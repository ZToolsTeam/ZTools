/**
 * 插件市场 API
 *
 * 公共实现只读 CDN 静态插件目录（plugins-v2/catalog.json），不访问任何后台；
 * 官方版与开源版共用同一份目录，账号、评论等在线服务不参与插件分发。
 */

import { getLocalPlugins } from './native'
import { normalizeCategoryNames, sortCategories } from '../utils/pluginCategories'
import { getPluginPlatforms } from '../utils/platform'
import { checkCompat, fetchVersions } from '../composables/useVersionCompat'
import {
  loadV2StaticCatalogList,
  findInV2StaticCatalog,
  normalizeCatalogEntry,
  normalizeCatalogId,
  buildCatalogDownloadInfo,
  resolveUpdatePlatform,
  normalizePluginVersionError
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
 * 分类按已发布插件的实际目录生成，内置插件分类由 stores/categories 补充
 * @returns {Promise<Array>} [{ id, name, slug, icon, sortOrder, pluginsCount }]
 */
export async function getCategories() {
  const entries = await loadV2StaticCatalogList()
  const counts = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !(entry.id || entry.pluginId) || entry.revoked || entry.draft) continue
    for (const name of normalizeCatalogEntry(entry).category) {
      counts.set(name, (counts.get(name) || 0) + 1)
    }
  }
  return sortCategories([...counts].map(([name, pluginsCount]) => ({ id: name, name, slug: name, pluginsCount })))
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
  const page = toPositiveInt(params.page, 1)
  const pageSize = toPositiveInt(params.per_page, 15)
  const raw = await loadV2StaticCatalogList()
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
  if (params.category && !['all', '全部'].includes(params.category)) {
    const categories = normalizeCategoryNames(params.category)
    items = items.filter((entry) => entry.category.some((name) => categories.includes(name)))
  }
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
  let catalogError
  try {
    const catalogEntry = await findInV2StaticCatalog(pluginId)
    if (catalogEntry) return catalogEntry
  } catch (error) {
    console.warn('[plugins] 插件目录不可用，尝试读取已安装插件详情:', error)
    catalogError = error
  }

  const local = (await getLocalPlugins()).find(
    (p) => String(p?.pluginId) === String(pluginId)
  )
  if (!local) throw catalogError || createNotInCatalogError(pluginId)
  return { ...local, id: local.pluginId, pluginId: local.pluginId }
}

/**
 * 获取下载信息（下载地址 + SHA-256），安装时由主进程强制校验
 * @param {string} pluginId - 插件标识符
 * @returns {Promise<Object>} { id, pluginId, version, downloadUrl, sha256, checksum, size }
 */
export async function getDownloadSign(pluginId) {
  // 已下架的条目在这里直接抛出 PLUGIN_REVOKED
  // 安装前重新读取目录，不能把列表缓存或离线快照当作仍可安装的依据。
  const entry = await findInV2StaticCatalog(pluginId, { forceRefresh: true })
  const info = buildCatalogDownloadInfo(entry)
  if (!info) throw createNotInCatalogError(pluginId, '插件市场未收录该插件或缺少下载信息')
  const platform = await resolveUpdatePlatform()
  const platforms = getPluginPlatforms(entry)
  if (platforms && !platforms.includes(platform)) {
    const error = new Error('该插件不支持当前平台')
    error.code = 'PLUGIN_PLATFORM_UNSUPPORTED'
    throw error
  }
  const versions = await fetchVersions()
  const compatible = checkCompat(entry, versions.appVersion, versions.webVersion)
  if (!compatible.compatible) {
    throw normalizePluginVersionError({ message: compatible.reason, errors: {
      minAppVersion: entry.minAppVersion, currentAppVersion: versions.appVersion
    } })
  }
  return info
}
