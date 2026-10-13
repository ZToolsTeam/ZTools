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
  assert.deepEqual(keyboard.at(-1), { enabled: false, accelerator: 'Alt+Space' })
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
