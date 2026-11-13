import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

let capturedAntdTheme = null

vi.mock('ant-design-vue', () => ({
  ConfigProvider: defineComponent({
    name: 'ConfigProvider',
    props: {
      locale: { type: Object, default: null },
      theme: { type: Object, default: null }
    },
    setup(props, { slots }) {
      return () => {
        capturedAntdTheme = props.theme
        return h('div', { 'data-testid': 'antd-config-provider' }, slots.default?.())
      }
    }
  }),
  theme: {
    darkAlgorithm: 'dark-algo',
    defaultAlgorithm: 'light-algo'
  }
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMocks
}))

import ThemeProvider from '@/components/ThemeProvider.vue'
import AppearanceSettings from '../AppearanceSettings.vue'
import { useThemeStore } from '@/stores/theme'

function mountAppearanceIntegration() {
  const Root = defineComponent({
    components: { ThemeProvider, AppearanceSettings },
    template: '<ThemeProvider><AppearanceSettings /></ThemeProvider>'
  })
  return mount(Root)
}

describe('AppearanceSettings × ThemeProvider × useThemeStore 多主题色集成测试', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    capturedAntdTheme = null
    document.documentElement.classList.remove('dark')
    delete document.documentElement.dataset.accent
    Object.values(toastMocks).forEach((fn) => fn.mockReset())
    global.window.ztools = undefined
  })

  afterEach(() => {
    vi.clearAllMocks()
    global.window.ztools = undefined
  })

  it('固定渲染 6 款预设主题色且不提供自定义取色器，切换后打通持久化、DOM 属性与 Ant Design Token', async () => {
    const configSet = vi.fn().mockResolvedValue(true)
    const configGet = vi.fn().mockResolvedValue(null)
    global.window.ztools = {
      config: { get: configGet, set: configSet },
      sys: { getInfo: vi.fn().mockResolvedValue({ darkMode: false }) }
    }

    const themeStore = useThemeStore()
    await themeStore.init()

    const wrapper = mountAppearanceIntegration()
    await flushPromises()

    // 验证仅渲染固定 6 款主题色且无任何取色器控件
    const accentButtons = wrapper.findAll('.accent-btn')
    expect(accentButtons.map((b) => b.text())).toEqual([
      '余烬橙', '冰川蓝', '松石翠', '星云紫', '绯樱红', '钛金灰'
    ])
    expect(wrapper.find('input[type="color"]').exists()).toBe(false)
    expect(capturedAntdTheme?.token?.colorPrimary).toBe('#f0582a')

    // 重复点击当前已选中的余烬橙，不触发冗余 IPC 写入
    await wrapper.find('[data-testid="accent-option-ember"]').trigger('click')
    await flushPromises()
    expect(configSet).not.toHaveBeenCalled()

    // 点击切换到冰川蓝：持久化 + DOM 属性 + Ant Design Token 联动更新
    await wrapper.find('[data-testid="accent-option-glacier"]').trigger('click')
    await flushPromises()
    expect(configSet).toHaveBeenCalledWith('ui.accent', 'glacier', true, 'user_settings.json')
    expect(themeStore.accent).toBe('glacier')
    expect(document.documentElement.dataset.accent).toBe('glacier')
    expect(wrapper.find('[data-testid="accent-option-glacier"]').attributes('aria-checked')).toBe('true')
    await vi.waitFor(() => {
      expect(capturedAntdTheme?.token?.colorPrimary).toBe('#2563eb')
      expect(capturedAntdTheme?.token?.colorBgBase).toBe('#f2f5f8')
    })

    // 切换到深色 + 钛金灰：验证实心主按钮填充色与反白深墨文字对比度联动
    await wrapper.findAll('.theme-btn').find((b) => b.text() === '深色').trigger('click')
    await wrapper.find('[data-testid="accent-option-mono"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(capturedAntdTheme?.token?.colorPrimary).toBe('#f4f4f5')
      expect(capturedAntdTheme?.token?.colorTextLightSolid).toBe('#09090b')
      expect(capturedAntdTheme?.token?.colorBgBase).toBe('#09090b')
    })

    wrapper.unmount()
  })

  it('[故障注入] 宿主保存主题色失败时提示错误并保持原有选中状态与配色不变', async () => {
    const configSet = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    global.window.ztools = {
      config: { get: vi.fn().mockResolvedValue(null), set: configSet }
    }

    const wrapper = mountAppearanceIntegration()
    await flushPromises()

    // 先成功切换到星云紫
    await wrapper.find('[data-testid="accent-option-iris"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="accent-option-iris"]').classes()).toContain('active')

    // 再切换到绯樱红时宿主返回 false 保存失败
    await wrapper.find('[data-testid="accent-option-crimson"]').trigger('click')
    await flushPromises()

    expect(toastMocks.error).toHaveBeenCalledWith('主题色设置保存失败：主题色设置未保存')
    expect(wrapper.find('[data-testid="accent-option-iris"]').classes()).toContain('active')
    expect(wrapper.find('[data-testid="accent-option-crimson"]').classes()).not.toContain('active')
    expect(document.documentElement.dataset.accent).toBe('iris')

    wrapper.unmount()
  })
})
