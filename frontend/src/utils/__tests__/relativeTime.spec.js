import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from '@/utils/relativeTime'

describe('formatRelativeTime', () => {
  // 2026-10-16 15:00 本地时间
  const now = new Date(2026, 9, 16, 15, 0, 0).getTime()

  it('按「刚刚 / 分钟 / 小时 / 昨天 / 天 / 日期」分级', () => {
    expect(formatRelativeTime(now - 20_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2 小时前')
    expect(formatRelativeTime(new Date(2026, 9, 15, 22, 0).getTime(), now)).toBe('昨天')
    expect(formatRelativeTime(new Date(2026, 9, 13, 9, 0).getTime(), now)).toBe('3 天前')
    expect(formatRelativeTime(new Date(2026, 8, 1, 9, 0).getTime(), now)).toBe('9月1日')
  })

  it('跨午夜：一小时以内按分钟显示；超过一小时且在昨天的显示「昨天」，而不是「N 小时前」', () => {
    const earlyMorning = new Date(2026, 9, 16, 1, 30).getTime()
    expect(formatRelativeTime(new Date(2026, 9, 16, 0, 50).getTime(), earlyMorning)).toBe('40 分钟前')
    expect(formatRelativeTime(new Date(2026, 9, 15, 22, 0).getTime(), earlyMorning)).toBe('昨天')
  })

  it('[破坏性] 非法、零、负数与未来时间不显示', () => {
    for (const value of [undefined, null, NaN, 0, -1, 'yesterday', now + 3_600_000]) {
      expect(formatRelativeTime(value, now)).toBe('')
    }
  })
})
