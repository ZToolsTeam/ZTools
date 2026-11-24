import {
  CATEGORY_ID_TO_NAME,
  isAllCategory,
  normalizeCategoryIds,
  normalizeCategoryRouteParam
} from '@/utils/pluginCategories'
import { invalidatePluginSession } from '@/declarative/pluginSession'
import { defineStore } from 'pinia'
import router from '@/router'
import { routeUtils } from '@/router/routes'
import {
  getOfficialPluginsList,
  isOfficialPlugin,
  isClientProvidedPlugin,
  getOfficialPlugin
} from '@/utils/officialPlugins'

import {
  getMarketPlugins as apiGetMarketPlugins,
  getPluginDetails as apiGetPluginDetails,
  getLocalPlugins as apiGetLocalPlugins,
  openPlugin as apiOpenPlugin,
  batchCheckPlugins,
  getDownloadSign,
  installPluginNative
} from '@/api/apiserver'
import { fetchVersions, checkCompat } from '@/composables/useVersionCompat'
import { loadV2StaticCatalogList } from '@/api/pluginCatalog'
import { formatLogArg } from '@/utils/logFormat'
import { isPluginSupportedOnCurrentPlatform, getPluginPlatforms, getPluginPlatformLabel } from '@/utils/platform'
import { cloudSync, pluginLifecycle, track } from '@edition'
import {
  StoreCatalogManager,
  isOfficialPluginItem
} from '@/utils/storeCatalogManager'
import {
  clearDeclarativePluginCache,
  loadInstalledDeclarativePlugin
} from '@/utils/declarativePluginLoader'
import {
  OFFICIAL_BADGE_CODE,
  getBundledPluginEntries,
  getBundledPluginEntry,
  isBundledPlugin,
  resolveBundledReplacement,
  resolveBundledReplacementFeature
} from '@/utils/bundledPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'
import { getLocalizedPluginField, mergePluginI18n } from '@/utils/pluginI18n'
import { runPluginInstall } from '@/utils/pluginInstallOperation'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { t } from '@/i18n'

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasPluginCategory(plugin) {
  if (!isPlainRecord(plugin)) return false
  if (normalizeCategoryIds(plugin.categoryId).length > 0) return true
  if (normalizeCategoryIds(plugin.category).length > 0) return true
  if (typeof plugin.category === 'string' && plugin.category.trim().length > 0) return true
  if (Array.isArray(plugin.category)) {
    return plugin.category.some((item) => typeof item === 'string' && item.trim().length > 0)
  }
  return false
}

function isSameJsonValue(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** 从市场目录条目提取可用于兜底补齐本地已安装插件的元数据（icon / i18n / 分类） */
function extractCatalogPatch(item) {
  if (!isPlainRecord(item)) return null
  const icon = typeof item.icon === 'string' && item.icon.startsWith('http') ? item.icon : ''
  const i18n = isPlainRecord(item.i18n) ? mergePluginI18n(item.i18n) : undefined
  const categoryIds = normalizeCategoryIds(item.categoryId || item.category)
  const categoryId = categoryIds.length === 1
    ? categoryIds[0]
    : categoryIds.length > 1
      ? categoryIds
      : undefined
  const category = categoryIds.length > 0
    ? categoryIds.map((id) => CATEGORY_ID_TO_NAME[id]).filter(Boolean).join(' / ')
    : ''
  if (!icon && !i18n && !categoryId && !category) return null
  return {
    ...(icon ? { icon } : {}),
    ...(i18n ? { i18n } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(category ? { category } : {})
  }
}

function normalizeCatalogPatchEntry(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed ? { icon: trimmed } : null
  }
  return extractCatalogPatch(raw)
}

function mergeCatalogPatch(existing, incoming) {
  if (!existing) return incoming
  if (!incoming) return existing
  const mergedI18n = mergePluginI18n(existing.i18n, incoming.i18n)
  return {
    ...(existing.icon || incoming.icon ? { icon: incoming.icon || existing.icon } : {}),
    ...(mergedI18n ? { i18n: mergedI18n } : {}),
    ...(existing.categoryId || incoming.categoryId ? { categoryId: incoming.categoryId || existing.categoryId } : {}),
    ...(existing.category || incoming.category ? { category: incoming.category || existing.category } : {})
  }
}

/** 安装 / 卸载通知交给版本处理；版本钩子出错只记日志，不影响安装状态 */
function notifyLifecycle(name, pluginId) {
  try {
    pluginLifecycle?.[name]?.(pluginId)
  } catch (err) {
    console.warn(`[plugins] pluginLifecycle.${name} 失败:`, err)
  }
}

/**
 * 规范化插件 ID（业务标识符）
 * 注意：使用 pluginId（业务标识符，如 'image-tool'），而不是 id（数据库主键 1, 2, 3...）
 * @param {string|object} value - 插件 ID 或插件对象
 * @returns {string} 规范化后的插件 ID
 */
function normalizePluginId(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    // 只使用 pluginId（业务标识符），不再使用 id（数据库主键）
    const nestedId = value.pluginId
    return nestedId === null || nestedId === undefined
      ? ''
      : String(nestedId).trim()
  }
  return String(value).trim()
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return []
  return Array.from(
    new Set(list.map((item) => normalizePluginId(item)).filter(Boolean))
  )
}

function parseConfigList(rawValue) {
  if (Array.isArray(rawValue)) return rawValue
  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * 解析并校验本地保存的最近使用时间：只保留仍在 recents 中、且为合理时间戳的条目。
 * 外部数据（配置文件）不可信：非对象、非数字、未来时间、原型链键名一律丢弃。
 * @param {unknown} raw - 配置中读出的字符串或对象
 * @param {string[]} recents
 * @param {number} [now]
 */
export function sanitizeRecentUsedAt(raw, recents, now = Date.now()) {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const id of Array.isArray(recents) ? recents : []) {
    if (!Object.hasOwn(value, id)) continue
    const time = value[id]
    if (Number.isFinite(time) && time > 0 && time <= now + 60_000) result[id] = time
  }
  return result
}

export const HIDDEN_BUNDLED_CONFIG_KEY = 'plugins.hidden_bundled'
export const BUNDLED_VISIBILITY_SIGNAL = 'ztools_bundled_visibility_changed'

