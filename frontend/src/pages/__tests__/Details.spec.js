import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import Details from '../Details.vue'
import { usePluginsStore } from '@/stores/plugins'
import { useUIStore } from '@/stores/ui'

const toastSpies = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

const apiMocks = vi.hoisted(() => ({
  openPlugin: vi.fn(),
  getDownloadSign: vi.fn(),
  installPluginNative: vi.fn(),
  uninstallPluginNative: vi.fn(),
  getPluginDetails: vi.fn(),
  isAuthenticated: vi.fn(),
  getPluginComments: vi.fn(),
  postPluginComment: vi.fn(),
  createShortcut: vi.fn(),
  checkPluginUpdate: vi.fn(),
  downloadPluginUpdate: vi.fn(),
  getMarketPlugins: vi.fn(),
  getLocalPlugins: vi.fn(),
  getSyncData: vi.fn(),
  pushSyncData: vi.fn()
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

vi.mock('@/composables/useVersionCompat', () => ({
  useVersionCompat: () => ({
    checkPluginCompat: vi.fn().mockResolvedValue({ compatible: true, reason: '' })
  }),
  fetchVersions: vi.fn().mockResolvedValue({
    appVersion: '1.0.0',
    webVersion: '1.0.0'
  }),
  checkCompat: vi.fn().mockReturnValue({ compatible: true, reason: '' })
}))

vi.mock('@/utils/pluginFeatureHotkeys', () => ({
  getPluginFeatureHotkeyItemByTrigger: vi.fn().mockReturnValue(null)
}))

vi.mock('@/api/apiserver', () => ({
  openPlugin: apiMocks.openPlugin,
  getDownloadSign: apiMocks.getDownloadSign,
  installPluginNative: apiMocks.installPluginNative,
  uninstallPluginNative: apiMocks.uninstallPluginNative,
  getPluginDetails: apiMocks.getPluginDetails,
  isAuthenticated: apiMocks.isAuthenticated,
  getPluginComments: apiMocks.getPluginComments,
  postPluginComment: apiMocks.postPluginComment,
  createShortcut: apiMocks.createShortcut,
  checkPluginUpdate: apiMocks.checkPluginUpdate,
  downloadPluginUpdate: apiMocks.downloadPluginUpdate,
  getMarketPlugins: apiMocks.getMarketPlugins,
  getLocalPlugins: apiMocks.getLocalPlugins,
  getSyncData: apiMocks.getSyncData,
  pushSyncData: apiMocks.pushSyncData
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/details/:pluginId',
        name: 'details',
        component: Details
      },
      {
        path: '/list/:category?',
        name: 'list',
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

describe('Details Page', () => {
  let router
  let wrapper
  let pluginsStore
  let uiStore

  beforeEach(async () => {
    setActivePinia(createPinia())
    pluginsStore = usePluginsStore()
    uiStore = useUIStore()
    router = createTestRouter()

    for (const mock of Object.values(apiMocks)) {
      mock.mockReset()
    }

    apiMocks.getPluginDetails.mockResolvedValue({
      pluginId: 'plugin-1',
      name: 'Plugin 1',
      version: '1.0.0',
      category: '媒体处理',
      size: '1 MB',
      downloads: 12,
      rating: 5,
      author: 'ZTools Team',
      screenshots: [],
      changelogs: []
    })
    apiMocks.getPluginComments.mockResolvedValue({ data: [] })
    apiMocks.isAuthenticated.mockResolvedValue(false)
    apiMocks.getLocalPlugins.mockResolvedValue([])
    apiMocks.getSyncData.mockResolvedValue({ updated_at: null, favorites: [] })
    apiMocks.getMarketPlugins.mockResolvedValue({
      list: [],
      total: 0,
      page: 1,
      pageSize: 12
    })

    pluginsStore.installedSet = new Set(['plugin-1'])
    pluginsStore.installedPlugins = [{ pluginId: 'plugin-1', version: '1.0.0' }]
    pluginsStore.updateMap = {
      'plugin-1': { hasUpdate: true, version: '1.1.0' }
    }

    global.window.ztools = {
      analytics: {
        report: vi.fn()
      },
      trigger: {
        list: vi.fn().mockResolvedValue([])
      },
      events: {
        subscribe: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn().mockResolvedValue(undefined)
      }
    }

    await router.push('/details/plugin-1')
    await router.isReady()
  })

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount()
      wrapper = null
    }
    vi.clearAllMocks()
  })

  it('插件卸载后会清除详情页的有更新状态', async () => {
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: {
            props: ['isInstalled', 'hasUpdate'],
            template:
              '<div data-test=\"detail-header-state\">{{ isInstalled ? \"installed\" : \"not-installed\" }}|{{ hasUpdate ? \"update\" : \"no-update\" }}</div>'
          },
          PluginScreenshots: true,
          PluginDescription: true,
          PluginComments: true,
          PluginRating: true,
          PluginVersions: true
        }
      }
    })

    await flushPromises()

    expect(wrapper.get('[data-test=\"detail-header-state\"]').text()).toBe(
      'installed|update'
    )

    pluginsStore.onUninstallComplete({ pluginId: 'plugin-1' })
    await flushPromises()

    expect(wrapper.get('[data-test=\"detail-header-state\"]').text()).toBe(
      'not-installed|no-update'
    )
  })

  it('安装完成后本地版本尚未刷新时不误显示更新', async () => {
    pluginsStore.installedPlugins = []
    pluginsStore.updateMap = {}
    apiMocks.checkPluginUpdate.mockResolvedValue({
      hasUpdate: true,
      version: '1.0.0'
    })

    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: {
            props: ['isInstalled', 'hasUpdate'],
            template:
              '<div data-test=\"detail-header-state\">{{ isInstalled ? \"installed\" : \"not-installed\" }}|{{ hasUpdate ? \"update\" : \"no-update\" }}</div>'
          },
          PluginScreenshots: true,
          PluginDescription: true,
          PluginComments: true,
          PluginRating: true,
          PluginVersions: true
        }
      }
    })

    await flushPromises()

    expect(apiMocks.checkPluginUpdate).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test=\"detail-header-state\"]').text()).toBe(
      'installed|no-update'
    )
  })

  it('点击头部留言按钮后切换到留言 Tab 并滚动到留言区域', async () => {
    let resolveComments
    apiMocks.getPluginComments.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveComments = resolve
      })
    )
    apiMocks.getPluginDetails.mockResolvedValueOnce({
      pluginId: 'plugin-1',
      name: 'Plugin 1',
      version: '1.0.0',
      commentsCount: 3,
      screenshots: [],
      changelogs: []
    })

    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: {
            props: ['commentsCount'],
            emits: ['show-comments'],
            template:
              '<button data-test="comments-action" @click="$emit(\'show-comments\')">{{ commentsCount }}</button>'
          },
          PluginScreenshots: true,
          PluginDescription: true,
          PluginComments: {
            template: '<div data-test="comments-panel"></div>'
          },
          PluginRating: true,
          PluginVersions: true
        }
      }
    })

    await flushPromises()

    const scrollContainer = document.createElement('main')
    const scrollTo = vi.fn()
    scrollContainer.scrollTop = 120
    scrollContainer.scrollTo = scrollTo
    scrollContainer.getBoundingClientRect = vi.fn(() => ({ top: 48 }))
    wrapper.get('.tab-container').element.getBoundingClientRect = vi.fn(() => ({
      top: 288
    }))
    scrollContainer.appendChild(wrapper.element)

    expect(wrapper.get('[data-test="comments-action"]').text()).toBe('3')

    await wrapper.get('[data-test="comments-action"]').trigger('click')

    expect(apiMocks.getPluginComments).toHaveBeenCalledWith('plugin-1')
    expect(wrapper.find('[data-test="comments-panel"]').exists()).toBe(true)
    expect(scrollTo).toHaveBeenCalledTimes(1)

    resolveComments({ data: [] })
    await flushPromises()

    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 360,
      behavior: 'smooth'
    })
  })

  it('创建桌面快捷方式期间忽略重复请求', async () => {
    let resolveShortcut
    apiMocks.createShortcut.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveShortcut = resolve
      })
    )

    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: {
            props: ['creatingShortcut'],
            template:
              '<div data-test="shortcut-state">{{ creatingShortcut ? "creating" : "idle" }}</div>'
          },
          PluginScreenshots: true,
          PluginDescription: true,
          PluginComments: true,
          PluginRating: true,
          PluginVersions: true
        }
      }
    })
    await flushPromises()

    const firstCall = wrapper.vm.createShortcut()
    const duplicateCall = wrapper.vm.createShortcut()
    await duplicateCall

    expect(apiMocks.createShortcut).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-test="shortcut-state"]').text()).toBe('creating')

    resolveShortcut({ success: true })
    await firstCall
    await flushPromises()

    expect(wrapper.get('[data-test="shortcut-state"]').text()).toBe('idle')
    expect(toastSpies.toastSuccess).toHaveBeenCalledWith('桌面快捷方式已生成')
  })

  it('未登录时详情页阻止下载并打开登录框', async () => {
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: true,
          PluginScreenshots: true,
          PluginDescription: true,
          PluginComments: true,
          PluginRating: true,
          PluginVersions: true
        }
      }
    })
    await flushPromises()

    await wrapper.vm.downloadPlugin()

    expect(uiStore.showLoginModal).toBe(true)
    expect(toastSpies.toastError).toHaveBeenCalledWith('请先登录后下载插件')
    expect(apiMocks.getDownloadSign).not.toHaveBeenCalled()
    expect(window.ztools.analytics.report).not.toHaveBeenCalledWith(
      'plugin_clickinstall',
      'plugin-1'
    )
  })
})
