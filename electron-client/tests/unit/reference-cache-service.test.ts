import assert from 'node:assert/strict'
import test from 'node:test'
import { ReferenceCacheService } from '../../src/main/services/reference-cache-service.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'
import type { PathGrantRef } from '../../src/contracts/path-reference.js'
import { ZToolsError, errorCodes } from '../../src/contracts/errors.js'

const caller = { type: 'main', webContentsId: 42 } as const
const root: PathGrantRef = { grantId: 'a'.repeat(43), displayName: 'Cache', kind: 'directory', operations: ['read', 'write', 'list'] }
const saving: PathGrantRef = { grantId: 'b'.repeat(43), displayName: 'output', kind: 'save', operations: ['write'] }
const reading: PathGrantRef = { grantId: 'c'.repeat(43), displayName: 'output', kind: 'file', operations: ['read'] }
function fixture() {
  const calls: string[] = [], revoked: string[] = []; let roots = 0
  const port = {
    reference: () => root,
    read: async (owner: number, _: string, relative: string) => { calls.push('read:' + owner + ':' + relative); return Buffer.from('cache') },
    createDirectory: async (_: number, __: string, relative: string) => { calls.push('mkdir:' + relative); return { status: 'created' as const } },
    deriveSave: async (_: number, __: string, relative: string) => { calls.push('deriveSave:' + relative); return saving },
    save: async (_: number, __: string, bytes: Buffer, replace: boolean) => { calls.push('save:' + bytes.toString() + ':' + replace); return { status: 'committed' as const, bytesWritten: bytes.length } },
    revoke: async (_: number, id: string) => { revoked.push(id) },
    deriveRead: async (_: number, __: string, relative: string) => { calls.push('deriveRead:' + relative); return reading },
    resourceUrl: () => 'ztools://file/' + reading.grantId + '/output'
  }
  const provider = { get: async () => { roots++; return root } }
  return { port, provider, calls, revoked, roots: () => roots,
    service: new ReferenceCacheService(port as unknown as PathGrantService, () => provider.get()) }
}

test('cache I/O uses only trusted owner root and relative native operations, returning FileRef without a path', async () => {
  const f = fixture()
  assert.equal((await f.service.readCache({ name: 'folder/input.txt' }, caller)).content, 'cache')
  const result = await f.service.writeCache({ name: 'folder/nested/output.txt', content: 'content' }, caller)
  assert.deepEqual(f.calls, ['read:42:folder/input.txt', 'mkdir:folder', 'mkdir:folder/nested', 'deriveSave:folder/nested/output.txt', 'save:content:false', 'deriveRead:folder/nested/output.txt'])
  assert.deepEqual(f.revoked, [saving.grantId]); assert.equal(result.reference.grantId, reading.grantId)
  assert.ok(!Object.hasOwn(result, 'path')); assert.equal(result.size, 7)
})

test('cache rejects renderer roots, traversal, internal names, invalid content and pre-cancel before acquisition', async () => {
  const f = fixture()
  for (const value of [{ name: '../outside', content: '' }, { name: '.ztools-save-owned', content: '' },
    { name: 'file', content: '', owner: 99 }, { name: 'file', content: '', path: '/raw' },
    { name: 'file', content: '%%%=', encoding: 'base64' }, { name: 'file', content: '', replace: 'true' }]) {
    await assert.rejects(f.service.writeCache(value, caller), { code: 'INVALID_REQUEST' })
  }
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.service.writeCache({ name: 'file', content: '' }, caller, cancelled.signal), { code: 'PERMISSION_DENIED' })
  assert.equal(f.roots(), 0); assert.deepEqual(f.calls, [])
  f.port.reference = () => ({ ...root, operations: ['read', 'list'] })
  await assert.rejects(f.service.readCache({ name: 'file' }, caller), { code: 'PERMISSION_DENIED' })
})

test('postcommit reference failure never claims rollback and native uncertainty survives successful grant cleanup', async () => {
  const f = fixture()
  f.port.deriveRead = async () => { throw new Error('no reference') }
  await assert.rejects(f.service.writeCache({ name: 'output', content: 'bytes' }, caller), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.deepEqual(f.revoked, [saving.grantId])
  const uncertain = fixture()
  uncertain.port.save = async () => { throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'unconfirmed') }
  await assert.rejects(uncertain.service.writeCache({ name: 'output', content: 'bytes' }, caller), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.deepEqual(uncertain.revoked, [saving.grantId])
})

test('late cancellation releases the undelivered FileRef and reports postcommit uncertainty', async () => {
  const f = fixture(), controller = new AbortController()
  f.port.resourceUrl = () => { controller.abort(); return 'ztools://file/private' }
  await assert.rejects(f.service.writeCache({ name: 'output', content: 'bytes' }, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.deepEqual(f.revoked, [saving.grantId, reading.grantId])
})

test('cache requests are bounded globally and per owner and reservations clear after settlement', async () => {
  const f = fixture(); let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  f.provider.get = async () => { await gate; return root }
  const pending = Array.from({ length: 8 }, (_, index) => f.service.readCache({ name: 'file' }, { ...caller, webContentsId: 1 + Math.floor(index / 2) }))
  await assert.rejects(f.service.readCache({ name: 'file' }, { ...caller, webContentsId: 1 }), { code: 'PERMISSION_DENIED' })
  await assert.rejects(f.service.readCache({ name: 'file' }, { ...caller, webContentsId: 99 }), { code: 'PERMISSION_DENIED' })
  finish(); await Promise.all(pending)
  assert.equal((await f.service.readCache({ name: 'file' }, caller)).content, 'cache')
})

test('main generated files use unpredictable restricted names and return references', async () => {
  const f = fixture()
  await f.service.writeGeneratedCacheFile(Buffer.from('image'), caller, 'png')
  await f.service.writeGeneratedCacheFile(Buffer.from('image'), caller, 'png')
  const names = f.calls.filter(item => item.startsWith('deriveSave:'))
  assert.notEqual(names[0], names[1]); assert.match(names[0]!, /^deriveSave:generated-[0-9a-f-]{36}\.png$/)
  await assert.rejects(f.service.writeGeneratedCacheFile(Buffer.alloc(0), caller, '../exe'))
})

test('cache write memory budget is reserved before root acquisition and released after failed roots', async () => {
  const f = fixture(); let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  f.provider.get = async () => { await gate; throw new Error('synthetic root failure') }
  const content = 'x'.repeat(16 * 1024 * 1024)
  const pending = Array.from({ length: 4 }, (_, index) => f.service.writeCache({ name: 'output', content }, { ...caller, webContentsId: index + 1 }))
  await assert.rejects(f.service.writeCache({ name: 'output', content: 'x' }, caller), { code: 'FILE_TOO_LARGE' })
  finish(); await Promise.all(pending.map(item => assert.rejects(item)))
  f.provider.get = async () => root
  assert.equal((await f.service.writeCache({ name: 'output', content: 'x' }, caller)).size, 1)
})
