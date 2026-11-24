import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
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
  matchSupportedLocale,
  normalizeLocaleSetting,
  resolveLocale,
  setLocale,
  stripLocaleSuffix,
  SUPPORTED_LOCALES,
  syncProcessLocaleEnv,
  t,
  ZTOOLS_LOCALE_ENV_KEY
} from '../../src/main/i18n/index.js'
import { handleLauncherCall } from '../../src/main/windows/launcher-controller.js'
import { GeekToolsService } from '../../src/main/services/geek-tools-service.js'
import { renderMarkdown } from '../../src/main/services/markdown-renderer.js'
import {
  INSTALL_LOCALE_QUERY_TIMEOUT_MS,
  parseCommandLineLocale,
  readInstallLocale,
  resolveStartupLocale,
  type RegQueryRunner
} from '../../src/main/i18n/install-locale.js'
import { buildTrayMenuTemplate, TrayController, type TrayAdapter } from '../../src/main/windows/tray-controller.js'
import { macosAppSubmenuItems } from '../../src/main/platform/macos/application-menu.js'
import { SystemToolsService } from '../../src/main/services/system-tools-service.js'
import { WorkerSession, type WorkerMessageNotify, type WorkerMessageResult } from '../../src/main/extension-host/worker-entry.js'
import type { ExtensionHostRequest, ZToolsResponse } from '../../src/contracts/ipc.js'
import type { CoreServices } from '../../src/main/services/core-services.js'
import type { IpcRouterOptions } from '../../src/main/ipc/router.js'
import {
  getAllPluginSearchKeywords,
  getLocalizedPluginDescription,
  getLocalizedPluginFeature,
  getLocalizedPluginKeywords,
  getLocalizedPluginName,
  getPluginAltNames,
  normalizePluginCategoryId,
  PLUGIN_CATEGORY_IDS,
  resolvePluginCategoryIds
} from '../../src/main/i18n/plugin-i18n.js'
import { SuperPanelDataService } from '../../src/main/super-panel/data-service.js'
import {
  DllPluginService,
  localizeDllErrorPayload,
  localizeDllProgressMessage,
  sanitizeDllErrorParams,
  withDllLocale
} from '../../src/main/services/dll-plugin-service.js'
import { buildAudioArguments } from '../../src/main/services/host-plugins/audio-processing.js'
import { UpdateService } from '../../src/main/services/update-service.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { createHash } from 'node:crypto'
import type { NativeDllCallResult, NativeDllEvent } from '../../src/main/native-host/dll-client-port.js'
import type { PluginManifest } from '../../src/main/services/plugin-install-service.js'
import {
  NetworkHostPluginHandler,
  renderLanShareHtml,
  resolveLanShareLocale
} from '../../src/main/services/host-plugins/network-host.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'
import { FocusService } from '../../src/main/services/focus-service.js'
import { HudService } from '../../src/main/services/hud-service.js'
import { KeyboardLockService } from '../../src/main/services/keyboard-lock-service.js'
import { MacAppUpdater, type MacAutoUpdater } from '../../src/main/platform/macos/app-update.js'
import { TriggerService, type GlobalShortcutAdapter } from '../../src/main/services/trigger-service.js'
import {
  getWindowActionMeta,
  WINDOW_ACTIONS,
  WindowManagementService,
  type WindowActionName
} from '../../src/main/services/window-management-service.js'
import { NavigationService } from '../../src/main/services/navigation-service.js'
import { errorCodes, toPublicError, ZToolsError } from '../../src/contracts/errors.js'
import { sanitizeErrorI18nParams, toLocalizedPublicError } from '../../src/main/ipc/error-localizer.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { PluginWindowManager } from '../../src/main/windows/plugin-window-manager.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'
import { recordBarHtml, WindowService } from '../../src/main/services/window-service.js'

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

