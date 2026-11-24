import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

/**
 * 主进程语言归一化与翻译模块。
 * 受 electron-client/tsconfig.json `rootDir: "src"` 限制，locale 归一化逻辑与
 * 单一信源 `packages/ztools-plugins-spec/src/locale.js` 保持 100% 同构：
 * 1. stripLocaleSuffix：修剪空白、剥离 POSIX `.UTF-8` / `@euro` 等后缀并将 `_` 转为 `-`；
 * 2. matchSupportedLocale：严格匹配受支持语言，空值 / `'system'` / `'auto'` / `'default'` / 第三语种返回 `null`；
 * 3. resolveLocale：兼容数组候选模式与 `(raw, systemLocale)` 两参模式，终态才回退 `en-US`。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocaleSetting = 'system' | SupportedLocale
export const SYSTEM_LOCALE = 'system' as const
export const DEFAULT_LOCALE: SupportedLocale = 'en-US'
export const ZTOOLS_LOCALE_ENV_KEY = 'ZTOOLS_LOCALE'

type Dictionary = Readonly<Record<string, string>>

const DICTIONARIES: Record<SupportedLocale, Dictionary> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

/**
 * 清理语言标签：去首尾空白、剥离 POSIX `.UTF-8` / `@...` 后缀、将 `_` 替换为 `-`。
 * 与 `packages/ztools-plugins-spec/src/locale.js#stripLocaleSuffix` 100% 同构。
 */
export function stripLocaleSuffix(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withoutPosix = trimmed.split(/[.@]/)[0] ?? ''
  return withoutPosix.trim().replaceAll('_', '-')
}

function normalizeTag(value: unknown): string {
  return stripLocaleSuffix(value).toLowerCase()
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'zh-CN' || value === 'en-US'
}

/**
 * 严格匹配受支持的规范语种：仅中文系返回 zh-CN、英文系返回 en-US，
 * 空值、system / auto / default、第三语种（如 ja-JP / fr-FR / ko-KR）或非法输入一律返回 null。
 * 与 `packages/ztools-plugins-spec/src/locale.js#matchSupportedLocale` 100% 同构。
 */
export function matchSupportedLocale(value: unknown): SupportedLocale | null {
  const lower = normalizeTag(value)
  if (!lower || lower === SYSTEM_LOCALE || lower === 'auto' || lower === 'default') {
    return null
  }
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN'
  if (lower === 'en' || lower.startsWith('en-')) return 'en-US'
  return null
}

/**
 * 归一化用户持久化语言设置（保留 `'system'`，其余严格匹配受支持语言，非法值回退 `fallback`）。
 * 与 `packages/ztools-plugins-spec/src/locale.js#normalizeLocaleSetting` 100% 同构。
 */
export function normalizeLocaleSetting(
  raw: unknown,
  fallback: LocaleSetting = SYSTEM_LOCALE
): LocaleSetting {
  const cleaned = normalizeTag(raw)
  if (cleaned === SYSTEM_LOCALE) return SYSTEM_LOCALE
  const matched = matchSupportedLocale(cleaned)
  if (matched) return matched
  if (fallback === SYSTEM_LOCALE || isSupportedLocale(fallback)) return fallback
  return SYSTEM_LOCALE
}

/**
 * 解析最终生效语言。
 * - 数组候选模式：`resolveLocale(['system', 'fr-FR', 'zh_CN.UTF-8'], fallback?)` 跳过空值/`'system'`/第三语种，命中首个受支持语言；
 * - 两参模式：`resolveLocale(raw, systemLocale)` 当 `raw` 为空或 `'system'` 时解析 `systemLocale`，否则直接解析 `raw`，未命中回退 `DEFAULT_LOCALE`（`'en-US'`）。
 */
export function resolveLocale(
  raw?: string | null | readonly unknown[],
  systemLocale?: string | null
): SupportedLocale {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const matched = matchSupportedLocale(item)
      if (matched) return matched
    }
    return isSupportedLocale(systemLocale) ? systemLocale : DEFAULT_LOCALE
  }
  const normalizedRaw = normalizeTag(raw)
  if (
    !normalizedRaw ||
    normalizedRaw === SYSTEM_LOCALE ||
    normalizedRaw === 'auto' ||
    normalizedRaw === 'default'
  ) {
    return matchSupportedLocale(systemLocale) ?? DEFAULT_LOCALE
  }
  return matchSupportedLocale(normalizedRaw) ?? DEFAULT_LOCALE
}

function detectRuntimeSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return DEFAULT_LOCALE
  }
}

const initialEnvLocale = typeof process.env[ZTOOLS_LOCALE_ENV_KEY] === 'string'
  ? process.env[ZTOOLS_LOCALE_ENV_KEY].trim()
  : ''

let lastSystemLocale: string = detectRuntimeSystemLocale()
let currentLocaleSetting: LocaleSetting = initialEnvLocale
  ? (normalizeTag(initialEnvLocale) === SYSTEM_LOCALE ? SYSTEM_LOCALE : resolveLocale(initialEnvLocale, lastSystemLocale))
  : SYSTEM_LOCALE
