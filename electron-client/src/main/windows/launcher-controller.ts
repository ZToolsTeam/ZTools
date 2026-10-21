import {
  BrowserWindow,
  screen,
  ipcMain
} from 'electron'
import { secureWebPreferences } from './main-window.js'
import type { WindowRegistry } from './window-registry.js'
import { calculateCenteredBounds } from './display-bounds.js'
import { FrameSyncManager } from '../services/frame-sync-manager.js'

export const LAUNCHER_CALL_CHANNEL = 'ztools:launcher_call' as const

export interface LauncherControllerOptions {
  icon: Electron.NativeImage
  registry: WindowRegistry
  showMainWindow(): void
  hideMainWindow(): void
  /** 让主窗口跳到指定页面（hash 路由，如 /details/foo） */
  navigateMainWindow?(route: string): void
  sidecars?: {
    trimProcessMemory(pid?: number): Promise<{ success: boolean; pid: number; trimmed: boolean }>
  }
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

  register(): void {
    if (this.#registered) return
    ipcMain.handle(LAUNCHER_CALL_CHANNEL, async (_event, action: unknown, payload?: unknown) => handleLauncherCall({
      hide: () => this.hide(),
      show: () => this.show(),
      toggle: () => this.toggle(),
      showMainWindow: () => this.options.showMainWindow(),
      navigateMainWindow: (route) => this.options.navigateMainWindow?.(route)
    }, action, payload))
    this.#registered = true
  }

  isVisible(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.isVisible())
  }

  show(): void {
    this.options.hideMainWindow()
    const window = this.#ensureWindow()
    this.#positionWindow(window)
    if (this.#frameSyncManager) {
      void this.#frameSyncManager.showWindow().catch(() => {
        if (!window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      })
    } else {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  }

  hide(): void {
    if (this.#window && !this.#window.isDestroyed() && this.#window.isVisible()) {
      if (this.#frameSyncManager) {
        this.#frameSyncManager.hideWindow()
      } else {
        this.#window.hide()
      }
    }
  }

  toggle(): void {
    if (this.isVisible()) {
      this.hide()
    } else {
      this.show()
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

    const window = new BrowserWindow({
      icon: this.options.icon,
      width: 680,
      height: 480,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      backgroundColor: '#00000000',
      autoHideMenuBar: true,
      webPreferences: {
        ...secureWebPreferences(),
        additionalArguments: ['--ztools-window-mode=launcher']
      }
    })

    this.options.registry.registerMain(window.webContents)

    window.webContents.on('before-input-event', (event, input) => {
      handleLauncherBeforeInputEvent(event, input, this)
    })

    window.on('blur', () => {
      if (!window.isDestroyed() && window.isVisible()) {
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
      trimMemory: async () => {
        if (this.options.sidecars?.trimProcessMemory) {
          await this.options.sidecars.trimProcessMemory(process.pid)
        }
      }
    })
    this.#frameSyncManager.attach(window)

    void window.loadURL('ztools://web/index.html?mode=launcher#/launcher').catch((err) => {
      console.error('极客悬浮窗加载失败:', err)
    })

    this.#window = window
    return window
  }

  #positionWindow(window: BrowserWindow): void {
    const point = typeof screen?.getCursorScreenPoint === 'function'
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 }
    const display = typeof screen?.getDisplayNearestPoint === 'function'
      ? (screen.getDisplayNearestPoint(point) || (typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined))
      : undefined
    if (display) {
      // 居中偏上（Raycast / uTools 黄金高度，距离顶部 18%），自动考虑多屏负坐标与工作区边界 clamp
      const bounds = calculateCenteredBounds({ width: 680, height: 480 }, display, 0.18)
      window.setBounds(bounds)
    } else {
      window.setBounds({ x: 0, y: 0, width: 680, height: 480 })
    }
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
