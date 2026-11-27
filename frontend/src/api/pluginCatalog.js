import { nativeCatalogUrl } from '@edition'
import { getPluginCategories } from '../utils/pluginCategories'
import { getLocalizedPluginField, mergePluginI18n } from '../utils/pluginI18n'
import { resolveErrorMessage } from '../utils/errorMessage'
import { t } from '@/i18n'
/**
 * 插件目录（CDN 静态索引）公共能力
 *
 * 插件市场以 CDN 上的 plugins-v2/catalog.json 为准：列表、详情、下载信息与更新检查都从这里算出；
 * 当 @edition 提供 nativeCatalogUrl 时，会并发拉取并合并官方原生插件附加目录。
 * 官方版与开源版共用这些校验，旧版插件目录不能作为下载或更新来源。
 */

import { V2_CATALOG_CDN_URL } from '../utils/declarativePluginLoader'
import { getPluginPlatforms, isMacOS } from '../utils/platform'
import { compareNumericVersions } from '../utils/version'
import {
  getBundledPluginEntry,
  getStoreOfficialPluginMeta
} from '../utils/bundledPlugins'

export const PLUGIN_VERSION_INCOMPATIBLE = 'PLUGIN_VERSION_INCOMPATIBLE'

const SUPPORTED_UPDATE_PLATFORMS = new Set(['windows', 'macos'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const V2_CATALOG_CACHE_TTL_MS = 60 * 1000
const V2_CATALOG_FETCH_TIMEOUT_MS = 2500

let _v2CatalogCache = null
let _v2CatalogCacheTime = 0
let _v2CatalogPending = null

export function normalizeCatalogId(pluginId) {
  return String(pluginId || '').trim().toLowerCase()
}

/** 市场安装包必须来自新版分发目录，不能把旧版 ZIP 当作声明式插件安装。 */
export function isV2PluginDownloadUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === new URL(V2_CATALOG_CDN_URL).origin &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith('/plugins-v2/') && url.pathname.endsWith('.zip')
  } catch {
    // 地址不合法，调用方会拒绝安装或更新。
    return false
  }
}

/**
 * 读取 V2 静态插件索引（CDN plugins-v2/catalog.json）的插件列表，60 秒内存缓存。
 * 合并并发请求；拉取失败明确报错，不能把故障当成空目录或已是最新版。
 * @returns {Promise<Array<object>>}
 */
export async function loadV2StaticCatalogList({ forceRefresh = false } = {}) {
  const now = Date.now()
  if (!forceRefresh && _v2CatalogCache && now - _v2CatalogCacheTime < V2_CATALOG_CACHE_TTL_MS) {
    return _v2CatalogCache
  }
  if (_v2CatalogPending) return _v2CatalogPending
  _v2CatalogPending = fetchCatalogList()
  try { return await _v2CatalogPending } finally { _v2CatalogPending = null }
}

/**
 * 从单个静态目录 URL 拉取并解析插件条目数组
 * @param {string} url - 静态目录 JSON 地址
 * @param {{ allowNotFound?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<object>>}
 */
async function fetchSingleCatalog(url, { allowNotFound = false, signal: externalSignal } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const onExternalAbort = () => controller?.abort()
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller?.abort()
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  const timer = controller ? setTimeout(() => controller.abort(), V2_CATALOG_FETCH_TIMEOUT_MS) : null
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    })
    if (allowNotFound && res.status === 404) {
      return []
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.json()
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.plugins)
        ? raw.plugins
        : Array.isArray(raw?.list)
          ? raw.list
          : null
    if (!list) throw new Error(t('pluginCatalog.invalidFormat'))
    return list
  } finally {
    if (timer) clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    controller?.abort()
  }
}

/**
 * 拉取附加原生插件目录：404 视为暂无原生插件返回空数组；其余网络或解析异常降级为空数组并告警，不阻断主市场
 * @param {string} url - 原生插件附加目录地址
 * @param {AbortSignal} [signal] - 主目录失败时的联级取消信号
 * @returns {Promise<Array<object>>}
 */
async function fetchNativeCatalogList(url, signal) {
  try {
    return await fetchSingleCatalog(url, { allowNotFound: true, signal })
  } catch (err) {
    if (!signal?.aborted) {
      console.warn('[pluginCatalog] 拉取原生插件附加目录失败，已忽略:', err)
    }
    return []
  }
}

