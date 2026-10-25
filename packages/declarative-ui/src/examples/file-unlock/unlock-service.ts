import {
  invokePluginService,
  openRealPath,
  readRealClipboardText,
  showRealItemInFolder,
  trashRealItem,
  writeRealClipboardText
} from '../shared/native-ipc.js'
import type {
  FileUnlockExecutionResult,
  FileUnlockInspectionResult,
  HandleKind,
  LockingProcessItem,
  RemovableDriveItem,
  ServiceTypeLabel,
  UnlockProcessFilter
} from './types.js'

export const FILE_UNLOCK_PLUGIN_NAME = 'FileUnlockPlugin'

export const CRITICAL_KERNEL_PROCESS_NAMES = new Set([
  'system',
  'idle',
  'registry',
  'smss',
  'smss.exe',
  'csrss',
  'csrss.exe',
  'wininit',
  'wininit.exe',
  'services',
  'services.exe',
  'lsass',
  'lsass.exe',
  'svchost',
  'svchost.exe',
  'winlogon',
  'winlogon.exe',
  'dwm',
  'dwm.exe',
  'fontdrvhost',
  'fontdrvhost.exe',
  'memory compression',
  'spoolsv',
  'spoolsv.exe',
  'launchd',
  'kernel_task',
  'windowserver',
  'loginwindow'
])

export function normalizeProcessBaseName(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
}

export function isKernelProtectedProcess(pid: number, name: string): boolean {
  if (Number.isFinite(pid) && pid > 0 && pid <= 4) {
    return true
  }
  const lower = String(name ?? '').trim().toLowerCase()
  if (!lower) return false
  const base = normalizeProcessBaseName(lower)
  return CRITICAL_KERNEL_PROCESS_NAMES.has(lower) || CRITICAL_KERNEL_PROCESS_NAMES.has(base)
}

export function resolveServiceTypeLabel(
  pid: number,
  name: string,
  rawLabel?: string
): ServiceTypeLabel {
  if (isKernelProtectedProcess(pid, name)) {
    return '系统内核'
  }
  const base = normalizeProcessBaseName(name)
  if (base === 'explorer') {
    return '资源管理器'
  }
  const normalized = String(rawLabel ?? '').trim()
  if (normalized === '后台服务' || normalized.toLowerCase().includes('service') || normalized === '3') {
    return '后台服务'
  }
  return '普通进程'
}

