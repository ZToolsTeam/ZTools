import type {
  JwtDecodedResult,
  JwtVerificationResult,
  UrlInspectResult,
  UrlQueryParamItem,
} from './types.js'

export function decodeBase64UrlToUtf8(segment: string): string {
  const trimmed = String(segment || '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_BASE64URL_SEGMENT: Base64URL 段不能为空')
  }
  if (!/^[A-Za-z0-9\-_]+={0,2}$/.test(trimmed)) {
    throw new Error('INVALID_BASE64URL_CHARS: 包含非法 Base64URL 字符')
  }

  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (normalized.length % 4)) % 4
  const padded = normalized + '='.repeat(padLen)

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8')
  }
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function encodeUtf8ToBase64Url(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(String(input), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  }
  const bytes = new TextEncoder().encode(String(input))
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function formatEpochSec(sec: unknown): string | undefined {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
    return undefined
  }
  const date = new Date(sec * 1000)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatDurationSec(absSec: number): string {
  const days = Math.floor(absSec / 86400)
  const hours = Math.floor((absSec % 86400) / 3600)
  const minutes = Math.floor((absSec % 3600) / 60)
  const seconds = Math.floor(absSec % 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}小时`)
  if (minutes > 0) parts.push(`${minutes}分`)
  if (parts.length === 0 || seconds > 0) parts.push(`${seconds}秒`)
  return parts.slice(0, 3).join(' ')
}

export function decodeJwtToken(rawInput: string, nowMs: number = Date.now()): JwtDecodedResult {
  const cleaned = String(rawInput || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim()

  if (!cleaned) {
    throw new Error('EMPTY_JWT_TOKEN: JWT Token 不能为空')
  }

  const segments = cleaned.split('.')
  if (segments.length !== 3) {
    throw new Error(
      `INVALID_JWT_STRUCTURE: 标准 JWT 必须包含 3 段 (Header.Payload.Signature)，当前为 ${segments.length} 段`,
    )
  }

  const [headerRaw, payloadRaw, signatureRaw] = segments
  let headerObj: Record<string, unknown>
  let payloadObj: Record<string, unknown>

  try {
    const headerJson = decodeBase64UrlToUtf8(headerRaw)
    const parsedHeader = JSON.parse(headerJson)
    if (!parsedHeader || typeof parsedHeader !== 'object' || Array.isArray(parsedHeader)) {
      throw new Error('Header 不是合法 JSON 对象')
    }
    headerObj = parsedHeader as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `INVALID_JWT_HEADER: Header 段 Base64URL 或 JSON 解析失败 (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  try {
    const payloadJson = decodeBase64UrlToUtf8(payloadRaw)
    const parsedPayload = JSON.parse(payloadJson)
    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
      throw new Error('Payload 不是合法 JSON 对象')
    }
    payloadObj = parsedPayload as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `INVALID_JWT_PAYLOAD: Payload 段 Base64URL 或 JSON 解析失败 (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  const algorithm = typeof headerObj.alg === 'string' ? headerObj.alg : 'UNKNOWN'
  const issuedAtText = formatEpochSec(payloadObj.iat)
  const notBeforeText = formatEpochSec(payloadObj.nbf)
  const expiresAtText = formatEpochSec(payloadObj.exp)

  let isExpired = false
  let expiryCountdownText = '未设置过期时间 (永不过期)'
  if (typeof payloadObj.exp === 'number' && Number.isFinite(payloadObj.exp)) {
    const nowSec = Math.floor(nowMs / 1000)
    const diffSec = payloadObj.exp - nowSec
    if (diffSec <= 0) {
      isExpired = true
      expiryCountdownText = `已过期 ${formatDurationSec(Math.abs(diffSec))}`
    } else {
      isExpired = false
      expiryCountdownText = `剩余 ${formatDurationSec(diffSec)} 有效`
    }
  }

  return {
    rawToken: cleaned,
    headerRaw,
    payloadRaw,
    signatureRaw,
    header: headerObj,
    payload: payloadObj,
    algorithm,
    issuedAtText,
    notBeforeText,
    expiresAtText,
    isExpired,
    expiryCountdownText,
  }
}

async function computeHmacSha256Base64Url(signingInput: string, secret: string): Promise<string> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const enc = new TextEncoder()
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(signingInput))
    const bytes = new Uint8Array(sigBuf)
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
    }
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }

  throw new Error('CRYPTO_UNAVAILABLE: 当前环境不支持 WebCrypto SubtleCrypto HMAC-SHA256')
}

export async function verifyJwtHmacSha256(
  rawToken: string,
  secret: string,
): Promise<JwtVerificationResult> {
  const decoded = decodeJwtToken(rawToken)
  if (!secret) {
    throw new Error('EMPTY_JWT_SECRET: 验签密钥 Secret 不能为空')
  }
  if (decoded.algorithm.toUpperCase() !== 'HS256') {
    return {
      verified: false,
      algorithm: decoded.algorithm,
      expectedSignature: '',
      actualSignature: decoded.signatureRaw,
      reason: `当前仅支持 HS256 对称密钥验签，Token 声明算法为 ${decoded.algorithm}`,
    }
  }

  const signingInput = `${decoded.headerRaw}.${decoded.payloadRaw}`
  const expectedSignature = await computeHmacSha256Base64Url(signingInput, secret)
  const verified = expectedSignature === decoded.signatureRaw

  return {
    verified,
    algorithm: decoded.algorithm,
    expectedSignature,
    actualSignature: decoded.signatureRaw,
    reason: verified ? 'HMAC-SHA256 签名一致' : '签名不匹配，密钥错误或载荷已被篡改',
  }
}

export async function signJwtHmacSha256(
  payload: Record<string, unknown>,
  secret: string,
  headerOverrides?: Record<string, unknown>,
): Promise<string> {
  if (!secret) {
    throw new Error('EMPTY_JWT_SECRET: 签发密钥 Secret 不能为空')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('INVALID_JWT_PAYLOAD: Payload 必须是合法 JSON 对象')
  }

  const header = {
    alg: 'HS256',
    typ: 'JWT',
    ...(headerOverrides || {}),
  }
  const headerB64 = encodeUtf8ToBase64Url(JSON.stringify(header))
  const payloadB64 = encodeUtf8ToBase64Url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const sigB64 = await computeHmacSha256Base64Url(signingInput, secret)
  return `${signingInput}.${sigB64}`
}

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val.replace(/\+/g, ' '))
  } catch {
    return val
  }
}

export function parseAndInspectUrl(rawInput: string): UrlInspectResult {
  const trimmed = String(rawInput || '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_URL_INPUT: URL 或 Query 字符串不能为空')
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
  const normalizedUrlStr = hasScheme
    ? trimmed
    : trimmed.startsWith('?') || trimmed.includes('=')
      ? `https://ztools.local/${trimmed.startsWith('?') ? trimmed : `?${trimmed}`}`
      : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(normalizedUrlStr)
  } catch (err) {
    throw new Error(
      `INVALID_URL_FORMAT: 无法解析 URL (${err instanceof Error ? err.message : String(err)})`,
    )
  }

  const queryParams: UrlQueryParamItem[] = []
  parsed.searchParams.forEach((value, key) => {
    const decodedValue = safeDecodeURIComponent(value)
    const isNestedUrl = /^https?:\/\//i.test(decodedValue)
    const isJsonLike =
      (decodedValue.startsWith('{') && decodedValue.endsWith('}')) ||
      (decodedValue.startsWith('[') && decodedValue.endsWith(']'))

    queryParams.push({
      key,
      rawValue: value,
      decodedValue,
      isNestedUrl,
      isJsonLike,
    })
  })

  return {
    rawInput: trimmed,
    protocol: hasScheme ? parsed.protocol.replace(/:$/, '') : 'query-only',
    host: hasScheme ? parsed.host : '-',
    hostname: hasScheme ? parsed.hostname : '-',
    port: hasScheme ? parsed.port || (parsed.protocol === 'https:' ? '443' : '80') : '-',
    pathname: hasScheme ? parsed.pathname : '-',
    hash: parsed.hash || '',
    encodedFullUrl: encodeURI(trimmed),
    decodedFullUrl: safeDecodeURIComponent(trimmed),
    queryParams,
  }
}
