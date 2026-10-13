/** Shared fixed read-only browser queries; requires an independently exported SQLite FileRef snapshot. */
class ReferenceSQLiteAPI extends ReferenceFileSystemAPI {
  async readBrowserSnapshot(file, options = {}) {
    this._options(options, ['kind', 'limit', 'keyword', 'signal'])
    if (!['chromium-history', 'firefox-history', 'firefox-bookmarks'].includes(options.kind) || !Number.isSafeInteger(options.limit ?? 200) || (options.limit ?? 200) < 1 || (options.limit ?? 200) > 1000 || typeof (options.keyword ?? '') !== 'string' || new TextEncoder().encode(options.keyword ?? '').length > 1024 || (options.keyword ?? '').includes(String.fromCharCode(0)) || (options.kind === 'firefox-bookmarks' && options.keyword)) throw this._error('INVALID_REQUEST', '浏览器快照选项无效')
    const result = await this._call('sqlite_read_browser_snapshot', { fileGrantId: this._reference(file, ['file'], 'read'), kind: options.kind, limit: options.limit ?? 200, keyword: options.keyword ?? '' }, { signal: options.signal })
    if (!Array.isArray(result.columns) || !result.columns.length || result.columns.length > 8 || result.columns.some(name => typeof name !== 'string' || name.length > 128) || !Array.isArray(result.rows) || result.rows.length > (options.limit ?? 200) || typeof result.truncated !== 'boolean' || typeof result.sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(result.sqliteVersion)) throw this._error('FILE_ERROR', 'SQLite响应无效')
    let bytes = 0
    const rows = result.rows.map(row => {
      if (!Array.isArray(row) || row.length !== result.columns.length) throw this._error('FILE_ERROR', 'SQLite行无效')
      for (const cell of row) {
        if (typeof cell === 'string') { const length = new TextEncoder().encode(cell).length; if (length > 512 * 1024) throw this._error('FILE_TOO_LARGE', 'SQLite字段超过上限'); bytes += length }
        else if (cell !== null && (typeof cell !== 'number' || !Number.isFinite(cell))) throw this._error('FILE_ERROR', 'SQLite字段无效')
        else bytes += 8
      }
      return Object.freeze([...row])
    })
    if (bytes > 8 * 1024 * 1024) throw this._error('RESPONSE_TOO_LARGE', 'SQLite结果超过8MiB')
    return Object.freeze({ columns: Object.freeze([...result.columns]), rows: Object.freeze(rows), truncated: result.truncated, sqliteVersion: result.sqliteVersion })
  }
}
export default ReferenceSQLiteAPI