export function sanitizeInputPath(rawInput: string): string {
  return String(rawInput ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()
}

export function looksLikeFilePath(rawInput: string): boolean {
  const cleaned = sanitizeInputPath(rawInput)
  if (!cleaned || cleaned.includes('\n') || cleaned.includes('\r')) return false
  return /^[a-zA-Z]:[\\/]/.test(cleaned) || /^\\\\[^\\]+\\[^\\]+/.test(cleaned) || cleaned.startsWith('/')
}

export function validateTargetPath(rawInput: string): {
  valid: boolean
  normalizedPath: string
  errorCode?: string
  error?: string
} {
  const cleaned = sanitizeInputPath(rawInput)
  if (!cleaned) {
    return {
      valid: false,
      normalizedPath: '',
      errorCode: 'INVALID_PATH',
      error: 'INVALID_PATH: 请输入或粘贴需要检测的文件、文件夹或盘符路径'
    }
  }
  if (cleaned.includes('\0')) {
    return {
      valid: false,
      normalizedPath: cleaned,
      errorCode: 'INVALID_PATH',
      error: 'INVALID_PATH: 路径包含非法空字节 (null byte)'
    }
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(cleaned)) {
    return {
      valid: false,
      normalizedPath: cleaned,
      errorCode: 'INVALID_PATH',
      error: 'INVALID_PATH: 禁止使用包含 .. 的路径穿越'
    }
  }
  if (!looksLikeFilePath(cleaned)) {
    return {
      valid: false,
      normalizedPath: cleaned,
      errorCode: 'INVALID_PATH',
      error: 'INVALID_PATH: 路径格式无效，请提供完整绝对路径（如 D:\\report.docx 或 /Volumes/USB）'
    }
  }
  return {
    valid: true,
    normalizedPath: cleaned
  }
}

export function normalizeLockingProcess(
  raw: Record<string, unknown>,
  fallbackTargetPath: string
): LockingProcessItem {
  const pid = Number(raw.pid ?? 0)
  const name = String(raw.name ?? `PID-${pid}`).trim()
  const executablePath = String(raw.executablePath ?? name).trim()
  const lockedPath = String(raw.lockedPath ?? fallbackTargetPath).trim()
  const isProtected = Boolean(raw.isProtected) || isKernelProtectedProcess(pid, name)
  const serviceTypeLabel = resolveServiceTypeLabel(
    pid,
    name,
    typeof raw.serviceTypeLabel === 'string' ? raw.serviceTypeLabel : undefined
  )
  const rawHandle = String(raw.handleType ?? 'file').toLowerCase()
  const handleType: HandleKind =
    rawHandle === 'directory' || rawHandle === 'dll' || rawHandle === 'unknown'
      ? (rawHandle as HandleKind)
      : 'file'

  return {
    id: String(raw.id ?? `${pid}-${lockedPath}`),
    pid,
    name,
    executablePath,
    lockedPath,
    handleType,
    serviceTypeLabel,
    isProtected,
    user: String(raw.user ?? 'User')
  }
}

export async function detectClipboardCandidatePath(hostOverride?: unknown): Promise<string> {
  try {
    const clip = await readRealClipboardText(hostOverride)
    const validation = validateTargetPath(clip)
    return validation.valid ? validation.normalizedPath : ''
  } catch {
    return ''
  }
}

export async function listRemovableDrives(hostOverride?: unknown): Promise<RemovableDriveItem[]> {
  const res = await invokePluginService<{ drives?: Array<Record<string, unknown>> }>(
    FILE_UNLOCK_PLUGIN_NAME,
    'listRemovableDrives',
    {},
    hostOverride
  )
  if (!res.ok || !res.data || !Array.isArray(res.data.drives)) {
    return []
  }
  return res.data.drives
    .map((d) => ({
      mount: String(d.mount ?? ''),
      label: String(d.label ?? '可移动磁盘'),
      totalBytes: Number(d.totalBytes ?? 0),
      freeBytes: Number(d.freeBytes ?? 0),
      totalText: String(d.totalText ?? '0 B'),
      freeText: String(d.freeText ?? '0 B')
    }))
    .filter((d) => Boolean(d.mount))
}

function extractErrorCode(errorMsg?: string, rawCode?: unknown): string {
  if (typeof rawCode === 'string' && rawCode.trim()) {
    return rawCode.trim()
  }
  const msg = String(errorMsg ?? '').trim()
  const m = msg.match(/^([A-Z0-9_]+):/)
  return m?.[1] ?? 'UNLOCK_FAILED'
}

export async function inspectTargetLocks(
  rawTargetPath: string,
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<FileUnlockInspectionResult> {
  const validation = validateTargetPath(rawTargetPath)
  if (!validation.valid) {
    return {
      ok: false,
      targetPath: validation.normalizedPath,
      isDirectory: false,
      isUnlocked: false,
      processes: [],
      errorCode: validation.errorCode ?? 'INVALID_PATH',
      error: validation.error ?? '路径格式无效'
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    FILE_UNLOCK_PLUGIN_NAME,
    'inspectLocks',
    {
      targetPath: validation.normalizedPath,
      ...extraParams
    },
    hostOverride
  )

  if (!res.ok || !res.data || res.data.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '扫描占用句柄失败')
    const errCode = extractErrorCode(errText, res.data?.errorCode)
    return {
      ok: false,
      targetPath: validation.normalizedPath,
      isDirectory: false,
      isUnlocked: false,
      processes: [],
      errorCode: errCode,
      error: errText
    }
  }

  const rawList = Array.isArray(res.data.processes)
    ? res.data.processes
    : Array.isArray(res.data.lockingProcesses)
      ? res.data.lockingProcesses
      : []

  const resolvedTarget = String(res.data.targetPath ?? validation.normalizedPath)
  const processes = rawList
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => normalizeLockingProcess(item, resolvedTarget))

  return {
    ok: true,
    targetPath: resolvedTarget,
    isDirectory: Boolean(res.data.isDirectory),
    isUnlocked: processes.length === 0,
    processes
  }
}

export async function unlockSingleProcess(
  proc: LockingProcessItem,
  targetPath: string,
  options: {
    trashAfterUnlock?: boolean
    renameTo?: string
    extraParams?: Record<string, unknown>
  } = {},
  hostOverride?: unknown
): Promise<FileUnlockExecutionResult> {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) {
    return {
      ok: false,
      unlockedCount: 0,
      skippedProtectedCount: 0,
      errorCode: 'INVALID_PID',
      error: 'INVALID_PID: 无效的进程 PID'
    }
  }

  if (proc.isProtected || isKernelProtectedProcess(proc.pid, proc.name)) {
    return {
      ok: false,
      pid: proc.pid,
      expectedName: proc.name,
      unlockedCount: 0,
      skippedProtectedCount: 1,
      errorCode: 'PROCESS_PROTECTED',
      error: `PROCESS_PROTECTED: 系统关键保护进程 (${proc.name}, PID ${proc.pid}) 受安全策略保护，严禁强制终止`
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    FILE_UNLOCK_PLUGIN_NAME,
    'unlockPath',
    {
      pid: proc.pid,
      expectedName: proc.name,
      targetPath: sanitizeInputPath(targetPath || proc.lockedPath),
      trashAfterUnlock: Boolean(options.trashAfterUnlock),
      ...(options.renameTo ? { renameTo: options.renameTo } : {}),
      ...(options.extraParams ?? {})
    },
    hostOverride
  )

  if (!res.ok || !res.data || res.data.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '解除文件占用失败')
    const errCode = extractErrorCode(errText, res.data?.errorCode)
    return {
      ok: false,
      pid: proc.pid,
      expectedName: proc.name,
      unlockedCount: 0,
      skippedProtectedCount: errCode === 'PROCESS_PROTECTED' ? 1 : 0,
      errorCode: errCode,
      error: errText
    }
  }

  return {
    ok: true,
    pid: proc.pid,
    expectedName: proc.name,
    unlockedCount: 1,
    skippedProtectedCount: 0,
    explorerRestarted: Boolean(res.data.explorerRestarted),
    trashed: Boolean(res.data.trashed),
    ...(typeof res.data.renamedPath === 'string' ? { renamedPath: res.data.renamedPath } : {})
  }
}

