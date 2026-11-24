import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  SYSTEM_LOCALE,
  SUPPORTED_LOCALES,
  stripLocaleSuffix,
  matchSupportedLocale,
  isSupportedLocale,
  resolveLocale,
  normalizeLocaleSetting
} from '../src/locale.js'

describe('packages/ztools-plugins-spec/src/locale.js 单一信源边界测试', () => {
  it('导出常量符合契约', () => {
    assert.equal(DEFAULT_LOCALE, 'zh-CN')
    assert.equal(FALLBACK_LOCALE, 'en-US')
    assert.equal(SYSTEM_LOCALE, 'system')
    assert.deepEqual([...SUPPORTED_LOCALES], ['zh-CN', 'en-US'])
    assert.equal(Object.isFrozen(SUPPORTED_LOCALES), true)
  })

  it('stripLocaleSuffix：剥离 POSIX .UTF-8/@... 后缀、转换下划线与修剪空白', () => {
    assert.equal(stripLocaleSuffix('zh_CN.UTF-8'), 'zh-CN')
    assert.equal(stripLocaleSuffix('  zh_TW.utf8@traditional  '), 'zh-TW')
    assert.equal(stripLocaleSuffix('en_US@euro'), 'en-US')
    assert.equal(stripLocaleSuffix('en_GB.ISO8859-1'), 'en-GB')
    assert.equal(stripLocaleSuffix('fr_FR.UTF-8@euro'), 'fr-FR')
    assert.equal(stripLocaleSuffix('  system  '), 'system')
    assert.equal(stripLocaleSuffix('.UTF-8'), '')
    assert.equal(stripLocaleSuffix('@euro'), '')
    assert.equal(stripLocaleSuffix('   '), '')
    assert.equal(stripLocaleSuffix(''), '')
    assert.equal(stripLocaleSuffix(null), '')
    assert.equal(stripLocaleSuffix(undefined), '')
    assert.equal(stripLocaleSuffix(123), '')
    assert.equal(stripLocaleSuffix({}), '')
  })

  it('matchSupportedLocale：严格匹配中英变体，第三语种、system 与空值返回 null', () => {
    for (const zh of ['zh', 'ZH', 'zh-CN', 'zh_cn', 'zh-TW', 'zh-HK', 'zh-Hans-SG', 'zh_CN.UTF-8', 'zh_SG@hans']) {
      assert.equal(matchSupportedLocale(zh), 'zh-CN', `预期 ${zh} -> zh-CN`)
    }
    for (const en of ['en', 'EN', 'en-US', 'en_gb', 'en-AU', 'en_US.UTF-8', 'en_US@euro']) {
      assert.equal(matchSupportedLocale(en), 'en-US', `预期 ${en} -> en-US`)
    }
    for (const miss of [
      '',
      '   ',
      null,
      undefined,
      0,
      {},
      'system',
      'SYSTEM',
      '  system  ',
      'auto',
      'default',
      'ja',
      'ja-JP',
      'ja_JP.UTF-8',
      'fr-FR',
      'ko-KR',
      'de_DE@euro',
      'es-ES',
      'zhx-CN',
      'eng-US'
    ]) {
      assert.equal(matchSupportedLocale(miss), null, `预期 ${String(miss)} -> null`)
    }
  })

  it('isSupportedLocale：严格值检查', () => {
    assert.equal(isSupportedLocale('zh-CN'), true)
    assert.equal(isSupportedLocale('en-US'), true)
    assert.equal(isSupportedLocale('zh'), false)
    assert.equal(isSupportedLocale('en'), false)
    assert.equal(isSupportedLocale('system'), false)
    assert.equal(isSupportedLocale('ja-JP'), false)
    assert.equal(isSupportedLocale(null), false)
  })

  it('resolveLocale：单值、数组顺延（跳过 system/空值/第三语种）与兜底回退', () => {
    // 单个候选
    assert.equal(resolveLocale('zh_CN.UTF-8'), 'zh-CN')
    assert.equal(resolveLocale('en_GB@euro'), 'en-US')
    assert.equal(resolveLocale('ja-JP'), 'en-US')
    assert.equal(resolveLocale('fr-FR'), 'en-US')
    assert.equal(resolveLocale('system'), 'en-US')
    assert.equal(resolveLocale(''), 'en-US')
    assert.equal(resolveLocale(null), 'en-US')
    assert.equal(resolveLocale(undefined), 'en-US')

    // 数组顺延
    assert.equal(resolveLocale(['system', 'fr-FR', 'zh_CN.UTF-8']), 'zh-CN')
    assert.equal(resolveLocale([null, '', '   ', 'system', 'auto', 'ja-JP', 'en_GB.UTF-8']), 'en-US')
    assert.equal(resolveLocale(['zh-TW', 'en-US']), 'zh-CN')
    assert.equal(resolveLocale(['en-AU', 'zh-CN']), 'en-US')
    assert.equal(resolveLocale(['system', 'ja-JP', 'ko-KR']), 'en-US')
    assert.equal(resolveLocale([]), 'en-US')

    // 自定义 fallback 与非法 fallback 保护
    assert.equal(resolveLocale(['system', 'ja-JP'], 'zh-CN'), 'zh-CN')
    assert.equal(resolveLocale('fr-FR', 'zh-CN'), 'zh-CN')
    assert.equal(resolveLocale('fr-FR', 'invalid-locale'), 'en-US')
  })

  it('normalizeLocaleSetting：保留 system、归一化受支持语言、非法值回退 fallback', () => {
    assert.equal(normalizeLocaleSetting('system'), 'system')
    assert.equal(normalizeLocaleSetting('  SYSTEM  '), 'system')
    assert.equal(normalizeLocaleSetting('zh_CN.UTF-8'), 'zh-CN')
    assert.equal(normalizeLocaleSetting('zh-HK'), 'zh-CN')
    assert.equal(normalizeLocaleSetting('en_US@euro'), 'en-US')
    assert.equal(normalizeLocaleSetting('en-GB'), 'en-US')
    assert.equal(normalizeLocaleSetting('ja-JP'), 'system')
    assert.equal(normalizeLocaleSetting(''), 'system')
    assert.equal(normalizeLocaleSetting(null), 'system')
    assert.equal(normalizeLocaleSetting(undefined), 'system')
    assert.equal(normalizeLocaleSetting('fr-FR', 'en-US'), 'en-US')
    assert.equal(normalizeLocaleSetting('fr-FR', 'zh-CN'), 'zh-CN')
    assert.equal(normalizeLocaleSetting('fr-FR', 'bad'), 'system')
  })
})
