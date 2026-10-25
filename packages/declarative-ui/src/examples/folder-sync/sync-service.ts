import { callHostTransport } from '../shared/native-ipc.js'
import type {
  CompareFoldersResponse,
  DiffFilterType,
  ExecuteSyncResponse,
  FolderSyncDiffItem,
  SyncMode
} from './types.js'

export function formatSyncBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (safe < 1024) return `${safe} B`
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`
  if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} MB`
  return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function shortenFolderPath(dirPath: string): string {
  const clean = (dirPath || '').trim()
  if (!clean) return '未选择目录'
  if (clean.length <= 36) return clean
  const parts = clean.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return clean
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
}

export function areDirectoriesNestedOrIdentical(dirA: string, dirB: string): boolean {
  const cleanA = (dirA || '').trim().replace(/[\\/]+$/, '')
  const cleanB = (dirB || '').trim().replace(/[\\/]+$/, '')
  if (!cleanA || !cleanB) return false
  const normA = cleanA.replace(/\//g, '\\').toLowerCase()
  const normB = cleanB.replace(/\//g, '\\').toLowerCase()
  if (normA === normB) return true
  return normB.startsWith(`${normA}\\`) || normA.startsWith(`${normB}\\`)
}

export function isWithinFatTimestampTolerance(mtimeA: number, mtimeB: number, toleranceMs = 2000): boolean {
  if (!Number.isFinite(mtimeA) || !Number.isFinite(mtimeB)) return false
  return Math.abs(mtimeA - mtimeB) <= toleranceMs
}

export function filterSyncDiffItems(
  items: readonly FolderSyncDiffItem[],
  diffFilter: DiffFilterType = 'all',
  query = ''
): FolderSyncDiffItem[] {
  const q = query.trim().toLowerCase()
  return items.filter((item) => {
    if (diffFilter === 'added' && item.diffType !== 'added' && item.diffType !== 'reverse-add') {
      return false
    }
    if (diffFilter === 'modified' && item.diffType !== 'modified') {
      return false
    }
    if (diffFilter === 'orphan' && item.diffType !== 'orphan') {
      return false
    }
    if (!q) return true
    return `${item.relPath} ${item.actionBadge} ${item.reasonText}`.toLowerCase().includes(q)
  })
}

export async function compareFolderTrees(options: {
  sourceDir: string
  targetDir: string
  syncMode?: SyncMode
  ignoreDevJunk?: boolean
  mockTargetFreeBytes?: number
  hostOverride?: unknown
}): Promise<CompareFoldersResponse> {
  const sourceDir = (options.sourceDir || '').trim()
  const targetDir = (options.targetDir || '').trim()
  const syncMode: SyncMode = options.syncMode || 'incremental'
  const ignoreDevJunk = options.ignoreDevJunk !== false

  if (!sourceDir || !targetDir) {
    return {
      ok: false,
      sourceDir,
      targetDir,
      syncMode,
      ignoreDevJunk,
      diffs: [],
      totalDiffs: 0,
      transferBytes: 0,
      targetFreeBytes: 0,
      errorCode: 'EMPTY_DIRECTORY_PATH',
      error: 'EMPTY_DIRECTORY_PATH: 请先选择源文件夹与目标文件夹'
    }
  }

  if (areDirectoriesNestedOrIdentical(sourceDir, targetDir)) {
    return {
      ok: false,
      sourceDir,
      targetDir,
      syncMode,
      ignoreDevJunk,
      diffs: [],
      totalDiffs: 0,
      transferBytes: 0,
      targetFreeBytes: 0,
      errorCode: 'NESTED_DIRECTORY_FORBIDDEN',
      error: 'NESTED_DIRECTORY_FORBIDDEN: 源目录与目标目录不能相同或互相包含'
    }
  }

  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'FolderSyncPlugin',
      func: 'compareDirs',
      params: {
        sourceDir,
        targetDir,
        syncMode,
        ignoreDevJunk,
        ...(typeof options.mockTargetFreeBytes === 'number'
          ? { mockTargetFreeBytes: options.mockTargetFreeBytes }
          : {})
      }
    },
    options.hostOverride
  )

  if (!res.ok || (res.data && res.data.ok === false)) {
    const errText = String(res.data?.error ?? res.error ?? '目录差异比对失败')
    const codeMatch = errText.match(/^([A-Z0-9_]+):/)
    return {
      ok: false,
      sourceDir,
      targetDir,
      syncMode,
      ignoreDevJunk,
      diffs: [],
      totalDiffs: 0,
      transferBytes: 0,
      targetFreeBytes: 0,
      errorCode: String(res.data?.errorCode ?? codeMatch?.[1] ?? 'COMPARE_FAILED'),
      error: errText
    }
  }

  const diffs = Array.isArray(res.data?.diffs)
    ? (res.data.diffs as FolderSyncDiffItem[])
    : []
  const transferBytes = Number(
    res.data?.transferBytes ??
      diffs
        .filter((d) => d.direction !== 'delete-dst')
        .reduce((acc, d) => acc + d.sizeBytes, 0)
  )
  const targetFreeBytes = Number(res.data?.targetFreeBytes ?? 50 * 1024 * 1024 * 1024)

  return {
    ok: true,
    sourceDir: String(res.data?.sourceDir ?? sourceDir),
    targetDir: String(res.data?.targetDir ?? targetDir),
    syncMode,
    ignoreDevJunk,
    diffs,
    totalDiffs: diffs.length,
    transferBytes,
    targetFreeBytes
  }
}

