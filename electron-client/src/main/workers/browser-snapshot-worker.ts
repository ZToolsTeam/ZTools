import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import initSqlJs, { type Database, type Statement } from 'sql.js'
import { parseBrowserSnapshot, validateBrowserSnapshotBytes, validateBrowserSnapshotResult } from '../../contracts/browser-snapshot.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { toLocalizedPublicError } from '../ipc/error-localizer.js'
const moduleRequire = createRequire(__filename)
async function run() {
  if (!parentPort) throw new Error('WORKER_REQUIRED')
  let db: Database | undefined, statement: Statement | undefined
  try {
    const params = parseBrowserSnapshot(workerData.params), bytes = Buffer.from(workerData.bytes)
    validateBrowserSnapshotBytes(bytes)
    const SQL = await initSqlJs({ wasmBinary: Uint8Array.from(fs.readFileSync(moduleRequire.resolve('sql.js/dist/sql-wasm.wasm'))).buffer })
    db = new SQL.Database(bytes)
    db.run('PRAGMA hard_heap_limit=67108864; PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY')
    if (db.exec('PRAGMA hard_heap_limit')[0]?.values[0]?.[0] !== 67108864 || db.exec('PRAGMA query_only')[0]?.values[0]?.[0] !== 1) throw new ZToolsError(errorCodes.fileError, 'SQLite read-only pragmas were not confirmed')
    const match = '%' + params.keyword.replace(/[!%_]/g, value => '!' + value) + '%'
    switch (params.kind) {
      case 'chromium-history': statement = db.prepare("SELECT u.url,u.title,v.visit_time,u.visit_count FROM urls u JOIN visits v ON u.id=v.url WHERE u.url LIKE ? ESCAPE '!' OR u.title LIKE ? ESCAPE '!' ORDER BY v.visit_time DESC LIMIT ?"); statement.bind([match, match, params.limit + 1]); break
      case 'firefox-history': statement = db.prepare("SELECT p.url,p.title,h.visit_date,p.visit_count FROM moz_places p JOIN moz_historyvisits h ON p.id=h.place_id WHERE p.url LIKE ? ESCAPE '!' OR p.title LIKE ? ESCAPE '!' ORDER BY h.visit_date DESC LIMIT ?"); statement.bind([match, match, params.limit + 1]); break
      case 'firefox-bookmarks': statement = db.prepare('SELECT b.id,b.parent,b.type,b.position,b.title,p.url,b.dateAdded,b.lastModified FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk=p.id ORDER BY b.parent,b.position,b.id LIMIT ?'); statement.bind([params.limit + 1]); break
      default: throw new ZToolsError(errorCodes.invalidRequest, 'Invalid SQLite query type')
    }
    const columns = statement.getColumnNames(), rows: (string | number | null)[][] = []
    let truncated = false, size = 0
    while (statement.step()) {
      if (rows.length === params.limit) { truncated = true; break }
      const row = statement.get()
      for (const cell of row) {
        if (cell instanceof Uint8Array) throw new ZToolsError(errorCodes.fileError, 'Browser query column type mismatch')
        if (typeof cell === 'string') {
          const length = Buffer.byteLength(cell); if (length > 512 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'SQLite field exceeds size limit'); size += length
        } else size += 8
      }
      if (size > 8 * 1024 * 1024) throw new ZToolsError(errorCodes.responseTooLarge, 'SQLite result exceeds 8 MiB')
      rows.push(row as (string | number | null)[])
    }
    const sqliteVersion = db.exec('SELECT sqlite_version()')[0]?.values[0]?.[0]
    parentPort.postMessage(validateBrowserSnapshotResult({ success: true, columns, rows, truncated, sqliteVersion }, params.limit))
  } catch (error) {
    parentPort.postMessage({ success: false, error: toLocalizedPublicError(error instanceof ZToolsError ? error : new ZToolsError(errorCodes.fileError, 'SQLite snapshot is corrupted or missing required browser tables')) })
  } finally { statement?.free(); db?.close(); parentPort.close() }
}
void run()
