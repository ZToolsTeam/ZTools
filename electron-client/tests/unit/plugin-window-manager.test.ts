import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow, Session } from 'electron'
import type {
  PluginManifest,
  PluginManifestRuntimeMetadata
} from '../../src/main/services/plugin-install-service.js'
import {
  normalizePluginWindowConfig,
  PluginWindowManager,
  type PluginWindowEventPublisher,
  type PluginManifestProvider,
  type PluginWindowManagerOptions} from '../../src/main/windows/plugin-window-manager.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import type { PluginSessionProvider } from '../../src/main/windows/plugin-session-manager.js'
import type { PluginStateProvider } from '../../src/main/services/plugin-state-service.js'
import { EventService } from '../../src/main/services/event-service.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'

let nextWebContentsId = 100
const originalConsoleInfo = console.info
const originalConsoleError = console.error

test.before(() => {
  console.info = () => undefined
  console.error = () => undefined
})

test.after(() => {
  console.info = originalConsoleInfo
  console.error = originalConsoleError
})

class FakeWebContents extends EventEmitter {
  readonly id = nextWebContentsId++
  readonly scripts: string[] = []
  windowOpenHandler: (() => { action: 'deny' }) | undefined

  audioMuted = false
  backgroundThrottling = false

  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted
  }

  setBackgroundThrottling(throttling: boolean): void {
    this.backgroundThrottling = throttling
  }

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.windowOpenHandler = handler
  }

  async executeJavaScript(source: string): Promise<unknown> {
    this.scripts.push(source)
    return undefined
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  readonly loadedUrls: string[] = []
  destroyed = false
  minimized = false
  shown = 0
  focused = 0
  restored = 0
  maximized = false
  bounds = { x: 120, y: 100, width: 980, height: 620 }
  loadError: Error | undefined
  loadGate: Promise<void> | undefined

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url)
    if (this.loadGate) await this.loadGate
    if (this.loadError) throw this.loadError
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  restore(): void {
    this.minimized = false
    this.restored += 1
    this.emit('restore')
  }

  show(): void {
    this.shown += 1
    this.emit('show')
  }

  hide(): void {
    this.emit('hide')
  }

  maximize(): void {
    if (this.maximized) return
    this.maximized = true
    this.emit('maximize')
  }

  unmaximize(): void {
    if (!this.maximized) return
    this.maximized = false
    this.emit('unmaximize')
  }

  isMaximized(): boolean {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    return this.maximized
  }

  getNormalBounds(): Electron.Rectangle {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    return { ...this.bounds }
  }

  focus(): void {
    this.focused += 1
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'plugin.test',
    name: '测试插件',
    version: '1.0.0',
    entry: 'pages/index.html',
    dllloader: '',
    requireAdmin: false,
    commonLibs: [],
    enabled: true,
    window: {
      width: 980,
      height: 620,
      minWidth: 820,
      minHeight: 520,
      resizable: true,
      controls: { minimize: true, maximize: true },
      singleInstance: true
    },
    ...overrides
  }
}

function provider(
  value: PluginManifest,
  runtimeMetadata?: PluginManifestRuntimeMetadata
): PluginManifestProvider {
  return {
    async withPluginManifest<T>(
      pluginId: string,
      action: (pluginManifest: PluginManifest, metadata?: PluginManifestRuntimeMetadata) => Promise<T>
    ): Promise<T> {
      assert.equal(pluginId, value.id)
      return runtimeMetadata ? action(value, runtimeMetadata) : action(value)
    }
  }
}

function sessionProvider(value: Session = {} as Session): PluginSessionProvider {
  return {
    async get(): Promise<Session> {
      return value
    }
  }
}

function stateProvider(
  enabled: boolean,
  document: Record<string, unknown> = {}
): PluginStateProvider {
  return {
    async readAll() { return document },
    async isEnabled(pluginId) {
      const value = document[pluginId]
      return typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).enabled === 'boolean'
        ? (value as Record<string, unknown>).enabled as boolean
        : enabled
    },
    async toggleEnabled() { return enabled },
    async markUsed() {},
    async setIconUrl() {},
    async update(pluginId, mutate) {
      const current = document[pluginId]
      const next = typeof current === 'object' && current !== null && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
      mutate(next)
      document[pluginId] = next
    }
  }
}

