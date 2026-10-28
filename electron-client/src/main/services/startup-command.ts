import { runBoundedProcess } from './bounded-process.js'

export interface StartupCommandResult { code: number; stdout: string; stderr: string }
export type StartupCommand = (args: string[], signal: AbortSignal, input?: Buffer) => Promise<StartupCommandResult>

/** 只调用 launchctl 或用标准输入转换 plist；等待进程退出后再释放操作锁。 */
export function runStartupProcess(executable: string, args: string[], signal: AbortSignal, input?: Buffer, timeoutMs = 5000, graceMs = 300): Promise<StartupCommandResult> {
  return runBoundedProcess(executable, args, signal, { ...(input ? { input } : {}), timeoutMs, graceMs, label: '系统启动项命令' })
}
export const runStartupCommand: StartupCommand = (args, signal, input) => runStartupProcess(input ? '/usr/bin/plutil' : '/bin/launchctl', args, signal, input)

export function startupCommandOutput(result: StartupCommandResult) {
  if (result.code !== 0) throw new Error(`系统启动项命令失败：${(result.stderr || result.stdout || String(result.code)).trim().slice(0, 1000)}`)
  return result.stdout
}
