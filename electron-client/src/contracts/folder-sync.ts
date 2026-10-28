import { errorCodes, ZToolsError } from './errors.js'
export type SyncMode = 'incremental' | 'two-way' | 'mirror'
export type FolderSyncRequest =
  | { action: 'compare'; operationId: string; sourceDir: string; targetDir: string; syncMode: SyncMode; ignoreDevJunk: boolean }
  | { action: 'execute'; operationId: string; planId: string; selectedRelPaths: string[] }
export interface SyncDiff {
  relPath: string; diffType: 'added' | 'modified' | 'reverse-add' | 'orphan' | 'conflict'
  direction: 'src-to-dst' | 'dst-to-src' | 'delete-dst' | 'conflict'
  actionBadge: string; reasonText: string; sizeBytes: number
  sourceFullPath: string; targetFullPath: string
}
export function validateFolderSyncRequest(value: unknown): asserts value is FolderSyncRequest {
  const invalid = () => new ZToolsError(errorCodes.invalidRequest, '目录同步参数无效')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const p = value as Record<string, unknown>
  if (typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.operationId)) throw invalid()
  const keys = p.action === 'compare' ? ['action', 'operationId', 'sourceDir', 'targetDir', 'syncMode', 'ignoreDevJunk'] : ['action', 'operationId', 'planId', 'selectedRelPaths']
  if (Object.keys(p).some(key => !keys.includes(key))) throw invalid()
  if (p.action === 'compare') {
    for (const key of ['sourceDir', 'targetDir']) if (typeof p[key] !== 'string' || !p[key] || p[key].length > 4096 || p[key].includes('\0')) throw invalid()
    if (!['incremental', 'two-way', 'mirror'].includes(String(p.syncMode)) || typeof p.syncMode !== 'string' || typeof p.ignoreDevJunk !== 'boolean') throw invalid()
  } else if (p.action === 'execute') {
    if (typeof p.planId !== 'string' || !/^[a-f0-9-]{36}$/.test(p.planId) || !Array.isArray(p.selectedRelPaths) || !p.selectedRelPaths.length || p.selectedRelPaths.length > 5000 ||
      p.selectedRelPaths.some(item => typeof item !== 'string' || !item || item.length > 4096 || item.includes('\0')) || new Set(p.selectedRelPaths).size !== p.selectedRelPaths.length) throw invalid()
  } else throw invalid()
}
