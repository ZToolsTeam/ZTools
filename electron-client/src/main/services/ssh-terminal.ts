import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validSshAlias, validSshTunnel, type SshTunnel } from '../../contracts/ssh-proxy.js'
import { runBoundedProcess } from './bounded-process.js'

export const shellArgument = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
export function sshArguments(alias: string, tunnel?: SshTunnel): string[] {
  if (!validSshAlias(alias) || (tunnel && !validSshTunnel(tunnel))) throw new Error('Invalid SSH target or port forwarding parameters')
  return tunnel ? ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort}`, alias] : [alias]
}
export function proxyTerminalArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535')
  const proxy = `http://127.0.0.1:${port}`
  return ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(key => `${key}=${proxy}`).concat(['/bin/zsh', '-f'])
}
/** Windows 新控制台只设置大写代理变量：Windows 环境变量不区分大小写，大小写各设一份会产生重复项。 */
export function windowsProxyTerminalArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535')
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(key => `${key}=http://127.0.0.1:${port}`)
}
export function windowsProxyEnvironment(base: NodeJS.ProcessEnv, assignments: string[]): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (!/^(?:https?|all)_proxy$/i.test(key)) next[key] = value
  for (const item of assignments) {
    const match = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)=(http:\/\/127\.0\.0\.1:\d{1,5})$/.exec(item)
    if (!match) throw new Error('Invalid proxy terminal parameters')
    next[match[1]!] = match[2]!
  }
  return next
}
export type TerminalOpen = (file: string, signal: AbortSignal) => Promise<void>
async function openCommand(file: string, signal: AbortSignal) {
  const result = await runBoundedProcess('/usr/bin/open', ['-a', '/System/Applications/Utilities/Terminal.app', file], signal, { label: 'Terminal open request', timeoutMs: 10000, maxBytes: 16384 })
  if (result.code !== 0) throw new Error('System did not confirm terminal open request; check whether a terminal window appeared')
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
    if (this.#stopped) throw new Error('Terminal service stopped')
    for (const dir of this.#pending) {
      try { await fs.lstat(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.#pending.delete(dir); else throw error }
    }
    signal.throwIfAborted(); if (this.#stopped) throw new Error('Terminal service stopped')
    if (this.#pending.size >= 32) throw new Error('Too many pending terminal launch requests; handle existing windows first')
    const dir = await fs.mkdtemp(path.join(this.directory, 'ztools-ssh-')), file = path.join(dir, 'connect.command')
    this.#pending.add(dir)
    const executable = kind === 'ssh' ? '/usr/bin/ssh' : '/usr/bin/env'
    const text = `#!/bin/sh\n/bin/rm -f -- ${shellArgument(file)}\n/bin/rmdir -- ${shellArgument(dir)}\nexec ${shellArgument(executable)} ${args.map(shellArgument).join(' ')}\n`
    try {
      await fs.writeFile(file, text, { flag: 'wx', mode: 0o700 })
      signal.throwIfAborted(); if (this.#stopped) throw new Error('Terminal service stopped')
      await this.open(file, signal)
      if (this.#stopped) throw new Error('Application is exiting; check already opened terminals')
      return { success: true, opened: true, notice: kind === 'ssh' ? 'Requested system terminal launch; check terminal output for connection, authentication, and tunnel status (Ctrl+C to stop)' : 'Requested new terminal with proxy environment; existing terminals are unchanged, close the new window to end. Uses zsh without personal startup files' }
    } catch (error) { await fs.rm(dir, { recursive: true, force: true }); this.#pending.delete(dir); throw error }
  }
  async stop() {
    this.#stopped = true; await Promise.allSettled([...this.#active])
    const failures: unknown[] = []
    for (const dir of this.#pending) {
      try { await fs.rm(dir, { recursive: true, force: true }); this.#pending.delete(dir) }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Failed to clean up some temporary terminal files; retry cleanup')
  }
}

/** 以独立控制台启动程序；只确认进程已创建，不等待其退出。 */
export type ConsoleStart = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>
const startConsole: ConsoleStart = (file, args, env) => new Promise((resolve, reject) => {
  // detached 在 Windows 上为子进程分配新的控制台窗口；不经 shell，参数由 Node 按 Windows 规则转义。
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, env })
  child.once('error', () => reject(new Error('System failed to open a new console window')))
  child.once('spawn', () => { child.unref(); resolve() })
})
/** Windows 终端：SSH 使用系统自带 OpenSSH 客户端；代理终端使用不执行 AutoRun 的 cmd.exe，均不写临时文件。 */
export class WindowsTerminalLauncher {
  #stopped = false
  constructor(private readonly start: ConsoleStart = startConsole, private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly isFile = async (file: string) => { try { return (await fs.stat(file)).isFile() } catch { return false } }) {}
  async launch(kind: 'ssh' | 'proxy', args: string[], signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('Terminal service stopped')
    const system32 = path.win32.join(this.environment.SystemRoot || 'C:\\Windows', 'System32')
    if (kind === 'ssh') {
      const ssh = path.win32.join(system32, 'OpenSSH', 'ssh.exe')
      if (!await this.isFile(ssh)) throw new Error('Windows built-in OpenSSH Client not found; install "OpenSSH Client" in Settings > System > Optional Features and retry')
      signal.throwIfAborted(); if (this.#stopped) throw new Error('Terminal service stopped')
      await this.start(ssh, args, { ...this.environment })
      return { success: true, opened: true, notice: 'Requested new console window; check console output for connection, authentication, and tunnel status (Ctrl+C to stop)' }
    }
    const env = windowsProxyEnvironment(this.environment, args)
    signal.throwIfAborted(); if (this.#stopped) throw new Error('Terminal service stopped')
    await this.start(path.win32.join(system32, 'cmd.exe'), ['/d', '/k', 'set', 'HTTP'], env)
    return { success: true, opened: true, notice: 'Requested new Command Prompt window with proxy environment; existing terminals are unchanged, close the new window to end. Command processor AutoRun is disabled' }
  }
  async stop() { this.#stopped = true }
}
export type SshTerminal = Pick<SshTerminalLauncher, 'launch' | 'stop'>
export const createSshTerminal = (platform: NodeJS.Platform = process.platform): SshTerminal => platform === 'win32' ? new WindowsTerminalLauncher() : new SshTerminalLauncher()
