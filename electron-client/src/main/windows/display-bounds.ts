import type { Display, Rectangle } from 'electron'

export interface SimpleRectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface SimplePoint {
  x: number
  y: number
}

/**
 * 校验并规范化矩形尺寸，抵御 NaN、无穷大、负数或零等异常输入
 */
export function sanitizeBounds(
  bounds: Partial<SimpleRectangle>,
  fallback: SimpleRectangle = { x: 0, y: 0, width: 800, height: 600 }
): SimpleRectangle {
  const x = Number.isFinite(bounds.x) ? Math.round(bounds.x!) : fallback.x
  const y = Number.isFinite(bounds.y) ? Math.round(bounds.y!) : fallback.y
  const width = Number.isFinite(bounds.width) && bounds.width! > 0 ? Math.round(bounds.width!) : fallback.width
  const height = Number.isFinite(bounds.height) && bounds.height! > 0 ? Math.round(bounds.height!) : fallback.height
  return { x, y, width, height }
}

/**
 * 将窗口几何矩形安全收敛在目标显示器的工作区（WorkArea）内
 * 避让任务栏，支持负坐标多显示器系统，并在屏幕小于窗口时平滑自适应
 */
export function clampBoundsToWorkArea(
  bounds: SimpleRectangle,
  workArea: Rectangle
): SimpleRectangle {
  const safeWorkArea = sanitizeBounds(workArea, { x: 0, y: 0, width: 1920, height: 1080 })
  const sanitized = sanitizeBounds(bounds)

  // 若窗口尺寸超过工作区，自动降级为工作区最大可用尺寸
  const width = Math.min(sanitized.width, safeWorkArea.width)
  const height = Math.min(sanitized.height, safeWorkArea.height)

  // 严格在 [workArea.x, workArea.x + workArea.width - width] 之间 clamp
  const minX = safeWorkArea.x
  const maxX = safeWorkArea.x + safeWorkArea.width - width
  const x = Math.max(minX, Math.min(sanitized.x, maxX))

  // 严格在 [workArea.y, workArea.y + safeWorkArea.height - height] 之间 clamp
  const minY = safeWorkArea.y
  const maxY = safeWorkArea.y + safeWorkArea.height - height
  const y = Math.max(minY, Math.min(sanitized.y, maxY))

  return { x, y, width, height }
}

/**
 * 计算指定显示器工作区内的居中位置，支持任意垂直比例（如 Launcher 默认 0.18 黄金偏上高度）
 */
export function calculateCenteredBounds(
  dimensions: { width: number; height: number },
  display: Display,
  verticalRatio = 0.5
): SimpleRectangle {
  const workArea = sanitizeBounds(display.workArea, { x: 0, y: 0, width: 1920, height: 1080 })
  const safeWidth = Math.max(1, Math.min(Math.round(dimensions.width), workArea.width))
  const safeHeight = Math.max(1, Math.min(Math.round(dimensions.height), workArea.height))

  const x = Math.round(workArea.x + (workArea.width - safeWidth) / 2)
  const ratio = Number.isFinite(verticalRatio) ? Math.max(0, Math.min(1, verticalRatio)) : 0.5
  const rawY = ratio === 0.5
    ? Math.round(workArea.y + (workArea.height - safeHeight) / 2)
    : Math.round(workArea.y + workArea.height * ratio)

  return clampBoundsToWorkArea({ x, y: rawY, width: safeWidth, height: safeHeight }, workArea)
}

/**
 * 计算跟随光标或屏幕居中的自适应面板矩形（针对 SuperPanel 与浮动菜单）
 */
export function calculateCursorRelativeBounds(
  dimensions: { width: number; height: number },
  cursor: SimplePoint,
  display: Display,
  positionMode: 'cursor' | 'center' = 'cursor'
): SimpleRectangle {
  const workArea = sanitizeBounds(display.workArea, { x: 0, y: 0, width: 1920, height: 1080 })
  const width = Math.min(Math.max(1, Math.round(dimensions.width)), workArea.width)
  const height = Math.min(Math.max(1, Math.round(dimensions.height)), workArea.height)

  const desiredX = positionMode === 'cursor'
    ? Math.round(cursor.x - width / 2)
    : Math.round(workArea.x + (workArea.width - width) / 2)

  const desiredY = positionMode === 'cursor'
    ? Math.round(cursor.y - height / 2)
    : Math.round(workArea.y + (workArea.height - height) / 2)

  return clampBoundsToWorkArea({ x: desiredX, y: desiredY, width, height }, workArea)
}

