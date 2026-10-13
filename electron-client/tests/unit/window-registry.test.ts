import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Session, WebContents } from 'electron'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class FakeWebContents extends EventEmitter {
  readonly session = {} as Session
  #destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.#destroyed
  }

  markDestroyedWithoutEvent(): void {
    this.#destroyed = true
  }

  send(): void {}

  destroy(): void {
    this.#destroyed = true
    this.emit('destroyed')
  }
}

function asWebContents(contents: FakeWebContents): WebContents {
  return contents as unknown as WebContents
}

test('plugin registration binds trusted plugin and instance identity to WebContents', () => {
  const registry = new WindowRegistry()
  const contents = new FakeWebContents(21)
  const identity = registry.registerPlugin(asWebContents(contents), 'todo', 'todo-instance-1')

  assert.deepEqual(identity, {
    type: 'plugin',
    webContentsId: 21,
    pluginId: 'todo',
    pluginInstanceId: 'todo-instance-1'
  })
  assert.deepEqual(registry.get(21), identity)
  assert.equal(registry.getSdkApiLane(identity), 1)
  assert.equal(Object.hasOwn(identity, 'sdkApiLane'), false)
  assert.equal(registry.getSession(21), contents.session)

  contents.destroy()
  assert.equal(registry.get(21), undefined)
  assert.equal(registry.getSdkApiLane(identity), undefined)
})

test('the same WebContents cannot be registered with a second identity', () => {
  const registry = new WindowRegistry()
  const contents = new FakeWebContents(22)
  registry.registerMain(asWebContents(contents))
  assert.throws(
    () => registry.registerPlugin(asWebContents(contents), 'todo', 'todo-instance-2'),
    /WebContents 已注册/u
  )
})

test('registration accepts only a lane supported by this host and never stores it on CallerIdentity', () => {
  const registry = new WindowRegistry({ hostMaximumSdkContractVersion: 2 })
  const contents = new FakeWebContents(23)
  const identity = registry.registerPlugin(asWebContents(contents), 'image-tool', 'image-tool-instance', 2)
  assert.equal(registry.getSdkApiLane(identity), 2)
  assert.deepEqual(Object.keys(identity).sort(), ['pluginId', 'pluginInstanceId', 'type', 'webContentsId'])

  const forgedField = { ...identity, sdkApiLane: 1 } as typeof identity
  assert.equal(registry.getSdkApiLane(forgedField), 2)
  assert.equal(registry.getSdkApiLane({ ...identity, pluginInstanceId: 'other-instance' }), undefined)
  assert.equal(registry.getSdkApiLane({ ...identity, webContentsId: 999 }), undefined)
  assert.equal((registry as unknown as { setSdkApiLane?: unknown }).setSdkApiLane, undefined)
})

test('the production registry keeps the main window on lane 1 and accepts its selected lane 2 plugin', () => {
  const registry = new WindowRegistry()
  const mainContents = new FakeWebContents(24)
  const mainIdentity = registry.registerMain(asWebContents(mainContents))
  assert.equal(registry.getSdkApiLane(mainIdentity), 1)

  const pluginContents = new FakeWebContents(25)
  const pluginIdentity = registry.registerPlugin(asWebContents(pluginContents), 'image-tool', 'image-tool-instance', 2)
  assert.equal(registry.getSdkApiLane(pluginIdentity), 2)
})

test('a stale destroyed generation cannot remove or impersonate a reused WebContents lane', () => {
  const registry = new WindowRegistry({ hostMaximumSdkContractVersion: 2 })
  const oldContents = new FakeWebContents(25)
  const oldIdentity = registry.registerPlugin(asWebContents(oldContents), 'image-tool', 'old-generation', 1)

  oldContents.markDestroyedWithoutEvent()
  assert.equal(registry.getSdkApiLane(oldIdentity), undefined)

  const newContents = new FakeWebContents(25)
  const newIdentity = registry.registerPlugin(asWebContents(newContents), 'image-tool', 'new-generation', 2)
  oldContents.emit('destroyed')

  assert.equal(registry.get(25)?.pluginInstanceId, 'new-generation')
  assert.equal(registry.getSdkApiLane(oldIdentity), undefined)
  assert.equal(registry.getSdkApiLane(newIdentity), 2)
})

test('registry clear deletes all lane metadata', () => {
  const registry = new WindowRegistry({ hostMaximumSdkContractVersion: 2 })
  const identity = registry.registerPlugin(asWebContents(new FakeWebContents(26)), 'todo', 'todo-instance', 2)
  registry.clear()
  assert.equal(registry.getSdkApiLane(identity), undefined)
})

test('a throwing removal listener does not prevent later listeners from receiving destroyed-owner cleanup', (t) => {
  const reports: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => reports.push(args))

  const registry = new WindowRegistry({ hostMaximumSdkContractVersion: 2 })
  const contents = new FakeWebContents(27)
  const identity = registry.registerPlugin(asWebContents(contents), 'todo', 'todo-instance', 2)
  const notified: number[] = []
  registry.onRemoved(() => { throw new Error('first listener failed') })
  registry.onRemoved((webContentsId) => notified.push(webContentsId))

  contents.destroy()

  assert.deepEqual(notified, [27])
  assert.equal(registry.getSdkApiLane(identity), undefined)
  assert.equal(reports.length, 1)
  assert.ok(reports[0]?.[1] instanceof AggregateError)
  assert.equal((reports[0]?.[1] as AggregateError).errors.length, 1)
})

test('clear notifies every owner and clears listeners before reporting failures; repeated clear is harmless', (t) => {
  const reports: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => reports.push(args))

  const registry = new WindowRegistry({ hostMaximumSdkContractVersion: 2 })
  const first = registry.registerPlugin(asWebContents(new FakeWebContents(28)), 'todo', 'first-instance', 2)
  const second = registry.registerPlugin(asWebContents(new FakeWebContents(29)), 'todo', 'second-instance', 2)
  const notified: number[] = []
  registry.onRemoved(() => { throw new Error('first listener failed') })
  registry.onRemoved((webContentsId) => notified.push(webContentsId))

  registry.clear()

  assert.deepEqual(notified, [28, 29])
  assert.equal(registry.getSdkApiLane(first), undefined)
  assert.equal(registry.getSdkApiLane(second), undefined)
  assert.equal(reports.length, 1)
  assert.ok(reports[0]?.[1] instanceof AggregateError)
  assert.equal((reports[0]?.[1] as AggregateError).errors.length, 2)

  assert.doesNotThrow(() => registry.clear())
  const afterClear = new FakeWebContents(30)
  registry.registerPlugin(asWebContents(afterClear), 'todo', 'after-clear', 2)
  afterClear.destroy()
  assert.deepEqual(notified, [28, 29])
  assert.equal(reports.length, 1)
})
