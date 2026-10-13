import { errorCodes, ZToolsError } from './errors.js'
import { grantId } from './path-reference.js'
export const BROWSER_SNAPSHOT_KINDS = ['chromium-history', 'firefox-history', 'firefox-bookmarks'] as const
export type BrowserSnapshotKind = typeof BROWSER_SNAPSHOT_KINDS[number]
export interface BrowserSnapshotParams { fileGrantId: string; kind: BrowserSnapshotKind; limit: number; keyword: string }
export interface BrowserSnapshotResult { success: true; columns: string[]; rows: (string | number | null)[][]; truncated: boolean; sqliteVersion: string }
const invalid = () => new ZToolsError(errorCodes.invalidRequest, '浏览器SQLite快照参数无效')
export function parseBrowserSnapshot(value: unknown): BrowserSnapshotParams {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !['fileGrantId', 'kind', 'limit', 'keyword'].includes(key))) throw invalid()
  const v = value as Record<string, unknown>, limit = v.limit ?? 200, keyword = v.keyword ?? ''
  if (!BROWSER_SNAPSHOT_KINDS.includes(v.kind as BrowserSnapshotKind) || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1000 || typeof keyword !== 'string' || Buffer.byteLength(keyword) > 1024 || keyword.includes(String.fromCharCode(0)) || (v.kind === 'firefox-bookmarks' && keyword !== '')) throw invalid()
  return { fileGrantId: grantId(v.fileGrantId), kind: v.kind as BrowserSnapshotKind, limit: Number(limit), keyword }
}
export function validateBrowserSnapshotBytes(bytes: Buffer): void {
  if (bytes.length > 16 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'SQLite快照超过16MiB')
  if (bytes.length < 512 || !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3' + String.fromCharCode(0)))) throw new ZToolsError(errorCodes.fileError, '不是完整SQLite快照')
  const encodedPageSize = bytes.readUInt16BE(16), pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || bytes.length % pageSize !== 0 || bytes.readUInt32BE(28) > bytes.length / pageSize) throw new ZToolsError(errorCodes.fileError, 'SQLite快照页头或大小无效')
  if (bytes[18] !== 1 || bytes[19] !== 1) throw new ZToolsError(errorCodes.fileError, '快照仍依赖WAL或未知格式；请提供检查点完成并导出的独立SQLite快照')
}
export function validateBrowserSnapshotResult(value: unknown, limit: number): BrowserSnapshotResult {
  const bad = () => new ZToolsError(errorCodes.fileError, 'SQLite worker返回无效')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad()
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['success', 'columns', 'rows', 'truncated', 'sqliteVersion'].includes(key)) || v.success !== true || typeof v.truncated !== 'boolean' || typeof v.sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(v.sqliteVersion) || !Array.isArray(v.columns) || !v.columns.length || v.columns.length > 8 || v.columns.some(c => typeof c !== 'string' || c.length > 128) || !Array.isArray(v.rows) || v.rows.length > limit) throw bad()
  let size = 0
  for (const row of v.rows) {
    if (!Array.isArray(row) || row.length !== v.columns.length) throw bad()
    for (const cell of row) {
      if (typeof cell === 'string') { const length = Buffer.byteLength(cell); if (length > 512 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'SQLite字段超过上限'); size += length }
      else if (cell !== null && (typeof cell !== 'number' || !Number.isFinite(cell))) throw bad()
      else size += 8
    }
  }
  if (size > 8 * 1024 * 1024) throw new ZToolsError(errorCodes.responseTooLarge, 'SQLite结果超过8MiB')
  return v as unknown as BrowserSnapshotResult
}
