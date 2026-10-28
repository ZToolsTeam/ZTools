import { callHostTransport } from '../shared/native-ipc.js'
import type {
  DecodedPreviewLine,
  FileDiagnosticResult,
  LineEndingType,
  TargetEncodingType
} from './types.js'

export function toHexHeaderPreview(bytes: Uint8Array, maxBytes = 16): string {
  const slice = bytes.subarray(0, Math.min(bytes.byteLength, maxBytes))
  return Array.from(slice)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ')
}

export function detectMagicSignature(
  bytes: Uint8Array,
  currentExtension: string
): {
  realMimeType: string
  realExtension: string
  isKnownBinary: boolean
} {
  if (!bytes || bytes.byteLength === 0) {
    return {
      realMimeType: 'text/plain',
      realExtension: currentExtension || 'txt',
      isKnownBinary: false
    }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { realMimeType: 'image/png', realExtension: 'png', isKnownBinary: true }
  }

  // JPEG: FF D8 FF
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { realMimeType: 'image/jpeg', realExtension: 'jpg', isKnownBinary: true }
  }

  // WEBP: RIFF....WEBP (52 49 46 46 ... 57 45 42 50)
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { realMimeType: 'image/webp', realExtension: 'webp', isKnownBinary: true }
  }

  // GIF: 47 49 46 38
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return { realMimeType: 'image/gif', realExtension: 'gif', isKnownBinary: true }
  }

  // PDF: 25 50 44 46 (%PDF)
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return { realMimeType: 'application/pdf', realExtension: 'pdf', isKnownBinary: true }
  }

  // ZIP / OOXML: 50 4B 03 04
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    const ooxmlExts = new Set(['docx', 'pptx', 'xlsx', 'jar', 'apk'])
    const ext = ooxmlExts.has(currentExtension) ? currentExtension : 'zip'
    return { realMimeType: 'application/zip', realExtension: ext, isKnownBinary: true }
  }

  return {
    realMimeType: '',
    realExtension: currentExtension,
    isKnownBinary: false
  }
}

export function detectTextEncodingAndBom(bytes: Uint8Array): {
  isText: boolean
  detectedEncoding: string
  confidence: number
  hasBom: boolean
} {
  if (!bytes || bytes.byteLength === 0) {
    return {
      isText: false,
      detectedEncoding: 'Empty',
      confidence: 100,
      hasBom: false
    }
  }

  // UTF-8 BOM: EF BB BF
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      isText: true,
      detectedEncoding: 'UTF-8-BOM',
      confidence: 100,
      hasBom: true
    }
  }

  // UTF-16 LE BOM: FF FE
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      isText: true,
      detectedEncoding: 'UTF-16LE',
      confidence: 100,
      hasBom: true
    }
  }

  // UTF-16 BE BOM: FE FF
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      isText: true,
      detectedEncoding: 'UTF-16BE',
      confidence: 100,
      hasBom: true
    }
  }

  // Check null bytes or high non-printable ratio -> binary
  const sampleLen = Math.min(bytes.byteLength, 4096)
  let nullCount = 0
  let controlCount = 0
  for (let i = 0; i < sampleLen; i++) {
    const b = bytes[i]!
    if (b === 0) nullCount++
    else if (b < 9 || (b > 13 && b < 32)) controlCount++
  }
  if (nullCount > 0 || controlCount > sampleLen * 0.12) {
    return {
      isText: false,
      detectedEncoding: 'Binary',
      confidence: 99,
      hasBom: false
    }
  }

  // Try strict UTF-8 decode first
  try {
    const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
    strictUtf8.decode(bytes.subarray(0, sampleLen))
    return {
      isText: true,
      detectedEncoding: 'UTF-8',
      confidence: 98,
      hasBom: false
    }
  } catch {
    // Non-UTF8 high bytes -> GBK / GB18030
    return {
      isText: true,
      detectedEncoding: 'GBK',
      confidence: 94,
      hasBom: false
    }
  }
}

