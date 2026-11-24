import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCurrentLocale, setI18nLocale } from '@/i18n'
import { resolveLocalizedChangelog } from '@/utils/updateChangelog'

describe('updateChangelog 多语言更新日志解析', () => {
  const originalLocale = getCurrentLocale()

  beforeEach(() => {
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    setI18nLocale(originalLocale)
  })

  it('优先精确匹配当前规范语种（zh-CN / en-US）', () => {
    const data = {
      changelog: '默认日志',
      changelogI18n: {
        'zh-CN': '中文更新日志',
        'en-US': 'English changelog'
      }
    }
    expect(resolveLocalizedChangelog(data, 'zh-CN')).toBe('中文更新日志')
    expect(resolveLocalizedChangelog(data, 'en-US')).toBe('English changelog')
    expect(resolveLocalizedChangelog(data)).toBe('中文更新日志')

    setI18nLocale('en-US')
    expect(resolveLocalizedChangelog(data)).toBe('English changelog')
  })

  it('兼容受支持语种的未归一化键名（en / en_US / zh / zh-Hans）与蛇形字段 changelog_i18n', () => {
    expect(
      resolveLocalizedChangelog(
        {
          changelog: 'fallback',
          changelog_i18n: { en: 'Short English', zh_Hans: '简体日志' }
        },
        'en-US'
      )
    ).toBe('Short English')

    expect(
      resolveLocalizedChangelog(
        {
          changelog: 'fallback',
          changelogI18n: { en_GB: 'UK English', zh: '中文简写' }
        },
        'zh-CN'
      )
    ).toBe('中文简写')
  })

  it('[防第三语种误判] 英文模式下绝不将 ja-JP / fr-FR / ko-KR 等第三语种误判为 en-US', () => {
    const data = {
      changelog: 'Default release notes',
      changelogI18n: {
        'ja-JP': '日本語の更新履歴',
        'fr-FR': 'Journal des modifications en français',
        'ko-KR': '한국어 변경 내역'
      }
    }
    expect(resolveLocalizedChangelog(data, 'en-US')).toBe('Default release notes')
    expect(resolveLocalizedChangelog(data, 'zh-CN')).toBe('Default release notes')
  })

  it('[边界] 缺失、空串或非法输入安全回退默认 changelog 或空串', () => {
    expect(resolveLocalizedChangelog(null, 'en-US')).toBe('')
    expect(resolveLocalizedChangelog(undefined, 'zh-CN')).toBe('')
    expect(resolveLocalizedChangelog({ changelog: 'Default', changelogI18n: { 'en-US': '   ' } }, 'en-US')).toBe('Default')
    expect(resolveLocalizedChangelog({ changelog: 123 }, 'en-US')).toBe('')
  })
})