/**
 * 判断窗口矩形与某个显示器工作区之间是否有足够的可见重叠面积
 */
export function getBoundsVisibleArea(bounds: SimpleRectangle, workArea: Rectangle): number {
  const b = sanitizeBounds(bounds)
  const w = sanitizeBounds(workArea)

  const intersectLeft = Math.max(b.x, w.x)
  const intersectTop = Math.max(b.y, w.y)
  const intersectRight = Math.min(b.x + b.width, w.x + w.width)
  const intersectBottom = Math.min(b.y + b.height, w.y + w.height)

  if (intersectRight <= intersectLeft || intersectBottom <= intersectTop) {
    return 0
  }
  return (intersectRight - intersectLeft) * (intersectBottom - intersectTop)
}

/**
 * 校验窗口矩形在当前全部活跃显示器中是否至少有一部分完全可见。
 * 若用户拔掉外接屏幕或切换分辨率导致窗口完全落在死区，自动安全居中归位到活跃显示器（避免脱屏孤儿窗口）
 */
export function ensureBoundsVisible(
  bounds: SimpleRectangle,
  displays: Display[],
  fallbackDisplay: Display,
  minVisiblePixels = 10000
): SimpleRectangle {
  const sanitized = sanitizeBounds(bounds)
  if (!displays || displays.length === 0) {
    return calculateCenteredBounds(sanitized, fallbackDisplay, 0.5)
  }

  // 统计在所有活跃屏幕中的最大可见重叠面积
  let maxVisibleArea = 0
  let bestDisplay: Display = fallbackDisplay

  for (const display of displays) {
    const area = getBoundsVisibleArea(sanitized, display.workArea)
    if (area > maxVisibleArea) {
      maxVisibleArea = area
      bestDisplay = display
    }
  }

  // 如果完全不可见或重叠面积严重不足（例如仅露几个像素边角），重定位到最佳显示器
  if (maxVisibleArea < minVisiblePixels) {
    return calculateCenteredBounds(sanitized, bestDisplay || fallbackDisplay, 0.5)
  }

  // 若仍可见，但部分边缘被裁切，将其安全 clamp 在重叠最大的显示器工作区内
  return clampBoundsToWorkArea(sanitized, (bestDisplay || fallbackDisplay).workArea)
}

export type DisplayMetricsChangeHandler = (event: string, display?: Display) => void

/**
 * 屏幕指标与拓扑变化中央监听器，提供防抖与声明式清理能力
 */
export class DisplayMetricsWatcher {
  readonly #listeners = new Set<DisplayMetricsChangeHandler>()
  readonly #screenModule: typeof import('electron').screen
  #debounceTimer: NodeJS.Timeout | null = null
  #bound = false

  constructor(screenModule: typeof import('electron').screen) {
    this.#screenModule = screenModule
  }

  subscribe(handler: DisplayMetricsChangeHandler): () => void {
    this.#listeners.add(handler)
    this.#ensureBinding()
    return () => {
      this.#listeners.delete(handler)
      if (this.#listeners.size === 0) {
        this.#unbind()
      }
    }
  }

  #ensureBinding(): void {
    if (this.#bound) return
    this.#screenModule.on('display-metrics-changed', this.#onMetricsChanged)
    this.#screenModule.on('display-added', this.#onDisplayAdded)
    this.#screenModule.on('display-removed', this.#onDisplayRemoved)
    this.#bound = true
  }

  #unbind(): void {
    if (!this.#bound) return
    this.#screenModule.removeListener('display-metrics-changed', this.#onMetricsChanged)
    this.#screenModule.removeListener('display-added', this.#onDisplayAdded)
    this.#screenModule.removeListener('display-removed', this.#onDisplayRemoved)
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer)
      this.#debounceTimer = null
    }
    this.#bound = false
  }

  #trigger(event: string, display?: Display): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer)
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null
      for (const listener of this.#listeners) {
        try {
          listener(event, display)
        } catch (error) {
          console.error('[DisplayMetricsWatcher] 监听回调执行异常:', error)
        }
      }
    }, 150)
  }

  #onMetricsChanged = (_event: Electron.Event, display: Display): void => {
    this.#trigger('metrics-changed', display)
  }

  #onDisplayAdded = (_event: Electron.Event, display: Display): void => {
    this.#trigger('display-added', display)
  }

  #onDisplayRemoved = (_event: Electron.Event, display: Display): void => {
    this.#trigger('display-removed', display)
  }

  dispose(): void {
    this.#listeners.clear()
    this.#unbind()
  }
}
