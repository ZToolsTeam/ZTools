import {
  app,
  BrowserWindow,
  clipboard as electronClipboard,
  desktopCapturer,
  dialog,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  systemPreferences
} from 'electron'
import type { Event as ElectronEvent } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IpcRouter } from './ipc/router.js'
import { installZToolsProtocol, registerZToolsScheme } from './protocol/ztools-protocol.js'
import { formatRuntimeDiagnostics, getRuntimeDiagnostics } from './services/runtime-diagnostics.js'
import {
  initializeRuntimeLogging,
  writeRuntimeLog,
  type RuntimeLogLevel
} from './services/runtime-logger.js'
import { createCoreServices, readWebVersion, type CoreServices } from './services/core-services.js'
import { WebResourceService } from './services/web-resource-service.js'
import { configureSessionSecurity, createMainWindow, updateMainWindowTheme } from './windows/main-window.js'
import { loadApplicationIcon } from './windows/application-icon.js'
import {
  decideCloseAction,
  readClosePreferences,
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

if (process.platform === 'darwin') configureMacosUserDataPath(app)
import { RuntimeLock } from './runtime/runtime-lock.js'
import { resolveRuntimePaths } from './runtime/runtime-paths.js'
import { CompatibilityCoordinator } from './runtime/compatibility-coordinator.js'
import { PluginStateService } from './services/plugin-state-service.js'
import { SystemToolsService } from './services/system-tools-service.js'
import {
  LaunchIntentDeduplicator,
  parseLaunchIntent,
  type LaunchIntent
} from './runtime/launch-intent.js'

function commandLineValue(prefix: string): string | undefined {
  const argument = process.argv.find((item) => item.startsWith(prefix))
  if (!argument) return undefined
  const value = argument.slice(prefix.length).trim()
  return value.length > 0 ? value : undefined
}

const processStartedAt = Date.now()
const initialLaunchIntent = parseLaunchIntent(process.argv)
const healthCheckRequested = process.argv.some((argument) => argument === '--health-check')
const requestedDataRoot = commandLineValue('--data-root=')
const normalizedRequestedDataRoot = requestedDataRoot ? path.resolve(requestedDataRoot) : undefined
const runtimePaths = resolveRuntimePaths({
  mode: app.isPackaged ? 'production' : 'development',
  appDataRoot: app.getPath('appData'),
  installRoot: app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath(),
  ...(normalizedRequestedDataRoot
    ? {
        businessDataRoot: normalizedRequestedDataRoot,
        productRoot: path.dirname(normalizedRequestedDataRoot)
      }
    : { businessDataRoot: path.join(app.getPath('appData'), 'ZTools', 'Data') })
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
    writeRuntimeLog('INFO', scope, 'Page load finished', { url: sanitizeUrlForLog(contents.getURL()) })
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
let quitAllowed = false
let closeHandling = false
let closeConfirmationPending = false
let runtimeLock: RuntimeLock | null = null
let healthCheckExitCode: number | undefined
let launchIntentReady = false
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

function applyDarkMode(enabled: boolean): void {
  superPanel?.setDarkMode(enabled)
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  updateMainWindowTheme(window, enabled)
  void window.webContents.executeJavaScript(
    `document.documentElement.classList.toggle('dark', ${enabled ? 'true' : 'false'})`
  ).catch(() => undefined)
}

function launchAnalyticsContext(intent: LaunchIntent, registrySource = 'none'): Record<string, unknown> {
  const installerMode = intent.installerMode?.trim().toLowerCase()
  return {
    cmd_source: intent.source ?? '',
    reg_source: intent.registrySource ?? registrySource,
    install_session_id: intent.installSessionId ?? '',
    installer_mode: installerMode === 'silent' || installerMode === 'interactive'
      ? installerMode
      : 'unknown',
    launch_request_id: intent.launchRequestId ?? '',
    launch_id: intent.launchId ?? '',
    launch_type: intent.launchType ?? 'unknown',
    attempt_no: intent.launchAttemptNo ?? '',
    launch_method: intent.launchMethod ?? ''
  }
}

function reportLaunchAnalytics(intent: LaunchIntent): void {
  if (!services) return
  const currentServices = services
  if (!intent.launchId && !intent.source) return
  const report = (registrySource: string): void => {
    const context = launchAnalyticsContext(intent, registrySource)
    if (intent.launchId) {
      currentServices.analytics.reportHost('setup_start_success', '', currentServices.webVersion, context)
    }
    if (intent.source) {
      currentServices.analytics.reportHost('app_online', '', currentServices.webVersion, context)
    }
  }
  if (intent.registrySource) {
    report(intent.registrySource)
    return
  }
  void currentServices.analytics.getRegistrySource().then(report).catch(() => report('none'))
}

function reportApplicationStartupAnalytics(): void {
  if (!services || startupAnalyticsReported) return
  startupAnalyticsReported = true
  services.analytics.reportHost('app_launch', '', services.webVersion)
  const release = os.release()
  const [major = 0, minor = 0, build = 0] = release
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
  services.analytics.reportHost('device_environment', '', services.webVersion, {
    platform: process.platform,
    os_name: os.version(),
    os_version: release,
    os_major: major,
    os_minor: minor,
    os_build: build,
    os_arch: os.arch(),
    process_arch: process.arch,
    windows_family: process.platform === 'win32' ? 'Windows NT' : '',
    windows_release: release
  })
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
}
let permissionRefreshListenersInstalled = false

function stopApplication(): Promise<void> {
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
    app.quit()
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
  void (async () => {
    let pref = 'dashboard'
    try {
      pref = (await services?.config.get('user_settings.json', 'ui.wake_preference', 'dashboard')) ?? 'dashboard'
    } catch {
      pref = 'dashboard'
    }

    if (pref === 'launcher' && launcher) {
      if (launcher.isVisible()) {
        launcher.hide()
      } else {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          mainWindow.hide()
        }
        launcher.show()
      }
      return
    }

    if (launcher && launcher.isVisible()) {
      launcher.hide()
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
    if (mainWindow.isVisible()) {
      mainWindow.hide()
      return
    }
    mainWindow.show()
    mainWindow.focus()
  })()
}

function showMainWindow(): void {
  if (applicationLifecycle.cancellationRequested) return
  if (launcher && launcher.isVisible()) {
    launcher.hide()
  }
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

function createMainWindowInstance(): BrowserWindow {
  if (applicationLifecycle.cancellationRequested) {
    throw new Error('Application startup has been cancelled')
  }
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  if (!mainApplicationIcon) throw new Error('Application icon is not ready')
  const window = createMainWindow({
    icon: mainApplicationIcon, webRoot: activeWebRoot(), registry,
    showOnReady: initialLaunchIntent?.autostart !== true, darkMode: nativeTheme.shouldUseDarkColors,
    ...(initialMainWindowSize ? { initialSize: initialMainWindowSize } : {}),
    persistNormalBounds: bounds => { void services?.config.setMainWindowSize(bounds.width, bounds.height).catch(error => console.warn('保存主窗口尺寸失败', error)) },
    onToggleLauncher: () => {
      if (launcher) {
        launcher.show()
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ztools:toggle_launcher_mode')
      }
    }
  })
  mainWindow = window
  updateMainWindowTheme(window, nativeTheme.shouldUseDarkColors)
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      updateMainWindowTheme(window, nativeTheme.shouldUseDarkColors)
    }
  })
  window.on('close', (event) => {
    if (quitAllowed) return
    event.preventDefault()
    void requestMainWindowClose('closeButton')
  })
  window.once('closed', () => {
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
  reportLaunchAnalytics(intent)
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
      title: '退出 ZTools',
      message: lifecyclePolicy.useSystemTray ? '要退出应用还是最小化到系统托盘？' : '要退出应用还是隐藏到 Dock？',
      buttons: lifecyclePolicy.useSystemTray
        ? ['立即退出', '最小化到托盘', '取消']
        : ['立即退出', '隐藏到 Dock', '取消'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
      checkboxLabel: '下次不再询问',
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
  else if (!window.isDestroyed()) window.hide()
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
    if (lifecyclePolicy.quitWhenAllWindowsClose) app.quit()
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
  app.whenReady().then(() => {
    const startupPromise = applicationLifecycle.start(async (signal) => {
    lifecycleLog('INFO', 'Electron app ready', { durationMs: Date.now() - processStartedAt })
    runtimeLock = await runLifecyclePhase('runtime-lock.acquire', () => RuntimeLock.acquire(runtimePaths))
    if (!applicationLifecycle.canContinueStartup()) { await runtimeLock.release(); runtimeLock = null; return }
    await runLifecyclePhase('compatibility.prepare', () => new CompatibilityCoordinator(runtimePaths, {
      targetClientVersion: app.getVersion()
    }).prepare())
    if (!applicationLifecycle.canContinueStartup()) return
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
    if (process.platform === 'darwin') {
      installMacosApplicationMenu({ onOpenPreferences: () => showMainWindow() })
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
    console.info('Electron runtime paths', {
      dataRoot,
      pluginRoot,
      webRoot,
      platform: process.platform,
      webRootExists: fs.existsSync(webRoot),
      pluginRootExists: fs.existsSync(pluginRoot)
    })
    const webVersion = await readWebVersion(activeWebRoot())
    if (!applicationLifecycle.canContinueStartup()) return
    services = createCoreServices(
      runtimePaths,
      app.getVersion(),
      webVersion,
      nativeRuntime.nativeHost,
      nativeRuntime.serviceClient,
      nativeRuntime.nativeInput ?? null,
      resources
    )
    await nativeRuntime.start(signal)
    if (!applicationLifecycle.canContinueStartup()) return

    // 启动原生高性能侧车引擎 (ztools-indexer & ztools-uiaccess) 并后台静默预热
    const activeServices = services
    if (activeServices) {
      void activeServices.sidecars.startAll().then(async () => {
        if (process.platform === 'win32') {
          const home = os.homedir()
          await activeServices.sidecars.indexPath(home, 'auto').catch(() => {})
        }
      }).catch((err) => {
        console.warn('[Bootstrap] SidecarManager startAll error:', err)
      })
    }
    let persistedTheme = ''
    try {
      persistedTheme = await services.config.get('user_settings.json', 'ui.theme', '')
    } catch (error) {
      console.warn('读取主题设置失败，将跟随系统:', error)
    }
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
    const pluginState = new PluginStateService(services.dataRoot)
    superPanel = new SuperPanelController({
      dataRoot: services.dataRoot,
      config: services.config,
      pluginState,
      getInstalledPlugins: async () => {
        if (!router) throw new Error('IPC Router 尚未初始化')
        return router.listInstalledPlugins()
      },
      openPlugin: async (pluginId) => {
        if (!router) throw new Error('IPC Router 尚未初始化')
        return router.openPlugin({ pluginId })
      },
      systemTools: new SystemToolsService(),
      getMainWindow: () => mainWindow
    })
    router = await IpcRouter.create(registry, services, {
      pluginResources: { webRoot: () => activeWebRoot(), pluginRoot },
      pluginState, onDarkModeChanged: applyDarkMode,
      reloadMainWindow: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不可用')
        await mainWindow.loadURL('ztools://web/index.html')
      },
      toggleMainWindow,
      toggleSuperPanel: (trigger) => superPanel?.toggle(trigger),
      getPanelLocalApps: () => superPanel?.getPanelLocalApps() ?? Promise.resolve([]),
      ...(process.platform === 'win32' ? {
        launchLocalApp: (appId: string) => {
          if (applicationLifecycle.cancellationRequested || !superPanel) {
            return Promise.reject(new Error('应用正在退出'))
          }
          return superPanel.launchLocalApp(appId)
        }
      } : {}),
      closeConfirmationResolved: () => { closeConfirmationPending = false },
      screenClipboardAdapters,
      systemPlatformAdapter,
      processDiscoveryAdapter,
      pathSemanticsAdapter,
      ...(process.platform === 'darwin' && app.isPackaged ? {
        loginItems: createMacosLoginItemAdapter({ platform: process.platform, isPackaged: app.isPackaged, app })
      } : {})
    })
    if (!applicationLifecycle.canContinueStartup()) return
    const protocolRoots = await router.fileService.prepareMainProtocolRoots()
    if (!applicationLifecycle.canContinueStartup()) return
    const referenceRuntime = await createAndAttachElectronReferenceRuntime({
      platform: process.platform,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      dataRoot,
      signal,
      ...(process.platform === 'darwin' ? { regionPreloadPath: path.resolve(__dirname, '../preload/main.js') } : {}),
      router,
      registry,
      screenClipboard: screenClipboardAdapters,
      clipboard: electronClipboard,
      images: nativeImage
    })
    if (referenceRuntime.available) {
      console.info('Reference runtime available', {
        helperArch: referenceRuntime.helperArch,
        unavailableOptionalProviders: referenceRuntime.unavailableOptionalProviders
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
    superPanel.register()
    const installedPlugins = await router.listInstalledPlugins()
    if (!applicationLifecycle.canContinueStartup()) return
    console.info('Installed plugin inventory', installedPlugins.data.map((plugin) => ({
      pluginId: plugin.pluginId,
      entry: plugin.entry,
      dllloader: plugin.dllloader,
      enabled: plugin.enabled
    })))
    console.info(`${formatRuntimeDiagnostics(getRuntimeDiagnostics())}\nnativeHostState=${nativeRuntime.nativeHost?.state ?? 'unsupported'}\nnativeHostPid=${String(nativeRuntime.nativeHost?.diagnostics.pid ?? '')}\nserviceState=${nativeRuntime.serviceClient?.diagnostics.state ?? 'unsupported'}`)
    mainApplicationIcon = await loadApplicationIcon()
    initialMainWindowSize = await services.config.getMainWindowSize().catch(() => undefined)
    if (!applicationLifecycle.canContinueStartup()) return
    createMainWindowInstance()
    if (!applicationLifecycle.canContinueStartup()) return
    launcher = new LauncherController({
      icon: mainApplicationIcon,
      registry,
      showMainWindow,
      hideMainWindow: () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          mainWindow.hide()
        }
      },
      sidecars: services.sidecars
    })
    launcher.register()
    if (lifecyclePolicy.useSystemTray) {
      tray = new TrayController({
        icon: mainApplicationIcon,
        showMainWindow,
        requestExit: () => { void requestMainWindowClose('trayMenu') }
      })
      await tray.start()
    }
    if (!applicationLifecycle.canContinueStartup()) return
    await router.ready().catch((error: unknown) => {
      console.error('超级面板输入初始化失败', error)
      lifecycleLog('ERROR', 'Super panel input initialization failed', undefined, error)
    })
    reportApplicationStartupAnalytics()
    launchIntentReady = true
    signalDeploymentReady(initialLaunchIntent)
    if (initialLaunchIntent) acceptLaunchIntent(initialLaunchIntent)
    else showMainWindow()
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
  }).catch((error: unknown) => {
    console.error('Electron readiness failed', error)
    void stopApplication().catch((stopError: unknown) => {
      console.error('Electron cleanup failed', stopError)
      lifecycleLog('ERROR', 'Electron cleanup after bootstrap failure failed', undefined, stopError)
    })
    app.exit(1)
  })
}
