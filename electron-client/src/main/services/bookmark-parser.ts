import { createHash } from 'node:crypto'
import { pinyin } from 'pinyin-pro'
import type { BookmarkBrowser, BrowserBookmark } from '../../contracts/browser-bookmarks.js'

export interface BookmarkSource { browser: BookmarkBrowser; browserLabel: string; profile: string; file: string; format: 'chromium' | 'firefox' | 'safari' }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Corrupt bookmark structure')
  return value as Record<string, unknown>
}
function name(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Bookmark title is too long or has an invalid type')
  return value
}
export function bookmarkItem(source: BookmarkSource, id: string, title: unknown, urlValue: unknown, trail: string[], date: number): BrowserBookmark | null {
  if (typeof urlValue !== 'string' || urlValue.length > 16384) throw new Error('Bookmark URL is too long or has an invalid type')
  let url: URL
  try { url = new URL(urlValue) } catch { return null /* 浏览器中不可打开的地址不参与网页检索。 */ }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  const label = name(title).trim() || url.hostname, folder = trail.filter(Boolean).join(' / ')
  const tokens = pinyin(`${label} ${folder}`, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  return {
    id: `${createHash('sha256').update(source.file).digest('hex').slice(0, 24)}:${id}`,
    title: label, url: urlValue, hostname: url.hostname, folderBreadcrumb: folder,
    browser: source.browser, browserLabel: source.browserLabel, profile: source.profile,
    dateAdded: Number.isFinite(date) && date > 0 && date <= 8640000000000000 ? date : null,
    pinyinFull: tokens.join('').toLowerCase(),
    pinyinInitials: tokens.map(token => /^[a-z]/i.test(token) ? token[0] : token).join('').toLowerCase()
  }
}
export function parseBookmarkTree(value: unknown, source: BookmarkSource): BrowserBookmark[] {
  const data = record(value), safari = source.format === 'safari'
  const roots = safari ? [data] : Object.values(record(data.roots))
  const result: BrowserBookmark[] = [], pending = roots.map((node, i) => ({ node, trail: [] as string[], id: String(i), depth: 0 }))
  let nodes = 0
  while (pending.length) {
    const { node, trail, id, depth } = pending.pop()!
    if (++nodes > 50000 || depth > 64) throw new Error('Bookmark tree exceeds 50000 nodes or depth 64')
    const entry = record(node), type = safari ? entry.WebBookmarkType : entry.type
    if (type === 'url' || type === 'WebBookmarkTypeLeaf') {
      const title = safari ? record(entry.URIDictionary ?? {}).title : entry.name
      const item = bookmarkItem(source, id, title, safari ? entry.URLString : entry.url, trail,
        safari ? Number.NaN : Number(entry.date_added) / 1000 - 11644473600000)
      if (item) result.push(item)
    } else if (type === 'folder' || type === 'WebBookmarkTypeList') {
      // Safari 的空文件夹省略 Children；Chromium 则必须包含 children 数组。
      const children = safari ? entry.Children === undefined ? [] : entry.Children : entry.children
      if (!Array.isArray(children)) throw new Error('Invalid bookmark folder children')
      const label = name(safari ? entry.Title : entry.name), next = label ? [...trail, label] : trail
      for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], trail: next, id: `${id}.${i}`, depth: depth + 1 })
    } else if (type !== 'WebBookmarkTypeProxy') throw new Error('Unsupported bookmark node type')
    if (result.length > 20000) throw new Error('Profile exceeds 20000 bookmarks; partial result skipped')
  }
  return result
}

export function parseFirefoxRows(rows: Record<string, unknown>[], source: BookmarkSource): BrowserBookmark[] {
  if (rows.length > 20000) throw new Error('Firefox profile exceeds 20000 bookmark nodes; partial result skipped')
  const nodes = new Map<number, Record<string, unknown>>(), result: BrowserBookmark[] = []
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.parent) || nodes.has(Number(row.id))) throw new Error('Invalid Firefox bookmark ID')
    nodes.set(Number(row.id), row)
  }
  for (const row of rows) {
    if (row.type !== 1) continue
    const trail: string[] = [], seen = new Set<number>([Number(row.id)])
    let parent = Number(row.parent)
    while (parent) {
      if (seen.has(parent) || seen.size > 64) throw new Error('Firefox bookmark parent cycle or excessive depth')
      seen.add(parent)
      const folder = nodes.get(parent)
      if (!folder || folder.type !== 2) throw new Error('Missing Firefox bookmark parent folder')
      trail.unshift(name(folder.title)); parent = Number(folder.parent)
    }
    const item = bookmarkItem(source, String(row.id), row.title, row.url, trail, Number(row.dateAdded) / 1000)
    if (item) result.push(item)
  }
  return result
}
