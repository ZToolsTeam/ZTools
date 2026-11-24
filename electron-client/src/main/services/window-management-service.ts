import type { SidecarManager } from './sidecar-manager.js'
import type { HudService } from './hud-service.js'
import { t, type SupportedLocale } from '../i18n/index.js'

export type WindowActionName =
  | 'left-half'
  | 'right-half'
  | 'top-half'
  | 'bottom-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'first-third'
  | 'center-third'
  | 'last-third'
  | 'first-two-thirds'
  | 'last-two-thirds'
  | 'maximize'
  | 'center'
  | 'restore'
  | 'reasonable-size'
  | 'make-larger'
  | 'make-smaller'
  | 'next-display'
  | 'previous-display'

export interface WindowActionMeta {
  name: WindowActionName
  title: string
  description: string
  category: 'halves' | 'corners' | 'thirds' | 'sizes' | 'display'
  icon: string
  shortcut?: string
}

interface WindowActionSpec {
  readonly name: WindowActionName
  readonly category: 'halves' | 'corners' | 'thirds' | 'sizes' | 'display'
  readonly icon: string
  readonly shortcut?: string
}

const WINDOW_ACTION_SPECS: Record<WindowActionName, WindowActionSpec> = {
  'left-half': { name: 'left-half', category: 'halves', icon: 'window-left', shortcut: 'Ctrl+Alt+Left' },
  'right-half': { name: 'right-half', category: 'halves', icon: 'window-right', shortcut: 'Ctrl+Alt+Right' },
  'top-half': { name: 'top-half', category: 'halves', icon: 'window-top', shortcut: 'Ctrl+Alt+Up' },
  'bottom-half': { name: 'bottom-half', category: 'halves', icon: 'window-bottom', shortcut: 'Ctrl+Alt+Down' },
  'top-left': { name: 'top-left', category: 'corners', icon: 'window-top-left', shortcut: 'Ctrl+Alt+U' },
  'top-right': { name: 'top-right', category: 'corners', icon: 'window-top-right', shortcut: 'Ctrl+Alt+I' },
  'bottom-left': { name: 'bottom-left', category: 'corners', icon: 'window-bottom-left', shortcut: 'Ctrl+Alt+J' },
  'bottom-right': { name: 'bottom-right', category: 'corners', icon: 'window-bottom-right', shortcut: 'Ctrl+Alt+K' },
  'first-third': { name: 'first-third', category: 'thirds', icon: 'window-third-left', shortcut: 'Ctrl+Alt+D' },
  'center-third': { name: 'center-third', category: 'thirds', icon: 'window-third-center', shortcut: 'Ctrl+Alt+F' },
  'last-third': { name: 'last-third', category: 'thirds', icon: 'window-third-right', shortcut: 'Ctrl+Alt+G' },
  'first-two-thirds': { name: 'first-two-thirds', category: 'thirds', icon: 'window-two-thirds-left', shortcut: 'Ctrl+Alt+E' },
  'last-two-thirds': { name: 'last-two-thirds', category: 'thirds', icon: 'window-two-thirds-right', shortcut: 'Ctrl+Alt+T' },
  'maximize': { name: 'maximize', category: 'sizes', icon: 'window-maximize', shortcut: 'Ctrl+Alt+Return' },
  'center': { name: 'center', category: 'sizes', icon: 'window-center', shortcut: 'Ctrl+Alt+C' },
  'restore': { name: 'restore', category: 'sizes', icon: 'window-restore' },
  'reasonable-size': { name: 'reasonable-size', category: 'sizes', icon: 'window-aspect' },
  'make-larger': { name: 'make-larger', category: 'sizes', icon: 'window-plus' },
  'make-smaller': { name: 'make-smaller', category: 'sizes', icon: 'window-minus' },
  'next-display': { name: 'next-display', category: 'display', icon: 'monitor' },
  'previous-display': { name: 'previous-display', category: 'display', icon: 'monitor' }
}

/** 按当前或指定 locale 实时构造窗口动作元数据快照 */
export function getWindowActionMeta(action: WindowActionName, locale?: SupportedLocale): WindowActionMeta {
  const spec = WINDOW_ACTION_SPECS[action]
  return {
    name: spec.name,
    title: t(`windowActions.${spec.name}.title`, undefined, locale),
    description: t(`windowActions.${spec.name}.description`, undefined, locale),
    category: spec.category,
    icon: spec.icon,
    ...(spec.shortcut ? { shortcut: spec.shortcut } : {})
  }
}

