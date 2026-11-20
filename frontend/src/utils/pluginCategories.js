/** 市场分类的稳定主键、名称、顺序与旧清单别名。筛选统一使用归一化数组，展示文本不能作为分类标识。 */
export const PLUGIN_CATEGORIES = Object.freeze([
  { id: 'productivity', name: '办公效率', icon: 'fa-briefcase', aliases: ['office', 'productivity', 'utility', '效率工具', '办公工具', '实用工具', '文本工具', '文档处理', 'finance', '金融理财', 'ai', 'AI工具', 'AI 工具'] },
  { id: 'system', name: '系统工具', icon: 'fa-wrench', aliases: ['system'] },
  { id: 'files', name: '文件管理', icon: 'fa-folder-open', aliases: ['files', 'file', 'storage'] },
  { id: 'media', name: '图像媒体', icon: 'fa-file-image-o', aliases: ['media', 'design', '媒体处理', '图像视频', '设计工具'] },
  { id: 'developer', name: '开发工具', icon: 'fa-code', aliases: ['developer', 'development', 'dev'] },
  { id: 'network', name: '网络工具', icon: 'fa-wifi', aliases: ['network', 'browser'] },
  { id: 'security', name: '安全隐私', icon: 'fa-shield', aliases: ['security', '安全工具'] },
  { id: 'other', name: '其他工具', icon: 'fa-cube', aliases: ['other', 'others'] }
])

export const CATEGORY_ICON_MAP = Object.fromEntries(PLUGIN_CATEGORIES.map(({ name, icon }) => [name, icon]))

export const CATEGORY_ID_TO_NAME = Object.freeze(
  Object.fromEntries(PLUGIN_CATEGORIES.map(({ id, name }) => [id, name]))
)

export const CATEGORY_NAME_TO_ID = Object.freeze(
  Object.fromEntries(PLUGIN_CATEGORIES.map(({ id, name }) => [name, id]))
)

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

export function getCategoryId(nameOrAlias) {
  if (typeof nameOrAlias !== 'string') return 'other'
  const key = nameOrAlias.trim().toLowerCase()
  if (!key) return 'other'
  return categoryIds.get(key) || 'other'
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
  return ids.length ? ids : ['other']
}

export function normalizeCategoryNames(value) {
  const values = Array.isArray(value) ? value : [value]
  const names = values.filter((item) => typeof item === 'string')
    .flatMap((item) => item.split(/\s*[\/／·]\s*/))
    .map((item) => item.trim()).filter(Boolean)
    .map((item) => categoryNames.get(item.toLowerCase()) || '其他工具')
  return [...new Set(names)]
}

/** 未填写分类的插件也要能从「全部」分组页找到，不能悄悄归到办公类。 */
export function getPluginCategories(value) {
  const names = normalizeCategoryNames(value)
  return names.length ? names : ['其他工具']
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
    return nameOrder.indexOf(cat.name)
  }
  return [...categories].sort((a, b) => rankOf(a) - rankOf(b))
}
