import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { PathWriteJournal } from '../../src/main/platform/path-write-journal.js'
import { PathWriteRecoveryService, type RecoveryAdapter } from '../../src/main/services/path-write-recovery-service.js'

const caller: CallerIdentity = { type: 'main', webContentsId: 42 }
const proof = Buffer.from('ZPW1\x01\x01synthetic proof', 'binary')
async function fixture() {
  let bytes: Buffer | undefined, pins = 0, releases = 0, stops = 0
  const journal = new PathWriteJournal({ read: async () => bytes, replace: async value => { bytes = Buffer.from(value) } },
    { seal: async text => Buffer.from(text), open: async value => value.toString() })
  const id = await journal.reserve('win32', 'E:\\synthetic\\private\\output.txt', 3)
  const adapter: RecoveryAdapter = {
    platform: 'win32', pin: async (selectedPath, kind, rights) => {
      assert.equal(selectedPath, 'E:\\synthetic\\private\\output.txt'); assert.equal(kind, 'save'); assert.deepEqual(rights, ['write'])
      pins++; return { kind, handle: 'private-native-handle', displayName: 'output.txt' }
    }, observeWrite: async (_, observedProof) => { assert.deepEqual(observedProof, proof); return { state: 'staging', size: 3 } },
    release: async () => { releases++ }, stop: async () => { stops++ }
  }
  return { journal, id, adapter, service: new PathWriteRecoveryService(journal, adapter), pins: () => pins, releases: () => releases, stops: () => stops }
}

test('recovery lists safe main-only metadata and an intent never opens a filesystem object', async () => {
  const f = await fixture(), result = await f.service.list(caller)
  assert.deepEqual(Object.keys(result[0]!).sort(), ['createdAt', 'displayName', 'expectedBytes', 'phase', 'recoveryId'])
  assert.equal(result[0]!.displayName, 'output.txt'); assert.ok(!JSON.stringify(result).includes('private'))
  assert.equal((await f.service.inspect(f.id, caller)).observation.state, 'unresolved'); assert.equal(f.pins(), 0)
  assert.equal((await f.journal.pending())[0]!.phase, 'intent')
})

test('object matching never promotes a write to business success, removes evidence or exposes adapter fields', async () => {
  const f = await fixture(); await f.journal.staged(f.id, proof)
  for (const state of ['staging', 'committed-object', 'unresolved'] as const) {
    f.adapter.observeWrite = async () => ({ state, size: 3, selectedPath: '/private', proof: 'secret' })
    const result = await f.service.inspect(f.id, caller)
    assert.deepEqual(result.observation, { state, size: 3 }); assert.equal(result.businessResult, 'unconfirmed')
    assert.ok(!JSON.stringify(result).includes('secret')); assert.equal((await f.journal.pending()).length, 1)
  }
  assert.equal(f.pins(), 3); assert.equal(f.releases(), 3)
})

test('plugin, invalid owner, forged IDs and unsupported journal platform are rejected before native pin', async () => {
  const f = await fixture()
  for (const identity of [{ type: 'plugin', webContentsId: 42 }, { type: 'main', webContentsId: 0 }] as CallerIdentity[]) {
    await assert.rejects(f.service.list(identity), { code: 'PERMISSION_DENIED' })
    await assert.rejects(f.service.inspect(f.id, identity), { code: 'PERMISSION_DENIED' })
  }
  for (const id of ['/private/raw/path', '', { recoveryId: f.id }, '00000000-0000-4000-8000-000000000000']) await assert.rejects(f.service.inspect(id, caller), { code: 'FILE_ERROR' })
  const wrong = new PathWriteRecoveryService(f.journal, { ...f.adapter, platform: 'darwin' })
  await assert.rejects(wrong.inspect(f.id, caller), { code: 'FILE_ERROR' }); assert.equal(f.pins(), 0)
})

