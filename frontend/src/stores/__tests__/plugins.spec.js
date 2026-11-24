import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { HIDDEN_BUNDLED_CONFIG_KEY, usePluginsStore, sanitizeRecentUsedAt } from '../plugins'
import { BUNDLED_PLUGIN_IDS } from '@/utils/bundledPlugins'
import { getLocalizedPluginDescription, getLocalizedPluginName } from '@/utils/pluginI18n'
import PluginAPI from '../../../public/js/cef-ipc/src/api/plugin.js'

// mock API
const apiMocks = vi.hoisted(() => ({
  getMarketPlugins: vi.fn(),
  getLocalPlugins: vi.fn(),
  getPluginDetails: vi.fn(),
  installPluginNative: vi.fn(),
  getDownloadSign: vi.fn()
}))

vi.mock('@/api/apiserver', () => ({
  getMarketPlugins: apiMocks.getMarketPlugins,
  getLocalPlugins: apiMocks.getLocalPlugins,
  getPluginDetails: apiMocks.getPluginDetails,
  installPluginNative: apiMocks.installPluginNative,
  getDownloadSign: apiMocks.getDownloadSign
}))

const catalogMocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/api/pluginCatalog', async (importOriginal) => ({
  ...(await importOriginal()), loadV2StaticCatalogList: catalogMocks.load
}))

const compatMocks = vi.hoisted(() => ({
  fetchVersions: vi.fn(),
  checkCompat: vi.fn()
}))

