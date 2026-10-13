import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { EventEnvelope } from '../../src/contracts/method-params.js'
import { RUNTIME_PERMISSION_CHANGED_EVENT } from '../../src/contracts/runtime-capability.js'
import { EventService } from '../../src/main/services/event-service.js'

interface SentMessage {
  webContentsId: number
  channel: string
  value: unknown
}

class FakeRegistry {
  readonly sent: SentMessage[] = []
  readonly #removedListeners = new Set<(webContentsId: number) => void>()

  send(webContentsId: number, channel: string, value: unknown): boolean {
    this.sent.push({ webContentsId, channel, value })
    return true
  }

  onRemoved(listener: (webContentsId: number) => void): () => void {
    this.#removedListeners.add(listener)
    return () => this.#removedListeners.delete(listener)
  }

  remove(webContentsId: number): void {
    for (const listener of this.#removedListeners) listener(webContentsId)
  }
}

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 2,
  pluginId: 'test-plugin',
  pluginInstanceId: 'instance-1'
}

const otherPluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 3,
  pluginId: 'other-plugin',
  pluginInstanceId: 'instance-2'
}
const secondSamePluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 4,
  pluginId: 'test-plugin',
  pluginInstanceId: 'instance-2'
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    envelopeId: 'env_renderer_1',
    version: 'v1',
    timestamp: 1,
    type: 'test.event',
    scope: 'system',
    source: { kind: 'spoofed' },
    target: { broadcast: true },
    payload: { value: 1 },
    ...overrides
  }
}

function sentEnvelope(message: SentMessage): Record<string, unknown> {
  return (message.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
}

test('subscriptions are idempotent and publisher does not receive its local event twice', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  assert.equal(events.subscribe({ key: 'test.event' }, mainCaller).subscribed, true)
  assert.equal(events.subscribe({ key: 'test.event' }, mainCaller).subscribed, false)
  events.subscribe({ key: 'test.event' }, pluginCaller)
  events.subscribe({ key: '*' }, pluginCaller)

  assert.deepEqual(events.publish({ envelope: envelope() }, mainCaller), {
    success: true,
    delivered: 1
  })
  assert.equal(registry.sent.length, 1)
  assert.equal(registry.sent[0]?.webContentsId, pluginCaller.webContentsId)
  const delivered = sentEnvelope(registry.sent[0] as SentMessage)
  assert.notEqual(delivered.envelopeId, 'env_renderer_1')
  assert.deepEqual(delivered.source, {
    kind: 'page',
    windowType: 'main'
  })
  events.stop()
})

test('request replies are limited to actual recipients and map back to the caller envelope id', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: 'rpc.test' }, pluginCaller)
  const requestEnvelope = envelope({ envelopeId: 'env_caller_request', type: 'rpc.test' })
  assert.equal(events.request({ envelope: requestEnvelope }, mainCaller).delivered, 1)
  const hostRequest = sentEnvelope(registry.sent[0] as SentMessage)
  const hostEnvelopeId = hostRequest.envelopeId as string

  const unrelatedCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 3,
    pluginId: 'other-plugin'
  }
  assert.throws(
    () => events.publish({ envelope: envelope({ replyTo: hostEnvelopeId }) }, unrelatedCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  const response = events.publish({
    envelope: envelope({
      envelopeId: 'env_plugin_reply',
      type: 'events.Ack',
      replyTo: hostEnvelopeId,
      payload: { ok: true }
    })
  }, pluginCaller)
  assert.deepEqual(response, { success: true, delivered: 1 })
  const callerReply = sentEnvelope(registry.sent[1] as SentMessage)
  assert.equal(registry.sent[1]?.webContentsId, mainCaller.webContentsId)
  assert.equal(callerReply.replyTo, 'env_caller_request')
  assert.deepEqual(callerReply.source, {
    kind: 'plugin',
    pluginId: 'test-plugin',
    pluginInstanceId: 'instance-1'
  })
  assert.equal(events.diagnostics().pendingRequests, 0)
  events.stop()
})