/**
 * 合并主目录与附加原生插件目录：
 * 按规范化插件 ID 去重，同 ID 时以原生目录条目优先覆盖并保留原顺序，新增条目追加在后
 * @param {Array<object>} primaryList - 主目录列表
 * @param {Array<object>} nativeList - 附加原生目录列表
 * @returns {Array<object>}
 */
function mergeCatalogLists(primaryList, nativeList) {
  const merged = []
  const indexById = new Map()

  const upsert = (item) => {
    if (!item || typeof item !== 'object') return
    const id = normalizeCatalogId(item?.id) || normalizeCatalogId(item?.pluginId)
    if (!id) return
    if (indexById.has(id)) {
      merged[indexById.get(id)] = item
    } else {
      indexById.set(id, merged.length)
      merged.push(item)
    }
  }

  for (const item of primaryList) upsert(item)
  for (const item of nativeList) upsert(item)
  return merged
}

async function fetchCatalogList() {
  try {
    const extraUrl = typeof nativeCatalogUrl === 'string' ? nativeCatalogUrl.trim() : ''
    // native-catalog.json 仅承载 Windows 原生 DLL 发行包；macOS 宿主跳过拉取，防止覆盖双端插件的 macOS target
    const shouldFetchNative = Boolean(extraUrl && extraUrl !== V2_CATALOG_CDN_URL && !isMacOS())
    const nativeCancelController =
      shouldFetchNative && typeof AbortController !== 'undefined' ? new AbortController() : null

    const primaryPromise = fetchSingleCatalog(V2_CATALOG_CDN_URL).catch((err) => {
      nativeCancelController?.abort()
      throw err
    })
    const nativePromise = shouldFetchNative
      ? fetchNativeCatalogList(extraUrl, nativeCancelController?.signal)
      : Promise.resolve([])

    const [primaryResult, nativeResult] = await Promise.allSettled([primaryPromise, nativePromise])
    if (primaryResult.status === 'rejected') {
      throw primaryResult.reason
    }

    const nativeList = nativeResult.status === 'fulfilled' ? nativeResult.value : []
    const list = mergeCatalogLists(primaryResult.value, nativeList)
    _v2CatalogCache = list
    _v2CatalogCacheTime = Date.now()
    return list
  } catch (cause) {
    const error = new Error(t('pluginCatalog.unavailable'), { cause })
    error.code = 'PLUGIN_CATALOG_UNAVAILABLE'
    throw error
  }
}

/**
 * 把静态索引里的条目整理成统一结构（id / pluginId / sha256 / size 等字段补齐）
 */
export function normalizeCatalogEntry(found, pluginId = '') {
  const resolvedId = found.id || found.pluginId || pluginId
  const localMeta = getBundledPluginEntry(resolvedId) || getStoreOfficialPluginMeta(resolvedId)
  const sha256 = found.sha256 || found.checksum || ''
  const category = getPluginCategories(localMeta?.category || found.category)
  const mergedI18n = mergePluginI18n(found.i18n, localMeta?.i18n)
  const defaultLocale = localMeta?.defaultLocale || found.defaultLocale
  const categoryId = localMeta?.categoryId || found.categoryId
  return {
    ...found,
    id: resolvedId,
    pluginId: found.pluginId || found.id || pluginId,
    name: localMeta?.name || found.name || resolvedId,
    title: localMeta?.title || localMeta?.name || found.title || found.name || resolvedId,
    description: localMeta?.description || found.description || '',
    category,
    ...(categoryId ? { categoryId } : {}),
    ...(defaultLocale ? { defaultLocale } : {}),
    ...(mergedI18n ? { i18n: mergedI18n } : {}),
    version: found.version || '1.0.0',
    downloadUrl: found.downloadUrl || '',
    sha256,
    checksum: sha256,
    size: Number(found.size ?? found.file_size ?? found.fileSize ?? 0) || 0
  }
}

/**
 * 在静态索引里按插件 id（不区分大小写）查找条目，找不到返回 null；目录不可用时抛错
 */
export async function findInV2StaticCatalog(pluginId, options) {
  const pid = normalizeCatalogId(pluginId)
  if (!pid) return null

  const list = await loadV2StaticCatalogList(options)
  if (!Array.isArray(list)) return null
  const found = list.find(
    (item) => normalizeCatalogId(item?.id || item?.pluginId) === pid
  )
  if (!found) return null
  return normalizeCatalogEntry(found, pluginId)
}

/**
 * 由静态索引条目生成下载信息；已下架的插件直接抛出 PLUGIN_REVOKED
 * @returns {object|null} 不存在的条目返回 null，未发布或安装包无效时抛错
 */
