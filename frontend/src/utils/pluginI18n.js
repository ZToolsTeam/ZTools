import { getCurrentLocale, t } from '@/i18n'
import { resolveLocale } from '@/utils/locale'
import { getCategoryId, normalizeCategoryIds } from '@/utils/pluginCategories'

/**
 * 读取插件在指定 locale 下的本地化字段，缺失时自动回退到插件默认字段。
 * @param {object} plugin
 * @param {'name' | 'description' | string} field
 * @param {string} [locale]
 * @returns {string}
 */
export function getLocalizedPluginField(plugin, field, locale) {
  if (!plugin || typeof plugin !== 'object' || !field) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const i18nMap = plugin.i18n
  if (i18nMap && typeof i18nMap === 'object') {
    const localized = i18nMap[targetLocale]?.[field]
    if (typeof localized === 'string' && localized.trim()) {
      return localized.trim()
    }
  }
  const fallback = plugin[field]
  return typeof fallback === 'string' ? fallback.trim() : ''
}

/**
 * 获取插件本地化显示名称（优先 plugin.i18n?.[currentLocale]?.name，回退 plugin.name / title / pluginId）
 */
export function getLocalizedPluginName(plugin, locale) {
  if (!plugin || typeof plugin !== 'object') return ''
  return (
    getLocalizedPluginField(plugin, 'name', locale) ||
    (typeof plugin.title === 'string' ? plugin.title.trim() : '') ||
    String(plugin.pluginId || plugin.id || '').trim()
  )
}

/**
 * 获取插件本地化简介（优先 plugin.i18n?.[currentLocale]?.description，回退 plugin.description）
 */
export function getLocalizedPluginDescription(plugin, locale) {
  if (!plugin || typeof plugin !== 'object') return ''
  return getLocalizedPluginField(plugin, 'description', locale)
}

/**
 * 收集插件的多语言备用名称，供中英/拼音无缝互搜使用（自动去重并排除当前主显示名）
 */
export function getLocalizedPluginAltNames(plugin, primaryName = '') {
  if (!plugin || typeof plugin !== 'object') return []
  const primary = String(primaryName || '').trim()
  const result = []
  const add = (val) => {
    if (typeof val !== 'string') return
    const trimmed = val.trim()
    if (!trimmed || trimmed === primary || result.includes(trimmed)) return
    result.push(trimmed)
  }

  add(plugin.name)
  add(plugin.title)
  if (Array.isArray(plugin.altNames)) {
    for (const alt of plugin.altNames) add(alt)
  }
  if (plugin.i18n && typeof plugin.i18n === 'object') {
    for (const entry of Object.values(plugin.i18n)) {
      if (entry && typeof entry === 'object') {
        add(entry.name)
      }
    }
  }
  return result
}

/**
 * 将插件分类名或分类 ID 映射为当前语言的本地化分类标签
 */
export function getLocalizedCategoryName(nameOrId) {
  if (!nameOrId || typeof nameOrId !== 'string') return ''
  const trimmed = nameOrId.trim()
  if (!trimmed) return ''
  if (trimmed === '全部' || trimmed.toLowerCase() === 'all') {
    return t('categories.all')
  }
  if (trimmed === 'favorites') {
    return t('categories.favorites')
  }
  const id = getCategoryId(trimmed)
  if (id === 'other' && trimmed !== '其他工具' && trimmed.toLowerCase() !== 'other') {
    return trimmed
  }
  return t(`categories.${id}`)
}

/**
 * 将插件 category 字段（字符串或数组）格式化为本地化分类名列表
 */
export function getLocalizedCategoryNames(value) {
  const ids = normalizeCategoryIds(value)
  return ids.map((id) => t(`categories.${id}`))
}
