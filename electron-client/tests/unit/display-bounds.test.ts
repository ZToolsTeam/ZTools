import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { Display, Rectangle } from 'electron'
import {
  sanitizeBounds,
  clampBoundsToWorkArea,
  calculateCenteredBounds,
  calculateCursorRelativeBounds,
  getBoundsVisibleArea,
  ensureBoundsVisible,
  DisplayMetricsWatcher
} from '../../src/main/windows/display-bounds.js'

function createMockDisplay(options: {
  id?: number
  bounds?: Rectangle
  workArea?: Rectangle
  scaleFactor?: number
}): Display {
  const bounds = options.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 }
  const workArea = options.workArea ?? bounds
  return {
    id: options.id ?? 1,
    bounds,
    workArea,
    scaleFactor: options.scaleFactor ?? 1,
    rotation: 0,
    touchSupport: 'unknown',
    accelerometerSupport: 'unknown',
    monochrome: false,
    colorDepth: 24,
    colorSpace: 'sRGB',
    size: { width: bounds.width, height: bounds.height },
    workAreaSize: { width: workArea.width, height: workArea.height },
    internal: false,
    label: `Display-${options.id ?? 1}`,
    displayFrequency: 60
  } as unknown as Display
}

test('sanitizeBounds: 抵御 NaN、无穷大、负数与零尺寸等异常输入', () => {
  const invalid = sanitizeBounds({
    x: Number.NaN,
    y: Number.POSITIVE_INFINITY,
    width: -500,
    height: 0
  })
  assert.equal(invalid.x, 0)
  assert.equal(invalid.y, 0)
  assert.equal(invalid.width, 800)
  assert.equal(invalid.height, 600)

  const empty = sanitizeBounds({})
  assert.equal(empty.x, 0)
  assert.equal(empty.y, 0)
  assert.equal(empty.width, 800)
  assert.equal(empty.height, 600)

  const valid = sanitizeBounds({ x: 12.8, y: -45.2, width: 680.1, height: 479.9 })
  assert.equal(valid.x, 13)
  assert.equal(valid.y, -45)
  assert.equal(valid.width, 680)
  assert.equal(valid.height, 480)
})

test('clampBoundsToWorkArea: 标准主屏幕内避让与防越界', () => {
  const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1040 } // 底部 40px 任务栏
  const windowBounds = { x: 1800, y: 900, width: 400, height: 300 }
  const clamped = clampBoundsToWorkArea(windowBounds, workArea)

  assert.equal(clamped.width, 400)
  assert.equal(clamped.height, 300)
  // x 必须 clamp 到 1920 - 400 = 1520
  assert.equal(clamped.x, 1520)
  // y 必须 clamp 到 1040 - 300 = 740
  assert.equal(clamped.y, 740)
})

test('clampBoundsToWorkArea: 多屏幕负坐标虚拟桌面（副屏在主屏左侧或上方）', () => {
  // 左侧副屏：x 从 -1920 到 0
  const leftWorkArea: Rectangle = { x: -1920, y: 0, width: 1920, height: 1080 }
  const clamped1 = clampBoundsToWorkArea({ x: -2000, y: 200, width: 600, height: 400 }, leftWorkArea)
  assert.equal(clamped1.x, -1920) // 不能小于 -1920
  assert.equal(clamped1.y, 200)

  // 上方副屏：y 从 -1080 到 0
  const topWorkArea: Rectangle = { x: 0, y: -1080, width: 1920, height: 1080 }
  const clamped2 = clampBoundsToWorkArea({ x: 100, y: -1200, width: 500, height: 300 }, topWorkArea)
  assert.equal(clamped2.x, 100)
  assert.equal(clamped2.y, -1080) // 不能小于 -1080
})

test('clampBoundsToWorkArea: 极端小屏幕或高 DPI 缩放下窗口超大时的平滑降级', () => {
  const smallWorkArea: Rectangle = { x: 0, y: 0, width: 600, height: 400 }
  const bigWindow = { x: 50, y: 50, width: 800, height: 600 }
  const clamped = clampBoundsToWorkArea(bigWindow, smallWorkArea)

  // 窗口必须自动收缩为工作区尺寸
  assert.equal(clamped.width, 600)
  assert.equal(clamped.height, 400)
  assert.equal(clamped.x, 0)
  assert.equal(clamped.y, 0)
})

