import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { monitorRecord, parseMonitorDisplay, validateMonitorRequest, type MonitorDisplay, type MonitorRequest } from '../../contracts/monitor-control.js'
import { t } from '../i18n/index.js'
import { windowsMonitorInvocation, windowsPowerShellPath } from '../platform/windows/monitor-helper.js'

export type MonitorRunner = (executable: string, args: string[], input: string | undefined, timeoutMs: number) => Promise<{ stdout: string; exitCode: number }>
/**
 * 单次显示器组件的最长运行时间（到点强制结束进程）。macOS 原生组件保持 15 秒。
 * Windows 每次要启动 PowerShell 并编译 C#：列表与熄屏 25 秒；调节要逐台 DDC 写入、读回，失败时还要恢复原值，
 * 多台同时调节时固定时限可能在恢复途中杀掉进程，所以按变更数放宽：20 秒 + 每项 6 秒，最多 120 秒。
 */
export function monitorTimeoutMs(request: MonitorRequest, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return 15000
  return request.action === 'set' ? Math.min(120000, 20000 + 6000 * request.changes.length) : 25000
}
const run: MonitorRunner = (executable, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = execFile(executable, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
    if (error && !stdout) reject(new ZToolsError(errorCodes.screenError, 'System operation did not complete; changes may have partially taken effect, scan again to verify'))
    else resolve({ stdout, exitCode: error ? 1 : 0 })
  })
  child.stdin?.on('error', () => { /* 子进程提前结束由回调报告，不能吞掉最终操作错误。 */ })
  child.stdin?.end(input)
})
const messages: Record<string, string> = {
  DISPLAY_STATE_CHANGED: 'Display state or connection changed; scan again before adjusting',
  DISPLAY_DISCONNECTED: 'Selected display is disconnected; scan again',
  DISPLAY_ID_AMBIGUOUS: 'Unable to uniquely identify display; operation stopped',
  DISPLAY_CONTROL_UNAVAILABLE: 'This hardware control is currently unavailable for the display',
  DISPLAY_MIRROR_UNSUPPORTED: 'Cannot confirm an independent control target in mirror mode; exit mirror mode and retry',
  DISPLAY_READ_FAILED: 'Failed to read actual display state; check device and cable then scan again',
  DISPLAY_WRITE_FAILED_RESTORED: 'Adjustment did not complete; original value verified and restored',
  DISPLAY_WRITE_OUTCOME_UNKNOWN: 'Some display states could not be restored or were modified externally; scan again to verify',
  DISPLAY_LIST_FAILED: 'Failed to list connected displays; scan again',
  DISPLAY_SLEEP_REJECTED: 'System rejected the display sleep request',
  DISPLAY_HELPER_FAILED: 'Display helper failed; scan again, and report the issue if it persists'
}
const reasonCodeKeys: Record<string, string> = {
  BRIGHTNESS_UNREADABLE: 'monitor.reason.brightnessUnreadable',
  MIRROR_UNSUPPORTED: 'monitor.reason.mirrorUnsupported',
  CONTROL_CHANNEL_AMBIGUOUS: 'monitor.reason.controlChannelAmbiguous'
}

/** 将原生显示器侧车返回的结构化原因码与回退显示名按当前 locale 本地化 */
export function localizeMonitorDisplay(display: MonitorDisplay): MonitorDisplay {
  const fallbackIndex = typeof display.fallbackDisplayIndex === 'number' ? display.fallbackDisplayIndex : undefined
  const reasonKey = display.reasonCode && Object.hasOwn(reasonCodeKeys, display.reasonCode)
    ? reasonCodeKeys[display.reasonCode]
    : undefined
  if (fallbackIndex === undefined && !reasonKey) return display
  const { fallbackDisplayIndex: _discarded, ...rest } = display
  return {
    ...rest,
    ...(fallbackIndex !== undefined ? { name: t('monitor.displayFallbackName', { id: fallbackIndex }) } : {}),
    ...(reasonKey ? { reason: t(reasonKey) } : {})
  }
}

