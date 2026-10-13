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
})
