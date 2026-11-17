import { ref, nextTick } from 'vue'

const DEFAULT_ROW_TOLERANCE_PX = 10
const DEFAULT_PAGE_STEP_ROWS = 4

/**
 * 将带有坐标的元素项聚类为按从上到下、从左到右排列的视觉行矩阵
 * @param {Array<{ index: number, top: number, left: number, width: number, height: number, group?: string }>} items
 * @param {number} [rowTolerance=10] 同一视觉行的垂直容差（px）
 * @returns {Array<Array<{ index: number, top: number, left: number, width: number, height: number, centerX: number }>>}
 */
export function clusterVisualRows(items, rowTolerance = DEFAULT_ROW_TOLERANCE_PX) {
  if (!Array.isArray(items) || items.length === 0) return []

  const normalized = items
    .filter((it) => it && Number.isInteger(it.index) && it.index >= 0)
    .map((it) => {
      const left = Number(it.left) || 0
      const top = Number(it.top) || 0
      const width = Math.max(0, Number(it.width) || 0)
      const height = Math.max(0, Number(it.height) || 0)
      return {
        index: it.index,
        top,
        left,
        width,
        height,
        centerX: left + width / 2,
        group: it.group ?? ''
      }
    })
    .sort((a, b) => {
      if (Math.abs(a.top - b.top) > rowTolerance) return a.top - b.top
      if (a.left !== b.left) return a.left - b.left
      return a.index - b.index
    })

  const rows = []
  for (const item of normalized) {
    const lastRow = rows[rows.length - 1]
    if (!lastRow) {
      rows.push([item])
      continue
    }
    const anchorTop = lastRow[0].top
    if (Math.abs(item.top - anchorTop) <= rowTolerance) {
      lastRow.push(item)
    } else {
      rows.push([item])
    }
  }

  for (const row of rows) {
    row.sort((a, b) => (a.left !== b.left ? a.left - b.left : a.index - b.index))
  }
  return rows
}

/**
 * 无真实几何布局环境（如 JSDOM 单元测试全 0 矩形）下的回退视觉行构建
 * 支持按分组（如分类概览、主页异构三区块）各自独立列数切分，保证跨组不串行
 * @param {Array<{ index: number, group?: string, cols?: number }>} descriptors
 * @param {number} [defaultCols=2]
 */
export function buildFallbackRows(descriptors, defaultCols = 2) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return []

  const safeDefaultCols = Math.max(1, Math.floor(Number(defaultCols) || 2))
  const groups = []
  for (const desc of descriptors) {
    if (!desc || !Number.isInteger(desc.index) || desc.index < 0) continue
    const groupKey = String(desc.group ?? '')
    const cols = Math.max(1, Math.floor(Number(desc.cols) || safeDefaultCols))
    const prev = groups[groups.length - 1]
    if (prev && prev.groupKey === groupKey && prev.cols === cols) {
      prev.items.push(desc)
    } else {
      groups.push({ groupKey, cols, items: [desc] })
    }
  }

  const SYNTHETIC_TOTAL_WIDTH = 960
  const ROW_HEIGHT = 64
  const rows = []
  let rowIndex = 0

  for (const grp of groups) {
    const colWidth = SYNTHETIC_TOTAL_WIDTH / grp.cols
    for (let i = 0; i < grp.items.length; i += grp.cols) {
      const slice = grp.items.slice(i, i + grp.cols)
      const row = slice.map((item, colIdx) => {
        const left = colIdx * colWidth
        return {
          index: item.index,
          top: rowIndex * ROW_HEIGHT,
          left,
          width: colWidth,
          height: ROW_HEIGHT,
          centerX: left + colWidth / 2,
          group: grp.groupKey
        }
      })
      rows.push(row)
      rowIndex += 1
    }
  }

  return rows
}

