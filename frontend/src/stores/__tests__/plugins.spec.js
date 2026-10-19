import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePluginsStore, sanitizeRecentUsedAt } from '../plugins'

// mock API
const apiMocks = vi.hoisted(() => ({
  getMarketPlugins: vi.fn(),
  getLocalPlugins: vi.fn(),
  getSyncData: vi.fn(),
  pushSyncData: vi.fn(),
  getPluginDetails: vi.fn()
}))

vi.mock('@/api/apiserver', () => ({
  getMarketPlugins: apiMocks.getMarketPlugins,
  getLocalPlugins: apiMocks.getLocalPlugins,
  getSyncData: apiMocks.getSyncData,
  pushSyncData: apiMocks.pushSyncData,
  getPluginDetails: apiMocks.getPluginDetails
}))

vi.mock('@/composables/useVersionCompat', () => ({
  fetchVersions: vi.fn().mockResolvedValue({ appVersion: '2.0.0', webVersion: '1.0.0' }),
  checkCompat: vi.fn().mockReturnValue({ compatible: true, reason: '' })
}))

function setupZtools({ isLoggedIn = false, configValues = {} } = {}) {
  global.window.ztools = {
    config: {
      get: vi.fn((key, def) => Promise.resolve(configValues[key] ?? def)),
      set: vi.fn().mockResolvedValue(true)
    },
    user: {
      isLoggedIn: vi.fn().mockResolvedValue(isLoggedIn),
      getToken: vi.fn().mockResolvedValue(null)
    },
    events: {
      emit: vi.fn()
    },
    analytics: {
      report: vi.fn()
    }
  }
}

