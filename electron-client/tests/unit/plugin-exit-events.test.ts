import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { EventEnvelope } from '../../src/contracts/method-params.js'
import { EventService } from '../../src/main/services/event-service.js'

const owner: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: 'calculator', pluginInstanceId: 'one' }
const sibling: CallerIdentity = { ...owner, webContentsId: 3, pluginInstanceId: 'two' }

function setup() {
  const sent: Array<{ id: number; envelope: EventEnvelope }> = []
  let removed: (id: number) => void = () => {}
  const registry = {
    send(id: number, _channel: string, value: unknown) {
      sent.push({ id, envelope: (value as { msgData: { envelope: EventEnvelope } }).msgData.envelope })
      return true
    },
    onRemoved(callback: (id: number) => void) { removed = callback; return () => { removed = () => {} } }
  }
  const events = new EventService(registry)
  const reply = (requestId: string, caller: CallerIdentity, payload: unknown = { ok: true }) => events.publish({
    envelope: { envelopeId: 'renderer_reply', version: 'v1', timestamp: 1, type: 'events.Ack',
      scope: 'plugin', source: { kind: 'page' }, target: { broadcast: true }, payload, replyTo: requestId }
  }, caller)
  return { events, sent, reply, remove: (id: number) => removed(id) }
}

test('exit acknowledgement is one-shot and bound to the exact subscribed instance', async () => {
  const context = setup()
  context.events.subscribe({ key: 'plugin_out' }, owner)
  context.events.subscribe({ key: '*' }, sibling)
  const completion = context.events.requestPluginExit(owner, false)
  const message = context.sent[0]
  assert.ok(message)
  assert.deepEqual(context.sent.map(item => item.id), [owner.webContentsId])
  assert.deepEqual(message.envelope.source, { kind: 'host' })
  assert.deepEqual(message.envelope.payload, { isKill: false })
  assert.throws(() => context.reply(message.envelope.envelopeId, sibling), { code: 'PERMISSION_DENIED' })
  assert.throws(() => context.reply(message.envelope.envelopeId, { ...owner, pluginInstanceId: 'replacement' }), { code: 'PERMISSION_DENIED' })
  context.reply(message.envelope.envelopeId, owner)
  assert.equal(await completion, 'COMPLETED')
  assert.equal(context.events.diagnostics().pendingRequests, 0)
  assert.throws(() => context.reply(message.envelope.envelopeId, owner), { code: 'INVALID_REQUEST' })
  context.events.stop()
})

test('malformed acknowledgement cannot complete exit and callback failure is preserved', async () => {
  const context = setup()
  context.events.subscribe({ key: 'plugin_out' }, owner)
  const completion = context.events.requestPluginExit(owner, true)
  const id = context.sent[0]!.envelope.envelopeId
  assert.throws(() => context.reply(id, owner, { ok: 'true' }), { code: 'INVALID_REQUEST' })
  assert.equal(context.events.diagnostics().pendingRequests, 1)
  context.reply(id, owner, { ok: false, secret: 'not-returned' })
  assert.equal(await completion, 'CALLBACK_FAILED')
  context.events.stop()
})

test('timeout, owner removal and service stop settle the request and release timers', async () => {
  for (const operation of ['timeout', 'remove', 'stop'] as const) {
    const context = setup()
    context.events.subscribe({ key: 'plugin_out' }, owner)
    const completion = context.events.requestPluginExit(owner, false, 10)
    if (operation === 'remove') context.remove(owner.webContentsId)
    if (operation === 'stop') context.events.stop()
    assert.equal(await completion, operation === 'timeout' ? 'TIMEOUT' : operation === 'remove' ? 'OWNER_GONE' : 'STOPPED')
    assert.equal(context.events.diagnostics().pendingRequests, 0)
    context.events.stop()
  }
})

test('lifecycle notifications reject renderer publication, broadcast and unbounded waits', async () => {
  const context = setup()
  context.events.subscribe({ key: 'unrelated' }, owner)
  assert.equal(await context.events.requestPluginExit(owner, false), 'NO_SUBSCRIBERS')
  assert.equal(await context.events.requestPluginExit(sibling, false), 'OWNER_GONE')
  for (const type of ['plugin_out', 'plugin_enter']) {
    const envelope: EventEnvelope = { envelopeId: 'fake', version: 'v1', timestamp: 0, type, scope: 'plugin', source: { kind: 'page' }, target: { broadcast: true }, payload: {} }
    assert.throws(() => context.events.publish({ envelope }, owner), { code: 'PERMISSION_DENIED' })
    assert.throws(() => context.events.request({ envelope }, owner), { code: 'PERMISSION_DENIED' })
    assert.throws(() => context.events.publishHost(type, {}), { code: 'PERMISSION_DENIED' })
  }
  for (const timeout of [0, -1, 2001, Infinity]) {
    assert.throws(() => context.events.requestPluginExit(owner, false, timeout), { code: 'INVALID_REQUEST' })
  }
  assert.throws(() => context.events.requestPluginExit(owner, 'false' as unknown as boolean), { code: 'INVALID_REQUEST' })
  assert.equal(context.sent.length, 0)
  context.events.stop()
})

test('undeliverable exit request releases its pending entry immediately', async () => {
  const events = new EventService({ send: () => false, onRemoved: () => () => {} })
  events.subscribe({ key: 'plugin_out' }, owner)
  assert.equal(await events.requestPluginExit(owner, false), 'OWNER_GONE')
  assert.equal(events.diagnostics().pendingRequests, 0)
  events.stop()
})
