import { errorCodes, ZToolsError } from './errors.js'

export const MAX_MARKDOWN_BYTES = 256 * 1024
export interface MarkdownOptions { preset: 'official' | 'business' | 'academic'; fontSize: 'size-3' | 'size-s4' | 'size-5'; firstLineIndent: boolean }
export type MarkdownDocumentParams =
  | { action: 'cancel'; operationId: string }
  | { action: 'read'; operationId: string; path: string }
  | { action: 'inspect' | 'copy' | 'export'; operationId: string; markdown: string; options: MarkdownOptions; outputPath?: string }
export function validateMarkdownText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_MARKDOWN_BYTES || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new ZToolsError(errorCodes.invalidRequest, '请输入有效的 Markdown 文本（最多 256 KiB，不含无效字符）')
  }
}
export function validateMarkdownParams(value: unknown): asserts value is MarkdownDocumentParams {
  const fail = (): never => { throw new ZToolsError(errorCodes.invalidRequest, 'Markdown 文档参数无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail()
  const p = value as Record<string, unknown>, action = p.action
  if (typeof action !== 'string') fail()
  if (typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.operationId)) fail()
  const allowed = action === 'cancel' ? ['action', 'operationId'] : action === 'read' ? ['action', 'operationId', 'path'] : ['action', 'operationId', 'markdown', 'options', ...(action === 'export' ? ['outputPath'] : [])]
  if (Object.keys(p).some(k => !allowed.includes(k))) fail()
  const validPath = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0')
  if (action === 'cancel') return
  if (action === 'read') { if (!validPath(p.path)) fail(); return }
  if (!['inspect', 'copy', 'export'].includes(String(action))) fail()
  validateMarkdownText(p.markdown)
  const o = p.options as Record<string, unknown> | undefined
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype || Object.keys(o).some(k => !['preset', 'fontSize', 'firstLineIndent'].includes(k)) || typeof o.preset !== 'string' || !['official', 'business', 'academic'].includes(o.preset) || typeof o.fontSize !== 'string' || !['size-3', 'size-s4', 'size-5'].includes(o.fontSize) || typeof o.firstLineIndent !== 'boolean') fail()
  if (action === 'export' && (!validPath(p.outputPath) || !String(p.outputPath).toLowerCase().endsWith('.docx'))) fail()
}
