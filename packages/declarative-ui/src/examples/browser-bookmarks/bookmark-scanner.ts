import { callHostTransport } from '../shared/native-ipc.js'
import type {
  BookmarkItem,
  BookmarkScannerOptions,
  BookmarkSourceInput,
  BrowserFilterValue,
  BrowserType,
  ScanBookmarksResponse
} from './types.js'

const PINYIN_DICT: Readonly<Record<string, string>> = Object.freeze({
  哔: 'bi',
  哩: 'li',
  百: 'bai',
  度: 'du',
  一: 'yi',
  下: 'xia',
  你: 'ni',
  就: 'jiu',
  知: 'zhi',
  道: 'dao',
  淘: 'tao',
  宝: 'bao',
  网: 'wang',
  天: 'tian',
  猫: 'mao',
  京: 'jing',
  东: 'dong',
  乎: 'hu',
  微: 'wei',
  信: 'xin',
  博: 'bo',
  飞: 'fei',
  书: 'shu',
  钉: 'ding',
  阿: 'a',
  里: 'li',
  云: 'yun',
  腾: 'teng',
  讯: 'xun',
  华: 'hua',
  为: 'wei',
  码: 'ma',
  企: 'qi',
  业: 'ye',
  研: 'yan',
  发: 'fa',
  效: 'xiao',
  能: 'neng',
  平: 'ping',
  台: 'tai',
  工: 'gong',
  作: 'zuo',
  生: 'sheng',
  产: 'chan',
  监: 'jian',
  控: 'kong',
  掘: 'jue',
  金: 'jin',
  开: 'kai',
  源: 'yuan',
  中: 'zhong',
  国: 'guo'
})

export function computePinyinIndex(text: string): { full: string; initials: string } {
  const clean = String(text || '').trim()
  let full = ''
  let initials = ''
  for (const ch of clean) {
    const py = PINYIN_DICT[ch]
    if (py) {
      full += py
      initials += py[0]
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      const lower = ch.toLowerCase()
      full += lower
      initials += lower
    }
  }
  return { full, initials }
}