function createDynamicActionMeta(spec: WindowActionSpec): WindowActionMeta {
  const meta: WindowActionMeta = {
    name: spec.name,
    title: '',
    description: '',
    category: spec.category,
    icon: spec.icon,
    ...(spec.shortcut ? { shortcut: spec.shortcut } : {})
  }
  Object.defineProperties(meta, {
    title: {
      enumerable: true,
      get: () => t(`windowActions.${spec.name}.title`)
    },
    description: {
      enumerable: true,
      get: () => t(`windowActions.${spec.name}.description`)
    }
  })
  return meta
}

export const WINDOW_ACTIONS: Record<WindowActionName, WindowActionMeta> = Object.fromEntries(
  (Object.keys(WINDOW_ACTION_SPECS) as WindowActionName[]).map((name) => [
    name,
    createDynamicActionMeta(WINDOW_ACTION_SPECS[name])
  ])
) as Record<WindowActionName, WindowActionMeta>

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowActionResult {
  success: boolean
  action: WindowActionName
  preset?: WindowActionName | undefined
  title: string
  targetWindowId?: string | undefined
  rect?: WindowBounds | undefined
  bounds?: WindowBounds | undefined
  previousRect?: WindowBounds | undefined
  error?: string | undefined
  message?: string | undefined
}

export interface WindowManagementServiceOptions {
  sidecarManager?: SidecarManager | undefined
  hudService?: HudService | undefined
  workArea?: WindowBounds | undefined
}

export interface ApplyWindowActionContext {
  windowId?: string | undefined
  currentBounds?: WindowBounds | undefined
  workArea?: WindowBounds | undefined
  isZToolsWindow?: boolean | undefined
  targetProcessId?: number | undefined
}

/**
 * 窗口坐标变化检测
 */
export function hasWindowBoundsChanged(a: WindowBounds, b: WindowBounds): boolean {
  return (
    Math.round(a.x) !== Math.round(b.x) ||
    Math.round(a.y) !== Math.round(b.y) ||
    Math.round(a.width) !== Math.round(b.width) ||
    Math.round(a.height) !== Math.round(b.height)
  )
}

/**
 * 判断窗口句柄是否属于 ZTools 自身窗口（大主界面 MainWindow 或极客框 LauncherWindow）
 */
export function isZToolsInternalWindowId(windowId?: string | null): boolean {
  if (!windowId) return false
  const lower = String(windowId).trim().toLowerCase()
  return (
    lower === 'ztools' ||
    lower.startsWith('ztools-') ||
    lower.includes('ztools-main') ||
    lower.includes('ztools-launcher')
  )
}

/**
 * 窗口极速调度服务 (Window Management Service)
 * 窗口状态保存与恢复（saveWindowState / getSavedWindowState）
 * 并适配 ZTools “小白大主界面 + 极客悬浮框”双界面下的外部目标窗口追踪 (lastExternalForegroundHwnd)
 */
export class WindowManagementService {
  private lastExternalForegroundHwnd: string | null = null
  private readonly currentWindowBounds = new Map<string, WindowBounds>()
  private readonly savedWindowStates = new Map<string, WindowBounds>()
  private readonly defaultWorkArea: WindowBounds

  constructor(private readonly options: WindowManagementServiceOptions = {}) {
    this.defaultWorkArea = options.workArea ?? { x: 0, y: 0, width: 1920, height: 1040 }
  }

