import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { errorCodes, ZToolsError, type ZToolsErrorCode } from '../../contracts/errors.js'

export const NATIVE_TRUST_SCHEMA_VERSION = 1
export const NATIVE_TRUST_DOMAIN_PREFIX = Buffer.from('ztools-native-trust-v1\0', 'ascii')
export const NATIVE_TRUST_MANIFEST_FILE = 'native-trust.json'
export const NATIVE_TRUST_SIGNATURE_FILE = 'native-trust.sig'
export const NATIVE_TRUST_PUBLIC_KEYS_FILE = 'native-trust-public-keys.json'
export const NATIVE_TRUST_REVOCATIONS_FILE = 'native-trust-revocations.json'
export const NATIVE_TRUST_LEGACY_FROZEN_FILE = 'legacy-frozen-dlls.json'

export const EMPTY_NATIVE_TRUST_PUBLIC_KEYS_JSON = '[]'
export const EMPTY_NATIVE_TRUST_REVOCATIONS_JSON =
  '{"schemaVersion":1,"revokedKeyIds":[],"revokedManifestSha256":[],"revokedFileSha256":[],"minPluginVersions":{}}'
export const EMPTY_NATIVE_TRUST_LEGACY_FROZEN_JSON = '[]'

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
const ALLOWED_USAGES = new Set<NativeTrustKeyUsage>(['native', 'native-privileged', 'commonlibs'])

export type NativeTrustKeyUsage = 'native' | 'native-privileged' | 'commonlibs'
export type NativeTrustFileRole = 'main' | 'dependency' | 'helper'
export type NativeTrustFileArch = 'x86' | 'x64'

export type NativeTrustRejectionCode =
  | 'INVALID_REQUEST'
  | 'MANIFEST_UNAVAILABLE'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_UNTRUSTED'
  | 'MANIFEST_REVOKED'
  | 'MANIFEST_ROLLBACK'
  | 'DLL_NOT_ALLOWED'
  | 'FUNCTION_NOT_ALLOWED'
  | 'DLL_PATH_INVALID'
  | 'DLL_UNAVAILABLE'
  | 'DLL_ARCH_INVALID'
  | 'DLL_INTEGRITY'

export interface NativeTrustPublicKeyEntry {
  readonly keyId: string
  readonly publicKeyHex: string
  readonly usages: readonly NativeTrustKeyUsage[]
}

export interface NativeTrustRevocations {
  readonly schemaVersion: 1
  readonly revokedKeyIds: readonly string[]
  readonly revokedManifestSha256: readonly string[]
  readonly revokedFileSha256: readonly string[]
  readonly minPluginVersions: Readonly<Record<string, string>>
}

export interface NativeTrustLegacyFrozenEntry {
  readonly pluginId: string
  readonly dllId: string
  readonly sha256: string
  readonly functions: readonly string[]
  readonly note?: string
}

export interface NativeTrustBundle {
  readonly publicKeys: readonly NativeTrustPublicKeyEntry[]
  readonly revocations: NativeTrustRevocations
  readonly legacyFrozen: readonly NativeTrustLegacyFrozenEntry[]
  readonly bundleSha256: string
}

export interface NativeTrustMainFileEntry {
  readonly role: 'main'
  readonly dllId: string
  readonly path: string
  readonly arch: 'x86'
  readonly size: number
  readonly sha256: string
  readonly functions: readonly string[]
}

export interface NativeTrustDependencyFileEntry {
  readonly role: 'dependency'
  readonly path: string
  readonly arch: 'x86'
  readonly size: number
  readonly sha256: string
}

export interface NativeTrustHelperFileEntry {
  readonly role: 'helper'
  readonly path: string
  readonly arch: NativeTrustFileArch
  readonly size: number
  readonly sha256: string
}

export type NativeTrustFileEntry =
  | NativeTrustMainFileEntry
  | NativeTrustDependencyFileEntry
  | NativeTrustHelperFileEntry

export interface NativeTrustManifest {
  readonly schemaVersion: 1
  readonly keyId: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly requireAdmin: boolean
  readonly issuedAt: string
  readonly files: readonly NativeTrustFileEntry[]
  /** 可选：仅普通权限官方签名插件声明的签名 CommonLibs 工具池逻辑 ID（requireAdmin=true 严禁出现） */
  readonly commonLibs?: readonly string[]
}

export interface ParsedSignatureLine {
  readonly version: 'v1'
  readonly keyId: string
  readonly signatureHex: string
}

export interface ParsedSemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly pre: readonly string[]
}

export interface PeInspectionResult {
  readonly unsupportedPe: false
  readonly arch: NativeTrustFileArch
  readonly isDll: boolean
  readonly isClrManaged: boolean
  readonly isExecutable: boolean
  readonly size: number
  readonly sha256: string | null
}

export interface UnsupportedPeResult {
  readonly unsupportedPe: true
  readonly machine: number
  readonly reason: string
}

export interface ScannedPeFile extends PeInspectionResult {
  readonly relPath: string
  readonly absPath: string
}

export interface VerifyPluginInstallOptions {
  readonly pluginDir: string
  readonly expectedPluginId: string
  readonly expectedPluginVersion: string
  /** 显式强类型：调用方必须先将 plugin.json.requireAdmin 归一化为 boolean */
  readonly expectedRequireAdmin: boolean
  readonly declaredMainEntries?: readonly string[]
  readonly bundle: NativeTrustBundle
}

export type VerifyPluginInstallResult =
  | {
      readonly verified: true
      readonly mode: 'signed'
      readonly keyId: string
      readonly manifestSha256: string
      readonly manifest: NativeTrustManifest
    }
  | {
      readonly verified: true
      readonly mode: 'legacy-frozen'
      readonly matchedEntries: readonly NativeTrustLegacyFrozenEntry[]
    }
  | {
      readonly verified: true
      readonly mode: 'legacy-unsigned'
      readonly matchedEntries: readonly NativeTrustLegacyFrozenEntry[]
    }

export interface WindowsNativeTrustInstallVerifier {
  verifyInstallDirectory(params: {
    readonly pluginDir: string
    readonly pluginId: string
    readonly pluginVersion: string
    readonly requireAdmin: boolean
    readonly declaredMainEntries: readonly string[]
  }): VerifyPluginInstallResult
  /**
   * 离线验签并提取普通权限官方签名原生插件声明的 CommonLibs 逻辑工具 ID：
   * - 无签名文件（旧冻结表或纯声明式插件）返回空数组；
   * - 签名存在但验签失败/吊销/篡改/特权插件非法携带 commonLibs 时 Fail-Fast 抛错。
   */
  resolveVerifiedCommonLibs?(params: {
    readonly pluginDir: string
    readonly pluginId: string
    readonly pluginVersion?: string
    readonly requireAdmin: boolean
  }): readonly string[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReservedDeviceSegment(segment: string): boolean {
  const base = (segment.split('.')[0] ?? '').toLowerCase()
  return ['con', 'prn', 'aux', 'nul'].includes(base) || /^(?:com|lpt)[1-9]$/.test(base)
}

function mapRejectionToErrorCode(hostCode: NativeTrustRejectionCode): ZToolsErrorCode {
  if (hostCode === 'INVALID_REQUEST') return errorCodes.invalidRequest
  if (
    hostCode === 'MANIFEST_UNTRUSTED' ||
    hostCode === 'MANIFEST_REVOKED' ||
    hostCode === 'MANIFEST_ROLLBACK' ||
    hostCode === 'DLL_NOT_ALLOWED' ||
    hostCode === 'FUNCTION_NOT_ALLOWED'
  ) {
    return errorCodes.permissionDenied
  }
  return errorCodes.pluginIntegrity
}

export function createNativeTrustError(hostCode: NativeTrustRejectionCode, message: string): ZToolsError {
  return new ZToolsError(mapRejectionToErrorCode(hostCode), message, { hostCode })
}

/** 校验安全标识符（与 C++ dll_paths::IsSafeIdentifier 与 sign-native-trust.mjs 严格对齐） */
export function isSafeIdentifier(value: unknown, allowLeadingUnderscore = false): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  const regex = allowLeadingUnderscore ? FUNCTION_IDENTIFIER_REGEX : IDENTIFIER_REGEX
  if (!regex.test(value)) return false
  if (value.endsWith('.')) return false
  if (!allowLeadingUnderscore && isReservedDeviceSegment(value)) return false
  return true
}

/** 校验签名 CommonLibs 逻辑工具 ID（与 C++ IsSafeCommonLibId、sign-native-trust.mjs 及 CommonLibsManager 对齐） */
export function isSafeCommonLibId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  if (!COMMON_LIB_ID_REGEX.test(value)) return false
  if (value.endsWith('.')) return false
  if (isReservedDeviceSegment(value)) return false
  return true
}

