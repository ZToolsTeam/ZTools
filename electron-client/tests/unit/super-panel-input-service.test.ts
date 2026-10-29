import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElectronGlobalShortcutAdapter } from '../../src/main/platform/common/electron-global-shortcut.js'
import type { JsonObject } from '../../src/main/services/json-file-store.js'
import { TriggerService, type TriggerDocumentStore } from '../../src/main/services/trigger-service.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeMouseTriggerConfig
} from '../../src/main/native-host/native-host-client.js'
import { decodeSuperPanelConfig } from '../../src/main/super-panel/config.js'
import { SuperPanelInputService } from '../../src/main/super-panel/input-service.js'

class FakeNativeInput {
  state = 'ready'
  readonly configurations: Array<NativeMouseTriggerConfig | null> = []
  inputListener: ((event: NativeInputEvent) => void) | undefined
  lifecycleListener: ((event: NativeHostLifecycleEvent) => void) | undefined

  async configureMouseTrigger(config: NativeMouseTriggerConfig | null): Promise<void> {
    this.configurations.push(config ? { ...config } : null)
  }

  onInputEvent(listener: (event: NativeInputEvent) => void): () => void {
    this.inputListener = listener
    return () => { this.inputListener = undefined }
  }

  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void {
    this.lifecycleListener = listener
    return () => { this.lifecycleListener = undefined }
  }
}

class MemoryTriggerStore implements TriggerDocumentStore {
  document: JsonObject = {}

  async read(): Promise<JsonObject> {
    return this.document
  }

  async replace(_fileName: string, document: JsonObject): Promise<void> {
    this.document = document
  }
}

type HotkeyRecordingEvent = {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  repeat: boolean
  timeStamp: number
}

type HotkeyRecorderModule = {
  parseSupportedHotkeyEvent(
    event: HotkeyRecordingEvent,
    options: { platform: 'macos' }
  ): { status: string; hotkey?: string }
}

test('reloads keyboard and mouse triggers and ignores stale native events', async () => {
  let source = JSON.stringify({
    enabled: true,
    keyboardHotkey: { enabled: true, modifiers: ['Alt'], key: 'X' },
    mouseHotkey: { enabled: true, button: 'middle_long', longPressMs: 300 }
  })
  const native = new FakeNativeInput()
  const keyboard: Array<{ enabled: boolean; accelerator: string }> = []
  let mouseToggles = 0
  const service = new SuperPanelInputService({
    config: { get: async () => source },
    triggers: {
      async syncSuperPanelHotkey(enabled, accelerator) {
        keyboard.push({ enabled, accelerator })
      }
    },
    nativeInput: native,
    toggle: () => { mouseToggles += 1 }
  })
  await service.ready
  assert.deepEqual(keyboard, [{ enabled: true, accelerator: 'Alt+X' }])
  assert.equal(service.diagnostics.mouseSupported, true)
  assert.deepEqual(native.configurations, [{ button: 'middle', action: 'long', longPressMs: 300 }])

  native.inputListener?.({
    type: 'mouse-trigger',
    config: { button: 'right', action: 'long', longPressMs: 300 }
  })
  assert.equal(mouseToggles, 0)
  native.inputListener?.({
    type: 'mouse-trigger',
    config: { button: 'middle', action: 'long', longPressMs: 300 }
  })
  assert.equal(mouseToggles, 1)

  source = JSON.stringify({ enabled: false })
  await service.reload()
  assert.deepEqual(keyboard.at(-1), { enabled: false, accelerator: 'Alt+Shift+Space' })
  assert.equal(native.configurations.at(-1), null)
  await service.stop()
})

