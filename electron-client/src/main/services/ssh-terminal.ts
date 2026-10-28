import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validSshAlias, validSshTunnel, type SshTunnel } from '../../contracts/ssh-proxy.js'
import { runBoundedProcess } from './bounded-process.js'

export const shellArgument = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
export function sshArguments(alias: string, tunnel?: SshTunnel): string[] {
  if (!validSshAlias(alias) || (tunnel && !validSshTunnel(tunnel))) throw new Error('SSH 目标或转发参数无效')
  return tunnel ? ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort}`, alias] : [alias]
}
export function proxyTerminalArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须在 1 到 65535 之间')
  const proxy = `http://127.0.0.1:${port}`
  return ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(key => `${key}=${proxy}`).concat(['/bin/zsh', '-f'])
}
/** Windows 新控制台只设置大写代理变量：Windows 环境变量不区分大小写，大小写各设一份会产生重复项。 */
export function windowsProxyTerminalArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须在 1 到 65535 之间')
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(key => `${key}=http://127.0.0.1:${port}`)
}
export function windowsProxyEnvironment(base: NodeJS.ProcessEnv, assignments: string[]): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (!/^(?:https?|all)_proxy$/i.test(key)) next[key] = value
  for (const item of assignments) {
    const match = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)=(http:\/\/127\.0\.0\.1:\d{1,5})$/.exec(item)
    if (!match) throw new Error('代理终端参数无效')
    next[match[1]!] = match[2]!
  }
  return next
}
export type TerminalOpen = (file: string, signal: AbortSignal) => Promise<void>
async function openCommand(file: string, signal: AbortSignal) {
  const result = await runBoundedProcess('/usr/bin/open', ['-a', '/System/Applications/Utilities/Terminal.app', file], signal, { label: '终端打开请求', timeoutMs: 10000, maxBytes: 16384 })
  if (result.code !== 0) throw new Error('系统未确认终端打开请求，请检查是否已出现终端窗口')
}
/** Terminal 可能延迟打开文件：启动脚本由自身清理；未启动的临时文件由服务退出时清理。 */
export class SshTerminalLauncher {
  #pending = new Set<string>(); #stopped = false
  #active = new Set<Promise<unknown>>()
  constructor(private readonly open: TerminalOpen = openCommand, private readonly directory = os.tmpdir()) {}
  launch(kind: 'ssh' | 'proxy', args: string[], signal: AbortSignal) {
    const task = this.#launch(kind, args, signal)
    this.#active.add(task)
    return task.finally(() => this.#active.delete(task))
  }
  async #launch(kind: 'ssh' | 'proxy', args: string[], signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('终端服务已停止')
    for (const dir of this.#pending) {
      try { await fs.lstat(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.#pending.delete(dir); else throw error }
    }
    signal.throwIfAborted(); if (this.#stopped) throw new Error('终端服务已停止')
    if (this.#pending.size >= 32) throw new Error('等待打开的终端过多，请先处理已有窗口')
    const dir = await fs.mkdtemp(path.join(this.directory, 'ztools-ssh-')), file = path.join(dir, '连接.command')
    this.#pending.add(dir)
    const executable = kind === 'ssh' ? '/usr/bin/ssh' : '/usr/bin/env'
    const text = `#!/bin/sh\n/bin/rm -f -- ${shellArgument(file)}\n/bin/rmdir -- ${shellArgument(dir)}\nexec ${shellArgument(executable)} ${args.map(shellArgument).join(' ')}\n`
    try {
      await fs.writeFile(file, text, { flag: 'wx', mode: 0o700 })
      signal.throwIfAborted(); if (this.#stopped) throw new Error('终端服务已停止')
      await this.open(file, signal)
      if (this.#stopped) throw new Error('客户端正在退出，请检查已打开的终端')
      return { success: true, opened: true, notice: kind === 'ssh' ? '已请求打开系统终端；连接、认证和隧道状态以终端输出为准，Ctrl+C 可停止' : '已请求打开带代理环境的新终端；已有终端不变，关闭新窗口即结束。此窗口使用不加载个人启动配置的 zsh' }
    } catch (error) { await fs.rm(dir, { recursive: true, force: true }); this.#pending.delete(dir); throw error }
  }
  async stop() {
    this.#stopped = true; await Promise.allSettled([...this.#active])
    const failures: unknown[] = []
    for (const dir of this.#pending) {
      try { await fs.rm(dir, { recursive: true, force: true }); this.#pending.delete(dir) }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '部分终端临时文件清理失败，可重试清理')
  }
}

/** 以独立控制台启动程序；只确认进程已创建，不等待其退出。 */
export type ConsoleStart = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>
const startConsole: ConsoleStart = (file, args, env) => new Promise((resolve, reject) => {
  // detached 在 Windows 上为子进程分配新的控制台窗口；不经 shell，参数由 Node 按 Windows 规则转义。
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, env })
  child.once('error', () => reject(new Error('系统未能打开新的控制台窗口')))
  child.once('spawn', () => { child.unref(); resolve() })
})
/** Windows 终端：SSH 使用系统自带 OpenSSH 客户端；代理终端使用不执行 AutoRun 的 cmd.exe，均不写临时文件。 */
export class WindowsTerminalLauncher {
  #stopped = false
  constructor(private readonly start: ConsoleStart = startConsole, private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly isFile = async (file: string) => { try { return (await fs.stat(file)).isFile() } catch { return false } }) {}
  async launch(kind: 'ssh' | 'proxy', args: string[], signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('终端服务已停止')
    const system32 = path.win32.join(this.environment.SystemRoot || 'C:\\Windows', 'System32')
    if (kind === 'ssh') {
      const ssh = path.win32.join(system32, 'OpenSSH', 'ssh.exe')
      if (!await this.isFile(ssh)) throw new Error('未找到 Windows 自带的 OpenSSH 客户端，请在“设置 > 系统 > 可选功能”中安装“OpenSSH 客户端”后重试')
      signal.throwIfAborted(); if (this.#stopped) throw new Error('终端服务已停止')
      await this.start(ssh, args, { ...this.environment })
      return { success: true, opened: true, notice: '已请求打开新的控制台窗口；连接、认证和隧道状态以窗口输出为准，Ctrl+C 可停止' }
    }
    const env = windowsProxyEnvironment(this.environment, args)
    signal.throwIfAborted(); if (this.#stopped) throw new Error('终端服务已停止')
    await this.start(path.win32.join(system32, 'cmd.exe'), ['/d', '/k', 'set', 'HTTP'], env)
    return { success: true, opened: true, notice: '已请求打开带代理环境的新命令提示符窗口；已有终端不变，关闭新窗口即结束。此窗口不执行命令处理器的 AutoRun 配置' }
  }
  async stop() { this.#stopped = true }
}
export type SshTerminal = Pick<SshTerminalLauncher, 'launch' | 'stop'>
export const createSshTerminal = (platform: NodeJS.Platform = process.platform): SshTerminal => platform === 'win32' ? new WindowsTerminalLauncher() : new SshTerminalLauncher()
