import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  type KeyboardDoubleTapAdapter,
  TriggerService,
  type GlobalShortcutAdapter,
  type TriggerDocumentStore
} from '../../src/main/services/trigger-service.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeKeyboardModifier
} from '../../src/main/native-host/native-host-client.js'
import type { JsonObject } from '../../src/main/services/json-file-store.js'
import type { PluginStateProvider } from '../../src/main/services/plugin-state-service.js'

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }

class MemoryStore implements TriggerDocumentStore {
  document: JsonObject
  failReplace = false

  constructor(document: JsonObject = {}) {
    this.document = structuredClone(document)
  }

  async read(): Promise<JsonObject> {
    return structuredClone(this.document)
  }

  async replace(_fileName: string, document: JsonObject): Promise<void> {
    if (this.failReplace) throw new ZToolsError(errorCodes.storageError, '测试存储失败')
    this.document = structuredClone(document)
  }
}

class FakeShortcuts implements GlobalShortcutAdapter {
  readonly callbacks = new Map<string, () => void>()
  readonly unavailable = new Set<string>()
  readonly registrationErrors = new Map<string, Error>()

  register(accelerator: string, callback: () => void): boolean {
    const key = accelerator.toLowerCase()
    const error = this.registrationErrors.get(key)
    if (error) throw error
    if (this.unavailable.has(key) || this.callbacks.has(key)) return false
    this.callbacks.set(key, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.callbacks.delete(accelerator.toLowerCase())
  }

  fire(accelerator: string): void {
    this.callbacks.get(accelerator.toLowerCase())?.()
  }
}

class FakeKeyboard implements KeyboardDoubleTapAdapter {
  readonly configurations: NativeKeyboardModifier[][] = []
  readonly inputListeners = new Set<(event: NativeInputEvent) => void>()
  readonly lifecycleListeners = new Set<(event: NativeHostLifecycleEvent) => void>()

  async configureKeyboardDoubleTap(modifiers: readonly NativeKeyboardModifier[]): Promise<void> {
    this.configurations.push([...modifiers])
  }

  onInputEvent(listener: (event: NativeInputEvent) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  emit(event: NativeInputEvent): void {
    for (const listener of this.inputListeners) listener(event)
  }

  emitLifecycle(event: NativeHostLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) listener(event)
  }
}

function createService(store = new MemoryStore(), keyboard?: FakeKeyboard): {
  service: TriggerService
  store: MemoryStore
  shortcuts: FakeShortcuts
  keyboard: FakeKeyboard | undefined
  events: Array<{ type: string; payload: unknown }>
  toggles: { count: number }
  panelToggles: { count: number }
  localAppLaunches: string[]
} {
  const shortcuts = new FakeShortcuts()
  const events: Array<{ type: string; payload: unknown }> = []
  const toggles = { count: 0 }
  const panelToggles = { count: 0 }
  const localAppLaunches: string[] = []
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    shortcuts,
    events: {
      publishHost(type, payload) {
        events.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    },
    toggleMainWindow: () => { toggles.count += 1 },
    toggleSuperPanel: () => { panelToggles.count += 1 },
    openPlugin: async () => undefined,
    launchLocalApp: async (appId) => { localAppLaunches.push(appId) },
    ...(keyboard ? { keyboard } : {})
  })
  return { service, store, shortcuts, keyboard, events, toggles, panelToggles, localAppLaunches }
}

function flatTrigger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'global_wake_hotkey',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Shift+Z' },
    actionMode: 'builtin',
    actionTarget: 'toggle_main_window',
    actionParams: {},
    ...overrides
  }
}

test('loads the Delphi trigger format and dispatches compatible hotkey events', async () => {
  const store = new MemoryStore({
    preserved: 'root-field',
    triggers: [
      {
        id: 'global_wake_hotkey',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Ctrl+Shift+Z' },
        action: { mode: 'builtin', target: 'toggle_main_window', params: {} },
        priority: 0,
        createTime: '2026-08-24 12:00:00'
      },
      {
        id: 'super_panel_keyboard_hotkey',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Alt+Space' },
        action: { mode: 'builtin', target: 'toggle_super_panel', params: {} }
      }
    ]
  })
  const { service, shortcuts, events, toggles, panelToggles } = createService(store)
  const result = await service.list({ pluginId: '' }, mainCaller)
  assert.equal(result.data.length, 2)
  assert.equal(result.data.every((trigger) => trigger.enabled && trigger.effectiveEnabled), true)
  assert.equal(shortcuts.callbacks.has('ctrl+shift+z'), true)
  assert.equal(shortcuts.callbacks.has('alt+space'), true)

  shortcuts.fire('Ctrl+Shift+Z')
  assert.deepEqual(events, [{
    type: 'hotkey_triggered',
    payload: { id: 'global_wake_hotkey', keys: 'Ctrl+Shift+Z' }
  }])
  assert.equal(toggles.count, 1)
  shortcuts.fire('Alt+Space')
  assert.equal(panelToggles.count, 1)
  await service.stop()
})

