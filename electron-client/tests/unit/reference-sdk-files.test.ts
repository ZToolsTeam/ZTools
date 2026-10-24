import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

interface SDK {
  listWriteRecovery(options?: unknown): Promise<unknown>
  inspectWriteRecovery(id: string, options?: unknown): Promise<unknown>
  findFiles(ref: unknown, pattern?: string, options?: unknown): Promise<unknown>
  findDirectories(ref: unknown, pattern?: string, options?: unknown): Promise<unknown>
  readFile(ref: unknown, options?: unknown): Promise<string>
  readFileAsBinary(ref: unknown, options?: unknown): Promise<ArrayBuffer>
  readFileRange(ref: unknown, offset: number, length: number, options?: unknown): Promise<ArrayBuffer>
  writeFile(ref: unknown, content: unknown, options?: unknown): Promise<unknown>
  deriveSave(ref: unknown, name: string): Promise<unknown>
  deleteDirectory(ref: unknown, name: string): Promise<unknown>
  writeCache(name: string, content: unknown, options?: unknown): Promise<unknown>
  describe(ref: unknown): Promise<unknown>
  deriveRead(ref: unknown, name: string): Promise<unknown>
  getDirectoryContents(ref: unknown): Promise<unknown>
  readCache(name: string): Promise<unknown>
  getCurrentDirectory(): Promise<unknown>
}
const file = { grantId: 'a'.repeat(43), displayName: '文件.txt', kind: 'file', operations: ['read'] }
const save = { grantId: 'b'.repeat(43), displayName: 'output.txt', kind: 'save', operations: ['write'] }
const directory = { grantId: 'c'.repeat(43), displayName: 'folder', kind: 'directory', operations: ['read', 'list', 'write'] }
const artifact = { grantId: 'd'.repeat(43), displayName: 'output.txt', kind: 'file', operations: ['read'], fileUrl: 'ztools://file/' + 'd'.repeat(43) + '/output.txt' }
function fixture(contractVersion = 2) {
  const directory = path.resolve('../frontend/public/js/cef-ipc/src/api')
  const source = fs.readFileSync(path.join(directory, 'fs-reference.js'), 'utf8').replace(/^export default .+$/m, '')
  const legacy = fs.readFileSync(path.join(directory, 'fs.js'), 'utf8').replace(/^export default .+$/m, '')
  const methods = Object.fromEntries([...source.matchAll(/'(filesystem_[a-z_]+)'/g)].map(match => [match[1], () => {}]))
  const calls: { method: string; params: unknown }[] = []
  let response: unknown = { success: true, content: '文本', size: 6 }
  const transport = { call: async (method: string, params: unknown) => { calls.push({ method, params: JSON.parse(JSON.stringify(params)) }); return response } }
  const window = { __ztoolsElectron: { contractVersion, transport: { methods } }, _readFileArrayBuffer: () => { throw new Error('V8 must not be used') } }
  const constructor = vm.runInNewContext(legacy + '\n' + source + '\nReferenceFileSystemAPI', {
    window, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa
  }) as new (port: typeof transport) => SDK
  return { sdk: new constructor(transport), calls, window, response: (value: unknown) => { response = value } }
}

test('SDK2 requires a matching Electron bridge and never selects legacy/V8/Mock transport', async () => {
  const old = fixture(1)
  await assert.rejects(old.sdk.readFile(file), { code: 'NOT_SUPPORTED' }); assert.equal(old.calls.length, 0)
  const missing = fixture(2); delete missing.window.__ztoolsElectron.transport.methods.filesystem_read_file
  await assert.rejects(missing.sdk.readFile(file), { code: 'NOT_SUPPORTED' }); assert.equal(missing.calls.length, 0)
})

test('SDK2 rejects malformed host references, unbounded listings and cache data without exposing raw fields', async () => {
  const f = fixture()
  for (const reference of [{ ...file, path: '/private/raw' }, { ...file, operations: ['read', 'write'] },
    { ...file, fileUrl: 'file:///private/raw' }, { ...file, displayName: 99 }, { ...file, kind: 'save' }]) {
    f.response({ success: true, reference })
    await assert.rejects(f.sdk.deriveRead(directory, 'child'), { code: 'FILE_ERROR' })
  }
  f.response({ success: true, files: [{ name: 'literal:back\\slash\n.txt', isDirectory: false, size: 0 }] })
  assert.deepEqual(JSON.parse(JSON.stringify(await f.sdk.getDirectoryContents(directory))), [{ name: 'literal:back\\slash\n.txt', isDirectory: false, size: 0 }])
  for (const files of [[{ name: '../escape', isDirectory: false, size: 1 }], [{ name: '.ztools-save-private', isDirectory: false, size: 1 }],
    [{ name: 'file', isDirectory: false, size: 1, path: '/private/raw' }], Array.from({ length: 10001 }, () => ({ name: 'file', isDirectory: false, size: 1 }))]) {
    f.response({ success: true, files }); await assert.rejects(f.sdk.getDirectoryContents(directory), { code: 'FILE_ERROR' })
  }
  f.response({ success: true, content: 'cache', size: -1 })
  await assert.rejects(f.sdk.readCache('cache'), { code: 'FILE_ERROR' })
  f.response({ success: true, reference: null }); assert.equal(await f.sdk.getCurrentDirectory(), null)
  f.response({ success: true, reference: file }); await assert.rejects(f.sdk.getCurrentDirectory(), { code: 'FILE_ERROR' })
})

