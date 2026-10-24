import assert from 'node:assert/strict'
import test from 'node:test'
import { PathGrantService, grantPathSegments } from '../../src/main/services/path-grant-service.js'
import type { PathAccessAdapter } from '../../src/main/platform/path-access.js'
import { OwnedPathAccessProvider } from '../../src/main/platform/owned-path-access.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'

function fixture() {
  const released: string[] = []
const adapter: PathAccessAdapter = {
    platform: 'win32',
    pin: async (_, kind) => ({ handle: 'native-only-handle', kind, displayName: '空 格.txt' }),
    read: async (_, segments) => Buffer.from(segments.join('/') || 'synthetic'),
    readRange: async (_, __, offset, length) => Buffer.from('synthetic').subarray(offset, offset + length),
    save: async (_, data) => ({ status: 'committed', bytesWritten: data.length }),
    streamSave: async (_, expected) => ({ status: 'committed', bytesWritten: expected ?? 0 }),
    pinCommittedSave: async object => ({ handle: 'committed-read', kind: 'file', displayName: object.displayName }),
    deriveSave: async (_, segments) => ({ handle: 'derived-native', kind: 'save', displayName: segments.at(-1)! }),
    deriveRead: async (_, segments) => ({ handle: 'derived-read', kind: 'file', displayName: segments.at(-1)! }),
    deriveDirectory: async (_, segments) => ({ handle: 'derived-directory', kind: 'directory', displayName: segments.at(-1)! }),
    describe: async object => ({ isDirectory: object.kind === 'directory', size: object.kind === 'directory' ? 0 : 9, lastModifiedMs: 1000 }),
    copy: async () => ({ status: 'committed', bytesWritten: 9 }),
    remove: async () => ({ status: 'committed' }),
    move: async () => ({ status: 'committed' }),
    createDirectory: async () => ({ status: 'created' }),
    list: async () => [{ name: 'fixture.txt', size: 9, isDirectory: false }],
    release: async object => { released.push(object.handle) },
    stop: async () => {}
  }
  return { adapter, released }
}

test('existing grant projection is immutable, owner-bound and cannot revive expired or revoked references', async () => {
  const f = fixture(); let now = 0
  const service = new PathGrantService(f.adapter, () => now)
  const directory = await service.create(42, '/trusted', 'directory', ['read', 'list'])
  const projected = service.reference(42, directory.grantId)
  assert.deepEqual(projected.operations, ['read', 'list'])
  assert.ok(Object.isFrozen(projected)); assert.ok(Object.isFrozen(projected.operations))
  assert.ok(!JSON.stringify(projected).includes('native-only-handle'))
  assert.throws(() => service.reference(99, directory.grantId), { code: 'PERMISSION_DENIED' })
  now = 3_600_000; assert.throws(() => service.reference(42, directory.grantId), { code: 'PERMISSION_DENIED' })
  now = 0; await service.revoke(42, directory.grantId)
  assert.throws(() => service.reference(42, directory.grantId), { code: 'PERMISSION_DENIED' })
  await service.stop()
})

test('confirmed save returns an owner-bound read-only artifact whose bytes match disk and revoke cascades', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const save = await service.create(42, '/private/output.txt', 'save', ['write'])
  let saved = Buffer.alloc(0)
  f.adapter.save = async (_object, bytes, replace) => {
    if (saved.length && !replace) throw new ZToolsError(errorCodes.fileAlreadyExists, 'exists')
    saved = Buffer.from(bytes)
    return { status: 'committed', bytesWritten: saved.length }
  }
  f.adapter.pinCommittedSave = async object => ({ handle: 'artifact-file', kind: 'file', displayName: object.displayName })
  f.adapter.describe = async object => ({ isDirectory: object.kind === 'directory', size: object.kind === 'file' ? saved.length : 0, lastModifiedMs: 1 })
  f.adapter.read = async object => object.handle === 'artifact-file' ? Buffer.from(saved) : Buffer.from('synthetic')

  const bytes = Buffer.from([0, 255, 7, 13])
  const receipt = await service.saveWithReference(42, save.grantId, bytes)
  assert.equal(receipt.referenceState, 'available')
  if (receipt.referenceState !== 'available') throw new Error('expected verified artifact')
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.bytesWritten, bytes.length)
  assert.deepEqual(receipt.reference.operations, ['read']); assert.equal(receipt.reference.kind, 'file')
  assert.deepEqual(await service.read(42, receipt.reference.grantId), bytes)
  assert.deepEqual(saved, bytes)
  await assert.rejects(service.save(42, receipt.reference.grantId, Buffer.from('no')), { code: 'PERMISSION_DENIED' })
  await assert.rejects(service.read(99, receipt.reference.grantId), { code: 'PERMISSION_DENIED' })
  await assert.rejects(service.saveWithReference(42, save.grantId, Buffer.from('conflict')), { code: 'FILE_ALREADY_EXISTS' })

  await service.revoke(42, save.grantId)
  assert.deepEqual(saved, bytes, 'revoking references cannot roll back committed file contents')
  assert.deepEqual(await service.read(42, receipt.reference.grantId), bytes, 'artifact lifetime is independent of the save target grant')
  await service.revoke(42, receipt.reference.grantId)
  await assert.rejects(service.read(42, receipt.reference.grantId), { code: 'PERMISSION_DENIED' })
  await service.stop()
})

