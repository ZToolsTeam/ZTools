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
    expect(store.categoryCounts).toEqual({ 办公效率: 2, 系统工具: 1, 媒体处理: 1 })
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
})