function createFakeEvents(): {
  publisher: PluginWindowEventPublisher
  published: Array<{ type: string; payload: unknown; owner?: CallerIdentity }>
} {
  const published: Array<{ type: string; payload: unknown; owner?: CallerIdentity }> = []
  return {
    published,
    publisher: {
      publishHost(type, payload) {
        published.push({ type, payload })
        return { success: true, delivered: 1 }
      },
      publishHostToOwner(type, payload, owner) {
        published.push({ type, payload, owner })
        return { success: true, delivered: 1 }
      }
    }
  }
}

function setup(
  value: PluginManifest = manifest(),
  extra: {
    sdkApiLane?: PluginManifestRuntimeMetadata['sdkApiLane']
    macNativeComponents?: PluginManifestRuntimeMetadata['macNativeComponents']
    state?: PluginStateProvider
    events?: PluginWindowEventPublisher
    sessions?: PluginSessionProvider
    suspendTimeoutMs?: number
    maxActiveBackgroundPlugins?: number
    onPluginSuspend?: (pluginId: string, instanceId: string) => void
    onPluginResume?: (pluginId: string, instanceId: string) => void
    onPluginCrash?: (pluginId: string, instanceId: string, details: { reason: string; exitCode: number }) => void
  } = {},
  requestExit?: PluginWindowManagerOptions['requestExit']
) {
  const windows: FakeWindow[] = []
  const options: Electron.BrowserWindowConstructorOptions[] = []
  const registrations: Array<{ pluginId: string; instanceId: string; webContentsId: number; sdkApiLane: number }> = []
  const pluginSession = {} as Session
  const registry = {
    registerPlugin(webContents: FakeWebContents, pluginId: string, instanceId: string, sdkApiLane = 1) {
      registrations.push({ pluginId, instanceId, webContentsId: webContents.id, sdkApiLane })
    }
  } as unknown as WindowRegistry
  const defaultFakeEvents = createFakeEvents()
  const events = extra.events ?? defaultFakeEvents.publisher
  const manager = new PluginWindowManager({
    registry,
    manifests: provider(value, extra.sdkApiLane === undefined ? undefined : {
      sdkApiLane: extra.sdkApiLane,
      ...(extra.macNativeComponents !== undefined ? { macNativeComponents: extra.macNativeComponents } : {})
    }),
    sessions: extra.sessions ?? sessionProvider(pluginSession),
    events,
    ...(requestExit ? { requestExit } : {}),
    ...(extra.state ? { state: extra.state } : {}),
    ...(extra.suspendTimeoutMs !== undefined ? { suspendTimeoutMs: extra.suspendTimeoutMs } : {}),
    ...(extra.maxActiveBackgroundPlugins !== undefined ? { maxActiveBackgroundPlugins: extra.maxActiveBackgroundPlugins } : {}),
    ...(extra.onPluginSuspend ? { onPluginSuspend: extra.onPluginSuspend } : {}),
    ...(extra.onPluginResume ? { onPluginResume: extra.onPluginResume } : {}),
    ...(extra.onPluginCrash ? { onPluginCrash: extra.onPluginCrash } : {}),
    createWindow(windowOptions) {
      options.push(windowOptions)
      const window = new FakeWindow()
      windows.push(window)
      return window as unknown as BrowserWindow
    }
  })
  return { manager, windows, options, registrations, pluginSession, events: defaultFakeEvents }
}

test('creates, registers and displays a plugin window with startup payload', async () => {
  const context = setup()
  const result = await context.manager.open({
    pluginId: 'plugin.test',
    payload: { source: 'unit-test' }
  })

  assert.equal(result.success, true)
  assert.equal(result.windowInstanceStatus, 'created')
  assert.equal(context.windows.length, 1)
  assert.equal(context.options[0]?.width, 980)
  assert.equal(context.options[0]?.minWidth, 820)
  assert.equal(context.options[0]?.webPreferences?.session, context.pluginSession)
  assert.equal(context.windows[0]?.loadedUrls[0], 'ztools://plugins/plugin.test/pages/index.html')
  assert.equal(context.windows[0]?.shown, 1)
  assert.equal(context.windows[0]?.focused, 1)
  assert.equal(context.registrations[0]?.pluginId, 'plugin.test')
  assert.equal(context.registrations[0]?.instanceId, result.instanceId)
  assert.equal(context.registrations[0]?.sdkApiLane, 1, 'legacy test providers without metadata remain lane 1')
  assert.ok(context.windows[0]?.webContents.scripts.some((source) => /ztools:startup-payload/.test(source)))
  assert.ok(context.windows[0]?.webContents.scripts.some((source) => /unit-test/.test(source)))
  let prevented = 0
  const navigationEvent = { preventDefault: () => { prevented += 1 } }
  context.windows[0]?.webContents.emit(
    'will-navigate',
    navigationEvent,
    'ztools://plugins/plugin.test/pages/next.html'
  )
  assert.equal(prevented, 0)
  context.windows[0]?.webContents.emit('will-navigate', navigationEvent, 'https://example.invalid/')
  assert.equal(prevented, 1)
  context.windows[0]?.webContents.emit('will-attach-webview', navigationEvent)
  assert.equal(prevented, 2)
  assert.deepEqual(context.windows[0]?.webContents.windowOpenHandler?.(), { action: 'deny' })
  await context.manager.stop()
})

