/** 标准特殊分类标识 */
export const ALL_CATEGORY_ID = 'all'
export const FAVORITES_CATEGORY_ID = 'favorites'
export const DEFAULT_CATEGORY_ID = 'other'

/** 市场分类的稳定主键、国际化键、兼容名称、顺序与旧清单别名。筛选统一使用标准 categoryId 主键，展示文本经 i18n 渲染。 */
export const PLUGIN_CATEGORIES = Object.freeze([
  // i18n-allow: legacy-category-alias
  { id: 'productivity', labelKey: 'categories.productivity', name: '办公效率', icon: 'fa-briefcase', aliases: ['office', 'productivity', 'utility', '效率工具', '办公工具', '实用工具', '文本工具', '文档处理', 'finance', '金融理财', 'ai', 'AI工具', 'AI 工具'] },
  // i18n-allow: legacy-category-alias
  { id: 'system', labelKey: 'categories.system', name: '系统工具', icon: 'fa-wrench', aliases: ['system'] },
  // i18n-allow: legacy-category-alias
  { id: 'files', labelKey: 'categories.files', name: '文件管理', icon: 'fa-folder-open', aliases: ['files', 'file', 'storage'] },
  // i18n-allow: legacy-category-alias
  { id: 'media', labelKey: 'categories.media', name: '图像媒体', icon: 'fa-file-image-o', aliases: ['media', 'design', '媒体处理', '图像视频', '设计工具'] },
  // i18n-allow: legacy-category-alias
  { id: 'developer', labelKey: 'categories.developer', name: '开发工具', icon: 'fa-code', aliases: ['developer', 'development', 'dev'] },
  // i18n-allow: legacy-category-alias
  { id: 'network', labelKey: 'categories.network', name: '网络工具', icon: 'fa-wifi', aliases: ['network', 'browser'] },
  // i18n-allow: legacy-category-alias
  { id: 'security', labelKey: 'categories.security', name: '安全隐私', icon: 'fa-shield', aliases: ['security', '安全工具'] },
  // i18n-allow: legacy-category-alias
  { id: 'other', labelKey: 'categories.other', name: '其他工具', icon: 'fa-cube', aliases: ['other', 'others'] }
])

/** 标准 categoryId -> 图标映射 */
export const CATEGORY_ICON_BY_ID = Object.freeze(
  Object.fromEntries(PLUGIN_CATEGORIES.map(({ id, icon }) => [id, icon]))
)

/** 兼容映射：同时支持按 categoryId 与旧中文分类名查找图标 */
export const CATEGORY_ICON_MAP = Object.freeze({
  ...Object.fromEntries(PLUGIN_CATEGORIES.map(({ name, icon }) => [name, icon])),
  ...CATEGORY_ICON_BY_ID
})

export const CATEGORY_ID_TO_NAME = Object.freeze(
  Object.fromEntries(PLUGIN_CATEGORIES.map(({ id, name }) => [id, name]))
)

export const CATEGORY_NAME_TO_ID = Object.freeze(
  Object.fromEntries(PLUGIN_CATEGORIES.map(({ id, name }) => [name, id]))
)

// i18n-allow: legacy-category-alias
const ALL_CATEGORY_ALIASES = new Set(['', ALL_CATEGORY_ID, '全部'])

const categoryIds = new Map(
  PLUGIN_CATEGORIES.flatMap(({ id, name, aliases }) =>
    [id, name, ...aliases].map((alias) => [alias.toLowerCase(), id])
  )
)

const categoryNames = new Map(
  PLUGIN_CATEGORIES.flatMap(({ id, name, aliases }) =>
    [id, name, ...aliases].map((alias) => [alias.toLowerCase(), name])
  )
)

/** 判断分类值是否表示「全部」（兼容空值、'all' 与旧中文 '全部'） */
export function isAllCategory(value) {
  if (value === null || value === undefined) return true
  if (typeof value !== 'string') return false
  return ALL_CATEGORY_ALIASES.has(value.trim().toLowerCase())
}

