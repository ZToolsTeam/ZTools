import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard as electronClipboard,
  desktopCapturer,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  shell as electronShell,
  systemPreferences
} from 'electron'
import type { Event as ElectronEvent } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IpcRouter } from './ipc/router.js'
import { IPC_EVENT_CHANNEL } from '../contracts/ipc.js'
import { resolveOpenSettingsShortcut, SHELL_SHORTCUTS } from '../contracts/hotkey-rules.js'
import { installZToolsProtocol, registerZToolsScheme } from './protocol/ztools-protocol.js'
import { getRuntimeDiagnostics } from './services/runtime-diagnostics.js'
import {
  initializeRuntimeLogging,
  writeRuntimeLog,
  type RuntimeLogLevel
} from './services/runtime-logger.js'
import { createCoreServices, readWebVersion, type CoreServices } from './services/core-services.js'
import { electronCredentialProtection } from './platform/electron-credential-protection.js'
import { MacAppUpdater } from './platform/macos/app-update.js'
import { WebResourceService } from './services/web-resource-service.js'
import {
  acceleratorToRecorderKeyPayload,
  configureSessionSecurity,
  createMainWindow,
  dispatchRecorderKeyToWebContents,
  normalizeAccentTheme,
  updateMainWindowTheme,
  type AccentTheme
} from './windows/main-window.js'
import { loadApplicationIcon, loadTrayIcon } from './windows/application-icon.js'
import {
  decideCloseAction,
  readClosePreferences,
  shouldQuitOnAllWindowsClosed,
  type CloseRequestOrigin
} from './windows/close-behavior.js'
import { TrayController } from './windows/tray-controller.js'
import { LauncherController } from './windows/launcher-controller.js'
import { WindowRegistry } from './windows/window-registry.js'
import { SuperPanelController } from './super-panel/controller.js'
import { createPlatformNativeRuntime } from './platform/native-runtime.js'
import { createMacosNativeRuntime } from './platform/macos/native-runtime.js'
import { createWindowsNativeRuntime } from './platform/windows/native-runtime.js'
import { createPlatformScreenClipboardAdapters } from './platform/screen-clipboard.js'
import { createMacosScreenClipboardAdapters } from './platform/macos/screen-clipboard.js'
import { configureMacosUserDataPath } from './platform/macos/user-data-path.js'
import { createWindowsScreenClipboardAdapters } from './platform/windows/screen-clipboard.js'
import { createMacosSystemPlatformAdapter } from './platform/macos/system.js'
import { installMacosApplicationMenu } from './platform/macos/application-menu.js'
import { createMacosLoginItemAdapter } from './platform/macos/login-item.js'
import { MacosExternalOpenCoordinator, installMacosExternalOpenListeners } from './platform/macos/external-open.js'
import { createPlatformProcessDiscoveryAdapter } from './platform/process-discovery.js'
import { createPathSemanticsAdapter } from './platform/path-semantics.js'
import { createSystemPlatformAdapter } from './platform/system.js'
import { createWindowsSystemPlatformAdapter } from './platform/windows/system.js'
import { createPlatformWindowLifecyclePolicy } from './platform/window-lifecycle.js'
import { ApplicationLifecycle, runCleanupActions } from './application-lifecycle.js'
import { createAndAttachElectronReferenceRuntime } from './platform/electron-reference-runtime.js'
import { closeDesktopNotifications, showDesktopNotification } from './platform/desktop-notification.js'
import { parseDevRuntimeOptions } from './runtime/dev-options.js'
import { RuntimeLock } from './runtime/runtime-lock.js'
import { resolveRuntimePaths } from './runtime/runtime-paths.js'
import { PluginStateService } from './services/plugin-state-service.js'
import { SystemToolsService } from './services/system-tools-service.js'
import {
  LaunchIntentDeduplicator,
  parseLaunchIntent,
  type LaunchIntent
} from './runtime/launch-intent.js'
import { setLocale, t } from './i18n/index.js'
import { parseCommandLineLocale, resolveStartupLocale } from './i18n/install-locale.js'

const devRuntimeOptions = parseDevRuntimeOptions(process.argv, { isPackaged: app.isPackaged })
if (devRuntimeOptions.isolatedUserDataRoot) {
  // 在 requestSingleInstanceLock() 与 macOS 默认路径配置之前切分 userData，
  // 确保独立 --data-root 测试/开发实例与本机安装版完全隔离单例锁与浏览器会话。
  fs.mkdirSync(devRuntimeOptions.isolatedUserDataRoot, { recursive: true, mode: 0o700 })
  app.setPath('userData', devRuntimeOptions.isolatedUserDataRoot)
} else if (process.platform === 'darwin') {
  configureMacosUserDataPath(app)
}

const processStartedAt = Date.now()
const initialLaunchIntent = parseLaunchIntent(process.argv)
const healthCheckRequested = process.argv.some((argument) => argument === '--health-check')
const normalizedRequestedDataRoot = devRuntimeOptions.requestedDataRoot
const runtimePaths = resolveRuntimePaths({
  mode: app.isPackaged ? 'production' : 'development',
  appDataRoot: app.getPath('appData'),
  installRoot: app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath(),
  ...(normalizedRequestedDataRoot
    ? {
        businessDataRoot: normalizedRequestedDataRoot,
        productRoot: path.dirname(normalizedRequestedDataRoot)
      }
    : { businessDataRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2') })
})
if (!app.isPackaged && !normalizedRequestedDataRoot) {
  runtimePaths.browserProfileRoot = app.getPath('sessionData')
  runtimePaths.cacheRoot = path.join(app.getPath('userData'), 'Cache')
}
app.setPath('sessionData', runtimePaths.browserProfileRoot)
const logFile = initializeRuntimeLogging(runtimePaths.logRoot)

registerZToolsScheme()

function sanitizeUrlForLog(value: string): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '<invalid-url>'
  }
}

function resolveLogWindowRole(value: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const mode = url.searchParams.get('mode')
    if (mode === 'launcher' || url.hash.includes('launcher')) return 'launcher'
    if (url.searchParams.get('popout') === '1' || url.hash.includes('/popout/')) return 'popout'
    if (url.protocol === 'ztools:' && url.host === 'web') return 'dashboard'
    if (url.protocol === 'ztools:' && url.host === 'plugin') return 'plugin'
  } catch {
    return undefined
  }
  return undefined
}

app.on('web-contents-created', (_event, contents) => {
  const scope = `renderer:${contents.getType()}:${contents.id}`
  writeRuntimeLog('INFO', scope, 'WebContents created')
  contents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    writeRuntimeLog(
      details.level === 'error' ? 'ERROR' : 'WARN',
      scope,
      details.message,
      { source: sanitizeUrlForLog(details.sourceId), line: details.lineNumber }
    )
  })
  contents.on('did-finish-load', () => {
    const rawUrl = contents.getURL()
    const windowRole = resolveLogWindowRole(rawUrl)
    writeRuntimeLog('INFO', scope, 'Page load finished', {
      url: sanitizeUrlForLog(rawUrl),
      ...(windowRole ? { windowRole } : {})
    })
  })
  contents.on('did-fail-load', (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeRuntimeLog('ERROR', scope, 'Page load failed', {
      errorCode,
      errorDescription,
      isMainFrame,
      url: sanitizeUrlForLog(validatedURL)
    })
  })
  contents.on('preload-error', (_preloadEvent, preloadPath, error) => {
    writeRuntimeLog('ERROR', scope, 'Preload failed', { preloadPath }, error)
  })
  contents.on('render-process-gone', (_goneEvent, details) => {
    writeRuntimeLog('ERROR', scope, 'Renderer process gone', details)
  })
  contents.on('unresponsive', () => {
    writeRuntimeLog('WARN', scope, 'Renderer became unresponsive', {
      url: sanitizeUrlForLog(contents.getURL())
    })
  })
})

