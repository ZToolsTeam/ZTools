import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { ReferenceIpcEndpoint } from '../../src/main/ipc/reference-endpoint.js'
import { ReferenceRequestTracker } from '../../src/main/services/reference-request-tracker.js'
import { createReferenceTransportBridge } from '../../src/preload/reference-transport.js'
import { REFERENCE_CANCEL_CHANNEL } from '../../src/contracts/reference-transport.js'
import { ReferenceFileDropService } from '../../src/main/services/reference-file-drop-service.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'

function fixture() {
  const target = { id: 42, isDestroyed: () => false, mainFrame: { url: 'ztools://plugins/example/index.html' } }
  let caller: CallerIdentity | undefined = { type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'instance-1' }
  let sdkApiLane: 1 | 2 | undefined = 2
  const event = { sender: target, senderFrame: target.mainFrame }
  const tracker = new ReferenceRequestTracker({ isActive: () => !!caller, onRemoved: () => () => {} }, 100)
  return { target, event, tracker, registry: { get: () => caller, getWebContents: () => target, getSdkApiLane: () => sdkApiLane },
    sdkApiLane: (value: 1 | 2 | undefined) => { sdkApiLane = value },
    caller: (value: CallerIdentity | undefined) => { caller = value } }
}

for (const ownerChange of ['destroyed', 'replaced', 'frame', 'lane'] as const) test(`postcommit unavailable facts never cross invalid endpoint ${ownerChange} boundary`, async () => {
  const f = fixture(); let finish!: () => void, entered!: () => void, disposed = 0
  const gate = new Promise<void>(resolve => { finish = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_write_file: {
    execute: async () => { entered(); await gate; return { success: true, status: 'committed-reference-unavailable', size: 5,
      issues: [{ stage: 'reference', code: 'PERMISSION_DENIED' }] } },
    disposeUndelivered: async () => { disposed++ }
  } }, () => true)
  const pending = endpoint.call(f.event, { messageId: 'postcommit-owner', method: 'filesystem_write_file', params: {} })
  await started
  if (ownerChange === 'destroyed') f.caller(undefined)
  else if (ownerChange === 'replaced') f.caller({ type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'instance-2' })
  else if (ownerChange === 'frame') f.target.mainFrame.url = 'https://example.invalid/'
  else f.sdkApiLane(1)
  finish()
  const result = await pending
  assert.equal(result.success, false); assert.equal(Object.hasOwn(result, 'data'), false)
  assert.equal(disposed, 1)
  await f.tracker.stop()
})

test('private native drop endpoint rejects untrusted frames/pages before asking for native authorization', async () => {
  const f = fixture(); let calls = 0
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, {}, () => true, { accept: async () => {
    calls++; return { success: true, accepted: 1, rejected: 0 }
  } })
  for (const event of [{ ...f.event, senderFrame: null }, { ...f.event, senderFrame: { ...f.target.mainFrame } },
    { ...f.event, sender: { ...f.target } }]) assert.equal((await endpoint.acceptDrop(event, ['/private/selected'])).success, false)
  f.target.mainFrame.url = 'https://example.invalid/'
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/selected'])).success, false); assert.equal(calls, 0)
  f.target.mainFrame.url = 'ztools://plugins/example/index.html'
  f.sdkApiLane(1)
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/selected'])).success, false); assert.equal(calls, 0)
  f.sdkApiLane(undefined)
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/selected'])).success, false); assert.equal(calls, 0)
  f.sdkApiLane(9 as 1 | 2)
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/selected'])).success, false); assert.equal(calls, 0)
  f.sdkApiLane(2)
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/selected'])).success, true); assert.equal(calls, 1)
  await f.tracker.stop()
})

test('reference call requires the trusted Registry lane and ignores renderer lane hints', async () => {
  const f = fixture(); let calls = 0
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_read_file: { execute: async () => { calls++; return true } } }, () => true)
  const request = { messageId: 'read-lane', method: 'filesystem_read_file', params: { sdkApiLane: 2 } }
  f.sdkApiLane(1)
  assert.equal((await endpoint.call(f.event, request)).success, false)
  assert.equal((await endpoint.call(f.event, { ...request, messageId: 'read-top-level-lane', sdkApiLane: 2 })).success, false)
  f.sdkApiLane(undefined)
  assert.equal((await endpoint.call(f.event, request)).success, false)
  f.sdkApiLane(9 as 1 | 2)
  assert.equal((await endpoint.call(f.event, request)).success, false)
  f.sdkApiLane(2)
  assert.equal((await endpoint.call(f.event, request)).success, true)
  assert.equal(calls, 1)
  await f.tracker.stop()
})

