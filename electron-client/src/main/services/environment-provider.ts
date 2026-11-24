import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { PathAccessAdapter } from '../platform/path-access.js'
import type { EnvironmentScope } from '../../contracts/environment-manager.js'
import { environmentRecord, validEnvironmentValue } from '../../contracts/environment-manager.js'
import { darwinPathProblem, readEnvironmentProfile, replaceEnvironmentProfile } from './environment-profile.js'
import { WINDOWS_ENVIRONMENT_SCRIPT } from './windows-environment-script.js'
import { preserveAndWriteEnvironment } from './environment-file-write.js'

export interface EnvironmentState { source: EnvironmentScope; location: string; exists: boolean; raw: string }
export interface EnvironmentProvider {
  readonly platform: string; readonly processEnvironment: NodeJS.ProcessEnv; readonly notice: string
  sources(): Array<{ id: EnvironmentScope; label: string }>
  read(source: EnvironmentScope, signal: AbortSignal): Promise<EnvironmentState>
  values(state: EnvironmentState): Map<string, string>
  change(state: EnvironmentState, key: string, value: string | null): EnvironmentState
  validate(state: EnvironmentState, signal: AbortSignal): Promise<void>
  write(before: EnvironmentState, after: EnvironmentState, signal: AbortSignal): Promise<string | undefined>
}
export function environmentRevision(state: EnvironmentState) { return createHash('sha256').update(JSON.stringify(state)).digest('hex') }
export function environmentFailure(error: unknown) { return error instanceof Error ? error.message : String(error) }
export async function readEnvironmentFile(file: string): Promise<{ exists: boolean; raw: string }> {
  let handle
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, raw: '' }; throw error }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Profile must be a small regular file owned by the current user, not a link or another user file')
    const bytes = await handle.readFile()
    if (bytes.length > 1024 * 1024) throw new Error('Profile file exceeds 1 MiB')
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (raw.includes('\0')) throw new Error('Profile file contains null bytes')
    return { exists: true, raw }
  } finally { await handle.close() }
}
export function runEnvironmentCommand(file: string, args: string[], input: string | undefined, signal: AbortSignal, syntaxProbe = false): Promise<string> {
  signal.throwIfAborted()
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: 'C', LC_ALL: 'C' }
  if (process.platform === 'win32' && path.basename(file).toLowerCase() === 'powershell.exe') {
    // Windows PowerShell 不能继承启动宿主的 PowerShell 7 模块目录。
    env.PSModulePath = path.join(path.dirname(file), 'Modules')
  }
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, windowsHide: true, env }, (error, stdout, stderr) => {
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) reject(new Error('Environment operation was canceled; refresh to verify write state'))
      else if (syntaxProbe && error && !error.killed && !error.signal && (error.code === 1 || error.code === 2) && !stdout.trim() && /(?:parse error near|syntax error near unexpected token).*then/.test(stderr)) resolve('')
      else if (syntaxProbe) reject(new Error('Unable to confirm export block follows a complete top-level command; original configuration was not modified'))
      else if (error || stderr.trim()) reject(new Error('System environment helper execution failed; check profile syntax, write permissions, or retry later; operation not confirmed'))
      else resolve(stdout)
    })
    const cancel = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', cancel, { once: true })
    child.stdin?.on('error', () => { /* 提前退出由 execFile 回调统一报告。 */ })
    child.stdin?.end(input)
    if (signal.aborted) cancel()
  })
}
interface RegistryEntry { key: string; value: string; kind: 'String' | 'ExpandString' }
function registryEntries(raw: string): RegistryEntry[] {
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data) || data.length > 4096 || data.some(v => !environmentRecord(v) || typeof v.key !== 'string' || !v.key || !validEnvironmentValue(v.value) || typeof v.kind !== 'string' || !['String', 'ExpandString'].includes(v.kind)) ||
      new Set(data.map(v => String(v.key).toLowerCase())).size !== data.length) throw new Error('Registry environment returned invalid records')
  return data as RegistryEntry[]
}
export class SystemEnvironmentProvider implements EnvironmentProvider {
  readonly notice: string
  readonly #profile: string; readonly #shell: string
  constructor(private readonly adapter: () => PathAccessAdapter, readonly platform = process.platform,
    readonly processEnvironment = process.env, home = os.homedir(), shell = process.env.SHELL || os.userInfo().shell || '/bin/zsh') {
    this.#shell = path.basename(shell) === 'bash' ? '/bin/bash' : path.basename(shell) === 'zsh' ? '/bin/zsh' : ''
    const directory = this.#shell === '/bin/zsh' && processEnvironment.ZDOTDIR ? processEnvironment.ZDOTDIR : home
    if (!path.isAbsolute(directory) || directory.includes('\0')) throw new Error('Shell profile directory must be an absolute path')
    this.#profile = path.join(directory, this.#shell === '/bin/bash' ? '.bash_profile' : '.zshrc')
    this.notice = platform === 'darwin' ? 'Current process environment is a read-only snapshot; shell variables are written to the ZTools block in the listed profile file and take effect in new terminals while existing apps remain unchanged. Other shell configs are left intact and may affect final values.' :
      'User and system variables are read directly from the Windows registry; sign out and back in for applications to inherit updates. The current process snapshot is read-only, and modifying system variables requires elevated permissions.'
  }
  sources() {
    if (this.platform === 'darwin') { if (!this.#shell) throw new Error('Current shell is not supported for safe writes; use zsh or bash'); return [{ id: 'user' as const, label: this.#profile }] }
    if (this.platform === 'win32') return [{ id: 'user' as const, label: 'Current User Registry Environment' }, { id: 'system' as const, label: 'System Registry Environment' }]
    throw new Error('Environment management is not supported on this platform')
  }
  async #registry(source: EnvironmentScope, request: Record<string, unknown>, signal: AbortSignal) {
    const executable = path.win32.join(this.processEnvironment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const out = await runEnvironmentCommand(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ENVIRONMENT_SCRIPT, 'utf16le').toString('base64')], JSON.stringify({ ...request, source }), signal)
    const result: unknown = JSON.parse(out)
    if (!environmentRecord(result) || result.success !== true) throw new Error('System did not confirm registry operation result')
    return result
  }
  async read(source: EnvironmentScope, signal: AbortSignal): Promise<EnvironmentState> {
    signal.throwIfAborted()
    const item = this.sources().find(v => v.id === source)
    if (!item) throw new Error('Environment source is not available on this platform')
    if (this.platform === 'darwin') {
      const data = await readEnvironmentFile(this.#profile)
      if (this.#shell === '/bin/bash' && !data.exists) {
        // Bash 只加载第一个存在的登录配置，不能新建高优先级文件遮蔽已有配置。
        for (const name of ['.bash_login', '.profile']) {
          const exists = await fs.lstat(path.join(path.dirname(this.#profile), name)).then(() => true, (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false
            throw error
          })
          if (exists) throw new Error(`Existing login profile ${name} detected; cannot create .bash_profile to shadow it. Consolidate Bash startup files manually first`)
        }
      }
      signal.throwIfAborted()
      const block = readEnvironmentProfile(data.raw)
      if (block.present) await this.#checkSyntax(block.before, signal, true)
      return { source, location: item.label, ...data }
    }
    const result = await this.#registry(source, { action: 'read' }, signal)
    const entries = registryEntries(JSON.stringify(result.entries)).sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase()))
    return { source, location: item.label, exists: true, raw: JSON.stringify(entries) }
  }
  values(state: EnvironmentState): Map<string, string> {
    if (this.platform === 'darwin') return readEnvironmentProfile(state.raw).entries
    return new Map(registryEntries(state.raw).map(v => [v.key, v.value]))
  }
  change(state: EnvironmentState, key: string, value: string | null): EnvironmentState {
    if (this.platform === 'darwin') {
      // 只拦截本次写入的 PATH（设置与清理都经过这里）；恢复备份直接写回原文件，不受此限
      const problem = key === 'PATH' && value !== null ? darwinPathProblem(value) : ''
      if (problem) throw new Error(`${problem}; original configuration was not modified`)
      const entries = this.values(state)
      if (value === null) entries.delete(key); else entries.set(key, value)
      return { ...state, exists: true, raw: replaceEnvironmentProfile(state.raw, entries) }
    }
    const entries = registryEntries(state.raw), existing = entries.find(v => v.key.toLowerCase() === key.toLowerCase())
    const next = entries.filter(v => v !== existing)
    if (value !== null) next.push({ key: existing?.key || key, value, kind: existing?.kind || 'ExpandString' })
    next.sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase()))
    return { ...state, raw: JSON.stringify(next) }
  }
  async validate(state: EnvironmentState, signal: AbortSignal) {
    if (!this.sources().some(s => s.id === state.source && s.label === state.location) || typeof state.exists !== 'boolean' || typeof state.raw !== 'string' || (!state.exists && state.raw !== '') || Buffer.byteLength(state.raw) > 1024 * 1024) throw new Error('Configuration does not belong to the current environment or exceeds size limit')
    this.values(state)
    if (this.platform !== 'darwin') return
    const block = readEnvironmentProfile(state.raw)
    if (block.present) await this.#checkSyntax(block.before, signal, true)
    await this.#checkSyntax(state.raw, signal)
  }
  async #checkSyntax(contents: string, signal: AbortSignal, prefix = false) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-env-syntax-')), file = path.join(temporary, 'profile')
    try {
      await fs.writeFile(file, contents, { flag: 'wx', mode: 0o600 })
      // -n 仅检查语法，不执行用户启动脚本或变量中的文本。
      const args = this.#shell === '/bin/zsh' ? ['-f', '-n', file] : ['--noprofile', '--norc', '-n', file]
      await runEnvironmentCommand(this.#shell, args, undefined, signal)
      if (prefix) {
        // 完整前缀必须能把 then then 识别为语法错误；若被未闭合的 here-document
        // 当成正文吞掉，-n 会成功，这时拒绝追加，避免配置写了却永远不会执行。
        await fs.appendFile(file, '\nthen then\n')
        await runEnvironmentCommand(this.#shell, args, undefined, signal, true)
      }
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  }
  async write(before: EnvironmentState, after: EnvironmentState, signal: AbortSignal) {
    await this.validate(after, signal)
    if (environmentRevision(await this.read(before.source, signal)) !== environmentRevision(before)) throw new Error('Configuration was modified externally; reload before proceeding')
    if (this.platform === 'win32') {
      await this.#registry(before.source, { action: 'write', expected: registryEntries(before.raw), entries: registryEntries(after.raw) }, signal)
      return
    }
    if (before.exists) {
      const stat = await fs.lstat(this.#profile)
      if (stat.isSymbolicLink() || !(stat.mode & 0o200)) throw new Error('Shell profile is a symlink or read-only file; not modified')
    }
    const adapter = this.adapter()
    let operationError: unknown, recoveryPath: string | undefined
    try {
      if (!after.exists) {
        if (!before.exists) return
        if (!adapter.trash) throw new Error('Safe file helper does not support restoring to a non-existent file state')
        const file = await adapter.pin(this.#profile, 'file', ['read'], signal)
        try {
          if ((await adapter.read(file, [], 1024 * 1024, signal)).toString('utf8') !== before.raw) throw new Error('Configuration changed before restore; reload and retry')
          signal.throwIfAborted()
          await adapter.trash(file, AbortSignal.timeout(15000))
        } finally { await adapter.release(file) }
        return
      }
      if (before.exists) {
        recoveryPath = await preserveAndWriteEnvironment(adapter, this.#profile, before.raw, after.raw, signal)
        return recoveryPath
      }
      const target = await adapter.pin(this.#profile, 'save', ['write'], signal)
      try {
        if (environmentRevision(await this.read(before.source, signal)) !== environmentRevision(before)) throw new Error('Configuration changed before save; reload and retry')
        signal.throwIfAborted()
        // 进入原子保存后完成提交并读回；不因界面退出而留下半份配置。
        await adapter.save(target, Buffer.from(after.raw, 'utf8'), false, AbortSignal.timeout(15000))
      } finally { await adapter.release(target) }
    } catch (error) { operationError = error; throw error }
    finally {
      try { await adapter.stop() }
      catch (error) { throw new Error(`${operationError ? environmentFailure(operationError) + '; ' : ''}Safe file helper exit not confirmed: ${environmentFailure(error)}; check configuration ${this.#profile}${recoveryPath ? ` and original file ${recoveryPath}` : ''}`) }
    }
  }
}
