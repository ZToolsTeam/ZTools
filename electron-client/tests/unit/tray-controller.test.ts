import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MenuItemConstructorOptions } from 'electron'
import { ConfigService } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { decodeSuperPanelConfig } from '../../src/main/super-panel/config.js'
import { SuperPanelInputService } from '../../src/main/super-panel/input-service.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeMouseTriggerConfig
} from '../../src/main/native-host/native-host-client.js'
import { decideCloseAction, readClosePreferences } from '../../src/main/windows/close-behavior.js'
import {
  DEFAULT_TRAY_WAKE_ACCELERATOR,
  normalizeTrayAccelerator,
  TrayController,
  type TrayAdapter
} from '../../src/main/windows/tray-controller.js'

class FakeTray implements TrayAdapter {
  toolTip = ''
  menus: MenuItemConstructorOptions[][] = []
  destroyed = false
  readonly listeners = new Map<'click' | 'double-click', () => void>()

  setToolTip(toolTip: string): void {
    this.toolTip = toolTip
  }

  setContextMenu(menu: Electron.Menu | null): void {
    if (menu) {
      this.menus.push((menu as unknown as { items: MenuItemConstructorOptions[] }).items)
    }
  }

  on(event: 'click' | 'double-click', listener: () => void): unknown {
    this.listeners.set(event, listener)
    return this
  }

  destroy(): void {
    this.destroyed = true
  }

  get latestMenu(): MenuItemConstructorOptions[] {
    return this.menus.at(-1) ?? []
  }

  findItem(id: string): MenuItemConstructorOptions {
    const found = this.latestMenu.find((item) => item.id === id)
    assert.ok(found, `Expected tray menu item "${id}" to exist`)
    return found
  }
}

function createFakeIcon(empty = false): Electron.NativeImage {
  return {
    isEmpty: () => empty
  } as unknown as Electron.NativeImage
}

function createTrayHarness() {
  const trays: FakeTray[] = []
  const deps = {
    createTray: () => {
      const tray = new FakeTray()
      trays.push(tray)
      return tray
    },
    buildMenu: (template: MenuItemConstructorOptions[]) =>
      ({ items: template }) as unknown as Electron.Menu
  }
  return { trays, deps }
}

class FakeNativeInput {
  state = 'ready'
  failNextConfigure: Error | null = null
  readonly configurations: Array<NativeMouseTriggerConfig | null> = []
  inputListener: ((event: NativeInputEvent) => void) | undefined
  lifecycleListener: ((event: NativeHostLifecycleEvent) => void) | undefined

