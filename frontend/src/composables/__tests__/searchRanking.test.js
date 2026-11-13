import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  useCommandSearch,
  compareEmptyQuery,
  calculateFrecencyScore,
  calculateFrecencyBonus,
  getCategoryRank,
  CATEGORY_RANKS,
  recordCommandUsage,
  recordQueryChoice,
  resolveQueryChoice,
  loadFrecencyMap,
  loadQueryChoices
} from '../useCommandSearch.js'
import { usePluginsStore } from '@/stores/plugins'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FRECENCY_KEY = 'ztools_command_frecency'
const CHOICES_KEY = 'ztools_command_query_choices'

const appRecord = (display, english, dir = '/Applications') => ({
  name: `${english}.app`, display_name: display, path: `${dir}/${english}.app`, kind: 'application', is_dir: true, size: 0, mtime: 1
})

let scope
let searchFiles
let panelItems
const create = (options) => scope.run(() => useCommandSearch(options))
const settle = () => vi.advanceTimersByTimeAsync(0)
const names = (state) => state.filteredItems.value.map((item) => item.name)
const seedFrecency = (map) => localStorage.setItem(FRECENCY_KEY, JSON.stringify(map))

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T10:00:00+08:00'))
  scope = effectScope()
  panelItems = []
  searchFiles = vi.fn(async (_query, _limit, options) => {
    if (options?.scope === 'applications') return { files: [appRecord('微信', 'WeChat')], scope: 'applications' }
    return { files: [], ...(options?.scope ? { scope: options.scope } : {}) }
  })
  window.__ztoolsLauncher = {
    searchFiles,
    getPanelData: vi.fn(async () => ({ success: true, data: { items: panelItems } }))
  }
  usePluginsStore().installedPlugins = [
    { pluginId: 'json-format', name: 'JSON 格式化', entry: 'dist/index.js', isDeclarative: true,
      features: [{ code: 'json-format', explain: 'JSON 格式化' }, { code: 'json-codegen', explain: 'JSON 生成类型' }] }
  ]
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete window.__ztoolsLauncher
})

describe('空查询比较器与 Frecency 原始分', () => {
  it('热度先分档再比较：任意输入顺序都得到同一个结果（修复“分差 < 5 视为同档”的循环）', () => {
    const a = { emptyBucket: 0, heatTier: Math.floor(100 / 5), categoryRank: 5, lastUsed: 3, index: 0 }
    const b = { emptyBucket: 0, heatTier: Math.floor(97 / 5), categoryRank: 3, lastUsed: 2, index: 1 }
    const c = { emptyBucket: 0, heatTier: Math.floor(94 / 5), categoryRank: 2, lastUsed: 1, index: 2 }
    const perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]
    const results = new Set(perms.map((list) => [...list].sort(compareEmptyQuery).map((x) => x.index).join(',')))
    expect(results.size).toBe(1)
  })

  it('原始分不封顶，搜索态加分封顶 180；频次按 30 天半衰期衰减，远古高频记录不再拿满频次分', () => {
    const now = Date.now()
    const heavyJustNow = { count: 100, score: 100, lastUsed: now - 1000 }
    const heavyHourAgo = { count: 100, score: 100, lastUsed: now - HOUR }
    expect(calculateFrecencyScore(heavyJustNow, now)).toBeGreaterThan(calculateFrecencyScore(heavyHourAgo, now))
    expect(calculateFrecencyBonus(heavyJustNow, now)).toBe(180)
    expect(calculateFrecencyBonus(heavyHourAgo, now)).toBe(180)

    // 一年前累计 1000 次：衰减计数约 0.24，频次分只剩几分
    const ancient = { count: 1000, score: 1000, lastUsed: now - 365 * DAY }
    expect(calculateFrecencyScore(ancient, now)).toBeLessThan(10)
  })

  it('记录使用时同时保存衰减计数；已安装程序顺带保存名称与路径，其它条目不保存', () => {
    recordCommandUsage('file:/Applications/WeChat.app', { type: 'file', isApplication: true, name: '微信', path: '/Applications/WeChat.app' })
    recordCommandUsage('json-format', { type: 'plugin', name: 'JSON 格式化' })
    vi.advanceTimersByTime(30 * DAY)
    recordCommandUsage('json-format')
    const map = loadFrecencyMap()
    expect(map['file:/Applications/WeChat.app'].meta).toEqual({ name: '微信', path: '/Applications/WeChat.app' })
    expect(map['json-format'].meta).toBeUndefined()
    expect(map['json-format'].count).toBe(2)
    // 30 天前的一次只算半次
    expect(map['json-format'].score).toBeCloseTo(1.5, 3)
  })
})

