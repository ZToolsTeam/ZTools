import { BrowserWindow, session, screen, type Session } from 'electron'
import path from 'node:path'
import os from 'node:os'
import type { WindowRegistry } from './window-registry.js'
import type { FileSystemService } from '../services/file-system-service.js'
import { selectFileResourceRoute } from '../protocol/file-resource-dispatch.js'
import type { ReferenceFileResources } from '../protocol/reference-file-resources.js'
import { ensureBoundsVisible } from './display-bounds.js'

export function isWindows11OrLater(): boolean {
  if (process.platform !== 'win32') return false
  const parts = os.release().split('.')
  const buildStr = parts[2] || '0'
  return (parseInt(buildStr, 10) || 0) >= 22000
}

/** 标题栏高度：主窗口 52px（与 Header.vue 一致），独立插件窗口 42px（与 DeclarativePage.vue 一致） */
export const MAIN_TITLE_BAR_HEIGHT = 52
export const POPOUT_TITLE_BAR_HEIGHT = 42

/** 积木 Z × 余烬橙：窗口首帧底色（与 theme.css 的 --rc-canvas 一致，避免打开时闪出旧配色） */
export function getWindowBackgroundColor(isDark: boolean): string {
  return isDark ? '#0b0b0c' : '#f4f3f0'
}

/** macOS 红绿灯（12px 高）垂直居中到自定义标题栏 */
export function getTrafficLightPosition(titleBarHeight: number): Electron.Point {
  return { x: 18, y: Math.round((titleBarHeight - 12) / 2) }
}

export function getTitleBarOverlayOptions(
  isDark: boolean,
  height: number = MAIN_TITLE_BAR_HEIGHT
): Electron.TitleBarOverlayOptions {
  return {
    // 与 theme.css 的 --rc-head 一致，Windows 窗口控制按钮与标题栏融为一体
    color: isDark ? '#0e0e10' : '#f7f6f3',
    symbolColor: isDark ? '#a0a0a8' : '#55555c',
    height
  }
}

export function updateMainWindowTheme(window: BrowserWindow, isDark: boolean): void {
  if (window.isDestroyed()) return
  if (process.platform === 'win32' && typeof window.setTitleBarOverlay === 'function') {
    try {
      window.setTitleBarOverlay(getTitleBarOverlayOptions(isDark))
    } catch {
      // 容错处理
    }
  }
  window.setBackgroundColor(getWindowBackgroundColor(isDark))
}

export interface MainWindowOptions {
  icon: Electron.NativeImage
  webRoot: string
  registry: WindowRegistry
  showOnReady?: boolean
  darkMode?: boolean
  initialSize?: { width: number; height: number }
  persistNormalBounds?: (bounds: Electron.Rectangle) => void
  onToggleLauncher?: (() => void) | undefined
}

export function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: path.resolve(__dirname, '../../preload/main.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false
  }
}

export function configureSessionSecurity(files: FileSystemService, referencesOrSession?: ReferenceFileResources | Session, explicitSession?: Session): void {
  const references = referencesOrSession && !('setPermissionRequestHandler' in referencesOrSession) ? referencesOrSession : undefined
  const targetSession = referencesOrSession && 'setPermissionRequestHandler' in referencesOrSession ? referencesOrSession : explicitSession ?? session.defaultSession
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  targetSession.on('will-download', (event) => event.preventDefault())
  targetSession.webRequest.onBeforeRequest(
    { urls: ['ztools://file/*'] },
    (details, callback) => {
      const webContentsId = details.webContentsId
      if (!references) {
        callback({ cancel: webContentsId === undefined || !files.canLoadFileCapability(details.url, webContentsId) })
        return
      }
      const route = selectFileResourceRoute(details.url, { claimsUrl: url => files.claimsFileCapabilityUrl(url) }, references)
      const allowed = route === 'reference' ? references.allowsNativeRequest(details, targetSession) :
        route === 'legacy' && references.allowsLegacyRequest(details, targetSession, files)
      callback({ cancel: !allowed })
    }
  )
}

export interface BeforeInputEventLike {
  preventDefault(): void
}

export interface InputDetailsLike {
  type?: string
  key?: string
  code?: string
  alt?: boolean
  control?: boolean
  shift?: boolean
  meta?: boolean
}