/** 解析 SemVer 版本号（MAJOR.MINOR.PATCH[-pre]） */
export function parseSemVer(version: unknown): ParsedSemVer | null {
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
export function compareSemVer(a: string | ParsedSemVer, b: string | ParsedSemVer): -1 | 0 | 1 {
  const va = typeof a === 'string' ? parseSemVer(a) : a
  const vb = typeof b === 'string' ? parseSemVer(b) : b
  if (!va || !vb) {
    throw createNativeTrustError('MANIFEST_INVALID', `Invalid SemVer version: ${String(a)} vs ${String(b)}`)
  }
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1
  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1
  if (vb.pre.length === 0) return -1
  const len = Math.max(va.pre.length, vb.pre.length)
  for (let i = 0; i < len; i += 1) {
    const pa = va.pre[i]
    const pb = vb.pre[i]
    if (pa === undefined) return -1
    if (pb === undefined) return 1
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

/** 校验插件内相对路径（与 C++ ValidateRelativePath 严格对齐） */
export function isSafeRelativeFilePath(
  entry: unknown,
  options: { requireLibPrefix?: boolean; requireDllExtension?: boolean } = {}
): entry is string {
  const { requireLibPrefix = false, requireDllExtension = false } = options
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_JSON_STRING_LEN) return false
  if (entry.startsWith('/') || entry.includes('\\') || entry.includes(':')) return false
  if (/[\u0000-\u001f\u007f*?"<>|]/.test(entry)) return false
  const segments = entry.split('/')
  if (segments.length === 0) return false
  const firstSegment = segments[0] ?? ''
  if (requireLibPrefix && (segments.length < 2 || firstSegment.toLowerCase() !== 'lib')) return false
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
    if (segment.endsWith('.') || segment.endsWith(' ')) return false
    if (isReservedDeviceSegment(segment)) return false
  }
  const lastSegment = segments[segments.length - 1] ?? ''
  if (requireDllExtension && !lastSegment.toLowerCase().endsWith('.dll')) {
    return false
  }
  return true
}

interface StrictJsonCursor {
  readonly text: string
  readonly len: number
  pos: number
}

function skipJsonWhitespace(cursor: StrictJsonCursor): void {
  while (cursor.pos < cursor.len) {
    const ch = cursor.text.charCodeAt(cursor.pos)
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) cursor.pos += 1
    else break
  }
}

function parseStrictJsonString(cursor: StrictJsonCursor): string {
  const { text, len } = cursor
  if (text[cursor.pos] !== '"') {
    throw createNativeTrustError('MANIFEST_INVALID', `Expected opening quote at offset ${cursor.pos}`)
  }
  cursor.pos += 1
  let out = ''
  while (cursor.pos < len) {
    const ch = text[cursor.pos] ?? ''
    const code = text.charCodeAt(cursor.pos)
    if (ch === '"') {
      cursor.pos += 1
      if (out.length > MAX_JSON_STRING_LEN) {
        throw createNativeTrustError('MANIFEST_INVALID', 'JSON string exceeds maximum length')
      }
      return out
    }
    if (code < 0x20) {
      throw createNativeTrustError('MANIFEST_INVALID', `Unescaped control character in JSON string at ${cursor.pos}`)
    }
    if (ch === '\\') {
      cursor.pos += 1
      if (cursor.pos >= len) throw createNativeTrustError('MANIFEST_INVALID', 'Unterminated JSON escape sequence')
      const esc = text[cursor.pos] ?? ''
      cursor.pos += 1
      if (esc === '"' || esc === '\\' || esc === '/') out += esc
      else if (esc === 'b') out += '\b'
      else if (esc === 'f') out += '\f'
      else if (esc === 'n') out += '\n'
      else if (esc === 'r') out += '\r'
      else if (esc === 't') out += '\t'
      else if (esc === 'u') {
        if (cursor.pos + 4 > len) throw createNativeTrustError('MANIFEST_INVALID', 'Truncated JSON \\u escape')
        const hex = text.slice(cursor.pos, cursor.pos + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw createNativeTrustError('MANIFEST_INVALID', `Invalid \\u escape: ${hex}`)
        }
        const unit = parseInt(hex, 16)
        cursor.pos += 4
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (cursor.pos + 6 > len || text[cursor.pos] !== '\\' || text[cursor.pos + 1] !== 'u') {
            throw createNativeTrustError('MANIFEST_INVALID', 'Lone high surrogate in JSON string')
          }
          const lowHex = text.slice(cursor.pos + 2, cursor.pos + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) {
            throw createNativeTrustError('MANIFEST_INVALID', `Invalid low surrogate escape: ${lowHex}`)
          }
          const lowUnit = parseInt(lowHex, 16)
          if (lowUnit < 0xdc00 || lowUnit > 0xdfff) {
            throw createNativeTrustError('MANIFEST_INVALID', 'High surrogate not followed by low surrogate')
          }
          cursor.pos += 6
          out += String.fromCharCode(unit, lowUnit)
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw createNativeTrustError('MANIFEST_INVALID', 'Lone low surrogate in JSON string')
        } else {
          out += String.fromCharCode(unit)
        }
      } else {
        throw createNativeTrustError('MANIFEST_INVALID', `Invalid JSON escape character: \\${esc}`)
      }
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = cursor.pos + 1 < len ? text.charCodeAt(cursor.pos + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) {
        throw createNativeTrustError('MANIFEST_INVALID', 'Lone raw high surrogate in JSON string')
      }
      out += ch + (text[cursor.pos + 1] ?? '')
      cursor.pos += 2
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw createNativeTrustError('MANIFEST_INVALID', 'Lone raw low surrogate in JSON string')
    } else {
      out += ch
      cursor.pos += 1
    }
    if (out.length > MAX_JSON_STRING_LEN) {
      throw createNativeTrustError('MANIFEST_INVALID', 'JSON string exceeds maximum length')
    }
  }
  throw createNativeTrustError('MANIFEST_INVALID', 'Unterminated JSON string')
}

function parseStrictJsonNumber(cursor: StrictJsonCursor): number {
  const { text, len } = cursor
  const start = cursor.pos
  if (text[cursor.pos] === '-') throw createNativeTrustError('MANIFEST_INVALID', 'Negative JSON numbers are not allowed')
  if (text[cursor.pos] === '0') {
    cursor.pos += 1
    const next = text[cursor.pos]
    if (next !== undefined && next >= '0' && next <= '9') {
      throw createNativeTrustError('MANIFEST_INVALID', 'Leading zeros are not allowed in JSON integers')
    }
  } else if ((text[cursor.pos] ?? '') >= '1' && (text[cursor.pos] ?? '') <= '9') {
    while (cursor.pos < len) {
      const cur = text[cursor.pos] ?? ''
      if (cur >= '0' && cur <= '9') cursor.pos += 1
      else break
    }
  } else {
    throw createNativeTrustError('MANIFEST_INVALID', `Malformed JSON number at offset ${cursor.pos}`)
  }
  const after = text[cursor.pos]
  if (after === '.' || after === 'e' || after === 'E') {
    throw createNativeTrustError('MANIFEST_INVALID', 'Only non-negative JSON integers are allowed')
  }
  const raw = text.slice(start, cursor.pos)
  const num = Number(raw)
  if (!Number.isSafeInteger(num) || num < 0 || num > Number.MAX_SAFE_INTEGER) {
    throw createNativeTrustError('MANIFEST_INVALID', `JSON integer out of 0..2^53-1 range: ${raw}`)
  }
  return num
}

function parseStrictJsonValue(cursor: StrictJsonCursor, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw createNativeTrustError('MANIFEST_INVALID', `JSON nesting depth exceeds ${MAX_JSON_DEPTH}`)
  }
  skipJsonWhitespace(cursor)
  if (cursor.pos >= cursor.len) throw createNativeTrustError('MANIFEST_INVALID', 'Unexpected end of JSON input')
  const { text } = cursor
  const ch = text[cursor.pos] ?? ''
  if (ch === '{') {
    if (depth + 1 > MAX_JSON_DEPTH) {
      throw createNativeTrustError('MANIFEST_INVALID', `JSON nesting depth exceeds ${MAX_JSON_DEPTH}`)
    }
    cursor.pos += 1
    skipJsonWhitespace(cursor)
    const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    if (text[cursor.pos] === '}') {
      cursor.pos += 1
      return obj
    }
    let count = 0
    while (true) {
      skipJsonWhitespace(cursor)
      const key = parseStrictJsonString(cursor)
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Duplicate JSON key: ${key}`)
      }
      count += 1
      if (count > MAX_JSON_OBJECT_KEYS) {
        throw createNativeTrustError('MANIFEST_INVALID', `JSON object key count exceeds ${MAX_JSON_OBJECT_KEYS}`)
      }
      skipJsonWhitespace(cursor)
      if (text[cursor.pos] !== ':') {
        throw createNativeTrustError('MANIFEST_INVALID', `Expected colon at offset ${cursor.pos}`)
      }
      cursor.pos += 1
      obj[key] = parseStrictJsonValue(cursor, depth + 1)
      skipJsonWhitespace(cursor)
      if (text[cursor.pos] === '}') {
        cursor.pos += 1
        return obj
      }
      if (text[cursor.pos] !== ',') {
        throw createNativeTrustError('MANIFEST_INVALID', `Expected comma or closing brace at offset ${cursor.pos}`)
      }
      cursor.pos += 1
    }
  }
  if (ch === '[') {
    if (depth + 1 > MAX_JSON_DEPTH) {
      throw createNativeTrustError('MANIFEST_INVALID', `JSON nesting depth exceeds ${MAX_JSON_DEPTH}`)
    }
    cursor.pos += 1
    skipJsonWhitespace(cursor)
    const arr: unknown[] = []
    if (text[cursor.pos] === ']') {
      cursor.pos += 1
      return arr
    }
    while (true) {
      arr.push(parseStrictJsonValue(cursor, depth + 1))
      skipJsonWhitespace(cursor)
      if (text[cursor.pos] === ']') {
        cursor.pos += 1
        return arr
      }
      if (text[cursor.pos] !== ',') {
        throw createNativeTrustError('MANIFEST_INVALID', `Expected comma or closing bracket at offset ${cursor.pos}`)
      }
      cursor.pos += 1
    }
  }
  if (ch === '"') return parseStrictJsonString(cursor)
  if (ch === 't' && text.startsWith('true', cursor.pos)) {
    cursor.pos += 4
    return true
  }
  if (ch === 'f' && text.startsWith('false', cursor.pos)) {
    cursor.pos += 5
    return false
  }
  if (ch === 'n' && text.startsWith('null', cursor.pos)) {
    cursor.pos += 4
    return null
  }
  if (ch >= '0' && ch <= '9') return parseStrictJsonNumber(cursor)
  throw createNativeTrustError('MANIFEST_INVALID', `Unexpected JSON token '${ch}' at offset ${cursor.pos}`)
}

/**
 * 严格受限 JSON 解析器（与 C++ shared/native_trust_json.hpp 与 sign-native-trust.mjs 规则完全一致）：
 * - 拒绝 UTF-8 BOM、重复键、非法转义、孤立代理对、未转义控制字符
 * - 限制嵌套深度 <= 8、单对象键数 <= 64、字符串长度 <= 4096
 * - 整数仅接受 0..2^53-1（拒绝负数、小数、科学计数法与前导零）
 */
export function parseStrictJson(text: string): unknown {
  if (typeof text !== 'string') throw createNativeTrustError('MANIFEST_INVALID', 'JSON input must be a string')
  if (text.charCodeAt(0) === 0xfeff) {
    throw createNativeTrustError('MANIFEST_INVALID', 'UTF-8 BOM is not allowed in JSON')
  }
  const cursor: StrictJsonCursor = { text, len: text.length, pos: 0 }
  const value = parseStrictJsonValue(cursor, 0)
  skipJsonWhitespace(cursor)
  if (cursor.pos !== cursor.len) {
    throw createNativeTrustError('MANIFEST_INVALID', `Trailing characters after JSON at offset ${cursor.pos}`)
  }
  return value
}

/** 解析 .sig 单行签名文本 "v1:<keyId>:<128位小写hex>" */
export function parseSignatureLine(rawText: string): ParsedSignatureLine | null {
  if (typeof rawText !== 'string') return null
  if (Buffer.byteLength(rawText, 'utf8') > MAX_SIGNATURE_BYTES) return null
  const stripped = rawText.replace(/\r?\n$/, '')
  if (stripped.includes('\r') || stripped.includes('\n')) return null
  const parts = stripped.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const keyId = parts[1] ?? ''
  const signatureHex = parts[2] ?? ''
  if (!KEY_ID_REGEX.test(keyId) || !HEX_128_REGEX.test(signatureHex)) return null
  return { version: 'v1', keyId, signatureHex }
}

/** 将 128 位小写 hex 原始 X||Y 公钥还原为 Node.js KeyObject */
export function importP256RawPublicKeyHex(publicKeyHex: string): crypto.KeyObject {
  const normalized = publicKeyHex.trim().toLowerCase()
  if (!HEX_128_REGEX.test(normalized)) {
    throw createNativeTrustError('MANIFEST_UNTRUSTED', 'P-256 raw public key must be 128 hex characters (64-byte X||Y)')
  }
  const raw = Buffer.from(normalized, 'hex')
  const x = raw.subarray(0, 32).toString('base64url')
  const y = raw.subarray(32, 64).toString('base64url')
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x, y },
    format: 'jwk'
  })
}

/** 校验域分离 ECDSA P-256 IEEE P1363 原始签名（prefix || raw_bytes） */
export function verifyNativeTrustSignature(
  manifestBytes: Buffer,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  const normalizedSig = signatureHex.trim().toLowerCase()
  if (!HEX_128_REGEX.test(normalizedSig)) return false
  try {
    const publicKey = importP256RawPublicKeyHex(publicKeyHex)
    const signingInput = Buffer.concat([NATIVE_TRUST_DOMAIN_PREFIX, manifestBytes])
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

/** 计算与 CMake ZTOOLS_NATIVE_TRUST_BUNDLE_SHA256 逐字节一致的信任包摘要 */
export function computeNativeTrustBundleSha256(texts: {
  readonly publicKeysText?: string | undefined
  readonly revocationsText?: string | undefined
  readonly legacyFrozenText?: string | undefined
}): string {
  const p = (texts.publicKeysText ?? EMPTY_NATIVE_TRUST_PUBLIC_KEYS_JSON).replace(/\r\n/g, '\n').trim()
  const r = (texts.revocationsText ?? EMPTY_NATIVE_TRUST_REVOCATIONS_JSON).replace(/\r\n/g, '\n').trim()
  const l = (texts.legacyFrozenText ?? EMPTY_NATIVE_TRUST_LEGACY_FROZEN_JSON).replace(/\r\n/g, '\n').trim()
  const combined = `publicKeys=${p}\nrevocations=${r}\nlegacyFrozen=${l}\n`
  return crypto.createHash('sha256').update(combined, 'utf8').digest('hex')
}

/** 校验公钥表 JSON 结构 */
export function validatePublicKeysSchema(value: unknown): readonly NativeTrustPublicKeyEntry[] {
  if (!Array.isArray(value)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'native-trust-public-keys.json must be an array')
  }
  const seenKeyIds = new Set<string>()
  const entries: NativeTrustPublicKeyEntry[] = []
  for (const item of value) {
    if (!isPlainRecord(item)) {
      throw createNativeTrustError('MANIFEST_INVALID', 'Public key entry must be an object')
    }
    const keys = Object.keys(item)
    if (keys.length !== 3 || !keys.every((k) => k === 'keyId' || k === 'publicKeyHex' || k === 'usages')) {
      throw createNativeTrustError('MANIFEST_INVALID', 'Public key entry has invalid fields')
    }
    if (typeof item.keyId !== 'string' || !KEY_ID_REGEX.test(item.keyId)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid public keyId: ${String(item.keyId)}`)
    }
    if (seenKeyIds.has(item.keyId)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Duplicate public keyId: ${item.keyId}`)
    }
    seenKeyIds.add(item.keyId)
    if (typeof item.publicKeyHex !== 'string' || !HEX_128_REGEX.test(item.publicKeyHex)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid publicKeyHex for keyId=${item.keyId}`)
    }
    if (!Array.isArray(item.usages) || item.usages.length === 0) {
      throw createNativeTrustError('MANIFEST_INVALID', `Missing usages for keyId=${item.keyId}`)
    }
    const usages: NativeTrustKeyUsage[] = []
    for (const usage of item.usages) {
      if (typeof usage !== 'string' || !ALLOWED_USAGES.has(usage as NativeTrustKeyUsage)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Invalid usage for keyId=${item.keyId}: ${String(usage)}`)
      }
      usages.push(usage as NativeTrustKeyUsage)
    }
    entries.push({ keyId: item.keyId, publicKeyHex: item.publicKeyHex, usages })
  }
  return entries
}

/** 校验吊销清单 JSON 结构 */
export function validateRevocationsSchema(value: unknown): NativeTrustRevocations {
  if (!isPlainRecord(value)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'native-trust-revocations.json must be an object')
  }
  const keys = Object.keys(value)
  if (keys.length !== ALLOWED_REVOCATION_KEYS.size || !keys.every((k) => ALLOWED_REVOCATION_KEYS.has(k))) {
    throw createNativeTrustError('MANIFEST_INVALID', 'native-trust-revocations.json has missing or unknown fields')
  }
  if (value.schemaVersion !== NATIVE_TRUST_SCHEMA_VERSION) {
    throw createNativeTrustError('MANIFEST_INVALID', 'Revocations schemaVersion must be 1')
  }
  if (!Array.isArray(value.revokedKeyIds)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'revokedKeyIds must be an array')
  }
  const revokedKeyIds: string[] = []
  for (const keyId of value.revokedKeyIds) {
    if (typeof keyId !== 'string' || !KEY_ID_REGEX.test(keyId)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid revokedKeyIds entry: ${String(keyId)}`)
    }
    revokedKeyIds.push(keyId)
  }
  if (!Array.isArray(value.revokedManifestSha256)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'revokedManifestSha256 must be an array')
  }
  const revokedManifestSha256: string[] = []
  for (const h of value.revokedManifestSha256) {
    if (typeof h !== 'string' || !SHA256_HEX_REGEX.test(h)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid revokedManifestSha256 entry: ${String(h)}`)
    }
    revokedManifestSha256.push(h)
  }
  if (!Array.isArray(value.revokedFileSha256)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'revokedFileSha256 must be an array')
  }
  const revokedFileSha256: string[] = []
  for (const h of value.revokedFileSha256) {
    if (typeof h !== 'string' || !SHA256_HEX_REGEX.test(h)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid revokedFileSha256 entry: ${String(h)}`)
    }
    revokedFileSha256.push(h)
  }
  if (!isPlainRecord(value.minPluginVersions)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'minPluginVersions must be an object')
  }
  const minPluginVersions: Record<string, string> = {}
  for (const [pluginId, version] of Object.entries(value.minPluginVersions)) {
    if (!isSafeIdentifier(pluginId)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid pluginId in minPluginVersions: ${pluginId}`)
    }
    if (typeof version !== 'string' || !parseSemVer(version)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid SemVer in minPluginVersions[${pluginId}]: ${String(version)}`)
    }
    minPluginVersions[pluginId] = version
  }
  return {
    schemaVersion: 1,
    revokedKeyIds,
    revokedManifestSha256,
    revokedFileSha256,
    minPluginVersions
  }
}

