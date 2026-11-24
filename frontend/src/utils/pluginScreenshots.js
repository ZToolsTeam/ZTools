/**
 * 插件详情页截图的数据整理（插件市场目录条目与随客户端内置插件共用）
 *
 * - 插件市场：目录条目的 screenshots 与 i18n[locale].screenshots 由发布脚本写入 [{ url, title, width, height }]，
 *   只接受 https 地址（当调用方显式提供可信 https baseUrl 时可兼容安全相对路径兜底）；
 *   其它协议（javascript:、data:、file: 等）与格式不对的条目直接丢弃，最多保留 5 张；
 * - 内置插件：截图随客户端分发，地址由 bundledPlugins.js 按本地副本生成，不经过这里，也不回退到网络。
 */

export const MAX_PLUGIN_SCREENSHOTS = 5

const SAFE_RELATIVE_SCREENSHOT_PATH =
  /^screenshots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** 目录条目里的截图地址是否可以展示：只认 https，且不含空白与引号 */
export function isSafeCatalogScreenshotUrl(url) {
  if (typeof url !== 'string' || !url || /[\s"'<>\\]/.test(url)) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 从市场目录条目中提取可信的 https 基准目录 URL（用于相对路径截图的安全兜底解析）。
 * @param {unknown} item
 * @returns {string}
 */
export function resolveCatalogScreenshotBaseUrl(item) {
  if (!isPlainRecord(item)) return ''
  const candidates = [item.screenshotBaseUrl, item.cdnBaseUrl, item.icon, item.downloadUrl]
  for (const raw of candidates) {
    if (!isSafeCatalogScreenshotUrl(raw)) continue
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

function resolveCatalogScreenshotUrl(shot, safeBaseUrl) {
  if (isSafeCatalogScreenshotUrl(shot.url)) {
    return shot.url
  }
  if (!safeBaseUrl) return ''

  const rawRel =
    typeof shot.url === 'string' && shot.url.trim()
      ? shot.url.trim()
      : (typeof shot.file === 'string' && shot.file.trim()
          ? shot.file.trim()
          : (typeof shot.path === 'string' && shot.path.trim() ? shot.path.trim() : ''))
  if (!rawRel || !SAFE_RELATIVE_SCREENSHOT_PATH.test(rawRel)) {
    return ''
  }
  try {
    const resolved = new URL(rawRel, safeBaseUrl).href
    return isSafeCatalogScreenshotUrl(resolved) ? resolved : ''
  } catch {
    return ''
  }
}

/**
 * 整理目录条目的截图列表
 * @param {unknown} raw
 * @param {{ baseUrl?: string }} [options]
 * @returns {Array<{ url: string, title: string, width?: number, height?: number }>}
 */
export function normalizeCatalogScreenshots(raw, options = {}) {
  if (!Array.isArray(raw)) return []
  const safeBaseUrl = isSafeCatalogScreenshotUrl(options?.baseUrl) ? options.baseUrl : ''
  const out = []
  for (const shot of raw) {
    if (!isPlainRecord(shot)) continue
    const url = resolveCatalogScreenshotUrl(shot, safeBaseUrl)
    if (!url) continue
    out.push({
      url,
      title: typeof shot.title === 'string' ? shot.title : '',
      width: positiveInt(shot.width),
      height: positiveInt(shot.height)
    })
    if (out.length >= MAX_PLUGIN_SCREENSHOTS) break
  }
  return out
}

/**
 * 归一化市场目录条目的 i18n[locale].screenshots（仅保留合法 https 截图，剔除无效协议与未解析相对路径）
 * @param {unknown} rawI18n
 * @param {{ baseUrl?: string }} [options]
 * @returns {object | undefined}
 */
export function normalizeCatalogI18nScreenshots(rawI18n, options = {}) {
  if (!isPlainRecord(rawI18n)) return undefined
  const out = {}
  let hasAny = false
  for (const [loc, entry] of Object.entries(rawI18n)) {
    if (FORBIDDEN_KEYS.has(loc) || !isPlainRecord(entry)) continue
    hasAny = true
    const nextEntry = { ...entry }
    if (Object.hasOwn(entry, 'screenshots')) {
      const normalizedShots = normalizeCatalogScreenshots(entry.screenshots, options)
      if (normalizedShots.length > 0) {
        nextEntry.screenshots = normalizedShots
      } else {
        delete nextEntry.screenshots
      }
    }
    out[loc] = nextEntry
  }
  return hasAny ? out : undefined
}

/**
 * 移除插件 i18n 字典中各语种的 screenshots 字段（防远程网络截图混入内置插件或未上传本地路径覆盖 CDN 截图）
 * @param {unknown} rawI18n
 * @returns {object | undefined}
 */
export function stripI18nScreenshots(rawI18n) {
  if (!isPlainRecord(rawI18n)) return undefined
  const out = {}
  let hasAny = false
  for (const [loc, entry] of Object.entries(rawI18n)) {
    if (FORBIDDEN_KEYS.has(loc) || !isPlainRecord(entry)) continue
    const nextEntry = { ...entry }
    delete nextEntry.screenshots
    if (Object.keys(nextEntry).length > 0) {
      hasAny = true
      out[loc] = nextEntry
    }
  }
  return hasAny ? out : undefined
}