/**
 * 解析并校验已隐藏（假卸载）的内置插件 ID 列表：
 * 外部配置文件不可信，仅保留合法的随客户端内置插件 ID（小写去重）。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function sanitizeHiddenBundledIds(raw) {
  const list = parseConfigList(raw)
  const result = []
  const seen = new Set()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const id = item.trim().toLowerCase()
    if (!id || seen.has(id) || !isBundledPlugin(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

async function persistBundledPluginVisibility(store, id, hidden) {
  const config = window.ztools?.config
  if (typeof config?.get !== 'function' || typeof config?.set !== 'function') {
    throw new Error(t('pluginsStore.saveBundledVisibilityFailed'))
  }
  await store.ensureHiddenBundledLoaded()
  const nextHidden = new Set(store.hiddenBundledSet)
  if (hidden) nextHidden.add(id)
  else nextHidden.delete(id)
  const saved = await config.set(
    HIDDEN_BUNDLED_CONFIG_KEY,
    JSON.stringify(Array.from(nextHidden)),
    false,
    'user_settings.json'
  )
  if (saved !== true) throw new Error(t('pluginsStore.saveBundledVisibilityFailed'))

  // 先前发出的配置读取可能晚于本次写入完成。
  store._hiddenBundledLoadPromise = null
  store.hiddenBundledSet = nextHidden
  store._hiddenBundledLoaded = true
  store._installedRevision += 1
  const entry = getBundledPluginEntry(id)
  const resolvedId = entry?.pluginId || id
  if (hidden) {
    store.installedSet = new Set(Array.from(store.installedSet).filter(
      (installedId) => normalizePluginId(installedId).toLowerCase() !== id
    ))
    store.installedPlugins = store.installedPlugins.filter(
      (p) => normalizePluginId(p.pluginId || p.id).toLowerCase() !== id
    )
  } else {
    store.installedSet.add(resolvedId)
    if (entry && isPluginVisible(entry) && isPluginSupportedOnCurrentPlatform(entry) &&
        !store.installedPlugins.some((p) => normalizePluginId(p.pluginId || p.id).toLowerCase() === id)) {
      const restored = { ...entry, builtin: true, lastUsedTime: store.recentUsedAt[resolvedId] || 0 }
      store.installedPlugins = [...store.installedPlugins, restored].sort(
        (a, b) => (b.lastUsedTime || 0) - (a.lastUsedTime || 0)
      )
    }
  }
  // 两个窗口同源；storage 只传变更信号，新窗口和接收方均从宿主配置读取选择。
  try {
    const storage = window.localStorage
    if (storage) {
      storage.setItem(BUNDLED_VISIBILITY_SIGNAL, storage.getItem(BUNDLED_VISIBILITY_SIGNAL) === '1' ? '0' : '1')
    }
  } catch (err) {
    console.warn('[plugins] 通知其他窗口刷新内置插件可见性失败:', err)
  }
  track('bundled_plugin_visibility', id, { action: hidden ? 'hide' : 'restore' })
  return { success: true, pluginId: hidden ? id : resolvedId, hidden }
}

export const usePluginsStore = defineStore('plugins', {
  state: () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 12,
    keyword: '',
    category: '',
    sourceFilter: 'all', // 'all' | 'official' (官方) | 'community' (社区)
    favorites: new Set(),
    recents: [],
    // 最近使用时间：{ [pluginId]: 毫秒时间戳 }，与 recents 一起只存本地
    recentUsedAt: {},
    installedSet: new Set(),
    installedPlugins: [], // 已安装插件的完整信息列表
    installedListLoaded: false, // 宿主安装列表和内置插件可见性均已读到，才允许同步完整快照
    _installedRequestId: 0,
    _installedRevision: 0,
    hiddenBundledSet: new Set(), // 在主页和搜索中隐藏的内置插件 ID（小写）
    _hiddenBundledLoaded: false, // 是否已从本地配置加载过 hiddenBundledSet
    _hiddenBundledLoadPromise: null,
    _togglingBundledSet: new Set(), // 每个插件只允许一次可见性切换
    _bundledVisibilityWrite: null, // 不同插件共用同一个配置键，按请求顺序写入
    downloadingSet: new Set(), // 正在下载的插件ID
    installingSet: new Set(), // 正在安装的插件ID集合（并发防重互斥）
    installFailedSet: new Set(), // 安装失败的插件ID（用于显示"重试"）
    installErrorMap: {}, // { [pluginId]: string } 安装失败具体错误信息
    revokedMap: {}, // { [pluginId]: { revoked: true, reason: string } } 官方下架状态映射
    _downloadTimers: {}, // 下载超时定时器（内部使用）
    favoritePluginsList: [], // 收藏插件的完整信息列表
    favoritePluginsLoaded: false, // 收藏详情是否已加载过一次（成功或回填都算）；之前收藏数只能看 favorites
    updateMap: {}, // { pluginId: updateInfo }
    lastUpdateCheckTime: 0, // 上次批量检查更新的时间戳
    loading: false,
    error: null,
    errorKey: null,
    // 推荐插件（从后端 API 获取）
    recommendedItems: [],
    recommendedLoading: false,
    recommendedError: null,
    recommendedErrorKey: null,
    // 各分类下当前系统可用的插件数；null 表示还没算出来（此时不隐藏任何分类）
    categoryCounts: null,
    // 初始化状态（防重入）
    _initPromise: null,
    // 插件列表内存缓存
    _listCache: {},           // { [cacheKey]: { data, timestamp } }
    _listCacheTTL: 2 * 60 * 1000  // 2分钟 TTL
  }),

  getters: {
    // 收藏的插件列表（从独立获取的数据中返回）
    favoriteItems: (state) => {
      return state.favoritePluginsList
    },

    // 最近使用的插件
    recentItems: (state) => {
      return state.recents
        .map((pluginId) =>
          // 使用 pluginId（业务标识符）进行匹配
          state.items.find((item) => item.pluginId === pluginId)
        )
        .filter(Boolean)
        .slice(0, 10)
    },

    // 是否已收藏
    isFavorite: (state) => (pluginId) => {
      return state.favorites.has(normalizePluginId(pluginId))
    },

    // 插件是否被官方下架
    isRevoked: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId)
      return Boolean(state.revokedMap[pid]?.revoked)
    },

    // 获取下架原因（响应式按当前 locale 动态计算，避免热切换冻结静态中文）
    getRevokedReason: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId)
      const entry = state.revokedMap[pid]
      if (!entry) return t('pluginCatalog.revokedDisabledReason')
      if (entry.kind === 'platform') {
        if (entry.targetItem) {
          const label = getPluginPlatformLabel(entry.targetItem)
          return label
            ? t('pluginsStore.platformUnsupportedWithLabel', { label })
            : t('pluginsStore.platformUnsupported')
        }
        return entry.reason || t('pluginsStore.platformUnsupported')
      }
      const localized = getLocalizedPluginField(
        {
          revokedReason: entry.rawReason || '',
          ...(entry.i18n ? { i18n: entry.i18n } : {})
        },
        'revokedReason'
      )
      if (localized) return localized
      if (entry.isDefault) return t('pluginCatalog.revokedDisabledReason')
      return entry.reason || t('pluginCatalog.revokedDisabledReason')
    },

    // 响应式加载错误信息（避免热切换语言时冻结）
    errorMessage: (state) => {
      if (state.errorKey) return t(state.errorKey)
      return state.error || null
    },

    // 响应式推荐插件加载错误信息
    recommendedErrorMessage: (state) => {
      if (state.recommendedErrorKey) return t(state.recommendedErrorKey)
      return state.recommendedError || null
    },

    // 禁用原因的类别：'platform' 表示插件目录里的新版本不再支持当前系统，其余为官方下架
    getRevokedKind: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId)
      return state.revokedMap[pid]?.kind === 'platform' ? 'platform' : 'revoked'
    },

    // 插件是否正在安装/下载（原地切换状态机）
    isInstalling: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId)
      return state.installingSet.has(pid) || state.downloadingSet.has(pid)
    },

    // 获取安装失败具体错误原因
    getInstallError: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId)
      return state.installErrorMap[pid] || ''
    },

    // 总页数
    totalPages: (state) => {
      return Math.ceil(state.total / state.pageSize)
    },

    // 是否有数据
    hasPlugins: (state) => {
      return state.items.length > 0
    },

    // 官方插件列表
    officialPlugins: (state) => {
      return state.items.filter((item) => isOfficialPluginItem(item))
    },

    // 社区插件列表
    communityPlugins: (state) => {
      return state.items.filter((item) => !isOfficialPluginItem(item))
    },

    // 检查指定插件是否为官方
    isOfficialItem: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId).toLowerCase()
      const found = state.items.find(
        (item) => normalizePluginId(item.pluginId || item.id).toLowerCase() === pid
      )
      return isOfficialPluginItem(found) || isOfficialPlugin(pid) || isBundledPlugin(pid)
    },

    // 内置插件是否已被用户在设置中卸载隐藏
    isBundledHidden: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId).toLowerCase()
      return Boolean(pid && state.hiddenBundledSet.has(pid))
    },

    // 内置插件是否正在执行卸载/还原状态切换（并发互斥）
    isTogglingBundled: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId).toLowerCase()
      return Boolean(pid && state._togglingBundledSet.has(pid))
    }
  },

  actions: {
    async init() {
      // 防重入：如果已经在初始化中，返回同一个 Promise
      if (this._initPromise) {
        // console.log('[plugins] 初始化已在进行中，等待完成...')
        return this._initPromise
      }

      this._initPromise = this._doInit()
      return this._initPromise
    },

    /**
     * 实际的初始化逻辑（内部方法）
     */
    async _doInit() {
      try {
        // 从本地获取收藏和最近使用（始终使用本地存储）
        if (window.ztools && window.ztools.config) {
          let favStr = await window.ztools.config.get(
            'favorite_plugins',
            '',
            'user_settings.json'
          )
          if (!favStr || favStr === '[]') {
            favStr = await window.ztools.config.get(
              'plugins.favorites',
              '[]',
              'user_settings.json'
            )
          }
          const recStr = await window.ztools.config.get(
            'plugins.recents',
            '[]',
            'user_settings.json'
          )

          const recAtStr = await window.ztools.config.get(
            'plugins.recents_at',
            '{}',
            'user_settings.json'
          )

          const parsedFavorites = parseConfigList(favStr)
          const parsedRecents = parseConfigList(recStr)
          this.favorites = new Set(normalizeIdList(parsedFavorites))
          this.recents = normalizeIdList(parsedRecents)
          this.recentUsedAt = sanitizeRecentUsedAt(recAtStr, this.recents)

          // 云端同步不阻塞首屏；完成后刷新收藏详情
          this.syncFromCloud()
            .then(() => this.fetchFavoritePlugins())
            .catch((err) => {
              console.warn('[plugins] 后台云端同步失败:', formatLogArg(err))
            })
        }
      } catch (err) {
        console.warn('[plugins] 读取收藏与最近使用配置失败:', err)
        this.favorites = new Set()
        this.recents = []
        this.recentUsedAt = {}
      }
      await this.fetchInstalledPlugins()

      // 收藏详情依赖市场接口，不阻塞首屏
      this.fetchFavoritePlugins().catch((err) => {
        console.warn('[plugins] 后台加载收藏插件失败:', err)
      })
    },

    /**
     * 触发收藏变化事件
     * @private
     */
    _emitFavoriteChanged(pluginId, isFavorite) {
      if (window.ztools && window.ztools.events) {
        window.ztools.events.emit('favorite_changed', {
          pluginId,
          isFavorite,
          timestamp: Date.now()
        })
      }
    },

    /**
     * 拉取云端收藏覆盖本地（由版本实现：官方版登录后同步；开源版为空操作）
     */
    async syncFromCloud() {
      await cloudSync.pullFavorites(this)
    },

    /**
     * 推送部分字段到云端（由版本实现：官方版登录后推送，失败静默；开源版为空操作）
     * @param {Object} data - 要推送的字段（部分更新）
     */
    async pushToCloud(data) {
      await cloudSync.push(data)
    },

    /**
     * 用一组插件 ID 替换收藏（去重规范化）并写回本地配置，供云同步拉取结果使用
     * @param {string[]} ids
     */
    async replaceFavorites(ids) {
      this.favorites = new Set(normalizeIdList(ids))
      if (window.ztools?.config) {
        await window.ztools.config.set(
          'plugins.favorites',
          JSON.stringify(Array.from(this.favorites)),
          false,
          'user_settings.json'
        )
      }
    },

    /**
     * 获取或初始化 Local-First Store 目录管理器
     */
    _getCatalogManager() {
      if (!this._catalogManager) {
        // 与详情、下载和更新共用一次 CDN 读取；离线时目录管理器只展示本地快照与内置插件。
        this._catalogManager = new StoreCatalogManager({
          fetchRemote: async () => {
            const list = await loadV2StaticCatalogList()
            this._applyRevocations(list)
            this._applyPlatformSupport(list)
            this._patchInstalledFromCatalog(list)
            return list
          },
          getLocalSnapshot: async () => {
            if (window.ztools?.config) {
              const raw = await window.ztools.config.get(
                'plugins.catalog_snapshot',
                '[]',
                'user_settings.json'
              )
              try {
                const parsed = JSON.parse(raw)
                return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
              } catch {
                return null
              }
            }
            return null
          },
          saveLocalSnapshot: async (data) => {
            if (window.ztools?.config) {
              await window.ztools.config.set(
                'plugins.catalog_snapshot',
                JSON.stringify(data),
                false,
                'user_settings.json'
              )
            }
          },
          getOfficialList: () => [...getBundledPluginEntries(), ...getOfficialPluginsList()],
          isPlatformSupported: (item) => isPluginVisible(item) && isPluginSupportedOnCurrentPlatform(item),
          ttlMs: 5 * 60 * 1000
        })
      }
      return this._catalogManager
    },

    setSourceFilter(filter) {
      const valid = ['all', 'official', 'community']
      this.sourceFilter = valid.includes(filter) ? filter : 'all'
      return this.load()
    },

    async load() {
      this.loading = true
      this.error = null
      this.errorKey = null
      try {
        const { list, total, page, pageSize } = await this.loadWithCache({
          keyword: this.keyword,
          category: this.category,
          sourceType: this.sourceFilter,
          page: this.page,
          per_page: this.pageSize
        }, true)

        this.items = list || []
        this.total = total
        this.page = page
        this.pageSize = pageSize

        // 市场数据到位后，补充已安装插件的远程 icon URL
        this._patchInstalledIcons()
      } catch (err) {
        const resolved = resolveErrorMessage(err, 'pluginsStore.loadFailed')
        this.errorKey = resolved === t('pluginsStore.loadFailed') ? 'pluginsStore.loadFailed' : null
        this.error = resolved
        console.error('[PluginsStore] 加载插件失败:', err)
        throw err
      } finally {
        this.loading = false
      }
    },

    /**
     * Local-First 本地优先插件列表加载（SLA < 10ms）
     * @param {Object} params - { category, sourceType, page, per_page, keyword, ids, sort, direction }
     * @param {boolean} forceRefresh - 是否强制从远程刷新全量索引
     * @returns {Promise<{list: Array, total: number, page: number, pageSize: number}>}
     */
    async loadWithCache(params = {}, forceRefresh = false) {
      const manager = this._getCatalogManager()
      if (forceRefresh) {
        await manager.ensureCatalog(true)
      }

      const queryParams = {
        sourceType: this.sourceFilter,
        ...params
      }

      const result = await manager.query(queryParams)
      // 下架状态来自完整目录，与当前分页、搜索和分类无关。
      this._applyRevocations(manager._catalog)
      this._updateCategoryCounts(manager._catalog)
      this._patchInstalledFromCatalog(manager._catalog)

      return result
    },

    /**
     * 当前分类 / 搜索词 / 指定 ID 范围内，「全部 / 官方 / 社区」各有多少插件。
     * 在已缓存的目录上本地统计，不发请求；目录不可用时抛出，由调用方决定不显示数字。
     * @param {{ category?: string, keyword?: string, ids?: string[] }} params
     */
    async countPluginsBySource(params = {}) {
      const manager = this._getCatalogManager()
      const types = ['all', 'official', 'community']
      const results = await Promise.all(
        types.map((sourceType) => manager.query({ ...params, sourceType, page: 1, pageSize: 1 }))
      )
      return Object.fromEntries(types.map((type, index) => [type, results[index].total]))
    },

    /** 按标准 categoryId 主键统计目录里的插件数（目录已按当前系统过滤，已下架的不计） */
    _updateCategoryCounts(catalog) {
      if (!Array.isArray(catalog)) return
      const counts = {}
      for (const item of catalog) {
        if (!item || item.draft || item.revoked || this.isRevoked?.(item.pluginId || item.id)) continue
        for (const id of normalizeCategoryIds(item.categoryId || item.category)) {
          counts[id] = (counts[id] || 0) + 1
        }
      }
      this.categoryCounts = counts
    },

    /** 侧栏等不经过市场列表的地方，主动拉一次目录来统计分类 */
    async refreshCategoryCounts() {
      try {
        const { catalog } = await this._getCatalogManager().ensureCatalog()
        this._applyRevocations(catalog)
        this._updateCategoryCounts(catalog)
        this._patchInstalledFromCatalog(catalog)
      } catch (error) {
        console.warn('[PluginsStore] 统计分类插件数失败，保留全部分类:', error)
      }
      return this.categoryCounts
    },

    /** 某个分类是否要显示：统计结果出来前一律显示；「全部」与正在查看的分类始终显示（兼容 categoryId 与旧中文名） */
    isCategoryVisible(idOrName, activeIdOrName = '') {
      if (isAllCategory(idOrName)) return true
      const normalized = normalizeCategoryRouteParam(idOrName)
      const normalizedActive = normalizeCategoryRouteParam(activeIdOrName)
      if (normalized && normalized === normalizedActive) return true
      if (!this.categoryCounts) return true
      const byId = this.categoryCounts[normalized]
      if (typeof byId === 'number') return byId > 0
      const legacyName = CATEGORY_ID_TO_NAME[normalized]
      if (legacyName && typeof this.categoryCounts[legacyName] === 'number') {
        return this.categoryCounts[legacyName] > 0
      }
      return (this.categoryCounts[idOrName] || 0) > 0
    },

    /** 清除所有列表缓存并重置管理器（主动刷新时调用） */
    clearListCache() {
      this._listCache = {}
      if (this._catalogManager) {
        this._catalogManager._lastSyncTime = 0
      }
    },

    /**
     * 加载推荐插件（从后端 API 获取，按下载量排序）
     * @param {number} limit - 获取数量，默认 8
     */
    async loadRecommendedPlugins(limit = 8) {
      this.recommendedLoading = true
      this.recommendedError = null
      this.recommendedErrorKey = null
      try {
        const { list } = await this.loadWithCache({
          sort: 'downloads',
          direction: 'desc',
          per_page: limit,
          page: 1
        })
        this.recommendedItems = list || []
      } catch (err) {
        const resolved = resolveErrorMessage(err, 'pluginsStore.loadRecommendedFailed')
        this.recommendedErrorKey = resolved === t('pluginsStore.loadRecommendedFailed') ? 'pluginsStore.loadRecommendedFailed' : null
        this.recommendedError = resolved
        console.error('[PluginsStore] 加载推荐插件失败:', err)
      } finally {
        this.recommendedLoading = false
      }
    },
    async details(id) {
      return apiGetPluginDetails(id)
    },
    async markRecent(pluginId) {
      const normalizedId = normalizePluginId(pluginId)
      if (!normalizedId) return

      this.recents = [
        normalizedId,
        ...this.recents.filter((x) => x !== normalizedId)
      ].slice(0, 20)
      // 只保留仍在最近列表中的时间，避免无限增长
      const usedAt = { [normalizedId]: Date.now() }
      for (const id of this.recents) {
        if (id !== normalizedId && Object.hasOwn(this.recentUsedAt, id)) usedAt[id] = this.recentUsedAt[id]
      }
      this.recentUsedAt = usedAt
      try {
        const recData = JSON.stringify(this.recents)

        if (window.ztools && window.ztools.config) {
          // 最近使用只保存到本地，不需要云端同步
          await window.ztools.config.set(
            'plugins.recents',
            recData,
            false,
            'user_settings.json'
          )
          await window.ztools.config.set(
            'plugins.recents_at',
            JSON.stringify(this.recentUsedAt),
            false,
            'user_settings.json'
          )
          // console.log('[plugins] 最近使用已保存')
        }
      } catch (err) {
        console.warn('[plugins] 保存最近使用失败:', err)
      }
    },
    /**
     * 根据收藏 ID 列表，从服务端批量获取收藏插件的完整信息
     */
    async fetchFavoritePlugins() {
      const ids = normalizeIdList(Array.from(this.favorites))
      if (ids.length === 0) {
        this.favoritePluginsList = []
        this.favoritePluginsLoaded = true
        return
      }
      try {
        const { list } = await this.loadWithCache({
          ids,
          per_page: ids.length,
          page: 1
        })
        this.favoritePluginsList = list || []
      } catch (err) {
        console.warn('[plugins] 加载收藏插件失败，尝试从本地已安装插件回填:', err)
        const localMatches = (this.installedPlugins || []).filter((p) =>
          ids.includes(normalizePluginId(p.pluginId || p.id))
        )
        this.favoritePluginsList = localMatches
      } finally {
        this.favoritePluginsLoaded = true
      }
    },

    async toggleFavorite(pluginId) {
      const normalizedId = normalizePluginId(pluginId)
      if (!normalizedId) {
        throw new Error(t('pluginsStore.pluginIdMissing'))
      }

      const wasFavorite = this.favorites.has(normalizedId)

      if (wasFavorite) {
        this.favorites.delete(normalizedId)
      } else {
        this.favorites.add(normalizedId)
      }

      const isFavorite = !wasFavorite

      try {
        const favData = JSON.stringify(Array.from(this.favorites))

        if (window.ztools && window.ztools.config) {
          // 本地配置持久化：保存 favorite_plugins 与 plugins.favorites
          await window.ztools.config.set(
            'favorite_plugins',
            favData,
            false,
            'user_settings.json'
          )
          await window.ztools.config.set(
            'plugins.favorites',
            favData,
            false,
            'user_settings.json'
          )

          // 后台静默推送收藏到云端（只有官方版且已登录时才真正推送，不阻塞本地操作）
          this.pushToCloud({
            favorites: Array.from(this.favorites)
          }).catch(() => {})
        }

        // 触发收藏变化事件，通知其他组件
        this._emitFavoriteChanged(normalizedId, isFavorite)

        // 埋点：收藏/取消收藏
        track('plugin_favorite', normalizedId, { action: isFavorite ? 'add' : 'remove' })

        // 刷新收藏插件完整信息列表
        await this.fetchFavoritePlugins()
      } catch (err) {
        console.error('[plugins] 保存收藏失败:', err)
        // 回滚状态
        if (wasFavorite) {
          this.favorites.add(normalizedId)
        } else {
          this.favorites.delete(normalizedId)
        }
        throw err
      }
    },

    /** 仅利用已有内存目录快照，用市场元数据补齐已安装旧版插件缺失的图标、i18n 与分类（不发起额外网络请求） */
    _patchInstalledFromCatalog(catalog) {
      if (!this.installedPlugins?.length || !Array.isArray(catalog) || catalog.length === 0) return
      const marketMap = {}
      for (const item of catalog) {
        const pid = item?.pluginId || item?.id
        if (!pid) continue
        const patch = extractCatalogPatch(item)
        if (!patch) continue
        const key = String(pid)
        marketMap[key] = mergeCatalogPatch(marketMap[key], patch)
      }
      if (Object.keys(marketMap).length > 0) {
        this._applyIconPatch(marketMap)
      }
    },

    /** 用市场数据补充已安装插件的远程 icon URL、缺失的 i18n 译文与缺失分类 */
    _patchInstalledIcons() {
      if (!this.installedPlugins?.length) return
      const marketMap = {}
      const lowerKeyMap = {}
      const addCatalogEntry = (item) => {
        const pid = item?.pluginId || item?.id
        if (!pid) return
        const patch = extractCatalogPatch(item)
        if (!patch) return
        const key = String(pid)
        const lower = key.toLowerCase()
        const canonicalKey = lowerKeyMap[lower] || key
        lowerKeyMap[lower] = canonicalKey
        marketMap[canonicalKey] = mergeCatalogPatch(marketMap[canonicalKey], patch)
      }
      const catalogSource = [
        ...(Array.isArray(this._catalogManager?._catalog) ? this._catalogManager._catalog : []),
        ...(Array.isArray(this.items) ? this.items : [])
      ]
      for (const item of catalogSource) {
        addCatalogEntry(item)
      }

      if (Object.keys(marketMap).length > 0) {
        this._applyIconPatch(marketMap)
      }

      // 找出不在市场列表里的已安装插件，单独请求它们的市场元数据（图标、i18n 与分类）
      // 内置插件的资源随客户端一起发布，不向市场查询，避免被旧版本数据覆盖（返回首页时图标或文案会闪一下再变）
      const missingIds = this.installedPlugins
        .map((p) => String(p.pluginId))
        .filter((id) => !marketMap[id] && !lowerKeyMap[id.toLowerCase()] && !isBundledPlugin(id))

      if (missingIds.length > 0) {
        apiGetMarketPlugins({ ids: missingIds, per_page: missingIds.length }).then((res) => {
          const list = res?.list || []
          for (const item of list) {
            addCatalogEntry(item)
          }
          this._applyIconPatch(marketMap)
        }).catch(() => {})
      }
    },

    _applyIconPatch(marketMap) {
      if (!this.installedPlugins?.length || !isPlainRecord(marketMap)) return
      const normalizedMap = new Map()
      const lowerMap = new Map()
      for (const [key, rawPatch] of Object.entries(marketMap)) {
        const patch = normalizeCatalogPatchEntry(rawPatch)
        if (!patch) continue
        normalizedMap.set(String(key), patch)
        const lower = String(key).toLowerCase()
        if (!lowerMap.has(lower)) lowerMap.set(lower, patch)
      }
      if (normalizedMap.size === 0) return

      let changed = false
      const nextInstalled = this.installedPlugins.map((p) => {
        if (isBundledPlugin(p.pluginId)) return p
        const pid = String(p.pluginId || p.id || '')
        const patch = normalizedMap.get(pid) || lowerMap.get(pid.toLowerCase())
        if (!patch) return p

        let itemChanged = false
        const updates = {}

        const remoteIcon = patch.icon || ''
        if (remoteIcon && p.icon !== remoteIcon) {
          updates.icon = remoteIcon
          itemChanged = true
        }

        // 以本地 plugin.json 的 i18n 为准，市场元数据仅用于兜底补齐本地缺失的语种或字段
        if (patch.i18n) {
          const mergedI18n = mergePluginI18n(patch.i18n, p.i18n)
          if (mergedI18n && !isSameJsonValue(mergedI18n, p.i18n)) {
            updates.i18n = mergedI18n
            itemChanged = true
          }
        }

        // 仅当本地旧版插件完全未声明分类时，使用市场目录的标准分类补齐
        if (!hasPluginCategory(p) && (patch.categoryId || patch.category)) {
          if (patch.categoryId) updates.categoryId = patch.categoryId
          if (patch.category) updates.category = patch.category
          itemChanged = true
        }

        // 对比本地 icon.url 记录的 URL 和市场最新 URL
        // 不一致说明后台更换了图标，通知宿主异步更新本地 icon.png 和 icon.ico
        // 内置插件没有本地 icon 文件，请求刷新只会在主进程得到 PLUGIN_NOT_FOUND
        if (!p.builtin && remoteIcon && (p.localIconUrl || '') !== remoteIcon) {
          if (window.ztools?.plugin?.refreshIcon) {
            const prevLocalIconUrl = p.localIconUrl
            updates.localIconUrl = remoteIcon
            itemChanged = true
            Promise.resolve(window.ztools.plugin.refreshIcon(p.pluginId, remoteIcon)).catch(() => {
              const current = (this.installedPlugins || []).find((item) => item.pluginId === p.pluginId)
              if (current && current.localIconUrl === remoteIcon) current.localIconUrl = prevLocalIconUrl
            })
          }
        }

        if (!itemChanged) return p
        changed = true
        return { ...p, ...updates }
      })

      if (changed) {
        this.installedPlugins = nextInstalled
      }
    },

    /**
     * 识别下架插件：同步官方下架状态，禁用已装插件并阻止启动（M1-8）
     * @param {Array} list - 插件列表
     */
    _applyRevocations(list) {
      if (!Array.isArray(list) || list.length === 0) return
      let changed = false
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const pid = normalizePluginId(item.pluginId || item.id)
        if (!pid) continue
        if (item.revoked) {
          const rawReason = item.revoked_reason || item.revokedReason || ''
          const localizedReason = getLocalizedPluginField(item, 'revokedReason')
          const reason = localizedReason || t('pluginCatalog.revokedDisabledReason')
          const itemI18n = item.i18n && typeof item.i18n === 'object' ? item.i18n : null
          const prev = this.revokedMap[pid]
          if (!prev || prev.reason !== reason || prev.rawReason !== rawReason || prev.i18n !== itemI18n) {
            this.revokedMap = {
              ...this.revokedMap,
              [pid]: {
                revoked: true,
                reason,
                ...(rawReason ? { rawReason } : {}),
                ...(itemI18n ? { i18n: itemI18n } : {}),
                isDefault: !localizedReason
              }
            }
            changed = true
          }
          // 若已在本地安装，立即置为禁用并标记下架原因，阻止启动
          if (this.installedSet.has(pid)) {
            const found = (this.installedPlugins || []).find(
              (p) => normalizePluginId(p.pluginId || p.id) === pid
            )
            if (found) {
              found.revoked = true
              found.revoked_reason = rawReason || reason
              if (itemI18n) {
                found.i18n = mergePluginI18n(found.i18n, itemI18n)
              }
              found.enabled = false
            }
            if (window.ztools?.plugin?.revoke) {
              window.ztools.plugin.revoke(pid, reason).catch((error) => {
                console.warn('[plugins] 禁用已下架插件失败:', pid, error)
              })
            }
          }
        }
      }
      if (changed && this.installedPlugins?.length) {
        this.installedPlugins = [...this.installedPlugins]
      }
    },

    /**
     * 插件目录里的新版本不再支持当前系统（例如改为仅 Windows）时，本机已装的旧版本在当前系统上多半不能用：
     * 标为"不支持当前系统"并阻止启动，引导卸载。只记在内存里、不写主进程的下架状态，
     * 目录以后恢复支持当前系统时自动解除；客户端自带的插件打开的是客户端里的那份，不受影响。
     * @param {Array} list - 插件目录原始条目（未按平台过滤）
     */
    _applyPlatformSupport(list) {
      if (!Array.isArray(list) || list.length === 0) return
      const next = { ...this.revokedMap }
      let changed = false
      for (const item of list) {
        if (!item || typeof item !== 'object' || item.revoked) continue
        const pid = normalizePluginId(item.pluginId || item.id)
        if (!pid || isClientProvidedPlugin(pid)) continue
        const platforms = getPluginPlatforms(item)
        if (!platforms || platforms.length === 0) continue
        const current = next[pid]
        if (current && current.kind !== 'platform') continue
        // 不看是否已安装：目录可能先于已装列表返回；未安装的这类条目本来就不会出现在当前系统的插件市场里
        if (!isPluginSupportedOnCurrentPlatform(item)) {
          const targetItem = {
            ...(Array.isArray(item.targets) ? { targets: item.targets } : {}),
            ...(Array.isArray(item.platforms) ? { platforms: item.platforms } : {})
          }
          const platformKey = JSON.stringify(targetItem)
          if (!current || current.platformKey !== platformKey) {
            next[pid] = { revoked: true, kind: 'platform', targetItem, platformKey }
            changed = true
          }
        } else if (current) {
          delete next[pid]
          changed = true
        }
      }
      if (changed) {
        this.revokedMap = next
        if (this.installedPlugins?.length) this.installedPlugins = [...this.installedPlugins]
      }
    },

    async ensureHiddenBundledLoaded(refresh = false) {
      if (!refresh && this._hiddenBundledLoadPromise) return this._hiddenBundledLoadPromise
      if (!refresh && this._hiddenBundledLoaded) return
      if (!window.ztools?.config?.get) {
        this._hiddenBundledLoaded = true
        return
      }
      this._hiddenBundledLoaded = false
      const read = (async () => window.ztools.config.get(HIDDEN_BUNDLED_CONFIG_KEY, '[]', 'user_settings.json'))()
      this._hiddenBundledLoadPromise = read
      try {
        const raw = await read
        if (this._hiddenBundledLoadPromise !== read) return
        this.hiddenBundledSet = new Set(sanitizeHiddenBundledIds(raw))
        this._hiddenBundledLoaded = true
      } finally {
        if (this._hiddenBundledLoadPromise === read) this._hiddenBundledLoadPromise = null
      }
    },

    async fetchInstalledPlugins(refreshBundledVisibility = false) {
      const requestId = ++this._installedRequestId
      const revision = this._installedRevision
      try {
        await this.ensureHiddenBundledLoaded(refreshBundledVisibility)
      } catch (err) {
        console.warn('[plugins] 读取内置插件可见性失败，本次只展示已确认的插件:', err)
      }
      if (requestId !== this._installedRequestId) return this.installedPlugins
      const canShowBundled = (id) => this._hiddenBundledLoaded && !this.isBundledHidden(id)
      try {
        const locals = await apiGetLocalPlugins()
        if (requestId !== this._installedRequestId) return this.installedPlugins
        if (revision !== this._installedRevision) return this.fetchInstalledPlugins()
        const bundledEntries = getBundledPluginEntries().filter((p) => canShowBundled(p.pluginId))
        const officialList = [...bundledEntries, ...getOfficialPluginsList()]

        // 识别本地已装插件的下架标记
        for (const p of locals || []) {
          const pid = normalizePluginId(p.pluginId || p.id)
          if (!pid) continue
          if (p.revoked) {
            const rawReason = p.revoked_reason || p.revokedReason || ''
            const localizedReason = getLocalizedPluginField(p, 'revokedReason')
            const reason = localizedReason || t('pluginCatalog.revokedDisabledReason')
            const itemI18n = p.i18n && typeof p.i18n === 'object' ? p.i18n : null
            this.revokedMap = {
              ...this.revokedMap,
              [pid]: {
                revoked: true,
                reason,
                ...(rawReason ? { rawReason } : {}),
                ...(itemI18n ? { i18n: itemI18n } : {}),
                isDefault: !localizedReason
              }
            }
            p.enabled = false
          }
        }

        const localIds = (locals || [])
          .map((p) => String(p.pluginId))
          .filter((id) => !isBundledPlugin(id) || canShowBundled(id))
        // 云同步只采纳完整快照，避免把尚未读到可见性配置的内置插件从远端记录中清除。
        this.installedListLoaded = this._hiddenBundledLoaded
        const officialIds = officialList.map((p) => String(p.pluginId))

        // 最新宿主快照决定市场插件安装状态；未隐藏的包内插件仍由客户端提供。
        this.installedSet = new Set([...localIds, ...officialIds])

        // 合并插件列表：本地插件 + 官方标杆应用（若本地已有同 ID 或别名则合并官方声明式定义并去重）
        const coveredOfficialKeys = new Set()
        const combined = []
        // 与内置插件同 ID 的本地安装副本：以内置版本为准，只沿用其最近使用时间与启用状态
        const localBundledState = new Map()
        for (const p of locals || []) {
          const key = String(p.pluginId || p.id || '').toLowerCase()
          if (isBundledPlugin(key)) {
            if (canShowBundled(key)) {
              localBundledState.set(key, { lastUsedTime: p.lastUsedTime, enabled: p.enabled })
            }
            continue
          }
          const builtinMatch = getOfficialPlugin(key)
          const isOff = isOfficialPluginItem(p, builtinMatch)
          if (builtinMatch) {
            const canonicalKey = String(builtinMatch.pluginId || key).toLowerCase()
            if (coveredOfficialKeys.has(canonicalKey)) {
              continue
            }
            coveredOfficialKeys.add(canonicalKey)
            const badge =
              p.official_badge ||
              p.officialBadge ||
              builtinMatch.official_badge ||
              builtinMatch.officialBadge ||
              builtinMatch.badge ||
              OFFICIAL_BADGE_CODE
            const mergedPlugin = {
              ...p,
              ...builtinMatch,
              id: p.id || builtinMatch.id,
              pluginId: p.pluginId || builtinMatch.pluginId,
              lastUsedTime: p.lastUsedTime ?? builtinMatch.lastUsedTime,
              enabled: p.enabled !== undefined ? p.enabled : builtinMatch.enabled,
              revoked: p.revoked || false,
              revoked_reason: p.revoked_reason || p.revokedReason || '',
              is_official: true,
              isOfficial: true,
              official_badge: badge,
              officialBadge: badge
            }
            delete mergedPlugin.platforms
            combined.push(mergedPlugin)
            continue
          }
          if (isOff) {
            const badge = p.official_badge || p.officialBadge || OFFICIAL_BADGE_CODE
            combined.push({
              ...p,
              is_official: true,
              isOfficial: true,
              official_badge: badge,
              officialBadge: badge
            })
            continue
          }
          combined.push(p)
        }
        for (const official of officialList) {
          const key = String(official.pluginId || '').toLowerCase()
          if (!coveredOfficialKeys.has(key)) {
            coveredOfficialKeys.add(key)
            const badge = official.official_badge || official.officialBadge || OFFICIAL_BADGE_CODE
            const localState = localBundledState.get(key)
            combined.push({
              ...official,
              ...(localState?.lastUsedTime !== undefined ? { lastUsedTime: localState.lastUsedTime } : {}),
              ...(typeof localState?.enabled === 'boolean' ? { enabled: localState.enabled } : {}),
              // 内置官方声明式插件：没有本地安装目录，不参与本地图标刷新等文件级操作
              builtin: true,
              is_official: true,
              isOfficial: true,
              official_badge: badge,
              officialBadge: badge
            })
          }
        }

        // 保存完整插件信息，按最近使用时间排序；当前平台不支持的插件（如 macOS 上的 Windows 专用插件）
        // 不进入展示与检索列表，installedSet 保持原样以免影响卸载 / 更新等安装状态判断
        this.installedPlugins = combined.filter((p) => isPluginVisible(p) && isPluginSupportedOnCurrentPlatform(p)).sort((a, b) => {
          const timeA = a.lastUsedTime || 0
          const timeB = b.lastUsedTime || 0
          return timeB - timeA
        })

        // 用市场数据补充远程 icon URL，并检测图标是否需要更新
        this._patchInstalledIcons()
        return combined
      } catch (err) {
        if (requestId !== this._installedRequestId) return this.installedPlugins
        if (revision !== this._installedRevision) return this.fetchInstalledPlugins()
        console.warn('[plugins] 获取本地插件失败，回退官方内置标杆插件列表:', err)
        this.installedListLoaded = false
        const bundledEntries = getBundledPluginEntries().filter((p) => canShowBundled(p.pluginId))
        const officialList = [...bundledEntries, ...getOfficialPluginsList()]
        const officialIds = officialList.map((p) => String(p.pluginId))
        this.installedSet = new Set(officialIds)
        this.installedPlugins = officialList
          .filter((p) => isPluginVisible(p) && isPluginSupportedOnCurrentPlatform(p))
          .map((plugin) => ({ ...plugin, builtin: true }))
        return officialList
      }
    },

    /**
     * 当前已安装、且在插件目录里的插件 ID（含随客户端内置的插件），供版本同步安装记录用。
     * 只返回插件目录里有的 ID：本地开发或自行导入的插件不外传。
     * 本地已安装列表读取失败、或插件目录只有内置兜底数据时返回 null（列表不完整，不能用来覆盖服务端记录）。
     * @returns {Promise<string[]|null>}
     */
    async getCatalogInstalledPluginIds() {
      if (!this.installedListLoaded) await this.fetchInstalledPlugins()
      if (!this.installedListLoaded) return null
      const manager = this._getCatalogManager()
      await manager.ensureCatalog()
      // 插件目录只有随包内置的兜底数据时，市场插件都查不到，不能当作完整列表
      if (!manager.lastSource || manager.lastSource === 'official_builtin') return null
      const ids = []
      for (const id of this.installedSet) {
        const pid = normalizePluginId(id)
        if (!pid) continue
        if (isBundledPlugin(pid) || manager.getById(pid)) ids.push(pid)
      }
      return [...new Set(ids)]
    },

    acceptsInstallEvent(payload) {
      return Boolean(payload?.pluginId) && !this.installingSet.has(String(payload.pluginId))
    },

    onPluginRuntimeStopped(payload) {
      if (typeof payload?.pluginId !== 'string') return
      const id = payload.pluginId.trim().toLowerCase()
      if (!id || /[/\\]/.test(id) || id.includes('..')) return
      this._installedRevision += 1
      clearDeclarativePluginCache(id)
      invalidatePluginSession(id)
    },

    onInstallComplete(payload, managed = false) {
      if (payload && payload.pluginId) {
        const pluginId = String(payload.pluginId)
        // 本窗口发起的安装由任务等待器按 operationId 核验，忽略全局监听的旧任务通知。
        if (!managed && !this.acceptsInstallEvent(payload)) return
        console.log('[pluginsStore.onInstallComplete]', pluginId, 'success:', payload.success, 'isUpdate:', payload.isUpdate)

        // 清除下载超时定时器
        this._clearDownloadTimer(pluginId)

        // 清除正在安装互斥标记
        const nextInstalling = new Set(this.installingSet)
        nextInstalling.delete(pluginId)
        this.installingSet = nextInstalling

        if (payload.success) {
          this.onPluginRuntimeStopped({ pluginId })
          // 新装的插件告诉版本（官方版已登录时上报插件 ID；更新与重复通知不再上报；开源版为空操作，失败不影响安装结果）
          if (!this.installedSet.has(pluginId) && !payload.isUpdate) {
            notifyLifecycle('onInstalled', pluginId)
          }
          // 安装成功：立即更新 installedSet
          const next = new Set(this.installedSet)
          next.add(pluginId)
          this.installedSet = next

          // 清除失败状态与错误信息
          const nextFailed = new Set(this.installFailedSet)
          nextFailed.delete(pluginId)
          this.installFailedSet = nextFailed
          if (this.installErrorMap[pluginId]) {
            const nextErrMap = { ...this.installErrorMap }
            delete nextErrMap[pluginId]
            this.installErrorMap = nextErrMap
          }

          // 清除下载状态
          this.endDownload(pluginId)

          // 清除该插件的更新缓存，避免更新完成后仍显示"有更新"
          if (this.updateMap[pluginId]) {
            const nextUpdate = { ...this.updateMap }
            delete nextUpdate[pluginId]
            this.updateMap = nextUpdate
          }
          // 不重置 lastUpdateCheckTime，避免 load() 中的 batchCheck 用旧版本号重新查出"有更新"
          // 等 fetchInstalledPlugins 刷新本地版本后，下次进入页面自然会重新检查

          // 延迟获取完整的已安装插件列表，避免覆盖刚设置的 installedSet
          // 宿主端插件目录扫描可能还未完全刷新缓存
          setTimeout(() => {
            this.fetchInstalledPlugins()
          }, 1500)
        } else {
          // 安装失败：清除下载状态，标记为失败（显示"重试"并记录错误原因）
          console.warn('[plugins.onInstallComplete] 安装失败:', pluginId, payload.error)
          this.endDownload(pluginId)

          const nextFailed = new Set(this.installFailedSet)
          nextFailed.add(pluginId)
          this.installFailedSet = nextFailed

          if (payload.error) {
            this.installErrorMap = {
              ...this.installErrorMap,
              [pluginId]: resolveErrorMessage(payload, 'pluginsStore.installFailed')
            }
          }
        }
      } else {
        console.warn('[plugins.onInstallComplete] payload 无效:', payload)
      }
    },

    onUninstallComplete(payload) {
      if (payload && payload.pluginId) {
        if (isClientProvidedPlugin(payload.pluginId)) {
          // 随客户端提供的插件不可卸载
          return
        }
        this.onPluginRuntimeStopped(payload)
        this.installedPlugins = this.installedPlugins.filter(plugin =>
          normalizePluginId(plugin.pluginId || plugin.id).toLowerCase() !== normalizePluginId(payload.pluginId).toLowerCase())
        // 卸载事件与卸载调用可能各通知一次，只在第一次（插件还在已安装列表里）告诉版本
        if (this.installedSet.has(String(payload.pluginId))) {
          notifyLifecycle('onUninstalled', String(payload.pluginId))
        }
        const next = new Set(this.installedSet)
        next.delete(String(payload.pluginId))
        this.installedSet = next

        // Remove from updateMap
        if (this.updateMap[payload.pluginId]) {
          const nextUpdate = { ...this.updateMap }
          delete nextUpdate[payload.pluginId]
          this.updateMap = nextUpdate
        }
      }
    },

    /**
     * 打开插件
     * @param {string} pluginId - 插件ID
     */
    async openPlugin(pluginId, options = {}) {
      try {
        // 已合并进内置插件的旧插件（如 notes → memo）直接打开保留的那个
        const normalizedId = normalizePluginId(resolveBundledReplacement(normalizePluginId(pluginId)))
        const featureCode = resolveBundledReplacementFeature(normalizePluginId(pluginId), options?.featureCode)
        if (!normalizedId) {
          throw new Error(t('pluginsStore.pluginIdMissing'))
        }

        // 下架防御性拦截（M1-8）
        if (this.isRevoked(normalizedId)) {
          const reason = this.getRevokedReason(normalizedId) || t('pluginCatalog.revokedDisabledReason')
          if (this.getRevokedKind(normalizedId) === 'platform') throw new Error(t('pluginsStore.cannotLaunchWithReason', { reason }))
          throw new Error(t('pluginsStore.cannotLaunchRevoked', { reason }))
        }

        // 已被用户在设置中假卸载（隐藏）的内置插件：引导前往详情页一键还原
        if (isBundledPlugin(normalizedId) && this.isBundledHidden(normalizedId)) {
          return {
            success: false,
            action: 'navigate_to_detail',
            pluginId: normalizedId,
            error: t('pluginsStore.bundledHiddenError')
          }
        }

        const lowerId = normalizedId.toLowerCase()
        const installedMatch = (this.installedPlugins || []).find(
          (p) => normalizePluginId(p.pluginId || p.id).toLowerCase() === lowerId
        )
        const catalogMatch =
          this._catalogManager?.getById?.(normalizedId) ||
          this._catalogManager?._catalog?.find?.(
            (p) => normalizePluginId(p.pluginId || p.id).toLowerCase() === lowerId
          ) ||
          (this.items || []).find(
            (p) => normalizePluginId(p.pluginId || p.id).toLowerCase() === lowerId
          )

        // 暂未开放的插件（未完成真实实现）不允许从旧快捷方式、历史记录等入口打开
        const targetPlugin = installedMatch || catalogMatch || normalizedId
        if (!isPluginVisible(targetPlugin)) {
          throw new Error(t('pluginsStore.cannotLaunchNotPublic'))
        }

        // 当前系统上不能真正工作的插件不允许启动，避免展示示例数据或假成功
        if (!isPluginSupportedOnCurrentPlatform(targetPlugin)) {
          throw new Error(t('pluginsStore.cannotLaunchUnsupportedPlatform'))
        }

        const isDeclarativePlugin = Boolean(
          isBundledPlugin(normalizedId) ||
          isOfficialPlugin(normalizedId) ||
            installedMatch?.isDeclarative === true ||
            catalogMatch?.isDeclarative === true ||
            (typeof installedMatch?.entry === 'string' &&
              installedMatch.entry.trim().toLowerCase().endsWith('.js')) ||
            (typeof catalogMatch?.entry === 'string' &&
              catalogMatch.entry.trim().toLowerCase().endsWith('.js'))
        )

        // 1. 若为官方标杆或已安装 V2 (.js) 声明式应用：直接路由或唤起声明式运行时
        if (isDeclarativePlugin) {
          await this.markRecent(normalizedId)

          // 悬浮启动器模式嗅探
          if (
            typeof window !== 'undefined' &&
            typeof window.__ztoolsOpenLauncherDeclarative === 'function'
          ) {
            const launched = await window.__ztoolsOpenLauncherDeclarative(normalizedId, { featureCode })
            if (launched?.cancelled) return launched
            if (launched?.success !== true) throw new Error(resolveErrorMessage(launched, 'launcher.launchPluginFailed'))
            return { success: true, isDeclarative: true, pluginId: normalizedId }
          }

          // 路由切换前先将声明式插件预热进内存缓存，确保进入 DeclarativePage 首帧同步直出无闪烁
          if (!getOfficialPlugin(normalizedId)) {
            await loadInstalledDeclarativePlugin(normalizedId, { featureCode }).catch((prewarmErr) => {
              console.debug('[plugins.openPlugin] 预热声明式插件未命中，交由页面视图处理:', formatLogArg(prewarmErr))
            })
          }

          // 正常工作台模式直接路由到声明式应用页
          if (router) {
            await router.push(routeUtils.toDeclarative(normalizedId, featureCode ? { feature: featureCode } : {}))
          }
          return { success: true, isDeclarative: true, pluginId: normalizedId }
        }

        // 2. 原生/第三方插件通过 API 打开
        const result = await apiOpenPlugin(normalizedId)
        // 更新最近使用
        if (result?.success) {
          await this.markRecent(normalizedId)
        }
        return result
      } catch (err) {
        console.error('[plugins] 打开插件失败:', err)
        throw err
      }
    },

    /**
     * 一键静默安装插件（M1-7 支持原地状态流转、并发互斥防重与异常回滚）
     * @param {string} pluginId - 插件ID
     * @param {Object} options - { autoOpen?: boolean }
     */
    async installPlugin(pluginId, options = {}) {
      const pid = normalizePluginId(pluginId)
      if (!pid) {
        throw new Error(t('pluginsStore.pluginIdMissing'))
      }

      // 1. 下架强拦截（M1-8）
      if (this.isRevoked(pid)) {
        const reason = this.getRevokedReason(pid)
        throw new Error(t('pluginsStore.cannotInstallRevoked', { reason }))
      }

      // 2. 并发防重互斥拦截：若已在安装或下载中，严禁重复并发触发
      if (this.installingSet.has(pid) || this.downloadingSet.has(pid)) {
        console.warn('[plugins.installPlugin] 插件正在安装中，忽略重复并发点击:', pid)
        return { success: false, busy: true, message: t('pluginsStore.installingBusy') }
      }

      // 3. 互斥加锁与重置状态
      const nextInstalling = new Set(this.installingSet)
      nextInstalling.add(pid)
      this.installingSet = nextInstalling
      this.startDownload(pid)
      // 受管安装按宿主任务状态结束，不用纯时间阈值推断失败。
      this._clearDownloadTimer(pid)

      if (this.installErrorMap[pid]) {
        const nextErrMap = { ...this.installErrorMap }
        delete nextErrMap[pid]
        this.installErrorMap = nextErrMap
      }

      try {
        // 4. 安装前统一在线校验；展示快照和调用方传入的旧地址不能决定实际安装包。
        const downloadInfo = await getDownloadSign(pid)
        const downloadUrl = downloadInfo?.downloadUrl
        if (!downloadUrl) {
          throw new Error(t('pluginsStore.downloadUrlMissing'))
        }

        // 5. 校验平台与版本兼容性（fetchVersions / checkCompat 不会抛错，不兼容时必须中止安装）
        if (typeof checkCompat === 'function' && downloadInfo) {
          const ver = await fetchVersions()
          const compat = checkCompat(downloadInfo, ver.appVersion, ver.webVersion)
          if (!compat.compatible) {
            throw new Error(compat.reason || t('pluginsStore.versionIncompatible'))
          }
        }

        // 6. 先订阅，再发起；早到通知与超时查询都匹配同一个 operationId。
        await runPluginInstall({
          pluginId: pid,
          start: () => installPluginNative(pid, downloadInfo),
          events: window.ztools?.events,
          getStatus: (id, operationId) => window.ztools.plugin.getInstallStatus(id, operationId)
        })

        // 若安装的插件为 V2 声明式插件，预先补充到 installedPlugins 列表以供 openPlugin 即时识别
        if (
          downloadInfo &&
          (downloadInfo.isDeclarative ||
            downloadInfo.channel === 'v2' ||
            downloadInfo.sha256 ||
            (typeof downloadInfo.entry === 'string' && downloadInfo.entry.endsWith('.js')))
        ) {
          const existsInInstalled = (this.installedPlugins || []).some(
            (p) => normalizePluginId(p.pluginId || p.id).toLowerCase() === pid.toLowerCase()
          )
          if (!existsInInstalled) {
            this.installedPlugins = [
              {
                ...downloadInfo,
                id: pid,
                pluginId: pid,
                entry: downloadInfo.entry || 'dist/index.js',
                isDeclarative: true
              },
              ...(this.installedPlugins || [])
            ]
          }
        }

        // 7. 安装完成状态同步
        this.onInstallComplete({ pluginId: pid, success: true }, true)

        // 8. 默认装完直接进入内嵌声明式舞台
        if (options.autoOpen !== false) {
          try {
            await this.openPlugin(pid)
          } catch (openErr) {
            console.warn('[plugins.installPlugin] 安装后自动打开异常:', openErr)
          }
        }

        return { success: true, pluginId: pid }
      } catch (err) {
        console.error('[plugins.installPlugin] 安装失败:', pid, err)
        const errMsg = resolveErrorMessage(err, 'pluginsStore.installFailed')
        this.installErrorMap = {
          ...this.installErrorMap,
          [pid]: errMsg
        }
        if (err?.code === 'INSTALL_STATUS_UNKNOWN') {
          this.endDownload(pid)
          return { success: false, pending: true, pluginId: pid, message: errMsg }
        }
        this.onInstallComplete({ pluginId: pid, success: false, error: errMsg }, true)
        throw err
      } finally {
        const finished = new Set(this.installingSet)
        finished.delete(pid)
        this.installingSet = finished
      }
    },

    hideBundledPlugin(pluginId) {
      return this._setBundledPluginHidden(pluginId, true)
    },

    restoreBundledPlugin(pluginId) {
      return this._setBundledPluginHidden(pluginId, false)
    },

    async _setBundledPluginHidden(pluginId, hidden) {
      const id = normalizePluginId(pluginId).toLowerCase()
      if (!isBundledPlugin(id)) {
        throw new Error(t(hidden ? 'pluginsStore.bundledOnlyAction' : 'pluginsStore.bundledOnlyRestore'))
      }
      if (this._togglingBundledSet.has(id)) {
        return { success: false, busy: true, message: t('pluginsStore.operationInProgress') }
      }

      this._togglingBundledSet.add(id)
      const save = () => persistBundledPluginVisibility(this, id, hidden)
      const previous = this._bundledVisibilityWrite
      const write = previous ? previous.then(save, save) : save()
      this._bundledVisibilityWrite = write
      try {
        return await write
      } finally {
        this._togglingBundledSet.delete(id)
        if (this._bundledVisibilityWrite === write) this._bundledVisibilityWrite = null
      }
    },

    /**
     * 卸载插件
     * @param {string} pluginId - 插件ID
     */
    async uninstallPlugin(pluginId) {
      try {
        if (isClientProvidedPlugin(pluginId)) {
          throw new Error(t('details.builtinCannotUninstall'))
        }

        if (window.ztools && window.ztools.plugin) {
          const result = await window.ztools.plugin.uninstall(pluginId)
          if (result && result.success) {
            // 更新本地状态
            this.onUninstallComplete({ pluginId })
            // 刷新已安装列表
            await this.fetchInstalledPlugins()
          }
          return result
        }
        throw new Error(t('nativeApi.moduleUnavailable', { module: 'plugin' }))
      } catch (err) {
        console.error('[plugins] 卸载插件失败:', err)
        throw err
      }
    },

    /**
     * 设置更新信息，自动过滤不兼容的更新
     * 不兼容的插件会标记 incompatible: true 和 incompatReason
     */
    async setUpdateInfo(updates) {
      if (!updates) {
        this.updateMap = {}
        this.lastUpdateCheckTime = Date.now()
        return
      }
      this._applyRevocations(Object.entries(updates)
        .filter(([, info]) => info?.revoked)
        .map(([pluginId, info]) => ({ ...info, pluginId })))

      // 获取当前版本用于兼容性判断
      let appVer = '1.0.0'
      let webVer = '1.0.0'
      try {
        const ver = await fetchVersions()
        appVer = ver.appVersion
        webVer = ver.webVersion
      } catch (e) {
        console.warn('[plugins] 获取版本失败，跳过兼容性检查:', e)
      }

      // 遍历更新信息，标记不兼容的插件
      const processed = {}
      for (const [key, info] of Object.entries(updates)) {
        if (!info || !info.hasUpdate) {
          processed[key] = info
          continue
        }
        const compat = checkCompat(info, appVer, webVer)
        if (compat.compatible) {
          processed[key] = info
        } else {
          // 保留更新信息但标记为不兼容，UI 层据此显示"需升级"
          processed[key] = {
            ...info,
            incompatible: true,
            incompatReason: compat.reason
          }
        }
      }

      this.updateMap = processed
      this.lastUpdateCheckTime = Date.now()
    },

    /**
     * 是否需要重新批量检查更新
     * @param {number} intervalMs - 最小间隔（毫秒），默认 5 分钟
     * @returns {boolean}
     */
    shouldCheckUpdate(intervalMs = 5 * 60 * 1000) {
      return Date.now() - this.lastUpdateCheckTime > intervalMs
    },

    /**
     * 批量检查已安装插件更新（带节流，默认 5 分钟内不重复请求）
     * @param {number} intervalMs - 最小间隔（毫秒），默认 5 分钟
     */
    async checkInstalledUpdates(intervalMs = 5 * 60 * 1000) {
      if (!this.shouldCheckUpdate(intervalMs)) return
      const locals = this.installedPlugins || []
      if (locals.length === 0) return
      const updates = await batchCheckPlugins({
        plugins: locals.map((p) => ({
          id: p.pluginId,
          version: p.version || '1.0.0'
        }))
      })
      await this.setUpdateInfo(updates)
    },

    // 下载状态管理
    startDownload(pluginId) {
      const id = String(pluginId)
      const next = new Set(this.downloadingSet)
      next.add(id)
      this.downloadingSet = next

      // 清除之前的失败状态（用户点击"重试"时）
      const nextFailed = new Set(this.installFailedSet)
      nextFailed.delete(id)
      this.installFailedSet = nextFailed

      // 设置下载超时（90秒），超时后自动标记为失败
      this._clearDownloadTimer(id)
      this._downloadTimers[id] = setTimeout(() => {
        // 如果还在下载中，说明超时了
        if (this.downloadingSet.has(id)) {
          console.warn('[plugins] 插件下载超时:', id)
          this.endDownload(id)
          const failed = new Set(this.installFailedSet)
          failed.add(id)
          this.installFailedSet = failed
        }
      }, 90 * 1000)
    },

    endDownload(pluginId) {
      const id = String(pluginId)
      const next = new Set(this.downloadingSet)
      next.delete(id)
      this.downloadingSet = next

      // 清除超时定时器
      this._clearDownloadTimer(id)
    },

    // 清除下载超时定时器（内部方法）
    _clearDownloadTimer(pluginId) {
      const id = String(pluginId)
      if (this._downloadTimers[id]) {
        clearTimeout(this._downloadTimers[id])
        delete this._downloadTimers[id]
      }
    },

    // 检查插件是否安装失败
    isInstallFailed(pluginId) {
      return this.installFailedSet.has(String(pluginId))
    }
  }
})
