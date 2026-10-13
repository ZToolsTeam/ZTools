import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
const id = 's'.repeat(43), ref = { grantId: id, kind: 'file', displayName: 'history.sqlite', operations: ['read'] }
function fixture(version = 2) {
  const methods = { sqlite_read_browser_snapshot() {} }
  const source = ['fs-reference', 'sqlite-reference'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ReferenceSQLiteAPI', { window: { __ztoolsElectron: { contractVersion: version, transport: { methods, cancellations: methods } } }, TextEncoder }) as new (transport: unknown) => { readBrowserSnapshot(ref: unknown, options: unknown): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> }
  const calls: { method: string; params: unknown; options: unknown }[] = []
  let response: unknown = { success: true, columns: ['url', 'title'], rows: [['https://example.test', null]], truncated: false, sqliteVersion: '3.49.1' }
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: unknown) => { calls.push({ method, params, options }); return response } })
  return { api, calls, response: (value: unknown) => { response = value } }
}
test('SQLite SDK sends opaque FileRef with fixed query and forwards true cancellation; freezes rows', async () => {
  const f = fixture(), signal = new AbortController().signal
  const result = await f.api.readBrowserSnapshot(ref, { kind: 'chromium-history', limit: 20, keyword: '%_', signal })
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.rows)); assert.ok(Object.isFrozen(result.rows[0])); assert.ok(Object.isFrozen(result.columns))
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0]?.params)), { fileGrantId: id, kind: 'chromium-history', limit: 20, keyword: '%_' }); assert.equal((f.calls[0]?.options as { signal: AbortSignal }).signal, signal)
})
test('SQLite SDK rejects raw paths, arbitrary SQL and invalid options before transport', async () => {
  const f = fixture()
  await assert.rejects(f.api.readBrowserSnapshot('/private/history', { kind: 'chromium-history' }), { code: 'INVALID_REQUEST' })
  for (const options of [{ kind: 'arbitrary', sql: 'DELETE' }, { kind: 'firefox-history', limit: 1001 }, { kind: 'firefox-bookmarks', keyword: 'x' }, { kind: 'firefox-history', keyword: 'x'.repeat(1025) }]) await assert.rejects(f.api.readBrowserSnapshot(ref, options), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
})
test('SQLite SDK denies preabort and contract1 explicitly without legacy DLL fallback', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.api.readBrowserSnapshot(ref, { kind: 'firefox-history', signal: controller.signal }), { code: 'CALLER_DESTROYED' }); assert.equal(f.calls.length, 0)
  const old = fixture(1); await assert.rejects(old.api.readBrowserSnapshot(ref, { kind: 'firefox-history' }), { code: 'NOT_SUPPORTED' }); assert.equal(old.calls.length, 0)
})
test('SQLite SDK rejects invalid column widths, blobs, nonfinite numbers and oversized fields', async () => {
  for (const change of [{ rows: [[1]] }, { rows: [[{}, null]] }, { rows: [[Infinity, null]] }, { rows: [['x'.repeat(512 * 1024 + 1), null]] }, { sqliteVersion: 'unknown' }, { columns: [] }]) {
    const f = fixture(); f.response({ success: true, columns: ['url', 'title'], rows: [['valid', null]], truncated: false, sqliteVersion: '3.49.1', ...change })
    await assert.rejects(f.api.readBrowserSnapshot(ref, { kind: 'firefox-history' }))
  }
})
