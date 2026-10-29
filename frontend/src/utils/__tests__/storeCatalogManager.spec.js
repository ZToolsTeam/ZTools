import { describe, it, expect, vi, afterEach } from 'vitest'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'

function asMac() {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
}

const builtinCalculator = {
  id: 'calculator', pluginId: 'calculator', name: '综合计算器与色彩速查',
  description: '输入算式直接出结果', category: '办公效率', isBuiltin: true
}

// 服务器清单里的同名旧版 Windows 插件
const remoteCalculator = {
  id: 'calculator', name: '计算器', description: '标准、科学、程序员三种模式',
  category: '系统工具', platforms: ['windows'], downloads: 845, revoked: false
}

function createManager(remote, official = [builtinCalculator]) {
  return new StoreCatalogManager({
    apiBaseUrl: '',
    fetchRemote: async () => ({ plugins: remote }),
    getOfficialList: () => official,
    isPlatformSupported: isPluginSupportedOnCurrentPlatform
  })
}

describe('StoreCatalogManager 远程条目与内置插件同 ID 合并', () => {
  afterEach(() => vi.restoreAllMocks())

  it('Mac 上不会因为远程同名条目标了 windows 就把内置计算器隐藏', async () => {
    asMac()
    const { catalog } = await createManager([remoteCalculator]).ensureCatalog(true)
    const calc = catalog.find((p) => p.pluginId === 'calculator')
    expect(calc).toBeTruthy()
    expect(calc.platforms).toBeUndefined()
  })

  it('名称、描述、分类以实际会打开的内置插件为准，下载量等统计仍取远程', async () => {
    asMac()
    const { catalog } = await createManager([remoteCalculator]).ensureCatalog(true)
    const calc = catalog.find((p) => p.pluginId === 'calculator')
    expect(calc.name).toBe('综合计算器与色彩速查')
    expect(calc.description).toBe('输入算式直接出结果')
    expect(calc.category).toEqual(['办公效率'])
    expect(calc.downloads).toBe(845)
  })

  it('版本、平台声明、图标以内置为准；内置插件的条目不带下载地址和最低客户端版本', async () => {
    asMac()
    const builtin = {
      ...builtinCalculator, version: '2.1.2', icon: 'ztools://web/bundled-plugins/calculator/icon.svg',
      targets: [{ id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }, { id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }]
    }
    const remote = {
      ...remoteCalculator, platforms: undefined, version: '2.1.4', icon: 'https://cdn.example.com/plugins-v2/ztools-team/calculator/icon.svg',
      targets: [{ id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }],
      downloadUrl: 'https://cdn.example.com/plugins-v2/ztools-team/calculator/calculator-2.1.4.zip', sha256: 'a'.repeat(64), size: 1024,
      minAppVersion: '9.9.9.9'
    }
    const { catalog } = await createManager([remote], [builtin]).ensureCatalog(true)
    const calc = catalog.find((p) => p.pluginId === 'calculator')
    expect(calc, '远程只声明 Windows 也不能在 Mac 上把内置插件隐藏').toBeTruthy()
    expect(calc.version).toBe('2.1.2')
    expect(calc.targets.map((t) => t.platform)).toEqual(['macos', 'windows'])
    expect(calc.icon).toBe(builtin.icon)
    for (const key of ['downloadUrl', 'sha256', 'size', 'minAppVersion']) expect(calc[key], key).toBeUndefined()
    expect(calc.downloads).toBe(845)
  })

  it('没有内置同名插件的远程条目保留下载地址、版本与最低客户端版本', async () => {
    const remote = { id: 'my-tool', name: 'My Tool', version: '1.2.0', downloadUrl: 'https://cdn.example.com/x.zip', sha256: 'b'.repeat(64), minAppVersion: '1.1.8.5' }
    const { catalog } = await createManager([remote], []).ensureCatalog(true)
    const item = catalog.find((p) => p.pluginId === 'my-tool')
    expect(item.downloadUrl).toBe(remote.downloadUrl)
    expect(item.version).toBe('1.2.0')
    expect(item.minAppVersion).toBe('1.1.8.5')
  })

  it('[破坏性] 远程条目照样能下架内置同名插件', async () => {
    asMac()
    const manager = createManager([{ ...remoteCalculator, revoked: true, revokedReason: '安全问题' }])
    await manager.ensureCatalog(true)
    expect(manager._revokedMap.calculator).toEqual({ revoked: true, reason: '安全问题' })
  })

  it('没有内置同名插件的远程条目，仍按自身平台声明过滤', async () => {
    asMac()
    const { catalog } = await createManager([{ id: 'hosts', name: 'Hosts', platforms: ['windows'] }], []).ensureCatalog(true)
    expect(catalog.find((p) => p.pluginId === 'hosts')).toBeUndefined()
  })

  it('[破坏性] 内置插件在不可用名单里时，远程同名条目也不能把它带回市场', async () => {
    asMac()
    const builtinUnavailable = { id: 'trial-nudges', pluginId: 'trial-nudges', name: '核心特权与技术方案' }
    const { catalog } = await createManager(
      [{ id: 'trial-nudges', name: '核心特权与技术方案', platforms: ['darwin', 'windows'] }],
      [builtinUnavailable]
    ).ensureCatalog(true)
    expect(catalog.find((p) => p.pluginId === 'trial-nudges')).toBeUndefined()
  })
})

