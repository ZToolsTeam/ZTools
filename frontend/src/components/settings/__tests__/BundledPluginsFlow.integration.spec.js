import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import BundledPluginsSettings from '../BundledPluginsSettings.vue'
import PluginCard3D from '@/components/PluginCard3D.vue'
import PluginActions from '@/pages/details-components/PluginActions.vue'
import {
  usePluginsStore,
  HIDDEN_BUNDLED_CONFIG_KEY,
  sanitizeHiddenBundledIds
} from '@/stores/plugins'
import { evaluateInlineCommandItem } from '@/composables/useCommandSearch'
import { setI18nLocale } from '@/i18n'

beforeEach(() => {
  setI18nLocale('zh-CN')
})

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn()
}))

const apiMocks = vi.hoisted(() => ({
  getLocalPlugins: vi.fn().mockResolvedValue([]),
  getMarketPlugins: vi.fn().mockResolvedValue({ list: [] }),
  openPlugin: vi.fn(),
  getDownloadSign: vi.fn(),
  installPluginNative: vi.fn(),
  batchCheckPlugins: vi.fn().mockResolvedValue({})
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies
}))

vi.mock('@edition', () => import('@/edition-oss/index.js'))

vi.mock('@/api/apiserver', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getLocalPlugins: apiMocks.getLocalPlugins,
    getMarketPlugins: apiMocks.getMarketPlugins,
    openPlugin: apiMocks.openPlugin,
    getDownloadSign: apiMocks.getDownloadSign,
    installPluginNative: apiMocks.installPluginNative,
    batchCheckPlugins: apiMocks.batchCheckPlugins
  }
})

