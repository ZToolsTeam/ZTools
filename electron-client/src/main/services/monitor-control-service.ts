import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { monitorRecord, parseMonitorDisplay, validateMonitorRequest, type MonitorRequest } from '../../contracts/monitor-control.js'
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
    if (error && !stdout) reject(new ZToolsError(errorCodes.screenError, '系统操作未能完成，结果可能已部分生效，请重新扫描确认'))
    else resolve({ stdout, exitCode: error ? 1 : 0 })
  })
  child.stdin?.on('error', () => { /* 子进程提前结束由回调报告，不能吞掉最终操作错误。 */ })
  child.stdin?.end(input)
})
const messages: Record<string, string> = {
  DISPLAY_STATE_CHANGED: '显示器状态或连接已变化，请重新扫描后再操作',
  DISPLAY_DISCONNECTED: '所选显示器已断开，请重新扫描',
  DISPLAY_ID_AMBIGUOUS: '无法唯一识别显示器，已停止操作',
  DISPLAY_CONTROL_UNAVAILABLE: '该显示器当前无法进行此项硬件调节',
  DISPLAY_MIRROR_UNSUPPORTED: '镜像模式下无法确认独立控制目标，请退出镜像后重试',
  DISPLAY_READ_FAILED: '未能读取显示器真实状态，请检查设备和线材后重新扫描',
  DISPLAY_WRITE_FAILED_RESTORED: '调节未完成，已核验恢复原值',
  DISPLAY_WRITE_OUTCOME_UNKNOWN: '部分显示器状态无法恢复或已被其他程序修改，请重新扫描确认',
  DISPLAY_LIST_FAILED: '未能列出已连接的显示器，请重新扫描',
  DISPLAY_SLEEP_REJECTED: '系统没有接受熄屏请求',
  DISPLAY_HELPER_FAILED: '显示器组件运行失败，请重新扫描；持续失败请反馈'
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
    if (!(platform === 'win32' ? path.win32.isAbsolute(executable) : path.isAbsolute(executable))) throw new Error('显示器组件路径必须为绝对路径')
  }
  async stop() { this.#stopped = true; await this.#pending?.catch(() => { /* 请求调用方接收实际失败；关闭只等待清理。 */ }) }
  #checkBeforeStart(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '显示器服务已停止')
  }
  async #run(executable: string, args: string[], input: string | undefined, timeoutMs: number) {
    try { return await this.runner(executable, args, input, timeoutMs) }
    catch { throw new ZToolsError(errorCodes.screenError, '系统操作未能完成，结果可能已部分生效，请重新扫描确认') }
  }
  async execute(value: unknown, signal: AbortSignal) {
    validateMonitorRequest(value); signal.throwIfAborted()
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '显示器服务已停止')
    if (this.platform !== 'darwin' && this.platform !== 'win32') throw new ZToolsError(errorCodes.notSupported, '当前平台不支持显示器控制')
    if (this.#pending) throw new ZToolsError(errorCodes.invalidRequest, '显示器操作正在执行，请稍候')
    const pending = this.#execute(value, signal); this.#pending = pending
    try { return await pending } finally { if (this.#pending === pending) this.#pending = undefined }
  }
  async #execute(request: MonitorRequest, signal: AbortSignal) {
    if (request.action === 'sleep' && this.platform === 'darwin') {
      this.#checkBeforeStart(signal)
      const result = await this.#run('/usr/bin/pmset', ['displaysleepnow'], undefined, monitorTimeoutMs(request, this.platform))
      if (result.exitCode !== 0) throw new ZToolsError(errorCodes.screenError, '系统没有接受熄屏请求')
      return { success: true, requested: true }
    }
    const stat = await fs.lstat(this.executable).catch(() => { throw new ZToolsError(errorCodes.screenError, '显示器原生组件未构建，请更新或重新构建客户端') })
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ZToolsError(errorCodes.screenError, '显示器原生组件无效')
    this.#checkBeforeStart(signal)
    // 写入开始后由原生进程完成回读或恢复；不能因关闭页面中途杀死恢复过程。
    const invocation = this.platform === 'win32' ? windowsMonitorInvocation({ version: 1, ...request }) : { args: [], input: JSON.stringify({ version: 1, ...request }) }
    const result = await this.#run(this.executable, invocation.args, invocation.input, monitorTimeoutMs(request, this.platform))
    let response: unknown
    try { response = JSON.parse(result.stdout) }
    catch { throw new ZToolsError(errorCodes.screenError, '显示器原生组件响应无效，请重新扫描确认') }
    if (!monitorRecord(response) || response.version !== 1) throw new ZToolsError(errorCodes.screenError, '显示器原生组件响应无效，请重新扫描确认')
    if (response.success !== true || result.exitCode !== 0) throw new ZToolsError(errorCodes.screenError, messages[String(response.code)] || '显示器操作未确认成功，请重新扫描确认')
    if (request.action === 'sleep') {
      if (response.requested !== true) throw new ZToolsError(errorCodes.screenError, '系统没有接受熄屏请求')
      return { success: true, requested: true }
    }
    if (request.action === 'list') {
      signal.throwIfAborted()
      if (!Array.isArray(response.displays) || response.displays.length > 31 || typeof response.topology !== 'string') throw new ZToolsError(errorCodes.screenError, '显示器列表响应无效')
      const displays = response.displays.map(parseMonitorDisplay)
      if (new Set(displays.map(d => d.id)).size !== displays.length) throw new ZToolsError(errorCodes.screenError, '显示器标识重复')
      return { success: true, displays, topology: response.topology }
    }
    if (!Array.isArray(response.changed) || response.changed.length !== request.changes.length) throw new ZToolsError(errorCodes.screenError, '调节回执不完整，请重新扫描确认')
    const seen = new Set<string>()
    for (const item of response.changed) {
      if (!monitorRecord(item)) throw new ZToolsError(errorCodes.screenError, '调节回执无效，请重新扫描确认')
      const key = `${item.id}:${item.control}`, wanted = request.changes.find(c => c.id === item.id && c.control === item.control)
      if (!wanted || seen.has(key) || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0 || item.value > 100 || !Number.isSafeInteger(item.maximum) || Number(item.maximum) < 0 || Number(item.maximum) > 65535) throw new ZToolsError(errorCodes.screenError, '调节回读与目标不一致，请重新扫描确认')
      const maximum = Number(item.maximum)
      const target = maximum ? Math.round(wanted.value * maximum / 100) * 100 / maximum : Math.fround(wanted.value / 100) * 100
      const tolerance = maximum ? Math.min(2, 10 / maximum) : 0.0001
      if (Math.abs(item.value - target) > tolerance) throw new ZToolsError(errorCodes.screenError, '调节回读与硬件档位不一致，请重新扫描确认')
      seen.add(key)
    }
    return { success: true, changed: response.changed }
  }
}