test('forwards the selected Main lane only when registering a new window; reuse keeps its existing lane', async () => {
  const context = setup(manifest(), { sdkApiLane: 2 })
  const first = await context.manager.open({ pluginId: 'plugin.test' })
  const reused = await context.manager.open({ pluginId: 'plugin.test' })

  assert.equal(context.registrations.length, 1)
  assert.equal(context.registrations[0]?.sdkApiLane, 2)
  assert.equal(reused.windowInstanceStatus, 'reused')
  assert.equal(reused.instanceId, first.instanceId)
  await context.manager.stop()
})

test('serializes concurrent opens and reuses a single-instance window', async () => {
  const windows: FakeWindow[] = []
  let releaseLoad = (): void => undefined
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
  const manager = new PluginWindowManager({
    registry: { registerPlugin() {} } as unknown as WindowRegistry,
    manifests: provider(manifest()),
    sessions: sessionProvider(),
    createWindow() {
      const window = new FakeWindow()
      window.loadGate = loadGate
      windows.push(window)
      return window as unknown as BrowserWindow
    }
  })
  const first = manager.open({ pluginId: 'plugin.test' })
  const second = manager.open({ pluginId: 'plugin.test', payload: { second: true } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const window = windows[0]
  assert.ok(window)
  releaseLoad()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(windows.length, 1)
  assert.equal(firstResult.windowInstanceStatus, 'created')
  assert.equal(secondResult.windowInstanceStatus, 'reused')
  assert.equal(secondResult.instanceId, firstResult.instanceId)
  assert.equal(window.shown, 2)
  assert.ok(window.webContents.scripts.some((source) => /second/.test(source)))
  await manager.stop()
})

test('closes only the requested instance and preserves close-all behavior', async () => {
  const context = setup(manifest({ window: { singleInstance: false } }))
  const first = await context.manager.open({ pluginId: 'plugin.test' })
  const second = await context.manager.open({ pluginId: 'plugin.test' })

  assert.notEqual(first.instanceId, second.instanceId)
  const closedFirst = await context.manager.closePlugin('plugin.test', first.instanceId)
  assert.deepEqual(closedFirst, { success: true, closed: 1 })
  assert.equal(context.windows[0]?.destroyed, true)
  assert.equal(context.windows[1]?.destroyed, false)

  assert.deepEqual(await context.manager.closePlugin('plugin.test', first.instanceId), { success: true, closed: 0 })
  assert.deepEqual(await context.manager.closePlugin('plugin.test', '11111111-1111-4111-8111-111111111111'), {
    success: true, closed: 0
  })
  assert.deepEqual(await context.manager.closePlugin('plugin.unknown'), { success: true, closed: 0 })

  assert.deepEqual(await context.manager.closePlugin('plugin.test'), { success: true, closed: 1 })
  assert.equal(context.windows[1]?.destroyed, true)
  assert.deepEqual(await context.manager.closePlugin('plugin.test'), { success: true, closed: 0 })
  await context.manager.stop()
})

test('serializes close behind an in-flight open for the same plugin', async () => {
  const windows: FakeWindow[] = []
  let releaseLoad = (): void => undefined
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
  const manager = new PluginWindowManager({
    registry: { registerPlugin() {} } as unknown as WindowRegistry,
    manifests: provider(manifest()),
    createWindow() {
      const window = new FakeWindow()
      window.loadGate = loadGate
      windows.push(window)
      return window as unknown as BrowserWindow
    }
  })

  const opening = manager.open({ pluginId: 'plugin.test' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const closing = manager.closePlugin('plugin.test')
  releaseLoad()

  const [opened, closed] = await Promise.all([opening, closing])
  assert.equal(opened.windowInstanceStatus, 'created')
  assert.deepEqual(closed, { success: true, closed: 1 })
  assert.equal(windows[0]?.destroyed, true)
  await manager.stop()
})

test('destroys a failed window and permits a later retry', async () => {
  const windows: FakeWindow[] = []
  const registry = { registerPlugin() {} } as unknown as WindowRegistry
  const manager = new PluginWindowManager({
    registry,
    manifests: provider(manifest()),
    sessions: sessionProvider(),
    createWindow() {
      const window = new FakeWindow()
      if (windows.length === 0) window.loadError = new Error('injected load failure')
      windows.push(window)
      return window as unknown as BrowserWindow
    }
  })

  await assert.rejects(manager.open({ pluginId: 'plugin.test' }), { code: 'PLUGIN_PACKAGE_INVALID' })
  assert.equal(windows[0]?.destroyed, true)
  const retried = await manager.open({ pluginId: 'plugin.test' })
  assert.equal(retried.windowInstanceStatus, 'created')
  assert.equal(windows.length, 2)
  await manager.stop()
})

test('validates plugin window dimensions and control values', () => {
  assert.throws(
    () => normalizePluginWindowConfig(manifest({ window: { width: 100 } })),
    { code: 'PLUGIN_PACKAGE_INVALID' }
  )
  assert.throws(
    () => normalizePluginWindowConfig(manifest({ window: { controls: { maximize: 'yes' } } })),
    { code: 'PLUGIN_PACKAGE_INVALID' }
  )
})

test('normal close waits for exact owner and repeated system close does not run exit twice', async () => {
  let finish!: (status: 'COMPLETED') => void
  const calls: Array<{ owner: unknown; isKill: boolean }> = []
  const context = setup(manifest(), undefined, (owner, isKill) => {
    calls.push({ owner, isKill })
    return new Promise(resolve => { finish = resolve })
  })
  const opened = await context.manager.open({ pluginId: 'plugin.test' })
  const closing = context.manager.closePlugin('plugin.test')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(context.windows[0]!.destroyed, false)
  let prevented = 0
  context.windows[0]!.emit('close', { preventDefault() { prevented++ } })
  assert.equal(prevented, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { owner: { type: 'plugin', webContentsId: context.windows[0]!.webContents.id,
    pluginId: 'plugin.test', pluginInstanceId: opened.instanceId }, isKill: false })
  finish('COMPLETED')
  await closing
  assert.equal(context.windows[0]!.destroyed, true)
  await context.manager.stop()
})

test('system close uses the same asynchronous exit path', async () => {
  let calls = 0
  const context = setup(manifest(), undefined, async () => { calls++; return 'COMPLETED' })
  await context.manager.open({ pluginId: 'plugin.test' })
  let prevented = false
  context.windows[0]!.emit('close', { preventDefault() { prevented = true } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(prevented, true)
  assert.equal(calls, 1)
  assert.equal(context.windows[0]!.destroyed, true)
  await context.manager.stop()
})

test('stop drains multiple instances concurrently and denies new opens', async () => {
  const finish: Array<(status: 'COMPLETED') => void> = []
  const context = setup(manifest({ window: { singleInstance: false } }), undefined, (_owner, isKill) => {
    assert.equal(isKill, true)
    return new Promise(resolve => { finish.push(resolve) })
  })
  await context.manager.open({ pluginId: 'plugin.test' })
  await context.manager.open({ pluginId: 'plugin.test' })
  const stopping = context.manager.stop()
  assert.equal(context.manager.stop(), stopping)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(finish.length, 2)
  await assert.rejects(context.manager.open({ pluginId: 'plugin.test' }), { code: 'APP_STOPPING' })
  finish.forEach(resolve => resolve('COMPLETED'))
  await stopping
  assert.ok(context.windows.every(window => window.destroyed))
})

test('an unresponsive exit has a bounded deadline and still closes its owned window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const context = setup(manifest(), undefined, () => new Promise(() => {}))
  await context.manager.open({ pluginId: 'plugin.test' })
  const closing = context.manager.closePlugin('plugin.test')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(context.windows[0]!.destroyed, false)
  t.mock.timers.tick(2000)
  await closing
  assert.equal(context.windows[0]!.destroyed, true)
  await context.manager.stop()
})

test('callback rejection closes the window while a renderer crash never runs exit callbacks', async () => {
  let calls = 0
  const context = setup(manifest(), undefined, async () => { calls++; throw new Error('synthetic callback failure') })
  await context.manager.open({ pluginId: 'plugin.test' })
  await context.manager.closePlugin('plugin.test')
  assert.equal(context.windows[0]!.destroyed, true)
  await context.manager.open({ pluginId: 'plugin.test' })
  context.windows[1]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(context.windows[1]!.destroyed, true)
  assert.equal(calls, 1)
  await context.manager.stop()
})


test('a crash during an outstanding exit settles without waiting for its deadline', async () => {
  const context = setup(manifest(), undefined, () => new Promise(() => {}))
  await context.manager.open({ pluginId: 'plugin.test' })
  const closing = context.manager.closePlugin('plugin.test')
  await new Promise<void>(resolve => setImmediate(resolve))
  context.windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await closing
  assert.equal(context.windows[0]!.destroyed, true)
  assert.equal(context.windows[0]!.listenerCount('closed'), 0)
  await context.manager.stop()
})


test('uses legacy top-level window fields first and defaults to multi-instance', () => {
  const config = normalizePluginWindowConfig(manifest({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    resizable: false,
    singleInstance: false,
    window: {
      width: 900,
      height: 600,
      minWidth: 320,
      minHeight: 240,
      resizable: true,
      singleInstance: true,
      controls: { minimize: true, maximize: true }
    }
  }))
  assert.deepEqual(config, {
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    resizable: false,
    minimizable: true,
    maximizable: false,
    closable: true,
    singleInstance: false
  })

  const withoutWindow = manifest()
  delete (withoutWindow as Record<string, unknown>).window
  assert.equal(normalizePluginWindowConfig(withoutWindow).singleInstance, false)
})

test('blocks persisted disabled plugins before reusing a window', async () => {
  const manager = new PluginWindowManager({
    registry: { registerPlugin() {} } as unknown as WindowRegistry,
    manifests: provider(manifest()),
    sessions: sessionProvider(),
    state: stateProvider(false)
  })
  await assert.rejects(manager.open({ pluginId: 'plugin.test' }), { code: 'PLUGIN_NOT_FOUND' })
  await manager.stop()
})

test('allows a persisted enabled override to open a manifest-disabled plugin', async () => {
  const context = setup(manifest({ enabled: false }), {
    state: stateProvider(false, { 'plugin.test': { enabled: true } })
  })
  const result = await context.manager.open({ pluginId: 'plugin.test' })
  assert.equal(result.success, true)
  assert.equal(context.windows.length, 1)
  await context.manager.stop()
})

test('closes one plugin window by instance id', async () => {
  const context = setup(manifest({ window: { singleInstance: false } }))
  const first = await context.manager.open({ pluginId: 'plugin.test' })
  const second = await context.manager.open({ pluginId: 'plugin.test' })
  assert.notEqual(first.instanceId, second.instanceId)
  assert.deepEqual(await context.manager.close('plugin.test', first.instanceId), { success: true, closed: 1 })
  await new Promise<void>((resolve) => setTimeout(resolve, 350))
  assert.equal(context.windows[0]?.destroyed, true)
  assert.equal(context.windows[1]?.destroyed, false)
  await context.manager.stop()
})

test('publishes instance-scoped lifecycle and host events without duplicates', async () => {
  const targeted: Array<{ type: string; payload: Record<string, unknown>; instanceId: string | undefined }> = []
  const host: Array<{ type: string; payload: Record<string, unknown> }> = []
  const events: PluginWindowEventPublisher = {
    publishHost(type, payload) {
      host.push({ type, payload: payload as Record<string, unknown> })
      return { success: true, delivered: 1 }
    },
    publishHostToOwner(type, payload, owner) {
      targeted.push({ type, payload: payload as Record<string, unknown>, instanceId: owner.pluginInstanceId })
      return { success: true, delivered: 1 }
    }
  }
  const exits: Array<{ instanceId: string | undefined; isKill: boolean }> = []
  const context = setup(manifest({ window: { singleInstance: false } }), { events },
    async (owner, isKill) => { exits.push({ instanceId: owner.pluginInstanceId, isKill }); return 'COMPLETED' })
  const first = await context.manager.open({ pluginId: 'plugin.test', payload: { from: 'open' } })
  const second = await context.manager.open({ pluginId: 'plugin.test' })
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(targeted.filter((event) => event.type === 'plugin_enter').length, 2)
  assert.deepEqual(
    targeted.filter((event) => event.type === 'plugin_enter').map((event) => event.instanceId),
    [first.instanceId, second.instanceId]
  )

  context.windows[0]?.hide()
  context.windows[0]?.show()
  assert.deepEqual(
    targeted.filter((event) => event.type === 'plugin_enter').map((event) => event.payload.windowInstanceStatus),
    ['created', 'created', 'reused']
  )
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(exits, [{ instanceId: first.instanceId, isKill: false }])
  assert.deepEqual(await context.manager.close('plugin.test', first.instanceId), { success: true, closed: 1 })
  assert.deepEqual(exits, [
    { instanceId: first.instanceId, isKill: false }, { instanceId: first.instanceId, isKill: false }
  ])
  assert.equal(targeted.filter(event => event.type === 'plugin_out').length, 0)
  assert.deepEqual(host.map((event) => event.type), ['plugin_opened', 'plugin_opened', 'plugin_closed'])
  await context.manager.stop()
})

test('delivers plugin enter through the real owner-only EventService without another instance or Main receiving it', async () => {
  const sent: Array<{ webContentsId: number; value: { type?: string; payload?: unknown } }> = []
  const events = new EventService({
    send(webContentsId, _channel, value) {
      const message = value as { msgType?: string; msgData?: { envelope?: { type?: string; payload?: unknown } } }
      assert.equal(message.msgType, 'event_envelope')
      assert.ok(message.msgData?.envelope)
      sent.push({ webContentsId, value: message.msgData.envelope })
      return true
    },
    onRemoved() { return () => undefined }
  })
  const unrelatedOwners: CallerIdentity[] = [
    { type: 'main', webContentsId: 1 },
    { type: 'plugin', webContentsId: 2, pluginId: 'plugin.test', pluginInstanceId: 'other-instance' }
  ]
  for (const owner of unrelatedOwners) events.subscribe({ key: 'plugin_enter' }, owner)
  const capturedOwners: CallerIdentity[] = []
  const publisher: PluginWindowEventPublisher = {
    publishHost: (type, payload) => events.publishHost(type, payload),
    publishHostToOwner(type, payload, owner) {
      if (type === 'plugin_enter') {
        capturedOwners.push({ ...owner })
        events.subscribe({ key: type }, owner)
      }
      return events.publishHostToOwner(type, payload, owner)
    }
  }
  const context = setup(manifest({ window: { singleInstance: false } }), { events: publisher })
  try {
    const first = await context.manager.open({ pluginId: 'plugin.test', payload: { source: 'owner-test' } })
    const second = await context.manager.open({ pluginId: 'plugin.test' })
    assert.deepEqual(capturedOwners, context.registrations.map(registration => ({
      type: 'plugin', webContentsId: registration.webContentsId,
      pluginId: registration.pluginId, pluginInstanceId: registration.instanceId
    })))
    const deliveries = sent.filter(message => message.value.type === 'plugin_enter')
    assert.equal(deliveries.length, 2)
    assert.deepEqual(deliveries.map(message => message.webContentsId), context.registrations.map(item => item.webContentsId))
    assert.deepEqual(deliveries.map(message => (message.value.payload as Record<string, unknown>).instanceId), [first.instanceId, second.instanceId])
    assert.equal(deliveries.some(message => unrelatedOwners.some(owner => owner.webContentsId === message.webContentsId)), false)
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    assert.equal(sent.filter(message => message.value.type === 'plugin_enter').length, 2, 'Successful owner delivery must stop enter retries')
  } finally {
    await context.manager.stop()
    events.stop()
  }
})

test('restores and debounces stable plugin window bounds', async () => {
  const document: Record<string, unknown> = {}
  const state = stateProvider(true, document)
  const first = setup(manifest(), { state })
  await first.manager.open({ pluginId: 'plugin.test' })
  const window = first.windows[0]
  assert.ok(window)
  window.bounds = { x: 150, y: 110, width: 1240, height: 820 }
  window.emit('resize')
  await new Promise<void>((resolve) => setTimeout(resolve, 350))
  const saved = (document['plugin.test'] as Record<string, unknown>).window as Record<string, unknown>
  assert.deepEqual(saved.default, {
    x: 150,
    y: 110,
    width: 1240,
    height: 820,
    maximized: false
  })
  await first.manager.stop()

  const second = setup(manifest(), { state: stateProvider(true, document) })
  await second.manager.open({ pluginId: 'plugin.test' })
  assert.equal(second.options[0]?.width, 1240)
  assert.equal(second.options[0]?.height, 820)
  await second.manager.stop()
})

test('persists the captured window state when a queued write runs after destruction', async () => {
  const document: Record<string, unknown> = {
    'plugin.test': { use_count: 3, window: { other: { width: 800 } } }
  }
  const state = stateProvider(true, document)
  const update = state.update.bind(state)
  let releaseWrite = (): void => undefined
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
  let queuedWrites = 0
  state.update = async (pluginId, mutate) => {
    queuedWrites += 1
    await writeGate
    await update(pluginId, mutate)
  }
  const context = setup(manifest(), { state })
  await context.manager.open({ pluginId: 'plugin.test' })
  const window = context.windows[0]
  assert.ok(window)
  window.bounds = { x: 150, y: 110, width: 1240, height: 820 }
  window.maximized = true
  await context.manager.close('plugin.test')
  assert.equal(window.destroyed, true)
  assert.ok(queuedWrites > 0)
  releaseWrite()
  await context.manager.stop()
  assert.deepEqual(document['plugin.test'], {
    use_count: 3,
    window: {
      other: { width: 800 },
      default: { x: 150, y: 110, width: 1240, height: 820, maximized: true }
    }
  })
})

test('suspends background plugin automatically after timeout and mutes audio', async () => {
  let suspendedCount = 0
  const context = setup(manifest(), {
    suspendTimeoutMs: 20,
    onPluginSuspend: () => {
      suspendedCount += 1
    }
  })
  await context.manager.open({ pluginId: 'plugin.test' })
  const window = context.windows[0]
  assert.ok(window)
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')
  assert.equal(window.webContents.audioMuted, false)

  // 触发 hide
  window.hide()
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')

  // 等待休眠定时器触发 (20ms)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(context.manager.getPluginState('plugin.test'), 'suspended')
  assert.equal(window.webContents.audioMuted, true)
  assert.equal(window.webContents.backgroundThrottling, true)
  assert.equal(suspendedCount, 1)

  const suspendedEvent = context.events.published.find((item) => item.type === 'plugin_suspended')
  assert.ok(suspendedEvent)
  assert.equal((suspendedEvent.payload as { pluginId: string }).pluginId, 'plugin.test')

  await context.manager.stop()
})

test('resumes suspended plugin seamlessly on reopen with audio unmuted', async () => {
  let resumedCount = 0
  const context = setup(manifest(), {
    suspendTimeoutMs: 10,
    onPluginResume: () => {
      resumedCount += 1
    }
  })
  await context.manager.open({ pluginId: 'plugin.test' })
  const window = context.windows[0]
  assert.ok(window)

  window.hide()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(context.manager.getPluginState('plugin.test'), 'suspended')
  assert.equal(window.webContents.audioMuted, true)

  // 重新打开（复用）
  const openResult = await context.manager.open({ pluginId: 'plugin.test' })
  assert.equal(openResult.windowInstanceStatus, 'reused')
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')
  assert.equal(window.webContents.audioMuted, false)
  assert.equal(resumedCount, 1)

  const resumedEvent = context.events.published.find((item) => item.type === 'plugin_resumed')
  assert.ok(resumedEvent)
  assert.equal((resumedEvent.payload as { pluginId: string }).pluginId, 'plugin.test')

  await context.manager.stop()
})

test('supports manual suspend and resume controls', async () => {
  const context = setup(manifest())
  await context.manager.open({ pluginId: 'plugin.test' })
  const window = context.windows[0]
  assert.ok(window)

  // 前台窗口不可直接休眠
  assert.equal(context.manager.suspend('plugin.test'), false)

  window.hide()
  assert.equal(context.manager.suspend('plugin.test'), true)
  assert.equal(context.manager.getPluginState('plugin.test'), 'suspended')
  assert.equal(window.webContents.audioMuted, true)

  assert.equal(context.manager.resume('plugin.test'), true)
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')
  assert.equal(window.webContents.audioMuted, false)

  await context.manager.stop()
})

test('enforces maxActiveBackgroundPlugins by suspending least recently used background plugin', async () => {
  const manifests = new Map<string, PluginManifest>([
    ['p1', manifest({ id: 'p1', name: 'Plugin 1' })],
    ['p2', manifest({ id: 'p2', name: 'Plugin 2' })],
    ['p3', manifest({ id: 'p3', name: 'Plugin 3' })]
  ])
  const windows: FakeWindow[] = []
  const events = createFakeEvents().publisher
  const registry = {
    registerPlugin: () => undefined
  } as unknown as WindowRegistry
  const provider: PluginManifestProvider = {
    async withPluginManifest<T>(pluginId: string, action: (manifest: PluginManifest) => Promise<T>): Promise<T> {
      const item = manifests.get(pluginId)
      assert.ok(item)
      return action(item)
    }
  }
  const manager = new PluginWindowManager({
    registry,
    manifests: provider,
    events,
    suspendTimeoutMs: 60_000, // 设定超长默认超时，避免定时器干扰
    maxActiveBackgroundPlugins: 1, // 最多允许 1 个未休眠后台插件
    createWindow: () => {
      const win = new FakeWindow()
      windows.push(win)
      return win as unknown as BrowserWindow
    }
  })

  await manager.open({ pluginId: 'p1' })
  await manager.open({ pluginId: 'p2' })

  assert.equal(windows.length, 2)
  const [win1, win2] = windows
  assert.ok(win1 && win2)

  // 隐藏 p1
  win1.hide()
  assert.equal(manager.getPluginState('p1'), 'ready')

  // 等待少量时间并隐藏 p2
  await new Promise((resolve) => setTimeout(resolve, 10))
  win2.hide()

  // 此时后台插件数量为 2，超过了上限 1，最老的 p1 应该被强制休眠，而最新的 p2 仍保持 ready
  assert.equal(manager.getPluginState('p1'), 'suspended')
  assert.equal(manager.getPluginState('p2'), 'ready')

  await manager.stop()
})

test('isolates render process crash with Crash Guard and broadcasts plugin_crashed', async () => {
  let crashedReport: { pluginId: string; instanceId: string; details: { reason: string; exitCode: number } } | undefined
  const context = setup(manifest(), {
    onPluginCrash: (pluginId, instanceId, details) => {
      crashedReport = { pluginId, instanceId, details }
    }
  })
  await context.manager.open({ pluginId: 'plugin.test' })
  const window = context.windows[0]
  assert.ok(window)
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')

  // 模拟渲染进程触发 OOM 崩溃
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 })

  // 验证 Crash Guard：状态迁移至 crashed，异常隔离未扩散，主进程正常运行
  assert.equal(context.manager.getPluginState('plugin.test'), 'crashed')
  const crashDetails = context.manager.getCrashDetails('plugin.test')
  assert.ok(crashDetails)
  assert.equal(crashDetails.reason, 'oom')
  assert.equal(crashDetails.exitCode, 137)

  assert.ok(crashedReport)
  assert.equal(crashedReport.pluginId, 'plugin.test')
  assert.equal(crashedReport.details.reason, 'oom')

  const crashEvent = context.events.published.find((item) => item.type === 'plugin_crashed')
  assert.ok(crashEvent)
  assert.equal((crashEvent.payload as { reason: string }).reason, 'oom')

  await context.manager.stop()
})

test('reloads crashed plugin successfully and broadcasts plugin_recovered', async () => {
  const context = setup(manifest())
  await context.manager.open({ pluginId: 'plugin.test' })
  const window1 = context.windows[0]
  assert.ok(window1)

  // 模拟崩溃
  window1.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  assert.equal(context.manager.getPluginState('plugin.test'), 'crashed')

  // 一键重载刷新
  const reloadResult = await context.manager.reload('plugin.test')
  assert.equal(reloadResult.success, true)
  assert.equal(reloadResult.recovered, true)

  // 验证已生成新窗口并处于 ready 状态
  assert.equal(context.windows.length, 2)
  const window2 = context.windows[1]
  assert.ok(window2)
  assert.equal(window1.destroyed, true)
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')

  const recoveredEvent = context.events.published.find((item) => item.type === 'plugin_recovered')
  assert.ok(recoveredEvent)
  assert.equal((recoveredEvent.payload as { pluginId: string }).pluginId, 'plugin.test')

  await context.manager.stop()
})

test('auto-recovers when opening a crashed single instance plugin', async () => {
  const context = setup(manifest())
  await context.manager.open({ pluginId: 'plugin.test' })
  const window1 = context.windows[0]
  assert.ok(window1)

  // 模拟崩溃
  window1.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 })
  assert.equal(context.manager.getPluginState('plugin.test'), 'crashed')

  // 用户再次呼出该插件，自动恢复
  const openResult = await context.manager.open({ pluginId: 'plugin.test' })
  assert.equal(openResult.windowInstanceStatus, 'created')
  assert.equal(context.manager.getPluginState('plugin.test'), 'ready')
  assert.equal(window1.destroyed, true)

  const recoveredEvent = context.events.published.find((item) => item.type === 'plugin_recovered')
  assert.ok(recoveredEvent)

  await context.manager.stop()
})

test('releases session strong reference symmetrically when last plugin window is closed', async () => {
  const releasedSessions: string[] = []
  const sessionProvider: PluginSessionProvider = {
    async get() {
      return {} as Session
    },
    release(pluginId) {
      releasedSessions.push(pluginId)
    }
  }
  const context = setup(manifest(), { sessions: sessionProvider })
  await context.manager.open({ pluginId: 'plugin.test' })
  assert.equal(releasedSessions.length, 0)

  // 关闭插件
  await context.manager.close('plugin.test')
  assert.deepEqual(releasedSessions, ['plugin.test'])

  await context.manager.stop()
})