describe('内置插件显示开关与双向恢复全链路集成及异常覆盖测试', () => {
  let configStore
  let closeWindowMock
  let store

  beforeEach(() => {
    setActivePinia(createPinia())
    store = usePluginsStore()
    configStore = {}
    closeWindowMock = vi.fn().mockResolvedValue({ success: true, closed: 1 })

    globalThis.window.ztools = {
      config: {
        get: vi.fn(async (key, fallback) =>
          Object.prototype.hasOwnProperty.call(configStore, key) ? configStore[key] : fallback
        ),
        set: vi.fn(async (key, value) => {
          configStore[key] = value
          return true
        })
      },
      plugin: {
        closeWindow: closeWindowMock
      },
      events: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn()
      }
    }

    for (const spy of Object.values(toastSpies)) spy.mockClear()
    for (const spy of Object.values(apiMocks)) spy.mockClear()
    apiMocks.getLocalPlugins.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('外部配置净化与边界防御 (sanitizeHiddenBundledIds)', () => {
    it('过滤 null / 损坏 JSON / 原型链属性 / 非内置市场插件 / 空白与重复项，仅保留合法内置插件小写 ID', () => {
      expect(sanitizeHiddenBundledIds(null)).toEqual([])
      expect(sanitizeHiddenBundledIds(undefined)).toEqual([])
      expect(sanitizeHiddenBundledIds('{broken-json')).toEqual([])
      expect(sanitizeHiddenBundledIds(0)).toEqual([])
      expect(sanitizeHiddenBundledIds({})).toEqual([])

      const dirtyInput = JSON.stringify([
        '  CALCULATOR ',
        'calculator',
        'memo',
        '__proto__',
        'constructor',
        'kill-process', // 市场官方插件，非随包内置
        'community-foo',
        '',
        123,
        null,
        { pluginId: 'todo' }
      ])
      expect(sanitizeHiddenBundledIds(dirtyInput)).toEqual(['calculator', 'memo'])
    })
  })

  describe('端到端真实状态流转闭环（设置页可见性 ↔ 已安装过滤 ↔ 计算器算式保留 ↔ 市场卡片与详情页还原）', () => {
    it('设置页隐藏后从已安装列表移除并持久化，计算器隐藏后主搜索框基础算式能力照常保留，还原后恢复可见', async () => {
      await store.fetchInstalledPlugins()
      expect(store.installedSet.has('calculator')).toBe(true)
      expect(store.installedPlugins.some((p) => p.pluginId === 'calculator')).toBe(true)

      const wrapper = mount(BundledPluginsSettings)
      await flushPromises()

      const calcRow = wrapper.get('[data-plugin-id="calculator"]')
      const visibilitySwitch = calcRow.get('button[role="switch"]')
      const stopped = vi.spyOn(store, 'onPluginRuntimeStopped')
      expect(visibilitySwitch.attributes('aria-label')).toBe('在主页和搜索中显示「计算器」')
      expect(visibilitySwitch.attributes('aria-checked')).toBe('true')
      await visibilitySwitch.trigger('click')
      await flushPromises()

      expect(store.isBundledHidden('calculator')).toBe(true)
      expect(store.installedSet.has('calculator')).toBe(false)
      expect(store.installedPlugins.some((p) => p.pluginId === 'calculator')).toBe(false)
      expect(JSON.parse(configStore[HIDDEN_BUNDLED_CONFIG_KEY])).toEqual(['calculator'])
      expect(closeWindowMock).not.toHaveBeenCalled()
      expect(stopped).not.toHaveBeenCalled()
      expect(toastSpies.toastSuccess).toHaveBeenCalledWith('已隐藏「计算器」')
      expect(calcRow.classes()).toContain('is-hidden-plugin')
      expect(visibilitySwitch.attributes('aria-checked')).toBe('false')

      const inlineMath = evaluateInlineCommandItem('128 + 256')
      expect(inlineMath).not.toBeNull()
      expect(inlineMath.answer).toBe('384')

      // 4. 验证打开已假卸载的内置插件（含旧插件重定向 notes -> memo）会引导跳转详情页还原
      await store.hideBundledPlugin('memo')
      const redirectOpen = await store.openPlugin('notes')
      expect(redirectOpen).toEqual({
        success: false,
        action: 'navigate_to_detail',
        pluginId: 'memo',
        error: '该内置插件已隐藏，可在设置中恢复显示'
      })

      // 5. 验证插件市场卡片（PluginCard3D）与详情页动作区（PluginActions）对已卸载内置插件展示“还原”而非“安装”
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/', component: { template: '<div />' } }]
      })
      const cardWrapper = mount(PluginCard3D, {
        props: {
          plugin: { pluginId: 'calculator', name: '计算器', description: '即时计算' },
          isInstalled: store.installedSet.has('calculator')
        },
        global: { plugins: [router] }
      })
      expect(cardWrapper.find('.card-action').text()).toBe('还原')

      const actionsWrapper = mount(PluginActions, {
        props: {
          isInstalled: false,
          isBundled: true,
          canUninstall: true,
          canCreateShortcut: false
        },
        global: {
          stubs: { 'a-tooltip': true }
        }
      })
      expect(actionsWrapper.text()).toContain('还原')
      expect(actionsWrapper.text()).not.toContain('安装')

      // 6. 在设置页点击“还原”按钮，恢复可见性且重新刷新本地列表后依然保持可见
      await visibilitySwitch.trigger('click')
      await flushPromises()
      expect(store.isBundledHidden('calculator')).toBe(false)
      expect(store.installedSet.has('calculator')).toBe(true)
      expect(store.installedPlugins.some((p) => p.pluginId === 'calculator')).toBe(true)
      expect(JSON.parse(configStore[HIDDEN_BUNDLED_CONFIG_KEY])).toEqual(['memo'])
      expect(visibilitySwitch.attributes('aria-checked')).toBe('true')
      expect(toastSpies.toastSuccess).toHaveBeenCalledWith('已显示「计算器」')

      cardWrapper.unmount()
      actionsWrapper.unmount()
      wrapper.unmount()
    })

    it('带路由定位时 focusPlugin 高亮目标行并在卸载组件时对称清理定时器', async () => {
      vi.useFakeTimers()
      const wrapper = mount(BundledPluginsSettings)
      await flushPromises()

      const focused = await wrapper.vm.focusPlugin('json-format')
      expect(focused).toBe(true)
      const targetRow = wrapper.find('[data-plugin-id="json-format"]')
      expect(targetRow.classes()).toContain('is-highlighted')

      // 非内置插件定位返回 false
      expect(await wrapper.vm.focusPlugin('kill-process')).toBe(false)

      // 2.2 秒后高亮自动消退
      vi.advanceTimersByTime(2300)
      await flushPromises()
      expect(targetRow.classes()).not.toContain('is-highlighted')

      // 再次触发后立即卸载组件，验证定时器被对称清除不抛错
      await wrapper.vm.focusPlugin('todo')
      wrapper.unmount()
      vi.advanceTimersByTime(3000)
    })
  })

  describe('破坏性故障注入与并发互斥断言', () => {
    it('[故障] 非内置插件调用 hideBundledPlugin / restoreBundledPlugin 立即拒绝抛错', async () => {
      await expect(store.hideBundledPlugin('')).rejects.toThrow('仅随客户端内置的插件支持此操作')
      await expect(store.hideBundledPlugin('kill-process')).rejects.toThrow('仅随客户端内置的插件支持此操作')
      await expect(store.restoreBundledPlugin('unknown-plugin')).rejects.toThrow('仅随客户端内置的插件支持还原')
    })

    it('[故障] config.set 返回 false 或抛出异常时，内存状态严格回滚且锁立即释放', async () => {
      await store.fetchInstalledPlugins()
      window.ztools.config.set.mockResolvedValueOnce(false)

      await expect(store.hideBundledPlugin('qr-code')).rejects.toThrow('无法保存内置插件显示设置')
      expect(store.isBundledHidden('qr-code')).toBe(false)
      expect(store.installedSet.has('qr-code')).toBe(true)
      expect(store.isTogglingBundled('qr-code')).toBe(false)

      // 下一次正常调用依然可以成功执行（验证互斥锁已对称释放）
      await expect(store.hideBundledPlugin('qr-code')).resolves.toEqual({
        success: true,
        pluginId: 'qr-code',
        hidden: true
      })

      // 还原时底层配置写入抛错：同样保持已卸载状态不脏写
      window.ztools.config.set.mockRejectedValueOnce(new Error('磁盘只读'))
      await expect(store.restoreBundledPlugin('qr-code')).rejects.toThrow('磁盘只读')
      expect(store.isBundledHidden('qr-code')).toBe(true)
      expect(store.installedSet.has('qr-code')).toBe(false)
      expect(store.isTogglingBundled('qr-code')).toBe(false)
    })

    it.each([true, false])('多个插件同时切换时按序写同一份名单，前次成功 %s', async (firstSucceeds) => {
      await store.hideBundledPlugin('memo')
      let finish
      window.ztools.config.set.mockImplementationOnce((_key, value) => new Promise((resolve) => {
        finish = () => {
          if (firstSucceeds) configStore[HIDDEN_BUNDLED_CONFIG_KEY] = value
          resolve(firstSucceeds)
        }
      }))

      const hiding = store.hideBundledPlugin('calculator')
      const showing = store.restoreBundledPlugin('memo')
      const outcomes = Promise.allSettled([hiding, showing])
      await flushPromises()
      expect(window.ztools.config.set).toHaveBeenCalledTimes(2)
      finish()
      const [hidden, shown] = await outcomes
      expect(hidden.status).toBe(firstSucceeds ? 'fulfilled' : 'rejected')
      expect(shown.status).toBe('fulfilled')
      const expected = firstSucceeds ? ['calculator'] : []
      expect([...store.hiddenBundledSet]).toEqual(expected)
      expect(JSON.parse(configStore[HIDDEN_BUNDLED_CONFIG_KEY])).toEqual(expected)
      expect(store.isTogglingBundled('memo')).toBe(false)
      expect(store.isTogglingBundled('calculator')).toBe(false)
    })

    it.each([undefined, null, 1, { success: true }])('保存返回非布尔成功值 %j 时不更改开关且解除锁', async (reply) => {
      window.ztools.config.set.mockResolvedValueOnce(reply)
      await expect(store.hideBundledPlugin('calculator')).rejects.toThrow('无法保存内置插件显示设置')
      expect(store.isBundledHidden('calculator')).toBe(false)
      expect(store.isTogglingBundled('calculator')).toBe(false)
    })

    it('读取失败时展示重试，重新加载磁盘选择后才显示开关', async () => {
      configStore[HIDDEN_BUNDLED_CONFIG_KEY] = '["calculator"]'
      window.ztools.config.get.mockRejectedValueOnce(new Error('读取失败'))
      const wrapper = mount(BundledPluginsSettings)
      await flushPromises()
      expect(wrapper.find('[role="switch"]').exists()).toBe(false)
      await wrapper.get('[role="alert"] button').trigger('click')
      await flushPromises()
      expect(wrapper.get('[data-plugin-id="calculator"] [role="switch"]').attributes('aria-checked')).toBe('false')
      expect(window.ztools.config.set).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('读取已有名单失败时保留磁盘选择，可以重试', async () => {
      configStore[HIDDEN_BUNDLED_CONFIG_KEY] = '["memo"]'
      window.ztools.config.get.mockRejectedValueOnce(new Error('读取失败'))
      await expect(store.hideBundledPlugin('calculator')).rejects.toThrow('读取失败')
      expect(window.ztools.config.set).not.toHaveBeenCalled()
      expect(store.isTogglingBundled('calculator')).toBe(false)
      await store.hideBundledPlugin('calculator')
      expect(JSON.parse(configStore[HIDDEN_BUNDLED_CONFIG_KEY])).toEqual(['memo', 'calculator'])
    })

    it('[并发] 同一内置插件连续高频触发时互斥拦截，返回 busy: true 不并发覆盖写配置', async () => {
      let resolveWrite
      window.ztools.config.set.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveWrite = () => resolve(true)
          })
      )

      const firstPromise = store.hideBundledPlugin('timestamp')
      const secondResult = await store.hideBundledPlugin('timestamp')
      await flushPromises()

      expect(secondResult).toEqual({
        success: false,
        busy: true,
        message: '操作处理中'
      })
      expect(window.ztools.config.set).toHaveBeenCalledTimes(1)

      resolveWrite()
      const firstResult = await firstPromise
      expect(firstResult).toEqual({
        success: true,
        pluginId: 'timestamp',
        hidden: true
      })
      expect(store.isTogglingBundled('timestamp')).toBe(false)
    })

    it('[持久化与宿主残留] 冷启动从配置恢复隐藏名单，即使宿主本地目录存在同名残留也不重新冒出', async () => {
      configStore[HIDDEN_BUNDLED_CONFIG_KEY] = JSON.stringify(['file-compare'])
      apiMocks.getLocalPlugins.mockResolvedValueOnce([
        { pluginId: 'file-compare', name: '文本对比旧副本' },
        { pluginId: 'custom-dev', name: '自定义插件', entry: 'index.html', version: '1.0.0' }
      ])

      await store.fetchInstalledPlugins()
      expect(store.isBundledHidden('file-compare')).toBe(true)
      expect(store.installedSet.has('file-compare')).toBe(false)
      expect(store.installedPlugins.some((p) => p.pluginId === 'file-compare')).toBe(false)
      expect(store.installedSet.has('custom-dev')).toBe(true)
    })
  })
})