describe('空查询排序', () => {
  it('重度使用的条目不再同时到顶：1 秒前用过的插件排在 1 小时前用过的系统工具前面', async () => {
    panelItems = [{ id: 'taskmgr', name: '任务管理器', type: 'system_tool', keywords: [] }]
    const now = Date.now()
    seedFrecency({
      'json-format': { count: 100, score: 100, lastUsed: now - 1000 },
      'system-tool:taskmgr': { count: 100, score: 100, lastUsed: now - HOUR }
    })
    const state = create()
    await settle()
    expect(names(state).slice(0, 2)).toEqual(['JSON 格式化', '任务管理器'])
  })

  it('长期未用（低于活跃门槛）的条目回落到默认推荐梯队，按分类排在未用过的内置指令之后', async () => {
    seedFrecency({ 'json-format': { count: 1, score: 1, lastUsed: Date.now() - 200 * DAY } })
    const state = create()
    await settle()
    const list = names(state)
    expect(list[0]).toBe('系统设置')
    expect(list.indexOf('JSON 格式化')).toBeGreaterThan(list.indexOf('系统设置'))
  })

  it('另一个窗口写入使用记录（storage 事件）后重新排序', async () => {
    const state = create()
    await settle()
    expect(names(state)[0]).toBe('系统设置')
    const raw = JSON.stringify({ 'json-format': { count: 1, score: 1, lastUsed: Date.now() } })
    localStorage.setItem(FRECENCY_KEY, raw)
    window.dispatchEvent(new StorageEvent('storage', { key: FRECENCY_KEY, newValue: raw }))
    expect(names(state)[0]).toBe('JSON 格式化')
  })

  it('冷启动：程序列表返回前用使用记录占位显示用过的程序，打开前先等列表返回换成真实条目', async () => {
    recordCommandUsage('file:/Applications/WeChat.app', { type: 'file', isApplication: true, name: '微信', path: '/Applications/WeChat.app' })
    let releaseApps
    searchFiles.mockImplementationOnce(() => new Promise((resolve) => { releaseApps = resolve }))
    const state = create()
    const placeholder = state.filteredItems.value[0]
    expect(placeholder).toMatchObject({ name: '微信', pendingGrant: true, isApplication: true })

    const ready = state.prepareItemForLaunch(placeholder)
    releaseApps({ files: [appRecord('微信', 'WeChat')], scope: 'applications' })
    const real = await ready
    expect(real).toMatchObject({ name: '微信', path: '/Applications/WeChat.app' })
    expect(real.pendingGrant).toBeUndefined()
    expect(state.filteredItems.value[0].pendingGrant).toBeUndefined()
  })

  it('冷启动占位的程序已卸载时，列表返回后消失，打开返回 null', async () => {
    recordCommandUsage('file:/Applications/Gone.app', { type: 'file', isApplication: true, name: '已卸载', path: '/Applications/Gone.app' })
    let releaseApps
    searchFiles.mockImplementationOnce(() => new Promise((resolve) => { releaseApps = resolve }))
    const state = create()
    const placeholder = state.filteredItems.value.find((item) => item.name === '已卸载')
    expect(placeholder?.pendingGrant).toBe(true)
    const ready = state.prepareItemForLaunch(placeholder)
    releaseApps({ files: [appRecord('微信', 'WeChat')], scope: 'applications' })
    expect(await ready).toBeNull()
    expect(names(state)).not.toContain('已卸载')
  })
})

