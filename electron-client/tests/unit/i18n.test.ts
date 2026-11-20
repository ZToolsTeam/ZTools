import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { WebContents } from 'electron'
import zhCN from '../../src/main/i18n/locales/zh-CN.json'
import enUS from '../../src/main/i18n/locales/en-US.json'
import {
  DEFAULT_LOCALE,
  getLocaleSetting,
  getResolvedLocale,
  resolveLocale,
  setLocale,
  SUPPORTED_LOCALES,
  t
} from '../../src/main/i18n/index.js'
import { buildTrayMenuTemplate, TrayController, type TrayAdapter } from '../../src/main/windows/tray-controller.js'
import { macosAppSubmenuItems } from '../../src/main/platform/macos/application-menu.js'
import { SystemToolsService } from '../../src/main/services/system-tools-service.js'
import { WorkerSession, type WorkerMessageNotify, type WorkerMessageResult } from '../../src/main/extension-host/worker-entry.js'
import type { ZToolsResponse } from '../../src/contracts/ipc.js'
import type { CoreServices } from '../../src/main/services/core-services.js'
import type { IpcRouterOptions } from '../../src/main/ipc/router.js'

test('resolveLocale normalizes BCP-47 tags and falls back to en-US', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['zh-CN', 'en-US'])
  assert.equal(DEFAULT_LOCALE, 'en-US')

  for (const tag of ['zh', 'ZH', 'zh-CN', 'zh_cn', 'zh-Hans', 'zh-Hans-CN', 'zh_hans_sg', 'zh-SG', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW']) {
    assert.equal(resolveLocale(tag, 'en-US'), 'zh-CN', `expected ${tag} -> zh-CN`)
  }

  for (const tag of ['en', 'en-US', 'en_GB', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'invalid-locale', '123']) {
    assert.equal(resolveLocale(tag, 'zh-CN'), 'en-US', `expected ${tag} -> en-US`)
  }

  assert.equal(resolveLocale('system', 'zh-TW'), 'zh-CN')
  assert.equal(resolveLocale('system', 'zh_Hans_CN'), 'zh-CN')
  assert.equal(resolveLocale('system', 'ja-JP'), 'en-US')
  assert.equal(resolveLocale('system', ''), 'en-US')
  assert.equal(resolveLocale(undefined, 'zh-CN'), 'zh-CN')
  assert.equal(resolveLocale(null, 'en-GB'), 'en-US')
})

