/**
 * 应用语言（Locale）归一化与解析工具。
 * 直接复用全端单一信源 `@ztools/plugins-spec/locale`，确保前后端/宿主/插件语言归一化语义 100% 一致。
 */

import {
  FALLBACK_LOCALE,
  SYSTEM_LOCALE,
  SUPPORTED_LOCALES,
  stripLocaleSuffix,
  matchSupportedLocale,
  isSupportedLocale,
  resolveLocale as resolveSpecLocale,
  normalizeLocaleSetting
} from '@ztools/plugins-spec/locale'

export {
  SUPPORTED_LOCALES,
  SYSTEM_LOCALE,
  stripLocaleSuffix,
  matchSupportedLocale,
  isSupportedLocale,
  normalizeLocaleSetting
}

export const DEFAULT_LOCALE = FALLBACK_LOCALE

export const LOCALE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'system', labelKey: 'settings.language.system', nativeLabel: 'System' }),
  Object.freeze({ value: 'zh-CN', labelKey: 'settings.language.zhCN', nativeLabel: '简体中文' }), // i18n-allow: native language autonym
  Object.freeze({ value: 'en-US', labelKey: 'settings.language.enUS', nativeLabel: 'English' })
])

/**
 * 将用户配置或系统语言标识解析为受支持的规范 Locale（'zh-CN' | 'en-US'）。
 * - 支持传入候选数组（与单一信源 `resolveLocale(candidates, fallback)` 完全等价）；
 * - 当 raw 为空（null / undefined / 空串）或 'system' / 'auto' / 'default'（忽略大小写与首尾空白）时，对 systemLocale 执行归一化；
 * - 中文系 BCP-47 / POSIX 标签统一归一化为 'zh-CN'；
 * - 英文系及其他非中文语言、或非法输入统一兜底为 DEFAULT_LOCALE（'en-US'）。
 */
export function resolveLocale(raw, systemLocale = DEFAULT_LOCALE) {
  if (Array.isArray(raw)) {
    return raw.length > 0 ? resolveSpecLocale(raw, DEFAULT_LOCALE) : DEFAULT_LOCALE
  }
  if (raw == null) {
    return resolveSpecLocale(systemLocale, DEFAULT_LOCALE)
  }
  if (typeof raw !== 'string') {
    return DEFAULT_LOCALE
  }
  const cleaned = stripLocaleSuffix(raw).toLowerCase()
  if (!cleaned || cleaned === SYSTEM_LOCALE || cleaned === 'auto' || cleaned === 'default') {
    return resolveSpecLocale(systemLocale, DEFAULT_LOCALE)
  }
  return resolveSpecLocale(raw, DEFAULT_LOCALE)
}
