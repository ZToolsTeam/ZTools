import { defineStore } from 'pinia'
import { getCategories } from '@/api/apiserver'
import { CATEGORY_ICON_MAP, PLUGIN_CATEGORIES, normalizeCategoryNames } from '@/utils/pluginCategories'

/** 分类数据缓存有效期：10 分钟 */
const CACHE_TTL = 10 * 60 * 1000

/** 固定分类入口覆盖离线快照；空分类由实际目录的 categoryCounts 隐藏。 */
export function mergeLocalCategories(remote) {
  const categories = new Map(PLUGIN_CATEGORIES.map(({ name, icon }) => [name, { id: name, name, slug: name, icon }]))
  for (const category of Array.isArray(remote) ? remote : []) {
    for (const name of normalizeCategoryNames(category?.name)) {
      categories.set(name, { ...categories.get(name), ...category, id: name, name, slug: name })
    }
  }
  return [...categories.values()]
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
          icon: CATEGORY_ICON_MAP[c.name] || 'fa-cube'
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
          this.items = mergeLocalCategories(categories)
          this.loaded = true
          this.lastFetchTime = Date.now()
        } catch (e) {
          console.warn('[categories] 获取远程分类失败，回退内置官方分类列表:', e)
          this.items = mergeLocalCategories([])
          this.loaded = false
          this.error = e?.message || '加载分类失败'
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
