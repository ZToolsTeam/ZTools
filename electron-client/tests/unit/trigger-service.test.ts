import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  type KeyboardDoubleTapAdapter,
  type MouseTriggerAdapter,
  normalizedAccelerator,
  TriggerService,
  type GlobalShortcutAdapter,
  type TriggerDocumentStore
} from '../../src/main/services/trigger-service.js'
import { getGlobalHotkeyBlacklistReason } from '../../src/contracts/hotkey-rules.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeKeyboardModifier,
  NativeMouseTriggerConfig
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

  isRegistered(accelerator: string): boolean {
    return this.callbacks.has(accelerator.toLowerCase())
  }

  fire(accelerator: string): void {
    this.callbacks.get(accelerator.toLowerCase())?.()
  }
}

class FakeKeyboard implements KeyboardDoubleTapAdapter {
  readonly configurations: NativeKeyboardModifier[][] = []
  readonly fullscreenDndFlags: boolean[] = []
  readonly inputListeners = new Set<(event: NativeInputEvent) => void>()
  readonly lifecycleListeners = new Set<(event: NativeHostLifecycleEvent) => void>()

  async configureKeyboardDoubleTap(
    modifiers: readonly NativeKeyboardModifier[],
    fullscreenDnd = true
  ): Promise<void> {
    this.configurations.push([...modifiers])
    this.fullscreenDndFlags.push(fullscreenDnd)
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

class FakeMouse implements MouseTriggerAdapter {
  readonly configurations: Array<NativeMouseTriggerConfig | null> = []
  readonly inputListeners = new Set<(event: NativeInputEvent) => void>()
  readonly lifecycleListeners = new Set<(event: NativeHostLifecycleEvent) => void>()

  async configureMouseTrigger(config: NativeMouseTriggerConfig | null): Promise<void> {
    this.configurations.push(config ? { ...config } : null)
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
} {
  const shortcuts = new FakeShortcuts()
  const events: Array<{ type: string; payload: unknown }> = []
  const toggles = { count: 0 }
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
    openPlugin: async () => undefined,
    ...(keyboard ? { keyboard } : {})
  })
  return { service, store, shortcuts, keyboard, events, toggles }
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
      }
    ]
  })
  const { service, shortcuts, events, toggles } = createService(store)
  const result = await service.list({ pluginId: '' }, mainCaller)
  assert.equal(result.data.length, 1)
  assert.equal(result.data.every((trigger) => trigger.enabled && trigger.effectiveEnabled), true)
  assert.equal(shortcuts.callbacks.has('ctrl+shift+z'), true)

  shortcuts.fire('Ctrl+Shift+Z')
  assert.deepEqual(events, [{
    type: 'hotkey_triggered',
    payload: { id: 'global_wake_hotkey', keys: 'Ctrl+Shift+Z' }
  }])
  assert.equal(toggles.count, 1)
  await service.stop()
})

test('triggers.json 中遗留的超级面板快捷键记录：加载后不注册、不参与冲突检测，并从文件中清理', async () => {
  const unknownRecord = { id: '../bad', pluginId: 'system' }
  const store = new MemoryStore({
    preserved: 'root-field',
    triggers: [
      {
        id: 'super_panel_keyboard_hotkey',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Alt+Shift+Space' },
        action: { mode: 'builtin', target: 'toggle_super_panel', params: {} }
      },
      unknownRecord,
      flatTrigger()
    ]
  })
  const { service, shortcuts } = createService(store)
  const listed = await service.list({ pluginId: '' }, mainCaller)

  // 只保留全局唤醒；遗留的超级面板组合键没有注册
  assert.deepEqual(listed.data.map((item) => item.id), ['global_wake_hotkey'])
  assert.equal(shortcuts.callbacks.has('alt+shift+space'), false)
  assert.equal(shortcuts.callbacks.has('ctrl+shift+z'), true)

  // 冲突检测不再把旧超级面板当作占用者
  const conflict = await service.checkConflict({ key: 'Alt+Shift+Space', pluginId: 'another' }, mainCaller)
  assert.equal(conflict.data.hasConflict, false)
  // 该组合键可以被其它触发器正常注册
  await service.register(flatTrigger({
    id: 'reuse_old_super_panel_key',
    pluginId: 'another',
    config: { key: 'Alt+Shift+Space' }
  }) as never, mainCaller)
  assert.equal(shortcuts.callbacks.has('alt+shift+space'), true)

  // 遗留记录已写回清理；无法解析的记录与根字段原样保留
  const stored = store.document.triggers as unknown[]
  assert.equal(stored.some((item) => (item as Record<string, unknown>).id === 'super_panel_keyboard_hotkey'), false)
  assert.deepEqual(stored[0], unknownRecord)
  assert.equal(store.document.preserved, 'root-field')
  await service.stop()
})

