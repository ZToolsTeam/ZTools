import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UpdateAPI from '../../../public/js/cef-ipc/src/api/update'

const SHA = 'a'.repeat(64)
const target = (platform) => ({ id: `${platform}-electron-any`, platform, runtime: 'electron', arch: 'any' })
function plugin(overrides = {}) {
  return {
    id: 'test-distribution', name: '分发测试', version: '2.0.0', category: ['系统工具', '办公效率'],
    downloadUrl: 'https://cdn.ztools.cn/plugins-v2/official/test-distribution/test-distribution-2.0.0.zip',
    sha256: SHA, size: 1024, targets: [target('macos'), target('windows')], ...overrides
  }
}
function serve(entries) {
  const mock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ plugins: entries })))
  vi.stubGlobal('fetch', mock)
  return mock
}
async function api() {
  vi.resetModules()
  return import('@/api/plugins')
}

// 只替换网络和宿主边界，使用真实目录解析、分类、平台与版本检查代码。
describe('新版插件安装分发链路', () => {
  beforeEach(() => {
    window.ztools = { sys: {
      getInfo: vi.fn().mockResolvedValue({ platform: 'macos' }),
      getCurrentVersion: vi.fn().mockResolvedValue({ appVersion: '1.1.8.2', webVersion: '1.0.4' })
    } }
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete window.ztools })

  it('分类来自新版目录，支持多分类；下架与草稿不进入分类和浏览结果', async () => {
    const fetchMock = serve([plugin(), plugin({ id: 'draft', draft: true }), plugin({ id: 'revoked', revoked: true })])
    const plugins = await api()
    expect(await plugins.getCategories()).toEqual([
      { id: 'productivity', name: '办公效率', slug: 'productivity', labelKey: 'categories.productivity', pluginsCount: 1 },
      { id: 'system', name: '系统工具', slug: 'system', labelKey: 'categories.system', pluginsCount: 1 }
    ])
    expect((await plugins.getMarketPlugins({ category: '办公效率' })).list.map((item) => item.id)).toEqual(['test-distribution'])
    expect(await plugins.getDownloadSign('test-distribution')).toMatchObject({ sha256: SHA, size: 1024 })
    const edition = await import('@edition')
    const expectedRequestsPerLoad = edition.nativeCatalogUrl ? 2 : 1
    expect(fetchMock).toHaveBeenCalledTimes(expectedRequestsPerLoad * 2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.ztools.cn/plugins-v2/catalog.json')
    if (edition.nativeCatalogUrl) {
      expect(fetchMock.mock.calls[1][0]).toBe(edition.nativeCatalogUrl)
    }
  })

  it.each([
    [{ revoked: true, downloadUrl: '' }, 'PLUGIN_REVOKED'],
    [{ draft: true }, 'PLUGIN_NOT_PUBLISHED'],
    [{ sha256: '' }, 'PLUGIN_INVALID_PACKAGE'],
    [{ downloadUrl: 'https://cdn.ztools.cn/plugins/old.zip' }, 'PLUGIN_INVALID_PACKAGE'],
    [{ downloadUrl: 'https://example.com/plugins-v2/old.zip' }, 'PLUGIN_INVALID_PACKAGE'],
    [{ downloadUrl: 'https://cdn.ztools.cn/plugins-v2/../plugins/old.zip' }, 'PLUGIN_INVALID_PACKAGE'],
    [{ targets: [target('windows')] }, 'PLUGIN_PLATFORM_UNSUPPORTED'],
    [{ minAppVersion: '1.1.8.3' }, 'PLUGIN_VERSION_INCOMPATIBLE'],
    [{ minAppVersion: 'broken' }, 'PLUGIN_VERSION_INCOMPATIBLE']
  ])('拒绝不安全或不兼容的安装请求：%j', async (overrides, code) => {
    serve([plugin(overrides)])
    const plugins = await api()
    await expect(plugins.getDownloadSign('test-distribution')).rejects.toMatchObject({ code })
  })

  it('最低客户端版本相等可安装，插件 API 版本不误当成客户端版本', async () => {
    serve([plugin({ minAppVersion: '1.1.8.2', minZToolsVersion: '2.0.0' })])
    const plugins = await api()
    expect(await plugins.getDownloadSign('test-distribution')).toMatchObject({ minAppVersion: '1.1.8.2' })
  })

  it('宿主版本不可读取时拒绝有最低版本要求的插件', async () => {
    serve([plugin({ minAppVersion: '1.1.8.2' })])
    window.ztools.sys.getCurrentVersion.mockRejectedValue(new Error('IPC 中断'))
    const plugins = await api()
    await expect(plugins.getDownloadSign('test-distribution')).rejects.toMatchObject({ code: 'PLUGIN_VERSION_INCOMPATIBLE' })
  })

  it('非成功 HTTP 响应中止下载；过期缓存失败不冒充新目录，恢复后重试成功', async () => {
    let response = () => new Response(JSON.stringify({ plugins: [plugin()] }))
    const signals = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => { signals.push(options.signal); return response() }))
    const plugins = await api()
    expect((await plugins.getMarketPlugins()).total).toBe(1)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001)
    try {
      response = () => new Response('不可用', { status: 503 })
      await expect(plugins.getMarketPlugins()).rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNAVAILABLE' })
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      response = () => new Response(JSON.stringify({ plugins: [] }))
      expect((await plugins.getMarketPlugins()).total).toBe(0)
    } finally { now.mockRestore() }
  })

  it('超时中止请求，清理等待状态后允许重新读取', async () => {
    const plugins = await api()
    vi.useFakeTimers()
    const signals = []
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signals.push(options.signal)
      options.signal.addEventListener('abort', () => reject(new Error('已中止')), { once: true })
    })))
    const pending = plugins.getMarketPlugins()
    const assertion = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(2501)
    await assertion
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    serve([plugin()])
    expect((await plugins.getMarketPlugins()).total).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [{ revoked: true }, 'PLUGIN_REVOKED'],
    [{ draft: true }, 'PLUGIN_NOT_PUBLISHED'],
    [{ downloadUrl: 'https://cdn.ztools.cn/plugins/old.zip' }, 'PLUGIN_INVALID_PACKAGE'],
    [{ targets: [target('windows')] }, 'PLUGIN_PLATFORM_UNSUPPORTED'],
    [{ minAppVersion: '1.1.8.3' }, 'PLUGIN_VERSION_INCOMPATIBLE']
  ])('已显示可更新后，最新目录变为 %j 时不能用旧地址绕过校验', async (overrides, code) => {
    serve([plugin()])
    await api()
    const update = await import('@/api/update')
    const { downloadPluginUpdate } = await import('@/api/apiserver')
    const displayed = await update.checkPluginUpdate('test-distribution', { current_version: '1.0.0' })
    expect(displayed.hasUpdate).toBe(true)
    serve([plugin(overrides)])
    const transport = { call: vi.fn() }
    window.ztools.update = new UpdateAPI(transport)
    await expect(downloadPluginUpdate('test-distribution', displayed)).rejects.toMatchObject({ code })
    expect(transport.call).not.toHaveBeenCalled()
  })

  it('更新从最新目录到真实 SDK 映射 SHA 与大小，宿主失败不报成功', async () => {
    const latest = plugin({ version: '2.1.0', downloadUrl: 'https://cdn.ztools.cn/plugins-v2/official/test-distribution/test-distribution-2.1.0.zip' })
    serve([latest])
    await api()
    const { downloadPluginUpdate } = await import('@/api/apiserver')
    const transport = { call: vi.fn().mockResolvedValue({ success: true }) }
    window.ztools.update = new UpdateAPI(transport)
    expect(await downloadPluginUpdate(latest.id, { downloadUrl: 'https://example.com/old.zip' })).toBe(true)
    expect(transport.call).toHaveBeenCalledWith('plugin_update', {
      pluginId: latest.id, url: latest.downloadUrl, version: latest.version, checksum: SHA, fileSize: 1024
    })
    transport.call.mockResolvedValue({ success: false })
    await expect(downloadPluginUpdate(latest.id)).rejects.toThrow('插件更新启动失败')
  })
})

