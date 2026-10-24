import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { NetworkRequestCancellationEndpoint } from '../../src/main/ipc/network-request-cancellation-endpoint.js'
import { NetworkRequestCancellationService } from '../../src/main/services/network-request-cancellation-service.js'
import type { SdkLaneIpcEvent, SdkLaneRegistry, SdkLaneTarget } from '../../src/main/ipc/sdk-lane-dispatch.js'

const plugin = { type: 'plugin' as const, webContentsId: 41, pluginId: 'exchange-rate', pluginInstanceId: 'instance-41' }

function createEndpoint(options: {
  readonly caller?: CallerIdentity
  readonly lane?: 1 | 2
  readonly url?: string
  readonly pendingMethod?: string
} = {}) {
  const caller = options.caller ?? plugin
  const frame = { url: options.url ?? 'ztools://plugins/exchange-rate/index.html' }
  const target: SdkLaneTarget = { id: caller.webContentsId, mainFrame: frame, isDestroyed: () => false }
  const registry: SdkLaneRegistry = {
    get: id => id === caller.webContentsId ? caller : undefined,
    getWebContents: id => id === target.id ? target : undefined,
    getSdkApiLane: () => options.lane ?? 1
  }
  const event: SdkLaneIpcEvent = { sender: target, senderFrame: frame }
  const service = new NetworkRequestCancellationService()
  const endpoint = new NetworkRequestCancellationEndpoint(
    registry,
    service,
    () => false,
    () => options.pendingMethod
  )
  return { caller, frame, target, event, service, endpoint }
}

test('Main cancellation endpoint binds plugin identity, real WebContents, main frame, lane, and fixed method', async () => {
  const fixture = createEndpoint()
  const controller = new AbortController()
  const release = fixture.service.begin(fixture.caller, 'network_http_request', 'network-1', controller)

  const response = await fixture.endpoint.cancel(fixture.event, { messageId: 'network-1', reason: 'cancel' })
  assert.equal(response.success, true)
  assert.equal(controller.signal.reason, 'CALLER_DESTROYED')

  const subframe = { url: fixture.frame.url }
  const subframeResponse = await fixture.endpoint.cancel({ ...fixture.event, senderFrame: subframe }, {
    messageId: 'network-1', reason: 'cancel'
  })
  assert.deepEqual(subframeResponse, {
    messageId: 'network-1', success: false,
    error: { code: 'PERMISSION_DENIED', message: '网络请求取消调用者无效' }
  })

  release()
  fixture.service.stop()
})

test('wrong plugin URL, invalid SDK lane, active method, and sender are rejected before cancellation', async () => {
  const invalidCases = [
    createEndpoint({ url: 'ztools://plugins/other-plugin/index.html' }),
    createEndpoint({ lane: 3 as unknown as 1 }),
    createEndpoint({ pendingMethod: 'app_ready' })
  ]
  for (const fixture of invalidCases) {
    const response = await fixture.endpoint.cancel(fixture.event, { messageId: 'network-2', reason: 'cancel' })
    assert.equal(response.success, false)
    assert.equal(response.error.code, 'PERMISSION_DENIED')
    fixture.service.stop()
  }

  const fixture = createEndpoint()
  const spoofed = { ...fixture.target, id: fixture.target.id + 1 }
  const response = await fixture.endpoint.cancel({ sender: spoofed, senderFrame: fixture.frame }, {
    messageId: 'network-3', reason: 'cancel'
  })
  assert.equal(response.success, false)
  assert.equal(response.error.code, 'PERMISSION_DENIED')
  fixture.service.stop()
})

test('trusted SDK lane 2 may cancel only its own fixed network request', async () => {
  const fixture = createEndpoint({ lane: 2 })
  const controller = new AbortController()
  const release = fixture.service.begin(fixture.caller, 'network_http_request', 'network-lane-2', controller)
  const response = await fixture.endpoint.cancel(fixture.event, { messageId: 'network-lane-2', reason: 'cancel' })
  assert.equal(response.success, true)
  assert.equal(controller.signal.reason, 'CALLER_DESTROYED')
  release()
  fixture.service.stop()
})

test('a different plugin instance cannot cancel the original request even with a matching messageId', async () => {
  const fixture = createEndpoint()
  const controller = new AbortController()
  const release = fixture.service.begin(fixture.caller, 'network_http_request', 'network-4', controller)
  const other = { ...plugin, webContentsId: 42, pluginInstanceId: 'instance-42' }
  const frame = { url: 'ztools://plugins/exchange-rate/index.html' }
  const target: SdkLaneTarget = { id: other.webContentsId, mainFrame: frame, isDestroyed: () => false }
  const registry: SdkLaneRegistry = {
    get: id => id === other.webContentsId ? other : undefined,
    getWebContents: id => id === target.id ? target : undefined,
    getSdkApiLane: () => 1
  }
  const endpoint = new NetworkRequestCancellationEndpoint(registry, fixture.service, () => false, () => undefined)
  const response = await endpoint.cancel({ sender: target, senderFrame: frame }, {
    messageId: 'network-4', reason: 'cancel'
  })
  assert.equal(response.success, true)
  assert.equal(controller.signal.aborted, false)
  release()
  fixture.service.stop()
})

test('malformed, unknown-field, and non-network identifiers do not reach active work', async () => {
  const fixture = createEndpoint({ pendingMethod: 'network_http_request' })
  const controller = new AbortController()
  const release = fixture.service.begin(fixture.caller, 'network_http_request', 'network-5', controller)

  for (const value of [
    { messageId: 'network-5', reason: 'cancel', method: 'network_http_upload' },
    { messageId: 'network-5', reason: 'abort' },
    { messageId: 'invalid id', reason: 'cancel' }
  ]) {
    const response = await fixture.endpoint.cancel(fixture.event, value)
    assert.equal(response.success, false)
  }
  assert.equal(controller.signal.aborted, false)
  release()
  fixture.service.stop()
})