app.on('child-process-gone', (_event, details) => {
  writeRuntimeLog('ERROR', 'electron-child', 'Child process gone', details)
})

console.info('Electron process starting', {
  logFile,
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  cwd: process.cwd()
})
lifecycleLog('INFO', 'Electron main process started', {
  pid: process.pid,
  logFile,
  isPackaged: app.isPackaged,
  healthCheckRequested,
  hasLaunchIntent: initialLaunchIntent !== undefined,
  hasDataRootOverride: normalizedRequestedDataRoot !== undefined
})

const webRoot = path.resolve(__dirname, '../assets/web')
const lifecyclePolicy = createPlatformWindowLifecyclePolicy(process.platform)
const applicationLifecycle = new ApplicationLifecycle()
const registry = new WindowRegistry()
let router: IpcRouter | null = null
let services: CoreServices | null = null
let webResources: WebResourceService | null = null
let mainApplicationIcon: Electron.NativeImage | undefined
let initialMainWindowSize: { width: number; height: number } | undefined
let mainWindow: BrowserWindow | null = null
let superPanel: SuperPanelController | null = null
let tray: TrayController | null = null
let launcher: LauncherController | null = null
let macAppUpdater: MacAppUpdater | undefined
let quitAllowed = false
let closeHandling = false
let closeConfirmationPending = false
let runtimeLock: RuntimeLock | null = null
let healthCheckExitCode: number | undefined
let launchIntentReady = false
let pendingWakeTarget: 'main' | 'launcher' | undefined
let removeNativeThemeListener: (() => void) | undefined
let startupAnalyticsReported = false
const pendingLaunchIntents: LaunchIntent[] = []
const launchIntentDeduplicator = new LaunchIntentDeduplicator()

function lifecycleLog(
  level: RuntimeLogLevel,
  message: string,
  details?: Record<string, unknown>,
  error?: unknown
): void {
  const values: unknown[] = [message]
  if (details !== undefined) values.push(details)
  if (error !== undefined) values.push(error)
  writeRuntimeLog(level, 'main-lifecycle', ...values)
}

function lifecyclePhaseStarted(phase: string, details?: Record<string, unknown>): number {
  const startedAt = Date.now()
  lifecycleLog('INFO', 'Lifecycle phase started', { ...details, phase })
  return startedAt
}

function lifecyclePhaseCompleted(
  phase: string,
  startedAt: number,
  details?: Record<string, unknown>
): void {
  lifecycleLog('INFO', 'Lifecycle phase completed', {
    ...details,
    phase,
    durationMs: Date.now() - startedAt
  })
}

function lifecyclePhaseFailed(
  phase: string,
  startedAt: number,
  error: unknown,
  details?: Record<string, unknown>
): void {
  lifecycleLog('ERROR', 'Lifecycle phase failed', {
    ...details,
    phase,
    durationMs: Date.now() - startedAt
  }, error)
}

async function runLifecyclePhase<T>(
  phase: string,
  action: () => T | Promise<T>,
  details?: Record<string, unknown>
): Promise<T> {
  const startedAt = lifecyclePhaseStarted(phase, details)
  try {
    const result = await action()
    lifecyclePhaseCompleted(phase, startedAt)
    return result
  } catch (error) {
    lifecyclePhaseFailed(phase, startedAt, error)
    throw error
  }
}

function activeWebRoot(): string {
  return webResources?.root ?? webRoot
}

let currentAccent: AccentTheme = 'ember'

function applyDarkMode(enabled: boolean): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  updateMainWindowTheme(window, enabled, currentAccent)
  void window.webContents.executeJavaScript(
    `document.documentElement.classList.toggle('dark', ${enabled ? 'true' : 'false'})`
  ).catch(() => undefined)
}

function applyAccentTheme(accent: AccentTheme): void {
  currentAccent = normalizeAccentTheme(accent)
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  updateMainWindowTheme(window, nativeTheme.shouldUseDarkColors, currentAccent)
  void window.webContents.executeJavaScript(
    `document.documentElement.dataset.accent = ${JSON.stringify(currentAccent)}`
  ).catch(() => undefined)
}

function reportApplicationStartupAnalytics(): void {
  if (!services || startupAnalyticsReported) return
  startupAnalyticsReported = true
  services.analytics.reportStartup()
}

let quitRequestPromise: Promise<void> | null = null

const externalOpen = new MacosExternalOpenCoordinator({
  handle: async (request, signal) => {
    if (signal.aborted || applicationLifecycle.cancellationRequested || !router) return
    if (request.kind !== 'plugin-open') throw new Error('External file consumer is not available')
    showMainWindow()
    if (signal.aborted || applicationLifecycle.cancellationRequested) return
    await router.openPlugin({ pluginId: request.pluginId })
  },
  onDeliveryError: () => console.error('外部插件打开失败')
})
// OS file delivery stays unregistered until the private FileRef consumer is complete.
const externalOpenListeners = installMacosExternalOpenListeners(app, externalOpen, {
  platform: process.platform,
  isPackaged: app.isPackaged,
  includeFileEvents: false
})

const refreshFocusedPermissions = (_event: ElectronEvent, window: BrowserWindow): void => {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  void router?.refreshPermissionOwner(window.webContents.id).catch((error: unknown) => {
    console.error('权限状态刷新失败', error)
  })
}
const refreshResumedPermissions = (): void => {
  void router?.refreshPermissionSubscribers().catch((error: unknown) => {
    console.error('唤醒后权限状态刷新失败', error)
  })
  void router?.verifyTriggersOnResume().catch((error: unknown) => {
    console.error('唤醒后热键重验失败', error)
  })
}
let permissionRefreshListenersInstalled = false

