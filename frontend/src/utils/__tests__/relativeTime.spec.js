import { describe, it, expect, afterEach } from 'vitest'
import { formatRelativeTime } from '@/utils/relativeTime'
import { getCurrentLocale, setI18nLocale } from '@/i18n'

describe('formatRelativeTime', () => {
  // 2026-10-16 15:00 本地时间
  const now = new Date(2026, 9, 16, 15, 0, 0).getTime()
  const originalLocale = getCurrentLocale()

  afterEach(() => {
    setI18nLocale(originalLocale)
  })

  it('zh-CN 下按「现在 / 分钟 / 小时 / 昨天 / 天 / 日期」分级', () => {
    expect(formatRelativeTime(now - 20_000, now, 'zh-CN')).toBe('现在')
    expect(formatRelativeTime(now - 5 * 60_000, now, 'zh-CN')).toBe('5分钟前')
    expect(formatRelativeTime(now - 2 * 3_600_000, now, 'zh-CN')).toBe('2小时前')
    expect(formatRelativeTime(new Date(2026, 9, 15, 22, 0).getTime(), now, 'zh-CN')).toBe('昨天')
    expect(formatRelativeTime(new Date(2026, 9, 13, 9, 0).getTime(), now, 'zh-CN')).toBe('3天前')
    expect(formatRelativeTime(new Date(2026, 8, 1, 9, 0).getTime(), now, 'zh-CN')).toBe('9月1日')
  })

  it('en-US 下按 Intl.RelativeTimeFormat 输出规范英文相对时间与短日期', () => {
    expect(formatRelativeTime(now - 20_000, now, 'en-US')).toBe('now')
    expect(formatRelativeTime(now - 5 * 60_000, now, 'en-US')).toBe('5 minutes ago')
    expect(formatRelativeTime(now - 2 * 3_600_000, now, 'en-US')).toBe('2 hours ago')
    expect(formatRelativeTime(new Date(2026, 9, 15, 22, 0).getTime(), now, 'en-US')).toBe('yesterday')
    expect(formatRelativeTime(new Date(2026, 9, 13, 9, 0).getTime(), now, 'en-US')).toBe('3 days ago')
    expect(formatRelativeTime(new Date(2026, 8, 1, 9, 0).getTime(), now, 'en-US')).toBe('Sep 1')
  })

  it('不传 locale 参数时自动跟随当前 i18n locale', () => {
    setI18nLocale('en-US')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
    setI18nLocale('zh-CN')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5分钟前')
  })

  it('跨午夜：一小时以内按分钟显示；超过一小时且在昨天的显示「昨天/yesterday」', () => {
    const earlyMorning = new Date(2026, 9, 16, 1, 30).getTime()
    expect(formatRelativeTime(new Date(2026, 9, 16, 0, 50).getTime(), earlyMorning, 'zh-CN')).toBe('40分钟前')
    expect(formatRelativeTime(new Date(2026, 9, 15, 22, 0).getTime(), earlyMorning, 'zh-CN')).toBe('昨天')
    expect(formatRelativeTime(new Date(2026, 9, 16, 0, 50).getTime(), earlyMorning, 'en-US')).toBe('40 minutes ago')
    expect(formatRelativeTime(new Date(2026, 9, 15, 22, 0).getTime(), earlyMorning, 'en-US')).toBe('yesterday')
  })

  it('[破坏性] 非法、零、负数与未来时间不显示', () => {
    for (const value of [undefined, null, NaN, 0, -1, 'yesterday', now + 3_600_000]) {
      expect(formatRelativeTime(value, now, 'zh-CN')).toBe('')
      expect(formatRelativeTime(value, now, 'en-US')).toBe('')
    }
    expect(formatRelativeTime(now - 60_000, NaN, 'en-US')).toBe('')
  })
})
