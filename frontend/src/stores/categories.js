import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getCategories } from '@/api/apiserver'
import {
  ALL_CATEGORY_ID,
  CATEGORY_ID_TO_NAME,
  PLUGIN_CATEGORIES,
  getCategoryIcon,
  normalizeCategoryIds
} from '@/utils/pluginCategories'
import { t } from '@/i18n'
import { resolveErrorMessage } from '@/utils/errorMessage'

/** 分类数据缓存有效期：10 分钟 */
const CACHE_TTL = 10 * 60 * 1000

/** 固定分类入口覆盖离线快照；以标准 categoryId 作为主键，空分类由实际目录的 categoryCounts 隐藏。 */
export function mergeLocalCategories(remote) {
  const categories = new Map(
    PLUGIN_CATEGORIES.map(({ id, name, labelKey, icon }) => [
      id,
      { id, slug: id, name, labelKey, icon }
    ])
  )
  for (const category of Array.isArray(remote) ? remote : []) {
    if (!category || typeof category !== 'object') continue
    const ids = normalizeCategoryIds(category.categoryId || category.id || category.slug || category.name)
    for (const id of ids) {
      const base = categories.get(id)
      const canonicalName = base?.name || CATEGORY_ID_TO_NAME[id] || id
      categories.set(id, {
        ...base,
        ...category,
        id,
        slug: id,
        name: canonicalName,
        labelKey: `categories.${id}`,
        icon: getCategoryIcon(id)
      })
    }
  }
  return [...categories.values()]
}

export const useCategoriesStore = defineStore('categories', () => {
  const items = ref([])
  const loading = ref(false)
  const loaded = ref(false)
  const errorRaw = ref(null)
  const errorKey = ref(null)
  const _fetchPromise = ref(null)
  const lastFetchTime = ref(0)

  /** 响应式错误信息：优先显式错误文本，否则按当前 locale 动态翻译 errorKey，切换语言不冻结 */
  const error = computed({
    get: () => errorRaw.value || (errorKey.value ? t(errorKey.value) : null),
    set: (val) => {
      errorRaw.value = val || null
      errorKey.value = null
    }
  })

  /** 带「全部」（标准主键 'all'）的完整分类列表，供 Sidebar 与市场筛选使用 */
  const sidebarCategories = computed(() => [
    { id: ALL_CATEGORY_ID, slug: ALL_CATEGORY_ID, name: ALL_CATEGORY_ID, labelKey: 'categories.all', icon: 'fa-th' },
    ...items.value.map((c) => ({
      id: c.id,
      slug: c.slug || c.id,
      name: c.name,
      labelKey: c.labelKey || `categories.${c.id}`,
      icon: getCategoryIcon(c.id || c.name)
    }))
  ])

  /** 获取分类列表（带缓存） */
  async function fetchCategories(force = false) {
    if (!force && loaded.value && Date.now() - lastFetchTime.value < CACHE_TTL) {
      return items.value
    }
    if (!force && _fetchPromise.value) {
      return _fetchPromise.value
    }

    loading.value = true
    errorRaw.value = null
    errorKey.value = null
    _fetchPromise.value = (async () => {
      try {
        const categories = await getCategories()
        items.value = mergeLocalCategories(categories)
        loaded.value = true
        lastFetchTime.value = Date.now()
      } catch (e) {
        console.warn('[categories] 获取远程分类失败，回退内置官方分类列表:', e)
        items.value = mergeLocalCategories([])
        loaded.value = false
        const resolved = resolveErrorMessage(e, 'categoriesStore.loadFailed')
        if (resolved === t('categoriesStore.loadFailed')) {
          errorRaw.value = null
          errorKey.value = 'categoriesStore.loadFailed'
        } else {
          errorRaw.value = resolved
          errorKey.value = null
        }
      } finally {
        loading.value = false
        _fetchPromise.value = null
      }
      return items.value
    })()

    return _fetchPromise.value
  }

  return {
    items,
    loading,
    loaded,
    error,
    errorKey,
    errorRaw,
    _fetchPromise,
    lastFetchTime,
    sidebarCategories,
    fetchCategories
  }
})