test('SDK2 file calls transmit grant IDs and relative names without renderer paths or owners', async () => {
  const f = fixture()
  assert.equal(await f.sdk.readFile(file), '文本')
  assert.deepEqual(f.calls[0], { method: 'filesystem_read_file', params: { grantId: file.grantId, relativePath: '', encoding: 'utf8' } })
  f.response({ success: true, status: 'committed', size: 3, reference: artifact })
  const receipt = await f.sdk.writeFile(save, new Uint8Array([0, 255, 7])) as { status: string; reference: typeof artifact }
  assert.equal(receipt.status, 'committed'); assert.deepEqual(JSON.parse(JSON.stringify(receipt.reference.operations)), ['read'])
  assert.deepEqual(f.calls[1], { method: 'filesystem_write_file', params: { saveGrantId: save.grantId, content: 'AP8H', encoding: 'base64', replace: false } })
  f.response({ success: true, reference: save })
  assert.equal(await f.sdk.deriveSave(directory, 'literal:back\\slash\n.txt'), save)
  assert.deepEqual(f.calls[2]!.params, { directoryGrantId: directory.grantId, relativePath: 'literal:back\\slash\n.txt' })
  assert.ok(!JSON.stringify(f.calls).includes('"path"')); assert.ok(!JSON.stringify(f.calls).includes('"owner"'))
})