/** 根据标准 categoryId 或旧中文分类名获取图标 */
export function getCategoryIcon(idOrName) {
  if (typeof idOrName !== 'string') return 'fa-cube'
  const trimmed = idOrName.trim()
  if (!trimmed) return 'fa-cube'
  if (Object.hasOwn(CATEGORY_ICON_BY_ID, trimmed)) return CATEGORY_ICON_BY_ID[trimmed]
  const id = getCategoryId(trimmed)
  return CATEGORY_ICON_BY_ID[id] || 'fa-cube'
}

export function getCategoryId(nameOrAlias) {
  if (typeof nameOrAlias !== 'string') return DEFAULT_CATEGORY_ID
  const key = nameOrAlias.trim().toLowerCase()
  if (!key) return DEFAULT_CATEGORY_ID
  return categoryIds.get(key) || DEFAULT_CATEGORY_ID
}

/** 路由/筛选场景的单个分类参数归一化：空/'all'/'全部' -> ''，'favorites' -> 'favorites'，已知分类/旧中文别名归一为标准 categoryId，未知自定义参数原样保留 */
export function normalizeCategoryRouteParam(value) {
  if (isAllCategory(value)) return ''
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  if (lower === FAVORITES_CATEGORY_ID) return FAVORITES_CATEGORY_ID
  return categoryIds.get(lower) || trimmed
}

/** 从分类对象（兼容远端数字 id 或标准 categoryId）或字符串中安全解析标准分类主键 */
export function resolveCategoryKey(category) {
  if (typeof category === 'string') {
    if (isAllCategory(category)) return ALL_CATEGORY_ID
    return normalizeCategoryRouteParam(category)
  }
  if (!category || typeof category !== 'object') return ''
  if (typeof category.id === 'string' && category.id.trim()) {
    if (isAllCategory(category.id)) return ALL_CATEGORY_ID
    const lowerId = category.id.trim().toLowerCase()
    if (categoryIds.has(lowerId)) return categoryIds.get(lowerId)
  }
  const fallback =
    (typeof category.categoryId === 'string' && category.categoryId.trim()) ||
    (typeof category.slug === 'string' && category.slug.trim()) ||
    (typeof category.name === 'string' && category.name.trim()) ||
    (typeof category.id === 'string' && category.id.trim()) ||
    ''
  if (isAllCategory(fallback)) return ALL_CATEGORY_ID
  return normalizeCategoryRouteParam(fallback)
}

export function normalizeCategoryIds(value) {
  const values = Array.isArray(value) ? value : [value]
  const ids = values
    .filter((item) => typeof item === 'string')
    .flatMap((item) => item.split(/\s*[\/／·]\s*/))
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => getCategoryId(item))
  return [...new Set(ids)]
}

/** 未填写分类的插件也要能从「全部」分组页找到，不能悄悄归到办公类。 */
export function getPluginCategoryIds(value) {
  const ids = normalizeCategoryIds(value)
  return ids.length ? ids : [DEFAULT_CATEGORY_ID]
}

export function normalizeCategoryNames(value) {
  const values = Array.isArray(value) ? value : [value]
  const names = values.filter((item) => typeof item === 'string')
    .flatMap((item) => item.split(/\s*[\/／·]\s*/))
    .map((item) => item.trim()).filter(Boolean)
    .map((item) => categoryNames.get(item.toLowerCase()) || CATEGORY_ID_TO_NAME[DEFAULT_CATEGORY_ID])
  return [...new Set(names)]
}

/** 未填写分类的插件也要能从「全部」分组页找到，不能悄悄归到办公类。 */
export function getPluginCategories(value) {
  const names = normalizeCategoryNames(value)
  return names.length ? names : [CATEGORY_ID_TO_NAME[DEFAULT_CATEGORY_ID]]
}

export function sortCategories(categories) {
  const nameOrder = PLUGIN_CATEGORIES.map(({ name }) => name)
  const idOrder = PLUGIN_CATEGORIES.map(({ id }) => id)
  const rankOf = (cat) => {
    if (!cat) return -1
    if (typeof cat.id === 'string') {
      const idx = idOrder.indexOf(cat.id)
      if (idx !== -1) return idx
    }
    const normalizedId = getCategoryId(cat.name)
    const byNorm = idOrder.indexOf(normalizedId)
    if (byNorm !== -1) return byNorm
    return nameOrder.indexOf(cat.name)
  }
  return [...categories].sort((a, b) => rankOf(a) - rankOf(b))
}
