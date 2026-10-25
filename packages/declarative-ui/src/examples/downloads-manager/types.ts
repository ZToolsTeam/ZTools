export type DownloadSourceChannel = 'all' | 'browser' | 'netdisk' | 'im' | 'custom'

export type DownloadFileCategory =
  | 'all'
  | 'installer'
  | 'archive'
  | 'document'
  | 'image'
  | 'media'
  | 'code'
  | 'other'

export interface DownloadSourceDescriptor {
  id: string
  label: string
  channel: Exclude<DownloadSourceChannel, 'all'>
  appName: string
  path: string
  exists?: boolean
}

export interface DownloadEntry {
  id: string
  name: string
  path: string
  dirPath: string
  ext: string
  category: Exclude<DownloadFileCategory, 'all'>
  sizeBytes: number
  sizeFormatted: string
  modifiedAt: string
  mtimeMs: number
  ageDays: number
  isPinned: boolean
  channel: Exclude<DownloadSourceChannel, 'all'>
  sourceId: string
  sourceLabel: string
  appName: string
}

export interface DownloadsDashboardSummary {
  downloadDir: string
  sources: DownloadSourceDescriptor[]
  totalCount: number
  totalSizeBytes: number
  totalSizeFormatted: string
  installerCount: number
  installerSizeBytes: number
  installerSizeFormatted: string
  largeFileCount: number
  oldFileCount: number
  oldFileSizeBytes: number
  oldFileSizeFormatted: string
  entries: DownloadEntry[]
}

export interface CleanResult {
  cleanedCount: number
  freedBytes: number
  freedFormatted: string
  remainingEntries: DownloadEntry[]
  failedPaths?: string[]
  error?: string
}