export function handleMainWindowBeforeInputEvent(
  event: BeforeInputEventLike,
  input: InputDetailsLike,
  options: {
    onToggleLauncher?: (() => void) | undefined
    isDestroyed?: (() => boolean) | undefined
    sendIpc?: ((channel: string) => void) | undefined
  }
): boolean {
  // 对标 Raycast: 拦截 Windows 系统菜单快捷键 Alt+Space (SC_KEYMENU)，彻底切断原生系统菜单并切换极客条
  if (input.alt && (input.key === ' ' || input.code === 'Space')) {
    event.preventDefault()
    if (input.type === 'keyDown') {
      if (typeof options.onToggleLauncher === 'function') {
        options.onToggleLauncher()
      } else if (!options.isDestroyed?.()) {
        options.sendIpc?.('ztools:toggle_launcher_mode')
      }
    }
    return true
  }
  return false
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const primaryDisplay = typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined
  const workArea = primaryDisplay?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }
  const maxWidth = Math.max(320, workArea.width)
  const maxHeight = Math.max(240, workArea.height)

  const minWidth = Math.min(900, maxWidth)
  const minHeight = Math.min(600, maxHeight)
  const width = Math.min(maxWidth, Math.max(minWidth, Math.min(8192, options.initialSize?.width ?? 1040)))
  const height = Math.min(maxHeight, Math.max(minHeight, Math.min(8192, options.initialSize?.height ?? 680)))
  const isDark = options.darkMode === true
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const hasMica = isWindows11OrLater()

  const window = new BrowserWindow({
    icon: options.icon,
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    backgroundColor: getWindowBackgroundColor(isDark),
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: getTrafficLightPosition(MAIN_TITLE_BAR_HEIGHT) } : {}),
    ...(isWin ? {
      titleBarOverlay: getTitleBarOverlayOptions(isDark)
    } : {}),
    ...(hasMica ? {
      backgroundMaterial: 'mica'
    } : {}),
    ...(isMac ? {
      vibrancy: 'sidebar'
    } : {}),
    webPreferences: secureWebPreferences()
  })
  options.registry.registerMain(window.webContents)

  const onDisplayMetricsChanged = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
    if (typeof screen?.getAllDisplays !== 'function' || typeof screen?.getPrimaryDisplay !== 'function') return
    const currentBounds = window.getNormalBounds ? window.getNormalBounds() : window.getBounds()
    const allDisplays = screen.getAllDisplays()
    const fallback = screen.getPrimaryDisplay()
    const safeBounds = ensureBoundsVisible(currentBounds, allDisplays, fallback, 10000)
    if (
      safeBounds.x !== currentBounds.x ||
      safeBounds.y !== currentBounds.y ||
      safeBounds.width !== currentBounds.width ||
      safeBounds.height !== currentBounds.height
    ) {
      window.setBounds(safeBounds)
    }
  }

  if (typeof screen?.on === 'function') {
    screen.on('display-metrics-changed', onDisplayMetricsChanged)
    screen.on('display-removed', onDisplayMetricsChanged)
    window.once('closed', () => {
      if (typeof screen?.removeListener === 'function') {
        screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
        screen.removeListener('display-removed', onDisplayMetricsChanged)
      }
    })
  }
  let persistTimer: NodeJS.Timeout | undefined
  const persistBounds = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      if (!window.isDestroyed() && !window.isMinimized() && !window.isMaximized() && !window.isFullScreen()) {
        options.persistNormalBounds?.(window.getNormalBounds())
      }
    }, 250)
  }
  window.on('resize', persistBounds)
  window.on('move', persistBounds)
  window.on('unmaximize', persistBounds)
  window.on('close', () => {
    if (persistTimer) clearTimeout(persistTimer)
    if (!window.isMinimized() && !window.isMaximized() && !window.isFullScreen()) {
      options.persistNormalBounds?.(window.getNormalBounds())
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('ztools://web/')) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('before-input-event', (event, input) => {
    handleMainWindowBeforeInputEvent(event, input, {
      ...(options.onToggleLauncher ? { onToggleLauncher: options.onToggleLauncher } : {}),
      isDestroyed: () => window.isDestroyed(),
      sendIpc: (channel) => window.webContents.send(channel)
    })
  })
  if (options.showOnReady !== false) {
    window.once('ready-to-show', () => {
      console.log('MAIN_WINDOW_READY_TO_SHOW triggered')
      window.show()
    })
    window.webContents.once('did-finish-load', () => {
      console.log('MAIN_WINDOW_DID_FINISH_LOAD triggered')
      window.show()
    })
  }
  void window.loadURL('ztools://web/index.html').catch((error: unknown) => {
    console.error('Main renderer load failed', error)
    if (!window.isDestroyed()) window.destroy()
  })
  return window
}
