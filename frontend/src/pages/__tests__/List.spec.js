import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import List from '../List.vue'
import { usePluginsStore } from '@/stores/plugins'

const apiMocks = vi.hoisted(() => ({
  getCategories: vi.fn(),
  getMarketPlugins: vi.fn(),
  openPlugin: vi.fn(),
  batchCheckPlugins: vi.fn(),
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
  getDownloadSign: apiMocks.getDownloadSign,
  installPluginNative: apiMocks.installPluginNative,
  isPluginVersionIncompatibleError: () => false,
  getPluginVersionIncompatibleMessage: (e) => e?.message || ''
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

// 公共列表页按开源版行为测试（两种仓库里结果一致）；官方版的登录拦截由版本扩展自行测试
vi.mock('@edition', () => import('@/edition-oss/index.js'))

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

const EXPECTED_CATEGORIES = ['办公效率', '系统工具', '图像媒体', '开发工具', '网络工具', 'AI工具', '安全隐私', '金融理财', '其他工具']

describe('List page', () => {
  let wrapper
  let router
  let pluginsStore

  beforeEach(async () => {
    // 兜底断开真实网络，防止任何遗漏的路径在测试中访问 CDN
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试环境断网')))
    window.localStorage.clear()
    setActivePinia(createPinia())
    pluginsStore = usePluginsStore()
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset()
    }
    apiMocks.getCategories.mockResolvedValue([])
    apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })
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

  it('开源版没有账号：安装不要求登录，直接安装并上报点击', async () => {
    pluginsStore.installPlugin = vi.fn().mockResolvedValue(undefined)
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

    expect(toastSpies.toastError).not.toHaveBeenCalledWith('请先登录后下载插件')
    expect(pluginsStore.installPlugin).toHaveBeenCalledWith('public-plugin', { autoOpen: true })
    // 开源版不上报使用统计
    expect(window.ztools.analytics.report).not.toHaveBeenCalled()
  })

  it('[故障] 开源版安装返回 401 / need_login 时按普通失败提示，不走登录流程', async () => {
    for (const err of [
      Object.assign(new Error('Unauthorized'), { status: 401 }),
      Object.assign(new Error('需要登录'), { need_login: true })
    ]) {
      toastSpies.toastError.mockClear()
      pluginsStore.installPlugin = vi.fn().mockRejectedValue(err)
      wrapper?.unmount()
      wrapper = mount(List, {
        global: {
          plugins: [router],
          stubs: { PluginCard3D: true, SkeletonCard: true, APagination: true, AButton: true }
        }
      })
      await flushPromises()

      await wrapper.vm.handleDownload('public-plugin')

      expect(toastSpies.toastError).toHaveBeenCalledWith('安装失败: ' + err.message)
      expect(toastSpies.toastWarning).not.toHaveBeenCalledWith(err.message)
    }
  })

  it('开源版安装中途失败（如 CDN 不可用）时提示原因且不弹登录框', async () => {
    pluginsStore.installPlugin = vi.fn().mockRejectedValue(new Error('插件目录暂不可用'))
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: { PluginCard3D: true, SkeletonCard: true, APagination: true, AButton: true }
      }
    })
    await flushPromises()

    await wrapper.vm.handleDownload('public-plugin')

    expect(toastSpies.toastError).toHaveBeenCalledWith('安装失败: 插件目录暂不可用')
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
    expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(EXPECTED_CATEGORIES.length)
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

    await wrapper.findAll('.category-view-all-btn')[1].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.category).toBe('系统工具')
  })

  it('分类概览下键盘焦点按页面展示顺序移动，Enter 打开焦点插件不报错', async () => {
    apiMocks.getCategories.mockResolvedValue([
      { id: 1, name: '系统工具', slug: 'system', pluginsCount: 3 },
      { id: 2, name: '办公效率', slug: 'office', pluginsCount: 2 }
    ])
    apiMocks.getMarketPlugins.mockImplementation(({ category }) => {
      if (category === '系统工具') {
        return Promise.resolve({
          list: Array.from({ length: 3 }, (_, i) => ({ pluginId: `system-${i + 1}`, name: `系统插件 ${i + 1}`, category })),
          total: 3
        })
      }
      if (category === '办公效率') {
        return Promise.resolve({
          list: [
            { pluginId: 'office-1', name: '办公插件 1', category },
            { pluginId: 'installed-plugin', name: '已装插件', category }
          ],
          total: 2
        })
      }
      return Promise.resolve({ list: [], total: 0 })
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await router.push({ name: 'list' })
    wrapper = mount(List, {
      global: {
        plugins: [router],
        stubs: {
          PluginCard3D: { props: ['plugin'], template: '<article class="plugin-card-stub">{{ plugin.name }}</article>' },
          SkeletonCard: true,
          APagination: true,
          AButton: true
        }
      }
    })
    await flushPromises()

    // 键盘导航列表 = 概览里实际渲染的卡片（按分类顺序展开），不再引用未定义变量
    expect(wrapper.vm.currentDisplayList.map((p) => p.pluginId)).toEqual([
      'office-1', 'installed-plugin', 'system-1', 'system-2', 'system-3'
    ])
    expect(wrapper.vm.previewFlatIndex(1, 1)).toBe(3)

    // 焦点高亮落在跨分类的正确卡片上
    wrapper.vm.focusedCardIndex = 1
    await flushPromises()
    const focused = wrapper.findAll('.is-list-card-focused')
    expect(focused).toHaveLength(1)
    expect(focused[0].text()).toBe('已装插件')

    // 越界下标：Enter 时取不到插件，不抛异常
    wrapper.vm.focusedCardIndex = 99
    await flushPromises()
    expect(wrapper.findAll('.is-list-card-focused')).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('isOverviewMode'), expect.anything())
    errorSpy.mockRestore()
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
    // 远端与本地共用固定的中文分类顺序
    expect(chips.map((c) => c.text())).toEqual(['全部', ...EXPECTED_CATEGORIES])
    expect(chips[0].classes()).toContain('is-on')

    await chips[2].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.category).toBe('系统工具')
    expect(wrapper.find('.market-title').text()).toBe('系统工具')
    expect(wrapper.findAll('.market-chip')[2].attributes('aria-pressed')).toBe('true')

    await router.push({ name: 'list', query: { q: 'json' } })
    await flushPromises()
    expect(wrapper.find('.market-title').text()).toBe('搜索「json」')
  })
})

