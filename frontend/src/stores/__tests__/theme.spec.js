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
    vi.unstubAllGlobals()
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

  it('只有旧版本地主题缓存时同步到宿主，保持原来的选择', async () => {
    localStorage.setItem('ztools_theme', 'dark')
    const set = vi.fn().mockResolvedValue(true)
    global.window.ztools = { config: { get: vi.fn().mockResolvedValue(null), set } }
    const store = useThemeStore()
    await store.init()
    expect(set).toHaveBeenCalledWith('ui.theme', 'dark', true, 'user_settings.json')
    expect(store.mode).toBe('dark')
    expect(store.isDark).toBe(true)
  })

  it('init 从 ztools.sys.getInfo 读取主题（config 无值时）', async () => {
    const setDarkMode = vi.fn().mockResolvedValue(true)
    global.window.ztools = {
      config: { get: vi.fn().mockResolvedValue(null) },
      sys: { getInfo: vi.fn().mockResolvedValue({ darkMode: true }), setDarkMode }
    }
    const store = useThemeStore()
    await store.init()
    expect(store.isDark).toBe(true)
    expect(store.mode).toBe('system')
    expect(setDarkMode).not.toHaveBeenCalled()
  })

  it('选择跟随系统后使用宿主当前颜色，并响应后续主题变化', async () => {
    const set = vi.fn().mockResolvedValue(true)
    const setDarkMode = vi.fn().mockResolvedValue(true)
    global.window.ztools = {
      config: { get: vi.fn().mockResolvedValue('dark'), set },
      sys: { getInfo: vi.fn().mockResolvedValue({ darkMode: false }), setDarkMode }
    }
    const store = useThemeStore()
    await store.init()
    expect(store.mode).toBe('dark')
    await store.setTheme('system')
    expect(set).toHaveBeenCalledWith('ui.theme', 'system', true, 'user_settings.json')
    expect(setDarkMode).not.toHaveBeenCalled()
    expect(store.mode).toBe('system')
    expect(store.isDark).toBe(false)
    store.handleSystemThemeChange(true, 'system')
    expect(store.mode).toBe('system')
    expect(store.isDark).toBe(true)
    store.handleSystemThemeChange(false, 'system')
    expect(store.isDark).toBe(false)
  })

  it('宿主通知颜色未改变但模式已变时，仍同步选中的模式', async () => {
    const store = useThemeStore()
    await store.setTheme('light')
    store.handleSystemThemeChange(false, 'system')
    expect(store.mode).toBe('system')
    expect(store.isDark).toBe(false)
  })

  it('浏览器中跟随系统变化，固定主题不受系统变化影响', async () => {
    let listener
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: (_type, callback) => { listener = callback }
    })))
    const store = useThemeStore()
    await store.init()
    listener({ matches: true })
    expect(store.isDark).toBe(true)
    await store.setTheme('light')
    listener({ matches: true })
    expect(store.mode).toBe('light')
    expect(store.isDark).toBe(false)
  })

  it('读取系统颜色期间收到更新时，不让旧结果覆盖新颜色', async () => {
    let resolveInfo
    global.window.ztools = {
      config: { set: vi.fn().mockResolvedValue(true) },
      sys: { getInfo: () => new Promise(resolve => { resolveInfo = resolve }) }
    }
    const store = useThemeStore()
    const saving = store.setTheme('system')
    await vi.waitFor(() => expect(resolveInfo).toBeTypeOf('function'))
    store.handleSystemThemeChange(true, 'system')
    resolveInfo({ darkMode: false })
    await saving
    expect(store.isDark).toBe(true)
  })

  it('保存失败时保留原有主题选择', async () => {
    global.window.ztools = { config: { set: vi.fn().mockResolvedValue(false) } }
    const store = useThemeStore()
    await expect(store.setTheme('dark')).rejects.toThrow('主题设置未保存')
    expect(store.mode).toBe('system')
    expect(store.isDark).toBe(false)
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
