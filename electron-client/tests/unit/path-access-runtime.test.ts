import assert from 'node:assert/strict'
import test from 'node:test'
import { createPathAccessRuntime } from '../../src/main/platform/path-access-runtime.js'
import type { PathAccessAdapter } from '../../src/main/platform/path-access.js'
import type { RecoveryAdapter } from '../../src/main/services/path-write-recovery-service.js'

function fixture(corrupt = false) {
  const events: string[] = [], journals: unknown[] = []
  let counter = 0
  const createAdapter = (journal?: unknown): PathAccessAdapter & RecoveryAdapter => {
    const id = ++counter; journals.push(journal)
    const unsupported = async (): Promise<never> => { throw new Error('TEST_OPERATION_NOT_EXPECTED') }
    return {
      platform: 'win32',
      pin: async (_, kind) => ({ handle: `${id}:root`, kind, displayName: 'selected' }),
      createDirectory: async (_, segments) => { assert.deepEqual(segments, ['FileWriteJournal']); events.push(`mkdir:${id}`); return { status: 'created' } },
      deriveDirectory: async (_, segments) => { assert.deepEqual(segments, ['FileWriteJournal']); return { handle: `${id}:journal`, kind: 'directory', displayName: 'FileWriteJournal' } },
      list: async () => corrupt ? [{ name: 'file-write-journal.bin', size: 3, isDirectory: false }] : [],
      deriveRead: async () => ({ handle: `${id}:record`, kind: 'file', displayName: 'file-write-journal.bin' }), read: async () => Buffer.from('bad'),
      release: async object => { events.push(`release:${object.handle}`) },
      stop: async () => { events.push(`stop:${id}`) },
      readRange: unsupported, save: unsupported, streamSave: unsupported, pinCommittedSave: unsupported, deriveSave: unsupported,
      describe: unsupported, copy: unsupported, remove: unsupported, move: unsupported, observeWrite: unsupported
    }
  }
  return { events, journals, createAdapter }
}
const options = { platform: 'win32' as const, executable: 'E:\\synthetic\\broker.exe', dataRoot: 'E:\\synthetic\\Data',
  sealer: { seal: async (text: string) => Buffer.from(text), open: async (bytes: Buffer) => bytes.toString() } }

test('runtime composes separate store/recovery and journal-enabled owner brokers, stopping the store last', async () => {
  const f = fixture(), runtime = await createPathAccessRuntime(options, { createAdapter: f.createAdapter })
  await runtime.grants.create(42, 'E:\\synthetic\\selected.txt', 'file', ['read'])
  await runtime.grants.create(99, 'E:\\synthetic\\another.txt', 'file', ['read'])
  assert.equal(f.journals.length, 4); assert.equal(f.journals[0], undefined); assert.equal(f.journals[1], undefined)
  assert.ok(f.journals[2]); assert.equal(f.journals[2], f.journals[3])
  const stopping = runtime.stop(); assert.equal(runtime.stop(), stopping); await stopping
  assert.equal(f.events.at(-1), 'stop:1'); assert.equal(f.events.filter(event => event.startsWith('stop:')).length, 4)
  await assert.rejects(runtime.grants.create(42, 'E:\\synthetic\\later.txt', 'file', ['read']))
  await assert.rejects(runtime.recovery.list({ type: 'main', webContentsId: 42 }))
})

test('normal shutdown closes recovery ingress while grant cleanup is still pending', async () => {
  const f = fixture()
  let adapterCount = 0, signalRecoveryStop!: () => void, enterGrantStop!: () => void, releaseGrantStop!: () => void
  const recoveryStopStarted = new Promise<void>(resolve => { signalRecoveryStop = resolve })
  const grantStopEntered = new Promise<void>(resolve => { enterGrantStop = resolve })
  const grantStopGate = new Promise<void>(resolve => { releaseGrantStop = resolve })
  const runtime = await createPathAccessRuntime(options, { createAdapter: journal => {
    const adapter = f.createAdapter(journal)
    adapterCount++
    return adapterCount === 2 ? { ...adapter, stop: async () => { await adapter.stop(); signalRecoveryStop() } } : adapter
  } })
  const originalGrantStop = runtime.grants.stop.bind(runtime.grants)
  runtime.grants.stop = () => { enterGrantStop(); return grantStopGate.then(originalGrantStop) }

  const stopping = runtime.stop()
  await grantStopEntered
  const recoveryListRejected = await runtime.recovery.list({ type: 'main', webContentsId: 42 }).then(() => false, () => true)
  if (recoveryListRejected) await recoveryStopStarted
  releaseGrantStop()
  await stopping
  assert.equal(recoveryListRejected, true, 'recovery ingress must close before grant cleanup settles')
  assert.ok(f.events.includes('stop:2'), 'recovery adapter cleanup must start before grant cleanup settles')
  assert.equal(f.events.at(-1), 'stop:1')
})