test('request without subscribers resolves with a synthetic NO_SUBSCRIBERS reply', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  assert.equal(events.request({ envelope: envelope() }, mainCaller).delivered, 0)
  assert.equal(registry.sent[0]?.webContentsId, mainCaller.webContentsId)
  const reply = sentEnvelope(registry.sent[0] as SentMessage)
  assert.equal(reply.replyTo, 'env_renderer_1')
  assert.deepEqual(reply.payload, { ok: false, code: 'NO_SUBSCRIBERS' })
  assert.equal(events.diagnostics().pendingRequests, 0)
  events.stop()
})

test('renderer removal clears subscriptions and pending requests', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: 'rpc.test' }, pluginCaller)
  events.request({ envelope: envelope({ type: 'rpc.test' }) }, mainCaller)
  assert.deepEqual(events.diagnostics(), { callers: 1, subscriptions: 1, pendingRequests: 1 })
  registry.remove(pluginCaller.webContentsId)
  assert.deepEqual(events.diagnostics(), { callers: 0, subscriptions: 0, pendingRequests: 0 })
  events.stop()
})

test('subscription observers track wildcard subscribers and host events preserve host identity', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const counts: number[] = []
  const removeObserver = events.onSubscriptionChanged('clipboard_change', (count) => counts.push(count))
  events.subscribe({ key: '*' }, pluginCaller)
  assert.deepEqual(events.subscribers('clipboard_change'), [pluginCaller])
  assert.deepEqual(events.publishHost('clipboard_change', { type: 'text', text: 'value' }), {
    success: true,
    delivered: 1
  })
  assert.deepEqual(sentEnvelope(registry.sent[0] as SentMessage).source, { kind: 'host' })
  events.unsubscribe({ key: '*' }, pluginCaller)
  assert.deepEqual(counts, [0, 1, 0])
  removeObserver()
  events.stop()
})

test('targeted host events are delivered only to the selected plugin', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: 'dllplugin_callback_result' }, pluginCaller)
  events.subscribe({ key: 'dllplugin_callback_result' }, otherPluginCaller)
  assert.deepEqual(events.publishHostToPlugin(
    'dllplugin_callback_result',
    { taskId: 'callback_1' },
    'test-plugin'
  ), {
    success: true,
    delivered: 1
  })
  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [
    pluginCaller.webContentsId
  ])
  assert.deepEqual(sentEnvelope(registry.sent[0] as SentMessage).target, {
    pluginId: 'test-plugin'
  })
  events.stop()
})

test('runtime permission change event is reserved for host publication', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, mainCaller)
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, pluginCaller)

  for (const caller of [mainCaller, pluginCaller]) {
    assert.throws(
      () => events.publish({ envelope: envelope({ type: RUNTIME_PERMISSION_CHANGED_EVENT }) }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    assert.throws(
      () => events.request({ envelope: envelope({ type: RUNTIME_PERMISSION_CHANGED_EVENT }) }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  }

  assert.equal(registry.sent.length, 0)
  assert.deepEqual(events.publishHostToOwner(
    RUNTIME_PERMISSION_CHANGED_EVENT,
    { capability: 'screen.capture', revision: 2 },
    pluginCaller
  ), { success: true, delivered: 1 })
  assert.deepEqual(sentEnvelope(registry.sent[0] as SentMessage).source, { kind: 'host' })
  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [pluginCaller.webContentsId])
  events.stop()
})

test('owner host events reach only the captured plugin instance and reject a reused window identity', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const type = 'dllplugin_callback_progress'
  events.subscribe({ key: type }, pluginCaller)
  events.subscribe({ key: type }, secondSamePluginCaller)
  events.subscribe({ key: '*' }, otherPluginCaller)

  assert.deepEqual(events.publishHostToOwner(type, { taskId: 'task_1' }, pluginCaller), {
    success: true,
    delivered: 1
  })
  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [pluginCaller.webContentsId])
  assert.deepEqual(sentEnvelope(registry.sent[0] as SentMessage).target, {
    pluginId: 'test-plugin',
    pluginInstanceId: 'instance-1'
  })

  const reusedWindowCaller = { ...pluginCaller, pluginInstanceId: 'instance-3' }
  events.subscribe({ key: type }, reusedWindowCaller)
  assert.deepEqual(events.publishHostToOwner(type, { taskId: 'task_1' }, pluginCaller), {
    success: true,
    delivered: 0
  })
  assert.deepEqual(events.publishHostToOwner(type, { taskId: 'task_2' }, reusedWindowCaller), {
    success: true,
    delivered: 1
  })
  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [
    pluginCaller.webContentsId,
    pluginCaller.webContentsId
  ])
  events.stop()
})

