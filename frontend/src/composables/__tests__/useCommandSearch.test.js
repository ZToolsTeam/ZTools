import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import * as edition from '@edition'
import {
  useCommandSearch,
  calculateFrecencyBonus,
  CATEGORY_RANKS,
  CATEGORY_WEIGHTS,
  PINNED_GRID_COLUMNS,
  buildPinPayload,
  canPinItem,
  resolvePinKey,
  getCategoryRank,
  getCategoryWeight,
  loadFrecencyMap,
  saveFrecencyMap,
  recordCommandUsage,
  recordQueryChoice,
  resolveCommandFaIcon,
  resolveFileFaIcon
} from '../useCommandSearch.js'

describe('useCommandSearch 统一搜索内核与 Frecency 排序测试套件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('1. [Frecency 连续时间衰减与对数频次算法] 1 小时内不同时间点连续区分，近期高频综合加权', () => {
    const now = Date.now()

    // 刚刚使用 1 次 vs 45 分钟前使用 1 次：刚使用的得分必须更高（消灭 1 小时内同分乱序）
    const justNowStats = { count: 1, lastUsed: now - 5 * 1000 }
    const fortyFiveMinStats = { count: 1, lastUsed: now - 45 * 60 * 1000 }
    expect(calculateFrecencyBonus(justNowStats, now)).toBeGreaterThan(
      calculateFrecencyBonus(fortyFiveMinStats, now)
    )

    // 30 分钟前使用 5 次
    const recentStats = { count: 5, lastUsed: now - 30 * 60 * 1000 }
    const bonusRecent = calculateFrecencyBonus(recentStats, now)
    expect(bonusRecent).toBe(151)

    // 2 天前使用 2 次（衰减计数 2 × 0.5^(2/30) ≈ 1.91）
    const twoDaysStats = { count: 2, lastUsed: now - 48 * 60 * 60 * 1000 }
    const bonusTwoDays = calculateFrecencyBonus(twoDaysStats, now)
    expect(bonusTwoDays).toBe(36)
    expect(bonusRecent).toBeGreaterThan(bonusTwoDays)

    // 空/非法记录
    expect(calculateFrecencyBonus(null)).toBe(0)
    expect(calculateFrecencyBonus({})).toBe(0)
  })

  it('2. [使用历史记录与持久化] recordCommandUsage 与 loadFrecencyMap', () => {
    recordCommandUsage('everything-search')
    recordCommandUsage('everything-search')

    const map = loadFrecencyMap()
    expect(map['everything-search']).toBeDefined()
    expect(map['everything-search'].count).toBe(2)
    expect(map['everything-search'].lastUsed).toBeGreaterThan(0)
  })

  it('3. [防乱序检索机制] 快速连续输入时丢弃过期响应', async () => {
    let resolveFirst = null
    let resolveSecond = null

    const mockSearchFiles = vi.fn().mockImplementation((query) => {
      if (query === 'first') {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ files: [{ name: 'first.txt', path: 'C:/first.txt', is_dir: false }] })
        })
      }
      if (query === 'second') {
        return new Promise((resolve) => {
          resolveSecond = () => resolve({ files: [{ name: 'second.txt', path: 'C:/second.txt', is_dir: false }] })
        })
      }
      return Promise.resolve({ files: [] })
    })

    window.__ztoolsLauncher = { searchFiles: mockSearchFiles }

    const { fileResults, search } = useCommandSearch({ enableFileSearch: true })

    // 快速触发第一次搜索
    search('first')
    // 立即触发第二次搜索（覆盖第一次）
    search('second')

    // 此时即使第一次搜索耗时很长并之后才返回
    await new Promise((r) => setTimeout(r, 120)) // 等待 debounce（80ms）
    if (resolveSecond) resolveSecond()
    if (resolveFirst) resolveFirst()

    await new Promise((r) => setTimeout(r, 30))

    // 结果必须是第二次的，绝不被第一次乱序覆盖
    expect(fileResults.value.some((f) => f.name === 'second.txt')).toBe(true)
    expect(fileResults.value.some((f) => f.name === 'first.txt')).toBe(false)
    delete window.__ztoolsLauncher
  })

  it('4. [图标语义映射与 Beyond Happy Path] 容错与默认回退', () => {
    expect(resolveCommandFaIcon('音频提取器', '媒体')).toBe('fa-music')
    expect(resolveCommandFaIcon('代码格式化', '开发')).toBe('fa-code')
    expect(resolveCommandFaIcon('未知工具', '')).toBe('fa-cube')
    expect(resolveCommandFaIcon(null, null)).toBe('fa-cube')

    expect(resolveFileFaIcon('folder', true)).toBe('fa-folder')
    expect(resolveFileFaIcon('pic.png', false)).toBe('fa-file-image-o')
    expect(resolveFileFaIcon('song.mp3', false)).toBe('fa-file-audio-o')
    expect(resolveFileFaIcon('unknown.xyz', false)).toBe('fa-file-text-o')

    // 损坏的 localStorage 容错
    localStorage.setItem('ztools_command_frecency', '{corrupted_json')
    expect(loadFrecencyMap()).toEqual({})
  })

  it('5. [插件 features 子命令、alias 短别名与 no-view 集成链路] 检索召回与置顶排序', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = [
      {
        pluginId: 'audio-helper',
        name: '音频百宝箱',
        description: '系统音量与设备管理',
        entry: 'dist/index.js',
        isDeclarative: true,
        alias: 'aud',
        features: [
          {
            code: 'quick-mute',
            explain: '一键静音切换',
            mode: 'no-view',
            alias: 'mute',
            cmds: ['静音', '关闭声音', { type: 'keyword', label: 'mute-audio' }]
          },
          {
            code: 'switch-output',
            explain: '切换输出扬声器',
            mode: 'view',
            alias: 'spk',
            cmds: ['耳机', '扬声器']
          }
        ]
      }
    ]

    const { filteredItems, search, recordUsage } = useCommandSearch({ enableFileSearch: false })

    // 默认空查询时：只展示主插件，未曾使用过的子命令不污染首屏列表
    expect(filteredItems.value.some((i) => i.key === 'audio-helper')).toBe(true)
    expect(filteredItems.value.some((i) => i.key === 'audio-helper:quick-mute')).toBe(false)

    // 输入短别名 "mute"：子命令立即以最高优先级置顶召回
    search('mute')
    expect(filteredItems.value.length).toBeGreaterThan(0)
    expect(filteredItems.value[0].key).toBe('audio-helper:quick-mute')
    expect(filteredItems.value[0].mode).toBe('no-view')
    expect(filteredItems.value[0].actionLabel).toBe('执行')

    // 输入 cmds 触发词 "耳机"：精准召回 switch-output 子命令
    search('耳机')
    expect(filteredItems.value.some((i) => i.key === 'audio-helper:switch-output')).toBe(true)

    // 记录子命令使用后，即使清空查询词也会在首屏常用流中展示
    recordUsage('audio-helper:quick-mute')
    search('')
    expect(filteredItems.value.some((i) => i.key === 'audio-helper:quick-mute')).toBe(true)
  })

  it('6. [破坏性异常与安全边界] 拦截已下架/已禁用插件，防御畸形 features / cmds 数据', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.revokedMap = {
      'malicious-plugin': { revoked: true, reason: '存在恶意代码' }
    }
    pluginsStore.installedPlugins = [
      null,
      undefined,
      { pluginId: '' },
      {
        pluginId: 'malicious-plugin',
        name: '恶意插件',
        enabled: true
      },
      {
        pluginId: 'disabled-plugin',
        name: '已禁用插件',
        enabled: false
      },
      {
        pluginId: 'dirty-manifest-plugin',
        name: '脏数据容错插件',
        entry: 'dist/index.mjs',
        mode: 'invalid-mode-xyz',
        features: [
          null,
          { code: '', explain: '缺失 code' },
          { code: 'missing-explain', explain: '' },
          { code: 'dup-code', explain: '第一个有效子命令', mode: 'unknown-mode', cmds: [null, 123, { label: '合法触发词' }] },
          { code: 'dup-code', explain: '重复 code 必须被去重丢弃' }
        ]
      },
      {
        // 旧清单里的 menu-bar 模式已不再支持，必须降级为 view
        pluginId: 'legacy-menu-bar-plugin',
        name: '旧菜单栏插件',
        entry: 'dist/index.mjs',
        mode: 'menu-bar',
        features: [{ code: 'tray-cmd', explain: '旧菜单栏子命令', mode: 'menu-bar' }]
      }
    ]

    const { filteredItems, search } = useCommandSearch({ enableFileSearch: false })

    // 已下架和已禁用插件绝不出现在候选列表中
    expect(filteredItems.value.some((i) => i.pluginId === 'malicious-plugin')).toBe(false)
    expect(filteredItems.value.some((i) => i.pluginId === 'disabled-plugin')).toBe(false)

    // 脏数据插件本身被规范化降级为 view 模式，且去重后仅保留 1 个有效子命令
    const validPlugin = filteredItems.value.find((i) => i.pluginId === 'dirty-manifest-plugin')
    expect(validPlugin).toBeDefined()
    expect(validPlugin.mode).toBe('view')
    expect(validPlugin.features).toHaveLength(1)
    expect(validPlugin.features[0].code).toBe('dup-code')
    expect(validPlugin.features[0].mode).toBe('view')

    const legacyPlugin = filteredItems.value.find((i) => i.pluginId === 'legacy-menu-bar-plugin')
    expect(legacyPlugin).toBeDefined()
    expect(legacyPlugin.mode).toBe('view')
    expect(legacyPlugin.features[0].mode).toBe('view')

    // 搜索对象型 cmd 的 label 能够正常命中
    search('合法触发词')
    expect(filteredItems.value.some((i) => i.key === 'dirty-manifest-plugin:dup-code')).toBe(true)
  })

  it('7. [内置插件多维意图检索与合并去重召回集成测试] 搜索合并后关键词精准命中对应插件子命令 (features)', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const { getBundledPluginEntries } = await import('@/utils/bundledPlugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = getBundledPluginEntries()

    const { filteredItems, search } = useCommandSearch({ enableFileSearch: false })

    // 1. 首屏空查询时不把数十个子命令展开刷屏，只展示 15 款主插件 + 内置命令
    search('')
    expect(filteredItems.value.some((i) => i.type === 'plugin-feature')).toBe(false)

    // 2. 搜索「单位换算」命中 calculator 的 calc-unit 子命令
    search('单位换算')
    expect(filteredItems.value.some((i) => i.key === 'calculator:calc-unit')).toBe(true)

    // 3. 搜索「人民币大写」命中 calculator 的 calc-rmb 子命令
    search('人民币大写')
    expect(filteredItems.value.some((i) => i.key === 'calculator:calc-rmb')).toBe(true)

    // 4. 搜索原独立插件「世界时钟」命中 timestamp 的 tz-world 子命令
    search('世界时钟')
    expect(filteredItems.value.some((i) => i.key === 'timestamp:tz-world')).toBe(true)

    // 5. 搜索「对比度」命中 color-picker 的 contrast-check 子命令
    search('对比度')
    expect(filteredItems.value.some((i) => i.key === 'color-picker:contrast-check')).toBe(true)

    // 6. 搜索原独立插件「base64解码」命中 crypto-tool 的 codec-base64 子命令
    search('base64解码')
    expect(filteredItems.value.some((i) => i.key === 'crypto-tool:codec-base64')).toBe(true)

    // 7. 搜索「json转ts」命中 json-format 的 json-codegen 子命令
    search('json转ts')
    expect(filteredItems.value.some((i) => i.key === 'json-format:json-codegen')).toBe(true)

    // 8. 搜索原独立插件「大写金额」与「世界时钟」命中合并后的 calculator 与 timestamp 子命令
    search('大写金额')
    expect(filteredItems.value.some((i) => i.key === 'calculator:calc-rmb')).toBe(true)

    search('世界时钟')
    expect(filteredItems.value.some((i) => i.key === 'timestamp:tz-world')).toBe(true)
  })

  it('8. [悬浮条首屏数据与旧版残留容错] 合并固定插件与系统工具，安全忽略旧版 type: local 残留项，且不再暴露 addLocalApp', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = [
      {
        pluginId: 'json-format',
        name: 'JSON 格式化',
        description: '格式化与校验 JSON',
        entry: 'dist/index.js',
        isDeclarative: true
      }
    ]

    const togglePinMock = vi.fn().mockResolvedValue({ success: true })
    const getPanelDataMock = vi.fn().mockResolvedValue({
      success: true,
      data: {
        items: [
          { id: 'json-format', name: 'JSON 格式化', type: 'plugin', pinned: true, recent: true },
          {
            id: 'local_vscode',
            name: 'Visual Studio Code',
            description: 'D:/Microsoft VS Code/Code.exe',
            iconUrl: 'data:image/png;base64,AAAA',
            type: 'local',
            pinned: true,
            recent: false
          },
          {
            id: 'sys_control_panel',
            name: '控制面板',
            description: '打开 Windows 控制面板',
            type: 'system_tool',
            pinned: true,
            keywords: ['control', 'kzmb']
          }
        ]
      }
    })

    window.__ztoolsLauncher = {
      getPanelData: getPanelDataMock,
      togglePin: togglePinMock
    }

    try {
      const state = useCommandSearch({ enableFileSearch: false })
      const {
        filteredItems,
        pinnedItems,
        search,
        refreshPanelData,
        toggleItemPin
      } = state

      expect(state.addLocalApp).toBeUndefined()

      await refreshPanelData({ force: true })

      // 1. 首屏固定项包含已固定插件与已固定系统工具，旧版残留 type: 'local' 被安全忽略不崩溃
      expect(pinnedItems.value.map((i) => i.pinKey)).toEqual(['plugin:json-format', 'system-tool:sys_control_panel'])
      expect(filteredItems.value.some((i) => i.type === 'local-app' || i.id === 'local_vscode')).toBe(false)

      // 2. 搜索系统工具关键词可召回系统工具条目
      search('控制面板')
      expect(filteredItems.value.some((i) => i.id === 'sys_control_panel' && i.type === 'system-tool')).toBe(true)

      // 3. 快捷方式前缀功能已删除：输入 /js 不会产生带 shortcutPrefix 的置顶项
      search('/js')
      expect(filteredItems.value.some((i) => i.shortcutPrefix)).toBe(false)

      // 4. 切换固定状态桥接调用
      const pinRes = await toggleItemPin(pinnedItems.value[0])
      expect(pinRes.success).toBe(true)
      expect(togglePinMock).toHaveBeenCalledWith('json-format', 'plugin')
    } finally {
      delete window.__ztoolsLauncher
    }
  })

  it('9. [全局 7 级分类权重验证] 严格遵循 系统工具(1) > 已安装软件(2) > 插件(3) > 子命令(4) > 本地文件夹(5) > 本地文件(6) > 宿主内置指令(7)', async () => {
    // 1. 静态等级与权重分映射验证（确认已移除 USER_LOCAL_APP）
    expect(CATEGORY_RANKS).toEqual({
      SYSTEM_TOOL: 1,
      INSTALLED_APP: 2,
      PLUGIN: 3,
      PLUGIN_FEATURE: 4,
      FILE_DIRECTORY: 5,
      FILE_REGULAR: 6,
      HOST_BUILTIN: 7
    })
    expect(CATEGORY_WEIGHTS).toEqual({
      1: 70,
      2: 60,
      3: 35,
      4: 20,
      5: 10,
      6: 5,
      7: 0
    })
    expect(CATEGORY_RANKS.USER_LOCAL_APP).toBeUndefined()

    expect(getCategoryRank({ type: 'system-tool' })).toBe(CATEGORY_RANKS.SYSTEM_TOOL)
    expect(getCategoryRank({ type: 'file', isApplication: true })).toBe(CATEGORY_RANKS.INSTALLED_APP)
    expect(getCategoryRank({ type: 'plugin' })).toBe(CATEGORY_RANKS.PLUGIN)
    expect(getCategoryRank({ type: 'plugin-feature' })).toBe(CATEGORY_RANKS.PLUGIN_FEATURE)
    expect(getCategoryRank({ type: 'file', isDir: true })).toBe(CATEGORY_RANKS.FILE_DIRECTORY)
    expect(getCategoryRank({ type: 'file', isDir: false })).toBe(CATEGORY_RANKS.FILE_REGULAR)
    expect(getCategoryRank({ key: 'system-settings' })).toBe(CATEGORY_RANKS.HOST_BUILTIN)

    expect(getCategoryWeight({ type: 'system-tool' })).toBeGreaterThan(getCategoryWeight({ type: 'file', isApplication: true }))
    expect(getCategoryWeight({ type: 'file', isApplication: true })).toBeGreaterThan(getCategoryWeight({ type: 'plugin' }))
    expect(getCategoryWeight({ type: 'plugin' })).toBeGreaterThan(getCategoryWeight({ type: 'plugin-feature' }))
    expect(getCategoryWeight({ type: 'plugin-feature' })).toBeGreaterThan(getCategoryWeight({ type: 'file', isDir: true }))
    expect(getCategoryWeight({ type: 'file', isDir: true })).toBeGreaterThan(getCategoryWeight({ type: 'file', isDir: false }))
    expect(getCategoryWeight({ type: 'file', isDir: false })).toBeGreaterThan(getCategoryWeight({ key: 'system-settings' }))

    // 2. 端到端混排验证：构造同前缀命中的 系统工具、已安装软件、插件、子命令、宿主内置指令、本地文件夹、本地普通文件（含旧 local 残留干扰项）
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = [
      {
        pluginId: 'sys-plugin',
        name: '系统中心插件',
        entry: 'dist/index.js',
        isDeclarative: true,
        features: [
          { code: 'main', explain: '系统中心插件' },
          { code: 'sub-sys', explain: '系统子功能环境变量与高阶配置管理中心' }
        ]
      }
    ]

    window.__ztoolsLauncher = {
      searchFiles: vi.fn(async (_q, _limit, opts) => {
        if (opts?.scope === 'applications') {
          return {
            scope: 'applications',
            files: [{ name: 'SystemApp.app', display_name: '系统安装软件', path: '/Applications/SystemApp.app', kind: 'application', is_dir: true, size: 0, mtime: 1 }]
          }
        }
        return {
          scope: 'files',
          files: [
            { name: '系统文档.txt', path: '/Users/demo/系统文档.txt', is_dir: false, size: 10, mtime: 5 },
            { name: '系统目录', path: '/Users/demo/系统目录', is_dir: true, size: 0, mtime: 5 }
          ]
        }
      }),
      getPanelData: vi.fn().mockResolvedValue({
        success: true,
        data: {
          items: [
            { id: 'user_sys_app', name: '系统自选软件', type: 'local', pinned: false, recent: false },
            { id: 'native_sys_tool', name: '系统控制工具', type: 'system_tool', keywords: [] }
          ]
        }
      })
    }

    try {
      const { filteredItems, matchedPlugins, search, refreshApplications, refreshPanelData } = useCommandSearch({ enableFileSearch: true })
      await refreshApplications({ force: true })
      await refreshPanelData({ force: true })

      search('系统')
      await new Promise((r) => setTimeout(r, 120))

      const orderedNames = filteredItems.value.map((i) => i.name)
      // 上段：系统工具(1) -> 已安装软件(2) -> 插件(3) -> 超长名称子命令(4) -> 宿主内置指令(7)；下段：本地文件夹(5) -> 本地普通文件(6)
      expect(orderedNames).toEqual([
        '系统控制工具',
        '系统安装软件',
        '系统中心插件',
        '系统子功能环境变量与高阶配置管理中心',
        '系统设置',
        '系统目录',
        '系统文档.txt'
      ])
      // matchedPlugins 不含已安装软件与文件
      expect(matchedPlugins.value.map((i) => i.name)).toEqual([
        '系统控制工具',
        '系统中心插件',
        '系统子功能环境变量与高阶配置管理中心',
        '系统设置'
      ])
    } finally {
      delete window.__ztoolsLauncher
    }
  })

  it('10. [空查询排序与搜索词抗噪记忆] 空查询展示用过的 2B 软件且固定宫格项后置；搜索词 3 次以上稳固首选防单次误触', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = [
      { pluginId: 'pinned-plugin', name: '已固定插件', entry: 'dist/index.js', isDeclarative: true },
      { pluginId: 'normal-plugin', name: '未固定插件', entry: 'dist/index.js', isDeclarative: true }
    ]

    window.__ztoolsLauncher = {
      searchFiles: vi.fn(async (_q, _limit, opts) => {
        if (opts?.scope === 'applications') {
          return {
            scope: 'applications',
            files: [{ name: 'WeChat.app', display_name: '微信', path: '/Applications/WeChat.app', kind: 'application', is_dir: true, size: 0, mtime: 1 }]
          }
        }
        return { files: [] }
      }),
      getPanelData: vi.fn().mockResolvedValue({
        success: true,
        data: {
          items: [
            { id: 'pinned-plugin', name: '已固定插件', type: 'plugin', pinned: true, recent: true },
            { id: 'sys_tool_1', name: '任务管理器', type: 'system_tool', keywords: [] }
          ]
        }
      })
    }

    try {
      const { filteredItems, search, recordUsage, refreshApplications, refreshPanelData } = useCommandSearch({ enableFileSearch: true })
      await refreshApplications({ force: true })
      await refreshPanelData({ force: true })

      // 1. 记录使用过本机应用 微信 (file:/Applications/WeChat.app)
      recordUsage('file:/Applications/WeChat.app')
      search('')

      // 空查询第 1 名应当是刚刚使用过的本机应用「微信」，而已在顶部固定宫格展示的「已固定插件」在列表中沉底
      expect(filteredItems.value[0]?.name).toBe('微信')
      expect(filteredItems.value.at(-1)?.pluginId).toBe('pinned-plugin')

      // 2. 搜索词抗单次误触：对同一词 "sys" 连续选 3 次 A，偶发误触 1 次 B 时仍保持 A 为首选；再点第 2 次 B 则完成迁移
      recordQueryChoice('sys', 'item-a')
      recordQueryChoice('sys', 'item-a')
      recordQueryChoice('sys', 'item-a')
      recordQueryChoice('sys', 'item-b')
      const choicesAfterOneClick = JSON.parse(localStorage.getItem('ztools_command_query_choices'))
      expect(choicesAfterOneClick.sys.key).toBe('item-a')

      recordQueryChoice('sys', 'item-b')
      const choicesAfterTwoClicks = JSON.parse(localStorage.getItem('ztools_command_query_choices'))
      expect(choicesAfterTwoClicks.sys.key).toBe('item-b')
    } finally {
      delete window.__ztoolsLauncher
    }
  })

  it('12. [内置系统设置指令] 悬浮条窗口执行「系统设置」一次性委托主窗口直达 /advanced-settings', async () => {
    const expandToDashboard = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsWindowMode = 'launcher'
    window.__ztoolsLauncher = { expandToDashboard }
    try {
      const { filteredItems, search } = useCommandSearch({ enableFileSearch: false })
      search('系统设置')
      const settingsCmd = filteredItems.value.find((item) => item.key === 'system-settings')
      expect(settingsCmd).toBeDefined()

      const res = await settingsCmd.action()
      expect(expandToDashboard).toHaveBeenCalledTimes(1)
      expect(expandToDashboard).toHaveBeenCalledWith('/advanced-settings')
      expect(res).toEqual(expect.objectContaining({ success: true, type: 'route' }))
    } finally {
      delete window.__ztoolsWindowMode
      delete window.__ztoolsLauncher
    }
  })

  it('13. [全类型 PinnedEntry 构建、pinKey 规则与不可固定排除] 覆盖 5 类条目、绿色 .exe/开始菜单应用及旧 local-app 安全排除', () => {
    expect(PINNED_GRID_COLUMNS).toBe(9)

    // 不可固定项与历史残留 local-app 排除
    expect(canPinItem(null)).toBe(false)
    expect(canPinItem({ type: 'inline-calculator', ephemeral: true, key: 'inline-calc:math:1+1' })).toBe(false)
    expect(canPinItem({ type: 'inline-color', ephemeral: true, key: 'inline-calc:color:#fff' })).toBe(false)
    expect(canPinItem({ ephemeral: true, type: 'custom', key: 'temp' })).toBe(false)
    expect(canPinItem({ type: 'market-search', key: 'market-search' })).toBe(false)
    expect(buildPinPayload({ type: 'inline-calculator', ephemeral: true })).toBeNull()

    const legacyLocalApp = { key: 'local-app:App_One', id: 'App_One', type: 'local-app' }
    expect(canPinItem(legacyLocalApp)).toBe(false)
    expect(buildPinPayload(legacyLocalApp)).toBeNull()
    expect(buildPinPayload({ kind: 'local-app', appId: 'App_One' })).toBeNull()
    expect(buildPinPayload({ id: 'App_One', panelItemType: 'local' })).toBeNull()
    expect(resolvePinKey(legacyLocalApp)).toBe('')
    expect(resolvePinKey({ kind: 'local-app', appId: 'App_One' })).toBe('')

    // 5 类可固定项构建与 pinKey
    const pluginItem = { type: 'plugin', pluginId: 'json-format', name: 'JSON 格式化' }
    expect(buildPinPayload(pluginItem)).toEqual({ kind: 'plugin', pluginId: 'json-format' })
    expect(resolvePinKey(pluginItem)).toBe('plugin:json-format')

    const featureItem = { type: 'plugin-feature', pluginId: 'json-format', featureCode: 'json-codegen' }
    expect(buildPinPayload(featureItem)).toEqual({
      kind: 'plugin-feature',
      pluginId: 'json-format',
      featureCode: 'json-codegen'
    })
    expect(resolvePinKey(featureItem)).toBe('plugin-feature:json-format:json-codegen')

    const builtinItem = { key: 'system-settings', name: '系统设置' }
    expect(buildPinPayload(builtinItem)).toEqual({ kind: 'builtin', commandKey: 'system-settings' })
    expect(resolvePinKey(builtinItem)).toBe('builtin:system-settings')

    // 同 key 插件与宿主内置指令严格区分
    const sameKeyPlugin = { key: 'system-settings', type: 'plugin', pluginId: 'system-settings' }
    expect(resolvePinKey(sameKeyPlugin)).toBe('plugin:system-settings')

    const sysTool = { key: 'system-tool:taskmgr', id: 'system-tool:taskmgr', type: 'system-tool', target: 'taskmgr' }
    expect(buildPinPayload(sysTool)).toEqual({ kind: 'system-tool', toolId: 'taskmgr' })
    expect(resolvePinKey(sysTool)).toBe('system-tool:taskmgr')

    // 绿色 .exe 普通文件与开始菜单应用均走 kind: 'file'
    const portableExe = { type: 'file', path: 'D:\\Portable\\Everything.exe', name: 'Everything.exe', isDir: false, isApplication: false }
    expect(buildPinPayload(portableExe)).toEqual({
      kind: 'file',
      path: 'D:\\Portable\\Everything.exe',
      name: 'Everything.exe',
      isDir: false,
      isApplication: false
    })
    expect(resolvePinKey(portableExe)).toBe('file:d:\\portable\\everything.exe')

    const startMenuApp = { type: 'file', path: 'C:\\ProgramData\\Start Menu\\WeChat.lnk', name: '微信', isDir: false, isApplication: true }
    expect(buildPinPayload(startMenuApp)).toEqual({
      kind: 'file',
      path: 'C:\\ProgramData\\Start Menu\\WeChat.lnk',
      name: '微信',
      isDir: false,
      isApplication: true
    })
    expect(resolvePinKey(startMenuApp)).toBe('file:c:\\programdata\\start menu\\wechat.lnk')

    const winFile = { type: 'file', path: 'C:\\Users\\Demo\\Docs\\', name: 'Docs', isDir: true, isApplication: false }
    expect(buildPinPayload(winFile)).toEqual({
      kind: 'file',
      path: 'C:\\Users\\Demo\\Docs\\',
      name: 'Docs',
      isDir: true,
      isApplication: false
    })
    expect(resolvePinKey(winFile)).toBe('file:c:\\users\\demo\\docs')
    expect(resolvePinKey({ type: 'file', path: 'C:/Users/Demo/Docs/' })).toBe('file:c:\\users\\demo\\docs')
    expect(resolvePinKey({ type: 'file', path: 'C:\\' })).toBe('file:c:\\')
    expect(resolvePinKey({ type: 'file', path: '/Users/Demo/App/' })).toBe('file:/Users/Demo/App')
    expect(resolvePinKey({ type: 'file', path: '/' })).toBe('file:/')
  })

  it('14. [全类型固定还原、旧 local-app 安全忽略、绿色 .exe 与开始菜单应用检索/固定、setPin/reorderPins/跨窗同步]', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.hiddenBundledSet = new Set(['hidden-bundled'])
    pluginsStore.revokedMap = { 'revoked-plugin': { revoked: true, reason: '官方下架' } }
    pluginsStore.installedPlugins = [
      {
        pluginId: 'json-format',
        name: 'JSON 格式化',
        entry: 'dist/index.js',
        isDeclarative: true,
        features: [
          { code: 'json-format', explain: 'JSON 格式化' },
          { code: 'json-codegen', explain: 'JSON 生成类型' }
        ]
      },
      { pluginId: 'other-plugin', name: '其他插件', entry: 'dist/index.js', isDeclarative: true },
      { pluginId: 'disabled-plugin', name: '已禁用插件', enabled: false, entry: 'dist/index.js' },
      {
        pluginId: 'mac-only-plugin',
        name: '仅 Mac 插件',
        entry: 'dist/index.js',
        targets: [{ runtime: 'electron', platform: 'macos' }]
      },
      { pluginId: 'revoked-plugin', name: '已下架插件', entry: 'dist/index.js', enabled: true }
    ]

    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'win32'
    const getFileIconMock = vi.fn().mockResolvedValue('data:image/png;base64,RkFMTEJBQ0s=')
    const reportSpy = vi.fn()
    const eventHandlers = new Map()
    const subscribeMock = vi.fn().mockResolvedValue({ success: true })
    const onMock = vi.fn((evt, fn) => {
      eventHandlers.set(evt, fn)
    })
    const offMock = vi.fn((evt) => {
      eventHandlers.delete(evt)
    })

    const initialPinnedEntries = [
      { pinKey: 'plugin-feature:json-format:json-codegen', entry: { kind: 'plugin-feature', pluginId: 'json-format', featureCode: 'json-codegen' }, available: true },
      { pinKey: 'builtin:system-settings', entry: { kind: 'builtin', commandKey: 'system-settings' }, available: true },
      { pinKey: 'plugin:hidden-bundled', entry: { kind: 'plugin', pluginId: 'hidden-bundled' }, available: true },
      { pinKey: 'plugin:revoked-plugin', entry: { kind: 'plugin', pluginId: 'revoked-plugin' }, available: true },
      { pinKey: 'plugin:disabled-plugin', entry: { kind: 'plugin', pluginId: 'disabled-plugin' }, available: true },
      { pinKey: 'plugin:mac-only-plugin', entry: { kind: 'plugin', pluginId: 'mac-only-plugin' }, available: true },
      { pinKey: 'plugin:uninstalled-plugin', entry: { kind: 'plugin', pluginId: 'uninstalled-plugin' }, available: true },
      { pinKey: 'plugin-feature:json-format:missing-feat', entry: { kind: 'plugin-feature', pluginId: 'json-format', featureCode: 'missing-feat' }, available: true },
      { pinKey: 'builtin:removed-builtin', entry: { kind: 'builtin', commandKey: 'removed-builtin' }, available: true },
      { pinKey: 'system-tool:taskmgr', entry: { kind: 'system-tool', toolId: 'taskmgr' }, available: true },
      { pinKey: 'system-tool:missing-tool', entry: { kind: 'system-tool', toolId: 'missing-tool' }, available: true },
      // 模拟旧缓存残留的 local-app 条目，必须被安全忽略且不影响其余 5 类固定项
      { pinKey: 'local-app:app_1', entry: { kind: 'local-app', appId: 'app_1' }, available: true },
      { pinKey: 'local-app:missing_app', entry: { kind: 'local-app', appId: 'missing_app' }, available: true },
      { pinKey: 'file:c:\\apps\\wechat.exe', entry: { kind: 'file', path: 'C:\\Apps\\WeChat.exe', name: '微信', isDir: false, isApplication: true }, available: true },
      { pinKey: 'file:c:\\docs\\missing.txt', entry: { kind: 'file', path: 'C:\\Docs\\missing.txt', name: 'missing.txt', isDir: false, isApplication: false }, available: false }
    ]

    let currentServerPins = initialPinnedEntries.filter((x) => x.entry.kind !== 'local-app')
    const setPinMock = vi.fn(async (entry, pinned) => {
      const pk = resolvePinKey(entry)
      currentServerPins = pinned
        ? [...currentServerPins.filter((x) => x.pinKey !== pk), { pinKey: pk, entry, available: true }]
        : currentServerPins.filter((x) => x.pinKey !== pk)
      return { success: true, pinned, pinKey: pk, pinnedEntries: currentServerPins }
    })
    const reorderPinsMock = vi.fn(async () => ({
      success: false,
      stale: true,
      error: '列表已变化',
      pinnedEntries: [initialPinnedEntries[1], initialPinnedEntries[0]]
    }))

    window.ztools = {
      sys: { getFileIcon: getFileIconMock },
      analytics: { report: reportSpy },
      events: { subscribe: subscribeMock, on: onMock, off: offMock }
    }
    window.__ztoolsLauncher = {
      searchFiles: vi.fn(async (_q, _l, opts) => {
        if (opts?.scope === 'applications') {
          return {
            scope: 'applications',
            files: [{ name: 'Notion.lnk', display_name: 'Notion', path: 'C:\\ProgramData\\Start Menu\\Notion.lnk', kind: 'application', is_dir: false, size: 0, mtime: 1 }]
          }
        }
        return {
          scope: 'files',
          files: [
            { name: 'notes.txt', path: 'C:\\Docs\\notes.txt', is_dir: false, size: 1, mtime: 1 },
            { name: 'portable-tool.exe', path: 'D:\\Tools\\portable-tool.exe', is_dir: false, size: 2048, mtime: 2 }
          ]
        }
      }),
      getPanelData: vi.fn().mockResolvedValue({
        success: true,
        data: {
          items: [
            { id: 'system-tool:taskmgr', target: 'taskmgr', name: '任务管理器', type: 'system_tool', keywords: [] },
            { id: 'app_1', name: '记事本', type: 'local', description: 'C:\\Windows\\notepad.exe' }
          ],
          pinnedEntries: initialPinnedEntries
        }
      }),
      setPin: setPinMock,
      reorderPins: reorderPinsMock
    }

    const scope = effectScope()
    try {
      const state = scope.run(() => useCommandSearch({ enableFileSearch: true }))
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 20))

      expect(subscribeMock).toHaveBeenCalledWith('super_panel_changed')
      expect(onMock).toHaveBeenCalledWith('super_panel_changed', expect.any(Function))

      // 1. 隐藏/下架/禁用/平台不支持的插件不在 pinnedItems 展示，但底层 pinnedEntries 原位保留；残留 local-app 直接忽略
      const pinKeys = state.pinnedItems.value.map((i) => i.pinKey)
      expect(pinKeys).not.toContain('plugin:hidden-bundled')
      expect(pinKeys).not.toContain('plugin:revoked-plugin')
      expect(pinKeys).not.toContain('plugin:disabled-plugin')
      expect(pinKeys).not.toContain('plugin:mac-only-plugin')
      expect(pinKeys).not.toContain('local-app:app_1')
      expect(pinKeys).not.toContain('local-app:missing_app')
      expect(state.pinnedEntries.value).toHaveLength(initialPinnedEntries.length - 2)
      expect(state.pinnedEntries.value.some((r) => r.entry.kind === 'local-app')).toBe(false)

      // 2. 保持原搜索条目 key，不分裂；且失效项保留在固定区中标 available: false
      const featurePin = state.pinnedItems.value.find((i) => i.pinKey === 'plugin-feature:json-format:json-codegen')
      expect(featurePin?.key).toBe('json-format:json-codegen')
      expect(featurePin?.available).toBe(true)

      const builtinPin = state.pinnedItems.value.find((i) => i.pinKey === 'builtin:system-settings')
      expect(builtinPin?.key).toBe('system-settings')
      expect(builtinPin?.available).toBe(true)

      const fileAppPin = state.pinnedItems.value.find((i) => i.pinKey === 'file:c:\\apps\\wechat.exe')
      expect(fileAppPin?.key).toBe('file:C:\\Apps\\WeChat.exe')
      expect(fileAppPin?.icon).toBe('data:image/png;base64,RkFMTEJBQ0s=')
      expect(getFileIconMock).toHaveBeenCalledWith('C:\\Apps\\WeChat.exe')

      const missingFilePin = state.pinnedItems.value.find((i) => i.pinKey === 'file:c:\\docs\\missing.txt')
      expect(missingFilePin?.available).toBe(false)
      expect(missingFilePin?.unavailableReason).toContain('missing.txt')
      expect(getFileIconMock).not.toHaveBeenCalledWith('C:\\Docs\\missing.txt')

      expect(state.pinnedItems.value.find((i) => i.pinKey === 'plugin:uninstalled-plugin')?.available).toBe(false)
      expect(state.pinnedItems.value.find((i) => i.pinKey === 'plugin-feature:json-format:missing-feat')?.available).toBe(false)
      expect(state.pinnedItems.value.find((i) => i.pinKey === 'builtin:removed-builtin')?.available).toBe(false)
      expect(state.pinnedItems.value.find((i) => i.pinKey === 'system-tool:missing-tool')?.available).toBe(false)

      // 3. 独立染色不串台：固定了内置 system-settings 与 json-codegen，同名插件和 json-format 主入口均不染 pinned
      state.search('json')
      const jsonMain = state.filteredItems.value.find((i) => i.key === 'json-format')
      const jsonFeat = state.filteredItems.value.find((i) => i.key === 'json-format:json-codegen')
      expect(jsonMain?.pinned).toBe(false)
      expect(jsonFeat?.pinned).toBe(true)

      state.search('系统设置')
      const hostBuiltin = state.filteredItems.value.find((i) => i.key === 'system-settings' && !i.type)
      expect(hostBuiltin?.pinned).toBe(true)

      // 4. 绿色 .exe 普通文件与开始菜单应用均可检索并按 kind: 'file' 固定/取消固定
      state.search('portable')
      await new Promise((r) => setTimeout(r, 110))
      const portableHit = state.filteredItems.value.find((i) => i.path === 'D:\\Tools\\portable-tool.exe')
      expect(portableHit).toMatchObject({ type: 'file', isApplication: false, isDir: false, pinned: false })

      const pinPortableRes = await state.setItemPinned(portableHit, true)
      expect(pinPortableRes).toMatchObject({ success: true, pinned: true, pinKey: 'file:d:\\tools\\portable-tool.exe' })
      expect(setPinMock).toHaveBeenCalledWith(
        { kind: 'file', path: 'D:\\Tools\\portable-tool.exe', name: 'portable-tool.exe', isDir: false, isApplication: false },
        true
      )
      expect(state.pinnedItems.value.some((i) => i.pinKey === 'file:d:\\tools\\portable-tool.exe')).toBe(true)

      const unpinPortableRes = await state.setItemPinned(portableHit, false)
      expect(unpinPortableRes).toMatchObject({ success: true, pinned: false })
      expect(state.pinnedItems.value.some((i) => i.pinKey === 'file:d:\\tools\\portable-tool.exe')).toBe(false)

      state.search('Notion')
      const startMenuHit = state.filteredItems.value.find((i) => i.path === 'C:\\ProgramData\\Start Menu\\Notion.lnk')
      expect(startMenuHit).toMatchObject({ type: 'file', isApplication: true, pinned: false })
      const pinAppRes = await state.setItemPinned(startMenuHit, true)
      expect(pinAppRes).toMatchObject({ success: true, pinned: true, pinKey: 'file:c:\\programdata\\start menu\\notion.lnk' })
      expect(setPinMock).toHaveBeenCalledWith(
        { kind: 'file', path: 'C:\\ProgramData\\Start Menu\\Notion.lnk', name: 'Notion', isDir: false, isApplication: true },
        true
      )
      if (edition.EDITION === 'commercial') {
        expect(reportSpy).toHaveBeenCalledWith('launcher_pin', '', { kind: 'file', action: 'pin' })
      }

      // setPin 失败时回滚本地
      setPinMock.mockResolvedValueOnce({ success: false, error: '写入失败' })
      const otherPlugin = { key: 'other-plugin', type: 'plugin', pluginId: 'other-plugin', name: '其他插件' }
      const failRes = await state.setItemPinned(otherPlugin, true)
      expect(failRes).toEqual({ success: false, error: '写入失败' })
      expect(state.pinnedItems.value.some((i) => i.pinKey === 'plugin:other-plugin')).toBe(false)

      // 5. reorderPinned 遇到 stale 时以主进程返回的 pinnedEntries 回滚同步
      const reorderRes = await state.reorderPinned(['builtin:system-settings', 'plugin-feature:json-format:json-codegen'])
      expect(reorderRes.success).toBe(false)
      expect(reorderRes.stale).toBe(true)
      expect(state.pinnedEntries.value.map((r) => r.pinKey)).toEqual([
        'builtin:system-settings',
        'plugin-feature:json-format:json-codegen'
      ])

      // 6. 跨窗广播 super_panel_changed 实时刷新
      eventHandlers.get('super_panel_changed')({
        payload: {
          pinnedEntries: [
            { pinKey: 'builtin:system-dashboard', entry: { kind: 'builtin', commandKey: 'system-dashboard' }, available: true }
          ]
        }
      })
      expect(state.pinnedItems.value.map((i) => i.pinKey)).toEqual(['builtin:system-dashboard'])

      // 7. 销毁作用域成对注销事件监听
      scope.stop()
      expect(offMock).toHaveBeenCalledWith('super_panel_changed', expect.any(Function))
    } finally {
      scope.stop()
      delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
      delete window.ztools
      delete window.__ztoolsLauncher
    }
  })
})
