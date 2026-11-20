import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocaleSetting = 'system' | SupportedLocale
export const DEFAULT_LOCALE: SupportedLocale = 'en-US'

type Dictionary = Readonly<Record<string, string>>

const DICTIONARIES: Record<SupportedLocale, Dictionary> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

function normalizeTag(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replaceAll('_', '-')
}

function isChineseTag(normalized: string): boolean {
  return (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized === 'zh-sg' ||
    normalized === 'zh-tw' ||
    normalized === 'zh-hk' ||
    normalized.startsWith('zh-hans') ||
    normalized.startsWith('zh-hant')
  )
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'zh-CN' || value === 'en-US'
}

export function resolveLocale(
  raw?: string | null,
  systemLocale?: string | null
): SupportedLocale {
  const normalizedRaw = normalizeTag(raw)
  const candidate = !normalizedRaw || normalizedRaw === 'system'
    ? normalizeTag(systemLocale)
    : normalizedRaw
  if (!candidate) return DEFAULT_LOCALE
  return isChineseTag(candidate) ? 'zh-CN' : DEFAULT_LOCALE
}

function detectRuntimeSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return DEFAULT_LOCALE
  }
}

let lastSystemLocale: string = detectRuntimeSystemLocale()
let currentLocaleSetting: LocaleSetting = 'system'
let currentResolvedLocale: SupportedLocale = resolveLocale('system', lastSystemLocale)

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
  if (!normalized || normalized === 'system') {
    currentLocaleSetting = 'system'
    currentResolvedLocale = resolveLocale('system', lastSystemLocale)
    return currentResolvedLocale
  }
  const resolved = resolveLocale(normalized, lastSystemLocale)
  currentLocaleSetting = resolved
  currentResolvedLocale = resolved
  return currentResolvedLocale
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
  if (!params) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ))
}