function stopApplication(): Promise<void> {
  pendingWakeTarget = undefined
  return applicationLifecycle.stop(async () => {
    if (permissionRefreshListenersInstalled) {
      permissionRefreshListenersInstalled = false
      app.removeListener('browser-window-focus', refreshFocusedPermissions)
      powerMonitor.removeListener('resume', refreshResumedPermissions)
    }
    const ownedTray = tray
    const ownedLauncher = launcher
    const ownedPanel = superPanel
    const ownedRouter = router
    const ownedServices = services
    const ownedWindow = mainWindow
    tray = null
    launcher = null
    superPanel = null
    router = null
    services = null
    mainWindow = null
    try {
      await runCleanupActions([
        async () => {
          if (ownedServices && ownedWindow && !ownedWindow.isDestroyed()) {
            const bounds = ownedWindow.getNormalBounds()
            await ownedServices.config.setMainWindowSize(bounds.width, bounds.height)
          }
        },
        () => { removeNativeThemeListener?.(); removeNativeThemeListener = undefined },
        () => externalOpenListeners.dispose(),
        () => externalOpen.stop(),
        () => ownedTray?.stop(),
        () => ownedLauncher?.stop(),
        () => ownedPanel?.stop(),
        () => ownedRouter?.stop(),
        () => ownedServices?.stop(),
        () => closeDesktopNotifications(),
        async () => { try { await runtimeLock?.release() } finally { runtimeLock = null } },
        () => {
          if (ownedWindow && !ownedWindow.isDestroyed()) ownedWindow.destroy()
        }
      ])
    } finally {
      registry.clear()
    }
  })
}

function requestApplicationStop(event: ElectronEvent): void {
  if (quitAllowed) {
    lifecycleLog('INFO', 'Electron quit event accepted after cleanup')
    return
  }
  lifecycleLog('INFO', 'Electron quit requested', {
    closeHandling,
    closeConfirmationPending,
    shutdownInProgress: applicationLifecycle.cancellationRequested
  })
  event.preventDefault()
  if (quitRequestPromise) return
  quitRequestPromise = stopApplication().then(() => {
    quitAllowed = true
    lifecycleLog('INFO', 'Application cleanup finished; allowing Electron quit')
    if (!macAppUpdater?.quitAndInstall()) app.quit()
  }).catch((error: unknown) => {
    console.error('Electron shutdown failed', error)
    lifecycleLog('ERROR', 'Application cleanup failed; forcing process exit', undefined, error)
    app.exit(1)
  })
}

function runHealthCheck(): Record<string, unknown> {
  const checks: Record<string, boolean> = {
    webRoot: false,
    dataRoot: false,
    dataRootIsOrdinaryDirectory: true,
    transactionRoot: false
  }
  const currentWebRoot = activeWebRoot()
  checks.webRoot = fs.existsSync(currentWebRoot) && fs.statSync(currentWebRoot).isDirectory()
  checks.transactionRoot = fs.existsSync(runtimePaths.transactionRoot) && fs.statSync(runtimePaths.transactionRoot).isDirectory()
  if (fs.existsSync(runtimePaths.businessDataRoot)) {
    const dataStats = fs.lstatSync(runtimePaths.businessDataRoot)
    checks.dataRoot = dataStats.isDirectory()
    checks.dataRootIsOrdinaryDirectory = dataStats.isDirectory() && !dataStats.isSymbolicLink()
  } else {
    checks.dataRoot = true
  }
  const healthy = Object.values(checks).every(Boolean)
  return {
    schemaVersion: 1,
    state: healthy ? 'healthy' : 'unhealthy',
    healthy,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    installRoot: path.dirname(app.getPath('exe')),
    dataRoot: runtimePaths.businessDataRoot,
    webRoot: currentWebRoot,
    checks
  }
}

function toggleMainWindow(): void {
  if (applicationLifecycle.cancellationRequested) return
  let pref: 'dashboard' | 'launcher' = 'launcher'
  try {
    pref = services?.config.getCachedWakePreference() ?? 'launcher'
  } catch {
    pref = 'launcher'
  }
  if (!launchIntentReady) {
    pendingWakeTarget = pref === 'launcher' ? 'launcher' : 'main'
    return
  }

  // 只有前台正在交互的悬浮条才收起；跨桌面唤醒不能把其它 Space 上的窗口当作当前窗口。
  if (launcher && launcher.isFocused()) {
    launcher.hide()
    return
  }

  // 严格遵循用户设置的「默认呼出形态」(ui.wake_preference)：悬浮条或主工作台
  if (pref === 'launcher' && launcher) {
    launcher.toggle()
    return
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    if (lifecyclePolicy.reopenMainWindowOnActivate && router && services) {
      createMainWindowInstance()
    }
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (mainWindow.isFocused()) {
    mainWindow.hide()
    return
  }
  launcher?.hide()
  mainWindow.show()
  mainWindow.focus()
}

function showMainWindow(): void {
  if (applicationLifecycle.cancellationRequested) return
  // Dock 与第二实例可能在异步初始化期间唤醒，必须等窗口依赖全部就绪。
  if (!launchIntentReady) {
    pendingWakeTarget = 'main'
    return
  }
  launcher?.hide()
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (lifecyclePolicy.reopenMainWindowOnActivate && router && services) {
      createMainWindowInstance()
    }
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.setAlwaysOnTop(true)
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false)
    }
  }, 300)
}

function navigateMainWindow(route: string): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  const deliver = (): void => {
    if (!target.isDestroyed()) {
      target.webContents.send(IPC_EVENT_CHANNEL, { msgType: 'navigation.open', msgData: { route } })
    }
  }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', deliver)
  else deliver()
}

function openMainWindowAt(route: string): void {
  showMainWindow()
  navigateMainWindow(route)
}

function openLauncherWindow(): void {
  if (applicationLifecycle.cancellationRequested) return
  if (launcher) {
    launcher.show()
    return
  }
  showMainWindow()
}

let currentSettingsAccelerator: string = SHELL_SHORTCUTS.OPEN_SETTINGS

/**
 * 同步刷新 macOS 顶栏应用菜单（携带最新的「偏好设置」快捷键）
 */
function refreshMacosApplicationMenu(settingsAccelerator: string = currentSettingsAccelerator): void {
  currentSettingsAccelerator = settingsAccelerator
  if (process.platform !== 'darwin') return
  installMacosApplicationMenu({
    onOpenPreferences: () => openMainWindowAt('/advanced-settings'),
    settingsAccelerator
  })
}

async function readTrayState(): Promise<{
  wakeAccelerator: string
  settingsAccelerator: string
  showTrayIcon: boolean
}> {
  if (!services) {
    return {
      wakeAccelerator: 'Alt+Space',
      settingsAccelerator: SHELL_SHORTCUTS.OPEN_SETTINGS,
      showTrayIcon: true
    }
  }
  const wakeFromTrigger = router?.getGlobalWakeHotkey()
  let wakeAccelerator = ''
  if (wakeFromTrigger?.exists) {
    // 优先使用 TriggerService 托管的 global_wake_hotkey 作为唯一真实信源（禁用则托盘不展示快捷键）
    wakeAccelerator = wakeFromTrigger.enabled ? wakeFromTrigger.key.trim() : ''
  } else {
    const rawWakeHotkey = await services.config
      .get('user_settings.json', 'hotkey.global', '__UNSET__')
      .catch(() => '__UNSET__')
    wakeAccelerator = rawWakeHotkey === '__UNSET__'
      ? 'Alt+Space'
      : String(rawWakeHotkey ?? '').trim()
  }
  const rawShellShortcuts = await services.config
    .get('user_settings.json', 'hotkey.shell', '')
    .catch(() => '')
  const settingsAccelerator = resolveOpenSettingsShortcut(rawShellShortcuts)
  const rawShowTrayIcon = await services.config
    .get('user_settings.json', 'system.showTrayIcon', 'true')
    .catch(() => 'true')
  return {
    // 存的是空串表示用户已关闭全局唤醒，托盘菜单不显示快捷键
    wakeAccelerator,
    // 存的是空串表示用户已清空偏好设置快捷键，菜单项不显示快捷键
    settingsAccelerator,
    // 默认显示；只有明确存为 false / 0 才隐藏
    showTrayIcon: !['false', '0'].includes(String(rawShowTrayIcon).trim().toLowerCase())
  }
}

