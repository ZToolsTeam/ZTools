import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import zhCN from '@/locales/zh-CN.json'
import enUS from '@/locales/en-US.json'
import * as ossEdition from '@/edition-oss/index.js'
import * as activeEdition from '@edition'
import {
  i18n,
  messages,
  t,
  setI18nLocale,
  getCurrentLocale,
  detectInitialLocale,
  mergeLocaleMessages
} from '@/i18n'
import { useLocaleStore } from '@/stores/locale'
import ThemeProvider from '@/components/ThemeProvider.vue'

function collectLeafKeys(obj, prefix = '') {
  const keys = []
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      keys.push(...collectLeafKeys(val, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys.sort()
}

describe('i18n 底座与 Open-Core 词条隔离', () => {
  const originalLocale = getCurrentLocale()

  afterEach(() => {
    setI18nLocale(originalLocale)
  })

  it('zh-CN.json 与 en-US.json 词条键集合完全一致且无空串', () => {
    const zhKeys = collectLeafKeys(zhCN)
    const enKeys = collectLeafKeys(enUS)
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBeGreaterThan(100)

    const checkNonEmpty = (obj) => {
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') checkNonEmpty(val)
        else expect(typeof val === 'string' && val.trim().length > 0).toBe(true)
      }
    }
    checkNonEmpty(zhCN)
    checkNonEmpty(enUS)
  })

  it('mergeLocaleMessages 正确合并 @edition 扩展词条并忽略原型污染键', () => {
    const base = {
      'zh-CN': { nav: { feedback: '反馈' } },
      'en-US': { nav: { feedback: 'Feedback' } }
    }
    const extra = {
      'zh-CN': { commercial: { auth: { login: '登录' } } },
      'en-US': { commercial: { auth: { login: 'Sign In' } } }
    }
    const merged = mergeLocaleMessages(base, extra)
    expect(merged['zh-CN'].nav.feedback).toBe('反馈')
    expect(merged['zh-CN'].commercial.auth.login).toBe('登录')
    expect(merged['en-US'].commercial.auth.login).toBe('Sign In')
    // 不污染源对象
    expect(base['zh-CN'].commercial).toBeUndefined()

    // 空 extra 返回基础词条副本
    const ossMerged = mergeLocaleMessages(base, Object.freeze({}))
    expect(ossMerged['zh-CN'].nav.feedback).toBe('反馈')
    expect(ossMerged['zh-CN'].commercial).toBeUndefined()
  })

  it('Open-Core 契约：edition-oss 导出空 localeMessages，当前 @edition 合规且 i18n/index.js 不直接引用 commercial', () => {
    expect(ossEdition.localeMessages).toEqual({})
    expect(Object.isFrozen(ossEdition.localeMessages)).toBe(true)
    expect(ossEdition.feedbackEntry.title).toBe('反馈建议')
    expect(ossEdition.feedbackEntry.titleKey).toBe('nav.feedback')

    expect(activeEdition.feedbackEntry.title).toBe('反馈建议')
    expect(activeEdition.feedbackEntry.titleKey).toBe('nav.feedback')
    expect(typeof activeEdition.localeMessages).toBe('object')

    if (activeEdition.EDITION === 'commercial') {
      expect(messages['zh-CN'].commercial).toBeTruthy()
      expect(messages['en-US'].commercial).toBeTruthy()
      setI18nLocale('en-US')
      expect(t('commercial.auth.loginTitle')).toBe('Sign in to ZTools')
      expect(t('commercial.headerUser.login')).toBe('Sign In')
      setI18nLocale('zh-CN')
      expect(t('commercial.auth.loginTitle')).toBe('登录 ZTools')
      expect(t('commercial.headerUser.login')).toBe('登录')
    }

    const i18nSource = readFileSync(path.resolve(__dirname, '../index.js'), 'utf-8')
    expect(i18nSource).not.toMatch(/commercial/)
  })

  it('detectInitialLocale 严格遵循 __ztoolsElectron.initialLocale > localStorage > navigator.language', () => {
    // 1. 优先 __ztoolsElectron.initialLocale
    expect(
      detectInitialLocale({
        window: { __ztoolsElectron: { initialLocale: 'en-US' } },
        localStorage: { getItem: () => 'zh-CN' },
        navigator: { language: 'zh-CN' }
      })
    ).toBe('en-US')

    // 2. 次选 localStorage.ztools_locale
    expect(
      detectInitialLocale({
        window: {},
        localStorage: { getItem: () => 'zh-CN' },
        navigator: { language: 'en-US' }
      })
    ).toBe('zh-CN')

    // 3. 当 localStorage 为 system 时回落 navigator.language
    expect(
      detectInitialLocale({
        window: {},
        localStorage: { getItem: () => 'system' },
        navigator: { language: 'zh-TW' }
      })
    ).toBe('zh-CN')

    // 4. localStorage 抛错时静默回落 navigator.language
    expect(
      detectInitialLocale({
        window: {},
        localStorage: {
          getItem: () => {
            throw new Error('SecurityError')
          }
        },
        navigator: { language: 'en-GB' }
      })
    ).toBe('en-US')
  })

  it('setI18nLocale 同步更新 vue-i18n locale、翻译输出、document.documentElement.lang 与 document.title', () => {
    setI18nLocale('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe(t('app.windowTitle'))
    expect(document.title).toBe('ZTools - Free, Clean Productivity Hub')
    expect(t('settings.title')).toBe('Settings')

    setI18nLocale('zh-CN')
    expect(i18n.global.locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.title).toBe(t('app.windowTitle'))
    expect(document.title).toBe('ZTools - 免费纯净的高效办公工具箱')
    expect(t('settings.title')).toBe('设置')
  })

  it('ThemeProvider 随 localeStore.locale 动态切换 ant-design-vue 的 zhCN / enUS', async () => {
    setActivePinia(createPinia())
    const localeStore = useLocaleStore()
    await localeStore.setLocale('zh-CN')

    const Child = defineComponent({
      setup() {
        return () => h('div', 'child')
      }
    })
    const wrapper = mount(ThemeProvider, {
      slots: { default: () => h(Child) }
    })

    const provider = wrapper.findComponent({ name: 'AConfigProvider' })
    expect(provider.props('locale')?.locale).toBe('zh-cn')

    await localeStore.setLocale('en-US')
    await nextTick()
    expect(provider.props('locale')?.locale).toBe('en')

    wrapper.unmount()
  })
})
