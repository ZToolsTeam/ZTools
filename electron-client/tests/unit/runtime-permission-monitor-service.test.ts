import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes } from '../../src/contracts/errors.js'
import { RUNTIME_PERMISSION_CHANGED_EVENT } from '../../src/contracts/runtime-capability.js'
import { EventService } from '../../src/main/services/event-service.js'
import { RuntimeCapabilityService } from '../../src/main/services/runtime-capability-service.js'
import { RuntimePermissionMonitorService } from '../../src/main/services/runtime-permission-monitor-service.js'

interface SentMessage {
  webContentsId: number
  value: unknown
}

class FakeRegistry {
  readonly sent: SentMessage[] = []
  readonly #removedListeners = new Set<(webContentsId: number) => void>()

  send(webContentsId: number, _channel: string, value: unknown): boolean {
    this.sent.push({ webContentsId, value })
    return true
  }

  onRemoved(listener: (webContentsId: number) => void): () => void {
    this.#removedListeners.add(listener)
    return () => this.#removedListeners.delete(listener)
  }
}

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = {
  type: 'plugin', webContentsId: 2, pluginId: 'plugin.actual', pluginInstanceId: 'instance.actual'
}
const otherPluginCaller: CallerIdentity = {
  type: 'plugin', webContentsId: 3, pluginId: 'plugin.other', pluginInstanceId: 'instance.other'
}

function sentEnvelope(message: SentMessage): Record<string, unknown> {
  return (message.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
}

function permissionEvents(registry: FakeRegistry): SentMessage[] {
  return registry.sent.filter((message) => sentEnvelope(message).type === RUNTIME_PERMISSION_CHANGED_EVENT)
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

test('subscription establishes a silent baseline and focus publishes only changed revisions', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  let permission: 'not-determined' | 'granted' | 'denied' | 'unknown' = 'unknown'
  const capabilities = new RuntimeCapabilityService([{ id: 'screen.capture' }], {
    getImplementation: () => 'supported',
    getOsPermission: () => permission
  })
  const monitor = new RuntimePermissionMonitorService(events, capabilities)
  monitor.start()
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, mainCaller)

  await monitor.onOwnerSubscribed(mainCaller)
  assert.equal(permissionEvents(registry).length, 0)
  assert.equal((await capabilities.getSnapshot({ capability: 'screen.capture' }, mainCaller)).authorization, 'unknown')

  await monitor.refreshOwner(mainCaller)
  assert.equal(permissionEvents(registry).length, 0)

  permission = 'denied'
  await monitor.refreshOwner(mainCaller)
  permission = 'granted'
  await monitor.refreshOwner(mainCaller)
  await monitor.refreshOwner(mainCaller)
  permission = 'denied'
  await monitor.refreshOwner(mainCaller)

  const sent = permissionEvents(registry)
  assert.equal(sent.length, 3)
  assert.deepEqual(sent.map((message) => (sentEnvelope(message).payload as Record<string, unknown>).capability), [
    'screen.capture', 'screen.capture', 'screen.capture'
  ])
  assert.deepEqual(sent.map((message) => message.webContentsId), [mainCaller.webContentsId, mainCaller.webContentsId, mainCaller.webContentsId])
  assert.ok(sent.every((message) => (sentEnvelope(message).source as Record<string, unknown>).kind === 'host'))
  assert.ok(sent.every((message) => Object.keys(sentEnvelope(message).payload as object).sort().join(',') === 'capability,revision'))

  monitor.stop()
  capabilities.stop()
  events.stop()
})

