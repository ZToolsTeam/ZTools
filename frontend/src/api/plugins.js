/**
 * 插件市场 API
 *
 * 对接 Backend 的插件相关接口
 */

import http from '../utils/http'
import { createOfflineError, isOnline } from '../config/runtime-mode'
import { getLocalPlugins } from './native'
import { V2_CATALOG_CDN_URL } from '../utils/declarativePluginLoader'

export const PLUGIN_VERSION_INCOMPATIBLE = 'PLUGIN_VERSION_INCOMPATIBLE'

let _v2CatalogCache = null
let _v2CatalogCacheTime = 0
const V2_CATALOG_CACHE_TTL_MS = 60 * 1000

async function findInV2StaticCatalog(pluginId) {
  const pid = String(pluginId || '').trim().toLowerCase()
  if (!pid || typeof fetch !== 'function') return null

  const now = Date.now()
  let list = null
  if (_v2CatalogCache && now - _v2CatalogCacheTime < V2_CATALOG_CACHE_TTL_MS) {
    list = _v2CatalogCache
  } else {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), 2500) : null
      try {
        const res = await fetch(V2_CATALOG_CDN_URL, {
          headers: { Accept: 'application/json' },
          signal: controller ? controller.signal : undefined
        })
        if (res.ok) {
          const raw = await res.json()
          list = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.plugins)
              ? raw.plugins
              : Array.isArray(raw?.list)
                ? raw.list
                : null
          if (list) {
            _v2CatalogCache = list
            _v2CatalogCacheTime = Date.now()
          }
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch {
      return null
    }
  }

  if (!Array.isArray(list)) return null
  const found = list.find(
    (item) => String(item?.id || item?.pluginId || '').trim().toLowerCase() === pid
  )
  if (!found) return null

  const sha256 = found.sha256 || found.checksum || ''
  return {
    ...found,
    id: found.id || found.pluginId || pluginId,
    pluginId: found.pluginId || found.id || pluginId,
    version: found.version || '1.0.0',
    downloadUrl: found.downloadUrl || '',
    sha256,
    checksum: sha256,
    size: Number(found.size ?? found.file_size ?? found.fileSize ?? 0) || 0
  }
}

function normalizePluginVersionError(payload = {}) {
  const data = payload.data || payload
  const errors = data.errors || payload.errors || {}
  const err = new Error(
    data.message || payload.message || '当前版本不满足此插件要求，请先升级客户端'
  )
  err.code = data.code || payload.code || errors.code || PLUGIN_VERSION_INCOMPATIBLE
  err.status = payload.status || data.status || 426
  err.errors = errors
  err.minAppVersion = errors.minAppVersion
  err.minWebVersion = errors.minWebVersion
  err.currentAppVersion = errors.currentAppVersion
  err.currentWebVersion = errors.currentWebVersion
  return err
}

export function isPluginVersionIncompatibleError(err) {
  return (
    err?.code === PLUGIN_VERSION_INCOMPATIBLE ||
    err?.data?.code === PLUGIN_VERSION_INCOMPATIBLE ||
    err?.errors?.code === PLUGIN_VERSION_INCOMPATIBLE ||
    err?.status === 426
  )
}

export function getPluginVersionIncompatibleMessage(err) {
  const minAppVersion = err?.minAppVersion || err?.errors?.minAppVersion
  const currentAppVersion =
    err?.currentAppVersion || err?.errors?.currentAppVersion

  if (minAppVersion && currentAppVersion) {
    return `当前 App 版本 ${currentAppVersion} 低于插件要求 ${minAppVersion}，请先升级客户端`
  }

  return err?.message || '当前版本不满足此插件要求，请先升级客户端'
}

function ensureDownloadInfo(response) {
  if (response.success) {
    if (!response.data) {
      throw normalizePluginVersionError(response)
    }
    return response.data
  }

  if (response.code === PLUGIN_VERSION_INCOMPATIBLE) {
    throw normalizePluginVersionError(response)
  }

  throw new Error(response.message || '获取下载信息失败')
}

