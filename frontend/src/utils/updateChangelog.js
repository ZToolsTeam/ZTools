import { getCurrentLocale } from '@/i18n'
import { matchSupportedLocale, resolveLocale } from '@/utils/locale'

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按当前规范 locale 解析客户端更新日志：
 * 1. 优先从 `data.changelogI18n`（兼容 `changelog_i18n`）精确匹配当前规范语种（如 'zh-CN' / 'en-US'）；
 * 2. 其次严格匹配 map 中未归一化的受支持语种键（如 'en' / 'zh' / 'en_US'），绝不把第三语种（如 'ja-JP' / 'fr-FR'）误判为 'en-US'；
 * 3. 缺失或为空时安全回退默认 `data.changelog`。
 *
 * @param {{ changelog?: string, changelogI18n?: Record<string, string> | null, changelog_i18n?: Record<string, string> | null } | null | undefined} data
 * @param {string} [locale]
 * @returns {string}
 */
export function resolveLocalizedChangelog(data, locale) {
  if (!isPlainRecord(data)) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const i18nMap = isPlainRecord(data.changelogI18n)
    ? data.changelogI18n
    : (isPlainRecord(data.changelog_i18n) ? data.changelog_i18n : null)

  if (i18nMap) {
    const exact = i18nMap[targetLocale]
    if (typeof exact === 'string' && exact.trim()) {
      return exact
    }
    for (const [key, val] of Object.entries(i18nMap)) {
      if (typeof val !== 'string' || !val.trim()) continue
      if (matchSupportedLocale(key) === targetLocale) {
        return val
      }
    }
  }

  return typeof data.changelog === 'string' ? data.changelog : ''
}
