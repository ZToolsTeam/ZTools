/**
 * 更新检查 API
 *
 * 对接 Backend 的更新相关接口
 */

import http from '../utils/http'
import { isOnline } from '../config/runtime-mode'
import { loadV2StaticCatalogList } from './plugins'
import { getPluginPlatforms } from '../utils/platform'
import { compareNumericVersions } from '../utils/version'
import { isBundledPlugin } from '../utils/bundledPlugins'

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

const SHA256_PATTERN = /^[a-f0-9]{64}$/i

function normalizeId(pluginId) {
  return String(pluginId || '').trim().toLowerCase()
}

function noUpdate(pluginId, message) {
  return { hasUpdate: false, pluginId: String(pluginId), message }
}

/**
 * 用 V2 静态索引（CDN plugins-v2/catalog.json）里的条目算出某个已装插件的更新信息。
 * 新插件只发布到静态索引，不在后台数据库里，所以更新要以这里为准。
 * 返回结构与后台接口一致，可直接交给 downloadPluginUpdate。
 * @param {object} entry - 静态索引中的插件条目
 * @param {string} currentVersion - 本地已装版本
 * @param {'windows'|'macos'} platform - 当前宿主平台
 */
export function buildCatalogUpdateInfo(entry, currentVersion, platform) {
  const pluginId = entry?.pluginId || entry?.id || ''
  if (entry?.revoked) {
    return { ...noUpdate(pluginId, '插件已下架'), revoked: true }
  }
  const platforms = getPluginPlatforms(entry)
  if (platforms && !platforms.includes(platform)) {
    return noUpdate(pluginId, '新版本不支持当前平台')
  }
  const latest = String(entry?.version || '').trim()
  const cmp = compareNumericVersions(latest, String(currentVersion || '').trim())
  if (cmp === null || cmp <= 0) {
    return { ...noUpdate(pluginId, '已是最新版本'), version: latest }
  }
  const sha256 = String(entry.sha256 || entry.checksum || '').trim().toLowerCase()
  const downloadUrl = String(entry.downloadUrl || entry.download_url || '').trim()
  // 主进程安装时强制校验 SHA-256，缺校验值或下载地址的条目装不上，不提示更新
  if (!SHA256_PATTERN.test(sha256) || !downloadUrl) {
    return { ...noUpdate(pluginId, '新版本缺少下载信息'), version: latest }
  }
  const size = Number(entry.size ?? entry.file_size ?? entry.fileSize ?? 0) || 0
  const info = {
    hasUpdate: true,
    pluginId: String(pluginId),
    version: latest,
    download_url: downloadUrl,
    downloadUrl,
    checksum: sha256,
    sha256,
    file_size: size,
    fileSize: size,
    release_notes: entry.releaseNotes || entry.release_notes || '',
    message: '发现新版本',
    source: 'static-catalog'
  }
  // minZToolsVersion 是插件 API 版本，不是客户端版本，这里不当作客户端最低版本
  if (entry.minAppVersion) info.minAppVersion = entry.minAppVersion
  return info
}

async function loadStaticCatalogMap() {
  const list = await loadV2StaticCatalogList()
  if (!Array.isArray(list)) return null
  const map = new Map()
  for (const entry of list) {
    const id = normalizeId(entry?.pluginId || entry?.id)
    if (id) map.set(id, entry)
  }
  return map
}

async function attachClientVersions(target) {
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (ver?.appVersion) {
      target.app_version = ver.appVersion
    }
    if (ver?.webVersion) {
      target.web_version = ver.webVersion
    }
  } catch {
    // 获取版本失败时静默忽略，回退到旧客户端行为
  }
  return target
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
  const currentVersion = params.current_version || '1.0.0'

  // 内置插件跟随客户端一起更新，不单独检查
  if (isBundledPlugin(pluginId)) return noUpdate(pluginId, '内置插件随客户端更新')

  // 新插件以静态索引为准；索引里没有的再问后台（老插件）
  const catalog = await loadStaticCatalogMap()
  const entry = catalog?.get(normalizeId(pluginId))
  if (entry) return buildCatalogUpdateInfo(entry, currentVersion, platform)

  const queryParams = await attachClientVersions({
    platform,
    current_version: currentVersion
  })

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
  // 兼容两种传入格式：{ id: xxx } 或 { pluginId: xxx }
  const requested = (data.plugins || [])
    .map((p) => ({ id: p.id || p.pluginId, version: p.version }))
    .filter((p) => p.id)

  const updates = {}
  const catalog = await loadStaticCatalogMap()
  const legacy = []
  for (const item of requested) {
    if (isBundledPlugin(item.id)) {
      updates[item.id] = noUpdate(item.id, '内置插件随客户端更新')
      continue
    }
    const entry = catalog?.get(normalizeId(item.id))
    if (entry) {
      updates[item.id] = buildCatalogUpdateInfo(entry, item.version || '1.0.0', platform)
    } else {
      legacy.push(item)
    }
  }

  // 静态索引里没有的老插件，仍由后台按版本兼容性返回
  if (legacy.length === 0) return updates

  const body = await attachClientVersions({ platform, plugins: legacy })
  let response
  try {
    response = await http.post('/api/update/plugins/batch', body)
  } catch (err) {
    // 后台不可用时，已从静态索引算出的结果照常返回，不让老接口拖累新插件更新
    if (Object.keys(updates).length > 0) {
      console.warn('[update] 后台批量检查失败，仅返回静态索引结果:', err)
      return updates
    }
    throw err
  }

  if (response.success) {
    return { ...(response.data || {}), ...updates }
  }

  if (Object.keys(updates).length > 0) {
    console.warn('[update] 后台批量检查失败，仅返回静态索引结果:', response.message)
    return updates
  }
  throw new Error(response.message || '批量检查更新失败')
}
