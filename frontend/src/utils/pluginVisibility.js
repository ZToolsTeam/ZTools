/**
 * 客户端展示哪些插件
 *
 * 官方插件来自 plugins 仓库，展示两类：
 *   1. 随客户端内置的（bundledPlugins.json 的 ids）；
 *   2. 通过插件市场分发的（storeOfficialIds：plugins 仓库里非草稿的其余官方插件），用户安装后正常显示。
 * 以下一律隐藏，也不允许通过旧快捷方式、历史记录等入口打开：
 *   1. 草稿与已下架（unreleasedOfficialIds：plugin.json 写了 draft 或 revoked，功能没做完或已合并下线）；
 *   2. 已合并进内置插件的旧重复插件（BUNDLED_PLUGIN_REPLACEMENTS）；
 *   3. 旧的内置声明式实现（officialPlugins.js，大量为示例数据）；
 *   4. 作者为 ZTools 官方、但不在 plugins 仓库里的其他插件条目（例如旧插件市场里的官方条目）。
 * 社区插件不受影响。
 */
import bundledConfig from '../config/bundledPlugins.generated.js'
import { isBundledPlugin, isStoreOfficialPlugin, BUNDLED_PLUGIN_REPLACEMENTS } from './bundledPlugins.js'
import { OFFICIAL_PLUGINS_MAP, OFFICIAL_PLUGIN_ALIASES } from './officialPlugins.js'

const UNRELEASED_OFFICIAL_IDS = new Set((bundledConfig.unreleasedOfficialIds || []).map((id) => String(id).toLowerCase()))
const OFFICIAL_AUTHORS = new Set(['ztools', 'ztools team', 'ztools-team', 'ztools official', 'ztools official team', 'official'])

function idOf(value) {
  if (!value) return ''
  if (typeof value === 'object') return String(value.pluginId || value.id || '').trim().toLowerCase()
  return String(value).trim().toLowerCase()
}

function isLegacyBuiltin(id) {
  // 只认对象自身的键，'constructor' 等原型链上的名字不算内置实现
  const resolved = Object.hasOwn(OFFICIAL_PLUGIN_ALIASES, id) ? OFFICIAL_PLUGIN_ALIASES[id] : id
  return Object.hasOwn(OFFICIAL_PLUGINS_MAP, resolved) || Object.hasOwn(OFFICIAL_PLUGINS_MAP, id)
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
  if (Object.hasOwn(BUNDLED_PLUGIN_REPLACEMENTS, id)) return false
  if (UNRELEASED_OFFICIAL_IDS.has(id)) return false
  if (isStoreOfficialPlugin(id)) return true
  // 旧内置声明式实现自带 isDeclarative 与 version，必须先于“已安装”判断排除，否则示例数据插件会重新出现
  if (isLegacyBuiltin(id)) return false
  const isInstalledOrDeclarative = Boolean(
    value &&
    typeof value === 'object' &&
    (value.isDeclarative || value.isInstalledDeclarative || value.entry || value.version)
  )
  if (isInstalledOrDeclarative) return true
  return !hasOfficialAuthor(value)
}
