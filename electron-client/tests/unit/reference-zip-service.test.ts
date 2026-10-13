import assert from 'node:assert/strict'
import { buildZipFixture as archive } from '../helpers/zip-fixture.js'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ReferenceZipService } from '../../src/main/services/reference-zip-service.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const caller = { webContentsId: 77 } as CallerIdentity
const id = 'z'.repeat(43)

function fixture(bytes = archive()) {
  const calls: unknown[][] = [], service = new ReferenceZipService({ read: async (...args) => { calls.push(args); return bytes } })
  return { service, calls, signal: new AbortController().signal }
}
test('ZIP provider lists real UTF8 entries and verifies data CRC through a FileRef read', async () => {
  const f = fixture(archive([{ name: 'folder/', data: Buffer.alloc(0) }, { name: 'folder/文档.txt', data: Buffer.from('hello') }]))
  const result = await f.service.list({ fileGrantId: id }, caller, f.signal)
  assert.ok('files' in result); assert.deepEqual(result.files?.map(file => [file.name, file.size, file.isDirectory]), [['folder/', 0, true], ['folder/文档.txt', 5, false]])
  assert.deepEqual(await f.service.test({ fileGrantId: id }, caller, f.signal), { success: true, valid: true })
  assert.equal(f.calls[0]?.[0], 77); assert.equal(f.calls[0]?.[1], id); assert.equal(f.calls[0]?.[3], 16 * 1024 * 1024)
})
test('ZIP test returns false for malformed archives and CRC mismatches, listing malformed archives fails', async () => {
  for (const bytes of [Buffer.from('broken'), archive(undefined, true)]) assert.deepEqual(await fixture(bytes).service.test({ fileGrantId: id }, caller, new AbortController().signal), { success: true, valid: false })
  await assert.rejects(fixture(Buffer.from('broken')).service.list({ fileGrantId: id }, caller, new AbortController().signal), { code: 'FILE_ERROR' })
})
test('ZIP names are exact relative entries and duplicate metadata fails', async () => {
  const f = fixture(archive([{ name: 'same', data: Buffer.alloc(0) }, { name: 'same', data: Buffer.alloc(0) }]))
  await assert.rejects(f.service.list({ fileGrantId: id }, caller, f.signal), { code: 'FILE_ERROR' })
  await assert.rejects(fixture(archive([{ name: '../outside', data: Buffer.alloc(0) }])).service.list({ fileGrantId: id }, caller, f.signal), { code: 'FILE_ERROR' })
})
test('ZIP read permission errors remain errors, never valid false', async () => {
  const error = Object.assign(new Error('permission'), { code: 'FILE_ACCESS_DENIED' }), service = new ReferenceZipService({ read: async () => { throw error } })
  await assert.rejects(service.test({ fileGrantId: id }, caller, new AbortController().signal), error)
})
test('ZIP stopped or preaborted calls do no read and a stopped pending read cannot publish', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.service.list({ fileGrantId: id }, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.calls.length, 0)
  let finish!: (value: Buffer) => void
  const service = new ReferenceZipService({ read: () => new Promise(resolve => { finish = resolve }) })
  const pending = service.list({ fileGrantId: id }, caller, new AbortController().signal); service.stop(); finish(archive())
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
})
test('ZIP rejects unknown parameters and raw paths before read', async () => {
  const f = fixture()
  for (const params of [{ fileGrantId: 'C:/raw.zip' }, { fileGrantId: id, archive: 'raw' }]) await assert.rejects(f.service.list(params, caller, f.signal), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
})
test('public ZIP SDK sends opaque FileRef IDs and forwards list/test cancellation', async () => {
  const source = ['fs-reference', 'zip'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const Constructor = vm.runInNewContext(source + '\nZipAPI', { window: { __ztoolsElectron: { contractVersion: 2, transport: { methods: { zip_list() {}, zip_test() {} }, cancellations: { zip_list() {}, zip_test() {} } } } }, TextEncoder }) as new (dll: unknown, transport: unknown) => { list(ref: unknown, options: unknown): Promise<unknown>; test(ref: unknown, options: unknown): Promise<boolean>; compress(options: unknown): Promise<boolean>; extract(options: unknown): Promise<boolean> }
  const calls: { method: string; params: unknown; options: unknown }[] = [], signal = new AbortController().signal
  const api = new Constructor({}, { supportsAbortSignal: true, call: async (method: string, params: unknown, options: unknown) => { calls.push({ method, params: JSON.parse(JSON.stringify(params)), options }); return method === 'zip_list' ? { success: true, files: [{ name: 'file.txt', size: 5, isDirectory: false }] } : { success: true, valid: true } } })
  const ref = { grantId: id, kind: 'file', displayName: 'archive.zip', operations: ['read'] }
  assert.equal((await api.list(ref, { signal }) as unknown[]).length, 1); assert.equal(await api.test(ref, { signal }), true)
  await assert.rejects(api.compress({ sources: 'raw', output: 'raw' }), { code: 'INVALID_REQUEST' }); await assert.rejects(api.extract({ archive: 'raw', output: 'raw' }), { code: 'INVALID_REQUEST' })
  assert.deepEqual(calls.map(call => call.params), [{ fileGrantId: id }, { fileGrantId: id }]); assert.equal((calls[0]?.options as { signal: AbortSignal }).signal, signal)
})

test('ZIP provider verifies actual deflated content without an external DLL', async () => {
  const f = fixture(archive([{ name: 'compressed.txt', data: Buffer.from('repeated text '.repeat(1000)) }], false, true))
  assert.deepEqual(await f.service.test({ fileGrantId: id }, caller, f.signal), { success: true, valid: true })
})

test('ZIP cancellation interrupts actual central-directory iteration', { timeout: 2000 }, async () => {
  const f = fixture(archive(Array.from({ length: 100 }, (_, index) => ({ name: index + '.txt', data: Buffer.from('data') })))), controller = new AbortController()
  const pending = f.service.list({ fileGrantId: id }, caller, controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
})