/** 校验冻结表 JSON 结构 */
export function validateLegacyFrozenSchema(value: unknown): readonly NativeTrustLegacyFrozenEntry[] {
  if (!Array.isArray(value)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'legacy-frozen-dlls.json must be an array')
  }
  const allowedKeys = new Set(['pluginId', 'dllId', 'sha256', 'functions', 'note'])
  const entries: NativeTrustLegacyFrozenEntry[] = []
  for (const item of value) {
    if (!isPlainRecord(item)) {
      throw createNativeTrustError('MANIFEST_INVALID', 'Legacy frozen entry must be an object')
    }
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Unknown field in legacy frozen entry: ${key}`)
      }
    }
    if (!isSafeIdentifier(item.pluginId) || !isSafeIdentifier(item.dllId)) {
      throw createNativeTrustError('MANIFEST_INVALID', 'Invalid pluginId or dllId in legacy frozen entry')
    }
    if (typeof item.sha256 !== 'string' || !SHA256_HEX_REGEX.test(item.sha256)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid sha256 for legacy entry ${item.pluginId}/${item.dllId}`)
    }
    if (!Array.isArray(item.functions) || item.functions.length === 0 || item.functions.length > MAX_FUNCTIONS_PER_MAIN) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid functions list for legacy entry ${item.pluginId}/${item.dllId}`)
    }
    const functions: string[] = []
    const seen = new Set<string>()
    for (const fn of item.functions) {
      if (!isSafeIdentifier(fn, true) || seen.has(fn)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Invalid or duplicate legacy function name: ${String(fn)}`)
      }
      seen.add(fn)
      functions.push(fn)
    }
    if (item.note !== undefined && typeof item.note !== 'string') {
      throw createNativeTrustError('MANIFEST_INVALID', 'Legacy frozen entry note must be a string')
    }
    entries.push({
      pluginId: item.pluginId,
      dllId: item.dllId,
      sha256: item.sha256,
      functions,
      ...(item.note !== undefined ? { note: item.note } : {})
    })
  }
  return entries
}

