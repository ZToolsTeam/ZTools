import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { Modal } from 'ant-design-vue'
import MyPage, { resetHomeLayoutCache } from '../MyPage.vue'
import { usePluginsStore } from '@/stores/plugins'
import { useUserStore } from '@edition'

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      {
        path: '/list/:category?',
        name: 'list',
        component: { template: '<div />' }
      },
      {
        path: '/detail/:id',
        name: 'details',
        component: { template: '<div />' }
      },
      {
        path: '/advanced-settings',
        name: 'advanced-settings',
        component: { template: '<div />' }
      }
    ]
  })
}

describe('MyPage Component', () => {
  let wrapper
  let router
  let pluginsStore
  let userStore
  let configValues
  let modalConfirmSpy
  let onMock
  let offMock
  let activeEventHandlers

  const basePlugins = [
    { pluginId: 'plugin-1', name: 'Plugin 1' },
    { pluginId: 'plugin-2', name: 'Plugin 2' },
    { pluginId: 'plugin-3', name: 'Plugin 3' }
  ]

  const mountOptions = {
    global: {
      stubs: {
        PluginCard3D: true,
        Empty: true,
        Button: true,
        Spin: true,
        RocketOutlined: true,
        AppstoreOutlined: true
      }
    }
  }

  function mockConfigGet(key, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(configValues, key)) {
      return Promise.resolve(configValues[key])
    }
    return Promise.resolve(defaultValue)
  }

  async function mountPage({
    installedPlugins = [],
    favoritePluginsList = [],
    recommendedItems = [],
    favorites = [],
    // 默认与运行时加载完收藏详情后的状态一致；测试加载中的情况时传 false
    favoritePluginsLoaded = true,
    config = {}
  } = {}) {
    configValues = {
      'plugins.favorites': JSON.stringify(favorites),
      'plugins.recents': '[]',
      'my-page.pinned': '[]',
      'my-page.recent-order': '[]',
      'my-page.drag-tip-shown': '',
      ...config
    }

    router = createTestRouter()
    await router.push('/')
    await router.isReady()

    pluginsStore.$patch({
      favorites: new Set(favorites),
      installedSet: new Set(installedPlugins.map((plugin) => plugin.pluginId)),
      installedPlugins,
      favoritePluginsList,
      favoritePluginsLoaded,
      recommendedItems,
      downloadingSet: new Set(),
      updateMap: {}
    })

    wrapper = mount(MyPage, {
      ...mountOptions,
      global: {
        ...mountOptions.global,
        plugins: [router]
      }
    })

    await flushPromises()
    return wrapper
  }

  async function emitZtoolsEvent(eventType, payload = {}) {
    const handlers = [...(activeEventHandlers.get(eventType) || [])]
    await Promise.all(handlers.map((handler) => handler({ payload })))
  }

  beforeEach(() => {
    resetHomeLayoutCache()
    setActivePinia(createPinia())
    pluginsStore = usePluginsStore()
    userStore = useUserStore()

    pluginsStore.init = vi.fn().mockResolvedValue(undefined)
    pluginsStore.fetchInstalledPlugins = vi.fn().mockResolvedValue(undefined)
    pluginsStore.loadRecommendedPlugins = vi.fn().mockResolvedValue(undefined)
    pluginsStore.pushToCloud = vi.fn().mockResolvedValue({ success: true })
    pluginsStore.openPlugin = vi.fn()
    pluginsStore.uninstallPlugin = vi.fn()
    pluginsStore.toggleFavorite = vi.fn().mockResolvedValue(undefined)
    pluginsStore.startDownload = vi.fn()
    pluginsStore.endDownload = vi.fn()

    userStore.isLoggedIn = false

    activeEventHandlers = new Map()
    onMock = vi.fn((eventType, handler) => {
      if (!activeEventHandlers.has(eventType)) {
        activeEventHandlers.set(eventType, new Set())
      }
      activeEventHandlers.get(eventType).add(handler)
    })
    offMock = vi.fn((eventType, handler) => {
      const handlers = activeEventHandlers.get(eventType)
      handlers?.delete(handler)
      if (handlers?.size === 0) activeEventHandlers.delete(eventType)
    })
    configValues = {}

    global.window.ztools = {
      config: {
        get: vi.fn(mockConfigGet),
        set: vi.fn().mockResolvedValue(true)
      },
      events: {
        on: onMock,
        off: offMock,
        emit: vi.fn()
      },
      user: {
        isLoggedIn: vi.fn().mockResolvedValue(false),
        getInfo: vi.fn().mockResolvedValue({ loggedIn: false, user: null })
      },
      sys: {
        getInfo: vi.fn().mockResolvedValue({ platform: 'windows' })
      }
    }

    modalConfirmSpy = vi
      .spyOn(Modal, 'confirm')
      .mockImplementation(({ onOk } = {}) => onOk?.())

    for (const spy of Object.values(toastSpies)) {
      spy.mockClear()
    }
  })

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount()
      wrapper = null
    }
    activeEventHandlers.clear()
    modalConfirmSpy.mockRestore()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe('lifecycle', () => {
    it('loads initial data and registers native events', async () => {
      await mountPage()

      expect(wrapper.exists()).toBe(true)
      expect(pluginsStore.init).toHaveBeenCalledTimes(1)
      expect(pluginsStore.fetchInstalledPlugins).toHaveBeenCalledTimes(1)
      expect(pluginsStore.loadRecommendedPlugins).toHaveBeenCalledWith(8)
      expect(wrapper.vm.favoritePlugins).toEqual([])
      expect(wrapper.vm.recommendedPlugins).toEqual([])
      expect(onMock).toHaveBeenCalledWith(
        'plugin_install_complete',
        wrapper.vm.handlePluginInstalled
      )
      expect(onMock).toHaveBeenCalledWith(
        'plugin_uninstalled',
        wrapper.vm.handlePluginUninstalled
      )
    })

    it('removes event and window listeners on unmount and does not duplicate them after remount', async () => {
      await mountPage()

      expect(activeEventHandlers.get('plugin_install_complete').size).toBe(1)
      expect(activeEventHandlers.get('plugin_uninstalled').size).toBe(1)

      wrapper.unmount()
      wrapper = null

      expect(offMock).toHaveBeenCalledWith(
        'plugin_install_complete',
        expect.any(Function)
      )
      expect(offMock).toHaveBeenCalledWith(
        'plugin_uninstalled',
        expect.any(Function)
      )
      expect(activeEventHandlers.size).toBe(0)

      await mountPage()

      expect(activeEventHandlers.get('plugin_install_complete').size).toBe(1)
      expect(activeEventHandlers.get('plugin_uninstalled').size).toBe(1)

      await emitZtoolsEvent('plugin_install_complete', {
        pluginId: 'plugin-1',
        success: true
      })
      expect(pluginsStore.fetchInstalledPlugins).toHaveBeenCalledTimes(3)

      const page = wrapper
      page.vm.selectedPlugin = basePlugins[0]
      page.unmount()
      wrapper = null

      const fetchCountAfterUnmount =
        pluginsStore.fetchInstalledPlugins.mock.calls.length
      await emitZtoolsEvent('plugin_install_complete', {
        pluginId: 'plugin-1',
        success: true
      })
      expect(pluginsStore.fetchInstalledPlugins).toHaveBeenCalledTimes(
        fetchCountAfterUnmount
      )

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
      expect(pluginsStore.openPlugin).not.toHaveBeenCalled()

      page.vm.showMenu = true
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(page.vm.showMenu).toBe(true)
    })

    it('does not leave listeners behind when unmounted during host-platform detection', async () => {
      let resolveHostInfo
      window.ztools.sys.getInfo.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveHostInfo = resolve
          })
      )

      const page = await mountPage()
      expect(onMock).toHaveBeenCalledTimes(2)

      page.vm.selectedPlugin = basePlugins[0]
      page.unmount()
      wrapper = null

      expect(offMock).toHaveBeenCalledTimes(2)
      expect(activeEventHandlers.size).toBe(0)

      resolveHostInfo({ platform: 'windows' })
      await flushPromises()

      expect(onMock).toHaveBeenCalledTimes(2)
      expect(activeEventHandlers.size).toBe(0)

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
      expect(pluginsStore.openPlugin).not.toHaveBeenCalled()
    })

    it('reads persisted drag-tip state from ztools config', async () => {
      await mountPage({
        config: {
          'my-page.drag-tip-shown': 'true'
        }
      })

      expect(wrapper.vm.showDragTip).toBe(false)
    })
  })

  describe('pinning and ordering', () => {
    it('pins, unpins and toggles plugins via ztools config', async () => {
      await mountPage({ installedPlugins: basePlugins })

      await wrapper.vm.pinPlugin('plugin-1')
      expect(wrapper.vm.getPinnedList()).toEqual(['plugin-1'])
      expect(window.ztools.config.set).toHaveBeenCalledWith(
        'my-page.pinned',
        '["plugin-1"]',
        false,
        'my_page_settings.json'
      )

      await wrapper.vm.unpinPlugin('plugin-1')
      expect(wrapper.vm.getPinnedList()).toEqual([])

      wrapper.vm.togglePin('plugin-2')
      await flushPromises()
      expect(wrapper.vm.getPinnedList()).toEqual(['plugin-2'])
    })

    it('loads pinned list from config on mount', async () => {
      await mountPage({
        config: {
          'my-page.pinned': '["plugin-1","plugin-2"]'
        }
      })

      expect(wrapper.vm.getPinnedList()).toEqual(['plugin-1', 'plugin-2'])
    })

    it('debounces reorder persistence with ztools config', async () => {
      vi.useFakeTimers()

      await mountPage({
        installedPlugins: basePlugins
      })

      wrapper.vm.reorderPlugins(basePlugins[0], 2)
      expect(window.ztools.config.set).not.toHaveBeenCalledWith(
        'my-page.recent-order',
        expect.any(String),
        false,
        'my_page_settings.json'
      )

      vi.advanceTimersByTime(300)
      await flushPromises()

      expect(window.ztools.config.set).toHaveBeenCalledWith(
        'my-page.recent-order',
        '["plugin-2","plugin-3","plugin-1"]',
        false,
        'my_page_settings.json'
      )
    })
  })

  describe('cloud sync', () => {
    it('syncs pinned list through the store when logged in', async () => {
      await mountPage({
        installedPlugins: basePlugins,
        config: {
          'my-page.pinned': '["plugin-1"]'
        }
      })
      userStore.isLoggedIn = true

      await wrapper.vm.syncPinnedToCloud()

      expect(pluginsStore.pushToCloud).toHaveBeenCalledWith({
        pinned_list: ['plugin-1']
      })
      expect(wrapper.vm.syncError).toBe(null)
    })

    it('does not sync when logged out', async () => {
      await mountPage()
      userStore.isLoggedIn = false

      await wrapper.vm.syncPinnedToCloud()

      expect(pluginsStore.pushToCloud).not.toHaveBeenCalled()
    })

    it('stores sync errors on failure', async () => {
      await mountPage({
        config: {
          'my-page.pinned': '["plugin-1"]'
        }
      })
      userStore.isLoggedIn = true
      pluginsStore.pushToCloud.mockRejectedValueOnce(new Error('Sync failed'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await wrapper.vm.syncPinnedToCloud()

      expect(wrapper.vm.syncError).toBe('Sync failed')
      warnSpy.mockRestore()
    })
  })

  describe('event handling', () => {
    it('refreshes installed plugins after install and syncs plugin list', async () => {
      await mountPage({
        installedPlugins: basePlugins.slice(0, 2)
      })
      userStore.isLoggedIn = true

      await wrapper.vm.handlePluginInstalled({
        payload: { pluginId: 'plugin-2', success: true }
      })
      await flushPromises()

      expect(pluginsStore.fetchInstalledPlugins).toHaveBeenCalled()
      expect(pluginsStore.pushToCloud).toHaveBeenCalledWith({
        plugin_list: ['plugin-1', 'plugin-2']
      })
      expect(toastSpies.info).toHaveBeenCalledWith('插件已安装')
    })

    it('removes uninstalled plugins from local state and cloud payload', async () => {
      await mountPage({
        installedPlugins: [basePlugins[1]],
        config: {
          'my-page.pinned': '["plugin-1"]',
          'my-page.recent-order': '["plugin-1","plugin-2"]'
        }
      })
      userStore.isLoggedIn = true

      wrapper.vm.handlePluginUninstalled({
        payload: { pluginId: 'plugin-1' }
      })
      await flushPromises()

      expect(wrapper.vm.getPinnedList()).toEqual([])
      expect(window.ztools.config.set).toHaveBeenCalledWith(
        'my-page.recent-order',
        '["plugin-2"]',
        false,
        'my_page_settings.json'
      )
      expect(pluginsStore.pushToCloud).toHaveBeenCalledWith({
        plugin_list: ['plugin-2'],
        plugin_order: ['plugin-2'],
        pinned_list: []
      })
      expect(toastSpies.info).toHaveBeenCalledWith('插件已卸载')
    })
  })

  describe('keyboard shortcuts and menu', () => {
    it('handles ctrl+p and enter for the selected plugin', async () => {
      await mountPage({ installedPlugins: basePlugins })

      wrapper.vm.selectedPlugin = basePlugins[0]
      wrapper.vm.handleKeyDown({
        key: 'p',
        ctrlKey: true,
        preventDefault: vi.fn()
      })
      await flushPromises()

      expect(wrapper.vm.isPinned('plugin-1')).toBe(true)

      wrapper.vm.handleKeyDown({
        key: 'Enter',
        ctrlKey: false,
        preventDefault: vi.fn()
      })

      expect(pluginsStore.openPlugin).toHaveBeenCalledWith('plugin-1')
    })

    it('uses Command+P on macOS and does not treat physical Control+P as the pin shortcut', async () => {
      window.ztools.sys.getInfo.mockResolvedValue({ platform: 'macos' })
      await mountPage({ installedPlugins: basePlugins })

      wrapper.vm.selectedPlugin = basePlugins[0]
      const commandEvent = {
        key: 'p',
        ctrlKey: false,
        metaKey: true,
        preventDefault: vi.fn()
      }
      wrapper.vm.handleKeyDown(commandEvent)
      await flushPromises()

      expect(commandEvent.preventDefault).toHaveBeenCalledOnce()
      expect(wrapper.vm.isPinned('plugin-1')).toBe(true)

      const controlEvent = {
        key: 'p',
        ctrlKey: true,
        metaKey: false,
        preventDefault: vi.fn()
      }
      wrapper.vm.handleKeyDown(controlEvent)
      await flushPromises()

      expect(controlEvent.preventDefault).not.toHaveBeenCalled()
      expect(wrapper.vm.isPinned('plugin-1')).toBe(true)
    })

    it('does not guess the platform-specific pin modifier when host detection is unknown', async () => {
      window.ztools.sys.getInfo.mockResolvedValue({ platform: 'unknown' })
      await mountPage({ installedPlugins: basePlugins })

      wrapper.vm.selectedPlugin = basePlugins[0]
      const event = {
        key: 'p',
        ctrlKey: true,
        metaKey: false,
        preventDefault: vi.fn()
      }
      wrapper.vm.handleKeyDown(event)
      await flushPromises()

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(wrapper.vm.isPinned('plugin-1')).toBe(false)
    })

    it('confirms uninstall on delete', async () => {
      await mountPage({ installedPlugins: basePlugins })

      wrapper.vm.selectedPlugin = basePlugins[0]
      wrapper.vm.handleKeyDown({
        key: 'Delete',
        ctrlKey: false,
        preventDefault: vi.fn()
      })

      expect(Modal.confirm).toHaveBeenCalled()
      expect(pluginsStore.uninstallPlugin).toHaveBeenCalledWith('plugin-1')
    })

    it('卸载结果如实提示：成功、抛错、宿主返回 success:false 三种情况', async () => {
      await mountPage({ installedPlugins: basePlugins })

      pluginsStore.uninstallPlugin = vi.fn().mockResolvedValue({ success: true })
      wrapper.vm.handleUninstallPlugin('plugin-1')
      await flushPromises()
      expect(toastSpies.toastSuccess).toHaveBeenCalledWith('插件已卸载')

      pluginsStore.uninstallPlugin = vi.fn().mockRejectedValue(new Error('当前平台不支持桌面快捷方式'))
      wrapper.vm.handleUninstallPlugin('plugin-2')
      await flushPromises()
      expect(toastSpies.toastError).toHaveBeenCalledWith('卸载失败: 当前平台不支持桌面快捷方式')

      toastSpies.toastSuccess.mockClear()
      pluginsStore.uninstallPlugin = vi.fn().mockResolvedValue({ success: false, error: '插件正在执行其他操作' })
      wrapper.vm.handleUninstallPlugin('plugin-3')
      await flushPromises()
      expect(toastSpies.toastError).toHaveBeenCalledWith('卸载失败: 插件正在执行其他操作')
      expect(toastSpies.toastSuccess).not.toHaveBeenCalled()
    })

    it('内置插件：右键菜单提供卸载并直接跳转设置页；按键盘 Delete 弹出防误触确认框，取消不跳转、确认后跳转设置页', async () => {
      const bundled = { pluginId: 'calculator', name: '计算器' }
      await mountPage({ installedPlugins: [...basePlugins, bundled] })
      Modal.confirm.mockClear()

      let capturedModalOpts = null
      modalConfirmSpy.mockImplementationOnce((opts) => {
        capturedModalOpts = opts
      })
      wrapper.vm.selectedPlugin = bundled
      wrapper.vm.handleKeyDown({ key: 'Delete', ctrlKey: false, preventDefault: vi.fn() })
      await flushPromises()
      expect(Modal.confirm).toHaveBeenCalledTimes(1)
      expect(capturedModalOpts?.title).toBe('前往设置管理内置插件')
      expect(pluginsStore.uninstallPlugin).not.toHaveBeenCalled()
      expect(router.currentRoute.value.name).toBe('home')

      capturedModalOpts?.onOk?.()
      await flushPromises()
      expect(router.currentRoute.value.name).toBe('advanced-settings')
      expect(router.currentRoute.value.query.manageBundled).toBe('calculator')

      await router.push('/')
      Modal.confirm.mockClear()
      wrapper.vm.showPluginMenu(bundled, { preventDefault() {}, clientX: 10, clientY: 10 })
      await flushPromises()
      expect(wrapper.find('.context-menu').exists()).toBe(true)
      const dangerItem = wrapper.find('.context-menu .menu-item.danger')
      expect(dangerItem.exists()).toBe(true)
      expect(dangerItem.text()).toContain('卸载')
      await dangerItem.trigger('click')
      await flushPromises()
      expect(Modal.confirm).not.toHaveBeenCalled()
      expect(pluginsStore.uninstallPlugin).not.toHaveBeenCalled()
      expect(router.currentRoute.value.name).toBe('advanced-settings')
      expect(router.currentRoute.value.query.manageBundled).toBe('calculator')
    })

    it('插件市场分发的官方插件（kill-process）装在插件目录里，可以从“我的”页面卸载', async () => {
      const storeOfficial = { pluginId: 'kill-process', name: '结束进程' }
      await mountPage({ installedPlugins: [...basePlugins, storeOfficial] })
      Modal.confirm.mockClear()
      pluginsStore.uninstallPlugin = vi.fn().mockResolvedValue({ success: true })

      wrapper.vm.showPluginMenu(storeOfficial, { preventDefault() {}, clientX: 10, clientY: 10 })
      await flushPromises()
      expect(wrapper.find('.context-menu .menu-item.danger').text()).toContain('卸载')

      wrapper.vm.handleUninstallPlugin('kill-process')
      await flushPromises()
      expect(Modal.confirm).toHaveBeenCalled()
      expect(pluginsStore.uninstallPlugin).toHaveBeenCalledWith('kill-process')
      expect(toastSpies.toastSuccess).toHaveBeenCalledWith('插件已卸载')
    })

    it('[破坏性] 卸载确认框打开时，回车和 Delete 不会再打开或卸载列表里的插件', async () => {
      await mountPage({ installedPlugins: basePlugins })
      wrapper.vm.selectedPlugin = basePlugins[0]
      Modal.confirm.mockClear()
      const wrap = document.createElement('div')
      wrap.className = 'ant-modal-wrap'
      document.body.appendChild(wrap)
      try {
        const enter = { key: 'Enter', ctrlKey: false, preventDefault: vi.fn() }
        wrapper.vm.handleKeyDown(enter)
        wrapper.vm.handleKeyDown({ key: 'Delete', ctrlKey: false, preventDefault: vi.fn() })
        await flushPromises()
        expect(enter.preventDefault).not.toHaveBeenCalled()
        expect(pluginsStore.openPlugin).not.toHaveBeenCalled()
        expect(Modal.confirm).not.toHaveBeenCalled()
      } finally {
        wrap.remove()
      }
    })

    it('shows and hides the plugin context menu', async () => {
      await mountPage({ installedPlugins: basePlugins })
      const event = {
        clientX: 100,
        clientY: 200,
        preventDefault: vi.fn()
      }

      wrapper.vm.showPluginMenu(basePlugins[0], event)
      expect(wrapper.vm.showMenu).toBe(true)
      expect(wrapper.vm.selectedPlugin).toEqual(basePlugins[0])
      expect(wrapper.vm.menuPosition).toEqual({ x: 100, y: 200 })

      wrapper.vm.hideMenu()
      expect(wrapper.vm.showMenu).toBe(false)
      expect(wrapper.vm.selectedPlugin).toBe(null)
    })
  })

  describe('computed state', () => {
    it('returns favorite plugins from the store', async () => {
      const favoritePluginsList = [basePlugins[0], basePlugins[2]]

      await mountPage({
        favoritePluginsList,
        favorites: ['plugin-1', 'plugin-3']
      })

      expect(wrapper.vm.favoritePlugins).toEqual(favoritePluginsList)
    })

    it('filters installed plugins out of recommendations and caps the list', async () => {
      const recommendedItems = Array.from({ length: 10 }, (_, index) => ({
        pluginId: `plugin-${index + 1}`,
        name: `Plugin ${index + 1}`
      }))

      await mountPage({
        installedPlugins: [recommendedItems[0]],
        recommendedItems
      })

      expect(wrapper.vm.recommendedPlugins).toHaveLength(8)
      expect(
        wrapper.vm.recommendedPlugins.some(
          (plugin) => plugin.pluginId === recommendedItems[0].pluginId
        )
      ).toBe(false)
    })

    it('counts only installed pinned plugins', async () => {
      await mountPage({
        installedPlugins: basePlugins,
        config: {
          'my-page.pinned': '["plugin-1","plugin-3"]'
        }
      })

      expect(wrapper.vm.pinnedCount).toBe(2)
      expect(wrapper.vm.canPin).toBe(true)
    })
  })

  describe('drag tip', () => {
    it('persists drag-tip dismissal through ztools config', async () => {
      await mountPage()

      wrapper.vm.hideDragTip()

      expect(wrapper.vm.showDragTip).toBe(false)
      expect(window.ztools.config.set).toHaveBeenCalledWith(
        'my-page.drag-tip-shown',
        'true',
        false,
        'my_page_settings.json'
      )
    })
  })

  describe('工作台紧凑布局（常用磁贴 / 最近使用）', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ pluginId: `p-${i}`, name: `插件 ${i}`, category: '系统工具' }))

    it('默认只显示两行磁贴（列数 × 2），其余收进「查看全部」', async () => {
      await mountPage({ installedPlugins: many })
      const tiles = wrapper.findAll('.plugin-tile')
      // jsdom 无布局，列数回退为默认 5 列
      expect(tiles).toHaveLength(10)
      expect(wrapper.text()).toContain('查看全部')
    })

    it('最近使用按打开记录排序，跳过已卸载项并最多 5 条，点击直接打开', async () => {
      await mountPage({ installedPlugins: many })
      pluginsStore.$patch({ recents: ['p-3', 'ghost-uninstalled', 'p-1', 'p-4', 'p-5', 'p-6', 'p-7'] })
      await flushPromises()
      const rows = wrapper.findAll('.recent-row')
      expect(rows.map((r) => r.find('.recent-name').text())).toEqual(['插件 3', '插件 1', '插件 4', '插件 5', '插件 6'])
      await rows[0].trigger('click')
      expect(pluginsStore.openPlugin).toHaveBeenCalledWith('p-3')
    })

    it('没有最近记录时不渲染「最近使用」，推荐为空时不渲染空状态占位', async () => {
      await mountPage({ installedPlugins: basePlugins, recommendedItems: [] })
      expect(wrapper.find('.recent-list').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('热门推荐')
      expect(wrapper.find('.market-banner').exists()).toBe(true)
    })

    describe('切换「已安装 / 收藏」时高度不变', () => {
      const switchTo = async (tab) => {
        const seg = wrapper.findComponent({ name: 'RcSegmented' })
        seg.vm.$emit('update:modelValue', tab)
        seg.vm.$emit('change', tab)
        await flushPromises()
      }
      const pane = (index) => wrapper.findAll('.my-plugins-pane')[index]
      const tabCounts = () => wrapper.findComponent({ name: 'RcSegmented' }).props('options').map((o) => o.count)

      it('两个标签叠放：当前标签显示真实磁贴，另一个是不可见、不可操作的同数量占位', async () => {
        const favs = many.slice(0, 3)
        await mountPage({ installedPlugins: many, favoritePluginsList: favs, favorites: favs.map((p) => p.pluginId) })
        expect(wrapper.findAll('.my-plugins-pane')).toHaveLength(2)
        // 已安装：真实磁贴（收起后 10 个）；收藏：3 个占位，隐藏且不可聚焦
        expect(pane(0).classes()).toContain('is-active')
        // 当前标签不能带 inert（带上就整块不可点击、不可聚焦）
        expect(pane(0).attributes('inert')).toBeUndefined()
        expect(pane(0).attributes('aria-hidden')).toBeUndefined()
        expect(pane(0).findAll('.plugin-tile')).toHaveLength(10)
        expect(pane(1).attributes('aria-hidden')).toBe('true')
        expect(pane(1).attributes('inert')).toBeDefined()
        expect(pane(1).findAll('.plugin-tile')).toHaveLength(0)
        expect(pane(1).findAll('.plugin-tile-skeleton')).toHaveLength(3)

        await switchTo('favorites')
        expect(pane(1).classes()).toContain('is-active')
        expect(pane(1).attributes('inert')).toBeUndefined()
        expect(pane(0).attributes('inert')).toBeDefined()
        expect(pane(1).findAll('.plugin-tile')).toHaveLength(3)
        expect(pane(0).attributes('aria-hidden')).toBe('true')
        expect(pane(0).findAll('.plugin-tile-skeleton')).toHaveLength(10)
        // 全页只有当前标签的磁贴可点
        expect(wrapper.findAll('.plugin-tile')).toHaveLength(3)
      })

      it('收藏为空：收藏标签的空状态与已安装磁贴叠放，切过去显示空状态', async () => {
        await mountPage({ installedPlugins: basePlugins, favorites: [] })
        expect(pane(1).find('.my-plugins-empty').exists()).toBe(true)
        expect(pane(1).text()).toContain('还没有收藏的插件')
        await switchTo('favorites')
        expect(pane(1).classes()).toContain('is-active')
        expect(pane(0).findAll('.plugin-tile-skeleton')).toHaveLength(basePlugins.length)
      })

      it('只有收藏没有已安装：已安装标签是空状态占位，收藏显示磁贴', async () => {
        const favs = [{ pluginId: 'remote-only', name: '远程插件' }]
        await mountPage({ installedPlugins: [], favoritePluginsList: favs, favorites: ['remote-only'] })
        expect(pane(0).find('.my-plugins-empty').exists()).toBe(true)
        await switchTo('favorites')
        expect(pane(1).findAll('.plugin-tile')).toHaveLength(1)
      })

      it('收藏详情加载中：按收藏数显示占位，不先显示「还没有收藏」，加载完换成真实磁贴', async () => {
        const favs = many.slice(0, 4)
        await mountPage({
          installedPlugins: basePlugins,
          favoritePluginsList: [],
          favoritePluginsLoaded: false,
          favorites: favs.map((p) => p.pluginId)
        })
        // 数量先按收藏 ID 计，不显示 0
        expect(tabCounts()).toEqual([basePlugins.length, 4])
        await switchTo('favorites')
        expect(pane(1).text()).not.toContain('还没有收藏的插件')
        expect(pane(1).findAll('.plugin-tile-skeleton')).toHaveLength(4)
        expect(pane(1).find('.plugin-tile-grid').attributes('aria-busy')).toBe('true')
        expect(wrapper.vm.displayedPlugins).toEqual([])

        pluginsStore.$patch({ favoritePluginsList: favs, favoritePluginsLoaded: true })
        await flushPromises()
        expect(pane(1).findAll('.plugin-tile')).toHaveLength(4)
        expect(pane(1).findAll('.plugin-tile-skeleton')).toHaveLength(0)
      })

      it('只有收藏且详情还在加载：区块照常显示占位，不会等加载完才整块出现', async () => {
        await mountPage({ installedPlugins: [], favoritePluginsList: [], favoritePluginsLoaded: false, favorites: ['a', 'b'] })
        expect(wrapper.findAll('.my-plugins-pane')).toHaveLength(2)
        expect(tabCounts()).toEqual([0, 2])
      })

      it('收藏加载失败回填后数量变少：按实际数量显示，空了就是空状态', async () => {
        await mountPage({ installedPlugins: basePlugins, favoritePluginsList: [], favoritePluginsLoaded: false, favorites: ['gone-1', 'gone-2'] })
        await switchTo('favorites')
        expect(pane(1).findAll('.plugin-tile-skeleton')).toHaveLength(2)
        pluginsStore.$patch({ favoritePluginsLoaded: true })
        await flushPromises()
        expect(tabCounts()).toEqual([basePlugins.length, 0])
        expect(pane(1).text()).toContain('还没有收藏的插件')
      })

      it('超过两行时占位也只按收起后的数量，展开「查看全部」只影响当前标签', async () => {
        const favs = many.slice(0, 12)
        await mountPage({ installedPlugins: many, favoritePluginsList: favs, favorites: favs.map((p) => p.pluginId) })
        expect(pane(1).findAll('.plugin-tile-skeleton')).toHaveLength(10)
        wrapper.vm.showAllPlugins = true
        await flushPromises()
        expect(pane(0).findAll('.plugin-tile')).toHaveLength(15)
        expect(pane(1).findAll('.plugin-tile-skeleton')).toHaveLength(10)
        // 切换标签收起展开状态
        await switchTo('favorites')
        expect(wrapper.vm.showAllPlugins).toBe(false)
        expect(pane(1).findAll('.plugin-tile')).toHaveLength(10)
      })
    })

    it('去插件市场横幅只保留右侧箭头一个图标', async () => {
      await mountPage({ installedPlugins: basePlugins })
      const banner = wrapper.find('.market-banner')
      expect(banner.exists()).toBe(true)
      expect(banner.findAll('svg')).toHaveLength(1)
    })

    it('点击已安装磁贴即打开；收藏中未安装的磁贴进入详情页', async () => {
      await mountPage({
        installedPlugins: basePlugins,
        favoritePluginsList: [{ pluginId: 'remote-only', name: '远程插件' }],
        favorites: ['remote-only']
      })
      await wrapper.findAll('.plugin-tile')[1].trigger('click')
      expect(pluginsStore.openPlugin).toHaveBeenCalledWith('plugin-2')

      // 切到「收藏」标签
      wrapper.findComponent({ name: 'RcSegmented' }).vm.$emit('update:modelValue', 'favorites')
      wrapper.findComponent({ name: 'RcSegmented' }).vm.$emit('change', 'favorites')
      await flushPromises()
      const tile = wrapper.findAll('.plugin-tile').find((t) => t.text().includes('远程插件'))
      expect(tile).toBeTruthy()
      expect(tile.text()).toContain('未安装')
      const pushSpy = vi.spyOn(router, 'push').mockResolvedValue(undefined)
      await tile.trigger('click')
      await flushPromises()
      expect(pushSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'details', params: { pluginId: 'remote-only' } }))
      expect(pluginsStore.openPlugin).toHaveBeenCalledTimes(1)
    })

    it('[破坏性] 已下架插件的磁贴点击不会启动，并提示下架原因', async () => {
      await mountPage({ installedPlugins: basePlugins })
      pluginsStore.$patch({ revokedMap: { 'plugin-1': { revoked: true, reason: '安全原因下架' } } })
      await flushPromises()
      const tile = wrapper.findAll('.plugin-tile')[0]
      expect(tile.text()).toContain('已下架')
      await tile.trigger('click')
      expect(pluginsStore.openPlugin).not.toHaveBeenCalled()
      expect(toastSpies.toastError).toHaveBeenCalledWith(expect.stringContaining('安全原因下架'))
    })

    it('右键磁贴弹出操作菜单，并提供「查看详情」', async () => {
      await mountPage({ installedPlugins: basePlugins })
      await wrapper.findAll('.plugin-tile')[0].trigger('contextmenu', { clientX: 40, clientY: 60 })
      await flushPromises()
      expect(wrapper.find('.context-menu').exists()).toBe(true)
      expect(wrapper.find('.context-menu').text()).toContain('查看详情')
    })

    it('[回归] 只有真正可更新且兼容的插件才标记「可更新」', async () => {
      await mountPage({ installedPlugins: basePlugins })
      pluginsStore.$patch({
        updateMap: {
          'plugin-1': { hasUpdate: false },
          'plugin-2': { hasUpdate: true, incompatible: false },
          'plugin-3': { hasUpdate: true, incompatible: true, incompatReason: '宿主版本过低' }
        }
      })
      await flushPromises()
      const labels = wrapper.findAll('.plugin-tile').map((t) => t.text().includes('可更新'))
      expect(labels).toEqual([false, true, false])
    })

    it('磁贴显示插件启动快捷键（来自触发器列表），双击修饰键以文字显示', async () => {
      window.ztools.trigger = {
        list: vi.fn().mockResolvedValue([
          { id: 't1', type: 'hotkey', pluginId: 'plugin-1', config: { key: 'Alt+V' }, action: { mode: 'window', target: 'plugin-1' } },
          { id: 't2', type: 'hotkey', pluginId: 'plugin-2', config: { key: 'DoubleCtrl' }, action: { mode: 'window', target: 'plugin-2' } }
        ])
      }
      await mountPage({ installedPlugins: basePlugins })
      const tiles = wrapper.findAll('.plugin-tile')
      expect(tiles[0].find('.shortcut-keys').exists()).toBe(true)
      expect(tiles[0].findAll('.shortcut-keys kbd').length).toBe(2)
      expect(tiles[1].text()).toContain('双击 Ctrl')
      expect(tiles[2].find('.shortcut-keys').exists()).toBe(false)
    })

    it('[破坏性] 读取触发器失败时磁贴照常显示，只是没有快捷键', async () => {
      window.ztools.trigger = { list: vi.fn().mockRejectedValue(new Error('IPC 断开')) }
      await mountPage({ installedPlugins: basePlugins })
      expect(wrapper.findAll('.plugin-tile')).toHaveLength(3)
      expect(wrapper.find('.plugin-tile .shortcut-keys').exists()).toBe(false)
    })

    it('最近使用显示相对时间，没有记录时间的条目留空', async () => {
      await mountPage({ installedPlugins: basePlugins })
      pluginsStore.$patch({ recents: ['plugin-2', 'plugin-1'], recentUsedAt: { 'plugin-2': Date.now() - 5 * 60_000 } })
      await flushPromises()
      const times = wrapper.findAll('.recent-row .recent-time').map((n) => n.text())
      expect(times).toEqual(['5 分钟前', ''])
    })
  })

  describe('从插件返回首页', () => {
    const names = (w) => w.findAll('.plugin-tile .tile-name').map((n) => n.text())

    it('[回归] 再次进入首页时不先闪「加载中」，并直接按上次的自定义顺序显示', async () => {
      await mountPage({ installedPlugins: basePlugins, config: { 'my-page.recent-order': JSON.stringify(['plugin-3', 'plugin-1', 'plugin-2']) } })
      expect(names(wrapper)).toEqual(['Plugin 3', 'Plugin 1', 'Plugin 2'])
      wrapper.unmount()

      // 第二次挂载：配置读取挂起，模拟主进程还没返回
      let release
      window.ztools.config.get = vi.fn(() => new Promise((r) => { release = r }))
      wrapper = mount(MyPage, { ...mountOptions, global: { ...mountOptions.global, plugins: [router] } })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.loading-container').exists()).toBe(false)
      expect(names(wrapper)).toEqual(['Plugin 3', 'Plugin 1', 'Plugin 2'])
      release?.('[]')
    })

    it('[破坏性] 再次进入时读取排序失败，仍保留上次顺序且页面不报错', async () => {
      await mountPage({ installedPlugins: basePlugins, config: { 'my-page.recent-order': JSON.stringify(['plugin-2', 'plugin-3', 'plugin-1']) } })
      wrapper.unmount()
      window.ztools.config.get = vi.fn().mockRejectedValue(new Error('IPC 超时'))
      wrapper = mount(MyPage, { ...mountOptions, global: { ...mountOptions.global, plugins: [router] } })
      await flushPromises()
      expect(wrapper.find('.loading-container').exists()).toBe(false)
      expect(names(wrapper).slice(0, 1)).toEqual(['Plugin 2'])
    })

    it('[回归] 切换标签、展开全部并移动卡片焦点后，从插件返回仍保持原标签、展开态与卡片焦点', async () => {
      await mountPage({ installedPlugins: basePlugins })
      wrapper.vm.activeTab = 'favorites'
      wrapper.vm.showAllPlugins = true
      wrapper.vm.focusedCardIndex = 2
      await wrapper.vm.$nextTick()
      wrapper.unmount()

      wrapper = mount(MyPage, { ...mountOptions, global: { ...mountOptions.global, plugins: [router] } })
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.activeTab).toBe('favorites')
      expect(wrapper.vm.showAllPlugins).toBe(true)
      expect(wrapper.vm.focusedCardIndex).toBe(2)
    })

    it('首次启动仍显示加载状态', async () => {
      pluginsStore.$patch({ installedPlugins: basePlugins })
      router = createTestRouter()
      await router.push('/')
      await router.isReady()
      window.ztools.config.get = vi.fn(() => new Promise(() => {}))
      wrapper = mount(MyPage, { ...mountOptions, global: { ...mountOptions.global, plugins: [router] } })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.loading-container').exists()).toBe(true)
    })
  })
  it.each(['pending', 'busy'])('安装%s时不误报完成', async state => {
    await mountPage({ installedPlugins: basePlugins })
    pluginsStore.installPlugin = vi.fn().mockResolvedValue({ success: false, [state]: true, message: '安装结果待确认' })
    await wrapper.vm.handleDownload('remote-only')
    expect(toastSpies.toastSuccess).not.toHaveBeenCalledWith('插件安装完成')
    expect(toastSpies.toastWarning).toHaveBeenCalledWith('安装结果待确认')
  })

  it('本窗口安装期间忽略页面旁路收到的旧任务通知', async () => {
    await mountPage({ installedPlugins: basePlugins })
    await flushPromises()
    pluginsStore.installingSet.add('plugin-1')
    for (const success of [true, false]) {
      await wrapper.vm.handlePluginInstalled({ payload: { pluginId: 'plugin-1', operationId: 'old-operation', success, isUpdate: true, error: '旧任务失败' } })
    }
    expect(toastSpies.toastSuccess).not.toHaveBeenCalled()
    expect(toastSpies.toastError).not.toHaveBeenCalled()
    pluginsStore.installingSet.delete('plugin-1')
    await wrapper.vm.handlePluginInstalled({ payload: { pluginId: 'plugin-1', operationId: 'external-update', success: true, isUpdate: true } })
    expect(toastSpies.toastSuccess).toHaveBeenCalled()
  })

  describe('方案A横向启动卡、悬浮快捷菜单与收藏未安装区分', () => {
    const switchToFavorites = async () => {
      const seg = wrapper.findComponent({ name: 'RcSegmented' })
      seg.vm.$emit('update:modelValue', 'favorites')
      seg.vm.$emit('change', 'favorites')
      await flushPromises()
    }

    it('横向双行启动卡展示简介及缺失字段时的多级回退，骨架屏同步为双行结构', async () => {
      const customInstalled = [
        { pluginId: 'with-desc', name: '解压与压缩', description: '免解压预览压缩包', category: '办公效率' },
        { pluginId: 'cat-only', name: '批量重命名', description: '   ', category: '文件工具' },
        { pluginId: 'bare-item', name: '极简工具' }
      ]
      await mountPage({
        installedPlugins: customInstalled,
        favoritePluginsList: [customInstalled[0]],
        favorites: ['with-desc'],
        config: { 'my-page.pinned': '["with-desc"]' }
      })

      const tiles = wrapper.findAll('.plugin-tile')
      expect(tiles[0].find('.tile-desc').text()).toBe('免解压预览压缩包')
      expect(tiles[0].find('.tile-pin').exists()).toBe(true)
      expect(tiles[1].find('.tile-desc').text()).toBe('文件工具')
      expect(tiles[2].find('.tile-desc').text()).toBe('点击立即打开')

      const skeleton = wrapper.find('.plugin-tile-skeleton')
      expect(skeleton.find('.skeleton-name').exists()).toBe(true)
      expect(skeleton.find('.skeleton-desc').exists()).toBe(true)
    })

    it('点击卡片右侧快捷菜单入口呼出菜单且不误触发打开插件，再次点击收起，跨卡片点击无缝切换且防视口溢出', async () => {
      await mountPage({ installedPlugins: basePlugins })
      const tiles = wrapper.findAll('.plugin-tile')
      const moreBtn0 = tiles[0].find('.tile-more-btn')
      const moreBtn1 = tiles[1].find('.tile-more-btn')
      expect(moreBtn0.exists()).toBe(true)

      // 模拟靠窗口右下角边缘的按钮矩形，验证菜单坐标防溢出钳制
      vi.spyOn(moreBtn0.element, 'getBoundingClientRect').mockReturnValue({
        left: 990,
        right: 1014,
        top: 740,
        bottom: 764,
        width: 24,
        height: 24
      })

      await moreBtn0.trigger('click')
      await flushPromises()
      expect(pluginsStore.openPlugin).not.toHaveBeenCalled()
      expect(wrapper.vm.showMenu).toBe(true)
      expect(wrapper.vm.selectedPlugin).toEqual(basePlugins[0])
      expect(wrapper.vm.menuPosition.x).toBeLessThanOrEqual((window.innerWidth || 1024) - 180)
      expect(wrapper.vm.menuPosition.y).toBeLessThanOrEqual((window.innerHeight || 768) - 210)

      // 跨卡片点击另一张卡的快捷入口：直接切换到第二张卡的菜单
      await moreBtn1.trigger('click')
      await flushPromises()
      expect(wrapper.vm.showMenu).toBe(true)
      expect(wrapper.vm.selectedPlugin).toEqual(basePlugins[1])

      // 再次点击同一张卡的快捷入口：互斥收起菜单
      await moreBtn1.trigger('click')
      await flushPromises()
      expect(wrapper.vm.showMenu).toBe(false)
      expect(wrapper.vm.selectedPlugin).toBe(null)
    })

    it('收藏页区分已安装与未安装卡片：视觉类名、快捷菜单安装动作、下载中互斥与键盘回车/删除边界', async () => {
      const favList = [
        { pluginId: 'plugin-1', name: '已装收藏项', description: '本地可用' },
        { pluginId: 'remote-fav', name: '未装收藏项', description: '待下载安装' }
      ]
      pluginsStore.installPlugin = vi.fn().mockResolvedValue({ success: true })

      await mountPage({
        installedPlugins: [favList[0]],
        favoritePluginsList: favList,
        favorites: ['plugin-1', 'remote-fav']
      })
      await switchToFavorites()

      const favTiles = wrapper.findAll('.plugin-tile')
      expect(favTiles).toHaveLength(2)
      expect(favTiles[0].classes()).not.toContain('is-uninstalled')
      expect(favTiles[0].find('.tile-uninstalled-badge').exists()).toBe(false)
      expect(favTiles[1].classes()).toContain('is-uninstalled')
      expect(favTiles[1].find('.tile-uninstalled-badge').exists()).toBe(true)
      expect(favTiles[1].find('.tile-desc').text()).toBe('未安装 · 点击查看详情')

      // 打开未安装收藏卡片的快捷菜单：展示「安装」「查看详情」「取消收藏」，不展示「打开」「固定到最前」「卸载」
      await favTiles[1].find('.tile-more-btn').trigger('click')
      await flushPromises()
      const menuText = wrapper.find('.context-menu').text()
      expect(menuText).toContain('安装')
      expect(menuText).toContain('查看详情')
      expect(menuText).toContain('取消收藏')
      expect(menuText).not.toContain('打开')
      expect(menuText).not.toContain('固定到最前')
      expect(menuText).not.toContain('卸载')

      // 点击菜单中的「安装」触发安装流程并自动收起菜单
      const installItem = wrapper.findAll('.context-menu .menu-item').find((item) => item.text() === '安装')
      await installItem.trigger('click')
      await flushPromises()
      expect(pluginsStore.installPlugin).toHaveBeenCalledWith('remote-fav', { autoOpen: true })
      expect(wrapper.vm.showMenu).toBe(false)

      // 并发下载中状态：菜单显示禁用态「安装中...」
      pluginsStore.$patch({ downloadingSet: new Set(['remote-fav']) })
      await favTiles[1].find('.tile-more-btn').trigger('click')
      await flushPromises()
      expect(wrapper.find('.context-menu .menu-item.disabled').text()).toBe('安装中...')
      wrapper.vm.hideMenu()

      // [破坏性边界] 聚焦到未安装收藏卡片按 Delete 不弹卸载确认框也不报错；按 Enter 跳转详情页而非启动报错
      Modal.confirm.mockClear()
      toastSpies.toastError.mockClear()
      wrapper.vm.focusedCardIndex = 1
      await flushPromises()

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      await flushPromises()
      expect(Modal.confirm).not.toHaveBeenCalled()
      expect(pluginsStore.uninstallPlugin).not.toHaveBeenCalled()
      expect(toastSpies.toastError).not.toHaveBeenCalled()

      const pushSpy = vi.spyOn(router, 'push').mockResolvedValue(undefined)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushPromises()
      expect(pluginsStore.openPlugin).not.toHaveBeenCalled()
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'details', params: { pluginId: 'remote-fav' } })
      )
    })
  })

})

