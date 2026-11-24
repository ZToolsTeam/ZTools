import { getCurrentLocale, t } from '@/i18n'
import { matchSupportedLocale, resolveLocale } from '@/utils/locale'
import {
  CATEGORY_ID_TO_NAME,
  DEFAULT_CATEGORY_ID,
  FAVORITES_CATEGORY_ID,
  getCategoryId,
  isAllCategory,
  normalizeCategoryIds
} from '@/utils/pluginCategories'

/**
 * 读取插件在指定 locale 下的本地化字段，缺失时自动回退到插件默认字段。
 * 兼容 plugin.i18n 与 plugin.manifest?.i18n；针对 revokedReason 同步兼容 revoked_reason 蛇形别名。
 * @param {object} plugin
 * @param {'name' | 'description' | 'revokedReason' | string} field
 * @param {string} [locale]
 * @returns {string}
 */
export function getLocalizedPluginField(plugin, field, locale) {
  if (!plugin || typeof plugin !== 'object' || !field) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const aliasField = field === 'revokedReason' ? 'revoked_reason' : (field === 'revoked_reason' ? 'revokedReason' : '')

  for (const i18nMap of getPluginI18nMaps(plugin)) {
    const entry = findLocaleEntry(i18nMap, targetLocale)
    if (!entry) continue
    const localized = entry[field] ?? (aliasField ? entry[aliasField] : undefined)
    if (typeof localized === 'string' && localized.trim()) {
      return localized.trim()
    }
  }

  const fallback = plugin[field] ?? (aliasField ? plugin[aliasField] : undefined)
  return typeof fallback === 'string' ? fallback.trim() : ''
}

/**
 * 获取插件本地化下架原因（优先 plugin.i18n?.[currentLocale]?.revokedReason，回退 revokedReason / revoked_reason）
 */
export function getLocalizedPluginRevokedReason(plugin, locale) {
  return getLocalizedPluginField(plugin, 'revokedReason', locale)
}

/**
 * 获取插件本地化显示名称（优先 plugin.i18n?.[currentLocale]?.name，回退 plugin.name / title / pluginId）
 */
export function getLocalizedPluginName(plugin, locale) {
  if (!plugin || typeof plugin !== 'object') return ''
  return (
    getLocalizedPluginField(plugin, 'name', locale) ||
    (typeof plugin.title === 'string' ? plugin.title.trim() : '') ||
    String(plugin.pluginId || plugin.id || '').trim()
  )
}

/**
 * 获取插件本地化简介（优先 plugin.i18n?.[currentLocale]?.description，回退 plugin.description）
 */
export function getLocalizedPluginDescription(plugin, locale) {
  if (!plugin || typeof plugin !== 'object') return ''
  return getLocalizedPluginField(plugin, 'description', locale)
}

/**
 * 收集插件的多语言备用名称，供中英/拼音无缝互搜使用（自动去重并排除当前主显示名）
 */
export function getLocalizedPluginAltNames(plugin, primaryName = '') {
  if (!plugin || typeof plugin !== 'object') return []
  const primary = String(primaryName || '').trim()
  const result = []
  const add = (val) => {
    if (typeof val !== 'string') return
    const trimmed = val.trim()
    if (!trimmed || trimmed === primary || result.includes(trimmed)) return
    result.push(trimmed)
  }

  add(plugin.name)
  add(plugin.title)
  if (Array.isArray(plugin.altNames)) {
    for (const alt of plugin.altNames) add(alt)
  }
  for (const i18nMap of getPluginI18nMaps(plugin)) {
    for (const entry of Object.values(i18nMap)) {
      if (isPlainRecord(entry)) {
        add(entry.name)
      }
    }
  }
  return result
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pickNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return ''
}

function getPluginI18nMaps(plugin) {
  if (!isPlainRecord(plugin)) return []
  const maps = []
  if (isPlainRecord(plugin.i18n)) maps.push(plugin.i18n)
  if (isPlainRecord(plugin.manifest?.i18n) && plugin.manifest.i18n !== plugin.i18n) {
    maps.push(plugin.manifest.i18n)
  }
  return maps
}

function findLocaleEntry(i18nMap, targetLocale) {
  if (!isPlainRecord(i18nMap) || !targetLocale) return null
  const exact = i18nMap[targetLocale]
  if (isPlainRecord(exact)) return exact
  for (const [key, entry] of Object.entries(i18nMap)) {
    if (!isPlainRecord(entry)) continue
    if (matchSupportedLocale(key) === targetLocale) {
      return entry
    }
  }
  return null
}

