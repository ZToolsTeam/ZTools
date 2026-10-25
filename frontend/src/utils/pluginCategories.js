/** 市场分类的名称、顺序与旧清单别名。筛选统一使用归一化数组，展示文本不能作为分类标识。 */
export const PLUGIN_CATEGORIES = Object.freeze([
  { name: '办公效率', icon: 'fa-briefcase', aliases: ['office', 'productivity', 'utility', '效率工具', '实用工具', '文本工具', '文档处理', '文件管理'] },
  { name: '系统工具', icon: 'fa-wrench', aliases: ['system'] },
  { name: '图像媒体', icon: 'fa-file-image-o', aliases: ['media', 'design', '媒体处理', '图像视频', '设计工具'] },
  { name: '开发工具', icon: 'fa-code', aliases: ['developer', 'development', 'dev'] },
  { name: '网络工具', icon: 'fa-wifi', aliases: ['network', 'browser'] },
  { name: 'AI工具', icon: 'fa-magic', aliases: ['ai', 'AI 工具'] },
  { name: '安全隐私', icon: 'fa-shield', aliases: ['security', '安全工具'] },
  { name: '金融理财', icon: 'fa-money', aliases: ['finance'] },
  { name: '其他工具', icon: 'fa-cube', aliases: [] }
])

export const CATEGORY_ICON_MAP = Object.fromEntries(PLUGIN_CATEGORIES.map(({ name, icon }) => [name, icon]))
const categoryNames = new Map(PLUGIN_CATEGORIES.flatMap(({ name, aliases }) =>
  [name, ...aliases].map((alias) => [alias.toLowerCase(), name])))

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
  const order = PLUGIN_CATEGORIES.map(({ name }) => name)
  return [...categories].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
}
