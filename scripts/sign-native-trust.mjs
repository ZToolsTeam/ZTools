#!/usr/bin/env node

/**
 * sign-native-trust.mjs
 * ZTools 原生 DLL 动态信任签名工具（Schema v1，ECDSA P-256 + SHA-256 + IEEE P1363）
 *
 * 契约要点（与 C++ shared/native_trust_verifier.hpp 和 TS native-trust-verifier.ts 严格对齐）：
 * 1. 算法：ECDSA P-256 (prime256v1) + SHA-256，签名固定 64 字节 IEEE P1363（128 位小写 hex）；
 * 2. 域分离前缀："ztools-native-trust-v1\0"，签名输入为 prefix || raw_bytes(native-trust.json)；
 * 3. .sig 格式：单行 ASCII "v1:<keyId>:<128 位小写 hex>\n"（总长 <= 256 字节）；先验签、后解析；
 * 4. 主入口必须显式声明（role="main" 带 dllId 与 functions），其余 PE 按规则自动归类为 dependency / helper；
 * 5. 封闭性校验：插件目录下全部 PE 文件（按 MZ+PE 头判定）必须覆盖，严禁漏签或夹带未声明 PE；
 * 6. 密钥用途隔离：requireAdmin=false 仅允许 usage="native"，requireAdmin=true 仅允许 usage="native-privileged"。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_TRUST_SCHEMA_VERSION = 1
export const NATIVE_TRUST_DOMAIN_PREFIX = Buffer.from('ztools-native-trust-v1\0', 'ascii')
export const COMMONLIBS_SCHEMA_VERSION = 1
export const COMMONLIBS_CATALOG_DOMAIN_PREFIX = Buffer.from('ztools-commonlibs-catalog-v1\0', 'ascii')
export const COMMONLIBS_CATALOG_FILE = 'catalog.json'
export const COMMONLIBS_SIGNATURE_FILE = 'catalog.sig'
export const DEFAULT_COMMONLIBS_KEY_ID = 'ztools-commonlibs-prod-2026a'
export const MAX_COMMONLIBS_CATALOG_BYTES = 1024 * 1024
export const COMMONLIBS_PLATFORM_ARCH_KEYS = Object.freeze(['win32-x64', 'darwin-arm64', 'darwin-x64'])
export const NATIVE_TRUST_MANIFEST_FILE = 'native-trust.json'
export const NATIVE_TRUST_SIGNATURE_FILE = 'native-trust.sig'
export const DEFAULT_NATIVE_TRUST_KEY_ID = 'ztools-native-prod-2026a'
export const DEFAULT_NATIVE_PRIV_KEY_ID = 'ztools-native-priv-prod-2026a'
export const REVOKED_DEV_KEY_IDS = Object.freeze(['ztools-native-2026-v1'])

export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_SIGNATURE_BYTES = 256
export const MAX_FILES_PER_MANIFEST = 128
export const MAX_FUNCTIONS_PER_MAIN = 256
export const MAX_COMMON_LIBS_PER_MANIFEST = 32
export const MAX_JSON_DEPTH = 8
export const MAX_JSON_OBJECT_KEYS = 64
export const MAX_JSON_STRING_LEN = 4096

const KEY_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const COMMON_LIB_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/
const FUNCTION_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/
const HEX_128_REGEX = /^[a-f0-9]{128}$/

const PE_MACHINE_IA32 = 0x014c
const PE_MACHINE_AMD64 = 0x8664
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002
const IMAGE_FILE_DLL = 0x2000
const PE32_OPTIONAL_MAGIC = 0x010b
const PE32PLUS_OPTIONAL_MAGIC = 0x020b
const IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR = 14

const REQUIRED_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'keyId',
  'pluginId',
  'pluginVersion',
  'requireAdmin',
  'issuedAt',
  'files'
])
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  ...REQUIRED_TOP_LEVEL_KEYS,
  'commonLibs'
])
const ALLOWED_MAIN_FILE_KEYS = new Set(['role', 'dllId', 'path', 'arch', 'size', 'sha256', 'functions'])
const ALLOWED_AUX_FILE_KEYS = new Set(['role', 'path', 'arch', 'size', 'sha256'])
const ALLOWED_REVOCATION_KEYS = new Set([
  'schemaVersion',
  'revokedKeyIds',
  'revokedManifestSha256',
  'revokedFileSha256',
  'minPluginVersions'
])
const ALLOWED_USAGES = new Set(['native', 'native-privileged', 'commonlibs'])

/** 校验 Windows 保留设备名段 */
function isReservedDeviceSegment(segment) {
  const base = segment.split('.')[0].toLowerCase()
  return ['con', 'prn', 'aux', 'nul'].includes(base) || /^(?:com|lpt)[1-9]$/.test(base)
}

/** 校验安全标识符（与 C++ dll_paths::IsSafeIdentifier 严格对齐） */
export function isSafeIdentifier(value, allowLeadingUnderscore = false) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  const regex = allowLeadingUnderscore ? FUNCTION_IDENTIFIER_REGEX : IDENTIFIER_REGEX
  if (!regex.test(value)) return false
  if (value.endsWith('.')) return false
  if (!allowLeadingUnderscore && isReservedDeviceSegment(value)) return false
  return true
}

/** 校验签名 CommonLibs 逻辑工具 ID（与 C++ / TS 严格对齐） */
export function isSafeCommonLibId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  if (!COMMON_LIB_ID_REGEX.test(value)) return false
  if (value.endsWith('.')) return false
  if (isReservedDeviceSegment(value)) return false
  return true
}

/** 校验 SemVer 版本号（MAJOR.MINOR.PATCH[-pre]） */
export function parseSemVer(version) {
  if (typeof version !== 'string' || version.length === 0 || version.length > 128) return null
  const match = SEMVER_REGEX.exec(version)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }
  const pre = match[4] ? match[4].split('.') : []
  for (const part of pre) {
    if (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')) return null
  }
  return { major, minor, patch, pre }
}

/** 比较两个 SemVer：返回 -1 / 0 / 1 */
export function compareSemVer(a, b) {
  const va = typeof a === 'string' ? parseSemVer(a) : a
  const vb = typeof b === 'string' ? parseSemVer(b) : b
  if (!va || !vb) throw new Error(`无效的 SemVer 版本号: ${a} vs ${b}`)
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1
  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1
  if (vb.pre.length === 0) return -1
  const len = Math.max(va.pre.length, vb.pre.length)
  for (let i = 0; i < len; i += 1) {
    if (i >= va.pre.length) return -1
    if (i >= vb.pre.length) return 1
    const pa = va.pre[i]
    const pb = vb.pre[i]
    if (pa === pb) continue
    const na = /^\d+$/.test(pa)
    const nb = /^\d+$/.test(pb)
    if (na && nb) {
      const ia = Number(pa)
      const ib = Number(pb)
      return ia < ib ? -1 : 1
    }
    if (na !== nb) return na ? -1 : 1
    return pa < pb ? -1 : 1
  }
  return 0
}

/** 校验插件内相对路径（与 C++ ValidateRelativePath 对齐） */
export function isSafeRelativeFilePath(entry, { requireLibPrefix = false, requireDllExtension = false } = {}) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > 4096) return false
  if (entry.startsWith('/') || entry.includes('\\') || entry.includes(':')) return false
  if (/[\u0000-\u001f\u007f*?"<>|]/.test(entry)) return false
  const segments = entry.split('/')
  if (segments.length === 0) return false
  if (requireLibPrefix && (segments.length < 2 || segments[0].toLowerCase() !== 'lib')) return false
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
    if (segment.endsWith('.') || segment.endsWith(' ')) return false
    if (isReservedDeviceSegment(segment)) return false
  }
  if (requireDllExtension && !segments[segments.length - 1].toLowerCase().endsWith('.dll')) {
    return false
  }
  return true
}

/**
 * 严格受限 JSON 解析器（拒绝重复键、非法转义、孤立代理对、超深嵌套、超大键数/串长、非法整数）
 * 与 C++ shared/native_trust_json.hpp 规则完全一致。
 */