export async function unlockAllProcesses(
  processes: LockingProcessItem[],
  targetPath: string,
  options: {
    trashAfterUnlock?: boolean
    renameTo?: string
    extraParams?: Record<string, unknown>
  } = {},
  hostOverride?: unknown
): Promise<FileUnlockExecutionResult> {
  const validation = validateTargetPath(targetPath)
  if (!validation.valid) {
    return {
      ok: false,
      unlockedCount: 0,
      skippedProtectedCount: 0,
      errorCode: validation.errorCode ?? 'INVALID_PATH',
      error: validation.error ?? '目标路径无效'
    }
  }

  const killable = processes.filter((p) => !p.isProtected && !isKernelProtectedProcess(p.pid, p.name))
  const protectedCount = processes.length - killable.length

  if (processes.length > 0 && killable.length === 0) {
    return {
      ok: false,
      unlockedCount: 0,
      skippedProtectedCount: protectedCount,
      errorCode: 'PROCESS_PROTECTED',
      error: 'PROCESS_PROTECTED: 当前占用均为系统关键保护进程，禁止强制终止'
    }
  }

  if (killable.length === 0 && options.trashAfterUnlock) {
    const trashRes = await trashRealItem(validation.normalizedPath, hostOverride)
    if (!trashRes.ok) {
      return {
        ok: false,
        unlockedCount: 0,
        skippedProtectedCount: 0,
        errorCode: 'TRASH_FAILED',
        error: trashRes.error ?? '移入回收站失败'
      }
    }
    return {
      ok: true,
      unlockedCount: 0,
      skippedProtectedCount: 0,
      trashed: true
    }
  }

  let unlockedCount = 0
  let explorerRestarted = false
  let trashed = false
  let renamedPath: string | undefined

  for (let i = 0; i < killable.length; i++) {
    const proc = killable[i]!
    const isLast = i === killable.length - 1
    const singleRes = await unlockSingleProcess(
      proc,
      validation.normalizedPath,
      {
        trashAfterUnlock: Boolean(isLast && options.trashAfterUnlock && protectedCount === 0),
        renameTo: isLast && protectedCount === 0 ? options.renameTo : undefined,
        extraParams: options.extraParams
      },
      hostOverride
    )
    if (!singleRes.ok) {
      return {
        ...singleRes,
        unlockedCount,
        skippedProtectedCount: protectedCount + singleRes.skippedProtectedCount
      }
    }
    unlockedCount += 1
    if (singleRes.explorerRestarted) explorerRestarted = true
    if (singleRes.trashed) trashed = true
    if (singleRes.renamedPath) renamedPath = singleRes.renamedPath
  }

  return {
    ok: true,
    unlockedCount,
    skippedProtectedCount: protectedCount,
    explorerRestarted,
    trashed,
    ...(renamedPath ? { renamedPath } : {})
  }
}

export async function unlockAndTrashTarget(
  processes: LockingProcessItem[],
  targetPath: string,
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<FileUnlockExecutionResult> {
  return unlockAllProcesses(
    processes,
    targetPath,
    {
      trashAfterUnlock: true,
      extraParams
    },
    hostOverride
  )
}

export function filterLockingProcesses(
  processes: LockingProcessItem[],
  filter: UnlockProcessFilter,
  query: string
): LockingProcessItem[] {
  const q = sanitizeInputPath(query).toLowerCase()
  const isPathQuery = looksLikeFilePath(query)

  return processes.filter((proc) => {
    if (filter === 'killable' && proc.isProtected) return false
    if (filter === 'protected' && !proc.isProtected) return false
    if (!q || isPathQuery) return true
    return (
      proc.name.toLowerCase().includes(q) ||
      String(proc.pid).includes(q) ||
      proc.executablePath.toLowerCase().includes(q) ||
      proc.serviceTypeLabel.toLowerCase().includes(q)
    )
  })
}

export async function revealLockedTargetInFolder(
  targetPath: string,
  hostOverride?: unknown
): Promise<boolean> {
  return showRealItemInFolder(sanitizeInputPath(targetPath), hostOverride)
}

export async function revealProcessExecutableInFolder(
  executablePath: string,
  hostOverride?: unknown
): Promise<boolean> {
  return showRealItemInFolder(sanitizeInputPath(executablePath), hostOverride)
}

export async function openUnlockedTarget(
  targetPath: string,
  hostOverride?: unknown
): Promise<boolean> {
  return openRealPath(sanitizeInputPath(targetPath), hostOverride)
}

export async function copyProcessInfoToClipboard(
  text: string,
  hostOverride?: unknown
): Promise<boolean> {
  return writeRealClipboardText(text, hostOverride)
}
