import { execFile } from 'node:child_process'
import path from 'node:path'

/** present：有电池；absent：系统明确报告没有电池；unknown：无法判断（含读取失败） */
export type SystemBatteryPresence = 'present' | 'absent' | 'unknown'
/** ac：交流供电；battery：电池供电；unknown：系统未报告 */
export type SystemPowerSource = 'ac' | 'battery' | 'unknown'

/**
 * system_get_battery_status 的结果。
 * percent / isCharging / timeRemaining 保持旧约定（255 = 电量未知，isCharging = 接入交流电，-1 = 剩余时间未知），
 * 旧约定分不清「没有电池」「电量未知」「读取失败」，所以另给 batteryState / powerSource / readError 三个字段。
 */
export interface SystemBatteryStatus {
  percent: number
  isCharging: boolean
  timeRemaining: number
  batteryState?: SystemBatteryPresence
  powerSource?: SystemPowerSource
  /** 读取失败原因；有值时其余字段都是未知值 */
  readError?: string
}

/** 执行外部命令并返回标准输出；非零退出、超时都要抛错 */
export type BatteryCommandRunner = (file: string, args: string[]) => Promise<string>

export const UNKNOWN_BATTERY_PERCENT = 255

function unknownStatus(readError?: string): SystemBatteryStatus {
  return { percent: UNKNOWN_BATTERY_PERCENT, isCharging: false, timeRemaining: -1, batteryState: 'unknown', powerSource: 'unknown', ...(readError ? { readError } : {}) }
}

/**
 * Windows：GetSystemPowerStatus 给电量与供电状态，Win32_Battery 实例数判断有没有电池。
 * CIM 查询失败时 batteryCount 为 -1，只靠 BatteryFlag 判断。兼容 Windows PowerShell 5.1。
 */
export const WINDOWS_BATTERY_STATUS_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ZToolsPowerStatus {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct SYSTEM_POWER_STATUS {',
  '    public byte ACLineStatus;',
  '    public byte BatteryFlag;',
  '    public byte BatteryLifePercent;',
  '    public byte Reserved;',
  '    public uint BatteryLifeTime;',
  '    public uint BatteryFullLifeTime;',
  '  }',
  '  [DllImport("kernel32.dll")]',
  '  public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);',
  '}',
  "'@",
  '$status = New-Object ZToolsPowerStatus+SYSTEM_POWER_STATUS',
  'if (-not [ZToolsPowerStatus]::GetSystemPowerStatus([ref]$status)) { [Console]::Error.WriteLine("GetSystemPowerStatus failed"); exit 1 }',
  '$batteryCount = -1',
  'try { $batteryCount = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop).Count } catch { $batteryCount = -1 }',
  '$lifeTime = [int64]$status.BatteryLifeTime',
  'if ($status.BatteryLifeTime -eq [uint32]::MaxValue) { $lifeTime = -1 }',
  '[pscustomobject]@{',
  '  acLineStatus = [int]$status.ACLineStatus',
  '  batteryFlag = [int]$status.BatteryFlag',
  '  percent = [int]$status.BatteryLifePercent',
  '  lifeTime = $lifeTime',
  '  batteryCount = [int]$batteryCount',
  '} | ConvertTo-Json -Compress'
].join('\n')

function byteField(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) throw new Error(`电源状态字段 ${key} 无效`)
  return value
}

