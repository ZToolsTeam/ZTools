/**
 * 插件市场 API
 *
 * 公共实现只读 CDN 静态插件目录（plugins-v2/catalog.json），不访问任何后台；
 * 官方版通过 @edition 提供 marketBackend 时，统一交给它处理（后台接口 + 静态目录）。
 */

import { marketBackend } from '@edition'
import { getLocalPlugins } from './native'
import {
  loadV2StaticCatalogList,
  findInV2StaticCatalog,
  normalizeCatalogEntry,
  normalizeCatalogId,
  buildCatalogDownloadInfo
} from './pluginCatalog'

export {
  PLUGIN_VERSION_INCOMPATIBLE,
  loadV2StaticCatalogList,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from './pluginCatalog'

export const PLUGIN_NOT_IN_CATALOG = 'PLUGIN_NOT_IN_CATALOG'

function createNotInCatalogError(pluginId, message = '插件市场未收录该插件') {
  const err = new Error(message)
  err.code = PLUGIN_NOT_IN_CATALOG
  err.pluginId = String(pluginId || '')
  return err
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function matchesKeyword(entry, keyword) {
  const fields = [entry.pluginId, entry.id, entry.name, entry.title, entry.description, entry.author]
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(keyword))
}

/**
 * 获取插件分类列表
 * 静态目录不单独提供分类，分类由本地已有插件合并得出（见 stores/categories）
 * @returns {Promise<Array>} [{ id, name, slug, icon, sortOrder, pluginsCount }]
 */
export async function getCategories() {
  if (marketBackend) return marketBackend.getCategories()
  return []
}

/**
 * 获取插件市场列表
 * @param {Object} params - 查询参数
 * @param {string} params.search - 搜索关键词（插件名称或描述）
 * @param {string} params.category - 分类筛选
 * @param {string|string[]} params.ids - 只取这些插件
 * @param {string} params.sort - 排序字段：created_at/downloads
 * @param {number} params.per_page - 每页数量（默认：15）
 * @param {number} params.page - 页码（默认：1）
 * @returns {Promise<Object>} { list, total, page, pageSize, lastPage }
 */
export async function getMarketPlugins(params = {}) {
  if (marketBackend) return marketBackend.getMarketPlugins(params)

  const page = toPositiveInt(params.page, 1)
  const pageSize = toPositiveInt(params.per_page, 15)
  const raw = await loadV2StaticCatalogList()
  if (!Array.isArray(raw)) {
    return { list: [], total: 0, page, pageSize, lastPage: 1 }
  }

  let items = raw
    .filter((entry) => entry && typeof entry === 'object' && (entry.id || entry.pluginId))
    .map((entry) => normalizeCatalogEntry(entry))

  const ids = params.ids
    ? (Array.isArray(params.ids) ? params.ids : String(params.ids).split(','))
        .map(normalizeCatalogId)
        .filter(Boolean)
    : null
  if (ids) {
    const wanted = new Set(ids)
    items = items.filter((entry) => wanted.has(normalizeCatalogId(entry.pluginId)))
  } else {
    // 普通浏览不展示已下架与草稿插件
    items = items.filter((entry) => !entry.revoked && !entry.draft)
  }

  const keyword = String(params.search || params.keyword || '').trim().toLowerCase()
  if (keyword) items = items.filter((entry) => matchesKeyword(entry, keyword))
  if (params.category) items = items.filter((entry) => entry.category === params.category)
  if (params.sort === 'downloads') {
    items = [...items].sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0))
  }

  const total = items.length
  const start = (page - 1) * pageSize
  return {
    list: items.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    lastPage: Math.max(1, Math.ceil(total / pageSize))
  }
}

/**
 * 获取插件详情：先查静态目录，再回退本地已安装插件
 * @param {string} pluginId - 插件标识符
 * @returns {Promise<Object>} 插件详情对象
 */
export async function getPluginDetails(pluginId) {
  if (marketBackend) return marketBackend.getPluginDetails(pluginId)

  const catalogEntry = await findInV2StaticCatalog(pluginId)
  if (catalogEntry) return catalogEntry

  const local = (await getLocalPlugins()).find(
    (p) => String(p?.pluginId) === String(pluginId)
  )
  if (!local) throw createNotInCatalogError(pluginId)
  return { ...local, id: local.pluginId, pluginId: local.pluginId }
}

/**
 * 获取下载信息（下载地址 + SHA-256），安装时由主进程强制校验
 * @param {string} pluginId - 插件标识符
 * @returns {Promise<Object>} { id, pluginId, version, downloadUrl, sha256, checksum, size }
 */
export async function getDownloadSign(pluginId) {
  if (marketBackend) return marketBackend.getDownloadSign(pluginId)

  // 已下架的条目在这里直接抛出 PLUGIN_REVOKED
  const info = buildCatalogDownloadInfo(await findInV2StaticCatalog(pluginId))
  if (!info) throw createNotInCatalogError(pluginId, '插件市场未收录该插件或缺少下载信息')
  return info
}
