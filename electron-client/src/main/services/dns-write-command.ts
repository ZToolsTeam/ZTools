import { spawn } from 'node:child_process'
import type { DnsCommand } from './dns-network-provider.js'
export class DnsWriteOutcomeUnknownError extends Error {
  constructor() { super('DNS 组件未在取消后结束，系统写入状态未确认') }
}

/** 原生组件在预提交阶段响应 SIGTERM，提交后完成应用/恢复；宿主必须等 close 后才能判断结果。 */
export const runDnsWriteCommand = (file: string, args: readonly string[], signal: AbortSignal, timeoutMs = 90000, graceMs = 10000): ReturnType<DnsCommand> => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  const child = spawn(file, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let size = 0, failure: Error | undefined
  let forced: ReturnType<typeof setTimeout> | undefined
  const terminate = (reason: Error) => {
    failure ??= reason; child.kill('SIGTERM')
    forced ??= setTimeout(() => { failure = new DnsWriteOutcomeUnknownError(); child.kill('SIGKILL') }, graceMs)
  }
  const abort = () => terminate(new Error('DNS 写入请求已取消'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => terminate(new Error('DNS 系统授权或写入超时')), timeoutMs)
  const collect = (chunks: Buffer[], data: Buffer) => {
    size += data.length
    if (size > 128 * 1024) terminate(new Error('DNS 组件响应超过限制'))
    else chunks.push(data)
  }
  child.stdout.on('data', data => collect(stdout, data)); child.stderr.on('data', data => collect(stderr, data))
  child.on('error', error => { failure = error })
  child.on('close', (code, exitSignal) => {
    clearTimeout(timer); signal.removeEventListener('abort', abort)
    if (forced) clearTimeout(forced)
    const errorText = Buffer.concat(stderr).toString('utf8').trim()
    // 提交阶段收到取消后，组件仍可能成功完成事务；以实际退出结果为准。
    if (code === 3 && !exitSignal) reject(failure || new Error('DNS 请求已在提交前取消'))
    else if (code !== 0 || exitSignal || errorText || size > 128 * 1024) reject(child.pid ? new DnsWriteOutcomeUnknownError() : failure || new Error('DNS 组件未启动'))
    else resolve(Buffer.concat(stdout).toString('utf8'))
  })
})
