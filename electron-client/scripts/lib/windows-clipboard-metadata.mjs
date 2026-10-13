import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const reportScope = 'read-only-win32-clipboard-lock-metadata'
const reportMaxBytes = 64 * 1024
const reportMaxAgeMs = 30 * 60 * 1000
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isReadOnlyProbeMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
    metadata.status === 'OBSERVED' && Number.isInteger(metadata.sessionId) && metadata.sessionId >= 0 &&
    metadata.contentRead === false && metadata.contentWritten === false
}

function isUnownedAccessDeniedProbe(metadata) {
  return isReadOnlyProbeMetadata(metadata) && metadata.canOpen === false && metadata.openErrorCode === 5 &&
    metadata.holderPresent === false && metadata.holderPid === 0 &&
    metadata.ownerPresent === false && metadata.ownerPid === 0
}

function isAccessibleProbe(metadata) {
  return isReadOnlyProbeMetadata(metadata) && metadata.canOpen === true && metadata.openErrorCode === 0
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
}

/** Run a fixed Win32 metadata-only probe. It never reads or writes clipboard contents. */
export function runReadOnlyWindowsClipboardProbe() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_CLIPBOARD_PROBE_PLATFORM_UNSUPPORTED')
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) throw new Error('WINDOWS_SYSTEM_ROOT_UNAVAILABLE')
  const powershellPath = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ClipboardMetadata { [DllImport("user32.dll")] public static extern IntPtr GetOpenClipboardWindow(); [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner(); [DllImport("user32.dll",SetLastError=true)] public static extern bool OpenClipboard(IntPtr h); [DllImport("user32.dll")] public static extern bool CloseClipboard(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }'; $holder=[ClipboardMetadata]::GetOpenClipboardWindow(); $owner=[ClipboardMetadata]::GetClipboardOwner(); [uint32]$holderPid=0; [uint32]$ownerPid=0; [void][ClipboardMetadata]::GetWindowThreadProcessId($holder,[ref]$holderPid); [void][ClipboardMetadata]::GetWindowThreadProcessId($owner,[ref]$ownerPid); $opened=[ClipboardMetadata]::OpenClipboard([IntPtr]::Zero); $errorCode=if($opened){0}else{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}; if($opened){[void][ClipboardMetadata]::CloseClipboard()}; @{status='OBSERVED';holderPresent=($holder -ne [IntPtr]::Zero);holderPid=$holderPid;ownerPresent=($owner -ne [IntPtr]::Zero);ownerPid=$ownerPid;canOpen=$opened;openErrorCode=$errorCode;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;contentRead=$false;contentWritten=$false}|ConvertTo-Json -Compress`
  const result = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: reportMaxBytes
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length > reportMaxBytes) {
    throw new Error('CURRENT_CLIPBOARD_OS_PROBE_FAILED')
  }
  let probe
  try { probe = JSON.parse(result.stdout.trim()) }
  catch { throw new Error('CURRENT_CLIPBOARD_OS_PROBE_OUTPUT_INVALID') }
  if (!isReadOnlyProbeMetadata(probe) ||
      !(isAccessibleProbe(probe) || isUnownedAccessDeniedProbe(probe))) {
    throw new Error('CURRENT_CLIPBOARD_OS_PROBE_METADATA_INVALID')
  }
  return {
    status: probe.status,
    sessionId: probe.sessionId,
    canOpen: probe.canOpen,
    openErrorCode: probe.openErrorCode,
    holderPresent: probe.holderPresent,
    holderPid: probe.holderPid,
    ownerPresent: probe.ownerPresent,
    ownerPid: probe.ownerPid,
    contentRead: false,
    contentWritten: false
  }
}

/** Read a bounded, non-symlink OS probe report without accepting executable input. */
export function readClipboardOsProbeReport(reportPath) {
  if (typeof reportPath !== 'string' || !path.win32.isAbsolute(reportPath)) {
    throw new Error('CLIPBOARD_OS_PROBE_REPORT_PATH_INVALID')
  }
  const resolvedPath = path.resolve(reportPath)
  const pathStat = fs.lstatSync(resolvedPath)
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > reportMaxBytes ||
      !sameWindowsPath(fs.realpathSync.native(resolvedPath), resolvedPath)) {
    throw new Error('CLIPBOARD_OS_PROBE_REPORT_PATH_INVALID')
  }
  const fd = fs.openSync(resolvedPath, 'r')
  let reportText
  try {
    const openedStat = fs.fstatSync(fd)
    if (!openedStat.isFile() || openedStat.size > reportMaxBytes) throw new Error('CLIPBOARD_OS_PROBE_REPORT_SIZE_INVALID')
    const buffer = Buffer.alloc(reportMaxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > reportMaxBytes || fs.fstatSync(fd).size > reportMaxBytes ||
        !sameWindowsPath(fs.realpathSync.native(resolvedPath), resolvedPath)) {
      throw new Error('CLIPBOARD_OS_PROBE_REPORT_SIZE_INVALID')
    }
    reportText = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
  const report = JSON.parse(reportText)
  return { path: resolvedPath, report }
}

/** Validate a recent, read-only report from the exact Windows clipboard metadata scope. */
export function validateClipboardOsProbeReport(report) {
  const errors = []
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { status: 'FAIL', errors: ['REPORT_INVALID'] }
  if (report.schemaVersion !== 1) errors.push('SCHEMA_VERSION_INVALID')
  if (!uuidPattern.test(report.runId ?? '')) errors.push('RUN_ID_INVALID')
  if (report.platform !== 'win32' || report.arch !== 'x64') errors.push('PLATFORM_INVALID')
  if (report.scope !== reportScope || report.status !== 'OBSERVED' || report.exitCode !== 0) errors.push('SCOPE_OR_STATUS_INVALID')
  if (!isUnownedAccessDeniedProbe(report.metadata)) errors.push('ACCESS_DENIED_METADATA_INVALID')
  const createdAtMs = Date.parse(report.createdAt)
  const ageMs = Date.now() - createdAtMs
  if (!Number.isFinite(createdAtMs) || ageMs < 0 || ageMs > reportMaxAgeMs) errors.push('REPORT_STALE')
  return errors.length === 0 ? {
    status: 'PASS', runId: report.runId, createdAt: report.createdAt, sessionId: report.metadata.sessionId
  } : { status: 'FAIL', errors }
}

/** Require a matching recent report before treating current OpenClipboard error 5 as an OS denial. */
export function classifyClipboardAccessEvidence(report, currentProbe) {
  if (isAccessibleProbe(currentProbe)) return { status: 'ACCESSIBLE', sessionId: currentProbe.sessionId }
  if (!isUnownedAccessDeniedProbe(currentProbe)) {
    return { status: 'FAIL', reason: 'CURRENT_PROBE_NOT_CONFIRMED_ACCESS_DENIED' }
  }
  const evidence = validateClipboardOsProbeReport(report)
  if (evidence.status !== 'PASS') return { status: 'FAIL', reason: 'OS_PROBE_REPORT_INVALID', errors: evidence.errors }
  if (evidence.sessionId !== currentProbe.sessionId) return { status: 'FAIL', reason: 'OS_PROBE_SESSION_MISMATCH' }
  return { status: 'OS_ACCESS_DENIED_CONFIRMED', reportRunId: evidence.runId,
    reportCreatedAt: evidence.createdAt, sessionId: currentProbe.sessionId, openErrorCode: 5 }
}
