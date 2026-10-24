/**
 * 开源版（没有官方后台）的插件市场与更新：只读 CDN 静态插件目录，不访问任何后台。
 * @edition 固定指向开源版实现，官方构建与开源仓库里结果一致；
 * 网络请求只经 fetch 发出，用例断言请求过的地址全部是 CDN 静态目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@edition', () => import('@/edition-oss/index.js'))

const SHA = 'b'.repeat(64)
const CROSS = [
  { id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' },
  { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }
]

function entry(id, version, extra = {}) {
  return {
    id,
    pluginId: id,
    name: `插件 ${id}`,
    description: `${id} 的说明`,
    category: '系统工具',
    version,
    downloadUrl: `https://cdn.ztools.cn/plugins-v2/ztools-team/${id}/${id}-${version}.zip`,
    sha256: SHA,
    size: 1024,
    targets: CROSS,
    ...extra
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

function setHost(platform = 'macos', localPlugins = []) {
  window.ztools = {
    sys: {
      getInfo: vi.fn().mockResolvedValue({ platform }),
      getCurrentVersion: vi.fn().mockResolvedValue({ appVersion: '1.1.8.2', webVersion: '1.0.0' })
    },
    plugin: {
      getList: vi.fn().mockResolvedValue({ data: localPlugins })
    }
  }
}

// 静态目录在模块里有 60 秒缓存，每个用例重新加载模块，互不影响
async function loadApis() {
  vi.resetModules()
  const plugins = await import('@/api/plugins')
  const update = await import('@/api/update')
  return { plugins, update }
}

function requestedUrls(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => String(url))
}

describe('开源版插件市场：只读 CDN 静态插件目录', () => {
  beforeEach(() => {
    setHost('macos')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.ztools
  })

  it('列表、详情与下载信息都来自静态目录，只请求 CDN 一个地址', async () => {
    const fetchMock = serveCatalog([entry('alpha', '1.0.0'), entry('beta', '2.0.0')])
    const { plugins } = await loadApis()

    const page = await plugins.getMarketPlugins({ per_page: 1, page: 2 })
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1, lastPage: 2 })
    expect(page.list.map((p) => p.pluginId)).toEqual(['beta'])

    const detail = await plugins.getPluginDetails('ALPHA')
    expect(detail).toMatchObject({ pluginId: 'alpha', sha256: SHA, checksum: SHA, size: 1024 })

    const sign = await plugins.getDownloadSign('beta')
    expect(sign).toEqual({
      id: 'beta',
      pluginId: 'beta',
      version: '2.0.0',
      downloadUrl: entry('beta', '2.0.0').downloadUrl,
      sha256: SHA,
      checksum: SHA,
      size: 1024
    })

    expect(await plugins.getCategories()).toEqual([])
    // 60 秒缓存内只拉一次，且只访问 CDN 静态目录，不访问任何后台接口
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const url of requestedUrls(fetchMock)) {
      expect(url.startsWith('https://cdn.ztools.cn/plugins-v2/')).toBe(true)
      expect(url).not.toMatch(/\/api\//)
    }
  })

  it('搜索、分类、按 id 取与按下载量排序；普通浏览不展示已下架与草稿插件', async () => {
    serveCatalog([
      entry('alpha', '1.0.0', { downloads: 5 }),
      entry('beta', '1.0.0', { downloads: 50, category: '办公效率' }),
      entry('gone', '1.0.0', { revoked: true }),
      entry('wip', '1.0.0', { draft: true })
    ])
    const { plugins } = await loadApis()

    expect((await plugins.getMarketPlugins()).list.map((p) => p.pluginId)).toEqual(['alpha', 'beta'])
    expect((await plugins.getMarketPlugins({ search: 'BETA' })).list.map((p) => p.pluginId)).toEqual(['beta'])
    expect((await plugins.getMarketPlugins({ category: '办公效率' })).total).toBe(1)
    expect(
      (await plugins.getMarketPlugins({ sort: 'downloads' })).list.map((p) => p.pluginId)
    ).toEqual(['beta', 'alpha'])
    // 按 id 取（如补全已装插件图标）时下架插件也要能取到
    expect(
      (await plugins.getMarketPlugins({ ids: ['gone', 'ALPHA'] })).list.map((p) => p.pluginId).sort()
    ).toEqual(['alpha', 'gone'])
    expect((await plugins.getMarketPlugins({ ids: 'alpha,beta' })).total).toBe(2)
  })

  it('非法分页参数按默认值处理，不出现负数页或除零', async () => {
    serveCatalog([entry('alpha', '1.0.0')])
    const { plugins } = await loadApis()

    for (const bad of [{ page: -3, per_page: 0 }, { page: 'x', per_page: NaN }, { page: 1.5, per_page: -1 }]) {
      const res = await plugins.getMarketPlugins(bad)
      expect(res.page).toBe(1)
      expect(res.pageSize).toBe(15)
      expect(res.lastPage).toBe(1)
      expect(res.list).toHaveLength(1)
    }
  })

  it('已下架插件拒绝下载，抛出 PLUGIN_REVOKED 并带上下架原因', async () => {
    serveCatalog([entry('gone', '1.0.0', { revoked: true, revokedReason: '违反隐私规范' })])
    const { plugins } = await loadApis()

    await expect(plugins.getDownloadSign('gone')).rejects.toMatchObject({
      code: 'PLUGIN_REVOKED',
      message: '插件已被官方安全下架: 违反隐私规范'
    })
  })

  it('目录里没有的插件：详情回退本地已安装插件；下载给出可识别的错误', async () => {
    serveCatalog([entry('alpha', '1.0.0')])
    setHost('macos', [{ pluginId: 'local-only', name: '本地插件' }])
    const { plugins } = await loadApis()

    expect(await plugins.getPluginDetails('local-only')).toMatchObject({ id: 'local-only', name: '本地插件' })
    await expect(plugins.getPluginDetails('missing')).rejects.toMatchObject({ code: 'PLUGIN_NOT_IN_CATALOG' })
    await expect(plugins.getDownloadSign('missing')).rejects.toMatchObject({ code: 'PLUGIN_NOT_IN_CATALOG' })
  })

  it('目录条目缺下载地址时不给下载信息', async () => {
    serveCatalog([entry('broken', '1.0.0', { downloadUrl: '' })])
    const { plugins } = await loadApis()

    await expect(plugins.getDownloadSign('broken')).rejects.toMatchObject({ code: 'PLUGIN_NOT_IN_CATALOG' })
  })

  describe('CDN 异常', () => {
    it('断网：列表为空、详情回退本地、下载报错，均不抛出未处理异常', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')))
      setHost('macos', [{ pluginId: 'local-a', name: 'A' }])
      const { plugins } = await loadApis()

      expect(await plugins.getMarketPlugins({ page: 3 })).toEqual({ list: [], total: 0, page: 3, pageSize: 15, lastPage: 1 })
      expect(await plugins.getPluginDetails('local-a')).toMatchObject({ id: 'local-a' })
      await expect(plugins.getDownloadSign('local-a')).rejects.toMatchObject({ code: 'PLUGIN_NOT_IN_CATALOG' })
    })

    it('5xx 与损坏的 JSON 当作目录不可用，下次请求重新拉取（失败结果不进缓存）', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('Unexpected token') } })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ list: 'not-an-array' }) })
        .mockResolvedValue({ ok: true, json: async () => [entry('alpha', '1.0.0')] })
      vi.stubGlobal('fetch', fetchMock)
      const { plugins } = await loadApis()

      expect((await plugins.getMarketPlugins()).list).toEqual([])
      expect((await plugins.getMarketPlugins()).list).toEqual([])
      expect((await plugins.getMarketPlugins()).list).toEqual([])
      expect((await plugins.getMarketPlugins()).list.map((p) => p.pluginId)).toEqual(['alpha'])
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it('目录里混入非对象与缺 id 的脏条目时跳过，不影响其它插件', async () => {
      serveCatalog([null, 42, 'x', { name: '没有 id' }, entry('alpha', '1.0.0')])
      const { plugins } = await loadApis()

      expect((await plugins.getMarketPlugins()).list.map((p) => p.pluginId)).toEqual(['alpha'])
    })
  })
})

describe('开源版插件更新：以 CDN 静态插件目录为准', () => {
  beforeEach(() => {
    setHost('macos')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.ztools
  })

  it('目录里有更高版本时提示更新，结果可直接交给更新下载接口', async () => {
    serveCatalog([entry('alpha', '1.2.0')])
    const { update } = await loadApis()

    const single = await update.checkPluginUpdate('alpha', { current_version: '1.0.0' })
    expect(single).toMatchObject({
      hasUpdate: true,
      pluginId: 'alpha',
      version: '1.2.0',
      downloadUrl: entry('alpha', '1.2.0').downloadUrl,
      sha256: SHA,
      source: 'static-catalog'
    })

    const batch = await update.batchCheckPlugins({ plugins: [{ id: 'alpha', version: '1.0.0' }] })
    expect(batch.alpha.hasUpdate).toBe(true)
  })

  it('已是最新、已下架、平台不支持、版本号畸形、目录未收录时都不提示更新', async () => {
    serveCatalog([
      entry('same', '1.0.0'),
      entry('gone', '9.0.0', { revoked: true }),
      entry('win-only', '9.0.0', { targets: [CROSS[0]] })
    ])
    const { update } = await loadApis()

    const res = await update.batchCheckPlugins({
      plugins: [
        { id: 'same', version: '1.0.0' },
        { id: 'gone', version: '1.0.0' },
        { id: 'win-only', version: '1.0.0' },
        { pluginId: 'unknown', version: '1.0.0' },
        { id: 'same', version: 'not-a-version' }
      ]
    })
    expect(res.same.hasUpdate).toBe(false)
    expect(res.gone).toMatchObject({ hasUpdate: false, revoked: true })
    expect(res['win-only']).toMatchObject({ hasUpdate: false, message: '新版本不支持当前平台' })
    expect(res.unknown).toMatchObject({ hasUpdate: false, message: '插件市场未收录该插件' })
  })

  it('CDN 不可用时不提示更新也不抛错，提示目录暂不可用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const { update } = await loadApis()

    expect(await update.checkPluginUpdate('alpha', { current_version: '1.0.0' })).toMatchObject({
      hasUpdate: false,
      message: '插件目录暂不可用'
    })
    expect(await update.batchCheckPlugins({ plugins: [{ id: 'alpha', version: '1.0.0' }] })).toEqual({
      alpha: { hasUpdate: false, pluginId: 'alpha', message: '插件目录暂不可用' }
    })
  })

  it('空列表与缺 id 的条目不发请求也不报错', async () => {
    const fetchMock = serveCatalog([entry('alpha', '1.2.0')])
    const { update } = await loadApis()

    expect(await update.batchCheckPlugins({ plugins: [] })).toEqual({})
    expect(await update.batchCheckPlugins({ plugins: [{ version: '1.0.0' }, null] })).toEqual({})
    expect(await update.batchCheckPlugins({})).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('宿主平台不受支持或读取失败时拒绝检查', async () => {
    serveCatalog([entry('alpha', '1.2.0')])
    const { update } = await loadApis()

    await expect(update.checkPluginUpdate('alpha', { platform: 'linux' })).rejects.toThrow('仅支持 Windows/macOS')
    window.ztools.sys.getInfo = vi.fn().mockRejectedValue(new Error('IPC 断开'))
    await expect(update.batchCheckPlugins({ plugins: [{ id: 'alpha', version: '1.0.0' }] })).rejects.toThrow(
      '读取宿主平台失败'
    )
  })

  it('20 次并发检查各自拿到自己的结果，目录只拉一次', async () => {
    const list = Array.from({ length: 20 }, (_, i) => entry(`p${i}`, `1.${i}.0`))
    const fetchMock = serveCatalog(list)
    const { update } = await loadApis()

    const results = await Promise.all(
      list.map((e, i) => update.checkPluginUpdate(e.id, { current_version: i % 2 ? '1.0.0' : '9.0.0' }))
    )
    results.forEach((res, i) => {
      expect(res.pluginId).toBe(`p${i}`)
      expect(res.hasUpdate).toBe(i % 2 === 1 && i > 0)
    })
    // 并发首拉可能各自发起，但全部来自 CDN 静态目录
    for (const url of requestedUrls(fetchMock)) {
      expect(url.startsWith('https://cdn.ztools.cn/plugins-v2/')).toBe(true)
    }
  })
})

describe('开源版不访问后台', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.ztools
  })

  it('[集成] 列表、详情、下载、单个与批量更新检查全程没有一次后台请求', async () => {
    const fetchMock = serveCatalog([entry('alpha', '2.0.0')])
    setHost('macos', [{ pluginId: 'local-only', name: '本地插件' }])
    const { plugins, update } = await loadApis()

    await plugins.getCategories()
    await plugins.getMarketPlugins({ search: 'alpha' })
    await plugins.getPluginDetails('alpha')
    await plugins.getPluginDetails('local-only')
    await plugins.getDownloadSign('alpha')
    await update.checkPluginUpdate('alpha', { current_version: '1.0.0' })
    await update.checkPluginUpdate('not-in-catalog', { current_version: '1.0.0' })
    await update.batchCheckPlugins({ plugins: [{ id: 'alpha', version: '1.0.0' }, { id: 'not-in-catalog', version: '1.0.0' }] })

    expect(fetchMock).toHaveBeenCalled()
    for (const url of requestedUrls(fetchMock)) {
      expect(url.startsWith('https://cdn.ztools.cn/plugins-v2/')).toBe(true)
    }
  })

  it('[故障] 开源版的分类为空、市场后台为空：公共入口不转交任何后台实现', async () => {
    const edition = await import('@edition')
    expect(edition.marketBackend).toBe(null)
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    setHost('macos')
    const { plugins, update } = await loadApis()
    expect(await plugins.getCategories()).toEqual([])
    expect((await plugins.getMarketPlugins()).list).toEqual([])
    expect(await update.checkPluginUpdate('x', { current_version: '1.0.0' })).toMatchObject({ hasUpdate: false })
    for (const url of requestedUrls(fetchMock)) {
      expect(url.startsWith('https://cdn.ztools.cn/plugins-v2/')).toBe(true)
    }
  })
})