test('derived save pins the exact committed target into an independently revocable read-only artifact', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const directory = await service.create(42, '/private', 'directory', ['read', 'write', 'list'])
  const save = await service.deriveSave(42, directory.grantId, 'derived/output.txt')
  let saved = Buffer.alloc(0), pinnedSaveHandle = ''
  f.adapter.save = async (object, bytes) => {
    assert.equal(object.handle, 'derived-native')
    saved = Buffer.from(bytes)
    return { status: 'committed', bytesWritten: saved.length }
  }
  f.adapter.pinCommittedSave = async object => {
    pinnedSaveHandle = object.handle
    return { handle: 'derived-artifact-read', kind: 'file', displayName: object.displayName }
  }
  f.adapter.describe = async object => ({ isDirectory: false, size: object.handle === 'derived-artifact-read' ? saved.length : 0, lastModifiedMs: 1 })
  f.adapter.read = async object => object.handle === 'derived-artifact-read' ? Buffer.from(saved) : Buffer.from('synthetic')

  const payload = Buffer.from([0, 255, 7, 13])
  const receipt = await service.saveWithReference(42, save.grantId, payload)
  assert.equal(receipt.referenceState, 'available')
  if (receipt.referenceState !== 'available') throw new Error('expected verified artifact')
  assert.equal(pinnedSaveHandle, 'derived-native')
  assert.equal(receipt.status, 'committed')
  assert.deepEqual(saved, payload)
  assert.deepEqual(await service.read(42, receipt.reference.grantId), payload)
  await service.revoke(42, save.grantId)
  assert.deepEqual(await service.read(42, receipt.reference.grantId), payload)
  await service.revoke(42, receipt.reference.grantId)
  await assert.rejects(service.read(42, receipt.reference.grantId), { code: 'PERMISSION_DENIED' })
  await service.stop()
})

test('save authorization expiring during artifact verification releases the new pin and never returns an expired grant', async () => {
  const f = fixture()
  let now = 0, saved = Buffer.alloc(0)
  const service = new PathGrantService(f.adapter, () => now)
  const save = await service.create(42, '/private/output.txt', 'save', ['write'])
  f.adapter.save = async (_object, bytes) => { saved = Buffer.from(bytes); return { status: 'committed', bytesWritten: bytes.length } }
  f.adapter.pinCommittedSave = async object => ({ handle: 'expires-during-verify', kind: 'file', displayName: object.displayName })
  f.adapter.describe = async () => ({ isDirectory: false, size: saved.length, lastModifiedMs: 1 })
  f.adapter.read = async object => {
    if (object.handle === 'expires-during-verify') now = 3_600_000
    return Buffer.from(saved)
  }

  assert.deepEqual(await service.saveWithReference(42, save.grantId, Buffer.from('committed')), {
    status: 'committed', bytesWritten: 9, referenceState: 'unavailable', issues: [{ stage: 'reference', code: 'FILE_ERROR' }]
  })
  assert.ok(f.released.includes('expires-during-verify'), 'new read pin is released after source grant expires')
  await service.stop()
})

test('unconfirmed writes never create artifact references; a committed artifact mismatch is a distinct failure', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const save = await service.create(42, '/private/output.txt', 'save', ['write'])
  let pinAttempts = 0
  f.adapter.save = async () => { throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'unconfirmed') }
  f.adapter.pinCommittedSave = async object => { pinAttempts++; return { handle: 'artifact-file', kind: 'file', displayName: object.displayName } }
  await assert.rejects(service.saveWithReference(42, save.grantId, Buffer.from('x')), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(pinAttempts, 0)

  f.adapter.save = async (_object, data) => ({ status: 'committed', bytesWritten: data.length })
  f.adapter.describe = async () => ({ isDirectory: false, size: 99, lastModifiedMs: 1 })
  assert.deepEqual(await service.saveWithReference(42, save.grantId, Buffer.from('x')), {
    status: 'committed', bytesWritten: 1, referenceState: 'unavailable', issues: [{ stage: 'reference', code: 'FILE_ERROR' }]
  })
  assert.equal(pinAttempts, 1)
  await service.stop()
})

test('native selected grants are read-only and the returned native kind determines directory listing rights', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  f.adapter.pinSelected = async () => ({ handle: 'selected-file', kind: 'file', displayName: 'file' })
  const file = await service.createSelected(42, '/private/file'); assert.deepEqual(file.operations, ['read'])
  f.adapter.pinSelected = async () => ({ handle: 'selected-directory', kind: 'directory', displayName: 'folder' })
  const directory = await service.createSelected(42, '/private/directory'); assert.deepEqual(directory.operations, ['read', 'list'])
  assert.equal((await service.list(42, directory.grantId)).length, 1)
  await assert.rejects(service.deriveSave(42, directory.grantId, 'output'))
  await assert.rejects(service.createDirectory(42, directory.grantId, 'output')); await service.stop()
})

