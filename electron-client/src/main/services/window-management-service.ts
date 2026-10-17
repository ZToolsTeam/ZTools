import type { SidecarManager } from './sidecar-manager.js'
import type { HudService } from './hud-service.js'

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

export interface WindowActionMeta {
  name: WindowActionName
  title: string
  description: string
  category: 'halves' | 'corners' | 'thirds' | 'sizes' | 'display'
  icon: string
  shortcut?: string
}

export const WINDOW_ACTIONS: Record<WindowActionName, WindowActionMeta> = {
  'left-half': {
    name: 'left-half',
    title: '左半屏',
    description: '将当前活动窗口吸附到屏幕左半部分',
    category: 'halves',
    icon: 'window-left',
    shortcut: 'Ctrl+Alt+Left'
  },
  'right-half': {
    name: 'right-half',
    title: '右半屏',
    description: '将当前活动窗口吸附到屏幕右半部分',
    category: 'halves',
    icon: 'window-right',
    shortcut: 'Ctrl+Alt+Right'
  },
  'top-half': {
    name: 'top-half',
    title: '上半屏',
    description: '将当前活动窗口吸附到屏幕上半部分',
    category: 'halves',
    icon: 'window-top',
    shortcut: 'Ctrl+Alt+Up'
  },
  'bottom-half': {
    name: 'bottom-half',
    title: '下半屏',
    description: '将当前活动窗口吸附到屏幕下半部分',
    category: 'halves',
    icon: 'window-bottom',
    shortcut: 'Ctrl+Alt+Down'
  },
  'top-left': {
    name: 'top-left',
    title: '左上角四分之一',
    description: '将当前窗口排列到屏幕左上四分之一区域',
    category: 'corners',
    icon: 'window-top-left',
    shortcut: 'Ctrl+Alt+U'
  },
  'top-right': {
    name: 'top-right',
    title: '右上角四分之一',
    description: '将当前窗口排列到屏幕右上四分之一区域',
    category: 'corners',
    icon: 'window-top-right',
    shortcut: 'Ctrl+Alt+I'
  },
  'bottom-left': {
    name: 'bottom-left',
    title: '左下角四分之一',
    description: '将当前窗口排列到屏幕左下四分之一区域',
    category: 'corners',
    icon: 'window-bottom-left',
    shortcut: 'Ctrl+Alt+J'
  },
  'bottom-right': {
    name: 'bottom-right',
    title: '右下角四分之一',
    description: '将当前窗口排列到屏幕右下四分之一区域',
    category: 'corners',
    icon: 'window-bottom-right',
    shortcut: 'Ctrl+Alt+K'
  },
  'first-third': {
    name: 'first-third',
    title: '左侧三分之一',
    description: '将当前窗口调整为屏幕左侧三分之一宽度',
    category: 'thirds',
    icon: 'window-third-left',
    shortcut: 'Ctrl+Alt+D'
  },
  'center-third': {
    name: 'center-third',
    title: '中间三分之一',
    description: '将当前窗口居中并调整为三分之一宽度',
    category: 'thirds',
    icon: 'window-third-center',
    shortcut: 'Ctrl+Alt+F'
  },
  'last-third': {
    name: 'last-third',
    title: '右侧三分之一',
    description: '将当前窗口调整为屏幕右侧三分之一宽度',
    category: 'thirds',
    icon: 'window-third-right',
    shortcut: 'Ctrl+Alt+G'
  },
  'first-two-thirds': {
    name: 'first-two-thirds',
    title: '左侧三分之二',
    description: '将当前窗口调整为屏幕左侧三分之二宽度',
    category: 'thirds',
    icon: 'window-two-thirds-left',
    shortcut: 'Ctrl+Alt+E'
  },
  'last-two-thirds': {
    name: 'last-two-thirds',
    title: '右侧三分之二',
    description: '将当前窗口调整为屏幕右侧三分之二宽度',
    category: 'thirds',
    icon: 'window-two-thirds-right',
    shortcut: 'Ctrl+Alt+T'
  },
  'maximize': {
    name: 'maximize',
    title: '最大化',
    description: '将当前活动窗口最大化充满整个工作区（避让任务栏）',
    category: 'sizes',
    icon: 'window-maximize',
    shortcut: 'Ctrl+Alt+Return'
  },
  'center': {
    name: 'center',
    title: '居中显示',
    description: '将当前活动窗口居中，保持适中比例',
    category: 'sizes',
    icon: 'window-center',
    shortcut: 'Ctrl+Alt+C'
  },
  'restore': {
    name: 'restore',
    title: '还原原始大小',
    description: '将活动窗口还原至调整前的上一位置与尺寸',
    category: 'sizes',
    icon: 'window-restore'
  },
  'reasonable-size': {
    name: 'reasonable-size',
    title: '适中黄金比例',
    description: '调整窗口为屏幕宽度的 60%、高度的 80%',
    category: 'sizes',
    icon: 'window-aspect'
  },
  'make-larger': {
    name: 'make-larger',
    title: '按比例微调放大',
    description: '将活动窗口各边向外延伸 50 像素',
    category: 'sizes',
    icon: 'window-plus'
  },
  'make-smaller': {
    name: 'make-smaller',
    title: '按比例微调缩小',
    description: '将活动窗口各边向内收缩 50 像素',
    category: 'sizes',
    icon: 'window-minus'
  }
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowActionResult {
  success: boolean
  action: WindowActionName
  title: string
  targetWindowId?: string | undefined
  rect?: WindowBounds | undefined
  previousRect?: WindowBounds | undefined
  error?: string | undefined
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
}

/**
 * 1:1 复刻 Raycast 原厂 Ob(cur, target) 坐标变化检测函数
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
 * 1:1 复刻 Raycast Window Management (Ob + saveWindowState / getSavedWindowState)
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
   * 1:1 复刻 Raycast saveWindowState(windowId, bounds)
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
   * 1:1 复刻 Raycast getSavedWindowState(windowId)
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
    const cleaned = action.trim().toLowerCase().replace(/_/g, '-') as WindowActionName
    return WINDOW_ACTIONS[cleaned] ? cleaned : null
  }

  /**
   * 获取所有支持的分屏动作清单
   */
  public listActions(): WindowActionMeta[] {
    return Object.values(WINDOW_ACTIONS)
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
        title: actionName || '未知动作',
        error: `不支持的窗口调度动作: "${actionName}"`
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
    const meta = WINDOW_ACTIONS[normalized]

    // Raycast 1:1 Restore 动作处理 (tx 函数逻辑)
    if (normalized === 'restore') {
      const savedBounds = this.getSavedWindowState(targetWindowId)
      if (!savedBounds) {
        const errMsg = '未找到该窗口的上一位置状态 (No previous window state)'
        if (this.options.hudService) {
          try {
            void this.options.hudService.showHUD(errMsg, {
              icon: meta.icon,
              durationMs: 1200
            })
          } catch {
            // ignore
          }
        }
        return {
          success: false,
          action: 'restore',
          title: meta.title,
          targetWindowId,
          error: errMsg
        }
      }

      // 将还原前的当前位置再次保存，以支持连续按两次 Restore 来回切换
      if (hasWindowBoundsChanged(currentBounds, savedBounds)) {
        this.saveWindowState(targetWindowId, currentBounds)
      }
      this.currentWindowBounds.set(targetWindowId, { ...savedBounds })

      if (this.options.sidecarManager) {
        await this.options.sidecarManager.manageWindow('restore', savedBounds).catch(() => null)
      }

      if (this.options.hudService) {
        try {
          void this.options.hudService.showHUD(`窗口已${meta.title}`, {
            icon: meta.icon,
            durationMs: 1200
          })
        } catch {
          // ignore
        }
      }

      return {
        success: true,
        action: 'restore',
        title: meta.title,
        targetWindowId,
        rect: { ...savedBounds },
        previousRect: { ...currentBounds }
      }
    }

    // 非 restore 分屏动作：计算目标坐标，若坐标发生变化则通过 saveWindowState 保存移动前坐标
    let targetRect = this.computeTargetBounds(normalized, currentBounds, workArea)

    if (this.options.sidecarManager) {
      const res = await this.options.sidecarManager.manageWindow(normalized, targetRect)
      if (res && res.success && res.rect) {
        targetRect = res.rect
      }
    }

    if (hasWindowBoundsChanged(currentBounds, targetRect)) {
      this.saveWindowState(targetWindowId, currentBounds)
    }
    this.currentWindowBounds.set(targetWindowId, { ...targetRect })

    if (this.options.hudService) {
      try {
        void this.options.hudService.showHUD(`窗口已${meta.title}`, {
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
      title: meta.title,
      targetWindowId,
      rect: { ...targetRect },
      previousRect: { ...currentBounds }
    }
  }
}