test('IpcRouter config_set ui.locale updates state, broadcasts system.LocaleChange, handles ui reset, and exposes locale in get_system_info', async () => {
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
      onLocaleChanged: (locale) => { localeCallbacks.push(locale) }
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

    // 先将初始语言固定为 zh-CN，便于精确校验 previousLocale 流转
    setLocale('zh-CN', 'zh-CN')

    // 1. Switch to en-US (zh-CN -> en-US)
    const setEn = await call('config_set', { file: 'user_settings.json', path: 'ui.locale', value: 'en-US', sync_enabled: true })
    assert.equal(setEn.success, true)
    assert.equal(getResolvedLocale(), 'en-US')
    assert.deepEqual(localeCallbacks, ['en-US'])

    const infoEn = await call('get_system_info', {})
    assert.equal(infoEn.success, true)
    assert.equal((infoEn.data as { locale?: string }).locale, 'en-US')

    // 2. Switch to system (mockSystemLocale = 'zh-CN', en-US -> zh-CN)
    mockSystemLocale = 'zh-CN'
    const setSys = await call('config_set', { file: 'user_settings.json', path: 'ui.locale', value: 'system', sync_enabled: true })
    assert.equal(setSys.success, true)
    assert.equal(getLocaleSetting(), 'system')
    assert.equal(getResolvedLocale(), 'zh-CN')
    assert.deepEqual(localeCallbacks, ['en-US', 'zh-CN'])

    // 3. Invalid locale falls back to en-US (zh-CN -> en-US)
    const setInvalid = await call('config_set', { file: 'user_settings.json', path: 'ui.locale', value: 'es-ES', sync_enabled: true })
    assert.equal(setInvalid.success, true)
    assert.equal(getResolvedLocale(), 'en-US')

    // 4. Overwriting ui without locale resets setting back to system (mockSystemLocale = 'zh-CN', en-US -> zh-CN)
    const clearUi = await call('config_set', { file: 'user_settings.json', path: 'ui', value: '{}', sync_enabled: true })
    assert.equal(clearUi.success, true)
    assert.equal(getLocaleSetting(), 'system')
    assert.equal(getResolvedLocale(), 'zh-CN')
    assert.deepEqual(localeCallbacks, ['en-US', 'zh-CN', 'en-US', 'zh-CN'])

    const localeEvents = sentEvents
      .map((entry) => entry.payload as {
        msgType?: string
        msgData?: { envelope?: { type?: string; payload?: { setting?: string; locale?: string; previousLocale?: string } } }
      })
      .filter((payload) => payload.msgType === 'event_envelope' && payload.msgData?.envelope?.type === 'system.LocaleChange')
    assert.equal(localeEvents.length, 4)
    assert.deepEqual(localeEvents[0]?.msgData?.envelope?.payload, { setting: 'en-US', locale: 'en-US', previousLocale: 'zh-CN' })
    assert.deepEqual(localeEvents[1]?.msgData?.envelope?.payload, { setting: 'system', locale: 'zh-CN', previousLocale: 'en-US' })
    assert.deepEqual(localeEvents[2]?.msgData?.envelope?.payload, { setting: 'en-US', locale: 'en-US', previousLocale: 'zh-CN' })
    assert.deepEqual(localeEvents[3]?.msgData?.envelope?.payload, { setting: 'system', locale: 'zh-CN', previousLocale: 'en-US' })

    // 契约级类型校验：ExtensionHostRequest.action 必须允许 'updateLocale'
    const updateLocaleRequest: ExtensionHostRequest = {
      id: 'ext-locale-1',
      action: 'updateLocale',
      payload: { locale: 'en-US' }
    }
    assert.equal(updateLocaleRequest.action, 'updateLocale')

    await router.stop()
  } finally {
    Module._load = originalLoad
    if (cachedRouter) require.cache[routerModulePath] = cachedRouter
    else delete require.cache[routerModulePath]
    setLocale(previous, 'zh-CN')
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('plugin-i18n resolves localized plugin metadata, features, altNames and cross-language search keywords', () => {
  const previous = getLocaleSetting()
  try {
    const manifest: Record<string, unknown> = {
      id: 'demo.json-tool',
      name: 'JSON 工具',
      description: '格式化与校验 JSON 数据',
      keywords: ['格式化', '校验'],
      features: [
        {
          code: 'format',
          explain: '美化 JSON',
          cmds: ['美化JSON', { type: 'regex', label: '正则匹配JSON', match: '^\\{' }]
        }
      ],
      i18n: {
        'en-US': {
          name: 'JSON Formatter',
          description: 'Format and validate JSON payloads',
          keywords: ['json', 'pretty'],
          features: {
            format: {
              explain: 'Pretty print JSON',
              cmds: ['format json', { type: 'regex', label: 'Match JSON Object', match: '^\\{' }]
            }
          }
        },
        'zh-CN': {
          name: 'JSON 格式化工具',
          description: '一键美化与校验 JSON',
          keywords: ['代码格式化'],
          features: {
            format: {
              explain: '一键格式化 JSON',
              cmds: ['格式化JSON']
            }
          }
        }
      }
    }

    setLocale('en-US')
    assert.equal(getLocalizedPluginName(manifest), 'JSON Formatter')
    assert.equal(getLocalizedPluginDescription(manifest), 'Format and validate JSON payloads')
    assert.deepEqual(getLocalizedPluginKeywords(manifest), ['json', 'pretty'])
    assert.deepEqual(getLocalizedPluginFeature(manifest, 'format'), {
      explain: 'Pretty print JSON',
      cmds: ['format json', { type: 'regex', label: 'Match JSON Object', match: '^\\{' }]
    })
    assert.deepEqual(getPluginAltNames(manifest), ['JSON 工具', 'JSON 格式化工具'])
    const enSearchKeywords = getAllPluginSearchKeywords(manifest)
    for (const expected of ['json', 'pretty', '格式化', 'JSON 工具', 'JSON 格式化工具', '代码格式化', 'format json', 'Match JSON Object', '格式化JSON', '美化JSON', '正则匹配JSON']) {
      assert.ok(enSearchKeywords.includes(expected), `expected search keyword "${expected}" in ${JSON.stringify(enSearchKeywords)}`)
    }

    setLocale('zh-CN')
    assert.equal(getLocalizedPluginName(manifest), 'JSON 格式化工具')
    assert.equal(getLocalizedPluginDescription(manifest), '一键美化与校验 JSON')
    assert.deepEqual(getLocalizedPluginKeywords(manifest), ['代码格式化'])
    assert.equal(getLocalizedPluginFeature(manifest, 'format').explain, '一键格式化 JSON')
    assert.deepEqual(getPluginAltNames(manifest), ['JSON 工具', 'JSON Formatter'])

    // 缺省或畸形 i18n 字段时安全回退至顶层 manifest 字段
    const malformed: Record<string, unknown> = {
      id: 'demo.fallback',
      name: 'Fallback Name',
      description: 'Fallback Desc',
      i18n: 'not-an-object'
    }
    assert.equal(getLocalizedPluginName(malformed, 'en-US'), 'Fallback Name')
    assert.equal(getLocalizedPluginDescription(malformed, 'en-US'), 'Fallback Desc')
    assert.deepEqual(getPluginAltNames(malformed, 'en-US'), [])
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('SuperPanelDataService localizes plugin metadata, merges bilingual keywords, and preserves SystemTools altNames and localized categories', async (context) => {
  const previous = getLocaleSetting()
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-i18n-super-panel-'))
  context.after(async () => {
    setLocale(previous, 'zh-CN')
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  const toolsService = new SystemToolsService({
    openExternal: async () => undefined,
    launchProcess: async () => ''
  }, 'win32')

  const service = new SuperPanelDataService(
    tempRoot,
    {
      get: async () => JSON.stringify({ pinnedSchemaVersion: 2, pinnedEntries: [] }),
      set: async () => undefined
    },
    async () => ({
      success: true,
      data: [
        {
          id: 'plugin.bilingual',
          name: '密码生成器',
          description: '生成高强度随机密码',
          keywords: ['密码', '随机'],
          features: [{ code: 'gen', explain: '生成密码', cmds: ['生成密码'] }],
          enabled: true,
          i18n: {
            'en-US': {
              name: 'Password Generator',
              description: 'Generate strong random passwords',
              keywords: ['password', 'keygen'],
              features: {
                gen: {
                  explain: 'Generate password',
                  cmds: ['gen pass']
                }
              }
            }
          }
        }
      ]
    }),
    async () => '',
    undefined,
    undefined,
    toolsService
  )

  // 英文模式：插件与系统工具均显示英文，且保留中文 altNames 与跨语言搜索关键词
  setLocale('en-US')
  const enData = await service.getData()
  const enPlugin = enData.items.find((item) => item.id === 'plugin.bilingual')
  assert.ok(enPlugin)
  assert.equal(enPlugin.name, 'Password Generator')
  assert.equal(enPlugin.description, 'Generate strong random passwords')
  assert.deepEqual(enPlugin.altNames, ['密码生成器'])
  for (const kw of ['password', 'keygen', '密码', '随机', '密码生成器', 'gen pass', '生成密码']) {
    assert.ok(enPlugin.keywords.includes(kw), `missing plugin keyword: ${kw}`)
  }

  const enThisPc = enData.items.find((item) => item.id === 'system-tool:this_pc')
  assert.ok(enThisPc)
  assert.equal(enThisPc.name, 'This PC')
  assert.deepEqual(enThisPc.altNames, ['此电脑'])
  assert.ok(enThisPc.keywords.includes('System Tools'))
  assert.ok(enThisPc.keywords.includes('Common Core'))
  assert.ok(enThisPc.keywords.includes('此电脑'))

  // 中文模式：插件与系统工具切回中文，且保留英文 altNames
  setLocale('zh-CN')
  const zhData = await service.getData()
  const zhPlugin = zhData.items.find((item) => item.id === 'plugin.bilingual')
  assert.ok(zhPlugin)
  assert.equal(zhPlugin.name, '密码生成器')
  assert.equal(zhPlugin.description, '生成高强度随机密码')
  assert.deepEqual(zhPlugin.altNames, ['Password Generator'])

  const zhThisPc = zhData.items.find((item) => item.id === 'system-tool:this_pc')
  assert.ok(zhThisPc)
  assert.equal(zhThisPc.name, '此电脑')
  assert.deepEqual(zhThisPc.altNames, ['This PC'])
  assert.ok(zhThisPc.keywords.includes('系统工具'))
  assert.ok(zhThisPc.keywords.includes('常用 核心'))
  assert.ok(zhThisPc.keywords.includes('This PC'))
})

test('DllPluginService localizes structured errorCode payloads in zh-CN/en-US and safely handles unknown or malformed payloads', async () => {
  const previous = getLocaleSetting()
  try {
    // 1. 验证全部 41 个结构化 DLL 错误码均已录入中英词典
    const expectedDllErrorCodes = [
      'INVALID_PARAMS', 'MISSING_PARAM', 'UNSUPPORTED_OPTION', 'INVALID_JSON', 'INTERNAL_ERROR',
      'OPERATION_CANCELLED', 'OPERATION_TIMEOUT', 'PERMISSION_DENIED', 'FILE_NOT_FOUND',
      'FILE_ALREADY_EXISTS', 'FILE_READ_FAILED', 'FILE_WRITE_FAILED', 'RENAME_FAILED',
      'NAME_UNCHANGED', 'CONFIG_NOT_FOUND', 'CONFIG_INVALID', 'TOOL_UNAVAILABLE',
      'HELPER_NOT_FOUND', 'HELPER_START_FAILED', 'HELPER_CRASHED', 'MODEL_LOAD_FAILED',
      'UNSUPPORTED_ARCH', 'WINDOW_INVALID', 'PASTE_TARGET_NOT_FOUND', 'WORKER_NOT_READY',
      'WORKER_BUSY', 'WORKER_IO_ERROR', 'WORKER_STOPPING', 'WORKER_START_FAILED',
      'SCREENS_UNAVAILABLE', 'REGISTRY_WRITE_FAILED', 'REGISTRY_DELETE_FAILED',
      'DYNAMIC_ITEM_DELETE_FORBIDDEN', 'MENU_ITEM_ALREADY_EXISTS', 'TASK_CANCELLED',
      'TASK_FAILED', 'TASK_ALREADY_RUNNING', 'INSUFFICIENT_FILES', 'ASYNC_MODE_REQUIRED',
      'MEDIA_PROCESS_FAILED', 'MEDIA_TIMEOUT'
    ]
    assert.equal(expectedDllErrorCodes.length, 41)
    for (const code of expectedDllErrorCodes) {
      const key = `dllErrors.${code}`
      assert.equal(Object.hasOwn(zhCN, key), true, `zh-CN.json missing ${key}`)
      assert.equal(Object.hasOwn(enUS, key), true, `en-US.json missing ${key}`)
    }

    // 2. 纯函数 localizeDllErrorPayload：双语翻译 + 插值 + 保留 errorCode/errorParams + 同步 message
    const rawMissingParam = {
      success: false,
      errorCode: 'MISSING_PARAM',
      errorParams: { param: 'inputPath' },
      error: 'raw error',
      message: 'raw error'
    }
    setLocale('zh-CN')
    const zhLocalized = localizeDllErrorPayload(rawMissingParam) as Record<string, unknown>
    assert.equal(zhLocalized.error, '缺少必要参数：inputPath')
    assert.equal(zhLocalized.message, '缺少必要参数：inputPath')
    assert.equal(zhLocalized.errorCode, 'MISSING_PARAM')
    assert.deepEqual(zhLocalized.errorParams, { param: 'inputPath' })
    // 保持纯函数语义，不原地修改入参
    assert.equal(rawMissingParam.error, 'raw error')

    setLocale('en-US')
    const enLocalized = localizeDllErrorPayload(rawMissingParam) as Record<string, unknown>
    assert.equal(enLocalized.error, 'Missing required parameter: inputPath.')
    assert.equal(enLocalized.message, 'Missing required parameter: inputPath.')
    assert.equal(enLocalized.errorCode, 'MISSING_PARAM')
    assert.deepEqual(enLocalized.errorParams, { param: 'inputPath' })

    // 3. 破坏性/边界测试：未知错误码、非法 errorCode、畸形 errorParams、成功响应与原始非对象均安全兜底
    const unknownCodePayload = { success: false, errorCode: 'UNKNOWN_FUTURE_CODE', error: 'fallback raw error' }
    assert.equal(localizeDllErrorPayload(unknownCodePayload), unknownCodePayload)

    const injectedCodePayload = { success: false, errorCode: '../tray.quit', error: 'original' }
    assert.equal(localizeDllErrorPayload(injectedCodePayload), injectedCodePayload)

    const malformedParamsPayload = {
      success: false,
      errorCode: 'MISSING_PARAM',
      errorParams: { param: { nested: true }, badNum: Number.NaN, ok: 'ignored' },
      error: 'original'
    }
    const malformedResult = localizeDllErrorPayload(malformedParamsPayload) as Record<string, unknown>
    assert.equal(malformedResult.error, 'Missing required parameter: {param}.')
    assert.equal(malformedResult.errorCode, 'MISSING_PARAM')

    const successPayload = { success: true, errorCode: 'FILE_NOT_FOUND', error: 'should not touch' }
    assert.equal(localizeDllErrorPayload(successPayload), successPayload)

    for (const primitive of [null, undefined, 'plain text', 42, ['array']]) {
      assert.equal(localizeDllErrorPayload(primitive), primitive)
    }

    // 4. 真实装配 DllPluginService：验证 callResponse（code=0 与 code!=0）及 callback/async 事件出口
    let nativeListener: ((event: NativeDllEvent) => void) | null = null
    let lastCallbackNativeTaskId = ''
    let nextCallResult: NativeDllCallResult = { code: 0, result: null }
    const publishedEvents: Array<{ type: string; payload: unknown }> = []
    const manifest: PluginManifest = {
      id: 'plugin.demo',
      name: 'Demo',
      version: '1.0.0',
      entry: 'index.html',
      dllloader: 'DemoPlugin.dll',
      requireAdmin: false,
      commonLibs: []
    }
    const dllService = new DllPluginService(
      {
        list: async () => ({ success: true, data: [manifest] }),
        withPluginManifest: async (_id, action) => action(manifest, { sdkApiLane: 1 })
      },
      {
        callDll: async () => nextCallResult,
        callDllAsync: async () => 'task_async_sync_unused',
        callDllWithCallback: async () => 'task_cb_sync_unused',
        beginDllAsyncTask: (_pluginId, _dllId, _fn, _params, _ctx, _sig, taskId) => ({
          taskId: taskId ?? 'task_1',
          outcome: Promise.resolve({ kind: 'started' })
        }),
        beginDllCallbackTask: (_pluginId, _dllId, _fn, _params, _ctx, _sig, taskId) => {
          lastCallbackNativeTaskId = taskId ?? 'task_cb_1'
          return {
            taskId: lastCallbackNativeTaskId,
            outcome: Promise.resolve({ kind: 'started' })
          }
        },
        queryDllTask: async (_pluginId, _dllId, taskId) => ({
          taskId,
          mode: 'callback',
          status: 'running',
          progress: 0,
          functionName: 'Run',
          error: null
        }),
        cancelDllTask: async () => 0,
        clearDllTask: async () => undefined,
        getDllInfo: async () => ({
          pluginName: 'DemoPlugin',
          version: '1.0.0',
          author: 'ZTools',
          description: 'Demo',
          functions: [],
          supportsAsync: true,
          supportsCallback: true,
          supportsCancel: true,
          supportsStopManagedProcesses: false
        }),
        onDllEvent: (listener) => {
          nativeListener = listener
          return () => { nativeListener = null }
        },
        acquirePluginMaintenance: async () => () => undefined
      },
      null,
      {
        publishHostToOwner: (type, payload) => {
          publishedEvents.push({ type, payload })
          return { success: true, delivered: 1 }
        }
      }
    )

    const caller = { type: 'main' as const, webContentsId: 1 }

    // 4a. code === 0 但业务返回 success: false + errorCode
    setLocale('en-US')
    nextCallResult = {
      code: 0,
      result: JSON.stringify({
        success: false,
        errorCode: 'FILE_NOT_FOUND',
        error: '原始中文报错'
      })
    }
    const bizErrRes = await dllService.call({ plugin: 'DemoPlugin', func: 'Read', params: {} }, caller)
    assert.equal(bizErrRes.success, true)
    assert.equal((bizErrRes.data as Record<string, unknown>).error, 'Target file or directory not found.')
    assert.equal((bizErrRes.data as Record<string, unknown>).errorCode, 'FILE_NOT_FOUND')

    // 4b. code !== 0 且带结构化 JSON 错误码
    nextCallResult = {
      code: 5,
      result: JSON.stringify({
        errorCode: 'PERMISSION_DENIED',
        error: '拒绝访问'
      })
    }
    const structuredFailRes = await dllService.call({ plugin: 'DemoPlugin', func: 'Write', params: {} }, caller)
    assert.equal(structuredFailRes.success, false)
    assert.equal(structuredFailRes.code, 5)
    assert.equal(structuredFailRes.error, 'Permission denied. Please check access rights or retry as administrator.')
    assert.equal(structuredFailRes.errorCode, 'PERMISSION_DENIED')

    // 4c. code !== 0 且无结构化正文：兜底文案走当前语言 t('dll.callFailedWithCode')
    nextCallResult = { code: 42, result: null }
    const fallbackEn = await dllService.call({ plugin: 'DemoPlugin', func: 'Fail', params: {} }, caller)
    assert.equal(fallbackEn.success, false)
    assert.equal(fallbackEn.error, 'DLL plugin call failed (error code: 42)')

    setLocale('zh-CN')
    const fallbackZh = await dllService.call({ plugin: 'DemoPlugin', func: 'Fail', params: {} }, caller)
    assert.equal(fallbackZh.success, false)
    assert.equal(fallbackZh.error, 'DLL 插件调用失败，错误码: 42')

    // 4d. 回调任务中通过 callback-result 返回结构化 errorCode，事件和 taskError 均本地化
    setLocale('en-US')
    const cbStart = await dllService.callWithCallback(
      { plugin: 'DemoPlugin', func: 'RunCb', params: { taskId: 'cb_i18n_1' } },
      caller
    )
    assert.equal(cbStart.success, true)
    assert.ok(nativeListener)
    assert.ok(lastCallbackNativeTaskId.length > 0)
    const cbTaskEventIndex = publishedEvents.length
    ;(nativeListener as (event: NativeDllEvent) => void)({
      type: 'callback-result',
      pluginId: 'plugin.demo',
      dllId: 'DemoPlugin',
      taskId: lastCallbackNativeTaskId,
      result: JSON.stringify({
        type: 'error',
        errorCode: 'MISSING_PARAM',
        errorParams: { param: 'outputDir' },
        error: '缺少 outputDir'
      })
    })
    const cbEvent = publishedEvents
      .slice(cbTaskEventIndex)
      .find((entry) => entry.type === 'dllplugin_callback_result')
    assert.ok(cbEvent)
    const cbResultJson = JSON.parse(String((cbEvent.payload as { result?: string }).result)) as Record<string, unknown>
    assert.equal(cbResultJson.error, 'Missing required parameter: outputDir.')
    assert.equal(cbResultJson.errorCode, 'MISSING_PARAM')
    assert.deepEqual(cbResultJson.errorParams, { param: 'outputDir' })
    const cbQuery = await dllService.queryTask({ plugin: 'DemoPlugin', taskId: 'cb_i18n_1' }, caller)
    assert.equal(cbQuery.taskError, 'Missing required parameter: outputDir.')

    // 4e. 异步任务中通过 task-error 返回结构化 errorCode，进度事件错误文案同步本地化
    const activeCbStart = await dllService.callAsync(
      { plugin: 'DemoPlugin', func: 'RunAsync', params: {} },
      caller
    )
    assert.equal(activeCbStart.success, true)
    const asyncTaskId = String(activeCbStart.taskId)
    ;(nativeListener as (event: NativeDllEvent) => void)({
      type: 'task-error',
      pluginId: 'plugin.demo',
      dllId: 'DemoPlugin',
      taskId: asyncTaskId,
      error: JSON.stringify({ errorCode: 'MEDIA_TIMEOUT', error: '媒体超时' })
    })
    const asyncProgressEvent = publishedEvents
      .slice(cbTaskEventIndex)
      .find((entry) => entry.type === 'dllplugin_progress' && (entry.payload as { taskId?: string }).taskId === asyncTaskId)
    assert.ok(asyncProgressEvent)
    assert.equal((asyncProgressEvent.payload as { error?: string }).error, 'Media processing timed out.')

    await dllService.stop()
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('runtime-capability-prompt preload parser restricts locale to supported values and defaults to en-US', () => {
  const Module = require('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = Module._load
  const exposed = new Map<string, unknown>()
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
        ipcRenderer: { on: () => undefined, removeListener: () => undefined, invoke: async () => ({ success: true }) }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  const preloadPath = require.resolve('../../src/preload/runtime-capability-prompt.js')
  const cached = require.cache[preloadPath]
  delete require.cache[preloadPath]
  try {
    const mod = require(preloadPath) as typeof import('../../src/preload/runtime-capability-prompt.js')
    assert.equal(mod.parseRuntimeCapabilityPromptLocale(['app', '--ztools-locale=zh-CN']), 'zh-CN')
    assert.equal(mod.parseRuntimeCapabilityPromptLocale(['app', '--ztools-locale=en-US']), 'en-US')
    assert.equal(mod.parseRuntimeCapabilityPromptLocale(['app', '--ztools-locale=fr-FR']), 'en-US')
    assert.equal(mod.parseRuntimeCapabilityPromptLocale(['app', '--ztools-locale=']), 'en-US')
    assert.equal(mod.parseRuntimeCapabilityPromptLocale([]), 'en-US')
    assert.equal(mod.parseRuntimeCapabilityPromptLocale(undefined), 'en-US')
  } finally {
    Module._load = originalLoad
    if (cached) require.cache[preloadPath] = cached
    else delete require.cache[preloadPath]
  }
})

test('MacRegionSelection injects current resolved --ztools-locale into overlay window additionalArguments', async () => {
  const previous = getLocaleSetting()
  const Module = require('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = Module._load
  const capturedWebPreferences: Array<{ additionalArguments?: string[] }> = []

  class FakeRegionBrowserWindow extends EventEmitter {
    destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 9001,
      mainFrame: {},
      getURL: () => 'ztools://web/platform/region-selector.html',
      setZoomFactor: () => undefined,
      setWindowOpenHandler: () => undefined
    })
    constructor(options: { webPreferences?: { additionalArguments?: string[] } }) {
      super()
      capturedWebPreferences.push(options.webPreferences ?? {})
    }
    setMenu(): void {}
    setAlwaysOnTop(): void {}
    async loadURL(): Promise<void> {}
    show(): void {}
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void {
      this.destroyed = true
      this.emit('closed')
    }
  }

  let ipcListener: ((event: unknown, value: unknown) => void) | undefined
  const screenEvents = new EventEmitter()

  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        BrowserWindow: FakeRegionBrowserWindow,
        ipcMain: {
          on: (_channel: string, listener: (event: unknown, value: unknown) => void) => {
            ipcListener = listener
          },
          removeListener: () => { ipcListener = undefined }
        },
        screen: screenEvents
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  const regionModulePath = require.resolve('../../src/main/platform/macos/region-selection.js')
  const cached = require.cache[regionModulePath]
  delete require.cache[regionModulePath]

  try {
    const { MacRegionSelection } = require(regionModulePath) as typeof import('../../src/main/platform/macos/region-selection.js')
    for (const targetLocale of ['en-US', 'zh-CN'] as const) {
      setLocale(targetLocale)
      capturedWebPreferences.length = 0
      const selector = new MacRegionSelection(process.execPath, {
        platform: 'darwin',
        screenEvents: screenEvents as never
      })
      const controller = new AbortController()
      const pending = selector.select([{ x: 0, y: 0, width: 800, height: 600 }], controller.signal)
      assert.equal(capturedWebPreferences.length, 1)
      const args = capturedWebPreferences[0]?.additionalArguments ?? []
      assert.ok(args.some((arg) => arg.startsWith('--ztools-region-selection=')), 'missing region selection token arg')
      assert.ok(args.includes(`--ztools-locale=${targetLocale}`), `expected --ztools-locale=${targetLocale} in ${JSON.stringify(args)}`)
      controller.abort()
      await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
      assert.equal(ipcListener, undefined)
      await selector.stop()
    }
  } finally {
    Module._load = originalLoad
    if (cached) require.cache[regionModulePath] = cached
    else delete require.cache[regionModulePath]
    setLocale(previous, 'zh-CN')
  }
})

test('recordBarHtml renders localized lang, title, tooltips and stop button text in zh-CN and en-US', () => {
  const previous = getLocaleSetting()
  const Module = require('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = Module._load
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getPath: () => os.tmpdir() },
        BrowserWindow: class {},
        dialog: {},
        nativeTheme: { shouldUseDarkColors: false },
        screen: {},
        webContents: { fromId: () => null }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  const windowServicePath = require.resolve('../../src/main/services/window-service.js')
  const cached = require.cache[windowServicePath]
  delete require.cache[windowServicePath]

  try {
    const { recordBarHtml } = require(windowServicePath) as typeof import('../../src/main/services/window-service.js')

    setLocale('en-US')
    const enHtml = recordBarHtml(12)
    assert.match(enHtml, /<html lang="en-US">/)
    assert.match(enHtml, /<title>Screen Recording Bar<\/title>/)
    assert.match(enHtml, /title="Drag to move"/)
    assert.match(enHtml, /title="Stop recording and save"/)
    assert.match(enHtml, /<span>Stop<\/span>/)
    assert.match(enHtml, /title="Restore main window"/)
    assert.match(enHtml, /title="Discard recording"/)
    assert.doesNotMatch(enHtml, /[\u4e00-\u9fff]/)

    setLocale('zh-CN')
    const zhHtml = recordBarHtml(12)
    assert.match(zhHtml, /<html lang="zh-CN">/)
    assert.match(zhHtml, /<title>录屏控制条<\/title>/)
    assert.match(zhHtml, /title="按住拖拽"/)
    assert.match(zhHtml, /title="结束录制并保存"/)
    assert.match(zhHtml, /<span>结束<\/span>/)
    assert.match(zhHtml, /title="还原主窗口"/)
    assert.match(zhHtml, /title="放弃本次录制"/)
  } finally {
    Module._load = originalLoad
    if (cached) require.cache[windowServicePath] = cached
    else delete require.cache[windowServicePath]
    setLocale(previous, 'zh-CN')
  }
})

test('LAN file share negotiates Accept-Language, falls back to resolved locale, and renders bilingual HTML & PIN prompts', async () => {
  const previous = getLocaleSetting()
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-i18n-lan-'))
  const sampleFile = path.join(tmpDir, 'notes.txt')
  await fs.writeFile(sampleFile, 'hello ztools')
  const ctx: HostPluginContext = {
    clipboard: null,
    processService: null,
    windowControl: null,
    authorizeExistingPath: async (value) => value,
    authorizeOutputPath: async (value) => value
  }
  const handler = new NetworkHostPluginHandler(ctx)

  try {
    // 1. Accept-Language 协商与主进程 locale 回退
    setLocale('zh-CN')
    assert.equal(resolveLanShareLocale(undefined), 'zh-CN')
    assert.equal(resolveLanShareLocale('*'), 'zh-CN')
    assert.equal(resolveLanShareLocale('en-US,en;q=0.9,zh-CN;q=0.8'), 'en-US')
    assert.equal(resolveLanShareLocale('fr-FR;q=0.9,zh-Hans;q=0.8'), 'zh-CN')
    assert.equal(resolveLanShareLocale('ja-JP,fr-FR;q=0.8'), 'en-US')
    assert.equal(resolveLanShareLocale('zh-CN;q=0,en-US;q=0.7'), 'en-US')

    setLocale('en-US')
    assert.equal(resolveLanShareLocale(''), 'en-US')

    // 2. 纯渲染函数：空态与非空态表头/下载按钮
    const enEmptyHtml = renderLanShareHtml([], 'en-US')
    assert.match(enEmptyHtml, /<html lang="en-US">/)
    assert.match(enEmptyHtml, /No shared files/)
    assert.doesNotMatch(enEmptyHtml, /[\u4e00-\u9fff]/)

    const zhEmptyHtml = renderLanShareHtml([], 'zh-CN')
    assert.match(zhEmptyHtml, /<html lang="zh-CN">/)
    assert.match(zhEmptyHtml, /暂无共享文件/)

    // 3. 真实本地 HTTP 服务：按 Accept-Language 响应英文/中文网页与 401 PIN 提示
    const started = await handler.handleLanShare('start', {
      port: 0,
      requirePin: true,
      pin: '4321',
      paths: [sampleFile]
    }) as { port: number }
    assert.ok(started.port > 0)

    const en401 = await fetch(`http://127.0.0.1:${started.port}/`, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' }
    })
    assert.equal(en401.status, 401)
    assert.match(await en401.text(), /valid PIN code/)

    const zh401 = await fetch(`http://127.0.0.1:${started.port}/`, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
    })
    assert.equal(zh401.status, 401)
    assert.match(await zh401.text(), /需要有效的 PIN 验证码/)

    const enPage = await fetch(`http://127.0.0.1:${started.port}/?pin=4321`, {
      headers: { 'Accept-Language': 'en-GB,en;q=0.9' }
    })
    assert.equal(enPage.status, 200)
    const enBody = await enPage.text()
    assert.match(enBody, /<title>ZTools LAN File Share<\/title>/)
    assert.match(enBody, /<th>File Name<\/th><th>Size<\/th><th>Action<\/th>/)
    assert.match(enBody, />Download<\/a>/)
    assert.doesNotMatch(enBody, /[\u4e00-\u9fff]/)

    // 不带 Accept-Language 头（Node fetch 默认不发送或传空）：回退主进程 resolved locale
    setLocale('zh-CN')
    const fallbackZhPage = await fetch(`http://127.0.0.1:${started.port}/?pin=4321`, {
      headers: { 'Accept-Language': '*' }
    })
    const fallbackZhBody = await fallbackZhPage.text()
    assert.match(fallbackZhBody, /<title>ZTools 局域网快传<\/title>/)
    assert.match(fallbackZhBody, /<th>文件名<\/th><th>大小<\/th><th>操作<\/th>/)
    assert.match(fallbackZhBody, />下载<\/a>/)
  } finally {
    await handler.stop()
    setLocale(previous, 'zh-CN')
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('FocusService localizes default categories, HUD messages, Pomodoro notifications and errors in zh-CN/en-US', () => {
  const previous = getLocaleSetting()
  const hudMessages: string[] = []
  const notifications: Array<{ title: string; body: string }> = []
  let now = Date.now()
  const hud = new HudService({ onShow: (payload) => { hudMessages.push(payload.message) } })

  setLocale('zh-CN')
  const service = new FocusService({
    hudService: hud,
    now: () => now,
    onNotification: (title, body) => { notifications.push({ title, body }) }
  })

  try {
    // 即使数据库在 zh-CN 初始化，切到 en-US 后预置分类仍动态展示英文，且不破坏拼音与英文检索
    setLocale('en-US')
    const enCats = service.listCategories()
    assert.equal(enCats.find((c) => c.id === 'cat-work')?.name, 'Deep Work')
    assert.equal(enCats.find((c) => c.id === 'cat-code')?.name, 'Geek Coding')
    assert.equal(service.listCategories('shendu')[0]?.id, 'cat-work')
    assert.equal(service.listCategories('coding')[0]?.id, 'cat-code')

    const customCat = service.createCategory({ name: 'My Custom Track' })
    assert.equal(service.listCategories('custom')[0]?.name, customCat.name)

    // 英文态启动 -> 暂停 -> 继续 -> 番茄到期进入短休
    service.startSession({ mode: 'pomodoro', categoryId: 'cat-work' })
    assert.match(hudMessages.at(-1) ?? '', /Focus started: Deep Work Focus Timer \(25 min\)/)
    service.pauseSession()
    assert.match(hudMessages.at(-1) ?? '', /Focus paused:/)
    service.resumeSession()
    assert.match(hudMessages.at(-1) ?? '', /Focus resumed:/)

    now += 25 * 60_000
    const breakSession = service.getCurrentSession()
    assert.equal(breakSession?.phase, 'short_break')
    assert.equal(breakSession?.title, '5-min Short Break')
    assert.equal(notifications.at(-1)?.title, 'Pomodoro Timer')
    assert.match(notifications.at(-1)?.body ?? '', /5-minute break/)
    assert.doesNotMatch(notifications.at(-1)?.body ?? '', /[\u4e00-\u9fff]/)

    service.cancelSession()
    assert.equal(hudMessages.at(-1), 'Focus session cancelled')
    assert.throws(() => service.pauseSession(), /No active timer is running/)

    // 切回中文态验证动态切换
    setLocale('zh-CN')
    assert.equal(service.listCategories().find((c) => c.id === 'cat-work')?.name, '深度工作')
    service.startSession({ mode: 'pomodoro', categoryId: 'cat-work' })
    now += 25 * 60_000
    assert.equal(service.getCurrentSession()?.title, '5 分钟短休息')
    assert.equal(notifications.at(-1)?.title, '番茄倒数')
    assert.match(notifications.at(-1)?.body ?? '', /进入 5 分钟休息/)
  } finally {
    service.stop()
    hud.stop()
    setLocale(previous, 'zh-CN')
  }
})

test('KeyboardLockService and MacAppUpdater localize user-facing guidance and errors in zh-CN/en-US', async () => {
  const previous = getLocaleSetting()
  const caller = { type: 'plugin' as const, webContentsId: 99, pluginId: 'clean-keyboard', pluginInstanceId: 'inst-1' }
  const startReq = { action: 'start', operationId: 'lock_i18n', durationSeconds: 10, lockPointer: false }
  const fakeAutoUpdater = Object.assign(new EventEmitter(), {
    setFeedURL: () => undefined,
    checkForUpdates: () => undefined,
    quitAndInstall: () => undefined
  }) as unknown as MacAutoUpdater

  try {
    setLocale('en-US')
    const winLock = new KeyboardLockService('/missing/ZToolsMacInputLock', 'win32')
    await assert.rejects(winLock.handle(startReq, caller, new AbortController().signal), /not supported on this operating system/)
    const missingMacLock = new KeyboardLockService('/missing/ZToolsMacInputLock', 'darwin')
    await assert.rejects(missingMacLock.handle(startReq, caller, new AbortController().signal), /not built/)
    await missingMacLock.stop()
    await assert.rejects(missingMacLock.handle(startReq, caller, new AbortController().signal), /service has stopped/)

    const devUpdater = new MacAppUpdater({
      appPath: '/Applications/ZTools.app',
      isPackaged: false,
      stagingRoot: os.tmpdir(),
      autoUpdater: fakeAutoUpdater,
      requestQuit: () => undefined,
      reportRestartError: () => undefined
    })
    assert.throws(() => devUpdater.assertSupported(), /not supported in development mode/)
    devUpdater.dispose()

    const dmgUpdater = new MacAppUpdater({
      appPath: '/Volumes/ZTools/ZTools.app',
      isPackaged: true,
      stagingRoot: os.tmpdir(),
      autoUpdater: fakeAutoUpdater,
      requestQuit: () => undefined,
      reportRestartError: () => undefined
    })
    assert.throws(() => dmgUpdater.assertSupported(), /Applications folder/)
    dmgUpdater.dispose()

    setLocale('zh-CN')
    await assert.rejects(winLock.handle(startReq, caller, new AbortController().signal), /尚未接入此系统输入锁/)
    const zhDmgUpdater = new MacAppUpdater({
      appPath: '/Volumes/ZTools/ZTools.app',
      isPackaged: true,
      stagingRoot: os.tmpdir(),
      autoUpdater: fakeAutoUpdater,
      requestQuit: () => undefined,
      reportRestartError: () => undefined
    })
    assert.throws(() => zhDmgUpdater.assertSupported(), /应用程序/)
    zhDmgUpdater.dispose()
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('TriggerService localizes hotkey_action_failed fallback and shortcut validation errors in zh-CN/en-US', async () => {
  const previous = getLocaleSetting()
  const events: Array<{ type: string; payload: unknown }> = []
  const callbacks = new Map<string, () => void>()
  const shortcuts: GlobalShortcutAdapter = {
    register(accelerator, cb) {
      callbacks.set(accelerator.toLowerCase(), cb)
      return true
    },
    unregister(accelerator) {
      callbacks.delete(accelerator.toLowerCase())
    }
  }
  const service = new TriggerService({
    dataRoot: 'unused',
    store: {
      read: async () => ({}),
      replace: async () => undefined
    },
    shortcuts,
    events: {
      publishHost(type, payload) {
        events.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    },
    toggleMainWindow: () => undefined,
    openPlugin: async () => { throw 'non-error-rejection' },
    platform: 'win32'
  })
  const mainCaller = { type: 'main' as const, webContentsId: 1 }

  try {
    await service.register({
      id: 'i18n_action_fail',
      pluginId: 'plugin.demo',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Alt+J' },
      action: { mode: 'window', target: 'plugin.demo', params: {} }
    }, mainCaller)

    setLocale('en-US')
    callbacks.get('ctrl+alt+j')?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const enFail = events.filter((e) => e.type === 'hotkey_action_failed').at(-1)
    assert.equal((enFail?.payload as { message?: string }).message, 'Shortcut action execution failed')

    await assert.rejects(
      service.register({
        id: 'i18n_bad_key',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Alt+F4' },
        action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
      }, mainCaller),
      /reserved Windows system shortcut/
    )

    setLocale('zh-CN')
    callbacks.get('ctrl+alt+j')?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const zhFail = events.filter((e) => e.type === 'hotkey_action_failed').at(-1)
    assert.equal((zhFail?.payload as { message?: string }).message, '快捷键动作执行失败')

    await assert.rejects(
      service.register({
        id: 'i18n_bad_key_zh',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Alt+F4' },
        action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
      }, mainCaller),
      /Windows 系统关键组合键/
    )
  } finally {
    await service.stop()
    setLocale(previous, 'zh-CN')
  }
})

test('WindowManagementService and NavigationService localize all built-in window action labels without Chinese in en-US', async () => {
  const previous = getLocaleSetting()
  const wm = new WindowManagementService()
  const nav = new NavigationService({ platform: 'win32', execFile: async () => ({ stdout: '' }) })
  nav.setMockWindows([
    { hwnd: 5001, title: 'README.md - VS Code', processName: 'Code', processId: 501, pinyin: 'readmemdvscode', acronym: 'rmvc' }
  ])

  try {
    const allActionNames = Object.keys(WINDOW_ACTIONS) as WindowActionName[]
    assert.equal(allActionNames.length, 21)

    setLocale('en-US')
    for (const name of allActionNames) {
      const meta = getWindowActionMeta(name)
      assert.equal(WINDOW_ACTIONS[name].title, meta.title)
      assert.equal(WINDOW_ACTIONS[name].description, meta.description)
      assert.doesNotMatch(meta.title, /[\u4e00-\u9fff]/, `${name} title leaked Chinese`)
      assert.doesNotMatch(meta.description, /[\u4e00-\u9fff]/, `${name} description leaked Chinese`)
    }
    for (const action of wm.listActions()) {
      assert.doesNotMatch(action.title, /[\u4e00-\u9fff]/)
      assert.doesNotMatch(action.description, /[\u4e00-\u9fff]/)
    }

    const enNavItems = await nav.searchMenuItems()
    assert.equal(enNavItems.length, 5)
    assert.equal(enNavItems[0]?.title, 'Switch to window: README.md - VS Code')
    assert.equal(enNavItems[1]?.title, '[Code] Maximize Window')
    assert.equal(enNavItems[2]?.title, '[Code] Snap to Left Half')
    assert.equal(enNavItems[3]?.title, '[Code] Snap to Right Half')
    assert.equal(enNavItems[4]?.title, '[Code] Close Window: README.md - VS Code')
    for (const item of enNavItems) {
      assert.doesNotMatch(item.title, /[\u4e00-\u9fff]/)
    }

    setLocale('zh-CN')
    assert.equal(WINDOW_ACTIONS['left-half'].title, '左半屏')
    assert.equal(WINDOW_ACTIONS['next-display'].title, '移到下一显示器')
    const zhNavItems = await nav.searchMenuItems()
    assert.equal(zhNavItems.length, 5)
    assert.equal(zhNavItems[0]?.title, '切换到窗口: README.md - VS Code')
    assert.equal(zhNavItems[1]?.title, '[Code] 最大化窗口')
    assert.equal(zhNavItems[2]?.title, '[Code] 左半屏分屏')
    assert.equal(zhNavItems[3]?.title, '[Code] 右半屏分屏')
    assert.equal(zhNavItems[4]?.title, '[Code] 关闭窗口: README.md - VS Code')
  } finally {
    await nav.stop()
    setLocale(previous, 'zh-CN')
  }
})

test('toLocalizedPublicError implements R3 split routing, privacy redaction, and English fallback', () => {
  const previous = getLocaleSetting()
  try {
    // 1. 纯契约层 toPublicError 非 ZToolsError 兜底为英文
    const rawFallback = toPublicError(new Error('secret stack C:\\Users\\test\\secret.db'))
    assert.deepEqual(rawFallback, { code: errorCodes.internalError, message: 'Internal host error' })

    // 2. toLocalizedPublicError 非 ZToolsError 按当前 locale 返回脱敏译文
    assert.deepEqual(toLocalizedPublicError(new Error('secret'), 'en-US'), {
      code: errorCodes.internalError,
      message: 'Internal host error'
    })
    assert.deepEqual(toLocalizedPublicError(new Error('secret'), 'zh-CN'), {
      code: errorCodes.internalError,
      message: '宿主内部错误'
    })

    // 3. 开发者契约错误（INVALID_REQUEST / METHOD_NOT_FOUND）未指定 i18nKey 时保留英文调试详情
    const devErr = new ZToolsError(errorCodes.invalidRequest, 'field "pluginId" must be a non-empty string', {
      path: 'C:\\private\\internal\\path',
      fields: ['pluginId']
    })
    assert.deepEqual(toLocalizedPublicError(devErr, 'zh-CN'), {
      code: errorCodes.invalidRequest,
      message: 'field "pluginId" must be a non-empty string'
    })

    // 4. 显式指定 i18nKey 与脱敏 i18nParams 时按词典翻译，且只放行 details.public
    const localizedErr = new ZToolsError(errorCodes.triggerConflict, 'raw', {
      i18nKey: 'trigger.owner.plugin',
      i18nParams: { pluginId: 'demo-tool' },
      path: '/secret/local/path',
      public: { retryAfterMs: 500 }
    })
    assert.deepEqual(toLocalizedPublicError(localizedErr, 'en-US'), {
      code: errorCodes.triggerConflict,
      message: 'Plugin demo-tool',
      details: { retryAfterMs: 500 }
    })
    assert.deepEqual(toLocalizedPublicError(localizedErr, 'zh-CN'), {
      code: errorCodes.triggerConflict,
      message: '插件 demo-tool',
      details: { retryAfterMs: 500 }
    })

    // 5. en-US 模式下未翻译的中文运行期错误自动由 error.<code> 兜底
    const legacyZhErr = new ZToolsError(errorCodes.permissionDenied, '无权访问该资源')
    assert.equal(toLocalizedPublicError(legacyZhErr, 'en-US').message, 'Permission denied')
    assert.equal(toLocalizedPublicError(legacyZhErr, 'zh-CN').message, '无权访问该资源')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('ConfigService notifies onLocaleSettingChanged across config_set, settings_set, and whole ui group write', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-config-locale-'))
  context.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  const store = new JsonFileStore(tempRoot, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)
  const received: unknown[] = []
  const unsubscribe = config.onLocaleSettingChanged((value) => {
    received.push(value)
  })

  // 1. config.set('user_settings.json', 'ui.locale', ...)
  await config.set('user_settings.json', 'ui.locale', 'en-US', true)
  // 2. config.setSetting('ui.locale', ...)
  await config.setSetting('ui.locale', 'zh-CN')
  // 3. 整组写入 ui 对象（含 locale 字段）
  await config.set('user_settings.json', 'ui', JSON.stringify({ theme: 'dark', locale: 'system' }), true)
  // 4. 整组写入 ui 对象（不含 locale 字段，不应误触发）
  await config.set('user_settings.json', 'ui', JSON.stringify({ theme: 'light' }), true)
  // 5. 写入其他配置文件，不应触发
  await config.set('my_page_settings.json', 'ui.locale', 'en-US', false)

  assert.deepEqual(received, ['en-US', 'zh-CN', 'system'])
  unsubscribe()
  await config.set('user_settings.json', 'ui.locale', 'en-US', true)
  assert.deepEqual(received, ['en-US', 'zh-CN', 'system'])
})

test('PluginWindowManager injects --ztools-locale= and refreshes active plugin windows on locale change (R5)', async () => {
  const previous = getLocaleSetting()
  try {
    setLocale('en-US')
    const registry = new WindowRegistry()
    const createdOptions: Electron.BrowserWindowConstructorOptions[] = []
    const titleHistory: string[] = []
    const executedScripts: string[] = []

    const fakeManifest: PluginManifest = {
      id: 'demo.bilingual-win',
      name: '双语独立窗口',
      version: '1.0.0',
      entry: 'index.html',
      dllloader: '',
      requireAdmin: false,
      commonLibs: [],
      i18n: {
        'en-US': {
          name: 'Bilingual Popout Window'
        }
      }
    }

    const manager = new PluginWindowManager({
      registry,
      manifests: {
        withPluginManifest: async (_id, action) => action(fakeManifest, { sdkApiLane: 1 })
      },
      createWindow: (opts) => {
        createdOptions.push(opts)
        const wc = Object.assign(new EventEmitter(), {
          id: 909,
          session: {},
          getURL: () => 'ztools://plugins/demo.bilingual-win/index.html',
          isDestroyed: () => false,
          setWindowOpenHandler: () => undefined,
          executeJavaScript: async (script: string) => {
            executedScripts.push(script)
            return undefined
          }
        })
        const win = Object.assign(new EventEmitter(), {
          webContents: wc,
          isDestroyed: () => false,
          isMinimized: () => false,
          isMaximized: () => false,
          isFullScreen: () => false,
          isVisible: () => true,
          loadURL: async () => undefined,
          show: () => undefined,
          focus: () => undefined,
          destroy: () => undefined,
          setTitle: (title: string) => {
            titleHistory.push(title)
          }
        })
        return win as unknown as Electron.BrowserWindow
      }
    })

    await manager.open({ pluginId: 'demo.bilingual-win' })
    assert.equal(createdOptions.length, 1)
    assert.equal(createdOptions[0]?.title, 'Bilingual Popout Window')
    const args = createdOptions[0]?.webPreferences?.additionalArguments ?? []
    assert.ok(args.includes('--ztools-locale=en-US'), `expected --ztools-locale=en-US in ${JSON.stringify(args)}`)

    // 热切换语言至 zh-CN，验证独立窗口标题与运行期 __ztoolsLocale 同步刷新
    setLocale('zh-CN')
    manager.refreshLocale('zh-CN')
    assert.deepEqual(titleHistory, ['双语独立窗口'])
    assert.ok(executedScripts.some((s) => s.includes('window.__ztoolsLocale="zh-CN"')))

    await manager.stop()
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('DllPluginService enforces R9 CJK sanitization on detail/stderr and appends safe path/exitCode context', () => {
  const previous = getLocaleSetting()
  try {
    // 1. 英文下携带安全 path / exitCode 自动附加详情，无参调用保持兼容
    const withPath = localizeDllErrorPayload(
      {
        success: false,
        errorCode: 'FILE_NOT_FOUND',
        errorParams: { path: 'D:\\media\\demo.mp4' },
        error: 'raw'
      },
      { locale: 'en-US' }
    ) as Record<string, unknown>
    assert.equal(withPath.error, 'Target file or directory not found (D:\\media\\demo.mp4)')

    const withExit = localizeDllErrorPayload(
      {
        success: false,
        errorCode: 'FFMPEG_PROCESS_FAILED',
        errorParams: { exitCode: 1 },
        error: 'raw'
      },
      { locale: 'en-US' }
    ) as Record<string, unknown>
    assert.equal(withExit.error, 'FFmpeg media processing exited with an error (exit code 1)')

    // 2. R9：英文模式下含中文字符的 detail 被过滤，避免中文借道透出
    const cjkDetail = localizeDllErrorPayload(
      {
        success: false,
        errorCode: 'MEDIA_PROCESS_FAILED',
        errorParams: { detail: '编码器初始化失败：不支持的像素格式' },
        error: 'raw'
      },
      { locale: 'en-US' }
    ) as Record<string, unknown>
    assert.equal(cjkDetail.error, 'Media processing failed.')
    assert.doesNotMatch(String(cjkDetail.error), /[\u4e00-\u9fa5]/)

    // 中文模式下正常保留 detail
    const zhDetail = localizeDllErrorPayload(
      {
        success: false,
        errorCode: 'MEDIA_PROCESS_FAILED',
        errorParams: { detail: '编码器初始化失败' },
        error: 'raw'
      },
      { locale: 'zh-CN' }
    ) as Record<string, unknown>
    assert.equal(zhDetail.error, '媒体处理失败（编码器初始化失败）')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('DllPluginService withDllLocale, localizeDllProgressMessage, and success messageCode localization (R4 & R9)', () => {
  const previous = getLocaleSetting()
  try {
    // 1. withDllLocale 注入 __locale 且不原地污染调用方入参对象
    setLocale('en-US')
    const rawParams: Record<string, unknown> = { input: 'a.mp4', quality: 80 }
    const enriched = withDllLocale(rawParams)
    assert.deepEqual(enriched, { input: 'a.mp4', quality: 80, __locale: 'en-US' })
    assert.equal(Object.hasOwn(rawParams, '__locale'), false)

    setLocale('zh-CN')
    assert.equal(withDllLocale(rawParams).__locale, 'zh-CN')

    // 2. localizeDllProgressMessage 翻译结构化 JSON progressCode + 插值 + fallback + 兼容旧纯文本
    const progressJson = JSON.stringify({
      progressCode: 'PROCESSING_ITEM',
      progressParams: { current: 2, total: 5, item: 'clip.mp4' },
      fallback: 'fallback text'
    })
    assert.equal(localizeDllProgressMessage(progressJson, 'en-US'), 'Processing (2/5): clip.mp4')
    assert.equal(localizeDllProgressMessage(progressJson, 'zh-CN'), '正在处理 (2/5)：clip.mp4')

    const unknownCodeJson = JSON.stringify({
      progressCode: 'FUTURE_UNKNOWN_STEP',
      fallback: 'Custom fallback message'
    })
    assert.equal(localizeDllProgressMessage(unknownCodeJson, 'en-US'), 'Custom fallback message')

    // 旧版纯文本与非 JSON 原样兼容
    assert.equal(localizeDllProgressMessage('Converting frame 12/100', 'en-US'), 'Converting frame 12/100')
    assert.equal(localizeDllProgressMessage('{invalid json', 'en-US'), '{invalid json')

    // 3. 成功路径 messageCode / messageParams 本地化
    const successPayload = { success: true, messageCode: 'COMPLETED', message: 'raw' }
    const enSuccess = localizeDllErrorPayload(successPayload, { locale: 'en-US' }) as Record<string, unknown>
    assert.equal(enSuccess.message, 'Operation completed')
    assert.equal(enSuccess.messageCode, 'COMPLETED')
    assert.equal(successPayload.message, 'raw')

    const zhSuccess = localizeDllErrorPayload(successPayload, { locale: 'zh-CN' }) as Record<string, unknown>
    assert.equal(zhSuccess.message, '操作已完成')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('UpdateService preserves changelogI18n and passes --lang=<resolvedLocale> to external updater', async (context) => {
  const previous = getLocaleSetting()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-i18n-update-'))
  context.after(async () => {
    setLocale(previous, 'zh-CN')
    await fs.rm(root, { recursive: true, force: true })
  })

  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  await fs.mkdir(runtimePaths.installRoot, { recursive: true })
  await fs.writeFile(path.join(runtimePaths.installRoot, 'ZToolsUpdater.exe'), 'updater')
  const payload = Buffer.from('installer-payload-binary')
  const checksum = createHash('sha256').update(payload).digest('hex')
  const launchedArgs: string[][] = []

  const service = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    updateSource: {
      async fetchLatest() {
        return {
          app: {
            version: '2.0.0',
            changelog: '默认更新说明',
            changelogI18n: {
              'zh-CN': '中文更新日志',
              'en-US': 'English changelog',
              __proto__: 'ignored'
            },
            force: false,
            fileSize: payload.length,
            downloadUrl: 'https://cdn.example/ZToolsSetup-2.0.0.exe',
            checksum
          },
          web: null
        }
      }
    },
    fetchImpl: async () => new Response(payload, { status: 200 }),
    runUpdaterImpl: async (_exe, args) => {
      launchedArgs.push(args)
      return 0
    }
  })

  const checkResult = await service.check({ source: 'manual' })
  assert.deepEqual(checkResult.app?.changelogI18n, {
    'zh-CN': '中文更新日志',
    'en-US': 'English changelog'
  })

  setLocale('en-US', 'zh-CN')
  await service.install({
    type: 'app',
    version: '2.0.0',
    downloadUrl: 'https://cdn.example/ZToolsSetup-2.0.0.exe',
    checksum,
    fileSize: payload.length
  })
  assert.ok(launchedArgs[0]?.includes('--lang=en-US'), `expected --lang=en-US in ${JSON.stringify(launchedArgs[0])}`)
  await service.stop()
})

test('host-plugins audio-processing errors carry structured ZToolsError i18nKey and localize across locales', () => {
  const previous = getLocaleSetting()
  try {
    setLocale('en-US')
    assert.throws(
      () => buildAudioArguments('unknownop', {}, ['a.mp3'], 'out.mp3'),
      (error: unknown) =>
        error instanceof ZToolsError &&
        error.code === errorCodes.notSupported &&
        error.details?.hostCode === 'AUDIO_UNSUPPORTED_METHOD' &&
        error.details?.i18nKey === 'hostPlugin.audio.unsupportedMethod' &&
        error.message === 'Unsupported audio operation: unknownop'
    )

    setLocale('zh-CN')
    assert.throws(
      () => buildAudioArguments('unknownop', {}, ['a.mp3'], 'out.mp3'),
      (error: unknown) =>
        error instanceof ZToolsError &&
        error.message === '不支持的音频操作：unknownop'
    )
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('resolveLocale strips POSIX suffixes and setLocale keeps process.env.ZTOOLS_LOCALE in sync', () => {
  const previous = getLocaleSetting()
  try {
    assert.equal(resolveLocale('zh_CN.UTF-8', 'en-US'), 'zh-CN')
    assert.equal(resolveLocale('zh_HK@euro', 'en-US'), 'zh-CN')
    assert.equal(resolveLocale('en_GB.UTF-8', 'zh-CN'), 'en-US')
    assert.equal(resolveLocale('ja_JP.UTF-8', 'zh-CN'), 'en-US')
    assert.equal(resolveLocale('system', 'zh_Hans_CN.UTF-8'), 'zh-CN')
    assert.equal(resolveLocale('system', 'de_DE.UTF-8'), 'en-US')

    setLocale('en-US', 'zh-CN')
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'en-US')

    setLocale('zh-CN', 'en-US')
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'zh-CN')

    // 外部覆盖 ZTOOLS_LOCALE 后，syncProcessLocaleEnv 能将其恢复为当前生效 locale
    process.env[ZTOOLS_LOCALE_ENV_KEY] = 'stale-value'
    assert.equal(syncProcessLocaleEnv(), 'zh-CN')
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'zh-CN')

    setLocale('system', 'en-US')
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'en-US')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('normalizePluginCategoryId and resolvePluginCategoryIds normalize standard slugs and legacy Chinese aliases', () => {
  assert.deepEqual(PLUGIN_CATEGORY_IDS, [
    'productivity',
    'system',
    'files',
    'media',
    'developer',
    'network',
    'security'
  ])

  assert.equal(normalizePluginCategoryId('Productivity'), 'productivity')
  assert.equal(normalizePluginCategoryId('  developer  '), 'developer')
  assert.equal(normalizePluginCategoryId('办公效率'), 'productivity')
  assert.equal(normalizePluginCategoryId('系统工具'), 'system')
  assert.equal(normalizePluginCategoryId('文件管理'), 'files')
  assert.equal(normalizePluginCategoryId('图像媒体'), 'media')
  assert.equal(normalizePluginCategoryId('开发工具'), 'developer')
  assert.equal(normalizePluginCategoryId('网络工具'), 'network')
  assert.equal(normalizePluginCategoryId('安全隐私'), 'security')

  // 非法输入与未知分类返回 null
  for (const invalid of ['', '   ', 'unknown', '其他工具', null, undefined, 42, {}]) {
    assert.equal(normalizePluginCategoryId(invalid), null)
  }

  // 优先读取 categoryId，缺失时兼容旧版中文 category，并去重且最多保留 2 个
  assert.deepEqual(resolvePluginCategoryIds({ categoryId: 'network', category: '办公效率' }), ['network'])
  assert.deepEqual(resolvePluginCategoryIds({ category: '系统工具' }), ['system'])
  assert.deepEqual(resolvePluginCategoryIds({ category: ['系统工具', '文件管理', '安全隐私'] }), ['system', 'files'])
  assert.deepEqual(resolvePluginCategoryIds({ category: ['开发工具', 'developer'] }), ['developer'])
  assert.deepEqual(resolvePluginCategoryIds({ category: ['不存在的分类', 123] }), [])
})

test('DllPluginService syncLocale keeps process.env.ZTOOLS_LOCALE aligned on construction and locale changes', () => {
  const previous = getLocaleSetting()
  try {
    setLocale('en-US', 'zh-CN')
    process.env[ZTOOLS_LOCALE_ENV_KEY] = 'zh-CN'
    const service = new DllPluginService(
      {
        list: async () => ({ success: true, data: [] }),
        withPluginManifest: async () => {
          throw new Error('unused')
        }
      },
      null,
      null,
      { publishHostToOwner: () => ({ success: true, delivered: 0 }) }
    )
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'en-US')
    assert.equal(service.syncLocale('zh-CN'), 'zh-CN')
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'zh-CN')
    setLocale('en-US', 'zh-CN')
    assert.equal(service.syncLocale(), 'en-US')
    assert.equal(process.env[ZTOOLS_LOCALE_ENV_KEY], 'en-US')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

function createCleanChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  return env
}

test('i18n module initializes from process.env.ZTOOLS_LOCALE in child process without overwriting with OS locale', () => {
  const i18nModulePath = path.resolve(__dirname, '../../src/main/i18n/index.js')
  const cases: ReadonlyArray<{ envValue: string; expectedSetting: string; expectedResolved: string }> = [
    { envValue: 'en-US', expectedSetting: 'en-US', expectedResolved: 'en-US' },
    { envValue: 'zh-CN', expectedSetting: 'zh-CN', expectedResolved: 'zh-CN' },
    { envValue: 'zh_TW', expectedSetting: 'zh-CN', expectedResolved: 'zh-CN' },
    { envValue: 'en_GB.UTF-8', expectedSetting: 'en-US', expectedResolved: 'en-US' }
  ]

  for (const item of cases) {
    const script = [
      `const i18n = require(${JSON.stringify(i18nModulePath)});`,
      'process.stdout.write(JSON.stringify({',
      '  setting: i18n.getLocaleSetting(),',
      '  resolved: i18n.getResolvedLocale(),',
      '  env: process.env[i18n.ZTOOLS_LOCALE_ENV_KEY]',
      '}));'
    ].join('\n')

    const raw = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: createCleanChildEnv({ [ZTOOLS_LOCALE_ENV_KEY]: item.envValue }),
      timeout: 10_000
    })
    const parsed = JSON.parse(raw) as { setting: string; resolved: string; env: string }
    assert.deepEqual(parsed, {
      setting: item.expectedSetting,
      resolved: item.expectedResolved,
      env: item.expectedResolved
    }, `child process should inherit ZTOOLS_LOCALE=${item.envValue}`)
  }
})

test('host-entry applies startCommand locale before spawning first worker', async () => {
  const hostEntryPath = path.resolve(__dirname, '../../src/main/extension-host/host-entry.js')
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-host-locale-race-'))
  const entryPath = path.join(tmpDir, 'probe-command.mjs')
  await fs.writeFile(
    entryPath,
    [
      'export default function probeLocale() {',
      '  return {',
      '    envLocale: process.env.ZTOOLS_LOCALE,',
      '    globalLocale: globalThis.__ztoolsLocale',
      '  }',
      '}'
    ].join('\n'),
    'utf8'
  )

  const child = fork(hostEntryPath, [], {
    env: createCleanChildEnv({ [ZTOOLS_LOCALE_ENV_KEY]: 'zh-CN' }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })

  try {
    const startResult = await new Promise<{
      success?: boolean
      data?: { envLocale?: string; globalLocale?: string }
      error?: { message?: string }
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('host-entry startCommand timed out'))
      }, 15_000)

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return
        const msg = raw as { type?: string; id?: string; success?: boolean; data?: { envLocale?: string; globalLocale?: string }; error?: { message?: string } }
        if (msg.type === 'result' && msg.id === 'req-first-worker-locale') {
          clearTimeout(timer)
          resolve(msg)
        }
      })

      child.send({
        type: 'request',
        id: 'req-first-worker-locale',
        action: 'startCommand',
        payload: {
          sessionId: 'sess-first-worker-locale',
          mode: 'no-view',
          entryPath,
          extensionId: 'test.locale.race',
          commandName: 'probeLocale',
          locale: 'en-US'
        }
      })
    })

    assert.equal(startResult.success, true, startResult.error?.message)
    assert.equal(startResult.data?.envLocale, 'en-US', 'first worker must inherit startCommand locale before pool.getFromPool()')
    assert.equal(startResult.data?.globalLocale, 'en-US')
  } finally {
    const exitPromise = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    })
    try {
      child.send({ type: 'notify', action: 'terminate' })
    } catch {
      child.kill()
    }
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(() => {
        if (child.exitCode === null) child.kill()
        resolve()
      }, 3_000))
    ])
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('readInstallLocale queries HKCU/HKLM with /reg:32 and /reg:64, enforces 1000ms timeout, and handles failures', async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = []
  const runnerAllMiss: RegQueryRunner = async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout })
    throw new Error('ERROR: The system was unable to find the specified registry key or value.')
  }

  assert.equal(await readInstallLocale({ platform: 'win32', runner: runnerAllMiss }), null)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map((c) => c.args), [
    ['query', 'HKCU\\Software\\ZTools', '/v', 'InstallLocale', '/reg:32'],
    ['query', 'HKCU\\Software\\ZTools', '/v', 'InstallLocale', '/reg:64'],
    ['query', 'HKLM\\SOFTWARE\\ZTools', '/v', 'InstallLocale', '/reg:32'],
    ['query', 'HKLM\\SOFTWARE\\ZTools', '/v', 'InstallLocale', '/reg:64']
  ])
  assert.ok(calls.every((c) => c.file === 'reg' && c.timeout === INSTALL_LOCALE_QUERY_TIMEOUT_MS))

  // 非 Windows 平台直接返回 null，不触发 reg 查询
  let nonWinCalled = false
  const nonWinResult = await readInstallLocale({
    platform: 'darwin',
    runner: async () => {
      nonWinCalled = true
      return { stdout: 'InstallLocale    REG_SZ    zh-CN' }
    }
  })
  assert.equal(nonWinResult, null)
  assert.equal(nonWinCalled, false)

  // 前两条非法/失败，第三条（HKLM /reg:32）命中合法值即短路返回
  let hitCount = 0
  const thirdHit = await readInstallLocale({
    platform: 'win32',
    runner: async (_file, args) => {
      hitCount += 1
      if (args[1] === 'HKCU\\Software\\ZTools' && args[4] === '/reg:32') {
        return { stdout: '    InstallLocale    REG_SZ    ja-JP\r\n' }
      }
      if (args[1] === 'HKCU\\Software\\ZTools' && args[4] === '/reg:64') {
        throw new Error('timeout')
      }
      if (args[1] === 'HKLM\\SOFTWARE\\ZTools' && args[4] === '/reg:32') {
        return { stdout: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\ZTools\r\n    InstallLocale    REG_SZ    en_US.UTF-8\r\n' }
      }
      return { stdout: '    InstallLocale    REG_SZ    zh-CN\r\n' }
    }
  })
  assert.equal(thirdHit, 'en-US')
  assert.equal(hitCount, 3)

  // 支持直接传 runner 函数重载
  if (process.platform === 'win32') {
    const directHit = await readInstallLocale(async () => ({
      stdout: '    InstallLocale    REG_SZ    zh-CN\r\n'
    }))
    assert.equal(directHit, 'zh-CN')
  }
})

test('parseCommandLineLocale and resolveStartupLocale enforce cold-start priority and distinguish missing key vs explicit system', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-locale-'))
  context.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  // 命令行解析：支持 --lang=<locale> 和 --lang <locale>，拒绝非法语种与缺值
  assert.equal(parseCommandLineLocale(['ZTools.exe', '--lang=en-US']), 'en-US')
  assert.equal(parseCommandLineLocale(['ZTools.exe', '--lang', 'zh_TW.UTF-8']), 'zh-CN')
  assert.equal(parseCommandLineLocale(['ZTools.exe', '--lang=fr-FR']), null)
  assert.equal(parseCommandLineLocale(['ZTools.exe', '--lang', '--data-root=C:\\x']), null)

  const store = new JsonFileStore(tempRoot, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  // 1. ui.locale 键不存在，无 --lang，命中注册表 InstallLocale 并立即落盘；二次启动直接命中 config 不再查注册表
  assert.equal(await config.has('user_settings.json', 'ui.locale'), false)
  let registryCalls = 0
  const firstBoot = await resolveStartupLocale({
    config,
    argv: ['ZTools.exe'],
    systemLocale: 'zh-CN',
    readInstallLocaleImpl: async () => {
      registryCalls += 1
      return 'en-US'
    }
  })
  assert.deepEqual(firstBoot, { setting: 'en-US', resolved: 'en-US', source: 'registry' })
  assert.equal(registryCalls, 1)
  assert.equal(await config.has('user_settings.json', 'ui.locale'), true)
  assert.equal(await config.get('user_settings.json', 'ui.locale', 'system'), 'en-US')

  const secondBoot = await resolveStartupLocale({
    config,
    argv: ['ZTools.exe', '--lang=zh-CN'],
    systemLocale: 'zh-CN',
    readInstallLocaleImpl: async () => {
      registryCalls += 1
      return 'zh-CN'
    }
  })
  assert.deepEqual(secondBoot, { setting: 'en-US', resolved: 'en-US', source: 'config' })
  assert.equal(registryCalls, 1, '已保存 ui.locale 后不得再次查询注册表')

  // 2. 显式设为 system 时，必须与“键不存在”区分：绝不查询注册表，也不被 --lang 覆盖
  await config.set('user_settings.json', 'ui.locale', 'system', true)
  const systemExplicitBoot = await resolveStartupLocale({
    config,
    argv: ['ZTools.exe', '--lang=en-US'],
    systemLocale: 'zh-CN',
    readInstallLocaleImpl: async () => {
      registryCalls += 1
      return 'en-US'
    }
  })
  assert.deepEqual(systemExplicitBoot, { setting: 'system', resolved: 'zh-CN', source: 'config' })
  assert.equal(registryCalls, 1, '显式 ui.locale=system 时绝不查注册表')

  // 3. 新配置文件（键不存在）时：--lang 优先级高于注册表
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-locale-cli-'))
  context.after(async () => {
    await fs.rm(freshRoot, { recursive: true, force: true })
  })
  const freshConfig = new ConfigService(new JsonFileStore(freshRoot, ConfigService.allowedStoreFiles))
  let freshRegistryCalls = 0
  const cliBoot = await resolveStartupLocale({
    config: freshConfig,
    argv: ['ZTools.exe', '--lang=en-US'],
    systemLocale: 'zh-CN',
    readInstallLocaleImpl: async () => {
      freshRegistryCalls += 1
      return 'zh-CN'
    }
  })
  assert.deepEqual(cliBoot, { setting: 'en-US', resolved: 'en-US', source: 'cli' })
  assert.equal(freshRegistryCalls, 0)

  // 4. 破坏性用例：注册表查询抛错时优雅回退 systemLocale
  const warnings: string[] = []
  const fallbackBoot = await resolveStartupLocale({
    config: freshConfig,
    argv: ['ZTools.exe'],
    systemLocale: 'zh-Hans-CN',
    readInstallLocaleImpl: async () => {
      throw new Error('registry read boom')
    },
    onWarn: (msg) => warnings.push(msg)
  })
  assert.deepEqual(fallbackBoot, { setting: 'system', resolved: 'zh-CN', source: 'system' })
  assert.equal(warnings.length, 1)

  // 5. 冷启动源码时序门禁：bootstrap.ts 必须在 nativeRuntime.start() 之前调用 resolveStartupLocale 与 setLocale
  const bootstrapSource = await fs.readFile(path.resolve(__dirname, '../../../src/main/bootstrap.ts'), 'utf8')
  const resolveIdx = bootstrapSource.indexOf('resolveStartupLocale(')
  const nativeStartIdx = bootstrapSource.indexOf("runLifecyclePhase('native-runtime.start'")
  assert.ok(resolveIdx > 0 && nativeStartIdx > 0, 'bootstrap.ts 应包含 resolveStartupLocale 与 native-runtime.start')
  assert.ok(resolveIdx < nativeStartIdx, 'ui.locale 初始化必须早于 nativeRuntime.start()')
})

test('setLocale keeps globalThis.__ztoolsLocale aligned with resolved locale', () => {
  const previous = getLocaleSetting()
  const globalHolder = globalThis as typeof globalThis & { __ztoolsLocale?: string }
  try {
    setLocale('en-US', 'zh-CN')
    assert.equal(globalHolder.__ztoolsLocale, 'en-US')
    setLocale('zh-CN', 'en-US')
    assert.equal(globalHolder.__ztoolsLocale, 'zh-CN')
    setLocale('system', 'zh-TW')
    assert.equal(globalHolder.__ztoolsLocale, 'zh-CN')
    setLocale('system', 'ja-JP')
    assert.equal(globalHolder.__ztoolsLocale, 'en-US')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('toLocalizedPublicError blocks CJK INVALID_REQUEST/METHOD_NOT_FOUND in en-US and never leaks raw {detail}/{stderr}', () => {
  const previous = getLocaleSetting()
  try {
    // 1. common.detailUnavailable 存在于双语词典
    assert.equal(t('common.detailUnavailable', undefined, 'zh-CN'), '详情见日志')
    assert.equal(t('common.detailUnavailable', undefined, 'en-US'), 'see logs for details')

    // 2. INVALID_REQUEST / METHOD_NOT_FOUND 中文原文：英文模式按 error.<code> 兜底，中文模式保留精确原文
    const zhInvalid = new ZToolsError(errorCodes.invalidRequest, '配置路径无效')
    assert.equal(toLocalizedPublicError(zhInvalid, 'en-US').message, 'Invalid request parameters')
    assert.doesNotMatch(toLocalizedPublicError(zhInvalid, 'en-US').message, /[\u4e00-\u9fa5]/)
    assert.equal(toLocalizedPublicError(zhInvalid, 'zh-CN').message, '配置路径无效')

    const zhMethodNotFound = new ZToolsError(errorCodes.methodNotFound, '未知方法: demo_foo')
    assert.equal(toLocalizedPublicError(zhMethodNotFound, 'en-US').message, 'Requested host method was not found')
    assert.equal(toLocalizedPublicError(zhMethodNotFound, 'zh-CN').message, '未知方法: demo_foo')

    // 纯英文调试消息在两种语言下都原样保留
    const enInvalid = new ZToolsError(errorCodes.invalidRequest, 'field "id" is required')
    assert.equal(toLocalizedPublicError(enInvalid, 'en-US').message, 'field "id" is required')
    assert.equal(toLocalizedPublicError(enInvalid, 'zh-CN').message, 'field "id" is required')

    // 3. 两处清洗函数：不再删除 detail/stderr，而是填充 common.detailUnavailable，彻底杜绝裸占位符
    assert.deepEqual(
      sanitizeErrorI18nParams({ detail: '底层异常：磁盘不可用', stderr: '权限不足' }, 'en-US'),
      { detail: 'see logs for details', stderr: 'see logs for details' }
    )
    assert.deepEqual(
      sanitizeDllErrorParams({ detail: '编码器初始化失败', stderr: '参数错误' }, 'en-US'),
      { detail: 'see logs for details', stderr: 'see logs for details' }
    )
    assert.deepEqual(
      sanitizeErrorI18nParams({ detail: '   ' }, 'zh-CN'),
      { detail: '详情见日志' }
    )

    // 4. 端到端含 {detail} 模板翻译：零裸 {detail} 且英文态零中文
    const detailTemplateErr = new ZToolsError(errorCodes.internalError, '执行失败', {
      i18nKey: 'hud.error.executionFailed',
      i18nParams: { detail: '脚本执行超时：无法连接管道' }
    })
    const enRendered = toLocalizedPublicError(detailTemplateErr, 'en-US')
    assert.equal(enRendered.message, 'Execution failed: see logs for details')
    assert.ok(!enRendered.message.includes('{detail}'))
    assert.doesNotMatch(enRendered.message, /[\u4e00-\u9fa5]/)

    // 5. 上游未传 i18nParams 或缺失 detail 键时同样补入 common.detailUnavailable，绝不泄漏裸 {detail}
    const missingDetailErr = new ZToolsError(errorCodes.internalError, '执行失败', {
      i18nKey: 'hud.error.executionFailed'
    })
    assert.equal(toLocalizedPublicError(missingDetailErr, 'en-US').message, 'Execution failed: see logs for details')
    assert.equal(toLocalizedPublicError(missingDetailErr, 'zh-CN').message, '执行失败: 详情见日志')
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('DllPluginService syncLocale dispatches __setLocale only to active resident UI DLLs and callAsync sanitizes failure messages', async () => {
  const previous = getLocaleSetting()
  try {
    setLocale('zh-CN')
    const nativeCalls: Array<{ pluginId: string; dllId: string; func: string; params: unknown }> = []
    const manifests: Record<string, PluginManifest> = {
      screenshot: {
        id: 'screenshot', name: 'Screenshot', version: '1.0.0', entry: 'index.html',
        dllloader: 'lib/ScreenCapturePlugin.dll', requireAdmin: false, commonLibs: []
      },
      record: {
        id: 'record', name: 'Record', version: '1.0.0', entry: 'index.html',
        dllloader: 'lib/RecordPlugin.dll', requireAdmin: false, commonLibs: []
      },
      'screen-color-picker': {
        id: 'screen-color-picker', name: 'Color Picker', version: '1.0.0', entry: 'index.html',
        dllloader: 'lib/ScreenColorPickerPlugin.dll', requireAdmin: false, commonLibs: []
      },
      'batch-audio': {
        id: 'batch-audio', name: 'Batch Audio', version: '1.0.0', entry: 'index.html',
        dllloader: 'lib/BatchAudioPlugin.dll', requireAdmin: false, commonLibs: []
      }
    }

    let nextAsyncOutcome: { kind: 'not-started' | 'host-exited'; error: Error } | null = null
    const service = new DllPluginService(
      {
        list: async () => ({ success: true, data: Object.values(manifests) }),
        withPluginManifest: async (id, action) => {
          const manifest = manifests[id]
          if (!manifest) throw new Error(`missing manifest ${id}`)
          return action(manifest, { sdkApiLane: 1 })
        }
      },
      {
        callDll: async (pluginId, dllId, func, params) => {
          nativeCalls.push({ pluginId, dllId, func, params })
          // 模拟 screenshot 的 __setLocale 失败，验证不中断 record 的派发
          if (func === '__setLocale' && pluginId === 'screenshot') {
            throw new Error('simulated __setLocale failure')
          }
          return { code: 0, result: JSON.stringify({ success: true }) }
        },
        callDllAsync: async () => 'unused',
        callDllWithCallback: async () => 'unused',
        beginDllAsyncTask: (_pluginId, _dllId, _fn, _params, _ctx, _sig, taskId) => ({
          taskId: taskId ?? 'task_async_err',
          outcome: Promise.resolve(nextAsyncOutcome ?? { kind: 'started' })
        }),
        beginDllCallbackTask: (_pluginId, _dllId, _fn, _params, _ctx, _sig, taskId) => ({
          taskId: taskId ?? 'task_cb',
          outcome: Promise.resolve({ kind: 'started' })
        }),
        queryDllTask: async (_p, _d, taskId) => ({
          taskId, mode: 'async', status: 'completed', progress: 100, functionName: 'Run', error: null
        }),
        cancelDllTask: async () => 0,
        clearDllTask: async () => undefined,
        getDllInfo: async () => ({
          pluginName: 'Mock', version: '1.0.0', author: 'ZTools', description: '', functions: [],
          supportsAsync: true, supportsCallback: true, supportsCancel: true, supportsStopManagedProcesses: false
        }),
        onDllEvent: () => () => undefined,
        acquirePluginMaintenance: async () => () => undefined,
        unloadDll: async () => undefined
      },
      null,
      { publishHostToOwner: () => ({ success: true, delivered: 0 }) },
      undefined,
      undefined,
      { authorizeCall: async (_dllId: string, _fn: string, params: Record<string, unknown>) => params } as never,
      undefined,
      'win32'
    )

    const mainCaller = { type: 'main' as const, webContentsId: 1 }
    // 1. 尚无活跃常驻 DLL 时 syncLocale 不发起任何 __setLocale
    service.syncLocale('en-US')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(nativeCalls.length, 0)

    // 2. 激活 screenshot、record 以及普通非界面插件 batch-audio（不激活 screen-color-picker）
    await service.call({ plugin: 'ScreenCapturePlugin', func: 'GetScreenList', params: {} }, mainCaller)
    await service.call({ plugin: 'RecordPlugin', func: 'GetMediaInfo', params: {} }, mainCaller)
    await service.call({ plugin: 'BatchAudioPlugin', func: 'GetFileInfo', params: {} }, mainCaller)
    nativeCalls.length = 0

    // 3. 热切换语言：仅向已活跃的 screenshot 和 record 派发 __setLocale；screenshot 失败不中断 record
    const originalWarn = console.warn
    const warnings: unknown[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      service.syncLocale('en-US')
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      console.warn = originalWarn
    }
    const dispatched = nativeCalls.filter((c) => c.func === '__setLocale')
    assert.equal(dispatched.length, 2)
    assert.deepEqual(
      dispatched.map((c) => ({ dllId: c.dllId, params: c.params })).sort((a, b) => a.dllId.localeCompare(b.dllId)),
      [
        { dllId: 'RecordPlugin', params: { locale: 'en-US' } },
        { dllId: 'ScreenCapturePlugin', params: { locale: 'en-US' } }
      ]
    )
    assert.ok(warnings.length >= 1, '单款 __setLocale 失败应记录 warn 日志')

    // 4. 卸载 record 后再次 syncLocale，不再向 record 派发
    await service.unloadPlugin('record')
    nativeCalls.length = 0
    const origWarn2 = console.warn
    console.warn = () => undefined
    try {
      service.syncLocale('zh-CN')
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      console.warn = origWarn2
    }
    const dispatchedAfterUnload = nativeCalls.filter((c) => c.func === '__setLocale')
    assert.deepEqual(dispatchedAfterUnload.map((c) => c.dllId), ['ScreenCapturePlugin'])

    // 5. callAsync 两条失败分支经 resolveNativeErrorMessage 清洗（英文模式下绝不泄漏中文）
    setLocale('en-US')
    nextAsyncOutcome = { kind: 'not-started', error: new Error('原生宿主未启动：加载失败') }
    const notStartedRes = await service.callAsync(
      { plugin: 'BatchAudioPlugin', func: 'GetFileInfo', params: {} },
      mainCaller
    )
    assert.equal(notStartedRes.success, false)
    assert.doesNotMatch(String(notStartedRes.error), /[\u4e00-\u9fa5]/)

    nextAsyncOutcome = { kind: 'host-exited', error: new Error('原生宿主进程意外退出') }
    const hostExitedRes = await service.callAsync(
      { plugin: 'BatchAudioPlugin', func: 'GetFileInfo', params: {} },
      mainCaller
    )
    assert.equal(hostExitedRes.success, false)
    assert.doesNotMatch(String(hostExitedRes.error), /[\u4e00-\u9fa5]/)

    await service.stop()
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('plugin-i18n uses strict locale matching so third languages are never misclassified as en-US', () => {
  assert.equal(matchSupportedLocale('zh-Hans-CN'), 'zh-CN')
  assert.equal(matchSupportedLocale('en_GB.UTF-8'), 'en-US')
  assert.equal(matchSupportedLocale('ja-JP'), null)
  assert.equal(matchSupportedLocale('fr-FR'), null)
  assert.equal(matchSupportedLocale('system'), null)

  const manifestWithThirdLang: Record<string, unknown> = {
    id: 'demo.third-lang',
    name: 'Default Name',
    description: 'Default Description',
    i18n: {
      'ja-JP': {
        name: '日本語タイトル',
        description: '日本語の説明'
      },
      'fr-FR': {
        name: 'Titre Français',
        description: 'Description Française'
      }
    }
  }

  // en-US 必须回退到顶层默认值，绝不能误命中 ja-JP / fr-FR
  assert.equal(getLocalizedPluginName(manifestWithThirdLang, 'en-US'), 'Default Name')
  assert.equal(getLocalizedPluginDescription(manifestWithThirdLang, 'en-US'), 'Default Description')
  assert.equal(getLocalizedPluginName(manifestWithThirdLang, 'zh-CN'), 'Default Name')

  // 短标签 en / zh-Hans 仍应正常匹配
  const shortTagManifest: Record<string, unknown> = {
    id: 'demo.short-tag',
    name: 'Base',
    i18n: {
      'ja-JP': { name: '日本語' },
      en: { name: 'English Short' },
      'zh-Hans': { name: '简体中文短标签' }
    }
  }
  assert.equal(getLocalizedPluginName(shortTagManifest, 'en-US'), 'English Short')
  assert.equal(getLocalizedPluginName(shortTagManifest, 'zh-CN'), '简体中文短标签')
})

test('PluginWindowManager syncs latest locale after loadURL finishes when locale switches during creating state', async () => {
  const previous = getLocaleSetting()
  try {
    setLocale('en-US')
    const registry = new WindowRegistry()
    const titleHistory: string[] = []
    const executedScripts: string[] = []
    let finishLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { finishLoad = resolve })

    const fakeManifest: PluginManifest = {
      id: 'demo.creating-locale',
      name: '建窗中切换测试',
      version: '1.0.0',
      entry: 'index.html',
      dllloader: '',
      requireAdmin: false,
      commonLibs: [],
      i18n: {
        'en-US': { name: 'Creating Race Test' }
      }
    }

    const manager = new PluginWindowManager({
      registry,
      manifests: {
        withPluginManifest: async (_id, action) => action(fakeManifest, { sdkApiLane: 1 })
      },
      createWindow: () => {
        const wc = Object.assign(new EventEmitter(), {
          id: 910,
          session: {},
          getURL: () => 'ztools://plugins/demo.creating-locale/index.html',
          isDestroyed: () => false,
          setWindowOpenHandler: () => undefined,
          executeJavaScript: async (script: string) => {
            executedScripts.push(script)
            return undefined
          }
        })
        const win = Object.assign(new EventEmitter(), {
          webContents: wc,
          isDestroyed: () => false,
          isMinimized: () => false,
          isMaximized: () => false,
          isFullScreen: () => false,
          isVisible: () => true,
          loadURL: async () => { await loadGate },
          show: () => undefined,
          focus: () => undefined,
          destroy: () => undefined,
          setTitle: (title: string) => { titleHistory.push(title) }
        })
        return win as unknown as Electron.BrowserWindow
      }
    })

    const openPromise = manager.open({ pluginId: 'demo.creating-locale' })
    // 等待进入 creating 态（loadURL 挂起中）
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(manager.getPluginState('demo.creating-locale'), 'creating')

    // 建窗期间热切换到 zh-CN
    setLocale('zh-CN')
    manager.refreshLocale('zh-CN')
    // 此时尚未 ready，不应向未加载页面注入 __ztoolsLocale
    assert.equal(executedScripts.some((s) => s.includes('window.__ztoolsLocale="zh-CN"')), false)

    // 放行 loadURL 完成
    finishLoad()
    await openPromise

    assert.ok(titleHistory.includes('建窗中切换测试'), '建窗完成后应补刷最新中文标题')
    assert.ok(
      executedScripts.some((s) => s.includes('window.__ztoolsLocale="zh-CN"')),
      '建窗完成后应补同步最新 __ztoolsLocale'
    )
    await manager.stop()
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('WindowService.refreshLocale updates open popout windows and recordBarHtml exposes stop-text hook', async () => {
  const previous = getLocaleSetting()
  try {
    setLocale('zh-CN')
    const zhHtml = recordBarHtml(12, 'zh-CN')
    assert.ok(zhHtml.includes('id="btn-stop"'))
    const enHtml = recordBarHtml(12, 'en-US')
    assert.ok(enHtml.includes('id="btn-stop"'))
    assert.doesNotMatch(enHtml, /[\u4e00-\u9fa5]/)

    const executedPopoutScripts: string[] = []
    const registry = new WindowRegistry()
    const service = new WindowService(
      {} as never,
      registry,
      undefined,
      () => {
        const wc = Object.assign(new EventEmitter(), {
          id: 951,
          session: {},
          getURL: () => 'ztools://web/index.html#/popout/demo',
          isDestroyed: () => false,
          setWindowOpenHandler: () => undefined,
          executeJavaScript: async (script: string) => {
            executedPopoutScripts.push(script)
            return undefined
          }
        })
        const win = Object.assign(new EventEmitter(), {
          webContents: wc,
          isDestroyed: () => false,
          isMinimized: () => false,
          isMaximized: () => false,
          isFullScreen: () => false,
          getBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
          getNormalBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
          loadURL: async () => undefined,
          show: () => undefined,
          focus: () => undefined,
          destroy: () => undefined
        })
        return win as unknown as Electron.BrowserWindow
      }
    )

    await service.open(
      { url: 'ztools://web/index.html#/popout/demo' },
      { type: 'main', webContentsId: 1 }
    )
    service.refreshLocale('en-US')
    assert.ok(
      executedPopoutScripts.some((s) => s.includes('window.__ztoolsLocale="en-US"')),
      'WindowService.refreshLocale 应向已打开独立弹出窗口同步 __ztoolsLocale'
    )
    service.stop()
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('M3 locale normalization aligns with plugins-spec single source of truth', () => {
  assert.equal(stripLocaleSuffix('zh_CN.UTF-8'), 'zh-CN')
  assert.equal(stripLocaleSuffix('en_US@euro'), 'en-US')
  assert.equal(stripLocaleSuffix('  zh_Hant_TW.utf8  '), 'zh-Hant-TW')
  assert.equal(stripLocaleSuffix(null), '')

  assert.equal(matchSupportedLocale('zh_CN.UTF-8'), 'zh-CN')
  assert.equal(matchSupportedLocale('en_US@euro'), 'en-US')
  for (const unmatched of ['system', 'auto', 'default', '', null, undefined, 'ja-JP', 'fr-FR', 'ko-KR', 'ja_JP.UTF-8']) {
    assert.equal(matchSupportedLocale(unmatched), null, `expected ${String(unmatched)} -> null`)
  }

  assert.equal(resolveLocale(['system', 'fr-FR', 'zh_CN.UTF-8']), 'zh-CN')
  assert.equal(resolveLocale(['', 'auto', 'ja-JP']), 'en-US')
  assert.equal(resolveLocale('ja-JP'), 'en-US')
  assert.equal(normalizeLocaleSetting('zh_CN.UTF-8'), 'zh-CN')
  assert.equal(normalizeLocaleSetting('system'), 'system')
  assert.equal(normalizeLocaleSetting('fr-FR'), 'system')
})

test('M3 main t() supports pipe plurals, inline plurals, and {{var}} literal escaping', () => {
  const previous = getLocaleSetting()
  try {
    setLocale('en-US')
    // 直接对未知键模板（fallback 为 key 本身）验证复数段与转义，避免污染正式词典
    assert.equal(t('No items | 1 item | {count} items', { count: 0 }), 'No items')
    assert.equal(t('No items | 1 item | {count} items', { count: 1 }), '1 item')
    assert.equal(t('No items | 1 item | {count} items', { count: 5 }), '5 items')
    assert.equal(t('{count} file | {count} files', { count: 1 }), '1 file')
    assert.equal(t('{count} file | {count} files', { count: 3 }), '3 files')
    assert.equal(t('A \\| B | C \\| D', { count: 2 }), 'C | D')
    assert.equal(t('Found {n} [[n:match|matches]]', { n: 1 }), 'Found 1 match')
    assert.equal(t('Found {n} [[n:match|matches]]', { n: 4 }), 'Found 4 matches')
    assert.equal(t('Macro {{date}} for {user}', { date: '2026-01-01', user: 'Alice' }), 'Macro {date} for Alice')
    assert.equal(t('Macro {{query}}'), 'Macro {query}')
    // 现有含 | 且不含 count 的模板不受复数拆分误伤
    assert.ok(t('scriptCommands.detail.summaryLine', { packageName: 'demo', status: 'ok', durationMs: 12 }).includes('|'))
  } finally {
    setLocale(previous, 'zh-CN')
  }
})

test('M3 ConfigService resets locale hook to system when ui object is cleared or overwritten without locale', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-i18n-config-reset-'))
  context.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  const store = new JsonFileStore(tempRoot, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)
  const observed: unknown[] = []
  const stop = config.onLocaleSettingChanged((raw) => { observed.push(raw) })
  try {
    await config.set('user_settings.json', 'ui.locale', 'en-US', true)
    await config.set('user_settings.json', 'ui', JSON.stringify({ theme: 'dark' }), true)
    await config.set('user_settings.json', 'ui', JSON.stringify({ locale: 'zh-CN' }), true)
    await config.set('user_settings.json', 'ui', '', true)
    assert.deepEqual(observed, ['en-US', 'system', 'zh-CN', 'system'])
  } finally {
    stop()
  }
})

test('M3 launcher-controller, system-tools, geek-tools, and markdown-renderer localize user-facing text', async () => {
  const previous = getLocaleSetting()
  const target = {
    hide: () => undefined,
    show: () => undefined,
    toggle: () => undefined,
    showMainWindow: () => undefined
  }
  const tools = new SystemToolsService({
    openExternal: async () => undefined,
    launchProcess: async () => ''
  }, 'darwin')
  const winTools = new SystemToolsService({
    openExternal: async () => undefined,
    launchProcess: async () => ''
  }, 'win32')
  const geek = new GeekToolsService({ dbPath: ':memory:' })
  try {
    setLocale('en-US')
    assert.equal(handleLauncherCall(target, 'unknown_cmd').error, 'Unknown action')
    assert.equal(handleLauncherCall(target, 'expand_to_dashboard', { route: 'javascript:alert(1)' }).error, 'Invalid target route')
    await assert.rejects(tools.openTarget('this_pc'), /only supported on Windows/)
    await assert.rejects(winTools.openTarget('not_exist'), /Unknown system tool/)
    assert.equal(geek.getTypingChallenges()[0]?.title, 'TypeScript Generic Interface')
    await assert.rejects(geek.launchGame('missing-game'), /Game not found: missing-game/)
    const mdEn = renderMarkdown('<script>x</script>\n\n![alt](file:///a.png)', { preset: 'academic', fontSize: 'size-s4', firstLineIndent: false })
    assert.ok(mdEn.summary.warnings.some((w) => w.includes('Raw HTML is preserved')))
    assert.ok(mdEn.text.includes('[Image: alt]'))
    assert.throws(() => renderMarkdown('   ', { preset: 'academic', fontSize: 'size-s4', firstLineIndent: false }))

    setLocale('zh-CN')
    assert.equal(handleLauncherCall(target, 'unknown_cmd').error, '未知动作')
    assert.equal(handleLauncherCall(target, 'expand_to_dashboard', { route: 'javascript:alert(1)' }).error, '非法的目标页面')
    await assert.rejects(tools.openTarget('this_pc'), /系统工具仅支持 Windows/)
    await assert.rejects(winTools.openTarget('not_exist'), /未知系统工具/)
    assert.equal(geek.getTypingChallenges()[0]?.title, 'TypeScript 泛型接口')
    await assert.rejects(geek.launchGame('missing-game'), /未找到游戏：missing-game/)
    const mdZh = renderMarkdown('<script>x</script>\n\n![alt](file:///a.png)', { preset: 'academic', fontSize: 'size-s4', firstLineIndent: false })
    assert.ok(mdZh.summary.warnings.some((w) => w.includes('原始 HTML 按文字保留')))
    assert.ok(mdZh.text.includes('[图片：alt]'))
  } finally {
    geek.stop()
    setLocale(previous, 'zh-CN')
  }
})



