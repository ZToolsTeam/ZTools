/**
 * 插件更新检查 API
 *
 * 公共实现以 CDN 静态插件目录为准，不访问任何后台；
 * 官方版通过 @edition 提供 marketBackend 时，统一交给它处理（静态目录 + 老插件走后台）。
 */

import { marketBackend } from '@edition'
import { isBundledPlugin } from '../utils/bundledPlugins'
import {
  resolveUpdatePlatform,
  normalizeCatalogId,
  noUpdate,
  buildCatalogUpdateInfo,
  loadStaticCatalogMap
} from './pluginCatalog'

export { buildCatalogUpdateInfo } from './pluginCatalog'

function notInCatalog(pluginId, catalog) {
  return noUpdate(pluginId, catalog ? '插件市场未收录该插件' : '插件目录暂不可用')
}

/**
 * 检查插件更新
 * @param {string} pluginId - 插件标识符
 * @param {Object} params - 查询参数
 * @param {string} params.platform - 平台：windows/macos（默认读取宿主平台）
 * @param {string} params.current_version - 当前版本号（默认：1.0.0）
 * @returns {Promise<Object>} 更新信息
 */
export async function checkPluginUpdate(pluginId, params = {}) {
  if (marketBackend) return marketBackend.checkPluginUpdate(pluginId, params)

  const platform = await resolveUpdatePlatform(params.platform)
  const currentVersion = params.current_version || '1.0.0'

  // 内置插件跟随客户端一起更新，不单独检查
  if (isBundledPlugin(pluginId)) return noUpdate(pluginId, '内置插件随客户端更新')

  const catalog = await loadStaticCatalogMap()
  const entry = catalog?.get(normalizeCatalogId(pluginId))
  if (entry) return buildCatalogUpdateInfo(entry, currentVersion, platform)
  return notInCatalog(pluginId, catalog)
}

/**
 * 批量检查插件更新
 * @param {Object} data - 请求数据
 * @param {string} data.platform - 平台：windows/macos（默认读取宿主平台）
 * @param {Array<Object>} data.plugins - 插件列表（{ id | pluginId, version }）
 * @returns {Promise<Object>} 更新信息对象（以插件标识符为 key）
 */
export async function batchCheckPlugins(data = {}) {
  if (marketBackend) return marketBackend.batchCheckPlugins(data)

  const platform = await resolveUpdatePlatform(data.platform)
  // 兼容两种传入格式：{ id: xxx } 或 { pluginId: xxx }
  const requested = (Array.isArray(data.plugins) ? data.plugins : [])
    .map((p) => ({ id: p?.id || p?.pluginId, version: p?.version }))
    .filter((p) => p.id)

  const updates = {}
  if (requested.length === 0) return updates

  const catalog = await loadStaticCatalogMap()
  for (const item of requested) {
    if (isBundledPlugin(item.id)) {
      updates[item.id] = noUpdate(item.id, '内置插件随客户端更新')
      continue
    }
    const entry = catalog?.get(normalizeCatalogId(item.id))
    updates[item.id] = entry
      ? buildCatalogUpdateInfo(entry, item.version || '1.0.0', platform)
      : notInCatalog(item.id, catalog)
  }
  return updates
}
