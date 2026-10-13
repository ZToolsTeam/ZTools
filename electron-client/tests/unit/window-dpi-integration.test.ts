import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { Display, Rectangle } from 'electron'
import {
  calculateCenteredBounds,
  calculateCursorRelativeBounds,
  ensureBoundsVisible,
  clampBoundsToWorkArea
} from '../../src/main/windows/display-bounds.js'

function makeDisplay(options: {
  id?: number
  workArea?: Rectangle
  scaleFactor?: number
}): Display {
  const workArea = options.workArea ?? { x: 0, y: 0, width: 1920, height: 1040 }
  return {
    id: options.id ?? 1,
    bounds: { ...workArea },
    workArea,
    scaleFactor: options.scaleFactor ?? 1,
    rotation: 0,
    touchSupport: 'unknown',
    accelerometerSupport: 'unknown',
    monochrome: false,
    colorDepth: 24,
    colorSpace: 'sRGB',
    size: { width: workArea.width, height: workArea.height },
    workAreaSize: { width: workArea.width, height: workArea.height },
    internal: false,
    label: `Display-${options.id ?? 1}`,
    displayFrequency: 60
  } as unknown as Display
}

test('Launcher 端到端 DPI 跨屏幕切换与自适应居中集成验证', () => {
  // 场景：用户有两块显示器
  // 显示器 1（主屏 4K 200% 缩放，逻辑 workArea: 0, 0, 1920, 1040）
  const primaryDisplay = makeDisplay({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 2 })
  // 显示器 2（副屏 1080P 100% 缩放，摆在主屏左侧，负坐标: -1920, 0, 1920, 1080）
  const secondaryDisplay = makeDisplay({ id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 })

  // 1. 光标在主屏上呼出 Launcher
  const boundsOnPrimary = calculateCenteredBounds({ width: 680, height: 480 }, primaryDisplay, 0.18)
  assert.equal(boundsOnPrimary.x, (1920 - 680) / 2) // 620
  assert.equal(boundsOnPrimary.y, Math.round(1040 * 0.18)) // 187
  assert.equal(boundsOnPrimary.width, 680)
  assert.equal(boundsOnPrimary.height, 480)

  // 2. 光标移动到左侧副屏（例如光标在 x: -500, y: 300）呼出 Launcher
  const boundsOnSecondary = calculateCenteredBounds({ width: 680, height: 480 }, secondaryDisplay, 0.18)
  assert.equal(boundsOnSecondary.x, -1920 + (1920 - 680) / 2) // -1300
  assert.equal(boundsOnSecondary.y, Math.round(1080 * 0.18)) // 194
  assert.equal(boundsOnSecondary.width, 680)
  assert.equal(boundsOnSecondary.height, 480)
})

test('SuperPanel 跨显示器与极端光标点击防溢出集成验证', () => {
  // 副屏在主屏上方：y 从 -1080 到 0
  const topDisplay = makeDisplay({ id: 3, workArea: { x: 0, y: -1080, width: 1920, height: 1040 } })

  // 光标在上方副屏的右上角边缘点击 (-10, -1070)
  const cursorNearTopRight = { x: 1900, y: -1070 }
  const panelBounds = calculateCursorRelativeBounds(
    { width: 400, height: 300 },
    cursorNearTopRight,
    topDisplay,
    'cursor'
  )

  // 验证必须完整处于 topDisplay 的 workArea 之内
  assert.ok(panelBounds.x >= topDisplay.workArea.x)
  assert.ok(panelBounds.x + panelBounds.width <= topDisplay.workArea.x + topDisplay.workArea.width)
  assert.ok(panelBounds.y >= topDisplay.workArea.y)
  assert.ok(panelBounds.y + panelBounds.height <= topDisplay.workArea.y + topDisplay.workArea.height)
  assert.equal(panelBounds.x, 1920 - 400) // clamp 到右侧边缘
  assert.equal(panelBounds.y, -1080) // clamp 到顶部边缘
})

test('主窗口与插件窗口脱屏孤儿自愈集成验证（拔掉外接屏幕测试）', () => {
  const laptopScreen = makeDisplay({ id: 1, workArea: { x: 0, y: 0, width: 1536, height: 824 } }) // 125% 常见笔记本
  const officeMonitor = makeDisplay({ id: 2, workArea: { x: 1536, y: 0, width: 2560, height: 1400 } }) // 办公室 2K 扩展屏

  // 用户在办公室时，把插件窗口放置在扩展屏中心 (2000, 200, 1000, 700)
  const officeBounds = { x: 2000, y: 200, width: 1000, height: 700 }

  // 此时拔掉扩展屏，系统只剩下 laptopScreen
  const healedBounds = ensureBoundsVisible(officeBounds, [laptopScreen], laptopScreen)

  // 验证：窗口自动居中落在笔记本屏幕内，且尺寸不会超出笔记本工作区
  assert.ok(healedBounds.x >= laptopScreen.workArea.x)
  assert.ok(healedBounds.y >= laptopScreen.workArea.y)
  assert.ok(healedBounds.x + healedBounds.width <= laptopScreen.workArea.width)
  assert.ok(healedBounds.y + healedBounds.height <= laptopScreen.workArea.height)
  assert.equal(healedBounds.width, 1000)
  assert.equal(healedBounds.height, 700)
  assert.equal(healedBounds.x, Math.round((1536 - 1000) / 2)) // 268
  assert.equal(healedBounds.y, Math.round((824 - 700) / 2)) // 62
})

test('高 DPI 下窗口尺寸大于小屏可用工作区时的自适应收缩集成验证', () => {
  // 超小工作区（例如极端高缩放 250% 下，逻辑分辨率只有 768x432）
  const tinyDisplay = makeDisplay({ id: 9, workArea: { x: 0, y: 0, width: 768, height: 432 } })

  // 主窗口默认希望 900x600
  const desired = { x: 50, y: 50, width: 900, height: 600 }
  const clamped = clampBoundsToWorkArea(desired, tinyDisplay.workArea)

  assert.equal(clamped.width, 768)
  assert.equal(clamped.height, 432)
  assert.equal(clamped.x, 0)
  assert.equal(clamped.y, 0)
})
