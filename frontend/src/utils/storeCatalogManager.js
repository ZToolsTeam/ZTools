/**
 * storeCatalogManager.js
 * ZTools 对齐 Raycast 标杆体系的 Local-First 扩展商店数据管理器
 * 
 * 核心设计：
 * 1. 本地优先 (Local-First)：全量索引在内存常驻，毫秒级本地过滤与拼音检索 (SLA < 10ms)；
 * 2. 离线韧性 (Offline Resilience)：网络中断、API 5xx 或超时时自动降级到本地持久化快照与内置标杆应用；
 * 3. 5 分钟短缓存 (5min TTL)：保障官方下架开关 (Kill-Switch) 与紧急安全修复即时生效；
 * 4. 纯净解耦：无 DOM 依赖，完全可测试。
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 分钟短缓存
// 远程清单请求的最长等待时间；超时按失败处理，走本地快照 / 内置清单，市场不会一直空着
export const REMOTE_FETCH_TIMEOUT_MS = 8000

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`远程插件清单请求超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 规范化插件 ID
 */
export function normalizePluginId(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const nested = value.pluginId || value.id
    return nested === null || nested === undefined ? '' : String(nested).trim()
  }
  return String(value).trim()
}

const OFFICIAL_AUTHORS = new Set([
  'ztools',
  'ztools team',
  'ztools-team',
  'ztools official',
  'ztools official team',
  'official'
])

/**
 * ZTools-extensions 开源社区生态插件集合（26 款跨平台开源扩展）
 * 当静态 CDN 索引 (plugins-v2/plugins.json) 批量构建产物的默认作者为 ZTools Team 时，
 * 将这些开源社区扩展归类到「社区精选 (community)」，确保开源与商业客户端的「社区精选」Tab 均可正常浏览与安装。
 */
export const COMMUNITY_EXTENSION_IDS = new Set([
  'base64image',
  'batch-text-convert',
  'browser-bookmarks',
  'browser-history',
  'calendar',
  'chinese-number-converter',
  'crypto-tool',
  'file-compare',
  'google-auth',
  'image-editor',
  'image-tool',
  'lan-share',
  'memo',
  'port-manager',
  'quick-folders',
  'record',
  'screen-color-picker',
  'shredder',
  'sqlite-plugin',
  'super-markdown',
  'text-formatter',
  'timestamp',
  'todo',
  'unit-converter',
  'uuid-generator',
  'world-clock'
])

/**
 * 规范化静态 CDN 插件目录载荷，将 ZTools-extensions 开源社区扩展标记为 community 来源
 * @param {any} payload
 * @returns {any}
 */
export function normalizeCdnCatalogPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const mapItem = (item) => {
    if (!item || typeof item !== 'object') return item
    const pid = normalizePluginId(item.pluginId || item.id).toLowerCase()
    if (!pid || !COMMUNITY_EXTENSION_IDS.has(pid)) return item
    const rawAuthor = String(item.author || '').trim()
    const isDefaultOfficialAuthor = !rawAuthor || isOfficialAuthor(rawAuthor)
    return {
      ...item,
      author: isDefaultOfficialAuthor ? 'ZTools Community' : rawAuthor,
      is_official: false,
      isOfficial: false,
      official_badge: null,
      officialBadge: null,
      source_type: 'community',
      sourceType: 'community'
    }
  }
  if (Array.isArray(payload)) {
    return payload.map(mapItem)
  }
  if (Array.isArray(payload.plugins)) {
    return { ...payload, plugins: payload.plugins.map(mapItem) }
  }
  if (Array.isArray(payload.list)) {
    return { ...payload, list: payload.list.map(mapItem) }
  }
  return payload
}

/**
 * 判断作者名称是否属于官方自营团队
 * @param {string} [author]
 * @returns {boolean}
 */
export function isOfficialAuthor(author) {
  if (!author || typeof author !== 'string') return false
  const normalized = author.trim().toLowerCase()
  if (!normalized) return false
  return OFFICIAL_AUTHORS.has(normalized) || normalized.includes('official')
}

