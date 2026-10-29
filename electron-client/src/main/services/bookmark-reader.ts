import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { parse as parsePlist } from 'plist'
import { validateBookmarkScan, type BookmarkScan } from '../../contracts/browser-bookmarks.js'
import { discoverBookmarks, errorMessage, readBookmarkFile, type BookmarkEnvironment } from './bookmark-discovery.js'
import { parseBookmarkTree, parseFirefoxRows, type BookmarkSource } from './bookmark-parser.js'

function validateFirefoxTables(db: DatabaseSync) {
  for (const [table, required] of Object.entries({ moz_bookmarks: ['id', 'parent', 'type', 'title', 'fk', 'dateAdded'], moz_places: ['id', 'url'] })) {
    const tables = db.prepare('SELECT * FROM pragma_table_list WHERE schema=? AND name=?').all('main', table)
    if (tables.length !== 1 || tables[0]!.type !== 'table' || tables[0]!.wr !== 0) throw new Error(`Firefox ${table} 表结构无效，未读取此配置`)
    const columns = db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table)
    const keys = columns.filter(column => column.pk !== 0)
    const indexes = db.prepare('SELECT origin FROM pragma_index_list(?)').all(table)
    // 独立的主键索引包括 INTEGER PRIMARY KEY DESC 和复合主键；仅允许直接按 rowid 查找。
    if (keys.length !== 1 || keys[0]!.name !== 'id' || String(keys[0]!.type).toUpperCase() !== 'INTEGER' ||
        indexes.some(index => index.origin === 'pk') ||
        required.some(name => !columns.some(column => column.name === name && column.hidden === 0))) {
      throw new Error(`Firefox ${table} 表结构无效，未读取此配置`)
    }
  }
}

function readFirefoxRows(db: DatabaseSync) {
  validateFirefoxTables(db)
  // LIMIT 和 rowid 主键约束限定查询工作量；先在 SQLite 内检查类型和字节数，避免把巨型字段带入 JS。
  const query = db.prepare(`SELECT b.id,
    CASE WHEN typeof(b.parent)='integer' THEN b.parent END AS parent,
    CASE WHEN typeof(b.type)='integer' THEN b.type END AS type,
    CASE WHEN typeof(b.dateAdded)='integer' THEN b.dateAdded END AS dateAdded,
    CASE WHEN typeof(b.title)='text' AND length(CAST(b.title AS BLOB))<=16384 THEN b.title END AS title,
    CASE WHEN typeof(p.url)='text' AND length(CAST(p.url AS BLOB))<=65536 THEN p.url END AS url,
    (typeof(b.parent)!='integer' OR typeof(b.type)!='integer' OR typeof(b.dateAdded) NOT IN ('integer','null')
      OR typeof(b.fk) NOT IN ('integer','null') OR typeof(b.title) NOT IN ('text','null')
      OR length(CAST(b.title AS BLOB))>16384
      OR (b.type=1 AND (typeof(p.url)!='text' OR length(CAST(p.url AS BLOB))>65536))) AS invalid
    FROM moz_bookmarks b NOT INDEXED LEFT JOIN moz_places p ON p.id=CASE WHEN typeof(b.fk)='integer' THEN b.fk END
    ORDER BY b.id LIMIT 20001`)
  const rows: Record<string, unknown>[] = []
  let bytes = 0
  for (const row of query.iterate()) {
    if (row.invalid) throw new Error('Firefox 书签字段类型无效或长度超限')
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (bytes > 7 * 1024 * 1024) throw new Error('Firefox 书签原始结果超过 7 MiB')
    rows.push(row)
  }
  return rows
}

export function readBookmarkSource(source: BookmarkSource) {
  if (source.format !== 'firefox') {
    const bytes = readBookmarkFile(source.file)
    const data = source.format === 'safari'
      ? parsePlist(execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: bytes, timeout: 5000, maxBuffer: 32 * 1024 * 1024 }).toString('utf8'))
      : JSON.parse(bytes.toString('utf8'))
    return parseBookmarkTree(data, source)
  }
  if (fs.statSync(source.file).size > 1024 * 1024 * 1024) throw new Error('Firefox 数据库超过 1 GiB')
  // SQLite 自身读取一致的主库和 WAL；不复制活动数据库、不写回书签，也不执行 checkpoint。
  const db = new DatabaseSync(source.file, { readOnly: true, timeout: 1500, enableDoubleQuotedStringLiterals: false, allowExtension: false })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; BEGIN')
    return parseFirefoxRows(readFirefoxRows(db), source)
  } finally { db.close() }
}
export function scanBrowserBookmarks(env: BookmarkEnvironment): BookmarkScan {
  const { sources, warnings } = discoverBookmarks(env)
  const result: BookmarkScan = { success: true, bookmarks: [], warnings, sourcesRead: 0 }
  let size = 0
  for (const source of sources) {
    try {
      const items = readBookmarkSource(source), bytes = Buffer.byteLength(JSON.stringify(items))
      if (result.bookmarks.length + items.length > 20000 || size + bytes > 7 * 1024 * 1024) throw new Error('总结果超过 20000 条或 7 MiB，本配置未载入')
      result.bookmarks.push(...items); size += bytes; result.sourcesRead++
    } catch (error) { warnings.push(`${source.browserLabel} / ${source.profile}：${errorMessage(error, source.browser)}`) }
  }
  return validateBookmarkScan(result)
}
