/**
 * 客户端展示哪些插件
 *
 * 官方插件只展示随客户端内置、已完成真实实现的那一批（bundledPlugins.json 的 ids）。
 * 以下一律隐藏，也不允许通过旧快捷方式、历史记录等入口打开：
 *   1. 旧的内置声明式实现（officialPlugins.js，大量为示例数据）；
 *   2. plugins 仓库里其余的官方插件（unreleasedOfficialIds，尚未完成真实实现）；
 *   3. 作者为 ZTools 官方、但不在内置名单里的其他插件条目（例如插件市场目录里的官方插件）。
 * 社区插件不受影响。
 */
import bundledConfig from '../config/bundledPlugins.generated.js'
import { isBundledPlugin } from './bundledPlugins.js'
import { OFFICIAL_PLUGINS_MAP, OFFICIAL_PLUGIN_ALIASES } from './officialPlugins.js'

const UNRELEASED_OFFICIAL_IDS = new Set((bundledConfig.unreleasedOfficialIds || []).map((id) => String(id).toLowerCase()))
const OFFICIAL_AUTHORS = new Set(['ztools', 'ztools team', 'ztools-team', 'ztools official', 'ztools official team', 'official'])

function idOf(value) {
  if (!value) return ''
  if (typeof value === 'object') return String(value.pluginId || value.id || '').trim().toLowerCase()
  return String(value).trim().toLowerCase()
}

function isLegacyBuiltin(id) {
  const resolved = OFFICIAL_PLUGIN_ALIASES[id] || id
  return Boolean(OFFICIAL_PLUGINS_MAP[resolved] || OFFICIAL_PLUGINS_MAP[id])
}

function hasOfficialAuthor(item) {
  if (!item || typeof item !== 'object') return false
  const author = typeof item.author === 'string' ? item.author : item.author?.name
  return OFFICIAL_AUTHORS.has(String(author || '').trim().toLowerCase())
}

export function isPluginVisible(value) {
  const id = idOf(value)
  if (!id) return false
  if (isBundledPlugin(id)) return true
  if (UNRELEASED_OFFICIAL_IDS.has(id) || isLegacyBuiltin(id)) return false
  return !hasOfficialAuthor(value)
}