test('lane 1 cannot cancel an in-flight reference request', async () => {
  const f = fixture(); let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { finish = resolve })
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_write_file: { execute: async () => {
    entered(); await wait; return { success: true }
  }, disposeUndelivered: async () => {} } }, () => true)
  const pending = endpoint.call(f.event, { messageId: 'write-lane', method: 'filesystem_write_file', params: {} })
  await started
  f.sdkApiLane(undefined)
  assert.equal((await endpoint.cancel(f.event, { messageId: 'write-lane', method: 'filesystem_write_file', reason: 'cancel' })).success, false)
  f.sdkApiLane(1)
  assert.equal((await endpoint.cancel(f.event, { messageId: 'write-lane', method: 'filesystem_write_file', reason: 'cancel' })).success, false)
  f.sdkApiLane(9 as 1 | 2)
  assert.equal((await endpoint.cancel(f.event, { messageId: 'write-lane', method: 'filesystem_write_file', reason: 'cancel' })).success, false)
  assert.equal((await endpoint.cancel(f.event, { messageId: 'write-lane', method: 'filesystem_write_file', reason: 'cancel', sdkApiLane: 2 })).success, false)
  f.sdkApiLane(2)
  finish()
  assert.equal((await pending).success, true)
  await f.tracker.stop()
})

test('closeIngress rejects new call/cancel/drop and drain waits for in-flight request and drop cleanup', async () => {
  const f = fixture()
  let requestStarted!: () => void, dropStarted!: () => void, dropStopStarted!: () => void
  let releaseDropStop!: () => void, rejectDrop!: (error: Error) => void
  const requestEntered = new Promise<void>(resolve => { requestStarted = resolve })
  const dropEntered = new Promise<void>(resolve => { dropStarted = resolve })
  const dropStopping = new Promise<void>(resolve => { dropStopStarted = resolve })
  const dropStopGate = new Promise<void>(resolve => { releaseDropStop = resolve })
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_read_file: { execute: async (_params, _caller, signal) => {
    requestStarted()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return true
  } } }, () => true, {
    accept: async () => {
      dropStarted()
      return await new Promise<{ success: true; accepted: number; rejected: number }>((_resolve, reject) => { rejectDrop = reject })
    },
    stop: () => { dropStopStarted(); rejectDrop(new Error('drop cancelled')); return dropStopGate }
  })
  const activeCall = endpoint.call(f.event, { messageId: 'shutdown-call', method: 'filesystem_read_file', params: {} })
  const activeDrop = endpoint.acceptDrop(f.event, ['/private/selected'])
  await Promise.all([requestEntered, dropEntered])

  endpoint.closeIngress()
  endpoint.closeIngress()
  const drain = endpoint.drain()
  assert.equal(endpoint.drain(), drain)
  await dropStopping
  assert.equal((await endpoint.call(f.event, { messageId: 'after-close', method: 'filesystem_read_file', params: {} })).success, false)
  assert.equal((await endpoint.cancel(f.event, { messageId: 'shutdown-call', method: 'filesystem_read_file', reason: 'cancel' })).success, false)
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/later'])).success, false)
  let drained = false
  void drain.then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false, 'the already-entered native drop must keep drain pending')

  releaseDropStop()
  await drain
  assert.equal((await activeCall).success, false)
  assert.equal((await activeDrop).success, false)
})

test('drop revalidates the Registry lane after native authorization begins', async () => {
  const f = fixture(); let validations = 0
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, {}, () => true, { accept: async (_owner, _value, _signal, validate) => {
    f.sdkApiLane(1); validations++; validate?.(); return { success: true, accepted: 1, rejected: 0 }
  } })
  assert.equal((await endpoint.acceptDrop(f.event, ['/private/selected'])).success, false)
  assert.equal(validations, 1)
  await f.tracker.stop()
})

test('private drop revalidates the same real frame after native pin and revokes refs on navigation', async () => {
  const f = fixture(), revoked: string[] = []; let sent = 0
  const grants: Pick<PathGrantService, 'create' | 'describe' | 'resourceUrl' | 'revoke'> = {
    create: async () => ({ grantId: 'a'.repeat(43), displayName: 'selected.txt', kind: 'file', operations: ['read'] }),
    describe: async () => { f.target.mainFrame.url = 'https://example.invalid/'; return { isDirectory: false, size: 3, lastModifiedMs: 1 } },
    resourceUrl: () => 'ztools://file/' + 'a'.repeat(43) + '/selected.txt', revoke: async (_, id) => { revoked.push(id) }
  }
  const drops = new ReferenceFileDropService({ ...f.registry, send: () => { sent++; return true } }, grants)
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, {}, () => true, drops)
  const result = await endpoint.acceptDrop(f.event, [process.platform === 'win32' ? 'E:/synthetic/selected.txt' : '/private/selected.txt'])
  assert.equal(result.success, false); assert.deepEqual(revoked, ['a'.repeat(43)]); assert.equal(sent, 0)
  await drops.stop(); await f.tracker.stop()
})

