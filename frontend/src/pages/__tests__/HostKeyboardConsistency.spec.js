import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import Antd from 'ant-design-vue'

import List from '../List.vue'
import MyPage, { resetHomeLayoutCache } from '../MyPage.vue'
import SearchBar from '@/components/SearchBar.vue'
import LauncherBar from '@/components/LauncherBar.vue'
import { usePluginsStore } from '@/stores/plugins'
import { useCategoriesStore } from '@/stores/categories'
import { useUIStore } from '@/stores/ui'
import { _resetKeymapForTesting } from '@/utils/keymap'

const apiMocks = vi.hoisted(() => ({
  getCategories: vi.fn(),
  getMarketPlugins: vi.fn(),
  openPlugin: vi.fn(),
  batchCheckPlugins: vi.fn(),
  getDownloadSign: vi.fn(),
  installPluginNative: vi.fn()
}))

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/api/apiserver', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getCategories: apiMocks.getCategories,
    getMarketPlugins: apiMocks.getMarketPlugins,
    openPlugin: apiMocks.openPlugin,
    batchCheckPlugins: apiMocks.batchCheckPlugins,
    getDownloadSign: apiMocks.getDownloadSign,
    installPluginNative: apiMocks.installPluginNative
  }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

vi.mock('@edition', () => import('@/edition-oss/index.js'))

function pressKey(target, key, extra = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...extra
  })
  target.dispatchEvent(ev)
  return ev
}

