import { defineStore } from 'pinia'
import { getCategories } from '@/api/apiserver'
import { getBundledPluginEntries } from '@/utils/bundledPlugins'

/** 分类数据缓存有效期：10 分钟 */
const CACHE_TTL = 10 * 60 * 1000

/** 分类名称 → 图标映射（前端本地维护） */
const CATEGORY_ICON_MAP = {
  '系统工具': 'fa-wrench',
  '办公效率': 'fa-briefcase',
  '媒体处理': 'fa-file-image-o',
  '安全工具': 'fa-shield',
  '开发工具': 'fa-code',
  '效率工具': 'fa-bolt',
  '设计工具': 'fa-paint-brush'
}
const DEFAULT_ICON = 'fa-cube'

/**
 * 远端分类表之外，补上随客户端内置插件实际使用的分类。
 * 否则远端分类与内置插件的分类对不上时，市场「全部」页按分类分组会一个插件都分不进去，侧栏分类也为空。
 */
export function mergeLocalCategories(remote) {
  const list = Array.isArray(remote) ? [...remote] : []
  const known = new Set(list.map((c) => c?.name))
  for (const entry of getBundledPluginEntries()) {
    const name = typeof entry.category === 'string' ? entry.category.trim() : ''
    if (!name || known.has(name)) continue
    known.add(name)
    list.push({ id: `local:${name}`, name, slug: `local-${name}`, local: true })
  }
  return list
}

export const useCategoriesStore = defineStore('categories', {
  state: () => ({
    items: [],
    loading: false,
    loaded: false,
    error: null,
    _fetchPromise: null,
    lastFetchTime: 0
  }),
  getters: {
    /** 带"全部"的完整分类列表，供 Sidebar 使用 */
    sidebarCategories: (state) => {
      return [
        { name: '全部', icon: 'fa-th' },
        ...state.items.map((c) => ({
          name: c.name,
          icon: CATEGORY_ICON_MAP[c.name] || DEFAULT_ICON
        }))
      ]
    }
  },
  actions: {
    /** 获取分类列表（带缓存） */
    async fetchCategories(force = false) {
      if (!force && this.loaded && Date.now() - this.lastFetchTime < CACHE_TTL) {
        return this.items
      }
      if (!force && this._fetchPromise) {
        return this._fetchPromise
      }

      this.loading = true
      this.error = null
      this._fetchPromise = (async () => {
        try {
          const categories = await getCategories()
          this.items = mergeLocalCategories(Array.isArray(categories) && categories.length > 0 ? categories : [
            { id: 1, name: '办公效率', slug: 'office', icon: 'fa-briefcase' },
            { id: 2, name: '系统工具', slug: 'system', icon: 'fa-wrench' },
            { id: 3, name: '媒体处理', slug: 'media', icon: 'fa-file-image-o' },
            { id: 4, name: '安全工具', slug: 'security', icon: 'fa-shield' }
          ])
          this.loaded = true
          this.lastFetchTime = Date.now()
        } catch (e) {
          console.warn('[categories] 获取远程分类失败，回退内置官方分类列表:', e)
          this.items = mergeLocalCategories([
            { id: 1, name: '办公效率', slug: 'office', icon: 'fa-briefcase' },
            { id: 2, name: '系统工具', slug: 'system', icon: 'fa-wrench' },
            { id: 3, name: '媒体处理', slug: 'media', icon: 'fa-file-image-o' },
            { id: 4, name: '安全工具', slug: 'security', icon: 'fa-shield' }
          ])
          this.loaded = true
          this.error = null
        } finally {
          this.loading = false
          this._fetchPromise = null
        }
        return this.items
      })()

      return this._fetchPromise
    }
  }
})