test('SDK write returns explicit unknown outcomes and rejects malformed committed receipts', async () => {
  const f = fixture()
  f.response({ success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const unknown = await f.sdk.writeFile(save, 'data') as { success: boolean; status: string; code: string }
  assert.deepEqual(JSON.parse(JSON.stringify(unknown)), { success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.ok(Object.isFrozen(unknown))

  for (const invalid of [
    { success: true, status: 'committed', size: 3, reference: artifact },
    { success: true, status: 'committed', size: 5, reference: artifact },
    { success: true, status: 'committed', size: 4, reference: { grantId: artifact.grantId, displayName: artifact.displayName, kind: 'file', operations: ['read'] } },
    { success: true, status: 'committed', size: 4, reference: { ...artifact, fileUrl: undefined } },
    { success: true, status: 'committed', size: 4, reference: { ...artifact, operations: ['read', 'write'] } },
    { success: true, status: 'committed', size: 4, reference: { ...artifact, kind: 'save', operations: ['write'] } },
    { success: true, status: 'committed', size: 4, reference: { ...artifact, fileUrl: 'file:///private/output.txt' } },
    { success: true, status: 'committed', size: 4, reference: artifact, path: '/private/output.txt' },
    { success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN', reference: artifact }
  ]) {
    f.response(invalid)
    await assert.rejects(f.sdk.writeFile(save, 'data'), { code: 'FILE_ERROR' })
  }
})

test('SDK2 rejects old path signatures, wrong authority, traversal and malformed options before transport', async () => {
  const f = fixture()
  for (const ref of ['C:/raw/file', { ...file, owner: 99 }, { ...file, path: '/raw' }, { ...file, grantId: 1 }]) {
    await assert.rejects(f.sdk.readFile(ref), { code: 'INVALID_REQUEST' })
  }
  await assert.rejects(f.sdk.writeFile(file, 'data'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.writeFile(save, 'data', { replace: 'true' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.deriveSave(directory, '../outside'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.deriveSave(directory, '.ztools-save-owned'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.deleteDirectory(directory, ''), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.writeCache('file', 'data', { owner: 99 }), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
})

test('SDK2 binary/range responses are byte preserving and malformed/oversized responses reject', async () => {
  const f = fixture()
  f.response({ success: true, content: 'AP8H', size: 3 })
  assert.deepEqual(new Uint8Array(await f.sdk.readFileAsBinary(file)), new Uint8Array([0, 255, 7]))
  f.response({ success: true, content: '/w==', size: 1, offset: 5, encoding: 'base64' })
  assert.deepEqual(new Uint8Array(await f.sdk.readFileRange(file, 5, 1)), new Uint8Array([255]))
  await assert.rejects(f.sdk.readFileRange(file, Number.MAX_SAFE_INTEGER, 1), { code: 'INVALID_REQUEST' })
  f.response({ success: true, content: '/w', size: 1 })
  await assert.rejects(f.sdk.readFileAsBinary(file), { code: 'FILE_ERROR' })
  f.response({ success: true, content: '', size: 17 * 1024 * 1024 })
  await assert.rejects(f.sdk.readFileAsBinary(file), { code: 'FILE_ERROR' })
  f.response({ success: true, isDirectory: false, size: NaN, lastModifiedMs: 0 })
  await assert.rejects(f.sdk.describe(file), { code: 'FILE_ERROR' })
})

test('SDK2 refuses unsupported cancellation instead of promising a local-only abort; pre-cancel never dispatches', async () => {
  const f = fixture(), controller = new AbortController()
  await assert.rejects(f.sdk.readFile(file, { signal: controller.signal }), { code: 'NOT_SUPPORTED' })
  controller.abort()
  await assert.rejects(f.sdk.readFile(file, { signal: controller.signal }), { code: 'CALLER_DESTROYED' })
  assert.equal(f.calls.length, 0)
  f.response({ success: false, error: { code: 'FILE_WRITE_OUTCOME_UNKNOWN', message: 'unconfirmed' } })
  await assert.rejects(f.sdk.writeFile(save, 'data'), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})


test('SDK reference searches send only directory IDs, relative names and explicit matching semantics', async () => {
  const f = fixture()
  f.response({ success: true, files: [{ name: 'literal:back\\slash\n.txt', isDirectory: false, size: 0 }] })
  const result = await f.sdk.findFiles(directory, '*.txt', { relativePath: 'nested', caseSensitive: false })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ name: 'literal:back\\slash\n.txt', isDirectory: false, size: 0 }])
  assert.deepEqual(f.calls[0], { method: 'filesystem_find_files', params: { directoryGrantId: directory.grantId,
    relativePath: 'nested', pattern: '*.txt', caseSensitive: false } })
  f.response({ success: true, files: [] }); await f.sdk.findDirectories(directory)
  assert.deepEqual(f.calls[1]!.params, { directoryGrantId: directory.grantId, relativePath: '', pattern: '*', caseSensitive: true })
  for (const pattern of ['../*', '', '\0', 'x'.repeat(129), '中'.repeat(86)]) await assert.rejects(f.sdk.findFiles(directory, pattern), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.findFiles('/raw', '*'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.findFiles(directory, '*', { caseSensitive: 'guess' }), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 2)
  f.response({ success: true, files: [{ name: 'a', isDirectory: false, size: 1, path: '/private/a' }] })
  await assert.rejects(f.sdk.findFiles(directory), { code: 'FILE_ERROR' })
  f.response({ success: true, files: [{ name: 'folder', isDirectory: true, size: 0 }] })
  await assert.rejects(f.sdk.findFiles(directory), { code: 'FILE_ERROR' })
})


test('SDK recovery diagnostics are bounded, immutable, path-free and never claim business success', async () => {
  const f = fixture(), id = '12345678-1234-4123-8123-123456789abc'
  const entry = { recoveryId: id, displayName: 'output.txt', phase: 'unknown', createdAt: 1, expectedBytes: null }
  f.response({ success: true, entries: [entry] })
  const entries = await f.sdk.listWriteRecovery() as object[]
  assert.ok(Object.isFrozen(entries)); assert.ok(Object.isFrozen(entries[0]))
  assert.deepEqual(f.calls[0], { method: 'filesystem_list_write_recovery', params: {} })
  for (const invalid of [[{ ...entry, selectedPath: '/private' }], [entry, entry], [{ ...entry, expectedBytes: -1 }], Array(257).fill(entry)]) {
    f.response({ success: true, entries: invalid }); await assert.rejects(f.sdk.listWriteRecovery(), { code: 'FILE_ERROR' })
  }
  for (const observation of [{ state: 'staging', size: 3 }, { state: 'committed-object', size: 3 }, { state: 'unresolved', reason: 'no-object-proof' }]) {
    f.response({ success: true, entry: { ...entry, observation, businessResult: 'unconfirmed' } })
    const result = await f.sdk.inspectWriteRecovery(id) as { observation: object }
    assert.ok(Object.isFrozen(result.observation))
  }
  for (const extra of [{ observation: { state: 'staging', size: 3, proof: 'secret' } }, { businessResult: 'success' }, { recoveryId: '00000000-0000-4000-8000-000000000000' }]) {
    f.response({ success: true, entry: { ...entry, observation: { state: 'staging', size: 3 }, businessResult: 'unconfirmed', ...extra } })
    await assert.rejects(f.sdk.inspectWriteRecovery(id), { code: 'FILE_ERROR' })
  }
  await assert.rejects(f.sdk.inspectWriteRecovery('/private/raw'), { code: 'INVALID_REQUEST' })
})