const SAFE_RELATIVE_SCREENSHOT_PATH =
  /^screenshots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/

function isAbsoluteScreenshotUrl(raw) {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (!trimmed || /[\s"'<>\\]/.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'ztools:' ||
      (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
    )
  } catch {
    return false
  }
}

function resolvePluginScreenshotBaseUrl(plugin) {
  if (!isPlainRecord(plugin)) return ''
  const candidates = [plugin.screenshotBaseUrl, plugin.cdnBaseUrl, plugin.icon, plugin.logo, plugin.downloadUrl]
  for (const raw of candidates) {
    if (!isAbsoluteScreenshotUrl(raw)) continue
    try {
      const parsed = new URL(raw)
      if (!parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.replace(/[^/]*$/, '')
      }
      parsed.search = ''
      parsed.hash = ''
      return parsed.href
    } catch {
      continue
    }
  }
  return ''
}

function resolveScreenshotUrl(shot, baseUrl) {
  const candidates = [shot.url, shot.file, shot.path]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (isAbsoluteScreenshotUrl(trimmed)) {
      return trimmed
    }
    if (baseUrl && SAFE_RELATIVE_SCREENSHOT_PATH.test(trimmed)) {
      try {
        const resolved = new URL(trimmed, baseUrl).href
        if (isAbsoluteScreenshotUrl(resolved)) {
          return resolved
        }
      } catch {
        continue
      }
    }
  }
  return ''
}

function extractValidScreenshots(rawList, plugin = null) {
  if (!Array.isArray(rawList)) return []
  const baseUrl = resolvePluginScreenshotBaseUrl(plugin)
  const valid = []
  for (const shot of rawList) {
    if (!isPlainRecord(shot)) continue
    const url = resolveScreenshotUrl(shot, baseUrl)
    if (!url) continue
    valid.push(shot.url === url ? shot : { ...shot, url })
  }
  return valid
}

/**
 * 读取插件在指定 locale 下的本地化截图列表：
 * 1. 按当前生效 locale（兼容 en / en_US / zh / zh-Hans 等受支持语种键）优先返回 `plugin.i18n?.[resolvedLocale]?.screenshots`（若有有效项）；
 * 2. 兼容 `shot.url || shot.file || shot.path`（相对路径仅在存在可信基准 URL 时解析，杜绝裸相对路径泄漏）；
 * 3. 若当前语言无有效截图则回退顶层 `plugin.screenshots`（及 `plugin.manifest?.screenshots`）；均无时返回空数组。
 *
 * @param {object} plugin
 * @param {string} [locale]
 * @returns {Array<{ url: string, title?: string, width?: number, height?: number }>}
 */
export function getLocalizedPluginScreenshots(plugin, locale) {
  if (!isPlainRecord(plugin)) return []
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()

  for (const i18nMap of getPluginI18nMaps(plugin)) {
    const entry = findLocaleEntry(i18nMap, targetLocale)
    if (!entry) continue
    const localizedShots = extractValidScreenshots(entry.screenshots, plugin)
    if (localizedShots.length > 0) {
      return localizedShots
    }
  }

  const topShots = extractValidScreenshots(plugin.screenshots, plugin)
  if (topShots.length > 0) {
    return topShots
  }
  return extractValidScreenshots(plugin.manifest?.screenshots, plugin)
}

function resolveFeatureCode(feat) {
  if (!isPlainRecord(feat)) return ''
  return pickNonEmptyString(feat.code, feat.id)
}

/**
 * 读取插件子命令（feature）在指定 locale 下的本地化说明文案：
 * 优先 plugin.i18n[targetLocale]?.features?.[feat.code]?.explain，
 * 其次兼容 feat.i18n，再回退 feat.explain || feat.label || feat.code。
 * @param {object} plugin
 * @param {object} feat
 * @param {string} [locale]
 * @returns {string}
 */
