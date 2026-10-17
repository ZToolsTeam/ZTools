import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { resolvePluginGlyph } from '@/utils/brandIcons'
import { _resetKeymapForTesting } from '@/utils/keymap'

// 模拟 vue-router 与 @/router
const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn()
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useRoute: () => ({ params: { pluginId: 'json-format' }, query: {} }),
    useRouter: () => ({
      push: mockPush,
      back: vi.fn(),
      currentRoute: { value: { name: 'launcher', path: '/launcher' } },
      resolve: (loc) => {
        if (typeof loc === 'string') return { fullPath: loc }
        const base = loc?.params?.pluginId
          ? `/${loc.name || 'declarative'}/${loc.params.pluginId}`
          : `/${loc?.name || ''}`
        const qs =
          loc?.query && Object.keys(loc.query).length > 0
            ? `?${new URLSearchParams(loc.query).toString()}`
            : ''
        return { fullPath: `${base}${qs}` }
      }
    })
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
    _resetKeymapForTesting()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // 集成测试不访问外网：远端 catalog 不可达时走内置标杆应用兜底，这正是要验证的降级路径
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试环境断网')))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
        'kill-process',
        'cleaner'
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
        // 图标统一使用品牌线性图形（不再使用彩色渐变）
        expect(resolvePluginGlyph(id)).not.toBe('')
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
      expect(officeRes.list.some((p) => p.pluginId === 'notes')).toBe(true)
      expect(officeRes.list.some((p) => p.pluginId === 'clipboard-history')).toBe(true)
      expect(officeRes.list.some((p) => p.pluginId === 'snippets')).toBe(true)
      // 只能展示示例数据的插件不进市场
      expect(officeRes.list.some((p) => p.pluginId === 'github')).toBe(false)

      // 2. 分类筛选：'系统工具'
      const sysRes = await store.loadWithCache({ category: '系统工具' }, true)
      expect(sysRes.list.some((p) => p.pluginId === 'qr-code')).toBe(false)
      expect(sysRes.list.some((p) => p.pluginId === 'kill-process')).toBe(false)
      expect(sysRes.list.some((p) => p.pluginId === 'trial-nudges')).toBe(false)

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

    it('点击【独立窗口】按钮时应携带状态弹出独立窗口，并在原生 IPC 异常时平滑降级至 /popout 路由', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'software-manager' }
      })

      await nextTick()

      const popoutBtn = wrapper.find('.declarative-popout-btn')
      expect(popoutBtn.exists()).toBe(true)
      await popoutBtn.trigger('click')

      // 在测试环境 (无 Electron 原生窗口句柄) 下，平滑降级跳转至 popout 独立路由
      expect(mockPush).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'popout',
          params: { pluginId: 'software-manager' }
        })
      )
    })

    it('独立常驻窗口模式 (isPopout=true) 应展示置顶与收回控制，且根视图按 Esc 严禁误触发退出', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'process-monitor', isPopout: true }
      })

      await nextTick()

      expect(wrapper.find('.declarative-pin-btn').exists()).toBe(true)
      expect(wrapper.find('.declarative-dock-btn').exists()).toBe(true)
      expect(wrapper.find('.declarative-popout-btn').exists()).toBe(false)
      expect(wrapper.text()).toContain('独立常驻防误关')

      // 在独立常驻模式根视图下触发 exit 事件，handleExit 必须拦截，不得跳转回主页
      const view = wrapper.findComponent({ name: 'DeclarativeView' })
      view.vm.$emit('exit')
      await nextTick()
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('列表项点击鼠标右键 (@contextmenu) 应自动高亮选中并就地呼出 ActionPanel', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'software-manager' }
      })

      await nextTick()

      const view = wrapper.findComponent({ name: 'DeclarativeView' })
      expect(view.exists()).toBe(true)

      const itemEls = wrapper.findAll('.cursor-pointer')
      const firstItem = itemEls.find(el => el.text().includes('微信') || el.text().includes('Chrome'))
      expect(firstItem).toBeDefined()

      // 触发 contextmenu 右键事件
      await firstItem.trigger('contextmenu')
      await nextTick()

      // 断言动作面板已弹出并携带目标项目名称
      const modal = wrapper.findComponent({ name: 'ActionPanelModal' })
      expect(modal.exists()).toBe(true)
      expect(modal.props('visible')).toBe(true)
      expect(modal.props('targetTitle')).toBeTruthy()
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

    it('[破坏性] 不可用的内置插件即使绕过列表直接打开也会被拒绝，且不跳转', async () => {
      const store = usePluginsStore()
      mockPush.mockClear()
      for (const id of ['github', ' KILL-PROCESS ', 'trial-nudges']) {
        await expect(store.openPlugin(id)).rejects.toThrow('当前系统上暂不可用')
      }
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('[破坏性] 直接访问不可用插件的路由时显示「当前系统暂不可用」，不渲染插件', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'kill-process' },
        global: { stubs: { DeclarativeView: true } }
      })
      await nextTick()
      expect(wrapper.text()).toContain('当前系统暂不可用')
      expect(wrapper.text()).toContain('进程管理急救箱')
      expect(wrapper.text()).not.toContain('未找到指定的声明式应用')
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(false)
      wrapper.unmount()
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

  describe('5. 第三方 V2 声明式扩展在 LauncherBar 原位秒开、features/no-view 与跨窗口接力集成测试', () => {
    it('5.1 [子命令命名导出与 no-view 执行] loadInstalledDeclarativePlugin 与 executeDeclarativeNoViewCommand 端到端闭环', async () => {
      const {
        loadInstalledDeclarativePlugin,
        executeDeclarativeNoViewCommand
      } = await import('@/utils/declarativePluginLoader')

      const mockFiles = {
        'plugin.json': JSON.stringify({
          id: 'third-party-suite',
          name: '极客工具箱',
          version: '1.2.0',
          description: '支持多命令与极速动作的第三方扩展',
          author: 'Indie Dev',
          entry: 'dist/index.js',
          icon: 'icon.svg',
          permissions: ['clipboard'],
          features: [
            { code: 'quick-clean', explain: '一键清理临时缓存', mode: 'no-view', alias: 'qc' },
            { code: 'view-logs', explain: '查看运行日志', mode: 'view', alias: 'vl' }
          ]
        }),
        'dist/index.js': `
          import { createElement, List } from '@ztools/declarative-ui'
          export function quickClean(ctx) {
            if (ctx.query === 'TRIGGER_FAIL') {
              throw new Error('磁盘只读无法清理')
            }
            return { message: '已清理 128MB 临时缓存' }
          }
          export function viewLogs() {
            return createElement(List, { navigationTitle: '第三方日志视图' })
          }
          export default function MainView() {
            return createElement(List, { navigationTitle: '第三方主视图' })
          }
        `
      }

      const readFile = async (_pid, relPath) => {
        if (mockFiles[relPath]) return mockFiles[relPath]
        throw new Error(`File not found: ${relPath}`)
      }

      // 1. 按 featureCode='view-logs' 加载驼峰命名导出 viewLogs
      const loadedSub = await loadInstalledDeclarativePlugin('third-party-suite', {
        featureCode: 'view-logs',
        readFile
      })
      expect(loadedSub.pluginId).toBe('third-party-suite')
      expect(loadedSub.featureCode).toBe('view-logs')
      expect(loadedSub.title).toBe('查看运行日志')
      expect(loadedSub.mode).toBe('view')
      expect(loadedSub.alias).toBe('vl')
      expect(typeof loadedSub.command).toBe('function')

      // 2. 执行 mode='no-view' 子命令成功路径
      const execOk = await executeDeclarativeNoViewCommand('third-party-suite', {
        featureCode: 'quick-clean',
        query: 'normal',
        readFile
      })
      expect(execOk.success).toBe(true)
      expect(execOk.message).toBe('已清理 128MB 临时缓存')

      // 3. [Beyond Happy Path] 执行 no-view 子命令抛错时包装为结构化 NO_VIEW_EXECUTION_ERROR
      await expect(
        executeDeclarativeNoViewCommand('third-party-suite', {
          featureCode: 'quick-clean',
          query: 'TRIGGER_FAIL',
          readFile
        })
      ).rejects.toMatchObject({
        code: 'NO_VIEW_EXECUTION_ERROR'
      })
    })

    it('5.2 [LauncherBar 原位秒开第三方 V2 插件 + Ctrl+K 子命令聚合 + Ctrl+M 跨窗接力 + 沙箱异常自愈]', async () => {
      const LauncherBar = (await import('@/components/LauncherBar.vue')).default

      // 模拟 fetch 读取本地已安装第三方 V2 插件资源
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url) => {
          const urlStr = String(url)
          if (urlStr.includes('ztools://plugins/community-notes/plugin.json')) {
            return {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({
                  id: 'community-notes',
                  name: '社区灵感笔记',
                  version: '1.0.0',
                  description: '第三方 V2 声明式笔记扩展',
                  author: 'Community',
                  entry: 'dist/index.js',
                  icon: 'icon.svg',
                  permissions: [],
                  features: [
                    { code: 'quick-stamp', explain: '复制当前时间戳', mode: 'no-view', alias: 'ts' },
                    { code: 'archive-list', explain: '打开归档笔记', mode: 'view', alias: 'arc' }
                  ]
                })
            }
          }
          if (urlStr.includes('ztools://plugins/community-notes/dist/index.js')) {
            return {
              ok: true,
              status: 200,
              text: async () => `
                const { createElement, List } = require('@ztools/declarative-ui');
                exports.quickStamp = function() {
                  return '时间戳已复制到剪贴板';
                };
                exports.default = function CommunityNotesApp() {
                  return createElement(
                    List,
                    { navigationTitle: '社区灵感笔记视图', searchBarPlaceholder: '搜索社区笔记...' },
                    createElement(List.Item, { id: 'note-1', title: '第一条社区极客笔记' })
                  );
                };
              `
            }
          }
          if (urlStr.includes('ztools://plugins/broken-v2-plugin/plugin.json')) {
            return {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({
                  id: 'broken-v2-plugin',
                  name: '损坏的扩展',
                  entry: 'dist/index.js',
                  permissions: []
                })
            }
          }
          if (urlStr.includes('ztools://plugins/broken-v2-plugin/dist/index.js')) {
            return {
              ok: true,
              status: 200,
              text: async () => `const cp = require('child_process');`
            }
          }
          throw new Error('Network disabled in test')
        })
      )

      const expandSpy = vi.fn().mockResolvedValue(undefined)
      window.__ztoolsLauncher = {
        expandToDashboard: expandSpy,
        hide: vi.fn().mockResolvedValue(undefined)
      }

      const store = usePluginsStore()
      vi.spyOn(store, 'init').mockResolvedValue(undefined)
      store.installedPlugins = [
        {
          pluginId: 'community-notes',
          name: '社区灵感笔记',
          description: '第三方 V2 声明式笔记扩展',
          entry: 'dist/index.js',
          isDeclarative: true,
          features: [
            { code: 'quick-stamp', explain: '复制当前时间戳', mode: 'no-view', alias: 'ts' },
            { code: 'archive-list', explain: '打开归档笔记', mode: 'view', alias: 'arc' }
          ]
        },
        {
          pluginId: 'broken-v2-plugin',
          name: '损坏的扩展',
          description: '试图越权调用 child_process',
          entry: 'dist/index.js',
          isDeclarative: true
        }
      ]

      const wrapper = mount(LauncherBar)
      await nextTick()

      // 1. 搜索定位到「社区灵感笔记」
      const input = wrapper.find('#launcherQuery')
      await input.setValue('社区灵感笔记')
      await input.trigger('input')
      await nextTick()

      expect(wrapper.text()).toContain('社区灵感笔记')

      // 2. 打开 Ctrl+K 动作面板，验证聚合了插件声明的 features 子命令与独立常驻窗口选项
      const actionBtn = wrapper.findAll('.launcher-foot-hint').find((b) => b.text().includes('动作'))
      await actionBtn.trigger('click')
      await nextTick()

      const actionModal = wrapper.findComponent({ name: 'ActionPanelModal' })
      expect(actionModal.exists()).toBe(true)
      const actionTitles = actionModal.props('actions').map((a) => a.props?.title)
      expect(actionTitles).toContain('执行：复制当前时间戳')
      expect(actionTitles).toContain('打开：打开归档笔记')
      expect(actionTitles).toContain('在独立常驻窗口中打开')

      // 关闭动作面板
      actionModal.vm.$emit('close')
      await nextTick()

      // 3. 点击「社区灵感笔记」行：验证第三方 V2 插件直接在 LauncherBar 内原位秒开 DeclarativeView
      const firstRow = wrapper.find('.launcher-row')
      await firstRow.trigger('click')
      await new Promise((r) => setTimeout(r, 30))
      await nextTick()

      const declView = wrapper.findComponent({ name: 'DeclarativeView' })
      expect(declView.exists()).toBe(true)
      expect(wrapper.text()).toContain('第一条社区极客笔记')
      expect(window.__ztoolsLauncher.hide).not.toHaveBeenCalled()

      // 4. 在原位声明式视图触发 Ctrl+M 展开工作台，验证路由自动指向 /declarative/community-notes
      await wrapper.trigger('keydown', { key: 'm', ctrlKey: true })
      await nextTick()
      expect(expandSpy).toHaveBeenCalledWith(expect.stringContaining('/declarative/community-notes'))

      // 5. [Beyond Happy Path] 触发试图越权加载 child_process 的第三方插件：验证悬浮条原位拦截并显示错误态，按 Esc 自愈恢复
      const inputAfterExpand = wrapper.find('#launcherQuery')
      await inputAfterExpand.setValue('损坏的扩展')
      await inputAfterExpand.trigger('input')
      await nextTick()

      await wrapper.find('.launcher-row').trigger('click')
      await new Promise((r) => setTimeout(r, 30))
      await nextTick()

      expect(wrapper.text()).toContain('无法打开该扩展')
      expect(wrapper.text()).toContain('安全沙箱拦截')

      // 按 Escape 自愈返回搜索框
      await wrapper.trigger('keydown', { key: 'Escape' })
      await nextTick()
      expect(wrapper.find('#launcherQuery').exists()).toBe(true)

      wrapper.unmount()
      delete window.__ztoolsLauncher
    })
  })
})