test('keeps the mouse trigger available when keyboard registration fails', async () => {
  let source = JSON.stringify({
    keyboardHotkey: { enabled: true, modifiers: ['Alt'], key: 'X' },
    mouseHotkey: { enabled: true, button: 'middle_long', longPressMs: 300 }
  })
  const native = new FakeNativeInput()
  let failKeyboard = false
  const service = new SuperPanelInputService({
    config: { get: async () => source },
    triggers: {
      async syncSuperPanelHotkey() {
        if (failKeyboard) throw new Error('shortcut occupied')
      }
    },
    nativeInput: native,
    toggle: () => undefined
  })
  await service.ready
  source = JSON.stringify({
    keyboardHotkey: { enabled: true, modifiers: ['Alt'], key: 'Y' },
    mouseHotkey: { enabled: true, button: 'right_press', longPressMs: 250 }
  })
  failKeyboard = true
  await assert.rejects(service.reload(), /shortcut occupied/)
  assert.deepEqual(native.configurations.at(-1), {
    button: 'right', action: 'press', longPressMs: 250
  })
  assert.equal(service.diagnostics.mouseEnabled, true)
  assert.equal(service.diagnostics.lastError, 'shortcut occupied')
  await service.stop()
})

test('routes macOS physical Control and Command through saved settings to global shortcut cleanup', async () => {
  const recorderPath = resolve(process.cwd(),
    '../frontend/src/utils/hotkeyRecorder.js'
  )
  const recorder = await import(pathToFileURL(recorderPath).href) as HotkeyRecorderModule
  const persistRecordedHotkey = (event: HotkeyRecordingEvent): string => {
    const result = recorder.parseSupportedHotkeyEvent(event, { platform: 'macos' })
    assert.equal(result.status, 'valid')
    const keys = (result.hotkey ?? '').split('+')
    const key = keys.pop()
    assert.ok(key, 'recorded hotkey must contain a main key')
    return JSON.stringify({
      enabled: true,
      keyboardHotkey: { enabled: true, modifiers: keys, key },
      mouseHotkey: { enabled: true, button: 'middle_long', longPressMs: 300 }
    })
  }
  const physicalControlSettings = persistRecordedHotkey({
    key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: false,
    metaKey: false, repeat: false, timeStamp: 1
  })
  const commandSettings = persistRecordedHotkey({
    key: 'k', code: 'KeyK', ctrlKey: false, altKey: false, shiftKey: false,
    metaKey: true, repeat: false, timeStamp: 2
  })
  assert.equal(decodeSuperPanelConfig(physicalControlSettings).keyboard.accelerator, 'Control+K')
  assert.equal(decodeSuperPanelConfig(commandSettings).keyboard.accelerator, 'Ctrl+K')

  const calls: string[] = []
  const callbacks = new Map<string, () => void>()
  const shortcutAdapter = createElectronGlobalShortcutAdapter({
    register(accelerator, callback) {
      calls.push('register:' + accelerator)
      callbacks.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      calls.push('unregister:' + accelerator)
      callbacks.delete(accelerator)
    }
  })
  const store = new MemoryTriggerStore()
  let panelToggles = 0
  const triggers = new TriggerService({
    dataRoot: 'unused',
    shortcuts: shortcutAdapter,
    events: { publishHost() { return { success: true, delivered: 1 } } },
    toggleMainWindow() {},
    toggleSuperPanel() { panelToggles += 1 },
    openPlugin: async () => undefined,
    store
  })
  let persistedSettings = physicalControlSettings
  const panelInput = new SuperPanelInputService({
    config: { get: async () => persistedSettings },
    triggers,
    nativeInput: null,
    toggle: () => undefined
  })
  await panelInput.ready
  assert.equal(panelInput.diagnostics.mouseSupported, false)
  assert.equal(panelInput.diagnostics.mouseEnabled, false)
  assert.deepEqual(calls, ['register:Control+K'])
  callbacks.get('Control+K')?.()
  assert.equal(panelToggles, 1)

  persistedSettings = commandSettings
  await panelInput.reload()
  assert.deepEqual(calls, [
    'register:Control+K',
    'unregister:Control+K',
    'register:CommandOrControl+K'
  ])
  callbacks.get('CommandOrControl+K')?.()
  assert.equal(panelToggles, 2)

  await panelInput.stop()
  await panelInput.stop()
  await triggers.stop()
  await panelInput.reload()
  assert.deepEqual(calls, [
    'register:Control+K',
    'unregister:Control+K',
    'register:CommandOrControl+K',
    'unregister:CommandOrControl+K'
  ])
})

