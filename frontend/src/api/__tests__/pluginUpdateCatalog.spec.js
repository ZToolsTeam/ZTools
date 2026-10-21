import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import UpdateAPI from '../../../public/js/cef-ipc/src/api/update'

const httpMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn()
}))

vi.mock('@/utils/http', () => ({ default: httpMock }))

const SHA = 'a'.repeat(64)
const CROSS = [
  { id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' },
  { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }
]
const WIN_ONLY = [CROSS[0]]

function entry(id, version, extra = {}) {
  return {
    id,
    pluginId: id,
    version,
    downloadUrl: `https://cdn.ztools.cn/plugins-v2/ztools-team/${id}/${id}-${version}.zip`,
    sha256: SHA,
    size: 2048,
    targets: CROSS,
    minZToolsVersion: '2.0.0',
    ...extra
  }
}

function setHost(platform, appVersion = '1.1.8.1') {
  window.ztools = {
    sys: {
      getInfo: vi.fn().mockResolvedValue({ platform }),
      getCurrentVersion: vi.fn().mockResolvedValue({ appVersion, webVersion: '1.0.4' })
    }
  }
}

function serveCatalog(list) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ schemaVersion: '2.0.0', total: list.length, list })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// 静态索引在模块里有 60 秒缓存，每个用例重新加载模块，互不影响
async function loadApi() {
  vi.resetModules()
  return import('../update')
}