/**
 * 获取插件分类列表
 * @returns {Promise<Array>} [{ id, name, slug, icon, sortOrder, pluginsCount }]
 */
export async function getCategories() {
  if (!isOnline) return []
  const response = await http.get('/api/plugins/categories')
  if (response.success) {
    return response.data
  }
  throw new Error(response.message || '获取分类列表失败')
}

/**
 * 获取插件市场列表
 * @param {Object} params - 查询参数
 * @param {string} params.search - 搜索关键词（插件名称或描述）
 * @param {string} params.category - 分类筛选
 * @param {string} params.sort - 排序字段：created_at/downloads（默认：created_at）
 * @param {string} params.direction - 排序方向：asc/desc（默认：desc）
 * @param {number} params.per_page - 每页数量（默认：15）
 * @param {number} params.page - 页码（默认：1）
 * @returns {Promise<Object>} { list, total, page, pageSize, lastPage }
 */
export async function getMarketPlugins(params = {}) {
  if (!isOnline) {
    return {
      list: [],
      total: 0,
      page: params.page || 1,
      pageSize: params.per_page || 15,
      lastPage: 1
    }
  }

  const apiParams = {
    search: params.search || params.keyword,
    category: params.category,
    ids: params.ids
      ? Array.isArray(params.ids)
        ? params.ids.join(',')
        : params.ids
      : undefined,
    sort: params.sort || undefined,
    direction: params.sort ? (params.direction || 'desc') : undefined,
    per_page: params.per_page || 15,
    page: params.page || 1
  }

  const response = await http.get('/api/plugins', { params: apiParams })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取插件列表失败')
}

/**
 * 获取插件详情
 * @param {string} pluginId - 插件标识符
 * @returns {Promise<Object>} 插件详情对象
 */
export async function getPluginDetails(pluginId) {
  if (!isOnline) {
    const local = (await getLocalPlugins()).find(
      (p) => String(p?.pluginId) === String(pluginId)
    )
    if (!local) throw createOfflineError()
    return { ...local, id: local.pluginId, pluginId: local.pluginId }
  }

  // 尝试获取客户端版本信息，用于服务端兼容性过滤
  const params = {}
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (ver?.appVersion) params.app_version = ver.appVersion
    if (ver?.webVersion) params.web_version = ver.webVersion
  } catch {
    // 获取版本失败时静默忽略
  }

  // 1. 优先尝试请求 V2 隔离通道详情
  try {
    const v2Res = await http.get(`/api/v2/plugins/${pluginId}`, { params })
    if (
      v2Res?.success &&
      v2Res.data &&
      (v2Res.data.channel === 'v2' || v2Res.data.sha256 || v2Res.data.checksum)
    ) {
      const sha256 = v2Res.data.sha256 || v2Res.data.checksum || ''
      return {
        ...v2Res.data,
        id: v2Res.data.id || v2Res.data.pluginId || pluginId,
        pluginId: v2Res.data.pluginId || v2Res.data.id || pluginId,
        sha256,
        checksum: v2Res.data.checksum || sha256
      }
    }
  } catch {
    // V2 接口不可用或未命中时继续尝试静态索引与旧接口
  }

  // 2. 尝试从 V2 静态索引匹配
  const staticMatch = await findInV2StaticCatalog(pluginId)
  if (staticMatch) {
    return staticMatch
  }

  // 3. 回退旧版 /api/plugins/:pluginId
  const response = await http.get(`/api/plugins/${pluginId}`, { params })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取插件详情失败')
}

/**
 * 获取插件下载地址
 * @param {string} pluginId - 插件标识符
 * @returns {Promise<string>} 下载地址
 */
export async function getPluginDownloadUrl(pluginId) {
  try {
    const response = await http.get(`/api/plugins/${pluginId}/download`)
    return ensureDownloadInfo(response).downloadUrl
  } catch (err) {
    if (isPluginVersionIncompatibleError(err)) {
      throw normalizePluginVersionError(err)
    }
    throw err
  }
}