export async function executeFolderSync(options: {
  sourceDir: string
  targetDir: string
  syncMode?: SyncMode
  ignoreDevJunk?: boolean
  selectedRelPaths?: string[]
  mockTargetFreeBytes?: number
  simulateLockedRelPaths?: string[]
  hostOverride?: unknown
}): Promise<ExecuteSyncResponse> {
  const sourceDir = (options.sourceDir || '').trim()
  const targetDir = (options.targetDir || '').trim()
  const syncMode: SyncMode = options.syncMode || 'incremental'
  const ignoreDevJunk = options.ignoreDevJunk !== false

  if (!sourceDir || !targetDir) {
    return {
      ok: false,
      syncedCount: 0,
      deletedCount: 0,
      transferredBytes: 0,
      failures: [],
      errorCode: 'EMPTY_DIRECTORY_PATH',
      error: 'EMPTY_DIRECTORY_PATH: 源目录与目标目录不能为空'
    }
  }

  if (areDirectoriesNestedOrIdentical(sourceDir, targetDir)) {
    return {
      ok: false,
      syncedCount: 0,
      deletedCount: 0,
      transferredBytes: 0,
      failures: [],
      errorCode: 'NESTED_DIRECTORY_FORBIDDEN',
      error: 'NESTED_DIRECTORY_FORBIDDEN: 源目录与目标目录不能相同或互相包含'
    }
  }

  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'FolderSyncPlugin',
      func: 'executeSync',
      params: {
        sourceDir,
        targetDir,
        syncMode,
        ignoreDevJunk,
        ...(Array.isArray(options.selectedRelPaths)
          ? { selectedRelPaths: options.selectedRelPaths }
          : {}),
        ...(typeof options.mockTargetFreeBytes === 'number'
          ? { mockTargetFreeBytes: options.mockTargetFreeBytes }
          : {}),
        ...(Array.isArray(options.simulateLockedRelPaths)
          ? { simulateLockedRelPaths: options.simulateLockedRelPaths }
          : {})
      }
    },
    options.hostOverride
  )

  if (!res.ok && !res.data) {
    const errText = String(res.error ?? '目录增量同步失败')
    const codeMatch = errText.match(/^([A-Z0-9_]+):/)
    return {
      ok: false,
      syncedCount: 0,
      deletedCount: 0,
      transferredBytes: 0,
      failures: [],
      errorCode: codeMatch?.[1] ?? 'SYNC_EXECUTION_FAILED',
      error: errText
    }
  }

  const data = (res.data ?? {}) as Record<string, unknown>
  const failures = Array.isArray(data.failures)
    ? (data.failures as Array<{ relPath: string; errorCode: string; error: string }>)
    : []

  if (data.ok === false && failures.length === 0) {
    const errText = String(data.error ?? res.error ?? '目录同步被拒绝')
    const codeMatch = errText.match(/^([A-Z0-9_]+):/)
    return {
      ok: false,
      syncedCount: 0,
      deletedCount: 0,
      transferredBytes: 0,
      failures: [],
      errorCode: String(data.errorCode ?? codeMatch?.[1] ?? 'SYNC_REJECTED'),
      error: errText
    }
  }

  return {
    ok: failures.length === 0 && data.ok !== false,
    syncedCount: Number(data.syncedCount ?? 0),
    deletedCount: Number(data.deletedCount ?? 0),
    transferredBytes: Number(data.transferredBytes ?? 0),
    failures,
    ...(failures.length > 0
      ? { errorCode: failures[0]!.errorCode, error: failures[0]!.error }
      : {})
  }
}
