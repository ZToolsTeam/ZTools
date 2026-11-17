import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  setWakePreference: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  getShowTrayIcon: vi.fn(),
  setShowTrayIcon: vi.fn(),
  isMac: false
}))

vi.mock('@/utils/platform', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, isMacOS: () => mocks.isMac }
})

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ query: {}, name: 'advanced-settings' })
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, warning: vi.fn(), info: vi.fn() })
}))
vi.mock('@/api/apiserver', () => ({
  isNative: false,
  getAutostart: vi.fn().mockResolvedValue(false),
  setAutostart: vi.fn().mockResolvedValue(true),
  getHotkey: vi.fn().mockResolvedValue('Alt+Space'),
  setHotkey: vi.fn().mockResolvedValue(true),
  getMinimizeToTray: vi.fn().mockResolvedValue(true),
  setMinimizeToTray: vi.fn().mockResolvedValue(true),
  getShowTrayIcon: mocks.getShowTrayIcon,
  setShowTrayIcon: mocks.setShowTrayIcon,
  getCloseConfirm: vi.fn().mockResolvedValue(true),
  setCloseConfirm: vi.fn().mockResolvedValue(true)
}))
vi.mock('@/utils/windowMode', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, setWakePreference: mocks.setWakePreference }
})

import AdvancedSettings from '../AdvancedSettings.vue'
import * as api from '@/api/apiserver'
import { useThemeStore } from '@/stores/theme'

function mountPage() {
  return mount(AdvancedSettings, {
    global: {
      stubs: {
        ScreenPermissionPanel: true,
        PluginHotkeyModal: true,
        PluginFeatureHotkeyModal: true,
        'a-switch': true,
        'a-select': true,
        'a-select-option': true,
        'a-radio-group': true,
        'a-radio-button': true,
        'a-slider': true,
        'a-input-number': true
      }
    }
  })
}