test('missing native selection port and illegal native save kind fail closed without retrying legacy pin', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  let pins = 0; f.adapter.pin = async () => { pins++; throw new Error('UNEXPECTED_LEGACY_PIN') }
  await assert.rejects(service.createSelected(42, '/private/file'), { code: 'NATIVE_HOST_UNAVAILABLE' }); assert.equal(pins, 0)
  f.adapter.pinSelected = async () => ({ handle: 'illegal-save', kind: 'save', displayName: 'output' })
  await assert.rejects(service.createSelected(42, '/private/output'), { code: 'PERMISSION_DENIED' })
  assert.deepEqual(f.released, ['illegal-save']); await service.stop()
})

test('pre-cancelled requests dispatch no native read, write, copy, move or directory operation', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter), controller = new AbortController()
  const file = await service.create(42, '/private/file', 'file', ['read'])
  const directory = await service.create(42, '/private/directory', 'directory', ['read', 'write', 'list'])
  const save = await service.create(42, '/private/output', 'save', ['write'])
  let nativeCalls = 0
  for (const method of ['read', 'readRange', 'list', 'save', 'streamSave', 'copy', 'remove', 'move', 'createDirectory', 'describe']) {
    Object.assign(f.adapter, { [method]: async () => { nativeCalls++; throw new Error('UNEXPECTED_NATIVE_DISPATCH') } })
  }
  controller.abort(); const signal = controller.signal
  async function* chunks() { nativeCalls++; yield Buffer.from('x') }
  for (const operation of [
    () => service.read(42, file.grantId, '', 1024, signal),
    () => service.readRange(42, file.grantId, '', 0, 1, signal),
    () => service.list(42, directory.grantId, '', signal),
    () => service.save(42, save.grantId, Buffer.from('x'), false, signal),
    () => service.streamSave(42, save.grantId, 1, chunks(), false, signal),
    () => service.copy(42, file.grantId, save.grantId, false, signal),
    () => service.remove(42, directory.grantId, 'child', false, signal),
    () => service.move(42, directory.grantId, 'child', save.grantId, false, signal),
    () => service.createDirectory(42, directory.grantId, 'child', signal),
    () => service.describe(42, file.grantId, signal)
  ]) await assert.rejects(operation(), { code: 'PERMISSION_DENIED' })
  assert.equal(nativeCalls, 0); await service.stop()
})

test('request signals reach native range operations and suppress late read results', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter), controller = new AbortController()
  const file = await service.create(42, '/private/file', 'file', ['read'])
  f.adapter.readRange = async (_, __, ___, ____, signal) => { controller.abort(); assert.equal(signal.aborted, true); return Buffer.from('x') }
  await assert.rejects(service.readRange(42, file.grantId, '', 0, 1, controller.signal), { code: 'PERMISSION_DENIED' })
  await service.stop()
})

test('request cancellation after a native write receipt preserves outcome uncertainty', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter), controller = new AbortController()
  const save = await service.create(42, '/private/output', 'save', ['write'])
  f.adapter.save = async (_, bytes, __, signal) => { controller.abort(); assert.equal(signal.aborted, true); return { status: 'committed', bytesWritten: bytes.length } }
  await assert.rejects(service.save(42, save.grantId, Buffer.from('x'), false, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await service.stop()
})

test('pre-cancelled creation does not pin; cancellation releases late native objects and derived references', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter), cancelled = new AbortController()
  cancelled.abort(); let pins = 0
  const originalPin = f.adapter.pin
  f.adapter.pin = async (...args) => { pins++; return originalPin(...args) }
  await assert.rejects(service.create(42, '/private/file', 'file', ['read'], cancelled.signal), { code: 'PERMISSION_DENIED' })
  assert.equal(pins, 0)
  const latePin = new AbortController()
  f.adapter.pin = async (_, kind, __, signal) => { latePin.abort(); assert.equal(signal.aborted, true); return { handle: 'late-pin', kind, displayName: 'file' } }
  await assert.rejects(service.create(42, '/private/file', 'file', ['read'], latePin.signal), { code: 'PERMISSION_DENIED' })
  assert.deepEqual(f.released, ['late-pin'])
  f.adapter.pin = originalPin
  const parent = await service.create(42, '/private/directory', 'directory', ['read'])
  const lateChild = new AbortController()
  f.adapter.deriveRead = async () => {
    queueMicrotask(() => queueMicrotask(() => lateChild.abort()))
    return { handle: 'late-registered-child', kind: 'file', displayName: 'child' }
  }
  await assert.rejects(service.deriveRead(42, parent.grantId, 'child', lateChild.signal), { code: 'PERMISSION_DENIED' })
  assert.equal(f.released.filter(handle => handle === 'late-registered-child').length, 1)
  await service.stop()
  assert.equal(f.released.filter(handle => handle === 'late-registered-child').length, 1)
})

