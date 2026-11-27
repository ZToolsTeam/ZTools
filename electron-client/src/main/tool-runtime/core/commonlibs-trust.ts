import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolPlatformArchKey
} from '../../../contracts/tool-runtime/common.js'
import { createToolRuntimeError, isPlainObject } from './errors.js'

/**
 * 第三方公共引擎工具池离线信任校验与防回滚核心模块。
 * 职责：
 * 1. 内建公开公钥锚点（与 resources/commonlibs/commonlibs-public-keys.json 严格一致）；
 * 2. 严格受限 JSON 解析（禁 BOM、禁重复键、限深 8、限串长 4096）；
 * 3. ECDSA P-256 + SHA-256 (IEEE P1363) 域分离离线验签，强制核验 usages 包含 "commonlibs"；
 * 4. Schema v1 校验（支持单平台异构 packages、executables 归属 files、防路径穿越、toolId 对齐）；
 * 5. SemVer 高水位防回滚与撤销列表判定。
 */

export const COMMONLIBS_CATALOG_SCHEMA_VERSION = 1 as const
export const COMMONLIBS_CATALOG_DOMAIN_PREFIX = Buffer.from('ztools-commonlibs-catalog-v1\0', 'ascii')
export const COMMONLIBS_PUBLIC_KEYS_FILE = 'commonlibs-public-keys.json'
export const COMMONLIBS_REVOCATIONS_FILE = 'commonlibs-revocations.json'

export const MAX_COMMONLIBS_JSON_BYTES = 2 * 1024 * 1024
export const MAX_COMMONLIBS_SIGNATURE_BYTES = 256
export const MAX_COMMONLIBS_JSON_DEPTH = 8
export const MAX_COMMONLIBS_JSON_STRING_LEN = 4096
export const MAX_COMMONLIBS_JSON_OBJECT_KEYS = 128

const KEY_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TOOL_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TOOL_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/
const HEX_128_REGEX = /^[a-f0-9]{128}$/
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/

export type CommonLibsKeyUsage = 'native' | 'native-privileged' | 'commonlibs'

const ALLOWED_KEY_USAGES: ReadonlySet<string> = new Set<CommonLibsKeyUsage>([
  'native',
  'native-privileged',
  'commonlibs'
])

export const SUPPORTED_PLATFORM_ARCH_KEYS: readonly ToolPlatformArchKey[] = Object.freeze([
  'win32-x64',
  'darwin-arm64',
  'darwin-x64'
])

const SUPPORTED_PLATFORM_ARCH_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_PLATFORM_ARCH_KEYS)

export interface CommonLibsPublicKeyEntry {
  readonly keyId: string
  readonly publicKeyHex: string
  readonly usages: readonly CommonLibsKeyUsage[]
}

export interface CommonLibsRevocations {
  readonly schemaVersion: 1
  readonly revokedKeyIds: readonly string[]
  readonly revokedToolIds: readonly string[]
  readonly revokedArchiveSha256: readonly string[]
  readonly revokedFileSha256: readonly string[]
  readonly minToolVersions: Readonly<Record<string, string>>
}

export interface CommonLibsTrustBundle {
  readonly publicKeys: readonly CommonLibsPublicKeyEntry[]
  readonly revocations: CommonLibsRevocations
}

export interface CommonLibFileEntry {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

export interface CommonLibPlatformPackage {
  readonly url: string
  readonly size: number
  readonly archiveSha256: string
  readonly executables: readonly string[]
  readonly files: readonly CommonLibFileEntry[]
}

export interface CommonLibCatalogToolEntry {
  readonly toolId: string
  readonly toolName: string
  readonly version: string
  readonly abiMajor: number
  readonly minClientVersion?: string
  readonly publishedAt?: string
  readonly packages: Readonly<Partial<Record<ToolPlatformArchKey, CommonLibPlatformPackage>>>
  readonly license?: string
}

export interface CommonLibsCatalog {
  readonly schemaVersion: 1
  readonly catalogType: 'public' | 'commercial'
  readonly keyId: string
  readonly generatedAt: string
  readonly tools: readonly CommonLibCatalogToolEntry[]
  readonly revocations?: CommonLibsRevocations
}

export interface ParsedCommonLibsSignature {
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

/** 内建公共工具池验签公钥（与 resources/commonlibs/commonlibs-public-keys.json 保持一致） */
export const BUILTIN_COMMONLIBS_PUBLIC_KEYS: readonly CommonLibsPublicKeyEntry[] = Object.freeze([
  Object.freeze({
    keyId: 'ztools-commonlibs-prod-2026a',
    publicKeyHex:
      'c473a0f5f1c4c2502526b596e07816f77fb03bd85cfbaee47c4c94e6cbd343036463e0a961583a055fd572e6b28806eaafba24acb2534063b8da162b26bde7d5',
    usages: Object.freeze(['commonlibs'] as const)
  })
])

export const EMPTY_COMMONLIBS_REVOCATIONS: CommonLibsRevocations = Object.freeze({
  schemaVersion: 1,
  revokedKeyIds: Object.freeze([]),
  revokedToolIds: Object.freeze([]),
  revokedArchiveSha256: Object.freeze([]),
  revokedFileSha256: Object.freeze([]),
  minToolVersions: Object.freeze({})
})

function isReservedWindowsDeviceSegment(segment: string): boolean {
  const base = (segment.split('.')[0] ?? '').toLowerCase()
  return ['con', 'prn', 'aux', 'nul'].includes(base) || /^(?:com|lpt)[1-9]$/.test(base)
}

/** 校验工具包内相对文件路径（禁止路径穿越、绝对路径、反斜杠、控制字符与 Windows 保留设备名） */
export function isSafeCommonLibRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_COMMONLIBS_JSON_STRING_LEN) {
    return false
  }
  if (value.startsWith('/') || value.includes('\\') || value.includes(':')) {
    return false
  }
  if (/[\u0000-\u001f\u007f*?"<>|]/.test(value)) {
    return false
  }
  const segments = value.split('/')
  if (segments.length === 0 || segments.length > 32) {
    return false
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
    if (segment.endsWith('.') || segment.endsWith(' ')) return false
    if (isReservedWindowsDeviceSegment(segment)) return false
  }
  return true
}

/** 解析严格 SemVer 版本号（MAJOR.MINOR.PATCH[-pre]） */
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
    if (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')) {
      return null
    }
  }
  return { major, minor, patch, pre }
}