function createTrayController(state: {
  wakeAccelerator: string
  settingsAccelerator: string
}): TrayController {
  if (!mainApplicationIcon) throw new Error('Application icon is not ready')
  return new TrayController({
    icon: loadTrayIcon(mainApplicationIcon),
    ...(devRuntimeOptions.isDevIsolated ? { toolTip: 'ZTools [DEV]' } : {}),
    ...state,
    showMainWindow,
    togglePrimaryWindow: toggleMainWindow,
    openLauncher: openLauncherWindow,
    openSettings: () => openMainWindowAt('/advanced-settings'),
    openAbout: () => openMainWindowAt('/about'),
    relaunchApp: () => {
      if (applicationLifecycle.cancellationRequested) return
      app.relaunch()
      app.quit()
    },
    requestExit: () => { void requestMainWindowClose('trayMenu') }
  })
}

// 托盘图标随「显示托盘图标」设置即时出现 / 消失；同步串行执行，避免连续切换时重复创建
let trayApplyQueue: Promise<void> = Promise.resolve()

function applyTrayState(state: {
  wakeAccelerator: string
  settingsAccelerator: string
  showTrayIcon: boolean
}): Promise<void> {
  if (state.settingsAccelerator !== currentSettingsAccelerator) {
    refreshMacosApplicationMenu(state.settingsAccelerator)
  }
  const { showTrayIcon, ...menuState } = state
  if (!showTrayIcon) {
    tray?.stop()
    tray = null
    return Promise.resolve()
  }
  if (tray) {
    tray.updateState(menuState)
    return Promise.resolve()
  }
  const created = createTrayController(menuState)
  tray = created
  return created.start().catch((error: unknown) => {
    if (tray === created) tray = null
    console.error('托盘图标创建失败', error)
    lifecycleLog('ERROR', 'Tray creation failed', undefined, error)
  })
}

function syncTrayState(): void {
  if (!mainApplicationIcon || applicationLifecycle.cancellationRequested) return
  trayApplyQueue = trayApplyQueue.catch(() => undefined).then(async () => {
    const state = await readTrayState()
    if (applicationLifecycle.cancellationRequested) return
    await applyTrayState(state)
  }).catch(() => undefined)
}

function createMainWindowInstance(): BrowserWindow {
  if (applicationLifecycle.cancellationRequested) {
    throw new Error('Application startup has been cancelled')
  }
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  if (!mainApplicationIcon) throw new Error('Application icon is not ready')
  const window = createMainWindow({
    icon: mainApplicationIcon, webRoot: activeWebRoot(), registry,
    ...(devRuntimeOptions.isDevIsolated ? { title: 'ZTools [DEV]' } : {}),
    // 冷启动由就绪后的唤醒目标决定显示；重开窗口才使用自动显示。
    showOnReady: launchIntentReady, darkMode: nativeTheme.shouldUseDarkColors, accent: currentAccent,
    ...(initialMainWindowSize ? { initialSize: initialMainWindowSize } : {}),
    persistNormalBounds: bounds => { void services?.config.setMainWindowSize(bounds.width, bounds.height).catch(error => console.warn('保存主窗口尺寸失败', error)) },
    isRecorderCaptureActive: () => router?.isRecorderCaptureActive() ?? false,
    onToggleLauncher: () => {
      if (launcher) {
        launcher.show()
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ztools:toggle_launcher_mode')
      }
    }
  })
  mainWindow = window
  updateMainWindowTheme(window, nativeTheme.shouldUseDarkColors, currentAccent)
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      updateMainWindowTheme(window, nativeTheme.shouldUseDarkColors, currentAccent)
    }
  })
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) {
      router?.flushStartupHotkeyConflicts()
    }
  })
  window.on('close', (event) => {
    if (quitAllowed) return
    event.preventDefault()
    void requestMainWindowClose('closeButton')
  })
  window.on('blur', () => {
    router?.setRecorderCaptureActive(false)
  })
  window.on('hide', () => {
    router?.setRecorderCaptureActive(false)
  })
  window.once('closed', () => {
    router?.setRecorderCaptureActive(false)
    if (mainWindow === window) mainWindow = null
    if (!applicationLifecycle.cancellationRequested && !quitAllowed &&
        lifecyclePolicy.quitWhenMainWindowIsDestroyed) app.quit()
  })
  return window
}

function launchContext(intent: LaunchIntent): Record<string, unknown> {
  return {
    ...(intent.source ? { source: intent.source } : {}),
    ...(intent.launchId ? { launchId: intent.launchId } : {}),
    ...(intent.launchRequestId ? { launchRequestId: intent.launchRequestId } : {}),
    ...(intent.launchType ? { launchType: intent.launchType } : {}),
    ...(intent.launchAttemptNo ? { launchAttemptNo: intent.launchAttemptNo } : {}),
    ...(intent.launchMethod ? { launchMethod: intent.launchMethod } : {}),
    ...(intent.installSessionId ? { installSessionId: intent.installSessionId } : {}),
    ...(intent.installerMode ? { installerMode: intent.installerMode } : {}),
    ...(intent.registrySource ? { registrySource: intent.registrySource } : {}),
    ...(intent.autostart !== undefined ? { autostart: intent.autostart } : {}),
    ...(intent.updated !== undefined ? { updated: intent.updated } : {})
  }
}

function signalDeploymentReady(intent: LaunchIntent | undefined): void {
  const sessionId = intent?.installSessionId
  if (!sessionId) return
  const marker = path.join(runtimePaths.transactionRoot, `${sessionId}.app-ready`)
  const temporary = `${marker}.${process.pid}.tmp`
  const content = `ZTOOLS_DEPLOYMENT_READY_V1\npid=${process.pid}\nsession=${sessionId}\n`
  try {
    fs.mkdirSync(runtimePaths.transactionRoot, { recursive: true })
    fs.writeFileSync(temporary, content, { encoding: 'utf8' })
    fs.renameSync(temporary, marker)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
    console.warn('Deployment ready signal failed', error)
  }
}

function signalDeploymentFailure(intent: LaunchIntent | undefined, error: unknown): void {
  const sessionId = intent?.installSessionId
  if (!sessionId) return
  const marker = path.join(runtimePaths.transactionRoot, `${sessionId}.app-failure`)
  const temporary = `${marker}.${process.pid}.tmp`
  const detail = (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 4096)
  const content = `ZTOOLS_DEPLOYMENT_FAILURE_V1\npid=${process.pid}\nsession=${sessionId}\nerror=${detail}\n`
  try {
    fs.mkdirSync(runtimePaths.transactionRoot, { recursive: true })
    fs.writeFileSync(temporary, content, { encoding: 'utf8' })
    fs.renameSync(temporary, marker)
  } catch (signalError) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
    console.warn('Deployment failure signal failed', signalError)
  }
}

