import {
  invokePluginService,
  showRealItemInFolder,
  writeRealClipboardText
} from '../shared/native-ipc.js'
import type {
  StartupCleanBrokenResult,
  StartupEntryItem,
  StartupScanSummary,
  StartupSourceFilter,
  StartupSourceLabel,
  StartupSourceType,
  StartupToggleResult
} from './types.js'

export const STARTUP_MANAGER_PLUGIN_NAME = 'StartupManagerPlugin'

export const WINDOWS_PROTECTED_CORE_SERVICES = new Set([
  'rpcss',
  'dcomlaunch',
  'plugplay',
  'eventlog',
  'windefend',
  'wdnissvc',
  'mpssvc',
  'dhcp',
  'dnscache',
  'lanmanworkstation',
  'lanmanserver',
  'schedule',
  'spooler',
  'themes',
  'audiosrv',
  'audioendpointbuilder',
  'bfe',
  'cryptsvc',
  'profsvc',
  'samss',
  'lsm',
  'power',
  'systemeventsbroker',
  'timebrokersvc',
  'usermanager',
  'wcmsvc',
  'winmgmt',
  'wuauserv',
  'trustedinstaller',
  'gpsvc',
  'nsi',
  'keyiso',
  'vaultsvc'
])

export function resolveInitialStartupFilter(featureCode?: string): StartupSourceFilter {
  switch (featureCode) {
    case 'startup-services':
      return 'service'
    case 'startup-tasks':
      return 'task'
    default:
      return 'all'
  }
}

