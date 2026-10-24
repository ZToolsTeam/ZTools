import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NETWORK_REQUEST_CANCEL_CHANNEL,
  parseNetworkRequestCancellation
} from '../../src/contracts/network-request-cancel.js'
import { NetworkRequestCancellationService } from '../../src/main/services/network-request-cancellation-service.js'
import { createNetworkRequestCancellationBridge } from '../../src/preload/network-request-cancellation.js'

const lane1 = { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1 }
const lane2 = { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }
const caller = { type: 'plugin' as const, webContentsId: 31, pluginId: 'exchange-rate', pluginInstanceId: 'instance-31' }

test('network cancellation payload accepts only an id and a fixed cancel reason', () => {
  assert.deepEqual(parseNetworkRequestCancellation({ messageId: 'request-1', reason: 'cancel' }), {
    messageId: 'request-1', reason: 'cancel'
  })
  for (const invalid of [
    null,
    [],
    { messageId: 'request-1', reason: 'cancel', method: 'app_ready' },
    { messageId: '', reason: 'cancel' },
    { messageId: 'request-1', reason: 'abort' }
  ]) assert.throws(() => parseNetworkRequestCancellation(invalid))
})

test('preload exposes only the fixed network cancellation method to authenticated SDK top frames', async () => {
  const calls: { channel: string; value: unknown }[] = []
  const bridge = createNetworkRequestCancellationBridge({
    invoke: async (channel, value) => { calls.push({ channel, value }); return { success: true } }
  }, lane1, true)
  assert.ok(bridge)
  assert.deepEqual(Object.keys(bridge), ['network_http_request'])
  const cancelNetworkRequest = bridge.network_http_request
  assert.ok(cancelNetworkRequest)
  await cancelNetworkRequest({ messageId: 'request-1', reason: 'timeout' })
  await assert.rejects(cancelNetworkRequest({ messageId: 'request-1', reason: 'cancel', channel: 'ztools:call' }))
  assert.equal(createNetworkRequestCancellationBridge({ invoke: async () => undefined }, lane1, false), undefined)
  assert.deepEqual(Object.keys(createNetworkRequestCancellationBridge({ invoke: async () => undefined }, lane2, true) ?? {}), ['network_http_request'])
  assert.equal(createNetworkRequestCancellationBridge({ invoke: async () => undefined }, undefined, true), undefined)
  assert.deepEqual(calls, [{
    channel: NETWORK_REQUEST_CANCEL_CHANNEL,
    value: { messageId: 'request-1', reason: 'timeout' }
  }])
})

test('an early cancellation is consumed before the HTTP handler starts and duplicate late cancel is terminal', () => {
  const service = new NetworkRequestCancellationService()
  assert.deepEqual(service.cancel(caller, 'request-2', 'cancel'), { accepted: true, terminal: false })
  assert.deepEqual(service.cancel(caller, 'request-2', 'timeout'), { accepted: true, terminal: false })

  const controller = new AbortController()
  const release = service.begin(caller, 'network_http_request', 'request-2', controller)
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason, 'CALLER_DESTROYED')
  release()
  release()
  assert.deepEqual(service.cancel(caller, 'request-2', 'cancel'), { accepted: false, terminal: true })
})

test('active cancellation aborts the Main controller, preserves timeout reason, and is idempotent', () => {
  const service = new NetworkRequestCancellationService()
  const controller = new AbortController()
  const release = service.begin(caller, 'network_http_request', 'request-3', controller)

  assert.deepEqual(service.cancel(caller, 'request-3', 'timeout'), { accepted: true, terminal: false })
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason, 'REQUEST_TIMEOUT')
  assert.deepEqual(service.cancel(caller, 'request-3', 'cancel'), { accepted: true, terminal: false })
  release()
  service.stop()
})

test('owner identity isolates requests and tombstones, while unsupported method and caller shapes fail closed', () => {
  const service = new NetworkRequestCancellationService()
  const controller = new AbortController()
  const release = service.begin(caller, 'network_http_request', 'request-4', controller)
  const otherInstance = { ...caller, pluginInstanceId: 'instance-other' }

  service.cancel(otherInstance, 'request-4', 'cancel')
  assert.equal(controller.signal.aborted, false)
  assert.throws(() => service.begin(caller, 'app_ready' as never, 'wrong-method', new AbortController()), { code: 'PERMISSION_DENIED' })
  assert.throws(() => service.cancel({ type: 'plugin', webContentsId: 31, pluginId: 'exchange-rate' }, 'bad-owner', 'cancel'), { code: 'PERMISSION_DENIED' })
  release()
  assert.deepEqual(service.cancel(caller, 'request-4', 'cancel'), { accepted: false, terminal: true })
  service.closeOwner(caller.webContentsId)
  service.stop()
})

test('early markers expire and stay bounded per owner and globally', () => {
  let now = 1_000
  const service = new NetworkRequestCancellationService(() => now)
  for (let index = 0; index < 64; index += 1) service.cancel(caller, `early-${index}`, 'cancel')
  assert.throws(() => service.cancel(caller, 'early-overflow', 'cancel'), { code: 'PLUGIN_BUSY' })
  assert.deepEqual(service.cancel(caller, 'early-0', 'timeout'), { accepted: true, terminal: false })

  for (let ownerIndex = 1; ownerIndex < 4; ownerIndex += 1) {
    const otherOwner = { ...caller, webContentsId: 60 + ownerIndex, pluginId: `plugin-${ownerIndex}`, pluginInstanceId: `instance-${ownerIndex}` }
    for (let index = 0; index < 64; index += 1) service.cancel(otherOwner, `other-${ownerIndex}-${index}`, 'cancel')
  }
  assert.throws(() => service.cancel({ ...caller, webContentsId: 70 }, 'global-overflow', 'cancel'), { code: 'PLUGIN_BUSY' })

  now += 10_001
  assert.deepEqual(service.cancel(caller, 'after-expiry', 'cancel'), { accepted: true, terminal: false })
  service.stop()
})

test('destroy and stop abort live work and clear owner state', () => {
  const service = new NetworkRequestCancellationService()
  service.cancel(caller, 'early-before-destroy', 'cancel')
  service.closeOwner(caller.webContentsId)
  const afterDestroy = new AbortController()
  const releaseAfterDestroy = service.begin(caller, 'network_http_request', 'early-before-destroy', afterDestroy)
  assert.equal(afterDestroy.signal.aborted, false)
  releaseAfterDestroy()

  const first = new AbortController()
  service.begin(caller, 'network_http_request', 'request-destroyed', first)
  service.closeOwner(caller.webContentsId)
  assert.equal(first.signal.reason, 'CALLER_DESTROYED')

  const second = new AbortController()
  service.begin(caller, 'network_http_request', 'request-stopped', second)
  service.stop()
  assert.equal(second.signal.reason, 'APP_STOPPING')
  assert.throws(() => service.cancel(caller, 'request-stopped', 'cancel'), { code: 'APP_STOPPING' })
})
