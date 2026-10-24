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
      { id: '系统工具', name: '系统工具', slug: '系统工具', pluginsCount: 1 },
      { id: '办公效率', name: '办公效率', slug: '办公效率', pluginsCount: 1 }
    ])
    expect((await plugins.getMarketPlugins({ category: '办公效率' })).list.map((item) => item.id)).toEqual(['test-distribution'])
    expect(await plugins.getDownloadSign('test-distribution')).toMatchObject({ sha256: SHA, size: 1024 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.ztools.cn/plugins-v2/catalog.json')
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
    let signal
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal
      signal.addEventListener('abort', () => reject(new Error('已中止')), { once: true })
    })))
    const pending = plugins.getMarketPlugins()
    const assertion = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_CATALOG_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(2501)
    await assertion
    expect(signal.aborted).toBe(true)
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
