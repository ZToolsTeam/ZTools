import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const mocks = vi.hoisted(() => ({
  setWakePreference: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  getShowTrayIcon: vi.fn(),
  setShowTrayIcon: vi.fn(),
  isMac: false,
  routeQuery: null,
  routerReplace: vi.fn(),
  pluginHotkeyShow: vi.fn(),
  pluginFeatureHotkeyShow: vi.fn()
}))

vi.mock('@/utils/platform', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, isMacOS: () => mocks.isMac }
})

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRouter: () => ({ push: vi.fn(), replace: mocks.routerReplace }),
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
import { BUILTIN_SHORTCUT_HINTS, SHELL_SHORTCUTS, _resetShellShortcutsForTesting } from '@/utils/shellShortcuts'
import { MOUSE_WAKE_OPTIONS } from '@/utils/globalWakeHotkey'
import { setI18nLocale } from '@/i18n'

beforeEach(() => {
  setI18nLocale('zh-CN')
})

const PluginHotkeyModalStub = defineComponent({
  name: 'PluginHotkeyModal',
  setup(_, { expose }) {
    expose({ show: mocks.pluginHotkeyShow, updateMap: vi.fn() })
    return () => null
  }
})

const PluginFeatureHotkeyModalStub = defineComponent({
  name: 'PluginFeatureHotkeyModal',
  setup(_, { expose }) {
    expose({ show: mocks.pluginFeatureHotkeyShow })
    return () => null
  }
})

function mountPage(options = {}) {
  return mount(AdvancedSettings, {
    attachTo: options.attachTo,
    global: {
      stubs: {
        ScreenPermissionPanel: { template: '<div class="settings-card" data-testid="screen-permission-panel"><h2 class="card-title">隐私与权限</h2></div>' },
        PluginHotkeyModal: PluginHotkeyModalStub,
        PluginFeatureHotkeyModal: PluginFeatureHotkeyModalStub,
        'a-switch': true,
        'a-select': true,
        'a-select-option': true,
        'a-radio-group': true,
        'a-radio-button': true,
        'a-slider': true,
        'a-input-number': true,
        ...(options.stubs || {})
      }
    }
  })
}

async function switchTab(wrapper, label) {
  const btn = wrapper.findAll('[data-testid="settings-tabs"] .seg-btn').find((item) => item.text() === label)
  expect(btn, `未找到设置 Tab: ${label}`).toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
  return btn
}

