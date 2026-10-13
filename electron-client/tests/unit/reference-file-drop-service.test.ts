import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { ReferenceFileDropService } from '../../src/main/services/reference-file-drop-service.js'

function fixture() {
  let identity: CallerIdentity | undefined = { type: 'plugin', webContentsId: 42, pluginId: 'synthetic', pluginInstanceId: 'instance-one' }
  const sent: unknown[] = [], revoked: string[] = [], selected: string[] = []
  let deliver = true, size = 3, failCleanup = false
  const grants: Pick<PathGrantService, 'create' | 'describe' | 'resourceUrl' | 'revoke'> = {
    create: async (owner, candidate, kind, operations) => {
      assert.equal(owner, 42); assert.equal(kind, 'file'); assert.deepEqual(operations, ['read']); selected.push(candidate)
      return { grantId: String(selected.length).padStart(43, 'a'), displayName: 'name.txt', kind, operations, ...{ absolutePath: '/private', handle: 'native' } }
    }, describe: async () => ({ isDirectory: false, size, lastModifiedMs: 1 }),
    resourceUrl: (_, id) => `ztools://file/${id}/name.txt`, revoke: async (_, id) => { if (failCleanup) throw new Error('unconfirmed'); revoked.push(id) }
  }
  const service = new ReferenceFileDropService({ get: () => identity, send: (_, __, value) => { sent.push(value); return deliver } }, grants)
  return { service, grants, sent, revoked, selected, setSize: (value: number) => { size = value }, failDelivery: () => { deliver = false },
    changeOwner: () => { identity = { ...identity!, pluginInstanceId: 'instance-two' } }, disappear: () => { identity = undefined }, failCleanup: () => { failCleanup = true } }
}
const source = path.resolve('out-test', 'synthetic-native-drop', 'input.txt')

test('drop payload projects opaque refs and native metadata without returning absolute paths or handles', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.accept(42, [source, source]), { success: true, accepted: 1, rejected: 0 })
  assert.equal(f.selected.length, 1)
  const text = JSON.stringify(f.sent); assert.ok(text.includes('"contractVersion":2')); assert.ok(text.includes('"fileUrl":"ztools://file/'))
  assert.ok(!text.includes('absolutePath')); assert.ok(!text.includes('"handle"')); assert.ok(!text.includes('synthetic-native-drop'))
})

test('size/type failures revoke acquired refs and successful neighboring selections still deliver', async () => {
  const f = fixture(); let descriptions = 0
  f.grants.describe = async () => ({ isDirectory: false, size: ++descriptions === 1 ? 512 * 1024 * 1024 + 1 : 3, lastModifiedMs: 1 })
  assert.deepEqual(await f.service.accept(42, [source, source + '.other']), { success: true, accepted: 1, rejected: 1 })
  assert.equal(f.revoked.length, 1); assert.ok(JSON.stringify(f.sent).includes('FILE_TOO_LARGE'))
})

test('partial delivery failure and changed plugin generation revoke all unreturned refs', async () => {
  const failed = fixture(); failed.failDelivery()
  await assert.rejects(failed.service.accept(42, [source]), { code: 'FILE_ERROR' }); assert.equal(failed.revoked.length, 1)
  const changed = fixture(), original = changed.grants.describe
  changed.grants.describe = async (...args) => { changed.changeOwner(); return original(...args) }
  await assert.rejects(changed.service.accept(42, [source]), { code: 'PERMISSION_DENIED' }); assert.equal(changed.revoked.length, 1)
})

test('oversize counts and untrusted caller fields are strict, with no path-based authority fallback', async () => {
  const f = fixture()
  assert.equal((await f.service.accept(42, { overflowCount: 101 })).rejected, 101)
  for (const value of [{ overflowCount: 101, owner: 99 }, { overflowCount: 100 }, [], Array(101).fill(source)]) await assert.rejects(f.service.accept(42, value), { code: 'INVALID_REQUEST' })
  assert.equal((await f.service.accept(42, ['/invalid\0path', 'relative'])).accepted, 0); assert.equal(f.selected.length, 0)
  await assert.rejects(f.service.accept(99, [source]), { code: 'PERMISSION_DENIED' })
  f.disappear(); await assert.rejects(f.service.accept(42, [source]), { code: 'PERMISSION_DENIED' })
})

