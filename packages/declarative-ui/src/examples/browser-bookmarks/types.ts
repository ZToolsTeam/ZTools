export type BrowserType =
  | 'edge'
  | 'chrome'
  | '360se'
  | '360chrome'
  | 'qqbrowser'
  | 'brave'
  | 'firefox'
  | 'safari'

export type BrowserFilterValue = 'all' | 'edge' | 'chrome' | 'domestic' | 'firefox'

export interface BookmarkItem {
  id: string
  title: string
  url: string
  hostname: string
  folderBreadcrumb: string
  browser: BrowserType
  browserLabel: string
  dateAdded: number
  dateAddedFormatted: string
  pinyinFull: string
  pinyinInitials: string
}

export interface BookmarkSourceInput {
  browser: BrowserType
  browserLabel: string
  jsonText?: string
  filePath?: string
  isLocked?: boolean
  sqliteRows?: Array<{
    id?: string | number
    title?: string
    url?: string
    dateAdded?: number
    folderBreadcrumb?: string
  }>
}

export interface BookmarkScannerOptions {
  browsers?: BrowserType[]
  includeProfiles?: boolean
  customSources?: BookmarkSourceInput[]
  hostOverride?: unknown
}

export interface ScanBookmarksResponse {
  bookmarks: BookmarkItem[]
  warnings: string[]
  activeBrowserCount: number
}