test('wildcard subscribers receive only their own caller-specific permission revision', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const authorization = new Map<string, 'granted' | 'denied' | 'unknown'>([
    ['plugin.actual', 'denied'], ['plugin.other', 'unknown']
  ])
  const capabilities = new RuntimeCapabilityService([{ id: 'screen.capture' }], {
    getImplementation: () => 'supported',
    getAuthorization: (_capability, caller) => authorization.get(caller.pluginId ?? '') ?? 'unknown',
    getOsPermission: () => 'denied'
  })
  const monitor = new RuntimePermissionMonitorService(events, capabilities)
  monitor.start()
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, pluginCaller)
  events.subscribe({ key: '*' }, otherPluginCaller)
  await Promise.all([
    monitor.onOwnerSubscribed(pluginCaller),
    monitor.onOwnerSubscribed(otherPluginCaller)
  ])
  assert.equal(permissionEvents(registry).length, 0)

  authorization.set('plugin.actual', 'granted')
  await monitor.refreshSubscribedOwners()

  const sent = permissionEvents(registry)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.webContentsId, pluginCaller.webContentsId)
  assert.deepEqual(sentEnvelope(sent[0] as SentMessage).target, { pluginId: pluginCaller.pluginId, pluginInstanceId: pluginCaller.pluginInstanceId })
  monitor.stop()
  capabilities.stop()
  events.stop()
})

test('a focus during an active baseline queues one fresh read instead of losing the change', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const firstRead = deferred<'denied' | 'granted'>()
  let reads = 0
  let permission: 'denied' | 'granted' = 'granted'
  const capabilities = new RuntimeCapabilityService([{ id: 'screen.capture' }], {
    getImplementation: () => 'supported',
    getOsPermission: () => {
      reads += 1
      return reads === 1 ? firstRead.promise : permission
    }
  })
  const monitor = new RuntimePermissionMonitorService(events, capabilities, { queryTimeoutMs: 1_000 })
  monitor.start()
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, mainCaller)
  const baseline = monitor.onOwnerSubscribed(mainCaller)
  permission = 'granted'
  firstRead.resolve('denied')
  await baseline

  assert.ok(reads >= 2)
  assert.equal(permissionEvents(registry).length, 1)
  monitor.stop()
  capabilities.stop()
  events.stop()
})

test('monitor timeout is bounded when a permission provider ignores abort, and late reads do not publish', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const lateRead = deferred<'denied' | 'granted'>()
  let hang = true
  const capabilities = new RuntimeCapabilityService([{ id: 'screen.capture' }], {
    getImplementation: () => 'supported',
    getOsPermission: () => hang ? lateRead.promise : 'granted'
  })
  const monitor = new RuntimePermissionMonitorService(events, capabilities, { queryTimeoutMs: 10 })
  monitor.start()
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, mainCaller)

  const started = Date.now()
  await monitor.onOwnerSubscribed(mainCaller)
  assert.ok(Date.now() - started < 2_000)
  lateRead.resolve('denied')
  hang = false
  await monitor.refreshOwner(mainCaller)
  assert.equal(permissionEvents(registry).length, 0)
  const current = await capabilities.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  assert.equal(current.osPermission, 'granted')

  monitor.stop()
  capabilities.stop()
  events.stop()
})

test('closing an owner aborts its monitor refresh and stop releases every subscription', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const started = deferred<boolean>()
  const lateRead = deferred<'denied' | 'granted'>()
  const capabilities = new RuntimeCapabilityService([{ id: 'screen.capture' }], {
    getImplementation: () => 'supported',
    getOsPermission: () => {
      started.resolve(true)
      return lateRead.promise
    }
  })
  const monitor = new RuntimePermissionMonitorService(events, capabilities, { queryTimeoutMs: 1_000 })
  monitor.start()
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, mainCaller)
  const pending = monitor.onOwnerSubscribed(mainCaller)
  await started.promise
  monitor.closeOwner(mainCaller.webContentsId)
  await pending
  lateRead.resolve('granted')
  assert.equal(permissionEvents(registry).length, 0)

  monitor.stop()
  events.subscribe({ key: RUNTIME_PERMISSION_CHANGED_EVENT }, pluginCaller)
  assert.equal(permissionEvents(registry).length, 0)
  await monitor.refreshOwner(pluginCaller)
  assert.equal(permissionEvents(registry).length, 0)
  capabilities.stop()
  events.stop()
})
