/**
 * 更新检查 API
 *
 * 对接 Backend 的更新相关接口
 */

import http from '../utils/http'
import { isOnline } from '../config/runtime-mode'

const SUPPORTED_UPDATE_PLATFORMS = new Set(['windows', 'macos'])

async function resolveUpdatePlatform(platform) {
  let resolvedPlatform = platform

  if (resolvedPlatform === undefined) {
    if (typeof window === 'undefined' || typeof window.ztools?.sys?.getInfo !== 'function') {
      throw new Error('无法读取宿主平台信息，已取消更新检查')
    }

    try {
      const info = await window.ztools.sys.getInfo()
      resolvedPlatform = info?.platform
    } catch {
      throw new Error('读取宿主平台失败，已取消更新检查')
    }
  }

  if (!SUPPORTED_UPDATE_PLATFORMS.has(resolvedPlatform)) {
    const platformName =
      typeof resolvedPlatform === 'string' && resolvedPlatform.trim()
        ? resolvedPlatform
        : 'unknown'
    throw new Error(
      `当前平台“${platformName}”不支持更新检查（仅支持 Windows/macOS）`
    )
  }

  return resolvedPlatform
}

/**
 * 检查主程序更新
 * @param {Object} params - 查询参数
 * @param {string} params.platform - 平台：windows/macos（默认读取宿主平台）
 * @param {string} params.current_version - 当前版本号（默认：1.0.0）
 * @returns {Promise<Object>} 更新信息
 * {
 *   hasUpdate: boolean,
 *   version: string,
 *   downloadUrl: string,
 *   fileSize: number,
 *   checksum: string,
 *   releaseNotes: string,
 *   publishedAt: string,
 *   isMandatory: boolean
 * }
 */
export async function checkAppUpdate(params = {}) {
  const platform = await resolveUpdatePlatform(params.platform)
  const response = await http.get('/api/update/app', {
    params: {
      platform,
      current_version: params.current_version || '1.0.0'
    }
  })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '检查更新失败')
}

/**
 * 检查插件更新
 * 携带客户端 appVersion 和 webVersion，由服务端返回兼容的最佳版本
 * @param {string} pluginId - 插件标识符
 * @param {Object} params - 查询参数
 * @param {string} params.platform - 平台：windows/macos（默认读取宿主平台）
 * @param {string} params.current_version - 当前版本号（默认：1.0.0）
 * @returns {Promise<Object>} 更新信息
 */
export async function checkPluginUpdate(pluginId, params = {}) {
  if (!isOnline) return { hasUpdate: false }
  const platform = await resolveUpdatePlatform(params.platform)
  // 构建基础请求参数
  const queryParams = {
    platform,
    current_version: params.current_version || '1.0.0'
  }

  // 尝试获取客户端版本信息，用于服务端兼容性过滤
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (ver?.appVersion) {
      queryParams.app_version = ver.appVersion
    }
    if (ver?.webVersion) {
      queryParams.web_version = ver.webVersion
    }
  } catch {
    // 获取版本失败时静默忽略，回退到旧客户端行为
  }

  const response = await http.get(`/api/update/plugin/${pluginId}`, {
    params: queryParams
  })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '检查插件更新失败')
}

/**
 * 批量检查插件更新
 * 携带客户端 appVersion 和 webVersion，由服务端返回兼容的最佳版本
 * @param {Object} data - 请求数据
 * @param {string} data.platform - 平台：windows/macos（默认读取宿主平台）
 * @param {Array<Object>} data.plugins - 插件列表
 * @param {string} data.plugins[].id - 插件标识符
 * @param {string} data.plugins[].version - 当前版本
 * @returns {Promise<Object>} 更新信息对象（以插件标识符为key）
 */
export async function batchCheckPlugins(data) {
  if (!isOnline) return {}
  const platform = await resolveUpdatePlatform(data.platform)
  // 构建基础请求体
  const body = {
    platform,
    plugins: data.plugins.map((p) => ({
      // 兼容两种传入格式：{ id: xxx } 或 { pluginId: xxx }
      id: p.id || p.pluginId,
      version: p.version
    }))
  }

  // 尝试获取客户端版本信息，用于服务端兼容性过滤
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (ver?.appVersion) {
      body.app_version = ver.appVersion
    }
    if (ver?.webVersion) {
      body.web_version = ver.webVersion
    }
  } catch {
    // 获取版本失败时静默忽略，回退到旧客户端行为
  }

  const response = await http.post('/api/update/plugins/batch', body)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '批量检查更新失败')
}
