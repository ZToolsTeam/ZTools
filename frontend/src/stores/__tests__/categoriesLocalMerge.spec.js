import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiMock = vi.hoisted(() => ({ getCategories: vi.fn() }))
vi.mock('@/api/apiserver', () => apiMock)

import { useCategoriesStore, mergeLocalCategories } from '@/stores/categories'
import { getBundledPluginEntries } from '@/utils/bundledPlugins'

const REMOTE = [
  { id: 1, name: '系统工具', slug: 'system' },
  { id: 2, name: '办公效率', slug: 'office' },
  { id: 3, name: '媒体处理', slug: 'media' },
  { id: 6, name: '安全工具', slug: 'security' }
]
const localNames = () => [...new Set(getBundledPluginEntries().map((e) => e.category).filter(Boolean))]

describe('分类列表补上内置插件用到的分类', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.getCategories.mockReset()
  })

  it('[回归] 远端分类与内置插件分类对不上时，补上内置插件的分类，每个内置插件都有分类可归', async () => {
    apiMock.getCategories.mockResolvedValue(REMOTE)
    const store = useCategoriesStore()
    await store.fetchCategories(true)
    const names = store.items.map((c) => c.name)
    expect(names.slice(0, 4)).toEqual(REMOTE.map((c) => c.name))
    for (const name of localNames()) expect(names).toContain(name)
    for (const entry of getBundledPluginEntries()) expect(names, entry.pluginId).toContain(entry.category)
    // 侧栏有图标，不出现重复
    expect(new Set(names).size).toBe(names.length)
    expect(store.sidebarCategories.find((c) => c.name === '开发工具')?.icon).toBe('fa-code')
  })

  it('[破坏性] 远端分类接口失败或返回空时，回退分类之外同样补上内置插件分类', async () => {
    for (const behave of [() => apiMock.getCategories.mockRejectedValueOnce(new Error('500')), () => apiMock.getCategories.mockResolvedValueOnce([]), () => apiMock.getCategories.mockResolvedValueOnce(null)]) {
      setActivePinia(createPinia())
      behave()
      const store = useCategoriesStore()
      await store.fetchCategories(true)
      const names = store.items.map((c) => c.name)
      for (const name of localNames()) expect(names).toContain(name)
      expect(store.loaded).toBe(true)
    }
  })

  it('远端已有同名分类时不重复添加；坏数据不崩溃', () => {
    const merged = mergeLocalCategories([...REMOTE, { id: 9, name: '开发工具' }])
    expect(merged.filter((c) => c.name === '开发工具')).toHaveLength(1)
    expect(merged.find((c) => c.name === '开发工具').id).toBe(9)
    expect(() => mergeLocalCategories(null)).not.toThrow()
    expect(mergeLocalCategories([null, undefined]).length).toBeGreaterThan(2)
  })
})