test('removes the first native listener when the second constructor subscription fails', () => {
  const inputListeners = new Set<(event: NativeInputEvent) => void>()
  const failure = new Error('lifecycle subscription failed')
  const native = {
    state: 'ready',
    async configureMouseTrigger() {},
    onInputEvent(listener: (event: NativeInputEvent) => void) {
      inputListeners.add(listener)
      return () => { inputListeners.delete(listener) }
    },
    onLifecycleEvent() {
      throw failure
    }
  }

  assert.throws(() => new SuperPanelInputService({
    config: { get: async () => JSON.stringify({ enabled: false }) },
    triggers: { async syncSuperPanelHotkey() {} },
    nativeInput: native,
    toggle: () => undefined
  }), (error: unknown) => error === failure)
  assert.equal(inputListeners.size, 0)
})

function migrationConfig(store: Record<string, unknown>, options: { failSet?: boolean; failWakeRead?: boolean } = {}) {
  const writes: Array<{ path: string; value: string; sync: boolean }> = []
  return {
    writes,
    config: {
      async get(_file: string, path: string, defaultValue: unknown): Promise<string> {
        if (path === 'hotkey.global' && options.failWakeRead) throw new Error('读取失败')
        const value = path === 'super_panel' ? store.super_panel : path === 'hotkey.global' ? store.wake : undefined
        if (value === undefined) return typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue)
        return typeof value === 'string' ? value : JSON.stringify(value)
      },
      async set(_file: string, path: string, value: string, sync: boolean): Promise<void> {
        if (options.failSet) throw new Error('磁盘已满')
        writes.push({ path, value, sync })
        if (path === 'super_panel') store.super_panel = JSON.parse(value)
      }
    }
  }
}

const legacyPanel = () => ({
  enabled: true,
  keyboardHotkey: { enabled: true, modifiers: ['Alt'], key: 'Space' },
  mouseHotkey: { enabled: true, button: 'middle_long', longPressMs: 300 },
  panelSize: 'large'
})

function keyboardRecorder() {
  const calls: Array<{ enabled: boolean; accelerator: string }> = []
  return { calls, triggers: { async syncSuperPanelHotkey(enabled: boolean, accelerator: string) { calls.push({ enabled, accelerator }) } } }
}

test('[迁移] 旧默认 Alt+Space 且全局唤醒也是 Alt+Space（未设置时按默认）时，超级面板改为 Alt+Shift+Space 并写回', async () => {
  for (const wake of [undefined, 'Alt+Space', 'option + space']) {
    const store: Record<string, unknown> = { super_panel: legacyPanel(), ...(wake === undefined ? {} : { wake }) }
    const { config, writes } = migrationConfig(store)
    const rec = keyboardRecorder()
    const service = new SuperPanelInputService({ config, triggers: rec.triggers, nativeInput: null, toggle: () => undefined })
    await service.ready
    assert.deepEqual(rec.calls, [{ enabled: true, accelerator: 'Alt+Shift+Space' }], String(wake))
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.sync, false)
    const saved = store.super_panel as Record<string, any>
    assert.deepEqual(saved.keyboardHotkey.modifiers, ['Alt', 'Shift'])
    // 其他设置原样保留
    assert.equal(saved.panelSize, 'large')
    assert.equal(saved.mouseHotkey.button, 'middle_long')
    // 再次加载不会重复写
    await service.reload()
    assert.equal(writes.length, 1)
    await service.stop()
  }
})

