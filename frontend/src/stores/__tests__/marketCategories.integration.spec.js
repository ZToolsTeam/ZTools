import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import PluginDetailHeader from '@/pages/details-components/PluginDetailHeader.vue'
import List from '@/pages/List.vue'
import { getCategories, getMarketPlugins } from '@/api/plugins'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
import { getBundledPluginEntries } from '@/utils/bundledPlugins'
import { loadV2StaticCatalogList } from '@/api/pluginCatalog'

// 复现线上目录的不同格式；仅替换网络，分类 API、内置清单、Pinia 和市场筛选均使用真实模块。
const entries = [
  { id: 'batch-rename', category: 'utility' },
  { id: 'browser-history', category: 'browser' },
  { id: 'network-adapter', category: 'system' },
  { id: 'mixed-media-test', category: ['图像媒体', '办公效率'] },
  { id: 'design-test', category: ['媒体处理', '设计工具', '图像媒体'] },
  { id: 'text-test', category: '办公效率 / 文本工具' },
  { id: 'efficiency-test', category: ['productivity', '效率工具'] },
  { id: 'missing-test', category: [] },
  { id: 'invalid-test', category: [null, 42, {}, '   '] },
  { id: 'unknown-test', category: '__proto__' },
  { id: 'draft-test', category: 'AI工具', draft: true },
  { id: 'revoked-test', category: 'AI工具', revoked: true }
]

describe('市场分类从 CDN、本地快照和内置清单到筛选与统计', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plugins: entries }))))
    await loadV2StaticCatalogList({ forceRefresh: true })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('宿主已安装列表的数组和旧别名转换为展示文字，并保留实际安装版本和状态', async () => {
    const local = [
      { pluginId: 'local-system', name: '本地插件', category: ['system', '系统工具'], version: '1.0.0', enabled: false, lastUsedTime: 100 },
      { pluginId: 'local-mixed', category: 'utility / media', version: '2.0.0' },
      { pluginId: 'local-invalid', category: [null, 42, {}] }
    ]
    const original = structuredClone(local)
    vi.stubGlobal('ztools', { plugin: { getList: vi.fn().mockResolvedValue({ data: local }) } })
    const store = usePluginsStore()
    await store.fetchInstalledPlugins()
    expect(store.installedPlugins.find(({ pluginId }) => pluginId === 'local-system')).toMatchObject({
      ...original[0], category: '系统工具'
    })
    expect(store.installedPlugins.find(({ pluginId }) => pluginId === 'local-mixed').category).toBe('办公效率 / 图像媒体')
    expect(store.installedPlugins.find(({ pluginId }) => pluginId === 'local-invalid').category).toBe('')
    expect(store.installedSet.has('local-system')).toBe(true)
    expect(local).toEqual(original)
    await flushPromises()
  })

  it('别名归一、组合分类拆分、重复计数消除；未分类插件可从分组页找到', async () => {
    const categories = await getCategories()
    expect(categories.map(({ name }) => name)).toEqual(['办公效率', '系统工具', '图像媒体', '网络工具', '其他工具'])
    const manager = new StoreCatalogManager({
      fetchRemote: () => getMarketPlugins({ per_page: 100 }),
      getOfficialList: () => []
    })
    const { catalog } = await manager.ensureCatalog()
    const store = usePluginsStore()
    store._updateCategoryCounts(catalog)
    for (const category of categories) {
      const result = await manager.query({ category: category.name, pageSize: 100 })
      expect(result.total, category.name).toBe(category.pluginsCount)
      expect(store.categoryCounts[category.name], category.name).toBe(result.total)
    }
    expect((await manager.query({ category: '网络工具' })).list.map(({ id }) => id)).toEqual(['browser-history'])
    expect((await manager.query({ category: '系统工具' })).list.map(({ id }) => id)).toEqual(['network-adapter'])
    expect((await manager.query({ category: '其他工具' })).total).toBe(3)
    expect((await getMarketPlugins({ category: 'browser' })).list.map(({ id }) => id)).toEqual(['browser-history'])
    expect((await manager.query({ category: '图像媒体' })).total).toBe(2)
  })

  it('真实内置多分类插件参与同一导航，不再制造斜杠分类或数组字符串', async () => {
    const store = useCategoriesStore()
    const categories = await store.fetchCategories(true)
    const names = categories.map(({ name }) => name)
    expect(names.every((name) => !/[\/·]/.test(name))).toBe(true)
    expect(names).not.toContain('效率工具')
    expect(names).not.toContain('设计工具')
    const bundled = getBundledPluginEntries()
    expect(bundled.find(({ id }) => id === 'translator').category).toBe('办公效率')
    for (const entry of bundled) {
      for (const name of entry.category.split(' / ')) expect(names, entry.id).toContain(name)
    }
  })

  it('断网读取旧快照仍使用相同分类，不遗留英文标签与复合分类', async () => {
    const manager = new StoreCatalogManager({
      fetchRemote: async () => { throw new Error('离线') },
      getLocalSnapshot: async () => entries.filter((entry) => !entry.draft && !entry.revoked),
      getOfficialList: () => []
    })
    const result = await manager.ensureCatalog()
    expect(result.isFallback).toBe(true)
    expect((await manager.query({ category: '办公效率' })).total).toBe(4)
    expect((await manager.query({ category: '网络工具' })).total).toBe(1)
    expect(result.catalog.every((entry) => Array.isArray(entry.category))).toBe(true)
  })

  it('详情标签将目录数组显示为中文文字，不能渲染 JSON 数组', async () => {
    const { list } = await getMarketPlugins({ ids: ['mixed-media-test'] })
    const wrapper = mount(PluginDetailHeader, {
      props: { plugin: { ...list[0], name: '批量音频' } },
      global: { stubs: { PluginActions: true, RcSquircle: true } }
    })
    try {
      expect(wrapper.find('.plugin-tags .tag').text()).toBe('图像媒体 · 办公效率')
    } finally { wrapper.unmount() }
  })

  it('离线的全部页面仍展示快照中的 AI 与未分类插件，并提供可用分类入口', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('断网')))
    const snapshot = [
      { id: 'offline-ai', name: '离线 AI 插件', category: 'AI工具' },
      { id: 'offline-unknown', name: '离线未分类插件', category: [] }
    ]
    const manager = new StoreCatalogManager({
      fetchRemote: () => getMarketPlugins(),
      getLocalSnapshot: async () => snapshot,
      getOfficialList: () => []
    })
    const plugins = usePluginsStore()
    plugins._getCatalogManager = () => manager
    vi.spyOn(plugins, 'fetchInstalledPlugins').mockResolvedValue([])
    vi.spyOn(plugins, 'shouldCheckUpdate').mockReturnValue(false)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/list/:category?', name: 'list', component: List }] })
    await router.push('/list')
    const wrapper = mount(List, { global: {
      plugins: [router],
      stubs: { PluginCard3D: { props: ['plugin'], template: '<article>{{ plugin.name }}</article>' }, SkeletonCard: true, APagination: true, AButton: true }
    } })
    try {
      await flushPromises()
      expect(wrapper.findAll('article').map((item) => item.text())).toEqual(['离线 AI 插件', '离线未分类插件'])
      const chips = wrapper.findAll('.market-chip')
      expect(chips.map((chip) => chip.text())).toEqual(['全部', 'AI工具', '其他工具'])
      await chips.find((chip) => chip.text() === '其他工具').trigger('click')
      await flushPromises()
      expect(wrapper.findAll('article').map((item) => item.text())).toEqual(['离线未分类插件'])
      expect(wrapper.text()).toContain('共 1 个')
    } finally { wrapper.unmount() }
  })
})