export function macDisplayHelperPath(packaged: boolean, resources: string) {
  return packaged ? path.join(resources, 'native', 'ZToolsMacDisplay') : path.resolve(__dirname, '../../mac-display-native/native/ZToolsMacDisplay')
}
/** 显示器组件：macOS 为原生组件，Windows 为系统自带的 PowerShell（组件源码随请求传入） */
export function monitorHelperPath(packaged: boolean, resources: string, platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? windowsPowerShellPath() : macDisplayHelperPath(packaged, resources)
}
export class MonitorControlService {
  #stopped = false
  #pending: Promise<unknown> | undefined
  constructor(private readonly executable: string, private readonly platform: NodeJS.Platform = process.platform, private readonly runner: MonitorRunner = run) {
    if (!(platform === 'win32' ? path.win32.isAbsolute(executable) : path.isAbsolute(executable))) throw new Error('Display helper path must be absolute')
  }
  async stop() { this.#stopped = true; await this.#pending?.catch(() => { /* 请求调用方接收实际失败；关闭只等待清理。 */ }) }
  #checkBeforeStart(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, 'Monitor control service has stopped')
  }
  async #run(executable: string, args: string[], input: string | undefined, timeoutMs: number) {
    try { return await this.runner(executable, args, input, timeoutMs) }
    catch { throw new ZToolsError(errorCodes.screenError, 'System operation did not complete; changes may have partially taken effect, scan again to verify') }
  }
  async execute(value: unknown, signal: AbortSignal) {
    validateMonitorRequest(value); signal.throwIfAborted()
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, 'Monitor control service has stopped')
    if (this.platform !== 'darwin' && this.platform !== 'win32') throw new ZToolsError(errorCodes.notSupported, 'Monitor control is not supported on this platform')
    if (this.#pending) throw new ZToolsError(errorCodes.invalidRequest, 'A monitor operation is already in progress; please wait')
    const pending = this.#execute(value, signal); this.#pending = pending
    try { return await pending } finally { if (this.#pending === pending) this.#pending = undefined }
  }
  async #execute(request: MonitorRequest, signal: AbortSignal) {
    if (request.action === 'sleep' && this.platform === 'darwin') {
      this.#checkBeforeStart(signal)
      const result = await this.#run('/usr/bin/pmset', ['displaysleepnow'], undefined, monitorTimeoutMs(request, this.platform))
      if (result.exitCode !== 0) throw new ZToolsError(errorCodes.screenError, 'System rejected the display sleep request')
      return { success: true, requested: true }
    }
    const stat = await fs.lstat(this.executable).catch(() => { throw new ZToolsError(errorCodes.screenError, 'Native display helper is not built; update or rebuild the client') })
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ZToolsError(errorCodes.screenError, 'Native display helper is invalid')
    this.#checkBeforeStart(signal)
    // 写入开始后由原生进程完成回读或恢复；不能因关闭页面中途杀死恢复过程。
    const invocation = this.platform === 'win32' ? windowsMonitorInvocation({ version: 1, ...request }) : { args: [], input: JSON.stringify({ version: 1, ...request }) }
    const result = await this.#run(this.executable, invocation.args, invocation.input, monitorTimeoutMs(request, this.platform))
    let response: unknown
    try { response = JSON.parse(result.stdout) }
    catch { throw new ZToolsError(errorCodes.screenError, 'Invalid response from native display helper; scan again to verify') }
    if (!monitorRecord(response) || response.version !== 1) throw new ZToolsError(errorCodes.screenError, 'Invalid response from native display helper; scan again to verify')
    if (response.success !== true || result.exitCode !== 0) throw new ZToolsError(errorCodes.screenError, messages[String(response.code)] || 'Monitor operation success could not be confirmed; scan again to verify')
    if (request.action === 'sleep') {
      if (response.requested !== true) throw new ZToolsError(errorCodes.screenError, 'System rejected the display sleep request')
      return { success: true, requested: true }
    }
    if (request.action === 'list') {
      signal.throwIfAborted()
      if (!Array.isArray(response.displays) || response.displays.length > 31 || typeof response.topology !== 'string') throw new ZToolsError(errorCodes.screenError, 'Invalid display list response')
      const displays = response.displays.map((item) => localizeMonitorDisplay(parseMonitorDisplay(item)))
      if (new Set(displays.map(d => d.id)).size !== displays.length) throw new ZToolsError(errorCodes.screenError, 'Duplicate display identifier')
      return { success: true, displays, topology: response.topology }
    }
    if (!Array.isArray(response.changed) || response.changed.length !== request.changes.length) throw new ZToolsError(errorCodes.screenError, 'Incomplete adjustment receipt; scan again to verify')
    const seen = new Set<string>()
    for (const item of response.changed) {
      if (!monitorRecord(item)) throw new ZToolsError(errorCodes.screenError, 'Invalid adjustment receipt; scan again to verify')
      const key = `${item.id}:${item.control}`, wanted = request.changes.find(c => c.id === item.id && c.control === item.control)
      if (!wanted || seen.has(key) || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0 || item.value > 100 || !Number.isSafeInteger(item.maximum) || Number(item.maximum) < 0 || Number(item.maximum) > 65535) throw new ZToolsError(errorCodes.screenError, 'Adjustment readback does not match target; scan again to verify')
      const maximum = Number(item.maximum)
      const target = maximum ? Math.round(wanted.value * maximum / 100) * 100 / maximum : Math.fround(wanted.value / 100) * 100
      const tolerance = maximum ? Math.min(2, 10 / maximum) : 0.0001
      if (Math.abs(item.value - target) > tolerance) throw new ZToolsError(errorCodes.screenError, 'Adjustment readback does not match hardware step; scan again to verify')
      seen.add(key)
    }
    return { success: true, changed: response.changed }
  }
}