export function detectLineEndingStyle(text: string): LineEndingType {
  if (!text) return 'None'
  const crlfCount = (text.match(/\r\n/g) ?? []).length
  const cleanLf = text.replace(/\r\n/g, '')
  const lfCount = (cleanLf.match(/\n/g) ?? []).length
  const crCount = (cleanLf.match(/\r/g) ?? []).length

  if (crlfCount > 0 && lfCount === 0 && crCount === 0) return 'CRLF'
  if (lfCount > 0 && crlfCount === 0 && crCount === 0) return 'LF'
  if (crCount > 0 && crlfCount === 0 && lfCount === 0) return 'CR'
  if (crlfCount === 0 && lfCount === 0 && crCount === 0) return 'None'
  return 'Mixed'
}

export function decodeTextBufferWithEncoding(bytes: Uint8Array, encoding: string): string {
  if (!bytes || bytes.byteLength === 0) return ''
  const norm = (encoding || 'utf-8').toLowerCase()
  try {
    if (norm === 'utf-8-bom' || norm === 'utf-8') {
      const start =
        bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start))
    }
    if (norm === 'gbk' || norm === 'gb2312' || norm === 'gb18030') {
      return new TextDecoder('gb18030', { fatal: false }).decode(bytes)
    }
    if (norm === 'big5') {
      return new TextDecoder('big5', { fatal: false }).decode(bytes)
    }
    if (norm === 'utf-16le') {
      return new TextDecoder('utf-16le', { fatal: false }).decode(bytes)
    }
    if (norm === 'utf-16be') {
      return new TextDecoder('utf-16be', { fatal: false }).decode(bytes)
    }
  } catch {
    // Fallback to utf-8 non-fatal
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function inspectFileFromBuffer(
  bytes: Uint8Array,
  filePath = 'unknown',
  overridePreviewEncoding?: string
): FileDiagnosticResult {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const extMatch = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const currentExtension = extMatch?.[1] || ''

  const magic = detectMagicSignature(bytes, currentExtension)
  const encInfo = magic.isKnownBinary
    ? {
        isText: false,
        detectedEncoding: 'Binary',
        confidence: 100,
        hasBom: false
      }
    : detectTextEncodingAndBom(bytes)

  let realMimeType = magic.realMimeType
  let realExtension = magic.realExtension

  if (!realMimeType) {
    if (encInfo.isText) {
      const previewHead = decodeTextBufferWithEncoding(
        bytes.subarray(0, Math.min(bytes.byteLength, 512)),
        encInfo.detectedEncoding
      )
        .trim()
        .toLowerCase()
      if (previewHead.startsWith('<!doctype html') || previewHead.startsWith('<html')) {
        realMimeType = 'text/html'
        realExtension = 'html'
      } else if (currentExtension === 'csv') {
        realMimeType = 'text/csv'
        realExtension = 'csv'
      } else {
        realMimeType = 'text/plain'
        realExtension = currentExtension || 'txt'
      }
    } else if (bytes.byteLength === 0) {
      realMimeType = 'application/x-empty'
      realExtension = currentExtension || 'txt'
    } else {
      realMimeType = 'application/octet-stream'
      realExtension = currentExtension || 'bin'
    }
  }

  const normalizedCur = currentExtension === 'jpeg' ? 'jpg' : currentExtension
  const normalizedReal = realExtension === 'jpeg' ? 'jpg' : realExtension
  const extensionMismatch =
    Boolean(normalizedCur) &&
    Boolean(normalizedReal) &&
    normalizedCur !== normalizedReal &&
    realMimeType !== 'application/octet-stream'

  let lineEnding: LineEndingType = 'None'
  const previewLines: DecodedPreviewLine[] = []

  if (encInfo.isText) {
    const activeEncoding = overridePreviewEncoding || encInfo.detectedEncoding
    const decodedText = decodeTextBufferWithEncoding(bytes, activeEncoding)
    lineEnding = detectLineEndingStyle(decodedText)
    const rawLines = decodedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').slice(0, 100)
    for (let i = 0; i < rawLines.length; i++) {
      previewLines.push({
        lineNumber: i + 1,
        text: rawLines[i]!
      })
    }
  } else if (bytes.byteLength > 0) {
    previewLines.push({
      lineNumber: 1,
      text: `[HEX] ${toHexHeaderPreview(bytes, 32)}`
    })
  }

  return {
    filePath,
    fileName,
    fileSize: bytes.byteLength,
    currentExtension,
    realMimeType,
    realExtension,
    extensionMismatch,
    isText: encInfo.isText,
    detectedEncoding: encInfo.detectedEncoding,
    confidence: encInfo.confidence,
    hasBom: encInfo.hasBom,
    lineEnding,
    hexHeaderPreview: toHexHeaderPreview(bytes, 16),
    previewLines
  }
}

export function convertTextBufferEncoding(
  bytes: Uint8Array,
  sourceEncoding: string,
  targetEncoding: TargetEncodingType,
  targetLineEnding?: 'CRLF' | 'LF'
): Uint8Array {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error('EMPTY_FILE_BUFFER: 空文件无法执行字符集转码')
  }
  let text = decodeTextBufferWithEncoding(bytes, sourceEncoding)
  if (targetLineEnding === 'CRLF') {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
  } else if (targetLineEnding === 'LF') {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  const utf8Body = new TextEncoder().encode(text)
  if (targetEncoding === 'utf-8-bom') {
    const out = new Uint8Array(3 + utf8Body.byteLength)
    out[0] = 0xef
    out[1] = 0xbb
    out[2] = 0xbf
    out.set(utf8Body, 3)
    return out
  }
  return utf8Body
}

export async function fixFileExtension(
  filePath: string,
  correctExt: string,
  hostOverride?: unknown
): Promise<{ ok: boolean; newPath?: string; error?: string }> {
  const res = await callHostTransport<{ newPath?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'FileInspectorPlugin',
      func: 'fixExtension',
      params: { filePath, correctExt }
    },
    hostOverride
  )
  if (!res.ok || !res.data?.newPath) {
    return { ok: false, error: res.error || res.data?.error || '修正文件后缀失败' }
  }
  return { ok: true, newPath: res.data.newPath }
}