  async configureMouseTrigger(config: NativeMouseTriggerConfig | null): Promise<void> {
    if (this.failNextConfigure) {
      const err = this.failNextConfigure
      this.failNextConfigure = null
      throw err
    }
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

test('normalizeTrayAccelerator handles empty, non-string, control-char, and oversized inputs safely', () => {
  assert.equal(normalizeTrayAccelerator(undefined), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator(null), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator(12345), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator(''), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator('   '), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator('Alt+Space\nInjected'), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator('Alt+\0Space'), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator('A'.repeat(65)), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator('  Ctrl+Shift+Space  '), 'Ctrl+Shift+Space')
})

test('TrayController rejects empty or invalid tray icons and guarantees start() idempotency', async () => {
  const { trays, deps } = createTrayHarness()

  const emptyController = new TrayController({
    icon: createFakeIcon(true),
    showMainWindow: () => undefined,
    requestExit: () => undefined,
    deps
  })
  await assert.rejects(() => emptyController.start(), /无法加载 ZTools 托盘图标/)

  const nullIconController = new TrayController({
    icon: null as unknown as Electron.NativeImage,
    showMainWindow: () => undefined,
    requestExit: () => undefined,
    deps
  })
  await assert.rejects(() => nullIconController.start(), /无法加载 ZTools 托盘图标/)
  assert.equal(trays.length, 0)

  const validController = new TrayController({
    icon: createFakeIcon(false),
    showMainWindow: () => undefined,
    requestExit: () => undefined,
    deps
  })
  await validController.start()
  await validController.start()
  assert.equal(trays.length, 1)
  validController.stop()
  assert.equal(trays[0]?.destroyed, true)
})

test('TrayController builds Raycast-aligned menu items and dispatches actions across platforms', async () => {
  const { trays, deps } = createTrayHarness()
  const events: string[] = []

  const controller = new TrayController({
    icon: createFakeIcon(false),
    isSuperPanelEnabled: true,
    wakeAccelerator: 'Option+Space',
    platform: 'darwin',
    showMainWindow: () => { events.push('showMainWindow') },
    togglePrimaryWindow: () => { events.push('togglePrimaryWindow') },
    openLauncher: () => { events.push('openLauncher') },
    openSettings: () => { events.push('openSettings') },
    openAbout: () => { events.push('openAbout') },
    relaunchApp: () => { events.push('relaunchApp') },
    requestExit: () => { events.push('requestExit') },
    deps
  })

  await controller.start()
  const tray = trays[0]!
  assert.equal(tray.toolTip, 'ZTools')

  const launcherItem = tray.findItem('open-launcher')
  assert.equal(launcherItem.label, '打开极客搜索')
  assert.equal(launcherItem.accelerator, 'Option+Space')

  const settingsItem = tray.findItem('open-settings')
  assert.equal(settingsItem.label, '偏好设置...')
  assert.equal(settingsItem.accelerator, 'Command+,')

  const superPanelItem = tray.findItem('toggle-super-panel')
  assert.equal(superPanelItem.type, 'checkbox')
  assert.equal(superPanelItem.checked, true)

  launcherItem.click?.({} as never, undefined, {} as never)
  tray.findItem('open-dashboard').click?.({} as never, undefined, {} as never)
  settingsItem.click?.({} as never, undefined, {} as never)
  tray.findItem('open-about').click?.({} as never, undefined, {} as never)
  tray.findItem('relaunch').click?.({} as never, undefined, {} as never)
  tray.findItem('quit').click?.({} as never, undefined, {} as never)
  tray.listeners.get('click')?.()
  tray.listeners.get('double-click')?.()

  assert.deepEqual(events, [
    'openLauncher',
    'showMainWindow',
    'openSettings',
    'openAbout',
    'relaunchApp',
    'requestExit',
    'togglePrimaryWindow',
    'showMainWindow'
  ])
})

test('TrayController falls back to showMainWindow when optional callbacks are omitted and isolates callback errors', async () => {
  const { trays, deps } = createTrayHarness()
  let showCalls = 0

  const controller = new TrayController({
    icon: createFakeIcon(false),
    platform: 'win32',
    showMainWindow: () => {
      showCalls += 1
      if (showCalls === 2) throw new Error('simulated window error')
    },
    requestExit: () => {
      throw new Error('simulated exit error')
    },
    deps
  })

  await controller.start()
  const tray = trays[0]!
  assert.equal(tray.findItem('open-settings').accelerator, 'Ctrl+,')
  assert.equal(tray.latestMenu.some((item) => item.id === 'relaunch'), false)

  // Omitted optional callbacks safely fall back to showMainWindow and do not throw out of click handlers
  assert.doesNotThrow(() => {
    tray.findItem('open-launcher').click?.({} as never, undefined, {} as never)
    tray.findItem('open-settings').click?.({} as never, undefined, {} as never)
    tray.findItem('open-about').click?.({} as never, undefined, {} as never)
    tray.findItem('quit').click?.({} as never, undefined, {} as never)
    tray.listeners.get('click')?.()
  })
  assert.equal(showCalls, 4)
})

test('Integration: TrayController + ConfigService + SuperPanelInputService + decideCloseAction end-to-end flow and error rollback', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-tray-integration-'))
  try {
    const store = new JsonFileStore(tempDir, ConfigService.allowedStoreFiles)
    const configService = new ConfigService(store)
    const nativeInput = new FakeNativeInput()
    const syncedHotkeys: Array<{ enabled: boolean; accelerator: string }> = []
    const hiddenReasons: string[] = []
    let exitDecision: string | null = null

    const superPanelInput = new SuperPanelInputService({
      config: configService,
      triggers: {
        async syncSuperPanelHotkey(enabled, accelerator) {
          syncedHotkeys.push({ enabled, accelerator })
        }
      },
      nativeInput,
      toggle: () => undefined
    })
    await superPanelInput.ready

    // Initial state: super panel enabled by default
    assert.equal(nativeInput.configurations.length, 1)
    assert.deepEqual(nativeInput.configurations[0], { button: 'middle', action: 'long', longPressMs: 300 })

    const { trays, deps } = createTrayHarness()
    const rawInitialSuperPanel = await configService.get('user_settings.json', 'super_panel', {})
    const initialSuperPanel = decodeSuperPanelConfig(rawInitialSuperPanel)

    const trayController = new TrayController({
      icon: createFakeIcon(false),
      isSuperPanelEnabled: initialSuperPanel.enabled,
      wakeAccelerator: await configService.get('user_settings.json', 'hotkey.global', 'Alt+Space'),
      showMainWindow: () => undefined,
      onToggleSuperPanel: async (enabled) => {
        await configService.set('user_settings.json', 'super_panel.enabled', String(enabled), false)
        if (!enabled) {
          hiddenReasons.push('tray_disabled')
        }
        await superPanelInput.reload()
      },
      requestExit: () => {
        void (async () => {
          const prefs = await readClosePreferences(configService)
          exitDecision = decideCloseAction(prefs, 'trayMenu')
        })()
      },
      deps
    })

    await trayController.start()
    const tray = trays[0]!
    assert.equal(tray.findItem('toggle-super-panel').checked, true)

    // 1. Disable Super Panel from Tray -> persists to disk, hides panel, unhooks mouse & keyboard
    tray.findItem('toggle-super-panel').click?.({ checked: false } as never, undefined, {} as never)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(trayController.state.isSuperPanelEnabled, false)
    assert.equal(tray.findItem('toggle-super-panel').checked, false)
    assert.deepEqual(hiddenReasons, ['tray_disabled'])
    assert.equal(nativeInput.configurations.at(-1), null)
    assert.equal(syncedHotkeys.at(-1)?.enabled, false)

    const persistedRaw = await configService.get('user_settings.json', 'super_panel', {})
    assert.equal(decodeSuperPanelConfig(persistedRaw).enabled, false)

    // 2. Simulate failure when re-enabling Super Panel -> TrayController must rollback checkbox to false
    nativeInput.failNextConfigure = new Error('native hook busy')
    tray.findItem('toggle-super-panel').click?.({ checked: true } as never, undefined, {} as never)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(trayController.state.isSuperPanelEnabled, false)
    assert.equal(tray.findItem('toggle-super-panel').checked, false)

    // 3. External settings update (user changes hotkey & enables super panel in Settings UI) -> syncs to Tray
    await configService.set('user_settings.json', 'hotkey.global', 'Ctrl+Space', true)
    await configService.set('user_settings.json', 'super_panel.enabled', 'true', false)
    await superPanelInput.reload()
    trayController.updateState({
      isSuperPanelEnabled: decodeSuperPanelConfig(await configService.get('user_settings.json', 'super_panel', {})).enabled,
      wakeAccelerator: await configService.get('user_settings.json', 'hotkey.global', 'Alt+Space')
    })

    assert.equal(tray.findItem('toggle-super-panel').checked, true)
    assert.equal(tray.findItem('open-launcher').accelerator, 'Ctrl+Space')
    assert.deepEqual(nativeInput.configurations.at(-1), { button: 'middle', action: 'long', longPressMs: 300 })

    // 4. Clicking Quit in Tray bypasses closeConfirm modal even when closeConfirm is true
    await configService.setSetting('closeConfirm', true)
    await configService.setSetting('minimizeToTray', true)
    tray.findItem('quit').click?.({} as never, undefined, {} as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(exitDecision, 'quit')

    // 5. After stop(), updateState() is a no-op
    const menuCountBeforeStop = tray.menus.length
    trayController.stop()
    trayController.updateState({ isSuperPanelEnabled: false, wakeAccelerator: 'Alt+F1' })
    assert.equal(tray.menus.length, menuCountBeforeStop)

    await superPanelInput.stop()
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
