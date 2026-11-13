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

/** Win32 WM_SYSCHAR 消息：Alt+Space 经 TranslateMessage 生成该消息后触发 DefWindowProc 弹出系统窗口菜单 */
export const WM_SYSCHAR = 0x0106

export interface SystemMenuControllableWindow {
  hookWindowMessage?(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void
  on?(event: 'system-context-menu', listener: (event: { preventDefault(): void }) => void): unknown
  removeMenu?(): void
  setMenuBarVisibility?(visible: boolean): void
}

/**
 * 抑制 Windows 原生窗口系统控制菜单（Alt+Space / 标题栏系统右键菜单 / 默认隐藏菜单栏抢焦），
 * 确保快捷键录入框按下 Alt 或 Alt+Space 时不会触发系统菜单导致隐藏输入框失焦退出录制。
 */
export function suppressWindowsSystemMenu(
  window: SystemMenuControllableWindow,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') return
  if (typeof window.removeMenu === 'function') {
    window.removeMenu()
  }
  if (typeof window.setMenuBarVisibility === 'function') {
    window.setMenuBarVisibility(false)
  }
  if (typeof window.hookWindowMessage === 'function') {
    window.hookWindowMessage(WM_SYSCHAR, () => {
      // 观测 WM_SYSCHAR，配合 removeMenu 与录制态 RegisterHotKey 阻止 SC_KEYMENU
    })
  }
  if (typeof window.on === 'function') {
    window.on('system-context-menu', (event) => {
      event.preventDefault()
    })
  }
}

export type AccentTheme = 'ember' | 'glacier' | 'jade' | 'iris' | 'crimson' | 'mono'

const WINDOW_THEME_PALETTES: Record<AccentTheme, {
  lightCanvas: string
  darkCanvas: string
  lightHead: string
  darkHead: string
  lightSymbol: string
  darkSymbol: string
}> = {
  ember: {
    lightCanvas: '#f4f3f0',
    darkCanvas: '#0b0b0c',
    lightHead: '#f7f6f3',
    darkHead: '#0e0e10',
    lightSymbol: '#55555c',
    darkSymbol: '#a0a0a8'
  },
  glacier: {
    lightCanvas: '#f2f5f8',
    darkCanvas: '#0a0d12',
    lightHead: '#f5f8fb',
    darkHead: '#0d1117',
    lightSymbol: '#475569',
    darkSymbol: '#94a3b8'
  },
  jade: {
    lightCanvas: '#f1f5f3',
    darkCanvas: '#090e0c',
    lightHead: '#f4f8f6',
    darkHead: '#0c1310',
    lightSymbol: '#495a52',
    darkSymbol: '#9ab0a5'
  },
  iris: {
    lightCanvas: '#f4f3f8',
    darkCanvas: '#0b0a10',
    lightHead: '#f6f5fa',
    darkHead: '#0f0d16',
    lightSymbol: '#534d69',
    darkSymbol: '#a59fbd'
  },
  crimson: {
    lightCanvas: '#f5f3f4',
    darkCanvas: '#0c0a0b',
    lightHead: '#f8f6f7',
    darkHead: '#100d0f',
    lightSymbol: '#574f53',
    darkSymbol: '#aba0a5'
  },
  mono: {
    lightCanvas: '#f4f4f5',
    darkCanvas: '#09090b',
    lightHead: '#f7f7f8',
    darkHead: '#0c0c0e',
    lightSymbol: '#52525b',
    darkSymbol: '#a1a1aa'
  }
}

export function isAccentTheme(value: unknown): value is AccentTheme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WINDOW_THEME_PALETTES, value)
}

export function normalizeAccentTheme(value: unknown): AccentTheme {
  return isAccentTheme(value) ? value : 'ember'
}

/** 窗口首帧底色（与 theme.css 的 --rc-canvas 一致，避免打开时闪出旧配色） */
export function getWindowBackgroundColor(isDark: boolean, accent: AccentTheme = 'ember'): string {
  const palette = WINDOW_THEME_PALETTES[normalizeAccentTheme(accent)]
  return isDark ? palette.darkCanvas : palette.lightCanvas
}

/** macOS 红绿灯（12px 高）垂直居中到自定义标题栏 */
export function getTrafficLightPosition(titleBarHeight: number): Electron.Point {
  return { x: 18, y: Math.round((titleBarHeight - 12) / 2) }
}

export function getTitleBarOverlayOptions(
  isDark: boolean,
  height: number = MAIN_TITLE_BAR_HEIGHT,
  accent: AccentTheme = 'ember'
): Electron.TitleBarOverlayOptions {
  const palette = WINDOW_THEME_PALETTES[normalizeAccentTheme(accent)]
  return {
    // 与 theme.css 的 --rc-head 一致，Windows 窗口控制按钮与标题栏融为一体
    color: isDark ? palette.darkHead : palette.lightHead,
    symbolColor: isDark ? palette.darkSymbol : palette.lightSymbol,
    height
  }
}

