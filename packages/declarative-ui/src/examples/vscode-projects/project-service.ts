import { callHostTransport } from '../shared/native-ipc.js'
import type { EditorFilterGroup, ProjectEntry, SupportedEditor } from './types.js'

const EDITOR_NAMES: Record<SupportedEditor, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  trae: 'Trae',
  windsurf: 'Windsurf',
  idea: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  pycharm: 'PyCharm',
  goland: 'GoLand'
}

export function formatRelativeTime(lastOpenedMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - lastOpenedMs) / 1000))
  if (diffSec < 60) return '刚刚打开'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} 天前`
}

export function normalizeFileUriToPath(rawUriOrPath: string): string {
  const trimmed = String(rawUriOrPath ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('file:///')) {
    try {
      const decoded = decodeURIComponent(trimmed.slice('file:///'.length))
      if (/^[a-zA-Z]:/.test(decoded)) {
        return decoded.replace(/\//g, '\\')
      }
      return '/' + decoded
    } catch {
      return trimmed.replace(/^file:\/\/\//, '')
    }
  }
  return trimmed
}

/**
 * 解析 VS Code / Cursor / Trae / Windsurf `history.recentlyOpenedPathsList` JSON 结构
 */
export function parseVscRecentlyOpenedJson(
  jsonStr: string,
  editorType: SupportedEditor = 'vscode',
  baseTimestampMs = Date.now()
): ProjectEntry[] {
  if (!jsonStr || !jsonStr.trim()) return []
  try {
    const parsed = JSON.parse(jsonStr) as {
      entries?: Array<{ folderUri?: string; fileUri?: string; workspace?: { configPath?: string }; label?: string }>
    }
    if (!parsed || !Array.isArray(parsed.entries)) return []
    const results: ProjectEntry[] = []

    parsed.entries.forEach((entry, idx) => {
      const rawUri = entry.folderUri || entry.workspace?.configPath || entry.fileUri || ''
      const fsPath = normalizeFileUriToPath(rawUri)
      if (!fsPath) return
      const name = entry.label || fsPath.split(/[\\/]/).filter(Boolean).pop() || fsPath
      const lastOpenedMs = baseTimestampMs - idx * 60_000
      results.push({
        name,
        path: fsPath,
        displayPath: fsPath,
        editorType,
        editorName: EDITOR_NAMES[editorType] || 'VS Code',
        lastOpenedMs,
        lastOpenedRelative: formatRelativeTime(lastOpenedMs, baseTimestampMs),
        isMissing: false
      })
    })
    return results
  } catch {
    return []
  }
}

/**
 * 解析 JetBrains `options/recentProjects.xml` 结构
 */
export function parseJetBrainsRecentProjectsXml(
  xmlStr: string,
  editorType: SupportedEditor = 'idea',
  userHome = 'C:\\Users\\Developer',
  nowMs = Date.now()
): ProjectEntry[] {
  if (!xmlStr || !xmlStr.trim()) return []
  const entries: ProjectEntry[] = []
  const entryRegex = /<entry\s+key="([^"]+)"[\s\S]*?<\/entry>/gi

  for (const match of xmlStr.matchAll(entryRegex)) {
    const rawKey = match[1] || ''
    const block = match[0] || ''
    if (!rawKey) continue

    const fsPath = rawKey.replace(/\$USER_HOME\$/g, userHome).replace(/\//g, '\\')
    const tsMatch = block.match(/name="(?:projectOpenTimestamp|activationTimestamp)"\s+value="(\d+)"/i)
    const lastOpenedMs = tsMatch?.[1] ? Number(tsMatch[1]) : nowMs - entries.length * 120_000
    const name = fsPath.split(/[\\/]/).filter(Boolean).pop() || fsPath

    entries.push({
      name,
      path: fsPath,
      displayPath: fsPath,
      editorType,
      editorName: EDITOR_NAMES[editorType] || 'JetBrains',
      lastOpenedMs,
      lastOpenedRelative: formatRelativeTime(lastOpenedMs, nowMs),
      isMissing: false
    })
  }
  return entries
}

/**
 * 解析 `.git/HEAD` 文本提取分支名或短 Commit Hash
 */
export function parseGitHeadContent(headContent: string): string | undefined {
  const trimmed = String(headContent ?? '').trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('ref: refs/heads/')) {
    return trimmed.slice('ref: refs/heads/'.length).trim()
  }
  if (/^[0-9a-fA-F]{7,40}$/.test(trimmed)) {
    return trimmed.slice(0, 7)
  }
  return undefined
}

export function mergeAndSortProjects(lists: ProjectEntry[][], nowMs = Date.now()): ProjectEntry[] {
  const seen = new Map<string, ProjectEntry>()
  for (const list of lists) {
    for (const item of list) {
      const key = `${item.editorType}:${item.path.toLowerCase()}`
      const existing = seen.get(key)
      if (!existing || item.lastOpenedMs > existing.lastOpenedMs) {
        seen.set(key, {
          ...item,
          lastOpenedRelative: formatRelativeTime(item.lastOpenedMs, nowMs)
        })
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.lastOpenedMs - a.lastOpenedMs)
}

export function filterProjectEntries(
  projects: ProjectEntry[],
  searchText: string,
  editorFilter: EditorFilterGroup = 'all'
): ProjectEntry[] {
  const vscSet = new Set<SupportedEditor>(['vscode', 'cursor', 'trae', 'windsurf'])
  const jbSet = new Set<SupportedEditor>(['idea', 'webstorm', 'pycharm', 'goland'])

  const byEditor = projects.filter((p) => {
    if (editorFilter === 'vsc-family') return vscSet.has(p.editorType)
    if (editorFilter === 'jetbrains') return jbSet.has(p.editorType)
    return true
  })

  const q = String(searchText ?? '').trim().toLowerCase()
  if (!q) return byEditor

  return byEditor.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      p.editorName.toLowerCase().includes(q) ||
      (p.gitBranch && p.gitBranch.toLowerCase().includes(q))
  )
}

export async function scanAllRecentProjects(
  rawEntries?: Array<Partial<ProjectEntry>>,
  hostOverride?: unknown
): Promise<ProjectEntry[]> {
  const res = await callHostTransport<{ projects?: Array<Record<string, unknown>> }>(
    'dllplugin_call',
    {
      plugin: 'VscodeProjectsPlugin',
      func: 'scanAllRecentProjects',
      params: rawEntries ? { rawEntries } : {}
    },
    hostOverride
  )
  const rawList = res.data?.projects ?? []
  const nowMs = Date.now()
  return rawList.map((r) => {
    const lastOpenedMs = Number(r.lastOpenedMs || nowMs)
    const p = String(r.path || '')
    return {
      name: String(r.name || p.split(/[\\/]/).pop() || p),
      path: p,
      displayPath: p,
      editorType: (r.editorType as SupportedEditor) || 'vscode',
      editorName: String(r.editorName || 'VS Code'),
      lastOpenedMs,
      lastOpenedRelative: formatRelativeTime(lastOpenedMs, nowMs),
      gitBranch: typeof r.gitBranch === 'string' ? r.gitBranch : undefined,
      isMissing: Boolean(r.isMissing)
    }
  })
}

export async function launchProjectInEditor(
  item: ProjectEntry,
  hostOverride?: unknown
): Promise<{ ok: boolean; error?: string }> {
  if (item.isMissing) {
    return {
      ok: false,
      error: `PROJECT_PATH_MISSING: 项目路径已失效或被移除 (${item.path})`
    }
  }
  const res = await callHostTransport<{ error?: string }>(
    'dllplugin_call',
    {
      plugin: 'VscodeProjectsPlugin',
      func: 'launchProject',
      params: { path: item.path, editor: item.editorType }
    },
    hostOverride
  )
  if (!res.ok) {
    return { ok: false, error: res.error || res.data?.error || '打开项目失败' }
  }
  return { ok: true }
}