describe('AdvancedSettings 设置页（单栏分组版式）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(mocks).forEach((m) => typeof m === 'function' && m.mockReset())
    mocks.isMac = false
    api.getHotkey.mockResolvedValue('Alt+Space')
    api.setHotkey.mockClear()
    api.getCloseConfirm.mockResolvedValue(true)
    api.setCloseConfirm.mockResolvedValue(true)
    api.getMinimizeToTray.mockResolvedValue(true)
    api.setMinimizeToTray.mockResolvedValue(true)
    mocks.getShowTrayIcon.mockResolvedValue(true)
    mocks.setShowTrayIcon.mockResolvedValue(true)
  })

  it('托盘图标开关：读取已保存的值，切换后写入；保存失败时开关回到原状态并提示', async () => {
    mocks.getShowTrayIcon.mockResolvedValue(false)
    const wrapper = mountPage()
    await flushPromises()
    const traySwitch = wrapper.findComponent('[data-testid="tray-icon-switch"]')
    expect(traySwitch.exists()).toBe(true)
    expect(traySwitch.attributes('checked')).toBe('false')

    traySwitch.vm.$emit('update:checked', true)
    traySwitch.vm.$emit('change', true)
    await flushPromises()
    expect(mocks.setShowTrayIcon).toHaveBeenCalledWith(true)
    expect(mocks.success).toHaveBeenCalled()

    mocks.setShowTrayIcon.mockResolvedValueOnce(false)
    traySwitch.vm.$emit('update:checked', false)
    traySwitch.vm.$emit('change', false)
    await flushPromises()
    expect(mocks.setShowTrayIcon).toHaveBeenLastCalledWith(false)
    expect(mocks.error).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="tray-icon-switch"]').attributes('checked')).toBe('true')
    wrapper.unmount()
  })

  it('[破坏性] 退出确认保存失败（setter 返回 false）时提示错误、不报成功，并按配置恢复开关', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const closeSwitch = wrapper.findAllComponents('a-switch-stub')
      .find((sw) => sw.element.closest('.setting-item')?.textContent.includes('退出确认'))
    expect(closeSwitch).toBeTruthy()
    api.setCloseConfirm.mockResolvedValueOnce(false)
    api.getCloseConfirm.mockClear()
    mocks.success.mockClear()
    closeSwitch.vm.$emit('update:checked', false)
    closeSwitch.vm.$emit('change', false)
    await flushPromises()
    expect(mocks.error).toHaveBeenCalledWith('关闭窗口设置保存失败')
    expect(mocks.success).not.toHaveBeenCalled()
    expect(api.getCloseConfirm).toHaveBeenCalledTimes(1)
    expect(closeSwitch.attributes('checked')).toBe('true')
    wrapper.unmount()
  })

  it('分组顺序为 外观 → 通用 → 快捷键 → 常用快捷键 → 内置插件，开发者工具卡片已删除，且不再渲染装饰图标', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('.page-title').text()).toBe('设置')
    expect(wrapper.findAll('.card-title').map((t) => t.text())).toEqual(['外观', '通用', '快捷键', '常用快捷键', '内置插件'])
    expect(wrapper.find('.setting-icon').exists()).toBe(false)
    expect(wrapper.find('.card-icon').exists()).toBe(false)
    wrapper.unmount()
  })

  it('主题卡片：点击另一主题会切换并标记选中；重复点击当前主题不重复保存', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const theme = useThemeStore()
    const spy = vi.spyOn(theme, 'setTheme').mockImplementation(async value => { theme.mode = value })
    const cards = wrapper.findAll('.theme-btn')
    expect(cards.map(card => card.text())).toEqual(['跟随系统', '浅色', '深色'])
    const current = wrapper.find('.theme-btn.active')
    await current.trigger('click')
    expect(spy).not.toHaveBeenCalled()

    const other = cards.find((c) => !c.classes().includes('active'))
    await other.trigger('click')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(other.classes()).toContain('active')
    expect(other.attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('预览卡：未选中的“跟随系统”显示半浅半深，浅色、深色固定', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const theme = useThemeStore()
    theme.mode = 'dark'
    await wrapper.vm.$nextTick()
    const card = (label) => wrapper.findAll('.theme-btn').find((c) => c.text() === label)
    expect(card('跟随系统').findAll('.theme-preview').map((p) => p.attributes('data-theme'))).toEqual(['light', 'dark'])
    expect(card('浅色').find('.theme-preview').attributes('data-theme')).toBe('light')
    expect(card('深色').find('.theme-preview').attributes('data-theme')).toBe('dark')
    wrapper.unmount()
  })

  it('跟随系统时颜色变化不会把选项变成固定深色', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const theme = useThemeStore()
    theme.handleSystemThemeChange(true, 'system')
    await wrapper.vm.$nextTick()
    const selected = wrapper.find('.theme-btn.active')
    expect(selected.text()).toBe('跟随系统')
    expect(selected.find('.dark-preview').exists()).toBe(true)
    wrapper.unmount()
  })

  it('默认呼出形态：点击未选中项才保存，保存失败时提示错误且页面不崩溃', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const group = wrapper.find('[aria-label="默认呼出形态"]')
    const segs = group.findAll('.seg-btn')
    expect(segs.map((s) => s.text())).toEqual(['悬浮条', '工作台'])
    const active = group.find('.seg-btn.active')
    await active.trigger('click')
    expect(mocks.setWakePreference).not.toHaveBeenCalled()

    const other = segs.find((s) => !s.classes().includes('active'))
    mocks.setWakePreference.mockImplementationOnce(() => { throw new Error('写入失败') })
    await other.trigger('click')
    expect(mocks.setWakePreference).toHaveBeenCalledTimes(1)
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('写入失败'))
    expect(wrapper.find('.seg-group').exists()).toBe(true)
    wrapper.unmount()
  })

  it('常用快捷键表与 MainLayout 的全局绑定一致，每项逐键显示键帽', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const rows = wrapper.findAll('.setting-item.compact')
    expect(rows.map((r) => r.find('.setting-label').text())).toEqual([
      '聚焦搜索', '动作面板', '切换到悬浮条', '打开设置', '返回主页'
    ])
    rows.forEach((row) => expect(row.findAll('kbd').length).toBeGreaterThan(0))
    const openSettingsRow = rows.find((r) => r.find('.setting-label').text() === '打开设置')
    expect(openSettingsRow?.findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', 'I'])
    wrapper.unmount()
  })

  describe('依赖 window.ztools 的设置项', () => {
    let config
    beforeEach(() => {
      config = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(true) }
      window.ztools = { config }
    })
    afterEach(() => {
      delete window.ztools
    })

    it('超级面板设置区块已删除：不再渲染相关设置，也不读写 super_panel 配置', async () => {
      const wrapper = mountPage()
      await flushPromises()
      for (const text of ['超级面板', '鼠标热键', '面板位置', '面板大小', '默认标签', '最近使用数量', '快捷方式设置']) {
        expect(wrapper.text()).not.toContain(text)
      }
      expect(config.get).not.toHaveBeenCalledWith('super_panel')
      expect(config.set).not.toHaveBeenCalledWith('super_panel', expect.anything())
      wrapper.unmount()
    })

    it('全局唤醒已关闭（空串）时显示「点击设置」', async () => {
      api.getHotkey.mockResolvedValue('')
      const wrapper = mountPage()
      await flushPromises()
      expect(wrapper.find('.hotkey-item .no-hotkey').text()).toBe('点击设置')
      expect(api.setHotkey).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('[破坏性] 读取唤醒快捷键失败时提示错误，其余设置照常加载，且不会把唤醒快捷键当成已关闭', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      api.getHotkey.mockRejectedValue(new Error('IPC 超时'))
      const wrapper = mountPage()
      await flushPromises()
      expect(mocks.error).toHaveBeenCalledWith('读取全局唤醒快捷键失败')
      expect(mocks.getShowTrayIcon).toHaveBeenCalled()
      expect(wrapper.find('.hotkey-item .no-hotkey').exists()).toBe(false)
      spy.mockRestore()
      wrapper.unmount()
    })

    it('macOS 开发版禁用开机自启开关并说明原因，不读取也不写入；正式版照常读取', async () => {
      mocks.isMac = true
      window.ztools.sys = { isDev: vi.fn().mockResolvedValue(true) }
      api.getAutostart.mockClear()
      const dev = mountPage()
      await flushPromises()
      expect(dev.find('[data-testid="autostart-status"]').text()).toContain('开发版不支持开机启动')
      expect(dev.findComponent('[data-testid="autostart-switch"]').attributes('disabled')).toBe('true')
      expect(api.getAutostart).not.toHaveBeenCalled()
      dev.unmount()

      window.ztools.sys.isDev.mockResolvedValue(false)
      const packaged = mountPage()
      await flushPromises()
      expect(api.getAutostart).toHaveBeenCalled()
      expect(packaged.findComponent('[data-testid="autostart-switch"]').attributes('disabled')).toBe('false')
      packaged.unmount()
    })

    it('快捷键录入框：录入 Alt+Space 时阻止事件冒泡，不触发外层 window keydown 监听', async () => {
      window.ztools.sys = { getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }) }
      window.ztools.trigger = {
        list: vi.fn().mockResolvedValue([]),
        register: vi.fn().mockResolvedValue({ success: true, triggerId: 'global_wake_hotkey' })
      }
      const windowKeydownSpy = vi.fn()
      window.addEventListener('keydown', windowKeydownSpy)
      try {
        const wrapper = mountPage()
        await flushPromises()
        const wakeRecorder = wrapper.find('.hotkey-item .hotkey-recorder')
        await wakeRecorder.trigger('click')
        const wakeInput = wakeRecorder.find('input.hotkey-hidden-input')
        await wakeInput.trigger('keydown', { key: ' ', code: 'Space', altKey: true })
        await flushPromises()
        expect(windowKeydownSpy).not.toHaveBeenCalled()
        expect(api.setHotkey).toHaveBeenCalledWith('Alt+Space')
        // 设置页只剩一个快捷键录入框（全局唤醒）
        expect(wrapper.findAll('.hotkey-recorder')).toHaveLength(1)
        wrapper.unmount()
      } finally {
        window.removeEventListener('keydown', windowKeydownSpy)
      }
    })
  })
})
