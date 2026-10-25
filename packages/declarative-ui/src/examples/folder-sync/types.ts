export type SyncMode = 'incremental' | 'two-way' | 'mirror'
export type DiffFilterType = 'all' | 'added' | 'modified' | 'orphan'
export type DiffCategory = 'added' | 'modified' | 'reverse-add' | 'orphan'
export type SyncDirection = 'src-to-dst' | 'dst-to-src' | 'delete-dst'

export interface FolderSyncDiffItem {
  relPath: string
  diffType: DiffCategory
  direction: SyncDirection
  actionBadge: string
  reasonText: string
  sizeBytes: number
  sourceMtimeMs: number | null
  targetMtimeMs: number | null
  sourceFullPath: string
  targetFullPath: string
}

export interface CompareFoldersResponse {
  ok: boolean
  sourceDir: string
  targetDir: string
  syncMode: SyncMode
  ignoreDevJunk: boolean
  diffs: FolderSyncDiffItem[]
  totalDiffs: number
  transferBytes: number
  targetFreeBytes: number
  errorCode?: string
  error?: string
}

export interface ExecuteSyncFailure {
  relPath: string
  errorCode: string
  error: string
}

export interface ExecuteSyncResponse {
  ok: boolean
  syncedCount: number
  deletedCount: number
  transferredBytes: number
  failures: ExecuteSyncFailure[]
  errorCode?: string
  error?: string
}