test('遗留超级面板记录清理写回失败时不影响其它触发器加载', async () => {
  const store = new MemoryStore({
    triggers: [
      {
        id: 'super_panel_keyboard_hotkey',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Alt+Shift+Space' },
        action: { mode: 'builtin', target: 'toggle_super_panel', params: {} }
      },
      flatTrigger()
    ]
  })
  store.failReplace = true
  const { service, shortcuts } = createService(store)
  const originalWarn = console.warn
  console.warn = () => undefined
  try {
    const listed = await service.list({ pluginId: '' }, mainCaller)
    assert.deepEqual(listed.data.map((item) => item.id), ['global_wake_hotkey'])
  } finally {
    console.warn = originalWarn
  }
  assert.equal(shortcuts.callbacks.has('alt+shift+space'), false)
  assert.equal(shortcuts.callbacks.has('ctrl+shift+z'), true)
  // 写回失败时文件内容保持不变，下次启动会再次清理
  assert.equal((store.document.triggers as unknown[]).length, 2)
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

test('历史 triggers.json 含遗留 launch_local_app / localapp:* 触发器时，启动正常跳过并清理，且插件与全局唤醒热键不受影响', async () => {
  const openedPlugins: Array<{ pluginId: string; payload?: Record<string, unknown> }> = []
  const shortcuts = new FakeShortcuts()
  const events: Array<{ type: string; payload: unknown }> = []
  let toggleCount = 0
  const store = new MemoryStore({
    preserved: 'root-field',
    triggers: [
      {
        id: 'legacy_nested_local_app',
        pluginId: 'localapp:1234ABCD',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Ctrl+Alt+L' },
        action: { mode: 'builtin', target: 'launch_local_app', params: { appId: 'localapp:1234ABCD' } }
      },
      {
        id: 'legacy_flat_local_app',
        pluginId: 'localapp:EFEF9999',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Ctrl+Alt+M' },
        actionMode: 'builtin',
        actionTarget: 'launch_local_app',
        actionParams: { appId: 'localapp:EFEF9999' }
      },
      flatTrigger(),
      {
        id: 'plugin_window_hotkey',
        pluginId: 'plugin.demo',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Ctrl+Alt+D' },
        action: { mode: 'window', target: 'plugin.demo', params: { from: 'hotkey' } }
      }
    ]
  })

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
    toggleMainWindow: () => { toggleCount += 1 },
    openPlugin: async (params) => { openedPlugins.push(params) }
  })

  const listed = await service.list({ pluginId: '' }, mainCaller)
  assert.deepEqual(listed.data.map((item) => item.id), ['global_wake_hotkey', 'plugin_window_hotkey'])
  assert.equal(events.some((item) => item.type === 'trigger_config_invalid'), false)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+l'), false)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+m'), false)
  assert.equal(shortcuts.callbacks.has('ctrl+shift+z'), true)
  assert.equal(shortcuts.callbacks.has('ctrl+alt+d'), true)

  // 插件热键与全局唤醒热键正常触发
  shortcuts.fire('Ctrl+Shift+Z')
  shortcuts.fire('Ctrl+Alt+D')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(toggleCount, 1)
  assert.deepEqual(openedPlugins, [{ pluginId: 'plugin.demo', payload: { from: 'hotkey' } }])

  // 旧本地软件占用的组合键可被插件自由重新绑定，无残留冲突
  const conflict = await service.checkConflict({ key: 'Ctrl+Alt+L', pluginId: 'plugin.demo' }, mainCaller)
  assert.equal(conflict.data.hasConflict, false)

  // 磁盘文档已自动清理两项遗留 localapp 触发器
  const persisted = store.document.triggers as Array<Record<string, unknown>>
  assert.deepEqual(persisted.map((item) => item.id), ['global_wake_hotkey', 'plugin_window_hotkey'])
  assert.equal(store.document.preserved, 'root-field')

  await service.stop()
})