describe('原生插件附加目录合并与容错', () => {
  const PRIMARY_URL = 'https://cdn.ztools.cn/plugins-v2/catalog.json'
  const NATIVE_URL = 'https://cdn.ztools.cn/plugins-v2/native-catalog.json'

  beforeEach(() => {
    window.ztools = {
      sys: {
        getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }),
        getCurrentVersion: vi.fn().mockResolvedValue({ appVersion: '1.1.8.2', webVersion: '1.0.4' })
      }
    }
  })

  afterEach(() => {
    vi.doUnmock('@edition')
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete window.ztools
  })

  async function loadWithNativeUrl(url) {
    vi.resetModules()
    vi.doMock('@edition', () => ({ nativeCatalogUrl: url }))
    const [plugins, catalog] = await Promise.all([
      import('@/api/plugins'),
      import('@/api/pluginCatalog')
    ])
    return { plugins, catalog }
  }

  it('商业版并发拉取并合并主目录与原生目录：同 ID 原位覆盖、新增条目追加在后，且可正常下载', async () => {
    const primaryList = [
      plugin({ id: 'plugin-a', version: '1.0.0' }),
      plugin({ id: 'shared-plugin', name: '主目录旧版', version: '1.0.0' }),
      plugin({ id: 'plugin-b', version: '1.0.0' })
    ]
    const nativeList = [
      plugin({
        id: 'SHARED-PLUGIN',
        pluginId: 'shared-plugin',
        name: '原生覆盖版',
        version: '2.0.0',
        downloadUrl: 'https://cdn.ztools.cn/plugins-v2/official/shared-plugin/shared-plugin-2.0.0.zip'
      }),
      plugin({
        id: 'native-only',
        name: '官方原生工具',
        version: '1.2.0',
        targets: [target('windows')],
        downloadUrl: 'https://cdn.ztools.cn/plugins-v2/official/native-only/native-only-1.2.0.zip'
      })
    ]

    const fetchMock = vi.fn(async (url) => {
      if (url === PRIMARY_URL) return new Response(JSON.stringify({ list: primaryList }))
      if (url === NATIVE_URL) return new Response(JSON.stringify({ plugins: nativeList }))
      throw new Error(`未预期的请求地址: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { plugins, catalog } = await loadWithNativeUrl(NATIVE_URL)
    const rawList = await catalog.loadV2StaticCatalogList()
    expect(rawList.map((item) => catalog.normalizeCatalogId(item.id || item.pluginId))).toEqual([
      'plugin-a',
      'shared-plugin',
      'plugin-b',
      'native-only'
    ])

    const market = await plugins.getMarketPlugins({ per_page: 20 })
    expect(market.total).toBe(4)
    expect(market.list.map((item) => item.pluginId)).toEqual([
      'plugin-a',
      'shared-plugin',
      'plugin-b',
      'native-only'
    ])
    expect(market.list[1]).toMatchObject({ name: '原生覆盖版', version: '2.0.0' })

    const foundNative = await catalog.findInV2StaticCatalog('native-only')
    expect(foundNative).toMatchObject({ id: 'native-only', version: '1.2.0' })
    expect(catalog.buildCatalogDownloadInfo(foundNative)).toMatchObject({
      id: 'native-only',
      downloadUrl: 'https://cdn.ztools.cn/plugins-v2/official/native-only/native-only-1.2.0.zip',
      sha256: SHA
    })
    expect(await plugins.getDownloadSign('native-only')).toMatchObject({
      id: 'native-only',
      version: '1.2.0',
      downloadUrl: 'https://cdn.ztools.cn/plugins-v2/official/native-only/native-only-1.2.0.zip'
    })
  })

  it('原生附加目录返回 404 时视为暂无原生插件，不告警也不阻断主市场', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async (url) => {
      if (url === PRIMARY_URL) return new Response(JSON.stringify({ plugins: [plugin({ id: 'base-plugin' })] }))
      if (url === NATIVE_URL) return new Response('Not Found', { status: 404 })
      throw new Error(`未预期的请求地址: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { plugins } = await loadWithNativeUrl(NATIVE_URL)
    const market = await plugins.getMarketPlugins()
    expect(market.total).toBe(1)
    expect(market.list.map((item) => item.id)).toEqual(['base-plugin'])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP 500', async () => new Response('Server Error', { status: 500 })],
    ['网络异常', async () => { throw new TypeError('Failed to fetch') }],
    ['损坏 JSON', async () => new Response('{broken-json', { status: 200 })]
  ])('原生附加目录发生 %s 时记录告警并降级为空数组，不阻断主市场', async (_label, nativeResponder) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === PRIMARY_URL) return new Response(JSON.stringify({ plugins: [plugin({ id: 'base-plugin' })] }))
      if (url === NATIVE_URL) return nativeResponder()
      throw new Error(`未预期的请求地址: ${url}`)
    }))

    const { plugins } = await loadWithNativeUrl(NATIVE_URL)
    const market = await plugins.getMarketPlugins()
    expect(market.total).toBe(1)
    expect(market.list.map((item) => item.id)).toEqual(['base-plugin'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('原生附加目录超时时记录告警并降级为空数组，不阻断主市场', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    let nativeSignal
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      if (url === PRIMARY_URL) {
        return Promise.resolve(new Response(JSON.stringify({ plugins: [plugin({ id: 'base-plugin' })] })))
      }
      if (url === NATIVE_URL) {
        return new Promise((_resolve, reject) => {
          nativeSignal = options.signal
          nativeSignal.addEventListener('abort', () => reject(new Error('原生目录超时')), { once: true })
        })
      }
      return Promise.reject(new Error(`未预期的请求地址: ${url}`))
    }))

    const { plugins } = await loadWithNativeUrl(NATIVE_URL)
    const pending = plugins.getMarketPlugins()
    await vi.advanceTimersByTimeAsync(2501)
    const market = await pending
    expect(nativeSignal.aborted).toBe(true)
    expect(market.total).toBe(1)
    expect(market.list.map((item) => item.id)).toEqual(['base-plugin'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('主目录失败时即使原生附加目录正常也严格 Fail-Fast', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === PRIMARY_URL) return new Response('Unavailable', { status: 503 })
      if (url === NATIVE_URL) return new Response(JSON.stringify({ plugins: [plugin({ id: 'native-only' })] }))
      throw new Error(`未预期的请求地址: ${url}`)
    }))

    const { plugins } = await loadWithNativeUrl(NATIVE_URL)
    await expect(plugins.getMarketPlugins()).rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNAVAILABLE' })
  })

  it('开源版（nativeCatalogUrl 为空）仅拉取主目录，不发出任何附加请求', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plugins: [plugin({ id: 'oss-plugin' })] })))
    vi.stubGlobal('fetch', fetchMock)

    const { plugins } = await loadWithNativeUrl('')
    const market = await plugins.getMarketPlugins()
    expect(market.total).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(PRIMARY_URL)
  })

  it('macOS 商业版跳过拉取 Windows 原生附加目录，保留双端插件的 macOS target', async () => {
    const origUserAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      configurable: true
    })
    try {
      const fetchMock = vi.fn(async (url) => {
        if (url === PRIMARY_URL) {
          return new Response(JSON.stringify({
            plugins: [plugin({ id: 'screenshot', targets: [target('windows'), target('macos')] })]
          }))
        }
        throw new Error(`macOS 不应请求 Windows 原生目录: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)

      const { catalog } = await loadWithNativeUrl(NATIVE_URL)
      const list = await catalog.loadV2StaticCatalogList()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe(PRIMARY_URL)
      expect(list[0].targets.map((t) => t.platform)).toEqual(['windows', 'macos'])
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: origUserAgent,
        configurable: true
      })
    }
  })
})
