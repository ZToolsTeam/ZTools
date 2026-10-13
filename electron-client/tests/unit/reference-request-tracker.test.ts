import assert from 'node:assert/strict'
import test from 'node:test'
import { ReferenceRequestTracker } from '../../src/main/services/reference-request-tracker.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'

function fixture(cleanupMs = 25) {
  const listeners = new Set<(owner: number) => void>(), removed = new Set<number>()
  let now = 0
  const tracker = new ReferenceRequestTracker({ isActive: owner => !removed.has(owner),
    onRemoved: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }, cleanupMs, () => now)
  return { tracker, listeners, advance: () => { now += 10_000 },
    remove: (owner: number) => { removed.add(owner); for (const listener of listeners) listener(owner) } }
}
function gate() {
  let finish!: (value: unknown) => void
  const promise = new Promise<unknown>(resolve => { finish = resolve })
  return { promise, finish: (value: unknown = 'done') => finish(value) }
}

test('owner/method cancellation before invoke registration prevents dispatch and is bounded and expires', async () => {
  const f = fixture(); let calls = 0
  f.tracker.cancel(42, 'filesystem_write_file', 'early')
  await assert.rejects(f.tracker.execute(42, 'filesystem_write_file', 'early', async () => { calls++; return true }, 1000, async () => {}), { code: 'CALLER_DESTROYED' })
  assert.equal(calls, 0)
  for (let owner = 1; owner <= 4; owner++) for (let index = 0; index < 64; index++) f.tracker.cancel(owner, 'filesystem_read_file', String(index))
  assert.throws(() => f.tracker.cancel(5, 'filesystem_read_file', 'overflow'), { code: 'PERMISSION_DENIED' })
  assert.throws(() => f.tracker.cancel(1, 'filesystem_write_file', '0'), { code: 'PERMISSION_DENIED' })
  f.advance(); assert.equal(await f.tracker.execute(1, 'filesystem_read_file', '0', async () => 'value'), 'value')
  await f.tracker.stop(); assert.equal(f.listeners.size, 0)
})

test('cancellation waits for native staging/commit facts instead of eagerly replacing them with generic abort', async () => {
  for (const code of [errorCodes.fileWriteOutcomeUnknown, errorCodes.fileStagingRetained]) {
    const f = fixture(), g = gate()
    const pending = f.tracker.execute(42, 'filesystem_write_file', 'write', async () => { await g.promise; throw new ZToolsError(code, 'native fact') }, 1000, async () => {})
    const rejected = assert.rejects(pending, { code })
    await Promise.resolve(); f.tracker.cancel(42, 'filesystem_write_file', 'write'); g.finish()
    await rejected; await f.tracker.stop()
  }
  const f = fixture(), g = gate()
  let disposed = 0
  const pending = f.tracker.execute(42, 'filesystem_write_file', 'receipt', async () => { await g.promise; return { success: true } }, 1000, async () => { disposed++ })
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await Promise.resolve(); f.tracker.cancel(42, 'filesystem_write_file', 'receipt'); g.finish()
  await rejected; assert.equal(disposed, 1); await f.tracker.stop()
})

test('cancel is scoped to trusted owner and exact method; destroyed owner suppresses a late read', async () => {
  const f = fixture(), g = gate()
  const pending = f.tracker.execute(42, 'filesystem_read_file', 'read', async () => g.promise)
  await Promise.resolve()
  f.tracker.cancel(99, 'filesystem_read_file', 'read')
  assert.throws(() => f.tracker.cancel(42, 'filesystem_write_file', 'read'), { code: 'PERMISSION_DENIED' })
  f.remove(42); g.finish()
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  await f.tracker.stop()
})

test('global/per-owner request limits retain noncooperating reservations until actual settlement', async () => {
  const f = fixture(10), gates = Array.from({ length: 8 }, () => gate())
  const pending = gates.map((g, index) => f.tracker.execute(1 + Math.floor(index / 2), 'filesystem_read_file', String(index), async () => g.promise))
  await assert.rejects(f.tracker.execute(1, 'filesystem_read_file', 'other', async () => true), { code: 'PERMISSION_DENIED' })
  await assert.rejects(f.tracker.execute(99, 'filesystem_read_file', 'other', async () => true), { code: 'PERMISSION_DENIED' })
  await Promise.resolve(); f.tracker.cancel(1, 'filesystem_read_file', '0')
  await assert.rejects(pending[0]!, { code: 'FILE_ERROR' })
  await assert.rejects(f.tracker.execute(1, 'filesystem_read_file', 'later', async () => true), { code: 'PERMISSION_DENIED' })
  for (const g of gates) g.finish()
  await Promise.allSettled(pending)
  assert.equal(await f.tracker.execute(1, 'filesystem_read_file', 'later', async () => true), true)
  await f.tracker.stop()
})

