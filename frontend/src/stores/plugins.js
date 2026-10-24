import { defineStore } from 'pinia'
import router from '@/router'
import { routeUtils } from '@/router/routes'
import {
  getOfficialPluginsList,
  isOfficialPlugin,
  getOfficialPlugin
} from '@/utils/officialPlugins'

import {
  getMarketPlugins as apiGetMarketPlugins,
  getPluginDetails as apiGetPluginDetails,
  getLocalPlugins as apiGetLocalPlugins,
  openPlugin as apiOpenPlugin,
  getDownloadSign,
  installPluginNative
} from '@/api/apiserver'
import { fetchVersions, checkCompat } from '@/composables/useVersionCompat'
import { formatLogArg } from '@/utils/logFormat'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { cloudSync, track } from '@edition'
import {
  StoreCatalogManager,
  isOfficialPluginItem,
  normalizeCdnCatalogPayload
} from '@/utils/storeCatalogManager'
import {
  clearDeclarativePluginCache,
  loadInstalledDeclarativePlugin,
  V2_CATALOG_CDN_URL
} from '@/utils/declarativePluginLoader'
import { getBundledPluginEntries, isBundledPlugin, resolveBundledReplacement } from '@/utils/bundledPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'

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

export const usePluginsStore = defineStore('plugins', {
  state: () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 12,
    keyword: '',
    category: '',
    sourceFilter: 'all', // 'all' | 'official' (官方自营) | 'community' (社区精选)
    favorites: new Set(),
    recents: [],
    // 最近使用时间：{ [pluginId]: 毫秒时间戳 }，与 recents 一起只存本地
    recentUsedAt: {},
    installedSet: new Set(),
    installedPlugins: [], // 已安装插件的完整信息列表
    downloadingSet: new Set(), // 正在下载的插件ID
    installingSet: new Set(), // 正在安装的插件ID集合（并发防重互斥）
    installFailedSet: new Set(), // 安装失败的插件ID（用于显示"重试"）
    installErrorMap: {}, // { [pluginId]: string } 安装失败具体错误信息
    revokedMap: {}, // { [pluginId]: { revoked: true, reason: string } } 官方下架状态映射
    _downloadTimers: {}, // 下载超时定时器（内部使用）
    favoritePluginsList: [], // 收藏插件的完整信息列表
    updateMap: {}, // { pluginId: updateInfo }
    lastUpdateCheckTime: 0, // 上次批量检查更新的时间戳
    loading: false,
    error: null,
    // 推荐插件（从后端 API 获取）
    recommendedItems: [],
    recommendedLoading: false,
    recommendedError: null,
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

    // 获取下架原因
    getRevokedReason: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId)
      return state.revokedMap[pid]?.reason || '该插件已被官方下架禁用'
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

    // 官方自营插件列表
    officialPlugins: (state) => {
      return state.items.filter((item) => isOfficialPluginItem(item))
    },

    // 社区精选插件列表
    communityPlugins: (state) => {
      return state.items.filter((item) => !isOfficialPluginItem(item))
    },

    // 检查指定插件是否为官方自营
    isOfficialItem: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId).toLowerCase()
      const found = state.items.find(
        (item) => normalizePluginId(item.pluginId || item.id).toLowerCase() === pid
      )
      return isOfficialPluginItem(found) || isOfficialPlugin(pid) || isBundledPlugin(pid)
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

        // 初始化已安装插件列表
        await this.fetchInstalledPlugins()

        // 收藏详情依赖市场接口，不阻塞首屏
        this.fetchFavoritePlugins().catch((err) => {
          console.warn('[plugins] 后台加载收藏插件失败:', err)
        })
      } catch (err) {
        console.error('[plugins] 初始化失败:', err)
        this.favorites = new Set()
        this.recents = []
        this.recentUsedAt = {}
      }
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
        // 插件目录以 CDN 静态目录为准（后台不再提供目录接口）；CDN 不可用时回退插件列表接口，再不行由目录管理器回退本地快照与内置清单
        this._catalogManager = new StoreCatalogManager({
          staticCatalogUrl: V2_CATALOG_CDN_URL,
          getStaticCatalog: async () => {
            const res = await fetch(V2_CATALOG_CDN_URL, {
              headers: { Accept: 'application/json' }
            })
            return res.ok ? normalizeCdnCatalogPayload(await res.json()) : null
          },
          fetchRemote: async () => {
            try {
              const res = await fetch(V2_CATALOG_CDN_URL, { headers: { Accept: 'application/json' } })
              if (res.ok) {
                return normalizeCdnCatalogPayload(await res.json())
              }
            } catch (e) {
              console.warn('[plugins] 静态 catalog 拉取失败，回退插件列表接口:', e)
            }
            return apiGetMarketPlugins({ per_page: 500, page: 1 })
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
        this.error = err.message || '加载插件失败'
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
      this._updateCategoryCounts(manager._catalog)

      // 识别官方下架状态并全链路同步（M1-8）
      this._applyRevocations(result.list)

      return result
    },

    /** 按分类统计目录里的插件数（目录已按当前系统过滤，已下架的不计） */
    _updateCategoryCounts(catalog) {
      if (!Array.isArray(catalog)) return
      const counts = {}
      for (const item of catalog) {
        if (!item || this.isRevoked?.(item.pluginId || item.id)) continue
        const names = Array.isArray(item.category) ? item.category : [item.category]
        for (const name of new Set(names.filter((n) => typeof n === 'string' && n))) {
          counts[name] = (counts[name] || 0) + 1
        }
      }
      this.categoryCounts = counts
    },

    /** 侧栏等不经过市场列表的地方，主动拉一次目录来统计分类 */
    async refreshCategoryCounts() {
      try {
        const { catalog } = await this._getCatalogManager().ensureCatalog()
        this._updateCategoryCounts(catalog)
      } catch (error) {
        console.warn('[PluginsStore] 统计分类插件数失败，保留全部分类:', error)
      }
      return this.categoryCounts
    },

    /** 某个分类是否要显示：统计结果出来前一律显示；正在查看的分类始终显示 */
    isCategoryVisible(name, activeName = '') {
      if (name === '全部' || name === activeName) return true
      if (!this.categoryCounts) return true
      return (this.categoryCounts[name] || 0) > 0
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
      try {
        const { list } = await this.loadWithCache({
          sort: 'downloads',
          direction: 'desc',
          per_page: limit,
          page: 1
        })
        this.recommendedItems = list || []
      } catch (err) {
        this.recommendedError = err.message || '加载推荐插件失败'
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
      }
    },

    async toggleFavorite(pluginId) {
      const normalizedId = normalizePluginId(pluginId)
      if (!normalizedId) {
        throw new Error('插件标识符不存在')
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

    /** 用市场数据补充已安装插件的远程 icon URL */
    _patchInstalledIcons() {
      if (!this.installedPlugins?.length) return
      const marketMap = {}
      const catalogSource = [
        ...(Array.isArray(this._catalogManager?._catalog) ? this._catalogManager._catalog : []),
        ...(Array.isArray(this.items) ? this.items : [])
      ]
      for (const item of catalogSource) {
        const pid = item?.pluginId || item?.id
        if (pid && item.icon && item.icon.startsWith('http')) {
          marketMap[String(pid)] = item.icon
        }
      }

      // 找出不在市场列表里的已安装插件，单独请求它们的图标 URL
      // 内置插件的图标随客户端一起发布，不向市场查询，避免被旧版本图标覆盖（返回首页时图标会闪一下再变）
      const missingIds = this.installedPlugins
        .map((p) => String(p.pluginId))
        .filter((id) => !marketMap[id] && !isBundledPlugin(id))

      if (missingIds.length > 0) {
        apiGetMarketPlugins({ ids: missingIds, per_page: missingIds.length }).then((res) => {
          const list = res?.list || []
          for (const item of list) {
            if (item.pluginId && item.icon && item.icon.startsWith('http')) {
              marketMap[String(item.pluginId)] = item.icon
            }
          }
          this._applyIconPatch(marketMap)
        }).catch(() => {})
        return
      }

      this._applyIconPatch(marketMap)
    },

    _applyIconPatch(marketMap) {
      let changed = false
      for (const p of this.installedPlugins) {
        if (isBundledPlugin(p.pluginId)) continue
        const remoteIcon = marketMap[String(p.pluginId)] || ''
        if (remoteIcon && p.icon !== remoteIcon) {
          p.icon = remoteIcon
          changed = true
        }
        // 对比本地 icon.url 记录的 URL 和市场最新 URL
        // 不一致说明后台更换了图标，通知 Delphi 异步更新本地 icon.png 和 icon.ico
        // 内置插件没有本地 icon 文件，请求刷新只会在主进程得到 PLUGIN_NOT_FOUND
        if (!p.builtin && remoteIcon && (p.localIconUrl || '') !== remoteIcon) {
          if (window.ztools?.plugin?.refreshIcon) {
            window.ztools.plugin.refreshIcon(p.pluginId, remoteIcon).catch(() => {})
          }
        }
      }
      if (changed) {
        this.installedPlugins = [...this.installedPlugins]
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
        const pid = normalizePluginId(item.pluginId || item.id)
        if (!pid) continue
        if (item.revoked) {
          const reason = item.revoked_reason || item.revokedReason || '该插件已被官方下架禁用'
          if (!this.revokedMap[pid] || this.revokedMap[pid].reason !== reason) {
            this.revokedMap = {
              ...this.revokedMap,
              [pid]: { revoked: true, reason }
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
              found.revoked_reason = reason
              found.enabled = false
            }
            if (window.ztools?.plugin?.toggle) {
              window.ztools.plugin.toggle(pid, false).catch(() => {})
            }
          }
        }
      }
      if (changed && this.installedPlugins?.length) {
        this.installedPlugins = [...this.installedPlugins]
      }
    },

    async fetchInstalledPlugins() {
      const bundledEntries = getBundledPluginEntries()
      try {
        const locals = await apiGetLocalPlugins()
        const officialList = [...bundledEntries, ...getOfficialPluginsList()]

        // 识别本地已装插件的下架标记
        for (const p of locals || []) {
          const pid = normalizePluginId(p.pluginId || p.id)
          if (!pid) continue
          if (p.revoked) {
            const reason = p.revoked_reason || p.revokedReason || '该插件已被官方下架禁用'
            this.revokedMap = {
              ...this.revokedMap,
              [pid]: { revoked: true, reason }
            }
            p.enabled = false
          }
        }

        const localIds = (locals || []).map((p) => String(p.pluginId))
        const officialIds = officialList.map((p) => String(p.pluginId))

        // 合并：保留当前 installedSet 中已有、宿主尚未返回的 ID，以及所有官方内置标杆应用 ID
        const merged = new Set([...localIds, ...officialIds])
        for (const id of this.installedSet) {
          merged.add(id)
        }
        this.installedSet = merged

        // 合并插件列表：本地插件 + 官方标杆应用（若本地已有同 ID 或别名则合并官方声明式定义并去重）
        const coveredOfficialKeys = new Set()
        const combined = []
        // 与内置插件同 ID 的本地安装副本：以内置版本为准，只沿用其最近使用时间与启用状态
        const localBundledState = new Map()
        for (const p of locals || []) {
          const key = String(p.pluginId || p.id || '').toLowerCase()
          if (isBundledPlugin(key)) {
            localBundledState.set(key, { lastUsedTime: p.lastUsedTime, enabled: p.enabled })
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
              '官方自营'
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
            const badge = p.official_badge || p.officialBadge || '官方自营'
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
            const badge = official.official_badge || official.officialBadge || '官方自营'
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
        console.warn('[plugins] 获取本地插件失败，回退官方内置标杆插件列表:', err)
        const officialList = [...bundledEntries, ...getOfficialPluginsList()]
        const officialIds = officialList.map((p) => String(p.pluginId))
        this.installedSet = new Set(officialIds)
        this.installedPlugins = officialList
          .filter((p) => isPluginVisible(p) && isPluginSupportedOnCurrentPlatform(p))
          .map((plugin) => ({ ...plugin, builtin: true }))
        return officialList
      }
    },

    onInstallComplete(payload) {
      if (payload && payload.pluginId) {
        const pluginId = String(payload.pluginId)
        console.log('[pluginsStore.onInstallComplete]', pluginId, 'success:', payload.success, 'isUpdate:', payload.isUpdate)

        // 清除下载超时定时器
        this._clearDownloadTimer(pluginId)

        // 清除正在安装互斥标记
        const nextInstalling = new Set(this.installingSet)
        nextInstalling.delete(pluginId)
        this.installingSet = nextInstalling

        if (payload.success) {
          clearDeclarativePluginCache(pluginId)
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
              [pluginId]: String(payload.error)
            }
          }
        }
      } else {
        console.warn('[plugins.onInstallComplete] payload 无效:', payload)
      }
    },

    onUninstallComplete(payload) {
      if (payload && payload.pluginId) {
        if (isOfficialPlugin(payload.pluginId) || isBundledPlugin(payload.pluginId)) {
          // 官方内置标杆应用不可卸载
          return
        }
        clearDeclarativePluginCache(payload.pluginId)
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
    async openPlugin(pluginId) {
      try {
        // 已合并进内置插件的旧插件（如 notes → memo）直接打开保留的那个
        const normalizedId = normalizePluginId(resolveBundledReplacement(normalizePluginId(pluginId)))
        if (!normalizedId) {
          throw new Error('插件标识符不存在')
        }

        // 下架防御性拦截（M1-8）
        if (this.isRevoked(normalizedId)) {
          const reason = this.getRevokedReason(normalizedId) || '该插件已被官方下架禁用'
          throw new Error(`无法启动：该插件已被官方下架禁用（原因：${reason}）`)
        }

        // 暂未开放的插件（未完成真实实现）不允许从旧快捷方式、历史记录等入口打开
        if (!isPluginVisible(normalizedId)) {
          throw new Error('无法启动：该插件暂未开放')
        }

        // 当前系统上不能真正工作的插件不允许启动，避免展示示例数据或假成功
        if (!isPluginSupportedOnCurrentPlatform(normalizedId)) {
          throw new Error('无法启动：该插件在当前系统上暂不可用')
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
            window.__ztoolsOpenLauncherDeclarative(normalizedId)
            return { success: true, isDeclarative: true, pluginId: normalizedId }
          }

          // 路由切换前先将声明式插件预热进内存缓存，确保进入 DeclarativePage 首帧同步直出无闪烁
          if (!getOfficialPlugin(normalizedId)) {
            await loadInstalledDeclarativePlugin(normalizedId).catch((prewarmErr) => {
              console.debug('[plugins.openPlugin] 预热声明式插件未命中，交由页面视图处理:', formatLogArg(prewarmErr))
            })
          }

          // 正常工作台模式直接路由到声明式应用页
          if (router) {
            await router.push(routeUtils.toDeclarative(normalizedId))
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
     * @param {Object} options - { autoOpen?: boolean, downloadInfo?: Object }
     */
    async installPlugin(pluginId, options = {}) {
      const pid = normalizePluginId(pluginId)
      if (!pid) {
        throw new Error('插件标识符不存在')
      }

      // 1. 下架强拦截（M1-8）
      if (this.isRevoked(pid)) {
        const reason = this.getRevokedReason(pid)
        throw new Error(`无法安装：该插件已被官方下架禁用（原因：${reason}）`)
      }

      // 2. 并发防重互斥拦截：若已在安装或下载中，严禁重复并发触发
      if (this.installingSet.has(pid) || this.downloadingSet.has(pid)) {
        console.warn('[plugins.installPlugin] 插件正在安装中，忽略重复并发点击:', pid)
        return { success: false, busy: true, message: '正在安装中' }
      }

      // 3. 互斥加锁与重置状态
      const nextInstalling = new Set(this.installingSet)
      nextInstalling.add(pid)
      this.installingSet = nextInstalling
      this.startDownload(pid)

      if (this.installErrorMap[pid]) {
        const nextErrMap = { ...this.installErrorMap }
        delete nextErrMap[pid]
        this.installErrorMap = nextErrMap
      }

      try {
        // 4. 获取下载签名与包信息（优先使用内存中已有的 V2 条目）
        let downloadInfo = options.downloadInfo
        if (!downloadInfo) {
          const lowerPid = pid.toLowerCase()
          const v2Candidate =
            this._catalogManager?.getById?.(pid) ||
            this._catalogManager?._catalog?.find?.(
              (i) => normalizePluginId(i.pluginId || i.id).toLowerCase() === lowerPid
            ) ||
            (this.items || []).find(
              (i) => normalizePluginId(i.pluginId || i.id).toLowerCase() === lowerPid
            )
          if (
            v2Candidate &&
            v2Candidate.downloadUrl &&
            (v2Candidate.sha256 || v2Candidate.checksum)
          ) {
            const sha256 = v2Candidate.sha256 || v2Candidate.checksum
            const size =
              Number(v2Candidate.size ?? v2Candidate.fileSize ?? v2Candidate.file_size ?? 0) || 0
            downloadInfo = {
              ...v2Candidate,
              id: v2Candidate.id || pid,
              pluginId: pid,
              version: v2Candidate.version || '1.0.0',
              downloadUrl: v2Candidate.downloadUrl,
              sha256,
              checksum: v2Candidate.checksum || sha256,
              size,
              fileSize: size
            }
          } else {
            downloadInfo = await getDownloadSign(pid)
          }
        }
        const downloadUrl = downloadInfo?.downloadUrl
        if (!downloadUrl) {
          throw new Error('无法获取插件下载地址')
        }

        // 5. 校验平台与版本兼容性
        if (typeof checkCompat === 'function' && downloadInfo) {
          try {
            const ver = await fetchVersions()
            const compat = checkCompat(downloadInfo, ver.appVersion, ver.webVersion)
            if (!compat.compatible) {
              throw new Error(compat.reason || '当前应用版本不满足该插件兼容性要求')
            }
          } catch (compatErr) {
            if (compatErr?.message && compatErr.message.includes('不满足')) {
              throw compatErr
            }
          }
        }

        // 6. 调用底层 Native/Electron 安装
        const result = await installPluginNative(pid, downloadInfo)
        if (!result || result.success === false) {
          throw new Error(result?.error || '安装执行失败')
        }

        // 6b. 若宿主返回异步 operationId，等待 plugin_install_complete 事件完成（30秒超时保护）
        if (
          result?.operationId &&
          typeof window !== 'undefined' &&
          typeof window.ztools?.events?.on === 'function'
        ) {
          await new Promise((resolve, reject) => {
            let settled = false
            let timer = null
            const cleanup = () => {
              if (timer) {
                clearTimeout(timer)
                timer = null
              }
              try {
                window.ztools?.events?.off?.('plugin_install_complete', onInstallEvent)
              } catch {}
            }
            const onInstallEvent = (evt) => {
              const payload =
                evt?.payload && typeof evt.payload === 'object' ? evt.payload : evt
              if (normalizePluginId(payload?.pluginId) !== pid) return
              if (settled) return
              settled = true
              cleanup()
              if (payload?.success === false) {
                reject(new Error(payload.error || '安装失败'))
              } else {
                resolve(payload)
              }
            }
            timer = setTimeout(() => {
              if (settled) return
              settled = true
              cleanup()
              reject(new Error('插件安装等待超时 (30s)'))
            }, 30 * 1000)
            try {
              window.ztools.events.subscribe?.('plugin_install_complete')?.catch?.(() => {})
            } catch {}
            window.ztools.events.on('plugin_install_complete', onInstallEvent)
          })
        }

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
        this.onInstallComplete({ pluginId: pid, success: true })

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
        const errMsg = err?.message || String(err) || '安装失败'
        this.installErrorMap = {
          ...this.installErrorMap,
          [pid]: errMsg
        }
        this.onInstallComplete({ pluginId: pid, success: false, error: errMsg })
        throw err
      } finally {
        const finished = new Set(this.installingSet)
        finished.delete(pid)
        this.installingSet = finished
      }
    },

    /**
     * 卸载插件
     * @param {string} pluginId - 插件ID
     */
    async uninstallPlugin(pluginId) {
      try {
        if (isOfficialPlugin(pluginId) || isBundledPlugin(pluginId)) {
          throw new Error('官方内置核心扩展不可卸载')
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
        throw new Error('ZTools plugin API 不可用')
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