function findClosestInRow(row, targetCenterX) {
  let best = row[0]
  let bestDist = Math.abs(best.centerX - targetCenterX)
  for (let i = 1; i < row.length; i++) {
    const candidate = row[i]
    const dist = Math.abs(candidate.centerX - targetCenterX)
    if (dist < bestDist) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}

/**
 * 在已聚类的视觉行矩阵上执行单步方向导航计算（纯函数）
 * 严格遵循视觉一致性规则：
 * - ArrowLeft / ArrowRight：仅在当前视觉行内左右移动，行首/行尾原地止步，绝不跨行折返；
 * - ArrowUp：首行触发 reachTop 信号（供双向闭环交回顶栏搜索框），绝不水平左跳；
 * - ArrowDown：末行原地止步，绝不水平右跳；中间行按期望水平列锚点 preferredCenterX 就近对齐；
 * - Home / End / PageUp / PageDown：首尾直达与整屏翻行。
 */
export function computeVisualNavStep(rows, currentIndex, key, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { nextIndex: -1, moved: false, reachTop: false, reachBottom: false, nextAnchorX: null }
  }

  let curRowIdx = -1
  let curColIdx = -1
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].findIndex((cell) => cell.index === currentIndex)
    if (c !== -1) {
      curRowIdx = r
      curColIdx = c
      break
    }
  }

  // 当前索引越界或未找到时，安全回落到首项
  if (curRowIdx === -1) {
    const first = rows[0][0]
    return {
      nextIndex: first.index,
      moved: true,
      reachTop: false,
      reachBottom: false,
      nextAnchorX: first.centerX
    }
  }

  const curRow = rows[curRowIdx]
  const curCell = curRow[curColIdx]
  const anchorX = Number.isFinite(options.preferredCenterX)
    ? options.preferredCenterX
    : curCell.centerX
  const pageStepRows = Math.max(1, Math.floor(Number(options.pageStepRows) || DEFAULT_PAGE_STEP_ROWS))

  switch (key) {
    case 'ArrowLeft': {
      if (curColIdx <= 0) {
        return {
          nextIndex: curCell.index,
          moved: false,
          reachTop: false,
          reachBottom: false,
          atRowEdge: 'start',
          nextAnchorX: curCell.centerX
        }
      }
      const target = curRow[curColIdx - 1]
      return {
        nextIndex: target.index,
        moved: true,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: target.centerX
      }
    }

    case 'ArrowRight': {
      if (curColIdx >= curRow.length - 1) {
        return {
          nextIndex: curCell.index,
          moved: false,
          reachTop: false,
          reachBottom: false,
          atRowEdge: 'end',
          nextAnchorX: curCell.centerX
        }
      }
      const target = curRow[curColIdx + 1]
      return {
        nextIndex: target.index,
        moved: true,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: target.centerX
      }
    }

    case 'ArrowUp': {
      if (curRowIdx <= 0) {
        return {
          nextIndex: curCell.index,
          moved: false,
          reachTop: true,
          reachBottom: false,
          nextAnchorX: anchorX
        }
      }
      const targetRow = rows[curRowIdx - 1]
      const target = findClosestInRow(targetRow, anchorX)
      return {
        nextIndex: target.index,
        moved: target.index !== curCell.index,
        reachTop: false,
        reachBottom: false,
        // 垂直移动保留原水平列锚点，穿过残缺短行后仍可回到原列
        nextAnchorX: anchorX
      }
    }

    case 'ArrowDown': {
      if (curRowIdx >= rows.length - 1) {
        return {
          nextIndex: curCell.index,
          moved: false,
          reachTop: false,
          reachBottom: true,
          nextAnchorX: anchorX
        }
      }
      const targetRow = rows[curRowIdx + 1]
      const target = findClosestInRow(targetRow, anchorX)
      return {
        nextIndex: target.index,
        moved: target.index !== curCell.index,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: anchorX
      }
    }

    case 'PageUp': {
      if (curRowIdx <= 0) {
        const first = curRow[0]
        return {
          nextIndex: first.index,
          moved: first.index !== curCell.index,
          reachTop: curRowIdx === 0 && first.index === curCell.index,
          reachBottom: false,
          nextAnchorX: first.centerX
        }
      }
      const targetRowIdx = Math.max(0, curRowIdx - pageStepRows)
      const target = findClosestInRow(rows[targetRowIdx], anchorX)
      return {
        nextIndex: target.index,
        moved: target.index !== curCell.index,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: anchorX
      }
    }

    case 'PageDown': {
      if (curRowIdx >= rows.length - 1) {
        return {
          nextIndex: curCell.index,
          moved: false,
          reachTop: false,
          reachBottom: true,
          nextAnchorX: anchorX
        }
      }
      const targetRowIdx = Math.min(rows.length - 1, curRowIdx + pageStepRows)
      const target = findClosestInRow(rows[targetRowIdx], anchorX)
      return {
        nextIndex: target.index,
        moved: target.index !== curCell.index,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: anchorX
      }
    }

    case 'Home': {
      const first = rows[0][0]
      return {
        nextIndex: first.index,
        moved: first.index !== curCell.index,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: first.centerX
      }
    }

    case 'End': {
      const lastRow = rows[rows.length - 1]
      const last = lastRow[lastRow.length - 1]
      return {
        nextIndex: last.index,
        moved: last.index !== curCell.index,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: last.centerX
      }
    }

    default:
      return {
        nextIndex: curCell.index,
        moved: false,
        reachTop: false,
        reachBottom: false,
        nextAnchorX: anchorX
      }
  }
}

