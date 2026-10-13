import { defineStore } from 'pinia'
import { getCategories } from '@/api/apiserver'

/** 分类数据缓存有效期：10 分钟 */
const CACHE_TTL = 10 * 60 * 1000

/** 分类名称 → 图标映射（前端本地维护） */
const CATEGORY_ICON_MAP = {
  '系统工具': 'fa-wrench',
  '办公效率': 'fa-briefcase',
  '媒体处理': 'fa-file-image-o',
  '安全工具': 'fa-shield'
}
const DEFAULT_ICON = 'fa-cube'

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
          this.items = Array.isArray(categories) && categories.length > 0 ? categories : [
            { id: 1, name: '办公效率', slug: 'office', icon: 'fa-briefcase' },
            { id: 2, name: '系统工具', slug: 'system', icon: 'fa-wrench' },
            { id: 3, name: '媒体处理', slug: 'media', icon: 'fa-file-image-o' },
            { id: 4, name: '安全工具', slug: 'security', icon: 'fa-shield' }
          ]
          this.loaded = true
          this.lastFetchTime = Date.now()
        } catch (e) {
          console.warn('[categories] 获取远程分类失败，回退内置官方分类列表:', e)
          this.items = [
            { id: 1, name: '办公效率', slug: 'office', icon: 'fa-briefcase' },
            { id: 2, name: '系统工具', slug: 'system', icon: 'fa-wrench' },
            { id: 3, name: '媒体处理', slug: 'media', icon: 'fa-file-image-o' },
            { id: 4, name: '安全工具', slug: 'security', icon: 'fa-shield' }
          ]
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
