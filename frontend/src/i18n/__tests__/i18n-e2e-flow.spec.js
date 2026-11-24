import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  routeQuery: null
}))

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ query: mocks.routeQuery, name: 'advanced-settings' })
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: mocks.success,
    error: mocks.error,
    warning: mocks.warning,
    info: vi.fn(),
    toastSuccess: mocks.success,
    toastError: mocks.error
  })
}))

vi.mock('@/api/apiserver', () => ({
  isNative: false,
  getAutostart: vi.fn().mockResolvedValue(false),
  setAutostart: vi.fn().mockResolvedValue(true),
  getHotkey: vi.fn().mockResolvedValue('Alt+Space'),
  setHotkey: vi.fn().mockResolvedValue(true),
  getMinimizeToTray: vi.fn().mockResolvedValue(true),
  setMinimizeToTray: vi.fn().mockResolvedValue(true),
  getShowTrayIcon: vi.fn().mockResolvedValue(true),
  setShowTrayIcon: vi.fn().mockResolvedValue(true),
  getCloseConfirm: vi.fn().mockResolvedValue(true),
  setCloseConfirm: vi.fn().mockResolvedValue(true)
}))

import {
  i18n,
  t,
  LOCALE_STORAGE_KEY,
  detectInitialLocale,
  getCurrentLocale,
  setI18nLocale
} from '@/i18n'
import { useLocaleStore } from '@/stores/locale'
import { useEventsStore } from '@/stores/events'
import ThemeProvider from '@/components/ThemeProvider.vue'
import AdvancedSettings from '@/pages/AdvancedSettings.vue'
import EventMonitor from '@/pages/EventMonitor.vue'
import enUS from '@/locales/en-US.json'

function createHostBridge({ savedLocale = 'system' } = {}) {
  const listeners = new Map()
  const configStore = new Map([['ui.locale', savedLocale]])

  const events = {
    subscribe: vi.fn().mockResolvedValue(true),
    on: vi.fn((eventName, cb) => {
      const list = listeners.get(eventName) || []
      list.push(cb)
      listeners.set(eventName, list)
      return () => events.off(eventName, cb)
    }),
    off: vi.fn((eventName, cb) => {
      const list = listeners.get(eventName) || []
      listeners.set(eventName, list.filter((fn) => fn !== cb))
    }),
    emit: vi.fn((eventName, payload) => {
      const envelope = { type: eventName, timestamp: Date.now(), payload }
      for (const cb of listeners.get(eventName) || []) cb(envelope)
      for (const cb of listeners.get('*') || []) cb(envelope)
    })
  }

  const config = {
    get: vi.fn(async (key, fallback = null) => (configStore.has(key) ? configStore.get(key) : fallback)),
    set: vi.fn(async (key, value) => {
      configStore.set(key, value)
      return true
    })
  }

  return {
    bridge: { config, events, trigger: { list: vi.fn().mockResolvedValue([]) } },
    listeners,
    configStore
  }
}