/**
 * 从容器 DOM 采集所有带 [data-nav-index] 的可导航节点并生成视觉行矩阵
 */
export function collectVisualRowsFromDOM(containerEl, options = {}) {
  const totalCount = Number(options.totalCount) || 0
  const defaultCols = Math.max(1, Math.floor(Number(options.fallbackColumns) || 2))
  const rowTolerance = Number(options.rowTolerance) || DEFAULT_ROW_TOLERANCE_PX

  if (!containerEl || typeof containerEl.querySelectorAll !== 'function') {
    if (totalCount <= 0) return []
    const descriptors = Array.from({ length: totalCount }, (_, i) => ({
      index: i,
      group: options.getGroup ? options.getGroup(i) : '',
      cols: options.getColumns ? options.getColumns(i) : defaultCols
    }))
    return buildFallbackRows(descriptors, defaultCols)
  }

  const nodeList = Array.from(containerEl.querySelectorAll('[data-nav-index]')).filter((node) => {
    if (node.closest('[inert], [aria-hidden="true"]')) return false
    return true
  })

  if (nodeList.length === 0) {
    if (totalCount <= 0) return []
    const descriptors = Array.from({ length: totalCount }, (_, i) => ({
      index: i,
      group: options.getGroup ? options.getGroup(i) : '',
      cols: options.getColumns ? options.getColumns(i) : defaultCols
    }))
    return buildFallbackRows(descriptors, defaultCols)
  }

  let hasRealGeometry = false
  const measured = []
  const fallbackDescs = []

  for (const node of nodeList) {
    const idx = Number.parseInt(node.getAttribute('data-nav-index') ?? '', 10)
    if (!Number.isInteger(idx) || idx < 0) continue
    const group = node.getAttribute('data-nav-group') || (options.getGroup ? options.getGroup(idx) : '')
    const attrCols = Number.parseInt(node.getAttribute('data-nav-cols') ?? '', 10)
    const cols = Number.isInteger(attrCols) && attrCols > 0
      ? attrCols
      : (options.getColumns ? options.getColumns(idx) : defaultCols)

    const rect = typeof node.getBoundingClientRect === 'function'
      ? node.getBoundingClientRect()
      : { top: 0, left: 0, width: 0, height: 0 }

    if (rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.left !== 0) {
      hasRealGeometry = true
    }

    measured.push({
      index: idx,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      group
    })
    fallbackDescs.push({ index: idx, group, cols })
  }

  if (hasRealGeometry) {
    return clusterVisualRows(measured, rowTolerance)
  }
  return buildFallbackRows(fallbackDescs, defaultCols)
}