async function dispatchLaunchIntent(intent: LaunchIntent): Promise<void> {
  if (applicationLifecycle.cancellationRequested) return
  const currentRouter = router
  if (!currentRouter) {
    pendingLaunchIntents.push(intent)
    return
  }
  const context = launchContext(intent)
  services?.analytics.reportLaunch(intent)
  try {
    currentRouter.publishLaunchIntent({ ...context, status: 'received' })
  } catch (error) {
    console.warn('Publishing launch intent failed', error)
  }
  if (intent.pluginId) {
    try {
      await currentRouter.openPlugin({
        pluginId: intent.pluginId,
        payload: { __ztools_launch_context: context }
      })
      currentRouter.publishLaunchIntent({
        ...context,
        pluginId: intent.pluginId,
        status: 'opened'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`启动插件失败: pluginId=${intent.pluginId}`, error)
      try {
        currentRouter.publishLaunchIntent({
          ...context,
          pluginId: intent.pluginId,
          status: 'failed',
          error: message
        })
      } catch (publishError) {
        console.warn('Publishing failed launch intent failed', publishError)
      }
      showMainWindow()
    }
    return
  }
  if (intent.autostart !== true) showMainWindow()
}

function acceptLaunchIntent(intent: LaunchIntent): void {
  if (applicationLifecycle.cancellationRequested) return
  if (!launchIntentDeduplicator.accept(intent)) {
    console.info(`忽略重复启动请求: launchId=${intent.launchId}`)
    return
  }
  if (!launchIntentReady) {
    pendingLaunchIntents.push(intent)
    return
  }
  void dispatchLaunchIntent(intent)
}

function drainLaunchIntents(): void {
  const queued = pendingLaunchIntents.splice(0)
  for (const intent of queued) void dispatchLaunchIntent(intent)
}

async function persistNativeCloseChoice(action: 'exit' | 'minimize'): Promise<void> {
  if (applicationLifecycle.cancellationRequested) return
  if (!services) return
  try {
    await services.config.setSetting('closeConfirm', false)
    await services.config.setSetting('minimizeToTray', action === 'minimize')
    lifecycleLog('INFO', 'Native close preference persisted', { action })
  } catch (error) {
    console.error('Persisting native close confirmation failed', error)
    lifecycleLog('ERROR', 'Native close preference persistence failed', { action }, error)
  }
}

let firstMinimizeNoticeHandled = false

function formatWakeHotkeyForNotice(rawKey: string): string {
  const trimmed = rawKey.trim()
  if (!trimmed) return ''
  const compact = trimmed.replace(/[+\s]/g, '').toLowerCase()
  if (compact === 'doublealt') return t('tray.firstMinimize.doubleAlt')
  if (compact === 'doublectrl' || compact === 'doublecontrol') return t('tray.firstMinimize.doubleCtrl')
  if (compact === 'doubleshift') return t('tray.firstMinimize.doubleShift')
  if (process.platform === 'darwin') {
    return trimmed
      .replace(/\bAlt\b/gi, 'Option')
      .replace(/\bCtrl\b/gi, 'Cmd')
  }
  return trimmed
}

/** 首次关闭主窗口隐藏到托盘时，发一条极简系统提示告知用户按全局热键随时呼出（全生命周期仅触发 1 次） */
async function notifyFirstMinimizeToTray(): Promise<void> {
  if (firstMinimizeNoticeHandled || applicationLifecycle.cancellationRequested || !services) return
  firstMinimizeNoticeHandled = true
  try {
    const notified = await services.config
      .get('user_settings.json', 'system.firstMinimizeNotified', 'false')
      .catch(() => 'false')
    if (String(notified).trim().toLowerCase() === 'true') return
    await services.config.set('user_settings.json', 'system.firstMinimizeNotified', 'true', false)
    const wake = router?.getGlobalWakeHotkey()
    const formattedKey = wake?.exists && wake.enabled ? formatWakeHotkeyForNotice(wake.key) : ''
    const body = formattedKey
      ? t('tray.firstMinimize.bodyWithHotkey', { hotkey: formattedKey })
      : t('tray.firstMinimize.bodyNoHotkey')
    await showDesktopNotification(t('tray.firstMinimize.title'), body)
  } catch (error) {
    // 系统禁用通知或免打扰时静默忽略，绝不影响隐藏到托盘
    lifecycleLog('DEBUG', 'First minimize desktop notice skipped', undefined, error)
  }
}

async function showNativeCloseConfirmation(): Promise<void> {
  if (applicationLifecycle.cancellationRequested) return
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    closeConfirmationPending = false
    lifecycleLog('WARN', 'Native close confirmation skipped because main window is unavailable')
    app.quit()
    return
  }
  let result: Electron.MessageBoxReturnValue
  try {
    lifecycleLog('INFO', 'Native close confirmation shown')
    result = await dialog.showMessageBox(window, {
      type: 'question',
      title: t('dialog.close.title'),
      // Windows 关掉托盘图标后没有托盘可去，改说「在后台运行」（仍可用全局快捷键或再次打开 ZTools 唤起）
      message: !lifecyclePolicy.useSystemTray
        ? t('dialog.close.messageDock')
        : tray ? t('dialog.close.messageTray') : t('dialog.close.messageBackground'),
      buttons: !lifecyclePolicy.useSystemTray
        ? [t('dialog.close.exitNow'), t('dialog.close.hideToDock'), t('dialog.close.cancel')]
        : [t('dialog.close.exitNow'), tray ? t('dialog.close.minimizeToTray') : t('dialog.close.runInBackground'), t('dialog.close.cancel')],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
      checkboxLabel: t('dialog.close.dontAskAgain'),
      checkboxChecked: true
    })
    lifecycleLog('INFO', 'Native close confirmation resolved', {
      response: result.response,
      checkboxChecked: result.checkboxChecked
    })
  } catch (error) {
    console.error('Showing native close confirmation failed', error)
    lifecycleLog('ERROR', 'Native close confirmation failed', undefined, error)
    return
  } finally {
    closeConfirmationPending = false
  }
  if (applicationLifecycle.cancellationRequested) return
  if (result.response === 2) return
  const action = result.response === 0 ? 'exit' : 'minimize'
  if (result.checkboxChecked) await persistNativeCloseChoice(action)
  if (action === 'exit') app.quit()
  else if (!window.isDestroyed()) {
    window.hide()
    void notifyFirstMinimizeToTray()
  }
}