/** 校验 Schema v1 native-trust.json 严格结构 */
export function validateNativeTrustManifestSchema(value: unknown): NativeTrustManifest {
  if (!isPlainRecord(value)) {
    throw createNativeTrustError('MANIFEST_INVALID', 'native-trust.json root must be an object')
  }
  const topKeys = Object.keys(value)
  const hasAllRequired = [...REQUIRED_TOP_LEVEL_KEYS].every((k) => Object.prototype.hasOwnProperty.call(value, k))
  if (!hasAllRequired || !topKeys.every((k) => ALLOWED_TOP_LEVEL_KEYS.has(k))) {
    throw createNativeTrustError('MANIFEST_INVALID', 'native-trust.json has missing or unknown top-level fields')
  }
  if (value.schemaVersion !== NATIVE_TRUST_SCHEMA_VERSION) {
    throw createNativeTrustError('MANIFEST_INVALID', `schemaVersion must be ${NATIVE_TRUST_SCHEMA_VERSION}`)
  }
  if (typeof value.keyId !== 'string' || !KEY_ID_REGEX.test(value.keyId)) {
    throw createNativeTrustError('MANIFEST_INVALID', `Invalid keyId: ${String(value.keyId)}`)
  }
  if (!isSafeIdentifier(value.pluginId)) {
    throw createNativeTrustError('MANIFEST_INVALID', `Invalid pluginId: ${String(value.pluginId)}`)
  }
  if (typeof value.pluginVersion !== 'string' || !parseSemVer(value.pluginVersion)) {
    throw createNativeTrustError('MANIFEST_INVALID', `Invalid pluginVersion: ${String(value.pluginVersion)}`)
  }
  if (typeof value.requireAdmin !== 'boolean') {
    throw createNativeTrustError('MANIFEST_INVALID', 'requireAdmin must be a boolean')
  }
  if (typeof value.issuedAt !== 'string' || value.issuedAt.length === 0 || value.issuedAt.length > 64) {
    throw createNativeTrustError('MANIFEST_INVALID', 'Invalid issuedAt')
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES_PER_MANIFEST) {
    throw createNativeTrustError('MANIFEST_INVALID', `files must be a non-empty array of 1..${MAX_FILES_PER_MANIFEST} items`)
  }

  let validatedCommonLibs: string[] | undefined
  if (Object.prototype.hasOwnProperty.call(value, 'commonLibs')) {
    // 护栏 2：特权插件（SYSTEM）严禁声明用户目录 CommonLibs 依赖
    if (value.requireAdmin) {
      throw createNativeTrustError(
        'MANIFEST_INVALID',
        'Privileged plugins (requireAdmin=true) are forbidden from declaring CommonLibs dependencies'
      )
    }
    if (!Array.isArray(value.commonLibs) || value.commonLibs.length > MAX_COMMON_LIBS_PER_MANIFEST) {
      throw createNativeTrustError(
        'MANIFEST_INVALID',
        `commonLibs must be an array of 0..${MAX_COMMON_LIBS_PER_MANIFEST} items`
      )
    }
    const seenLibs = new Set<string>()
    validatedCommonLibs = []
    for (const libId of value.commonLibs) {
      if (!isSafeCommonLibId(libId)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Invalid commonLibs toolId: ${String(libId)}`)
      }
      if (seenLibs.has(libId)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Duplicate commonLibs toolId: ${libId}`)
      }
      seenLibs.add(libId)
      validatedCommonLibs.push(libId)
    }
  }

  const seenPaths = new Set<string>()
  const seenDllIds = new Set<string>()
  const files: NativeTrustFileEntry[] = []
  let mainCount = 0

  for (const item of value.files) {
    if (!isPlainRecord(item)) {
      throw createNativeTrustError('MANIFEST_INVALID', 'files entry must be an object')
    }
    const role = item.role
    if (role !== 'main' && role !== 'dependency' && role !== 'helper') {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid files[].role: ${String(role)}`)
    }
    const itemKeys = Object.keys(item)
    const allowedSet = role === 'main' ? ALLOWED_MAIN_FILE_KEYS : ALLOWED_AUX_FILE_KEYS
    if (itemKeys.length !== allowedSet.size || !itemKeys.every((k) => allowedSet.has(k))) {
      throw createNativeTrustError('MANIFEST_INVALID', `files entry fields do not match role=${role}`)
    }
    const relPath = item.path
    if (
      !isSafeRelativeFilePath(relPath, {
        requireLibPrefix: value.requireAdmin,
        requireDllExtension: role === 'main' || role === 'dependency'
      })
    ) {
      throw createNativeTrustError('MANIFEST_INVALID', `Unsafe relative file path: ${String(relPath)}`)
    }
    const pathKey = relPath.toLowerCase()
    if (seenPaths.has(pathKey)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Duplicate path in files: ${relPath}`)
    }
    seenPaths.add(pathKey)

    if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid size for files[${relPath}]`)
    }
    if (typeof item.sha256 !== 'string' || !SHA256_HEX_REGEX.test(item.sha256)) {
      throw createNativeTrustError('MANIFEST_INVALID', `Invalid sha256 for files[${relPath}]`)
    }

    if (role === 'main') {
      mainCount += 1
      if (item.arch !== 'x86') {
        throw createNativeTrustError('MANIFEST_INVALID', `main entry must be x86 DLL: ${relPath}`)
      }
      if (!isSafeIdentifier(item.dllId)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Invalid main.dllId: ${String(item.dllId)}`)
      }
      const dllKey = item.dllId.toLowerCase()
      if (seenDllIds.has(dllKey)) {
        throw createNativeTrustError('MANIFEST_INVALID', `Duplicate main.dllId: ${item.dllId}`)
      }
      seenDllIds.add(dllKey)
      if (!Array.isArray(item.functions) || item.functions.length === 0 || item.functions.length > MAX_FUNCTIONS_PER_MAIN) {
        throw createNativeTrustError('MANIFEST_INVALID', `Invalid functions list for main[${item.dllId}]`)
      }
      const functions: string[] = []
      const seenFns = new Set<string>()
      for (const fn of item.functions) {
        if (!isSafeIdentifier(fn, true)) {
          throw createNativeTrustError('MANIFEST_INVALID', `Invalid function identifier: ${String(fn)}`)
        }
        if (seenFns.has(fn)) {
          throw createNativeTrustError('MANIFEST_INVALID', `Duplicate function identifier: ${fn}`)
        }
        seenFns.add(fn)
        functions.push(fn)
      }
      files.push({
        role: 'main',
        dllId: item.dllId,
        path: relPath,
        arch: 'x86',
        size: item.size,
        sha256: item.sha256,
        functions
      })
    } else if (role === 'dependency') {
      if (item.arch !== 'x86') {
        throw createNativeTrustError('MANIFEST_INVALID', `dependency entry must be x86 DLL: ${relPath}`)
      }
      files.push({
        role: 'dependency',
        path: relPath,
        arch: 'x86',
        size: item.size,
        sha256: item.sha256
      })
    } else {
      if (item.arch !== 'x86' && item.arch !== 'x64') {
        throw createNativeTrustError('MANIFEST_INVALID', `helper.arch must be x86 or x64: ${relPath}`)
      }
      files.push({
        role: 'helper',
        path: relPath,
        arch: item.arch,
        size: item.size,
        sha256: item.sha256
      })
    }
  }

  if (mainCount === 0) {
    throw createNativeTrustError('MANIFEST_INVALID', 'files must contain at least one role="main" entry')
  }
  return {
    schemaVersion: 1,
    keyId: value.keyId,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    requireAdmin: value.requireAdmin,
    issuedAt: value.issuedAt,
    files,
    ...(validatedCommonLibs !== undefined ? { commonLibs: validatedCommonLibs } : {})
  }
}