/**
 * 视觉网格与多区块统一键盘导航 Composable
 */
export function useVisualGridNav(options = {}) {
  const focusedIndex = options.focusedIndex || ref(0)
  const preferredCenterX = ref(null)
  const isKeyboardMode = ref(false)
  let lastPointerPos = { x: null, y: null }

  function resetAnchor() {
    preferredCenterX.value = null
  }

  function setFocusedIndex(idx, { syncAnchor = true } = {}) {
    const next = Math.max(0, Number(idx) || 0)
    focusedIndex.value = next
    if (syncAnchor) {
      preferredCenterX.value = null
    }
  }

  function scrollFocusedIntoView() {
    nextTick(() => {
      const container = typeof options.getContainer === 'function' ? options.getContainer() : options.containerRef?.value
      let el = null
      if (container && typeof container.querySelector === 'function') {
        el = container.querySelector(`[data-nav-index="${focusedIndex.value}"]`)
      }
      if (!el && options.focusedSelector && typeof document !== 'undefined') {
        el = document.querySelector(options.focusedSelector)
      }
      el?.scrollIntoView?.({ block: 'nearest' })
    })
  }

  function navigate(key) {
    const totalCount = typeof options.getTotalCount === 'function' ? options.getTotalCount() : 0
    if (totalCount <= 0) return false

    const container = typeof options.getContainer === 'function' ? options.getContainer() : options.containerRef?.value
    const fallbackColumns = typeof options.getFallbackColumns === 'function'
      ? options.getFallbackColumns()
      : (options.fallbackColumns ?? 2)

    const rows = collectVisualRowsFromDOM(container, {
      totalCount,
      fallbackColumns,
      rowTolerance: options.rowTolerance,
      getGroup: options.getGroup,
      getColumns: options.getColumns
    })
    if (rows.length === 0) return false

    let pageStepRows = DEFAULT_PAGE_STEP_ROWS
    if (rows.length >= 2 && container) {
      const rowDelta = Math.abs(rows[1][0].top - rows[0][0].top)
      const viewportH = container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight * 0.7 : 400)
      if (rowDelta > 16 && viewportH > 0) {
        pageStepRows = Math.max(1, Math.round(viewportH / rowDelta) - 1)
      }
    }

    const result = computeVisualNavStep(rows, focusedIndex.value, key, {
      preferredCenterX: preferredCenterX.value,
      pageStepRows
    })

    isKeyboardMode.value = true
    if (result.nextAnchorX !== null && result.nextAnchorX !== undefined) {
      preferredCenterX.value = result.nextAnchorX
    }

    if (result.reachTop && typeof options.onReachTop === 'function') {
      const handledByTop = options.onReachTop()
      if (handledByTop !== false) return true
    }

    if (result.reachBottom && typeof options.onReachBottom === 'function') {
      const handledByBottom = options.onReachBottom()
      if (handledByBottom !== false) return true
    }

    if (result.nextIndex >= 0) {
      focusedIndex.value = result.nextIndex
    }
    options.onFocusGrid?.()
    if (result.moved) {
      scrollFocusedIntoView()
    }
    // 在网格中按方向键即使已在行首/行尾/末行止步，也返回 true 消费事件，阻止外层滚动条乱晃
    return true
  }

  function handlePointerMove(event) {
    if (!isKeyboardMode.value) return
    const sx = event?.screenX ?? null
    const sy = event?.screenY ?? null
    if (sx !== null && sy !== null && lastPointerPos.x === sx && lastPointerPos.y === sy) {
      return
    }
    lastPointerPos = { x: sx, y: sy }
    isKeyboardMode.value = false
  }

  return {
    focusedIndex,
    preferredCenterX,
    isKeyboardMode,
    navigate,
    setFocusedIndex,
    resetAnchor,
    scrollFocusedIntoView,
    handlePointerMove
  }
}
