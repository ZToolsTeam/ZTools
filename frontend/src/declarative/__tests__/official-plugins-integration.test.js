import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import fs from 'node:fs'
import path from 'node:path'
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
import { BUNDLED_PLUGIN_IDS, isStoreOfficialPlugin } from '@/utils/bundledPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'

/**
 * 模拟客户端的静态资源服务：bundled-plugins/ 下的请求直接读取 public/bundled-plugins 里的真实插件产物，
 * 其余请求一律视为断网，保证测试走真实的插件代码而不访问外网
 */
function bundledFetch(url) {
  const m = String(url).match(/\/bundled-plugins\/(.+)$/)
  if (!m) return Promise.reject(new Error('测试环境断网'))
  const file = path.join(process.cwd(), 'public/bundled-plugins', ...m[1].split('/').map(decodeURIComponent))
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, text: async () => '' })
  const body = fs.readFileSync(file, 'utf8')
  return Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) })
}

async function settle() {
  // 窗口 API 按需 import，先等模块就绪再断言后续路由和界面状态。
  await vi.dynamicImportSettled()
  for (let i = 0; i < 10; i++) {
    await flushPromises()
    await nextTick()
  }
}

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
    vi.stubGlobal('fetch', vi.fn(bundledFetch))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('1. 注册表完整性与规范断言 (Registry Completeness)', () => {
    it('保留的旧内置应用定义字段完备合规', () => {
      // 内置原版与市场真实插件另行验证，不能要求它们继续返回旧示例实现。
      const requiredBenchmarkIds = [
        'github',
        'google-translate',
        'obsidian',
        'winget',
        'currency-exchange'
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

    it('与内置原版插件同 ID（含别名）的旧实现必须让位，不再被识别为旧内置应用', () => {
      for (const id of BUNDLED_PLUGIN_IDS) {
        expect(isOfficialPlugin(id)).toBe(false)
        expect(isOfficialPlugin(`  ${id.toUpperCase()}  `)).toBe(false)
        expect(getOfficialPlugin(id)).toBeUndefined()
      }
      // screen-color-picker 是 color-picker 的别名，同样让位
      expect(getOfficialPlugin('screen-color-picker')).toBeUndefined()
      expect(getOfficialPluginsList().some((p) => BUNDLED_PLUGIN_IDS.includes(p.pluginId))).toBe(false)
    })

    it('大小写不敏感与首尾空白容错', () => {
      expect(isOfficialPlugin('  KILL-PROCESS  ')).toBe(true)
      expect(getOfficialPlugin('  GITHUB  ')).toBeDefined()
      expect(getOfficialPlugin('  GITHUB  ').pluginId).toBe('github')
      // 插件市场分发的真实插件（kill-process、cleaner）不再返回同名的旧示例实现，大小写与空白同样处理
      for (const id of ['kill-process', '  KILL-PROCESS  ', 'cleaner']) expect(getOfficialPlugin(id)).toBeUndefined()
    })
  })

  describe('2. Pinia Store 集成与已安装列表合并', () => {
    it.each(['darwin', 'win32'])('网络测速使用市场真实实现，仅 macOS 开放入口（%s）', async (platform) => {
      vi.stubGlobal('__ZTOOLS_PLATFORM_OVERRIDE__', platform)
      const installed = {
        pluginId: 'speedtest', name: '网络测速', author: 'ZTools Team',
        entry: 'dist/index.js', isDeclarative: true
      }
      vi.mocked(apiServer.getLocalPlugins).mockResolvedValue([installed])
      const store = usePluginsStore()
      await store.fetchInstalledPlugins()

      // 网络测速由官方维护，经插件市场分发，不使用同名旧内置实现
      expect(isStoreOfficialPlugin('speedtest')).toBe(true)
      expect(getOfficialPlugin('speedtest')).toBeUndefined()
      expect(getOfficialPluginsList().some(p => p.pluginId === 'speedtest')).toBe(false)
      expect(isPluginVisible(' SPEEDTEST ')).toBe(true)
      expect(isPluginSupportedOnCurrentPlatform(' SPEEDTEST ')).toBe(platform === 'darwin')
      const installedSpeedtest = store.installedPlugins.filter(p => p.pluginId === 'speedtest')
      mockPush.mockClear()
      if (platform === 'darwin') {
        expect(installedSpeedtest).toHaveLength(1)
        expect(installedSpeedtest[0]).toMatchObject(installed)
        await expect(store.openPlugin('speedtest')).resolves.toMatchObject({ success: true, isDeclarative: true })
        expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
          name: 'declarative', params: { pluginId: 'speedtest' }
        }))
      } else {
        expect(installedSpeedtest).toEqual([])
        await expect(store.openPlugin(' SPEEDTEST ')).rejects.toThrow('当前系统上暂不可用')
        expect(mockPush).not.toHaveBeenCalled()
      }
      expect(apiServer.openPlugin).not.toHaveBeenCalled()
    })

    it('表格互转安装后显示真实官方市场插件，旧内置实现不能抢占入口或改写作者', async () => {
      const installed = {
        pluginId: 'table-converter', name: '表格互转', author: 'ZTools Team',
        version: '1.0.0', entry: 'dist/index.js', isDeclarative: true
      }
      vi.mocked(apiServer.getLocalPlugins).mockResolvedValue([installed])
      const store = usePluginsStore()
      await store.fetchInstalledPlugins()

      expect(store.installedPlugins.filter((p) => p.pluginId === installed.pluginId)).toEqual([
        expect.objectContaining({ ...installed, isOfficial: true, is_official: true })
      ])
      expect(getOfficialPlugin(installed.pluginId)).toBeUndefined()
      expect(isOfficialPlugin(installed.pluginId)).toBe(true)
      expect(isPluginVisible(' TABLE-CONVERTER ')).toBe(true)
      const result = await store.openPlugin(installed.pluginId)
      expect(result.isDeclarative).toBe(true)
      expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
        name: 'declarative', params: { pluginId: installed.pluginId }
      }))
      expect(apiServer.openPlugin).not.toHaveBeenCalled()
    })

    it('fetchInstalledPlugins：官方插件展示内置原版与插件市场安装的，旧内置实现与草稿隐藏，社区插件照常展示', async () => {
      vi.mocked(apiServer.getLocalPlugins).mockResolvedValue([
        { pluginId: 'legacy-demo', name: '社区插件', lastUsedTime: 100 },
        // 用户以前从市场装过的未完成官方插件：隐藏
        { pluginId: 'cleaner', name: '垃圾清理', author: 'ZTools Team', lastUsedTime: 90 },
        // 与内置插件同 ID 的已安装旧副本：合并为内置条目，只出现一次
        { pluginId: 'json-format', name: '旧 JSON', lastUsedTime: 80 }
      ])

      const store = usePluginsStore()
      await store.fetchInstalledPlugins()

      const ids = store.installedPlugins.map((p) => p.pluginId)
      expect(ids).toContain('legacy-demo')
      for (const id of BUNDLED_PLUGIN_IDS) expect(ids).toContain(id)
      expect(ids.filter((id) => id === 'json-format')).toHaveLength(1)
      // 插件市场分发的官方插件安装后正常展示；草稿、旧示例实现与已合并的旧插件仍隐藏
      expect(ids).toContain('cleaner')
      for (const hidden of ['speedtest', 'kill-process', 'clipboard-history', 'notes']) {
        expect(ids).not.toContain(hidden)
      }
      // 内置插件 + 社区插件 legacy-demo + 插件市场安装的 cleaner
      expect(store.installedPlugins.length).toBe(BUNDLED_PLUGIN_IDS.length + 2)

      const jsonFormat = store.installedPlugins.find((p) => p.pluginId === 'json-format')
      expect(jsonFormat.isDeclarative).toBe(true)
      expect(jsonFormat.bundled).toBe(true)
      expect(typeof jsonFormat.category).toBe('string')
    })

    it('当本地原生接口异常/网络不可用时，内置插件依然可用', async () => {
      vi.mocked(apiServer.getLocalPlugins).mockRejectedValue(new Error('Native IPC Connection Timeout'))

      const store = usePluginsStore()
      await store.fetchInstalledPlugins()

      expect(store.installedPlugins.map((p) => p.pluginId).sort()).toEqual([...BUNDLED_PLUGIN_IDS].sort())
      expect(store.installedSet.has('json-format')).toBe(true)
    })

    it('列表尚未加载时打开内置插件，也直接路由到声明式页面，不走原生插件接口', async () => {
      const store = usePluginsStore()
      const result = await store.openPlugin('json-format')

      expect(result.success).toBe(true)
      expect(result.isDeclarative).toBe(true)
      expect(apiServer.openPlugin).not.toHaveBeenCalled()
      expect(store.recents).toContain('json-format')
      expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
        name: 'declarative',
        params: { pluginId: 'json-format' }
      }))
    })

    it('严禁卸载内置插件', async () => {
      const store = usePluginsStore()
      await expect(store.uninstallPlugin('json-format')).rejects.toThrow('内置插件随客户端提供，不能卸载')

      // onUninstallComplete 事件静默保护
      store.installedSet.add('json-format')
      store.onUninstallComplete({ pluginId: 'json-format' })
      expect(store.installedSet.has('json-format')).toBe(true)
    })

    it('插件市场分发的官方插件（如 kill-process）装在插件目录里，可以正常卸载', async () => {
      const store = usePluginsStore()
      const uninstall = vi.fn().mockResolvedValue({ success: true })
      const previous = window.ztools
      window.ztools = { ...(previous || {}), plugin: { uninstall } }
      store.fetchInstalledPlugins = vi.fn().mockResolvedValue(undefined)
      try {
        store.installedSet.add('kill-process')
        await expect(store.uninstallPlugin('kill-process')).resolves.toEqual({ success: true })
        expect(uninstall).toHaveBeenCalledWith('kill-process')
        expect(store.installedSet.has('kill-process')).toBe(false)
      } finally {
        window.ztools = previous
      }
    })

    it('插件市场（远端不可达时）只列出内置插件，并支持分类与搜索', async () => {
      const store = usePluginsStore()

      const devRes = await store.loadWithCache({ category: '开发工具' }, true)
      expect(devRes.list.some((p) => p.pluginId === 'json-format')).toBe(true)
      expect(devRes.list.some((p) => p.pluginId === 'calculator')).toBe(false)
      expect(devRes.list.some((p) => p.pluginId === 'kill-process')).toBe(false)

      const allRes = await store.loadWithCache({}, true)
      for (const p of allRes.list) expect(isPluginVisible(p)).toBe(true)
      expect(allRes.list.some((p) => p.pluginId === 'clipboard-history')).toBe(false)

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

      await settle()

      // 读取的是 public/bundled-plugins 下真实的插件产物
      expect(wrapper.text()).toContain('JSON 格式化')
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(true)
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('bundled-plugins/json-format/dist/index.js'))
    })

    it('冷启动异步加载内置声明式插件期间：顶栏标题首帧直出，且严禁在加载完成前闪现“未找到指定的声明式应用”报错卡片', async () => {
      let resolvePendingFetch
      vi.stubGlobal(
        'fetch',
        vi.fn((url) => new Promise((resolve) => {
          resolvePendingFetch = () => resolve(bundledFetch(url))
        }))
      )

      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'json-format' }
      })

      // 首帧（异步 fetch 尚未返回）：顶栏标题与独立窗口按钮已就绪，主体仅展示静默背景占位，绝不闪现报错图标或文案
      expect(wrapper.text()).toContain('JSON 格式化')
      expect(wrapper.find('.declarative-popout-btn').exists()).toBe(true)
      expect(wrapper.find('[data-test="declarative-loading-placeholder"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('未找到指定的声明式应用')
      expect(wrapper.find('.declarative-error-back-btn').exists()).toBe(false)

      // 推进所有挂起的请求直至插件加载完成
      while (resolvePendingFetch) {
        const fn = resolvePendingFetch
        resolvePendingFetch = null
        fn()
        await flushPromises()
      }
      await settle()

      expect(wrapper.find('[data-test="declarative-loading-placeholder"]').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(true)
    })

    it('通过 store.openPlugin 预热后进入 DeclarativePage 时：首帧即同步挂载 DeclarativeView（零异步等待帧）', async () => {
      const store = usePluginsStore()
      await store.openPlugin('json-format')

      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'json-format' }
      })

      // 无需等待 flushPromises，首帧同步命中内存缓存并挂载 DeclarativeView
      expect(wrapper.find('[data-test="declarative-loading-placeholder"]').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(true)
    })

    it('[Beyond Happy Path] 当插件资源加载失败 (HTTP 500) 时：加载结束后准确呈现错误提示与返回按钮', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error'
        })
      )

      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'json-format' }
      })

      await settle()

      expect(wrapper.find('[data-test="declarative-loading-placeholder"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('未找到指定的声明式应用')
      expect(wrapper.text()).toContain('HTTP 500')
      expect(wrapper.find('.declarative-error-back-btn').exists()).toBe(true)
    })

    it('点击返回工作台按钮触发路由后退', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'qr-code' }
      })

      await settle()

      // 返回入口只有底栏「返回工作台 Esc」一个，顶栏不再重复放返回按钮
      expect(wrapper.find('button[title*="返回我的插件"]').exists()).toBe(false)
      const backBtns = wrapper.findAll('[data-decl-exit]')
      expect(backBtns).toHaveLength(1)
      expect(backBtns[0].element.tagName).toBe('BUTTON')
      await backBtns[0].trigger('click')

      expect(mockPush).toHaveBeenCalledWith({ name: 'my' })
    })

    it('子页面标题并入顶栏面包屑，视图内不再叠第二条标题栏；切换插件后清空', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'qr-code' }
      })

      await settle()

      expect(wrapper.find('[data-decl-page-subtitle]').exists()).toBe(false)
      const view = wrapper.findComponent({ name: 'DeclarativeView' })
      expect(view.props('hostTitleBar')).toBe(true)
      view.vm.$emit('title-change', '编辑规则')
      await nextTick()
      expect(wrapper.find('[data-decl-page-subtitle]').text()).toBe('编辑规则')
      // [边界] 非字符串标题不显示
      view.vm.$emit('title-change', null)
      await nextTick()
      expect(wrapper.find('[data-decl-page-subtitle]').exists()).toBe(false)

      view.vm.$emit('title-change', '编辑规则')
      await nextTick()
      await wrapper.setProps({ pluginId: 'calculator' })
      await settle()
      expect(wrapper.find('[data-decl-page-subtitle]').exists()).toBe(false)
    })

    it('点击【独立窗口】按钮时应携带状态弹出独立窗口，并在原生 IPC 异常时平滑降级至 /popout 路由', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'todo' }
      })

      await settle()

      const popoutBtn = wrapper.find('.declarative-popout-btn')
      expect(popoutBtn.exists()).toBe(true)
      await popoutBtn.trigger('click')
      await settle()

      // 在测试环境 (无 Electron 原生窗口句柄) 下，平滑降级跳转至 popout 独立路由
      expect(mockPush).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'popout',
          params: { pluginId: 'todo' }
        })
      )
    })

    it('独立常驻窗口模式 (isPopout=true) 应展示置顶与收回控制，且根视图按 Esc 严禁误触发退出', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'calculator', isPopout: true }
      })

      await settle()

      expect(wrapper.find('.declarative-pin-btn').exists()).toBe(true)
      expect(wrapper.find('.declarative-dock-btn').exists()).toBe(true)
      expect(wrapper.find('.declarative-popout-btn').exists()).toBe(false)
      // Esc 只清空搜索的提示只在底栏出现一处，灰阶显示；不再有返回工作台入口
      const hints = wrapper.findAll('[data-decl-popout-hint]')
      expect(hints).toHaveLength(1)
      expect(hints[0].text()).toContain('只清空搜索')
      expect(wrapper.find('[data-decl-exit]').exists()).toBe(false)
      expect(wrapper.html()).not.toContain('--rc-success')

      // 在独立常驻模式根视图下触发 exit 事件，handleExit 必须拦截，不得跳转回主页
      const view = wrapper.findComponent({ name: 'DeclarativeView' })
      view.vm.$emit('exit')
      await nextTick()
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('列表项点击鼠标右键 (@contextmenu) 应自动高亮选中并就地呼出 ActionPanel', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'calculator' }
      })

      await settle()

      const view = wrapper.findComponent({ name: 'DeclarativeView' })
      expect(view.exists()).toBe(true)

      const itemEls = wrapper.findAll('.cursor-pointer')
      const firstItem = itemEls.find(el => el.text().includes('sqrt'))
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

    it('[破坏性] 未开放的插件即使绕过列表直接打开也会被拒绝，且不跳转', async () => {
      const store = usePluginsStore()
      mockPush.mockClear()
      for (const id of ['github', 'trial-nudges', 'clipboard-history']) {
        await expect(store.openPlugin(id)).rejects.toThrow('暂未开放')
      }
      expect(mockPush).not.toHaveBeenCalled()
      expect(apiServer.openPlugin).not.toHaveBeenCalled()
    })

    it('[破坏性] 直接访问未开放插件的路由时显示「暂未开放」，不渲染插件', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'trial-nudges' },
        global: { stubs: { DeclarativeView: true } }
      })
      await settle()
      expect(wrapper.text()).toContain('该插件暂未开放')
      expect(wrapper.text()).not.toContain('核心特权与技术方案')
      expect(wrapper.text()).not.toContain('未找到指定的声明式应用')
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(false)
      wrapper.unmount()
    })

    it('[集成] 与内置插件重复的旧插件 notes 已合并进便签：从旧入口打开直接进入便签', async () => {
      const store = usePluginsStore()
      mockPush.mockClear()
      for (const id of ['notes', ' NOTES ']) {
        const result = await store.openPlugin(id)
        expect(result.success).toBe(true)
      }
      expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ name: 'declarative', params: { pluginId: 'memo' } }))
      expect(mockPush.mock.calls.every(([arg]) => arg?.params?.pluginId === 'memo')).toBe(true)
      expect(store.recents).toContain('memo')
      expect(store.recents).not.toContain('notes')
      expect(apiServer.openPlugin).not.toHaveBeenCalled()
    })

    it('[集成] 直接访问旧 notes 插件的路由时渲染便签，不提示暂未开放', async () => {
      const wrapper = mount(DeclarativePage, {
        props: { pluginId: 'notes' },
        global: { stubs: { DeclarativeView: true } }
      })
      await settle()
      expect(wrapper.text()).not.toContain('该插件暂未开放')
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

      await settle()

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
      const fallbackRes = await store.loadWithCache({ category: '开发工具' }, true)

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
      // 标题用插件名，命令说明保留在 featureExplain 里作为提示
      expect(loadedSub.title).toBe('极客工具箱')
      expect(loadedSub.featureExplain).toBe('查看运行日志')
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