vi.mock('@/composables/useVersionCompat', () => compatMocks)

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
    catalogMocks.load.mockReset().mockResolvedValue([])
    compatMocks.fetchVersions.mockReset().mockResolvedValue({ appVersion: '2.0.0', webVersion: '1.0.0' })
    compatMocks.checkCompat.mockReset().mockReturnValue({ compatible: true, reason: '' })
    apiMocks.getLocalPlugins.mockResolvedValue([])
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
  describe('fetchFavoritePlugins：收藏详情加载标记', () => {
    it('成功、失败回填、没有收藏三种结束方式都标记为已加载；失败时只回填本地已安装的收藏', async () => {
      const store = usePluginsStore()
      expect(store.favoritePluginsLoaded).toBe(false)

      store.favorites = new Set(['fav-a', 'fav-b'])
      store.loadWithCache = vi.fn().mockResolvedValue({ list: [{ pluginId: 'fav-a' }, { pluginId: 'fav-b' }] })
      await store.fetchFavoritePlugins()
      expect(store.favoritePluginsLoaded).toBe(true)
      expect(store.favoritePluginsList.map((p) => p.pluginId)).toEqual(['fav-a', 'fav-b'])

      store.favoritePluginsLoaded = false
      store.installedPlugins = [{ pluginId: 'fav-b', name: '本地收藏' }, { pluginId: 'other' }]
      store.loadWithCache = vi.fn().mockRejectedValue(new Error('目录不可用'))
      await store.fetchFavoritePlugins()
      expect(store.favoritePluginsLoaded).toBe(true)
      expect(store.favoritePluginsList.map((p) => p.pluginId)).toEqual(['fav-b'])

      store.favoritePluginsLoaded = false
      store.favorites = new Set()
      await store.fetchFavoritePlugins()
      expect(store.favoritePluginsLoaded).toBe(true)
      expect(store.favoritePluginsList).toEqual([])
    })
  })

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
    // 注入目录读取边界，验证列表缓存本身；真实 CDN 链路见 pluginDistribution.spec.js
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
      catalogMocks.load.mockResolvedValue([{ pluginId: 'p1' }])

      await store.loadWithCache(params)
      await store.loadWithCache(params)

      expect(catalogMocks.load).toHaveBeenCalledTimes(1)
    })

    it('forceRefresh=true 时跳过缓存', async () => {
      const store = usePluginsStore()
      const params = { category: 'tools', page: 1, per_page: 12 }
      catalogMocks.load.mockResolvedValue([])

      await store.loadWithCache(params)
      await store.loadWithCache(params, true)

      expect(catalogMocks.load).toHaveBeenCalledTimes(2)
    })

    it('clearListCache 清空缓存', async () => {
      const store = usePluginsStore()
      const params = { page: 1 }
      catalogMocks.load.mockResolvedValue([])

      await store.loadWithCache(params)
      store.clearListCache()
      await store.loadWithCache(params)

      expect(catalogMocks.load).toHaveBeenCalledTimes(2)
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
      // 同步状态由各版本扩展自行维护，公共插件 store 里没有
      expect('syncStatus' in store.$state).toBe(false)
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
    it('隐藏配置暂不可读时仍加载普通插件并保留收藏，恢复后按已存选择重建完整列表', async () => {
      const store = usePluginsStore()
      let canReadVisibility = false
      window.ztools.config.get.mockImplementation((key, fallback) => {
        if (key === 'favorite_plugins') return ['local-tool']
        if (key !== HIDDEN_BUNDLED_CONFIG_KEY) return fallback
        if (!canReadVisibility) throw new Error('读取失败')
        return ['memo']
      })
      apiMocks.getLocalPlugins.mockResolvedValue([{ pluginId: 'local-tool' }, { pluginId: 'memo' }])

      await store.init()
      expect(store.installedPlugins.map(plugin => plugin.pluginId)).toEqual(['local-tool'])
      expect(store.installedSet.has('local-tool')).toBe(true)
      expect(store.favorites.has('local-tool')).toBe(true)
      await expect(store.getCatalogInstalledPluginIds()).resolves.toBeNull()

      canReadVisibility = true
      await store.fetchInstalledPlugins()
      expect(store.installedListLoaded).toBe(true)
      expect(store.installedSet.has('memo')).toBe(false)
      expect(store.installedSet.has('calculator')).toBe(true)
      expect(store.installedSet.has('local-tool')).toBe(true)
      expect(window.ztools.config.set).not.toHaveBeenCalled()
    })

    it('配置服务整体不可用时仍从宿主加载普通插件', async () => {
      const store = usePluginsStore()
      window.ztools.config.get.mockRejectedValue(new Error('配置服务不可用'))
      apiMocks.getLocalPlugins.mockResolvedValue([{ pluginId: 'local-tool' }])
      await store.init()
      expect(store.installedPlugins.map(plugin => plugin.pluginId)).toEqual(['local-tool'])
      expect(store.installedListLoaded).toBe(false)
    })

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

    it('API 失败时优雅降级返回内置插件不崩溃', async () => {
      const store = usePluginsStore()
      apiMocks.getLocalPlugins.mockRejectedValue(new Error('网络错误'))

      const result = await store.fetchInstalledPlugins()
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      expect(result.length).toBe(BUNDLED_PLUGIN_IDS.length)
    })

    it('最新宿主快照移除陈旧市场安装记录，同时保留未隐藏的内置插件', async () => {
      const store = usePluginsStore()
      store.installedSet = new Set(['p-existing'])
      apiMocks.getLocalPlugins.mockResolvedValue([{ pluginId: 'p-new' }])

      await store.fetchInstalledPlugins()

      expect(store.installedSet.has('p-existing')).toBe(false)
      expect(store.installedSet.has('p-new')).toBe(true)
      expect(store.installedSet.has('memo')).toBe(true)
    })

    it('并行首读等待同一份隐藏配置，不会先展示已隐藏的内置插件', async () => {
      const store = usePluginsStore()
      let finishConfig
      window.ztools.config.get.mockReturnValueOnce(new Promise(resolve => { finishConfig = resolve }))
      const first = store.fetchInstalledPlugins()
      const second = store.fetchInstalledPlugins()
      expect(window.ztools.config.get).toHaveBeenCalledOnce()
      expect(apiMocks.getLocalPlugins).not.toHaveBeenCalled()
      finishConfig('["memo"]')
      await Promise.all([first, second])
      expect(apiMocks.getLocalPlugins).toHaveBeenCalledOnce()
      expect(store.installedSet.has('memo')).toBe(false)
      expect(store.installedPlugins.some(item => item.pluginId === 'memo')).toBe(false)
    })

    it('跨窗通知重新读取配置，早发的磁盘快照晚返回也不能覆盖新选择', async () => {
      const store = usePluginsStore()
      let resolveOldRead
      window.ztools.config.get.mockImplementationOnce(() => new Promise(resolve => { resolveOldRead = resolve }))
      window.ztools.config.get.mockResolvedValueOnce(['qr-code'])
      const older = store.fetchInstalledPlugins()
      await store.fetchInstalledPlugins(true)
      resolveOldRead([])
      await older
      expect(store.isBundledHidden('qr-code')).toBe(true)
      expect(store.installedSet.has('qr-code')).toBe(false)
      expect(store.installedPlugins.some(plugin => plugin.pluginId === 'qr-code')).toBe(false)
    })

    it.each(['success', 'failure'])('后发列表先返回时，早发请求的%s不能覆盖最新快照', async outcome => {
      const store = usePluginsStore()
      store._hiddenBundledLoaded = true
      let finish
      let notifyStarted
      const started = new Promise(resolve => { notifyStarted = resolve })
      apiMocks.getLocalPlugins.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = () => outcome === 'success' ? resolve([{ pluginId: 'stale-market' }]) : reject(new Error('旧请求失败'))
        notifyStarted()
      }))
      const old = store.fetchInstalledPlugins()
      await started
      apiMocks.getLocalPlugins.mockResolvedValueOnce([{ pluginId: 'new-market' }])
      await store.fetchInstalledPlugins()
      finish()
      await old
      expect(store.installedSet.has('new-market')).toBe(true)
      expect(store.installedSet.has('stale-market')).toBe(false)
      expect(store.installedListLoaded).toBe(true)
    })

    it.each([
      ['install', 'success'], ['install', 'failure'], ['uninstall', 'success'], ['uninstall', 'failure']
    ])('快照等待期间%s，迟到的%s快照触发重新读取而不覆盖新状态', async (operation, outcome) => {
      const store = usePluginsStore()
      store._hiddenBundledLoaded = true
      store.installedPlugins = [{ pluginId: 'market-probe' }]
      store.installedSet.add('market-probe')
      let finish
      let notifyStarted
      const started = new Promise(resolve => { notifyStarted = resolve })
      apiMocks.getLocalPlugins.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = () => outcome === 'success'
          ? resolve(operation === 'uninstall' ? [{ pluginId: 'market-probe' }] : [])
          : reject(new Error('过时扫描失败'))
        notifyStarted()
      }))
      apiMocks.getLocalPlugins.mockResolvedValue(operation === 'install' ? [{ pluginId: 'market-probe' }] : [])
      const old = store.fetchInstalledPlugins()
      await started
      if (operation === 'install') store.onInstallComplete({ pluginId: 'market-probe', success: true }, true)
      else store.onUninstallComplete({ pluginId: 'market-probe' })
      expect(store.installedSet.has('market-probe')).toBe(operation === 'install')
      finish()
      await old
      expect(apiMocks.getLocalPlugins).toHaveBeenCalledTimes(2)
      expect(store.installedSet.has('market-probe')).toBe(operation === 'install')
      expect(store.installedPlugins.some(item => item.pluginId === 'market-probe')).toBe(operation === 'install')
    })

    it.each(['hide', 'restore'])('快照等待期间%s内置插件，旧请求不能改变其可见性', async operation => {
      const store = usePluginsStore()
      store._hiddenBundledLoaded = true
      if (operation === 'restore') store.hiddenBundledSet.add('memo')
      let finish
      apiMocks.getLocalPlugins.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      apiMocks.getLocalPlugins.mockResolvedValue([])
      const old = store.fetchInstalledPlugins()
      await Promise.resolve()
      if (operation === 'hide') await store.hideBundledPlugin('memo')
      else await store.restoreBundledPlugin('memo')
      finish([{ pluginId: 'memo', version: '0.1.0' }])
      await old
      expect(store.installedSet.has('memo')).toBe(operation === 'restore')
      expect(store.installedPlugins.some(item => item.pluginId === 'memo')).toBe(operation === 'restore')
      expect(apiMocks.getLocalPlugins).toHaveBeenCalledTimes(2)
    })

    it('禁用或下架停止运行时后，旧扫描不能恢复其启用状态', async () => {
      const store = usePluginsStore()
      store._hiddenBundledLoaded = true
      let finish
      let notifyStarted
      const started = new Promise(resolve => { notifyStarted = resolve })
      apiMocks.getLocalPlugins.mockImplementationOnce(() => new Promise(resolve => {
        finish = resolve
        notifyStarted()
      }))
      apiMocks.getLocalPlugins.mockResolvedValue([{ pluginId: 'market-probe', enabled: false }])
      const pending = store.fetchInstalledPlugins()
      await started
      store.onPluginRuntimeStopped({ pluginId: 'market-probe' })
      finish([{ pluginId: 'market-probe', enabled: true }])
      await pending
      expect(store.installedPlugins.find(item => item.pluginId === 'market-probe').enabled).toBe(false)
      expect(apiMocks.getLocalPlugins).toHaveBeenCalledTimes(2)
    })

    it('[回归] 插件市场分发的真实插件（clipboard-manager / everything-file-search）不再并入旧示例实现，同名与别名记录不重复', async () => {
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
      // clipboard-manager 现在是插件市场分发的真实插件：按安装目录里的清单展示，不再并入同名旧示例实现
      const clipMatches = combined.filter((p) => p.pluginId === 'clipboard-manager')
      expect(clipMatches).toHaveLength(1)
      expect(clipMatches[0].command).toBeUndefined()
      // 只存在于旧示例实现里的 clipboard-history 不在展示列表里
      const visibleIds = store.installedPlugins.map((p) => p.pluginId)
      expect(visibleIds).not.toContain('clipboard-history')
      expect(visibleIds.filter((id) => id === 'clipboard-manager').length).toBeLessThanOrEqual(1)

      const searchMatches = combined.filter(
        (p) => p.pluginId === 'everything-search' || p.pluginId === 'everything-file-search'
      )
      // everything-file-search 也改为插件市场分发，旧别名记录不再并入旧示例实现，但仍只保留一条
      expect(searchMatches).toHaveLength(1)
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
        { pluginId: 'cleaner', builtin: true, icon: '' },
        { pluginId: 'local-plugin', icon: '', localIconUrl: 'https://cdn.example.com/old.png' },
        { pluginId: 'up-to-date', icon: '', localIconUrl: 'https://cdn.example.com/same.png' }
      ]
      store._applyIconPatch({
        cleaner: 'https://cdn.example.com/cleaner.png',
        'local-plugin': 'https://cdn.example.com/new.png',
        'up-to-date': 'https://cdn.example.com/same.png'
      })
      expect(refreshIcon).toHaveBeenCalledTimes(1)
      expect(refreshIcon).toHaveBeenCalledWith('local-plugin', 'https://cdn.example.com/new.png')
      // 界面仍然使用市场的远程图标
      expect(store.installedPlugins[0].icon).toBe('https://cdn.example.com/cleaner.png')
    })

    it('[回归] 随客户端内置的插件不被市场旧图标覆盖（返回首页时图标闪一下再变）', () => {
      const refreshIcon = vi.fn().mockResolvedValue({ success: true })
      window.ztools = { plugin: { refreshIcon } }
      const store = usePluginsStore()
      store.installedPlugins = [{ pluginId: 'timestamp', builtin: true, icon: 'bundled-plugins/timestamp/icon.svg' }]
      const list = store.installedPlugins
      store._applyIconPatch({ timestamp: 'https://cdn.example.com/old-timestamp.png' })
      expect(store.installedPlugins).toBe(list)
      expect(store.installedPlugins[0].icon).toBe('bundled-plugins/timestamp/icon.svg')
      expect(refreshIcon).not.toHaveBeenCalled()
    })

    it('[集成] 只有内置插件时不向市场查询图标', async () => {
      apiMocks.getMarketPlugins.mockClear()
      const store = usePluginsStore()
      store.installedPlugins = [{ pluginId: 'timestamp', builtin: true, icon: '' }, { pluginId: 'todo', builtin: true, icon: '' }]
      store._patchInstalledIcons()
      await Promise.resolve()
      expect(apiMocks.getMarketPlugins).not.toHaveBeenCalled()
    })

    it('[破坏性] 市场返回的列表里混入内置插件的图标也会被忽略', async () => {
      apiMocks.getMarketPlugins.mockClear()
      apiMocks.getMarketPlugins.mockResolvedValueOnce({
        list: [
          { pluginId: 'community-x', icon: 'https://cdn.example.com/x.png' },
          { pluginId: 'todo', icon: 'https://cdn.example.com/old-todo.png' }
        ]
      })
      const store = usePluginsStore()
      store.installedPlugins = [{ pluginId: 'todo', builtin: true, icon: '' }, { pluginId: 'community-x', icon: '' }]
      store._patchInstalledIcons()
      await vi.waitFor(() => expect(store.installedPlugins.find((p) => p.pluginId === 'community-x').icon).toBe('https://cdn.example.com/x.png'))
      expect(apiMocks.getMarketPlugins.mock.calls[0][0].ids).toEqual(['community-x'])
      expect(store.installedPlugins.find((p) => p.pluginId === 'todo').icon).toBe('')
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

    it('[回归] 本地旧版插件缺少 i18n 与分类时，通过市场查询兜底补齐并在英文模式生效', async () => {
      apiMocks.getMarketPlugins.mockResolvedValueOnce({
        list: [
          {
            pluginId: 'archive-manager',
            icon: 'https://cdn.example.com/archive.svg',
            categoryId: ['files', 'productivity'],
            i18n: {
              'en-US': {
                name: 'ZIP Archive Manager',
                description: 'Inspect and extract ZIP archives locally.'
              }
            }
          },
          {
            pluginId: 'md-to-office',
            icon: 'https://cdn.example.com/md.svg',
            categoryId: 'productivity',
            i18n: {
              'en-US': {
                name: 'Markdown to Word',
                description: 'Convert Markdown into formatted Word files.'
              }
            }
          }
        ]
      })
      const store = usePluginsStore()
      store.installedPlugins = [
        {
          pluginId: 'archive-manager',
          name: '解压与压缩',
          description: '本地查看与解压 ZIP',
          category: '文件管理',
          icon: ''
        },
        {
          pluginId: 'md-to-office',
          name: 'AI文档转Word',
          description: '将 Markdown 转为 Word',
          category: '',
          icon: ''
        }
      ]

      store._patchInstalledIcons()
      await vi.waitFor(() => {
        const md = store.installedPlugins.find((p) => p.pluginId === 'md-to-office')
        expect(md?.i18n?.['en-US']?.name).toBe('Markdown to Word')
      })

      const archive = store.installedPlugins.find((p) => p.pluginId === 'archive-manager')
      const md = store.installedPlugins.find((p) => p.pluginId === 'md-to-office')
      expect(getLocalizedPluginName(archive, 'en-US')).toBe('ZIP Archive Manager')
      expect(getLocalizedPluginDescription(archive, 'en-US')).toBe('Inspect and extract ZIP archives locally.')
      // 本地已有分类时不被市场覆盖
      expect(archive.category).toBe('文件管理')
      expect(archive.categoryId).toBeUndefined()

      // 本地旧版缺失分类时自动由市场目录补齐
      expect(getLocalizedPluginName(md, 'en-US')).toBe('Markdown to Word')
      expect(md.categoryId).toBe('productivity')
      expect(md.category).toBe('办公效率')
    })

    it('[回归] 本地已有 i18n 字段优先于市场数据，市场只补齐缺失字段；重复补齐幂等不重建数组引用', () => {
      const store = usePluginsStore()
      store.installedPlugins = [
        {
          pluginId: 'custom-tool',
          name: '本地插件',
          description: '本地中文简介',
          category: '开发工具',
          i18n: {
            'en-US': {
              name: 'Local Override Name'
            }
          }
        }
      ]
      const patchMap = {
        'custom-tool': {
          icon: 'https://cdn.example.com/custom.svg',
          categoryId: 'productivity',
          i18n: {
            'en-US': {
              name: 'Market Name Should Not Override',
              description: 'Market English Description'
            }
          }
        }
      }

      store._applyIconPatch(patchMap)
      const patched = store.installedPlugins[0]
      expect(getLocalizedPluginName(patched, 'en-US')).toBe('Local Override Name')
      expect(getLocalizedPluginDescription(patched, 'en-US')).toBe('Market English Description')
      expect(patched.category).toBe('开发工具')

      // 再次应用相同补丁必须幂等，不无故替换 installedPlugins 数组引用
      const snapshotRef = store.installedPlugins
      store._applyIconPatch(patchMap)
      expect(store.installedPlugins).toBe(snapshotRef)
    })

    it('[回归] 内置插件的 i18n 与分类同样不被市场旧数据覆盖', () => {
      const store = usePluginsStore()
      store.installedPlugins = [
        {
          pluginId: 'memo',
          builtin: true,
          name: '便签',
          categoryId: 'productivity',
          i18n: {
            'en-US': {
              name: 'Quick Notes'
            }
          }
        }
      ]
      const originalRef = store.installedPlugins
      store._applyIconPatch({
        memo: {
          icon: 'https://cdn.example.com/old-memo.svg',
          categoryId: 'system',
          i18n: {
            'en-US': {
              name: 'Stale Market Memo',
              description: 'Old description'
            }
          }
        }
      })
      expect(store.installedPlugins).toBe(originalRef)
      expect(getLocalizedPluginName(store.installedPlugins[0], 'en-US')).toBe('Quick Notes')
      expect(store.installedPlugins[0].categoryId).toBe('productivity')
    })

    it('[集成/时序] 已安装插件早于市场目录加载完成时，refreshCategoryCounts 拿到目录后自动补齐 i18n 且不发多余查询', async () => {
      apiMocks.getMarketPlugins.mockClear()
      catalogMocks.load.mockResolvedValueOnce([
        {
          id: 'office-slim',
          pluginId: 'office-slim',
          name: '办公文档瘦身',
          categoryId: 'productivity',
          icon: 'https://cdn.example.com/office-slim.svg',
          i18n: {
            'en-US': {
              name: 'Office Document Slimmer',
              description: 'Recompress Word, PowerPoint, and Excel locally.'
            }
          }
        }
      ])

      const store = usePluginsStore()
      store.installedPlugins = [
        {
          pluginId: 'office-slim',
          name: '办公文档瘦身',
          description: '本地重新压缩文档',
          category: ''
        }
      ]

      await store.refreshCategoryCounts()

      const patched = store.installedPlugins.find((p) => p.pluginId === 'office-slim')
      expect(getLocalizedPluginName(patched, 'en-US')).toBe('Office Document Slimmer')
      expect(patched.categoryId).toBe('productivity')
      expect(apiMocks.getMarketPlugins).not.toHaveBeenCalled()
    })

    it('[破坏性] 市场补丁含畸形 i18n、数组与原型污染键时安全忽略且不污染原型', () => {
      const store = usePluginsStore()
      store.installedPlugins = [
        {
          pluginId: 'safe-plugin',
          name: '安全插件',
          description: '原始描述'
        }
      ]
      const maliciousPayload = JSON.parse('{"__proto__":{"polluted":"yes"},"en-US":{"name":"Safe Plugin","__proto__":{"bad":1}}}')
      expect(() =>
        store._applyIconPatch({
          'safe-plugin': {
            icon: 'not-a-http-url',
            categoryId: ['', null],
            i18n: maliciousPayload
          }
        })
      ).not.toThrow()

      expect(({}).polluted).toBeUndefined()
      expect(({}).bad).toBeUndefined()
      expect(store.installedPlugins[0].icon).toBeUndefined()
      expect(getLocalizedPluginName(store.installedPlugins[0], 'en-US')).toBe('Safe Plugin')
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

  describe('下架状态贯穿完整目录与更新检查', () => {
    it.each(['市场分页', '批量更新'])('%s 未显示下架插件时仍禁用已安装项', async (source) => {
      const store = usePluginsStore()
      const gone = { pluginId: 'gone-tool', revoked: true, revokedReason: '已撤回', category: '办公效率' }
      store.installedSet = new Set(['gone-tool'])
      store.installedPlugins = [{ pluginId: 'gone-tool', enabled: true }]
      window.ztools.plugin = { revoke: vi.fn().mockResolvedValue(true) }
      if (source === '市场分页') {
        store._getCatalogManager = () => ({
          _catalog: [gone, { pluginId: 'visible', category: '系统工具' }],
          query: async () => ({ list: [{ pluginId: 'visible' }], total: 2 })
        })
        await store.loadWithCache({ page: 1, per_page: 1 })
        expect(store.categoryCounts).toEqual({ system: 1 })
      } else {
        await store.setUpdateInfo({ 'gone-tool': { ...gone, hasUpdate: false } })
      }
      expect(store.isRevoked('gone-tool')).toBe(true)
      expect(store.getRevokedReason('gone-tool')).toBe('已撤回')
      expect(store.installedPlugins[0].enabled).toBe(false)
      expect(window.ztools.plugin.revoke).toHaveBeenCalledWith('gone-tool', '已撤回')
      await expect(store.openPlugin('gone-tool')).rejects.toThrow('下架')
    })
  })

  describe('安装必须重新读取发布状态', () => {
    it('目录失败时不使用列表快照或调用方提供的地址，释放安装状态', async () => {
      const store = usePluginsStore()
      const cached = { pluginId: 'test-distribution', downloadUrl: 'https://cdn.ztools.cn/plugins/old.zip', sha256: 'a'.repeat(64) }
      store.items = [cached]
      apiMocks.getDownloadSign.mockRejectedValue(Object.assign(new Error('插件已下架'), { code: 'PLUGIN_REVOKED' }))
      await expect(store.installPlugin('test-distribution', { downloadInfo: cached })).rejects.toMatchObject({ code: 'PLUGIN_REVOKED' })
      expect(apiMocks.getDownloadSign).toHaveBeenCalledWith('test-distribution')
      expect(apiMocks.installPluginNative).not.toHaveBeenCalled()
      expect(store.installingSet.has('test-distribution')).toBe(false)
      expect(store.downloadingSet.has('test-distribution')).toBe(false)
      expect(store.isInstallFailed('test-distribution')).toBe(true)
    })
  })

  describe('installPlugin 版本门槛', () => {
    it('客户端版本低于 minAppVersion 时中止安装，不调用宿主安装', async () => {
      compatMocks.checkCompat.mockReturnValue({ compatible: false, reason: '该插件需要 App >= 1.1.8.3，当前 1.1.8.2，请先升级客户端' })
      const store = usePluginsStore()
      const downloadInfo = { downloadUrl: 'https://cdn.example.com/a.zip', sha256: 'a'.repeat(64), minAppVersion: '1.1.8.3' }
      apiMocks.getDownloadSign.mockResolvedValue(downloadInfo)
      await expect(store.installPlugin('disk-analyzer')).rejects.toThrow('1.1.8.3')
      expect(compatMocks.checkCompat).toHaveBeenCalledWith(downloadInfo, '2.0.0', '1.0.0')
      expect(apiMocks.installPluginNative).not.toHaveBeenCalled()
    })
  })

  describe('安装任务与下架真实 SDK 契约', () => {
    const pid = 'operation-fixture'
    function installBus(store) {
      const listeners = new Set()
      window.ztools.events = {
        subscribe: vi.fn().mockResolvedValue({ success: true }),
        on: (_type, handler) => listeners.add(handler),
        off: (_type, handler) => listeners.delete(handler)
      }
      // 真实全局事件转发与局部安装等待器同时存在。
      window.ztools.events.on('plugin_install_complete', event => store.onInstallComplete(event.payload))
      window.ztools.plugin = { getInstallStatus: vi.fn() }
      return {
        listeners,
        emit: (payload) => { for (const handler of [...listeners]) handler({ payload: { pluginId: pid, ...payload } }) }
      }
    }
    beforeEach(() => {
      apiMocks.getDownloadSign.mockResolvedValue({ downloadUrl: 'https://cdn.example.com/plugin.zip', version: '1.0.0' })
      apiMocks.installPluginNative.mockResolvedValue({ success: true, operationId: 'current-op' })
    })

    it.each([true, false])('重复下架固定禁用并持久化原因（原启用=%s）', async enabled => {
      const state = { enabled, revoked: false }
      const call = vi.fn(async (method, params) => {
        expect(method).toBe('plugin_revoke')
        Object.assign(state, { enabled: false, revoked: params.revoked, reason: params.reason })
        return { success: true }
      })
      window.ztools.plugin = new PluginAPI({ call })
      const store = usePluginsStore()
      store.installedSet.add(pid)
      store.installedPlugins = [{ pluginId: pid, enabled }]
      const catalog = [{ pluginId: pid, revoked: true, revokedReason: '已撤回' }]
      store._applyRevocations(catalog)
      store._applyRevocations(catalog)
      await Promise.resolve()
      expect(call).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenLastCalledWith('plugin_revoke', { pluginId: pid, revoked: true, reason: '已撤回' })
      expect(state).toEqual({ enabled: false, revoked: true, reason: '已撤回' })
      await expect(store.openPlugin(pid)).rejects.toThrow('下架')
    })

    it.each([true, false])('安装响应之前到达的完成事件正确结算（成功=%s）', async success => {
      const store = usePluginsStore()
      const { emit, listeners } = installBus(store)
      apiMocks.installPluginNative.mockImplementation(async () => {
        emit({ operationId: 'current-op', success, error: '校验失败' })
        return { success: true, operationId: 'current-op' }
      })
      const result = store.installPlugin(pid, { autoOpen: false })
      if (success) await expect(result).resolves.toMatchObject({ success: true })
      else await expect(result).rejects.toThrow('校验失败')
      expect(store.installedSet.has(pid)).toBe(success)
      expect(store.installFailedSet.has(pid)).toBe(!success)
      expect(store.installingSet.has(pid)).toBe(false)
      expect(listeners.size).toBe(1)
    })

    it('旧任务、其他插件和畸形通知不能结束正在安装的任务', async () => {
      const store = usePluginsStore()
      const { emit, listeners } = installBus(store)
      const result = store.installPlugin(pid, { autoOpen: false })
      await vi.advanceTimersByTimeAsync(0)
      emit({ operationId: 'old-op', success: true })
      emit({ operationId: 'current-op', success: true, pluginId: 'another-plugin' })
      emit({ operationId: 'current-op' })
      expect(store.installingSet.has(pid)).toBe(true)
      expect(store.installedSet.has(pid)).toBe(false)
      emit({ operationId: 'current-op', success: true })
      await expect(result).resolves.toMatchObject({ success: true })
      expect(listeners.size).toBe(1)
    })

    it('通知丢失时查询真实终态，运行超过90秒也不误报失败', async () => {
      const store = usePluginsStore()
      const { listeners } = installBus(store)
      const getStatus = window.ztools.plugin.getInstallStatus
      getStatus.mockResolvedValue({ pluginId: pid, operationId: 'current-op', status: 'running' })
      const result = store.installPlugin(pid, { autoOpen: false })
      await vi.advanceTimersByTimeAsync(90_001)
      expect(getStatus).toHaveBeenCalledTimes(3)
      expect(store.isInstallFailed(pid)).toBe(false)
      expect(store.installingSet.has(pid)).toBe(true)
      getStatus.mockResolvedValue({ pluginId: pid, operationId: 'current-op', status: 'completed', success: true })
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(result).resolves.toMatchObject({ success: true })
      expect(store.downloadingSet.has(pid)).toBe(false)
      expect(listeners.size).toBe(1)
    })

    it('宿主查询确认失败时展示失败原因', async () => {
      const store = usePluginsStore()
      const { listeners } = installBus(store)
      window.ztools.plugin.getInstallStatus.mockResolvedValue({
        pluginId: pid, operationId: 'current-op', status: 'completed', success: false, error: '磁盘空间不足'
      })
      const result = store.installPlugin(pid, { autoOpen: false }).catch(error => error)
      await vi.advanceTimersByTimeAsync(30_001)
      expect((await result).message).toBe('磁盘空间不足')
      expect(store.isInstallFailed(pid)).toBe(true)
      expect(listeners.size).toBe(1)
    })

    it('查询不可用时只提示结果待确认，迟到完成事件仍可同步', async () => {
      const store = usePluginsStore()
      const { listeners, emit } = installBus(store)
      window.ztools.plugin.getInstallStatus.mockRejectedValue(new Error('IPC 断开'))
      const result = store.installPlugin(pid, { autoOpen: false })
      await vi.advanceTimersByTimeAsync(30_001)
      await expect(result).resolves.toMatchObject({ success: false, pending: true })
      expect(store.isInstallFailed(pid)).toBe(false)
      expect(store.installedSet.has(pid)).toBe(false)
      expect(listeners.size).toBe(1)
      emit({ operationId: 'current-op', success: true })
      expect(store.installedSet.has(pid)).toBe(true)
    })

    it('订阅失败时不发起安装并释放监听', async () => {
      const store = usePluginsStore()
      const { listeners } = installBus(store)
      window.ztools.events.subscribe.mockRejectedValue(new Error('订阅失败'))
      await expect(store.installPlugin(pid)).rejects.toThrow('订阅失败')
      expect(apiMocks.installPluginNative).not.toHaveBeenCalled()
      expect(listeners.size).toBe(1)
      expect(store.installingSet.has(pid)).toBe(false)
    })

    it('发起安装失败时释放监听和互斥', async () => {
      const store = usePluginsStore()
      const { listeners } = installBus(store)
      apiMocks.installPluginNative.mockRejectedValue(new Error('权限不足'))
      await expect(store.installPlugin(pid)).rejects.toThrow('权限不足')
      expect(listeners.size).toBe(1)
      expect(store.installingSet.has(pid)).toBe(false)
    })
  })
})

describe('插件目录里的新版本不再支持当前系统', () => {
  const winOnly = [{ id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }]
  const both = [...winOnly, { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }]
  beforeEach(() => {
    setActivePinia(createPinia())
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
  })
  afterEach(() => {
    delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
  })

  it('Mac 上目录改为仅 Windows：已装副本标为不支持当前系统并阻止启动，不写主进程下架状态；目录恢复支持后自动解除', async () => {
    const call = vi.fn(async () => ({ success: true }))
    window.ztools.plugin = new PluginAPI({ call })
    const store = usePluginsStore()
    store.installedSet.add('legacy-win-tool')
    store.installedPlugins = [{ pluginId: 'legacy-win-tool', enabled: true }]
    store._applyPlatformSupport([{ pluginId: 'legacy-win-tool', targets: winOnly }])
    expect(store.isRevoked('legacy-win-tool')).toBe(true)
    expect(store.getRevokedKind('legacy-win-tool')).toBe('platform')
    expect(store.getRevokedReason('legacy-win-tool')).toBe('插件目录里的新版本仅 Windows，当前系统已不再支持')
    expect(call).not.toHaveBeenCalled()
    await expect(store.openPlugin('legacy-win-tool')).rejects.toThrow('无法启动：插件目录里的新版本仅 Windows，当前系统已不再支持')

    store._applyPlatformSupport([{ pluginId: 'legacy-win-tool', targets: both }])
    expect(store.isRevoked('legacy-win-tool')).toBe(false)
  })

  it('[边界] 官方下架优先于平台标记；客户端自带的插件、未声明平台或声明为空的条目不处理；目录先于已装列表返回也能标记', () => {
    const store = usePluginsStore()
    store.revokedMap = { gone: { revoked: true, reason: '安全问题' } }
    store._applyPlatformSupport([
      { pluginId: 'gone', targets: winOnly },
      { pluginId: 'calculator', targets: winOnly },
      { pluginId: 'no-declare' },
      { pluginId: 'empty-declare', targets: [] },
      { pluginId: 'not-installed-yet', targets: winOnly },
      null,
      { targets: winOnly }
    ])
    expect(store.getRevokedKind('gone')).toBe('revoked')
    expect(store.getRevokedReason('gone')).toBe('安全问题')
    expect(store.isRevoked('calculator')).toBe(false)
    expect(store.isRevoked('no-declare')).toBe(false)
    expect(store.isRevoked('empty-declare')).toBe(false)
    expect(store.getRevokedKind('not-installed-yet')).toBe('platform')

    // 之后目录把它正式下架：下架原因覆盖平台标记
    store._applyRevocations([{ pluginId: 'not-installed-yet', revoked: true, revokedReason: '已合并' }])
    expect(store.getRevokedKind('not-installed-yet')).toBe('revoked')
    store._applyPlatformSupport([{ pluginId: 'not-installed-yet', targets: both }])
    expect(store.isRevoked('not-installed-yet'), '平台恢复支持不能解除官方下架').toBe(true)
  })
})