async function requestMainWindowClose(origin: CloseRequestOrigin): Promise<void> {
  if (applicationLifecycle.cancellationRequested) return
  if (quitAllowed || closeHandling || closeConfirmationPending) {
    lifecycleLog('DEBUG', 'Main window close request ignored', {
      origin,
      quitAllowed,
      closeHandling,
      closeConfirmationPending
    })
    return
  }
  lifecycleLog('INFO', 'Main window close requested', { origin })
  closeHandling = true
  try {
    if (!services) {
      lifecycleLog('WARN', 'Main window close requested before core services were ready')
      app.quit()
      return
    }
    const preferences = await runLifecyclePhase(
      'close.read-preferences',
      () => readClosePreferences(services!.config),
      { origin }
    )
    const decision = decideCloseAction(preferences, origin)
    lifecycleLog('INFO', 'Main window close decision resolved', { origin, decision })
    if (applicationLifecycle.cancellationRequested) return
    switch (decision) {
      case 'confirm':
        closeConfirmationPending = true
        showMainWindow()
        const rendererConfirmationDelivered = router?.requestCloseConfirmation(origin) ?? false
        lifecycleLog('INFO', 'Renderer close confirmation requested', {
          origin,
          delivered: rendererConfirmationDelivered
        })
        if (!rendererConfirmationDelivered) await showNativeCloseConfirmation()
        return
      case 'hide':
        lifecycleLog('INFO', 'Main window hidden instead of quitting', { origin })
        mainWindow?.hide()
        void notifyFirstMinimizeToTray()
        return
      case 'quit':
        lifecycleLog('INFO', 'Main window close decision requests application quit', { origin })
        app.quit()
        return
      default: {
        const exhaustive: never = decision
        throw new Error(`Unknown close decision: ${String(exhaustive)}`)
      }
    }
  } catch (error) {
    if (applicationLifecycle.cancellationRequested) return
    console.error('Resolving Electron close behavior failed', error)
    lifecycleLog('ERROR', 'Resolving main window close behavior failed', { origin }, error)
    closeConfirmationPending = true
    showMainWindow()
    await showNativeCloseConfirmation()
  } finally {
    closeHandling = false
  }
}

