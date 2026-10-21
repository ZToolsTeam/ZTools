import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import List from '../List.vue'
import { getBundledPluginEntries } from '@/utils/bundledPlugins'
import { usePluginsStore } from '@/stores/plugins'
import { useUIStore } from '@/stores/ui'

const apiMocks = vi.hoisted(() => ({
  getCategories: vi.fn(),
  getMarketPlugins: vi.fn(),
  openPlugin: vi.fn(),
  batchCheckPlugins: vi.fn(),
  isAuthenticated: vi.fn(),
  getDownloadSign: vi.fn(),
  installPluginNative: vi.fn()
}))

const toastSpies = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/api/apiserver', () => ({
  getCategories: apiMocks.getCategories,
  getMarketPlugins: apiMocks.getMarketPlugins,
  openPlugin: apiMocks.openPlugin,
  batchCheckPlugins: apiMocks.batchCheckPlugins,
  isAuthenticated: apiMocks.isAuthenticated,
  getDownloadSign: apiMocks.getDownloadSign,
  installPluginNative: apiMocks.installPluginNative
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/list/:category?',
        name: 'list',
        component: List
      }
    ]
  })
}

const LOCAL_CATEGORY_NAMES = [...new Set(getBundledPluginEntries().map((e) => e.category).filter(Boolean))]
  .filter((name) => !['系统工具', '办公效率'].includes(name))