test('reference producers require cleanup and revoke undelivered late outputs; cleanup failures remain observable on stop', async () => {
  const f = fixture(), g = gate(), disposed: unknown[] = []
  await assert.rejects(f.tracker.execute(42, 'clipboard_read_files', 'missing', async () => []), { code: 'PERMISSION_DENIED' })
  const pending = f.tracker.execute(42, 'clipboard_read_files', 'files', async () => g.promise, 1000, async value => { disposed.push(value) })
  await Promise.resolve(); f.tracker.cancel(42, 'clipboard_read_files', 'files'); g.finish({ files: ['opaque'] })
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' }); assert.deepEqual(disposed, [{ files: ['opaque'] }])
  const late = gate()
  const failed = f.tracker.execute(42, 'clipboard_read_files', 'failed', async () => late.promise, 1000, async () => { throw new Error('unconfirmed') })
  await Promise.resolve(); f.tracker.cancel(42, 'clipboard_read_files', 'failed'); late.finish([])
  await assert.rejects(failed, { code: 'FILE_ERROR' })
  await assert.rejects(f.tracker.stop(), { code: 'FILE_ERROR' })
})

test('closeIngress synchronously rejects new work, aborts a pending write, and drain waits for its final outcome', async () => {
  const f = fixture(), g = gate()
  let workStarted!: () => void, workSignal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { workStarted = resolve })
  const pending = f.tracker.execute(42, 'filesystem_write_file', 'closing-write', async signal => {
    workSignal = signal; workStarted(); await g.promise; return { success: true }
  }, 1000, async () => {})
  await started
  f.tracker.closeIngress()
  assert.equal(workSignal?.aborted, true)
  await assert.rejects(f.tracker.execute(42, 'filesystem_read_file', 'after-close', async () => true), { code: 'PERMISSION_DENIED' })
  assert.throws(() => f.tracker.cancel(42, 'filesystem_write_file', 'closing-write'), { code: 'PERMISSION_DENIED' })
  const draining = f.tracker.stop()
  assert.equal(f.tracker.stop(), draining)
  let drained = false
  void draining.then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false, 'stop must retain ownership until the operation settles')
  g.finish()
  await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await draining
  assert.equal(drained, true)
  assert.equal(f.listeners.size, 0)
})

test('timeout and shutdown are bounded, repeatable and refuse arbitrary methods or infinite file I/O', async () => {
  const f = fixture(10), g = gate()
  await assert.rejects(f.tracker.execute(42, 'dllplugin_call', 'bad', async () => true), { code: 'PERMISSION_DENIED' })
  await assert.rejects(f.tracker.execute(42, 'filesystem_read_file', 'bad', async () => true, 'infinite'), { code: 'PERMISSION_DENIED' })
  const pending = f.tracker.execute(42, 'filesystem_write_file', 'timeout', async () => g.promise, 1, async () => {})
  await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const stopped = f.tracker.stop(); assert.equal(f.tracker.stop(), stopped)
  await assert.rejects(stopped, { code: 'FILE_ERROR' })
  g.finish(); await Promise.resolve()
  await assert.rejects(f.tracker.execute(42, 'filesystem_read_file', 'after', async () => true), { code: 'PERMISSION_DENIED' })
})

test('generated screen/image delivery cancellation preserves possible cache writes and disposes only the output reference', async () => {
  for (const method of ['screen_capture', 'clipboard_read_image']) {
    const f = fixture(), g = gate(), disposed: unknown[] = []
    const result = { reference: { grantId: 'synthetic' } }
    const pending = f.tracker.execute(42, method, 'generated', async () => g.promise, 1000, async value => { disposed.push(value) })
    await Promise.resolve(); f.tracker.cancel(42, method, 'generated'); g.finish(result)
    await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
    assert.deepEqual(disposed, [result]); await f.tracker.stop()
  }
})
