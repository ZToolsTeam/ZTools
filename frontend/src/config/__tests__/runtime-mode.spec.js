import { afterEach, describe, expect, it, vi } from 'vitest'

// 单机模式：未配置 VITE_API_BASE_URL 时不得发出任何后台请求
describe('单机模式', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadOffline() {
    vi.stubEnv('VITE_API_BASE_URL', '')
    vi.resetModules()
    const adapter = vi.fn()
    const { default: http } = await import('@/utils/http')
    http.defaults.adapter = adapter
    return { http, adapter }
  }

  it('isOnline 为 false', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    vi.resetModules()
    const mode = await import('@/config/runtime-mode')
    expect(mode.isOnline).toBe(false)
  })

  it('http 请求在发出前被拒绝且不触达 adapter', async () => {
    const { http, adapter } = await loadOffline()
    const { isOfflineError } = await import('@/config/runtime-mode')
    await expect(http.get('/api/anything')).rejects.toSatisfy(isOfflineError)
    expect(adapter).not.toHaveBeenCalled()
  })

  it('商城与更新接口返回空结果且不发请求', async () => {
    const { adapter } = await loadOffline()
    const plugins = await import('@/api/plugins')
    const update = await import('@/api/update')

    expect(await plugins.getCategories()).toEqual([])
    expect((await plugins.getMarketPlugins({ page: 2 })).list).toEqual([])
    expect(await update.batchCheckPlugins({ plugins: [{ id: 'a', version: '1.0.0' }] })).toEqual({})
    expect(await update.checkPluginUpdate('a')).toEqual({ hasUpdate: false })
    expect(adapter).not.toHaveBeenCalled()
  })

  it('详情回退到本地已安装插件', async () => {
    vi.stubGlobal('window', {
      ...globalThis.window,
      ztools: {
        plugin: {
          getList: vi.fn().mockResolvedValue({ data: [{ pluginId: 'local-a', name: 'A' }] })
        }
      }
    })
    const { adapter } = await loadOffline()
    const plugins = await import('@/api/plugins')
    const { isOfflineError } = await import('@/config/runtime-mode')

    expect(await plugins.getPluginDetails('local-a')).toMatchObject({ id: 'local-a', name: 'A' })
    await expect(plugins.getPluginDetails('missing')).rejects.toSatisfy(isOfflineError)
    expect(adapter).not.toHaveBeenCalled()
  })
})