export function updateMainWindowTheme(
  window: BrowserWindow,
  isDark: boolean,
  accent: AccentTheme = 'ember'
): void {
  if (window.isDestroyed()) return
  const normalized = normalizeAccentTheme(accent)
  if (process.platform === 'win32' && typeof window.setTitleBarOverlay === 'function') {
    try {
      window.setTitleBarOverlay(getTitleBarOverlayOptions(isDark, MAIN_TITLE_BAR_HEIGHT, normalized))
    } catch {
      // 容错处理
    }
  }
  window.setBackgroundColor(getWindowBackgroundColor(isDark, normalized))
}

export interface MainWindowOptions {
  icon: Electron.NativeImage
  webRoot: string
  registry: WindowRegistry
  showOnReady?: boolean
  darkMode?: boolean
  accent?: AccentTheme
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

export interface RecorderKeyPayload {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export function acceleratorToRecorderKeyPayload(
  accelerator: string,
  platform: NodeJS.Platform = process.platform
): RecorderKeyPayload | null {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null
  const tokens = accelerator
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tokens.length === 0) return null

  let ctrlKey = false
  let altKey = false
  let shiftKey = false
  let metaKey = false
  let mainToken = ''

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      if (platform === 'darwin') metaKey = true
      else ctrlKey = true
    } else if (lower === 'control') {
      ctrlKey = true
    } else if (lower === 'alt' || lower === 'option') {
      altKey = true
    } else if (lower === 'shift') {
      shiftKey = true
    } else if (lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'super') {
      metaKey = true
    } else {
      if (mainToken) return null
      mainToken = token
    }
  }

  if (!mainToken) return null
  const lowerMain = mainToken.toLowerCase()
  if (lowerMain === 'space' || mainToken === ' ') {
    return { key: ' ', code: 'Space', ctrlKey, altKey, shiftKey, metaKey }
  }
  if (/^[a-z]$/i.test(mainToken)) {
    const upper = mainToken.toUpperCase()
    return { key: upper, code: `Key${upper}`, ctrlKey, altKey, shiftKey, metaKey }
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(mainToken)) {
    const upper = mainToken.toUpperCase()
    return { key: upper, code: upper, ctrlKey, altKey, shiftKey, metaKey }
  }
  if (mainToken === '`' || mainToken === '~') {
    return { key: mainToken, code: 'Backquote', ctrlKey, altKey, shiftKey, metaKey }
  }
  return null
}

export function dispatchRecorderKeyToWebContents(
  webContents:
    | {
        isDestroyed?: () => boolean
        executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>
      }
    | undefined,
  payload: RecorderKeyPayload
): Promise<boolean> {
  if (
    !webContents ||
    webContents.isDestroyed?.() ||
    typeof webContents.executeJavaScript !== 'function'
  ) {
    return Promise.resolve(false)
  }
  const serialized = JSON.stringify({
    key: payload.key,
    code: payload.code,
    ctrlKey: Boolean(payload.ctrlKey),
    altKey: Boolean(payload.altKey),
    shiftKey: Boolean(payload.shiftKey),
    metaKey: Boolean(payload.metaKey)
  })
  return webContents
    .executeJavaScript(
      `Boolean(typeof window !== 'undefined' && typeof window.__ztoolsDispatchRecorderHotkey === 'function' && window.__ztoolsDispatchRecorderHotkey(${serialized}))`,
      true
    )
    .then((handled) => handled === true)
    .catch(() => false)
}

export function handleMainWindowBeforeInputEvent(
  event: BeforeInputEventLike,
  input: InputDetailsLike,
  options: {
    onToggleLauncher?: (() => void) | undefined
    isDestroyed?: (() => boolean) | undefined
    sendIpc?: ((channel: string) => void) | undefined
    forwardRecorderKey?: ((payload: RecorderKeyPayload) => void) | undefined
  }
): boolean {
  const isSpace =
    input.code === 'Space' ||
    input.key === ' ' ||
    (typeof input.key === 'string' && input.key.toLowerCase() === 'space')
  if ((input.alt || input.control) && isSpace) {
    event.preventDefault()
    if (input.type === 'keyDown' && !options.isDestroyed?.()) {
      options.forwardRecorderKey?.({
        key: ' ',
        code: 'Space',
        ctrlKey: Boolean(input.control),
        altKey: Boolean(input.alt),
        shiftKey: Boolean(input.shift),
        metaKey: Boolean(input.meta)
      })
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
  const accent = normalizeAccentTheme(options.accent)
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
    backgroundColor: getWindowBackgroundColor(isDark, accent),
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: getTrafficLightPosition(MAIN_TITLE_BAR_HEIGHT) } : {}),
    ...(isWin ? {
      titleBarOverlay: getTitleBarOverlayOptions(isDark, MAIN_TITLE_BAR_HEIGHT, accent)
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
  suppressWindowsSystemMenu(window)

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
      sendIpc: (channel) => window.webContents.send(channel),
      forwardRecorderKey: (payload) => {
        void dispatchRecorderKeyToWebContents(window.webContents, payload)
      }
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