describe('StoreCatalogManager 远程清单超时', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('[破坏性] 远程接口一直不返回时，超时后回退到内置清单，市场不会一直为空', async () => {
    vi.useFakeTimers()
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      fetchRemote: () => new Promise(() => {}),
      getOfficialList: () => [builtinCalculator],
      remoteTimeoutMs: 1000
    })
    const pending = manager.ensureCatalog(true)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending
    expect(result.isFallback).toBe(true)
    expect(result.catalog.map((p) => p.pluginId)).toEqual(['calculator'])
  })

  it('[破坏性] 静态清单也挂起时同样超时回退', async () => {
    vi.useFakeTimers()
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      getStaticCatalog: () => new Promise(() => {}),
      getOfficialList: () => [builtinCalculator],
      remoteTimeoutMs: 1000
    })
    const pending = manager.ensureCatalog(true)
    await vi.advanceTimersByTimeAsync(3000)
    const result = await pending
    expect(result.catalog.map((p) => p.pluginId)).toEqual(['calculator'])
  })

  it('远程在超时前返回时正常使用远程结果', async () => {
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      fetchRemote: async () => ({ plugins: [{ id: 'todo', name: '待办' }] }),
      getOfficialList: () => [],
      remoteTimeoutMs: 1000
    })
    const result = await manager.ensureCatalog(true)
    expect(result.isFallback).toBe(false)
    expect(result.catalog.map((p) => p.pluginId)).toEqual(['todo'])
  })
})

