import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useThemeStore } from '../theme'

describe('useThemeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    // 重置 DOM
    document.documentElement.classList.remove('dark')
    // 重置 window.ztools
    global.window.ztools = undefined
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('初始状态 isDark 为 false', () => {
    const store = useThemeStore()
    expect(store.isDark).toBe(false)
  })

  it('toggle 切换暗色模式', async () => {
    const store = useThemeStore()
    await store.toggle()
    expect(store.isDark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    await store.toggle()
    expect(store.isDark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setTheme("dark") 应用暗色', async () => {
    const store = useThemeStore()
    await store.setTheme('dark')
    expect(store.isDark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setTheme("light") 应用亮色', async () => {
    const store = useThemeStore()
    await store.setTheme('dark')
    await store.setTheme('light')
    expect(store.isDark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('handleSystemThemeChange 响应系统主题变化', () => {
    const store = useThemeStore()
    store.handleSystemThemeChange(true)
    expect(store.isDark).toBe(true)
    store.handleSystemThemeChange(false)
    expect(store.isDark).toBe(false)
  })

  it('init 从 ztools.config 读取主题', async () => {
    global.window.ztools = {
      config: { get: vi.fn().mockResolvedValue('dark') }
    }
    const store = useThemeStore()
    await store.init()
    expect(store.isDark).toBe(true)
  })

  it('init 从 ztools.sys.getInfo 读取主题（config 无值时）', async () => {
    global.window.ztools = {
      config: { get: vi.fn().mockResolvedValue(null) },
      sys: { getInfo: vi.fn().mockResolvedValue({ darkMode: true }) }
    }
    const store = useThemeStore()
    await store.init()
    expect(store.isDark).toBe(true)
  })

  it('init 防重入：多次调用只执行一次', async () => {
    const configGet = vi.fn().mockResolvedValue('light')
    global.window.ztools = { config: { get: configGet } }
    const store = useThemeStore()
    await Promise.all([store.init(), store.init(), store.init()])
    expect(configGet).toHaveBeenCalledTimes(1)
  })

  it('toggle 调用 ztools.config.set 保存主题', async () => {
    const configSet = vi.fn().mockResolvedValue(true)
    global.window.ztools = { config: { set: configSet } }
    const store = useThemeStore()
    await store.toggle()
    expect(configSet).toHaveBeenCalledWith('ui.theme', 'dark', true, 'user_settings.json')
  })
})