export function buildCatalogDownloadInfo(entry) {
  if (!entry) return null
  if (entry.revoked) {
    const reason = getLocalizedPluginField(entry, 'revokedReason') || t('pluginCatalog.revokedDefaultReason')
    const err = new Error(t('pluginCatalog.revokedWithReason', { reason }))
    err.code = 'PLUGIN_REVOKED'
    throw err
  }
  if (entry.draft) {
    const err = new Error(entry.draftReason || t('pluginCatalog.notPublished'))
    err.code = 'PLUGIN_NOT_PUBLISHED'
    throw err
  }
  if (!isV2PluginDownloadUrl(entry.downloadUrl) || !SHA256_PATTERN.test(entry.sha256 || entry.checksum || '')) {
    const err = new Error(t('pluginCatalog.invalidPackage'))
    err.code = 'PLUGIN_INVALID_PACKAGE'
    throw err
  }
  return {
    id: entry.id,
    pluginId: entry.pluginId,
    version: entry.version,
    downloadUrl: entry.downloadUrl,
    sha256: entry.sha256,
    checksum: entry.checksum,
    size: entry.size,
    ...(entry.minAppVersion ? { minAppVersion: entry.minAppVersion } : {})
  }
}

export function normalizePluginVersionError(payload = {}) {
  const data = payload.data || payload
  const errors = data.errors || payload.errors || {}
  const err = new Error(
    resolveErrorMessage(data?.message ? data : payload, 'pluginCatalog.versionIncompatible')
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
    return t('pluginCatalog.versionTooLow', { current: currentAppVersion, min: minAppVersion })
  }

  return resolveErrorMessage(err, 'pluginCatalog.versionIncompatible')
}

/**
 * 解析更新检查用的宿主平台（只支持 windows / macos），读取失败时抛错取消检查
 */
export async function resolveUpdatePlatform(platform) {
  let resolvedPlatform = platform

  if (resolvedPlatform === undefined) {
    if (typeof window === 'undefined' || typeof window.ztools?.sys?.getInfo !== 'function') {
      throw new Error(t('pluginCatalog.platformInfoUnavailable'))
    }

    try {
      const info = await window.ztools.sys.getInfo()
      resolvedPlatform = info?.platform
    } catch {
      throw new Error(t('pluginCatalog.platformReadFailed'))
    }
  }

  if (!SUPPORTED_UPDATE_PLATFORMS.has(resolvedPlatform)) {
    const platformName =
      typeof resolvedPlatform === 'string' && resolvedPlatform.trim()
        ? resolvedPlatform
        : 'unknown'
    throw new Error(t('pluginCatalog.platformUnsupported', { platform: platformName }))
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
    return {
      ...noUpdate(pluginId, t('pluginCatalog.revokedShort')),
      revoked: true,
      revokedReason: getLocalizedPluginField(entry, 'revokedReason') || t('pluginCatalog.revokedDisabledReason'),
      ...(entry.i18n && typeof entry.i18n === 'object' ? { i18n: entry.i18n } : {})
    }
  }
  if (entry?.draft) return noUpdate(pluginId, t('pluginCatalog.notPublished'))
  const platforms = getPluginPlatforms(entry)
  if (platforms && !platforms.includes(platform)) {
    return noUpdate(pluginId, t('pluginCatalog.updatePlatformUnsupported'))
  }
  const latest = String(entry?.version || '').trim()
  const cmp = compareNumericVersions(latest, String(currentVersion || '').trim())
  if (cmp === null || cmp <= 0) {
    return { ...noUpdate(pluginId, t('pluginCatalog.alreadyLatest')), version: latest }
  }
  const sha256 = String(entry.sha256 || entry.checksum || '').trim().toLowerCase()
  const downloadUrl = String(entry.downloadUrl || entry.download_url || '').trim()
  // 主进程安装时强制校验 SHA-256，缺校验值或下载地址的条目装不上，不提示更新
  if (!SHA256_PATTERN.test(sha256) || !isV2PluginDownloadUrl(downloadUrl)) {
    return { ...noUpdate(pluginId, t('pluginCatalog.missingDownloadInfo')), version: latest }
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
    message: t('pluginCatalog.newVersionFound'),
    source: 'static-catalog'
  }
  // minZToolsVersion 是插件 API 版本，不是客户端版本，这里不当作客户端最低版本
  if (entry.minAppVersion) info.minAppVersion = entry.minAppVersion
  return info
}

/**
 * 静态索引按规范化 id 建表；索引不可用时抛错
 * @returns {Promise<Map<string, object>>}
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
