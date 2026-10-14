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
  getSyncData as apiGetSyncData,
  pushSyncData as apiPushSyncData,
  getDownloadSign,
  installPluginNative
} from '@/api/apiserver'
import { fetchVersions, checkCompat } from '@/composables/useVersionCompat'
import { formatLogArg } from '@/utils/logFormat'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { isOnline } from '@/config/runtime-mode'
import { StoreCatalogManager, resolveApiBaseUrl } from '@/utils/storeCatalogManager'

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
    // 数据同步状态
    syncStatus: 'idle', // 'idle' | 'syncing' | 'success' | 'error'
    lastSyncTime: null, // 最后同步时间戳
    syncError: null, // 同步错误信息
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
      return state.items.filter((item) => Boolean(item.is_official || item.isOfficial))
    },

    // 社区精选插件列表
    communityPlugins: (state) => {
      return state.items.filter((item) => !Boolean(item.is_official || item.isOfficial))
    },

    // 检查指定插件是否为官方自营
    isOfficialItem: (state) => (pluginId) => {
      const pid = normalizePluginId(pluginId).toLowerCase()
      const found = state.items.find(
        (item) => normalizePluginId(item.pluginId || item.id).toLowerCase() === pid
      )
      return Boolean(found?.is_official || found?.isOfficial)
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

          const parsedFavorites = parseConfigList(favStr)
          const parsedRecents = parseConfigList(recStr)
          this.favorites = new Set(normalizeIdList(parsedFavorites))
          this.recents = normalizeIdList(parsedRecents)

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
     * 从云端同步数据（登录后调用）
     * 拉取云端数据并覆盖本地缓存
     */
    async syncFromCloud() {
      if (!isOnline || !window.ztools?.user) {
        // console.log('[plugins] 用户服务不可用，跳过云端同步')
        return
      }

      try {
        const isLoggedIn = await window.ztools.user.isLoggedIn()
        if (!isLoggedIn) {
          // console.log('[plugins] 用户未登录，跳过云端同步')
          return
        }

        this.syncStatus = 'syncing'
        this.syncError = null
        // console.log('[plugins] 开始云端同步...')

        // 拉取云端数据
        const cloudData = await apiGetSyncData()
        // console.log('[plugins] 云端数据:', cloudData)

        // 记录云端同步时间，用于后续推送时的乐观锁
        this._cloudUpdatedAt = cloudData.updated_at || null

        // 云端有数据时覆盖本地收藏（updated_at 为 null 说明云端从未写入，保留本地等首次推送）
        if (cloudData.updated_at && Array.isArray(cloudData.favorites)) {
          this.favorites = new Set(normalizeIdList(cloudData.favorites))

          // 写回本地
          if (window.ztools?.config) {
            const favData = JSON.stringify(Array.from(this.favorites))
            await window.ztools.config.set(
              'plugins.favorites',
              favData,
              false,
              'user_settings.json'
            )
          }
        }

        this.syncStatus = 'success'
        this.lastSyncTime = Date.now()
        // console.log('[plugins] 云端同步完成')
      } catch (err) {
        this.syncStatus = 'error'
        this.syncError = err.message || '同步失败'
        console.warn('[plugins] 云端同步失败:', formatLogArg(err))
      }
    },

    /**
     * 推送数据到云端（异步，失败不阻塞）
     * @param {Object} data - 要推送的字段（部分更新）
     */
    async pushToCloud(data) {
      if (!isOnline || !window.ztools?.user) return

      try {
        const isLoggedIn = await window.ztools.user.isLoggedIn()
        if (!isLoggedIn) return

        const payload = {
          ...data,
          last_updated_at: this._cloudUpdatedAt || null
        }

        const result = await apiPushSyncData(payload)

        if (result.success) {
          // 更新本地记录的云端时间
          this._cloudUpdatedAt = result.data?.updated_at || null
          // console.log('[plugins] 推送云端成功')
        } else if (result.conflict) {
          // 冲突时用云端数据覆盖（Last Write Wins 简化处理）
          console.warn('[plugins] 云端数据冲突，使用云端数据')
          this._cloudUpdatedAt = result.data?.updated_at || null
        }
      } catch (err) {
        // 推送失败静默处理，不影响本地操作
        console.warn('[plugins] 推送云端失败:', formatLogArg(err))
      }
    },

    /**
     * 获取或初始化 Local-First Store 目录管理器
     */
    _getCatalogManager() {
      if (!this._catalogManager) {
        const apiBase = resolveApiBaseUrl()
        this._catalogManager = new StoreCatalogManager({
          apiBaseUrl: apiBase,
          fetchRemote: async (url) => {
            if (url) {
              try {
                const res = await fetch(url, { headers: { Accept: 'application/json' } })
                if (res.ok) {
                  return await res.json()
                }
              } catch (e) {
                console.warn('[plugins] 官方 catalog 拉取失败，回退默认接口:', e)
              }
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
          getOfficialList: () => getOfficialPluginsList(),
          isPlatformSupported: isPluginSupportedOnCurrentPlatform,
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

      // 识别官方下架状态并全链路同步（M1-8）
      this._applyRevocations(result.list)

      return result
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

          // 仅当用户处于已登录状态时，才在后台静默发起云端收藏列表同步；未登录直接跳过
          let isLoggedIn = false
          try {
            if (window.ztools?.user && typeof window.ztools.user.isLoggedIn === 'function') {
              isLoggedIn = await window.ztools.user.isLoggedIn()
            }
          } catch {
            isLoggedIn = false
          }

          if (isLoggedIn) {
            this.pushToCloud({
              favorites: Array.from(this.favorites)
            }).catch(() => {})
          }
        }

        // 触发收藏变化事件，通知其他组件
        this._emitFavoriteChanged(normalizedId, isFavorite)

        // 埋点：收藏/取消收藏
        window.ztools?.analytics?.report('plugin_favorite', normalizedId, { action: isFavorite ? 'add' : 'remove' })

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
      for (const item of this.items) {
        if (item.pluginId && item.icon && item.icon.startsWith('http')) {
          marketMap[String(item.pluginId)] = item.icon
        }
      }

      // 找出不在市场列表里的已安装插件，单独请求它们的图标 URL
      const missingIds = this.installedPlugins
        .map((p) => String(p.pluginId))
        .filter((id) => !marketMap[id])

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
        const remoteIcon = marketMap[String(p.pluginId)] || ''
        if (remoteIcon && p.icon !== remoteIcon) {
          p.icon = remoteIcon
          changed = true
        }
        // 对比本地 icon.url 记录的 URL 和市场最新 URL
        // 不一致说明后台更换了图标，通知 Delphi 异步更新本地 icon.png 和 icon.ico
        if (remoteIcon && (p.localIconUrl || '') !== remoteIcon) {
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
      try {
        const locals = await apiGetLocalPlugins()
        const officialList = getOfficialPluginsList()

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

        // 合并插件列表：本地插件 + 官方标杆应用（若本地已有同 ID 则优先本地）
        const localMap = new Map(
          (locals || []).map((p) => [String(p.pluginId || '').toLowerCase(), p])
        )
        const combined = [...(locals || [])]
        for (const official of officialList) {
          const key = String(official.pluginId || '').toLowerCase()
          if (!localMap.has(key)) {
            combined.push({ ...official })
          }
        }

        // 保存完整插件信息，按最近使用时间排序
        this.installedPlugins = combined.sort((a, b) => {
          const timeA = a.lastUsedTime || 0
          const timeB = b.lastUsedTime || 0
          return timeB - timeA
        })

        // 用市场数据补充远程 icon URL，并检测图标是否需要更新
        this._patchInstalledIcons()
        return combined
      } catch (err) {
        console.warn('[plugins] 获取本地插件失败，回退官方内置标杆插件列表:', err)
        const officialList = getOfficialPluginsList()
        const officialIds = officialList.map((p) => String(p.pluginId))
        this.installedSet = new Set(officialIds)
        this.installedPlugins = [...officialList]
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
        if (isOfficialPlugin(payload.pluginId)) {
          // 官方内置标杆应用不可卸载
          return
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
    async openPlugin(pluginId) {
      try {
        const normalizedId = normalizePluginId(pluginId)
        if (!normalizedId) {
          throw new Error('插件标识符不存在')
        }

        // 下架防御性拦截（M1-8）
        if (this.isRevoked(normalizedId)) {
          const reason = this.getRevokedReason(normalizedId) || '该插件已被官方下架禁用'
          throw new Error(`无法启动：该插件已被官方下架禁用（原因：${reason}）`)
        }

        // 1. 若为官方标杆声明式应用：直接路由或唤起声明式运行时
        if (isOfficialPlugin(normalizedId)) {
          await this.markRecent(normalizedId)

          // 悬浮启动器模式嗅探
          if (
            typeof window !== 'undefined' &&
            typeof window.__ztoolsOpenLauncherDeclarative === 'function'
          ) {
            window.__ztoolsOpenLauncherDeclarative(normalizedId)
            return { success: true, isDeclarative: true, pluginId: normalizedId }
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
        // 4. 获取下载签名与包信息
        let downloadInfo = options.downloadInfo
        if (!downloadInfo) {
          downloadInfo = await getDownloadSign(pid)
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
        if (isOfficialPlugin(pluginId)) {
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