if (!app.requestSingleInstanceLock()) {
  lifecycleLog('WARN', 'Single-instance lock unavailable; exiting')
  app.quit()
} else {
  app.on('window-all-closed', () => {
    if (!shouldQuitOnAllWindowsClosed({
      quitWhenAllWindowsClose: lifecyclePolicy.quitWhenAllWindowsClose,
      cancellationRequested: applicationLifecycle.cancellationRequested,
      quitAllowed,
      quitInProgress: quitRequestPromise !== null
    })) return
    app.quit()
  })
  if (lifecyclePolicy.reopenMainWindowOnActivate) {
    app.on('activate', () => showMainWindow())
  }
  app.on('second-instance', (_event, commandLine) => {
    const intent = parseLaunchIntent(commandLine, {})
    lifecycleLog('INFO', 'Second instance request received', {
      hasLaunchIntent: intent !== undefined,
      pluginId: intent?.pluginId,
      autostart: intent?.autostart,
      source: intent?.source
    })
    if (!intent) {
      showMainWindow()
      return
    }
    if (intent.autostart !== true && !intent.pluginId) showMainWindow()
    acceptLaunchIntent(intent)
  })
  app.on('before-quit', requestApplicationStop)
  app.on('will-quit', () => macAppUpdater?.dispose())
  app.whenReady().then(() => {
    const startupPromise = applicationLifecycle.start(async (signal) => {
    lifecycleLog('INFO', 'Electron app ready', { durationMs: Date.now() - processStartedAt })
    runtimeLock = await runLifecyclePhase('runtime-lock.acquire', () => RuntimeLock.acquire(runtimePaths))
    if (!applicationLifecycle.canContinueStartup()) { await runtimeLock.release(); runtimeLock = null; return }
    const resources = new WebResourceService({ bundledRoot: webRoot, runtimePaths })
    webResources = resources
    await runLifecyclePhase('web-resources.initialize', () => resources.initialize())
    if (!applicationLifecycle.canContinueStartup()) return
    if (healthCheckRequested) {
      const result = runHealthCheck()
      lifecycleLog(result.healthy ? 'INFO' : 'WARN', 'Health check completed', result)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      healthCheckExitCode = result.healthy ? 0 : 1
      return
    }
    if (!applicationLifecycle.canContinueStartup()) return
    const earlyCliLocale = parseCommandLineLocale(process.argv)
    setLocale(earlyCliLocale ?? 'system', app.getLocale())
    if (process.platform === 'darwin') {
      refreshMacosApplicationMenu()
    } else {
      // 非 macOS 平台清空默认应用菜单，封堵 Alt 调出或子窗口菜单泄漏
      Menu.setApplicationMenu(null)
    }
    const screenClipboardAdapters = createPlatformScreenClipboardAdapters(process.platform, {
      windows: () => createWindowsScreenClipboardAdapters({ screen, desktopCapturer, nativeImage }),
      macos: () => createMacosScreenClipboardAdapters({
        screen,
        desktopCapturer,
        nativeImage,
        systemPreferences
      }, app.isPackaged, process.resourcesPath)
    })
    const processDiscoveryAdapter = createPlatformProcessDiscoveryAdapter(process.platform)
    const pathSemanticsAdapter = createPathSemanticsAdapter(process.platform)
    const dataRoot = runtimePaths.businessDataRoot
    const pluginRoot = path.join(dataRoot, 'Plugins')
    const systemPlatformAdapter = createSystemPlatformAdapter(process.platform, {
      windows: () => createWindowsSystemPlatformAdapter(app.getPath('userData')),
      macos: () => createMacosSystemPlatformAdapter(app.getPath('userData'))
    })
    const nativeRuntime = createPlatformNativeRuntime(process.platform, {
      windows: () => createWindowsNativeRuntime({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        pluginRoot,
        dataRoot
      }),
      macos: () => createMacosNativeRuntime({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        pluginRoot,
        processArchitecture: process.arch,
        runningUnderTranslation: app.runningUnderARM64Translation === true
      })
    })
    const currentWebRoot = activeWebRoot()
    console.info('Electron runtime paths', {
      dataRoot,
      pluginRoot,
      activeWebRoot: currentWebRoot,
      bundledWebRoot: webRoot,
      platform: process.platform,
      activeWebRootExists: fs.existsSync(currentWebRoot),
      bundledWebRootExists: fs.existsSync(webRoot),
      pluginRootExists: fs.existsSync(pluginRoot)
    })
    const webVersion = await readWebVersion(currentWebRoot)
    if (!applicationLifecycle.canContinueStartup()) return
    if (process.platform === 'darwin') {
      macAppUpdater = new MacAppUpdater({
        appPath: path.resolve(process.execPath, '../../..'),
        isPackaged: app.isPackaged,
        stagingRoot: path.join(runtimePaths.transactionRoot, 'MacUpdate'),
        autoUpdater,
        requestQuit: () => app.quit(),
        reportRestartError: (error) => {
          lifecycleLog('ERROR', 'macOS update restart failed', undefined, error)
          dialog.showErrorBox(
            t('dialog.updateRestartFailed.title'),
            t('dialog.updateRestartFailed.message', { detail: error.message })
          )
          app.exit(1)
        }
      })
    }
    const createdServices = await runLifecyclePhase('core-services.create', () => createCoreServices(
      runtimePaths,
      app.getVersion(),
      webVersion,
      nativeRuntime.nativeHost,
      nativeRuntime.serviceClient,
      nativeRuntime.nativeInput ?? null,
      resources,
      undefined,
      macAppUpdater,
      {
        runningUnderARM64Translation: typeof app.runningUnderARM64Translation === 'boolean'
          ? app.runningUnderARM64Translation
          : null,
        credentialProtection: electronCredentialProtection,
        isPackaged: app.isPackaged
      }
    ))
    services = createdServices
    createdServices.focus.setNotificationHandler(showDesktopNotification)
    // 冷启动语言必须在 nativeRuntime.start() 之前确定并写入 ZTOOLS_LOCALE / globalThis.__ztoolsLocale
    const startupLocale = await resolveStartupLocale({
      config: createdServices.config,
      argv: process.argv,
      systemLocale: app.getLocale(),
      onWarn: (message, error) => console.warn(message, error)
    })
    setLocale(startupLocale.setting, app.getLocale())
    const initialShellShortcutsRaw = await createdServices.config
      .get('user_settings.json', 'hotkey.shell', '')
      .catch(() => '')
    refreshMacosApplicationMenu(resolveOpenSettingsShortcut(initialShellShortcutsRaw))
    await runLifecyclePhase('native-runtime.start', () => nativeRuntime.start(signal))
    if (!applicationLifecycle.canContinueStartup()) return

    // 启动原生高性能侧车引擎 (ztools-indexer & ztools-uiaccess) 并后台静默预热
    void createdServices.sidecars.startAll(signal).then(async () => {
      if (signal.aborted || !applicationLifecycle.canContinueStartup()) return
      const status = createdServices.sidecars.getStatus()
      console.info('[SidecarManager] Sidecars started:', JSON.stringify(status))
      if (status.uiaccess.usingFallback) {
        console.info('[SidecarManager] UIAccess 已降级运行于标准模式（无法跨提权窗口操作）', {
          activeBinary: status.uiaccess.activeBinary,
          reason: status.uiaccess.fallbackReason
        })
      }
      if (process.platform === 'win32' || process.platform === 'darwin') {
        const targetScope = process.platform === 'win32' ? '*' : os.homedir()
        const cacheDir = path.join(createdServices.dataRoot, 'cache')
        const cachePath = path.join(cacheDir, 'file-index.zidx')
        try {
          fs.mkdirSync(cacheDir, { recursive: true })
          const cached = await createdServices.sidecars.loadIndexCache(cachePath)
          if (cached.loaded && cached.total_indexed > 0) {
            console.info(`[SidecarManager] Warmed ${cached.total_indexed} cached file entries in ${cached.elapsed_ms.toFixed(2)}ms from disk snapshot`)
          }
        } catch (err) {
          console.warn('[SidecarManager] Disk cache preload skipped:', err)
        }
        if (signal.aborted || !applicationLifecycle.canContinueStartup()) return
        const indexRes = await createdServices.sidecars.indexPath(targetScope, 'auto', cachePath).catch((err) => {
          console.warn('[SidecarManager] Initial index warmup failed:', err)
          return null
        })
        if (signal.aborted || !applicationLifecycle.canContinueStartup()) return
        if (indexRes) {
          const drivesSummary = Array.isArray(indexRes.indexed_drives) && indexRes.indexed_drives.length > 0
            ? ` [${indexRes.indexed_drives.join(', ')}]`
            : ''
          console.info(`[SidecarManager] Indexed ${indexRes.total_indexed} files from ${targetScope === '*' ? 'all local & removable drives' : targetScope}${drivesSummary} in ${indexRes.elapsed_ms}ms (${indexRes.scanner_used})`)
        }
      }
    }).catch((err) => {
      if (signal.aborted) return
      console.warn('[Bootstrap] SidecarManager startAll error:', err)
    })
    let persistedTheme = ''
    let persistedAccent: unknown = 'ember'
    try {
      persistedTheme = await createdServices.config.get('user_settings.json', 'ui.theme', '')
      persistedAccent = await createdServices.config.get('user_settings.json', 'ui.accent', 'ember')
      await createdServices.config.get('user_settings.json', 'ui.wake_preference', 'launcher').catch(() => 'launcher')
    } catch (error) {
      console.warn('读取主题设置失败，将跟随系统:', error)
    }
    currentAccent = normalizeAccentTheme(persistedAccent)
    nativeTheme.themeSource = persistedTheme === 'dark' || persistedTheme === 'light'
      ? persistedTheme
      : 'system'
    applyDarkMode(nativeTheme.shouldUseDarkColors)
    const onNativeThemeUpdated = (): void => {
      const enabled = nativeTheme.shouldUseDarkColors
      applyDarkMode(enabled)
      router?.publishDarkModeChange(enabled)
    }
    nativeTheme.on('updated', onNativeThemeUpdated)
    removeNativeThemeListener = () => nativeTheme.removeListener('updated', onNativeThemeUpdated)
    const pluginState = new PluginStateService(createdServices.dataRoot)
    superPanel = new SuperPanelController({
      dataRoot: createdServices.dataRoot,
      config: createdServices.config,
      pluginState,
      getInstalledPlugins: async () => {
        if (!router) throw new Error('IPC Router is not initialized')
        return router.listInstalledPlugins()
      },
      openPlugin: async (pluginId) => {
        if (!router) throw new Error('IPC Router is not initialized')
        return router.openPlugin({ pluginId })
      },
      systemTools: new SystemToolsService(),
      resolveAuthorizedReadPath: async (rawPath, caller) => {
        if (!router) throw new Error('IPC Router is not initialized')
        if (!caller) throw new Error('Caller identity is unavailable')
        return router.fileService.resolveAuthorizedPath(rawPath, caller, 'read', false)
      },
      revealPath: (fullPath) => {
        electronShell.showItemInFolder(fullPath)
      },
      onChanged: () => {
        router?.publishSuperPanelChanged()
      }
    })
    const initialWakeRaw = await createdServices.config
      .get('user_settings.json', 'hotkey.global', '__UNSET__')
      .catch(() => '__UNSET__')
    const initialWakeHotkey = initialWakeRaw === '__UNSET__'
      ? 'Alt+Space'
      : String(initialWakeRaw ?? '').trim()
    router = await runLifecyclePhase('ipc-router.create', () => IpcRouter.create(registry, createdServices, {
      pluginResources: { webRoot: () => activeWebRoot(), pluginRoot },
      ...(devRuntimeOptions.devAllowDrafts ? { devAllowDrafts: true } : {}),
      ...(devRuntimeOptions.devCommonLibsPublicKeysPath
        ? { devCommonLibsPublicKeysPath: devRuntimeOptions.devCommonLibsPublicKeysPath }
        : {}),
      pluginState, onDarkModeChanged: applyDarkMode, onAccentChanged: applyAccentTheme,
      onLocaleChanged: () => {
        syncTrayState()
        refreshMacosApplicationMenu()
      },
      onTrayStatePossiblyChanged: syncTrayState,
      initialWakeHotkey,
      reloadMainWindow: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is unavailable')
        await mainWindow.loadURL('ztools://web/index.html')
      },
      toggleMainWindow,
      forwardHotkeyToRecorder: (accelerator) => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) {
          return false
        }
        const payload = acceleratorToRecorderKeyPayload(accelerator, process.platform)
        if (!payload) return false
        return dispatchRecorderKeyToWebContents(mainWindow.webContents, payload)
      },
      closeConfirmationResolved: (action) => {
        closeConfirmationPending = false
        if (action === 'minimize') {
          void notifyFirstMinimizeToTray()
        }
      },
      screenClipboardAdapters,
      systemPlatformAdapter,
      processDiscoveryAdapter,
      pathSemanticsAdapter,
      ...(process.platform === 'darwin' && app.isPackaged ? {
        loginItems: createMacosLoginItemAdapter({ platform: process.platform, isPackaged: app.isPackaged, app })
      } : {})
    }))
    if (!applicationLifecycle.canContinueStartup()) return
    const protocolRoots = await router.fileService.prepareMainProtocolRoots()
    if (!applicationLifecycle.canContinueStartup()) return
    const activeRouter = router
    const referenceRuntime = await runLifecyclePhase('reference-runtime.attach', () => createAndAttachElectronReferenceRuntime({
      platform: process.platform,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      dataRoot,
      signal,
      ...(process.platform === 'darwin' ? { regionPreloadPath: path.resolve(__dirname, '../preload/main.js') } : {}),
      router: activeRouter,
      registry,
      screenClipboard: screenClipboardAdapters,
      clipboard: electronClipboard,
      images: nativeImage
    }))
    if (referenceRuntime.available) {
      const platformExpectedDisabled = process.platform !== 'darwin'
        ? referenceRuntime.unavailableOptionalProviders.filter((id) => id === 'local-vision-ocr')
        : []
      console.info('Reference runtime available', {
        helperArch: referenceRuntime.helperArch,
        unavailableOptionalProviders: referenceRuntime.unavailableOptionalProviders,
        ...(platformExpectedDisabled.length > 0 ? { expectedDisabledByPlatform: platformExpectedDisabled } : {})
      })
    } else {
      console.info('Reference runtime unavailable', { reason: referenceRuntime.reason })
    }
    if (!applicationLifecycle.canContinueStartup()) return
    installZToolsProtocol({
      web: () => activeWebRoot(),
      plugins: pluginRoot,
      ...protocolRoots
    }, router.fileService, referenceRuntime.available ? referenceRuntime.resources : undefined)
    configureSessionSecurity(router.fileService, referenceRuntime.available ? referenceRuntime.resources : undefined)
    router.register()
    permissionRefreshListenersInstalled = true
    app.on('browser-window-focus', refreshFocusedPermissions)
    powerMonitor.on('resume', refreshResumedPermissions)
    const installedPlugins = await runLifecyclePhase('plugins.inventory', () => activeRouter.listInstalledPlugins())
    if (!applicationLifecycle.canContinueStartup()) return
    console.info('Installed plugin inventory', JSON.stringify(installedPlugins.data.map((plugin) => ({
      pluginId: plugin.pluginId,
      entry: plugin.entry,
      dllloader: plugin.dllloader,
      enabled: plugin.enabled
    }))))
    console.info('Runtime diagnostics', JSON.stringify({
      ...getRuntimeDiagnostics(),
      nativeHostState: nativeRuntime.nativeHost?.state ?? 'unsupported',
      nativeHostPid: nativeRuntime.nativeHost?.diagnostics.pid ?? null,
      serviceState: nativeRuntime.serviceClient?.diagnostics.state ?? 'unsupported'
    }))
    await runLifecyclePhase('windows-and-tray.initialize', async () => {
      mainApplicationIcon = await loadApplicationIcon()
      initialMainWindowSize = await createdServices.config.getMainWindowSize().catch(() => undefined)
      if (!applicationLifecycle.canContinueStartup()) return
      createMainWindowInstance()
      if (!applicationLifecycle.canContinueStartup()) return
      launcher = new LauncherController({
        icon: mainApplicationIcon,
        registry,
        isAuthorizedCaller: ({ senderId }) => {
          const mainId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : undefined
          const launcherId = launcher?.webContentsId
          return (mainId !== undefined && senderId === mainId) ||
            (launcherId !== undefined && senderId === launcherId)
        },
        showMainWindow,
        navigateMainWindow,
        hideMainWindow: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.hide()
          }
        },
        panelBridge: {
          getData: () => superPanel ? superPanel.getData() : Promise.resolve({ success: false }),
          togglePin: (id, itemType) => superPanel ? superPanel.togglePin(id, itemType) : Promise.resolve({ success: false }),
          setPin: (entry, pinned, caller) => superPanel
            ? superPanel.setPin(entry, pinned, caller)
            : Promise.resolve({ success: false, error: t('superPanel.error.serviceUnavailable') }),
          reorderPins: (order) => superPanel
            ? superPanel.reorderPins(order)
            : Promise.resolve({ success: false, error: t('superPanel.error.serviceUnavailable') }),
          openItem: (id, itemType, query, action) => superPanel
            ? superPanel.openPanelItem(id, itemType, query, action)
            : Promise.resolve({ success: false })
        },
        sidecars: createdServices.sidecars
      })
      launcher.register()
      if (healthCheckExitCode === undefined) {
        launcher.prewarm()
      }
      // Windows 通知区域与 macOS 菜单栏都显示托盘图标，可在设置中关闭
      await applyTrayState(await readTrayState())
    })
    if (!applicationLifecycle.canContinueStartup()) return
    reportApplicationStartupAnalytics()
    launchIntentReady = true
    signalDeploymentReady(initialLaunchIntent)
    if (healthCheckExitCode === undefined) {
      void services.update.cleanupConsumedDownloads({
        needCleanup: Boolean(initialLaunchIntent?.needCleanup || initialLaunchIntent?.updated)
      })
    }
    if (initialLaunchIntent) acceptLaunchIntent(initialLaunchIntent)
    else showMainWindow()
    if (pendingWakeTarget) {
      const wakeTarget = pendingWakeTarget
      pendingWakeTarget = undefined
      if (wakeTarget === 'launcher') openLauncherWindow()
      else showMainWindow()
    }
    drainLaunchIntents()
    lifecycleLog('INFO', 'Application bootstrap completed', {
      durationMs: Date.now() - processStartedAt,
      nativeHostState: nativeRuntime.nativeHost?.state ?? 'unsupported',
      serviceState: nativeRuntime.serviceClient?.diagnostics.state ?? 'unsupported',
      mainWindowCreated: mainWindow !== null
    })
    if (applicationLifecycle.canContinueStartup()) externalOpen.markReady()
    })
    if (!startupPromise) return
    void startupPromise.then(async () => {
      if (healthCheckExitCode !== undefined) {
        await stopApplication()
        app.exit(healthCheckExitCode)
      }
    }).catch(async (error: unknown) => {
      if (applicationLifecycle.cancellationRequested) return
      console.error('Electron bootstrap failed', error)
      signalDeploymentFailure(initialLaunchIntent, error)
      await stopApplication().catch((stopError: unknown) => {
        console.error('Electron cleanup failed', stopError)
      })
      app.exit(1)
    })
  }).catch(async (error: unknown) => {
    console.error('Electron readiness failed', error)
    await stopApplication().catch((stopError: unknown) => {
      console.error('Electron cleanup failed', stopError)
      lifecycleLog('ERROR', 'Electron cleanup after bootstrap failure failed', undefined, stopError)
    })
    app.exit(1)
  })
}