test('opaque grant returns no native path/handle and enforces owner, scope, rights and expiration', async () => {
  const f = fixture(); let now = 1
  const service = new PathGrantService(f.adapter, () => now)
  const grant = await service.create(42, '/private/selected/path', 'file', ['read'])
  assert.equal(JSON.stringify(grant).includes('private'), false)
  assert.equal(JSON.stringify(grant).includes('native-only'), false)
  assert.match(grant.grantId, /^[A-Za-z0-9_-]{43}$/)
  assert.equal((await service.read(42, grant.grantId)).toString(), 'synthetic')
  await assert.rejects(service.read(99, grant.grantId))
  await assert.rejects(service.read(42, grant.grantId, 'child'))
  const save = await service.create(42, '/private/new', 'save', ['write'])
  await assert.rejects(service.read(42, save.grantId))
  now += 3_600_001
  await assert.rejects(service.read(42, grant.grantId))
  await service.stop()
  assert.equal(f.released.length, 2)
})

test('relative traversal, absolute paths, separators, ADS and excessive depth rejected', () => {
  assert.deepEqual(grantPathSegments('空 格/e\u0301.txt'), ['空 格', 'e\u0301.txt'])
  for (const value of ['/root', '..', 'a/../b', 'a//b', 'a\\b', 'C:x', 'a\0b', '.ztools-save-secret', 'child/.ZTOOLS-SAVE-secret', 'a/'.repeat(65)]) assert.throws(() => grantPathSegments(value, 'win32'))
  assert.deepEqual(grantPathSegments('colon:name/back\\slash/line\nbreak', 'darwin'), ['colon:name', 'back\\slash', 'line\nbreak'])
  for (const value of ['/root', '..', 'a/../b', 'a//b', 'a\0b', '.ztools-save-secret', 'child/.ZTOOLS-SAVE-secret']) assert.throws(() => grantPathSegments(value, 'darwin'))
})

test('Mac grants preserve literal POSIX basenames, while NUL and path separators remain denied', async () => {
  const f = fixture()
  Object.assign(f.adapter, { platform: 'darwin' })
  f.adapter.pin = async (_, kind) => ({ handle: 'native', kind, displayName: 'colon:back\\slash\nname' })
  const service = new PathGrantService(f.adapter)
  const grant = await service.create(42, '/trusted', 'file', ['read'])
  assert.equal(grant.displayName, 'colon:back\\slash\nname')
  await service.stop()
})

test('bounded range reads enforce owner, rights, scope and safe integer limits', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const grant = await service.create(42, '/fixture', 'file', ['read'])
  assert.equal((await service.readRange(42, grant.grantId, '', 1, 3)).toString(), 'ynt')
  assert.equal((await service.readRange(42, grant.grantId, '', 99, 3)).length, 0)
  await assert.rejects(service.readRange(99, grant.grantId, '', 0, 1))
  for (const [offset, length] of [[-1, 1], [0.5, 1], [0, -1], [0, 16 * 1024 * 1024 + 1], [Number.MAX_SAFE_INTEGER, 1]]) {
    await assert.rejects(service.readRange(42, grant.grantId, '', offset!, length!))
  }
  await assert.rejects(service.readRange(42, grant.grantId, 'child', 0, 1))
  const folder = await service.create(42, '/fixture', 'directory', ['list'])
  await assert.rejects(service.readRange(42, folder.grantId, 'file', 0, 1))
  f.adapter.readRange = async () => Buffer.from('oversized')
  await assert.rejects(service.readRange(42, grant.grantId, '', 0, 1))
  await service.stop()
})

test('listing rights are independent from reading rights and bound to the owning directory grant', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const grant = await service.create(42, '/fixture', 'directory', ['list'])
  assert.deepEqual(await service.list(42, grant.grantId), [{ name: 'fixture.txt', size: 9, isDirectory: false }])
  await assert.rejects(service.read(42, grant.grantId, 'fixture.txt'))
  await assert.rejects(service.list(99, grant.grantId))
  await assert.rejects(service.list(42, grant.grantId, '../outside'))
  await service.stop()
})

test('save snapshots input, binds write-only owner and rejects unconfirmed commit after revoke', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const grant = await service.create(42, '/fixture/output', 'save', ['write'])
  const input = Buffer.from('original')
  f.adapter.save = async (_, data, replace) => {
    assert.equal(data.toString(), 'original'); assert.equal(replace, false)
    return { status: 'committed', bytesWritten: data.length }
  }
  const saving = service.save(42, grant.grantId, input); input.fill(0)
  assert.deepEqual(await saving, { status: 'committed', bytesWritten: 8 })
  await assert.rejects(service.save(99, grant.grantId, Buffer.from('x')))
  await assert.rejects(service.read(42, grant.grantId))
  let finish!: () => void
  f.adapter.save = async () => new Promise(resolve => { finish = () => resolve({ status: 'committed', bytesWritten: 1 }) })
  const pending = service.save(42, grant.grantId, Buffer.from('x'), true)
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, grant.grantId)
  finish(); await rejected; await closing; await service.stop()
})