describe('AdvancedSettings 设置页（4 Tab 带外框分段槽版式）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.routeQuery = reactive({})
    mocks.routerReplace.mockImplementation((next) => {
      if (next && next.query && mocks.routeQuery) {
        for (const [k, v] of Object.entries(next.query)) {
          if (v === undefined) delete mocks.routeQuery[k]
          else mocks.routeQuery[k] = v
        }
      }
      return Promise.resolve()
    })
    Object.values(mocks).forEach((m) => typeof m === 'function' && m.mockClear())
    mocks.isMac = false
    api.getHotkey.mockResolvedValue('Alt+Space')
    api.setHotkey.mockClear()
    api.setHotkey.mockResolvedValue(true)
    api.getCloseConfirm.mockResolvedValue(true)
    api.setCloseConfirm.mockResolvedValue(true)
    api.getMinimizeToTray.mockResolvedValue(true)
    api.setMinimizeToTray.mockResolvedValue(true)
    mocks.getShowTrayIcon.mockResolvedValue(true)
    mocks.setShowTrayIcon.mockResolvedValue(true)
  })

  it('顶部为带外框分段槽 4 个 Tab，按 Tab 分组互斥渲染且不渲染装饰图标', async () => {
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('.page-title').text()).toBe('设置')
    const tabGroup = wrapper.find('[data-testid="settings-tabs"]')
    expect(tabGroup.exists()).toBe(true)
    expect(tabGroup.classes()).toContain('is-marker')

    const tabBtns = tabGroup.findAll('.seg-btn')
    expect(tabBtns.map((b) => b.text())).toEqual(['常规与外观', '快捷键', '内置插件', '隐私与权限'])
    expect(tabBtns[0].classes()).toContain('active')
    expect(tabBtns[0].attributes('aria-checked')).toBe('true')

    // Tab 1: 常规与外观
    expect(wrapper.findAll('.card-title').map((t) => t.text())).toEqual(['外观', '通用'])
    expect(wrapper.find('.setting-icon').exists()).toBe(false)
    expect(wrapper.find('.card-icon').exists()).toBe(false)

    // Tab 2: 快捷键
    await switchTab(wrapper, '快捷键')
    expect(wrapper.findAll('.card-title').map((t) => t.text())).toEqual(['快捷键', '常用快捷键'])
    expect(wrapper.find('[data-testid="tray-icon-switch"]').exists()).toBe(false)

    // Tab 3: 内置插件
    await switchTab(wrapper, '内置插件')
    expect(wrapper.find('[data-testid="bundled-plugins-settings"]').exists()).toBe(true)
    expect(wrapper.findAll('.card-title').map((t) => t.text())).toEqual(['内置插件'])

    // Tab 4: 隐私与权限
    await switchTab(wrapper, '隐私与权限')
    expect(wrapper.find('[data-testid="screen-permission-panel"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('顶部 Tab 支持方向键与 Home/End 全键盘导航', async () => {
    const wrapper = mountPage({ attachTo: document.body })
    await flushPromises()

    const buttons = () => wrapper.findAll('[data-testid="settings-tabs"] [role="radio"]')
    buttons()[0].element.focus()

    await buttons()[0].trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(buttons()[1].classes()).toContain('active')
    expect(document.activeElement).toBe(buttons()[1].element)

    await buttons()[1].trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(buttons()[3].classes()).toContain('active')
    expect(wrapper.find('[data-testid="screen-permission-panel"]').exists()).toBe(true)

    await buttons()[3].trigger('keydown', { key: 'Home' })
    await flushPromises()
    expect(buttons()[0].classes()).toContain('active')
    expect(wrapper.findAll('.card-title').map((t) => t.text())).toEqual(['外观', '通用'])

    wrapper.unmount()
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

  it('默认呼出形态：在快捷键 Tab 下点击未选中项才保存，保存失败时提示错误且页面不崩溃', async () => {
    const wrapper = mountPage()
    await flushPromises()
    await switchTab(wrapper, '快捷键')

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
    expect(group.exists()).toBe(true)
    wrapper.unmount()
  })

  it('两个快捷键入口可用键盘聚焦，关闭对应弹窗后焦点回到触发按钮', async () => {
    const wrapper = mountPage({ attachTo: document.body })
    await flushPromises()
    await switchTab(wrapper, '快捷键')
    const rows = wrapper.findAll('button[aria-haspopup="dialog"]')
    expect(rows.map(row => row.get('.setting-label').text())).toEqual(['启动快捷键', '功能快捷键'])
    for (const [index, modal] of [PluginHotkeyModalStub, PluginFeatureHotkeyModalStub].entries()) {
      const row = rows[index]
      expect(row.element.tabIndex).toBe(0)
      await row.trigger('click')
      expect([mocks.pluginHotkeyShow, mocks.pluginFeatureHotkeyShow][index]).toHaveBeenCalled()
      wrapper.findComponent(modal).vm.$emit('closed')
      expect(document.activeElement).toBe(row.element)
    }
    wrapper.unmount()
  })

  it('常用快捷键表与 MainLayout 的全局绑定一致，每项逐键显示键帽', async () => {
    const wrapper = mountPage()
    await flushPromises()
    await switchTab(wrapper, '快捷键')

    const rows = wrapper.findAll('.setting-item.compact')
    expect(rows.map((r) => r.find('.setting-label').text())).toEqual(
      BUILTIN_SHORTCUT_HINTS.map((item) => item.label)
    )
    rows.forEach((row) => expect(row.findAll('kbd').length).toBeGreaterThan(0))
    const openSettingsRow = rows.find((r) => r.find('.setting-label').text() === '打开设置')
    expect(openSettingsRow?.findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', ','])
    expect(rows.find((r) => r.find('.setting-label').text() === '工作台与悬浮条切换')).toBeUndefined()
    const popoutRow = rows.find((r) => r.find('.setting-label').text() === '弹出为独立常驻窗口')
    expect(popoutRow?.findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', 'Shift', 'P'])
    wrapper.unmount()
  })

  describe('外部路由深链参数联动与异常防御', () => {
    it('支持 ?tab=hotkey 别名直达「快捷键」Tab，并支持 ?openPluginHotkey&pluginId / ?openPluginFeatureHotkey 自动切 Tab 并弹窗', async () => {
      mocks.routeQuery.tab = 'hotkey'
      const wrapper1 = mountPage()
      await flushPromises()
      expect(wrapper1.find('[data-testid="settings-tabs"] .seg-btn.active').text()).toBe('快捷键')
      wrapper1.unmount()

      mocks.routeQuery = reactive({ openPluginHotkey: 'true', pluginId: 'demo-plugin' })
      const wrapper2 = mountPage()
      await flushPromises()
      expect(wrapper2.find('[data-testid="settings-tabs"] .seg-btn.active').text()).toBe('快捷键')
      expect(mocks.pluginHotkeyShow).toHaveBeenCalledWith({ pluginId: 'demo-plugin' })
      expect(mocks.routeQuery.openPluginHotkey).toBeUndefined()
      expect(mocks.routeQuery.pluginId).toBeUndefined()
      wrapper2.unmount()

      mocks.routeQuery = reactive({ openPluginFeatureHotkey: 'true' })
      const wrapper3 = mountPage()
      await flushPromises()
      expect(wrapper3.find('[data-testid="settings-tabs"] .seg-btn.active').text()).toBe('快捷键')
      expect(mocks.pluginFeatureHotkeyShow).toHaveBeenCalledTimes(1)
      expect(mocks.routeQuery.openPluginFeatureHotkey).toBeUndefined()
      wrapper3.unmount()
    })

    it('携带 ?manageBundled=calculator 时自动切到「内置插件」Tab 并高亮目标内置插件行', async () => {
      mocks.routeQuery = reactive({ manageBundled: 'calculator' })
      const wrapper = mountPage()
      await flushPromises()

      expect(wrapper.find('[data-testid="settings-tabs"] .seg-btn.active').text()).toBe('内置插件')
      expect(mocks.routeQuery.manageBundled).toBeUndefined()
      const calcRow = wrapper.find('[data-plugin-id="calculator"]')
      expect(calcRow.exists()).toBe(true)
      expect(calcRow.classes()).toContain('is-highlighted')

      // 已处于其它 Tab 后若再次收到 manageBundled 参数，同样切换并聚焦目标行
      await switchTab(wrapper, '常规与外观')
      mocks.routeQuery.manageBundled = 'json-format'
      await flushPromises()
      expect(wrapper.find('[data-testid="settings-tabs"] .seg-btn.active').text()).toBe('内置插件')
      expect(wrapper.find('[data-plugin-id="json-format"]').classes()).toContain('is-highlighted')

      wrapper.unmount()
    })

    it('[破坏性] 非法或原型链污染 ?tab= 参数安全回退到默认「常规与外观」Tab，不报错不白屏', async () => {
      for (const badTab of ['__proto__', 'constructor', 'toString', 'unknown-tab', '', '   ']) {
        mocks.routeQuery = reactive({ tab: badTab })
        const wrapper = mountPage()
        await flushPromises()
        expect(wrapper.find('[data-testid="settings-tabs"] .seg-btn.active').text()).toBe('常规与外观')
        expect(wrapper.findAll('.card-title').map((t) => t.text())).toEqual(['外观', '通用'])
        wrapper.unmount()
      }
    })
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

    it('超级面板设置区块已删除：所有 Tab 下均不渲染相关设置，也不读写 super_panel 配置', async () => {
      const wrapper = mountPage()
      await flushPromises()
      for (const tabLabel of ['常规与外观', '快捷键', '内置插件', '隐私与权限']) {
        await switchTab(wrapper, tabLabel)
        for (const text of ['超级面板', '鼠标热键', '面板位置', '面板大小', '默认标签', '最近使用数量', '快捷方式设置']) {
          expect(wrapper.text()).not.toContain(text)
        }
      }
      expect(config.get).not.toHaveBeenCalledWith('super_panel')
      expect(config.set).not.toHaveBeenCalledWith('super_panel', expect.anything())
      wrapper.unmount()
    })

    it('全局唤醒已关闭（空串）时在「快捷键」Tab 显示「点击设置」', async () => {
      api.getHotkey.mockResolvedValue('')
      const wrapper = mountPage()
      await flushPromises()
      await switchTab(wrapper, '快捷键')
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
      await switchTab(wrapper, '快捷键')
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

    it('快捷键录入框：录入 Alt+Space 时阻止事件冒泡，且切换 Tab 时自动中止未完成的快捷键录入', async () => {
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
        await switchTab(wrapper, '快捷键')

        const wakeRecorder = wrapper.find('.hotkey-item .hotkey-recorder')
        await wakeRecorder.trigger('click')
        expect(wakeRecorder.classes()).toContain('recording')

        // 未完成录入直接切走 Tab，再切回时录制状态必须已被清理
        await switchTab(wrapper, '常规与外观')
        await switchTab(wrapper, '快捷键')
        expect(wrapper.find('.hotkey-item .hotkey-recorder').classes()).not.toContain('recording')

        const wakeRecorderAgain = wrapper.find('.hotkey-item .hotkey-recorder')
        await wakeRecorderAgain.trigger('click')
        const wakeInput = wakeRecorderAgain.find('input.hotkey-hidden-input')
        await wakeInput.trigger('keydown', { key: ' ', code: 'Space', altKey: true })
        await flushPromises()
        expect(windowKeydownSpy).not.toHaveBeenCalled()
        expect(api.setHotkey).toHaveBeenCalledWith('Alt+Space')
        // 快捷键 Tab 包含 1 个单一「全局唤醒快捷键」录入框 + 5 个可编辑常用快捷键录入框（不再展示独立悬浮条快捷键，Esc 保持只读）
        expect(wrapper.findAll('.hotkey-recorder')).toHaveLength(6)
        expect(wrapper.find('[data-testid="launcher-hotkey-setting"]').exists()).toBe(false)
        expect(wrapper.find('[data-testid="common-shortcut-row-back"] .hotkey-recorder').exists()).toBe(false)
        wrapper.unmount()
      } finally {
        window.removeEventListener('keydown', windowKeydownSpy)
      }
    })

    it('[破坏性] 初始化异步加载未完成即卸载组件时，监听器对称注销且不触发残留深链弹窗', async () => {
      let resolveSysInfo
      window.ztools.sys = {
        getInfo: vi.fn(() => new Promise((resolve) => { resolveSysInfo = resolve }))
      }
      mocks.routeQuery = reactive({ openPluginHotkey: 'true' })
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')
      try {
        const wrapper = mountPage()
        expect(resolveSysInfo).toBeTypeOf('function')
        wrapper.unmount()
        resolveSysInfo({ platform: 'windows' })
        await flushPromises()

        const addedHandler = addSpy.mock.calls.find(([type]) => type === 'ztools-settings-changed')?.[1]
        const removedHandler = removeSpy.mock.calls.find(([type]) => type === 'ztools-settings-changed')?.[1]
        expect(addedHandler).toBeTypeOf('function')
        expect(removedHandler).toBe(addedHandler)
        expect(mocks.pluginHotkeyShow).not.toHaveBeenCalled()
      } finally {
        addSpy.mockRestore()
        removeSpy.mockRestore()
      }
    })

    it('全局唤醒快捷键支持「恢复默认」与双向冲突预检，保存后刷新托盘并支持壳层保留提醒', async () => {
      api.getHotkey.mockResolvedValue('Ctrl+Shift+Z')
      const checkConflictMock = vi.fn().mockResolvedValue({ hasConflict: false, conflicts: [] })
      const reloadHotkeysMock = vi.fn().mockResolvedValue(true)
      window.ztools.sys = {
        getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }),
        reloadHotkeys: reloadHotkeysMock
      }
      window.ztools.trigger = {
        list: vi.fn().mockResolvedValue([]),
        register: vi.fn().mockResolvedValue({ success: true, data: { triggerId: 'global_wake_hotkey' } }),
        unregister: vi.fn().mockResolvedValue({ success: true }),
        checkConflict: checkConflictMock
      }

      const wrapper = mountPage({ attachTo: document.body })
      await flushPromises()
      await switchTab(wrapper, '快捷键')

      // 1. 双向冲突预检命中时阻止保存、不覆盖已配置热键并提示冲突目标
      checkConflictMock.mockResolvedValueOnce({
        hasConflict: true,
        conflicts: [{ pluginId: 'demo', pluginName: '截图工具' }]
      })
      await wrapper.find('.hotkey-item .hotkey-recorder').trigger('click')
      await wrapper.find('.hotkey-item input.hotkey-hidden-input').trigger('keydown', { key: 'A', ctrlKey: true, altKey: true })
      await flushPromises()
      expect(checkConflictMock).toHaveBeenCalledWith('Ctrl+Alt+A', 'system', 'global_wake_hotkey')
      expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('截图工具'))
      expect(api.setHotkey).not.toHaveBeenCalledWith('Ctrl+Alt+A')

      // 2. 命中壳层保留快捷键时允许保存，但给出温和 warning 提示并调用 reloadHotkeys
      await wrapper.find('.hotkey-item .hotkey-recorder').trigger('click')
      await wrapper.find('.hotkey-item input.hotkey-hidden-input').trigger('keydown', { key: 'B', ctrlKey: true })
      await flushPromises()
      expect(api.setHotkey).toHaveBeenCalledWith('Ctrl+B')
      expect(reloadHotkeysMock).toHaveBeenCalled()
      expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('展开 / 收起侧栏'))

      // 3. 点击「恢复默认」恢复为 Alt+Space 并再次刷新托盘
      const restoreBtn = wrapper.find('[data-testid="restore-default-wake-hotkey"]')
      expect(restoreBtn.exists()).toBe(true)
      expect(restoreBtn.attributes('disabled')).toBeUndefined()
      await restoreBtn.trigger('click')
      await flushPromises()
      expect(checkConflictMock).toHaveBeenLastCalledWith('Alt+Space', 'system', 'global_wake_hotkey')
      expect(api.setHotkey).toHaveBeenLastCalledWith('Alt+Space')
      expect(reloadHotkeysMock).toHaveBeenCalledTimes(2)
      expect(restoreBtn.attributes('disabled')).toBeDefined()

      // 4. Esc 取消录入后焦点自动归还外层 .hotkey-recorder 容器而非停在隐藏 input
      const recorder = wrapper.find('.hotkey-item .hotkey-recorder')
      const hiddenInput = wrapper.find('.hotkey-item input.hotkey-hidden-input')
      await recorder.trigger('click')
      await flushPromises()
      expect(document.activeElement).toBe(hiddenInput.element)
      await hiddenInput.trigger('keydown', { key: 'Escape' })
      await flushPromises()
      expect(recorder.classes()).not.toContain('recording')
      expect(document.activeElement).toBe(recorder.element)

      wrapper.unmount()
    })

    it('Windows 原生双模拓展设置：仅支持双按/鼠标的宿主展示鼠标快捷唤醒（无右键单击）、200~500ms 阈值与全屏免打扰开关', async () => {
      // 1. macOS（无能力标识）隐藏相关设置
      window.ztools.sys = { getInfo: vi.fn().mockResolvedValue({ platform: 'macos', supportsDoubleModifierHotkeys: false, supportsMouseTriggers: false }) }
      window.ztools.trigger = { list: vi.fn().mockResolvedValue([]) }
      const macWrapper = mountPage()
      await flushPromises()
      await switchTab(macWrapper, '快捷键')
      expect(macWrapper.find('[data-testid="mouse-wake-select"]').exists()).toBe(false)
      expect(macWrapper.find('[data-testid="fullscreen-dnd-switch"]').exists()).toBe(false)
      macWrapper.unmount()

      // 2. Windows 真实宿主展示完整拓展并联动保存 mouse_wake_hook 与全屏免打扰
      const registerMock = vi.fn().mockResolvedValue({ success: true, data: { triggerId: 'mouse_wake_hook' } })
      const reloadHotkeysMock = vi.fn().mockResolvedValue(true)
      const triggerListMock = vi.fn().mockResolvedValue([
        {
          id: 'mouse_wake_hook',
          pluginId: 'system',
          type: 'hook',
          enabled: true,
          config: { kind: 'mouse', button: 'middle', action: 'long', longPressMs: 350, fullscreenDnd: false },
          action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
        }
      ])
      window.ztools.sys = {
        getInfo: vi.fn().mockResolvedValue({
          platform: 'windows',
          supportsDoubleModifierHotkeys: true,
          supportsMouseTriggers: true
        }),
        reloadHotkeys: reloadHotkeysMock
      }
      window.ztools.trigger = {
        list: triggerListMock,
        register: registerMock,
        unregister: vi.fn().mockResolvedValue({ success: true })
      }

      const winWrapper = mountPage({
        stubs: {
          'a-select': {
            props: ['value', 'options', 'disabled'],
            emits: ['update:value', 'change'],
            template:
              '<select :value="value" :disabled="disabled" @change="$emit(\'update:value\', $event.target.value); $emit(\'change\', $event.target.value)"><option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select>'
          }
        }
      })
      await flushPromises()
      await switchTab(winWrapper, '快捷键')

      const mouseSelect = winWrapper.findComponent('[data-testid="mouse-wake-select"]')
      expect(mouseSelect.exists()).toBe(true)
      expect(MOUSE_WAKE_OPTIONS.some((opt) => opt.value === 'right:press')).toBe(false)
      expect(winWrapper.find('[data-testid="mouse-long-press-slider"]').exists()).toBe(true)
      expect(winWrapper.text()).toContain('350 ms')

      // 切换全屏免打扰开关
      const dndSwitch = winWrapper.findComponent('[data-testid="fullscreen-dnd-switch"]')
      expect(dndSwitch.exists()).toBe(true)
      await dndSwitch.vm.$emit('change', true)
      await flushPromises()

      expect(registerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mouse_wake_hook',
          type: 'hook',
          config: expect.objectContaining({ kind: 'mouse', button: 'middle', action: 'long', longPressMs: 350, fullscreenDnd: true })
        })
      )
      expect(reloadHotkeysMock).toHaveBeenCalled()

      winWrapper.unmount()
    })

    it('常规与外观页提供界面语言选择项，切换为 English 后即时刷新设置页文案并持久化', async () => {
      const configSet = vi.fn().mockResolvedValue(true)
      global.window.ztools = {
        config: { get: vi.fn().mockResolvedValue(null), set: configSet }
      }
      const wrapper = mountPage()
      await flushPromises()

      expect(wrapper.find('.page-title').text()).toBe('设置')
      const localeSelect = wrapper.findComponent('[data-testid="locale-select"]')
      expect(localeSelect.exists()).toBe(true)

      await localeSelect.vm.$emit('update:value', 'en-US')
      await flushPromises()

      expect(configSet).toHaveBeenCalledWith('ui.locale', 'en-US', true, 'user_settings.json')
      expect(wrapper.find('.page-title').text()).toBe('Settings')
      expect(wrapper.findAll('[data-testid="settings-tabs"] .seg-btn')[0].text()).toBe('General & Appearance')

      wrapper.unmount()
    })

    it('单一全局唤醒快捷键与底层 TriggerService 真实注册态对齐：未生效时展示警告，同步失败时回滚配置与界面', async () => {
      api.getHotkey.mockResolvedValue('Alt+Space')
      const checkConflictMock = vi.fn().mockResolvedValue({ data: { hasConflict: false, conflicts: [] } })
      const registerMock = vi.fn()
        .mockRejectedValueOnce(new Error('操作系统拒绝注册'))
        .mockResolvedValue({ success: true, data: { triggerId: 'global_wake_hotkey' } })
      const listMock = vi.fn().mockResolvedValue([
        {
          id: 'global_wake_hotkey',
          pluginId: 'system',
          type: 'hotkey',
          enabled: true,
          effectiveEnabled: false,
          config: { key: 'Ctrl+Space' },
          action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
        }
      ])
      window.ztools = {
        sys: {
          getInfo: vi.fn().mockResolvedValue({ platform: 'windows', supportsDoubleModifierHotkeys: false, supportsMouseTriggers: false }),
          reloadHotkeys: vi.fn().mockResolvedValue(true)
        },
        trigger: {
          list: listMock,
          register: registerMock,
          unregister: vi.fn().mockResolvedValue({ success: true }),
          checkConflict: checkConflictMock
        }
      }

      const wrapper = mountPage({ attachTo: document.body })
      await flushPromises()
      await switchTab(wrapper, '快捷键')

      // 1. 不再展示独立悬浮条快捷键，改由「默认呼出形态」与单一全局唤醒快捷键配合
      expect(wrapper.find('[data-testid="launcher-hotkey-setting"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="wake-preference-setting"]').exists()).toBe(true)

      // 2. 以 TriggerService 真实键位 Ctrl+Space 对齐展示，且 effectiveEnabled=false 时显式提示未生效
      expect(wrapper.find('.hotkey-item .hotkey-recorder').text()).toContain('Ctrl')
      expect(wrapper.find('[data-testid="wake-hotkey-inactive-hint"]').exists()).toBe(true)

      // 3. 录制新热键注册失败时，必须回滚界面与 hotkey.global 配置为旧键 Ctrl+Space
      const recorder = wrapper.find('.hotkey-item .hotkey-recorder')
      const hiddenInput = wrapper.find('.hotkey-item input.hotkey-hidden-input')
      await recorder.trigger('click')
      await flushPromises()
      await hiddenInput.trigger('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true })
      await flushPromises()
      expect(api.setHotkey).toHaveBeenCalledWith('Ctrl+Alt+L')
      expect(api.setHotkey).toHaveBeenLastCalledWith('Ctrl+Space')
      expect(mocks.error).toHaveBeenCalled()
      expect(wrapper.find('[data-testid="wake-hotkey-inactive-hint"]').exists()).toBe(true)

      // 4. 再次录制有效热键注册成功后，清除未生效警告提示
      await recorder.trigger('click')
      await flushPromises()
      await hiddenInput.trigger('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })
      await flushPromises()
      expect(api.setHotkey).toHaveBeenLastCalledWith('Ctrl+Alt+K')
      expect(wrapper.find('[data-testid="wake-hotkey-inactive-hint"]').exists()).toBe(false)

      wrapper.unmount()
    })

    it('[性能与生命周期] 挂载时只调用一次 trigger.list() 供三方复用，失活期间忽略 ztools-settings-changed 与查询参数变化', async () => {
      const { KeepAlive, ref } = await import('vue')
      const listMock = vi.fn().mockResolvedValue([
        {
          id: 'plugin_hotkey_demo',
          pluginId: 'demo',
          type: 'hotkey',
          enabled: true,
          config: { key: 'Alt+D' },
          action: { mode: 'window', target: 'demo', params: {} }
        }
      ])
      window.ztools = {
        config: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(true) },
        sys: { getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }) },
        trigger: { list: listMock }
      }

      const active = ref(true)
      const Host = defineComponent({
        components: { KeepAlive, AdvancedSettings },
        setup: () => ({ active }),
        template: '<KeepAlive><AdvancedSettings v-if="active" /></KeepAlive>'
      })
      const wrapper = mount(Host, {
        global: {
          stubs: {
            ScreenPermissionPanel: true,
            PluginHotkeyModal: PluginHotkeyModalStub,
            PluginFeatureHotkeyModal: PluginFeatureHotkeyModalStub,
            'a-switch': true,
            'a-select': true,
            'a-slider': true
          }
        }
      })
      try {
        await flushPromises()
        // loadTriggerWakePreferences + loadPluginHotkeyCount + loadPluginFeatureHotkeyCount 共享单次 trigger.list()
        expect(listMock).toHaveBeenCalledTimes(1)

        // 失活期间忽略 ztools-settings-changed 与 route.query 变化
        active.value = false
        await flushPromises()
        api.getHotkey.mockClear()
        window.dispatchEvent(new Event('ztools-settings-changed'))
        mocks.routeQuery.openPluginHotkey = 'true'
        await flushPromises()
        expect(api.getHotkey).not.toHaveBeenCalled()
        expect(mocks.pluginHotkeyShow).not.toHaveBeenCalled()

        // 重新激活后恢复刷新与深链消费，且同样只调一次 trigger.list()
        listMock.mockClear()
        active.value = true
        await flushPromises()
        expect(listMock).toHaveBeenCalledTimes(1)
        expect(mocks.pluginHotkeyShow).toHaveBeenCalledTimes(1)
      } finally {
        wrapper.unmount()
      }
    })

    it('常用快捷键：除 Esc 外 5 项均支持录制修改、清空与一键恢复默认，同组冲突被拦截', async () => {
      _resetShellShortcutsForTesting()
      const savedConfigs = new Map()
      const reloadHotkeysMock = vi.fn().mockResolvedValue({ success: true })
      window.ztools = {
        sys: {
          getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }),
          reloadHotkeys: reloadHotkeysMock
        },
        config: {
          get: vi.fn(async (path, fallback) => (savedConfigs.has(path) ? savedConfigs.get(path) : fallback)),
          set: vi.fn(async (path, value) => {
            savedConfigs.set(path, value)
            return true
          })
        },
        trigger: { list: vi.fn().mockResolvedValue([]) }
      }

      const wrapper = mountPage({ attachTo: document.body })
      await flushPromises()
      await switchTab(wrapper, '快捷键')

      try {
        // 1. Esc（返回上一级 / 主页）保持只读，无录入框与清空按钮
        const backRow = wrapper.find('[data-testid="common-shortcut-row-back"]')
        expect(backRow.find('.hotkey-recorder').exists()).toBe(false)
        expect(backRow.find('.clear-btn').exists()).toBe(false)
        expect(backRow.findAll('kbd').map((k) => k.text())).toEqual(['Esc'])

        const restoreBtn = wrapper.find('[data-testid="restore-default-shell-shortcuts"]')
        expect(restoreBtn.attributes('disabled')).toBeDefined()

        // 2. 聚焦搜索录制为与动作面板冲突的 Ctrl+K：被拦截且值不变
        const focusRow = wrapper.find('[data-testid="common-shortcut-row-focus-search"]')
        await focusRow.find('.hotkey-recorder').trigger('click')
        await flushPromises()
        await focusRow.find('input.hotkey-hidden-input').trigger('keydown', { key: 'k', code: 'KeyK', ctrlKey: true })
        await flushPromises()
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('动作面板'))
        expect(SHELL_SHORTCUTS.FOCUS_SEARCH).toBe('Ctrl+F')

        // 3. 聚焦搜索修改为 Ctrl+J：写入 user_settings.json 且刷新宿主热键菜单
        await focusRow.find('.hotkey-recorder').trigger('click')
        await flushPromises()
        await focusRow.find('input.hotkey-hidden-input').trigger('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true })
        await flushPromises()
        expect(SHELL_SHORTCUTS.FOCUS_SEARCH).toBe('Ctrl+J')
        expect(focusRow.findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', 'J'])
        expect(restoreBtn.attributes('disabled')).toBeUndefined()
        expect(reloadHotkeysMock).toHaveBeenCalled()

        // 4. 点击清空按钮清空「打开设置」快捷键：显示「未设置」且值为空串
        const settingsRow = wrapper.find('[data-testid="common-shortcut-row-open-settings"]')
        await settingsRow.find('.clear-btn').trigger('click')
        await flushPromises()
        expect(SHELL_SHORTCUTS.OPEN_SETTINGS).toBe('')
        expect(settingsRow.findAll('kbd')).toHaveLength(0)
        expect(settingsRow.text()).toContain('未设置')

        // 5. 清空后可以重新录入默认逗号组合 Ctrl+,
        await settingsRow.find('.hotkey-recorder').trigger('click')
        await flushPromises()
        await settingsRow.find('input.hotkey-hidden-input').trigger('keydown', { key: ',', code: 'Comma', ctrlKey: true })
        await flushPromises()
        expect(SHELL_SHORTCUTS.OPEN_SETTINGS).toBe('Ctrl+,')
        expect(settingsRow.findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', ','])

        // 6. 点击「恢复默认」还原全部常用快捷键
        await restoreBtn.trigger('click')
        await flushPromises()
        expect(SHELL_SHORTCUTS.FOCUS_SEARCH).toBe('Ctrl+F')
        expect(SHELL_SHORTCUTS.OPEN_SETTINGS).toBe('Ctrl+,')
        expect(restoreBtn.attributes('disabled')).toBeDefined()
      } finally {
        wrapper.unmount()
        _resetShellShortcutsForTesting()
      }
    })
  })
})
