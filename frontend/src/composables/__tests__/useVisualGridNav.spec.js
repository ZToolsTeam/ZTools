import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  clusterVisualRows,
  buildFallbackRows,
  computeVisualNavStep,
  collectVisualRowsFromDOM,
  useVisualGridNav
} from '../useVisualGridNav'
import { useKeymap, KEYMAP_SCOPES, _resetKeymapForTesting } from '@/utils/keymap'
import { useUIStore } from '@/stores/ui'

describe('useVisualGridNav 视觉网格与多区块方向键导航测试套件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetKeymapForTesting()
  })

  afterEach(() => {
    _resetKeymapForTesting()
    document.body.innerHTML = ''
  })

  describe('1. 视觉行聚类与双列/多列方向步进核心契约', () => {
    it('双列布局（696px 常规工作台宽度）：从左上 [0] 按 ↓ 精准落入左二 [2]，绝不斜跳至 [3]', () => {
      // 模拟真实双列 PluginCard3D 几何矩形（每行 2 张卡，宽 336px，间距 12px）
      const rects = Array.from({ length: 6 }, (_, i) => {
        const row = Math.floor(i / 2)
        const col = i % 2
        return {
          index: i,
          top: 80 + row * 76,
          left: 204 + col * 348,
          width: 336,
          height: 64
        }
      })

      const rows = clusterVisualRows(rects)
      expect(rows.map((r) => r.map((c) => c.index))).toEqual([
        [0, 1],
        [2, 3],
        [4, 5]
      ])

      // [0] 按下 -> [2]（正下方左列）
      const down1 = computeVisualNavStep(rows, 0, 'ArrowDown')
      expect(down1.nextIndex).toBe(2)
      expect(down1.moved).toBe(true)

      // [2] 再按下 -> [4]（第 3 行左列）
      const down2 = computeVisualNavStep(rows, 2, 'ArrowDown', { preferredCenterX: down1.nextAnchorX })
      expect(down2.nextIndex).toBe(4)

      // [4]（末行左列）再按下 -> 原地止步，绝不水平右跳到 [5]
      const downAtBottom = computeVisualNavStep(rows, 4, 'ArrowDown', { preferredCenterX: down2.nextAnchorX })
      expect(downAtBottom.nextIndex).toBe(4)
      expect(downAtBottom.moved).toBe(false)
      expect(downAtBottom.reachBottom).toBe(true)
    })

    it('选项 1A（同行严格止步）：行首按 ← 与行尾按 → 原地止步，不跨行折返', () => {
      const rows = buildFallbackRows(
        Array.from({ length: 5 }, (_, index) => ({ index, cols: 2 })),
        2
      )
      // 第 0 行: [0, 1]；第 1 行: [2, 3]；第 2 行: [4]
      expect(computeVisualNavStep(rows, 0, 'ArrowRight').nextIndex).toBe(1)
      // 行尾 [1] 再按 →：留在 [1]，不折入 [2]
      const rightEdge = computeVisualNavStep(rows, 1, 'ArrowRight')
      expect(rightEdge.nextIndex).toBe(1)
      expect(rightEdge.moved).toBe(false)
      expect(rightEdge.atRowEdge).toBe('end')

      // 行首 [2] 按 ←：留在 [2]，不折回 [1]
      const leftEdge = computeVisualNavStep(rows, 2, 'ArrowLeft')
      expect(leftEdge.nextIndex).toBe(2)
      expect(leftEdge.moved).toBe(false)
      expect(leftEdge.atRowEdge).toBe('start')
    })

    it('选项 2A（首行上移双向闭环）：第 1 行任意列按 ↑ 均发出 reachTop 且绝不水平左跳至 [0]', () => {
      const rows = buildFallbackRows(
        Array.from({ length: 6 }, (_, index) => ({ index, cols: 3 })),
        3
      )
      // 在第 1 行第 3 列 [2] 按 ↑：reachTop=true，nextIndex 仍为 2（绝不左跳到 0）
      const upFromTopRight = computeVisualNavStep(rows, 2, 'ArrowUp')
      expect(upFromTopRight.reachTop).toBe(true)
      expect(upFromTopRight.moved).toBe(false)
      expect(upFromTopRight.nextIndex).toBe(2)
    })

    it('列锚点记忆：从右列穿过残缺短行（如分类概览末行仅 1 项或中间单列区块）后按 ↓ 仍精准恢复右列', () => {
      // 模拟分类 A 有 3 项 [0,1] + [2]，分类 B 有 4 项 [3,4] + [5,6]
      const descriptors = [
        { index: 0, group: 'catA', cols: 2 },
        { index: 1, group: 'catA', cols: 2 },
        { index: 2, group: 'catA', cols: 2 },
        { index: 3, group: 'catB', cols: 2 },
        { index: 4, group: 'catB', cols: 2 },
        { index: 5, group: 'catB', cols: 2 },
        { index: 6, group: 'catB', cols: 2 }
      ]
      const rows = buildFallbackRows(descriptors, 2)
      expect(rows.map((r) => r.map((c) => c.index))).toEqual([
        [0, 1],
        [2],
        [3, 4],
        [5, 6]
      ])

      // 从 [0] 右移到右列 [1]，锁定右列锚点
      const stepRight = computeVisualNavStep(rows, 0, 'ArrowRight')
      expect(stepRight.nextIndex).toBe(1)

      // 从右列 [1] 按 ↓：因第 2 行只有左列 [2]，就近落到 [2]，但保留右列 nextAnchorX
      const stepDownShort = computeVisualNavStep(rows, 1, 'ArrowDown', {
        preferredCenterX: stepRight.nextAnchorX
      })
      expect(stepDownShort.nextIndex).toBe(2)

      // 从 [2] 继续按 ↓ 进入分类 B 首行 [3, 4]：依靠保留的右列锚点精准落回右列 [4]！
      const stepDownNextGroup = computeVisualNavStep(rows, 2, 'ArrowDown', {
        preferredCenterX: stepDownShort.nextAnchorX
      })
      expect(stepDownNextGroup.nextIndex).toBe(4)
    })

    it('支持 Home / End / PageUp / PageDown 快速定位', () => {
      const rows = buildFallbackRows(
        Array.from({ length: 14 }, (_, index) => ({ index, cols: 2 })),
        2
      )
      // 共 7 行：[0,1], [2,3], [4,5], [6,7], [8,9], [10,11], [12,13]
      const stepRight = computeVisualNavStep(rows, 0, 'ArrowRight') // 选中 [1]（右列）
      const pgDown = computeVisualNavStep(rows, 1, 'PageDown', {
        preferredCenterX: stepRight.nextAnchorX,
        pageStepRows: 3
      })
      expect(pgDown.nextIndex).toBe(7) // 第 4 行右列

      const endStep = computeVisualNavStep(rows, 7, 'End')
      expect(endStep.nextIndex).toBe(13)

      const homeStep = computeVisualNavStep(rows, 13, 'Home')
      expect(homeStep.nextIndex).toBe(0)
    })
  })

  describe('2. 真实组件装配集成闭环（搜索框 ⇄ 多区块异构网格）', () => {
    it('完整跑通：搜索框按 ↓ 移交网格 -> 4列磁贴 -> 1列最近使用 -> 2列推荐 -> 首行按 ↑ 回归搜索框', async () => {
      const uiStore = useUIStore()
      const focusSearchSpy = vi.fn(() => {
        uiStore.setSearchInputActive(true)
        uiStore.focusSearch()
      })
      window.__ztoolsFocusHomeSearch = focusSearchSpy

      const HostHarness = defineComponent({
        setup() {
          const containerRef = ref(null)
          const focusedIndex = ref(0)
          // 模拟主页异构三区块：4 个磁贴(4列) + 2 条最近使用(1列) + 2 张推荐卡(2列) = 共 8 项
          const entries = [
            { idx: 0, group: 'tiles', cols: 4 },
            { idx: 1, group: 'tiles', cols: 4 },
            { idx: 2, group: 'tiles', cols: 4 },
            { idx: 3, group: 'tiles', cols: 4 },
            { idx: 4, group: 'recents', cols: 1 },
            { idx: 5, group: 'recents', cols: 1 },
            { idx: 6, group: 'recommended', cols: 2 },
            { idx: 7, group: 'recommended', cols: 2 }
          ]

          const nav = useVisualGridNav({
            focusedIndex,
            containerRef,
            getTotalCount: () => entries.length,
            onFocusGrid: () => uiStore.focusGrid(),
            onReachTop: () => {
              window.__ztoolsFocusHomeSearch?.()
              return true
            }
          })

          useKeymap(KEYMAP_SCOPES.PAGE, {
            ArrowRight: () => nav.navigate('ArrowRight'),
            ArrowLeft: () => nav.navigate('ArrowLeft'),
            ArrowDown: () => nav.navigate('ArrowDown'),
            ArrowUp: () => nav.navigate('ArrowUp'),
            Home: () => nav.navigate('Home'),
            End: () => nav.navigate('End')
          })

          return () =>
            h(
              'div',
              { ref: containerRef },
              entries.map((item) =>
                h('div', {
                  key: item.idx,
                  'data-nav-index': item.idx,
                  'data-nav-group': item.group,
                  'data-nav-cols': item.cols,
                  class: focusedIndex.value === item.idx ? 'is-focused' : ''
                })
              )
            )
        }
      })

      const wrapper = mount(HostHarness, { attachTo: document.body })
      await nextTick()

      const pressWindow = (key) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }

      // 初始在 [0]（tiles 第 1 项），右移 2 次到 [2]（第 3 列）
      pressWindow('ArrowRight')
      pressWindow('ArrowRight')
      await nextTick()
      expect(wrapper.find('[data-nav-index="2"]').classes()).toContain('is-focused')
      expect(uiStore.isGridFocused).toBe(true)

      // 从 [2] 按 ↓：跨入「最近使用」第 1 行 [4]
      pressWindow('ArrowDown')
      await nextTick()
      expect(wrapper.find('[data-nav-index="4"]').classes()).toContain('is-focused')

      // 再按 ↓：进入「最近使用」第 2 行 [5]
      pressWindow('ArrowDown')
      await nextTick()
      expect(wrapper.find('[data-nav-index="5"]').classes()).toContain('is-focused')

      // 再按 ↓：进入「热门推荐」[6, 7]，因为原锚点在偏右第 3 列(centerX=600)，精准落入右列 [7]！
      pressWindow('ArrowDown')
      await nextTick()
      expect(wrapper.find('[data-nav-index="7"]').classes()).toContain('is-focused')

      // 按 Home 回到 [0]，再右移到 [1]，然后按 ↑ 触发回顶栏搜索框闭环，且索引保持在 [1] 不左跳！
      pressWindow('Home')
      pressWindow('ArrowRight')
      await nextTick()
      expect(wrapper.find('[data-nav-index="1"]').classes()).toContain('is-focused')

      pressWindow('ArrowUp')
      await nextTick()
      expect(focusSearchSpy).toHaveBeenCalledTimes(1)
      expect(wrapper.find('[data-nav-index="1"]').classes()).toContain('is-focused')

      delete window.__ztoolsFocusHomeSearch
      wrapper.unmount()
    })
  })

  describe('3. 破坏性与异常边界测试（Beyond Happy Path）', () => {
    it('空数据、null/undefined、负数索引、越界索引、0 索引及隐藏 inert 节点安全处理不崩溃', () => {
      expect(clusterVisualRows(null)).toEqual([])
      expect(clusterVisualRows([])).toEqual([])
      expect(buildFallbackRows(undefined)).toEqual([])
      expect(computeVisualNavStep([], 0, 'ArrowDown').moved).toBe(false)

      // 包含索引 0（严禁用 !item.index 误判过滤掉 0！）与畸形项
      const rows = clusterVisualRows([
        null,
        { index: -3, top: 0, left: 0, width: 100, height: 40 },
        { index: 0, top: 10, left: 10, width: 100, height: 40 },
        { index: 1, top: 12, left: 120, width: 100, height: 40 }
      ])
      expect(rows).toHaveLength(1)
      expect(rows[0].map((c) => c.index)).toEqual([0, 1])

      // 当前索引越界（如 999）时按键自动自愈落回首项 0
      const recovered = computeVisualNavStep(rows, 999, 'ArrowDown')
      expect(recovered.nextIndex).toBe(0)
      expect(recovered.moved).toBe(true)

      // DOM 中处于 [inert] 或 [aria-hidden="true"] 隐藏标签面板内的节点必须被排除
      const host = document.createElement('div')
      host.innerHTML = `
        <div>
          <div data-nav-index="0" data-nav-cols="2">可见0</div>
          <div data-nav-index="1" data-nav-cols="2">可见1</div>
        </div>
        <div inert>
          <div data-nav-index="0" data-nav-cols="2">隐藏占位0</div>
        </div>
        <div aria-hidden="true">
          <div data-nav-index="2" data-nav-cols="2">隐藏占位2</div>
        </div>
      `
      const collected = collectVisualRowsFromDOM(host, { totalCount: 2, fallbackColumns: 2 })
      expect(collected).toHaveLength(1)
      expect(collected[0].map((c) => c.index)).toEqual([0, 1])
    })
  })
})
