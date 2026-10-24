/**
 * 插件更新检查 API
 *
 * 公共实现以 CDN 静态插件目录为准，不访问任何后台；
 * 官方版和开源版使用同一条分发链路，不请求旧版插件；目录不可用时明确报错。
 */

import { isBundledPlugin } from '../utils/bundledPlugins'
import { getDownloadSign } from './plugins'
import { downloadPluginUpdate as nativeDownloadPluginUpdate } from './native'
import {
  resolveUpdatePlatform,
  normalizeCatalogId,
  noUpdate,
  buildCatalogUpdateInfo,
  loadStaticCatalogMap
} from './pluginCatalog'

export { buildCatalogUpdateInfo } from './pluginCatalog'

/** 点击更新时重新确认发布状态，展示时保存的地址不能绕过下架与兼容检查。 */
export async function downloadPluginUpdate(pluginId) {
  if (isBundledPlugin(pluginId)) throw new Error('内置插件随客户端更新')
  const info = await getDownloadSign(pluginId)
  const result = await nativeDownloadPluginUpdate(pluginId, { ...info, fileSize: info.size })
  if (!result || result.success === false) throw new Error(result?.error || '插件更新启动失败')
  return result
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
  const platform = await resolveUpdatePlatform(params.platform)
  const currentVersion = params.current_version || '1.0.0'

  // 内置插件跟随客户端一起更新，不单独检查
  if (isBundledPlugin(pluginId)) return noUpdate(pluginId, '内置插件随客户端更新')

  const catalog = await loadStaticCatalogMap()
  const entry = catalog?.get(normalizeCatalogId(pluginId))
  if (entry) return buildCatalogUpdateInfo(entry, currentVersion, platform)
  return noUpdate(pluginId, '插件市场未收录该插件')
}

/**
 * 批量检查插件更新
 * @param {Object} data - 请求数据
 * @param {string} data.platform - 平台：windows/macos（默认读取宿主平台）
 * @param {Array<Object>} data.plugins - 插件列表（{ id | pluginId, version }）
 * @returns {Promise<Object>} 更新信息对象（以插件标识符为 key）
 */
export async function batchCheckPlugins(data = {}) {
  const platform = await resolveUpdatePlatform(data.platform)
  // 兼容两种传入格式：{ id: xxx } 或 { pluginId: xxx }
  const requested = (Array.isArray(data.plugins) ? data.plugins : [])
    .map((p) => ({ id: p?.id || p?.pluginId, version: p?.version }))
    .filter((p) => p.id)

  const updates = {}
  if (requested.length === 0) return updates

  const catalog = requested.some((item) => !isBundledPlugin(item.id)) ? await loadStaticCatalogMap() : null
  for (const item of requested) {
    if (isBundledPlugin(item.id)) {
      updates[item.id] = noUpdate(item.id, '内置插件随客户端更新')
      continue
    }
    const entry = catalog?.get(normalizeCatalogId(item.id))
    updates[item.id] = entry
      ? buildCatalogUpdateInfo(entry, item.version || '1.0.0', platform)
      : noUpdate(item.id, '插件市场未收录该插件')
  }
  return updates
}