describe('List page', () => {
  let wrapper
  let router
  let pluginsStore
  let uiStore

  beforeEach(async () => {
    // 兜底断开真实网络，防止任何遗漏的路径在测试中访问 CDN
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试环境断网')))
    window.localStorage.clear()
    setActivePinia(createPinia())
    pluginsStore = usePluginsStore()
    uiStore = useUIStore()
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset()
    }
    apiMocks.getCategories.mockResolvedValue([])
    apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })
    apiMocks.isAuthenticated.mockResolvedValue(false)
    pluginsStore.$patch({
      favorites: new Set(),
      installedSet: new Set(['installed-plugin']),
      installedPlugins: [{ pluginId: 'installed-plugin', version: '1.0.0' }],
      downloadingSet: new Set(),
      updateMap: {}
    })
    // List 只依赖 store.loadWithCache（目录拉取 / 本地筛选分页由 StoreCatalogManager 负责，另有测试覆盖），
    // 这里把边界接到 apiMocks.getMarketPlugins 上，断言 List 传出的查询参数与竞态处理
    pluginsStore.loadWithCache = vi.fn((params) => apiMocks.getMarketPlugins(params))
    pluginsStore.fetchInstalledPlugins = vi.fn().mockResolvedValue([])
    pluginsStore.shouldCheckUpdate = vi.fn().mockReturnValue(false)

    window.ztools = {
      analytics: {
        report: vi.fn()
      },
      events: {
        on: vi.fn(),
        off: vi.fn()
      }
    }

    router = createTestRouter()
    await router.push({
      name: 'list',
      params: { category: 'tools' },
      query: { q: 'old' }
    })
    await router.isReady()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (wrapper) {
      wrapper.unmount()
      wrapper = null
    }
    delete window.ztools
    vi.clearAllMocks()
  })

  it('keeps the latest search results when older requests resolve later', async () => {
    const firstRequest = createDeferred()
    const secondRequest = createDeferred()

    apiMocks.getMarketPlugins
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise)

    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: true,
          SkeletonCard: true,
          APagination: true,
          AButton: true
        }
      }
    })

    await flushPromises()
    expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(1)
    expect(apiMocks.getMarketPlugins).toHaveBeenLastCalledWith({
      category: 'tools',
      page: 1,
      per_page: 20,
      sourceType: 'all',
      keyword: 'old'
    })

    await router.push({
      name: 'list',
      params: { category: 'tools' },
      query: { q: 'new' }
    })
    await flushPromises()

    expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(2)
    expect(apiMocks.getMarketPlugins).toHaveBeenLastCalledWith({
      category: 'tools',
      page: 1,
      per_page: 20,
      sourceType: 'all',
      keyword: 'new'
    })

    secondRequest.resolve({
      list: [{ pluginId: 'new-plugin', name: 'New Plugin' }],
      total: 1
    })
    await flushPromises()

    expect(wrapper.vm.items).toEqual([
      { pluginId: 'new-plugin', name: 'New Plugin' }
    ])
    expect(wrapper.vm.total).toBe(1)

    firstRequest.resolve({
      list: [{ pluginId: 'old-plugin', name: 'Old Plugin' }],
      total: 1
    })
    await flushPromises()

    expect(wrapper.vm.items).toEqual([
      { pluginId: 'new-plugin', name: 'New Plugin' }
    ])
    expect(wrapper.vm.total).toBe(1)
  })

  it('未登录时所有插件都阻止下载并打开登录框', async () => {
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: true,
          SkeletonCard: true,
          APagination: true,
          AButton: true
        }
      }
    })
    await flushPromises()

    await wrapper.vm.handleDownload('public-plugin')

    expect(uiStore.showLoginModal).toBe(true)
    expect(toastSpies.toastError).toHaveBeenCalledWith('请先登录后下载插件')
    expect(apiMocks.getDownloadSign).not.toHaveBeenCalled()
    expect(window.ztools.analytics.report).not.toHaveBeenCalledWith(
      'plugin_clickinstall',
      'public-plugin'
    )
  })

  it('全部插件页按分类展示前 8 个并显示真实总数', async () => {
    apiMocks.getCategories.mockResolvedValue([
      {
        id: 1,
        name: '系统工具',
        slug: 'system',
        pluginsCount: 12
      },
      {
        id: 2,
        name: '办公效率',
        slug: 'office',
        pluginsCount: 2
      }
    ])
    apiMocks.getMarketPlugins.mockImplementation(({ category }) => {
      if (category === '系统工具') {
        return Promise.resolve({
          list: Array.from({ length: 8 }, (_, index) => ({
            pluginId: `system-${index + 1}`,
            name: `系统插件 ${index + 1}`,
            category
          })),
          total: 12
        })
      }
      if (category === '办公效率') {
        return Promise.resolve({
          list: [
            { pluginId: 'office-1', name: '办公插件 1', category },
            { pluginId: 'office-2', name: '办公插件 2', category }
          ],
          total: 2
        })
      }
      return Promise.resolve({ list: [], total: 0 })
    })

    await router.push({ name: 'list' })
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: {
            props: ['plugin'],
            template:
              '<article class="plugin-card-stub">{{ plugin.name }}</article>'
          },
          SkeletonCard: true,
          APagination: true,
          AButton: {
            template:
              '<button class="view-all-stub" @click="$emit(\'click\')"><slot /></button>'
          }
        }
      }
    })
    await flushPromises()

    // 远端 2 个分类 + 内置插件补上的分类，各取一次预览
    expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(2 + LOCAL_CATEGORY_NAMES.length)
    expect(apiMocks.getMarketPlugins).toHaveBeenCalledWith({
      category: '系统工具',
      page: 1,
      per_page: 8
    })
    expect(apiMocks.getMarketPlugins).toHaveBeenCalledWith({
      category: '办公效率',
      page: 1,
      per_page: 8
    })
    expect(wrapper.vm.previewGroups).toHaveLength(2)
    expect(wrapper.findAll('.plugin-card-stub')).toHaveLength(10)
    expect(wrapper.text()).toContain('共 14 个')
    expect(wrapper.text()).toContain('系统工具')
    expect(wrapper.text()).toContain('12')
    expect(wrapper.text()).toContain('办公效率')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.findAll('.category-view-all-btn')).toHaveLength(2)

    await wrapper.findAll('.category-view-all-btn')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.category).toBe('系统工具')
  })

  it('全部插件搜索结果保持相关性顺序并使用普通分页', async () => {
    apiMocks.getCategories.mockResolvedValue([
      { id: 1, name: '系统工具', pluginsCount: 10 },
      { id: 2, name: '办公效率', pluginsCount: 10 }
    ])
    apiMocks.getMarketPlugins.mockResolvedValue({
      list: [
        {
          pluginId: 'best-match',
          name: '最佳匹配',
          category: '办公效率'
        },
        {
          pluginId: 'second-match',
          name: '次要匹配',
          category: '系统工具'
        }
      ],
      total: 51
    })

    await router.push({ name: 'list', query: { q: '匹配' } })
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: {
            props: ['plugin'],
            template:
              '<article class="plugin-card-stub">{{ plugin.name }}</article>'
          },
          SkeletonCard: true,
          APagination: {
            template: '<div class="pagination-stub"></div>'
          },
          AButton: true
        }
      }
    })
    await flushPromises()

    expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(1)
    expect(apiMocks.getMarketPlugins).toHaveBeenCalledWith({
      category: '',
      page: 1,
      per_page: 20,
      sourceType: 'all',
      keyword: '匹配'
    })
    expect(wrapper.vm.previewGroups).toEqual([])
    expect(wrapper.findAll('.plugin-card-stub').map((item) => item.text())).toEqual([
      '最佳匹配',
      '次要匹配'
    ])
    expect(wrapper.find('.pagination-stub').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('查看全部')

    await wrapper.vm.handlePaginationChange(2, 10)
    await flushPromises()
    expect(wrapper.vm.page).toBe(1)
    expect(wrapper.vm.pageSize).toBe(10)
    expect(window.localStorage.getItem('ztools_market_page_size')).toBe('10')
    expect(apiMocks.getMarketPlugins).toHaveBeenLastCalledWith({
      category: '',
      page: 1,
      per_page: 10,
      sourceType: 'all',
      keyword: '匹配'
    })
  })

  it('分类恰好 10 个插件时仍显示分页容量选择器', async () => {
    apiMocks.getMarketPlugins.mockResolvedValue({
      list: Array.from({ length: 10 }, (_, index) => ({
        pluginId: `media-${index + 1}`,
        name: `媒体插件 ${index + 1}`,
        category: '媒体处理'
      })),
      total: 10
    })

    await router.push({
      name: 'list',
      params: { category: '媒体处理' }
    })
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: true,
          SkeletonCard: true,
          APagination: {
            template: '<div class="pagination-stub"></div>'
          },
          AButton: true
        }
      }
    })
    await flushPromises()

    expect(wrapper.vm.pageSize).toBe(20)
    expect(wrapper.vm.total).toBe(10)
    expect(wrapper.find('.pagination-stub').exists()).toBe(true)
  })

  it('重新打开列表页时恢复上次选择的分页容量', async () => {
    window.localStorage.setItem('ztools_market_page_size', '50')
    apiMocks.getMarketPlugins.mockResolvedValue({
      list: [],
      total: 1
    })

    await router.push({
      name: 'list',
      params: { category: '系统工具' }
    })
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: true,
          SkeletonCard: true,
          APagination: true,
          AButton: true
        }
      }
    })
    await flushPromises()

    expect(wrapper.vm.pageSize).toBe(50)
    expect(apiMocks.getMarketPlugins).toHaveBeenLastCalledWith({
      category: '系统工具',
      page: 1,
      per_page: 50,
      sourceType: 'all',
      keyword: ''
    })
  })

  it('页头显示「插件市场」，页面内分类筛选与侧栏同一导航，并随分类 / 搜索切换标题', async () => {
    apiMocks.getCategories.mockResolvedValue([
      { id: 1, name: '系统工具', pluginsCount: 1 },
      { id: 2, name: '办公效率', pluginsCount: 1 }
    ])
    await router.push({ name: 'list' })
    wrapper = mount(List, {
      global: { plugins: [router], stubs: { PluginCard3D: true, SkeletonCard: true, APagination: true, AButton: true } }
    })
    await flushPromises()

    expect(wrapper.find('.market-title').text()).toBe('插件市场')
    const chips = wrapper.findAll('.market-chip')
    // 远端分类在前，随后是内置插件用到、远端没有的分类
    expect(chips.map((c) => c.text())).toEqual(['全部', '系统工具', '办公效率', ...LOCAL_CATEGORY_NAMES])
    expect(chips[0].classes()).toContain('is-on')

    await chips[1].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.category).toBe('系统工具')
    expect(wrapper.find('.market-title').text()).toBe('系统工具')
    expect(wrapper.findAll('.market-chip')[1].attributes('aria-pressed')).toBe('true')

    await router.push({ name: 'list', query: { q: 'json' } })
    await flushPromises()
    expect(wrapper.find('.market-title').text()).toBe('搜索「json」')
  })
})

