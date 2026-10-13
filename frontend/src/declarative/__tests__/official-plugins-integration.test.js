import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import {
  OFFICIAL_PLUGIN_IDS,
  OFFICIAL_PLUGINS_MAP,
  OFFICIAL_PLUGINS_LIST,
  isOfficialPlugin,
  getOfficialPlugin,
  getOfficialPluginsList
} from '@/utils/officialPlugins'
import { usePluginsStore } from '@/stores/plugins'
import DeclarativePage from '@/pages/DeclarativePage.vue'
import * as apiServer from '@/api/apiserver'

// 模拟 vue-router 与 @/router
const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn()
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useRoute: () => ({ params: { pluginId: 'json-format' } }),
    useRouter: () => ({ push: mockPush, back: vi.fn() })
  }
})

// 模拟 @/router
vi.mock('@/router', () => ({
  default: {
    push: mockPush,
    replace: vi.fn(),
    currentRoute: { value: { name: 'my', path: '/' } }
  }
}))

// 模拟 apiserver 中的 getLocalPlugins 与 getMarketPlugins
vi.mock('@/api/apiserver', async () => {
  const actual = await vi.importActual('@/api/apiserver')
  return {
    ...actual,
    getLocalPlugins: vi.fn(),
    openPlugin: vi.fn(),
    getMarketPlugins: vi.fn().mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20 })
  }
})

