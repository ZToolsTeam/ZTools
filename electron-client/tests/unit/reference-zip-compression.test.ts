import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { ReferenceZipCompressionService } from '../../src/main/services/reference-zip-compression-service.js'
import { ReferenceZipService } from '../../src/main/services/reference-zip-service.js'
import type { PathSaveResult } from '../../src/main/platform/path-access.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const caller = { webContentsId: 81 } as CallerIdentity
const first = 'a'.repeat(43), second = 'c'.repeat(43), output = 'b'.repeat(43)
function fixture() {
  let encoded: Buffer | undefined, writes = 0, reads = 0
  let read = async (_id: string) => Buffer.from('repeated content '.repeat(100))
  let save: (bytes: Buffer) => Promise<PathSaveResult> = async bytes => ({ status: 'committed', bytesWritten: bytes.length })
  let name = (id: string): string => id === first ? 'first.txt' : '文档.txt'
  const service = new ReferenceZipCompressionService({ list: async () => { throw new Error('unused') }, deriveRead: async () => { throw new Error('unused') }, revoke: async () => {}, reference: (_owner, id) => ({ grantId: id, kind: 'file', displayName: name(id), operations: ['read'] }), read: async (_owner, id) => { reads++; return read(id) }, save: async (_owner, _id, bytes) => { writes++; encoded = bytes; return save(bytes) } })
  return { service, signal: new AbortController().signal, bytes: () => encoded!, writes: () => writes, reads: () => reads, read: (fn: typeof read) => { read = fn }, save: (fn: typeof save) => { save = fn }, name: (fn: typeof name) => { name = fn } }
}
test('ZIP compression creates actual stored/deflate multi-file archives and only returns confirmed saves', async () => {
  for (const level of [0, 6]) {
    const f = fixture(), result = await f.service.compress({ fileGrantIds: [first, second], saveGrantId: output, level }, caller, f.signal)
    assert.equal(result.status, 'committed'); assert.equal(result.fileCount, 2); assert.equal(result.size, f.bytes().length); assert.equal(f.writes(), 1)
    const reader = new ReferenceZipService({ read: async () => f.bytes() })
    assert.deepEqual(await reader.test({ fileGrantId: first }, caller, f.signal), { success: true, valid: true })
    const listed = await reader.list({ fileGrantId: first }, caller, f.signal); assert.ok('files' in listed)
    assert.deepEqual(listed.files?.map(file => file.name), ['first.txt', '文档.txt'])
  }
})
test('ZIP compression rejects invalid options and empty inputs before IO', async () => {
  const f = fixture()
  for (const params of [{ fileGrantIds: [], saveGrantId: output }, { fileGrantIds: [first], saveGrantId: output, level: 10 }, { fileGrantIds: [first], saveGrantId: output, path: 'raw' }]) await assert.rejects(f.service.compress(params, caller, f.signal), { code: 'INVALID_REQUEST' })
  assert.equal(f.reads(), 0); assert.equal(f.writes(), 0)
})
test('duplicate case-insensitive names and aggregate source limit never commit', async () => {
  const f = fixture(); f.name(id => id === first ? 'Same.txt' : 'same.txt')
  await assert.rejects(f.service.compress({ fileGrantIds: [first, second], saveGrantId: output }, caller, f.signal), { code: 'INVALID_REQUEST' }); assert.equal(f.writes(), 0)
  const g = fixture(); g.read(async () => Buffer.alloc(9 * 1024 * 1024))
  await assert.rejects(g.service.compress({ fileGrantIds: [first, second], saveGrantId: output }, caller, g.signal), { code: 'FILE_TOO_LARGE' }); assert.equal(g.writes(), 0)
})
test('cancel or stop during file read never starts external write', async () => {
  const f = fixture(), controller = new AbortController(); f.read(async () => { controller.abort(); return Buffer.from('data') })
  await assert.rejects(f.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.writes(), 0)
  const g = fixture(); g.service.stop()
  await assert.rejects(g.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, g.signal), { code: 'CALLER_DESTROYED' }); assert.equal(g.reads(), 0)
})
test('unknown or late-canceled save is never reported as successful ZIP output', async () => {
  const f = fixture(); f.save(async bytes => ({ status: 'unknown', bytesWritten: bytes.length } as never))
  await assert.rejects(f.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, f.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const g = fixture(), controller = new AbortController(); g.save(async bytes => { controller.abort(); return { status: 'committed', bytesWritten: bytes.length } })
  await assert.rejects(g.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})
test('public ZIP compression sends FileRef/SaveRef IDs, level zero and AbortSignal', async () => {
  const source = ['fs-reference', 'zip'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ZipAPI', { window: { __ztoolsElectron: { contractVersion: 2, transport: { methods: { zip_compress() {} }, cancellations: { zip_compress() {} } } } }, TextEncoder }) as new (dll: unknown, transport: unknown) => { compress(options: unknown): Promise<boolean> }
  let response = { success: true, status: 'committed', fileCount: 1, sourceCount: 1, size: 100 }; const calls: unknown[][] = [], signal = new AbortController().signal
  const api = new Constructor({}, { supportsAbortSignal: true, call: async (...args: unknown[]) => { calls.push(args); return response } })
  const file = { grantId: first, kind: 'file', displayName: 'first.txt', operations: ['read'] }, save = { grantId: output, kind: 'save', displayName: 'archive.zip', operations: ['write'] }
  assert.equal(await api.compress({ sources: [file], output: save, level: 0, signal }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]?.[1])), { fileGrantIds: [first], saveGrantId: output, level: 0, replace: false, storePaths: true }); assert.equal((calls[0]?.[2] as { signal: AbortSignal }).signal, signal)
  response = { ...response, status: 'unknown' }
  await assert.rejects(api.compress({ sources: file, output: save }), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await assert.rejects(api.compress({ sources: file, output: save, password: 'secret' }), { code: 'NOT_SUPPORTED' })
})

function directoryFixture() {
  let encoded: Buffer | undefined, writes = 0, revoked = 0, listing = 0
  let children = async (relative: string) => relative === '' ? [{ name: 'nested', isDirectory: true, size: 0 }, { name: 'empty', isDirectory: true, size: 0 }] : relative === 'nested' ? [{ name: 'file.txt', isDirectory: false, size: 4 }] : []
  let read = async () => Buffer.from('data')
  const service = new ReferenceZipCompressionService({
    reference: (_owner, id) => ({ grantId: id, kind: 'directory', displayName: 'root', operations: ['read', 'list'] }),
    list: async (_owner, _id, relative) => { listing++; return children(relative ?? '') },
    deriveRead: async () => ({ grantId: second, kind: 'file', displayName: 'file.txt', operations: ['read'] }),
    revoke: async () => { revoked++ }, read: async () => read(),
    save: async (_owner, _id, bytes) => { writes++; encoded = bytes; return { status: 'committed', bytesWritten: bytes.length } }
  })
  return { service, signal: new AbortController().signal, bytes: () => encoded!, writes: () => writes, revoked: () => revoked, listing: () => listing, children: (fn: typeof children) => { children = fn }, read: (fn: typeof read) => { read = fn } }
}
test('directory compression preserves root/nested/empty directories with actual stored and deflate CRC', async () => {
  for (const level of [0, 6]) {
    const f = directoryFixture(), receipt = await f.service.compress({ fileGrantIds: [first], saveGrantId: output, level }, caller, f.signal)
    assert.equal(receipt.sourceCount, 1); assert.equal(receipt.fileCount, 1); assert.equal(f.revoked(), 1)
    const reader = new ReferenceZipService({ read: async () => f.bytes() })
    const entries = await reader.readEntries({ fileGrantId: first }, caller, f.signal)
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['root/', 'root/empty/', 'root/nested/', 'root/nested/file.txt'])
    assert.equal(entries.find(entry => entry.name.endsWith('file.txt'))?.data.toString(), 'data')
  }
})
test('directory read size change and cancellation release derived refs without saving', async () => {
  const f = directoryFixture(); f.read(async () => Buffer.from('changed'))
  await assert.rejects(f.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, f.signal), { code: 'FILE_ERROR' }); assert.equal(f.revoked(), 1); assert.equal(f.writes(), 0)
  const g = directoryFixture(), controller = new AbortController(); g.read(async () => { controller.abort(); return Buffer.from('data') })
  await assert.rejects(g.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(g.revoked(), 1); assert.equal(g.writes(), 0)
})
test('directory flattening, excessive entries and case collisions cannot produce an output', async () => {
  const f = directoryFixture()
  await assert.rejects(f.service.compress({ fileGrantIds: [first], saveGrantId: output, storePaths: false }, caller, f.signal), { code: 'NOT_SUPPORTED' }); assert.equal(f.listing(), 0)
  const g = directoryFixture(); g.children(async () => Array.from({ length: 1024 }, (_, i) => ({ name: String(i), isDirectory: false, size: 4 })))
  await assert.rejects(g.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, g.signal), { code: 'FILE_TOO_LARGE' }); assert.equal(g.writes(), 0)
  const h = directoryFixture(); h.children(async () => [{ name: 'same', isDirectory: false, size: 4 }, { name: 'SAME', isDirectory: false, size: 4 }])
  await assert.rejects(h.service.compress({ fileGrantIds: [first], saveGrantId: output }, caller, h.signal), { code: 'INVALID_REQUEST' }); assert.equal(h.writes(), 0); assert.equal(h.revoked(), 2)
})
