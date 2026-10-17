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
    expect(calc.category).toBe('办公效率')
    expect(calc.downloads).toBe(845)
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
    const builtinClipboard = { id: 'clipboard-history', pluginId: 'clipboard-history', name: '剪贴板历史' }
    const { catalog } = await createManager(
      [{ id: 'clipboard-history', name: '剪贴板', platforms: ['darwin', 'windows'] }],
      [builtinClipboard]
    ).ensureCatalog(true)
    expect(catalog.find((p) => p.pluginId === 'clipboard-history')).toBeUndefined()
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