export async function saveConvertedTextFile(
  filePath: string,
  encodedBytes: Uint8Array,
  hostOverride?: unknown
): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  const base64Data =
    typeof Buffer !== 'undefined'
      ? Buffer.from(encodedBytes).toString('base64')
      : btoa(String.fromCharCode(...encodedBytes))

  const res = await callHostTransport<{ outputPath?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'FileInspectorPlugin',
      func: 'writeEncoded',
      params: { filePath, base64Data }
    },
    hostOverride
  )
  if (!res.ok || !res.data?.outputPath) {
    return {
      ok: false,
      error: res.error || res.data?.error || '文件正被其他应用打开，请关闭后重试'
    }
  }
  return { ok: true, outputPath: res.data.outputPath }
}

export async function pickAndReadLocalFile(
  hostOverride?: unknown
): Promise<{ ok: boolean; filePath?: string; bytes?: Uint8Array; error?: string }> {
  const dialogRes = await callHostTransport<{ canceled?: boolean; filePaths?: string[] }>(
    'window_show_open_dialog',
    { properties: ['openFile'] },
    hostOverride
  )
  const chosenPath = dialogRes.data?.filePaths?.[0]
  if (!dialogRes.ok || dialogRes.data?.canceled || !chosenPath) {
    return { ok: false, error: '未选择文件' }
  }
  const readRes = await callHostTransport<{ base64Data?: string; filePath?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'FileInspectorPlugin',
      func: 'readFile',
      params: { filePath: chosenPath }
    },
    hostOverride
  )
  if (!readRes.ok || !readRes.data?.base64Data) {
    return { ok: false, error: readRes.error || readRes.data?.error || '读取文件字节失败' }
  }
  const b64 = readRes.data.base64Data
  const bytes =
    typeof Buffer !== 'undefined'
      ? new Uint8Array(Buffer.from(b64, 'base64'))
      : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return { ok: true, filePath: readRes.data.filePath || chosenPath, bytes }
}
