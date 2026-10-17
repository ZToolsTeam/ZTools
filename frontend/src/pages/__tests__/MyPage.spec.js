import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { Modal } from 'ant-design-vue'
import MyPage from '../MyPage.vue'
import { usePluginsStore } from '@/stores/plugins'
import { useUserStore } from '@/stores/user'

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
})

