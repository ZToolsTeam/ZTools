import { describe, it, expect } from 'vitest'
import * as specLocale from '@ztools/plugins-spec/locale'
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_OPTIONS,
  stripLocaleSuffix,
  matchSupportedLocale,
  isSupportedLocale,
  normalizeLocaleSetting,
  resolveLocale
} from '../locale.js'

describe('locale utils', () => {
  describe('constants', () => {
    it('exports frozen SUPPORTED_LOCALES, DEFAULT_LOCALE and LOCALE_OPTIONS', () => {
      expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US'])
      expect(Object.isFrozen(SUPPORTED_LOCALES)).toBe(true)
      expect(DEFAULT_LOCALE).toBe('en-US')

      expect(Object.isFrozen(LOCALE_OPTIONS)).toBe(true)
      expect(LOCALE_OPTIONS.map((o) => o.value)).toEqual(['system', 'zh-CN', 'en-US'])
      for (const option of LOCALE_OPTIONS) {
        expect(Object.isFrozen(option)).toBe(true)
        expect(typeof option.labelKey).toBe('string')
        expect(typeof option.nativeLabel).toBe('string')
      }
    })
  })

  describe('matchSupportedLocale', () => {
    it('strictly matches Chinese and English variants and returns null for third locales or system', () => {
      for (const zh of ['zh', 'zh-CN', 'zh_TW', 'zh-Hans-SG', 'zh_CN.UTF-8']) {
        expect(matchSupportedLocale(zh)).toBe('zh-CN')
      }
      for (const en of ['en', 'EN', 'en-US', 'en_GB', 'en_AU.UTF-8']) {
        expect(matchSupportedLocale(en)).toBe('en-US')
      }
      for (const third of ['ja-JP', 'fr-FR', 'ko-KR', 'de-DE', 'system', '', '   ', null, undefined, 123, {}]) {
        expect(matchSupportedLocale(third)).toBeNull()
      }
    })
  })

  describe('resolveLocale', () => {
    it('normalizes all Chinese BCP-47 and POSIX variants to zh-CN', () => {
      const zhVariants = [
        'zh',
        'ZH',
        'zh-cn',
        'zh-CN',
        'zh_CN',
        '  zh_cn  ',
        'zh-Hans',
        'zh-hans-cn',
        'zh_Hans_SG',
        'zh-SG',
        'zh-TW',
        'zh_tw',
        'zh-HK',
        'zh_HK',
        'zh-Hant',
        'zh-Hant-TW',
        'zh-Hant-HK',
        'zh-MO',
        'zh_CN.UTF-8',
        'zh_TW@traditional'
      ]
      for (const tag of zhVariants) {
        expect(resolveLocale(tag, 'en-US')).toBe('zh-CN')
      }
    })

    it('normalizes English and all non-Chinese locales to en-US', () => {
      const nonZhVariants = [
        'en',
        'EN',
        'en-US',
        'en_US',
        'en-GB',
        'en_AU.UTF-8',
        'ja',
        'ja-JP',
        'ko-KR',
        'fr-FR',
        'de-DE',
        'es-ES',
        'zhfoo',
        'invalid-locale'
      ]
      for (const tag of nonZhVariants) {
        expect(resolveLocale(tag, 'zh-CN')).toBe('en-US')
      }
    })

    it('falls back to systemLocale when raw is empty or system', () => {
      expect(resolveLocale(undefined, 'zh-CN')).toBe('zh-CN')
      expect(resolveLocale(null, 'zh_TW')).toBe('zh-CN')
      expect(resolveLocale('', 'zh-Hans')).toBe('zh-CN')
      expect(resolveLocale('   ', 'zh-HK')).toBe('zh-CN')
      expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN')
      expect(resolveLocale('SYSTEM', 'zh_SG')).toBe('zh-CN')
      expect(resolveLocale('  System  ', 'zh-Hant-TW')).toBe('zh-CN')

      expect(resolveLocale('system', 'en-GB')).toBe('en-US')
      expect(resolveLocale('system', 'ja-JP')).toBe('en-US')
      expect(resolveLocale('system')).toBe('en-US')
      expect(resolveLocale(undefined)).toBe('en-US')
    })

    it('handles abnormal and non-string inputs safely without throwing', () => {
      const abnormalInputs = [0, 123, NaN, false, true, {}, [], Symbol('zh')]
      for (const bad of abnormalInputs) {
        expect(resolveLocale(bad, 'zh-CN')).toBe('en-US')
        expect(resolveLocale('system', bad)).toBe('en-US')
        expect(resolveLocale(null, bad)).toBe('en-US')
      }
      expect(resolveLocale('system', 'system')).toBe('en-US')
      expect(resolveLocale('system', '')).toBe('en-US')
      expect(resolveLocale('system', null)).toBe('en-US')
    })

    it('reuses @ztools/plugins-spec/locale single source of truth helpers', () => {
      expect(stripLocaleSuffix).toBe(specLocale.stripLocaleSuffix)
      expect(matchSupportedLocale).toBe(specLocale.matchSupportedLocale)
      expect(isSupportedLocale).toBe(specLocale.isSupportedLocale)
      expect(normalizeLocaleSetting).toBe(specLocale.normalizeLocaleSetting)

      expect(stripLocaleSuffix('zh_CN.UTF-8')).toBe('zh-CN')
      expect(stripLocaleSuffix('en_US@euro')).toBe('en-US')
      expect(normalizeLocaleSetting('zh_Hans')).toBe('zh-CN')
      expect(normalizeLocaleSetting('en-GB')).toBe('en-US')
      expect(normalizeLocaleSetting('system')).toBe('system')
      expect(normalizeLocaleSetting('ja-JP')).toBe('system')

      expect(resolveLocale(['system', 'fr-FR', 'zh_CN.UTF-8'])).toBe('zh-CN')
      expect(resolveLocale(['ja-JP', 'ko-KR'])).toBe('en-US')
    })
  })
})
