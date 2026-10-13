import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../internal-plugins/settings/src/App.vue'
import GeneralSettings from '../internal-plugins/settings/src/components/GeneralSettings.vue'
import PluginManagement from '../internal-plugins/settings/src/components/PluginManagement.vue'
import AboutSettings from '../internal-plugins/settings/src/components/AboutSettings.vue'
import { bridge, INITIAL_MOCK_CONFIG, INITIAL_MOCK_PLUGINS } from '../internal-plugins/settings/src/services/ztools-bridge'

describe('ZTools Settings Plugin Suite (Root Entry)', () => {
  beforeEach(() => {
    bridge.resetMock()
    if (typeof window !== 'undefined') {
      delete (window as any).ztools
      window.open = vi.fn()
    }
  })

  afterEach(() => {
    if (typeof window !== 'undefined') {
      delete (window as any).ztools
    }
  })

  describe('1. 架构纯净解耦与 Bridge 兜底', () => {
    it('在无桌面宿主环境下应该优雅降级至 Mock 数据', async () => {
      expect(bridge.isHostAvailable()).toBe(false)

      const general = await bridge.getGeneralConfig()
      expect(general.autostart).toBe(false)
      expect(general.theme).toBe('light')
      expect(general.globalHotkey).toBe('Ctrl+Shift+Z')

      const plugins = await bridge.getPlugins()
      expect(plugins.length).toBe(INITIAL_MOCK_PLUGINS.length)

      const version = await bridge.getVersionInfo()
      expect(version.appVersion).toBe('1.0.0')
      expect(version.webVersion).toBe('1.0.0')
    })

    it('当存在宿主 window.ztools 时应优先调用宿主 API', async () => {
      const mockHostGet = vi.fn().mockResolvedValue('dark')
      const mockHostSet = vi.fn().mockResolvedValue(true)
      const mockHostGetAutostart = vi.fn().mockResolvedValue({ success: true, enabled: true })

      ;(window as any).ztools = {
        settings: {
          get: mockHostGet,
          set: mockHostSet
        },
        sys: {
          getAutostart: mockHostGetAutostart,
          getCurrentVersion: vi.fn().mockResolvedValue({ appVersion: '2.0.0', webVersion: '2.0.0' })
        }
      }

      expect(bridge.isHostAvailable()).toBe(true)

      const config = await bridge.getGeneralConfig()
      expect(config.autostart).toBe(true)
      expect(config.theme).toBe('dark')

      await bridge.setTheme('light')
      expect(mockHostSet).toHaveBeenCalledWith('theme', 'light')

      const version = await bridge.getVersionInfo()
      expect(version.appVersion).toBe('2.0.0')
    })
  })

  describe('2. 主窗口与面板切换 (App Navigation)', () => {
    it('默认展示通用设置面板', async () => {
      const wrapper = mount(App)
      await new Promise((r) => setTimeout(r, 50))

      expect(wrapper.findComponent(GeneralSettings).exists()).toBe(true)
      expect(wrapper.findComponent(PluginManagement).exists()).toBe(false)
      expect(wrapper.findComponent(AboutSettings).exists()).toBe(false)
      expect(wrapper.find('.header-title').text()).toBe('通用设置')
    })

    it('点击侧边栏各选项能够平滑切换各模块面板', async () => {
      const wrapper = mount(App)
      await new Promise((r) => setTimeout(r, 50))

      // 切换到插件管理
      const navPlugins = wrapper.find('[data-testid="nav-plugins"]')
      await navPlugins.trigger('click')
      expect(wrapper.findComponent(PluginManagement).exists()).toBe(true)
      expect(wrapper.findComponent(GeneralSettings).exists()).toBe(false)
      expect(wrapper.find('.header-title').text()).toBe('插件管理')

      // 切换到关于与更新
      const navAbout = wrapper.find('[data-testid="nav-about"]')
      await navAbout.trigger('click')
      expect(wrapper.findComponent(AboutSettings).exists()).toBe(true)
      expect(wrapper.findComponent(PluginManagement).exists()).toBe(false)
      expect(wrapper.find('.header-title').text()).toBe('关于与更新')

      // 切回通用设置
      const navGeneral = wrapper.find('[data-testid="nav-general"]')
      await navGeneral.trigger('click')
      expect(wrapper.findComponent(GeneralSettings).exists()).toBe(true)
      expect(wrapper.find('.header-title').text()).toBe('通用设置')
    })
  })

  describe('3. 通用设置读写逻辑 (General Settings)', () => {
    it('读取配置并在 UI 中正确呈现', async () => {
      const wrapper = mount(GeneralSettings)
      await new Promise((r) => setTimeout(r, 50))

      const autostartInput = wrapper.find('[data-testid="autostart-toggle"] input')
      const trayInput = wrapper.find('[data-testid="tray-toggle"] input')
      const hotkeyDisplay = wrapper.find('[data-testid="hotkey-display"]')

      expect((autostartInput.element as HTMLInputElement).checked).toBe(false)
      expect((trayInput.element as HTMLInputElement).checked).toBe(true)
      expect(hotkeyDisplay.text()).toContain('Ctrl')
      expect(hotkeyDisplay.text()).toContain('Shift')
      expect(hotkeyDisplay.text()).toContain('Z')
    })

    it('支持开机启动与常驻托盘开关交互与持久化', async () => {
      const wrapper = mount(GeneralSettings)
      await new Promise((r) => setTimeout(r, 50))

      const autostartInput = wrapper.find('[data-testid="autostart-toggle"] input')
      await autostartInput.setValue(true)
      expect(bridge.getMockStore().general.autostart).toBe(true)

      const trayInput = wrapper.find('[data-testid="tray-toggle"] input')
      await trayInput.setValue(false)
      expect(bridge.getMockStore().general.minimizeToTray).toBe(false)
    })

    it('支持浅色、深色与跟随系统主题切换并同步 DOM 属性', async () => {
      const wrapper = mount(GeneralSettings)
      await new Promise((r) => setTimeout(r, 50))

      // 切换至深色模式
      const darkBtn = wrapper.find('[data-testid="theme-dark"]')
      await darkBtn.trigger('click')
      expect(bridge.getMockStore().general.theme).toBe('dark')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
      expect(document.documentElement.classList.contains('dark')).toBe(true)

      // 切换至浅色模式
      const lightBtn = wrapper.find('[data-testid="theme-light"]')
      await lightBtn.trigger('click')
      expect(bridge.getMockStore().general.theme).toBe('light')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it('支持全局呼出键清空与重置为默认键', async () => {
      const wrapper = mount(GeneralSettings)
      await new Promise((r) => setTimeout(r, 50))

      // 清除快捷键
      const clearBtn = wrapper.find('[data-testid="clear-hotkey-btn"]')
      await clearBtn.trigger('click')
      expect(bridge.getMockStore().general.globalHotkey).toBe('')
      expect(wrapper.text()).toContain('未设置')

      // 重置为默认快捷键
      const resetBtn = wrapper.find('[data-testid="reset-hotkey-btn"]')
      await resetBtn.trigger('click')
      expect(bridge.getMockStore().general.globalHotkey).toBe('Ctrl+Shift+Z')
      expect(wrapper.text()).toContain('Ctrl')
    })

    it('支持快捷键录制流程', async () => {
      const wrapper = mount(GeneralSettings)
      await new Promise((r) => setTimeout(r, 50))

      const hotkeyDisplay = wrapper.find('[data-testid="hotkey-display"]')
      await hotkeyDisplay.trigger('click')
      expect(wrapper.text()).toContain('正在录制按键')

      // 模拟按下 Alt+K
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        altKey: true,
        bubbles: true,
        cancelable: true
      })
      window.dispatchEvent(event)
      await wrapper.vm.$nextTick()

      expect(bridge.getMockStore().general.globalHotkey).toBe('Alt+K')
    })
  })

  describe('4. 插件管理模块 (Plugin Management)', () => {
    it('正确展示插件列表及状态统计', async () => {
      const wrapper = mount(PluginManagement)
      await new Promise((r) => setTimeout(r, 50))

      expect(wrapper.text()).toContain('备忘快贴')
      expect(wrapper.text()).toContain('超级计算器')
      expect(wrapper.text()).toContain('共 5 个插件')
    })

    it('支持搜索框过滤插件', async () => {
      const wrapper = mount(PluginManagement)
      await new Promise((r) => setTimeout(r, 50))

      const searchInput = wrapper.find('[data-testid="plugin-search-input"]')
      await searchInput.setValue('计算器')

      expect(wrapper.text()).toContain('超级计算器')
      expect(wrapper.text()).not.toContain('备忘快贴')

      // 清空搜索框
      await searchInput.setValue('')
      expect(wrapper.text()).toContain('备忘快贴')
    })

    it('支持切换插件启用/停用状态', async () => {
      const wrapper = mount(PluginManagement)
      await new Promise((r) => setTimeout(r, 50))

      const memoToggle = wrapper.find('[data-testid="toggle-memo"] input')
      expect((memoToggle.element as HTMLInputElement).checked).toBe(true)

      // 点击切换停用
      await memoToggle.setValue(false)
      await new Promise((r) => setTimeout(r, 20))

      const memo = bridge.getMockStore().plugins.find((p) => p.id === 'memo')
      expect(memo?.enabled).toBe(false)
    })

    it('支持打开插件所在目录与启动插件', async () => {
      const wrapper = mount(PluginManagement)
      await new Promise((r) => setTimeout(r, 50))

      const openDirBtn = wrapper.find('[data-testid="open-dir-memo"]')
      await openDirBtn.trigger('click')

      const openPluginBtn = wrapper.find('[data-testid="open-plugin-memo"]')
      await openPluginBtn.trigger('click')

      expect(wrapper.emitted('notify')).toBeTruthy()
    })

    it('支持带有确认防护的插件卸载流程', async () => {
      const wrapper = mount(PluginManagement)
      await new Promise((r) => setTimeout(r, 50))

      expect(wrapper.find('[data-testid="uninstall-modal"]').exists()).toBe(false)

      // 点击备忘快贴的卸载按钮
      const uninstallBtn = wrapper.find('[data-testid="uninstall-memo"]')
      await uninstallBtn.trigger('click')

      // 验证模态确认框弹出
      expect(wrapper.find('[data-testid="uninstall-modal"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('确认卸载插件？')

      // 点击取消
      const cancelBtn = wrapper.find('[data-testid="cancel-uninstall-btn"]')
      await cancelBtn.trigger('click')
      expect(wrapper.find('[data-testid="uninstall-modal"]').exists()).toBe(false)
      expect(bridge.getMockStore().plugins.some((p) => p.id === 'memo')).toBe(true)

      // 重新打开并点击确认卸载
      await uninstallBtn.trigger('click')
      const confirmBtn = wrapper.find('[data-testid="confirm-uninstall-btn"]')
      await confirmBtn.trigger('click')
      await new Promise((r) => setTimeout(r, 20))

      // 验证已被彻底移除
      expect(bridge.getMockStore().plugins.some((p) => p.id === 'memo')).toBe(false)
      expect(wrapper.text()).not.toContain('备忘快贴')
    })
  })

  describe('5. 关于与更新模块 (About & Updates)', () => {
    it('正确展示应用与前端视图版本', async () => {
      const wrapper = mount(AboutSettings)
      await new Promise((r) => setTimeout(r, 50))

      const appBadge = wrapper.find('[data-testid="app-version-badge"]')
      const webBadge = wrapper.find('[data-testid="web-version-badge"]')

      expect(appBadge.text()).toContain('App 1.0.0')
      expect(webBadge.text()).toContain('Web 1.0.0')
    })

    it('点击检查更新能触发更新检测并展示结果状态', async () => {
      const wrapper = mount(AboutSettings)
      await new Promise((r) => setTimeout(r, 50))

      const checkBtn = wrapper.find('[data-testid="check-update-btn"]')
      await checkBtn.trigger('click')

      // 等待异步检查返回
      await new Promise((r) => setTimeout(r, 500))

      const statusBox = wrapper.find('[data-testid="update-status-box"]')
      expect(statusBox.exists()).toBe(true)
      expect(statusBox.text()).toContain('当前已是最新版本')
    })

    it('点击官方链接能够安全调用外部打开通道', async () => {
      const openSpy = vi.spyOn(bridge, 'openExternal')
      const wrapper = mount(AboutSettings)
      await new Promise((r) => setTimeout(r, 50))

      await wrapper.find('[data-testid="link-website"]').trigger('click')
      expect(openSpy).toHaveBeenCalledWith('https://www.ztools.cn')

      await wrapper.find('[data-testid="link-license"]').trigger('click')
      expect(openSpy).toHaveBeenCalledWith('https://opensource.org/licenses/MIT')

      await wrapper.find('[data-testid="link-docs"]').trigger('click')
      expect(openSpy).toHaveBeenCalledWith('https://www.ztools.cn/docs')
    })
  })
})
