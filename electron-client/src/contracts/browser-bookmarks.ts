import { errorCodes, ZToolsError } from './errors.js'

export const BOOKMARK_BROWSERS = ['chrome', 'edge', 'brave', '360se', '360chrome', 'qqbrowser', 'firefox', 'safari'] as const
export type BookmarkBrowser = typeof BOOKMARK_BROWSERS[number]
export interface BrowserBookmark {
  id: string; title: string; url: string; hostname: string; folderBreadcrumb: string
  browser: BookmarkBrowser; browserLabel: string; profile: string; dateAdded: number | null
  pinyinFull: string; pinyinInitials: string
}
export interface BookmarkScan { success: true; bookmarks: BrowserBookmark[]; warnings: string[]; sourcesRead: number }
export function validateBookmarkRequest(value: unknown): asserts value is { operationId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'operationId') ||
      typeof (value as { operationId?: unknown }).operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test((value as { operationId: string }).operationId)) {
    throw new ZToolsError(errorCodes.invalidRequest, '书签读取参数无效')
  }
}
export function validateBookmarkScan(value: unknown): BookmarkScan {
  const data = value as Partial<BookmarkScan> | null
  if (!data || data.success !== true || !Array.isArray(data.bookmarks) || data.bookmarks.length > 20000 ||
      !Array.isArray(data.warnings) || data.warnings.some(w => typeof w !== 'string' || w.length > 2048) || data.warnings.length > 512 ||
      !Number.isSafeInteger(data.sourcesRead) || data.sourcesRead! < 0 || data.sourcesRead! > 256) throw new Error('书签读取结果无效')
  if (data.sourcesRead === 0 && data.warnings.length) throw new Error(`未能读取任何浏览器书签：${data.warnings.slice(0, 5).join('；')}`)
  if (data.sourcesRead === 0 && data.bookmarks.length) throw new Error('书签来源缺失')
  const ids = new Set<string>()
  for (const b of data.bookmarks) {
    if (!b || !BOOKMARK_BROWSERS.includes(b.browser) || !['id', 'title', 'url', 'hostname', 'folderBreadcrumb', 'browserLabel', 'profile', 'pinyinFull', 'pinyinInitials'].every(key => typeof b[key as keyof BrowserBookmark] === 'string') ||
        !b.id || ids.has(b.id) || b.url.length > 16384 || b.title.length > 4096 ||
        (b.dateAdded !== null && (!Number.isFinite(b.dateAdded) || b.dateAdded <= 0 || b.dateAdded > 8640000000000000))) throw new Error('书签条目无效')
    const url = new URL(b.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== b.hostname) throw new Error('书签网址无效')
    ids.add(b.id)
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw new Error('书签结果超过 8 MiB，请减少浏览器配置中的书签后重试')
  return data as BookmarkScan
}