/** 从 resources/native 目录加载三份信任根 JSON（缺失视为空表，存在但非法时 Fail-Fast 抛错） */
export function loadNativeTrustBundle(nativeResourcesDir: string): NativeTrustBundle {
  const readOptionalFile = (fileName: string): string | undefined => {
    const filePath = path.join(nativeResourcesDir, fileName)
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false })
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw createNativeTrustError('MANIFEST_INVALID', `Trust bundle file is not a regular file: ${fileName}`)
    }
    return fs.readFileSync(filePath, 'utf8')
  }

  const publicKeysText = readOptionalFile(NATIVE_TRUST_PUBLIC_KEYS_FILE)
  const revocationsText = readOptionalFile(NATIVE_TRUST_REVOCATIONS_FILE)
  const legacyFrozenText = readOptionalFile(NATIVE_TRUST_LEGACY_FROZEN_FILE)

  const publicKeys = validatePublicKeysSchema(
    parseStrictJson(publicKeysText ?? EMPTY_NATIVE_TRUST_PUBLIC_KEYS_JSON)
  )
  const revocations = validateRevocationsSchema(
    parseStrictJson(revocationsText ?? EMPTY_NATIVE_TRUST_REVOCATIONS_JSON)
  )
  const legacyFrozen = validateLegacyFrozenSchema(
    parseStrictJson(legacyFrozenText ?? EMPTY_NATIVE_TRUST_LEGACY_FROZEN_JSON)
  )
  const bundleSha256 = computeNativeTrustBundleSha256({
    publicKeysText,
    revocationsText,
    legacyFrozenText
  })
  return { publicKeys, revocations, legacyFrozen, bundleSha256 }
}

/**
 * 探测并解析 PE 文件头（支持 x86/x64 的 DLL、EXE、.sys 内核驱动与 .node）：
 * - 非 PE 返回 null
 * - 合法 PE 返回 PeInspectionResult
 * - 畸形或不支持架构（如 ARM64）的 PE 返回 UnsupportedPeResult 以便外层 Fail-Closed 拦截
 */
