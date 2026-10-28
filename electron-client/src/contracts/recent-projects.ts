import { errorCodes, ZToolsError } from './errors.js'

export const PROJECT_EDITORS = ['vscode', 'vscode-insiders', 'cursor', 'trae', 'trae-cn', 'windsurf', 'idea', 'webstorm', 'pycharm', 'goland', 'clion', 'rider', 'datagrip', 'rustrover'] as const
export type ProjectEditor = typeof PROJECT_EDITORS[number]
export interface RecentProject {
  id: string; path: string; name: string; editor: ProjectEditor; editorName: string
  family: 'vsc' | 'jetbrains'; kind: 'folder' | 'workspace'
  lastOpenedMs: number | null; gitBranch: string | null
  pathState: 'available' | 'missing' | 'unreadable'; pathError: string | null
}
export interface RecentProjectsScan { success: true; projects: RecentProject[]; warnings: string[]; sourcesRead: number; skippedRemote: number }
export type RecentProjectsRequest = { action: 'scan'; operationId: string } | { action: 'cancel'; operationId: string } | { action: 'open' | 'terminal'; id: string }
export function validateRecentProjectsRequest(value: unknown): asserts value is RecentProjectsRequest {
  const v = value as Record<string, unknown> | null
  const scan = v?.action === 'scan' || v?.action === 'cancel'
  const keys = scan ? ['action', 'operationId'] : ['action', 'id']
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)) ||
      (typeof v.action !== 'string' || !['scan', 'cancel', 'open', 'terminal'].includes(v.action)) ||
      (scan ? typeof v.operationId !== 'string' || !/^[\w-]{1,100}$/.test(v.operationId) : typeof v.id !== 'string' || !/^[a-f0-9]{64}$/.test(v.id))) {
    throw new ZToolsError(errorCodes.invalidRequest, '最近项目请求无效')
  }
}
export function validateRecentProjectsScan(value: unknown): RecentProjectsScan {
  const v = value as RecentProjectsScan | null
  if (!v || v.success !== true || !Array.isArray(v.projects) || v.projects.length > 5000 ||
      !Array.isArray(v.warnings) || v.warnings.length > 256 || v.warnings.some(w => typeof w !== 'string' || w.length > 2048) ||
      !Number.isSafeInteger(v.sourcesRead) || v.sourcesRead < 0 || v.sourcesRead > 256 || !Number.isSafeInteger(v.skippedRemote) || v.skippedRemote < 0) throw new Error('最近项目扫描结果无效')
  if (!v.sourcesRead && v.warnings.length) throw new Error(`无法读取项目历史：${v.warnings.slice(0, 4).join('；')}`)
  if (!v.sourcesRead && v.projects.length) throw new Error('项目历史缺少来源')
  const ids = new Set<string>()
  for (const p of v.projects) {
    if (!p || typeof p.id !== 'string' || !/^[a-f0-9]{64}$/.test(p.id) || ids.has(p.id) ||
        !PROJECT_EDITORS.includes(p.editor) || !['vsc', 'jetbrains'].includes(p.family) || !['folder', 'workspace'].includes(p.kind) ||
        !['path', 'name', 'editorName'].every(k => typeof p[k as keyof RecentProject] === 'string' && String(p[k as keyof RecentProject]).length <= 16384) ||
        !/^(\/|[A-Za-z]:\\|\\\\)/.test(p.path) || p.path.includes('\0') || !p.name ||
        !['available', 'missing', 'unreadable'].includes(p.pathState) || (p.pathError !== null && typeof p.pathError !== 'string') ||
        (p.gitBranch !== null && (typeof p.gitBranch !== 'string' || p.gitBranch.length > 1024)) ||
        (p.lastOpenedMs !== null && (!Number.isSafeInteger(p.lastOpenedMs) || p.lastOpenedMs <= 0 || p.lastOpenedMs > 8640000000000000))) throw new Error('项目历史条目无效')
    ids.add(p.id)
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 8 * 1024 * 1024) throw new Error('项目历史结果超过 8 MiB')
  return v
}