export function getLocalizedFeatureExplain(plugin, feat, locale) {
  if (!isPlainRecord(feat)) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const code = resolveFeatureCode(feat)

  if (code) {
    for (const i18nMap of getPluginI18nMaps(plugin)) {
      const featEntry = findLocaleEntry(i18nMap, targetLocale)?.features?.[code]
      if (isPlainRecord(featEntry)) {
        const localized = pickNonEmptyString(featEntry.explain, featEntry.label)
        if (localized) return localized
      }
    }
  }

  if (isPlainRecord(feat.i18n)) {
    const featLocaleEntry = findLocaleEntry(feat.i18n, targetLocale)
    if (isPlainRecord(featLocaleEntry)) {
      const localized = pickNonEmptyString(featLocaleEntry.explain, featLocaleEntry.label)
      if (localized) return localized
    }
  }

  return pickNonEmptyString(feat.explain, feat.label, code)
}

/**
 * 合并并解析插件子命令（feature）的本地化触发词列表：
 * 优先放入当前 locale 的 plugin.i18n[targetLocale]?.features?.[code]?.cmds（兼容 feat.i18n），
 * 再合并默认 feat.cmds 与对向语言 cmds（过滤非法元素并大小写不敏感去重，支持中英互搜）。
 * @param {object} plugin
 * @param {object} feat
 * @param {string} [locale]
 * @returns {Array<string|object>}
 */
export function getLocalizedFeatureCmds(plugin, feat, locale) {
  if (!isPlainRecord(feat)) return []
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const code = resolveFeatureCode(feat)
  const result = []
  const seen = new Set()

  const addCmds = (rawList) => {
    if (!Array.isArray(rawList)) return
    for (const cmd of rawList) {
      if (typeof cmd === 'string') {
        const trimmed = cmd.trim()
        if (!trimmed) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        result.push(trimmed)
      } else if (isPlainRecord(cmd)) {
        const label = pickNonEmptyString(cmd.label, cmd.value, cmd.name)
        if (!label) continue
        const lower = label.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        result.push(cmd)
      }
    }
  }

  const i18nMaps = getPluginI18nMaps(plugin)
  if (code) {
    for (const i18nMap of i18nMaps) {
      addCmds(findLocaleEntry(i18nMap, targetLocale)?.features?.[code]?.cmds)
    }
  }
  if (isPlainRecord(feat.i18n)) {
    addCmds(findLocaleEntry(feat.i18n, targetLocale)?.cmds)
  }

  addCmds(feat.cmds)

  if (code) {
    for (const i18nMap of i18nMaps) {
      for (const [loc, entry] of Object.entries(i18nMap)) {
        if (loc === targetLocale || matchSupportedLocale(loc) === targetLocale || !isPlainRecord(entry)) continue
        addCmds(entry.features?.[code]?.cmds)
      }
    }
  }
  if (isPlainRecord(feat.i18n)) {
    for (const [loc, entry] of Object.entries(feat.i18n)) {
      if (loc === targetLocale || matchSupportedLocale(loc) === targetLocale || !isPlainRecord(entry)) continue
      addCmds(entry.cmds)
    }
  }

  return result
}

/**
 * 收集子命令的多语言备用说明（自动去重并排除当前主显示名），供英文态/中文态互搜使用。
 * @param {object} plugin
 * @param {object} feat
 * @param {string} [primaryExplain]
 * @returns {string[]}
 */
export function getLocalizedFeatureAltNames(plugin, feat, primaryExplain = '') {
  if (!isPlainRecord(feat)) return []
  const primary = String(primaryExplain || '').trim()
  const primaryLower = primary.toLowerCase()
  const code = resolveFeatureCode(feat)
  const result = []
  const seen = new Set()

  const add = (val) => {
    if (typeof val !== 'string') return
    const trimmed = val.trim()
    if (!trimmed) return
    const lower = trimmed.toLowerCase()
    if (lower === primaryLower || seen.has(lower)) return
    seen.add(lower)
    result.push(trimmed)
  }

  add(feat.explain)
  add(feat.title)
  add(feat.name)
  add(feat.label)

  if (code) {
    for (const i18nMap of getPluginI18nMaps(plugin)) {
      for (const entry of Object.values(i18nMap)) {
        const featEntry = isPlainRecord(entry) ? entry.features?.[code] : null
        if (!isPlainRecord(featEntry)) continue
        add(featEntry.explain)
        add(featEntry.title)
        add(featEntry.name)
        add(featEntry.label)
      }
    }
  }

  if (isPlainRecord(feat.i18n)) {
    for (const entry of Object.values(feat.i18n)) {
      if (!isPlainRecord(entry)) continue
      add(entry.explain)
      add(entry.title)
      add(entry.name)
      add(entry.label)
    }
  }

  return result
}