/** 比较两个 SemVer：返回 -1（小于）、0（等于）、1（大于） */
export function compareSemVer(a: string | ParsedSemVer, b: string | ParsedSemVer): -1 | 0 | 1 {
  const va = typeof a === 'string' ? parseSemVer(a) : a
  const vb = typeof b === 'string' ? parseSemVer(b) : b
  if (!va || !vb) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Invalid SemVer version comparison: ${String(a)} vs ${String(b)}`
    )
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
      return Number(pa) < Number(pb) ? -1 : 1
    }
    if (na !== nb) return na ? -1 : 1
    return pa < pb ? -1 : 1
  }
  return 0
}

interface StrictJsonCursor {
  readonly text: string
  readonly len: number
  pos: number
}

function skipWhitespace(cursor: StrictJsonCursor): void {
  while (cursor.pos < cursor.len) {
    const ch = cursor.text.charCodeAt(cursor.pos)
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      cursor.pos += 1
    } else {
      break
    }
  }
}

function parseStrictString(cursor: StrictJsonCursor): string {
  const { text, len } = cursor
  if (text[cursor.pos] !== '"') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Expected JSON string opening quote at offset ${cursor.pos}`
    )
  }
  cursor.pos += 1
  let out = ''
  while (cursor.pos < len) {
    const ch = text[cursor.pos] ?? ''
    const code = text.charCodeAt(cursor.pos)
    if (ch === '"') {
      cursor.pos += 1
      if (out.length > MAX_COMMONLIBS_JSON_STRING_LEN) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          'JSON string exceeds maximum allowed length (4096)'
        )
      }
      return out
    }
    if (code < 0x20) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Unescaped control character in JSON string at offset ${cursor.pos}`
      )
    }
    if (ch === '\\') {
      cursor.pos += 1
      if (cursor.pos >= len) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          'Unterminated JSON escape sequence'
        )
      }
      const esc = text[cursor.pos] ?? ''
      cursor.pos += 1
      if (esc === '"' || esc === '\\' || esc === '/') out += esc
      else if (esc === 'b') out += '\b'
      else if (esc === 'f') out += '\f'
      else if (esc === 'n') out += '\n'
      else if (esc === 'r') out += '\r'
      else if (esc === 't') out += '\t'
      else if (esc === 'u') {
        if (cursor.pos + 4 > len) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            'Truncated JSON \\u escape sequence'
          )
        }
        const hex = text.slice(cursor.pos, cursor.pos + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            `Invalid JSON \\u escape: ${hex}`
          )
        }
        const unit = parseInt(hex, 16)
        cursor.pos += 4
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (cursor.pos + 6 > len || text[cursor.pos] !== '\\' || text[cursor.pos + 1] !== 'u') {
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
              'Lone high surrogate in JSON string'
            )
          }
          const lowHex = text.slice(cursor.pos + 2, cursor.pos + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) {
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
              `Invalid low surrogate escape: ${lowHex}`
            )
          }
          const lowUnit = parseInt(lowHex, 16)
          if (lowUnit < 0xdc00 || lowUnit > 0xdfff) {
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
              'High surrogate not followed by valid low surrogate'
            )
          }
          cursor.pos += 6
          out += String.fromCharCode(unit, lowUnit)
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            'Lone low surrogate in JSON string'
          )
        } else {
          out += String.fromCharCode(unit)
        }
      } else {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Invalid JSON escape character: \\${esc}`
        )
      }
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = cursor.pos + 1 < len ? text.charCodeAt(cursor.pos + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          'Lone raw high surrogate in JSON string'
        )
      }
      out += ch + (text[cursor.pos + 1] ?? '')
      cursor.pos += 2
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'Lone raw low surrogate in JSON string'
      )
    } else {
      out += ch
      cursor.pos += 1
    }
    if (out.length > MAX_COMMONLIBS_JSON_STRING_LEN) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'JSON string exceeds maximum allowed length (4096)'
      )
    }
  }
  throw createToolRuntimeError(
    TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
    'Unterminated JSON string'
  )
}

