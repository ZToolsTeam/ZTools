import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useThemeStore } from '../theme'
import { useEventsStore } from '../events'
import { ACCENT_THEMES } from '@/constants/themes'

describe('useThemeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    // 重置 DOM
    document.documentElement.classList.remove('dark')
    delete document.documentElement.dataset.accent
    // 重置 window.ztools
    global.window.ztools = undefined
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('初始状态 isDark 为 false，默认主题色为 ember', () => {
    const store = useThemeStore()
    expect(store.isDark).toBe(false)
    expect(store.accent).toBe('ember')
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

  it('init 从 ztools.config 读取明暗主题与固定主题色', async () => {
    global.window.ztools = {
      config: {
        get: vi.fn(async (key) => {
          if (key === 'ui.theme') return 'dark'
          if (key === 'ui.accent') return 'glacier'
          return null
        })
      }
    }
    const store = useThemeStore()
    await store.init()
    expect(store.isDark).toBe(true)
    expect(store.accent).toBe('glacier')
    expect(document.documentElement.dataset.accent).toBe('glacier')
  })

  it('只有旧版本地缓存时同步明暗主题与主题色到宿主，保持原来的选择', async () => {
    localStorage.setItem('ztools_theme', 'dark')
    localStorage.setItem('ztools_accent', 'jade')
    const set = vi.fn().mockResolvedValue(true)
    global.window.ztools = { config: { get: vi.fn().mockResolvedValue(null), set } }
    const store = useThemeStore()
    await store.init()
    expect(set).toHaveBeenCalledWith('ui.theme', 'dark', true, 'user_settings.json')
    expect(set).toHaveBeenCalledWith('ui.accent', 'jade', true, 'user_settings.json')
    expect(store.mode).toBe('dark')
    expect(store.isDark).toBe(true)
    expect(store.accent).toBe('jade')
    expect(document.documentElement.dataset.accent).toBe('jade')
  })

  it('init 从 ztools.sys.getInfo 读取主题（config 无值时），非法主题色安全降级为 ember', async () => {
    const setDarkMode = vi.fn().mockResolvedValue(true)
    global.window.ztools = {
      config: {
        get: vi.fn(async (key) => (key === 'ui.accent' ? 'invalid-custom-hex' : null))
      },
      sys: { getInfo: vi.fn().mockResolvedValue({ darkMode: true }), setDarkMode }
    }
    const store = useThemeStore()
    await store.init()
    expect(store.isDark).toBe(true)
    expect(store.mode).toBe('system')
    expect(store.accent).toBe('ember')
    expect(document.documentElement.dataset.accent).toBe('ember')
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

  it('init 防重入：多次并发调用只执行一轮配置读取', async () => {
    const configGet = vi.fn().mockResolvedValue('light')
    global.window.ztools = { config: { get: configGet } }
    const store = useThemeStore()
    await Promise.all([store.init(), store.init(), store.init()])
    // 单轮初始化仅读取 ui.theme 与 ui.accent 各 1 次
    expect(configGet).toHaveBeenCalledTimes(2)
  })

  it('toggle 调用 ztools.config.set 保存主题', async () => {
    const configSet = vi.fn().mockResolvedValue(true)
    global.window.ztools = { config: { set: configSet } }
    const store = useThemeStore()
    await store.toggle()
    expect(configSet).toHaveBeenCalledWith('ui.theme', 'dark', true, 'user_settings.json')
  })

  describe('6 款固定主题色（无自定义色值）全链路与异常边界', () => {
    it('逐一切换全部 6 款固定主题色均同步写入宿主配置、localStorage 与 DOM data-accent', async () => {
      expect(ACCENT_THEMES).toEqual(['ember', 'glacier', 'jade', 'iris', 'crimson', 'mono'])
      const configSet = vi.fn().mockResolvedValue(true)
      global.window.ztools = { config: { set: configSet } }
      const store = useThemeStore()

      for (const accent of ACCENT_THEMES) {
        await store.setAccent(accent)
        expect(store.accent).toBe(accent)
        expect(document.documentElement.dataset.accent).toBe(accent)
        expect(localStorage.getItem('ztools_accent')).toBe(accent)
        expect(configSet).toHaveBeenLastCalledWith('ui.accent', accent, true, 'user_settings.json')
      }
    })

    it('[边界防御] 拒绝任意非固定预设或自定义色值，保持当前状态不变', async () => {
      const store = useThemeStore()
      await store.setAccent('iris')

      for (const badInput of ['#ff0000', 'rgb(0,0,0)', 'purple', '', null, undefined, 123]) {
        await expect(store.setAccent(badInput)).rejects.toThrow('不支持的主题色')
      }
      expect(store.accent).toBe('iris')
      expect(document.documentElement.dataset.accent).toBe('iris')
    })

    it('[故障注入] 宿主保存主题色返回 false 或抛出 IPC 错误时回滚拒绝且不污染 DOM', async () => {
      const configSet = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('磁盘只读'))
      global.window.ztools = { config: { set: configSet } }
      const store = useThemeStore()

      await store.setAccent('crimson')
      await expect(store.setAccent('mono')).rejects.toThrow('主题色设置未保存')
      expect(store.accent).toBe('crimson')
      expect(document.documentElement.dataset.accent).toBe('crimson')

      await expect(store.setAccent('glacier')).rejects.toThrow('磁盘只读')
      expect(store.accent).toBe('crimson')
      expect(document.documentElement.dataset.accent).toBe('crimson')
    })

    it('[并发竞态] 慢速 setAccent 挂起期间收到更新选择或跨窗口广播时，旧结果不覆盖新主题色', async () => {
      let resolveFirstSave
      const configSet = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstSave = resolve }))
        .mockResolvedValueOnce(true)
      global.window.ztools = { config: { set: configSet } }
      const store = useThemeStore()

      const firstTask = store.setAccent('glacier')
      await vi.waitFor(() => expect(resolveFirstSave).toBeTypeOf('function'))
      await store.setAccent('mono')
      expect(store.accent).toBe('mono')

      resolveFirstSave(true)
      await firstTask
      expect(store.accent).toBe('mono')
      expect(document.documentElement.dataset.accent).toBe('mono')
    })

    it('[跨模块与成对清理] EventsStore 订阅 system.AccentColorChange 同步更新主题色，destroy 后解除监听', async () => {
      const handlers = new Map()
      const subscribe = vi.fn().mockResolvedValue(true)
      const on = vi.fn((event, fn) => handlers.set(event, fn))
      const off = vi.fn((event, fn) => {
        if (handlers.get(event) === fn) handlers.delete(event)
      })
      global.window.ztools = { events: { subscribe, on, off } }

      const themeStore = useThemeStore()
      const eventsStore = useEventsStore()
      await eventsStore.init()

      expect(subscribe).toHaveBeenCalledWith('system.AccentColorChange')
      const handler = handlers.get('system.AccentColorChange')
      expect(handler).toBeTypeOf('function')

      handler({ payload: { accent: 'jade' } })
      expect(themeStore.accent).toBe('jade')
      expect(document.documentElement.dataset.accent).toBe('jade')

      // 非法负载不破坏现有主题色
      handler({ payload: { accent: '#00ff00' } })
      expect(themeStore.accent).toBe('jade')

      eventsStore.destroy()
      expect(off).toHaveBeenCalledWith('system.AccentColorChange', handler)
      expect(handlers.has('system.AccentColorChange')).toBe(false)
    })
  })
})
