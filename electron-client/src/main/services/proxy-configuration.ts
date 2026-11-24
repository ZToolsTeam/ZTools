import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseIni } from 'ini'
import type { ProxyTool } from '../../contracts/ssh-proxy.js'
import type { EnvironmentState } from './environment-provider.js'
import { environmentRevision } from './environment-provider.js'
import { preserveAndWriteEnvironment } from './environment-file-write.js'
import type { PathAccessAdapter } from '../platform/path-access.js'
import { runBoundedProcess } from './bounded-process.js'

export interface ProxyValue { key: string; value: string; hasCredentials: boolean; dynamic: boolean }
export interface ProxyConfiguration { tool: ProxyTool; location: string; exists: boolean; values: ProxyValue[]; notices: string[] }
const proxyKeys = (tool: ProxyTool) => tool === 'git' ? ['http.proxy'] : ['proxy', 'https-proxy']
const fail = (text: string) => new Error(text)
async function exists(file: string) {
  try { await fs.lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw fail('Unable to read proxy configuration path') }
}
/** 不跟随链接、不接受硬链接；以实际打开对象做有界读取。 */
export async function readProxyFile(location: string, signal: AbortSignal): Promise<EnvironmentState> {
  signal.throwIfAborted()
  if (!path.isAbsolute(location) || location.includes('\0') || location.length > 16384) throw fail('Invalid proxy configuration path')
  if (!await exists(location)) return { source: 'user', location, exists: false, raw: '' }
  // Windows 没有 O_NOFOLLOW，先显式拒绝符号链接与目录联接，避免读写被转向其他文件。
  if ((await fs.lstat(location)).isSymbolicLink()) throw fail('Proxy configuration must be a regular file owned by the current user, not a symlink, and no larger than 256 KiB')
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat(), limit = 256 * 1024
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (process.getuid && stat.uid !== process.getuid())) throw fail('Proxy configuration must be a regular file owned by the current user, not a symlink, and no larger than 256 KiB')
    const bytes = Buffer.alloc(limit + 1); let count = 0
    while (count < bytes.length) { signal.throwIfAborted(); const result = await handle.read(bytes, count, Math.min(16384, bytes.length - count), count); if (!result.bytesRead) break; count += result.bytesRead }
    if (count > limit) throw fail('Proxy configuration exceeds 256 KiB')
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
    if (raw.includes('\0')) throw fail('Proxy configuration contains null bytes')
    return { source: 'user', location, exists: true, raw }
  } finally { await handle.close() }
}
function npmValues(raw: string) {
  if (raw.split(/[\r\n]/).some(line => line.length > 32768)) throw fail('NPM configuration line exceeds maximum length')
  const parsed = parseIni(raw)
  let count = 0
  function check(value: unknown, depth: number) {
    if (++count > 8192 || depth > 32) throw fail('NPM configuration structure exceeds limit')
    if (value && typeof value === 'object') for (const child of Object.values(value)) check(child, depth + 1)
  }
  check(parsed, 0); return parsed
}
export function replaceNpmProxy(raw: string, proxy: string | null): string {
  const before = npmValues(raw), keys = proxyKeys('npm')
  let section = false
  const lines = raw.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []
  const kept = lines.filter(line => {
    if (/^\[[^\]]*\]\s*$/.test(line)) section = true
    return section || !Object.keys(parseIni(line)).some(key => keys.includes(key))
  }).join('')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const next = (proxy === null ? '' : keys.map(key => `${key}=${proxy}${eol}`).join('')) + kept
  const after = npmValues(next)
  for (const key of keys) {
    if (proxy === null ? Object.hasOwn(after, key) : after[key] !== proxy) throw fail('NPM proxy copy verification failed')
    delete before[key]; delete after[key]
  }
  if (!isDeepStrictEqual(before, after)) throw fail('Other NPM configuration entries changed; aborting write')
  return next
}
export function displayProxy(key: string, value: unknown): ProxyValue | undefined {
  if (value === undefined || value === null || value === false || value === '') return undefined
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw fail('Proxy value is not a valid single-line URL')
  if (value.includes('${')) return { key, value: 'Determined by environment variable', hasCredentials: false, dynamic: true }
  try {
    const parsed = new URL(value), hasCredentials = !!parsed.username || !!parsed.password
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw fail('Invalid proxy protocol')
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
    return { key, value: `${parsed.protocol}//${parsed.host}${hasCredentials ? ' (credentials hidden)' : ''}`, hasCredentials, dynamic: false }
  } catch { throw fail('Unrecognized proxy URL format; inspect the original configuration file') }
}
/** Windows 上从 PATH 与 Git for Windows 默认安装目录查找 git.exe；只接受绝对路径中的普通文件，不搜索当前目录。 */
export async function findWindowsGit(environment: NodeJS.ProcessEnv, isFile = async (file: string) => { try { return (await fs.stat(file)).isFile() } catch { return false } }): Promise<string> {
  const directories = (environment.PATH ?? environment.Path ?? '').split(';').map(item => item.trim().replace(/^"(.*)"$/, '$1')).filter(item => item && path.win32.isAbsolute(item) && !item.includes('\0'))
  for (const root of [environment.ProgramFiles, environment.ProgramW6432, environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, 'Programs')]) if (root && path.win32.isAbsolute(root)) directories.push(path.win32.join(root, 'Git', 'cmd'))
  for (const directory of directories) { const file = path.win32.join(directory, 'git.exe'); if (await isFile(file)) return file }
  throw fail('Git (git.exe) was not found; install Git for Windows and refresh (NPM proxy is unaffected)')
}
export class ProxyConfigurationProvider {
  #gitExecutable: Promise<string> | undefined
  constructor(private readonly adapter: () => PathAccessAdapter, readonly home = os.homedir(), readonly environment = process.env, readonly platform: NodeJS.Platform = process.platform,
    private readonly locateGit = () => findWindowsGit(environment)) {}
  /** Git for Windows 以 HOME（未设置时用用户目录）定位全局配置；npm 始终使用用户目录。 */
  get #gitHome() { const home = this.environment.HOME; return this.platform === 'win32' && home && path.isAbsolute(home) ? home : this.home }
  async location(tool: ProxyTool): Promise<string> {
    const override = tool === 'git' ? this.environment.GIT_CONFIG_GLOBAL : this.environment.npm_config_userconfig ?? this.environment.NPM_CONFIG_USERCONFIG
    if (override !== undefined) { if (!path.isAbsolute(override) || override.includes('\0')) throw fail('Custom proxy configuration path must be an absolute path'); return path.normalize(override) }
    if (tool === 'npm') return path.join(this.home, '.npmrc')
    const gitHome = this.#gitHome
    const primary = path.join(gitHome, '.gitconfig'), xdgRoot = this.environment.XDG_CONFIG_HOME || path.join(gitHome, '.config')
    if (!path.isAbsolute(xdgRoot)) throw fail('XDG configuration directory must be an absolute path')
    const secondary = path.join(xdgRoot, 'git', 'config')
    return await exists(primary) || !await exists(secondary) ? primary : secondary
  }
  async read(tool: ProxyTool, signal: AbortSignal) { return readProxyFile(await this.location(tool), signal) }
  async #git(raw: string, signal: AbortSignal, mutation?: { proxy: string | null }): Promise<{ raw: string; entries: Array<[string, string]> }> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-proxy-')), file = path.join(temporary, 'config')
    try {
      await fs.writeFile(file, raw, { flag: 'wx', mode: 0o600 })
      const windows = this.platform === 'win32', git = windows ? await (this.#gitExecutable ??= this.locateGit().catch(error => { this.#gitExecutable = undefined; throw error })) : '/usr/bin/git'
      const system32 = path.win32.join(this.environment.SystemRoot || 'C:\\Windows', 'System32')
      const env: NodeJS.ProcessEnv = windows
        ? { HOME: temporary, USERPROFILE: temporary, SystemRoot: this.environment.SystemRoot || 'C:\\Windows', PATH: `${path.win32.dirname(git)};${system32}`, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' }
        : { HOME: temporary, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
      const run = (args: string[]) => runBoundedProcess(git, ['config', '--no-includes', '--file', file, ...args], signal, { cwd: temporary, label: 'Git config check', env, ...(windows ? { timeoutMs: 15000 } : {}) })
      if (mutation) {
        const result = await run(mutation.proxy === null ? ['--unset-all', 'http.proxy'] : ['--replace-all', 'http.proxy', mutation.proxy])
        if (result.code !== 0 && !(mutation.proxy === null && result.code === 5)) throw fail('Git failed to generate proxy configuration copy; original file was not modified')
      }
      const result = await run(['--null', '--list'])
      if (result.code !== 0) throw fail('Git configuration syntax check failed; original file was not modified')
      const entries = result.stdout.split('\0').filter(Boolean).map((entry): [string, string] => { const at = entry.indexOf('\n'); return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)] })
      if (entries.length > 8192) throw fail('Git configuration entries exceed limit')
      return { raw: (await readProxyFile(file, signal)).raw, entries }
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  }
  async inspect(tool: ProxyTool, state: EnvironmentState, signal: AbortSignal): Promise<ProxyConfiguration> {
    const data = tool === 'git' ? Object.fromEntries((await this.#git(state.raw, signal)).entries) : npmValues(state.raw)
    const values = proxyKeys(tool).map(key => displayProxy(key, data[key])).filter((value): value is ProxyValue => !!value)
    const notices = [tool === 'git' ? 'Shows the general HTTP/HTTPS proxy from the listed user config file; includes, alternate user files, URL-specific rules, or project configs may override it' : 'Shows the proxy from the listed user .npmrc file; project configs, global configs, and environment variables may override it']
    const envKeys = Object.keys(this.environment).filter(key => /^(?:https?_proxy|all_proxy|no_proxy|npm_config_(?:proxy|https_proxy)|git_config_(?:count|parameters))$/i.test(key))
    if (envKeys.length) notices.push(`Current client environment also sets ${envKeys.join(', ')}; existing terminals may inherit different variables`)
    return { tool, location: state.location, exists: state.exists, values, notices }
  }
  async change(tool: ProxyTool, state: EnvironmentState, proxy: string | null, signal: AbortSignal): Promise<EnvironmentState> {
    let raw: string
    if (tool === 'npm') raw = replaceNpmProxy(state.raw, proxy)
    else {
      const before = await this.#git(state.raw, signal), after = await this.#git(state.raw, signal, { proxy })
      if (!isDeepStrictEqual(before.entries.filter(([key]) => key !== 'http.proxy'), after.entries.filter(([key]) => key !== 'http.proxy'))) throw fail('Other Git configuration entries changed; aborting write')
      const targets = after.entries.filter(([key]) => key === 'http.proxy')
      if (proxy === null ? targets.length !== 0 : targets.length !== 1 || targets[0]![1] !== proxy) throw fail('Git proxy copy verification failed')
      raw = after.raw
    }
    if (Buffer.byteLength(raw) > 256 * 1024) throw fail('Modified proxy configuration exceeds size limit')
    return { ...state, exists: state.exists || proxy !== null, raw }
  }
  async write(tool: ProxyTool, before: EnvironmentState, after: EnvironmentState, signal: AbortSignal) {
    if (before.location !== after.location || before.source !== 'user' || after.source !== 'user' || (!after.exists && after.raw !== '')) throw fail('Invalid proxy configuration write target')
    if (environmentRevision(await this.read(tool, signal)) !== environmentRevision(before)) throw fail('Proxy configuration changed; please reload')
    if (before.exists && !((await fs.lstat(before.location)).mode & 0o200)) throw fail('Proxy configuration file is read-only and was not modified')
    const adapter = this.adapter()
    let recoveryPath: string | undefined, writeFailure: unknown
    try {
      if (!after.exists) {
        if (!before.exists) return
        if (!adapter.trash) throw fail('Secure file component does not support restoring to a non-existent state')
        const file = await adapter.pin(before.location, 'file', ['read'], signal)
        try {
          if ((await adapter.read(file, [], 256 * 1024, signal)).toString('utf8') !== before.raw) throw fail('Proxy configuration changed before restoration')
          signal.throwIfAborted(); await adapter.trash(file, AbortSignal.timeout(15000))
        } finally { await adapter.release(file) }
      } else if (before.exists) {
        recoveryPath = await preserveAndWriteEnvironment(adapter, before.location, before.raw, after.raw, signal)
        return recoveryPath
      }
      else {
        const target = await adapter.pin(before.location, 'save', ['write'], signal)
        try { signal.throwIfAborted(); await adapter.save(target, Buffer.from(after.raw), false, AbortSignal.timeout(15000)) }
        finally { await adapter.release(target) }
      }
    } catch (error) { writeFailure = error; throw error }
    finally {
      try { await adapter.stop() }
      catch (error) {
        throw fail(`${writeFailure instanceof Error ? writeFailure.message + '; ' : ''}Secure file component shutdown unconfirmed: ${error instanceof Error ? error.message : 'cleanup failed'}; inspect ${before.location}${recoveryPath ? ` and preserved backup ${recoveryPath}` : ''}`)
      }
    }
  }
}
