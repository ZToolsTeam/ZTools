import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { ReferenceZipExtractionService } from '../../src/main/services/reference-zip-extraction-service.js'
import { ReferenceZipService } from '../../src/main/services/reference-zip-service.js'
import { buildZipFixture } from '../helpers/zip-fixture.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const caller = { webContentsId: 81 } as CallerIdentity
const input = 'a'.repeat(43), output = 'b'.repeat(43), saveId = 'c'.repeat(43)
function fixture(files = [{ name: 'folder/文档.txt', data: Buffer.from('hello') }], corrupt = false) {
  const bytes = buildZipFixture(files, corrupt, true), writes: { name: string; data: Buffer }[] = [], dirs: string[] = [], revoked: string[] = []
  let current = '', read = async () => bytes, save = async (data: Buffer) => ({ status: 'committed' as const, bytesWritten: data.length })
  const reader = new ReferenceZipService({ read: async () => read() })
  const service = new ReferenceZipExtractionService(reader, {
    reference: () => ({ grantId: output, kind: 'directory', displayName: 'destination', operations: ['write'] }),
    createDirectory: async (_owner, _id, name) => { dirs.push(name); return { status: 'created' } },
    deriveSave: async (_owner, _id, name) => { current = name; return { grantId: saveId, kind: 'save', displayName: name, operations: ['write'] } },
    save: async (_owner, _id, data, replace) => { assert.equal(replace, false); const receipt = await save(data); writes.push({ name: current, data }); return receipt },
    revoke: async (_owner, id) => { revoked.push(id) }
  })
  return { service, writes, dirs, revoked, signal: new AbortController().signal, read: (fn: typeof read) => { read = fn }, save: (fn: typeof save) => { save = fn } }
}
test('ZIP extraction verifies CRC and creates nested/empty directories before confirmed no-replace writes', async () => {
  const f = fixture([{ name: 'empty/', data: Buffer.alloc(0) }, { name: 'a/b/文档.txt', data: Buffer.from('hello') }, { name: 'zero.txt', data: Buffer.alloc(0) }])
  const result = await f.service.extract({ fileGrantId: input, directoryGrantId: output }, caller, f.signal)
  assert.equal(result.status, 'committed'); assert.deepEqual(result.completed, ['a/b/文档.txt', 'zero.txt']); assert.deepEqual(f.dirs, ['a', 'empty', 'a/b'])
  assert.equal(f.writes[0]?.data.toString(), 'hello'); assert.equal(f.writes[1]?.data.length, 0); assert.equal(f.revoked.length, 2)
})
test('CRC damage and duplicate namespace or file/directory collisions never start writes', async () => {
  for (const [files, corrupt] of [
    [[{ name: 'a.txt', data: Buffer.from('a') }], true],
    [[{ name: 'a.txt', data: Buffer.from('a') }, { name: 'A.txt', data: Buffer.from('b') }], false],
    [[{ name: 'a', data: Buffer.from('a') }, { name: 'a/b.txt', data: Buffer.from('b') }], false],
    [[{ name: '../a', data: Buffer.from('a') }], false]
  ] as const) {
    const f = fixture([...files], corrupt)
    await assert.rejects(f.service.extract({ fileGrantId: input, directoryGrantId: output }, caller, f.signal)); assert.equal(f.dirs.length, 0); assert.equal(f.writes.length, 0)
  }
})
test('second file failure preserves confirmed first file and releases every derived save grant', async () => {
  const f = fixture([{ name: 'a.txt', data: Buffer.from('a') }, { name: 'b.txt', data: Buffer.from('b') }]); let count = 0
  f.save(async data => { if (++count === 2) throw new ZToolsError(errorCodes.fileAlreadyExists, '已有文件'); return { status: 'committed', bytesWritten: data.length } })
  const result = await f.service.extract({ fileGrantId: input, directoryGrantId: output }, caller, f.signal)
  assert.equal(result.status, 'partial'); assert.deepEqual(result.completed, ['a.txt']); assert.equal(result.error?.code, 'FILE_ALREADY_EXISTS'); assert.equal(result.uncertain, undefined); assert.equal(f.revoked.length, 2)
})
test('late save cancellation is unknown and does not report file as committed', async () => {
  const f = fixture(), controller = new AbortController(); f.save(async data => { controller.abort(); return { status: 'committed', bytesWritten: data.length } })
  const result = await f.service.extract({ fileGrantId: input, directoryGrantId: output }, caller, controller.signal)
  assert.equal(result.status, 'partial'); assert.equal(result.error?.code, 'FILE_WRITE_OUTCOME_UNKNOWN'); assert.equal(result.uncertain, 'folder/文档.txt'); assert.deepEqual(result.completed, []); assert.equal(f.revoked.length, 1)
})
test('cancel before/during read or stopped service never starts directory/file writes', async () => {
  const f = fixture(), controller = new AbortController(); f.read(async () => { controller.abort(); return buildZipFixture() })
  await assert.rejects(f.service.extract({ fileGrantId: input, directoryGrantId: output }, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.dirs.length, 0)
  const g = fixture(); g.service.stop(); await assert.rejects(g.service.extract({ fileGrantId: input, directoryGrantId: output }, caller, g.signal), { code: 'CALLER_DESTROYED' })
})
test('invalid extraction options are rejected before IO', async () => {
  const f = fixture(); await assert.rejects(f.service.extract({ fileGrantId: input, directoryGrantId: output, replace: true }, caller, f.signal), { code: 'INVALID_REQUEST' }); assert.equal(f.writes.length, 0)
})
test('public ZIP extraction sends owned refs/signal and exposes partial receipts without claiming success', async () => {
  const source = ['fs-reference', 'zip'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ZipAPI', { window: { __ztoolsElectron: { contractVersion: 2, transport: { methods: { zip_extract() {} }, cancellations: { zip_extract() {} } } } }, TextEncoder }) as new (dll: unknown, transport: unknown) => { extract(options: unknown): Promise<boolean> }
  let response: unknown = { success: true, status: 'committed', completed: ['a.txt'], createdDirectories: [] }; const calls: unknown[][] = [], signal = new AbortController().signal
  const api = new Constructor({}, { supportsAbortSignal: true, call: async (...args: unknown[]) => { calls.push(args); return response } })
  const file = { grantId: input, kind: 'file', displayName: 'archive.zip', operations: ['read'] }, directory = { grantId: output, kind: 'directory', displayName: 'output', operations: ['write'] }
  assert.equal(await api.extract({ archive: file, output: directory, signal }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]?.[1])), { fileGrantId: input, directoryGrantId: output }); assert.equal((calls[0]?.[2] as { signal: AbortSignal }).signal, signal)
  response = { success: true, status: 'partial', completed: ['a.txt'], createdDirectories: ['folder'], error: { code: 'FILE_ALREADY_EXISTS', message: '已有文件' } }
  await assert.rejects(api.extract({ archive: file, output: directory }), error => { assert.equal((error as { code: string }).code, 'FILE_ALREADY_EXISTS'); assert.deepEqual(JSON.parse(JSON.stringify((error as { completed: string[] }).completed)), ['a.txt']); return true })
  await assert.rejects(api.extract({ archive: file, output: directory, replace: true }), { code: 'NOT_SUPPORTED' })
})
