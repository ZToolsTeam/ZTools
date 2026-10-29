import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { build as buildPlist } from 'plist'
import { BrowserBookmarksService } from '../../src/main/services/browser-bookmarks-service.js'
import { scanBrowserBookmarks, readBookmarkSource } from '../../src/main/services/bookmark-reader.js'
import { discoverBookmarks, errorMessage, type BookmarkEnvironment } from '../../src/main/services/bookmark-discovery.js'
import { parseBookmarkTree, type BookmarkSource } from '../../src/main/services/bookmark-parser.js'
import { validateBookmarkRequest, validateBookmarkScan } from '../../src/contracts/browser-bookmarks.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall } from '../../src/contracts/capabilities.js'
import { toPublicError } from '../../src/contracts/errors.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'

const caller: CallerIdentity = { type: 'plugin', webContentsId: 771, pluginId: 'browser-bookmarks' }
const signal = () => new AbortController().signal
function fixture(platform = 'darwin') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-bookmarks-'))
  const env: BookmarkEnvironment = { platform, home, localAppData: path.join(home, 'Local'), appData: path.join(home, 'Roaming') }
  return { env, close: () => fs.rmSync(home, { recursive: true, force: true }) }
}
function put(file: string, data: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file }
function chrome(env: BookmarkEnvironment, profile = 'Default') { return env.platform === 'darwin' ? path.join(env.home, 'Library', 'Application Support', 'Google', 'Chrome', profile, 'Bookmarks') : path.join(env.localAppData, 'Google', 'Chrome', 'User Data', profile, 'Bookmarks') }
function tree(count = 1) {
  return { roots: { bookmark_bar: { type: 'folder', name: '资料', children: Array.from({ length: count }, (_, i) => ({ type: 'url', id: '1', name: `测试文档 ${i}`, url: `https://example.com/${i}?x=a%20b#part`, date_added: '13374374400000000' })) } } }
}
const source = (file: string, format: BookmarkSource['format'] = 'chromium'): BookmarkSource => ({ browser: format === 'firefox' ? 'firefox' : 'chrome', browserLabel: 'Browser', profile: 'test', file, format })
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function firefox(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, parent INTEGER, type INTEGER, title TEXT, fk INTEGER, dateAdded INTEGER);
    INSERT INTO moz_bookmarks VALUES(1,0,2,'根目录',NULL,NULL),(2,1,2,'学习',NULL,NULL);
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO moz_places VALUES(1,'https://example.org/wal');
    INSERT INTO moz_bookmarks VALUES(3,2,1,'最新书签',1,1730000000000000);`)
  return db
}
test('校验与能力表拒绝任意路径、SQL及无效操作号', () => {
  assert.equal(canCall('browser_bookmarks_scan', caller), true)
  for (const method of ['browser_bookmarks_scan', 'browser_bookmarks_cancel'] as const) validateMethodParams(method, { operationId: 'valid_1' })
  for (const value of [null, [], {}, { operationId: '' }, { operationId: '../x' }, { operationId: 'x', file: '/etc/passwd' }, { operationId: 'x', sql: 'select 1' }]) assert.throws(() => validateBookmarkRequest(value))
  for (const value of [{}, { success: false }, { success: true, bookmarks: [], warnings: [], sourcesRead: -1 }]) assert.throws(() => validateBookmarkScan(value))
})
test('完整 worker 链路：多配置超过100/500条、重复原始编号、全拼首字母、来源文件不变', async () => {
  const f = fixture(), service = new BrowserBookmarksService(f.env)
  const files = [put(chrome(f.env), JSON.stringify(tree(520))), put(chrome(f.env, 'Profile 1'), JSON.stringify(tree(2)))]
  const before = files.map(digest)
  try {
    const result = await service.scan({ operationId: 'all' }, caller, signal())
    assert.equal(result.bookmarks.length, 522); assert.equal(result.sourcesRead, 2); assert.deepEqual(result.warnings, [])
    assert.equal(new Set(result.bookmarks.map(b => b.id)).size, 522)
    assert.match(result.bookmarks[0]!.pinyinFull, /ceshiwendang/); assert.match(result.bookmarks[0]!.pinyinInitials, /cswd/)
    assert.equal(result.bookmarks[0]!.url, 'https://example.com/0?x=a%20b#part')
    assert.deepEqual(files.map(digest), before)
  } finally { await service.stop(); f.close() }
})
test('Firefox 只读查询包含未checkpoint的WAL；保留主库与WAL且正确构造文件夹', async () => {
  const f = fixture(), file = path.join(f.env.home, 'Library', 'Application Support', 'Firefox', 'Profiles', 'sample.default', 'places.sqlite')
  const db = firefox(file), before = [digest(file), digest(`${file}-wal`)], service = new BrowserBookmarksService(f.env)
  try {
    const result = await service.scan({ operationId: 'wal' }, caller, signal())
    assert.equal(result.bookmarks.length, 1); assert.deepEqual(result.warnings, [])
    assert.equal(result.bookmarks[0]!.title, '最新书签'); assert.equal(result.bookmarks[0]!.folderBreadcrumb, '根目录 / 学习')
    assert.deepEqual([digest(file), digest(`${file}-wal`)], before)
    db.exec('UPDATE moz_bookmarks SET parent=2 WHERE id=2')
    assert.throws(() => readBookmarkSource(source(file, 'firefox')), /循环/)
  } finally { await service.stop(); db.close(); f.close() }
})
test('Firefox 拒绝递归 VIEW、虚表、非 rowid 主键和生成列，服务随后仍可读取', async () => {
  const f = fixture(), file = path.join(f.env.home, 'Library', 'Application Support', 'Firefox', 'Profiles', 'bad.default', 'places.sqlite')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const declarations = [
    "CREATE VIEW moz_bookmarks AS WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<100000000) SELECT sum(n) AS id,0 AS parent,2 AS type,'folder' AS title,NULL AS fk,NULL AS dateAdded FROM x",
    'CREATE VIRTUAL TABLE moz_bookmarks USING fts5(id,parent,type,title,fk,dateAdded)',
    'CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY DESC,parent INTEGER,type INTEGER,title TEXT,fk INTEGER,dateAdded INTEGER)',
    'CREATE TABLE moz_bookmarks(id INTEGER,parent INTEGER,type INTEGER,title TEXT,fk INTEGER,dateAdded INTEGER,PRIMARY KEY(id,parent))',
    'CREATE TABLE moz_bookmarks(id TEXT PRIMARY KEY,parent INTEGER,type INTEGER,title TEXT,fk INTEGER,dateAdded INTEGER)',
    'CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,parent INTEGER,type INTEGER,title TEXT,fk INTEGER,dateAdded INTEGER) WITHOUT ROWID',
    "CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,parent INTEGER,type INTEGER,title TEXT GENERATED ALWAYS AS ('computed'),fk INTEGER,dateAdded INTEGER)"
  ]
  const service = new BrowserBookmarksService(f.env, 2000)
  try {
    for (const [index, declaration] of declarations.entries()) {
      const db = new DatabaseSync(file)
      db.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT); ${declaration}`); db.close()
      const before = digest(file)
      await assert.rejects(service.scan({ operationId: `schema_${index}` }, caller, signal()), /表结构无效/)
      assert.equal(digest(file), before)
      fs.unlinkSync(file)
    }
    const db = firefox(file)
    try {
      assert.equal((await service.scan({ operationId: 'healthy' }, caller, signal())).bookmarks.length, 1)
      db.exec('DROP TABLE moz_places; CREATE TABLE moz_places(id INTEGER PRIMARY KEY DESC,url TEXT)')
      await assert.rejects(service.scan({ operationId: 'bad_places' }, caller, signal()), /moz_places 表结构无效/)
    } finally { db.close() }
  } finally { await service.stop(); f.close() }
})
test('Firefox 在进入 JS 前拒绝巨型或错误类型字段，累计原始结果也有上限', () => {
  const f = fixture(), file = path.join(f.env.home, 'places.sqlite'), db = firefox(file)
  try {
    for (const sql of ["UPDATE moz_bookmarks SET title=zeroblob(16777216) WHERE id=3", "UPDATE moz_bookmarks SET title=printf('%.*c',16385,'x') WHERE id=3", "UPDATE moz_places SET url=zeroblob(16777216)", "UPDATE moz_bookmarks SET parent=x'00' WHERE id=3", "UPDATE moz_bookmarks SET dateAdded=x'00' WHERE id=3"]) {
      db.exec(sql)
      assert.throws(() => readBookmarkSource(source(file, 'firefox')), /字段类型无效或长度超限/)
      db.exec("UPDATE moz_bookmarks SET title='最新书签',parent=2,dateAdded=1730000000000000 WHERE id=3; UPDATE moz_places SET url='https://example.org/wal'")
    }
    db.exec('BEGIN')
    const insert = db.prepare('INSERT INTO moz_bookmarks VALUES(?,2,1,?,1,NULL)')
    for (let i = 4; i < 1304; i++) insert.run(i, '甲'.repeat(2000))
    db.exec('COMMIT')
    assert.throws(() => readBookmarkSource(source(file, 'firefox')), /原始结果超过 7 MiB/)
  } finally { db.close(); f.close() }
})
test('Windows路径、Firefox profiles.ini自定义配置和同文件去重', () => {
  const f = fixture('win32'), dbPath = path.join(f.env.home, 'custom', 'places.sqlite')
  const db = firefox(dbPath)
  try {
    put(chrome(f.env, 'Profile 7'), JSON.stringify(tree()))
    put(path.join(f.env.appData, 'Mozilla', 'Firefox', 'profiles.ini'), `[Profile0]\nName=自定义\nIsRelative=0\nPath=${path.dirname(dbPath)}\n`)
    const result = scanBrowserBookmarks(f.env)
    assert.equal(result.bookmarks.length, 2); assert.equal(result.sourcesRead, 2)
    assert.equal(result.bookmarks.find(b => b.browser === 'firefox')!.profile, '自定义')
    fs.symlinkSync(path.dirname(chrome(f.env, 'Profile 7')), path.dirname(chrome(f.env, 'Profile linked')), process.platform === 'win32' ? 'junction' : 'dir')
    // Windows 普通用户未必有文件符号链接权限；目录去重仍用无需提权的 junction 验证。
    if (process.platform !== 'win32') fs.symlinkSync(chrome(f.env, 'Profile 7'), path.join(path.dirname(path.dirname(chrome(f.env, 'Profile 7'))), 'SingletonSocket'))
    assert.equal(discoverBookmarks(f.env).sources.length, 2)
    assert.deepEqual(discoverBookmarks(f.env).warnings, [])
  } finally { db.close(); f.close() }
})
test('损坏、无权限与超大来源显式告警；不存在/合法空库才返回空结果', () => {
  const f = fixture()
  try {
    assert.deepEqual(scanBrowserBookmarks(f.env), { success: true, bookmarks: [], warnings: [], sourcesRead: 0 })
    const file = put(chrome(f.env), '{broken'), valid = put(chrome(f.env, 'Profile 1'), JSON.stringify(tree(0)))
    let result = scanBrowserBookmarks(f.env)
    assert.equal(result.sourcesRead, 1); assert.equal(result.warnings.length, 1); assert.equal(result.bookmarks.length, 0)
    fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1)); result = scanBrowserBookmarks(f.env)
    assert.match(result.warnings[0]!, /16 MiB/)
    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(valid, 0)
      try { assert.throws(() => scanBrowserBookmarks(f.env), /未能读取任何.*权限/) }
      finally { fs.chmodSync(valid, 0o600) }
    }
    assert.throws(() => scanBrowserBookmarks({ ...f.env, platform: 'unsupported' }), /不支持/)
  } finally { f.close() }
})
test('解析拒绝过深或损坏树；过滤非网页链接，未知日期不冒充今天', () => {
  const s = source('/fixture/Bookmarks'), data = tree(1)
  data.roots.bookmark_bar.children[0]!.date_added = 'bad'
  const item = parseBookmarkTree(data, s)[0]!
  assert.equal(item.dateAdded, null)
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,x', 'about:blank', 'invalid']) {
    data.roots.bookmark_bar.children[0]!.url = url; assert.deepEqual(parseBookmarkTree(data, s), [])
  }
  assert.throws(() => parseBookmarkTree({}, s)); assert.throws(() => parseBookmarkTree({ roots: { a: { type: 'folder' } } }, s))
  let node: unknown = { type: 'folder', children: [] }
  for (let i = 0; i < 70; i++) node = { type: 'folder', children: [node] }
  assert.throws(() => parseBookmarkTree({ roots: { a: node } }, s), /64/)
})
test('Safari 二进制 plist 实际只读转换', { skip: process.platform !== 'darwin' }, () => {
  const f = fixture(), file = path.join(f.env.home, 'Library', 'Safari', 'Bookmarks.plist')
  try {
    put(file, buildPlist({ WebBookmarkType: 'WebBookmarkTypeList', DateAdded: new Date('2024-01-01T00:00:00Z'), ReadingList: { Data: Buffer.from([1, 2, 3]) }, Children: [{ WebBookmarkType: 'WebBookmarkTypeList', Title: '空目录' }, { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://example.net/safari', URIDictionary: { title: 'Safari 书签' } }] }))
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file])
    const before = digest(file), result = scanBrowserBookmarks(f.env)
    assert.deepEqual(result.warnings, []); assert.equal(result.bookmarks[0]!.browser, 'safari'); assert.equal(digest(file), before)
  } finally { f.close() }
})
test('取消隔离、重复调用、超时和服务退出后释放worker，拒绝迟到成功', async () => {
  const f = fixture(), service = new BrowserBookmarksService(f.env), controller = new AbortController()
  try {
    const task = service.scan({ operationId: 'cancel' }, caller, controller.signal)
    assert.equal(service.cancel({ operationId: 'cancel' }, { ...caller, webContentsId: 999 }).cancelRequested, false)
    await assert.rejects(service.scan({ operationId: 'again' }, caller, signal()), /正在读取/)
    assert.equal(service.cancel({ operationId: 'cancel' }, caller).cancelRequested, true)
    await assert.rejects(task, /取消/)
    assert.equal((await service.scan({ operationId: 'retry' }, caller, signal())).sourcesRead, 0)
    const stopped = service.scan({ operationId: 'stop' }, caller, signal()), rejected = assert.rejects(stopped, /取消/)
    await service.stop(); await rejected
    await assert.rejects(service.scan({ operationId: 'late' }, caller, signal()), /停止/)
    const timeout = new BrowserBookmarksService(f.env, 1)
    await assert.rejects(timeout.scan({ operationId: 'timeout' }, caller, signal()), /超时/); await timeout.stop()
    controller.abort(); await assert.rejects(service.scan({ operationId: 'abort' }, caller, controller.signal))
  } finally { await service.stop(); f.close() }
})
test('读取大量真实条目过程中取消，等待 worker 退出后可重新读取', async () => {
  const f = fixture(), data = tree(1000), service = new BrowserBookmarksService(f.env)
  for (const item of data.roots.bookmark_bar.children) item.name = '测试书签'.repeat(200)
  const file = put(chrome(f.env), JSON.stringify(data))
  const started = Date.now(), task = service.scan({ operationId: 'running' }, caller, signal())
  const rejected = assert.rejects(task, /取消/)
  const timer = setTimeout(() => service.cancel({ operationId: 'running' }, caller), 150)
  try {
    await rejected
    assert.ok(Date.now() - started < 3000)
    fs.writeFileSync(file, JSON.stringify(tree(1)))
    assert.equal((await service.scan({ operationId: 'after_running' }, caller, signal())).bookmarks.length, 1)
  } finally { clearTimeout(timer); await service.stop(); f.close() }
})

test('Safari 书签无权读取时提示完全磁盘访问，其他浏览器保持通用权限提示', () => {
  const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  assert.match(errorMessage(denied, 'safari'), /完全磁盘访问/)
  assert.doesNotMatch(errorMessage(denied, 'chrome'), /完全磁盘访问/)
  assert.match(errorMessage(denied), /文件访问权限/)
  assert.equal(errorMessage(Object.assign(new Error('x'), { code: 'EBUSY' }), 'safari'), '浏览器正在使用书签，请稍后刷新')
})

test('一个来源都读不到时，插件收到真实原因（无权限），而不是“宿主内部错误”', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const f = fixture(), service = new BrowserBookmarksService(f.env)
  const file = put(chrome(f.env), JSON.stringify(tree(1)))
  fs.chmodSync(file, 0o000)
  try {
    const error = await service.scan({ operationId: 'denied' }, caller, signal()).then(() => null, e => e)
    assert.ok(error)
    const exposed = toPublicError(error)
    assert.notEqual(exposed.message, '宿主内部错误')
    assert.match(exposed.message, /未能读取任何浏览器书签/)
  } finally { fs.chmodSync(file, 0o600); await service.stop(); f.close() }
})
