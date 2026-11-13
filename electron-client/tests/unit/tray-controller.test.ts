import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MenuItemConstructorOptions } from 'electron'
import { ConfigService } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { decideCloseAction, readClosePreferences } from '../../src/main/windows/close-behavior.js'
import {
  buildTrayMenuTemplate,
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

test('normalizeTrayAccelerator handles empty, non-string, control-char, and oversized inputs safely', () => {
  assert.equal(normalizeTrayAccelerator(undefined), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator(null), DEFAULT_TRAY_WAKE_ACCELERATOR)
  assert.equal(normalizeTrayAccelerator(12345), DEFAULT_TRAY_WAKE_ACCELERATOR)
  // 空串是用户关闭了全局唤醒，不能退回默认值
  assert.equal(normalizeTrayAccelerator(''), '')
  assert.equal(normalizeTrayAccelerator('   '), '')
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

  // 旧“启用超级面板”菜单项已移除
  assert.equal(tray.latestMenu.some((item) => item.id === 'toggle-super-panel'), false)

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

test('Integration: TrayController + ConfigService + decideCloseAction 端到端同步唤醒快捷键与退出决策', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-tray-integration-'))
  try {
    const store = new JsonFileStore(tempDir, ConfigService.allowedStoreFiles)
    const configService = new ConfigService(store)
    let exitDecision: string | null = null
    const { trays, deps } = createTrayHarness()

    const trayController = new TrayController({
      icon: createFakeIcon(false),
      wakeAccelerator: await configService.get('user_settings.json', 'hotkey.global', 'Alt+Space'),
      showMainWindow: () => undefined,
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
    // 旧“启用超级面板”菜单项已移除
    assert.equal(tray.latestMenu.some((item) => item.id === 'toggle-super-panel'), false)

    // 1. 设置里修改全局唤醒快捷键 -> 同步到托盘菜单
    await configService.set('user_settings.json', 'hotkey.global', 'Ctrl+Space', true)
    trayController.updateState({
      wakeAccelerator: await configService.get('user_settings.json', 'hotkey.global', 'Alt+Space')
    })
    // 设置里的 Ctrl 与全局快捷键注册一致转成 CommandOrControl（macOS 显示 ⌘，Windows 显示 Ctrl）
    assert.equal(tray.findItem('open-launcher').accelerator, 'CommandOrControl+Space')

    // 2. 用户在设置里清除全局唤醒（存空串）-> 托盘菜单不再显示快捷键，也不退回默认的 Alt+Space
    await configService.set('user_settings.json', 'hotkey.global', '', true)
    trayController.updateState({
      wakeAccelerator: await configService.get('user_settings.json', 'hotkey.global', 'Alt+Space')
    })
    assert.equal(trayController.state.wakeAccelerator, '')
    assert.equal(tray.findItem('open-launcher').accelerator, undefined)

    // 3. 托盘菜单点击退出时，即使 closeConfirm 为 true 也直接退出
    await configService.setSetting('closeConfirm', true)
    await configService.setSetting('minimizeToTray', true)
    tray.findItem('quit').click?.({} as never, undefined, {} as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(exitDecision, 'quit')

    // 4. stop() 之后 updateState() 不再重建菜单
    const menuCountBeforeStop = tray.menus.length
    trayController.stop()
    trayController.updateState({ wakeAccelerator: 'Alt+F1' })
    assert.equal(tray.menus.length, menuCountBeforeStop)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('托盘菜单的唤醒快捷键与全局快捷键注册一致：设置里的 Ctrl 转为 CommandOrControl（macOS 显示 ⌘，不再显示成 Control）', () => {
  const noop = (): void => undefined
  const items = buildTrayMenuTemplate({
    wakeAccelerator: 'Ctrl+Shift+Z',
    platform: 'darwin',
    onOpenLauncher: noop,
    onShowMainWindow: noop,
    onOpenSettings: noop,
    onOpenAbout: noop,
    onRequestExit: noop
  })
  assert.equal(items.find((item) => item.id === 'open-launcher')?.accelerator, 'CommandOrControl+Shift+Z')
})