describe('官方标杆声明式应用注册表与端到端集成测试', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('1. 注册表完整性与规范断言 (Registry Completeness)', () => {
    it('必须完整包含 10 款核心标杆应用定义，且字段完备合规', () => {
      const requiredBenchmarkIds = [
        'json-format',
        'qr-code',
        'github',
        'google-translate',
        'color-picker',
        'obsidian',
        'speedtest',
        'winget',
        'currency-exchange',
        'kill-process'
      ]

      expect(OFFICIAL_PLUGINS_LIST.length).toBeGreaterThanOrEqual(10)

      for (const id of requiredBenchmarkIds) {
        expect(isOfficialPlugin(id)).toBe(true)
        const def = getOfficialPlugin(id)
        expect(def).toBeDefined()
        expect(def.pluginId).toBe(id)
        expect(def.name).toBeTruthy()
        expect(def.description).toBeTruthy()
        expect(def.category).toBeTruthy()
        expect(def.keyword).toBeTruthy()
        expect(def.faIcon).toMatch(/^fa-/)
        expect(def.iconGradient).toContain('linear-gradient')
        expect(def.isBuiltin).toBe(true)
        expect(def.isDeclarative).toBe(true)
        expect(typeof def.command).toBe('function')
      }
    })

    it('大小写不敏感与首尾空白容错', () => {
      expect(isOfficialPlugin('  JSON-FORMAT  ')).toBe(true)
      expect(isOfficialPlugin('Qr-Code')).toBe(true)
      expect(getOfficialPlugin('  KILL-PROCESS  ')).toBeDefined()
      expect(getOfficialPlugin('kill-process').name).toBe('进程管理急救箱')
    })
  })

  describe('2. Pinia Store 集成与已安装列表合并', () => {
    it('fetchInstalledPlugins 必须自动将 10 款官方应用合并入 installedPlugins 与 installedSet', async () => {
      // 模拟本地原生插件仅有 1 个历史旧插件
      vi.mocked(apiServer.getLocalPlugins).mockResolvedValue([
        { pluginId: 'legacy-demo', name: '旧插件', lastUsedTime: 100 }
      ])

      const store = usePluginsStore()
      const list = await store.fetchInstalledPlugins()

      // 验证数量：本地 1 个 + 官方 11 个 = 12 个
      expect(list.length).toBeGreaterThanOrEqual(11)
      expect(store.installedSet.has('legacy-demo')).toBe(true)
      expect(store.installedSet.has('json-format')).toBe(true)
      expect(store.installedSet.has('qr-code')).toBe(true)
      expect(store.installedSet.has('speedtest')).toBe(true)

      const jsonFormat = store.installedPlugins.find((p) => p.pluginId === 'json-format')
      expect(jsonFormat).toBeDefined()
      expect(jsonFormat.name).toBe('JSON 格式化与类型推导')
      expect(jsonFormat.badge).toBe('官方标杆')
    })

    it('当本地原生接口异常/网络不可用时，优雅降级保证官方标杆插件依然秒开可用', async () => {
      vi.mocked(apiServer.getLocalPlugins).mockRejectedValue(new Error('Native IPC Connection Timeout'))

      const store = usePluginsStore()
      const list = await store.fetchInstalledPlugins()

      // 即使原生接口崩溃，官方应用必须坚挺可用
      expect(list.length).toBeGreaterThanOrEqual(10)
      expect(store.installedSet.has('json-format')).toBe(true)
      expect(store.installedSet.has('kill-process')).toBe(true)
    })

    it('调用 openPlugin 打开官方应用时，应更新最近使用并直接路由到声明式页面', async () => {
      const store = usePluginsStore()
      const result = await store.openPlugin('json-format')

      expect(result.success).toBe(true)
      expect(result.isDeclarative).toBe(true)
      expect(result.pluginId).toBe('json-format')
      expect(store.recents).toContain('json-format')
      expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
        name: 'declarative',
        params: { pluginId: 'json-format' }
      }))
    })

    it('严禁卸载官方内置核心扩展', async () => {
      const store = usePluginsStore()
      await expect(store.uninstallPlugin('json-format')).rejects.toThrow('官方内置核心扩展不可卸载')
      
      // onUninstallComplete 事件静默保护
      store.installedSet.add('json-format')
      store.onUninstallComplete({ pluginId: 'json-format' })
      expect(store.installedSet.has('json-format')).toBe(true)
    })

    it('所有插件市场列表 loadWithCache 自动包含官方标杆应用并支持分类与搜索', async () => {
      const store = usePluginsStore()

      // 1. 分类筛选：'办公效率'
      const officeRes = await store.loadWithCache({ category: '办公效率' }, true)
      expect(officeRes.list.some((p) => p.pluginId === 'json-format')).toBe(true)
      expect(officeRes.list.some((p) => p.pluginId === 'github')).toBe(true)

      // 2. 分类筛选：'系统工具'
      const sysRes = await store.loadWithCache({ category: '系统工具' }, true)
      expect(sysRes.list.some((p) => p.pluginId === 'qr-code')).toBe(true)
      expect(sysRes.list.some((p) => p.pluginId === 'kill-process')).toBe(true)

      // 3. 关键词检索：'json'
      const searchRes = await store.loadWithCache({ keyword: 'json' }, true)
      expect(searchRes.list.some((p) => p.pluginId === 'json-format')).toBe(true)
      expect(searchRes.list.some((p) => p.pluginId === 'qr-code')).toBe(false)
    })
  })

  describe('3. DeclarativePage 宿主组件集成渲染与键盘流', () => {
    it('正常挂载官方标杆应用并呈现 DeclarativeView 容器', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'json-format' }
      })

      await nextTick()

      expect(wrapper.text()).toContain('JSON 格式化与类型推导')
      expect(wrapper.text()).toContain('官方标杆')
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(true)
    })

    it('点击返回工作台按钮触发路由后退', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'qr-code' }
      })

      await nextTick()

      const backBtn = wrapper.find('button[title*="返回我的插件"]')
      expect(backBtn.exists()).toBe(true)
      await backBtn.trigger('click')

      expect(mockPush).toHaveBeenCalledWith({ name: 'my' })
    })
  })

  describe('4. 破坏性异常与越界测试 (Beyond Happy Path)', () => {
    it('边界异常 1: 空值与非法类型入参安全防护', () => {
      expect(isOfficialPlugin(null)).toBe(false)
      expect(isOfficialPlugin(undefined)).toBe(false)
      expect(isOfficialPlugin('')).toBe(false)
      expect(isOfficialPlugin('   ')).toBe(false)
      expect(isOfficialPlugin(12345)).toBe(false)
      expect(isOfficialPlugin({})).toBe(false)

      expect(getOfficialPlugin(null)).toBeUndefined()
      expect(getOfficialPlugin(undefined)).toBeUndefined()
      expect(getOfficialPlugin('')).toBeUndefined()
      expect(getOfficialPlugin('unknown-non-exist')).toBeUndefined()
    })

    it('边界异常 2: openPlugin 空值入参拦截抛错', async () => {
      const store = usePluginsStore()
      await expect(store.openPlugin('')).rejects.toThrow('插件标识符不存在')
      await expect(store.openPlugin(null)).rejects.toThrow('插件标识符不存在')
    })

    it('边界异常 3: DeclarativePage 收到未知或篡改 pluginId 时平滑降级，不得白屏崩溃', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'malicious-injected-id-9999' }
      })

      await nextTick()

      // 验证平滑容错提示
      expect(wrapper.text()).toContain('未找到指定的声明式应用')
      expect(wrapper.text()).toContain('malicious-injected-id-9999')
      expect(wrapper.find('.declarative-error-back-btn').text()).toContain('返回我的插件列表')

      // 点击能安全返回
      await wrapper.find('.declarative-error-back-btn').trigger('click')
      expect(mockPush).toHaveBeenCalledWith({ name: 'my' })
    })

    it('边界异常 4: 远端市场服务崩溃或 500 熔断时，loadWithCache 优雅降级并确保内置标杆应用始终可用', async () => {
      const { getMarketPlugins } = await import('@/api/apiserver')
      // 模拟远端接口 500 熔断抛错
      vi.mocked(getMarketPlugins).mockRejectedValueOnce(new Error('Internal Server Error 500: Database connection pool exhausted'))

      const store = usePluginsStore()
      const fallbackRes = await store.loadWithCache({ category: '办公效率' }, true)

      // 验证平滑降级：不抛出未捕获异常，且内置核心标杆应用依然正常就绪
      expect(fallbackRes.list.length).toBeGreaterThan(0)
      expect(fallbackRes.list.some((p) => p.pluginId === 'json-format')).toBe(true)
    })
  })
})