test('save concurrency is bounded before allocating queued snapshots and recovers after completion', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const grant = await service.create(42, '/fixture', 'save', ['write']), finish: (() => void)[] = []
  f.adapter.save = async (_, data) => new Promise(resolve => { finish.push(() => resolve({ status: 'committed', bytesWritten: data.length })) })
  const pending = Array.from({ length: 16 }, () => service.save(42, grant.grantId, Buffer.alloc(0)))
  await assert.rejects(service.save(42, grant.grantId, Buffer.alloc(0)))
  await new Promise(resolve => setImmediate(resolve)); finish.forEach(done => done()); await Promise.all(pending)
  f.adapter.save = async (_, data) => ({ status: 'committed', bytesWritten: data.length })
  assert.deepEqual(await service.save(42, grant.grantId, Buffer.from('x')), { status: 'committed', bytesWritten: 1 })
  await service.stop()
})

test('derived save grants inherit owner, deadline and parent revocation without exposing paths', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const parent = await service.create(42, '/fixture', 'directory', ['write'])
  const child = await service.deriveSave(42, parent.grantId, 'nested/output.txt')
  assert.deepEqual(child.operations, ['write']); assert.equal(child.kind, 'save'); assert.equal(child.displayName, 'output.txt')
  assert.equal(JSON.stringify(child).includes('derived-native'), false)
  await assert.rejects(service.deriveSave(99, parent.grantId, 'output.txt'))
  await assert.rejects(service.deriveSave(42, parent.grantId, '../outside'))
  await assert.rejects(service.read(42, child.grantId))
  assert.equal((await service.save(42, child.grantId, Buffer.from('x'))).status, 'committed')
  await service.revoke(42, parent.grantId)
  await assert.rejects(service.save(42, child.grantId, Buffer.from('x')))
  assert.deepEqual(f.released, ['derived-native', 'native-only-handle']); await service.stop()
})

test('revoking a directory during derivation releases late native child and never activates its grant', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const parent = await service.create(42, '/fixture', 'directory', ['write'])
  let finish!: () => void
  f.adapter.deriveSave = async (_, parts) => new Promise(resolve => { finish = () => resolve({ handle: 'late-child', kind: 'save', displayName: parts.at(-1)! }) })
  const pending = service.deriveSave(42, parent.grantId, 'output.txt'), rejected = assert.rejects(pending)
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, parent.grantId)
  finish(); await rejected; await closing
  assert.deepEqual(f.released, ['late-child', 'native-only-handle']); await service.stop()
})

test('derived grants cannot extend parent expiry and report failed child release during parent close', async () => {
  const f = fixture(); let now = 0
  const service = new PathGrantService(f.adapter, () => now)
  const parent = await service.create(42, '/fixture', 'directory', ['write'])
  now = 3_599_000
  const child = await service.deriveSave(42, parent.grantId, 'output.txt')
  now = 3_600_001
  await assert.rejects(service.save(42, child.grantId, Buffer.from('x')))
  await service.stop()
  const g = fixture(), broken = new PathGrantService(g.adapter)
  const root = await broken.create(42, '/fixture', 'directory', ['write'])
  await broken.deriveSave(42, root.grantId, 'output.txt')
  g.adapter.release = async object => { if (object.handle === 'derived-native') throw new Error('release failed') }
  await assert.rejects(broken.revoke(42, root.grantId)); await assert.rejects(broken.stop())
})

test('directory descendants preserve only parent rights and inherit hierarchical revocation', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const parent = await service.create(42, '/trusted', 'directory', ['list'])
  const child = await service.deriveDirectory(42, parent.grantId, 'nested')
  assert.equal(child.kind, 'directory'); assert.deepEqual(child.operations, ['list'])
  await assert.rejects(service.read(42, child.grantId, 'file.txt'))
  await assert.rejects(service.deriveSave(42, child.grantId, 'output.txt'))
  await assert.rejects(service.deriveDirectory(99, parent.grantId, 'nested'))
  await assert.rejects(service.deriveDirectory(42, parent.grantId, ''))
  const grandchild = await service.deriveDirectory(42, child.grantId, 'deeper')
  await service.revoke(42, parent.grantId)
  await assert.rejects(service.list(42, grandchild.grantId))
  assert.equal(f.released.length, 3)
  await service.stop()
})