test('拒绝注册已下线的 launch_local_app 动作（主窗口与插件调用方均拦截）', async () => {
  const { service, shortcuts, store } = createService()
  const pluginCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 2,
    pluginId: 'plugin.one'
  }

  for (const [index, override] of [
    { pluginId: 'localapp:1234ABCD', actionParams: { appId: 'localapp:1234ABCD' } },
    { pluginId: 'system', actionParams: { appId: 'localapp:1234ABCD' } },
    { pluginId: 'plugin.one', actionParams: {} }
  ].entries()) {
    await assert.rejects(
      service.register(flatTrigger({
        id: `rejected_local_app_${index}`,
        config: { key: `Ctrl+Alt+F${index + 1}` },
        actionMode: 'builtin',
        actionTarget: 'launch_local_app',
        ...override
      }) as never, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
  }

  await assert.rejects(
    service.register(flatTrigger({
      id: 'plugin_launch_local_app',
      pluginId: 'plugin.one',
      config: { key: 'Ctrl+Alt+L' },
      actionMode: 'builtin',
      actionTarget: 'launch_local_app',
      actionParams: { appId: 'localapp:1234ABCD' }
    }) as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  assert.equal(shortcuts.callbacks.size, 0)
  assert.equal(store.document.triggers, undefined)
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
    config: { key: 'Alt+F8' },
    actionMode: 'window',
    actionTarget: 'plugin.one'
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

test('dispatches plugin-window hotkey actions with their payloads', async () => {
  const store = new MemoryStore()
  const shortcuts = new FakeShortcuts()
  const opened: Array<{ pluginId: string; payload?: Record<string, unknown> }> = []
  const service = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store,
    shortcuts,
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => undefined,
    openPlugin: async (params) => { opened.push(params) }
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
    openPlugin: async () => undefined
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
    openPlugin: async () => undefined
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
  const { service, shortcuts, toggles } = createService(new MemoryStore(), keyboard)
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

  await assert.rejects(
    service.register({
      id: 'duplicate-double-control',
      pluginId: 'other.plugin',
      type: 'hotkey',
      enabled: true,
      config: { key: 'DoubleControl' },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
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
    openPlugin: async () => undefined
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

test('[回归] 系统内置触发器与全局唤醒用同一组合键时报出明确占用者，而不是「操作系统拒绝注册」', async () => {
  const { service, shortcuts } = createService()
  await service.register(flatTrigger({ config: { key: 'Alt+Space' } }) as never, mainCaller)
  await assert.rejects(
    service.register(flatTrigger({ id: 'another_system_hotkey', config: { key: 'Alt+Space' } }) as never, mainCaller),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.triggerConflict &&
      /已被「全局唤醒」占用/.test(error.message)
  )
  // 已注册的全局唤醒不受影响
  assert.equal(shortcuts.callbacks.has('alt+space'), true)
  await service.stop()
})

test('不再支持 toggle_super_panel 内置动作', async () => {
  const { service, shortcuts, store } = createService()
  await assert.rejects(
    service.register(flatTrigger({
      id: 'legacy_panel_action',
      config: { key: 'Ctrl+Alt+P' },
      actionTarget: 'toggle_super_panel'
    }) as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.equal(shortcuts.callbacks.size, 0)
  assert.equal(store.document.triggers, undefined)
  await service.stop()
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
  await service.register(flatTrigger({ config: { key: 'Alt+Shift+Space' } }) as never, mainCaller)
  for (const key of ['Shift+Alt+Space', ' alt + shift + space ', 'Option+Shift+Space']) {
    const conflict = await service.checkConflict({ key, pluginId: 'another' }, mainCaller)
    assert.equal(conflict.data.hasConflict, true, key)
    assert.equal(conflict.data.conflicts[0]?.pluginName, '全局唤醒')
  }
  const free = await service.checkConflict({ key: 'Alt+Space', pluginId: 'another' }, mainCaller)

  // 验证录制态临时捕获未注册的 Ctrl+Space / Alt+Space 并在按下后立即释放
  const forwarded: string[] = []
  const recShortcuts = new FakeShortcuts()
  const recorderService = new TriggerService({
    dataRoot: 'unused-in-memory-store',
    store: new MemoryStore(),
    shortcuts: recShortcuts,
    events: {
      publishHost() {
        return { success: true, delivered: 1 }
      }
    },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    forwardHotkeyToRecorder: (accelerator) => {
      forwarded.push(accelerator)
      return true
    }
  })
  // 另一个系统触发器占用 Alt+Shift+Space，验证录制态不会释放已注册的组合键
  await recorderService.register(flatTrigger({
    id: 'extra_system_hotkey',
    config: { key: 'Alt+Shift+Space' }
  }) as never, mainCaller)
  recorderService.setRecorderCaptureActive(true)
  assert.equal(recShortcuts.callbacks.has('ctrl+space'), true)
  assert.equal(recShortcuts.callbacks.has('alt+space'), true)
  recShortcuts.fire('Ctrl+Space')
  assert.deepEqual(forwarded, ['Ctrl+Space'])
  assert.equal(recShortcuts.callbacks.has('ctrl+space'), false)
  assert.equal(recShortcuts.callbacks.has('alt+space'), false)
  await recorderService.register(flatTrigger({ config: { key: 'Ctrl+Space' } }) as never, mainCaller)
  assert.equal(recShortcuts.callbacks.has('ctrl+space'), true)
  recorderService.setRecorderCaptureActive(true)
  assert.equal(recShortcuts.callbacks.has('alt+space'), true)
  recShortcuts.fire('Alt+Space')
  assert.deepEqual(forwarded, ['Ctrl+Space', 'Alt+Space'])
  assert.equal(recShortcuts.callbacks.has('alt+space'), false)
  assert.equal(recShortcuts.callbacks.has('ctrl+space'), true)
  assert.equal(recShortcuts.callbacks.has('alt+shift+space'), true)
  recorderService.setRecorderCaptureActive(false)
  await recorderService.stop()
  assert.equal(free.data.hasConflict, false)
  await service.stop()
})

test('normalizedAccelerator 与黑名单规则正确区分 macOS ⌘/⌃ 与跨平台禁区键位', async () => {
  // macOS 下 Ctrl/Cmd/Command/CommandOrControl/CmdOrCtrl 均统一到 meta（⌘），物理 Control 单独保留为 ctrl（⌃）
  assert.equal(normalizedAccelerator('Cmd+Space', 'darwin'), 'meta+space')
  assert.equal(normalizedAccelerator('Command + Space', 'darwin'), 'meta+space')
  assert.equal(normalizedAccelerator('CommandOrControl+Space', 'darwin'), 'meta+space')
  assert.equal(normalizedAccelerator('CmdOrCtrl+Space', 'darwin'), 'meta+space')
  assert.equal(normalizedAccelerator('Ctrl+Space', 'darwin'), 'meta+space')
  assert.equal(normalizedAccelerator('Control + Space', 'darwin'), 'ctrl+space')
  assert.equal(normalizedAccelerator('Option+Shift+Space', 'darwin'), 'alt+shift+space')

  // Windows 下 CmdOrCtrl/Ctrl 均归一到 ctrl
  assert.equal(normalizedAccelerator('CmdOrCtrl+Space', 'win32'), 'ctrl+space')
  assert.equal(normalizedAccelerator('Ctrl+Alt+K', 'win32'), 'ctrl+alt+k')

  // 黑名单函数与 TriggerService 拦截校验
  assert.ok(getGlobalHotkeyBlacklistReason('Cmd+Q', 'darwin'))
  assert.ok(getGlobalHotkeyBlacklistReason('Cmd+Tab', 'darwin'))
  assert.ok(getGlobalHotkeyBlacklistReason('Cmd+Space', 'darwin'))
  assert.ok(getGlobalHotkeyBlacklistReason('Alt+F4', 'win32'))
  assert.ok(getGlobalHotkeyBlacklistReason('Ctrl+Shift+Escape', 'win32'))
  assert.equal(getGlobalHotkeyBlacklistReason('Ctrl+Shift+Z', 'darwin'), null)

  const macService = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts: new FakeShortcuts(),
    events: { publishHost: () => ({ success: true, delivered: 1 }) },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    platform: 'darwin'
  })
  for (const blocked of ['Cmd+Q', 'Cmd+Tab', 'Cmd+Space']) {
    await assert.rejects(
      macService.register(flatTrigger({ id: `blk_${blocked}`, config: { key: blocked } }) as never, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
  await macService.stop()

  const winService = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts: new FakeShortcuts(),
    events: { publishHost: () => ({ success: true, delivered: 1 }) },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    platform: 'win32'
  })
  for (const blocked of ['Alt+F4', 'Alt+Tab', 'Ctrl+Shift+Escape', 'Ctrl+C', 'A', 'Space']) {
    await assert.rejects(
      winService.register(flatTrigger({ id: `blk_${blocked}`, config: { key: blocked } }) as never, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
  await winService.stop()
})

test('收紧插件调用方权限：禁止 hook/Double*/内置动作与跨插件目标，仅放行自身窗口快捷键', async () => {
  const keyboard = new FakeKeyboard()
  const mouse = new FakeMouse()
  const shortcuts = new FakeShortcuts()
  const service = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts,
    keyboard,
    mouse,
    events: { publishHost: () => ({ success: true, delivered: 1 }) },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    platform: 'win32'
  })
  const pluginCaller: CallerIdentity = { type: 'plugin', webContentsId: 10, pluginId: 'demo.plugin' }

  // 禁止注册鼠标 hook
  await assert.rejects(
    service.register({
      id: 'p_hook',
      pluginId: 'demo.plugin',
      type: 'hook',
      enabled: true,
      config: { kind: 'mouse', button: 'middle', action: 'press', longPressMs: 300 },
      actionMode: 'window',
      actionTarget: 'demo.plugin'
    } as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  // 禁止注册双击修饰键
  await assert.rejects(
    service.register(flatTrigger({
      id: 'p_double',
      pluginId: 'demo.plugin',
      config: { key: 'DoubleCtrl' },
      actionMode: 'window',
      actionTarget: 'demo.plugin'
    }) as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  // 禁止内置动作 toggle_main_window
  await assert.rejects(
    service.register(flatTrigger({
      id: 'p_builtin',
      pluginId: 'demo.plugin',
      config: { key: 'Ctrl+Alt+1' },
      actionMode: 'builtin',
      actionTarget: 'toggle_main_window'
    }) as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  // 禁止指向其他插件窗口
  await assert.rejects(
    service.register(flatTrigger({
      id: 'p_cross',
      pluginId: 'demo.plugin',
      config: { key: 'Ctrl+Alt+2' },
      actionMode: 'window',
      actionTarget: 'other.plugin'
    }) as never, pluginCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  // 合法自身窗口组合键注册通过
  const ok = await service.register(flatTrigger({
    id: 'p_ok',
    pluginId: 'demo.plugin',
    config: { key: 'Ctrl+Alt+3' },
    actionMode: 'window',
    actionTarget: 'demo.plugin'
  }) as never, pluginCaller)
  assert.deepEqual(ok, { success: true, data: { triggerId: 'p_ok' } })
  assert.equal(shortcuts.callbacks.has('ctrl+alt+3'), true)

  await service.stop()
})

test('冷启动 initialWakeHotkey 自动初始化全局唤醒触发器，不覆盖已有 triggers.json', async () => {
  const freshStore = new MemoryStore()
  const freshShortcuts = new FakeShortcuts()
  const freshService = new TriggerService({
    dataRoot: 'unused',
    store: freshStore,
    shortcuts: freshShortcuts,
    events: { publishHost: () => ({ success: true, delivered: 1 }) },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    initialWakeHotkey: 'Alt+Space',
    platform: 'win32'
  })
  await freshService.waitUntilReady()
  assert.deepEqual(freshService.getGlobalWakeHotkey(), { exists: true, enabled: true, key: 'Alt+Space' })
  assert.equal(freshShortcuts.callbacks.has('alt+space'), true)
  assert.equal(Array.isArray(freshStore.document.triggers), true)
  await freshService.stop()

  // 已有 triggers 数组但用户主动删掉了全局唤醒时，不得强制补种回来
  const existingStore = new MemoryStore({ triggers: [] })
  const existingService = new TriggerService({
    dataRoot: 'unused',
    store: existingStore,
    shortcuts: new FakeShortcuts(),
    events: { publishHost: () => ({ success: true, delivered: 1 }) },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    initialWakeHotkey: 'Alt+Space',
    platform: 'win32'
  })
  await existingService.waitUntilReady()
  assert.deepEqual(existingService.getGlobalWakeHotkey(), { exists: false, enabled: false, key: '' })
  await existingService.stop()
})

test('启动与唤醒冲突检测：记录冲突、支持订阅延迟补发，并在系统恢复后清空', async () => {
  const store = new MemoryStore({
    triggers: [
      {
        id: 'global_wake_hotkey',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Alt+Space' },
        action: { mode: 'builtin', target: 'toggle_main_window', params: {} },
        priority: 0,
        createTime: '2026-08-24 12:00:00'
      }
    ]
  })
  const shortcuts = new FakeShortcuts()
  shortcuts.unavailable.add('alt+space')
  let deliveredCount = 0
  const published: Array<{ type: string; payload: unknown }> = []
  let subListener: ((eventName: string, subscriberCount: number) => void) | undefined

  const service = new TriggerService({
    dataRoot: 'unused',
    store,
    shortcuts,
    events: {
      publishHost(type, payload) {
        published.push({ type, payload })
        return { success: true, delivered: deliveredCount }
      },
      onSubscriptionChanged(eventName, listener) {
        if (eventName === 'hotkey_conflicts_detected') {
          subListener = (_ev, count) => listener(count)
        }
        return () => { subListener = undefined }
      }
    },
    toggleMainWindow: () => undefined,
    openPlugin: async () => undefined,
    platform: 'win32'
  })

  await service.waitUntilReady()
  assert.deepEqual(service.getStartupConflicts(), [{
    type: 'system',
    key: 'Alt+Space',
    pluginId: 'system',
    triggerId: 'global_wake_hotkey'
  }])
  // 启动期主窗口还未就绪（delivered = 0），发出去一次无订阅，留待补发
  assert.equal(published.length, 1)

  // 模拟主窗口就绪并注册监听：触发 onSubscriptionChanged 后通过 setImmediate 只补发一次
  deliveredCount = 1
  subListener?.('hotkey_conflicts_detected', 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(published.length, 2)
  // 再次调用 flushStartupConflicts 不会重复发
  service.flushStartupConflicts()
  assert.equal(published.length, 2)

  // 外部释放热键后系统唤醒重验：自动重新注册成功且冲突列表清空
  shortcuts.unavailable.delete('alt+space')
  await service.verifyRegistrations()
  assert.equal(shortcuts.callbacks.has('alt+space'), true)
  assert.deepEqual(service.getStartupConflicts(), [])

  // 运行期热键被系统静默夺走再唤起：再次发布冲突通知
  shortcuts.callbacks.delete('alt+space')
  shortcuts.unavailable.add('alt+space')
  await service.verifyRegistrations()
  assert.equal(published.length, 3)
  assert.equal(published[2]?.type, 'hotkey_conflicts_detected')

  await service.stop()
})

test('checkConflict 检出同插件不同触发器冲突，并支持 excludeTriggerId 排除自身', async () => {
  const { service } = createService()
  const caller: CallerIdentity = { type: 'plugin', webContentsId: 3, pluginId: 'plugin.self' }
  await service.register(flatTrigger({
    id: 'self_a',
    pluginId: 'plugin.self',
    config: { key: 'Ctrl+Alt+S' },
    actionMode: 'window',
    actionTarget: 'plugin.self'
  }) as never, caller)

  // 不传 excludeTriggerId 时，同插件也检测到 self_a 占用
  const conflictWithoutExclude = await service.checkConflict(
    { key: 'Ctrl+Alt+S', pluginId: 'plugin.self' },
    caller
  )
  assert.equal(conflictWithoutExclude.data.hasConflict, true)
  assert.equal(conflictWithoutExclude.data.conflicts[0]?.triggerId, 'self_a')

  // 编辑自身 self_a 时传入 excludeTriggerId: 'self_a' 应放行
  const selfExcluded = await service.checkConflict(
    { key: 'Ctrl+Alt+S', pluginId: 'plugin.self', excludeTriggerId: 'self_a' },
    caller
  )
  assert.equal(selfExcluded.data.hasConflict, false)

  // 但排除一个不存在或别的 ID 时仍能准确检出冲突
  const otherExcluded = await service.checkConflict(
    { key: 'Ctrl+Alt+S', pluginId: 'plugin.self', excludeTriggerId: 'self_b' },
    caller
  )
  assert.equal(otherExcluded.data.hasConflict, true)
  await service.stop()
})

test('双击修饰键支持 fullscreenDnd 透传以及在录制框激活期间转发 DoubleCtrl', async () => {
  const keyboard = new FakeKeyboard()
  const forwarded: string[] = []
  let toggleCount = 0
  const service = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts: new FakeShortcuts(),
    keyboard,
    events: { publishHost: () => ({ success: true, delivered: 1 }) },
    toggleMainWindow: () => { toggleCount += 1 },
    openPlugin: async () => undefined,
    forwardHotkeyToRecorder: (accelerator) => {
      forwarded.push(accelerator)
      return true
    },
    platform: 'win32'
  })

  await service.register(flatTrigger({
    id: 'global_wake_hotkey',
    config: { key: 'DoubleCtrl', fullscreenDnd: false }
  }) as never, mainCaller)
  assert.deepEqual(keyboard.configurations.at(-1), ['ctrl'])
  assert.equal(keyboard.fullscreenDndFlags.at(-1), false)

  // 非录制态双击 Ctrl -> 触发唤醒主窗口
  keyboard.emit({ type: 'keyboard-double-tap', modifier: 'ctrl' })
  assert.equal(toggleCount, 1)
  assert.deepEqual(forwarded, [])

  // 录制框激活期间双击 Ctrl -> 拦截并转发给录制框，不触发唤醒
  service.setRecorderCaptureActive(true)
  assert.equal(service.isRecorderCaptureActive(), true)
  keyboard.emit({ type: 'keyboard-double-tap', modifier: 'ctrl' })
  assert.deepEqual(forwarded, ['DoubleCtrl'])
  assert.equal(toggleCount, 1)
  assert.equal(service.isRecorderCaptureActive(), false)

  await service.stop()
})

test('鼠标触发钩子 (type: hook) 全生命周期：校验、单一活跃互斥、派发动作、崩溃重连自愈与停用注销', async () => {
  const mouse = new FakeMouse()
  const shortcuts = new FakeShortcuts()
  const events: Array<{ type: string; payload: unknown }> = []
  let toggleCount = 0
  const service = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts,
    mouse,
    events: {
      publishHost(type, payload) {
        events.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    },
    toggleMainWindow: () => { toggleCount += 1 },
    openPlugin: async () => undefined,
    platform: 'win32'
  })

  // 1. 禁止 right + press 破坏右键菜单
  await assert.rejects(
    service.register({
      id: 'hook_bad',
      pluginId: 'system',
      type: 'hook',
      enabled: true,
      config: { kind: 'mouse', button: 'right', action: 'press', longPressMs: 300 },
      actionMode: 'builtin',
      actionTarget: 'toggle_main_window'
    } as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )

  // 2. 注册第一组活跃鼠标触发器
  await service.register({
    id: 'global_wake_mouse',
    pluginId: 'system',
    type: 'hook',
    enabled: true,
    config: { kind: 'mouse', button: 'forward', action: 'long', longPressMs: 320, fullscreenDnd: false },
    actionMode: 'builtin',
    actionTarget: 'toggle_main_window'
  } as never, mainCaller)
  assert.deepEqual(mouse.configurations.at(-1), {
    button: 'forward',
    action: 'long',
    longPressMs: 320,
    fullscreenDnd: false
  })

  // 3. 第二组启用鼠标触发器因互斥被拒绝
  await assert.rejects(
    service.register({
      id: 'second_mouse_hook',
      pluginId: 'system',
      type: 'hook',
      enabled: true,
      config: { kind: 'mouse', button: 'middle', action: 'press', longPressMs: 280 },
      actionMode: 'builtin',
      actionTarget: 'toggle_main_window'
    } as never, mainCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.triggerConflict
  )

  // 4. 命中触发器后执行动作并广播事件
  mouse.emit({
    type: 'mouse-trigger',
    config: { button: 'forward', action: 'long', longPressMs: 320 }
  })
  assert.equal(toggleCount, 1)
  assert.equal(events.some((item) => item.type === 'hotkey_triggered'), true)

  // 5. 侧车崩溃后重启 -> 自动重新下发当前活跃鼠标配置实现自愈
  mouse.emitLifecycle({ type: 'crashed', pid: undefined, exitCode: 1, signal: null, stderr: 'test' })
  mouse.emitLifecycle({ type: 'restarted', attempt: 1, pid: 1234 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(mouse.configurations.at(-1), {
    button: 'forward',
    action: 'long',
    longPressMs: 320,
    fullscreenDnd: false
  })

  // 6. stop() 时下发 null 注销原生鼠标钩子
  await service.stop()
  assert.equal(mouse.configurations.at(-1), null)
})

test('openPlugin 异步失败时发布 hotkey_action_failed 事件', async () => {
  const shortcuts = new FakeShortcuts()
  const events: Array<{ type: string; payload: unknown }> = []
  const service = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts,
    events: {
      publishHost(type, payload) {
        events.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    },
    toggleMainWindow: () => undefined,
    openPlugin: async () => {
      throw new Error('插件窗口启动失败')
    },
    platform: 'win32'
  })

  await service.register({
    id: 'plugin_open_fail',
    pluginId: 'plugin.broken',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+L' },
    actionMode: 'window',
    actionTarget: 'plugin.broken',
    actionParams: {}
  } as never, mainCaller)

  shortcuts.fire('Ctrl+Alt+L')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const failureEvent = events.find((item) => item.type === 'hotkey_action_failed')
  assert.ok(failureEvent)
  assert.deepEqual(failureEvent.payload, {
    id: 'plugin_open_fail',
    target: 'plugin.broken',
    message: '插件窗口启动失败'
  })
  await service.stop()
})

test('[防误触] 退出双击修饰键录制后的 600ms 冷却期内，延迟到达的 KeyUp 不误触发切换窗口', async () => {
  const keyboard = new FakeKeyboard()
  let toggleCount = 0
  let forwardedCount = 0
  const service = new TriggerService({
    dataRoot: 'unused',
    store: new MemoryStore(),
    shortcuts: new FakeShortcuts(),
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => { toggleCount += 1 },
    openPlugin: async () => undefined,
    keyboard,
    forwardHotkeyToRecorder: () => {
      forwardedCount += 1
      return true
    },
    platform: 'win32'
  })

  await service.register({
    id: 'global_wake_hotkey',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'DoubleCtrl' },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  }, mainCaller)

  // 1. 进入录制并由前端在 KeyDown 结束录制态退出，紧随其后的 KeyUp 到达
  service.setRecorderCaptureActive(true)
  service.setRecorderCaptureActive(false)
  keyboard.emit({ type: 'keyboard-double-tap', modifier: 'ctrl' })
  assert.equal(toggleCount, 0)
  assert.equal(forwardedCount, 0)

  // 2. 激活态下按下也会被转发给录制框而不触发切窗
  service.setRecorderCaptureActive(true)
  keyboard.emit({ type: 'keyboard-double-tap', modifier: 'ctrl' })
  assert.equal(forwardedCount, 1)
  assert.equal(toggleCount, 0)

  await service.stop()
})