describe('插件更新：以 CDN 静态索引为准', { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setHost('macos')
  })

  afterEach(() => {
    delete window.ztools
    vi.unstubAllGlobals()
  })

  it('静态索引里有更高版本时提示更新，结果可以直接交给更新下载接口', async () => {
    serveCatalog([entry('translator', '2.1.0')])
    const { batchCheckPlugins } = await loadApi()

    const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })

    expect(updates.translator).toMatchObject({
      hasUpdate: true,
      version: '2.1.0',
      checksum: SHA,
      download_url: 'https://cdn.ztools.cn/plugins-v2/ztools-team/translator/translator-2.1.0.zip'
    })
    // 新插件不在后台数据库里，不应再去问后台
    expect(httpMock.post).not.toHaveBeenCalled()

    // 串到真实的更新下载接口：主进程收到的 checksum 必须是 SHA-256，否则会拒绝安装
    const transport = { call: vi.fn().mockResolvedValue({ success: true }) }
    await expect(new UpdateAPI(transport).downloadPlugin('translator', updates.translator)).resolves.toBe(true)
    expect(transport.call).toHaveBeenCalledWith('plugin_update', {
      pluginId: 'translator',
      url: 'https://cdn.ztools.cn/plugins-v2/ztools-team/translator/translator-2.1.0.zip',
      version: '2.1.0',
      checksum: SHA,
      fileSize: 2048
    })
  })

  it('minZToolsVersion 是插件 API 版本，不能把 1.x 客户端判成“需升级”', async () => {
    serveCatalog([entry('translator', '2.1.0', { minZToolsVersion: '2.0.0' })])
    const { batchCheckPlugins } = await loadApi()
    const { checkCompat } = await import('@/composables/useVersionCompat')

    const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })

    expect(updates.translator.minAppVersion).toBeUndefined()
    expect(checkCompat(updates.translator, '1.1.8.1', '1.0.4').compatible).toBe(true)
  })

  it('静态索引和后台各管各的：索引里没有的老插件才发给后台，结果合并', async () => {
    serveCatalog([entry('translator', '2.1.0')])
    httpMock.post.mockResolvedValue({
      success: true,
      data: { 'legacy-tool': { hasUpdate: true, version: '1.5.0' } }
    })
    const { batchCheckPlugins } = await loadApi()

    const updates = await batchCheckPlugins({
      plugins: [
        { id: 'translator', version: '2.0.0' },
        { pluginId: 'legacy-tool', version: '1.0.0' }
      ]
    })

    expect(httpMock.post).toHaveBeenCalledWith(
      '/api/update/plugins/batch',
      expect.objectContaining({
        platform: 'macos',
        plugins: [{ id: 'legacy-tool', version: '1.0.0' }],
        app_version: '1.1.8.1'
      })
    )
    expect(updates.translator.hasUpdate).toBe(true)
    expect(updates['legacy-tool'].version).toBe('1.5.0')
  })

  it('插件 id 大小写不同也能匹配到索引条目', async () => {
    serveCatalog([entry('translator', '2.1.0')])
    const { batchCheckPlugins } = await loadApi()

    const updates = await batchCheckPlugins({ plugins: [{ id: 'Translator', version: '2.0.0' }] })

    expect(updates.Translator.hasUpdate).toBe(true)
    expect(httpMock.post).not.toHaveBeenCalled()
  })

  it('内置插件跟随客户端更新：既不比对索引也不问后台', async () => {
    const fetchMock = serveCatalog([entry('json-format', '9.9.9')])
    const { batchCheckPlugins } = await loadApi()

    const updates = await batchCheckPlugins({ plugins: [{ id: 'json-format', version: '1.0.0' }] })

    expect(updates['json-format'].hasUpdate).toBe(false)
    expect(httpMock.post).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('单个插件检查同样以静态索引为准，内置插件直接跳过', async () => {
    serveCatalog([entry('translator', '2.1.0')])
    const { checkPluginUpdate } = await loadApi()

    await expect(checkPluginUpdate('translator', { current_version: '2.0.0' })).resolves.toMatchObject({
      hasUpdate: true,
      version: '2.1.0'
    })
    await expect(checkPluginUpdate('memo', { current_version: '1.0.0' })).resolves.toMatchObject({
      hasUpdate: false
    })
    expect(httpMock.get).not.toHaveBeenCalled()
  })

  describe('异常与边界', () => {
    it('CDN 拉取失败时全部回退后台，行为与以前一致', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
      httpMock.post.mockResolvedValue({ success: true, data: { translator: { hasUpdate: false } } })
      const { batchCheckPlugins } = await loadApi()

      const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })

      expect(httpMock.post).toHaveBeenCalledWith(
        '/api/update/plugins/batch',
        expect.objectContaining({ plugins: [{ id: 'translator', version: '2.0.0' }] })
      )
      expect(updates.translator.hasUpdate).toBe(false)
    })

    it('CDN 返回 5xx 或损坏的 JSON 时同样回退后台', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }))
      httpMock.post.mockResolvedValue({ success: true, data: {} })
      let api = await loadApi()
      await api.batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })
      expect(httpMock.post).toHaveBeenCalledTimes(1)

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        }
      }))
      api = await loadApi()
      await api.batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })
      expect(httpMock.post).toHaveBeenCalledTimes(2)

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ list: 'oops' }) }))
      api = await loadApi()
      await api.batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })
      expect(httpMock.post).toHaveBeenCalledTimes(3)
    })

    it('后台挂了不影响新插件的更新结果', async () => {
      serveCatalog([entry('translator', '2.1.0')])
      httpMock.post.mockRejectedValue(new Error('HTTP 503'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { batchCheckPlugins } = await loadApi()

      const updates = await batchCheckPlugins({
        plugins: [
          { id: 'translator', version: '2.0.0' },
          { id: 'legacy-tool', version: '1.0.0' }
        ]
      })

      expect(updates.translator.hasUpdate).toBe(true)
      expect(updates['legacy-tool']).toBeUndefined()
      warn.mockRestore()
    })

    it('全是老插件且后台失败时照常抛错，交给调用方处理', async () => {
      serveCatalog([])
      httpMock.post.mockResolvedValue({ success: false, message: '服务暂不可用' })
      const { batchCheckPlugins } = await loadApi()

      await expect(
        batchCheckPlugins({ plugins: [{ id: 'legacy-tool', version: '1.0.0' }] })
      ).rejects.toThrow('服务暂不可用')
    })

    it.each([
      ['同版本', '2.0.0', '2.0.0'],
      ['本地版本更高（不往回降）', '2.1.0', '2.0.0'],
      ['四段式同版本', '2.0.0.0', '2.0.0']
    ])('%s 时不提示更新', async (_label, local, remote) => {
      serveCatalog([entry('translator', remote)])
      const { batchCheckPlugins } = await loadApi()

      const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: local }] })

      expect(updates.translator.hasUpdate).toBe(false)
    })

    it.each([
      ['索引版本号畸形', { version: 'latest' }],
      ['缺 SHA-256（主进程会拒装）', { sha256: undefined, checksum: undefined }],
      ['SHA-256 被截断', { sha256: SHA.slice(0, 63) }],
      ['SHA-256 含非十六进制字符', { sha256: 'g'.repeat(64) }],
      ['缺下载地址', { downloadUrl: '' }]
    ])('%s 时不提示更新', async (_label, patch) => {
      serveCatalog([{ ...entry('translator', '2.1.0'), ...patch }])
      const { batchCheckPlugins } = await loadApi()

      const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })

      expect(updates.translator.hasUpdate).toBe(false)
      expect(httpMock.post).not.toHaveBeenCalled()
    })

    it('本地版本号畸形时不提示更新，避免反复弹“可更新”', async () => {
      serveCatalog([entry('translator', '2.1.0')])
      const { batchCheckPlugins } = await loadApi()

      const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: 'dev' }] })

      expect(updates.translator.hasUpdate).toBe(false)
    })

    it('已下架的插件不提示更新，并带上下架标记', async () => {
      serveCatalog([entry('translator', '2.1.0', { revoked: true })])
      const { batchCheckPlugins } = await loadApi()

      const updates = await batchCheckPlugins({ plugins: [{ id: 'translator', version: '2.0.0' }] })

      expect(updates.translator).toMatchObject({ hasUpdate: false, revoked: true })
    })

    it('新版本只支持 Windows 时，Mac 上不提示更新，Windows 上提示', async () => {
      serveCatalog([entry('hosts', '1.1.0', { targets: WIN_ONLY })])
      let api = await loadApi()
      let updates = await api.batchCheckPlugins({ plugins: [{ id: 'hosts', version: '1.0.0' }] })
      expect(updates.hosts.hasUpdate).toBe(false)

      setHost('windows')
      serveCatalog([entry('hosts', '1.1.0', { targets: WIN_ONLY })])
      api = await loadApi()
      updates = await api.batchCheckPlugins({ plugins: [{ id: 'hosts', version: '1.0.0' }] })
      expect(updates.hosts.hasUpdate).toBe(true)
    })

    it('20 次并发检查各自拿到自己的结果，不会串', async () => {
      serveCatalog([entry('translator', '2.1.0'), entry('ocr', '2.0.1')])
      const { batchCheckPlugins } = await loadApi()

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          batchCheckPlugins({
            plugins: [{ id: i % 2 ? 'translator' : 'ocr', version: '2.0.0' }]
          })
        )
      )

      results.forEach((r, i) => {
        const id = i % 2 ? 'translator' : 'ocr'
        expect(Object.keys(r)).toEqual([id])
        expect(r[id].hasUpdate).toBe(true)
      })
      expect(httpMock.post).not.toHaveBeenCalled()
    })

    it('空列表和缺 id 的条目不发请求也不报错', async () => {
      serveCatalog([entry('translator', '2.1.0')])
      const { batchCheckPlugins } = await loadApi()

      await expect(batchCheckPlugins({ plugins: [] })).resolves.toEqual({})
      await expect(batchCheckPlugins({ plugins: [{ version: '1.0.0' }] })).resolves.toEqual({})
      expect(httpMock.post).not.toHaveBeenCalled()
    })
  })
})