describe('StoreCatalogManager 作者署名与来源分类', () => {
  it('官方市场插件保留团队署名，社区独立插件保留作者的 GitHub 用户名', async () => {
    const rawPayload = {
      plugins: [
        { id: 'snippets', name: '快捷短语', author: 'ZTools Team', is_official: true },
        { id: 'alice-tool', name: '社区工具', author: 'octocat', is_official: false },
        { id: 'cleaner', name: '系统清理', author: 'ZTools Team', is_official: true }
      ]
    }
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      getStaticCatalog: async () => rawPayload,
      getOfficialList: () => [builtinCalculator]
    })

    const communityRes = await manager.query({ sourceType: 'community' })
    expect(communityRes.list.map((p) => p.pluginId)).toEqual(['alice-tool'])
    expect(communityRes.list[0]).toMatchObject({ author: 'octocat', is_official: false })

    const officialRes = await manager.query({ sourceType: 'official' })
    expect(officialRes.list.map((p) => p.pluginId).sort()).toEqual(['calculator', 'cleaner', 'snippets'])
    expect(officialRes.list.find((p) => p.pluginId === 'snippets')).toMatchObject({
      author: 'ZTools Team', is_official: true, source_type: 'official'
    })
    expect(rawPayload.plugins[0].author).toBe('ZTools Team')
  })

  it('[集成] 远端 CDN 返回旧版冗长插件名称或英文分类时，自动对齐为 plugins 仓库最新精简名称与标准四字分类', async () => {
    const staleRemotePlugins = [
      { id: 'boost', name: '开机加速与启动项管理', description: '旧描述', category: ['系统工具'], author: 'ZTools Team' },
      { id: 'cleaner', name: '系统垃圾深度清理', description: '旧描述', category: ['系统工具'], author: 'ZTools Team' },
      { id: 'context-menu', name: '系统右键菜单管理', description: '旧描述', category: ['系统工具'], author: 'ZTools Team' },
      { id: 'disk-analyzer', name: '磁盘空间透视分析器', description: '旧描述', category: ['系统工具'], author: 'ZTools Team' },
      { id: 'network-adapter', name: '网络适配器', description: '旧描述', category: 'system', author: 'ZTools Team' }
    ]
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      fetchRemote: async () => ({ list: staleRemotePlugins }),
      getOfficialList: () => []
    })
    const res = await manager.query({ category: '系统工具', pageSize: 20 })
    const byId = Object.fromEntries(res.list.map((p) => [p.pluginId, p]))
    expect(byId.boost.name).toBe('开机启动项')
    expect(byId.cleaner.name).toBe('垃圾清理')
    expect(byId['context-menu'].name).toBe('右键菜单管理')
    expect(byId['disk-analyzer'].name).toBe('磁盘空间分析')
    expect(byId['network-adapter'].name).toBe('网卡管理')
    expect(byId['network-adapter'].category).toEqual(['系统工具'])
  })
})


describe('StoreCatalogManager 搜索按匹配程度排序', () => {
  const catalog = [
    { id: 'ocr-pro', name: '图片识字增强', description: '截图后识别文字', downloads: 9000, author: 'alice', is_official: false, source_type: 'community' },
    { id: 'screenshot', name: '截图历史', description: '查看截图', downloads: 10, author: 'ZTools Team', is_official: true },
    { id: 'snip', name: '截图标注', description: '', downloads: 500, author: 'bob', is_official: false, source_type: 'community' },
    { id: 'clipboard', name: '剪贴板', description: '', downloads: 99999, author: 'carol', is_official: false, source_type: 'community' },
    { id: 'pdf-tools', name: 'PDF 工具箱', description: '合并拆分', keywords: ['pdf', '合并'], downloads: 3, author: 'dave', is_official: false, source_type: 'community' }
  ]
  const manager = () => new StoreCatalogManager({
    apiBaseUrl: '',
    getStaticCatalog: async () => ({ plugins: catalog }),
    getOfficialList: () => []
  })

  it('有搜索词时先按匹配程度，同档官方在前、再按下载量；只在描述里出现的排最后', async () => {
    const res = await manager().query({ keyword: '截图' })
    expect(res.list.map((p) => p.pluginId)).toEqual(['screenshot', 'snip', 'ocr-pro'])
    expect(res.total).toBe(3)
  })

  it('拼音、首字母与触发词都能搜到；没有搜索词时保持官方置顶 + 下载量排序', async () => {
    const m = manager()
    expect((await m.query({ keyword: 'jt' })).list[0].pluginId).toBe('screenshot')
    expect((await m.query({ keyword: 'jietu' })).list.map((p) => p.pluginId)).toEqual(['screenshot', 'snip'])
    expect((await m.query({ keyword: '合并' })).list.map((p) => p.pluginId)).toEqual(['pdf-tools'])
    expect((await m.query({ keyword: 'alice' })).list.map((p) => p.pluginId)).toEqual(['ocr-pro'])
    const all = await m.query({})
    expect(all.list[0].pluginId).toBe('screenshot')
    expect(all.list.slice(1).map((p) => p.pluginId)).toEqual(['clipboard', 'ocr-pro', 'snip', 'pdf-tools'])
  })

  it('[边界] 搜索词只有空白视为没有搜索词；匹配不到返回空页', async () => {
    const m = manager()
    expect((await m.query({ keyword: '   ' })).total).toBe(catalog.length)
    expect(await m.query({ keyword: '不存在的插件' })).toMatchObject({ list: [], total: 0, lastPage: 1 })
  })
})