/**
 * 统一判定插件条目是否为官方自营
 * 修复 `item.is_official ?? ...` 在后端返回默认布尔值 `false` 时直接短路、
 * 从而忽略 builtinMatch 与官方作者（如 'ZTools Team'）的缺陷
 * @param {object} item
 * @param {object|null} [builtinMatch]
 * @returns {boolean}
 */
export function isOfficialPluginItem(item, builtinMatch = null) {
  if (!item || typeof item !== 'object') return false
  if (
    item.isBuiltin === true ||
    builtinMatch?.is_official === true ||
    builtinMatch?.isOfficial === true ||
    builtinMatch?.isBuiltin === true
  ) {
    return true
  }
  if (
    (item.source_type === 'community' || item.sourceType === 'community') &&
    item.is_official !== true &&
    item.isOfficial !== true
  ) {
    return false
  }
  if (item.is_official === true || item.isOfficial === true) return true
  if (item.source_type === 'official' || item.sourceType === 'official') return true
  if (isOfficialAuthor(item.author) || isOfficialAuthor(builtinMatch?.author)) {
    return true
  }
  return false
}

/**
 * 简易拼音/模糊匹配评分器
 * @param {object} plugin - 插件对象
 * @param {string} keyword - 搜索关键词
 * @returns {boolean} 是否命中
 */
export function matchPlugin(plugin, keyword) {
  if (!keyword) return true
  const kw = keyword.trim().toLowerCase()
  if (!kw) return true

  const id = String(plugin.pluginId || plugin.id || '').toLowerCase()
  const name = String(plugin.name || '').toLowerCase()
  const title = String(plugin.title || '').toLowerCase()
  const desc = String(plugin.description || '').toLowerCase()
  const author = String(plugin.author || '').toLowerCase()
  const kwList = Array.isArray(plugin.keywords) ? plugin.keywords.join(' ').toLowerCase() : String(plugin.keywords || '').toLowerCase()

  return (
    id.includes(kw) ||
    name.includes(kw) ||
    title.includes(kw) ||
    desc.includes(kw) ||
    author.includes(kw) ||
    kwList.includes(kw)
  )
}

/**
 * 解析 API 基础地址（支持 Vite 环境变量与 Node 测试环境）
 * @param {string} [overrideUrl]
 * @returns {string}
 */
export function resolveApiBaseUrl(overrideUrl) {
  let url = ''
  if (overrideUrl !== undefined && overrideUrl !== null) {
    url = String(overrideUrl).trim()
  } else {
    try {
      if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_API_BASE_URL !== undefined) {
        url = String(import.meta.env.VITE_API_BASE_URL || '').trim()
      }
    } catch {}
    if (!url) {
      try {
        if (typeof process !== 'undefined' && process?.env?.VITE_API_BASE_URL !== undefined) {
          url = String(process.env.VITE_API_BASE_URL || '').trim()
        }
      } catch {}
    }
  }
  return url.replace(/\/+$/, '')
}

export const getApiBaseUrl = resolveApiBaseUrl

export class StoreCatalogManager {
  /**
   * @param {object} options
   * @param {string} [options.apiBaseUrl] - 官方后台 API 地址；若未配置或为空则自动进入去中心化静态模式
   * @param {string} [options.staticCatalogUrl] - 开源静态 Catalog 地址
   * @param {() => Promise<Array|{ list: Array }>} [options.getStaticCatalog] - 静态 Catalog 获取器
   * @param {(catalogUrl?: string) => Promise<{ list: Array, total?: number } | Array>} options.fetchRemote
   * @param {() => Promise<Array|null>} [options.getLocalSnapshot]
   * @param {(catalog: Array) => Promise<void>} [options.saveLocalSnapshot]
   * @param {() => Array} [options.getOfficialList]
   * @param {(plugin: object) => boolean} [options.isPlatformSupported]
   * @param {number} [options.ttlMs]
   */
  constructor(options = {}) {
    this.apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl)
    this.hasCustomFetchRemote = typeof options.fetchRemote === 'function'
    this.staticCatalogUrl = options.staticCatalogUrl || ''
    this.getStaticCatalog = options.getStaticCatalog || null
    this.fetchRemote = options.fetchRemote || null
    this.getLocalSnapshot = options.getLocalSnapshot || (async () => null)
    this.saveLocalSnapshot = options.saveLocalSnapshot || (async () => {})
    this.getOfficialList = options.getOfficialList || (() => [])
    this.isPlatformSupported = options.isPlatformSupported || (() => true)
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS
    this.remoteTimeoutMs = options.remoteTimeoutMs || REMOTE_FETCH_TIMEOUT_MS

