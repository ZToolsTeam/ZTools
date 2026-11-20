import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLocaleStore } from '@/stores/locale'
import { useEventsStore } from '@/stores/events'
import { i18n, LOCALE_STORAGE_KEY, setI18nLocale } from '@/i18n'

describe('useLocaleStore', () => {
  let store = null

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

  it('init 监听 storage 事件与 system.LocaleChange 事件实现多窗口与系统语言同步', async () => {
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
    await store.init()

    expect(subscribe).toHaveBeenCalledWith('system.LocaleChange')
    expect(listeners.has('system.LocaleChange')).toBe(true)

    // 1. 宿主推送系统语言切换（当前为 system 模式）
    listeners.get('system.LocaleChange')({ payload: { systemLocale: 'en-US' } })
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
    listeners.get('system.LocaleChange')({ payload: { systemLocale: 'en-US' } })
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
    const eventsStore = useEventsStore()
    await eventsStore.init()

    expect(subscribe).toHaveBeenCalledWith('system.LocaleChange')
    expect(listeners.has('system.LocaleChange')).toBe(true)

    listeners.get('system.LocaleChange')({ payload: { systemLocale: 'en-US' } })
    expect(store.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')

    eventsStore.cleanup?.()
  })
})