test('reference IPC rejects unregistered, foreign WebContents, subframes, wrong plugin URLs and denied methods', async () => {
  const f = fixture(); let calls = 0
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_read_file: { execute: async () => { calls++; return true } } }, () => true)
  const request = { messageId: 'read', method: 'filesystem_read_file', params: {} }
  for (const event of [{ ...f.event, senderFrame: null }, { ...f.event, senderFrame: { url: f.target.mainFrame.url } },
    { ...f.event, sender: { ...f.target } }]) {
    const result = await endpoint.call(event, request); assert.equal(result.success, false)
  }
  for (const url of ['https://example.invalid/', 'ztools://web/index.html', 'ztools://plugins/other/index.html']) {
    f.target.mainFrame.url = url; assert.equal((await endpoint.call(f.event, request)).success, false)
  }
  f.target.mainFrame.url = 'ztools://plugins/example/index.html'; f.caller(undefined)
  assert.equal((await endpoint.call(f.event, request)).success, false)
  assert.equal(calls, 0); await f.tracker.stop()
})

test('maintained preload to Main endpoint cancellation is owner-bound and returns native commit uncertainty', async () => {
  const f = fixture(); let finish!: () => void, disposed = 0
  const wait = new Promise<void>(resolve => { finish = resolve })
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_write_file: { execute: async (_params, caller) => {
    assert.equal(caller.webContentsId, 42); await wait; return { success: true }
  }, disposeUndelivered: async () => { disposed++ } } }, () => true)
  const bridge = createReferenceTransportBridge(
    { invoke: (channel, value) => channel === REFERENCE_CANCEL_CHANNEL ? endpoint.cancel(f.event, value) : endpoint.call(f.event, value) },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 },
    true
  )
  assert.ok(bridge)
  const pending = bridge.methods.filesystem_write_file!({ messageId: 'write', params: { saveGrantId: 'a'.repeat(43) } })
  await Promise.resolve()
  const cancelled = await bridge.cancellations.filesystem_write_file!({ messageId: 'write', reason: 'cancel' })
  assert.deepEqual(cancelled, { messageId: 'write', success: true, data: { success: true, requested: true } })
  finish()
  assert.deepEqual(await pending, { messageId: 'write', success: false, error: { code: 'FILE_WRITE_OUTCOME_UNKNOWN', message: '文件请求取消后写入结果未确认' } })
  assert.equal(disposed, 1)
  await f.tracker.stop()
})

test('navigation or instance change after reference production revokes only the undelivered output', async () => {
  const f = fixture(), disposed: unknown[] = []
  const reference = { grantId: 'a'.repeat(43), kind: 'file', operations: ['read'], displayName: 'selected.txt' }
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_derive_read: {
    execute: async () => { f.target.mainFrame = { url: 'ztools://plugins/example/new.html' }; return { reference } },
    disposeUndelivered: async value => { disposed.push(value) }
  } }, () => true)
  const result = await endpoint.call(f.event, { messageId: 'derive', method: 'filesystem_derive_read', params: {} })
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.error.code, 'CALLER_DESTROYED')
  assert.deepEqual(disposed, [{ reference }]); await f.tracker.stop()
})

test('new Registry generation cannot receive a pending old-generation reference result', async () => {
  const f = fixture(), disposed: unknown[] = []
  const reference = { grantId: 'b'.repeat(43), kind: 'file', operations: ['read'], displayName: 'old.txt' }
  const endpoint = new ReferenceIpcEndpoint(f.registry, f.tracker, { filesystem_derive_read: {
    execute: async () => { f.caller({ type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'instance-2' }); return { reference } },
    disposeUndelivered: async value => { disposed.push(value) }
  } }, () => true)
  const result = await endpoint.call(f.event, { messageId: 'old-generation', method: 'filesystem_derive_read', params: {} })
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.error.code, 'CALLER_DESTROYED')
  assert.deepEqual(disposed, [{ reference }])
  await f.tracker.stop()
})
