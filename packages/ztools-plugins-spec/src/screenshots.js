import { SCREENSHOT_PATH_REGEX } from './validator.js'

/**
 * 统一收集插件清单中声明的全部截图（顶层默认截图 + i18n 多语言截图）。
 * 顶层 screenshots[] 使用 `path` 字段，i18n[locale].screenshots[] 使用 `file` 字段，
 * 统一经 SCREENSHOT_PATH_REGEX 校验过滤，防止路径穿越或非法格式。
 *
 * @param {Record<string, unknown> | null | undefined} manifest
 * @returns {Array<{ locale: string, rel: string, title?: string }>}
 */
export function collectDeclaredScreenshots(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return []
  }

  const results = []
  const seen = new Set()

  const pushEntry = (locale, rawRel, rawTitle) => {
    if (typeof rawRel !== 'string') return
    const rel = rawRel.trim()
    if (!SCREENSHOT_PATH_REGEX.test(rel)) return
    const dedupeKey = `${locale}::${rel}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    const entry = { locale, rel }
    if (typeof rawTitle === 'string' && rawTitle.trim().length > 0) {
      entry.title = rawTitle
    }
    results.push(entry)
  }

  if (Array.isArray(manifest.screenshots)) {
    for (const shot of manifest.screenshots) {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) continue
      pushEntry('default', shot.path, shot.title)
    }
  }

  const i18n = manifest.i18n
  if (i18n && typeof i18n === 'object' && !Array.isArray(i18n)) {
    for (const [locale, entry] of Object.entries(i18n)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!Array.isArray(entry.screenshots)) continue
      for (const shot of entry.screenshots) {
        if (!shot || typeof shot !== 'object' || Array.isArray(shot)) continue
        pushEntry(locale, shot.file, shot.title)
      }
    }
  }

  return results
}

/**
 * 返回清单声明的全部截图相对路径（跨语言去重，保持声明顺序）。
 *
 * @param {Record<string, unknown> | null | undefined} manifest
 * @returns {string[]}
 */
export function collectDeclaredScreenshotPaths(manifest) {
  const seen = new Set()
  const paths = []
  for (const item of collectDeclaredScreenshots(manifest)) {
    if (seen.has(item.rel)) continue
    seen.add(item.rel)
    paths.push(item.rel)
  }
  return paths
}