function parseStrictNonNegativeInt(cursor: StrictJsonCursor): number {
  const { text, len } = cursor
  const start = cursor.pos
  if (text[cursor.pos] === '-') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Negative numbers are not allowed in CommonLibs trust JSON'
    )
  }
  if (text[cursor.pos] === '0') {
    cursor.pos += 1
    const next = text[cursor.pos]
    if (next !== undefined && next >= '0' && next <= '9') {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'Leading zeros are not allowed in JSON integers'
      )
    }
  } else if ((text[cursor.pos] ?? '') >= '1' && (text[cursor.pos] ?? '') <= '9') {
    while (cursor.pos < len) {
      const cur = text[cursor.pos] ?? ''
      if (cur >= '0' && cur <= '9') cursor.pos += 1
      else break
    }
  } else {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Malformed JSON number at offset ${cursor.pos}`
    )
  }
  const after = text[cursor.pos]
  if (after === '.' || after === 'e' || after === 'E') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Only non-negative integers are allowed in CommonLibs trust JSON'
    )
  }
  const raw = text.slice(start, cursor.pos)
  const num = Number(raw)
  if (!Number.isSafeInteger(num) || num < 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `JSON integer out of safe range: ${raw}`
    )
  }
  return num
}

function parseStrictValue(cursor: StrictJsonCursor, depth: number): unknown {
  if (depth > MAX_COMMONLIBS_JSON_DEPTH) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `JSON nesting depth exceeds ${MAX_COMMONLIBS_JSON_DEPTH}`
    )
  }
  skipWhitespace(cursor)
  if (cursor.pos >= cursor.len) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Unexpected end of JSON input'
    )
  }
  const { text } = cursor
  const ch = text[cursor.pos] ?? ''
  if (ch === '{') {
    if (depth + 1 > MAX_COMMONLIBS_JSON_DEPTH) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `JSON nesting depth exceeds ${MAX_COMMONLIBS_JSON_DEPTH}`
      )
    }
    cursor.pos += 1
    skipWhitespace(cursor)
    const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    if (text[cursor.pos] === '}') {
      cursor.pos += 1
      return obj
    }
    let count = 0
    while (true) {
      skipWhitespace(cursor)
      const key = parseStrictString(cursor)
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Duplicate JSON key detected: ${key}`
        )
      }
      count += 1
      if (count > MAX_COMMONLIBS_JSON_OBJECT_KEYS) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `JSON object key count exceeds ${MAX_COMMONLIBS_JSON_OBJECT_KEYS}`
        )
      }
      skipWhitespace(cursor)
      if (text[cursor.pos] !== ':') {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Expected ':' at offset ${cursor.pos}`
        )
      }
      cursor.pos += 1
      obj[key] = parseStrictValue(cursor, depth + 1)
      skipWhitespace(cursor)
      if (text[cursor.pos] === '}') {
        cursor.pos += 1
        return obj
      }
      if (text[cursor.pos] !== ',') {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Expected ',' or '}' at offset ${cursor.pos}`
        )
      }
      cursor.pos += 1
    }
  }
  if (ch === '[') {
    if (depth + 1 > MAX_COMMONLIBS_JSON_DEPTH) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `JSON nesting depth exceeds ${MAX_COMMONLIBS_JSON_DEPTH}`
      )
    }
    cursor.pos += 1
    skipWhitespace(cursor)
    const arr: unknown[] = []
    if (text[cursor.pos] === ']') {
      cursor.pos += 1
      return arr
    }
    while (true) {
      arr.push(parseStrictValue(cursor, depth + 1))
      skipWhitespace(cursor)
      if (text[cursor.pos] === ']') {
        cursor.pos += 1
        return arr
      }
      if (text[cursor.pos] !== ',') {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Expected ',' or ']' at offset ${cursor.pos}`
        )
      }
      cursor.pos += 1
    }
  }
  if (ch === '"') return parseStrictString(cursor)
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
  if (ch >= '0' && ch <= '9') return parseStrictNonNegativeInt(cursor)
  throw createToolRuntimeError(
    TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
    `Unexpected JSON token '${ch}' at offset ${cursor.pos}`
  )
}

/**
 * 严格受限 JSON 解析器：
 * - 禁止 UTF-8 BOM、禁止重复键、禁止非法转义与未转义控制字符；
 * - 嵌套深度上限 8、字符串长度上限 4096、对象键数上限 128；
 * - 仅允许非负安全整数。
 */
export function parseStrictCommonLibsJson(text: string): unknown {
  if (typeof text !== 'string') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Trust JSON input must be a string'
    )
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMONLIBS_JSON_BYTES) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Trust JSON exceeds maximum byte limit'
    )
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'UTF-8 BOM is forbidden in CommonLibs trust JSON'
    )
  }
  const cursor: StrictJsonCursor = { text, len: text.length, pos: 0 }
  const value = parseStrictValue(cursor, 0)
  skipWhitespace(cursor)
  if (cursor.pos !== cursor.len) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Trailing characters after JSON at offset ${cursor.pos}`
    )
  }
  return value
}