  /**
   * 记录前台活动窗口（自动过滤 ZTools 自身的主界面与悬浮框，避免小白在主界面点击分屏时误操作 ZTools 自身）
   */
  public recordForegroundWindow(
    windowId: string,
    bounds?: WindowBounds,
    isZToolsSelf = false
  ): string | null {
    if (!windowId || typeof windowId !== 'string') return this.lastExternalForegroundHwnd
    const trimmed = windowId.trim()
    if (!trimmed || isZToolsSelf || isZToolsInternalWindowId(trimmed)) {
      return this.lastExternalForegroundHwnd
    }

    this.lastExternalForegroundHwnd = trimmed
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
      this.currentWindowBounds.set(trimmed, { ...bounds })
    } else if (!this.currentWindowBounds.has(trimmed)) {
      this.currentWindowBounds.set(trimmed, { x: 120, y: 100, width: 1000, height: 700 })
    }
    return this.lastExternalForegroundHwnd
  }

  /**
   * 获取最近一次激活的非 ZTools 外部目标窗口句柄
   */
  public getLastExternalForegroundWindow(): string | null {
    return this.lastExternalForegroundHwnd
  }

  /**
   * 保存窗口状态 saveWindowState(windowId, bounds)
   */
  public saveWindowState(windowId: string, bounds: WindowBounds): void {
    if (!windowId) return
    this.savedWindowStates.set(windowId, {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
  }

  /**
   * 读取已保存的窗口状态 getSavedWindowState(windowId)
   */
  public getSavedWindowState(windowId: string): WindowBounds | undefined {
    if (!windowId) return undefined
    const state = this.savedWindowStates.get(windowId)
    return state ? { ...state } : undefined
  }

  /**
   * 获取窗口当前已知坐标
   */
  public getCurrentWindowBounds(windowId: string): WindowBounds | undefined {
    if (!windowId) return undefined
    const b = this.currentWindowBounds.get(windowId)
    return b ? { ...b } : undefined
  }

  /**
   * 根据分屏动作计算目标窗口坐标
   */
  public computeTargetBounds(
    action: WindowActionName,
    cur: WindowBounds,
    workArea: WindowBounds = this.defaultWorkArea
  ): WindowBounds {
    const { x: wx, y: wy, width: ww, height: wh } = workArea
    const halfW = Math.floor(ww / 2)
    const halfH = Math.floor(wh / 2)
    const thirdW = Math.floor(ww / 3)
    const twoThirdsW = ww - thirdW

    switch (action) {
      case 'left-half':
        return { x: wx, y: wy, width: halfW, height: wh }
      case 'right-half':
        return { x: wx + halfW, y: wy, width: ww - halfW, height: wh }
      case 'top-half':
        return { x: wx, y: wy, width: ww, height: halfH }
      case 'bottom-half':
        return { x: wx, y: wy + halfH, width: ww, height: wh - halfH }
      case 'top-left':
        return { x: wx, y: wy, width: halfW, height: halfH }
      case 'top-right':
        return { x: wx + halfW, y: wy, width: ww - halfW, height: halfH }
      case 'bottom-left':
        return { x: wx, y: wy + halfH, width: halfW, height: wh - halfH }
      case 'bottom-right':
        return { x: wx + halfW, y: wy + halfH, width: ww - halfW, height: wh - halfH }
      case 'first-third':
        return { x: wx, y: wy, width: thirdW, height: wh }
      case 'center-third':
        return { x: wx + thirdW, y: wy, width: thirdW, height: wh }
      case 'last-third':
        return { x: wx + 2 * thirdW, y: wy, width: ww - 2 * thirdW, height: wh }
      case 'first-two-thirds':
        return { x: wx, y: wy, width: twoThirdsW, height: wh }
      case 'last-two-thirds':
        return { x: wx + thirdW, y: wy, width: twoThirdsW, height: wh }
      case 'maximize':
        return { x: wx, y: wy, width: ww, height: wh }
      case 'center': {
        const w = Math.min(cur.width, ww)
        const h = Math.min(cur.height, wh)
        return {
          x: wx + Math.round((ww - w) / 2),
          y: wy + Math.round((wh - h) / 2),
          width: w,
          height: h
        }
      }
      case 'reasonable-size': {
        const w = Math.round(ww * 0.6)
        const h = Math.round(wh * 0.8)
        return {
          x: wx + Math.round((ww - w) / 2),
          y: wy + Math.round((wh - h) / 2),
          width: w,
          height: h
        }
      }
      case 'make-larger': {
        const w = Math.min(ww, cur.width + 100)
        const h = Math.min(wh, cur.height + 100)
        return {
          x: Math.max(wx, cur.x - 50),
          y: Math.max(wy, cur.y - 50),
          width: w,
          height: h
        }
      }
      case 'make-smaller': {
        const w = Math.max(300, cur.width - 100)
        const h = Math.max(200, cur.height - 100)
        return {
          x: cur.x + 50,
          y: cur.y + 50,
          width: w,
          height: h
        }
      }
      case 'restore':
      default:
        return { ...cur }
    }
  }

  /**
   * 标准化动作名称（支持 kebab-case 与 snake_case 互转）
   */
  public normalizeActionName(action: string): WindowActionName | null {
    if (!action || typeof action !== 'string') return null
    const cleaned = action.trim().toLowerCase().replace(/_/g, '-').replace(/^(top|bottom)-(left|right)-quarter$/, '$1-$2') as WindowActionName
    return WINDOW_ACTIONS[cleaned] ? cleaned : null
  }

  /**
   * 获取所有支持的分屏动作清单
   */
  public listActions(): WindowActionMeta[] {
    return (Object.keys(WINDOW_ACTION_SPECS) as WindowActionName[])
      .filter((name) => process.platform === 'win32'
        ? name !== 'restore'
        : name !== 'next-display' && name !== 'previous-display')
      .map((name) => getWindowActionMeta(name))
  }

  /**
   * 应用窗口排版动作并触发毫秒级半透明 HUD 提示
   */
  public async applyAction(
    actionName: string,
    context: ApplyWindowActionContext = {}
  ): Promise<WindowActionResult> {
    const normalized = this.normalizeActionName(actionName)
    if (!normalized) {
      return {
        success: false,
        action: (actionName as WindowActionName) || 'center',
        title: actionName || t('windowActions.error.unknownAction'),
        error: t('windowActions.error.unsupportedAction', { action: actionName })
      }
    }

    // Windows 的目标窗口、显示器与几何由原生进程读取，不能采用插件或缓存估算的坐标。
    if (process.platform === 'win32') return this.applyWindowsAction(normalized, context)
    if (normalized === 'next-display' || normalized === 'previous-display') {
      return {
        success: false,
        action: normalized,
        title: getWindowActionMeta(normalized).title,
        error: t('windowActions.error.crossDisplayUnsupported')
      }
    }

    // 解析真实目标窗口（若当前传入的是 ZTools 主界面或未传，自动回退至 lastExternalForegroundHwnd）
    let targetWindowId = context.windowId?.trim() || ''
    if (!targetWindowId || context.isZToolsWindow || isZToolsInternalWindowId(targetWindowId)) {
      targetWindowId = this.lastExternalForegroundHwnd || 'external-active-window'
    } else {
      this.lastExternalForegroundHwnd = targetWindowId
    }

    if (context.currentBounds) {
      this.currentWindowBounds.set(targetWindowId, { ...context.currentBounds })
    }

    const currentBounds: WindowBounds = this.currentWindowBounds.get(targetWindowId) ?? {
      x: 120,
      y: 100,
      width: 1000,
      height: 700
    }
    const workArea = context.workArea ?? this.defaultWorkArea
    const meta = getWindowActionMeta(normalized)

    // 恢复窗口动作处理
    if (normalized === 'restore') {
      const savedBounds = this.getSavedWindowState(targetWindowId)
      if (!savedBounds) {
        const errMsg = t('windowActions.error.noPreviousState')
        if (this.options.hudService) {
          try {
            void this.options.hudService.showHUD(errMsg, {
              icon: meta.icon,
              durationMs: 1200
            })
          } catch (err) {
            console.warn('[WindowManagementService] HUD display error:', err)
          }
        }
        return {
          success: false,
          action: 'restore',
          preset: 'restore',
          title: meta.title,
          targetWindowId,
          error: errMsg,
          message: errMsg
        }
      }

      if (this.options.sidecarManager) {
        const sidecarRes = await this.options.sidecarManager.manageWindow('restore', savedBounds).catch((err: unknown) => ({
          success: false,
          action: 'restore',
          error: err instanceof Error ? err.message : String(err)
        }))
        if (!sidecarRes || sidecarRes.success === false) {
          if (sidecarRes?.error) {
            console.warn('[WindowManagementService] Sidecar restore failed:', sidecarRes.error)
          }
          const errMsg = t('windowActions.error.dispatchFailed')
          return {
            success: false,
            action: 'restore',
            preset: 'restore',
            title: meta.title,
            targetWindowId,
            rect: { ...savedBounds },
            bounds: { ...savedBounds },
            previousRect: { ...currentBounds },
            error: errMsg,
            message: errMsg
          }
        }
      }

      // 将还原前的当前位置再次保存，以支持连续按两次 Restore 来回切换
      if (hasWindowBoundsChanged(currentBounds, savedBounds)) {
        this.saveWindowState(targetWindowId, currentBounds)
      }
      this.currentWindowBounds.set(targetWindowId, { ...savedBounds })

      if (this.options.hudService) {
        try {
          void this.options.hudService.showHUD(t('windowActions.hud.applied', { title: meta.title }), {
            icon: meta.icon,
            durationMs: 1200
          })
        } catch (err) {
          console.warn('[WindowManagementService] HUD display error:', err)
        }
      }

      return {
        success: true,
        action: 'restore',
        preset: 'restore',
        title: meta.title,
        targetWindowId,
        rect: { ...savedBounds },
        bounds: { ...savedBounds },
        previousRect: { ...currentBounds }
      }
    }

    // 非 restore 分屏动作：计算目标坐标，若坐标发生变化则通过 saveWindowState 保存移动前坐标
    let targetRect = this.computeTargetBounds(normalized, currentBounds, workArea)

    if (this.options.sidecarManager) {
      const sidecarRes = await this.options.sidecarManager.manageWindow(normalized, targetRect)
      if (!sidecarRes || sidecarRes.success === false) {
        if (sidecarRes?.error) {
          console.warn('[WindowManagementService] Sidecar window action failed:', normalized, sidecarRes.error)
        }
        const errMsg = t('windowActions.error.dispatchFailed')
        return {
          success: false,
          action: normalized,
          preset: normalized,
          title: meta.title,
          targetWindowId,
          rect: { ...targetRect },
          bounds: { ...targetRect },
          previousRect: { ...currentBounds },
          error: errMsg,
          message: errMsg
        }
      }
      if (sidecarRes.rect) {
        targetRect = sidecarRes.rect
      }
    }

    if (hasWindowBoundsChanged(currentBounds, targetRect)) {
      this.saveWindowState(targetWindowId, currentBounds)
    }
    this.currentWindowBounds.set(targetWindowId, { ...targetRect })

    if (this.options.hudService) {
      try {
        void this.options.hudService.showHUD(t('windowActions.hud.applied', { title: meta.title }), {
          icon: meta.icon,
          durationMs: 1200
        })
      } catch (err) {
        console.warn('[WindowManagementService] HUD display error:', err)
      }
    }

    return {
      success: true,
      action: normalized,
      preset: normalized,
      title: meta.title,
      targetWindowId,
      rect: { ...targetRect },
      bounds: { ...targetRect },
      previousRect: { ...currentBounds }
    }
  }
  /** 与隐藏后粘贴相同：先让出前台，再获取真实外部窗口；失败恢复调用窗口。 */
  public async applyToExternalWindow(
    action: string,
    window: { hide(): void; show(): void; focus(): void; isDestroyed(): boolean },
    signal?: AbortSignal
  ): Promise<WindowActionResult> {
    const normalized = this.normalizeActionName(action)
    const failure = (error: string): WindowActionResult => ({ success: false, action: normalized || 'center', title: action, error })
    if (!normalized || !this.listActions().some(item => item.name === normalized)) return failure(t('windowActions.error.unsupportedActionGeneric'))
    if (!this.options.sidecarManager || window.isDestroyed() || signal?.aborted) return failure(t('windowActions.error.unavailableOrCancelled'))
    window.hide()
    try {
      // Windows 隐藏窗口后才会将前台交给下一个窗口，等待激活完成，避免读到自身。
      await new Promise<void>(resolve => setTimeout(resolve, 80))
      if (signal?.aborted) throw new Error(t('windowActions.error.cancelled'))
      const target = await this.options.sidecarManager.getActiveWindow()
      if (!target.active || !Number.isSafeInteger(target.hwnd) || target.hwnd <= 0 || !Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid === process.pid) {
        throw new Error(t('windowActions.error.noExternalWindow'))
      }
      if (signal?.aborted || window.isDestroyed()) throw new Error(t('windowActions.error.cancelled'))
      const result = await this.applyAction(normalized, { windowId: String(target.hwnd), targetProcessId: target.pid })
      if (!result.success) {
        if (!window.isDestroyed()) { window.show(); window.focus() }
        return result
      }
      return result
    } catch (error) {
      if (!window.isDestroyed()) { window.show(); window.focus() }
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

  private async applyWindowsAction(action: WindowActionName, context: ApplyWindowActionContext): Promise<WindowActionResult> {
    const meta = getWindowActionMeta(action)
    const failure = (error: string): WindowActionResult => ({ success: false, action, title: meta.title, error })
    if (action === 'restore') return failure(t('windowActions.error.restoreNotSupported'))
    if (!this.options.sidecarManager) return failure(t('windowActions.error.sidecarUnavailable'))
    const hwnd = Number(context.windowId), pid = context.targetProcessId
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !pid || !Number.isSafeInteger(pid) || pid === process.pid) return failure(t('windowActions.error.missingExternalTarget'))
    try {
      const result = await this.options.sidecarManager.manageWindow(action, undefined, { hwnd, pid })
      if (result?.success !== true) {
        if (result?.error) {
          console.warn('[WindowManagementService] Windows sidecar action not confirmed:', action, result.error)
        }
        return failure(t('windowActions.error.notConfirmed'))
      }
      const rect = result.rect
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
        return failure(t('windowActions.error.invalidRect'))
      }
      void this.options.hudService?.showHUD(t('windowActions.hud.applied', { title: meta.title }), { icon: meta.icon, durationMs: 1200 })
      return { success: true, action, preset: action, title: meta.title, rect, bounds: rect }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

}