export function parseStrictJson(text) {
  if (typeof text !== 'string') throw new Error('JSON 输入必须是字符串')
  if (text.charCodeAt(0) === 0xfeff) throw new Error('JSON 不允许包含 UTF-8 BOM')
  const len = text.length
  let pos = 0

  const skipWs = () => {
    while (pos < len) {
      const ch = text.charCodeAt(pos)
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) pos += 1
      else break
    }
  }

  const parseString = () => {
    if (text[pos] !== '"') throw new Error(`期望字符串起始引号，位置 ${pos}`)
    pos += 1
    let out = ''
    while (pos < len) {
      const ch = text[pos]
      const code = text.charCodeAt(pos)
      if (ch === '"') {
        pos += 1
        if (out.length > MAX_JSON_STRING_LEN) throw new Error('JSON 字符串超过最大长度限制')
        return out
      }
      if (code < 0x20) throw new Error(`JSON 字符串包含未转义控制字符，位置 ${pos}`)
      if (ch === '\\') {
        pos += 1
        if (pos >= len) throw new Error('JSON 转义序列未闭合')
        const esc = text[pos]
        pos += 1
        if (esc === '"' || esc === '\\' || esc === '/') out += esc
        else if (esc === 'b') out += '\b'
        else if (esc === 'f') out += '\f'
        else if (esc === 'n') out += '\n'
        else if (esc === 'r') out += '\r'
        else if (esc === 't') out += '\t'
        else if (esc === 'u') {
          if (pos + 4 > len) throw new Error('JSON \\u 转义长度不足')
          const hex = text.slice(pos, pos + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`非法 \\u 转义: ${hex}`)
          const unit = parseInt(hex, 16)
          pos += 4
          if (unit >= 0xd800 && unit <= 0xdbff) {
            // 高代理必须紧跟低代理
            if (pos + 6 > len || text[pos] !== '\\' || text[pos + 1] !== 'u') {
              throw new Error('JSON 包含孤立高代理对')
            }
            const lowHex = text.slice(pos + 2, pos + 6)
            if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) throw new Error(`非法低代理转义: ${lowHex}`)
            const lowUnit = parseInt(lowHex, 16)
            if (lowUnit < 0xdc00 || lowUnit > 0xdfff) throw new Error('JSON 高代理后未接低代理')
            pos += 6
            out += String.fromCharCode(unit, lowUnit)
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new Error('JSON 包含孤立低代理对')
          } else {
            out += String.fromCharCode(unit)
          }
        } else {
          throw new Error(`JSON 包含非法转义字符: \\${esc}`)
        }
      } else {
        // 拒绝裸孤立代理码元
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = pos + 1 < len ? text.charCodeAt(pos + 1) : 0
          if (next < 0xdc00 || next > 0xdfff) throw new Error('JSON 字符串包含孤立高代理')
          out += ch + text[pos + 1]
          pos += 2
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          throw new Error('JSON 字符串包含孤立低代理')
        } else {
          out += ch
          pos += 1
        }
      }
      if (out.length > MAX_JSON_STRING_LEN) throw new Error('JSON 字符串超过最大长度限制')
    }
    throw new Error('JSON 字符串未闭合')
  }

  const parseNumber = () => {
    const start = pos
    if (text[pos] === '-') throw new Error('JSON 不允许负数')
    if (text[pos] === '0') {
      pos += 1
      if (pos < len && text[pos] >= '0' && text[pos] <= '9') {
        throw new Error('JSON 整数不允许前导零')
      }
    } else if (text[pos] >= '1' && text[pos] <= '9') {
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') pos += 1
    } else {
      throw new Error(`JSON 数字格式错误，位置 ${pos}`)
    }
    if (pos < len && (text[pos] === '.' || text[pos] === 'e' || text[pos] === 'E')) {
      throw new Error('JSON 仅允许非负整数')
    }
    const raw = text.slice(start, pos)
    const num = Number(raw)
    if (!Number.isSafeInteger(num) || num < 0 || num > Number.MAX_SAFE_INTEGER) {
      throw new Error(`JSON 整数超出 0..2^53-1 范围: ${raw}`)
    }
    return num
  }

  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) throw new Error(`JSON 嵌套深度超过上限 ${MAX_JSON_DEPTH}`)
    skipWs()
    if (pos >= len) throw new Error('JSON 意外结束')
    const ch = text[pos]
    if (ch === '{') {
      if (depth + 1 > MAX_JSON_DEPTH) throw new Error(`JSON 嵌套深度超过上限 ${MAX_JSON_DEPTH}`)
      pos += 1
      skipWs()
      const obj = Object.create(null)
      if (text[pos] === '}') {
        pos += 1
        return obj
      }
      let count = 0
      while (true) {
        skipWs()
        const key = parseString()
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          throw new Error(`JSON 存在重复键: ${key}`)
        }
        count += 1
        if (count > MAX_JSON_OBJECT_KEYS) throw new Error(`JSON 对象键数超过上限 ${MAX_JSON_OBJECT_KEYS}`)
        skipWs()
        if (text[pos] !== ':') throw new Error(`期望冒号，位置 ${pos}`)
        pos += 1
        obj[key] = parseValue(depth + 1)
        skipWs()
        if (text[pos] === '}') {
          pos += 1
          return obj
        }
        if (text[pos] !== ',') throw new Error(`期望逗号或右花括号，位置 ${pos}`)
        pos += 1
      }
    }
    if (ch === '[') {
      if (depth + 1 > MAX_JSON_DEPTH) throw new Error(`JSON 嵌套深度超过上限 ${MAX_JSON_DEPTH}`)
      pos += 1
      skipWs()
      const arr = []
      if (text[pos] === ']') {
        pos += 1
        return arr
      }
      while (true) {
        arr.push(parseValue(depth + 1))
        skipWs()
        if (text[pos] === ']') {
          pos += 1
          return arr
        }
        if (text[pos] !== ',') throw new Error(`期望逗号或右方括号，位置 ${pos}`)
        pos += 1
      }
    }
    if (ch === '"') return parseString()
    if (ch === 't' && text.startsWith('true', pos)) {
      pos += 4
      return true
    }
    if (ch === 'f' && text.startsWith('false', pos)) {
      pos += 5
      return false
    }
    if (ch === 'n' && text.startsWith('null', pos)) {
      pos += 4
      return null
    }
    if (ch >= '0' && ch <= '9') return parseNumber()
    throw new Error(`JSON 包含非法字符 '${ch}'，位置 ${pos}`)
  }

  const value = parseValue(0)
  skipWs()
  if (pos !== len) throw new Error(`JSON 尾部存在多余内容，位置 ${pos}`)
  return value
}

/**
 * 探测并解析 PE 文件头（支持 x86/x64 的 DLL、EXE、.sys 内核驱动及 .node）。
 * 非 PE 文件返回 null；合法 PE 返回 { arch: 'x86'|'x64', isDll, isClrManaged, isExecutable, size, sha256 }；
 * 畸形/不支持架构的 PE（例如 ARM64）返回 { unsupportedPe: true, machine } 以便外层 Fail-Closed 拦截。
 */
export function inspectPeFile(filePath, { computeHash = true } = {}) {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) {
    throw new Error(`禁止符号链接或重解析点: ${filePath}`)
  }
  if (!stat.isFile()) return null
  if (stat.size < 64) return null

  const fd = fs.openSync(filePath, 'r')
  try {
    const dos = Buffer.alloc(64)
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64) return null
    if (dos.readUInt16LE(0) !== 0x5a4d) return null // 非 MZ
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset + 26 > stat.size) return null

    const coffAndMagic = Buffer.alloc(26)
    if (fs.readSync(fd, coffAndMagic, 0, 26, peOffset) !== 26) return null
    if (coffAndMagic.readUInt32LE(0) !== 0x00004550) return null // 非 PE\0\0

    const machine = coffAndMagic.readUInt16LE(4)
    const sections = coffAndMagic.readUInt16LE(6)
    const optionalSize = coffAndMagic.readUInt16LE(20)
    const characteristics = coffAndMagic.readUInt16LE(22)
    const optionalMagic = coffAndMagic.readUInt16LE(24)
    const sectionTableEnd = peOffset + 24 + optionalSize + sections * 40
    if (sections < 1 || sections > 96 || sectionTableEnd > stat.size) {
      return { unsupportedPe: true, machine, reason: 'PE 节表越界或节数异常' }
    }

    let arch = null
    let isClrManaged = false
    if (machine === PE_MACHINE_IA32 && optionalMagic === PE32_OPTIONAL_MAGIC && optionalSize >= 96) {
      arch = 'x86'
      // PE32 DataDirectory 起始于 optional header 偏移 96，第 14 项 COM Descriptor 位于 +96 + 14*8 = +208
      if (optionalSize >= 216 && peOffset + 24 + 216 <= stat.size) {
        const clr = Buffer.alloc(8)
        if (fs.readSync(fd, clr, 0, 8, peOffset + 24 + 96 + IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR * 8) === 8) {
          isClrManaged = clr.readUInt32LE(0) !== 0 && clr.readUInt32LE(4) !== 0
        }
      }
    } else if (machine === PE_MACHINE_AMD64 && optionalMagic === PE32PLUS_OPTIONAL_MAGIC && optionalSize >= 112) {
      arch = 'x64'
      // PE32+ DataDirectory 起始于 optional header 偏移 112，第 14 项位于 +112 + 14*8 = +224
      if (optionalSize >= 232 && peOffset + 24 + 232 <= stat.size) {
        const clr = Buffer.alloc(8)
        if (fs.readSync(fd, clr, 0, 8, peOffset + 24 + 112 + IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR * 8) === 8) {
          isClrManaged = clr.readUInt32LE(0) !== 0 && clr.readUInt32LE(4) !== 0
        }
      }
    } else {
      return { unsupportedPe: true, machine, reason: `不支持的 PE 架构: 0x${machine.toString(16)}` }
    }

    const isExecutable = (characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) !== 0
    if (!isExecutable) {
      return { unsupportedPe: true, machine, reason: '缺少 IMAGE_FILE_EXECUTABLE_IMAGE 标志' }
    }
    const isDll = (characteristics & IMAGE_FILE_DLL) !== 0
    let sha256 = null
    if (computeHash) {
      const hash = crypto.createHash('sha256')
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let offset = 0
      while (offset < stat.size) {
        const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset)
        if (bytesRead <= 0) break
        hash.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
        offset += bytesRead
      }
      sha256 = hash.digest('hex')
    }
    return {
      arch,
      isDll,
      isClrManaged,
      isExecutable,
      size: stat.size,
      sha256
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** 校验目标文件是否为合法 32 位原生 Windows DLL PE 镜像 */
export function assertX86DllFile(filePath) {
  const info = inspectPeFile(filePath)
  if (!info || info.unsupportedPe || info.arch !== 'x86' || !info.isDll || info.isClrManaged) {
    throw new Error(`目标文件不是合法的 Win32 x86 原生 DLL: ${filePath}`)
  }
  return { size: info.size, sha256: info.sha256 }
}

/** 递归枚举插件目录内的所有 PE 文件（按 POSIX 相对路径排序，遇符号链接 Fail-Closed） */
export function scanPeFilesInDirectory(pluginDir, { computeHash = true } = {}) {
  const absDir = path.resolve(pluginDir)
  const rootStat = fs.lstatSync(absDir)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`插件目录非法或为符号链接: ${absDir}`)
  }
  const results = []
  const walk = (currentAbs, relPrefix) => {
    const entries = fs.readdirSync(currentAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(currentAbs, entry.name)
      const stat = fs.lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        throw new Error(`插件目录内禁止符号链接: ${fullPath}`)
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (stat.isDirectory()) {
        walk(fullPath, relPath)
      } else if (stat.isFile()) {
        const pe = inspectPeFile(fullPath, { computeHash })
        if (pe) {
          if (pe.unsupportedPe) {
            throw new Error(`检测到不支持的 PE 文件 ${relPath}: ${pe.reason}`)
          }
          results.push({ relPath, absPath: fullPath, ...pe })
        }
      }
    }
  }
  walk(absDir, '')
  return results
}

