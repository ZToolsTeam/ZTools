import {
  BrowserWindow,
  screen,
  ipcMain,
  nativeTheme
} from 'electron'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { isHostCaller } from '../ipc/plugin-principal.js'
import {
  getWindowBackgroundColor,
  isWindows11OrLater,
  secureWebPreferences,
  suppressWindowsSystemMenu
} from './main-window.js'
import type { WindowRegistry } from './window-registry.js'
import { calculateCenteredBounds, calculateCursorRelativeBounds } from './display-bounds.js'
import { FrameSyncManager } from '../services/frame-sync-manager.js'
import { isShowingNativeDialog } from '../services/window-service.js'
import { prewarmMacosApplicationCache } from '../platform/macos/file-indexer.js'

export const LAUNCHER_CALL_CHANNEL = 'ztools:launcher_call' as const
const LAUNCHER_SIZE = { width: 750, height: 480 }
const UNAUTHORIZED_LAUNCHER_ERROR = '无权调用悬浮条宿主接口'

export interface LauncherShowOptions {
  trigger?: 'keyboard_hotkey' | 'mouse_hotkey'
  position?: 'center' | 'cursor'
}

export interface LauncherPanelBridge {
  getData(): Promise<unknown>
  togglePin(id: string, itemType: string): Promise<{ success: boolean; pinned?: boolean }>
  setPin?(entry: unknown, pinned: unknown, caller?: CallerIdentity): Promise<{
    success: boolean
    pinned?: boolean
    pinKey?: string
    pinnedEntries?: unknown[]
    error?: string
  }>
  reorderPins?(order: unknown): Promise<{
    success: boolean
    stale?: boolean
    error?: string
    pinnedEntries?: unknown[]
  }>
  openItem(
    id: string,
    itemType: string,
    query?: string,
    action?: unknown
  ): Promise<{ success: boolean; error?: string }>
}

export interface LauncherControllerOptions {
  icon: Electron.NativeImage
  registry: WindowRegistry
  isAuthorizedCaller?: (info: { senderId: number; isMainFrame: boolean }) => boolean
  showMainWindow(): void
  hideMainWindow(): void
  /** 记录最近一次主动打开的窗口形态 */
  onShow?(): void
  /** 让主窗口跳到指定页面（hash 路由，如 /details/foo） */
  navigateMainWindow?(route: string): void
  panelBridge?: LauncherPanelBridge
  sidecars?: {
    trimProcessMemory(pid?: number): Promise<{ success: boolean; pid: number; trimmed: boolean }>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface LauncherInvokeEventLike {
  sender?: {
    id?: unknown
    mainFrame?: unknown
    isDestroyed?: () => boolean
  }
  senderFrame?: unknown
}

export interface LauncherInputController {
  hide(): void
}

export function handleLauncherBeforeInputEvent(
  event: { preventDefault: () => void },
  input: { alt?: boolean; code?: string; key?: string; type?: string },
  controller: LauncherInputController
): boolean {
  // 对标 Raycast: 极客条内按下 Alt+Space 彻底阻止原生菜单并收起隐藏 (Toggle Hide)
  if (input.alt && (input.key === ' ' || input.code === 'Space')) {
    event.preventDefault()
    if (input.type === 'keyDown') {
      controller.hide()
    }
    return true
  }
  return false
}

// 悬浮条展开到工作台时可附带目标页面；路由来自渲染进程，按不可信输入校验
const MAX_DASHBOARD_ROUTE_LENGTH = 512
const DASHBOARD_ROUTE_PATTERN = /^\/(?!\/)[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$/

export function normalizeDashboardRoute(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_DASHBOARD_ROUTE_LENGTH) return null
  if (!DASHBOARD_ROUTE_PATTERN.test(value)) return null
  return value
}

export interface LauncherCallTarget {
  hide(): void
  show(): void
  toggle(): void
  showMainWindow(): void
  navigateMainWindow?(route: string): void
}

export function handleLauncherCall(
  target: LauncherCallTarget,
  action: unknown,
  payload?: unknown
): { success: boolean; error?: string } {
  if (action === 'expand_to_dashboard') {
    let route: string | null = null
    if (payload !== undefined && payload !== null) {
      const rawRoute = typeof payload === 'object' ? (payload as { route?: unknown }).route : undefined
      route = normalizeDashboardRoute(rawRoute)
      if (!route) return { success: false, error: '非法的目标页面' }
    }
    target.hide()
    target.showMainWindow()
    if (route) target.navigateMainWindow?.(route)
    return { success: true }
  }
  if (action === 'hide') {
    target.hide()
    return { success: true }
  }
  if (action === 'show') {
    target.show()
    return { success: true }
  }
  if (action === 'toggle') {
    target.toggle()
    return { success: true }
  }
  return { success: false, error: '未知动作' }
}

export class LauncherController {
  #window: BrowserWindow | null = null
  #frameSyncManager: FrameSyncManager | null = null
  #registered = false
  #screenListenerAttached = false

  constructor(private readonly options: LauncherControllerOptions) {}

  get webContentsId(): number | undefined {
    return this.#window && !this.#window.isDestroyed() ? this.#window.webContents.id : undefined
  }

  #authorizeCaller(event: unknown): CallerIdentity | null {
    const invokeEvent = isRecord(event) ? (event as LauncherInvokeEventLike) : undefined
    const sender = invokeEvent?.sender
    if (!sender || typeof sender.id !== 'number') return null
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return null
    const hasFrameInfo = invokeEvent?.senderFrame !== undefined || sender.mainFrame !== undefined
    const isMainFrame = hasFrameInfo
      ? Boolean(invokeEvent?.senderFrame && sender.mainFrame && invokeEvent.senderFrame === sender.mainFrame)
      : true
    if (!isMainFrame) return null

    const caller = this.options.registry.get(sender.id)
    if (!caller || !isHostCaller(caller)) return null
    if (this.options.isAuthorizedCaller && !this.options.isAuthorizedCaller({ senderId: sender.id, isMainFrame })) {
      return null
    }
    return caller
  }

  async #dispatchPanelBridgeAction(
    bridge: LauncherPanelBridge,
    action: unknown,
    payload: unknown,
    caller: CallerIdentity
  ): Promise<{ handled: true; result: unknown } | { handled: false }> {
    const body = isRecord(payload) ? payload : {}
    if (action === 'get_panel_data') {
      return { handled: true, result: await bridge.getData() }
    }
    if (action === 'set_pin') {
      if (!bridge.setPin) {
        return { handled: true, result: { success: false, error: '当前宿主不支持固定操作' } }
      }
      return { handled: true, result: await bridge.setPin(body.entry, body.pinned, caller) }
    }
    if (action === 'reorder_pins') {
      if (!bridge.reorderPins) {
        return { handled: true, result: { success: false, error: '当前宿主不支持排序操作' } }
      }
      return { handled: true, result: await bridge.reorderPins(body.order) }
    }
    if (action === 'toggle_pin') {
      return {
        handled: true,
        result: await bridge.togglePin(
          typeof body.id === 'string' ? body.id : '',
          typeof body.itemType === 'string' ? body.itemType : ''
        )
      }
    }
    if (action === 'open_panel_item') {
      const res = await bridge.openItem(
        typeof body.id === 'string' ? body.id : '',
        typeof body.itemType === 'string' ? body.itemType : '',
        typeof body.query === 'string' ? body.query : undefined,
        body.action
      )
      if (res && res.success !== false) {
        this.hide()
      }
      return { handled: true, result: res }
    }
    return { handled: false }
  }

