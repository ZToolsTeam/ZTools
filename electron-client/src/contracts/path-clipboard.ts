import { errorCodes, ZToolsError } from './errors.js'
import { grantId } from './path-reference.js'

export function parseReferenceClipboardText(value: unknown): { text: string } | { fileGrantId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ZToolsError(errorCodes.invalidRequest, '剪贴板文本参数无效')
  }
  const record = value as Record<string, unknown>, keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === 'text' && typeof record.text === 'string' && Buffer.byteLength(record.text) <= 8 * 1024 * 1024) return { text: record.text }
  if (keys.length === 1 && keys[0] === 'fileGrantId') return { fileGrantId: grantId(record.fileGrantId) }
  throw new ZToolsError(errorCodes.invalidRequest, '请提供text或已授权fileGrantId，不能使用旧临时路径')
}