test('cancelled requests and failed native cleanup cannot report successful delivery', async () => {
  const f = fixture(), cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.service.accept(42, [source], cancelled.signal), { code: 'FILE_ERROR' }); assert.equal(f.selected.length, 0)
  f.setSize(512 * 1024 * 1024 + 1); f.failCleanup()
  await assert.rejects(f.service.accept(42, [source]), { code: 'FILE_ERROR' }); assert.equal(f.sent.length, 0)
})

test('per-window drop concurrency is bounded and reservations recover after accepted requests settle', async () => {
  const f = fixture(), original = f.grants.create
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.grants.create = async (...args) => { await gate; return original(...args) }
  const first = f.service.accept(42, [source]), second = f.service.accept(42, [source + '.second'])
  await assert.rejects(f.service.accept(42, [source + '.third']), { code: 'FILE_ERROR' })
  release(); assert.equal((await first).accepted, 1); assert.equal((await second).accepted, 1)
  assert.equal((await f.service.accept(42, [source + '.later'])).accepted, 1)
})

test('total native metadata budget refuses an extra file before publishing its grant', async () => {
  const f = fixture(); f.setSize(512 * 1024 * 1024)
  const result = await f.service.accept(42, Array.from({ length: 5 }, (_, index) => source + index))
  assert.equal(result.accepted, 4); assert.equal(result.rejected, 1); assert.equal(f.revoked.length, 1)
})


test('stop aborts pending native drop authorization, revokes late refs and refuses new delivery', async () => {
  const f = fixture(), original = f.grants.create
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.grants.create = async (...args) => { await gate; return original(...args) }
  const operation = f.service.accept(42, [source])
  const rejected = assert.rejects(operation, { code: 'FILE_ERROR' })
  await new Promise<void>(resolve => setImmediate(resolve))
  const stopped = f.service.stop(); assert.equal(f.service.stop(), stopped)
  await assert.rejects(f.service.accept(42, [source]), { code: 'FILE_ERROR' })
  release(); await rejected; await stopped
  assert.equal(f.revoked.length, 1); assert.equal(f.sent.length, 0)
})

test('owner removal cancels only its pending drop and removes the owned listener on stop', async () => {
  const f = fixture(), original = f.grants.create
  let removed!: (owner: number) => void, unlistened = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.grants.create = async (...args) => { await gate; return original(...args) }
  const service = new ReferenceFileDropService({ get: () => ({ type: 'plugin', webContentsId: 42, pluginId: 'synthetic', pluginInstanceId: 'one' }),
    send: () => { throw new Error('cancelled delivery') }, onRemoved: listener => { removed = listener; return () => { unlistened++ } } }, f.grants)
  const operation = service.accept(42, [source]), rejected = assert.rejects(operation, { code: 'FILE_ERROR' })
  await new Promise<void>(resolve => setImmediate(resolve))
  removed(99); removed(42); release(); await rejected; await service.stop()
  assert.equal(f.revoked.length, 1); assert.equal(unlistened, 1)
})

test('noncooperative drop cleanup times out without publishing success; late refs are still revoked', async () => {
  const f = fixture(), original = f.grants.create
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.grants.create = async (...args) => { await gate; return original(...args) }
  const service = new ReferenceFileDropService({ get: () => ({ type: 'plugin', webContentsId: 42, pluginId: 'synthetic', pluginInstanceId: 'one' }), send: () => false }, f.grants, 10)
  const operation = service.accept(42, [source]), rejected = assert.rejects(operation, { code: 'FILE_ERROR' })
  await new Promise<void>(resolve => setImmediate(resolve))
  await assert.rejects(service.stop(), { code: 'FILE_ERROR' })
  release(); await rejected; assert.equal(f.revoked.length, 1)
})