describe('usePluginsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    for (const mock of Object.values(apiMocks)) mock.mockReset()
    apiMocks.getLocalPlugins.mockResolvedValue([])
    apiMocks.getSyncData.mockResolvedValue({ updated_at: null, favorites: [] })
    apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 12 })
    setupZtools()
    // 单测不访问外网：CDN 不可达时真实 fetch 会挂起直到超时，导致用例随网络状况时好时坏
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试环境断网')))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  // ── 下载状态管理 ──────────────────────────────────────────────
  describe('下载状态管理', () => {
    it('startDownload 添加到 downloadingSet 并清除失败状态', () => {
      const store = usePluginsStore()
      store.installFailedSet = new Set(['plugin-1'])
      store.startDownload('plugin-1')
      expect(store.downloadingSet.has('plugin-1')).toBe(true)
      expect(store.installFailedSet.has('plugin-1')).toBe(false)
    })

    it('endDownload 从 downloadingSet 移除', () => {
      const store = usePluginsStore()
      store.startDownload('plugin-1')
      store.endDownload('plugin-1')
      expect(store.downloadingSet.has('plugin-1')).toBe(false)
    })

    it('startDownload 90秒超时后自动标记失败', () => {
      const store = usePluginsStore()
      store.startDownload('plugin-timeout')
      expect(store.downloadingSet.has('plugin-timeout')).toBe(true)

      vi.advanceTimersByTime(90 * 1000 + 100)

      expect(store.downloadingSet.has('plugin-timeout')).toBe(false)
      expect(store.installFailedSet.has('plugin-timeout')).toBe(true)
    })

    it('endDownload 在超时前调用时不触发超时逻辑', () => {
      const store = usePluginsStore()
      store.startDownload('plugin-ok')
      store.endDownload('plugin-ok')

      vi.advanceTimersByTime(90 * 1000 + 100)

      expect(store.installFailedSet.has('plugin-ok')).toBe(false)
    })

    it('isInstallFailed 正确返回失败状态', () => {
      const store = usePluginsStore()
      expect(store.isInstallFailed('plugin-1')).toBe(false)
      store.installFailedSet = new Set(['plugin-1'])
      expect(store.isInstallFailed('plugin-1')).toBe(true)
    })
  })

  // ── onInstallComplete ─────────────────────────────────────────
  describe('onInstallComplete', () => {
    it('安装成功时更新 installedSet 并清除失败状态', () => {
      const store = usePluginsStore()
      store.installFailedSet = new Set(['plugin-1'])
      store.onInstallComplete({ pluginId: 'plugin-1', success: true })
      expect(store.installedSet.has('plugin-1')).toBe(true)
      expect(store.installFailedSet.has('plugin-1')).toBe(false)
    })

    it('新安装完成时不由前端重复上报 plugin_install', () => {
      const store = usePluginsStore()
      store.onInstallComplete({ pluginId: 'plugin-1', success: true, isUpdate: false })
      expect(window.ztools.analytics.report).not.toHaveBeenCalledWith('plugin_install', 'plugin-1')
    })

    it('更新完成时不由前端重复上报业务事件', () => {
      const store = usePluginsStore()
      store.onInstallComplete({ pluginId: 'plugin-1', success: true, isUpdate: true })
      expect(window.ztools.analytics.report).not.toHaveBeenCalledWith('plugin_updatecomplete', 'plugin-1')
      expect(window.ztools.analytics.report).not.toHaveBeenCalledWith('plugin_install', 'plugin-1')
    })

    it('安装成功时清除 updateMap 中的对应条目', () => {
      const store = usePluginsStore()
      store.updateMap = { 'plugin-1': { hasUpdate: true, version: '2.0.0' } }
      store.onInstallComplete({ pluginId: 'plugin-1', success: true })
      expect(store.updateMap['plugin-1']).toBeUndefined()
    })

    it('安装失败时标记 installFailedSet', () => {
      const store = usePluginsStore()
      store.startDownload('plugin-1')
      store.onInstallComplete({ pluginId: 'plugin-1', success: false, error: '下载失败' })
      expect(store.downloadingSet.has('plugin-1')).toBe(false)
      expect(store.installFailedSet.has('plugin-1')).toBe(true)
    })

    it('payload 无效时不崩溃', () => {
      const store = usePluginsStore()
      expect(() => store.onInstallComplete(null)).not.toThrow()
      expect(() => store.onInstallComplete({})).not.toThrow()
    })
  })

  // ── onUninstallComplete ───────────────────────────────────────
  describe('onUninstallComplete', () => {
    it('卸载后从 installedSet 移除', () => {
      const store = usePluginsStore()
      store.installedSet = new Set(['plugin-1', 'plugin-2'])
      store.onUninstallComplete({ pluginId: 'plugin-1' })
      expect(store.installedSet.has('plugin-1')).toBe(false)
      expect(store.installedSet.has('plugin-2')).toBe(true)
    })

    it('卸载后清除 updateMap 条目', () => {
      const store = usePluginsStore()
      store.updateMap = { 'plugin-1': { hasUpdate: true } }
      store.onUninstallComplete({ pluginId: 'plugin-1' })
      expect(store.updateMap['plugin-1']).toBeUndefined()
    })
  })

  // ── shouldCheckUpdate ─────────────────────────────────────────
  describe('shouldCheckUpdate', () => {
    it('从未检查时返回 true', () => {
      const store = usePluginsStore()
      expect(store.shouldCheckUpdate()).toBe(true)
    })

    it('刚检查过时返回 false', () => {
      const store = usePluginsStore()
      store.lastUpdateCheckTime = Date.now()
      expect(store.shouldCheckUpdate()).toBe(false)
    })

    it('超过间隔后返回 true', () => {
      const store = usePluginsStore()
      store.lastUpdateCheckTime = Date.now() - 6 * 60 * 1000
      expect(store.shouldCheckUpdate()).toBe(true)
    })
  })

  // ── markRecent ────────────────────────────────────────────────
  describe('markRecent', () => {
    it('添加到最近使用列表头部', async () => {
      const store = usePluginsStore()
      store.recents = ['plugin-2', 'plugin-3']
      await store.markRecent('plugin-1')
      expect(store.recents[0]).toBe('plugin-1')
    })

    it('已存在时移到头部不重复', async () => {
      const store = usePluginsStore()
      store.recents = ['plugin-1', 'plugin-2']
      await store.markRecent('plugin-2')
      expect(store.recents).toEqual(['plugin-2', 'plugin-1'])
    })

    it('超过 20 条时截断', async () => {
      const store = usePluginsStore()
      store.recents = Array.from({ length: 20 }, (_, i) => `plugin-${i}`)
      await store.markRecent('plugin-new')
      expect(store.recents.length).toBe(20)
      expect(store.recents[0]).toBe('plugin-new')
    })

    it('空 pluginId 时不操作', async () => {
      const store = usePluginsStore()
      store.recents = ['plugin-1']
      await store.markRecent('')
      expect(store.recents).toEqual(['plugin-1'])
    })
  })

  // ── getters ───────────────────────────────────────────────────
  describe('getters', () => {
    it('isFavorite 正确判断收藏状态', () => {
      const store = usePluginsStore()
      store.favorites = new Set(['plugin-1'])
      expect(store.isFavorite('plugin-1')).toBe(true)
      expect(store.isFavorite('plugin-2')).toBe(false)
    })

    it('totalPages 正确计算', () => {
      const store = usePluginsStore()
      store.total = 25
      store.pageSize = 12
      expect(store.totalPages).toBe(3)
    })

    it('hasPlugins 有数据时为 true', () => {
      const store = usePluginsStore()
      expect(store.hasPlugins).toBe(false)
      store.items = [{ pluginId: 'p1' }]
      expect(store.hasPlugins).toBe(true)
    })

    it('recentItems 按 recents 顺序返回 items 中的插件', () => {
      const store = usePluginsStore()
      store.items = [
        { pluginId: 'p1', name: 'P1' },
        { pluginId: 'p2', name: 'P2' }
      ]
      store.recents = ['p2', 'p1']
      expect(store.recentItems[0].pluginId).toBe('p2')
      expect(store.recentItems[1].pluginId).toBe('p1')
    })
  })

  // ── listCache ─────────────────────────────────────────────────
  describe('列表缓存', () => {
    // 目录管理器会先尝试 V2 接口与 CDN 静态索引；测试里断开真实网络，
    // 保证确定性地回退到 getMarketPlugins，避免结果随网络环境漂移
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试环境断网')))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('loadWithCache 命中缓存时不重复请求', async () => {
      const store = usePluginsStore()
      const params = { category: 'tools', page: 1, per_page: 12 }
      apiMocks.getMarketPlugins.mockResolvedValue({ list: [{ pluginId: 'p1' }], total: 1 })

      await store.loadWithCache(params)
      await store.loadWithCache(params)

      expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(1)
    })

    it('forceRefresh=true 时跳过缓存', async () => {
      const store = usePluginsStore()
      const params = { category: 'tools', page: 1, per_page: 12 }
      apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })

      await store.loadWithCache(params)
      await store.loadWithCache(params, true)

      expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(2)
    })

    it('clearListCache 清空缓存', async () => {
      const store = usePluginsStore()
      const params = { page: 1 }
      apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })

      await store.loadWithCache(params)
      store.clearListCache()
      await store.loadWithCache(params)

      expect(apiMocks.getMarketPlugins).toHaveBeenCalledTimes(2)
    })
  })

  // ── toggleFavorite ────────────────────────────────────────────
  describe('toggleFavorite', () => {
    it('未登录时允许本地收藏且不抛出错误，跳过云端同步', async () => {
      setupZtools({ isLoggedIn: false })
      const store = usePluginsStore()
      apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })

      await store.toggleFavorite('plugin-1')
      expect(store.favorites.has('plugin-1')).toBe(true)
      expect(global.window.ztools.config.set).toHaveBeenCalledWith(
        'favorite_plugins',
        JSON.stringify(['plugin-1']),
        false,
        'user_settings.json'
      )
      expect(apiMocks.pushSyncData).not.toHaveBeenCalled()
    })

    it('pluginId 为空时抛出错误', async () => {
      const store = usePluginsStore()
      await expect(store.toggleFavorite('')).rejects.toThrow()
    })

    it('登录后可以添加收藏', async () => {
      setupZtools({ isLoggedIn: true })
      apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })
      const store = usePluginsStore()

      await store.toggleFavorite('plugin-1')
      expect(store.favorites.has('plugin-1')).toBe(true)
    })

    it('再次调用取消收藏', async () => {
      setupZtools({ isLoggedIn: true })
      apiMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })
      const store = usePluginsStore()
      store.favorites = new Set(['plugin-1'])

      await store.toggleFavorite('plugin-1')
      expect(store.favorites.has('plugin-1')).toBe(false)
    })

    it('保存失败时回滚状态', async () => {
      setupZtools({ isLoggedIn: true })
      global.window.ztools.config.set = vi.fn().mockRejectedValue(new Error('保存失败'))
      const store = usePluginsStore()

      await expect(store.toggleFavorite('plugin-1')).rejects.toThrow('保存失败')
      expect(store.favorites.has('plugin-1')).toBe(false)
    })
  })

  // ── fetchInstalledPlugins ─────────────────────────────────────
  describe('fetchInstalledPlugins', () => {
    it('正确更新 installedSet 和 installedPlugins', async () => {
      const store = usePluginsStore()
      apiMocks.getLocalPlugins.mockResolvedValue([
        { pluginId: 'p1', lastUsedTime: 200 },
        { pluginId: 'p2', lastUsedTime: 100 }
      ])

      await store.fetchInstalledPlugins()

      expect(store.installedSet.has('p1')).toBe(true)
      expect(store.installedSet.has('p2')).toBe(true)
      // 按 lastUsedTime 降序排列
      expect(store.installedPlugins[0].pluginId).toBe('p1')
    })

    it('API 失败时优雅降级返回官方内置插件不崩溃', async () => {
      const store = usePluginsStore()
      apiMocks.getLocalPlugins.mockRejectedValue(new Error('网络错误'))

      const result = await store.fetchInstalledPlugins()
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThanOrEqual(10)
    })

    it('合并已有 installedSet 避免时序问题', async () => {
      const store = usePluginsStore()
      store.installedSet = new Set(['p-existing'])
      apiMocks.getLocalPlugins.mockResolvedValue([{ pluginId: 'p-new' }])

      await store.fetchInstalledPlugins()

      expect(store.installedSet.has('p-existing')).toBe(true)
      expect(store.installedSet.has('p-new')).toBe(true)
    })

    it('[回归] 本地旧版同名或别名插件（如 clipboard-manager / everything-search）自动合并为 2.0 声明式定义并去重', async () => {
      const store = usePluginsStore()
      apiMocks.getLocalPlugins.mockResolvedValue([
        {
          pluginId: 'clipboard-manager',
          name: '旧版剪贴板',
          entry: 'index.html',
          platforms: ['windows'],
          lastUsedTime: 500
        },
        {
          pluginId: 'everything-search',
          name: '旧版文件搜索',
          entry: 'index.html',
          platforms: ['windows'],
          lastUsedTime: 400
        },
        // 异常边界：同时存在别名与标准名时只保留一条
        {
          pluginId: 'clipboard-history',
          name: '重复剪贴板',
          lastUsedTime: 300
        }
      ])

      const combined = await store.fetchInstalledPlugins()
      const clipMatches = combined.filter(
        (p) => p.pluginId === 'clipboard-manager' || p.pluginId === 'clipboard-history'
      )
      expect(clipMatches).toHaveLength(1)
      expect(clipMatches[0].isDeclarative).toBe(true)
      expect(typeof clipMatches[0].command).toBe('function')
      expect(clipMatches[0].platforms).toBeUndefined()

      const searchMatches = combined.filter(
        (p) => p.pluginId === 'everything-search' || p.pluginId === 'everything-file-search'
      )
      expect(searchMatches).toHaveLength(1)
      expect(searchMatches[0].isDeclarative).toBe(true)
      expect(typeof searchMatches[0].command).toBe('function')
    })
  })

  // ── 图标刷新 ────────────────────────────────────────────────────
  describe('_applyIconPatch', () => {
    afterEach(() => {
      delete window.ztools
    })

    it('[回归] 内置官方插件没有本地图标文件，不向主进程请求刷新（避免 PLUGIN_NOT_FOUND 刷屏）', () => {
      const refreshIcon = vi.fn().mockResolvedValue({ success: true })
      window.ztools = { plugin: { refreshIcon } }
      const store = usePluginsStore()
      store.installedPlugins = [
        { pluginId: 'json-format', builtin: true, icon: '' },
        { pluginId: 'local-plugin', icon: '', localIconUrl: 'https://cdn.example.com/old.png' },
        { pluginId: 'up-to-date', icon: '', localIconUrl: 'https://cdn.example.com/same.png' }
      ]
      store._applyIconPatch({
        'json-format': 'https://cdn.example.com/json.png',
        'local-plugin': 'https://cdn.example.com/new.png',
        'up-to-date': 'https://cdn.example.com/same.png'
      })
      expect(refreshIcon).toHaveBeenCalledTimes(1)
      expect(refreshIcon).toHaveBeenCalledWith('local-plugin', 'https://cdn.example.com/new.png')
      // 界面仍然使用市场的远程图标
      expect(store.installedPlugins[0].icon).toBe('https://cdn.example.com/json.png')
    })

    it('[破坏性] 主进程刷新失败不会抛到调用方', async () => {
      const refreshIcon = vi.fn().mockRejectedValue(new Error('PLUGIN_NOT_FOUND'))
      window.ztools = { plugin: { refreshIcon } }
      const store = usePluginsStore()
      store.installedPlugins = [{ pluginId: 'local-plugin', icon: '', localIconUrl: '' }]
      expect(() => store._applyIconPatch({ 'local-plugin': 'https://cdn.example.com/a.png' })).not.toThrow()
      await Promise.resolve()
      expect(refreshIcon).toHaveBeenCalledTimes(1)
    })
  })

  // ── 最近使用时间 ───────────────────────────────────────────────
  describe('最近使用时间', () => {
    afterEach(() => {
      delete window.ztools
    })

    it('sanitizeRecentUsedAt 只保留 recents 中的合理时间戳', () => {
      const now = 1_800_000_000_000
      const raw = JSON.stringify({ a: now - 1000, b: 'x', c: now + 3_600_000, d: -5, gone: now - 10 })
      expect(sanitizeRecentUsedAt(raw, ['a', 'b', 'c', 'd'], now)).toEqual({ a: now - 1000 })
    })

    it('[破坏性] 损坏的配置、数组与原型链键名一律安全回退', () => {
      expect(sanitizeRecentUsedAt('{not json', ['a'])).toEqual({})
      expect(sanitizeRecentUsedAt('[1,2]', ['0'])).toEqual({})
      expect(sanitizeRecentUsedAt(null, ['a'])).toEqual({})
      expect(sanitizeRecentUsedAt('{}', ['__proto__', 'constructor', 'toString'])).toEqual({})
      expect(sanitizeRecentUsedAt({ a: 1 }, 'not-array')).toEqual({})
    })

    it('markRecent 记录时间并与 recents 一起持久化，超出列表的旧时间被清理', async () => {
      const set = vi.fn().mockResolvedValue(true)
      window.ztools = { config: { set } }
      const store = usePluginsStore()
      store.recents = ['old']
      store.recentUsedAt = { old: 1, stale: 2 }
      await store.markRecent('json-format')
      expect(store.recents).toEqual(['json-format', 'old'])
      expect(Object.keys(store.recentUsedAt).sort()).toEqual(['json-format', 'old'])
      expect(store.recentUsedAt['json-format']).toBeGreaterThan(1)
      const saved = set.mock.calls.find(([key]) => key === 'plugins.recents_at')
      expect(JSON.parse(saved[1])).toEqual(store.recentUsedAt)
    })
  })
})

