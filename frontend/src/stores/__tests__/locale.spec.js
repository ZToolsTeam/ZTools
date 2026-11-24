import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLocaleStore } from '@/stores/locale'
import { useEventsStore } from '@/stores/events'
import { i18n, LOCALE_STORAGE_KEY, setI18nLocale } from '@/i18n'

describe('useLocaleStore', () => {
  let store = null
  let eventsStore = null

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    delete window.__ztoolsElectron
    window.ztools = undefined
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    store?.destroy?.()
    store = null
    eventsStore?.destroy?.()
    eventsStore = null
    localStorage.clear()
    delete window.__ztoolsElectron
    window.ztools = undefined
    vi.restoreAllMocks()
  })

  it('setLocale 持久化到 config 与 localStorage，并同步更新 i18n 与 html[lang]', async () => {
    const configSet = vi.fn().mockResolvedValue(true)
    window.ztools = {
      config: { set: configSet, get: vi.fn().mockResolvedValue(null) }
    }

    store = useLocaleStore()
    await store.setLocale('en-US')

    expect(configSet).toHaveBeenCalledWith('ui.locale', 'en-US', true, 'user_settings.json')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')
    expect(store.setting).toBe('en-US')
    expect(store.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')

    await store.setLocale('zh-CN')
    expect(store.setting).toBe('zh-CN')
    expect(store.locale).toBe('zh-CN')
    expect(i18n.global.locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('setLocale 拒绝非法语言值并在宿主保存失败时抛错且不污染状态', async () => {
    const configSet = vi.fn().mockResolvedValue(false)
    window.ztools = {
      config: { set: configSet }
    }
    store = useLocaleStore()
    store.setting = 'zh-CN'
    store.locale = 'zh-CN'

    await expect(store.setLocale('fr-FR')).rejects.toThrow()
    await expect(store.setLocale(null)).rejects.toThrow()
    await expect(store.setLocale('en-US')).rejects.toThrow()

    expect(store.setting).toBe('zh-CN')
    expect(store.locale).toBe('zh-CN')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull()
  })

  it('init 监听 storage 事件并与 eventsStore 协同响应 system.LocaleChange（无重复订阅）', async () => {
    const listeners = new Map()
    const subscribe = vi.fn().mockResolvedValue(true)
    const on = vi.fn((event, cb) => {
      const list = listeners.get(event) || []
      list.push(cb)
      listeners.set(event, list)
    })
    const off = vi.fn((event, cb) => {
      const list = listeners.get(event) || []
      listeners.set(event, list.filter((fn) => fn !== cb))
    })
    window.ztools = {
      config: { get: vi.fn().mockResolvedValue('system'), set: vi.fn().mockResolvedValue(true) },
      events: { subscribe, on, off }
    }

    store = useLocaleStore()
    eventsStore = useEventsStore()
    const handleSpy = vi.spyOn(store, 'handleSystemLocaleChange')

    await store.init()
    await eventsStore.init()

    // system.LocaleChange 仅由 eventsStore 唯一订阅一次，绝不重复触发
    const localeSubCalls = subscribe.mock.calls.filter(([evt]) => evt === 'system.LocaleChange')
    expect(localeSubCalls).toHaveLength(1)
    expect(listeners.get('system.LocaleChange')).toHaveLength(1)

    // 1. 宿主推送系统语言切换（当前为 system 模式）
    for (const cb of listeners.get('system.LocaleChange')) {
      cb({ payload: { systemLocale: 'en-US' } })
    }
    expect(handleSpy).toHaveBeenCalledTimes(1)
    expect(store.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')

    // 2. 另一窗口修改 localStorage.ztools_locale
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LOCALE_STORAGE_KEY,
        newValue: 'zh-CN'
      })
    )
    expect(store.setting).toBe('zh-CN')
    expect(store.locale).toBe('zh-CN')
    expect(i18n.global.locale.value).toBe('zh-CN')

    // 3. 固定为 zh-CN 后，系统语言变化不应覆盖用户显式选择
    for (const cb of listeners.get('system.LocaleChange')) {
      cb({ payload: { systemLocale: 'en-US' } })
    }
    expect(handleSpy).toHaveBeenCalledTimes(2)
    expect(store.locale).toBe('zh-CN')
  })

  it('eventsStore 收到 system.LocaleChange 时同步转发至 localeStore.applyHostLocale', async () => {
    const listeners = new Map()
    const subscribe = vi.fn().mockResolvedValue(true)
    window.ztools = {
      config: { get: vi.fn().mockResolvedValue('system'), set: vi.fn().mockResolvedValue(true) },
      events: {
        subscribe,
        on: vi.fn((event, cb) => listeners.set(event, cb)),
        off: vi.fn((event) => listeners.delete(event))
      }
    }

    store = useLocaleStore()
    store.setting = 'system'
    eventsStore = useEventsStore()
    await eventsStore.init()

    expect(subscribe).toHaveBeenCalledWith('system.LocaleChange')
    expect(listeners.has('system.LocaleChange')).toBe(true)

    listeners.get('system.LocaleChange')({ payload: { systemLocale: 'en-US' } })
    expect(store.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
  })

  it('[边界] localStorage 为空且 electronInitial 来自显式设置时，不误覆盖 systemLocale', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    window.__ztoolsElectron = { initialLocale: 'en-US' }
    window.ztools = {
      config: {
        get: vi.fn().mockResolvedValue('en-US'),
        set: vi.fn().mockResolvedValue(true)
      }
    }

    store = useLocaleStore()
    await store.init()

    expect(store.setting).toBe('en-US')
    expect(store.locale).toBe('en-US')
    expect(store.systemLocale).toBe('zh-CN')

    // 用户随后切回“跟随系统”，应恢复为真实系统语言 zh-CN 而非被误覆盖的 en-US
    await store.setLocale('system')
    expect(store.setting).toBe('system')
    expect(store.locale).toBe('zh-CN')
    expect(i18n.global.locale.value).toBe('zh-CN')
  })

  it('[启动优先级统一] localStorage 残留旧缓存且 __ztoolsElectron.initialLocale 存在时，同步阶段优先采用 initialLocale 避免二次闪屏', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
    window.__ztoolsElectron = { initialLocale: 'en-US' }

    let resolveConfigGet
    window.ztools = {
      config: {
        get: vi.fn(() => new Promise((resolve) => { resolveConfigGet = resolve })),
        set: vi.fn().mockResolvedValue(true)
      }
    }

    store = useLocaleStore()
    const applySpy = vi.spyOn(store, '_applyLocale')
    const initPromise = store.init()

    // 同步阶段直接切到 electronInitial ('en-US')，不先闪回 localStorage 的 'zh-CN'
    expect(store.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(applySpy).toHaveBeenNthCalledWith(1, 'en-US')
    expect(store.systemLocale).toBe('zh-CN')

    resolveConfigGet('en-US')
    await initPromise
    expect(store.setting).toBe('en-US')
    expect(store.locale).toBe('en-US')
    expect(store.systemLocale).toBe('zh-CN')
  })

  it('handleSystemLocaleChange 收到 locale 或裸字符串通知时不篡改真实 systemLocale', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    store = useLocaleStore()
    store.setting = 'system'
    store.systemLocale = 'zh-CN'

    // 1. 仅推送 { locale: 'en-US' }：可切换当前显示语言，但不篡改 systemLocale
    store.handleSystemLocaleChange({ payload: { locale: 'en-US' } })
    expect(store.systemLocale).toBe('zh-CN')
    expect(store.locale).toBe('en-US')

    // 2. 裸字符串通知同样不篡改 systemLocale
    store.handleSystemLocaleChange('en-US')
    expect(store.systemLocale).toBe('zh-CN')
    expect(store.locale).toBe('en-US')

    // 3. 推送 { setting: 'en-US', locale: 'en-US' }：更新 setting 与显示语言，不篡改 systemLocale
    store.handleSystemLocaleChange({ payload: { setting: 'en-US', locale: 'en-US' } })
    expect(store.setting).toBe('en-US')
    expect(store.locale).toBe('en-US')
    expect(store.systemLocale).toBe('zh-CN')

    // 4. 用户固定在 zh-CN 时，仅收到 { locale: 'en-US' }（无 setting）不覆盖用户显式设置，也不篡改 systemLocale
    store.setting = 'zh-CN'
    store.handleSystemLocaleChange({ payload: { locale: 'en-US' } })
    expect(store.systemLocale).toBe('zh-CN')
    expect(store.locale).toBe('zh-CN')

    // 5. 仅在明确收到 systemLocale 字段时才更新 systemLocale
    store.setting = 'system'
    store.handleSystemLocaleChange({ payload: { systemLocale: 'en-US' } })
    expect(store.systemLocale).toBe('en-US')
    expect(store.locale).toBe('en-US')
  })
})
