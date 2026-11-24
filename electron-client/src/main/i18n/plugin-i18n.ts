import { getResolvedLocale, matchSupportedLocale, type SupportedLocale } from './index.js'

/** 插件市场 7 大标准分类 slug（与 @ztools/plugins-spec 对齐） */
export const PLUGIN_CATEGORY_IDS = [
  'productivity',
  'system',
  'files',
  'media',
  'developer',
  'network',
  'security'
] as const

export type PluginCategoryId = (typeof PLUGIN_CATEGORY_IDS)[number]

const PLUGIN_CATEGORY_ID_SET: ReadonlySet<string> = new Set(PLUGIN_CATEGORY_IDS)

/** 旧版插件清单中文分类别名到标准 categoryId slug 的兼容归一化映射 */
const LEGACY_CATEGORY_ALIASES: Readonly<Record<string, PluginCategoryId>> = Object.freeze({
  办公效率: 'productivity', // i18n-allow: legacy Chinese category alias
  效率工具: 'productivity', // i18n-allow: legacy Chinese category alias
  效率: 'productivity', // i18n-allow: legacy Chinese category alias
  系统工具: 'system', // i18n-allow: legacy Chinese category alias
  系统管理: 'system', // i18n-allow: legacy Chinese category alias
  文件管理: 'files', // i18n-allow: legacy Chinese category alias
  文件工具: 'files', // i18n-allow: legacy Chinese category alias
  图像媒体: 'media', // i18n-allow: legacy Chinese category alias
  媒体工具: 'media', // i18n-allow: legacy Chinese category alias
  影音媒体: 'media', // i18n-allow: legacy Chinese category alias
  开发工具: 'developer', // i18n-allow: legacy Chinese category alias
  开发者: 'developer', // i18n-allow: legacy Chinese category alias
  网络工具: 'network', // i18n-allow: legacy Chinese category alias
  网络: 'network', // i18n-allow: legacy Chinese category alias
  安全隐私: 'security', // i18n-allow: legacy Chinese category alias
  安全工具: 'security' // i18n-allow: legacy Chinese category alias
})

/** 将标准分类 slug 或旧版中文分类名归一化为标准 categoryId；非法值返回 null */
export function normalizePluginCategoryId(value: unknown): PluginCategoryId | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (PLUGIN_CATEGORY_ID_SET.has(lower)) return lower as PluginCategoryId
  return Object.hasOwn(LEGACY_CATEGORY_ALIASES, trimmed) ? LEGACY_CATEGORY_ALIASES[trimmed]! : null
}

/** 从插件清单提取标准 categoryId 列表（优先读取 manifest.categoryId，缺失时兼容归一化 manifest.category） */
export function resolvePluginCategoryIds(manifest: Record<string, unknown>): PluginCategoryId[] {
  const source = manifest.categoryId !== undefined ? manifest.categoryId : manifest.category
  const rawList = Array.isArray(source) ? source : source !== undefined ? [source] : []
  const seen = new Set<PluginCategoryId>()
  const result: PluginCategoryId[] = []
  for (const item of rawList) {
    const normalized = normalizePluginCategoryId(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= 2) break
  }
  return result
}

/** 单个插件功能的本地化元数据 */
export interface LocalizedPluginFeature {
  readonly explain?: string
  readonly cmds?: readonly unknown[]
}

const MAX_KEYWORD_LENGTH = 128
const MAX_KEYWORDS_COUNT = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyTrimmedString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function extractStringKeywords(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/)
      : []
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_KEYWORD_LENGTH) continue
    result.push(trimmed)
  }
  return result
}

function extractCommandSearchTerms(cmds: unknown): string[] {
  if (!Array.isArray(cmds)) return []
  const result: string[] = []
  for (const cmd of cmds) {
    if (typeof cmd === 'string') {
      const trimmed = cmd.trim()
      if (trimmed.length > 0 && trimmed.length <= MAX_KEYWORD_LENGTH) {
        result.push(trimmed)
      }
      continue
    }
    if (isRecord(cmd)) {
      const label = nonEmptyTrimmedString(cmd.label)
      if (label.length > 0 && label.length <= MAX_KEYWORD_LENGTH) {
        result.push(label)
      }
    }
  }
  return result
}

function findLocaleI18nEntry(
  manifest: Record<string, unknown>,
  targetLocale: SupportedLocale
): Record<string, unknown> | undefined {
  const rawI18n = manifest.i18n
  if (!isRecord(rawI18n)) return undefined
  const direct = rawI18n[targetLocale]
  if (isRecord(direct)) return direct
  // 兼容仅声明短标签（如 zh / en / zh-Hans）的清单；严格匹配避免第三语种（如 ja-JP/fr-FR）被误判为 en-US
  for (const [key, entry] of Object.entries(rawI18n)) {
    if (!isRecord(entry)) continue
    if (matchSupportedLocale(key) === targetLocale) {
      return entry
    }
  }
  return undefined
}

function findTopLevelFeature(
  manifest: Record<string, unknown>,
  featureCode: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(manifest.features)) return undefined
  for (const item of manifest.features) {
    if (isRecord(item) && item.code === featureCode) {
      return item
    }
  }
  return undefined
}

/**
 * 读取指定语言下的插件名称（优先 manifest.i18n[locale].name，回退 manifest.name / manifest.id）
 */
export function getLocalizedPluginName(
  manifest: Record<string, unknown>,
  locale?: SupportedLocale
): string {
  const targetLocale = locale ?? getResolvedLocale()
  const entry = findLocaleI18nEntry(manifest, targetLocale)
  const localized = nonEmptyTrimmedString(entry?.name)
  if (localized) return localized
  const fallback = nonEmptyTrimmedString(manifest.name)
  if (fallback) return fallback
  return nonEmptyTrimmedString(manifest.id)
}