export function isSafeHttpBookmarkUrl(rawUrl: string): boolean {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) return false
  if (/^(javascript|vbscript|data|file|place|about|chrome|edge):/i.test(trimmed)) {
    return false
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function formatBookmarkDate(tsMs: number): string {
  const safe = Number.isFinite(tsMs) && tsMs > 0 ? tsMs : Date.now()
  const d = new Date(safe)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function normalizeBookmarkEntry(raw: {
  id: string
  title: string
  url: string
  folderBreadcrumb?: string
  browser: BrowserType
  browserLabel: string
  dateAdded?: number
}): BookmarkItem | null {
  if (!isSafeHttpBookmarkUrl(raw.url)) {
    return null
  }
  const parsedUrl = new URL(raw.url.trim())
  const title = String(raw.title || parsedUrl.hostname).trim()
  const folderBreadcrumb = String(raw.folderBreadcrumb || '').trim()
  const py = computePinyinIndex(`${title} ${folderBreadcrumb}`)
  const dateAdded =
    typeof raw.dateAdded === 'number' && Number.isFinite(raw.dateAdded) && raw.dateAdded > 0
      ? raw.dateAdded
      : Date.now()

  return {
    id: String(raw.id),
    title,
    url: parsedUrl.toString(),
    hostname: parsedUrl.hostname,
    folderBreadcrumb,
    browser: raw.browser,
    browserLabel: raw.browserLabel,
    dateAdded,
    dateAddedFormatted: formatBookmarkDate(dateAdded),
    pinyinFull: py.full,
    pinyinInitials: py.initials
  }
}

export function parseChromiumBookmarksJson(
  jsonText: string,
  browser: BrowserType,
  browserLabel: string
): BookmarkItem[] {
  const parsed = JSON.parse(jsonText) as { roots?: Record<string, Record<string, unknown>> }
  const roots = parsed?.roots || {}
  const items: BookmarkItem[] = []

  const walk = (node: Record<string, unknown>, trail: string[]) => {
    if (!node || typeof node !== 'object') return
    const type = String(node.type || '')
    const name = String(node.name || '').trim()

    if (type === 'url') {
      const rawUrl = String(node.url || '').trim()
      const rawDate = Number(node.date_added || 0)
      const dateAdded =
        rawDate > 11644473600000000
          ? Math.floor(rawDate / 1000 - 11644473600000)
          : rawDate > 0
            ? rawDate
            : Date.now()
      const entry = normalizeBookmarkEntry({
        id: String(node.id || `${browser}-${items.length + 1}`),
        title: name || rawUrl,
        url: rawUrl,
        folderBreadcrumb: trail.join(' / '),
        browser,
        browserLabel,
        dateAdded
      })
      if (entry) {
        items.push(entry)
      }
      return
    }

    const children = Array.isArray(node.children)
      ? (node.children as Array<Record<string, unknown>>)
      : []
    const nextTrail =
      name && !['书签栏', 'Bookmarks bar', '其他书签', 'Other bookmarks'].includes(name)
        ? [...trail, name]
        : trail
    for (const child of children) {
      walk(child, nextTrail)
    }
  }

  for (const key of Object.keys(roots)) {
    const rootNode = roots[key]
    if (rootNode) {
      walk(rootNode, [])
    }
  }
  return items
}

export async function scanAllBrowserBookmarksWithMeta(
  options: BookmarkScannerOptions = {}
): Promise<ScanBookmarksResponse> {
  const warnings: string[] = []
  const allItems: BookmarkItem[] = []

  if (Array.isArray(options.customSources) && options.customSources.length > 0) {
    for (const src of options.customSources) {
      try {
        if (typeof src.jsonText === 'string') {
          const parsedItems = parseChromiumBookmarksJson(
            src.jsonText,
            src.browser,
            src.browserLabel
          )
          allItems.push(...parsedItems)
        } else if (Array.isArray(src.sqliteRows)) {
          // Copy-on-read snapshot simulation for locked Firefox places.sqlite
          const snapshotRows = [...src.sqliteRows]
          for (let i = 0; i < snapshotRows.length; i++) {
            const row = snapshotRows[i]!
            const entry = normalizeBookmarkEntry({
              id: String(row.id ?? `ff-${i + 1}`),
              title: String(row.title || ''),
              url: String(row.url || ''),
              folderBreadcrumb: String(row.folderBreadcrumb || 'Firefox 书签'),
              browser: src.browser,
              browserLabel: src.browserLabel,
              dateAdded: row.dateAdded
            })
            if (entry) {
              allItems.push(entry)
            }
          }
        }
      } catch (err) {
        warnings.push(
          `${src.browserLabel} 解析失败已隔离: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  } else {
    const res = await callHostTransport<{
      bookmarks?: Array<{
        id: string
        title: string
        url: string
        hostname: string
        folderBreadcrumb: string
        browser: BrowserType
        browserLabel: string
        dateAdded: number
      }>
      warnings?: string[]
    }>(
      'dllplugin_call',
      {
        plugin: 'BrowserBookmarksPlugin',
        func: 'scanBookmarks',
        params: {}
      },
      options.hostOverride
    )

    if (!res.ok) {
      throw new Error(res.error || 'BOOKMARKS_SCAN_FAILED: 无法读取本地浏览器书签库')
    }

    if (Array.isArray(res.data?.warnings)) {
      warnings.push(...res.data.warnings)
    }

    for (const b of res.data?.bookmarks || []) {
      const normalized = normalizeBookmarkEntry(b)
      if (normalized) {
        allItems.push(normalized)
      }
    }
  }

  const allowedBrowsers = Array.isArray(options.browsers) ? new Set(options.browsers) : null
  const filteredByBrowsers = allowedBrowsers
    ? allItems.filter((item) => allowedBrowsers.has(item.browser))
    : allItems

  const browserSet = new Set(filteredByBrowsers.map((i) => i.browser))
  return {
    bookmarks: filteredByBrowsers,
    warnings,
    activeBrowserCount: browserSet.size
  }
}

export async function scanAllBrowserBookmarks(
  options: BookmarkScannerOptions = {}
): Promise<BookmarkItem[]> {
  const res = await scanAllBrowserBookmarksWithMeta(options)
  return res.bookmarks
}

export function searchAndFilterBookmarks(
  bookmarks: readonly BookmarkItem[],
  query = '',
  browserFilter: BrowserFilterValue = 'all'
): BookmarkItem[] {
  const byBrowser = bookmarks.filter((item) => {
    if (browserFilter === 'all') return true
    if (browserFilter === 'domestic') {
      return (
        item.browser === '360se' ||
        item.browser === '360chrome' ||
        item.browser === 'qqbrowser'
      )
    }
    return item.browser === browserFilter
  })

  const rawQuery = query.trim().toLowerCase()
  if (!rawQuery) {
    return byBrowser
  }

  if (rawQuery.startsWith('domain:')) {
    const domainTarget = rawQuery.slice('domain:'.length).trim()
    return byBrowser.filter((item) => item.hostname.toLowerCase().includes(domainTarget))
  }

  const scored: Array<{ item: BookmarkItem; score: number }> = []
  for (const item of byBrowser) {
    const titleLower = item.title.toLowerCase()
    const urlLower = item.url.toLowerCase()
    const hostLower = item.hostname.toLowerCase()
    const folderLower = item.folderBreadcrumb.toLowerCase()

    let score = 0
    if (titleLower === rawQuery || hostLower === rawQuery) {
      score = 100
    } else if (titleLower.includes(rawQuery)) {
      score = 90
    } else if (item.pinyinInitials.includes(rawQuery)) {
      score = 85
    } else if (item.pinyinFull.includes(rawQuery)) {
      score = 80
    } else if (hostLower.includes(rawQuery)) {
      score = 75
    } else if (folderLower.includes(rawQuery) || urlLower.includes(rawQuery)) {
      score = 60
    }

    if (score > 0) {
      scored.push({ item, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}