test('dictionary parity, interpolation, and fallback behavior', () => {
  const zhKeys = Object.keys(zhCN).sort()
  const enKeys = Object.keys(enUS).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh-CN.json and en-US.json must have identical key sets')

  const previous = getLocaleSetting()
  try {
    setLocale('en-US', 'zh-CN')
    assert.equal(getLocaleSetting(), 'en-US')
    assert.equal(getResolvedLocale(), 'en-US')
    assert.equal(t('tray.quit'), 'Quit ZTools')
    assert.equal(t('trigger.owner.plugin', { pluginId: 'demo' }), 'Plugin demo')
    assert.equal(t('non.existent.key'), 'non.existent.key')

    setLocale('zh-CN', 'en-US')
    assert.equal(getLocaleSetting(), 'zh-CN')
    assert.equal(getResolvedLocale(), 'zh-CN')
    assert.equal(t('tray.quit'), '退出 ZTools')
    assert.equal(t('trigger.owner.plugin', { pluginId: 'demo' }), '插件 demo')

    // Invalid locale falls back to en-US
    setLocale('fr-FR', 'zh-CN')
    assert.equal(getResolvedLocale(), 'en-US')

    // System locale resolution
    setLocale('system', 'zh-Hans-CN')
    assert.equal(getLocaleSetting(), 'system')
    assert.equal(getResolvedLocale(), 'zh-CN')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('native UI builders and SystemToolsService switch labels dynamically with locale', async () => {
  const previous = getLocaleSetting()
  try {
    setLocale('en-US')
    const enTrayItems = buildTrayMenuTemplate({
      wakeAccelerator: 'Alt+Space',
      platform: 'win32',
      onOpenLauncher: () => undefined,
      onShowMainWindow: () => undefined,
      onOpenSettings: () => undefined,
      onOpenAbout: () => undefined,
      onRelaunchApp: () => undefined,
      onRequestExit: () => undefined
    })
    assert.equal(enTrayItems.find((item) => item.id === 'open-launcher')?.label, 'Open Quick Launcher')
    assert.equal(enTrayItems.find((item) => item.id === 'quit')?.label, 'Quit ZTools')

    const enMacItems = macosAppSubmenuItems({ onOpenPreferences: () => undefined })
    assert.ok(enMacItems.some((item) => item.label === 'Preferences...'))

    // TrayController rebuilds context menu on locale change even when wakeAccelerator is unchanged
    const builtMenus: Array<Array<{ id?: string; label?: string }>> = []
    const fakeTray: TrayAdapter = {
      setToolTip: () => undefined,
      setContextMenu: (menu) => {
        if (menu) builtMenus.push((menu as unknown as { items: Array<{ id?: string; label?: string }> }).items)
      },
      on: () => undefined,
      destroy: () => undefined
    }
    const trayController = new TrayController({
      icon: { isEmpty: () => false } as unknown as Electron.NativeImage,
      wakeAccelerator: 'Alt+Space',
      showMainWindow: () => undefined,
      requestExit: () => undefined,
      deps: {
        createTray: () => fakeTray,
        buildMenu: (template) => ({ items: template }) as unknown as Electron.Menu
      }
    })
    await trayController.start()
    assert.equal(builtMenus.length, 1)
    assert.equal(builtMenus[0]?.find((item) => item.id === 'quit')?.label, 'Quit ZTools')

    setLocale('zh-CN')
    trayController.updateState({ wakeAccelerator: 'Alt+Space' })
    assert.equal(builtMenus.length, 2)
    assert.equal(builtMenus[1]?.find((item) => item.id === 'quit')?.label, '退出 ZTools')
    trayController.stop()

    // SystemToolsService returns localized name/description and opposite language in altNames
    const toolsService = new SystemToolsService({
      openExternal: async () => undefined,
      launchProcess: async () => ''
    }, 'win32')

    setLocale('en-US')
    const enTools = await toolsService.listTargets()
    const enThisPc = enTools.targets.find((item) => item.id === 'this_pc')
    assert.equal(enThisPc?.name, 'This PC')
    assert.deepEqual(enThisPc?.altNames, ['此电脑'])

    setLocale('zh-CN')
    const zhTools = await toolsService.listTargets()
    const zhThisPc = zhTools.targets.find((item) => item.id === 'this_pc')
    assert.equal(zhThisPc?.name, '此电脑')
    assert.deepEqual(zhThisPc?.altNames, ['This PC'])
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('WorkerSession handles updateLocale request and notifies listeners', async () => {
  const messages: Array<WorkerMessageResult | WorkerMessageNotify> = []
  const session = new WorkerSession((msg) => messages.push(msg))
  const receivedLocales: string[] = []
  const unsubscribe = session.onLocaleChange((locale) => receivedLocales.push(locale))

  await session.handleRequest({
    type: 'request',
    id: 'req-locale-1',
    action: 'updateLocale',
    payload: { locale: 'zh-CN' }
  })

  assert.equal(session.getLocale(), 'zh-CN')
  assert.deepEqual(receivedLocales, ['zh-CN'])
  const reply = messages.find((msg): msg is WorkerMessageResult => msg.type === 'result' && msg.id === 'req-locale-1')
  assert.ok(reply)
  assert.equal(reply.success, true)
  assert.deepEqual(reply.data, { updated: true, locale: 'zh-CN' })

  unsubscribe()
  session.terminate()
})

test('IpcRouter config_set ui.locale updates state, broadcasts system.LocaleChange, notifies workers, and exposes locale in get_system_info', async () => {
  const previous = getLocaleSetting()
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-i18n-router-'))
  const dataRoot = path.join(tempRoot, 'data')
  const pluginRoot = path.join(tempRoot, 'plugins')
  const webRoot = path.join(tempRoot, 'web')
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(pluginRoot, { recursive: true })
  await fs.mkdir(webRoot, { recursive: true })

  // Mock electron module in Node test environment if not already running inside Electron
  const Module = require('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = Module._load
  const ipcHandlers = new Map<string, (event: unknown, value: unknown) => unknown>()
  let mockSystemLocale = 'zh-CN'

  const electronMock = {
    app: {
      getPath: () => tempRoot,
      getAppPath: () => tempRoot,
      isPackaged: false,
      runningUnderARM64Translation: false,
      getFileIcon: async () => ({ toDataURL: () => '' }),
      getLocale: () => mockSystemLocale,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => undefined
    },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, value: unknown) => unknown) => {
        ipcHandlers.set(channel, handler)
      },
      removeHandler: (channel: string) => {
        ipcHandlers.delete(channel)
      },
      on: () => undefined,
      removeListener: () => undefined
    },
    nativeTheme: Object.assign(new EventEmitter(), {
      themeSource: 'system',
      shouldUseDarkColors: false
    }),
    globalShortcut: {
      register: () => true,
      unregister: () => undefined,
      isRegistered: () => false
    },
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    clipboard: {},
    desktopCapturer: {},
    nativeImage: {},
    net: {},
    powerSaveBlocker: { start: () => 1, stop: () => undefined },
    screen: {},
    shell: {},
    systemPreferences: {},
    utilityProcess: {}
  }

  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return electronMock
    try {
      return originalLoad.call(this, request, parent, isMain)
    } catch (error) {
      if (request === 'ini') {
        return { parse: () => ({}), stringify: () => '' }
      }
      throw error
    }
  }

  const routerModulePath = require.resolve('../../src/main/ipc/router.js')
  const cachedRouter = require.cache[routerModulePath]
  delete require.cache[routerModulePath]

  try {
    const { IpcRouter } = require(routerModulePath) as typeof import('../../src/main/ipc/router.js')
    const { WindowRegistry } = require('../../src/main/windows/window-registry.js') as typeof import('../../src/main/windows/window-registry.js')

    const registry = new WindowRegistry()
    const sentEvents: Array<{ channel: string; payload: unknown }> = []
    class FakeContents extends EventEmitter {
      readonly session = {}
      constructor(readonly id: number) { super() }
      getURL(): string { return 'ztools://web/index.html' }
      isDestroyed(): boolean { return false }
      send(channel: string, payload: unknown): void {
        sentEvents.push({ channel, payload })
      }
    }
    const mainContents = new FakeContents(101)
    registry.registerMain(mainContents as unknown as WebContents)

    const localeCallbacks: string[] = []
    const workerLocales: string[] = []
    const hostLocales: string[] = []
    const configStore = new Map<string, unknown>()

    const cacheRoot = path.join(tempRoot, 'cache')
    const transactionRoot = path.join(tempRoot, 'tx')
    await fs.mkdir(cacheRoot, { recursive: true })
    await fs.mkdir(transactionRoot, { recursive: true })

    const fakeServices = {
      dataRoot,
      runtimePaths: {
        mode: 'development',
        installRoot: tempRoot,
        productRoot: tempRoot,
        businessDataRoot: dataRoot,
        browserProfileRoot: path.join(tempRoot, 'profile'),
        cacheRoot,
        logRoot: path.join(tempRoot, 'logs'),
        transactionRoot
      },
      appVersion: '1.0.0',
      webVersion: '1.0.0',
      config: {
        get: async (file: string, key: string, fallback: unknown) =>
          configStore.has(`${file}:${key}`) ? configStore.get(`${file}:${key}`) : fallback,
        set: async (file: string, key: string, value: unknown) => {
          configStore.set(`${file}:${key}`, value)
        },
        getSetting: async () => undefined,
        setSetting: async (_key: string, value: unknown) => value,
        getFeature: async () => false,
        getFeatures: async () => ({}),
        setFeature: async (_k: string, v: boolean) => v,
        setFeatures: async (v: Record<string, boolean>) => v
      },
      user: { getInfo: async () => ({ logged_in: false }), setToken: async () => false, logout: async () => undefined },
      analytics: { report: () => undefined, reportStartup: () => undefined, reportLaunch: () => undefined, stop: () => undefined },
      clipboardHistory: { useImageThumbnailer: () => undefined },
      nativeHost: {
        state: 'ready',
        onDllEvent: () => () => undefined,
        onInputEvent: () => () => undefined,
        onLifecycleEvent: () => () => undefined
      },
      serviceClient: null,
      update: {
        onProgress: () => () => undefined,
        check: async () => ({ success: true, source: 'manual', app: null, web: null }),
        getVersion: () => ({ appVersion: '1.0.0', webVersion: '1.0.0' }),
        download: async () => ({}),
        install: async () => ({}),
        cancel: () => ({ success: true })
      },
      sidecars: {
        searchFiles: async () => ({ files: [], subdirs: [] }),
        getStatus: () => ({})
      },
      focus: {},
      stop: async () => undefined
    } as unknown as CoreServices

    const router = await IpcRouter.create(registry, fakeServices, {
      pluginResources: { webRoot: () => webRoot, pluginRoot },
      toggleMainWindow: () => undefined,
      closeConfirmationResolved: () => undefined,
      screenClipboardAdapters: {
        screen: {
          capture: async () => ({}),
          getCursorPos: () => ({ x: 0, y: 0 }),
          getPrimaryDisplay: () => ({}),
          getAllDisplays: () => [],
          getDisplayNearest: () => ({}),
          getDisplayMatching: () => ({})
        },
        clipboard: {
          readText: () => '',
          writeText: () => undefined,
          readImage: () => '',
          writeImage: () => undefined,
          readFiles: () => [],
          writeFiles: () => undefined,
          clear: () => undefined
        }
      } as unknown as IpcRouterOptions['screenClipboardAdapters'],
      systemPlatformAdapter: {
        userDataPath: dataRoot,
        getRuntimeTarget: () => ({ platform: process.platform, runtime: 'electron', arch: process.arch }),
        getNativeId: async () => '12345678',
        readCurrentFolder: async () => '',
        readCurrentBrowserUrl: async () => ({ url: '', browser: '' })
      } as unknown as IpcRouterOptions['systemPlatformAdapter'],
      processDiscoveryAdapter: {
        listProcesses: async () => [],
        listPorts: async () => []
      } as unknown as IpcRouterOptions['processDiscoveryAdapter'],
      onLocaleChanged: (locale) => { localeCallbacks.push(locale) },
      workerPool: {
        broadcastLocale: (locale) => { workerLocales.push(locale) }
      },
      extensionHost: {
        updateLocale: (locale) => { hostLocales.push(locale) }
      }
    })
    router.register()

    const invoke = ipcHandlers.get('ztools:call')
    assert.ok(invoke, 'ztools:call handler should be registered')

    let seq = 0
    const call = async (method: string, params: unknown) =>
      await invoke({ sender: mainContents }, { messageId: `i18n-${++seq}`, method, params }) as ZToolsResponse

    // Subscribe to system.LocaleChange
    const subRes = await call('event_subscribe', { key: 'system.LocaleChange' })
    assert.equal(subRes.success, true)

    // 1. Switch to en-US
    const setEn = await call('config_set', { file: 'user_settings.json', path: 'ui.locale', value: 'en-US', sync_enabled: true })
    assert.equal(setEn.success, true)
    assert.equal(getResolvedLocale(), 'en-US')
    assert.deepEqual(localeCallbacks, ['en-US'])
    assert.deepEqual(workerLocales, ['en-US'])
    assert.deepEqual(hostLocales, ['en-US'])

    const infoEn = await call('get_system_info', {})
    assert.equal(infoEn.success, true)
    assert.equal((infoEn.data as { locale?: string }).locale, 'en-US')

    // 2. Switch to system (mockSystemLocale = 'zh-CN')
    mockSystemLocale = 'zh-CN'
    const setSys = await call('config_set', { file: 'user_settings.json', path: 'ui.locale', value: 'system', sync_enabled: true })
    assert.equal(setSys.success, true)
    assert.equal(getLocaleSetting(), 'system')
    assert.equal(getResolvedLocale(), 'zh-CN')
    assert.deepEqual(localeCallbacks, ['en-US', 'zh-CN'])
    assert.deepEqual(workerLocales, ['en-US', 'zh-CN'])
    assert.deepEqual(hostLocales, ['en-US', 'zh-CN'])

    // 3. Invalid locale falls back to en-US
    const setInvalid = await call('config_set', { file: 'user_settings.json', path: 'ui.locale', value: 'es-ES', sync_enabled: true })
    assert.equal(setInvalid.success, true)
    assert.equal(getResolvedLocale(), 'en-US')

    const localeEvents = sentEvents
      .map((entry) => entry.payload as {
        msgType?: string
        msgData?: { envelope?: { type?: string; payload?: { setting?: string; locale?: string } } }
      })
      .filter((payload) => payload.msgType === 'event_envelope' && payload.msgData?.envelope?.type === 'system.LocaleChange')
    assert.equal(localeEvents.length, 3)
    assert.deepEqual(localeEvents[0]?.msgData?.envelope?.payload, { setting: 'en-US', locale: 'en-US' })
    assert.deepEqual(localeEvents[1]?.msgData?.envelope?.payload, { setting: 'system', locale: 'zh-CN' })
    assert.deepEqual(localeEvents[2]?.msgData?.envelope?.payload, { setting: 'en-US', locale: 'en-US' })

    await router.stop()
  } finally {
    Module._load = originalLoad
    if (cachedRouter) require.cache[routerModulePath] = cachedRouter
    else delete require.cache[routerModulePath]
    setLocale(previous, 'zh-CN')
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
