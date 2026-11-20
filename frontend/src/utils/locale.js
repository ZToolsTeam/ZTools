/**
 * 应用语言（Locale）归一化与解析工具。
 * 纯函数实现，不依赖浏览器全局对象，确保在 Node / Electron 主进程 / Vitest 环境下均可直接复用。
 */

export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US'])

export const DEFAULT_LOCALE = 'en-US'

export const LOCALE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'system', labelKey: 'settings.language.system', nativeLabel: 'System' }),
  Object.freeze({ value: 'zh-CN', labelKey: 'settings.language.zhCN', nativeLabel: '简体中文' }),
  Object.freeze({ value: 'en-US', labelKey: 'settings.language.enUS', nativeLabel: 'English' })
])

function normalizeLocaleTag(input) {
  if (typeof input !== 'string') return DEFAULT_LOCALE
  const cleaned = input.trim().split(/[.@]/)[0].replace(/_/g, '-').toLowerCase()
  if (!cleaned) return DEFAULT_LOCALE
  const primary = cleaned.split('-')[0]
  if (primary === 'zh') {
    return 'zh-CN'
  }
  return DEFAULT_LOCALE
}

/**
 * 将用户配置或系统语言标识解析为受支持的规范 Locale（'zh-CN' | 'en-US'）。
 * - 当 raw 为空（null / undefined / 空串）或 'system'（忽略大小写与首尾空白）时，对 systemLocale 执行归一化；
 * - 中文系 BCP-47 / POSIX 标签（zh / zh-CN / zh-Hans* / zh-SG / zh-TW / zh-HK / zh-Hant* 等）统一归一化为 'zh-CN'；
 * - 英文系及其他非中文语言、或非法输入统一兜底为 DEFAULT_LOCALE（'en-US'）。
 */
export function resolveLocale(raw, systemLocale = DEFAULT_LOCALE) {
  if (raw == null) {
    return normalizeLocaleTag(systemLocale)
  }
  if (typeof raw !== 'string') {
    return DEFAULT_LOCALE
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === 'system') {
    return normalizeLocaleTag(systemLocale)
  }
  return normalizeLocaleTag(trimmed)
}