/**
 * 读取指定语言下的插件简介（优先 manifest.i18n[locale].description，回退 manifest.description）
 */
export function getLocalizedPluginDescription(
  manifest: Record<string, unknown>,
  locale?: SupportedLocale
): string {
  const targetLocale = locale ?? getResolvedLocale()
  const entry = findLocaleI18nEntry(manifest, targetLocale)
  const localized = nonEmptyTrimmedString(entry?.description)
  if (localized) return localized
  return nonEmptyTrimmedString(manifest.description)
}

/**
 * 读取指定语言下的插件关键词列表（优先 manifest.i18n[locale].keywords，回退顶层 keywords / keyword）
 */
export function getLocalizedPluginKeywords(
  manifest: Record<string, unknown>,
  locale?: SupportedLocale
): string[] {
  const targetLocale = locale ?? getResolvedLocale()
  const entry = findLocaleI18nEntry(manifest, targetLocale)
  if (entry && Array.isArray(entry.keywords)) {
    const localizedKeywords = extractStringKeywords(entry.keywords)
    if (localizedKeywords.length > 0) {
      return localizedKeywords.slice(0, MAX_KEYWORDS_COUNT)
    }
  }
  const fallback = manifest.keywords !== undefined ? manifest.keywords : manifest.keyword
  return extractStringKeywords(fallback).slice(0, MAX_KEYWORDS_COUNT)
}

/**
 * 读取指定语言下某个 feature code 对应的 explain 与 cmds，缺省字段回退至顶层 manifest.features
 */
export function getLocalizedPluginFeature(
  manifest: Record<string, unknown>,
  featureCode: string,
  locale?: SupportedLocale
): LocalizedPluginFeature {
  if (!featureCode) return {}
  const targetLocale = locale ?? getResolvedLocale()
  const entry = findLocaleI18nEntry(manifest, targetLocale)
  const i18nFeatures = isRecord(entry?.features) ? entry.features : undefined
  const localizedFeature = isRecord(i18nFeatures?.[featureCode])
    ? i18nFeatures[featureCode]
    : undefined
  const baseFeature = findTopLevelFeature(manifest, featureCode)

  const explain = nonEmptyTrimmedString(localizedFeature?.explain) ||
    nonEmptyTrimmedString(baseFeature?.explain)
  const cmds = Array.isArray(localizedFeature?.cmds)
    ? localizedFeature.cmds
    : Array.isArray(baseFeature?.cmds)
      ? baseFeature.cmds
      : undefined

  return {
    ...(explain ? { explain } : {}),
    ...(cmds ? { cmds } : {})
  }
}

/**
 * 提取对向语言及其他语言中的插件别名（去重并排除当前语言主显示名），用于跨语言互搜
 */
export function getPluginAltNames(
  manifest: Record<string, unknown>,
  locale?: SupportedLocale
): string[] {
  const targetLocale = locale ?? getResolvedLocale()
  const primaryName = getLocalizedPluginName(manifest, targetLocale)
  const seen = new Set<string>()
  const altNames: string[] = []
  const add = (candidate: unknown): void => {
    const trimmed = nonEmptyTrimmedString(candidate)
    if (!trimmed || trimmed === primaryName || trimmed.length > MAX_KEYWORD_LENGTH || seen.has(trimmed)) {
      return
    }
    seen.add(trimmed)
    altNames.push(trimmed)
  }

  add(manifest.name)
  if (Array.isArray(manifest.altNames)) {
    for (const item of manifest.altNames) add(item)
  }
  if (isRecord(manifest.i18n)) {
    for (const entry of Object.values(manifest.i18n)) {
      if (isRecord(entry)) add(entry.name)
    }
  }
  return altNames
}

/**
 * 汇总插件在全部语言下的搜索关键词与命令别名（顶层 keywords/keyword、各语言 keywords、对向语言名称、顶层与各语言 features.cmds）
 */
export function getAllPluginSearchKeywords(
  manifest: Record<string, unknown>,
  locale?: SupportedLocale
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const pushAll = (items: readonly string[]): void => {
    for (const item of items) {
      const trimmed = item.trim()
      if (trimmed.length === 0 || trimmed.length > MAX_KEYWORD_LENGTH || seen.has(trimmed)) {
        continue
      }
      seen.add(trimmed)
      result.push(trimmed)
      if (result.length >= MAX_KEYWORDS_COUNT) return
    }
  }

  // 1. 当前语言关键词与顶层关键词
  pushAll(getLocalizedPluginKeywords(manifest, locale))
  pushAll(extractStringKeywords(manifest.keywords !== undefined ? manifest.keywords : manifest.keyword))

  // 2. 跨语言备用名称（含默认名称及各 i18n 语言名称）
  pushAll(getPluginAltNames(manifest, locale))

  // 3. 所有语言条目下的 keywords 与 features[code].cmds
  if (isRecord(manifest.i18n)) {
    for (const entry of Object.values(manifest.i18n)) {
      if (!isRecord(entry)) continue
      pushAll(extractStringKeywords(entry.keywords))
      if (isRecord(entry.features)) {
        for (const feature of Object.values(entry.features)) {
          if (!isRecord(feature)) continue
          pushAll(extractCommandSearchTerms(feature.cmds))
        }
      }
      if (result.length >= MAX_KEYWORDS_COUNT) break
    }
  }

  // 4. 顶层 features[*].cmds
  if (result.length < MAX_KEYWORDS_COUNT && Array.isArray(manifest.features)) {
    for (const feature of manifest.features) {
      if (!isRecord(feature)) continue
      pushAll(extractCommandSearchTerms(feature.cmds))
      if (result.length >= MAX_KEYWORDS_COUNT) break
    }
  }

  return result
}