test('calculateCenteredBounds: Launcher 黄金比例 (0.18) 与居中计算', () => {
  const display = createMockDisplay({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  const centered = calculateCenteredBounds({ width: 680, height: 480 }, display, 0.18)

  assert.equal(centered.width, 680)
  assert.equal(centered.height, 480)
  assert.equal(centered.x, Math.round((1920 - 680) / 2)) // 620
  assert.equal(centered.y, Math.round(1080 * 0.18)) // 194
})

test('calculateCenteredBounds: 负坐标副屏上的居中定位', () => {
  const leftDisplay = createMockDisplay({
    workArea: { x: -1920, y: 0, width: 1920, height: 1080 }
  })
  const centered = calculateCenteredBounds({ width: 680, height: 480 }, leftDisplay, 0.5)

  assert.equal(centered.x, -1920 + Math.round((1920 - 680) / 2)) // -1300
  assert.equal(centered.y, Math.round((1080 - 480) / 2)) // 300
})

test('calculateCursorRelativeBounds: SuperPanel 跟随光标在四个极端角落时的防溢出保护', () => {
  const display = createMockDisplay({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  })

  // 1. 左上角 (0, 0) 点击
  const topLeft = calculateCursorRelativeBounds({ width: 400, height: 300 }, { x: 0, y: 0 }, display, 'cursor')
  assert.equal(topLeft.x, 0)
  assert.equal(topLeft.y, 0)

  // 2. 右下角 (1920, 1080) 点击
  const bottomRight = calculateCursorRelativeBounds({ width: 400, height: 300 }, { x: 1920, y: 1080 }, display, 'cursor')
  assert.equal(bottomRight.x, 1920 - 400)
  assert.equal(bottomRight.y, 1080 - 300)

  // 3. 右上角 (1920, 0) 点击
  const topRight = calculateCursorRelativeBounds({ width: 400, height: 300 }, { x: 1920, y: 0 }, display, 'cursor')
  assert.equal(topRight.x, 1920 - 400)
  assert.equal(topRight.y, 0)

  // 4. 左下角 (0, 1080) 点击
  const bottomLeft = calculateCursorRelativeBounds({ width: 400, height: 300 }, { x: 0, y: 1080 }, display, 'cursor')
  assert.equal(bottomLeft.x, 0)
  assert.equal(bottomLeft.y, 1080 - 300)
})

test('getBoundsVisibleArea: 准确计算窗口与屏幕重叠面积', () => {
  const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 }
  // 完全包含
  const full = getBoundsVisibleArea({ x: 100, y: 100, width: 500, height: 400 }, workArea)
  assert.equal(full, 500 * 400)

  // 部分相交
  const partial = getBoundsVisibleArea({ x: 1800, y: 1000, width: 200, height: 200 }, workArea)
  // 相交部分宽 120 (1800..1920)，高 80 (1000..1080)
  assert.equal(partial, 120 * 80)

  // 完全脱离无相交
  const outside = getBoundsVisibleArea({ x: 3000, y: 100, width: 500, height: 400 }, workArea)
  assert.equal(outside, 0)
})

test('ensureBoundsVisible: 外接显示器断开（拔屏）后脱屏孤儿窗口自愈拉回有效主屏幕', () => {
  const primaryDisplay = createMockDisplay({
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  // 曾在外接副屏 (x: 2560..4480) 上的窗口
  const orphanWindow = { x: 3000, y: 200, width: 900, height: 600 }

  // 此时副屏拔掉，当前可用显示器列表中只有 primaryDisplay
  const healed = ensureBoundsVisible(orphanWindow, [primaryDisplay], primaryDisplay)

  // 必须被自愈拉回 primaryDisplay 居中
  assert.equal(healed.width, 900)
  assert.equal(healed.height, 600)
  assert.equal(healed.x, Math.round((1920 - 900) / 2))
  assert.equal(healed.y, Math.round((1080 - 600) / 2))
})

test('ensureBoundsVisible: 仅极小边角露在屏内（少于 10000 像素）时主动重排', () => {
  const primaryDisplay = createMockDisplay({
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  })
  // 仅露 10x10 = 100 像素在屏幕边缘
  const edgeGlitch = { x: 1910, y: 1070, width: 900, height: 600 }
  const healed = ensureBoundsVisible(edgeGlitch, [primaryDisplay], primaryDisplay, 10000)

  // 露在屏幕内的面积不足以正常操作，必须自动重排到安全居中位置
  assert.equal(healed.x, Math.round((1920 - 900) / 2))
  assert.equal(healed.y, Math.round((1080 - 600) / 2))
})

test('DisplayMetricsWatcher: 事件防抖、回调分发与对称销毁清理', async () => {
  const emitter = new EventEmitter()
  const watcher = new DisplayMetricsWatcher(emitter as unknown as typeof import('electron').screen)

  let callCount = 0
  let lastEvent = ''
  const unsubscribe = watcher.subscribe((event) => {
    callCount += 1
    lastEvent = event
  })

  // 模拟操作系统瞬间高频触发 5 次 metrics 变化
  for (let i = 0; i < 5; i++) {
    emitter.emit('display-metrics-changed', {}, createMockDisplay({ id: 1 }))
  }

  // 立即检查：防抖尚未触发
  assert.equal(callCount, 0)

  // 等待防抖窗口过期 (150ms)
  await new Promise((resolve) => setTimeout(resolve, 220))
  assert.equal(callCount, 1)
  assert.equal(lastEvent, 'metrics-changed')

  // 测试取消订阅
  unsubscribe()
  emitter.emit('display-metrics-changed', {}, createMockDisplay({ id: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 220))
  assert.equal(callCount, 1) // 不再增加

  // 测试 dispose 彻底清理
  watcher.dispose()
  assert.equal(emitter.listenerCount('display-metrics-changed'), 0)
  assert.equal(emitter.listenerCount('display-added'), 0)
  assert.equal(emitter.listenerCount('display-removed'), 0)
})
