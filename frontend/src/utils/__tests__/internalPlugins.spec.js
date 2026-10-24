import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INTERNAL_PLUGINS,
  INTERNAL_PLUGIN_DEFINITIONS,
  isPluginApiAvailable,
  openInternalPlugin,
  openSettings,
  openDevTools
} from '../internalPlugins'

describe('internalPlugins 门面', () => {
  beforeEach(() => {
    delete window.ztools
    delete window.__ztoolsToast
    delete window.__openShortcutSettings
    delete window.__scrollToSuperPanelSettings
    vi.restoreAllMocks()
  })

  it('常量定义完备且不可变', () => {
    expect(INTERNAL_PLUGINS.SETTINGS).toBe('internal-settings')
    expect(INTERNAL_PLUGINS.DEVELOPER).toBe('internal-developer')
    expect(INTERNAL_PLUGIN_DEFINITIONS[INTERNAL_PLUGINS.SETTINGS].fallbackRoute.name).toBe('advanced-settings')
    expect(INTERNAL_PLUGIN_DEFINITIONS[INTERNAL_PLUGINS.DEVELOPER].fallbackRoute.name).toBe('devtools')
  })

  it('isPluginApiAvailable 正确感知原生环境', () => {
    expect(isPluginApiAvailable()).toBe(false)

    window.ztools = { plugin: { open: vi.fn() } }
    expect(isPluginApiAvailable()).toBe(true)
  })

  it('原生环境下优先调用 window.ztools.plugin.open 并返回原生成功结果', async () => {
    const mockOpen = vi.fn().mockResolvedValue({ success: true, instanceId: 'inst-1' })
    window.ztools = { plugin: { open: mockOpen } }

    const res = await openInternalPlugin('internal-settings', { foo: 'bar' })
    expect(mockOpen).toHaveBeenCalledWith('internal-settings', { foo: 'bar' })
    expect(res).toEqual({
      success: true,
      native: true,
      type: 'native',
      data: { success: true, instanceId: 'inst-1' }
    })
  })

  it('校验 payload 参数类型与超限情况', async () => {
    await expect(openInternalPlugin('internal-settings', 'invalid-payload')).rejects.toThrow(TypeError)
    await expect(openInternalPlugin('internal-settings', [1, 2, 3])).rejects.toThrow(TypeError)

    const hugePayload = { big: 'x'.repeat(65 * 1024) }
    await expect(openInternalPlugin('internal-settings', hugePayload)).rejects.toThrow(RangeError)
  })

  it('纯 Web 环境或原生调用失败时，优雅降级导航到本地路由', async () => {
    const mockRouter = { push: vi.fn().mockResolvedValue(true) }

    // 纯 Web 环境：无 window.ztools
    const res = await openInternalPlugin('internal-settings', undefined, { router: mockRouter })
    expect(mockRouter.push).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'advanced-settings' })
    )
    expect(res.success).toBe(true)
    expect(res.fallback).toBe(true)
    expect(res.type).toBe('route')
  })

  it('openSettings 传递控制参数并同步全局标记与降级路由 query', async () => {
    const mockRouter = { push: vi.fn().mockResolvedValue(true) }

    await openSettings({
      scrollToSuperPanelSettings: true,
      openShortcutSettings: true,
      router: mockRouter
    })

    expect(window.__scrollToSuperPanelSettings).toBe(true)
    expect(window.__openShortcutSettings).toBe(true)
    expect(mockRouter.push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'advanced-settings',
        query: expect.objectContaining({
          scrollToSuperPanelSettings: 'true',
          openShortcutSettings: 'true'
        })
      })
    )
  })

  it('openDevTools 在降级环境下导航到 devtools 路由', async () => {
    const mockRouter = { push: vi.fn().mockResolvedValue(true) }

    const res = await openDevTools({ router: mockRouter })
    expect(mockRouter.push).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'devtools' })
    )
    expect(res.success).toBe(true)
    expect(res.fallback).toBe(true)
  })

  it('无路由且无原生支持时给出友好提示', async () => {
    const mockToast = vi.fn()
    window.__ztoolsToast = mockToast

    const res = await openInternalPlugin('unknown-plugin', undefined, { router: null })
    expect(res.success).toBe(false)
    expect(res.fallback).toBe(true)
    expect(res.type).toBe('prompt')
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('unknown-plugin'))
  })

  it('preferRoute 为 true 时跳过原生 plugin.open 直接走内部路由', async () => {
    const mockOpen = vi.fn().mockResolvedValue({ success: true })
    window.ztools = { plugin: { open: mockOpen } }
    const mockRouter = { push: vi.fn().mockResolvedValue(true) }

    const res = await openInternalPlugin('internal-settings', undefined, {
      preferRoute: true,
      router: mockRouter
    })

    expect(mockOpen).not.toHaveBeenCalled()
    expect(mockRouter.push).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'advanced-settings' })
    )
    expect(res.success).toBe(true)
    expect(res.fallback).toBe(true)
    expect(res.type).toBe('route')
  })

  it('openSettings 默认启用 preferRoute，在原生环境中直接极速导航', async () => {
    const mockOpen = vi.fn().mockResolvedValue({ success: true })
    window.ztools = { plugin: { open: mockOpen } }
    const mockRouter = { push: vi.fn().mockResolvedValue(true) }

    const res = await openSettings({ router: mockRouter })

    expect(mockOpen).not.toHaveBeenCalled()
    expect(mockRouter.push).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'advanced-settings' })
    )
    expect(res.success).toBe(true)
  })

  it('当降级路由 push 发生异常时，安全降级至兜底友好提示', async () => {
    const mockToast = vi.fn()
    window.__ztoolsToast = mockToast
    const mockRouter = {
      push: vi.fn().mockRejectedValue(new Error('Navigation cancelled'))
    }

    const res = await openInternalPlugin('internal-settings', undefined, {
      preferRoute: true,
      router: mockRouter
    })

    expect(res.success).toBe(false)
    expect(res.fallback).toBe(true)
    expect(res.type).toBe('prompt')
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('系统设置'))
  })
})