/** 解析 WINDOWS_BATTERY_STATUS_SCRIPT 的输出；格式不对直接抛错，不猜默认值 */
export function parseWindowsBatteryStatusOutput(stdout: string): SystemBatteryStatus {
  let value: unknown
  try { value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) } catch { throw new Error('电源状态输出不是有效 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('电源状态输出格式无效')
  const row = value as Record<string, unknown>
  const acLine = byteField(row, 'acLineStatus'), flag = byteField(row, 'batteryFlag'), rawPercent = byteField(row, 'percent')
  const lifeTime = row.lifeTime, count = row.batteryCount
  if (typeof lifeTime !== 'number' || !Number.isSafeInteger(lifeTime) || lifeTime < -1) throw new Error('电池剩余时间字段无效')
  if (typeof count !== 'number' || !Number.isInteger(count) || count < -1) throw new Error('电池数量字段无效')
  // BatteryFlag：128 = 没有系统电池，255 = 未知；BatteryLifePercent：255 = 未知
  const flagKnown = flag !== 255, flagNoBattery = flagKnown && (flag & 128) !== 0
  const percent = rawPercent <= 100 ? rawPercent : UNKNOWN_BATTERY_PERCENT
  let batteryState: SystemBatteryPresence
  if (count > 0) batteryState = 'present'
  else if (flagNoBattery) batteryState = 'absent'
  else if (count === 0) batteryState = flagKnown && percent !== UNKNOWN_BATTERY_PERCENT ? 'present' : 'absent'
  else batteryState = flagKnown ? 'present' : 'unknown'
  const powerSource: SystemPowerSource = acLine === 1 ? 'ac' : acLine === 0 ? 'battery' : 'unknown'
  return {
    percent: batteryState === 'present' ? percent : UNKNOWN_BATTERY_PERCENT,
    isCharging: powerSource === 'ac',
    timeRemaining: batteryState === 'present' ? lifeTime : -1,
    batteryState,
    powerSource
  }
}

/** 解析 macOS `pmset -g batt`：有 InternalBattery 行才算有电池，只有供电来源行的是台式机 */
export function parseMacBatteryStatusOutput(stdout: string): SystemBatteryStatus {
  const text = String(stdout ?? '')
  const source = /drawing from '([^']+)'/i.exec(text)?.[1]
  const powerSource: SystemPowerSource = !source ? 'unknown' : /AC Power/i.test(source) ? 'ac' : /Battery Power/i.test(source) ? 'battery' : 'unknown'
  const batteryLine = text.split(/\r?\n/).find(line => /InternalBattery/i.test(line))
  if (!batteryLine) {
    if (!source) throw new Error('pmset 输出无法识别')
    return { percent: UNKNOWN_BATTERY_PERCENT, isCharging: powerSource === 'ac', timeRemaining: -1, batteryState: 'absent', powerSource }
  }
  const percentMatch = /(\d{1,3})%/.exec(batteryLine)
  const rawPercent = percentMatch ? Number.parseInt(percentMatch[1] ?? '', 10) : Number.NaN
  const percent = Number.isInteger(rawPercent) && rawPercent >= 0 && rawPercent <= 100 ? rawPercent : UNKNOWN_BATTERY_PERCENT
  const isCharging = powerSource === 'ac' || (powerSource === 'unknown' && /charging|charged|AC attached/i.test(batteryLine) && !/discharging/i.test(batteryLine))
  const timeMatch = /(\d+):(\d+)\s+remaining/i.exec(batteryLine)
  const timeRemaining = timeMatch ? Number.parseInt(timeMatch[1] ?? '0', 10) * 3600 + Number.parseInt(timeMatch[2] ?? '0', 10) * 60 : -1
  return { percent, isCharging, timeRemaining, batteryState: 'present', powerSource }
}

/** 把子进程错误转成用户看得懂的原因（超时 / 退出码 / 无法启动） */
export function describeBatteryCommandError(error: unknown): string {
  const err = error as { killed?: boolean; signal?: string | null; code?: unknown; stderr?: unknown; message?: unknown }
  if (err?.killed || err?.code === 'ETIMEDOUT') return '读取超时'
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) : ''
  if (typeof err?.code === 'number') return `命令退出码 ${err.code}${stderr ? `：${stderr}` : ''}`
  if (typeof err?.code === 'string') return `无法启动命令（${err.code}）`
  return typeof err?.message === 'string' && err.message ? err.message.slice(0, 200) : String(error)
}

const defaultRunner: BatteryCommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr: String(stderr ?? '') }))
    else resolve(String(stdout ?? ''))
  })
})

/** 读取失败不抛错（保持旧接口不报错的约定），原因写进 readError，batteryState 为 unknown */
export async function readSystemBatteryStatus(platform: NodeJS.Platform = process.platform, run: BatteryCommandRunner = defaultRunner): Promise<SystemBatteryStatus> {
  if (platform === 'darwin') {
    let stdout: string
    try { stdout = await run('/usr/bin/pmset', ['-g', 'batt']) } catch (error) { return unknownStatus(`电源状态${describeBatteryCommandError(error)}`) }
    try { return parseMacBatteryStatusOutput(stdout) } catch (error) { return unknownStatus(error instanceof Error ? error.message : String(error)) }
  }
  if (platform !== 'win32') return unknownStatus('当前平台不支持读取电源状态')
  const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let stdout: string
  try { stdout = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_BATTERY_STATUS_SCRIPT]) } catch (error) { return unknownStatus(`电源状态${describeBatteryCommandError(error)}`) }
  try { return parseWindowsBatteryStatusOutput(stdout) } catch (error) { return unknownStatus(error instanceof Error ? error.message : String(error)) }
}