test('owned provider adapters still get best-effort stop after a synchronous grants stop failure', async () => {
  const f = fixture(), runtime = await createPathAccessRuntime(options, { createAdapter: f.createAdapter })
  await runtime.grants.create(42, 'E:\\synthetic\\selected.txt', 'file', ['read'])
  runtime.grants.stop = () => { throw new Error('PRIVATE_GRANTS_STOP_BEFORE_PROVIDER') }

  await assert.rejects(runtime.stop(), { code: 'FILE_ERROR' })
  assert.ok(f.events.includes('stop:3'), 'the already-created owner adapter must receive fallback cleanup')
  assert.ok(f.events.includes('stop:2'))
  assert.equal(f.events.at(-1), 'stop:1')
})

test('corrupt journal rejects initialization and stops only its newly created store broker', async () => {
  const f = fixture(true)
  await assert.rejects(createPathAccessRuntime(options, { createAdapter: f.createAdapter }), { code: 'FILE_ERROR' })
  assert.equal(f.journals.length, 1); assert.equal(f.events.at(-1), 'stop:1')
})

test('runtime rejects wrong-platform adapters and malformed roots without path fallback', async () => {
  const f = fixture()
  await assert.rejects(createPathAccessRuntime({ ...options, dataRoot: 'relative' }, { createAdapter: f.createAdapter }))
  assert.equal(f.journals.length, 0)
  await assert.rejects(createPathAccessRuntime(options, { createAdapter: journal => ({ ...f.createAdapter(journal), platform: 'darwin' }) }), { code: 'FILE_ERROR' })
  assert.deepEqual(f.events, ['stop:1'])
})

test('a synchronous service stop failure still closes recovery and the store and preserves the shared stop promise', async () => {
  const f = fixture(), runtime = await createPathAccessRuntime(options, { createAdapter: f.createAdapter })
  runtime.grants.stop = () => { throw new Error('PRIVATE_STOP_FAILURE') }
  const stopping = runtime.stop()
  assert.equal(runtime.stop(), stopping)
  await assert.rejects(stopping, { code: 'FILE_ERROR' })
  assert.deepEqual(f.events.filter(event => event.startsWith('stop:')), ['stop:2', 'stop:1'])
})

test('a synchronous initialization cleanup failure does not replace the public initialization error', async () => {
  const f = fixture()
  await assert.rejects(createPathAccessRuntime(options, { createAdapter: journal => ({
    ...f.createAdapter(journal), platform: 'darwin',
    stop: () => { f.events.push('cleanup-attempted'); throw new Error('PRIVATE_ADAPTER_FAILURE') }
  }) }), { code: 'FILE_ERROR' })
  assert.ok(f.events.includes('cleanup-attempted'))
})

test('a late root pin is released and its adapter stopped after startup cancellation', async () => {
  const f = fixture(), startup = new AbortController()
  let entered!: () => void, releasePin!: (value: { handle: string; kind: 'directory'; displayName: string }) => void
  let passedSignal: AbortSignal | undefined
  const pinStarted = new Promise<void>(resolve => { entered = resolve })
  const createAdapter = (journal?: unknown) => {
    const adapter = f.createAdapter(journal)
    return { ...adapter, pin: async (_path: string, _kind: 'file' | 'directory' | 'save', _rights: readonly ('read' | 'write' | 'list')[], signal: AbortSignal) => {
      passedSignal = signal; entered()
      return await new Promise<{ handle: string; kind: 'directory'; displayName: string }>(resolve => { releasePin = resolve })
    } }
  }
  const startupOptions = { ...options, signal: startup.signal } as typeof options & { signal: AbortSignal }
  const creating = createPathAccessRuntime(startupOptions, { createAdapter })
  await pinStarted
  startup.abort()
  releasePin({ handle: 'late-root', kind: 'directory', displayName: 'Data' })
  const outcome = await creating.then(runtime => ({ runtime }), error => ({ error }))
  if ('runtime' in outcome) await outcome.runtime.stop()
  assert.ok('error' in outcome, 'a cancelled initialization must not return an active runtime')
  assert.equal(passedSignal, startup.signal)
  assert.equal(passedSignal?.aborted, true)
  assert.deepEqual(f.events, ['release:late-root', 'stop:1'])
})

test('a pre-cancelled startup does not acquire a path adapter', async () => {
  const f = fixture(), startup = new AbortController(); startup.abort()
  let created = 0
  const startupOptions = { ...options, signal: startup.signal } as typeof options & { signal: AbortSignal }
  await assert.rejects(createPathAccessRuntime(startupOptions, { createAdapter: journal => { created++; return f.createAdapter(journal) } }), { code: 'FILE_ERROR' })
  assert.equal(created, 0)
})

test('a late recovery-adapter construction failure releases the pinned root and continues adapter cleanup', async () => {
  const f = fixture(); let created = 0
  const createAdapter = (journal?: unknown) => {
    const adapter = f.createAdapter(journal), id = ++created
    return { ...adapter, platform: id === 2 ? 'darwin' as const : 'win32' as const,
      stop: async () => { f.events.push(`stop-attempt:${id}`); if (id === 2) throw new Error('PRIVATE_RECOVERY_STOP') } }
  }
  await assert.rejects(createPathAccessRuntime(options, { createAdapter }), { code: 'FILE_ERROR' })
  assert.ok(f.events.includes('release:1:root'))
  assert.deepEqual(f.events.filter(event => event.startsWith('stop-attempt:')), ['stop-attempt:2', 'stop-attempt:1'])
})