  register(): void {
    if (this.#registered) return
    ipcMain.handle(LAUNCHER_CALL_CHANNEL, async (event, action: unknown, payload?: unknown) => {
      const caller = this.#authorizeCaller(event)
      if (!caller) {
        return { success: false, error: UNAUTHORIZED_LAUNCHER_ERROR }
      }
      if (isRecord(payload) && ('attributedPlugin' in payload || 'stalePluginSession' in payload)) {
        return { success: false, error: UNAUTHORIZED_LAUNCHER_ERROR }
      }
      const bridge = this.options.panelBridge
      if (bridge) {
        try {
          const dispatched = await this.#dispatchPanelBridgeAction(bridge, action, payload, caller)
          if (dispatched.handled) return dispatched.result
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
      return handleLauncherCall({
        hide: () => this.hide(),
        show: () => this.show(),
        toggle: () => this.toggle(),
        showMainWindow: () => this.options.showMainWindow(),
        navigateMainWindow: (route) => this.options.navigateMainWindow?.(route)
      }, action, payload)
    })
    this.#registered = true
  }

  /**
   * 后台静默预热极客悬浮窗与应用索引（避免用户首次按下快捷键时承受 BrowserWindow 创建与页面冷启动延迟）
   */
  prewarm(): void {
    try {
      prewarmMacosApplicationCache()
      this.#ensureWindow()
    } catch (error) {
      console.error('极客悬浮窗后台预热失败:', error)
    }
  }

  isVisible(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.isVisible())
  }

  isFocused(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.isFocused())
  }

  show(showOptions?: LauncherShowOptions): void {
    this.options.onShow?.()
    const window = this.#ensureWindow()
    this.#positionWindow(window, showOptions?.position)
    if (this.#frameSyncManager) {
      this.options.hideMainWindow()
      void this.#frameSyncManager.showWindow().catch((error: unknown) => {
        console.error('悬浮条显示失败:', error)
      })
    } else {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      this.options.hideMainWindow()
    }
  }

  hide(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      if (this.#frameSyncManager) {
        this.#frameSyncManager.hideWindow()
      } else {
        this.#window.hide()
      }
    }
  }

  toggle(showOptions?: LauncherShowOptions): void {
    // 另一个 Space 上仍映射的窗口不算当前唤醒目标；只有正在交互时才切换为隐藏。
    if (this.isFocused() || this.#frameSyncManager?.state === 'resuming') {
      this.hide()
    } else {
      this.show(showOptions)
    }
  }

  #onDisplayMetricsChanged = (): void => {
    if (this.#window && !this.#window.isDestroyed() && this.#window.isVisible()) {
      this.#positionWindow(this.#window)
    }
  }

  #attachScreenListeners(): void {
    if (this.#screenListenerAttached || typeof screen?.on !== 'function') return
    screen.on('display-metrics-changed', this.#onDisplayMetricsChanged)
    screen.on('display-removed', this.#onDisplayMetricsChanged)
    this.#screenListenerAttached = true
  }

  #detachScreenListeners(): void {
    if (!this.#screenListenerAttached || typeof screen?.removeListener !== 'function') return
    screen.removeListener('display-metrics-changed', this.#onDisplayMetricsChanged)
    screen.removeListener('display-removed', this.#onDisplayMetricsChanged)
    this.#screenListenerAttached = false
  }

  #ensureWindow(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window

    this.#attachScreenListeners()

    // Windows 11 由系统统一裁切圆角和绘制边框，避免矩形描边露出页面的透明圆角。
    const nativeCorners = isWindows11OrLater()
    const window = new BrowserWindow({
      icon: this.options.icon,
      ...LAUNCHER_SIZE,
      frame: false,
      transparent: !nativeCorners,
      roundedCorners: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      // panel 自带跨桌面与全屏辅助窗口行为；自身不能成为全屏主窗口。
      // 不再调用 setVisibleOnAllWorkspaces：它会改变整个应用的激活策略。
      ...(process.platform === 'darwin'
        ? { type: 'panel', fullscreenable: false, hasShadow: false }
        : {}),
      backgroundColor: nativeCorners ? getWindowBackgroundColor(nativeTheme.shouldUseDarkColors) : '#00000000',
      autoHideMenuBar: true,
      webPreferences: {
        ...secureWebPreferences(),
        additionalArguments: ['--ztools-window-mode=launcher']
      }
    })

    this.options.registry.registerMain(window.webContents)
    suppressWindowsSystemMenu(window)
    window.webContents.on('before-input-event', (event, input) => {
      handleLauncherBeforeInputEvent(event, input, this)
    })

    window.on('blur', () => {
      if (!window.isDestroyed() && !isShowingNativeDialog(window)) {
        this.hide()
      }
    })

    window.once('closed', () => {
      if (this.#frameSyncManager) {
        this.#frameSyncManager.dispose()
        this.#frameSyncManager = null
      }
      if (this.#window === window) {
        this.#window = null
      }
      this.#detachScreenListeners()
    })

    this.#frameSyncManager = new FrameSyncManager({
      suspendTimeoutMs: 15000,
      frameSyncTimeoutMs: 150,
      platform: process.platform,
      trimMemory: async () => {
        if (this.options.sidecars?.trimProcessMemory) {
          await this.options.sidecars.trimProcessMemory(process.pid)
        }
      }
    })
    this.#frameSyncManager.attach(window)

    const launcherUrl = `ztools://web/index.html?mode=launcher${nativeCorners ? '&nativeCorners=1' : ''}#/launcher`
    void window.loadURL(launcherUrl).catch((err) => {
      console.error('极客悬浮窗加载失败:', err)
    })

    this.#window = window
    return window
  }

  #positionWindow(window: BrowserWindow, positionMode: 'center' | 'cursor' = 'center'): void {
    const point = typeof screen?.getCursorScreenPoint === 'function'
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 }
    const display = typeof screen?.getDisplayNearestPoint === 'function'
      ? (screen.getDisplayNearestPoint(point) || (typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined))
      : undefined
    const targetBounds = display
      ? (positionMode === 'cursor'
          ? calculateCursorRelativeBounds(LAUNCHER_SIZE, point, display, 'cursor')
          : calculateCenteredBounds(LAUNCHER_SIZE, display, 0.12))
      : { x: 0, y: 0, ...LAUNCHER_SIZE }
    if (typeof window.getBounds === 'function') {
      const cur = window.getBounds()
      if (
        cur.x === targetBounds.x &&
        cur.y === targetBounds.y &&
        cur.width === targetBounds.width &&
        cur.height === targetBounds.height
      ) {
        return
      }
    }
    window.setBounds(targetBounds)
  }

  stop(): void {
    this.#detachScreenListeners()
    if (this.#registered) {
      ipcMain.removeHandler(LAUNCHER_CALL_CHANNEL)
      this.#registered = false
    }
    if (this.#frameSyncManager) {
      this.#frameSyncManager.dispose()
      this.#frameSyncManager = null
    }
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.destroy()
      this.#window = null
    }
  }
}