describe('宿主工作台与悬浮条键盘方向键视觉一致性端到端集成测试', () => {
  let router
  let pluginsStore
  let categoriesStore
  let uiStore

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('断网隔离')))
    window.localStorage.clear()
    resetHomeLayoutCache()
    setActivePinia(createPinia())
    _resetKeymapForTesting()

    pluginsStore = usePluginsStore()
    categoriesStore = useCategoriesStore()
    uiStore = useUIStore()

    apiMocks.getCategories.mockResolvedValue([{ id: 1, name: '办公效率', pluginsCount: 6 }])
    apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })

    pluginsStore.$patch({
      favorites: new Set(),
      installedSet: new Set(['zip-tool', 'img-compress']),
      installedPlugins: [
        { pluginId: 'zip-tool', name: '解压与压缩', category: '办公效率' },
        { pluginId: 'img-compress', name: '图片压缩', category: '办公效率' }
      ],
      downloadingSet: new Set(),
      updateMap: {}
    })
    pluginsStore.loadWithCache = vi.fn((params) => apiMocks.getMarketPlugins(params))
    pluginsStore.countPluginsBySource = vi.fn().mockResolvedValue({ all: 6, official: 6, community: 0 })
    pluginsStore.fetchInstalledPlugins = vi.fn().mockResolvedValue([])
    pluginsStore.shouldCheckUpdate = vi.fn().mockReturnValue(false)
    pluginsStore.init = vi.fn().mockResolvedValue(undefined)
    pluginsStore.loadRecommendedPlugins = vi.fn().mockResolvedValue(undefined)
    pluginsStore.openPlugin = vi.fn().mockResolvedValue({ success: true })
    pluginsStore.toggleFavorite = vi.fn().mockResolvedValue(undefined)

    window.ztools = {
      analytics: { report: vi.fn() },
      events: { on: vi.fn(), off: vi.fn() },
      config: { get: vi.fn().mockResolvedValue('[]'), set: vi.fn().mockResolvedValue(true) },
      sys: { getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }) }
    }

    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'my', component: MyPage },
        { path: '/list/:category?', name: 'list', component: List, props: true },
        { path: '/details/:pluginId', name: 'details', component: { template: '<div />' } }
      ]
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _resetKeymapForTesting()
    delete window.ztools
    delete window.__ztoolsFocusHomeSearch
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('1. [H-01/H-04/H-06/H-10] 分类插件列表双列网格：上下左右严格对齐视觉行列、同行止步、首行按 ↑ 回搜索框、Ctrl+K 展开动作面板', async () => {
    // 复刻用户截图中的 6 张「办公效率」双列卡片
    const officeList = [
      { pluginId: 'zip-tool', name: '解压与压缩', category: '办公效率' },
      { pluginId: 'audio-conv', name: '音频转换', category: '办公效率' },
      { pluginId: 'img-compress', name: '图片压缩', category: '办公效率' },
      { pluginId: 'calculator', name: '计算器', category: '办公效率' },
      { pluginId: 'calendar', name: '日程日历', category: '办公效率' },
      { pluginId: 'invoice', name: '发票助手', category: '办公效率' }
    ]
    apiMocks.getMarketPlugins.mockResolvedValue({ list: officeList, total: 6 })

    await router.push({ name: 'list', params: { category: '办公效率' } })
    await router.isReady()

    let searchFocusedCount = 0
    window.__ztoolsFocusHomeSearch = () => {
      searchFocusedCount += 1
      uiStore.setSearchInputActive(true)
      uiStore.focusSearch()
    }

    const wrapper = mount(List, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          SkeletonCard: true,
          APagination: true
        }
      }
    })
    await flushPromises()
    categoriesStore.$patch({ loaded: true, loading: false, items: [{ id: 1, name: '办公效率' }] })
    await flushPromises()

    // 注入真实双列几何矩形（宽 336px，高 64px，每行 2 列）
    const navNodes = wrapper.findAll('[data-nav-index]')
    expect(navNodes).toHaveLength(6)
    navNodes.forEach((node, idx) => {
      const row = Math.floor(idx / 2)
      const col = idx % 2
      vi.spyOn(node.element, 'getBoundingClientRect').mockReturnValue({
        top: 80 + row * 76,
        bottom: 144 + row * 76,
        left: 200 + col * 348,
        right: 536 + col * 348,
        width: 336,
        height: 64
      })
    })

    // 初始聚焦在 [0]「解压与压缩」（第 1 行左列）
    expect(wrapper.vm.focusedCardIndex).toBe(0)

    // 按 ↓：必须直达正下方第 2 行左列 [2]「图片压缩」，绝不斜跳到 [3]「计算器」！
    const firstFavorite = navNodes[0].get('.card-icon-btn').element
    firstFavorite.focus()
    expect(document.activeElement).toBe(firstFavorite)
    pressKey(firstFavorite, 'ArrowDown')
    await nextTick()
    expect(wrapper.vm.focusedCardIndex).toBe(2)
    expect(document.activeElement).toBe(navNodes[2].element)
    expect(navNodes[0].get('.card-icon-btn').element.tabIndex).toBe(-1)
    expect(navNodes[2].get('.card-icon-btn').element.tabIndex).toBe(0)
    expect(navNodes.filter(node => node.element.tabIndex === 0)).toHaveLength(1)

    // 按 →：同排右移到 [3]「计算器」；再按 →（已在第 2 行末列）：原地止步留在 [3]，绝不折行跳到 [4]！
    pressKey(window, 'ArrowRight')
    await nextTick()
    expect(wrapper.vm.focusedCardIndex).toBe(3)

    pressKey(window, 'ArrowRight')
    await nextTick()
    expect(wrapper.vm.focusedCardIndex).toBe(3)

    // 从 [3]（第 2 行右列）按 ↑：回到第 1 行右列 [1]「音频转换」
    pressKey(window, 'ArrowUp')
    await nextTick()
    expect(wrapper.vm.focusedCardIndex).toBe(1)

    // 从第 1 行右列 [1] 再按 ↑：触发双向闭环回到顶栏搜索框，且绝不水平左跳到 [0]！
    pressKey(window, 'ArrowUp')
    await nextTick()
    expect(searchFocusedCount).toBe(1)
    expect(wrapper.vm.focusedCardIndex).toBe(1)
    // 搜索框激活期间卡片主焦点光环隐藏，消除双光环并存
    expect(wrapper.findAll('.is-list-card-focused')).toHaveLength(0)

    // 恢复网格焦点并按 Ctrl+K：弹出动作面板而非静默改收藏
    uiStore.focusGrid()
    await nextTick()
    expect(wrapper.findAll('.is-list-card-focused')).toHaveLength(1)

    pressKey(window, 'k', { ctrlKey: true })
    await nextTick()
    expect(wrapper.find('.action-panel-scrim').exists()).toBe(true)
    expect(pluginsStore.toggleFavorite).not.toHaveBeenCalled()

    // 在动作面板打开时按 Esc：仅关闭动作面板，不误回主页
    pressKey(window, 'Escape')
    await nextTick()
    expect(wrapper.find('.action-panel-scrim').exists()).toBe(false)

    wrapper.unmount()
  })

  it('2. [H-02 & H-09] 顶栏 SearchBar 与主页 MyPage 协同：搜索框 ←/→/Delete 零穿透，三区块上下贯通', async () => {
    pluginsStore.$patch({
      installedSet: new Set(['p1', 'p2']),
      installedPlugins: [
        { pluginId: 'p1', name: '插件一' },
        { pluginId: 'p2', name: '插件二' }
      ],
      recents: ['p1'],
      recommendedItems: [
        { pluginId: 'rec1', name: '推荐插件一' },
        { pluginId: 'rec2', name: '推荐插件二' }
      ]
    })
    const uninstallSpy = vi.spyOn(pluginsStore, 'uninstallPlugin')

    await router.push('/')
    await router.isReady()

    const searchText = ref('测试词')
    const WorkbenchShell = defineComponent({
      setup() {
        return () =>
          h('div', [
            h(SearchBar, {
              modelValue: searchText.value,
              'onUpdate:modelValue': (v) => {
                searchText.value = v
              }
            }),
            h(MyPage)
          ])
      }
    })

    const wrapper = mount(WorkbenchShell, {
      attachTo: document.body,
      global: { plugins: [router, Antd] }
    })
    await flushPromises()

    const searchInput = wrapper.find('.rc-search-input input').element
    searchInput.focus()
    await nextTick()
    expect(uiStore.isSearchInputActive).toBe(true)

    // 在非空搜索框内按 ArrowRight / Delete：光标与删字不被 PAGE 劫持，不移动底下磁贴、不触发卸载！
    const rightEv = pressKey(searchInput, 'ArrowRight')
    const delEv = pressKey(searchInput, 'Delete')
    expect(rightEv.defaultPrevented).toBe(false)
    expect(delEv.defaultPrevented).toBe(false)
    expect(uninstallSpy).not.toHaveBeenCalled()

    // 先按 Escape 收起非空词展开的下拉候选（或清空后按 ArrowDown），验证两种路径均可顺畅移交网格
    pressKey(searchInput, 'Escape')
    await nextTick()
    expect(uiStore.isGridFocused).toBe(true)
    expect(uiStore.isSearchInputActive).toBe(false)

    // 再次聚焦并清空搜索词（下拉未展开态），按 ArrowDown 直接将焦点移交至下方网格
    searchText.value = ''
    await nextTick()
    searchInput.focus()
    await nextTick()
    pressKey(searchInput, 'ArrowDown')
    await nextTick()
    expect(uiStore.isGridFocused).toBe(true)
    expect(uiStore.isSearchInputActive).toBe(false)

    // 从第 1 区块磁贴(0,1 同排) 按 ↓ -> 进入第 2 区块「最近使用」(索引 2) -> 再按 ↓ -> 进入第 3 区块「热门推荐」(索引 3)
    const myPageVm = wrapper.findComponent(MyPage).vm
    expect(myPageVm.focusedCardIndex).toBe(0)

    pressKey(window, 'ArrowDown')
    await nextTick()
    expect(myPageVm.focusedCardIndex).toBe(2)
    expect(wrapper.find('.recent-row.is-recent-focused').exists()).toBe(true)

    pressKey(window, 'ArrowDown')
    await nextTick()
    expect(myPageVm.focusedCardIndex).toBe(3)

    wrapper.unmount()
  })

  it('3. [H-03 & H-09] 极客悬浮条 LauncherBar：打开 ActionPanelModal 时 ↑/↓/Enter 完全隔离不串台', async () => {
    await router.push('/')
    await router.isReady()

    const wrapper = mount(LauncherBar, {
      attachTo: document.body,
      global: { plugins: [router] }
    })
    await flushPromises()

    const beforeActiveIdx = wrapper.vm.activeIndex
    expect(beforeActiveIdx).toBe(0)

    // 按 Ctrl+K 呼出动作面板
    pressKey(window, 'k', { ctrlKey: true })
    await flushPromises()
    expect(wrapper.find('.action-panel-scrim').exists()).toBe(true)

    // 按 ArrowDown：移动的是动作面板内的选中项，背后 LauncherBar 的 activeIndex 严禁被篡改！
    pressKey(window, 'ArrowDown')
    await nextTick()
    expect(wrapper.vm.activeIndex).toBe(0)
    const actionItems = wrapper.findAll('.action-panel-item')
    if (actionItems.length > 1) {
      expect(actionItems[1].classes()).toContain('is-selected')
    }

    wrapper.unmount()
  })
})
