import { errorCodes, ZToolsError } from './errors.js'
import { grantId } from './path-reference.js'

/** Internal v2 transfer input. IPC/SDK registration waits for the complete consumer migration. */
export interface DownloadReferenceParams {
  url: string
  saveGrantId: string
  headers?: Record<string, string>
  replace?: boolean
  timeout?: number
}
export interface UploadReferenceParams {
  url: string
  fileGrantId: string
  headers?: Record<string, string>
  fieldName?: string
  timeout?: number
}

const invalid = () => new ZToolsError(errorCodes.invalidRequest, '文件引用传输参数无效')
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !keys.includes(key))) throw invalid()
  return value as Record<string, unknown>
}
function common(v: Record<string, unknown>): { url: string; timeout: number; headers?: Record<string, string> } {
  if (typeof v.url !== 'string' || Buffer.byteLength(v.url) > 8192 || /[\0\r\n]/.test(v.url)) throw invalid()
  let url: URL
  try { url = new URL(v.url) } catch { throw invalid() }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw invalid()
  const timeout = v.timeout ?? 120_000
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 120_000) throw invalid()
  let headers: Record<string, string> | undefined
  if (v.headers !== undefined) {
    if (!v.headers || typeof v.headers !== 'object' || Array.isArray(v.headers)) throw invalid()
    const source = record(v.headers, Object.keys(v.headers as object))
    if (Object.keys(source).length > 128) throw invalid()
    headers = {}; let bytes = 0
    for (const [key, value] of Object.entries(source)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value) || Buffer.byteLength(value) > 8192) throw invalid()
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
      if (bytes > 64 * 1024) throw invalid()
      Object.defineProperty(headers, key, { value, enumerable: true, writable: true, configurable: true })
    }
  }
  return { url: url.href, timeout: Number(timeout), ...(headers ? { headers } : {}) }
}
export function parseDownloadReference(value: unknown): DownloadReferenceParams {
  const v = record(value, ['url', 'saveGrantId', 'headers', 'timeout', 'replace'])
  if (v.replace !== undefined && typeof v.replace !== 'boolean') throw invalid()
  return { ...common(v), saveGrantId: grantId(v.saveGrantId), replace: v.replace as boolean | undefined ?? false }
}
export function parseUploadReference(value: unknown): UploadReferenceParams {
  const v = record(value, ['url', 'fileGrantId', 'headers', 'timeout', 'fieldName'])
  const fieldName = v.fieldName ?? 'file'
  if (typeof fieldName !== 'string' || !fieldName || Buffer.byteLength(fieldName) > 256 || /[\0\r\n]/.test(fieldName)) throw invalid()
  return { ...common(v), fileGrantId: grantId(v.fileGrantId), fieldName }
}
