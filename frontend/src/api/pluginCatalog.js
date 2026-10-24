/**
 * 插件目录（CDN 静态索引）公共能力
 *
 * 插件市场以 CDN 上的 plugins-v2/catalog.json 为准：列表、详情、下载信息与更新检查都从这里算出。
 * 未配置官方后台（单机模式）时只用这里；配置了后台时 plugins.js / update.js 的后台分支也复用这里的校验与换算，保证结果一致。
 */

import { V2_CATALOG_CDN_URL } from '../utils/declarativePluginLoader'
import { getPluginPlatforms } from '../utils/platform'
import { compareNumericVersions } from '../utils/version'

export const PLUGIN_VERSION_INCOMPATIBLE = 'PLUGIN_VERSION_INCOMPATIBLE'

const SUPPORTED_UPDATE_PLATFORMS = new Set(['windows', 'macos'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const V2_CATALOG_CACHE_TTL_MS = 60 * 1000
const V2_CATALOG_FETCH_TIMEOUT_MS = 2500

let _v2CatalogCache = null
let _v2CatalogCacheTime = 0

export function normalizeCatalogId(pluginId) {
  return String(pluginId || '').trim().toLowerCase()
}

/**
 * 读取 V2 静态插件索引（CDN plugins-v2/catalog.json）的插件列表，60 秒内存缓存。
 * 拉取失败、超时或格式不对时返回 null，由调用方决定如何降级。
 * @returns {Promise<Array<object> | null>}
 */
export async function loadV2StaticCatalogList() {
  if (typeof fetch !== 'function') return null

  const now = Date.now()
  if (_v2CatalogCache && now - _v2CatalogCacheTime < V2_CATALOG_CACHE_TTL_MS) {
    return _v2CatalogCache
  }
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), V2_CATALOG_FETCH_TIMEOUT_MS) : null
    try {
      const res = await fetch(V2_CATALOG_CDN_URL, {
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      })
      if (!res.ok) return null
      const raw = await res.json()
      const list = Array.isArray(raw)
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
      return list
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/**
 * 把静态索引里的条目整理成统一结构（id / pluginId / sha256 / size 等字段补齐）
 */
export function normalizeCatalogEntry(found, pluginId = '') {
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

/**
 * 在静态索引里按插件 id（不区分大小写）查找条目，找不到或索引不可用时返回 null
 */
export async function findInV2StaticCatalog(pluginId) {
  const pid = normalizeCatalogId(pluginId)
  if (!pid) return null

  const list = await loadV2StaticCatalogList()
  if (!Array.isArray(list)) return null
  const found = list.find(
    (item) => normalizeCatalogId(item?.id || item?.pluginId) === pid
  )
  if (!found) return null
  return normalizeCatalogEntry(found, pluginId)
}

/**
 * 由静态索引条目生成下载信息；已下架的插件直接抛出 PLUGIN_REVOKED
 * @returns {object|null} 条目缺下载地址时返回 null
 */
export function buildCatalogDownloadInfo(entry) {
  if (!entry || !entry.downloadUrl) return null
  if (entry.revoked) {
    const reason = entry.revokedReason || entry.revoked_reason || '该插件已被官方安全下架'
    const err = new Error(`插件已被官方安全下架: ${reason}`)
    err.code = 'PLUGIN_REVOKED'
    throw err
  }
  return {
    id: entry.id,
    pluginId: entry.pluginId,
    version: entry.version,
    downloadUrl: entry.downloadUrl,
    sha256: entry.sha256,
    checksum: entry.checksum,
    size: entry.size
  }
}

export function normalizePluginVersionError(payload = {}) {
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

/**
 * 解析更新检查用的宿主平台（只支持 windows / macos），读取失败时抛错取消检查
 */
export async function resolveUpdatePlatform(platform) {
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

export function noUpdate(pluginId, message) {
  return { hasUpdate: false, pluginId: String(pluginId), message }
}

/**
 * 用 V2 静态索引（CDN plugins-v2/catalog.json）里的条目算出某个已装插件的更新信息。
 * 新插件只发布到静态索引，所以更新要以这里为准。
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

/**
 * 静态索引按规范化 id 建表；索引不可用时返回 null
 * @returns {Promise<Map<string, object> | null>}
 */
export async function loadStaticCatalogMap() {
  const list = await loadV2StaticCatalogList()
  if (!Array.isArray(list)) return null
  const map = new Map()
  for (const entry of list) {
    const id = normalizeCatalogId(entry?.pluginId || entry?.id)
    if (id) map.set(id, entry)
  }
  return map
}
