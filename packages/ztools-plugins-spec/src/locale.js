/**
 * ZTools 全端语言归一化单一信源（零 Node 依赖，浏览器 / Electron / Bun / Node 通用）
 *
 * 核心语义约束：
 * 1. stripLocaleSuffix：统一修剪空白、剥离 POSIX `.UTF-8` / `@euro` 等后缀并将 `_` 转为 `-`。
 * 2. matchSupportedLocale：严格匹配受支持语言，遇到空值、`'system'` 或第三语种（如 `ja-JP`/`fr-FR`）
 *    必须返回 `null`，严禁静默归类为 `en-US`（根除 Accept-Language 截断与第三语种误判）。
 * 3. resolveLocale：接受单个候选或候选列表，跳过空值与 `'system'`，返回首个命中的受支持语言，
 *    全部未命中时才回退到 `fallback`（默认 `'en-US'`）。
 */

export const DEFAULT_LOCALE = 'zh-CN'
export const FALLBACK_LOCALE = 'en-US'
export const SYSTEM_LOCALE = 'system'
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US'])

/**
 * 清理语言标签：去首尾空白、剥离 POSIX `.UTF-8` / `@...` 后缀、将 `_` 替换为 `-`。
 * @param {unknown} raw
 * @returns {string}
 */
export function stripLocaleSuffix(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withoutPosix = trimmed.split(/[.@]/)[0] || ''
  return withoutPosix.trim().replace(/_/g, '-')
}

/**
 * 严格匹配当前 ZTools 支持的语言标签。
 * 未命中、空值、`'system'` 或第三语种（如 `ja-JP`、`fr-FR`、`ko-KR`）返回 `null`。
 * @param {unknown} raw
 * @returns {'zh-CN' | 'en-US' | null}
 */
export function matchSupportedLocale(raw) {
  const cleaned = stripLocaleSuffix(raw)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  if (lower === SYSTEM_LOCALE || lower === 'auto' || lower === 'default') {
    return null
  }
  if (lower === 'zh' || lower.startsWith('zh-')) {
    return 'zh-CN'
  }
  if (lower === 'en' || lower.startsWith('en-')) {
    return 'en-US'
  }
  return null
}

/**
 * 是否为受支持的标准语言标签（严格值检查）。
 * @param {unknown} value
 * @returns {value is 'zh-CN' | 'en-US'}
 */
export function isSupportedLocale(value) {
  return value === 'zh-CN' || value === 'en-US'
}

/**
 * 按候选优先级解析最终生效语言。
 * 支持传入单个值或数组；遇到空值、`'system'` 或非支持语言会自动顺延到下一个候选，
 * 全部未命中时回退至 `fallback`（默认 `'en-US'`）。
 *
 * @param {unknown | readonly unknown[]} candidates
 * @param {'zh-CN' | 'en-US'} [fallback='en-US']
 * @returns {'zh-CN' | 'en-US'}
 */
export function resolveLocale(candidates, fallback = FALLBACK_LOCALE) {
  const safeFallback = isSupportedLocale(fallback) ? fallback : FALLBACK_LOCALE
  const list = Array.isArray(candidates) ? candidates : [candidates]
  for (const item of list) {
    const matched = matchSupportedLocale(item)
    if (matched) return matched
  }
  return safeFallback
}

/**
 * 归一化用户持久化语言设置（保留 `'system'`，其余严格匹配受支持语言，非法值默认 `'system'`）。
 * @param {unknown} raw
 * @param {'system' | 'zh-CN' | 'en-US'} [fallback='system']
 * @returns {'system' | 'zh-CN' | 'en-US'}
 */
export function normalizeLocaleSetting(raw, fallback = SYSTEM_LOCALE) {
  const cleaned = stripLocaleSuffix(raw).toLowerCase()
  if (cleaned === SYSTEM_LOCALE) return SYSTEM_LOCALE
  const matched = matchSupportedLocale(cleaned)
  if (matched) return matched
  if (fallback === SYSTEM_LOCALE || isSupportedLocale(fallback)) return fallback
  return SYSTEM_LOCALE
}