test('targeted host events distinguish instances of the same plugin', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: 'plugin_enter' }, pluginCaller)
  events.subscribe({ key: 'plugin_enter' }, secondSamePluginCaller)

  assert.deepEqual(events.publishHostToOwner(
    'plugin_enter',
    { instanceId: 'instance-1' },
    pluginCaller
  ), { success: true, delivered: 1 })
  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [pluginCaller.webContentsId])
  assert.deepEqual(sentEnvelope(registry.sent[0] as SentMessage).target, {
    pluginId: 'test-plugin',
    pluginInstanceId: 'instance-1'
  })
  events.stop()
})

test('plugin install lifecycle events are delivered only to subscribed main callers', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const protectedTypes = [
    'plugin_download_progress',
    'plugin_install_complete',
    'plugin_uninstalled'
  ]

  for (const type of protectedTypes) {
    events.subscribe({ key: type }, mainCaller)
    events.subscribe({ key: type }, pluginCaller)
  }
  events.subscribe({ key: '*' }, otherPluginCaller)

  for (const type of protectedTypes) {
    assert.deepEqual(events.publishHostToMain(type, { pluginId: 'plugin.test' }), {
      success: true,
      delivered: 1
    })
  }

  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [
    mainCaller.webContentsId,
    mainCaller.webContentsId,
    mainCaller.webContentsId
  ])
  assert.deepEqual(registry.sent.map((message) => sentEnvelope(message).target), [
    { main: true },
    { main: true },
    { main: true }
  ])
  events.stop()
})

test('plugin exit handshake accepts ACK only from the captured caller generation', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: 'plugin_out' }, pluginCaller)
  const result = events.requestPluginExit(pluginCaller, false, 500)
  const request = sentEnvelope(registry.sent[0] as SentMessage)
  assert.equal(request.type, 'plugin_out')
  assert.deepEqual(request.target, { pluginId: 'test-plugin', pluginInstanceId: 'instance-1' })

  const reusedWindowCaller = { ...pluginCaller, pluginInstanceId: 'instance-3' }
  assert.throws(() => events.publish({ envelope: envelope({
    type: 'events.Ack', replyTo: String(request.envelopeId), payload: { ok: true }
  }) }, reusedWindowCaller), (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
  assert.deepEqual(events.publish({ envelope: envelope({
    type: 'events.Ack', replyTo: String(request.envelopeId), payload: { ok: true }
  }) }, pluginCaller), { success: true, delivered: 1 })
  assert.equal(await result, 'COMPLETED')
  assert.equal(events.diagnostics().pendingRequests, 0)
  events.stop()
})

test('plugin exit handshake settles on owner removal and timeout', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  events.subscribe({ key: 'plugin_out' }, pluginCaller)
  const removed = events.requestPluginExit(pluginCaller, true, 500)
  registry.remove(pluginCaller.webContentsId)
  assert.equal(await removed, 'OWNER_GONE')

  events.subscribe({ key: 'plugin_out' }, pluginCaller)
  const timedOut = events.requestPluginExit(pluginCaller, false, 5)
  assert.equal(await timedOut, 'TIMEOUT')
  assert.equal(events.diagnostics().pendingRequests, 0)
  events.stop()
})