/** 解析单行签名文本 "v1:<keyId>:<128位小写hex>" */
export function parseCommonLibsSignatureLine(rawText: string): ParsedCommonLibsSignature | null {
  if (typeof rawText !== 'string') return null
  if (Buffer.byteLength(rawText, 'utf8') > MAX_COMMONLIBS_SIGNATURE_BYTES) return null
  const stripped = rawText.replace(/\r?\n$/, '')
  if (stripped.includes('\r') || stripped.includes('\n')) return null
  const parts = stripped.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const keyId = parts[1] ?? ''
  const signatureHex = parts[2] ?? ''
  if (!KEY_ID_REGEX.test(keyId) || !HEX_128_REGEX.test(signatureHex)) return null
  return { version: 'v1', keyId, signatureHex }
}

/** 将 128 位小写 hex 原始 X||Y 公钥导入为 ECDSA P-256 KeyObject */
export function importCommonLibsP256PublicKey(publicKeyHex: string): crypto.KeyObject {
  const normalized = publicKeyHex.trim().toLowerCase()
  if (!HEX_128_REGEX.test(normalized)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'P-256 raw public key must be 128 lowercase hex characters'
    )
  }
  const raw = Buffer.from(normalized, 'hex')
  const x = raw.subarray(0, 32).toString('base64url')
  const y = raw.subarray(32, 64).toString('base64url')
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x, y },
    format: 'jwk'
  })
}

/** 校验公钥列表 JSON Schema */
export function validateCommonLibsPublicKeysSchema(value: unknown): readonly CommonLibsPublicKeyEntry[] {
  if (!Array.isArray(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'commonlibs-public-keys.json must be a JSON array'
    )
  }
  const seen = new Set<string>()
  const entries: CommonLibsPublicKeyEntry[] = []
  for (const item of value) {
    if (!isPlainObject(item)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'Public key entry must be an object'
      )
    }
    const keys = Object.keys(item)
    if (keys.length !== 3 || !keys.every((k) => k === 'keyId' || k === 'publicKeyHex' || k === 'usages')) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'Public key entry contains unexpected or missing fields'
      )
    }
    if (typeof item.keyId !== 'string' || !KEY_ID_REGEX.test(item.keyId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid public keyId: ${String(item.keyId)}`
      )
    }
    if (seen.has(item.keyId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Duplicate public keyId: ${item.keyId}`
      )
    }
    seen.add(item.keyId)
    if (typeof item.publicKeyHex !== 'string' || !HEX_128_REGEX.test(item.publicKeyHex)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid publicKeyHex for keyId ${item.keyId}`
      )
    }
    if (!Array.isArray(item.usages) || item.usages.length === 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Public key ${item.keyId} must declare non-empty usages`
      )
    }
    const usages: CommonLibsKeyUsage[] = []
    for (const usage of item.usages) {
      if (typeof usage !== 'string' || !ALLOWED_KEY_USAGES.has(usage)) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Unsupported key usage "${String(usage)}" for keyId ${item.keyId}`
        )
      }
      if (!usages.includes(usage as CommonLibsKeyUsage)) {
        usages.push(usage as CommonLibsKeyUsage)
      }
    }
    entries.push(
      Object.freeze({
        keyId: item.keyId,
        publicKeyHex: item.publicKeyHex,
        usages: Object.freeze(usages)
      })
    )
  }
  return Object.freeze(entries)
}

const ALLOWED_REVOCATION_KEYS = new Set([
  'schemaVersion',
  'revokedKeyIds',
  'revokedToolIds',
  'revokedArchiveSha256',
  'revokedFileSha256',
  'minToolVersions'
])

/** 校验撤销表 JSON Schema */
export function validateCommonLibsRevocationsSchema(value: unknown): CommonLibsRevocations {
  if (!isPlainObject(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'commonlibs-revocations.json must be a JSON object'
    )
  }
  const keys = Object.keys(value)
  if (keys.length !== ALLOWED_REVOCATION_KEYS.size || keys.some((k) => !ALLOWED_REVOCATION_KEYS.has(k))) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'commonlibs-revocations.json contains unexpected or missing fields'
    )
  }
  if (value.schemaVersion !== COMMONLIBS_CATALOG_SCHEMA_VERSION) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Unsupported revocations schemaVersion: ${String(value.schemaVersion)}`
    )
  }
  const readStringArray = (field: string, pattern: RegExp): readonly string[] => {
    const raw = value[field]
    if (!Array.isArray(raw)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Revocations field "${field}" must be an array`
      )
    }
    const out: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string' || !pattern.test(item)) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Invalid entry in revocations.${field}: ${String(item)}`
        )
      }
      if (!out.includes(item)) out.push(item)
    }
    return Object.freeze(out)
  }

  const revokedKeyIds = readStringArray('revokedKeyIds', KEY_ID_REGEX)
  const revokedToolIds = readStringArray('revokedToolIds', TOOL_ID_REGEX)
  const revokedArchiveSha256 = readStringArray('revokedArchiveSha256', SHA256_HEX_REGEX)
  const revokedFileSha256 = readStringArray('revokedFileSha256', SHA256_HEX_REGEX)

  if (!isPlainObject(value.minToolVersions)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Revocations field "minToolVersions" must be an object'
    )
  }
  const minToolVersions: Record<string, string> = {}
  for (const [toolName, minVer] of Object.entries(value.minToolVersions)) {
    if (!TOOL_NAME_REGEX.test(toolName) || typeof minVer !== 'string' || !parseSemVer(minVer)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid minToolVersions entry: ${toolName}=${String(minVer)}`
      )
    }
    minToolVersions[toolName] = minVer
  }
  return Object.freeze({
    schemaVersion: 1,
    revokedKeyIds,
    revokedToolIds,
    revokedArchiveSha256,
    revokedFileSha256,
    minToolVersions: Object.freeze(minToolVersions)
  })
}

export interface LoadTrustBundleOptions {
  /** 可选额外公钥（仅供测试或受控扩展合并，严禁覆盖或移除内建公钥） */
  readonly extraPublicKeys?: readonly CommonLibsPublicKeyEntry[]
  /** 可选额外撤销配置（与资源目录撤销表取严格并集） */
  readonly extraRevocations?: Partial<CommonLibsRevocations>
  /** 仅测试可用：是否忽略内建公钥 */
  readonly replaceBuiltinKeysForTest?: boolean
}

function mergeRevocations(
  base: CommonLibsRevocations,
  incoming: Partial<CommonLibsRevocations>
): CommonLibsRevocations {
  const minToolVersions: Record<string, string> = { ...base.minToolVersions }
  if (incoming.minToolVersions) {
    for (const [toolName, version] of Object.entries(incoming.minToolVersions)) {
      if (!TOOL_NAME_REGEX.test(toolName) || !parseSemVer(version)) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Invalid merged minToolVersions entry: ${toolName}=${String(version)}`
        )
      }
      const existing = minToolVersions[toolName]
      if (!existing || compareSemVer(version, existing) > 0) {
        minToolVersions[toolName] = version
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    revokedKeyIds: Object.freeze(Array.from(new Set([...base.revokedKeyIds, ...(incoming.revokedKeyIds ?? [])]))),
    revokedToolIds: Object.freeze(Array.from(new Set([...base.revokedToolIds, ...(incoming.revokedToolIds ?? [])]))),
    revokedArchiveSha256: Object.freeze(
      Array.from(new Set([...base.revokedArchiveSha256, ...(incoming.revokedArchiveSha256 ?? [])]))
    ),
    revokedFileSha256: Object.freeze(
      Array.from(new Set([...base.revokedFileSha256, ...(incoming.revokedFileSha256 ?? [])]))
    ),
    minToolVersions: Object.freeze(minToolVersions)
  })
}

