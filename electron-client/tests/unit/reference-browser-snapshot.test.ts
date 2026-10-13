import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { ReferenceBrowserSnapshotService } from '../../src/main/services/reference-browser-snapshot-service.js'
import { browserSnapshotFixture } from '../helpers/browser-snapshot-fixture.js'
const caller = { webContentsId: 77 } as CallerIdentity, id = 's'.repeat(43)
const signal = () => new AbortController().signal
const params = { fileGrantId: id, kind: 'chromium-history' }
async function fixture() {
  const bytes = await browserSnapshotFixture(), workers: Worker[] = [], calls: unknown[][] = []
  const service = new ReferenceBrowserSnapshotService({ read: async (...args) => { calls.push(args); return bytes } }, { createWorker: (file, options) => { const worker = new Worker(file, options); workers.push(worker); return worker } })
  return { service, bytes, workers, calls }
}
test('SQLite worker executes real Chromium history in order, verifies exit and immutable input bytes', async () => {
  const f = await fixture(), original = Buffer.from(f.bytes)
  const result = await f.service.read(params, caller, signal())
  assert.deepEqual(result.columns, ['url', 'title', 'visit_time', 'visit_count']); assert.equal(result.rows.length, 3)
  assert.equal(result.rows[0]?.[1], '百分%_!中文'); assert.equal(result.truncated, false); assert.match(result.sqliteVersion, /^\d+\.\d+\.\d+$/)
  assert.equal(f.workers[0]?.threadId, -1); assert.deepEqual(f.bytes, original)
  assert.deepEqual(f.calls[0]?.slice(0, 4), [77, id, '', 16 * 1024 * 1024]); await f.service.stop()
})
test('SQLite worker truncates explicitly and treats SQL LIKE wildcard characters literally', async () => {
  const f = await fixture()
  const small = await f.service.read({ ...params, limit: 1 }, caller, signal()); assert.equal(small.rows.length, 1); assert.equal(small.truncated, true)
  const literal = await f.service.read({ ...params, keyword: '%_!' }, caller, signal()); assert.equal(literal.rows.length, 2); assert.ok(literal.rows.every(row => row[1] === '百分%_!中文'))
  const injection = await f.service.read({ ...params, keyword: "' OR 1=1 --" }, caller, signal()); assert.equal(injection.rows.length, 0)
})
test('SQLite worker reads actual Firefox history and bookmark rows including folders and separators', async () => {
  const f = await fixture(), history = await f.service.read({ ...params, kind: 'firefox-history' }, caller, signal())
  assert.equal(history.rows[0]?.[2], 1700000000000001)
  const bookmarks = await f.service.read({ ...params, kind: 'firefox-bookmarks' }, caller, signal())
  assert.equal(bookmarks.columns.length, 8); assert.deepEqual(bookmarks.rows.map(row => [row[0], row[2], row[5]]), [[1, 2, null], [2, 1, 'https://example.test/a'], [3, 3, null]])
})
test('SQLite rejects malformed, truncated and WAL-dependent snapshots before spawning', async () => {
  const bytes = await browserSnapshotFixture(), wal = Buffer.from(bytes); wal[18] = 2; wal[19] = 2
  const invalidPage = Buffer.from(bytes); invalidPage.writeUInt16BE(513, 16)
  for (const input of [Buffer.from('bad'), bytes.subarray(0, bytes.length - 1), wal, invalidPage]) {
    let spawned = false
    const service = new ReferenceBrowserSnapshotService({ read: async () => input }, { createWorker: () => { spawned = true; throw new Error('unreachable') } })
    await assert.rejects(service.read(params, caller, signal()), { code: 'FILE_ERROR' }); assert.equal(spawned, false)
  }
})
test('SQLite worker reports actual corrupt database without table and releases thread', async () => {
  const f = await fixture(); f.bytes.fill(0, 100)
  await assert.rejects(f.service.read(params, caller, signal()), { code: 'FILE_ERROR' }); assert.equal(f.workers[0]?.threadId, -1)
})
test('SQLite true cancellation and bounded timeout wait for actual worker exit', async () => {
  const bytes = await browserSnapshotFixture()
  for (const mode of ['abort', 'timeout'] as const) {
    let worker!: Worker
    const controller = new AbortController()
    const service = new ReferenceBrowserSnapshotService({ read: async () => bytes }, { timeoutMs: mode === 'timeout' ? 1 : 5000, createWorker: (file, options) => {
      worker = new Worker(file, options); if (mode === 'abort') setImmediate(() => controller.abort()); return worker
    } })
    await assert.rejects(service.read(params, caller, controller.signal), { code: mode === 'abort' ? 'CALLER_DESTROYED' : 'REQUEST_TIMEOUT' })
    assert.equal(worker.threadId, -1); await service.stop()
  }
})
test('SQLite stop aborts active worker and waits for exit, stopped calls do no read', async () => {
  const bytes = await browserSnapshotFixture(); let worker!: Worker, ready!: () => void, reads = 0
  const created = new Promise<void>(resolve => { ready = resolve })
  const service = new ReferenceBrowserSnapshotService({ read: async () => { reads++; return bytes } }, { createWorker: (file, options) => { worker = new Worker(file, options); ready(); return worker } })
  const pending = service.read(params, caller, signal()), rejection = assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  await created; await service.stop(); await rejection; assert.equal(worker.threadId, -1)
  await assert.rejects(service.read(params, caller, signal()), { code: 'CALLER_DESTROYED' }); assert.equal(reads, 1)
})
test('SQLite validates parameters and preabort before native reads', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort()
  for (const p of [{ ...params, path: '/private/db' }, { ...params, fileGrantId: '/raw.db' }, { ...params, limit: 0 }, { ...params, kind: 'write' }, { ...params, keyword: 'a'.repeat(1025) }, { ...params, kind: 'firefox-bookmarks', keyword: 'x' }]) await assert.rejects(f.service.read(p, caller, signal()), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.service.read(params, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.calls.length, 0)
})
test('SQLite owner reservation blocks duplicate and third owner before native read', async () => {
  const bytes = await browserSnapshotFixture(), finishes: ((value: Buffer) => void)[] = []
  const service = new ReferenceBrowserSnapshotService({ read: () => new Promise(resolve => finishes.push(resolve)) })
  const one = service.read(params, caller, signal()), two = service.read(params, { webContentsId: 78 } as CallerIdentity, signal())
  await assert.rejects(service.read(params, caller, signal()), { code: 'FILE_TOO_LARGE' })
  await assert.rejects(service.read(params, { webContentsId: 79 } as CallerIdentity, signal()), { code: 'FILE_TOO_LARGE' }); assert.equal(finishes.length, 2)
  const settled = Promise.allSettled([one, two]); const stopped = service.stop(); finishes.forEach(finish => finish(bytes)); await stopped
  assert.ok((await settled).every(result => result.status === 'rejected'))
})
