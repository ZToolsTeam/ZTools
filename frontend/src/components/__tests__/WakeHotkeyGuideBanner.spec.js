import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import WakeHotkeyGuideBanner from '../WakeHotkeyGuideBanner.vue'
import { currentGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { ROUTES } from '@/router/routes'
import { setI18nLocale } from '@/i18n'

const apiMock = vi.hoisted(() => ({ getHotkey: vi.fn().mockResolvedValue('Alt+Space') }))
vi.mock('@/api/apiserver', () => apiMock)

function createTestRouter(initialPath = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'my', component: { template: '<div />' } },
      { path: '/list', name: 'list', component: { template: '<div />' } },
      { path: '/advanced-settings', name: ROUTES.ADVANCED_SETTINGS.name, component: { template: '<div />' } }
    ]
  })
  return { router, ready: router.push(initialPath).then(() => router.isReady()) }
}

describe('WakeHotkeyGuideBanner 新手单键轻引导条', () => {
  let prevLocale

  beforeEach(() => {
    prevLocale = setI18nLocale('zh-CN')
    localStorage.clear()
    currentGlobalWakeHotkey.value = 'Alt+Space'
    apiMock.getHotkey.mockReset()
    apiMock.getHotkey.mockResolvedValue('Alt+Space')
  })

  afterEach(() => {
    delete window.ztools
    localStorage.clear()
    setI18nLocale(prevLocale)
  })

  it('在主页/市场页展示当前全局唤醒热键，且只教这 1 个键；触发一次 global_wake_hotkey 后自动永久退场', async () => {
    let hotkeyHandler = null
    const offSpy = vi.fn()
    const configSet = vi.fn().mockResolvedValue(true)
    window.ztools = {
      config: {
        get: vi.fn().mockResolvedValue('false'),
        set: configSet
      },
      events: {
        on: vi.fn((event, handler) => {
          if (event === 'hotkey_triggered') hotkeyHandler = handler
          return offSpy
        })
      }
    }

    const { router, ready } = createTestRouter('/')
    await ready
    const wrapper = mount(WakeHotkeyGuideBanner, { global: { plugins: [router] } })
    await flushPromises()

    const banner = wrapper.find('[data-testid="wake-hotkey-guide-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('Alt')
    expect(banner.text()).toContain('Space')
    expect(banner.text()).not.toContain('Ctrl+U')

    // 其他热键触发不会误消引导条
    hotkeyHandler?.({ id: 'plugin_hotkey_demo' })
    await flushPromises()
    expect(wrapper.find('[data-testid="wake-hotkey-guide-banner"]').exists()).toBe(true)

    // 用户亲手按下一次全局唤醒热键，自动毕业并持久化隐藏
    hotkeyHandler?.({ id: 'global_wake_hotkey' })
    await flushPromises()
    expect(wrapper.find('[data-testid="wake-hotkey-guide-banner"]').exists()).toBe(false)
    expect(localStorage.getItem('ztools_wake_hotkey_mastered')).toBe('1')
    expect(configSet).toHaveBeenCalledWith('ui.wake_hotkey_hint_dismissed', 'true', false)

    wrapper.unmount()
    expect(offSpy).toHaveBeenCalledTimes(1)
  })

  it('非主页/市场页或热键已关闭时自动隐藏，支持点击修改跳转快捷键设置与手动关闭', async () => {
    const { router, ready } = createTestRouter('/list')
    await ready
    const wrapper = mount(WakeHotkeyGuideBanner, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="wake-hotkey-guide-banner"]').exists()).toBe(true)

    // 点击修改跳转至快捷键设置 Tab，并在设置页自动隐藏
    await wrapper.find('[data-testid="wake-guide-change-btn"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe(ROUTES.ADVANCED_SETTINGS.name)
    expect(router.currentRoute.value.query.tab).toBe('shortcuts')
    expect(wrapper.find('[data-testid="wake-hotkey-guide-banner"]').exists()).toBe(false)

    // 回到主页后点击关闭按钮永久隐藏
    await router.push('/')
    await flushPromises()
    expect(wrapper.find('[data-testid="wake-hotkey-guide-banner"]').exists()).toBe(true)
    await wrapper.find('[data-testid="wake-guide-dismiss-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wake-hotkey-guide-banner"]').exists()).toBe(false)
    expect(localStorage.getItem('ztools_wake_hotkey_mastered')).toBe('1')

    wrapper.unmount()
  })
})