test('read descendants enforce directory read permission and metadata never exposes native paths', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const parent = await service.create(42, '/fixture', 'directory', ['read'])
  const child = await service.deriveRead(42, parent.grantId, 'nested/input.bin')
  assert.deepEqual(child.operations, ['read']); assert.equal(child.kind, 'file')
  assert.deepEqual(await service.describe(42, child.grantId), { isDirectory: false, size: 9, lastModifiedMs: 1000 })
  await assert.rejects(service.describe(99, child.grantId))
  await assert.rejects(service.save(42, child.grantId, Buffer.from('x')))
  const listOnly = await service.create(42, '/fixture', 'directory', ['list'])
  await assert.rejects(service.deriveRead(42, listOnly.grantId, 'input.bin'))
  await assert.rejects(service.describe(42, listOnly.grantId))
  await service.revoke(42, parent.grantId); await assert.rejects(service.describe(42, child.grantId)); await service.stop()
})

test('trusted owner removal automatically revokes descendants and detaches its listener on stop', async () => {
  const f = fixture(), active = new Set([42]); let removed!: (owner: number) => void, detached = 0
  const service = new PathGrantService(f.adapter, Date.now, 5000, {
    isActive: owner => active.has(owner),
    onRemoved: listener => { removed = listener; return () => { detached++ } }
  })
  await assert.rejects(service.create(99, '/fixture', 'file', ['read']))
  const root = await service.create(42, '/fixture', 'directory', ['read'])
  const child = await service.deriveRead(42, root.grantId, 'input.bin')
  active.delete(42); removed(42)
  await assert.rejects(service.read(42, child.grantId))
  await service.stop(); assert.equal(detached, 1)
  assert.equal(f.released.length, 2)
})

test('stream save enforces owner, size, global concurrency and late commit uncertainty', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const output = await service.create(42, '/output', 'save', ['write'])
  async function* chunks() { yield Buffer.from('stream') }
  assert.deepEqual(await service.streamSave(42, output.grantId, 6, chunks()), { status: 'committed', bytesWritten: 6 })
  await assert.rejects(service.streamSave(99, output.grantId, 6, chunks()))
  await assert.rejects(service.streamSave(42, output.grantId, 2 * 1024 * 1024 * 1024 + 1, chunks()))
  const finishes: (() => void)[] = []
  f.adapter.streamSave = async (_, expected) => new Promise(resolve => { finishes.push(() => resolve({ status: 'committed', bytesWritten: expected ?? 0 })) })
  const pending = Array.from({ length: 8 }, () => service.streamSave(42, output.grantId, 6, chunks()))
  await assert.rejects(service.streamSave(42, output.grantId, 6, chunks()))
  await new Promise(resolve => setImmediate(resolve)); finishes.forEach(finish => finish()); await Promise.all(pending)
  let finish!: () => void
  f.adapter.streamSave = async () => new Promise(resolve => { finish = () => resolve({ status: 'committed', bytesWritten: 6 }) })
  const late = service.streamSave(42, output.grantId, 6, chunks()), rejected = assert.rejects(late, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, output.grantId)
  finish(); await rejected; await closing; await service.stop()
})

test('copy binds both rights to one owner and cancelling either grant suppresses a late commit result', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const source = await service.create(42, '/source', 'file', ['read']), destination = await service.create(42, '/destination', 'save', ['write'])
  assert.deepEqual(await service.copy(42, source.grantId, destination.grantId), { status: 'committed', bytesWritten: 9 })
  await assert.rejects(service.copy(99, source.grantId, destination.grantId))
  await assert.rejects(service.copy(42, destination.grantId, source.grantId))
  let finish!: () => void, signal!: AbortSignal
  f.adapter.copy = async (_, __, ___, abort) => { signal = abort; return new Promise(resolve => { finish = () => resolve({ status: 'committed', bytesWritten: 9 }) }) }
  const pending = service.copy(42, source.grantId, destination.grantId, true), rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, source.grantId)
  assert.equal(signal.aborted, true); finish(); await rejected; await closing; await service.stop()
})

test('remove requires writable directory scope and reports unknown outcome for a late committed removal', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const directory = await service.create(42, '/fixture', 'directory', ['write'])
  const file = await service.create(42, '/file', 'file', ['read'])
  assert.deepEqual(await service.remove(42, directory.grantId, 'child'), { status: 'committed' })
  await assert.rejects(service.remove(99, directory.grantId, 'child'))
  await assert.rejects(service.remove(42, file.grantId, 'child'))
  await assert.rejects(service.remove(42, directory.grantId, ''))
  await assert.rejects(service.remove(42, directory.grantId, '../outside'))
  let finish!: () => void, signal!: AbortSignal
  f.adapter.remove = async (_, segments, isDirectory, abort) => {
    assert.deepEqual(segments, ['empty']); assert.equal(isDirectory, true); signal = abort
    return new Promise(resolve => { finish = () => resolve({ status: 'committed' }) })
  }
  const pending = service.remove(42, directory.grantId, 'empty', true)
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, directory.grantId)
  assert.equal(signal.aborted, true); finish(); await rejected; await closing; await service.stop()
})

