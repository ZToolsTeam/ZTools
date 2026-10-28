import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useCommandSearch,
  calculateFrecencyBonus,
  loadFrecencyMap,
  saveFrecencyMap,
  recordCommandUsage,
  resolveCommandFaIcon,
  resolveFileFaIcon
} from '../useCommandSearch.js'

describe('useCommandSearch 统一搜索内核与 Frecency 排序测试套件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('1. [Frecency 算法衰减集成链路] 频度与近期使用综合加权', () => {
    const now = Date.now()

    // 1 小时内使用 5 次
    const recentStats = { count: 5, lastUsed: now - 30 * 60 * 1000 }
    const bonusRecent = calculateFrecencyBonus(recentStats, now)
    // 120 (recency) + 50 (frequency) = 170
    expect(bonusRecent).toBe(170)

    // 2 天前使用 2 次
    const twoDaysStats = { count: 2, lastUsed: now - 48 * 60 * 60 * 1000 }
    const bonusTwoDays = calculateFrecencyBonus(twoDaysStats, now)
    // 50 (recency) + 20 (frequency) = 70
    expect(bonusTwoDays).toBe(70)

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
    let callIndex = 0
    let resolveFirst = null
    let resolveSecond = null

    const mockSearchFiles = vi.fn().mockImplementation((query) => {
      callIndex++
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

    window.ztools = {
      system: {
        searchFiles: mockSearchFiles
      }
    }

    const { query, fileResults, search } = useCommandSearch({ enableFileSearch: true })

    // 快速触发第一次搜索
    search('first')
    // 立即触发第二次搜索（覆盖第一次）
    search('second')

    // 此时即使第一次搜索耗时很长并之后才返回
    await new Promise((r) => setTimeout(r, 60)) // 等待 debounce
    if (resolveSecond) resolveSecond()
    if (resolveFirst) resolveFirst()

    await new Promise((r) => setTimeout(r, 30))

    // 结果必须是第二次的，绝不被第一次乱序覆盖
    expect(fileResults.value.some((f) => f.name === 'second.txt')).toBe(true)
    expect(fileResults.value.some((f) => f.name === 'first.txt')).toBe(false)
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

    // 输入短别名 "mute"：子命令立即以最高优先级 (score 100000) 置顶召回
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

    // 2. 搜索「webp转jpg」命中 batch-image 的 preset-to-jpg 子命令
    search('webp转jpg')
    expect(filteredItems.value.some((i) => i.key === 'batch-image:preset-to-jpg')).toBe(true)

    // 3. 搜索「扫描件转灰度」命中 batch-image 的 preset-doc-bw 子命令
    search('扫描件转灰度')
    expect(filteredItems.value.some((i) => i.key === 'batch-image:preset-doc-bw')).toBe(true)

    // 4. 搜索原独立插件「词典 / 查词」命中 translator 的 translate-dict 子命令
    search('词典')
    expect(filteredItems.value.some((i) => i.key === 'translator:translate-dict')).toBe(true)

    // 5. 搜索「变量命名」命中 translator 的 translate-naming 子命令
    search('变量命名')
    expect(filteredItems.value.some((i) => i.key === 'translator:translate-naming')).toBe(true)

    // 6. 搜索原独立插件「base64解码」命中 crypto-tool 的 codec-base64 子命令
    search('base64解码')
    expect(filteredItems.value.some((i) => i.key === 'crypto-tool:codec-base64')).toBe(true)

    // 7. 搜索「高铁票」命中 invoice-assistant 的 invoice-travel 子命令
    search('高铁票')
    expect(filteredItems.value.some((i) => i.key === 'invoice-assistant:invoice-travel')).toBe(true)

    // 8. 搜索原独立插件「大写金额」与「世界时钟」命中合并后的 calculator 与 timestamp 子命令
    search('大写金额')
    expect(filteredItems.value.some((i) => i.key === 'calculator:calc-rmb')).toBe(true)

    search('世界时钟')
    expect(filteredItems.value.some((i) => i.key === 'timestamp:tz-world')).toBe(true)
  })
})
