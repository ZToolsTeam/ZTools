import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useCommandSearch,
  calculateFrecencyBonus,
  CATEGORY_RANKS,
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

  it('8. [悬浮条首屏数据] 合并固定插件、已添加本地软件与系统工具；/前缀 不再召回快捷方式', async () => {
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
    const addLocalAppMock = vi.fn().mockResolvedValue({ success: true, added: 1 })
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
            keywords: ['control', 'kzmb']
          }
        ]
      }
    })

    window.__ztoolsLauncher = {
      getPanelData: getPanelDataMock,
      togglePin: togglePinMock,
      addLocalApp: addLocalAppMock
    }

    try {
      const {
        filteredItems,
        pinnedItems,
        search,
        refreshPanelData,
        toggleItemPin,
        addLocalApp
      } = useCommandSearch({ enableFileSearch: false })

      await refreshPanelData({ force: true })

      // 1. 首屏固定项包含已固定插件与已固定本地软件
      expect(pinnedItems.value.map((i) => i.id || i.pluginId)).toEqual(['json-format', 'local_vscode'])

      // 2. 搜索系统工具关键词可召回系统工具条目
      search('控制面板')
      expect(filteredItems.value.some((i) => i.id === 'sys_control_panel' && i.type === 'system-tool')).toBe(true)

      // 3. 快捷方式前缀功能已删除：输入 /js 不会产生带 shortcutPrefix 的置顶项
      search('/js')
      expect(filteredItems.value.some((i) => i.shortcutPrefix)).toBe(false)

      // 4. 切换固定状态与添加本地软件桥接调用
      const pinRes = await toggleItemPin(pinnedItems.value[0])
      expect(pinRes.success).toBe(true)
      expect(togglePinMock).toHaveBeenCalledWith('json-format', 'plugin')

      const addRes = await addLocalApp()
      expect(addRes).toEqual({ success: true, added: 1 })
      expect(addLocalAppMock).toHaveBeenCalledOnce()
    } finally {
      delete window.__ztoolsLauncher
    }
  })

  it('9. [全局 8 级分类权重验证] 同等匹配度且无历史记录时，严格遵循 1B > 1A > 2B > 2A > 3A > 3B > 4A > 4B', async () => {
    // 1. 静态等级与权重分映射验证
    expect(getCategoryRank({ key: 'system-settings' })).toBe(CATEGORY_RANKS.HOST_BUILTIN)
    expect(getCategoryRank({ type: 'system-tool' })).toBe(CATEGORY_RANKS.SYSTEM_TOOL)
    expect(getCategoryRank({ type: 'file', isApplication: true })).toBe(CATEGORY_RANKS.INSTALLED_APP)
    expect(getCategoryRank({ type: 'local-app', isApplication: true })).toBe(CATEGORY_RANKS.USER_LOCAL_APP)
    expect(getCategoryRank({ type: 'plugin' })).toBe(CATEGORY_RANKS.PLUGIN)
    expect(getCategoryRank({ type: 'plugin-feature' })).toBe(CATEGORY_RANKS.PLUGIN_FEATURE)
    expect(getCategoryRank({ type: 'file', isDir: true })).toBe(CATEGORY_RANKS.FILE_DIRECTORY)
    expect(getCategoryRank({ type: 'file', isDir: false })).toBe(CATEGORY_RANKS.FILE_REGULAR)

    expect(getCategoryWeight({ key: 'system-settings' })).toBeGreaterThan(getCategoryWeight({ type: 'system-tool' }))
    expect(getCategoryWeight({ type: 'system-tool' })).toBeGreaterThan(getCategoryWeight({ type: 'file', isApplication: true }))
    expect(getCategoryWeight({ type: 'file', isApplication: true })).toBeGreaterThan(getCategoryWeight({ type: 'local-app', isApplication: true }))
    expect(getCategoryWeight({ type: 'local-app', isApplication: true })).toBeGreaterThan(getCategoryWeight({ type: 'plugin' }))
    expect(getCategoryWeight({ type: 'plugin' })).toBeGreaterThan(getCategoryWeight({ type: 'plugin-feature' }))
    expect(getCategoryWeight({ type: 'plugin-feature' })).toBeGreaterThan(getCategoryWeight({ type: 'file', isDir: true }))
    expect(getCategoryWeight({ type: 'file', isDir: true })).toBeGreaterThan(getCategoryWeight({ type: 'file', isDir: false }))

    // 2. 端到端混排验证：构造同前缀命中的 1B, 1A, 2B, 2A, 3A, 3B, 4A, 4B
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
          { code: 'sub-sys', explain: '系统子功能' }
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
      const { filteredItems, search, refreshApplications, refreshPanelData } = useCommandSearch({ enableFileSearch: true })
      await refreshApplications({ force: true })
      await refreshPanelData({ force: true })

      search('系统')
      await new Promise((r) => setTimeout(r, 120))

      const orderedNames = filteredItems.value.map((i) => i.name)
      // 验证 1B (系统设置) -> 1A (系统控制工具) -> 2B (系统安装软件) -> 2A (系统自选软件) -> 3A (系统中心插件) -> 3B (系统子功能) -> 4A (系统目录) -> 4B (系统文档.txt)
      expect(orderedNames).toEqual([
        '系统设置',
        '系统控制工具',
        '系统安装软件',
        '系统自选软件',
        '系统中心插件',
        '系统子功能',
        '系统目录',
        '系统文档.txt'
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
})