test('move binds source directory write and destination save rights and cancels when either owner grant closes', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const directory = await service.create(42, '/fixture', 'directory', ['write'])
  const destination = await service.create(42, '/output', 'save', ['write'])
  assert.deepEqual(await service.move(42, directory.grantId, 'input', destination.grantId), { status: 'committed' })
  await assert.rejects(service.move(99, directory.grantId, 'input', destination.grantId))
  await assert.rejects(service.move(42, destination.grantId, 'input', directory.grantId))
  await assert.rejects(service.move(42, directory.grantId, '', destination.grantId))
  let finish!: () => void, signal!: AbortSignal
  f.adapter.move = async (_, segments, __, replace, abort) => {
    assert.deepEqual(segments, ['input']); assert.equal(replace, true); signal = abort
    return new Promise(resolve => { finish = () => resolve({ status: 'committed' }) })
  }
  const pending = service.move(42, directory.grantId, 'input', destination.grantId, true)
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, destination.grantId)
  assert.equal(signal.aborted, true); finish(); await rejected; await closing; await service.stop()
})

test('resource URL ownership, exact spelling, lease limits, abort and revocation stay bound to read FileRefs', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const file = await service.create(42, '/fixture', 'file', ['read'])
  const url = service.resourceUrl(42, file.grantId)
  assert.equal(service.canLoadResource(url, 42), true); assert.equal(service.canLoadResource(url, 99), false)
  for (const bad of [url + '?x', url + '#x', url + '/child', url.replace('file/', 'file:123/'), url.replace('/%E7', '/%e7')]) {
    assert.equal(service.canLoadResource(bad, 42), false)
    await assert.rejects(service.openResource(bad, new AbortController().signal))
  }
  const directory = await service.create(42, '/directory', 'directory', ['read'])
  assert.throws(() => service.resourceUrl(42, directory.grantId))
  const leases = await Promise.all(Array.from({ length: 8 }, () => service.openResource(url, new AbortController().signal)))
  await assert.rejects(service.openResource(url, new AbortController().signal))
  leases[0]!.close(); leases[0]!.close()
  const controller = new AbortController(), ninth = await service.openResource(url, controller.signal)
  controller.abort(); assert.equal(ninth.signal.aborted, true); await assert.rejects(ninth.read(0, 1))
  const replacement = await service.openResource(url, new AbortController().signal)
  await service.revoke(42, file.grantId)
  assert.equal(replacement.signal.aborted, true); assert.equal(leases[1]!.signal.aborted, true)
  assert.equal(service.canLoadResource(url, 42), false)
  await service.stop()
})

test('owner providers isolate cancellation and shutdown while keeping another owner readable', async () => {
  const first = fixture(), second = fixture(); let created = 0, firstStopped = 0, secondStopped = 0
  first.adapter.stop = async () => { firstStopped++ }; second.adapter.stop = async () => { secondStopped++ }
  const provider = new OwnedPathAccessProvider('win32', () => ++created === 1 ? first.adapter : second.adapter)
  const service = new PathGrantService(provider)
  const a = await service.create(42, '/first', 'file', ['read']), b = await service.create(99, '/second', 'file', ['read'])
  first.adapter.read = async (_, __, ___, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  const reading = service.read(42, a.grantId), rejected = assert.rejects(reading)
  await new Promise(resolve => setImmediate(resolve)); await service.closeOwner(42); await rejected
  assert.equal(firstStopped, 1); assert.equal(secondStopped, 0)
  assert.equal((await service.read(99, b.grantId)).toString(), 'synthetic')
  await assert.rejects(service.create(42, '/closed', 'file', ['read']))
  await service.stop(); assert.equal(firstStopped, 1); assert.equal(secondStopped, 1)
})

test('owner provider bounds native generations and propagates failed cleanup across repeated stop', async () => {
  const f = fixture(), provider = new OwnedPathAccessProvider('win32', () => f.adapter)
  for (let owner = 1; owner <= 32; owner++) provider.forOwner(owner)
  assert.throws(() => provider.forOwner(33)); assert.throws(() => provider.forOwner(0))
  await provider.closeOwner(1); assert.throws(() => provider.forOwner(1))
  provider.forOwner(33)
  f.adapter.stop = async () => { throw new Error('stop unconfirmed') }
  await assert.rejects(provider.closeOwner(2)); await assert.rejects(provider.stop()); await assert.rejects(provider.stop())
})

test('directory creation requires write scope and preserves created/existing status with uncertain late results', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  const directory = await service.create(42, '/directory', 'directory', ['write'])
  const file = await service.create(42, '/file', 'file', ['read'])
  assert.deepEqual(await service.createDirectory(42, directory.grantId, 'new'), { status: 'created' })
  f.adapter.createDirectory = async () => ({ status: 'existing' })
  assert.deepEqual(await service.createDirectory(42, directory.grantId, 'new'), { status: 'existing' })
  await assert.rejects(service.createDirectory(99, directory.grantId, 'new'))
  await assert.rejects(service.createDirectory(42, file.grantId, 'new'))
  await assert.rejects(service.createDirectory(42, directory.grantId, ''))
  await assert.rejects(service.createDirectory(42, directory.grantId, '../outside'))
  let finish!: () => void
  f.adapter.createDirectory = async () => new Promise(resolve => { finish = () => resolve({ status: 'created' }) })
  const late = service.createDirectory(42, directory.grantId, 'late'), rejected = assert.rejects(late, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); const closing = service.revoke(42, directory.grantId)
  finish(); await rejected; await closing; await service.stop()
})