/** 逐段校验相对路径无符号链接且 realpath 落在插件根目录内，缺失目标文件时抛出语义清晰的 DLL_UNAVAILABLE 错误 */
function assertNoSymlinkSegmentsWithinRoot(absRoot, relPath) {
  const segments = relPath.split('/')
  let current = absRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) {
      throw new Error(`DLL_UNAVAILABLE: 清单声明的文件不存在: ${relPath}`)
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`DLL_PATH_INVALID: 路径包含符号链接或重解析点: ${relPath}`)
    }
  }
  const realRoot = fs.realpathSync(absRoot)
  const realTarget = fs.realpathSync(current)
  const rel = path.relative(realRoot, realTarget)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`DLL_PATH_INVALID: 解析后的文件路径逃逸插件根目录: ${relPath}`)
  }
  return current
}

/** 从 PEM 公钥或私钥提取 64 字节未压缩 X||Y 原始公钥（128 位小写 hex，兼容 CNG BCRYPT_ECCPUBLIC_BLOB） */
export function extractP256RawPublicKeyHex(keyInput) {
  const keyObj = typeof keyInput === 'string' || Buffer.isBuffer(keyInput)
    ? crypto.createPublicKey(keyInput)
    : keyInput
  const jwk = keyObj.export({ format: 'jwk' })
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('密钥必须为 EC P-256 (prime256v1) 曲线')
  }
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`P-256 公钥坐标长度异常: x=${x.length}, y=${y.length}`)
  }
  return Buffer.concat([x, y]).toString('hex')
}

/** 将 128 位小写 hex 原始 X||Y 公钥还原为 Node.js KeyObject */
export function importP256RawPublicKeyHex(publicKeyHex) {
  const normalized = String(publicKeyHex || '').trim().toLowerCase()
  if (!HEX_128_REGEX.test(normalized)) {
    throw new Error('P-256 原始公钥必须是 128 位十六进制字符串（64 字节 X||Y）')
  }
  const raw = Buffer.from(normalized, 'hex')
  const x = raw.subarray(0, 32).toString('base64url')
  const y = raw.subarray(32, 64).toString('base64url')
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x, y },
    format: 'jwk'
  })
}

/** 生成一对新的 ECDSA P-256 密钥对 */
export function generateNativeTrustKeyPair(keyId = DEFAULT_NATIVE_TRUST_KEY_ID, usages = ['native']) {
  if (!KEY_ID_REGEX.test(keyId)) {
    throw new Error(`keyId 格式无效: ${keyId}`)
  }
  if (!Array.isArray(usages) || usages.length === 0 || !usages.every((u) => ALLOWED_USAGES.has(u))) {
    throw new Error(`usages 无效: ${JSON.stringify(usages)}`)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  const publicKeyHex = extractP256RawPublicKeyHex(publicKey)
  return { keyId, usages: [...usages], privateKeyPem, publicKeyPem, publicKeyHex }
}

/** 解析 .sig 文件单行内容 "v1:<keyId>:<128 位小写 hex>" */
export function parseSignatureLine(rawText) {
  if (typeof rawText !== 'string') return null
  if (Buffer.byteLength(rawText, 'utf8') > MAX_SIGNATURE_BYTES) return null
  const stripped = rawText.replace(/\r?\n$/, '')
  if (stripped.includes('\r') || stripped.includes('\n')) return null
  const parts = stripped.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, keyId, signatureHex] = parts
  if (!KEY_ID_REGEX.test(keyId) || !HEX_128_REGEX.test(signatureHex)) return null
  return { version: 'v1', keyId, signatureHex }
}

/** 构造 .sig 文件文本 */
export function formatSignatureLine(keyId, signatureHex) {
  if (!KEY_ID_REGEX.test(String(keyId || ''))) throw new Error(`keyId 无效: ${keyId}`)
  const normalizedSig = String(signatureHex || '').toLowerCase()
  if (!HEX_128_REGEX.test(normalizedSig)) throw new Error('签名 hex 格式无效')
  return `v1:${keyId}:${normalizedSig}\n`
}

/** 对任意载荷按指定域分离前缀进行 ECDSA P-256 IEEE P1363 签名（返回 128 位小写 hex） */
export function signDomainSeparatedPayload(payloadBuffer, privateKeyPem, domainPrefix) {
  const prefix = Buffer.isBuffer(domainPrefix) ? domainPrefix : Buffer.from(String(domainPrefix), 'ascii')
  const bytes = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(String(payloadBuffer), 'utf8')
  const signingInput = Buffer.concat([prefix, bytes])
  const signature = crypto.sign('sha256', signingInput, {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  })
  if (signature.length !== 64) {
    throw new Error(`ECDSA P-256 IEEE P1363 签名长度异常: ${signature.length}`)
  }
  return signature.toString('hex')
}

/** 验证任意载荷在指定域分离前缀下的 ECDSA P-256 IEEE P1363 签名 */
export function verifyDomainSeparatedSignature(payloadBuffer, signatureHex, publicKeyHex, domainPrefix) {
  const normalizedSig = String(signatureHex || '').trim().toLowerCase()
  if (!HEX_128_REGEX.test(normalizedSig)) return false
  try {
    const prefix = Buffer.isBuffer(domainPrefix) ? domainPrefix : Buffer.from(String(domainPrefix), 'ascii')
    const publicKey = importP256RawPublicKeyHex(publicKeyHex)
    const bytes = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(String(payloadBuffer), 'utf8')
    const signingInput = Buffer.concat([prefix, bytes])
    return crypto.verify(
      'sha256',
      signingInput,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(normalizedSig, 'hex')
    )
  } catch {
    return false
  }
}

/** 对 native-trust.json 原始字节进行域分离 ECDSA P-256 签名（返回 128 位小写 hex） */
export function signNativeTrustPayload(manifestBuffer, privateKeyPem) {
  return signDomainSeparatedPayload(manifestBuffer, privateKeyPem, NATIVE_TRUST_DOMAIN_PREFIX)
}

/** 验证 native-trust.json 原始字节与签名 hex（128 位小写 hex） */
export function verifyNativeTrustSignature(manifestBuffer, signatureHex, publicKeyHex) {
  return verifyDomainSeparatedSignature(manifestBuffer, signatureHex, publicKeyHex, NATIVE_TRUST_DOMAIN_PREFIX)
}