/**
 * 加载 CommonLibs 离线信任包：
 * - 默认始终以代码内建 `BUILTIN_COMMONLIBS_PUBLIC_KEYS` 为信任根；
 * - 若提供了 `resourcesDir`，则读取其中的公钥与撤销文件并与内建锚点安全合并。
 */
export function loadCommonLibsTrustBundle(
  resourcesDir?: string,
  options: LoadTrustBundleOptions = {}
): CommonLibsTrustBundle {
  const keyMap = new Map<string, CommonLibsPublicKeyEntry>()
  if (!options.replaceBuiltinKeysForTest) {
    for (const entry of BUILTIN_COMMONLIBS_PUBLIC_KEYS) {
      keyMap.set(entry.keyId, entry)
    }
  }

  let revocations: CommonLibsRevocations = EMPTY_COMMONLIBS_REVOCATIONS

  if (resourcesDir) {
    const keysPath = path.join(resourcesDir, COMMONLIBS_PUBLIC_KEYS_FILE)
    if (fs.existsSync(keysPath)) {
      const raw = fs.readFileSync(keysPath, 'utf8')
      const parsed = validateCommonLibsPublicKeysSchema(parseStrictCommonLibsJson(raw))
      for (const entry of parsed) {
        const existing = keyMap.get(entry.keyId)
        if (existing && existing.publicKeyHex !== entry.publicKeyHex) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            `External public key "${entry.keyId}" conflicts with built-in key anchor`
          )
        }
        if (!existing) {
          keyMap.set(entry.keyId, entry)
        }
      }
    }

    const revocationsPath = path.join(resourcesDir, COMMONLIBS_REVOCATIONS_FILE)
    if (fs.existsSync(revocationsPath)) {
      const raw = fs.readFileSync(revocationsPath, 'utf8')
      const parsed = validateCommonLibsRevocationsSchema(parseStrictCommonLibsJson(raw))
      revocations = mergeRevocations(revocations, parsed)
    }
  }

  if (options.extraPublicKeys) {
    const validated = validateCommonLibsPublicKeysSchema(options.extraPublicKeys)
    for (const entry of validated) {
      const existing = keyMap.get(entry.keyId)
      if (existing && existing.publicKeyHex !== entry.publicKeyHex) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Injected public key "${entry.keyId}" conflicts with existing key anchor`
        )
      }
      if (!existing) {
        keyMap.set(entry.keyId, entry)
      }
    }
  }

  if (options.extraRevocations) {
    revocations = mergeRevocations(revocations, options.extraRevocations)
  }

  return Object.freeze({
    publicKeys: Object.freeze(Array.from(keyMap.values())),
    revocations
  })
}

/**
 * 对原始字节执行域分离 ECDSA P-256 + SHA-256 (IEEE P1363) 离线验签。
 * 强制校验：
 * 1. 签名行格式为 v1:<keyId>:<128hex>；
 * 2. keyId 必须存在于信任包中；
 * 3. keyEntry.usages 必须包含 "commonlibs"（严格隔离 native / native-privileged 密钥）；
 * 4. keyId 不在撤销列表中；
 * 5. 对 `ztools-commonlibs-catalog-v1\0 || rawBytes` 的密码学验签必须通过。
 */
export function verifyCommonLibsRawSignature(
  rawBytes: Buffer,
  signatureText: string,
  bundle: CommonLibsTrustBundle
): ParsedCommonLibsSignature {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_COMMONLIBS_JSON_BYTES) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'CommonLibs signed payload is empty or exceeds maximum byte limit'
    )
  }
  const parsedSig = parseCommonLibsSignatureLine(signatureText)
  if (!parsedSig) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'Malformed CommonLibs signature format (expected v1:<keyId>:<128hex>)'
    )
  }
  if (bundle.revocations.revokedKeyIds.includes(parsedSig.keyId)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolRevoked,
      `CommonLibs signing key "${parsedSig.keyId}" has been revoked`
    )
  }
  const keyEntry = bundle.publicKeys.find((item) => item.keyId === parsedSig.keyId)
  if (!keyEntry) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Unknown CommonLibs signing keyId: ${parsedSig.keyId}`
    )
  }
  // 关键安全边界：仅允许显式声明 commonlibs 用途的公钥，严禁 native / native-privileged 密钥越权签发
  if (!keyEntry.usages.includes('commonlibs')) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Public key "${parsedSig.keyId}" is not authorized for "commonlibs" usage`
    )
  }

  let verified = false
  try {
    const publicKey = importCommonLibsP256PublicKey(keyEntry.publicKeyHex)
    const signingInput = Buffer.concat([COMMONLIBS_CATALOG_DOMAIN_PREFIX, rawBytes])
    verified = crypto.verify(
      'sha256',
      signingInput,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parsedSig.signatureHex, 'hex')
    )
  } catch {
    verified = false
  }
  if (!verified) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'CommonLibs ECDSA P-256 signature verification failed'
    )
  }
  return parsedSig
}

const ALLOWED_CATALOG_KEYS = new Set(['schemaVersion', 'catalogType', 'keyId', 'generatedAt', 'tools', 'revocations'])
const ALLOWED_TOOL_ENTRY_KEYS = new Set([
  'toolId',
  'toolName',
  'version',
  'abiMajor',
  'minClientVersion',
  'publishedAt',
  'packages',
  'license'
])
const ALLOWED_PACKAGE_KEYS = new Set(['url', 'size', 'archiveSha256', 'executables', 'files'])
const ALLOWED_FILE_KEYS = new Set(['path', 'size', 'sha256'])
const CLIENT_VERSION_REGEX = /^\d+(?:\.\d+){1,3}$/

function validateEmbeddedRevocations(value: unknown): CommonLibsRevocations {
  if (!isPlainObject(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'CommonLibs catalog revocations must be a JSON object'
    )
  }
  const normalized: Record<string, unknown> = {
    schemaVersion: COMMONLIBS_CATALOG_SCHEMA_VERSION,
    revokedKeyIds: value.revokedKeyIds ?? [],
    revokedToolIds: value.revokedToolIds ?? [],
    revokedArchiveSha256: value.revokedArchiveSha256 ?? [],
    revokedFileSha256: value.revokedFileSha256 ?? [],
    minToolVersions: value.minToolVersions ?? {}
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_REVOCATION_KEYS.has(key)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs catalog revocations contains unknown field: ${key}`
      )
    }
  }
  return validateCommonLibsRevocationsSchema(normalized)
}