export function inspectPeFile(
  filePath: string,
  options: { computeHash?: boolean } = {}
): PeInspectionResult | UnsupportedPeResult | null {
  const { computeHash = true } = options
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) {
    throw createNativeTrustError('DLL_PATH_INVALID', `Symbolic link or reparse point is forbidden: ${filePath}`)
  }
  if (!stat.isFile() || stat.size < 64) return null

  const fd = fs.openSync(filePath, 'r')
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size < 64) return null

    const dos = Buffer.alloc(64)
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64) return null
    if (dos.readUInt16LE(0) !== 0x5a4d) return null // 非 MZ
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset + 26 > opened.size) return null

    const coffAndMagic = Buffer.alloc(26)
    if (fs.readSync(fd, coffAndMagic, 0, 26, peOffset) !== 26) return null
    if (coffAndMagic.readUInt32LE(0) !== 0x00004550) return null // 非 PE\0\0

    const machine = coffAndMagic.readUInt16LE(4)
    const sections = coffAndMagic.readUInt16LE(6)
    const optionalSize = coffAndMagic.readUInt16LE(20)
    const characteristics = coffAndMagic.readUInt16LE(22)
    const optionalMagic = coffAndMagic.readUInt16LE(24)
    const sectionTableEnd = peOffset + 24 + optionalSize + sections * 40
    if (sections < 1 || sections > 96 || sectionTableEnd > opened.size) {
      return { unsupportedPe: true, machine, reason: 'PE section table out of bounds' }
    }

    let arch: NativeTrustFileArch | null = null
    let isClrManaged = false
    if (machine === PE_MACHINE_IA32 && optionalMagic === PE32_OPTIONAL_MAGIC && optionalSize >= 96) {
      arch = 'x86'
      if (optionalSize >= 216 && peOffset + 24 + 216 <= opened.size) {
        const clr = Buffer.alloc(8)
        if (fs.readSync(fd, clr, 0, 8, peOffset + 24 + 96 + IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR * 8) === 8) {
          isClrManaged = clr.readUInt32LE(0) !== 0 && clr.readUInt32LE(4) !== 0
        }
      }
    } else if (machine === PE_MACHINE_AMD64 && optionalMagic === PE32PLUS_OPTIONAL_MAGIC && optionalSize >= 112) {
      arch = 'x64'
      if (optionalSize >= 232 && peOffset + 24 + 232 <= opened.size) {
        const clr = Buffer.alloc(8)
        if (fs.readSync(fd, clr, 0, 8, peOffset + 24 + 112 + IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR * 8) === 8) {
          isClrManaged = clr.readUInt32LE(0) !== 0 && clr.readUInt32LE(4) !== 0
        }
      }
    } else {
      return { unsupportedPe: true, machine, reason: `Unsupported PE machine: 0x${machine.toString(16)}` }
    }

    const isExecutable = (characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) !== 0
    if (!isExecutable) {
      return { unsupportedPe: true, machine, reason: 'Missing IMAGE_FILE_EXECUTABLE_IMAGE flag' }
    }
    const isDll = (characteristics & IMAGE_FILE_DLL) !== 0

    let sha256: string | null = null
    if (computeHash) {
      const hash = crypto.createHash('sha256')
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let offset = 0
      while (offset < opened.size) {
        const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - offset), offset)
        if (bytesRead <= 0) break
        hash.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
        offset += bytesRead
      }
      const after = fs.fstatSync(fd)
      if (offset !== opened.size || after.size !== opened.size) {
        throw createNativeTrustError('DLL_INTEGRITY', `PE file changed while hashing: ${filePath}`)
      }
      sha256 = hash.digest('hex')
    }

    return {
      unsupportedPe: false,
      arch,
      isDll,
      isClrManaged,
      isExecutable,
      size: opened.size,
      sha256
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** 递归枚举插件目录内的所有 PE 文件（遇符号链接/不支持的 PE 一律 Fail-Closed） */
export function scanPeFilesInDirectory(pluginDir: string, options: { computeHash?: boolean } = {}): ScannedPeFile[] {
  const absDir = path.resolve(pluginDir)
  const rootStat = fs.lstatSync(absDir)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw createNativeTrustError('DLL_PATH_INVALID', `Plugin directory is invalid or a symbolic link: ${absDir}`)
  }
  const results: ScannedPeFile[] = []
  const walk = (currentAbs: string, relPrefix: string): void => {
    const entries = fs.readdirSync(currentAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(currentAbs, entry.name)
      const stat = fs.lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        throw createNativeTrustError('DLL_PATH_INVALID', `Symbolic link is forbidden inside plugin directory: ${fullPath}`)
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (stat.isDirectory()) {
        walk(fullPath, relPath)
      } else if (stat.isFile()) {
        const pe = inspectPeFile(fullPath, options)
        if (pe) {
          if (pe.unsupportedPe) {
            throw createNativeTrustError('DLL_ARCH_INVALID', `Unsupported PE file ${relPath}: ${pe.reason}`)
          }
          results.push({ relPath, absPath: fullPath, ...pe })
        }
      }
    }
  }
  walk(absDir, '')
  return results
}

/**
 * 探测目录内是否包含任意 PE 文件或 native-trust.json / native-trust.sig（供安装期触发条件 ③ 使用）。
 * 扫描时遇到符号链接立即 Fail-Closed 抛错。
 */
export function directoryHasPeOrTrustFiles(pluginDir: string): boolean {
  const absDir = path.resolve(pluginDir)
  const rootStat = fs.lstatSync(absDir)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw createNativeTrustError('DLL_PATH_INVALID', `Plugin directory is invalid or a symbolic link: ${absDir}`)
  }
  const manifestPath = path.join(absDir, NATIVE_TRUST_MANIFEST_FILE)
  const sigPath = path.join(absDir, NATIVE_TRUST_SIGNATURE_FILE)
  if (
    fs.lstatSync(manifestPath, { throwIfNoEntry: false }) !== undefined ||
    fs.lstatSync(sigPath, { throwIfNoEntry: false }) !== undefined
  ) {
    return true
  }
  const walk = (currentAbs: string): boolean => {
    const entries = fs.readdirSync(currentAbs, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentAbs, entry.name)
      const stat = fs.lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        throw createNativeTrustError('DLL_PATH_INVALID', `Symbolic link is forbidden inside plugin directory: ${fullPath}`)
      }
      if (stat.isDirectory()) {
        if (walk(fullPath)) return true
      } else if (stat.isFile()) {
        const pe = inspectPeFile(fullPath, { computeHash: false })
        if (pe !== null) return true
      }
    }
    return false
  }
  return walk(absDir)
}

function assertNoSymlinkSegmentsWithinRoot(absRoot: string, relPath: string): string {
  const segments = relPath.split('/')
  let current = absRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) {
      throw createNativeTrustError('DLL_UNAVAILABLE', `Declared file does not exist: ${relPath}`)
    }
    if (stat.isSymbolicLink()) {
      throw createNativeTrustError('DLL_PATH_INVALID', `Path contains symbolic link or reparse point: ${relPath}`)
    }
  }
  const realRoot = fs.realpathSync(absRoot)
  const realTarget = fs.realpathSync(current)
  const rel = path.relative(realRoot, realTarget)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw createNativeTrustError('DLL_PATH_INVALID', `Resolved file path escapes plugin root: ${relPath}`)
  }
  return current
}

/**
 * 纯内存载荷 + 签名校验（先验 `.sig` 与原始字节签名，通过后再严格解析 JSON 与 Schema 校验；不含磁盘文件校验）。
 * 供黄金向量单测与安装期校验复用。
 */