/** 校验 CommonLibs 工具池签名清单（catalog.json）Schema v1 */
export function validateCommonLibsCatalogSchema(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('CommonLibs 清单必须为 JSON 对象')
  }
  const allowedTop = new Set(['schemaVersion', 'catalogType', 'keyId', 'generatedAt', 'tools', 'revocations'])
  for (const key of Object.keys(catalog)) {
    if (!allowedTop.has(key)) throw new Error(`CommonLibs 清单包含未知字段: ${key}`)
  }
  if (catalog.schemaVersion !== COMMONLIBS_SCHEMA_VERSION) {
    throw new Error(`CommonLibs 清单 schemaVersion 必须为 ${COMMONLIBS_SCHEMA_VERSION}`)
  }
  if (catalog.catalogType !== 'public' && catalog.catalogType !== 'commercial') {
    throw new Error(`CommonLibs 清单 catalogType 无效: ${String(catalog.catalogType)}`)
  }
  if (typeof catalog.keyId !== 'string' || !KEY_ID_REGEX.test(catalog.keyId)) {
    throw new Error(`CommonLibs 清单 keyId 无效: ${String(catalog.keyId)}`)
  }
  if (typeof catalog.generatedAt !== 'string' || Number.isNaN(Date.parse(catalog.generatedAt))) {
    throw new Error('CommonLibs 清单 generatedAt 必须为有效 ISO-8601 时间戳')
  }
  if (!Array.isArray(catalog.tools)) {
    throw new Error('CommonLibs 清单 tools 必须为数组')
  }
  const seenToolIds = new Set()
  const platformKeySet = new Set(COMMONLIBS_PLATFORM_ARCH_KEYS)
  for (const tool of catalog.tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw new Error('CommonLibs tools 项必须为对象')
    }
    if (typeof tool.toolId !== 'string' || !isSafeIdentifier(tool.toolId)) {
      throw new Error(`CommonLibs toolId 无效: ${String(tool.toolId)}`)
    }
    if (seenToolIds.has(tool.toolId)) {
      throw new Error(`CommonLibs toolId 重复: ${tool.toolId}`)
    }
    seenToolIds.add(tool.toolId)
    if (typeof tool.toolName !== 'string' || !isSafeIdentifier(tool.toolName)) {
      throw new Error(`CommonLibs toolName 无效: ${String(tool.toolName)}`)
    }
    if (typeof tool.version !== 'string' || !parseSemVer(tool.version)) {
      throw new Error(`CommonLibs version 非有效 SemVer: ${String(tool.version)}`)
    }
    if (tool.toolId !== `${tool.toolName}-${tool.version}`) {
      throw new Error(`CommonLibs toolId(${tool.toolId}) 必须等于 ${tool.toolName}-${tool.version}`)
    }
    if (!Number.isSafeInteger(tool.abiMajor) || tool.abiMajor < 0) {
      throw new Error(`CommonLibs abiMajor 必须为非负整数: ${String(tool.abiMajor)}`)
    }
    if (tool.minClientVersion !== undefined && (typeof tool.minClientVersion !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(tool.minClientVersion))) {
      throw new Error(`CommonLibs minClientVersion 格式无效: ${String(tool.minClientVersion)}`)
    }
    if (!tool.packages || typeof tool.packages !== 'object' || Array.isArray(tool.packages)) {
      throw new Error(`CommonLibs ${tool.toolId} 缺少 packages 映射`)
    }
    const pkgKeys = Object.keys(tool.packages)
    if (pkgKeys.length === 0) {
      throw new Error(`CommonLibs ${tool.toolId} 至少需要包含一个平台包`)
    }
    for (const platformKey of pkgKeys) {
      if (!platformKeySet.has(platformKey)) {
        throw new Error(`CommonLibs ${tool.toolId} 包含非法平台架构键: ${platformKey}`)
      }
      const pkg = tool.packages[platformKey]
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        throw new Error(`CommonLibs ${tool.toolId}.${platformKey} 必须为对象`)
      }
      if (typeof pkg.url !== 'string' || !/^https?:\/\//i.test(pkg.url)) {
        throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.url 无效`)
      }
      if (!Number.isSafeInteger(pkg.size) || pkg.size <= 0) {
        throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.size 必须为正整数`)
      }
      if (typeof pkg.archiveSha256 !== 'string' || !SHA256_HEX_REGEX.test(pkg.archiveSha256)) {
        throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.archiveSha256 无效`)
      }
      if (!Array.isArray(pkg.executables) || pkg.executables.length === 0) {
        throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.executables 必须为非空数组`)
      }
      if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
        throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.files 必须为非空数组`)
      }
      const filePathSet = new Set()
      for (const fileEntry of pkg.files) {
        if (!fileEntry || typeof fileEntry !== 'object' || Array.isArray(fileEntry)) {
          throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.files 条目无效`)
        }
        if (typeof fileEntry.path !== 'string' || !isSafeRelativeFilePath(fileEntry.path)) {
          throw new Error(`CommonLibs ${tool.toolId}.${platformKey} 文件路径不安全: ${String(fileEntry.path)}`)
        }
        if (filePathSet.has(fileEntry.path)) {
          throw new Error(`CommonLibs ${tool.toolId}.${platformKey} 存在重复文件路径: ${fileEntry.path}`)
        }
        filePathSet.add(fileEntry.path)
        if (!Number.isSafeInteger(fileEntry.size) || fileEntry.size < 0) {
          throw new Error(`CommonLibs ${tool.toolId}.${platformKey} 文件大小无效: ${fileEntry.path}`)
        }
        if (typeof fileEntry.sha256 !== 'string' || !SHA256_HEX_REGEX.test(fileEntry.sha256)) {
          throw new Error(`CommonLibs ${tool.toolId}.${platformKey} 文件 sha256 无效: ${fileEntry.path}`)
        }
      }
      for (const execRel of pkg.executables) {
        if (typeof execRel !== 'string' || !filePathSet.has(execRel)) {
          throw new Error(`CommonLibs ${tool.toolId}.${platformKey}.executables 项未出现在 files 清单中: ${String(execRel)}`)
        }
      }
    }
  }
  if (catalog.revocations !== undefined) {
    const rev = catalog.revocations
    if (!rev || typeof rev !== 'object' || Array.isArray(rev)) {
      throw new Error('CommonLibs revocations 必须为对象')
    }
    for (const arrField of ['revokedKeyIds', 'revokedToolIds', 'revokedArchiveSha256', 'revokedFileSha256']) {
      if (rev[arrField] !== undefined && !Array.isArray(rev[arrField])) {
        throw new Error(`CommonLibs revocations.${arrField} 必须为数组`)
      }
    }
    if (rev.minToolVersions !== undefined && (!rev.minToolVersions || typeof rev.minToolVersions !== 'object' || Array.isArray(rev.minToolVersions))) {
      throw new Error('CommonLibs revocations.minToolVersions 必须为对象')
    }
  }
  return catalog
}

/** 签发 CommonLibs 工具池清单（严格使用 usage="commonlibs" 与 ztools-commonlibs-catalog-v1\0 域分离前缀） */
export function signCommonLibsCatalog({ catalog, keyId = DEFAULT_COMMONLIBS_KEY_ID, privateKeyPem, keyUsages }) {
  if (Array.isArray(keyUsages) && !keyUsages.includes('commonlibs')) {
    throw new Error(`密钥 ${keyId} 不允许用于 commonlibs 目录签名（usages=${JSON.stringify(keyUsages)}）`)
  }
  const normalized = {
    schemaVersion: COMMONLIBS_SCHEMA_VERSION,
    catalogType: catalog.catalogType ?? 'public',
    keyId,
    generatedAt: catalog.generatedAt ?? new Date().toISOString(),
    tools: catalog.tools ?? [],
    revocations: catalog.revocations ?? {
      revokedKeyIds: [],
      revokedToolIds: [],
      revokedArchiveSha256: [],
      revokedFileSha256: [],
      minToolVersions: {}
    }
  }
  validateCommonLibsCatalogSchema(normalized)
  const catalogText = `${JSON.stringify(normalized, null, 2)}\n`
  const catalogBytes = Buffer.from(catalogText, 'utf8')
  if (catalogBytes.length > MAX_COMMONLIBS_CATALOG_BYTES) {
    throw new Error(`CommonLibs 清单超出体积上限: ${catalogBytes.length}`)
  }
  const signatureHex = signDomainSeparatedPayload(catalogBytes, privateKeyPem, COMMONLIBS_CATALOG_DOMAIN_PREFIX)
  const signatureText = formatSignatureLine(keyId, signatureHex)
  return {
    catalog: normalized,
    catalogText,
    catalogBytes,
    signatureHex,
    signatureText
  }
}

/** 离线验签 CommonLibs 清单原始字节与 .sig 文本（强制校验 usage="commonlibs"，拒绝原生密钥互验） */
export function verifyCommonLibsCatalog({ catalogBytes, signatureText, publicKeys, revokedKeyIds = [] }) {
  const bytes = Buffer.isBuffer(catalogBytes) ? catalogBytes : Buffer.from(String(catalogBytes), 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_COMMONLIBS_CATALOG_BYTES) {
    return { ok: false, code: 'CATALOG_UNAVAILABLE', message: 'CommonLibs catalog bytes invalid or oversized' }
  }
  const sig = parseSignatureLine(signatureText)
  if (!sig) {
    return { ok: false, code: 'CATALOG_INVALID', message: 'CommonLibs signature line malformed' }
  }
  if (revokedKeyIds.includes(sig.keyId)) {
    return { ok: false, code: 'CATALOG_REVOKED', message: `CommonLibs signing key revoked: ${sig.keyId}` }
  }
  const keyEntry = Array.isArray(publicKeys) ? publicKeys.find((item) => item && item.keyId === sig.keyId) : null
  if (!keyEntry || !Array.isArray(keyEntry.usages) || !keyEntry.usages.includes('commonlibs')) {
    return { ok: false, code: 'CATALOG_UNTRUSTED', message: `Untrusted or wrong-usage commonlibs keyId: ${sig.keyId}` }
  }
  if (!verifyDomainSeparatedSignature(bytes, sig.signatureHex, keyEntry.publicKeyHex, COMMONLIBS_CATALOG_DOMAIN_PREFIX)) {
    return { ok: false, code: 'CATALOG_UNTRUSTED', message: 'CommonLibs ECDSA signature verification failed' }
  }
  let parsed
  try {
    parsed = parseStrictJson(bytes.toString('utf8'))
    validateCommonLibsCatalogSchema(parsed)
  } catch (error) {
    return { ok: false, code: 'CATALOG_INVALID', message: error instanceof Error ? error.message : String(error) }
  }
  if (parsed.keyId !== sig.keyId) {
    return { ok: false, code: 'CATALOG_INVALID', message: 'CommonLibs catalog keyId mismatch with signature' }
  }
  return { ok: true, keyId: sig.keyId, catalog: parsed }
}

