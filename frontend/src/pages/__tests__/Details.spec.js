import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import { Modal } from 'ant-design-vue'

import Details from '../Details.vue'
import { HIDDEN_BUNDLED_CONFIG_KEY, usePluginsStore } from '@/stores/plugins'
import { getCurrentLocale, setI18nLocale, t } from '@/i18n'

const toastSpies = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn()
}))

const apiMocks = vi.hoisted(() => ({
  openPlugin: vi.fn(),
  getDownloadSign: vi.fn(),
  installPluginNative: vi.fn(),
  uninstallPluginNative: vi.fn(),
  getPluginDetails: vi.fn(),
  createShortcut: vi.fn(),
  checkPluginUpdate: vi.fn(),
  downloadPluginUpdate: vi.fn(),
  getMarketPlugins: vi.fn(),
  getLocalPlugins: vi.fn()
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

// 公共详情页按开源版行为测试（两种仓库里结果一致）；官方版的留言、登录拦截由版本扩展自行测试
vi.mock('@edition', () => import('@/edition-oss/index.js'))

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
  createShortcut: apiMocks.createShortcut,
  checkPluginUpdate: apiMocks.checkPluginUpdate,
  downloadPluginUpdate: apiMocks.downloadPluginUpdate,
  getMarketPlugins: apiMocks.getMarketPlugins,
  getLocalPlugins: apiMocks.getLocalPlugins,
  isPluginVersionIncompatibleError: () => false,
  getPluginVersionIncompatibleMessage: (e) => e?.message || ''
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

  beforeEach(async () => {
    setActivePinia(createPinia())
    pluginsStore = usePluginsStore()
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
    apiMocks.getLocalPlugins.mockResolvedValue([])
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
        }
      }
    })

    await flushPromises()

    expect(apiMocks.checkPluginUpdate).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test=\"detail-header-state\"]').text()).toBe(
      'installed|no-update'
    )
  })

  it('开源版详情页只有头部与「插件详情」卡片：没有 Tab、留言卡与版本记录，误发「查看留言」不报错', async () => {
    apiMocks.getPluginDetails.mockResolvedValueOnce({
      pluginId: 'plugin-1',
      name: 'Plugin 1',
      version: '1.0.0',
      // 即使插件数据里带了留言数，开源版也不显示留言入口
      commentsCount: 3,
      screenshots: [],
      changelogs: [{ id: 1, version: '1.0.0', changes: 'x' }]
    })

    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: {
            props: ['commentsCount'],
            emits: ['show-comments'],
            template:
              '<button data-test="comments-action" @click="$emit(\'show-comments\')">{{ commentsCount === null ? "none" : commentsCount }}</button>'
          },
          PluginScreenshots: true,
          PluginDescription: { template: '<div data-test="description-panel"></div>' }
        }
      }
    })
    await flushPromises()

    expect(wrapper.find('[aria-label="插件信息"]').exists()).toBe(false)
    expect(wrapper.findAll('.detail-card').map((card) => card.attributes('data-section'))).toEqual(['detail'])
    expect(wrapper.get('.detail-overview [data-test="comments-action"]').exists()).toBe(true)
    expect(wrapper.find('.usage-example').exists()).toBe(false)
    expect(wrapper.find('.detail-card [data-test="description-panel"]').exists()).toBe(true)
    // 插件数据里带了版本记录，开源版也不显示
    expect(wrapper.text()).not.toContain('版本记录')
    expect(wrapper.get('[data-test="comments-action"]').text()).toBe('none')

    // 头部误发「查看留言」：没有留言卡，不滚动也不报错
    await wrapper.get('[data-test="comments-action"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="description-panel"]').exists()).toBe(true)
  })

  it('开源版不显示评分：插件数据里的旧 rating 字段不用，头部收到的评分汇总为 null，也不请求评分接口', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('测试环境断网'))
    vi.stubGlobal('fetch', fetchSpy)
    apiMocks.getPluginDetails.mockResolvedValueOnce({
      pluginId: 'plugin-1', name: 'Plugin 1', version: '1.0.0', rating: 4.9, screenshots: [], changelogs: []
    })
    try {
      wrapper = mount(Details, {
        global: {
          plugins: [router],
          stubs: { PluginActions: true, PluginScreenshots: true, PluginDescription: true, RcSquircle: true }
        }
      })
      await flushPromises()
      expect(wrapper.find('.plugin-name').text()).toBe('Plugin 1')
      expect(wrapper.find('.meta-rating').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('4.9')
      expect(wrapper.text()).not.toContain('评分')
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('rating'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('市场插件的截图来自目录条目，非 https 或只有相对路径的条目不显示', async () => {
    const good = { url: 'https://cdn.ztools.cn/plugins-v2/official/plugin-1/screenshots/1.0.0/01-abcdef12.png', title: '主界面', width: 1280, height: 800 }
    apiMocks.getPluginDetails.mockResolvedValueOnce({
      pluginId: 'plugin-1', name: 'Plugin 1', version: '1.0.0', changelogs: [],
      // 目录不可用时详情来自已安装插件的 plugin.json，screenshots 只有相对路径
      screenshots: [good, { path: 'screenshots/02.png', title: '本地' }, { url: 'javascript:alert(1)' }]
    })
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: true,
          PluginDescription: true,
          PluginScreenshots: { props: ['screenshots'], template: '<div data-test="shots">{{ JSON.stringify(screenshots) }}</div>' }
        }
      }
    })
    await flushPromises()
    expect(JSON.parse(wrapper.get('[data-test="shots"]').text())).toEqual([good])
  })

  it('用插件声明的文本口令展示真实示例，切换语言后更新触发词和说明', async () => {
    const originalLocale = getCurrentLocale()
    apiMocks.getPluginDetails.mockResolvedValueOnce({
      pluginId: 'plugin-1', name: 'Test', version: '1.0.0',
      features: [null, { code: 'unsupported' }, { code: 'region', cmds: ['截图识字'], explain: '识别并复制' }],
      i18n: { 'en-US': { features: { region: { cmds: ['screen OCR'], explain: 'Recognize and copy' } } } }
    })
    try {
      setI18nLocale('zh-CN')
      wrapper = mount(Details, { global: { plugins: [router], stubs: { PluginDetailHeader: true } } })
      await flushPromises()
      expect(wrapper.get('.usage-command').text()).toBe('截图识字')
      expect(wrapper.get('.usage-example').text()).toContain('识别并复制')
      setI18nLocale('en-US')
      await flushPromises()
      expect(wrapper.get('.usage-command').text()).toBe('screen OCR')
      expect(wrapper.get('.usage-example').text()).toContain('Recognize and copy')
    } finally {
      setI18nLocale(originalLocale)
    }
  })

  it('切换语言后详情页响应式切换本地化截图与标题', async () => {
    const originalLocale = getCurrentLocale()
    const zhShot = { url: 'https://cdn.ztools.cn/plugins-v2/official/plugin-1/screenshots/1.0.0/01-zh.png', title: '中文主界面', width: 1280, height: 800 }
    const enShot = { url: 'https://cdn.ztools.cn/plugins-v2/official/plugin-1/screenshots/1.0.0/01-en.png', title: 'English Main View', width: 1280, height: 800 }
    apiMocks.getPluginDetails.mockResolvedValueOnce({
      pluginId: 'plugin-1',
      name: 'Plugin 1',
      version: '1.0.0',
      changelogs: [],
      screenshots: [zhShot],
      i18n: {
        'en-US': {
          name: 'Plugin 1 EN',
          screenshots: [enShot]
        }
      }
    })
    try {
      setI18nLocale('zh-CN')
      wrapper = mount(Details, {
        global: {
          plugins: [router],
          stubs: {
            PluginDetailHeader: true,
            PluginDescription: true,
            PluginScreenshots: { props: ['screenshots'], template: '<div data-test="shots">{{ JSON.stringify(screenshots) }}</div>' }
          }
        }
      })
      await flushPromises()
      expect(JSON.parse(wrapper.get('[data-test="shots"]').text())).toEqual([zhShot])

      setI18nLocale('en-US')
      await flushPromises()
      expect(JSON.parse(wrapper.get('[data-test="shots"]').text())).toEqual([enShot])

      setI18nLocale('zh-CN')
      await flushPromises()
      expect(JSON.parse(wrapper.get('[data-test="shots"]').text())).toEqual([zhShot])
    } finally {
      setI18nLocale(originalLocale)
    }
  })

  it('内置插件的截图只用随客户端分发的本地副本，不请求插件目录', async () => {
    await router.push('/details/memo')
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: true,
          PluginDescription: true,
          PluginScreenshots: { props: ['screenshots'], template: '<div data-test="shots">{{ JSON.stringify(screenshots) }}</div>' }
        }
      }
    })
    await flushPromises()
    expect(apiMocks.getPluginDetails).not.toHaveBeenCalled()
    const shots = JSON.parse(wrapper.get('[data-test="shots"]').text())
    // 目前内置插件都没有声明截图：不显示，也不回退到网络地址
    expect(Array.isArray(shots)).toBe(true)
    for (const item of shots) expect(item.url).toMatch(/bundled-plugins\/memo\/screenshots\//)
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

  it('开源版没有账号：安装不要求登录，直接安装', async () => {
    pluginsStore.installPlugin = vi.fn().mockResolvedValue({ success: true })
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: true,
          PluginScreenshots: true,
          PluginDescription: true
        }
      }
    })
    await flushPromises()

    await wrapper.vm.downloadPlugin()

    expect(toastSpies.toastError).not.toHaveBeenCalledWith('请先登录后下载插件')
    expect(pluginsStore.installPlugin).toHaveBeenCalledWith('plugin-1', { autoOpen: true })
    expect(toastSpies.toastSuccess).toHaveBeenCalledWith('插件安装完成')
    // 开源版不上报使用统计（详情页访问、点击安装都不上报）
    expect(window.ztools.analytics.report).not.toHaveBeenCalled()
  })

  it('[故障] 开源版收藏返回 401 时按普通失败提示，不走登录流程', async () => {
    pluginsStore.toggleFavorite = vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: { PluginDetailHeader: true, PluginScreenshots: true, PluginDescription: true }
      }
    })
    await flushPromises()

    await wrapper.vm.toggleFavorite()

    expect(toastSpies.toastError).toHaveBeenCalledWith('操作失败: Unauthorized')
    expect(toastSpies.toastWarning).not.toHaveBeenCalledWith('Unauthorized')
  })

  it('开源版安装失败时提示真实原因，不弹登录框', async () => {
    pluginsStore.installPlugin = vi.fn().mockRejectedValue(
      Object.assign(new Error('插件市场未收录该插件或缺少下载信息'), { code: 'PLUGIN_NOT_IN_CATALOG' })
    )
    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: { PluginDetailHeader: true, PluginScreenshots: true, PluginDescription: true }
      }
    })
    await flushPromises()

    await wrapper.vm.downloadPlugin()

    expect(toastSpies.toastError).toHaveBeenCalledWith('安装失败: 插件市场未收录该插件或缺少下载信息')
  })

  it('打开随包内置插件 (bundledPlugin 如 json-format) 详情页时首帧同步直出，不闪骨架屏且不请求远程详情接口', async () => {
    pluginsStore.installedSet = new Set()
    await router.push('/details/json-format')

    wrapper = mount(Details, {
      global: {
        plugins: [router],
        stubs: {
          PluginDetailHeader: {
            props: ['plugin', 'isInstalled'],
            template:
              '<div data-test="bundled-detail-header">{{ plugin?.name }}|{{ isInstalled ? "installed" : "not-installed" }}</div>'
          },
          PluginScreenshots: true,
          PluginDescription: true,
        }
      }
    })

    // 首帧（无需等待 flushPromises）即已渲染详情头部，不闪现 .skeleton-container
    expect(wrapper.find('.skeleton-container').exists()).toBe(false)
    expect(wrapper.get('[data-test="bundled-detail-header"]').text()).toBe(
      'JSON 格式化|installed'
    )
    expect(apiMocks.getPluginDetails).not.toHaveBeenCalled()
  })
  it.each(['pending', 'busy'])('安装%s时不误报完成', async state => {
    pluginsStore.installPlugin = vi.fn().mockResolvedValue({ success: false, [state]: true, message: '安装结果待确认' })
    wrapper = mount(Details, { global: { plugins: [router], stubs: { PluginDetailHeader: true, PluginScreenshots: true, PluginDescription: true } } })
    await flushPromises()
    await wrapper.vm.downloadPlugin()
    expect(toastSpies.toastSuccess).not.toHaveBeenCalledWith('插件安装完成')
    expect(toastSpies.toastWarning).toHaveBeenCalledWith('安装结果待确认')
  })

  it('本窗口安装期间忽略页面旁路收到的旧任务通知', async () => {
    wrapper = mount(Details, { global: { plugins: [router], stubs: { PluginDetailHeader: true, PluginScreenshots: true, PluginDescription: true } } })
    await flushPromises()
    pluginsStore.installingSet.add('plugin-1')
    for (const success of [true, false]) {
      await wrapper.vm.handleInstallComplete({ payload: { pluginId: 'plugin-1', operationId: 'old-operation', success, isUpdate: true, error: '旧任务失败' } })
    }
    expect(toastSpies.toastSuccess).not.toHaveBeenCalled()
    expect(toastSpies.toastError).not.toHaveBeenCalled()
    pluginsStore.installingSet.delete('plugin-1')
    await wrapper.vm.handleInstallComplete({ payload: { pluginId: 'plugin-1', operationId: 'external-update', success: true, isUpdate: true } })
    expect(toastSpies.toastSuccess).toHaveBeenCalled()
  })

  describe('卸载与桌面快捷方式入口', () => {
    const headerStub = {
      props: ['isInstalled', 'canUninstall', 'canCreateShortcut'],
      emits: ['uninstall'],
      template:
        '<div data-test="entry-state" @click="$emit(\'uninstall\')">{{ isInstalled }}|{{ canUninstall }}|{{ canCreateShortcut }}</div>'
    }

    async function mountDetailsFor(pluginId, platform) {
      globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = platform
      apiMocks.getPluginDetails.mockResolvedValue({ pluginId, name: pluginId, version: '1.0.0', screenshots: [], changelogs: [] })
      await router.push(`/details/${pluginId}`)
      wrapper = mount(Details, {
        global: {
          plugins: [router],
          stubs: { PluginDetailHeader: headerStub, PluginScreenshots: true, PluginDescription: true }
        }
      })
      await flushPromises()
      return wrapper.get('[data-test="entry-state"]')
    }

    afterEach(() => {
      delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
    })

    it('普通已安装插件：Windows 上可卸载、可生成快捷方式；macOS 上不给快捷方式入口', async () => {
      expect((await mountDetailsFor('plugin-1', 'win32')).text()).toBe('true|true|true')
      wrapper.unmount()
      expect((await mountDetailsFor('plugin-1', 'darwin')).text()).toBe('true|true|false')
    })

    it('随客户端内置的插件：可点击卸载引导至设置页假卸载、暂不开放桌面快捷方式；点击卸载时不弹原生删除框也不调宿主', async () => {
      const confirm = vi.spyOn(Modal, 'confirm')
      const entry = await mountDetailsFor('calculator', 'win32')
      expect(entry.text()).toBe('true|true|false')

      await entry.trigger('click')
      await flushPromises()
      expect(confirm).not.toHaveBeenCalled()
      expect(apiMocks.uninstallPluginNative).not.toHaveBeenCalled()
      expect(toastSpies.toastInfo).toHaveBeenCalledWith(t('details.manageBundledInSettings'))
      expect(router.currentRoute.value.name).toBe('advanced-settings')
      expect(router.currentRoute.value.query.manageBundled).toBe('calculator')
      confirm.mockRestore()
    })

    it('已隐藏的内置插件在详情页可以恢复显示，无需请求下载签名', async () => {
      const config = new Map([[HIDDEN_BUNDLED_CONFIG_KEY, ['calculator']]])
      window.ztools.config = {
        get: vi.fn(async (key, fallback) => config.get(key) ?? fallback),
        set: vi.fn(async (key, value) => {
          config.set(key, JSON.parse(value))
          return true
        })
      }
      await pluginsStore.fetchInstalledPlugins()
      const entry = await mountDetailsFor('calculator', 'win32')
      expect(entry.text()).toBe('false|true|false')

      await wrapper.vm.downloadPlugin()
      await flushPromises()
      expect(apiMocks.getDownloadSign).not.toHaveBeenCalled()
      expect(apiMocks.installPluginNative).not.toHaveBeenCalled()
      expect(pluginsStore.isBundledHidden('calculator')).toBe(false)
      expect(config.get(HIDDEN_BUNDLED_CONFIG_KEY)).toEqual([])
      expect(entry.text()).toBe('true|true|false')
      expect(toastSpies.toastSuccess).toHaveBeenCalledWith('已还原内置插件')
    })

    it('插件市场分发的官方插件：以实际安装状态为准，装了就能卸载', async () => {
      pluginsStore.installedSet = new Set()
      expect((await mountDetailsFor('kill-process', 'win32')).text()).toBe('false|true|true')
      wrapper.unmount()
      pluginsStore.installedSet = new Set(['kill-process'])
      expect((await mountDetailsFor('kill-process', 'win32')).text()).toBe('true|true|true')
    })

    it('点击设置快捷键时携带 openPluginHotkey=true 与当前 pluginId 跳转设置页', async () => {
      await router.push('/details/plugin-1')
      const pushSpy = vi.spyOn(router, 'push')
      wrapper = mount(Details, {
        global: {
          plugins: [router],
          stubs: { PluginDetailHeader: true, PluginScreenshots: true, PluginDescription: true }
        }
      })
      await flushPromises()

      wrapper.vm.setHotkey()
      await flushPromises()

      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'advanced-settings',
          query: {
            openPluginHotkey: 'true',
            pluginId: 'plugin-1'
          }
        })
      )
    })

    it('[KeepAlive 生命周期] 失活期间跳过下载进度、安装完成 Toast 与路由响应，重新激活且 pluginId 变化时才重载', async () => {
      const { defineComponent, ref, KeepAlive } = await import('vue')
      const active = ref(true)
      const Host = defineComponent({
        components: { KeepAlive, Details },
        setup: () => ({ active }),
        template: '<KeepAlive><Details v-if="active" /></KeepAlive>'
      })

      await router.push('/details/plugin-1')
      const hostWrapper = mount(Host, {
        global: {
          plugins: [router],
          stubs: { PluginDetailHeader: true, PluginScreenshots: true, PluginDescription: true }
        }
      })
      try {
        await flushPromises()
        const detailsComp = hostWrapper.findComponent(Details)
        expect(apiMocks.getPluginDetails).toHaveBeenCalledTimes(1)

        // 切走失活
        active.value = false
        await flushPromises()

        // 失活期间忽略进度与安装完成事件，不弹重复 Toast
        detailsComp.vm.handleDownloadProgress({ payload: { pluginId: 'plugin-1', percent: 75 } })
        await detailsComp.vm.handleInstallComplete({
          payload: { pluginId: 'plugin-1', operationId: 'bg-op', success: true, isUpdate: false }
        })
        expect(detailsComp.vm.downloadProgress).toBe(0)
        expect(toastSpies.toastSuccess).not.toHaveBeenCalled()

        // 失活期间路由变化不立即发请求
        apiMocks.getPluginDetails.mockResolvedValueOnce({
          pluginId: 'plugin-2',
          name: 'Plugin 2',
          version: '2.0.0',
          screenshots: [],
          changelogs: []
        })
        await router.push('/details/plugin-2')
        await flushPromises()
        expect(apiMocks.getPluginDetails).toHaveBeenCalledTimes(1)

        // 重新激活时检测到 pluginId 变化，触发一次加载
        active.value = true
        await flushPromises()
        expect(apiMocks.getPluginDetails).toHaveBeenCalledTimes(2)
        expect(apiMocks.getPluginDetails).toHaveBeenLastCalledWith('plugin-2')
      } finally {
        hostWrapper.unmount()
      }
    })
  })
})