/**
 * 获取下载签名
 * 携带客户端 appVersion 和 webVersion，由服务端返回兼容的最佳版本
 * @param {string} pluginId - 插件标识符
 * @returns {Promise<Object>} { id, pluginId, version, downloadUrl, sha256, checksum, size }
 */
export async function getDownloadSign(pluginId) {
  // 尝试获取客户端版本信息，用于服务端兼容性过滤
  const params = {}
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (ver?.appVersion) {
      params.app_version = ver.appVersion
    }
    if (ver?.webVersion) {
      params.web_version = ver.webVersion
    }
  } catch {
    // 获取版本失败时静默忽略，回退到旧客户端行为
  }

  // 1. 优先尝试 V2 隔离通道下载签名
  try {
    const v2Res = await http.get(`/api/v2/plugins/${pluginId}/download`, { params })
    if (
      v2Res &&
      ((v2Res.success && v2Res.data === null) || v2Res.code === PLUGIN_VERSION_INCOMPATIBLE)
    ) {
      throw normalizePluginVersionError(v2Res)
    }
    if (
      v2Res?.success &&
      v2Res.data &&
      v2Res.data.downloadUrl &&
      (v2Res.data.channel === 'v2' || v2Res.data.sha256 || v2Res.data.checksum)
    ) {
      const d = v2Res.data
      const sha256 = d.sha256 || d.checksum || ''
      const size = Number(d.size ?? d.fileSize ?? d.file_size ?? 0) || 0
      return {
        ...d,
        id: d.id || d.pluginId || pluginId,
        pluginId: d.pluginId || d.id || pluginId,
        version: d.version || '1.0.0',
        downloadUrl: d.downloadUrl,
        sha256,
        checksum: d.checksum || sha256,
        size
      }
    }
  } catch (v2Err) {
    if (isPluginVersionIncompatibleError(v2Err)) {
      throw normalizePluginVersionError(v2Err)
    }
    if (v2Err?.code === 'PLUGIN_REVOKED' || v2Err?.data?.code === 'PLUGIN_REVOKED') {
      throw v2Err
    }
  }

  // 2. 尝试从 V2 静态索引匹配
  const staticMatch = await findInV2StaticCatalog(pluginId)
  if (staticMatch && staticMatch.downloadUrl) {
    if (staticMatch.revoked) {
      const reason = staticMatch.revokedReason || staticMatch.revoked_reason || '该插件已被官方安全下架'
      const err = new Error(`插件已被官方安全下架: ${reason}`)
      err.code = 'PLUGIN_REVOKED'
      throw err
    }
    return {
      id: staticMatch.id,
      pluginId: staticMatch.pluginId,
      version: staticMatch.version,
      downloadUrl: staticMatch.downloadUrl,
      sha256: staticMatch.sha256,
      checksum: staticMatch.checksum,
      size: staticMatch.size
    }
  }

  // 3. 回退原有的 /api/download/sign/:pluginId
  try {
    const response = await http.get(`/api/download/sign/${pluginId}`, { params })
    return ensureDownloadInfo(response)
  } catch (err) {
    if (isPluginVersionIncompatibleError(err)) {
      throw normalizePluginVersionError(err)
    }
    throw err
  }
}



/**
 * 获取插件留言列表
 * @param {string} pluginId - 插件标识符
 * @param {Object} params - 分页参数
 * @returns {Promise<Object>}
 */
export async function getPluginComments(pluginId, params = {}) {
  const response = await http.get(`/api/plugins/${pluginId}/comments`, {
    params
  })
  if (response.success) {
    return response.data
  }
  throw new Error(response.message || '获取留言失败')
}

/**
 * 提交插件留言
 * @param {string} pluginId - 插件标识符
 * @param {Object} data - { content, parent_id }
 * @returns {Promise<Object>}
 */
export async function postPluginComment(pluginId, data) {
  const response = await http.post(`/api/plugins/${pluginId}/comments`, data)
  if (response.success) {
    return response.data
  }
  throw new Error(response.message || '提交留言失败')
}
