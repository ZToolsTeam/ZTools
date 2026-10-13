import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { PathAccessAdapter } from '../../src/main/platform/path-access.js'
import { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { AnchoredFileSystemService } from '../../src/main/services/anchored-file-system-service.js'
import { ReferenceRequestTracker } from '../../src/main/services/reference-request-tracker.js'
import { isConfirmedReferenceWriteReceipt } from '../../src/contracts/path-reference.js'

function fixture() {
  let saved = Buffer.alloc(0), writes = 0, releases = 0
  const unsupported = async (): Promise<never> => { throw new Error('unused fixture capability') }
  const adapter: PathAccessAdapter = {
    platform: 'win32', pin: async (_, kind) => ({ handle: 'save', kind, displayName: 'output.txt' }),
    save: async (_, bytes) => { saved = Buffer.from(bytes); writes++; return { status: 'committed', bytesWritten: bytes.length } },
    pinCommittedSave: async () => ({ handle: 'artifact', kind: 'file', displayName: 'output.txt' }),
    describe: async () => ({ size: saved.length, isDirectory: false, lastModifiedMs: 1 }),
    read: async () => Buffer.from(saved), release: async () => { releases++ }, stop: async () => {},
    pinSelected: unsupported, readRange: unsupported, streamSave: unsupported, deriveRead: unsupported,
    deriveSave: unsupported, deriveDirectory: unsupported, copy: unsupported, list: unsupported,
    createDirectory: unsupported, remove: unsupported, move: unsupported
  }
  return { adapter, bytes: () => saved, counts: () => ({ writes, releases }) }
}

for (const cleanupFails of [false, true]) test(`postcommit URL failure preserves ACK and independent cleanup issue: ${cleanupFails}`, async context => {
  const f = fixture(), grants = new PathGrantService(f.adapter), files = new AnchoredFileSystemService(grants)
  const save = await grants.create(42, 'C:/private/output.txt', 'save', ['write'])
  const revoke = grants.revoke.bind(grants)
  grants.resourceUrl = () => { throw new ZToolsError(errorCodes.permissionDenied, 'private output path must stay hidden') }
  grants.revoke = async (...args) => { await revoke(...args); if (cleanupFails) throw new Error('private cleanup detail') }
  context.after(async () => { await grants.stop().catch(() => {}) })
  const result = await files.writeFile({ saveGrantId: save.grantId, content: 'saved', encoding: 'utf8' }, { type: 'main', webContentsId: 42 })
  assert.deepEqual(result, { success: true, status: 'committed-reference-unavailable', size: 5,
    issues: [{ stage: 'reference', code: 'PERMISSION_DENIED' }, ...(cleanupFails ? [{ stage: 'release', code: 'FILE_ERROR' }] : [])] })
  assert.equal(f.bytes().toString(), 'saved'); assert.equal(f.counts().writes, 1)
  assert.doesNotMatch(JSON.stringify(result), /grantId|fileUrl|private|operations|"reference":/)
})

for (const phase of ['pin', 'expiry', 'cancel', 'release'] as const) test(`trusted ACK survives artifact ${phase} failure`, async context => {
  const f = fixture(); let now = 0
  const grants = new PathGrantService(f.adapter, () => now, 25), controller = new AbortController()
  const save = await grants.create(42, 'C:/private/output.txt', 'save', ['write'])
  if (phase === 'pin') f.adapter.pinCommittedSave = async () => { throw new Error('pin failed') }
  if (phase === 'expiry') f.adapter.read = async () => { now = 3_600_000; return f.bytes() }
  if (phase === 'cancel') {
    const nativeSave = f.adapter.save
    f.adapter.save = async (...args) => { const ack = await nativeSave(...args); controller.abort(); return ack }
  }
  if (phase === 'release') {
    f.adapter.describe = async () => ({ size: 99, isDirectory: false, lastModifiedMs: 1 })
    f.adapter.release = async object => { if (object.handle === 'artifact') throw new Error('release failed') }
  }
  context.after(async () => { await grants.stop().catch(() => {}) })
  const result: any = await grants.saveWithReference(42, save.grantId, Buffer.from('saved'), false, controller.signal)
  assert.equal(result.status, 'committed'); assert.equal(result.bytesWritten, 5)
  assert.equal(result.referenceState, 'unavailable'); assert.equal(Object.hasOwn(result, 'reference'), false)
  if (phase === 'release') assert.ok(result.issues.some((issue: any) => issue.stage === 'release' && issue.code === 'FILE_ERROR'))
  assert.equal(f.counts().writes, 1); assert.equal(f.bytes().toString(), 'saved')
})

for (const cleanupFails of [false, true]) test(`cancelled request retains only known commit fact, cleanup=${cleanupFails}`, async context => {
  const tracker = new ReferenceRequestTracker({ isActive: () => true, onRemoved: () => () => {} }, 100)
  let finish!: () => void, disposed = 0
  const gate = new Promise<void>(resolve => { finish = resolve })
  const reference = { grantId: 'a'.repeat(43), kind: 'file', displayName: 'out.txt', operations: ['read'], fileUrl: `ztools://file/${'a'.repeat(43)}/out.txt` }
  const pending = tracker.execute(42, 'filesystem_write_file', 'known-commit', async () => {
    await gate; return { success: true, status: 'committed', size: 5, reference }
  }, 1000, async () => { disposed++; if (cleanupFails) throw new Error('private release error') })
  context.after(async () => { await tracker.stop().catch(() => {}) })
  await Promise.resolve(); tracker.cancel(42, 'filesystem_write_file', 'known-commit'); finish()
  assert.deepEqual(await pending, { success: true, status: 'committed-reference-unavailable', size: 5,
    issues: [{ stage: 'reference', code: 'PERMISSION_DENIED' }, ...(cleanupFails ? [{ stage: 'release', code: 'FILE_ERROR' }] : [])] })
  assert.equal(disposed, 1)
})

test('postcommit exact guard rejects getters, hidden fields, invalid issues and arbitrary successes', () => {
  const receipt = () => ({ success: true, status: 'committed-reference-unavailable', size: 5,
    issues: [{ stage: 'release', code: 'FILE_ERROR' }] })
  assert.equal(isConfirmedReferenceWriteReceipt(receipt()), true)
  assert.equal(isConfirmedReferenceWriteReceipt(Object.assign(Object.create(null), receipt())), true)
  let reads = 0
  const getter = receipt(); Object.defineProperty(getter, 'size', { enumerable: true, get: () => { reads++; return 5 } })
  const hidden = receipt(); Object.defineProperty(hidden, 'privatePath', { value: 'private' })
  const symbol = receipt(); Object.defineProperty(symbol, Symbol('extra'), { value: true })
  const hiddenIssue = receipt(); Object.defineProperty(hiddenIssue.issues[0]!, 'code', { enumerable: false, value: 'FILE_ERROR' })
  for (const value of [getter, hidden, symbol, hiddenIssue, { success: true },
    { ...receipt(), size: -1 }, { ...receipt(), size: 16 * 1024 * 1024 + 1 },
    { ...receipt(), reference: {} }, { ...receipt(), issues: [] },
    { ...receipt(), issues: [{ stage: 'release', code: 'PERMISSION_DENIED' }] },
    { ...receipt(), issues: [{ stage: 'release', code: 'FILE_ERROR' }, { stage: 'reference', code: 'FILE_ERROR' }] },
    { ...receipt(), issues: [{ stage: 'reference', code: 'FILE_ERROR' }, { stage: 'reference', code: 'FILE_ERROR' }] }]) {
    assert.equal(isConfirmedReferenceWriteReceipt(value), false)
  }
  assert.equal(reads, 0, 'guard must not execute an accessor')
})

for (const method of ['save', 'streamSave', 'copy'] as const) test(`postcommit cleanup failure is explicit for direct ${method} consumers`, async context => {
  const f = fixture(), grants = new PathGrantService(f.adapter)
  context.after(async () => { await grants.stop().catch(() => {}) })
  const save = await grants.create(42, 'C:/private/output.txt', 'save', ['write'])
  const cleanup = { status: 'committed' as const, bytesWritten: 5,
    cleanupIssues: [{ stage: 'release' as const, code: errorCodes.fileError }] }
  let calls = 0, pinAttempts = 0
  f.adapter.pinCommittedSave = async () => { pinAttempts++; throw new Error('must not create reference') }
  f.adapter.save = async () => { calls++; return cleanup }
  f.adapter.streamSave = async () => { calls++; return cleanup }
  f.adapter.copy = async () => { calls++; return cleanup }
  let result: Promise<unknown>
  if (method === 'save') result = grants.save(42, save.grantId, Buffer.from('saved'))
  else if (method === 'streamSave') {
    async function* chunks() { yield Buffer.from('saved') }
    result = grants.streamSave(42, save.grantId, 5, chunks())
  } else {
    const source = await grants.create(42, 'C:/private/input.txt', 'file', ['read'])
    result = grants.copy(42, source.grantId, save.grantId)
  }
  await assert.rejects(result, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(calls, 1); assert.equal(pinAttempts, 0)
})

test('trusted journal cleanup metadata keeps commit facts without attempting any usable reference', async context => {
  const f = fixture(), grants = new PathGrantService(f.adapter), files = new AnchoredFileSystemService(grants)
  context.after(async () => { await grants.stop().catch(() => {}) })
  const save = await grants.create(42, 'C:/private/output.txt', 'save', ['write'])
  f.adapter.save = async () => ({ status: 'committed', bytesWritten: 5,
    cleanupIssues: [{ stage: 'release', code: errorCodes.fileError }] })
  f.adapter.pinCommittedSave = async () => { throw new Error('must not create reference') }
  assert.deepEqual(await files.writeFile({ saveGrantId: save.grantId, content: 'saved' }, { type: 'main', webContentsId: 42 }), {
    success: true, status: 'committed-reference-unavailable', size: 5, issues: [{ stage: 'release', code: 'FILE_ERROR' }]
  })
})

for (const result of [{ success: true }, new Error('arbitrary failure')]) test(`cancel never upgrades an unconfirmed ${result instanceof Error ? 'error' : 'success'}`, async context => {
  const tracker = new ReferenceRequestTracker({ isActive: () => true, onRemoved: () => () => {} }, 100)
  context.after(async () => { await tracker.stop().catch(() => {}) })
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const pending = tracker.execute(42, 'filesystem_write_file', 'unconfirmed', async () => {
    await gate; if (result instanceof Error) throw result; return result
  }, 1000, async () => {})
  await Promise.resolve(); tracker.cancel(42, 'filesystem_write_file', 'unconfirmed'); finish()
  await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})

test('postcommit receipt arriving after cleanup deadline only disposes reference and never replaces unknown', async context => {
  const tracker = new ReferenceRequestTracker({ isActive: () => true, onRemoved: () => () => {} }, 10)
  context.after(async () => { await tracker.stop().catch(() => {}) })
  let finish!: () => void, disposed!: () => void, settlements = 0
  const gate = new Promise<void>(resolve => { finish = resolve })
  const cleanup = new Promise<void>(resolve => { disposed = resolve })
  const pending = tracker.execute(42, 'filesystem_write_file', 'late-commit', async () => {
    await gate; return { success: true, status: 'committed', size: 5, reference: {
      grantId: 'a'.repeat(43), kind: 'file', displayName: 'out.txt', operations: ['read'],
      fileUrl: `ztools://file/${'a'.repeat(43)}/out.txt` } }
  }, 1000, async () => { disposed() })
  void pending.then(() => { settlements++ }, () => { settlements++ })
  await Promise.resolve(); tracker.cancel(42, 'filesystem_write_file', 'late-commit')
  await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(settlements, 1)
  finish(); await cleanup; await tracker.stop()
  assert.equal(settlements, 1, 'late positive facts cannot resolve an already finished public call twice')
})