describe('已安装程序去重', () => {
  it('与用户添加的软件同名、或与系统工具同名的开始菜单程序只保留优先级高的一条，使用记录合并', async () => {
    searchFiles.mockImplementation(async (_q, _l, options) => {
      if (options?.scope === 'applications') {
        return {
          scope: 'applications',
          files: [
            { name: 'Google Chrome.lnk', display_name: 'Google Chrome', path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk', kind: 'application', is_dir: false, size: 0, mtime: 1 },
            { name: '任务管理器.lnk', display_name: '任务管理器', path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\任务管理器.lnk', kind: 'application', is_dir: false, size: 0, mtime: 1 }
          ]
        }
      }
      return { files: [], scope: 'files' }
    })
    panelItems = [
      { id: 'chrome', name: 'Google Chrome', type: 'local', description: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { id: 'taskmgr', name: '任务管理器', type: 'system_tool', keywords: [] }
    ]
    // 使用记录记在开始菜单那一份上
    seedFrecency({ 'file:C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk': { count: 3, score: 3, lastUsed: Date.now() } })
    const state = create()
    await settle()

    state.search('chrome')
    const chromes = state.filteredItems.value.filter((item) => item.name === 'Google Chrome')
    expect(chromes).toHaveLength(1)
    expect(chromes[0].type).toBe('local-app')

    state.search('任务管理器')
    expect(state.filteredItems.value.filter((item) => item.name === '任务管理器').map((item) => item.type)).toEqual(['system-tool'])

    // 空查询：合并过来的使用记录让手动添加的 Chrome 进入活跃梯队排第一
    state.search('')
    expect(state.filteredItems.value[0]).toMatchObject({ name: 'Google Chrome', type: 'local-app' })
  })
})

describe('搜索词选择记忆', () => {
  it('误点 1 次不顶掉旧习惯，再选 1 次完成迁移；用得再久的旧习惯也能在几次内迁移', () => {
    for (let i = 0; i < 3; i++) recordQueryChoice('sys', 'item-a')
    recordQueryChoice('sys', 'item-b')
    expect(resolveQueryChoice(loadQueryChoices().sys).key).toBe('item-a')
    recordQueryChoice('sys', 'item-b')
    expect(resolveQueryChoice(loadQueryChoices().sys).key).toBe('item-b')

    // 旧格式：累计 50 次的旧习惯按权重上限 5 折算，连续改选 4 次完成迁移
    localStorage.setItem(CHOICES_KEY, JSON.stringify({ code: { key: 'old', at: 1, counts: { old: { count: 50, at: 1 } } } }))
    for (let i = 0; i < 3; i++) recordQueryChoice('code', 'new')
    expect(resolveQueryChoice(loadQueryChoices().code).key).toBe('old')
    recordQueryChoice('code', 'new')
    expect(resolveQueryChoice(loadQueryChoices().code).key).toBe('new')
  })

  it('同一个词下已有 5 个候选时，刚选中的新条目不会在裁剪时被删掉', () => {
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      recordQueryChoice('q', key)
      recordQueryChoice('q', key)
    }
    recordQueryChoice('q', 'z')
    const counts = loadQueryChoices().q.counts
    expect(Object.keys(counts)).toHaveLength(5)
    expect(counts.z).toBeTruthy()
  })

  it('前缀继承只认稳定习惯：误点 1 次 vsc 不给 vs 加分，选 2 次后才加分', async () => {
    usePluginsStore().installedPlugins = [
      { pluginId: 'vs-alpha', name: 'VS Alpha', entry: 'dist/index.js', isDeclarative: true },
      { pluginId: 'vs-beta', name: 'VS Beta', entry: 'dist/index.js', isDeclarative: true }
    ]
    const state = create({ enableFileSearch: false })
    // 未学习时名称更短的 VS Beta 排第一
    state.search('vs')
    expect(names(state)[0]).toBe('VS Beta')

    recordQueryChoice('vsc', 'vs-alpha')
    state.search('v')
    state.search('vs')
    expect(names(state)[0]).toBe('VS Beta')

    recordQueryChoice('vsc', 'vs-alpha')
    state.search('v')
    state.search('vs')
    expect(names(state)[0]).toBe('VS Alpha')
  })
})

describe('分类与固定标记', () => {
  it('未登记的条目类型归最低档；与内置指令同 key 的插件仍按插件归类', () => {
    expect(getCategoryRank({ type: 'clipboard-entry' })).toBe(CATEGORY_RANKS.FILE_REGULAR)
    expect(getCategoryRank({ key: 'system-settings' })).toBe(CATEGORY_RANKS.HOST_BUILTIN)
    expect(getCategoryRank({ key: 'system-settings', type: 'plugin' })).toBe(CATEGORY_RANKS.PLUGIN)
  })

  it('插件被固定后只有主入口带固定标记，子命令不显示「已固定」', async () => {
    panelItems = [{ id: 'json-format', name: 'JSON 格式化', type: 'plugin', pinned: true }]
    const state = create({ enableFileSearch: false })
    await state.refreshPanelData({ force: true })
    state.search('json')
    const plugin = state.filteredItems.value.find((item) => item.type === 'plugin')
    const feature = state.filteredItems.value.find((item) => item.type === 'plugin-feature')
    expect(plugin.pinned).toBe(true)
    expect(feature.pinned).toBeFalsy()
  })
})