    this._catalog = [] // 内存中全量有效插件条目
    this._lastSyncTime = 0
    this._revokedMap = {} // { [pluginId]: { revoked: true, reason: string } }
    this._inFlightPromise = null
  }

  /**
   * 获取当前全量插件缓存（若过期或未加载则触发同步）
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<{ catalog: Array, isFallback: boolean, source: 'memory'|'remote'|'decentralized_static'|'local_snapshot'|'official_builtin' }>}
   */
  async ensureCatalog(forceRefresh = false) {
    const now = Date.now()
    if (!forceRefresh && this._catalog.length > 0 && now - this._lastSyncTime < this.ttlMs) {
      return { catalog: this._catalog, isFallback: false, source: 'memory' }
    }

    if (this._inFlightPromise) {
      return this._inFlightPromise
    }

    this._inFlightPromise = this._doSync(forceRefresh)
    try {
      return await this._inFlightPromise
    } finally {
      this._inFlightPromise = null
    }
  }

  async _doSync(forceRefresh) {
    let rawList = null
    let source = 'remote'
    let isFallback = false
    let remoteFailed = false

    // 1. 若配置了官方后台地址 (VITE_API_BASE_URL 非空)，优先请求官方 /api/plugins/catalog
    if (this.apiBaseUrl) {
      try {
        const catalogUrl = `${this.apiBaseUrl.replace(/\/+$/, '')}/api/plugins/catalog`
        const res = await withTimeout(
          this.fetchRemote
            ? this.fetchRemote(catalogUrl)
            : (typeof fetch === 'function' ? fetch(catalogUrl).then((r) => r.json()) : Promise.resolve(null)),
          this.remoteTimeoutMs
        )
        if (res && Array.isArray(res.list)) {
          rawList = res.list
        } else if (Array.isArray(res)) {
          rawList = res
        } else if (res && Array.isArray(res.plugins)) {
          rawList = res.plugins
        } else {
          remoteFailed = true
        }
      } catch (remoteErr) {
        remoteFailed = true
        console.warn('[StoreCatalogManager] 官方远程拉取失败，尝试本地容灾降级:', remoteErr)
      }
    } else if (this.hasCustomFetchRemote) {
      // 兼容显式传入 fetchRemote 的调用方与单元测试
      try {
        const res = await withTimeout(this.fetchRemote(), this.remoteTimeoutMs)
        if (res && Array.isArray(res.list)) {
          rawList = res.list
        } else if (Array.isArray(res)) {
          rawList = res
        } else if (res && Array.isArray(res.plugins)) {
          rawList = res.plugins
        } else {
          remoteFailed = true
        }
      } catch (remoteErr) {
        remoteFailed = true
        console.warn('[StoreCatalogManager] 远程拉取失败，尝试本地容灾降级:', remoteErr)
      }
    } else {
      // 2. 当 VITE_API_BASE_URL 为空（开源默认状态）且无自定义 fetchRemote 时，自动采用去中心化静态 Catalog 模式，绝不报错
      source = 'decentralized_static'
      if (this.getStaticCatalog) {
        try {
          const staticRes = await withTimeout(Promise.resolve().then(() => this.getStaticCatalog()), this.remoteTimeoutMs)
          if (Array.isArray(staticRes)) {
            rawList = staticRes
          } else if (staticRes && Array.isArray(staticRes.list)) {
            rawList = staticRes.list
          } else if (staticRes && Array.isArray(staticRes.plugins)) {
            rawList = staticRes.plugins
          }
        } catch {
          // 去中心化模式下静默处理，绝不抛错
        }
      }
    }

    if (remoteFailed) {
      isFallback = true
    }

    // 3. 远程/静态失败时，降级到本地持久化快照
    if (!rawList || rawList.length === 0) {
      try {
        const local = await this.getLocalSnapshot()
        if (Array.isArray(local) && local.length > 0) {
          rawList = local
          source = 'local_snapshot'
          isFallback = true
        }
      } catch (snapshotErr) {
        if (this.apiBaseUrl || this.hasCustomFetchRemote) {
          console.warn('[StoreCatalogManager] 本地快照读取失败:', snapshotErr)
        }
      }
    }

    // 4. 本地快照亦无时，降级至开源静态 Catalog 或 内置标杆清单
    if ((!rawList || rawList.length === 0) && this.getStaticCatalog) {
      try {
        const staticRes = await withTimeout(Promise.resolve().then(() => this.getStaticCatalog()), this.remoteTimeoutMs)
        if (Array.isArray(staticRes) && staticRes.length > 0) {
          rawList = staticRes
          source = 'decentralized_static'
          isFallback = true
        } else if (staticRes && Array.isArray(staticRes.list) && staticRes.list.length > 0) {
          rawList = staticRes.list
          source = 'decentralized_static'
          isFallback = true
        } else if (staticRes && Array.isArray(staticRes.plugins) && staticRes.plugins.length > 0) {
          rawList = staticRes.plugins
          source = 'decentralized_static'
          isFallback = true
        }
      } catch {}
    }

    // 5. 最终使用随包内置官方标杆应用保底（保证开源极客开箱即用，绝不崩溃）
    if (!rawList || rawList.length === 0) {
      const official = this.getOfficialList()
      rawList = Array.isArray(official) ? official : []
      if (source !== 'decentralized_static') {
        source = 'official_builtin'
      }
      if (this.apiBaseUrl || this.hasCustomFetchRemote || remoteFailed) {
        isFallback = true
      }
    }

    // 5. 规范化并解析官方自营金标插件
    const officialList = this.getOfficialList() || []
    const officialMap = new Map()
    for (const off of officialList) {
      const opid = normalizePluginId(off.pluginId || off.id)
      if (opid) {
        officialMap.set(opid.toLowerCase(), off)
      }
    }
    const seenIds = new Set()
    const mergedList = []
    const newRevokedMap = {}

    // 处理主要列表
    for (const item of rawList) {
      const pid = normalizePluginId(item.pluginId || item.id)
      if (!pid || seenIds.has(pid.toLowerCase())) continue
      seenIds.add(pid.toLowerCase())

      const builtinMatch = officialMap.get(pid.toLowerCase())

      const isOfficial = isOfficialPluginItem(item, builtinMatch)
      const officialBadge =
        item.official_badge ||
        item.officialBadge ||
        builtinMatch?.official_badge ||
        builtinMatch?.officialBadge ||
        (isOfficial ? '官方自营' : null)
      const homepageUrl =
        item.homepage_url ||
        item.homepageUrl ||
        item.homepage ||
        builtinMatch?.homepage_url ||
        builtinMatch?.homepageUrl ||
        builtinMatch?.homepage ||
        ''

      let mergedCategory = item.category || builtinMatch?.category || '实用工具'
      if (builtinMatch?.category && item.category) {
        const catA = Array.isArray(item.category) ? item.category : [item.category]
        const catB = Array.isArray(builtinMatch.category)
          ? builtinMatch.category
          : [builtinMatch.category]
        const combined = Array.from(new Set([...catA, ...catB].filter(Boolean)))
        mergedCategory = combined.length === 1 ? combined[0] : combined
      }

      const sourceType = isOfficial
        ? 'official'
        : item.source_type || item.sourceType || 'community'

      const normalizedItem = {
        ...(builtinMatch || {}),
        ...item,
        id: pid,
        pluginId: pid,
        name: item.name || builtinMatch?.name || pid,
        title: item.title || item.name || builtinMatch?.title || pid,
        version: item.version || builtinMatch?.version || '1.0.0',
        description: item.description || builtinMatch?.description || '',
        category: mergedCategory,
        isBuiltin: Boolean(item.isBuiltin || builtinMatch?.isBuiltin),
        downloads: Number(item.downloads || item.downloadsCount || 0),
        rating: Number(item.rating || 5.0),
        is_official: isOfficial,
        isOfficial: isOfficial,
        official_badge: officialBadge,
        officialBadge: officialBadge,
        source_type: sourceType,
        sourceType: sourceType,
        homepage_url: homepageUrl,
        homepageUrl: homepageUrl
      }

      // 与内置插件同 ID 时，实际打开的是内置插件（openPlugin 优先走内置）。
      // 名称、描述和平台限制以内置为准，避免显示另一个插件的介绍，或被远程条目的平台声明误隐藏
      if (builtinMatch) {
        normalizedItem.name = builtinMatch.name || normalizedItem.name
        normalizedItem.title = builtinMatch.title || builtinMatch.name || normalizedItem.title
        normalizedItem.description = builtinMatch.description || normalizedItem.description
        if (builtinMatch.category) normalizedItem.category = builtinMatch.category
        if (Array.isArray(builtinMatch.platforms)) normalizedItem.platforms = builtinMatch.platforms
        else delete normalizedItem.platforms
      }

      // 提取下架标记
      if (item.revoked) {
        newRevokedMap[pid] = {
          revoked: true,
          reason: item.revoked_reason || item.revokedReason || '该插件已被官方下架禁用'
        }
      }

      if (this.isPlatformSupported(normalizedItem)) {
        mergedList.push(normalizedItem)
      }
    }

    // 补充未在列表中出现的内置官方标杆应用（自动赋予官方自营金标与官方技术支持属性）
    for (const official of officialList) {
      const pid = normalizePluginId(official.pluginId || official.id)
      if (pid && !seenIds.has(pid.toLowerCase())) {
        seenIds.add(pid.toLowerCase())
        if (this.isPlatformSupported(official)) {
          mergedList.push({
            ...official,
            id: pid,
            pluginId: pid,
            is_official: true,
            isOfficial: true,
            official_badge: official.official_badge || official.officialBadge || '官方自营',
            officialBadge: official.official_badge || official.officialBadge || '官方自营',
            source_type: 'official',
            sourceType: 'official',
            homepage_url: official.homepage_url || official.homepageUrl || official.homepage || '',
            homepageUrl: official.homepage_url || official.homepageUrl || official.homepage || ''
          })
        }
      }
    }

    // 更新内存状态
    this._catalog = mergedList
    this._revokedMap = newRevokedMap
    this._lastSyncTime = Date.now()

    // 若本次成功从远程拉取，异步持久化到本地存储
    if (source === 'remote' && mergedList.length > 0) {
      this.saveLocalSnapshot(mergedList).catch((err) => {
        console.warn('[StoreCatalogManager] 保存本地快照失败:', err)
      })
    }

    return {
      catalog: this._catalog,
      list: this._catalog,
      isFallback,
      source
    }
  }

  /**
   * 极速本地查询（SLA < 10ms）
   * @param {object} params
   * @param {string} [params.category]
   * @param {string} [params.sourceType] - 'all' | 'official' (官方自营) | 'community' (社区精选)
   * @param {string} [params.keyword]
   * @param {string|string[]} [params.ids]
   * @param {'downloads'|'created_at'|'rating'|'name'} [params.sort='downloads']
   * @param {'asc'|'desc'} [params.direction='desc']
   * @param {number} [params.page=1]
   * @param {number} [params.pageSize=20]
   * @returns {Promise<{ list: Array, total: number, page: number, pageSize: number, lastPage: number }>}
   */
  async query(params = {}) {
    const { catalog } = await this.ensureCatalog()

    const targetCategory = String(params.category || '').trim()
    const keyword = String(params.keyword || params.search || '').trim()
    const sortField = params.sort || 'downloads'
    const direction = params.direction === 'asc' ? 1 : -1
    const rawPage = Number(params.page)
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1
    const rawPageSize = Number(params.pageSize || params.per_page)
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.floor(rawPageSize) : 20

    // 分类筛选适配：all、official（官方自营）、community（社区精选）
    const rawFilter = String(
      params.sourceType || params.filterType || params.sourceFilter || params.filter || ''
    ).trim().toLowerCase()
    const filterType = (targetCategory === 'official' || targetCategory === '官方自营' || rawFilter === 'official')
      ? 'official'
      : (targetCategory === 'community' || targetCategory === '社区精选' || rawFilter === 'community')
        ? 'community'
        : 'all'

    let targetIds = null
    if (params.ids) {
      const arr = Array.isArray(params.ids) ? params.ids : String(params.ids).split(',')
      targetIds = new Set(arr.map((id) => normalizePluginId(id).toLowerCase()).filter(Boolean))
    }

    // 1. 本地极速过滤
    let filtered = catalog.filter((item) => {
      // ID 限制（如收藏夹/指定插件批量查询）
      if (targetIds && !targetIds.has(String(item.pluginId).toLowerCase())) {
        return false
      }

      // 来源类型过滤 (all / official / community)
      const itemIsOfficial = isOfficialPluginItem(item)
      if (filterType === 'official' && !itemIsOfficial) {
        return false
      }
      if (filterType === 'community' && itemIsOfficial) {
        return false
      }

      // 常规分类过滤（当 category 不是特殊的 official / community / all / 全部 时生效）
      if (
        targetCategory &&
        !['全部', 'all', 'official', '官方自营', 'community', '社区精选'].includes(targetCategory)
      ) {
        const itemCat = Array.isArray(item.category)
          ? item.category
          : [String(item.category || '')]
        if (!itemCat.some((c) => String(c).trim() === targetCategory)) {
          return false
        }
      }

      // 关键词搜索
      if (keyword && !matchPlugin(item, keyword)) {
        return false
      }

      return true
    })

    // 2. 本地排序：官方自营插件置顶
    filtered.sort((a, b) => {
      const aOfficial = isOfficialPluginItem(a) ? 1 : 0
      const bOfficial = isOfficialPluginItem(b) ? 1 : 0
      if (aOfficial !== bOfficial) {
        return bOfficial - aOfficial // 官方自营置顶
      }

      let valA = a[sortField]
      let valB = b[sortField]

      if (typeof valA === 'string') {
        return direction * valA.localeCompare(String(valB || ''))
      }
      const numDiff = direction * ((Number(valA) || 0) - (Number(valB) || 0))
      if (numDiff !== 0) {
        return numDiff
      }
      const aBuiltin = Boolean(a.isBuiltin) ? 1 : 0
      const bBuiltin = Boolean(b.isBuiltin) ? 1 : 0
      if (aBuiltin !== bBuiltin) {
        return bBuiltin - aBuiltin
      }
      return 0
    })

    // 3. 本地分页
    const total = filtered.length
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    const offset = (page - 1) * pageSize
    const pageList = filtered.slice(offset, offset + pageSize)

    return {
      list: pageList,
      total,
      page,
      pageSize,
      lastPage
    }
  }

  /**
   * 获取所有被标记下架的插件状态映射
   * @returns {{ [pluginId: string]: { revoked: boolean, reason: string } }}
   */
  getRevocations() {
    return { ...this._revokedMap }
  }

  /**
   * 查询指定插件是否下架
   * @param {string} pluginId
   * @returns {{ revoked: boolean, reason: string }}
   */
  isRevoked(pluginId) {
    const pid = normalizePluginId(pluginId).toLowerCase()
    return this._revokedMap[pid] || { revoked: false, reason: '' }
  }

  /**
   * 手动标记插件下架（运行时熔断或测试注入）
   * @param {string} pluginId
   * @param {string} [reason]
   */
  markRevoked(pluginId, reason = '该插件已被官方下架禁用') {
    const pid = normalizePluginId(pluginId).toLowerCase()
    if (!pid) return
    this._revokedMap[pid] = { revoked: true, reason }
  }

  /**
   * 同步从内存缓存中按 ID 获取插件条目
   * @param {string} pluginId
   * @returns {object|null}
   */
  getById(pluginId) {
    const pid = normalizePluginId(pluginId).toLowerCase()
    if (!pid || !Array.isArray(this._catalog)) return null
    const found = this._catalog.find((p) => String(p.pluginId || p.id).toLowerCase() === pid)
    return found ? { ...found } : null
  }

  /**
   * 获取特定插件详情
   * @param {string} pluginId
   * @returns {Promise<object|null>}
   */
  async getDetails(pluginId) {
    const pid = normalizePluginId(pluginId).toLowerCase()
    if (!pid) return null
    const { catalog } = await this.ensureCatalog()
    const found = catalog.find((p) => String(p.pluginId).toLowerCase() === pid)
    return found ? { ...found } : null
  }
}
