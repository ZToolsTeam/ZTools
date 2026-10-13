import initSqlJs from 'sql.js'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const moduleRequire = createRequire(__filename)
export async function browserSnapshotFixture(): Promise<Buffer> {
  const SQL = await initSqlJs({ wasmBinary: Uint8Array.from(fs.readFileSync(moduleRequire.resolve('sql.js/dist/sql-wasm.wasm'))).buffer })
  const db = new SQL.Database()
  try {
    db.run(`CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT,visit_count INTEGER);
      CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER);
      CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT,visit_count INTEGER);
      CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,place_id INTEGER,visit_date INTEGER);
      CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,parent INTEGER,type INTEGER,position INTEGER,title TEXT,fk INTEGER,dateAdded INTEGER,lastModified INTEGER);`)
    db.run('INSERT INTO urls VALUES(1,?,?,3),(2,?,?,1)', ['https://example.test/a', '百分%_!中文', 'https://example.test/b', 'normal'])
    db.run('INSERT INTO visits VALUES(1,1,13300000000000000),(2,2,13300000000000001),(3,1,13300000000000002)')
    db.run('INSERT INTO moz_places VALUES(1,?,?,3),(2,?,?,1)', ['https://example.test/a', '百分%_!中文', 'https://example.test/b', 'normal'])
    db.run('INSERT INTO moz_historyvisits VALUES(1,1,1700000000000000),(2,2,1700000000000001)')
    db.run("INSERT INTO moz_bookmarks VALUES(1,0,2,0,'菜单',NULL,1,2),(2,1,1,0,'书签',1,3,4),(3,1,3,1,NULL,NULL,5,6)")
    return Buffer.from(db.export())
  } finally { db.close() }
}