function validatePlatformPackage(value: unknown, contextLabel: string): CommonLibPlatformPackage {
  if (!isPlainObject(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) must be an object`
    )
  }
  const keys = Object.keys(value)
  if (keys.length !== ALLOWED_PACKAGE_KEYS.size || keys.some((k) => !ALLOWED_PACKAGE_KEYS.has(k))) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) has invalid fields`
    )
  }
  if (typeof value.url !== 'string' || value.url.length === 0 || value.url.length > 2048) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) has invalid url`
    )
  }
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) has invalid size`
    )
  }
  if (typeof value.archiveSha256 !== 'string' || !SHA256_HEX_REGEX.test(value.archiveSha256)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) has invalid archiveSha256`
    )
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 512) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) must list 1..512 files`
    )
  }
  const seenPaths = new Set<string>()
  const files: CommonLibFileEntry[] = []
  for (const fileItem of value.files) {
    if (!isPlainObject(fileItem)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs file entry (${contextLabel}) must be an object`
      )
    }
    const fKeys = Object.keys(fileItem)
    if (fKeys.length !== ALLOWED_FILE_KEYS.size || fKeys.some((k) => !ALLOWED_FILE_KEYS.has(k))) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs file entry (${contextLabel}) has invalid fields`
      )
    }
    if (!isSafeCommonLibRelativePath(fileItem.path)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs file path is unsafe (${contextLabel}): ${String(fileItem.path)}`
      )
    }
    const lowerPath = fileItem.path.toLowerCase()
    if (seenPaths.has(lowerPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Duplicate file path in CommonLibs package (${contextLabel}): ${fileItem.path}`
      )
    }
    seenPaths.add(lowerPath)
    if (typeof fileItem.size !== 'number' || !Number.isSafeInteger(fileItem.size) || fileItem.size < 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid file size for ${fileItem.path} (${contextLabel})`
      )
    }
    if (typeof fileItem.sha256 !== 'string' || !SHA256_HEX_REGEX.test(fileItem.sha256)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid file sha256 for ${fileItem.path} (${contextLabel})`
      )
    }
    files.push(
      Object.freeze({
        path: fileItem.path,
        size: fileItem.size,
        sha256: fileItem.sha256
      })
    )
  }

  if (!Array.isArray(value.executables) || value.executables.length === 0 || value.executables.length > 64) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `CommonLibs package (${contextLabel}) must declare 1..64 executables`
    )
  }
  const exactFilePathSet = new Set(files.map((item) => item.path))
  const executables: string[] = []
  for (const execPath of value.executables) {
    if (!isSafeCommonLibRelativePath(execPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Unsafe executable path (${contextLabel}): ${String(execPath)}`
      )
    }
    if (!exactFilePathSet.has(execPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Executable "${execPath}" must be listed in package.files (${contextLabel})`
      )
    }
    if (!executables.includes(execPath)) {
      executables.push(execPath)
    }
  }

  return Object.freeze({
    url: value.url,
    size: value.size,
    archiveSha256: value.archiveSha256,
    executables: Object.freeze(executables),
    files: Object.freeze(files)
  })
}

