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

export interface WindowActionResult {
  success: boolean
  action: WindowActionName
  title: string
  rect?: { x: number; y: number; width: number; height: number } | undefined
  error?: string | undefined
}

export interface WindowManagementServiceOptions {
  sidecarManager?: SidecarManager | undefined
  hudService?: HudService | undefined
}

/**
 * 窗口极速调度服务 (Window Management Service)
 * 对标 Raycast REA 15 种 Win32 分屏吸附动作与毫秒级半透明 HUD 提示
 */
export class WindowManagementService {
  constructor(private readonly options: WindowManagementServiceOptions = {}) {}

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
  public async applyAction(actionName: string): Promise<WindowActionResult> {
    const normalized = this.normalizeActionName(actionName)
    if (!normalized) {
      return {
        success: false,
        action: (actionName as WindowActionName) || 'center',
        title: actionName || '未知动作',
        error: `不支持的窗口调度动作: "${actionName}"`
      }
    }

    const meta = WINDOW_ACTIONS[normalized]
    let resultRect: { x: number; y: number; width: number; height: number } | undefined

    // 1. 尝试通过 ztools-uiaccess 预编译侧车执行原生 Win32 排版
    if (this.options.sidecarManager) {
      const res = await this.options.sidecarManager.manageWindow(normalized)
      if (res && res.success) {
        resultRect = res.rect
      }
    }

    // 2. 毫秒级半透明 HUD 弹出反馈
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
      rect: resultRect
    }
  }
}