test('revocation cancels in-flight read before release and suppresses its late result', async () => {
  const f = fixture(); let finish!: () => void, signal!: AbortSignal
  f.adapter.read = (_, __, ___, abort) => { signal = abort; return new Promise(resolve => { finish = () => resolve(Buffer.from('late')) }) }
  const service = new PathGrantService(f.adapter), grant = await service.create(42, '/fixture', 'file', ['read'])
  const pending = service.read(42, grant.grantId)
  await new Promise(resolve => setImmediate(resolve))
  const closing = service.revoke(42, grant.grantId)
  assert.equal(signal.aborted, true); assert.equal(f.released.length, 0)
  finish(); await assert.rejects(pending); await closing
  assert.equal(f.released.length, 1)
  await assert.rejects(service.read(42, grant.grantId)); await service.stop()
})

test('owner closes during pin: cancels creation, releases late object, never activates grant', async () => {
  const f = fixture(); let finish!: () => void, signal!: AbortSignal
  f.adapter.pin = (_, kind, __, abort) => { signal = abort; return new Promise(resolve => { finish = () => resolve({ handle: 'late', kind, displayName: 'fixture' }) }) }
  const service = new PathGrantService(f.adapter), pending = service.create(42, '/fixture', 'file', ['read'])
  const rejected = assert.rejects(pending), closing = service.closeOwner(42)
  assert.equal(signal.aborted, true); finish(); await rejected; await closing
  assert.deepEqual(f.released, ['late']); await assert.rejects(service.create(42, '/fixture', 'file', ['read']))
})

test('noncooperating native read yields bounded incomplete cleanup without freeing a live handle', async () => {
  const f = fixture(); f.adapter.read = () => new Promise(() => {})
  const service = new PathGrantService(f.adapter, Date.now, 10), grant = await service.create(42, '/fixture', 'file', ['read'])
  void service.read(42, grant.grantId).catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(service.revoke(42, grant.grantId)); assert.equal(f.released.length, 0)
  await assert.rejects(service.stop()); await assert.rejects(service.read(42, grant.grantId))
})

test('a late pin release failure is observable when its owner closes', async () => {
  const f = fixture(); let finish!: () => void
  f.adapter.pin = (_, kind) => new Promise(resolve => { finish = () => resolve({ handle: 'late', kind, displayName: 'fixture' }) })
  f.adapter.release = async () => { throw new Error('native release failed') }
  const service = new PathGrantService(f.adapter), pending = service.create(42, '/fixture', 'file', ['read'])
  const rejected = assert.rejects(pending), closing = assert.rejects(service.closeOwner(42))
  finish(); await rejected; await closing
})

test('stop cancels pin creation and cleanly releases its late object exactly once', async () => {
  const f = fixture(); let finish!: () => void
  f.adapter.pin = (_, kind) => new Promise(resolve => { finish = () => resolve({ handle: 'late', kind, displayName: 'fixture' }) })
  const service = new PathGrantService(f.adapter), pending = service.create(42, '/fixture', 'file', ['read'])
  const rejected = assert.rejects(pending), stopping = service.stop()
  assert.equal(stopping, service.stop()); finish(); await rejected; await stopping
  assert.deepEqual(f.released, ['late'])
})

test('resource provenance cannot authorize save refs or an alias URL and disappears on revoke', async () => {
  const f = fixture(), service = new PathGrantService(f.adapter)
  try {
    const file = await service.create(42, '/private/selected', 'file', ['read'])
    const url = service.resourceUrl(42, file.grantId)
    assert.equal(service.ownsResourceUrl(url), true)
    assert.equal(service.ownsResourceUrl(url + '?owner=99'), false)
    assert.equal(service.ownsResourceUrl(url + '#fragment'), false)
    assert.equal(service.ownsResourceUrl(url.slice(0, url.lastIndexOf('/') + 1) + 'alias.txt'), false)
    assert.equal(service.canLoadResource(url, 99), false)
    const save = await service.create(42, '/private/output', 'save', ['write'])
    const saveUrl = 'ztools://file/' + save.grantId + '/' + encodeURIComponent(save.displayName)
    assert.equal(service.ownsResourceUrl(saveUrl), true)
    assert.equal(service.canLoadResource(saveUrl, 42), false)
    await service.revoke(42, file.grantId)
    assert.equal(service.ownsResourceUrl(url), false)
  } finally { await service.stop() }
})