test('registers flat and nested actions, persists nested Delphi-compatible JSON and checks conflicts', async () => {
  const { service, store, shortcuts } = createService()
  const first = await service.register(flatTrigger() as never, mainCaller)
  assert.equal(first.data.triggerId, 'global_wake_hotkey')
  assert.equal(shortcuts.callbacks.has('ctrl+shift+z'), true)
  const stored = store.document.triggers as Array<Record<string, unknown>>
  const storedTrigger = stored[0]
  assert.ok(storedTrigger)
  assert.equal((storedTrigger.action as Record<string, unknown>).target, 'toggle_main_window')
  assert.equal(Object.hasOwn(storedTrigger, 'actionMode'), false)

  const conflict = await service.checkConflict({ key: ' ctrl + shift + z ', pluginId: 'another' }, mainCaller)
  assert.equal(conflict.data.hasConflict, true)
  await assert.rejects(
    service.register(flatTrigger({ id: 'duplicate', pluginId: 'another' }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.triggerConflict
  )

  const generated = await service.register({
    pluginId: 'another',
    type: 'hotkey',
    enabled: false,
    config: { key: 'Alt+F10' },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  }, mainCaller)
  assert.match(generated.data.triggerId, /^[a-f0-9-]{36}$/)
  await service.stop()
})

test('registers and reloads a Windows local-app hotkey through the ID-only Main port', async () => {
  const appId = 'localapp:1234ABCD'
  const first = createService()
  await first.service.register(flatTrigger({
    id: 'local_app_hotkey',
    pluginId: appId,
    config: { key: 'Ctrl+Alt+L' },
    actionMode: 'builtin',
    actionTarget: 'launch_local_app',
    actionParams: { appId }
  }) as never, mainCaller)

  const persisted = (first.store.document.triggers as Array<Record<string, unknown>>)[0]
  assert.ok(persisted)
  assert.deepEqual(persisted.action, {
    mode: 'builtin',
    target: 'launch_local_app',
    params: { appId }
  })
  assert.equal(first.shortcuts.callbacks.has('ctrl+alt+l'), true)
  first.shortcuts.fire('Ctrl+Alt+L')
  assert.deepEqual(first.localAppLaunches, [appId])
  await first.service.stop()
  assert.equal(first.shortcuts.callbacks.size, 0)

  const restarted = createService(first.store)
  const listed = await restarted.service.list({ pluginId: '' }, mainCaller)
  assert.equal(listed.data[0]?.effectiveEnabled, true)
  assert.equal(restarted.shortcuts.callbacks.has('ctrl+alt+l'), true)
  restarted.shortcuts.fire('Ctrl+Alt+L')
  assert.deepEqual(restarted.localAppLaunches, [appId])
  await restarted.service.stop()
  assert.equal(restarted.shortcuts.callbacks.size, 0)
})

test('rejects local-app action paths, Mac IDs, extra parameters, and mismatched owners', async () => {
  const { service, shortcuts, store } = createService()
  const invalidActions = [
    { pluginId: 'localapp:1234ABCD', actionParams: { appId: 'C:\\Apps\\Editor.exe' } },
    { pluginId: 'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF', actionParams: {
      appId: 'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'
    } },
    { pluginId: 'localapp:1234ABCD', actionParams: { appId: 'localapp:1234ABCD', path: 'C:\\Apps\\Editor.exe' } },
    { pluginId: 'plugin.one', actionParams: { appId: 'localapp:1234ABCD' } }
  ]

  for (const [index, override] of invalidActions.entries()) {
    await assert.rejects(
      service.register(flatTrigger({
        id: `invalid_local_app_${index}`,
        config: { key: `Ctrl+Alt+F${index + 1}` },
        actionMode: 'builtin',
        actionTarget: 'launch_local_app',
        ...override
      }) as never, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
  }
  assert.equal(shortcuts.callbacks.size, 0)
  assert.equal(store.document.triggers, undefined)
  await service.stop()
})

test('does not register a local-app action without the Main ID lookup port', async () => {
  const appId = 'localapp:1234ABCD'
  const store = new MemoryStore()
  const shortcuts = new FakeShortcuts()
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    shortcuts,
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => undefined,
    toggleSuperPanel: () => undefined,
    openPlugin: async () => undefined
  })

  await assert.rejects(
    service.register(flatTrigger({
      id: 'local_app_without_port',
      pluginId: appId,
      actionMode: 'builtin',
      actionTarget: 'launch_local_app',
      actionParams: { appId }
    }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.equal(shortcuts.callbacks.size, 0)
  assert.equal(store.document.triggers, undefined)
  await service.stop()
})

test('does not let a plugin caller impersonate a local-app trigger owner', async () => {
  const { service } = createService()
  const appId = 'localapp:1234ABCD'
  const pluginCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 2,
    pluginId: 'plugin.one'
  }

  await assert.rejects(
    service.list({ pluginId: appId }, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    service.checkConflict({ key: 'Ctrl+Alt+L', pluginId: appId }, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    service.register(flatTrigger({
      id: 'plugin_local_app_spoof',
      pluginId: appId,
      config: { key: 'Ctrl+Alt+L' },
      actionMode: 'builtin',
      actionTarget: 'launch_local_app',
      actionParams: { appId }
    }) as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    service.register(flatTrigger({
      id: 'plugin_cross_owner_local_app',
      pluginId: pluginCaller.pluginId,
      config: { key: 'Ctrl+Alt+K' },
      actionMode: 'builtin',
      actionTarget: 'launch_local_app',
      actionParams: { appId }
    }) as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  await service.stop()
})

test('rejects invalid Electron accelerator syntax as an invalid request before registration', async () => {
  const { service, shortcuts } = createService()
  for (const key of ['Ctrl+NotAKey', 'Ctrl', '']) {
    await assert.rejects(
      service.register(flatTrigger({ config: { key } }) as never, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
  assert.equal(shortcuts.callbacks.size, 0)
  await service.stop()
})

test('treats OS registration refusal as a conflict and restores the old shortcut on update', async () => {
  const { service, shortcuts } = createService()
  await service.register(flatTrigger({ config: { key: 'Ctrl+Alt+A' } }) as never, mainCaller)
  shortcuts.unavailable.add('ctrl+alt+b')

  await assert.rejects(
    service.register(flatTrigger({ config: { key: 'Ctrl+Alt+B' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.triggerConflict
  )
  assert.equal(shortcuts.callbacks.has('ctrl+alt+a'), true)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+b'), false)
  const current = await service.list({ pluginId: '' }, mainCaller)
  assert.equal(current.data[0]?.config.key, 'Ctrl+Alt+A')
  await service.stop()
})

test('does not convert adapter exceptions to shortcut conflicts and restores the old shortcut', async () => {
  const { service, shortcuts } = createService()
  await service.register(flatTrigger({ config: { key: 'Ctrl+Alt+A' } }) as never, mainCaller)
  const registrationError = new Error('native registration service failed')
  shortcuts.registrationErrors.set('ctrl+alt+b', registrationError)

  await assert.rejects(
    service.register(flatTrigger({ config: { key: 'Ctrl+Alt+B' } }) as never, mainCaller),
    (error) => error === registrationError
  )
  assert.equal(shortcuts.callbacks.has('ctrl+alt+a'), true)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+b'), false)
  await service.stop()
})

test('redacts shortcut adapter exception details from rollback logs', async () => {
  const { service, shortcuts } = createService()
  await service.register(flatTrigger({ config: { key: 'Ctrl+Alt+A' } }) as never, mainCaller)
  const sensitiveDetail = '/Users/alice/private/keychain-token-789'
  const registrationError = new Error(`native registration failed at ${sensitiveDetail}`)
  shortcuts.registrationErrors.set('ctrl+alt+b', registrationError)
  shortcuts.registrationErrors.set('ctrl+alt+a', registrationError)

  const originalConsoleError = console.error
  const logs: Parameters<typeof console.error>[] = []
  console.error = (...args) => { logs.push(args) }
  try {
    await assert.rejects(
      service.register(flatTrigger({ config: { key: 'Ctrl+Alt+B' } }) as never, mainCaller),
      (error) => error === registrationError
    )
  } finally {
    console.error = originalConsoleError
  }

  assert.deepEqual(logs, [['Failed to restore global shortcut after rollback']])
  assert.equal(JSON.stringify(logs).includes(sensitiveDetail), false)
  await service.stop()
})

test('redacts event adapter exception details from hotkey logs', async () => {
  const sensitiveDetail = '/Users/alice/private/event-token-987'
  const eventError = new Error(`event delivery failed at ${sensitiveDetail}`)
  const shortcuts = new FakeShortcuts()
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store: new MemoryStore(),
    shortcuts,
    events: {
      publishHost() {
        throw eventError
      }
    },
    toggleMainWindow: () => undefined,
    toggleSuperPanel: () => undefined,
    openPlugin: async () => undefined
  })
  await service.register(flatTrigger() as never, mainCaller)

  const originalConsoleError = console.error
  const logs: Parameters<typeof console.error>[] = []
  console.error = (...args) => { logs.push(args) }
  try {
    shortcuts.fire('Ctrl+Shift+Z')
  } finally {
    console.error = originalConsoleError
  }

  assert.deepEqual(logs, [['Failed to publish hotkey event']])
  assert.equal(JSON.stringify(logs).includes(sensitiveDetail), false)
  await service.stop()
})

test('preserves unknown fields and the original flat action shape when updating a trigger', async () => {
  const store = new MemoryStore({ triggers: [{
    id: 'legacy-flat',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+L', legacyConfig: 'keep' },
    actionMode: 'builtin',
    actionTarget: 'toggle_main_window',
    actionParams: { legacyAction: true },
    legacyField: { keep: true }
  }] })
  const { service } = createService(store)
  await service.setEnabled({ triggerId: 'legacy-flat', enabled: false }, mainCaller)
  const saved = (store.document.triggers as Array<Record<string, unknown>>)[0]
  assert.equal(saved?.legacyField && (saved.legacyField as Record<string, unknown>).keep, true)
  assert.equal(saved?.config && (saved.config as Record<string, unknown>).legacyConfig, 'keep')
  assert.equal(saved?.actionMode, 'builtin')
  assert.equal(saved?.actionTarget, 'toggle_main_window')
  assert.equal(saved?.action, undefined)
  assert.equal((saved?.actionParams as Record<string, unknown>).legacyAction, true)
  await service.stop()
})

test('rolls shortcut registration back when atomic persistence fails', async () => {
  const { service, store, shortcuts } = createService()
  await service.register(flatTrigger({ config: { key: 'Ctrl+Alt+A' } }) as never, mainCaller)
  store.failReplace = true
  await assert.rejects(
    service.register(flatTrigger({ config: { key: 'Ctrl+Alt+B' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.storageError
  )
  assert.equal(shortcuts.callbacks.has('ctrl+alt+a'), true)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+b'), false)
  store.failReplace = false
  const result = await service.list({ pluginId: '' }, mainCaller)
  const restored = result.data[0]
  assert.ok(restored)
  assert.equal(restored.config.key, 'Ctrl+Alt+A')
  await service.stop()
})

test('enforces plugin ownership for register, list and mutation', async () => {
  const { service } = createService()
  const pluginCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 2,
    pluginId: 'plugin.one'
  }
  await service.register(flatTrigger({
    id: 'one',
    pluginId: 'plugin.one',
    enabled: false,
    config: { key: 'Alt+F8' }
  }) as never, pluginCaller)
  await service.register(flatTrigger({
    id: 'two',
    pluginId: 'plugin.two',
    enabled: false,
    config: { key: 'Alt+F9' }
  }) as never, mainCaller)

  assert.deepEqual((await service.list({ pluginId: '' }, pluginCaller)).data.map((item) => item.id), ['one'])
  await assert.rejects(
    service.list({ pluginId: 'plugin.two' }, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    service.unregister('two', pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await service.stop()
})

test('rejects unsupported trigger types and double modifiers without changing storage', async () => {
  const { service, store } = createService()
  await assert.rejects(
    service.register(flatTrigger({ type: 'timer' }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  await assert.rejects(
    service.register(flatTrigger({ config: { key: 'DoubleCtrl' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  await assert.rejects(
    service.register(flatTrigger({ config: { key: 'Ctrl++' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.equal(store.document.triggers, undefined)
  await service.stop()
})

test('dispatches plugin-window and local-app hotkey actions with their payloads', async () => {
  const store = new MemoryStore()
  const shortcuts = new FakeShortcuts()
  const opened: Array<{ pluginId: string; payload?: Record<string, unknown> }> = []
  const launched: string[] = []
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    shortcuts,
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => undefined,
    toggleSuperPanel: () => undefined,
    openPlugin: async (params) => { opened.push(params) },
    launchLocalApp: async (appId) => { launched.push(appId) }
  })

  await service.register({
    id: 'open-plugin-hotkey',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+1' },
    action: { mode: 'window', target: 'plugin.test', params: { source: 'hotkey', autoCapture: true } }
  }, mainCaller)
  await service.register({
    id: 'launch-app-hotkey',
    pluginId: 'localapp:ABCDEF12',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+2' },
    action: { mode: 'builtin', target: 'launch_local_app', params: { appId: 'localapp:ABCDEF12' } }
  }, mainCaller)
  await service.register({
    id: 'screenshot-feature-hotkey',
    pluginId: 'screenshot',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+3' },
    action: {
      mode: 'window',
      target: 'screenshot',
      params: { source: 'screenshot_capture_hotkey', captureMode: 'region' }
    }
  }, mainCaller)
  await service.register({
    id: 'ocr-feature-hotkey',
    pluginId: 'ocr',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+4' },
    action: {
      mode: 'window',
      target: 'ocr',
      params: { source: 'ocr_capture_hotkey', autoCapture: true, autoRecognize: true }
    }
  }, mainCaller)

  shortcuts.fire('Ctrl+Alt+1')
  shortcuts.fire('Ctrl+Alt+2')
  shortcuts.fire('Ctrl+Alt+3')
  shortcuts.fire('Ctrl+Alt+4')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(opened, [{
    pluginId: 'plugin.test',
    payload: { source: 'hotkey', autoCapture: true }
  }, {
    pluginId: 'screenshot',
    payload: { source: 'screenshot_capture_hotkey', captureMode: 'region' }
  }, {
    pluginId: 'ocr',
    payload: { source: 'ocr_capture_hotkey', autoCapture: true, autoRecognize: true }
  }])
  assert.deepEqual(launched, ['localapp:ABCDEF12'])
  await service.stop()
})

test('retries an enabled shortcut that was unavailable during startup', async () => {
  const store = new MemoryStore({ triggers: [{
    id: 'retry_hotkey',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+R' },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  }] })
  const shortcuts = new FakeShortcuts()
  shortcuts.unavailable.add('ctrl+alt+r')
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    shortcuts,
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => undefined,
    toggleSuperPanel: () => undefined,
    openPlugin: async () => undefined,
    launchLocalApp: async () => undefined
  })
  const initial = await service.list({ pluginId: '' }, mainCaller)
  assert.equal(initial.data[0]?.enabled, true)
  assert.equal(initial.data[0]?.effectiveEnabled, false)
  assert.equal(shortcuts.callbacks.size, 0)
  shortcuts.unavailable.clear()
  await service.setEnabled({ triggerId: 'retry_hotkey', enabled: true }, mainCaller)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+r'), true)
  const retried = await service.list({ pluginId: '' }, mainCaller)
  assert.equal(retried.data[0]?.enabled, true)
  assert.equal(retried.data[0]?.effectiveEnabled, true)
  await service.stop()
})

test('does not register or fire triggers for disabled plugins, but restores them when re-enabled', async () => {
  const store = new MemoryStore({ triggers: [{
    id: 'plugin-hotkey',
    pluginId: 'plugin.one',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+P' },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  }] })
  const shortcuts = new FakeShortcuts()
  const events: Array<{ type: string; payload: unknown }> = []
  let enabled = false
  const state: PluginStateProvider = {
    async readAll() { return {} },
    async isEnabled() { return enabled },
    async toggleEnabled() { return enabled },
    async markUsed() {},
    async setIconUrl() {},
    async update() {}
  }
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    state,
    shortcuts,
    events: { publishHost(type, payload) { events.push({ type, payload }); return { success: true, delivered: 1 } } },
    toggleMainWindow: () => undefined,
    toggleSuperPanel: () => undefined,
    openPlugin: async () => undefined,
    launchLocalApp: async () => undefined
  })
  await service.list({ pluginId: '' }, mainCaller)
  assert.equal(shortcuts.callbacks.size, 0)
  enabled = true
  await service.syncPluginEnabled('plugin.one', true)
  assert.equal(shortcuts.callbacks.size, 1)
  shortcuts.fire('Ctrl+Alt+P')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(events[0]?.type, 'hotkey_triggered')
  enabled = false
  await service.syncPluginEnabled('plugin.one', false)
  assert.equal(shortcuts.callbacks.size, 0)
  await service.stop()
})

test('routes NativeHost double modifier events and cleans up keyboard configuration', async () => {
  const keyboard = new FakeKeyboard()
  const { service, shortcuts, toggles, panelToggles } = createService(new MemoryStore(), keyboard)
  await service.register({
    id: 'double-control',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'DoubleCtrl' },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  }, mainCaller)
  assert.equal(shortcuts.callbacks.has('doublectrl'), false)
  assert.deepEqual(keyboard.configurations[keyboard.configurations.length - 1], ['ctrl'])

  keyboard.emit({ type: 'keyboard-double-tap', modifier: 'ctrl' })
  assert.equal(toggles.count, 1)
  assert.equal(panelToggles.count, 0)

  await assert.rejects(
    service.register({
      id: 'duplicate-double-control',
      pluginId: 'other.plugin',
      type: 'hotkey',
      enabled: true,
      config: { key: 'DoubleControl' },
      action: { mode: 'builtin', target: 'toggle_super_panel', params: {} }
    }, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.triggerConflict
  )

  await service.setEnabled({ triggerId: 'double-control', enabled: false }, mainCaller)
  assert.deepEqual(keyboard.configurations[keyboard.configurations.length - 1], [])
  keyboard.emit({ type: 'keyboard-double-tap', modifier: 'ctrl' })
  assert.equal(toggles.count, 1)

  await service.setEnabled({ triggerId: 'double-control', enabled: true }, mainCaller)
  assert.deepEqual(keyboard.configurations[keyboard.configurations.length - 1], ['ctrl'])
  keyboard.emitLifecycle({ type: 'crashed', pid: 1, exitCode: 1, signal: null, stderr: '' })
  keyboard.emitLifecycle({ type: 'restarted', attempt: 1, pid: 2 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(keyboard.configurations[keyboard.configurations.length - 1], ['ctrl'])

  await service.stop()
  assert.deepEqual(keyboard.configurations[keyboard.configurations.length - 1], [])
})

test('does not treat disabled plugin triggers as active conflicts', async () => {
  const store = new MemoryStore({ triggers: [
    {
      id: 'disabled-hotkey',
      pluginId: 'plugin.disabled',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Alt+P' },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    },
    {
      id: 'system-hotkey',
      pluginId: 'system',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Alt+P' },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    }
  ] })
  const shortcuts = new FakeShortcuts()
  let enabled = false
  const state: PluginStateProvider = {
    async readAll() { return {} },
    async isEnabled(pluginId) { return pluginId === 'system' || enabled },
    async toggleEnabled() { return enabled },
    async markUsed() {},
    async setIconUrl() {},
    async update() {}
  }
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    state,
    shortcuts,
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => undefined,
    toggleSuperPanel: () => undefined,
    openPlugin: async () => undefined,
    launchLocalApp: async () => undefined
  })
  await service.list({ pluginId: '' }, mainCaller)
  assert.equal(shortcuts.callbacks.size, 1)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+p'), true)
  const conflict = await service.checkConflict({ key: 'Ctrl+Alt+P', pluginId: 'plugin.other' }, mainCaller)
  assert.equal(conflict.data.hasConflict, true)
  enabled = true
  await service.syncPluginEnabled('plugin.disabled', true)
  assert.equal(shortcuts.callbacks.size, 1)
  await service.stop()
})

test('unregister is idempotent for missing and concurrently removed triggers', async () => {
  const { service, store, shortcuts } = createService(new MemoryStore({ triggers: [flatTrigger()] }))
  const result = { success: true, data: 'Trigger unregistered' }
  assert.deepEqual(await service.unregister('missing', mainCaller), result)
  assert.equal(shortcuts.callbacks.size, 1)
  assert.deepEqual(await Promise.all([
    service.unregister('global_wake_hotkey', mainCaller),
    service.unregister('global_wake_hotkey', mainCaller)
  ]), [result, result])
  assert.equal(shortcuts.callbacks.size, 0)
  assert.deepEqual(store.document.triggers, [])
  store.failReplace = true
  assert.deepEqual(await service.unregister('global_wake_hotkey', mainCaller), result)
  await service.stop()
})

test('disables and unregisters symmetrically, then rejects calls after stop', async () => {
  const { service, shortcuts } = createService()
  await service.register(flatTrigger() as never, mainCaller)
  await service.setEnabled({ triggerId: 'global_wake_hotkey', enabled: false }, mainCaller)
  assert.equal(shortcuts.callbacks.size, 0)
  const disabled = await service.list({ pluginId: '' }, mainCaller)
  assert.equal(disabled.data[0]?.enabled, false)
  assert.equal(disabled.data[0]?.effectiveEnabled, false)
  await service.setEnabled({ triggerId: 'global_wake_hotkey', enabled: true }, mainCaller)
  assert.equal(shortcuts.callbacks.size, 1)
  await service.unregister('global_wake_hotkey', mainCaller)
  assert.equal(shortcuts.callbacks.size, 0)
  await service.stop()
  await assert.rejects(
    service.list({ pluginId: '' }, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.appStopping
  )
})

test('isolates a corrupt trigger record and preserves it across a later write', async () => {
  const invalid = { id: '../bad', pluginId: 'system' }
  const store = new MemoryStore({ triggers: [invalid, flatTrigger()] })
  const { service, events } = createService(store)
  const listed = await service.list({ pluginId: '' }, mainCaller)
  assert.deepEqual(listed.data.map((item) => item.id), ['global_wake_hotkey'])
  assert.equal(events[0]?.type, 'trigger_config_invalid')
  await service.setEnabled({ triggerId: 'global_wake_hotkey', enabled: false }, mainCaller)
  assert.deepEqual((store.document.triggers as unknown[])[0], invalid)
  assert.equal((store.document.triggers as Array<Record<string, unknown>>)[1]?.enabled, false)
  await service.stop()
})

test('[回归] 超级面板与全局唤醒同属 system，用同一组合键时报出明确冲突，而不是「操作系统拒绝注册」', async () => {
  const { service, shortcuts } = createService()
  await service.syncSuperPanelHotkey(true, 'Alt+Space')
  await assert.rejects(
    service.register(flatTrigger({ config: { key: 'Alt+Space' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.triggerConflict &&
      /已被「超级面板」占用/.test(error.message)
  )
  // 已注册的超级面板不受影响
  assert.equal(shortcuts.callbacks.has('alt+space'), true)
  // 反过来：全局唤醒先占用，超级面板再用同一组合键也明确报出占用者
  const other = createService()
  await other.service.register(flatTrigger({ config: { key: 'Alt+Space' } }) as never, mainCaller)
  await assert.rejects(
    other.service.syncSuperPanelHotkey(true, 'Alt+Space'),
    (error) => error instanceof ZToolsError && /已被「全局唤醒」占用/.test(error.message)
  )
  await service.stop()
  await other.service.stop()
})

test('[回归] 同一插件的两个不同触发器也不能共用一个组合键（同一组合键系统里只能注册一次）', async () => {
  const { service } = createService()
  await service.register(flatTrigger({ id: 'a', pluginId: 'demo', config: { key: 'Ctrl+Alt+K' } }) as never, mainCaller)
  await assert.rejects(
    service.register(flatTrigger({ id: 'b', pluginId: 'demo', config: { key: 'Ctrl+Alt+K' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.triggerConflict && /插件 demo/.test(error.message)
  )
  // 同一个触发器原地更新（同 ID）不算冲突
  await service.register(flatTrigger({ id: 'a', pluginId: 'demo', config: { key: 'Ctrl+Alt+K' } }) as never, mainCaller)
  await service.stop()
})

test('[边界] 修饰键顺序、大小写、空白与别名（Option = Alt）不同也识别为同一组合键', async () => {
  const { service } = createService()
  await service.syncSuperPanelHotkey(true, 'Alt+Shift+Space')
  for (const key of ['Shift+Alt+Space', ' alt + shift + space ', 'Option+Shift+Space']) {
    const conflict = await service.checkConflict({ key, pluginId: 'another' }, mainCaller)
    assert.equal(conflict.data.hasConflict, true, key)
    assert.equal(conflict.data.conflicts[0]?.pluginName, '超级面板')
  }
  const free = await service.checkConflict({ key: 'Alt+Space', pluginId: 'another' }, mainCaller)
  assert.equal(free.data.hasConflict, false)
  await service.stop()
})
