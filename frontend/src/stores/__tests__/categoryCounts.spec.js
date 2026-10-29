import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePluginsStore } from '@/stores/plugins'

describe('插件 store 分类计数', () => {
  let store
  beforeEach(() => {
    setActivePinia(createPinia())
    store = usePluginsStore()
  })

  it('按分类统计，一个插件属于多个分类时每个分类各算一次，重复分类只算一次', () => {
    store._updateCategoryCounts([
      { pluginId: 'a', category: '办公效率' },
      { pluginId: 'b', category: ['办公效率', '系统工具', '办公效率'] },
      { pluginId: 'c', category: '媒体处理' }
    ])
    expect(store.categoryCounts).toEqual({ 办公效率: 2, 系统工具: 1, 图像媒体: 1 })
  })

  it('[破坏性] 已下架插件不计；空值、缺分类、非字符串分类不崩溃也不计', () => {
    store.revokedMap = { gone: { revoked: true } }
    store.isRevoked = (id) => id === 'gone'
    store._updateCategoryCounts([null, undefined, { pluginId: 'gone', category: '办公效率' }, { pluginId: 'x' }, { pluginId: 'y', category: 42 }, { pluginId: 'z', category: [null, ''] }])
    expect(store.categoryCounts).toEqual({})
    // 非数组目录忽略，不覆盖上次结果
    store._updateCategoryCounts('broken')
    expect(store.categoryCounts).toEqual({})
  })

  it('统计结果出来前全部显示；之后只显示有插件的分类，「全部」与正在查看的分类始终显示', () => {
    expect(store.isCategoryVisible('安全工具')).toBe(true)
    store.categoryCounts = { 办公效率: 6 }
    expect(store.isCategoryVisible('办公效率')).toBe(true)
    expect(store.isCategoryVisible('安全工具')).toBe(false)
    expect(store.isCategoryVisible('全部')).toBe(true)
    expect(store.isCategoryVisible('安全工具', '安全工具')).toBe(true)
  })

  it('[破坏性] 拉取目录失败时保留全部分类，不抛错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store._getCatalogManager = () => ({ ensureCatalog: () => Promise.reject(new Error('断网')) })
    await expect(store.refreshCategoryCounts()).resolves.toBeNull()
    expect(store.isCategoryVisible('系统工具')).toBe(true)
    warn.mockRestore()
  })

  it('各来源插件数：在真实目录上按分类与搜索词统计，官方与社区互斥、合计等于全部', async () => {
    const { StoreCatalogManager } = await import('@/utils/storeCatalogManager')
    const catalog = [
      { pluginId: 'a', name: '官方甲', author: 'ZTools Team', category: '系统工具', targets: [] },
      { pluginId: 'b', name: '社区乙', author: 'someone', source_type: 'community', category: '系统工具' },
      { pluginId: 'c', name: '社区丙', author: 'other', source_type: 'community', category: '办公效率' }
    ]
    const manager = new StoreCatalogManager({ fetchRemote: async () => ({ list: catalog }), getLocalSnapshot: async () => [], getOfficialList: () => [] })
    store._getCatalogManager = () => manager
    const all = await store.countPluginsBySource({})
    expect(all.all).toBe(all.official + all.community)
    const sys = await store.countPluginsBySource({ category: '系统工具' })
    expect(sys.all).toBe(sys.official + sys.community)
    expect(sys.community).toBeGreaterThanOrEqual(1)
    const none = await store.countPluginsBySource({ keyword: '不存在的插件名' })
    expect(none).toEqual({ all: 0, official: 0, community: 0 })
  })

  it('[异常] 目录不可用时抛出，由调用方决定不显示数量', async () => {
    store._getCatalogManager = () => ({ query: vi.fn().mockRejectedValue(new Error('目录不可用')) })
    await expect(store.countPluginsBySource({ category: '系统工具' })).rejects.toThrow('目录不可用')
  })
})