test('failed identity, corrupt observation and unconfirmed release are observable and sanitize native diagnostics', async () => {
  const f = await fixture(); await f.journal.staged(f.id, proof)
  f.adapter.observeWrite = async () => { throw new Error('/private/native/diagnostic') }
  await assert.rejects(f.service.inspect(f.id, caller), error => { assert.ok(!(error as Error).message.includes('/private')); return true })
  assert.equal(f.releases(), 1)
  f.adapter.observeWrite = async () => ({ state: 'staging', size: NaN })
  await assert.rejects(f.service.inspect(f.id, caller), { code: 'FILE_ERROR' })
  f.adapter.observeWrite = async () => ({ state: 'staging', size: 3 })
  f.adapter.release = async () => { throw new Error('unconfirmed') }
  await assert.rejects(f.service.inspect(f.id, caller), { code: 'FILE_ERROR' }); assert.equal((await f.journal.pending()).length, 1)
})

test('recovery stop is idempotent and invalidates subsequent requests', async () => {
  const f = await fixture(); const first = f.service.stop(); assert.equal(f.service.stop(), first); await first
  assert.equal(f.stops(), 1); await assert.rejects(f.service.list(caller), { code: 'PERMISSION_DENIED' })
  await assert.rejects(f.service.inspect(f.id, caller), { code: 'PERMISSION_DENIED' })
})


test('recovery pre-cancel does not pin and late native pin is released without an observation or success', async () => {
  const f = await fixture(); await f.journal.staged(f.id, proof)
  const early = new AbortController(); early.abort()
  await assert.rejects(f.service.inspect(f.id, caller, early.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.pins(), 0)
  let settle!: (value: Awaited<ReturnType<RecoveryAdapter['pin']>>) => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let observations = 0
  f.adapter.pin = async (_path, kind, _rights, signal) => { assert.equal(signal.aborted, false); started(); return new Promise(resolve => { settle = resolve }) }
  f.adapter.observeWrite = async () => { observations++; return { state: 'staging', size: 3 } }
  const controller = new AbortController(), pending = f.service.inspect(f.id, caller, controller.signal)
  await ready; controller.abort(); settle({ kind: 'save', handle: 'late', displayName: 'output.txt' })
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' }); assert.equal(observations, 0); assert.equal(f.releases(), 1)
  assert.equal((await f.journal.pending()).length, 1)
})

test('recovery bounds all accepted queries and stop reports noncooperative cleanup while retaining evidence', async () => {
  const f = await fixture(); await f.journal.staged(f.id, proof)
  let complete!: () => void
  const blocked = new Promise<void>(resolve => { complete = resolve })
  f.adapter.observeWrite = async () => { await blocked; return { state: 'staging', size: 3 } }
  const service = new PathWriteRecoveryService(f.journal, f.adapter, 10)
  const pending = Array.from({ length: 8 }, () => service.inspect(f.id, caller))
  const observed = pending.map(value => assert.rejects(value, { code: 'PERMISSION_DENIED' }))
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(service.list(caller), { code: 'FILE_ERROR' })
  const stopped = service.stop(); assert.equal(service.stop(), stopped)
  await assert.rejects(stopped, { code: 'FILE_ERROR' }); assert.equal(f.stops(), 1)
  complete(); await Promise.all(observed); assert.equal(f.releases(), 8); assert.equal((await f.journal.pending()).length, 1)
})

test('recovery stops only after cooperative inspection releases its object', async () => {
  const f = await fixture(); await f.journal.staged(f.id, proof)
  const order: string[] = []; let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.adapter.observeWrite = async (_object, _proof, signal) => { started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { state: 'staging', size: 3 } }
  f.adapter.release = async () => { order.push('release') }; f.adapter.stop = async () => { order.push('stop') }
  const pending = f.service.inspect(f.id, caller); const rejected = assert.rejects(pending, { code: 'PERMISSION_DENIED' })
  await ready; await f.service.stop(); await rejected; assert.deepEqual(order, ['release', 'stop'])
})