export function verifySignedManifestPayload(params: {
  readonly manifestBytes: Buffer
  readonly signatureText: string
  readonly expectedPluginId: string
  readonly expectedRequireAdmin: boolean
  readonly expectedPluginVersion?: string
  readonly bundle: NativeTrustBundle
}): {
  readonly keyId: string
  readonly manifestSha256: string
  readonly manifest: NativeTrustManifest
} {
  const { manifestBytes, signatureText, expectedPluginId, expectedRequireAdmin, expectedPluginVersion, bundle } = params
  if (!isSafeIdentifier(expectedPluginId)) {
    throw createNativeTrustError('INVALID_REQUEST', `Invalid pluginId format: ${expectedPluginId}`)
  }
  if (typeof expectedRequireAdmin !== 'boolean') {
    throw createNativeTrustError('INVALID_REQUEST', 'expectedRequireAdmin must be an explicit boolean')
  }
  if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw createNativeTrustError('MANIFEST_UNAVAILABLE', `Invalid native-trust.json size: ${manifestBytes.length}`)
  }
  if (Buffer.byteLength(signatureText, 'utf8') === 0 || Buffer.byteLength(signatureText, 'utf8') > MAX_SIGNATURE_BYTES) {
    throw createNativeTrustError('MANIFEST_UNAVAILABLE', 'Invalid native-trust.sig size')
  }

  const parsedSig = parseSignatureLine(signatureText)
  if (!parsedSig) {
    throw createNativeTrustError('MANIFEST_INVALID', 'Invalid native-trust.sig format (expected v1:<keyId>:<128hex>)')
  }

  const requiredUsage: NativeTrustKeyUsage = expectedRequireAdmin ? 'native-privileged' : 'native'
  const matchedKey = bundle.publicKeys.find((item) => item.keyId === parsedSig.keyId)
  if (!matchedKey || !matchedKey.usages.includes(requiredUsage)) {
    throw createNativeTrustError(
      'MANIFEST_UNTRUSTED',
      `No trusted public key for keyId=${parsedSig.keyId} with usage=${requiredUsage}`
    )
  }
  if (bundle.revocations.revokedKeyIds.includes(parsedSig.keyId)) {
    throw createNativeTrustError('MANIFEST_REVOKED', `Signing key has been revoked: ${parsedSig.keyId}`)
  }

  // 先验签、后解析 JSON
  if (!verifyNativeTrustSignature(manifestBytes, parsedSig.signatureHex, matchedKey.publicKeyHex)) {
    throw createNativeTrustError('MANIFEST_UNTRUSTED', 'ECDSA P-256 signature verification failed')
  }

  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex')
  if (bundle.revocations.revokedManifestSha256.includes(manifestSha256)) {
    throw createNativeTrustError('MANIFEST_REVOKED', `Manifest digest has been revoked: ${manifestSha256}`)
  }

  let manifestText: string
  try {
    // 严格 UTF-8 解码，同时保留 BOM（ignoreBOM: true）交由 parseStrictJson 显式拒绝
    manifestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(manifestBytes)
  } catch {
    throw createNativeTrustError('MANIFEST_INVALID', 'native-trust.json contains invalid UTF-8 byte sequence')
  }
  const parsedJson = parseStrictJson(manifestText)
  const manifest = validateNativeTrustManifestSchema(parsedJson)

  if (manifest.keyId !== parsedSig.keyId) {
    throw createNativeTrustError(
      'MANIFEST_INVALID',
      `Manifest keyId (${manifest.keyId}) does not match signature keyId (${parsedSig.keyId})`
    )
  }
  if (manifest.pluginId.toLowerCase() !== expectedPluginId.toLowerCase()) {
    throw createNativeTrustError(
      'MANIFEST_INVALID',
      `Manifest pluginId (${manifest.pluginId}) does not match expected pluginId (${expectedPluginId})`
    )
  }
  if (manifest.requireAdmin !== expectedRequireAdmin) {
    throw createNativeTrustError(
      'DLL_NOT_ALLOWED',
      `Manifest requireAdmin (${String(manifest.requireAdmin)}) does not match expected (${String(expectedRequireAdmin)})`
    )
  }
  if (expectedPluginVersion !== undefined && manifest.pluginVersion !== expectedPluginVersion) {
    throw createNativeTrustError(
      'MANIFEST_INVALID',
      `Manifest pluginVersion (${manifest.pluginVersion}) does not match plugin.json version (${expectedPluginVersion})`
    )
  }

  const minVerEntry = Object.entries(bundle.revocations.minPluginVersions).find(
    ([id]) => id.toLowerCase() === manifest.pluginId.toLowerCase()
  )
  if (minVerEntry && compareSemVer(manifest.pluginVersion, minVerEntry[1]) < 0) {
    throw createNativeTrustError(
      'MANIFEST_ROLLBACK',
      `Plugin version ${manifest.pluginVersion} is below minimum allowed version ${minVerEntry[1]}`
    )
  }

  return { keyId: parsedSig.keyId, manifestSha256, manifest }
}

/**
 * 安全探测并读取插件目录内的配对签名文件（native-trust.json + native-trust.sig）：
 * - 两者均不存在返回 null；
 * - 任一缺失、为符号链接/非常规文件或体积越界时 Fail-Fast 抛 MANIFEST_UNAVAILABLE。
 */
function readPairedNativeTrustFiles(absDir: string): {
  readonly manifestBytes: Buffer
  readonly signatureText: string
} | null {
  const manifestPath = path.join(absDir, NATIVE_TRUST_MANIFEST_FILE)
  const sigPath = path.join(absDir, NATIVE_TRUST_SIGNATURE_FILE)
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false })
  const sigStat = fs.lstatSync(sigPath, { throwIfNoEntry: false })
  if (manifestStat === undefined && sigStat === undefined) {
    return null
  }
  if (!manifestStat || !sigStat) {
    throw createNativeTrustError('MANIFEST_UNAVAILABLE', 'Missing paired native-trust.json or native-trust.sig')
  }
  if (
    manifestStat.isSymbolicLink() ||
    sigStat.isSymbolicLink() ||
    !manifestStat.isFile() ||
    !sigStat.isFile()
  ) {
    throw createNativeTrustError('MANIFEST_UNAVAILABLE', 'native-trust.json or native-trust.sig is not a regular file')
  }
  if (
    manifestStat.size === 0 ||
    manifestStat.size > MAX_MANIFEST_BYTES ||
    sigStat.size === 0 ||
    sigStat.size > MAX_SIGNATURE_BYTES
  ) {
    throw createNativeTrustError('MANIFEST_UNAVAILABLE', 'native-trust.json or native-trust.sig size is out of bounds')
  }
  return {
    manifestBytes: fs.readFileSync(manifestPath),
    signatureText: fs.readFileSync(sigPath, 'utf8')
  }
}

/**
 * 安装期目录完整信任校验（对应方案 §3.5 与 B5）：
 * - 分支 A（存在 native-trust.json 或 .sig）：严格先验签后解析、吊销/最低版本、全 PE 哈希与封闭性检查（严禁降级冻结表）
 * - 分支 B（均不存在）：仅允许普通插件命中冻结表（特权一律拒绝，且不得存在未被批准的额外主入口；冻结分支仅校验主 DLL，伴生文件不跨越用户权限边界）
 */