test('[迁移] 用户已把全局唤醒改成别的键或已关闭（空串）时，保留超级面板的 Alt+Space 不动', async () => {
  for (const wake of ['Ctrl+Shift+Z', '', '   ']) {
    const store: Record<string, unknown> = { super_panel: legacyPanel(), wake }
    const { config, writes } = migrationConfig(store)
    const rec = keyboardRecorder()
    const service = new SuperPanelInputService({ config, triggers: rec.triggers, nativeInput: null, toggle: () => undefined })
    await service.ready
    assert.deepEqual(rec.calls, [{ enabled: true, accelerator: 'Alt+Space' }], JSON.stringify(wake))
    assert.equal(writes.length, 0)
    await service.stop()
  }
})

test('[故障注入] 写回配置失败时本次仍使用新键；读不到全局唤醒设置时不做迁移', async () => {
  {
    const store: Record<string, unknown> = { super_panel: legacyPanel() }
    const { config } = migrationConfig(store, { failSet: true })
    const rec = keyboardRecorder()
    const service = new SuperPanelInputService({ config, triggers: rec.triggers, nativeInput: null, toggle: () => undefined })
    await service.ready
    assert.deepEqual(rec.calls, [{ enabled: true, accelerator: 'Alt+Shift+Space' }])
    await service.stop()
  }
  {
    const store: Record<string, unknown> = { super_panel: legacyPanel() }
    const { config, writes } = migrationConfig(store, { failWakeRead: true })
    const rec = keyboardRecorder()
    const service = new SuperPanelInputService({ config, triggers: rec.triggers, nativeInput: null, toggle: () => undefined })
    await service.ready
    assert.deepEqual(rec.calls, [{ enabled: true, accelerator: 'Alt+Space' }])
    assert.equal(writes.length, 0)
    await service.stop()
  }
  {
    // 超级面板配置损坏：按新默认值使用，不写回、不崩溃
    const store: Record<string, unknown> = { super_panel: '{broken' }
    const { config, writes } = migrationConfig(store)
    const rec = keyboardRecorder()
    const service = new SuperPanelInputService({ config, triggers: rec.triggers, nativeInput: null, toggle: () => undefined })
    await service.ready
    assert.deepEqual(rec.calls, [{ enabled: true, accelerator: 'Alt+Shift+Space' }])
    assert.equal(writes.length, 0)
    await service.stop()
  }
})

test('[集成] 新装客户端：超级面板先注册，全局唤醒随后用默认 Alt+Space 也能注册成功，两个键各自生效', async () => {
  const store = new MemoryTriggerStore()
  const registered = new Map<string, () => void>()
  let panelToggles = 0
  let mainToggles = 0
  const triggers = new TriggerService({
    dataRoot: 'unused',
    store,
    shortcuts: {
      register(accelerator, callback) {
        const key = accelerator.toLowerCase()
        if (registered.has(key)) return false
        registered.set(key, callback)
        return true
      },
      unregister(accelerator) { registered.delete(accelerator.toLowerCase()) }
    },
    events: { publishHost: () => ({ success: true, delivered: 0 }) },
    toggleMainWindow: () => { mainToggles += 1 },
    toggleSuperPanel: () => { panelToggles += 1 },
    openPlugin: async () => undefined
  })
  const { config } = migrationConfig({})
  const panel = new SuperPanelInputService({ config, triggers, nativeInput: null, toggle: () => undefined })
  await panel.ready
  await triggers.register({
    id: 'global_wake_hotkey', pluginId: 'system', type: 'hotkey', enabled: true,
    config: { key: 'Alt+Space' }, actionMode: 'builtin', actionTarget: 'toggle_main_window', actionParams: {}
  } as never, { type: 'main', webContentsId: 1 })
  registered.get('alt+space')?.()
  registered.get('alt+shift+space')?.()
  assert.equal(mainToggles, 1)
  assert.equal(panelToggles, 1)
  await panel.stop()
  await triggers.stop()
})