export function extractExePathFromCommand(rawCommand: string): string {
  const trimmed = String(rawCommand ?? '').trim()
  if (!trimmed) return ''

  const quotedMatch = trimmed.match(/^"([^"]+)"/)
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim()
  }

  const winExeMatch = trimmed.match(/^([a-zA-Z]:\\[^\r\n"]*?\.(?:exe|bat|cmd|com|ps1|vbs|lnk|msc))\b/i)
  if (winExeMatch?.[1]) {
    return winExeMatch[1].trim()
  }

  const posixMatch = trimmed.match(/^(\/[^\s"']+)/)
  if (posixMatch?.[1]) {
    return posixMatch[1].trim()
  }

  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  return firstToken.replace(/^['"]+|['"]+$/g, '').trim()
}

export function hasDangerousStartupTokens(val: string): boolean {
  if (!val) return false
  return /[\0\r\n;|`$]/.test(val)
}

export function isMicrosoftProtectedStartupItem(item: {
  source?: string
  name?: string
  serviceName?: string
  taskPath?: string
  publisher?: string
  exePath?: string
  command?: string
}): boolean {
  const src = String(item.source ?? '').toLowerCase()
  const svcName = String(item.serviceName ?? item.name ?? '').trim().toLowerCase()
  const taskPath = String(item.taskPath ?? item.name ?? '').trim()
  const publisher = String(item.publisher ?? '').trim().toLowerCase()
  const exePath = String(item.exePath ?? extractExePathFromCommand(item.command ?? '')).toLowerCase()

  if (src === 'service') {
    if (WINDOWS_PROTECTED_CORE_SERVICES.has(svcName)) return true
    if (publisher.includes('microsoft')) return true
    if (
      exePath.startsWith('c:\\windows\\system32\\') ||
      exePath.startsWith('c:\\windows\\syswow64\\') ||
      exePath.includes('\\svchost.exe')
    ) {
      return true
    }
  }

  if (src === 'task') {
    const normalizedTask = taskPath.replace(/\//g, '\\').toLowerCase()
    if (normalizedTask.startsWith('\\microsoft\\') || publisher.includes('microsoft')) {
      return true
    }
  }

  return false
}

export function resolveStartupSourceLabel(source: StartupSourceType): StartupSourceLabel {
  switch (source) {
    case 'folder':
      return '启动目录'
    case 'service':
      return '后台服务'
    case 'task':
      return '计划任务'
    case 'launchd':
      return 'LaunchAgent'
    default:
      return '注册表'
  }
}

export function normalizeStartupEntry(raw: Record<string, unknown>): StartupEntryItem | null {
  const rawSource = String(raw.source ?? 'registry').toLowerCase()
  const source: StartupSourceType =
    rawSource === 'folder' || rawSource === 'service' || rawSource === 'task' || rawSource === 'launchd'
      ? (rawSource as StartupSourceType)
      : 'registry'

  const name = String(raw.name ?? '').trim()
  const command = String(raw.command ?? raw.path ?? '').trim()
  if (!name || !command) return null

  const exePath =
    typeof raw.exePath === 'string' && raw.exePath.trim()
      ? raw.exePath.trim()
      : extractExePathFromCommand(command)
  const publisher = String(raw.publisher ?? '').trim()
  const serviceName = typeof raw.serviceName === 'string' ? raw.serviceName.trim() : undefined
  const taskPath = typeof raw.taskPath === 'string' ? raw.taskPath.trim() : undefined
  const regKey = typeof raw.regKey === 'string' ? raw.regKey.trim() : undefined

  if (
    isMicrosoftProtectedStartupItem({
      source,
      name,
      ...(serviceName ? { serviceName } : {}),
      ...(taskPath ? { taskPath } : {}),
      publisher,
      exePath,
      command
    })
  ) {
    return null
  }

  const id = String(raw.id ?? `${source}:${serviceName ?? taskPath ?? name}`)
  const sourceLabel = resolveStartupSourceLabel(source)

  return {
    id,
    name,
    publisher,
    command,
    exePath,
    source,
    sourceLabel,
    scope: String(raw.scope ?? (source === 'service' || source === 'task' ? 'System' : 'User')),
    ...(regKey ? { regKey } : {}),
    ...(serviceName ? { serviceName } : {}),
    ...(taskPath ? { taskPath } : {}),
    enabled: Boolean(raw.enabled),
    fileMissing: Boolean(raw.fileMissing)
  }
}

function extractStartupErrorCode(errText?: string, rawCode?: unknown): string {
  if (typeof rawCode === 'string' && rawCode.trim()) return rawCode.trim()
  const msg = String(errText ?? '').trim()
  const m = msg.match(/^([A-Z0-9_]+):/)
  return m?.[1] ?? 'STARTUP_OPERATION_FAILED'
}

export function computeStartupScanSummary(items: StartupEntryItem[]): StartupScanSummary {
  return {
    ok: true,
    items,
    totalCount: items.length,
    enabledCount: items.filter((i) => i.enabled).length,
    serviceCount: items.filter((i) => i.source === 'service').length,
    taskCount: items.filter((i) => i.source === 'task').length,
    brokenCount: items.filter((i) => i.fileMissing).length
  }
}

export async function scanStartupItems(
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<StartupScanSummary> {
  const res = await invokePluginService<Record<string, unknown>>(
    STARTUP_MANAGER_PLUGIN_NAME,
    'listAll',
    extraParams,
    hostOverride
  )

  if (!res.ok || !res.data || res.data.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '扫描启动项失败')
    const errCode = extractStartupErrorCode(errText, res.data?.errorCode)
    return {
      ok: false,
      items: [],
      totalCount: 0,
      enabledCount: 0,
      serviceCount: 0,
      taskCount: 0,
      brokenCount: 0,
      errorCode: errCode,
      error: errText
    }
  }

  const rawList = Array.isArray(res.data.items)
    ? res.data.items
    : Array.isArray(res.data.startupItems)
      ? res.data.startupItems
      : []

  const items: StartupEntryItem[] = []
  for (const raw of rawList) {
    if (raw && typeof raw === 'object') {
      const normalized = normalizeStartupEntry(raw as Record<string, unknown>)
      if (normalized) items.push(normalized)
    }
  }

  return computeStartupScanSummary(items)
}

export async function setStartupItemEnabled(
  item: StartupEntryItem,
  targetEnabled: boolean,
  currentItems: StartupEntryItem[] = [],
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<StartupToggleResult> {
  if (!item || (!item.id && !item.name)) {
    return {
      ok: false,
      id: '',
      enabled: Boolean(item?.enabled),
      updatedItems: currentItems,
      errorCode: 'INVALID_IDENTIFIER',
      error: 'INVALID_IDENTIFIER: 缺少启动项标识'
    }
  }

  if (
    hasDangerousStartupTokens(item.id) ||
    hasDangerousStartupTokens(item.name) ||
    hasDangerousStartupTokens(item.serviceName ?? '') ||
    hasDangerousStartupTokens(item.taskPath ?? '')
  ) {
    return {
      ok: false,
      id: item.id,
      enabled: item.enabled,
      updatedItems: currentItems,
      errorCode: 'INVALID_IDENTIFIER',
      error: 'INVALID_IDENTIFIER: 启动项标识包含非法控制字符或注入风险片段，已拦截'
    }
  }

  if (isMicrosoftProtectedStartupItem(item)) {
    return {
      ok: false,
      id: item.id,
      enabled: item.enabled,
      updatedItems: currentItems,
      errorCode: 'PROTECTED_SYSTEM_ITEM',
      error: 'PROTECTED_SYSTEM_ITEM: 微软系统核心服务或系统任务受安全保护，禁止禁用'
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    STARTUP_MANAGER_PLUGIN_NAME,
    'setEnabled',
    {
      id: item.id,
      name: item.name,
      source: item.source,
      scope: item.scope,
      command: item.command,
      exePath: item.exePath,
      publisher: item.publisher,
      ...(item.serviceName ? { serviceName: item.serviceName } : {}),
      ...(item.taskPath ? { taskPath: item.taskPath } : {}),
      enabled: targetEnabled,
      ...extraParams
    },
    hostOverride
  )

  if (!res.ok || !res.data || res.data.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '切换启动项状态失败')
    const errCode = extractStartupErrorCode(errText, res.data?.errorCode)
    return {
      ok: false,
      id: item.id,
      enabled: item.enabled,
      updatedItems: currentItems,
      errorCode: errCode,
      error: errText
    }
  }

  const updatedItems = currentItems.map((entry) =>
    entry.id === item.id ? { ...entry, enabled: targetEnabled } : entry
  )

  return {
    ok: true,
    id: item.id,
    enabled: targetEnabled,
    updatedItems
  }
}

export async function removeBrokenStartupItems(
  targetBrokenItems: StartupEntryItem[],
  currentItems: StartupEntryItem[] = [],
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<StartupCleanBrokenResult> {
  if (!Array.isArray(targetBrokenItems) || targetBrokenItems.length === 0) {
    return {
      ok: false,
      removedCount: 0,
      removedIds: [],
      remainingItems: currentItems,
      errorCode: 'EMPTY_ITEMS',
      error: 'EMPTY_ITEMS: 当前没有可清理的无效残留启动项'
    }
  }

  for (const item of targetBrokenItems) {
    if (
      hasDangerousStartupTokens(item.id) ||
      hasDangerousStartupTokens(item.name)
    ) {
      return {
        ok: false,
        removedCount: 0,
        removedIds: [],
        remainingItems: currentItems,
        errorCode: 'INVALID_IDENTIFIER',
        error: 'INVALID_IDENTIFIER: 启动项标识包含非法字符，拒绝清理'
      }
    }
    if (!item.fileMissing) {
      return {
        ok: false,
        removedCount: 0,
        removedIds: [],
        remainingItems: currentItems,
        errorCode: 'ITEM_NOT_BROKEN',
        error: `ITEM_NOT_BROKEN: 启动项 "${item.name}" 的目标文件仍然存在，禁止作为残留项删除`
      }
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    STARTUP_MANAGER_PLUGIN_NAME,
    'removeBroken',
    {
      items: targetBrokenItems,
      ...extraParams
    },
    hostOverride
  )

  if (!res.ok || !res.data || res.data.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '清理残留启动项失败')
    const errCode = extractStartupErrorCode(errText, res.data?.errorCode)
    return {
      ok: false,
      removedCount: 0,
      removedIds: [],
      remainingItems: currentItems,
      errorCode: errCode,
      error: errText
    }
  }

  const removedIds = Array.isArray(res.data.removedIds)
    ? res.data.removedIds.map(String)
    : targetBrokenItems.map((i) => i.id)
  const removedSet = new Set(removedIds)
  const remainingItems = currentItems.filter((entry) => !removedSet.has(entry.id))

  return {
    ok: true,
    removedCount: removedIds.length,
    removedIds,
    remainingItems
  }
}

export function filterStartupItems(
  items: StartupEntryItem[],
  filter: StartupSourceFilter,
  searchQuery: string
): StartupEntryItem[] {
  const q = String(searchQuery ?? '').trim().toLowerCase()

  return items.filter((item) => {
    if (filter === 'app' && item.source !== 'registry' && item.source !== 'folder' && item.source !== 'launchd') {
      return false
    }
    if (filter === 'service' && item.source !== 'service') {
      return false
    }
    if (filter === 'task' && item.source !== 'task') {
      return false
    }
    if (filter === 'enabled' && !item.enabled) {
      return false
    }
    if (filter === 'broken' && !item.fileMissing) {
      return false
    }

    if (!q) return true
    return (
      item.name.toLowerCase().includes(q) ||
      item.publisher.toLowerCase().includes(q) ||
      item.command.toLowerCase().includes(q) ||
      item.exePath.toLowerCase().includes(q) ||
      item.sourceLabel.toLowerCase().includes(q)
    )
  })
}

export async function revealStartupExeInFolder(
  exePath: string,
  hostOverride?: unknown
): Promise<boolean> {
  return showRealItemInFolder(String(exePath ?? '').trim(), hostOverride)
}

export async function copyStartupCommandToClipboard(
  command: string,
  hostOverride?: unknown
): Promise<boolean> {
  return writeRealClipboardText(String(command ?? ''), hostOverride)
}