export function verifyPluginInstallDirectory(options: VerifyPluginInstallOptions): VerifyPluginInstallResult {
  const {
    pluginDir,
    expectedPluginId,
    expectedPluginVersion,
    expectedRequireAdmin,
    declaredMainEntries = [],
    bundle
  } = options

  if (!isSafeIdentifier(expectedPluginId)) {
    throw createNativeTrustError('INVALID_REQUEST', `Invalid pluginId format: ${expectedPluginId}`)
  }
  if (!parseSemVer(expectedPluginVersion)) {
    throw createNativeTrustError('INVALID_REQUEST', `Invalid pluginVersion format: ${expectedPluginVersion}`)
  }
  if (typeof expectedRequireAdmin !== 'boolean') {
    throw createNativeTrustError('INVALID_REQUEST', 'expectedRequireAdmin must be an explicit boolean')
  }

  const absDir = path.resolve(pluginDir)
  const rootStat = fs.lstatSync(absDir, { throwIfNoEntry: false })
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw createNativeTrustError('DLL_PATH_INVALID', `Plugin directory is invalid or a symbolic link: ${absDir}`)
  }

  const pairedFiles = readPairedNativeTrustFiles(absDir)

  // 分支 A：任一签名文件存在即强制走严格签名验证，严禁降级到旧版兼容分支
  if (pairedFiles !== null) {
    const requiredUsage: NativeTrustKeyUsage = expectedRequireAdmin ? 'native-privileged' : 'native'
    const hasUsableKey = bundle.publicKeys.some((entry) => entry.usages.includes(requiredUsage))
    if (!hasUsableKey) {
      throw createNativeTrustError(
        'MANIFEST_UNTRUSTED',
        `Native trust root has no usable public keys for usage=${requiredUsage}`
      )
    }

    const verifiedPayload = verifySignedManifestPayload({
      manifestBytes: pairedFiles.manifestBytes,
      signatureText: pairedFiles.signatureText,
      expectedPluginId,
      expectedRequireAdmin,
      expectedPluginVersion,
      bundle
    })

    // 封闭性枚举（跳过扫描期重复哈希）+ 全 PE 架构/大小/哈希/吊销校验
    const allPeFiles = scanPeFilesInDirectory(absDir, { computeHash: false })
    const declaredPaths = new Set<string>()
    for (const file of verifiedPayload.manifest.files) {
      declaredPaths.add(file.path.toLowerCase())
      const targetAbs = assertNoSymlinkSegmentsWithinRoot(absDir, file.path)
      const pe = inspectPeFile(targetAbs)
      if (!pe) {
        throw createNativeTrustError('DLL_ARCH_INVALID', `Declared file is not a valid PE image: ${file.path}`)
      }
      if (pe.unsupportedPe) {
        throw createNativeTrustError('DLL_ARCH_INVALID', `Declared file has unsupported PE architecture: ${file.path}`)
      }
      if (file.role === 'main' || file.role === 'dependency') {
        if (pe.arch !== 'x86' || !pe.isDll || pe.isClrManaged) {
          throw createNativeTrustError('DLL_ARCH_INVALID', `${file.role} file must be a native Win32 x86 DLL: ${file.path}`)
        }
      } else if (pe.arch !== file.arch) {
        throw createNativeTrustError(
          'DLL_ARCH_INVALID',
          `Helper architecture mismatch (declared ${file.arch}, actual ${pe.arch}): ${file.path}`
        )
      }
      if (pe.size !== file.size || pe.sha256 !== file.sha256) {
        throw createNativeTrustError('DLL_INTEGRITY', `File integrity mismatch: ${file.path}`)
      }
      if (pe.sha256 !== null && bundle.revocations.revokedFileSha256.includes(pe.sha256)) {
        throw createNativeTrustError('MANIFEST_REVOKED', `File digest has been revoked: ${file.path}`)
      }
    }

    for (const pe of allPeFiles) {
      if (!declaredPaths.has(pe.relPath.toLowerCase())) {
        throw createNativeTrustError('DLL_NOT_ALLOWED', `Undeclared PE file detected in package: ${pe.relPath}`)
      }
    }

    return {
      verified: true,
      mode: 'signed',
      keyId: verifiedPayload.keyId,
      manifestSha256: verifiedPayload.manifestSha256,
      manifest: verifiedPayload.manifest
    }
  }

  // 分支 B：无签名文件 → 旧版本原生插件兼容放行（不走新验签逻辑，保留路径安全、架构合法、吊销与最低版本校验）
  const minVerEntry = Object.entries(bundle.revocations.minPluginVersions).find(
    ([id]) => id.toLowerCase() === expectedPluginId.toLowerCase()
  )
  if (minVerEntry && compareSemVer(expectedPluginVersion, minVerEntry[1]) < 0) {
    throw createNativeTrustError(
      'MANIFEST_ROLLBACK',
      `Plugin version ${expectedPluginVersion} is below minimum allowed version ${minVerEntry[1]}`
    )
  }

  const frozenForPlugin = bundle.legacyFrozen.filter(
    (entry) => entry.pluginId.toLowerCase() === expectedPluginId.toLowerCase()
  )

  const allPeFiles = scanPeFilesInDirectory(absDir)
  for (const pe of allPeFiles) {
    if (pe.sha256 !== null && bundle.revocations.revokedFileSha256.includes(pe.sha256)) {
      throw createNativeTrustError('MANIFEST_REVOKED', `Unsigned plugin contains a revoked binary: ${pe.relPath}`)
    }
  }

  const normalizedDeclared = [...new Set(
    declaredMainEntries
      .map((entry) => entry.trim().replaceAll('\\', '/'))
      .filter((entry) => entry.length > 0)
  )]
  if (normalizedDeclared.length === 0) {
    throw createNativeTrustError(
      'DLL_NOT_ALLOWED',
      `Unsigned plugin ${expectedPluginId} carries PE files without declaring a main DLL entry`
    )
  }

  const peByLowerPath = new Map(allPeFiles.map((pe) => [pe.relPath.toLowerCase(), pe]))
  const matchedEntries: NativeTrustLegacyFrozenEntry[] = []
  const approvedMainPaths = new Set<string>()
  const approvedDllIds = new Set<string>()
  let allMatchedFrozen = frozenForPlugin.length > 0

  for (const declaredPath of normalizedDeclared) {
    if (!isSafeRelativeFilePath(declaredPath, { requireLibPrefix: expectedRequireAdmin, requireDllExtension: true })) {
      throw createNativeTrustError('DLL_PATH_INVALID', `Invalid main DLL entry path: ${declaredPath}`)
    }
    const lowerPath = declaredPath.toLowerCase()
    const pe = peByLowerPath.get(lowerPath)
    if (!pe || pe.arch !== 'x86' || !pe.isDll || pe.isClrManaged || pe.sha256 === null) {
      throw createNativeTrustError('DLL_ARCH_INVALID', `Main DLL entry is not a valid Win32 x86 DLL: ${declaredPath}`)
    }
    const baseName = path.posix.basename(declaredPath)
    const dllId = baseName.slice(0, -4)
    if (!isSafeIdentifier(dllId)) {
      throw createNativeTrustError('DLL_PATH_INVALID', `Invalid main DLL identifier: ${dllId}`)
    }
    const matched = frozenForPlugin.find(
      (entry) => entry.dllId.toLowerCase() === dllId.toLowerCase() && entry.sha256 === pe.sha256
    )
    if (matched) {
      matchedEntries.push(matched)
    } else {
      allMatchedFrozen = false
    }
    approvedMainPaths.add(lowerPath)
    approvedDllIds.add(dllId.toLowerCase())
  }

  // 防止与已声明主入口同名的重复 DLL 造成运行时解析歧义
  for (const pe of allPeFiles) {
    const lowerPath = pe.relPath.toLowerCase()
    if (approvedMainPaths.has(lowerPath)) continue
    if (!lowerPath.endsWith('.dll')) continue
    const baseName = path.posix.basename(pe.relPath)
    const candidateDllId = baseName.slice(0, -4).toLowerCase()
    if (approvedDllIds.has(candidateDllId)) {
      throw createNativeTrustError('DLL_NOT_ALLOWED', `Unsigned plugin contains duplicate main DLL entry: ${pe.relPath}`)
    }
  }

  return {
    verified: true,
    mode: allMatchedFrozen && !expectedRequireAdmin ? 'legacy-frozen' : 'legacy-unsigned',
    matchedEntries
  }
}

/**
 * 轻量离线验签并提取普通权限官方签名原生插件声明的 CommonLibs 逻辑工具 ID：
 * - 严禁采信未签名的 plugin.json；必须先对 native-trust.json/.sig 执行 ECDSA 离线验签、吊销与权限对齐校验；
 * - 无签名文件（历史冻结表或纯声明式插件）返回空数组；
 * - 若只存在半套签名文件、验签失败、吊销、或特权插件违规携带 commonLibs，一律 Fail-Fast 抛错。
 */
export function verifySignedPluginCommonLibs(options: {
  readonly pluginDir: string
  readonly expectedPluginId: string
  readonly expectedPluginVersion?: string
  readonly expectedRequireAdmin: boolean
  readonly bundle: NativeTrustBundle
}): readonly string[] {
  const { pluginDir, expectedPluginId, expectedPluginVersion, expectedRequireAdmin, bundle } = options
  if (!isSafeIdentifier(expectedPluginId)) {
    throw createNativeTrustError('INVALID_REQUEST', `Invalid pluginId format: ${expectedPluginId}`)
  }
  if (typeof expectedRequireAdmin !== 'boolean') {
    throw createNativeTrustError('INVALID_REQUEST', 'expectedRequireAdmin must be an explicit boolean')
  }
  const absDir = path.resolve(pluginDir)
  const rootStat = fs.lstatSync(absDir, { throwIfNoEntry: false })
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw createNativeTrustError('DLL_PATH_INVALID', `Plugin directory is invalid: ${absDir}`)
  }

  const pairedFiles = readPairedNativeTrustFiles(absDir)
  if (pairedFiles === null) {
    return []
  }

  const verifiedPayload = verifySignedManifestPayload({
    manifestBytes: pairedFiles.manifestBytes,
    signatureText: pairedFiles.signatureText,
    expectedPluginId,
    expectedRequireAdmin,
    ...(expectedPluginVersion !== undefined ? { expectedPluginVersion } : {}),
    bundle
  })
  // 护栏 2 二次防线：特权插件严禁返回任何用户目录 CommonLibs 依赖
  if (expectedRequireAdmin || verifiedPayload.manifest.requireAdmin) {
    return []
  }
  return verifiedPayload.manifest.commonLibs ?? []
}

/** 创建基于 resources/native 目录的安装期校验器（每次按固定已加载 bundle 执行，缺失 JSON 视为空表） */
export function createWindowsNativeTrustInstallVerifier(
  nativeResourcesDirOrBundle: string | NativeTrustBundle
): WindowsNativeTrustInstallVerifier {
  const bundle = typeof nativeResourcesDirOrBundle === 'string'
    ? loadNativeTrustBundle(nativeResourcesDirOrBundle)
    : nativeResourcesDirOrBundle
  return {
    verifyInstallDirectory({ pluginDir, pluginId, pluginVersion, requireAdmin, declaredMainEntries }) {
      return verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: pluginId,
        expectedPluginVersion: pluginVersion,
        expectedRequireAdmin: requireAdmin,
        declaredMainEntries,
        bundle
      })
    },
    resolveVerifiedCommonLibs({ pluginDir, pluginId, pluginVersion, requireAdmin }) {
      return verifySignedPluginCommonLibs({
        pluginDir,
        expectedPluginId: pluginId,
        ...(pluginVersion !== undefined ? { expectedPluginVersion: pluginVersion } : {}),
        expectedRequireAdmin: requireAdmin,
        bundle
      })
    }
  }
}