describe('前端多语言全链路端到端场景测试（Open-Core 隔离）', () => {
  const originalLocale = getCurrentLocale()
  let pinia = null
  let localeStore = null
  let eventsStore = null

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    localStorage.clear()
    delete window.__ztoolsElectron
    window.ztools = undefined
    mocks.success.mockReset()
    mocks.error.mockReset()
    mocks.warning.mockReset()
    mocks.routeQuery = reactive({})
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    localeStore?.destroy?.()
    localeStore = null
    eventsStore?.destroy?.()
    eventsStore = null
    localStorage.clear()
    delete window.__ztoolsElectron
    window.ztools = undefined
    setI18nLocale(originalLocale)
    vi.restoreAllMocks()
  })

  it('首屏 initialLocale 探测 → 初始化渲染 → 设置页切换 en-US → 跨窗口 storage 同步 → 主进程广播 → 切回 zh-CN', async () => {
    // 1. 首屏探测：window.__ztoolsElectron.initialLocale 优先于 localStorage 与 navigator.language
    expect(
      detectInitialLocale({
        window: { __ztoolsElectron: { initialLocale: 'en-US' } },
        localStorage: { getItem: () => 'zh-CN' },
        navigator: { language: 'zh-CN' }
      })
    ).toBe('en-US')

    // 2. 初始化宿主桥与 stores（模拟宿主以 system 偏好、zh-CN 初始语言启动）
    window.__ztoolsElectron = { initialLocale: 'zh-CN' }
    const { bridge, listeners, configStore } = createHostBridge({ savedLocale: 'system' })
    window.ztools = bridge

    localeStore = useLocaleStore()
    eventsStore = useEventsStore()
    await localeStore.init()
    await eventsStore.init()

    const AppShell = defineComponent({
      setup() {
        return () =>
          h(ThemeProvider, null, {
            default: () => h(AdvancedSettings)
          })
      }
    })

    const PluginHotkeyModalStub = defineComponent({
      name: 'PluginHotkeyModal',
      setup(_, { expose }) {
        expose({ show: vi.fn(), updateMap: vi.fn() })
        return () => null
      }
    })

    const PluginFeatureHotkeyModalStub = defineComponent({
      name: 'PluginFeatureHotkeyModal',
      setup(_, { expose }) {
        expose({ show: vi.fn() })
        return () => null
      }
    })

    const wrapper = mount(AppShell, {
      global: {
        plugins: [pinia],
        stubs: {
          AppearanceSettings: true,
          BundledPluginsSettings: true,
          ScreenPermissionPanel: true,
          PluginHotkeyModal: PluginHotkeyModalStub,
          PluginFeatureHotkeyModal: PluginFeatureHotkeyModalStub,
          'a-switch': true,
          'a-slider': true,
          'a-input-number': true
        }
      }
    })

    try {
      await flushPromises()
      const provider = wrapper.findComponent({ name: 'AConfigProvider' })

      // 初始为 zh-CN
      expect(document.documentElement.lang).toBe('zh-CN')
      expect(document.title).toBe('ZTools - 免费纯净的高效办公工具箱')
      expect(provider.props('locale')?.locale).toBe('zh-cn')
      expect(wrapper.find('.page-title').text()).toBe('设置')

      // 3. 在设置页通过语言下拉框切换为 en-US
      const localeSelect = wrapper.findComponent('[data-testid="locale-select"]')
      expect(localeSelect.exists()).toBe(true)
      localeSelect.vm.$emit('update:value', 'en-US')
      await flushPromises()
      await nextTick()

      expect(configStore.get('ui.locale')).toBe('en-US')
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')
      expect(localeStore.setting).toBe('en-US')
      expect(localeStore.locale).toBe('en-US')
      expect(i18n.global.locale.value).toBe('en-US')
      expect(document.documentElement.lang).toBe('en-US')
      expect(document.title).toBe('ZTools - Free, Clean Productivity Hub')
      expect(provider.props('locale')?.locale).toBe('en')
      expect(wrapper.find('.page-title').text()).toBe('Settings')
      expect(mocks.success).toHaveBeenCalledWith('Language updated')

      // 4. 跨窗口 storage 事件同步：模拟另一窗口将语言切换为 system（当前 systemLocale 为 zh-CN）
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: LOCALE_STORAGE_KEY,
          newValue: 'system'
        })
      )
      await nextTick()
      expect(localeStore.setting).toBe('system')
      expect(localeStore.locale).toBe('zh-CN')
      expect(document.documentElement.lang).toBe('zh-CN')
      expect(document.title).toBe('ZTools - 免费纯净的高效办公工具箱')
      expect(provider.props('locale')?.locale).toBe('zh-cn')
      expect(wrapper.find('.page-title').text()).toBe('设置')

      // 5. 主进程广播 system.LocaleChange（在 system 模式下热切换至 en-US）
      expect(listeners.get('system.LocaleChange')).toHaveLength(1)
      for (const cb of listeners.get('system.LocaleChange')) {
        cb({ payload: { systemLocale: 'en-US' } })
      }
      await nextTick()
      expect(localeStore.locale).toBe('en-US')
      expect(document.documentElement.lang).toBe('en-US')
      expect(document.title).toBe('ZTools - Free, Clean Productivity Hub')
      expect(provider.props('locale')?.locale).toBe('en')
      expect(wrapper.find('.page-title').text()).toBe('Settings')

      // 6. 显式切回 zh-CN：系统语言再次广播 en-US 不应覆盖用户显式设置
      await localeStore.setLocale('zh-CN')
      await nextTick()
      expect(localeStore.setting).toBe('zh-CN')
      expect(localeStore.locale).toBe('zh-CN')
      expect(document.documentElement.lang).toBe('zh-CN')
      expect(document.title).toBe('ZTools - 免费纯净的高效办公工具箱')
      expect(provider.props('locale')?.locale).toBe('zh-cn')
      expect(wrapper.find('.page-title').text()).toBe('设置')

      for (const cb of listeners.get('system.LocaleChange')) {
        cb({ payload: { systemLocale: 'en-US' } })
      }
      await nextTick()
      expect(localeStore.locale).toBe('zh-CN')
      expect(document.documentElement.lang).toBe('zh-CN')
    } finally {
      wrapper.unmount()
    }
  })

  it('英文管道复数语法在 0 / 1 / 2 数量下输出正确单复数且绝不泄漏管道符 |', () => {
    setI18nLocale('en-US')

    const pluralCases = [
      {
        key: 'launcher.resultsCount',
        buildArgs: (n) => [{ count: n }, n],
        expected: ['0 results', '1 result', '2 results']
      },
      {
        key: 'launcher.resultsCountDegraded',
        buildArgs: (n) => [{ count: n }, n],
        expected: [
          '0 results · System index unavailable',
          '1 result · System index unavailable',
          '2 results · System index unavailable'
        ]
      },
      {
        key: 'market.partialCategoryFailed',
        buildArgs: (n) => [{ count: n }, n],
        expected: [
          '0 categories failed to load, please retry later',
          '1 category failed to load, please retry later',
          '2 categories failed to load, please retry later'
        ]
      },
      {
        key: 'market.card.ratingTooltip',
        buildArgs: (n) => [{ score: '4.8', count: n }, n],
        expected: [
          'Avg 4.8 / 5 (0 ratings)',
          'Avg 4.8 / 5 (1 rating)',
          'Avg 4.8 / 5 (2 ratings)'
        ]
      },
      {
        key: 'details.meta.installs',
        buildArgs: (n) => [{ count: n.toLocaleString('en-US') }, n],
        expected: ['0 installs', '1 install', '2 installs']
      },
      {
        key: 'details.meta.ratingInsufficientTitle',
        buildArgs: (n) => [{ count: n }, n],
        expected: [
          '0 ratings; average shown at 3+',
          '1 rating; average shown at 3+',
          '2 ratings; average shown at 3+'
        ]
      },
      {
        key: 'details.meta.ratingTitle',
        buildArgs: (n) => [{ score: '4.5', count: n }, n],
        expected: [
          'Avg 4.5 / 5 (0 ratings)',
          'Avg 4.5 / 5 (1 rating)',
          'Avg 4.5 / 5 (2 ratings)'
        ]
      },
      {
        key: 'myPage.maxPinnedWarning',
        buildArgs: (n) => [{ count: n }, n],
        expected: [
          'You can pin up to 0 plugins',
          'You can pin up to 1 plugin',
          'You can pin up to 2 plugins'
        ]
      },
      {
        key: 'declarative.drop.acceptedCount',
        buildArgs: (n) => [{ count: n }, n],
        expected: ['0 items', '1 item', '2 items']
      },
      {
        key: 'declarative.drop.rejectedCount',
        buildArgs: (n) => [{ count: n }, n],
        expected: ['0 unsupported items', '1 unsupported item', '2 unsupported items']
      },
      {
        key: 'diagnostics.batchTests.results.readSuccess',
        buildArgs: (n) => [{ bytes: n }, n],
        expected: ['Read succeeded (0 bytes)', 'Read succeeded (1 byte)', 'Read succeeded (2 bytes)']
      },
      {
        key: 'diagnostics.batchTests.results.captureSuccess',
        buildArgs: (n) => [{ bytes: n }, n],
        expected: ['Capture succeeded (0 bytes)', 'Capture succeeded (1 byte)', 'Capture succeeded (2 bytes)']
      },
      {
        key: 'diagnostics.batchTests.results.marketListSuccess',
        buildArgs: (n) => [{ count: n, total: 10 }, n],
        expected: [
          'Loaded 0 plugins (10 total)',
          'Loaded 1 plugin (10 total)',
          'Loaded 2 plugins (10 total)'
        ]
      },
      {
        key: 'diagnostics.batchTests.results.protocolReadSuccess',
        buildArgs: (n) => [{ bytes: n }, n],
        expected: [
          'Protocol read succeeded (0 bytes)',
          'Protocol read succeeded (1 byte)',
          'Protocol read succeeded (2 bytes)'
        ]
      },
      {
        key: 'diagnostics.fs.readSuccess',
        buildArgs: (n) => [{ bytes: n }, n],
        expected: [
          'Read file succeeded (0 bytes)',
          'Read file succeeded (1 byte)',
          'Read file succeeded (2 bytes)'
        ]
      },
      {
        key: 'diagnostics.fs.listDirSuccess',
        buildArgs: (n) => [{ dir: '/tmp', count: n }, n],
        expected: [
          'Listed directory: /tmp (0 items)',
          'Listed directory: /tmp (1 item)',
          'Listed directory: /tmp (2 items)'
        ]
      },
      {
        key: 'diagnostics.protocol.readBlobLog',
        buildArgs: (n) => [{ size: n, type: 'text/plain' }, n],
        expected: [
          'Protocol read Blob succeeded: 0 bytes, type: text/plain',
          'Protocol read Blob succeeded: 1 byte, type: text/plain',
          'Protocol read Blob succeeded: 2 bytes, type: text/plain'
        ]
      }
    ]

    for (const item of pluralCases) {
      ;[0, 1, 2].forEach((n, idx) => {
        const rendered = t(item.key, ...item.buildArgs(n))
        expect(rendered, `${item.key} (n=${n})`).toBe(item.expected[idx])
        expect(rendered).not.toContain('|')
      })
    }

    // 组合场景：接受 1 项且忽略 2 项不兼容内容
    expect(
      t('declarative.drop.partialAccepted', {
        accepted: t('declarative.drop.acceptedCount', { count: 1 }, 1),
        rejected: t('declarative.drop.rejectedCount', { count: 2 }, 2)
      })
    ).toBe('Accepted 1 item, ignored 2 unsupported items')

    // 校验开源 en-US.json 中已无任何 (s) / (ies) 妥协写法
    const rawEn = JSON.stringify(enUS)
    expect(rawEn).not.toMatch(/\(s\)|\(ies\)/)

    // 切回 zh-CN 传入复数参数也正常渲染
    setI18nLocale('zh-CN')
    expect(t('launcher.resultsCount', { count: 1 }, 1)).toBe('1 个结果')
    expect(
      t('declarative.drop.partialAccepted', {
        accepted: t('declarative.drop.acceptedCount', { count: 1 }, 1),
        rejected: t('declarative.drop.rejectedCount', { count: 2 }, 2)
      })
    ).toBe('已接收 1 项，忽略 2 项不兼容内容')
  })

  it('EventMonitor 事件时间戳跟随当前 locale 本地化渲染，且 theme.css 定义了 :root:lang(en) 英文优先字体栈', async () => {
    const listeners = []
    window.ztools = {
      events: {
        on: vi.fn((_evt, cb) => listeners.push(cb)),
        off: vi.fn()
      }
    }

    const wrapper = mount(EventMonitor)
    try {
      const ts = new Date('2026-10-27T16:22:05').getTime()
      listeners[0]({ type: 'system.LocaleChange', timestamp: ts, payload: { systemLocale: 'en-US' } })
      await nextTick()

      setI18nLocale('zh-CN')
      await nextTick()
      expect(wrapper.find('.event-meta').text()).toContain(new Date(ts).toLocaleString('zh-CN'))

      setI18nLocale('en-US')
      await nextTick()
      expect(wrapper.find('.event-meta').text()).toContain(new Date(ts).toLocaleString('en-US'))
    } finally {
      wrapper.unmount()
    }

    const themeCss = readFileSync(path.resolve(__dirname, '../../assets/css/theme.css'), 'utf8')
    const enLangBlock = themeCss.match(/:root:lang\(en\)\s*\{[^}]*\}/)?.[0] || ''
    expect(enLangBlock).toContain('--rc-font-sans:')
    expect(enLangBlock.indexOf('"Segoe UI"')).toBeGreaterThan(-1)
    expect(enLangBlock.indexOf('"PingFang SC"')).toBeGreaterThan(enLangBlock.indexOf('"Segoe UI"'))
  })
})