/**
 * 收集插件当前语言、默认字段与对向语言的关键词集合（去重，供中英互搜使用）。
 * @param {object} plugin
 * @param {string} [locale]
 * @returns {string[]}
 */
export function getLocalizedPluginKeywords(plugin, locale) {
  if (!isPlainRecord(plugin)) return []
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const result = []
  const seen = new Set()

  const addKeywords = (raw) => {
    if (Array.isArray(raw)) {
      for (const kw of raw) {
        if (typeof kw !== 'string') continue
        const trimmed = kw.trim()
        if (!trimmed) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        result.push(trimmed)
      }
    } else if (typeof raw === 'string' && raw.trim()) {
      for (const part of raw.split(/[\s,，]+/)) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        result.push(trimmed)
      }
    }
  }

  const i18nMaps = getPluginI18nMaps(plugin)
  for (const i18nMap of i18nMaps) {
    addKeywords(findLocaleEntry(i18nMap, targetLocale)?.keywords)
  }

  addKeywords(plugin.keywords)
  if (plugin.manifest?.keywords !== plugin.keywords) {
    addKeywords(plugin.manifest?.keywords)
  }

  for (const i18nMap of i18nMaps) {
    for (const [loc, entry] of Object.entries(i18nMap)) {
      if (loc === targetLocale || matchSupportedLocale(loc) === targetLocale || !isPlainRecord(entry)) continue
      addKeywords(entry.keywords)
    }
  }

  return result
}

/**
 * 合并多个插件 i18n 字典（后者非空字段优先覆盖前者，对 features 按 code 浅合并）。
 * 若均无有效内容则返回 undefined，避免污染无多语言数据的插件对象。
 * @param {...(object|null|undefined)} maps
 * @returns {object|undefined}
 */
export function mergePluginI18n(...maps) {
  const merged = {}
  let hasEntry = false

  for (const map of maps) {
    if (!isPlainRecord(map)) continue
    for (const [loc, entry] of Object.entries(map)) {
      if (loc === '__proto__' || loc === 'constructor' || loc === 'prototype') continue
      if (!isPlainRecord(entry)) continue
      hasEntry = true
      const prev = isPlainRecord(merged[loc]) ? merged[loc] : {}
      const next = { ...prev }
      for (const [field, val] of Object.entries(entry)) {
        if (field === '__proto__' || field === 'constructor' || field === 'prototype') continue
        if (field === 'features' && isPlainRecord(val)) {
          const mergedFeatures = isPlainRecord(prev.features) ? { ...prev.features } : {}
          for (const [code, featVal] of Object.entries(val)) {
            if (code === '__proto__' || code === 'constructor' || code === 'prototype') continue
            if (!isPlainRecord(featVal)) continue
            mergedFeatures[code] = isPlainRecord(mergedFeatures[code])
              ? { ...mergedFeatures[code], ...featVal }
              : { ...featVal }
          }
          next.features = mergedFeatures
        } else if (val !== undefined && val !== null) {
          next[field] = val
        }
      }
      merged[loc] = next
    }
  }

  return hasEntry ? merged : undefined
}

/**
 * 将插件分类名或分类 ID 映射为当前语言的本地化分类标签
 */
export function getLocalizedCategoryName(nameOrId) {
  if (Array.isArray(nameOrId)) {
    const first = nameOrId.find((item) => typeof item === 'string' && item.trim())
    return first ? getLocalizedCategoryName(first) : ''
  }
  if (!nameOrId || typeof nameOrId !== 'string') return ''
  const trimmed = nameOrId.trim()
  if (!trimmed) return ''
  if (isAllCategory(trimmed)) {
    return t('categories.all')
  }
  if (trimmed.toLowerCase() === FAVORITES_CATEGORY_ID) {
    return t('categories.favorites')
  }
  const id = getCategoryId(trimmed)
  if (
    id === DEFAULT_CATEGORY_ID &&
    trimmed !== CATEGORY_ID_TO_NAME[DEFAULT_CATEGORY_ID] &&
    trimmed.toLowerCase() !== DEFAULT_CATEGORY_ID &&
    trimmed.toLowerCase() !== 'others'
  ) {
    return trimmed
  }
  return t(`categories.${id}`)
}

/**
 * 将插件 category 字段（字符串或数组）格式化为本地化分类名列表
 */
export function getLocalizedCategoryNames(value) {
  const ids = normalizeCategoryIds(value)
  return ids.map((id) => t(`categories.${id}`))
}