/** 校验吊销清单 JSON 对象格式 */
export function validateRevocationsSchema(revocations) {
  if (!revocations || typeof revocations !== 'object' || Array.isArray(revocations)) {
    throw new Error('吊销清单必须为 JSON 对象')
  }
  for (const key of Object.keys(revocations)) {
    if (!ALLOWED_REVOCATION_KEYS.has(key)) {
      throw new Error(`吊销清单包含未知字段: ${key}`)
    }
  }
  if (revocations.schemaVersion !== NATIVE_TRUST_SCHEMA_VERSION) {
    throw new Error(`吊销清单 schemaVersion 必须为 ${NATIVE_TRUST_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(revocations.revokedKeyIds)) throw new Error('revokedKeyIds 必须为数组')
  for (const keyId of revocations.revokedKeyIds) {
    if (typeof keyId !== 'string' || !KEY_ID_REGEX.test(keyId)) {
      throw new Error(`revokedKeyIds 含非法 keyId: ${keyId}`)
    }
  }
  if (!Array.isArray(revocations.revokedManifestSha256)) throw new Error('revokedManifestSha256 必须为数组')
  for (const h of revocations.revokedManifestSha256) {
    if (typeof h !== 'string' || !SHA256_HEX_REGEX.test(h)) {
      throw new Error(`revokedManifestSha256 含非法 SHA-256: ${h}`)
    }
  }
  if (!Array.isArray(revocations.revokedFileSha256)) throw new Error('revokedFileSha256 必须为数组')
  for (const h of revocations.revokedFileSha256) {
    if (typeof h !== 'string' || !SHA256_HEX_REGEX.test(h)) {
      throw new Error(`revokedFileSha256 含非法 SHA-256: ${h}`)
    }
  }
  if (
    !revocations.minPluginVersions ||
    typeof revocations.minPluginVersions !== 'object' ||
    Array.isArray(revocations.minPluginVersions)
  ) {
    throw new Error('minPluginVersions 必须为对象')
  }
  for (const [pluginId, version] of Object.entries(revocations.minPluginVersions)) {
    if (!isSafeIdentifier(pluginId)) throw new Error(`minPluginVersions 含非法 pluginId: ${pluginId}`)
    if (!parseSemVer(version)) throw new Error(`minPluginVersions[${pluginId}] 含非法 SemVer: ${version}`)
  }
  return revocations
}

/** 校验 Schema v1 native-trust.json 对象结构（严格模式：拒绝未知字段） */
export function validateNativeTrustManifestSchema(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('native-trust.json 顶层必须为对象')
  }
  const topKeys = Object.keys(manifest)
  const hasAllRequired = [...REQUIRED_TOP_LEVEL_KEYS].every((k) => Object.prototype.hasOwnProperty.call(manifest, k))
  if (!hasAllRequired || !topKeys.every((k) => ALLOWED_TOP_LEVEL_KEYS.has(k))) {
    throw new Error('native-trust.json 顶层字段不完整或包含未知字段')
  }
  if (manifest.schemaVersion !== NATIVE_TRUST_SCHEMA_VERSION) {
    throw new Error(`schemaVersion 必须为 ${NATIVE_TRUST_SCHEMA_VERSION}`)
  }
  if (typeof manifest.keyId !== 'string' || !KEY_ID_REGEX.test(manifest.keyId)) {
    throw new Error(`keyId 无效: ${manifest.keyId}`)
  }
  if (!isSafeIdentifier(manifest.pluginId)) {
    throw new Error(`pluginId 无效: ${manifest.pluginId}`)
  }
  if (!parseSemVer(manifest.pluginVersion)) {
    throw new Error(`pluginVersion 无效（须为 SemVer）: ${manifest.pluginVersion}`)
  }
  if (typeof manifest.requireAdmin !== 'boolean') {
    throw new Error('requireAdmin 必须为布尔值')
  }
  if (typeof manifest.issuedAt !== 'string' || manifest.issuedAt.length === 0 || manifest.issuedAt.length > 64) {
    throw new Error('issuedAt 无效')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES_PER_MANIFEST) {
    throw new Error(`files 必须为 1..${MAX_FILES_PER_MANIFEST} 条非空数组`)
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'commonLibs')) {
    // 护栏 2：特权插件严禁声明用户目录 CommonLibs 依赖
    if (manifest.requireAdmin) {
      throw new Error('特权插件（requireAdmin=true）严禁声明 commonLibs 工具池依赖')
    }
    if (!Array.isArray(manifest.commonLibs) || manifest.commonLibs.length > MAX_COMMON_LIBS_PER_MANIFEST) {
      throw new Error(`commonLibs 必须为 0..${MAX_COMMON_LIBS_PER_MANIFEST} 条数组`)
    }
    const seenLibs = new Set()
    for (const libId of manifest.commonLibs) {
      if (!isSafeCommonLibId(libId)) {
        throw new Error(`commonLibs 包含非法工具 ID: ${libId}`)
      }
      if (seenLibs.has(libId)) {
        throw new Error(`commonLibs 包含重复工具 ID: ${libId}`)
      }
      seenLibs.add(libId)
    }
  }

  const seenPaths = new Set()
  const seenDllIds = new Set()
  let mainCount = 0
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('files 条目必须为对象')
    }
    const role = item.role
    if (role !== 'main' && role !== 'dependency' && role !== 'helper') {
      throw new Error(`files[].role 无效: ${role}`)
    }
    const itemKeys = Object.keys(item)
    const allowedSet = role === 'main' ? ALLOWED_MAIN_FILE_KEYS : ALLOWED_AUX_FILE_KEYS
    if (itemKeys.length !== allowedSet.size || !itemKeys.every((k) => allowedSet.has(k))) {
      throw new Error(`files[${item.path || '?'}] 字段与 role=${role} 不匹配或包含未知字段`)
    }
    const relPath = item.path
    if (
      !isSafeRelativeFilePath(relPath, {
        requireLibPrefix: manifest.requireAdmin,
        requireDllExtension: role === 'main' || role === 'dependency'
      })
    ) {
      throw new Error(`相对路径不合法: ${relPath}`)
    }
    const pathKey = relPath.toLowerCase()
    if (seenPaths.has(pathKey)) throw new Error(`files 包含重复路径: ${relPath}`)
    seenPaths.add(pathKey)

    if (!Number.isSafeInteger(item.size) || item.size <= 0) {
      throw new Error(`files[${relPath}].size 无效: ${item.size}`)
    }
    if (typeof item.sha256 !== 'string' || !SHA256_HEX_REGEX.test(item.sha256)) {
      throw new Error(`files[${relPath}].sha256 无效`)
    }

    if (role === 'main') {
      mainCount += 1
      if (item.arch !== 'x86') throw new Error(`main 必须为 x86 DLL: ${relPath}`)
      if (!isSafeIdentifier(item.dllId)) throw new Error(`main.dllId 无效: ${item.dllId}`)
      const dllKey = item.dllId.toLowerCase()
      if (seenDllIds.has(dllKey)) throw new Error(`重复的 main.dllId: ${item.dllId}`)
      seenDllIds.add(dllKey)
      if (!Array.isArray(item.functions) || item.functions.length === 0 || item.functions.length > MAX_FUNCTIONS_PER_MAIN) {
        throw new Error(`main[${item.dllId}].functions 必须为 1..${MAX_FUNCTIONS_PER_MAIN} 条非空数组`)
      }
      const seenFns = new Set()
      for (const fn of item.functions) {
        if (!isSafeIdentifier(fn, true)) throw new Error(`非法函数名: ${fn}`)
        if (seenFns.has(fn)) throw new Error(`重复函数名: ${fn}`)
        seenFns.add(fn)
      }
    } else if (role === 'dependency') {
      if (item.arch !== 'x86') throw new Error(`dependency 必须为 x86 DLL: ${relPath}`)
    } else {
      if (item.arch !== 'x86' && item.arch !== 'x64') {
        throw new Error(`helper.arch 必须为 x86 或 x64: ${relPath}`)
      }
    }
  }
  if (mainCount === 0) throw new Error('files 中必须至少包含一个 role="main" 条目')
  return manifest
}

/**
 * 构造并签发 Schema v1 原生信任清单（内存纯函数）
 */
export function createSignedNativeTrust({
  pluginId,
  pluginVersion,
  requireAdmin = false,
  keyId,
  files,
  commonLibs = [],
  privateKeyPem,
  keyUsages,
  issuedAt = new Date().toISOString()
}) {
  const effectiveKeyId = keyId || (requireAdmin ? DEFAULT_NATIVE_PRIV_KEY_ID : DEFAULT_NATIVE_TRUST_KEY_ID)
  const requiredUsage = requireAdmin ? 'native-privileged' : 'native'
  if (Array.isArray(keyUsages) && !keyUsages.includes(requiredUsage)) {
    throw new Error(`密钥 ${effectiveKeyId} 用途 ${JSON.stringify(keyUsages)} 不允许签发 ${requiredUsage} 清单`)
  }
  if (!isSafeIdentifier(pluginId)) throw new Error(`pluginId 无效: ${pluginId}`)
  if (!parseSemVer(pluginVersion)) throw new Error(`pluginVersion 无效（须为 SemVer）: ${pluginVersion}`)
  if (typeof requireAdmin !== 'boolean') throw new Error('requireAdmin 必须为布尔值')
  if (!KEY_ID_REGEX.test(String(effectiveKeyId))) throw new Error(`keyId 无效: ${effectiveKeyId}`)
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_MANIFEST) {
    throw new Error(`files 必须为 1..${MAX_FILES_PER_MANIFEST} 条非空数组`)
  }
  if (!Array.isArray(commonLibs)) {
    throw new Error('commonLibs 必须为数组')
  }
  const normalizedCommonLibs = commonLibs.map((item) => String(item).trim())
  if (requireAdmin && normalizedCommonLibs.length > 0) {
    throw new Error('特权插件（requireAdmin=true）严禁声明 commonLibs 工具池依赖')
  }

  const normalizedFiles = files.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('files 条目必须为对象')
    const role = String(item.role || '')
    const relPath = String(item.path || '').replaceAll('\\', '/')
    const arch = String(item.arch || 'x86')
    const size = Number(item.size)
    const sha256 = String(item.sha256 || '').toLowerCase()
    if (role === 'main') {
      return {
        role: 'main',
        dllId: String(item.dllId || ''),
        path: relPath,
        arch,
        size,
        sha256,
        functions: Array.isArray(item.functions) ? item.functions.map((f) => String(f)) : []
      }
    }
    return {
      role,
      path: relPath,
      arch,
      size,
      sha256
    }
  })

  const manifestObject = {
    schemaVersion: NATIVE_TRUST_SCHEMA_VERSION,
    keyId: effectiveKeyId,
    pluginId,
    pluginVersion,
    requireAdmin,
    issuedAt,
    files: normalizedFiles,
    ...(normalizedCommonLibs.length > 0 ? { commonLibs: normalizedCommonLibs } : {})
  }
  validateNativeTrustManifestSchema(manifestObject)

  const manifestText = `${JSON.stringify(manifestObject, null, 2)}\n`
  const manifestBytes = Buffer.from(manifestText, 'utf8')
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`native-trust.json 体积超过上限 ${MAX_MANIFEST_BYTES} 字节`)
  }
  const signatureHex = signNativeTrustPayload(manifestBytes, privateKeyPem)
  const signatureText = formatSignatureLine(effectiveKeyId, signatureHex)
  return {
    manifest: manifestObject,
    manifestText,
    signatureHex,
    signatureText
  }
}

/** 尝试从插件目录的 build-info.json 或 plugin.json 提取默认版本号与构建时间 */
function readPluginDirMetadata(absDir) {
  let pluginVersion = null
  let builtAt = null
  const pluginJsonPath = path.join(absDir, 'plugin.json')
  if (fs.existsSync(pluginJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'))
      if (typeof parsed.version === 'string' && parseSemVer(parsed.version)) {
        pluginVersion = parsed.version
      }
    } catch {
      // 由调用方显式参数或后续校验兜底
    }
  }
  const buildInfoPath = path.join(absDir, 'build-info.json')
  if (fs.existsSync(buildInfoPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
      if (typeof parsed.builtAt === 'string' && parsed.builtAt.trim()) {
        builtAt = parsed.builtAt.trim()
      }
    } catch {
      // 忽略畸形 build-info
    }
  }
  return { pluginVersion, builtAt }
}

/**
 * 扫描插件目录并写入 Schema v1 native-trust.json 与 native-trust.sig
 * 要求：必须显式声明 mainEntries（取消自动将所有 DLL 签为 main 的行为），并封闭覆盖全部 PE 文件。
 */
export function signPluginDirectory({
  pluginDir,
  pluginId,
  pluginVersion,
  requireAdmin = false,
  keyId,
  mainEntries,
  commonLibs = [],
  roleOverrides = {},
  privateKeyPem,
  keyUsages,
  issuedAt
}) {
  const absDir = path.resolve(pluginDir)
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`插件目录不存在: ${absDir}`)
  }
  if (!Array.isArray(mainEntries) || mainEntries.length === 0) {
    throw new Error('必须显式声明至少一个 mainEntries（含 path、dllId、functions），禁止自动推导主入口')
  }

  const meta = readPluginDirMetadata(absDir)
  const resolvedVersion = pluginVersion || meta.pluginVersion
  if (!resolvedVersion || !parseSemVer(resolvedVersion)) {
    throw new Error(`必须提供合法的 SemVer pluginVersion（参数或 plugin.json.version）: ${resolvedVersion}`)
  }
  const resolvedIssuedAt = issuedAt || meta.builtAt || new Date().toISOString()

  const allPeFiles = scanPeFilesInDirectory(absDir)
  const peByLowerPath = new Map(allPeFiles.map((item) => [item.relPath.toLowerCase(), item]))

  const mainByLowerPath = new Map()
  const mainDirs = new Set()
  const files = []

  for (const entry of mainEntries) {
    if (!entry || typeof entry !== 'object') throw new Error('mainEntries 条目必须为对象')
    const relPath = String(entry.path || '').replaceAll('\\', '/')
    if (!isSafeRelativeFilePath(relPath, { requireLibPrefix: requireAdmin, requireDllExtension: true })) {
      throw new Error(`非法 main 相对路径: ${relPath}`)
    }
    const lowerPath = relPath.toLowerCase()
    if (mainByLowerPath.has(lowerPath)) throw new Error(`重复声明 main 路径: ${relPath}`)
    const pe = peByLowerPath.get(lowerPath)
    if (!pe) throw new Error(`声明的 main 文件不存在或不是合法 PE: ${relPath}`)
    if (pe.arch !== 'x86' || !pe.isDll || pe.isClrManaged) {
      throw new Error(`main 入口必须是 Win32 x86 原生 DLL: ${relPath}`)
    }
    const dllId = String(entry.dllId || path.basename(relPath, path.extname(relPath)))
    if (!isSafeIdentifier(dllId)) throw new Error(`main.dllId 无效: ${dllId}`)
    if (!Array.isArray(entry.functions) || entry.functions.length === 0) {
      throw new Error(`main[${dllId}] 必须显式提供非空 functions 白名单`)
    }
    mainByLowerPath.set(lowerPath, entry)
    const dirName = path.posix.dirname(pe.relPath).toLowerCase()
    mainDirs.add(dirName)
    files.push({
      role: 'main',
      dllId,
      path: pe.relPath,
      arch: 'x86',
      size: pe.size,
      sha256: pe.sha256,
      functions: entry.functions
    })
  }

  const normalizedOverrides = new Map()
  if (roleOverrides && typeof roleOverrides === 'object') {
    for (const [k, v] of Object.entries(roleOverrides)) {
      const normKey = String(k).replaceAll('\\', '/').toLowerCase()
      if (v !== 'dependency' && v !== 'helper') {
        throw new Error(`roleOverrides[${k}] 仅支持 dependency 或 helper，实际: ${v}`)
      }
      normalizedOverrides.set(normKey, v)
    }
  }

  for (const pe of allPeFiles) {
    const lowerPath = pe.relPath.toLowerCase()
    if (mainByLowerPath.has(lowerPath)) continue
    if (!isSafeRelativeFilePath(pe.relPath, { requireLibPrefix: requireAdmin })) {
      throw new Error(`插件内存在不合规路径的 PE 文件（requireAdmin=${requireAdmin}）: ${pe.relPath}`)
    }
    let role = normalizedOverrides.get(lowerPath)
    if (!role) {
      const dirName = path.posix.dirname(pe.relPath).toLowerCase()
      const isSameDirX86NativeDll =
        mainDirs.has(dirName) &&
        pe.arch === 'x86' &&
        pe.isDll &&
        !pe.isClrManaged &&
        pe.relPath.toLowerCase().endsWith('.dll')
      role = isSameDirX86NativeDll ? 'dependency' : 'helper'
    }
    if (role === 'dependency' && (pe.arch !== 'x86' || !pe.isDll || pe.isClrManaged || !pe.relPath.toLowerCase().endsWith('.dll'))) {
      throw new Error(`role="dependency" 仅允许 Win32 x86 原生 DLL: ${pe.relPath}`)
    }
    files.push({
      role,
      path: pe.relPath,
      arch: pe.arch,
      size: pe.size,
      sha256: pe.sha256
    })
  }

  const signed = createSignedNativeTrust({
    pluginId,
    pluginVersion: resolvedVersion,
    requireAdmin,
    keyId,
    files,
    commonLibs,
    privateKeyPem,
    keyUsages,
    issuedAt: resolvedIssuedAt
  })

  fs.writeFileSync(path.join(absDir, NATIVE_TRUST_MANIFEST_FILE), signed.manifestText, 'utf8')
  fs.writeFileSync(path.join(absDir, NATIVE_TRUST_SIGNATURE_FILE), signed.signatureText, 'utf8')
  return signed
}

/**
 * 解析私钥 PEM 及对应 keyId/usages（取消 .local-keys 静默回退，支持父仓根目录 native-trust-private-keys.json）
 * 优先级：显式 privateKeyPem → --key <pem> → 环境变量 ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PEM / _PATH → --key-file <json> → 默认父仓根目录 native-trust-private-keys.json
 */
export function resolvePrivateKeyMaterial({
  privateKeyPem,
  keyPath,
  keyFilePath,
  keyId,
  requireAdmin = false,
  usage,
  env = process.env,
  rootDir
} = {}) {
  const requiredUsage = usage ?? (requireAdmin ? 'native-privileged' : 'native')
  if (!ALLOWED_USAGES.has(requiredUsage)) {
    throw new Error(`不支持的密钥用途: ${String(requiredUsage)}`)
  }
  const defaultKeyIdForUsage =
    requiredUsage === 'commonlibs'
      ? DEFAULT_COMMONLIBS_KEY_ID
      : requiredUsage === 'native-privileged'
        ? DEFAULT_NATIVE_PRIV_KEY_ID
        : DEFAULT_NATIVE_TRUST_KEY_ID
  const effectiveKeyId = keyId || defaultKeyIdForUsage

  if (typeof privateKeyPem === 'string' && privateKeyPem.trim()) {
    return { keyId: effectiveKeyId, privateKeyPem, keyUsages: undefined }
  }
  if (keyPath) {
    return {
      keyId: effectiveKeyId,
      privateKeyPem: fs.readFileSync(path.resolve(keyPath), 'utf8'),
      keyUsages: undefined
    }
  }
  if (typeof env.ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PEM === 'string' && env.ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PEM.trim()) {
    return {
      keyId: effectiveKeyId,
      privateKeyPem: env.ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PEM,
      keyUsages: undefined
    }
  }
  if (typeof env.ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PATH === 'string' && env.ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PATH.trim()) {
    return {
      keyId: effectiveKeyId,
      privateKeyPem: fs.readFileSync(path.resolve(env.ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PATH.trim()), 'utf8'),
      keyUsages: undefined
    }
  }

  const candidateJsonPath = keyFilePath
    ? path.resolve(keyFilePath)
    : rootDir
      ? path.join(path.resolve(rootDir), 'native-trust-private-keys.json')
      : null

  if (keyFilePath && !fs.existsSync(candidateJsonPath)) {
    throw new Error(`指定的密钥文件不存在: ${candidateJsonPath}`)
  }

  if (candidateJsonPath && fs.existsSync(candidateJsonPath)) {
    const raw = JSON.parse(fs.readFileSync(candidateJsonPath, 'utf8'))
    const list = Array.isArray(raw?.keys) ? raw.keys : []
    const matched = keyId
      ? list.find((item) => item && item.keyId === keyId)
      : list.find((item) => item && item.keyId === effectiveKeyId) ||
        list.find((item) => item && Array.isArray(item.usages) && item.usages.includes(requiredUsage))
    if (!matched) {
      throw new Error(`私钥文件 ${candidateJsonPath} 中未找到匹配密钥（keyId=${effectiveKeyId}, usage=${requiredUsage}）`)
    }
    if (!Array.isArray(matched.usages) || !matched.usages.includes(requiredUsage)) {
      throw new Error(`密钥 ${matched.keyId} 的 usages=${JSON.stringify(matched.usages)} 与所需用途 ${requiredUsage} 不一致`)
    }
    if (typeof matched.privateKeyPem !== 'string' || !matched.privateKeyPem.trim()) {
      throw new Error(`密钥 ${matched.keyId} 缺少有效 privateKeyPem`)
    }
    return {
      keyId: matched.keyId,
      privateKeyPem: matched.privateKeyPem,
      keyUsages: matched.usages
    }
  }

  throw new Error(
    `未找到原生 DLL 签名私钥（keyId=${effectiveKeyId}, usage=${requiredUsage}）：请传入 --key / --key-file、配置 ZTOOLS_NATIVE_TRUST_PRIVATE_KEY_PEM / _PATH，或提供父仓根目录 native-trust-private-keys.json`
  )
}

/** 兼容封装：仅返回私钥 PEM 字符串 */
export function resolvePrivateKeyPem(options = {}) {
  return resolvePrivateKeyMaterial(options).privateKeyPem
}

/**
 * 离线严格校验插件目录签名（先验签后解析 + 吊销/最低版本 + 封闭性全 PE 覆盖校验）
 */
export function verifyPluginDirectory({
  pluginDir,
  publicKeys,
  revocations = null,
  expectedPluginId = null,
  expectedRequireAdmin = null
}) {
  const absDir = path.resolve(pluginDir)
  const manifestPath = path.join(absDir, NATIVE_TRUST_MANIFEST_FILE)
  const sigPath = path.join(absDir, NATIVE_TRUST_SIGNATURE_FILE)
  if (!fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) {
    throw new Error('缺少 native-trust.json 或 native-trust.sig')
  }
  const manifestStat = fs.lstatSync(manifestPath)
  const sigStat = fs.lstatSync(sigPath)
  if (manifestStat.isSymbolicLink() || sigStat.isSymbolicLink()) {
    throw new Error('信任清单或签名文件不允许为符号链接')
  }
  if (manifestStat.size === 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`native-trust.json 体积非法: ${manifestStat.size}`)
  }
  if (sigStat.size === 0 || sigStat.size > MAX_SIGNATURE_BYTES) {
    throw new Error(`native-trust.sig 体积非法: ${sigStat.size}`)
  }

  const manifestBytes = fs.readFileSync(manifestPath)
  const sigRaw = fs.readFileSync(sigPath, 'utf8')
  const parsedSig = parseSignatureLine(sigRaw)
  if (!parsedSig) {
    throw new Error('native-trust.sig 格式无效（必须为 v1:<keyId>:<128hex>）')
  }

  const matchedKey = Array.isArray(publicKeys)
    ? publicKeys.find((k) => k && k.keyId === parsedSig.keyId)
    : undefined
  if (!matchedKey) {
    throw new Error(`未找到 keyId=${parsedSig.keyId} 对应的受信任公钥`)
  }
  // 调用方显式指定 expectedRequireAdmin 时，在验签前即按对应 usage 校验公钥用途（与 TS/C++ 顺序一致）
  if (typeof expectedRequireAdmin === 'boolean') {
    const expectedUsage = expectedRequireAdmin ? 'native-privileged' : 'native'
    if (!Array.isArray(matchedKey.usages) || !matchedKey.usages.includes(expectedUsage)) {
      throw new Error(`公钥 ${matchedKey.keyId} 用途不匹配 ${expectedUsage}`)
    }
  }
  if (revocations) {
    validateRevocationsSchema(revocations)
    if (revocations.revokedKeyIds.includes(parsedSig.keyId)) {
      throw new Error(`签名密钥已被吊销: ${parsedSig.keyId}`)
    }
  }

  // 先对原始字节验签，通过后再解析 JSON
  if (!verifyNativeTrustSignature(manifestBytes, parsedSig.signatureHex, matchedKey.publicKeyHex)) {
    throw new Error('ECDSA P-256 签名验证失败')
  }

  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex')
  if (revocations && revocations.revokedManifestSha256.includes(manifestSha256)) {
    throw new Error(`清单哈希已被吊销: ${manifestSha256}`)
  }

  let manifestText
  try {
    // 严格 UTF-8 解码，同时保留 BOM（ignoreBOM: true）交由 parseStrictJson 显式拒绝
    manifestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(manifestBytes)
  } catch {
    throw new Error('native-trust.json 包含非法 UTF-8 字节序列')
  }
  const manifest = parseStrictJson(manifestText)
  validateNativeTrustManifestSchema(manifest)

  if (manifest.keyId !== parsedSig.keyId) {
    throw new Error(`清单 keyId(${manifest.keyId}) 与签名 keyId(${parsedSig.keyId}) 不一致`)
  }
  const requiredUsage = manifest.requireAdmin ? 'native-privileged' : 'native'
  if (!Array.isArray(matchedKey.usages) || !matchedKey.usages.includes(requiredUsage)) {
    throw new Error(`公钥 ${matchedKey.keyId} 用途不匹配 ${requiredUsage}`)
  }
  if (expectedPluginId && manifest.pluginId.toLowerCase() !== String(expectedPluginId).toLowerCase()) {
    throw new Error(`pluginId 不匹配: 期望 ${expectedPluginId}，实际 ${manifest.pluginId}`)
  }
  if (typeof expectedRequireAdmin === 'boolean' && manifest.requireAdmin !== expectedRequireAdmin) {
    throw new Error(`requireAdmin 不匹配: 期望 ${expectedRequireAdmin}，实际 ${manifest.requireAdmin}`)
  }
  if (revocations) {
    const minVer = Object.entries(revocations.minPluginVersions).find(
      ([id]) => id.toLowerCase() === manifest.pluginId.toLowerCase()
    )?.[1]
    if (minVer && compareSemVer(manifest.pluginVersion, minVer) < 0) {
      throw new Error(`插件版本 ${manifest.pluginVersion} 低于最低安全版本 ${minVer}`)
    }
  }

  // 封闭性（跳过扫描期重复哈希）+ 逐段路径无链接校验 + 全文件哈希与架构校验
  const allPeFiles = scanPeFilesInDirectory(absDir, { computeHash: false })
  const declaredPaths = new Set()
  for (const file of manifest.files) {
    declaredPaths.add(file.path.toLowerCase())
    const targetAbs = assertNoSymlinkSegmentsWithinRoot(absDir, file.path)
    const pe = inspectPeFile(targetAbs)
    if (!pe || pe.unsupportedPe) {
      throw new Error(`声明文件不是有效 PE: ${file.path}`)
    }
    if (file.role === 'main' || file.role === 'dependency') {
      if (pe.arch !== 'x86' || !pe.isDll || pe.isClrManaged) {
        throw new Error(`${file.role} 文件必须是 Win32 x86 原生 DLL: ${file.path}`)
      }
    } else if (pe.arch !== file.arch) {
      throw new Error(`helper 文件架构不匹配（声明 ${file.arch}，实际 ${pe.arch}）: ${file.path}`)
    }
    if (pe.size !== file.size || pe.sha256 !== file.sha256) {
      throw new Error(`文件完整性不匹配: ${file.path}`)
    }
    if (revocations && revocations.revokedFileSha256.includes(pe.sha256)) {
      throw new Error(`文件哈希已被吊销: ${file.path}`)
    }
  }
  for (const pe of allPeFiles) {
    if (!declaredPaths.has(pe.relPath.toLowerCase())) {
      throw new Error(`检测到未在 native-trust.json 中声明的 PE 文件: ${pe.relPath}`)
    }
  }
  return { manifest, manifestSha256, keyId: parsedSig.keyId }
}

function parseMainSpec(specText) {
  // 格式：<relPath>:<dllId>:<fn1,fn2,...>
  const firstColon = specText.indexOf(':')
  const secondColon = firstColon >= 0 ? specText.indexOf(':', firstColon + 1) : -1
  if (firstColon <= 0 || secondColon <= firstColon + 1) {
    throw new Error(`--main 参数格式须为 <path>:<dllId>:<fn1,fn2>，实际: ${specText}`)
  }
  const relPath = specText.slice(0, firstColon)
  const dllId = specText.slice(firstColon + 1, secondColon)
  const fns = specText
    .slice(secondColon + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return { path: relPath, dllId, functions: fns }
}

function parseCliArgs(argv) {
  const command = argv[0]
  const options = { mains: [], commonLibs: [], roleOverrides: {}, usages: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir' && i + 1 < argv.length) options.dir = argv[++i]
    else if (arg === '--plugin-id' && i + 1 < argv.length) options.pluginId = argv[++i]
    else if (arg === '--plugin-version' && i + 1 < argv.length) options.pluginVersion = argv[++i]
    else if (arg === '--issued-at' && i + 1 < argv.length) options.issuedAt = argv[++i]
    else if (arg === '--key-id' && i + 1 < argv.length) options.keyId = argv[++i]
    else if (arg === '--key' && i + 1 < argv.length) options.key = argv[++i]
    else if (arg === '--key-file' && i + 1 < argv.length) options.keyFile = argv[++i]
    else if (arg === '--usage' && i + 1 < argv.length) options.usages.push(argv[++i])
    else if (arg === '--out-private' && i + 1 < argv.length) options.outPrivate = argv[++i]
    else if (arg === '--out-public-json' && i + 1 < argv.length) options.outPublicJson = argv[++i]
    else if (arg === '--public-json' && i + 1 < argv.length) options.publicJson = argv[++i]
    else if (arg === '--revocations-json' && i + 1 < argv.length) options.revocationsJson = argv[++i]
    else if (arg === '--file' && i + 1 < argv.length) options.file = argv[++i]
    else if (arg === '--main' && i + 1 < argv.length) options.mains.push(parseMainSpec(argv[++i]))
    else if (arg === '--common-lib' && i + 1 < argv.length) {
      const items = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
      options.commonLibs.push(...items)
    } else if (arg === '--main-json' && i + 1 < argv.length) {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(argv[++i]), 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('--main-json 必须为数组')
      options.mains.push(...parsed)
    } else if (arg === '--role-override' && i + 1 < argv.length) {
      const pair = argv[++i]
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new Error(`--role-override 格式须为 <path>=<dependency|helper>，实际: ${pair}`)
      options.roleOverrides[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (arg === '--require-admin') options.requireAdmin = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  return { command, options }
}

function printUsage() {
  console.log(`用法：
  1. 生成 ECDSA P-256 密钥对:
     node scripts/sign-native-trust.mjs generate-keypair [--key-id <id>] [--usage native|native-privileged] [--out-private <private.pem>] [--out-public-json <public-keys.json>]

  2. 为插件目录签发 Schema v1 native-trust.json 与 native-trust.sig:
     node scripts/sign-native-trust.mjs sign --dir <pluginDir> --plugin-id <id> --plugin-version <semver> --main <path>:<dllId>:<fn1,fn2> [--main ...] [--common-lib <toolId>] [--role-override <path>=<role>] [--require-admin] [--key-id <id>] [--key <private.pem> | --key-file <keys.json>]

  3. 离线校验插件目录签名（先验签后解析 + 全 PE 封闭性检查）:
     node scripts/sign-native-trust.mjs verify --dir <pluginDir> --public-json <public-keys.json> [--revocations-json <revocations.json>] [--plugin-id <id>] [--require-admin]

  4. 校验吊销清单格式:
     node scripts/sign-native-trust.mjs revocations --file <native-trust-revocations.json>
`)
}

function runCli(argv) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    return
  }
  const { command, options } = parseCliArgs(argv)
  if (command === 'generate-keypair') {
    const usages = options.usages.length > 0 ? options.usages : ['native']
    const keyId = options.keyId || (usages.includes('native-privileged') ? DEFAULT_NATIVE_PRIV_KEY_ID : DEFAULT_NATIVE_TRUST_KEY_ID)
    const pair = generateNativeTrustKeyPair(keyId, usages)
    if (options.outPrivate) {
      const privPath = path.resolve(options.outPrivate)
      fs.mkdirSync(path.dirname(privPath), { recursive: true })
      fs.writeFileSync(privPath, pair.privateKeyPem, { encoding: 'utf8', mode: 0o600 })
      console.log(`已写入私钥: ${privPath}`)
    }
    if (options.outPublicJson) {
      const pubPath = path.resolve(options.outPublicJson)
      fs.mkdirSync(path.dirname(pubPath), { recursive: true })
      let existing = []
      if (fs.existsSync(pubPath)) {
        existing = JSON.parse(fs.readFileSync(pubPath, 'utf8'))
        if (!Array.isArray(existing)) throw new Error(`公钥配置文件格式无效: ${pubPath}`)
      }
      const next = existing.filter((entry) => entry && entry.keyId !== keyId)
      next.push({ keyId, publicKeyHex: pair.publicKeyHex, usages: pair.usages })
      fs.writeFileSync(pubPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      console.log(`已更新公钥配置（保留历史公钥共 ${next.length} 把）: ${pubPath}`)
    }
    console.log(`keyId: ${pair.keyId}`)
    console.log(`usages: ${pair.usages.join(',')}`)
    console.log(`publicKeyHex: ${pair.publicKeyHex}`)
    return
  }

  if (command === 'sign') {
    if (!options.dir || !options.pluginId) {
      throw new Error('sign 命令必须指定 --dir 与 --plugin-id')
    }
    const requireAdmin = Boolean(options.requireAdmin)
    const keyMaterial = resolvePrivateKeyMaterial({
      keyPath: options.key,
      keyFilePath: options.keyFile,
      keyId: options.keyId,
      requireAdmin,
      rootDir
    })
    let keyUsages = keyMaterial.keyUsages
    if (options.publicJson) {
      const pubList = JSON.parse(fs.readFileSync(path.resolve(options.publicJson), 'utf8'))
      const pubEntry = Array.isArray(pubList) ? pubList.find((k) => k && k.keyId === keyMaterial.keyId) : null
      if (!pubEntry) throw new Error(`公钥表中未找到 keyId=${keyMaterial.keyId}`)
      const derivedHex = extractP256RawPublicKeyHex(keyMaterial.privateKeyPem)
      if (derivedHex !== String(pubEntry.publicKeyHex || '').toLowerCase()) {
        throw new Error(`私钥与公钥表中的 ${keyMaterial.keyId} 不匹配`)
      }
      keyUsages = pubEntry.usages
    }
    const result = signPluginDirectory({
      pluginDir: options.dir,
      pluginId: options.pluginId,
      pluginVersion: options.pluginVersion,
      requireAdmin,
      keyId: keyMaterial.keyId,
      mainEntries: options.mains,
      commonLibs: options.commonLibs,
      roleOverrides: options.roleOverrides,
      privateKeyPem: keyMaterial.privateKeyPem,
      keyUsages,
      issuedAt: options.issuedAt
    })
    console.log(
      `签名完成: pluginId=${result.manifest.pluginId}, version=${result.manifest.pluginVersion}, requireAdmin=${result.manifest.requireAdmin}, files=${result.manifest.files.length}, keyId=${result.manifest.keyId}`
    )
    return
  }

  if (command === 'verify') {
    if (!options.dir || !options.publicJson) {
      throw new Error('verify 命令必须指定 --dir 与 --public-json')
    }
    const publicKeys = JSON.parse(fs.readFileSync(path.resolve(options.publicJson), 'utf8'))
    const revocations = options.revocationsJson
      ? parseStrictJson(fs.readFileSync(path.resolve(options.revocationsJson), 'utf8'))
      : null
    const verified = verifyPluginDirectory({
      pluginDir: options.dir,
      publicKeys,
      revocations,
      expectedPluginId: options.pluginId || null,
      expectedRequireAdmin: typeof options.requireAdmin === 'boolean' ? options.requireAdmin : null
    })
    console.log(
      `校验通过: pluginId=${verified.manifest.pluginId}, version=${verified.manifest.pluginVersion}, files=${verified.manifest.files.length}, keyId=${verified.keyId}`
    )
    return
  }

  if (command === 'revocations') {
    const filePath = options.file || path.join(rootDir, 'electron-client', 'resources', 'native', 'native-trust-revocations.json')
    const rawText = fs.readFileSync(path.resolve(filePath), 'utf8')
    const parsed = parseStrictJson(rawText)
    validateRevocationsSchema(parsed)
    console.log(
      `吊销清单校验通过: keys=${parsed.revokedKeyIds.length}, manifests=${parsed.revokedManifestSha256.length}, files=${parsed.revokedFileSha256.length}, minVersions=${Object.keys(parsed.minPluginVersions).length}`
    )
    return
  }

  throw new Error(`不支持的命令: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    console.error(`[sign-native-trust] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