let currentResolvedLocale: SupportedLocale = initialEnvLocale
  ? resolveLocale(initialEnvLocale, lastSystemLocale)
  : resolveLocale(SYSTEM_LOCALE, lastSystemLocale)

/** 将当前生效的规范 locale 同步写入进程环境变量 ZTOOLS_LOCALE 与 globalThis.__ztoolsLocale，供原生 DLL、子进程与共享包即时继承 */
export function syncProcessLocaleEnv(locale?: SupportedLocale): SupportedLocale {
  const resolved = locale ?? currentResolvedLocale
  process.env[ZTOOLS_LOCALE_ENV_KEY] = resolved
  ;(globalThis as typeof globalThis & { __ztoolsLocale?: SupportedLocale }).__ztoolsLocale = resolved
  return resolved
}

syncProcessLocaleEnv(currentResolvedLocale)

export function getLocaleSetting(): LocaleSetting {
  return currentLocaleSetting
}

export function getResolvedLocale(): SupportedLocale {
  return currentResolvedLocale
}

export function setLocale(
  setting: unknown,
  systemLocale?: string | null
): SupportedLocale {
  if (typeof systemLocale === 'string' && systemLocale.trim().length > 0) {
    lastSystemLocale = systemLocale.trim()
  }
  const normalized = normalizeTag(setting)
  if (!normalized || normalized === SYSTEM_LOCALE) {
    currentLocaleSetting = SYSTEM_LOCALE
    currentResolvedLocale = resolveLocale(SYSTEM_LOCALE, lastSystemLocale)
    return syncProcessLocaleEnv(currentResolvedLocale)
  }
  const resolved = resolveLocale(normalized, lastSystemLocale)
  currentLocaleSetting = resolved
  currentResolvedLocale = resolved
  return syncProcessLocaleEnv(currentResolvedLocale)
}

/** 按未转义的 `|` 拆分复数段，并将段内 `\|` 还原为字面量 `|` */
function splitUnescapedPipes(template: string): string[] {
  const segments: string[] = []
  let current = ''
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch === '\\' && template[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (ch === '|') {
      segments.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current.trim())
  return segments
}

function selectPluralSegment(segments: readonly string[], count: number): string {
  if (segments.length <= 1) return segments[0] ?? ''
  const abs = Math.abs(count)
  if (segments.length === 2) {
    return (abs === 1 ? segments[0] : segments[1]) ?? ''
  }
  if (count === 0) return segments[0] ?? ''
  if (abs === 1) return segments[1] ?? ''
  return segments[2] ?? ''
}

function resolvePluralTemplate(
  template: string,
  params?: Readonly<Record<string, string | number>>
): string {
  if (!params) return template
  // 1. 内联复数段：[[var:singular|plural]] 或 [[var:zero|one|other]]
  let resolved = template.replace(
    /\[\[([A-Za-z0-9_]+):((?:\\.|[^\]])+)\]\]/g,
    (match, name: string, body: string) => {
      if (!Object.hasOwn(params, name)) return match
      const numeric = Number(params[name])
      if (!Number.isFinite(numeric)) return match
      return selectPluralSegment(splitUnescapedPipes(body), numeric)
    }
  )
  // 2. 整串 `|` 复数段：仅当显式传入有限数字 count 且模板含未转义 `|` 时生效
  const rawCount = Object.hasOwn(params, 'count') ? params.count : undefined
  if (typeof rawCount === 'number' && Number.isFinite(rawCount) && resolved.includes('|')) {
    const segments = splitUnescapedPipes(resolved)
    if (segments.length > 1) {
      resolved = selectPluralSegment(segments, rawCount)
    }
  }
  return resolved
}

export function t(
  key: string,
  params?: Readonly<Record<string, string | number>>,
  locale?: SupportedLocale
): string {
  const targetLocale = locale ?? currentResolvedLocale
  const dict = DICTIONARIES[targetLocale]
  const fallbackDict = DICTIONARIES[DEFAULT_LOCALE]
  const template = Object.hasOwn(dict, key)
    ? dict[key]
    : Object.hasOwn(fallbackDict, key)
      ? fallbackDict[key]
      : key
  if (!template) return key
  const pluralized = resolvePluralTemplate(template, params)
  // 单遍处理 `{{var}}` 字面量转义（输出 `{var}`）与 `{var}` 参数插值，防止二次替换
  return pluralized.replace(
    /\{\{([A-Za-z0-9_]+)\}\}|\{([A-Za-z0-9_]+)\}/g,
    (match, escapedName: string | undefined, varName: string | undefined) => {
      if (escapedName !== undefined) return `{${escapedName}}`
      if (varName !== undefined && params && Object.hasOwn(params, varName)) {
        return String(params[varName])
      }
      return match
    }
  )
}