/** 校验 CommonLibs Catalog Schema v1 结构 */
export function validateCommonLibsCatalogSchema(value: unknown): CommonLibsCatalog {
  if (!isPlainObject(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'CommonLibs catalog must be a JSON object'
    )
  }
  const topKeys = Object.keys(value)
  if (topKeys.some((k) => !ALLOWED_CATALOG_KEYS.has(k))) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'CommonLibs catalog contains unexpected top-level fields'
    )
  }
  if (value.schemaVersion !== COMMONLIBS_CATALOG_SCHEMA_VERSION) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Unsupported CommonLibs catalog schemaVersion: ${String(value.schemaVersion)}`
    )
  }
  if (value.catalogType !== 'public' && value.catalogType !== 'commercial') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Unsupported CommonLibs catalogType: ${String(value.catalogType)}`
    )
  }
  if (typeof value.keyId !== 'string' || !KEY_ID_REGEX.test(value.keyId)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Invalid CommonLibs catalog keyId: ${String(value.keyId)}`
    )
  }
  if (typeof value.generatedAt !== 'string' || !ISO_TIMESTAMP_REGEX.test(value.generatedAt)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Invalid CommonLibs catalog generatedAt timestamp: ${String(value.generatedAt)}`
    )
  }
  if (!Array.isArray(value.tools) || value.tools.length > 256) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      'CommonLibs catalog tools must be an array (0..256)'
    )
  }

  const seenToolIds = new Set<string>()
  const tools: CommonLibCatalogToolEntry[] = []

  for (const item of value.tools) {
    if (!isPlainObject(item)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'CommonLibs tool entry must be an object'
      )
    }
    const itemKeys = Object.keys(item)
    if (itemKeys.some((k) => !ALLOWED_TOOL_ENTRY_KEYS.has(k))) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'CommonLibs tool entry contains unknown fields'
      )
    }
    if (typeof item.toolName !== 'string' || !TOOL_NAME_REGEX.test(item.toolName)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid CommonLibs toolName: ${String(item.toolName)}`
      )
    }
    if (typeof item.version !== 'string' || !parseSemVer(item.version)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid CommonLibs tool SemVer version: ${String(item.version)}`
      )
    }
    const expectedToolId = `${item.toolName}-${item.version}`
    if (typeof item.toolId !== 'string' || !TOOL_ID_REGEX.test(item.toolId) || item.toolId !== expectedToolId) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs toolId "${String(item.toolId)}" must exactly equal "${expectedToolId}"`
      )
    }
    if (seenToolIds.has(item.toolId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Duplicate toolId in CommonLibs catalog: ${item.toolId}`
      )
    }
    seenToolIds.add(item.toolId)
    if (typeof item.abiMajor !== 'number' || !Number.isSafeInteger(item.abiMajor) || item.abiMajor < 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid abiMajor for tool ${item.toolId}`
      )
    }
    if (
      item.minClientVersion !== undefined &&
      (typeof item.minClientVersion !== 'string' || !CLIENT_VERSION_REGEX.test(item.minClientVersion))
    ) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid minClientVersion for tool ${item.toolId}`
      )
    }
    if (
      item.publishedAt !== undefined &&
      (typeof item.publishedAt !== 'string' || !ISO_TIMESTAMP_REGEX.test(item.publishedAt))
    ) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid publishedAt timestamp for tool ${item.toolId}`
      )
    }
    if (item.license !== undefined && (typeof item.license !== 'string' || item.license.length === 0 || item.license.length > 128)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Invalid license field for tool ${item.toolId}`
      )
    }
    if (!isPlainObject(item.packages)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs tool ${item.toolId} must contain a packages object`
      )
    }
    const pkgKeys = Object.keys(item.packages)
    if (pkgKeys.length === 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs tool ${item.toolId} must declare at least one platform package`
      )
    }
    const packages: Partial<Record<ToolPlatformArchKey, CommonLibPlatformPackage>> = {}
    for (const platformKey of pkgKeys) {
      if (!SUPPORTED_PLATFORM_ARCH_SET.has(platformKey)) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Unsupported platformArch key "${platformKey}" in tool ${item.toolId}`
        )
      }
      const typedKey = platformKey as ToolPlatformArchKey
      packages[typedKey] = validatePlatformPackage(item.packages[platformKey], `${item.toolId}:${typedKey}`)
    }
    tools.push(
      Object.freeze({
        toolId: item.toolId,
        toolName: item.toolName,
        version: item.version,
        abiMajor: item.abiMajor,
        packages: Object.freeze(packages),
        ...(item.minClientVersion !== undefined ? { minClientVersion: item.minClientVersion } : {}),
        ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
        ...(item.license !== undefined ? { license: item.license } : {})
      })
    )
  }

  const revocations = value.revocations !== undefined ? validateEmbeddedRevocations(value.revocations) : undefined

  return Object.freeze({
    schemaVersion: 1,
    catalogType: value.catalogType,
    keyId: value.keyId,
    generatedAt: value.generatedAt,
    tools: Object.freeze(tools),
    ...(revocations ? { revocations } : {})
  })
}

/**
 * 先对原始字节验签，再执行严格受限 JSON 解析与 Schema v1 校验，
 * 并强制要求 catalog.keyId === signature.keyId。
 */
export function verifyAndParseCommonLibsCatalog(
  rawBytes: Buffer,
  signatureText: string,
  bundle: CommonLibsTrustBundle
): { readonly catalog: CommonLibsCatalog; readonly signature: ParsedCommonLibsSignature } {
  const signature = verifyCommonLibsRawSignature(rawBytes, signatureText, bundle)
  const text = rawBytes.toString('utf8')
  const parsed = parseStrictCommonLibsJson(text)
  const catalog = validateCommonLibsCatalogSchema(parsed)
  if (catalog.keyId !== signature.keyId) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
      `Catalog keyId "${catalog.keyId}" does not match signature keyId "${signature.keyId}"`
    )
  }
  return { catalog, signature }
}

export interface RevocationCheckTarget {
  readonly keyId?: string
  readonly toolId?: string
  readonly archiveSha256?: string
  readonly fileSha256s?: readonly string[]
}

/** 命中任意维度撤销表时立即拒绝 */
export function assertCommonLibNotRevoked(
  target: RevocationCheckTarget,
  revocations: CommonLibsRevocations
): void {
  if (target.keyId && revocations.revokedKeyIds.includes(target.keyId)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolRevoked,
      `CommonLibs key "${target.keyId}" has been revoked`
    )
  }
  if (target.toolId && revocations.revokedToolIds.includes(target.toolId)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolRevoked,
      `CommonLibs tool "${target.toolId}" has been revoked`
    )
  }
  if (target.archiveSha256 && revocations.revokedArchiveSha256.includes(target.archiveSha256)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolRevoked,
      'CommonLibs archive checksum has been revoked'
    )
  }
  if (target.fileSha256s) {
    for (const digest of target.fileSha256s) {
      if (revocations.revokedFileSha256.includes(digest)) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.toolRevoked,
          'CommonLibs file checksum has been revoked'
        )
      }
    }
  }
}

/**
 * 防回滚高水位判定：
 * - 拒绝低于撤销表 `minToolVersions[toolName]` 的版本；
 * - 拒绝低于本地已记录高水位 `localHighWaterVersion` 的版本。
 */
export function assertCommonLibNoRollback(
  toolName: string,
  version: string,
  localHighWaterVersion: string | undefined,
  revocations: CommonLibsRevocations
): void {
  const minRequired = revocations.minToolVersions[toolName]
  if (minRequired && compareSemVer(version, minRequired) < 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolRollbackBlocked,
      `Tool "${toolName}" version ${version} is below minimum allowed version ${minRequired}`
    )
  }
  if (localHighWaterVersion && compareSemVer(version, localHighWaterVersion) < 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolRollbackBlocked,
      `Tool "${toolName}" version ${version} is older than local high-water version ${localHighWaterVersion}`
    )
  }
}
