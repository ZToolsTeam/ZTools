/**
 * 插件市场 API
 *
 * 对接 Backend 的插件相关接口
 */

import http from '../utils/http'
import { createOfflineError, isOnline } from '../config/runtime-mode'
import { getLocalPlugins } from './native'

export const PLUGIN_VERSION_INCOMPATIBLE = 'PLUGIN_VERSION_INCOMPATIBLE'

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
 * 返回字段包括：
 * - id: 插件标识符
 * - pluginId: 插件标识符
 * - name: 插件名称
 * - version: 当前版本号（最新版本）
 * - description: 描述
 * - category: 分类
 * - author: 作者
 * - rating: 评分
 * - downloads: 下载次数
 * - size: 文件大小
 * - downloadUrl: 下载地址（最新版本）
 * - icon: 图标
 * - keywords: 关键词数组
 * - screenshots: 截图列表
 * - features: 功能列表
 * - changelogs: 更新日志
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
 * @returns {Promise<Object>} { downloadUrl, pluginId }
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
