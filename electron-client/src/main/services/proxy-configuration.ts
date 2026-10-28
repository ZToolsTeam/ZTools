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
  try { await fs.lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw fail('代理配置路径无法读取') }
}
/** 不跟随链接、不接受硬链接；以实际打开对象做有界读取。 */
export async function readProxyFile(location: string, signal: AbortSignal): Promise<EnvironmentState> {
  signal.throwIfAborted()
  if (!path.isAbsolute(location) || location.includes('\0') || location.length > 16384) throw fail('代理配置路径无效')
  if (!await exists(location)) return { source: 'user', location, exists: false, raw: '' }
  // Windows 没有 O_NOFOLLOW，先显式拒绝符号链接与目录联接，避免读写被转向其他文件。
  if ((await fs.lstat(location)).isSymbolicLink()) throw fail('代理配置必须是当前用户的普通文件，不能是链接或超过 256 KiB')
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat(), limit = 256 * 1024
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (process.getuid && stat.uid !== process.getuid())) throw fail('代理配置必须是当前用户的普通文件，不能是链接或超过 256 KiB')
    const bytes = Buffer.alloc(limit + 1); let count = 0
    while (count < bytes.length) { signal.throwIfAborted(); const result = await handle.read(bytes, count, Math.min(16384, bytes.length - count), count); if (!result.bytesRead) break; count += result.bytesRead }
    if (count > limit) throw fail('代理配置超过 256 KiB')
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
    if (raw.includes('\0')) throw fail('代理配置包含空字符')
    return { source: 'user', location, exists: true, raw }
  } finally { await handle.close() }
}
function npmValues(raw: string) {
  if (raw.split(/[\r\n]/).some(line => line.length > 32768)) throw fail('NPM 配置单行过长')
  const parsed = parseIni(raw)
  let count = 0
  function check(value: unknown, depth: number) {
    if (++count > 8192 || depth > 32) throw fail('NPM 配置结构超过限制')
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
    if (proxy === null ? Object.hasOwn(after, key) : after[key] !== proxy) throw fail('NPM 代理副本核验失败')
    delete before[key]; delete after[key]
  }
  if (!isDeepStrictEqual(before, after)) throw fail('NPM 其他配置发生变化，停止写入')
  return next
}
export function displayProxy(key: string, value: unknown): ProxyValue | undefined {
  if (value === undefined || value === null || value === false || value === '') return undefined
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw fail('代理值不是有效的单行地址')
  if (value.includes('${')) return { key, value: '由环境变量决定', hasCredentials: false, dynamic: true }
  try {
    const parsed = new URL(value), hasCredentials = !!parsed.username || !!parsed.password
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw fail('代理协议无效')
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
    return { key, value: `${parsed.protocol}//${parsed.host}${hasCredentials ? '（认证信息已隐藏）' : ''}`, hasCredentials, dynamic: false }
  } catch { throw fail('代理地址格式无法识别，请在原配置中检查') }
}
/** Windows 上从 PATH 与 Git for Windows 默认安装目录查找 git.exe；只接受绝对路径中的普通文件，不搜索当前目录。 */
export async function findWindowsGit(environment: NodeJS.ProcessEnv, isFile = async (file: string) => { try { return (await fs.stat(file)).isFile() } catch { return false } }): Promise<string> {
  const directories = (environment.PATH ?? environment.Path ?? '').split(';').map(item => item.trim().replace(/^"(.*)"$/, '$1')).filter(item => item && path.win32.isAbsolute(item) && !item.includes('\0'))
  for (const root of [environment.ProgramFiles, environment.ProgramW6432, environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, 'Programs')]) if (root && path.win32.isAbsolute(root)) directories.push(path.win32.join(root, 'Git', 'cmd'))
  for (const directory of directories) { const file = path.win32.join(directory, 'git.exe'); if (await isFile(file)) return file }
  throw fail('未找到 Git（git.exe），请安装 Git for Windows 后刷新；NPM 代理不受影响')
}
export class ProxyConfigurationProvider {
  #gitExecutable: Promise<string> | undefined
  constructor(private readonly adapter: () => PathAccessAdapter, readonly home = os.homedir(), readonly environment = process.env, readonly platform: NodeJS.Platform = process.platform,
    private readonly locateGit = () => findWindowsGit(environment)) {}
  /** Git for Windows 以 HOME（未设置时用用户目录）定位全局配置；npm 始终使用用户目录。 */
  get #gitHome() { const home = this.environment.HOME; return this.platform === 'win32' && home && path.isAbsolute(home) ? home : this.home }
  async location(tool: ProxyTool): Promise<string> {
    const override = tool === 'git' ? this.environment.GIT_CONFIG_GLOBAL : this.environment.npm_config_userconfig ?? this.environment.NPM_CONFIG_USERCONFIG
    if (override !== undefined) { if (!path.isAbsolute(override) || override.includes('\0')) throw fail('自定义代理配置路径必须为绝对路径'); return path.normalize(override) }
    if (tool === 'npm') return path.join(this.home, '.npmrc')
    const gitHome = this.#gitHome
    const primary = path.join(gitHome, '.gitconfig'), xdgRoot = this.environment.XDG_CONFIG_HOME || path.join(gitHome, '.config')
    if (!path.isAbsolute(xdgRoot)) throw fail('XDG 配置目录必须为绝对路径')
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
      const run = (args: string[]) => runBoundedProcess(git, ['config', '--no-includes', '--file', file, ...args], signal, { cwd: temporary, label: 'Git 配置检查', env, ...(windows ? { timeoutMs: 15000 } : {}) })
      if (mutation) {
        const result = await run(mutation.proxy === null ? ['--unset-all', 'http.proxy'] : ['--replace-all', 'http.proxy', mutation.proxy])
        if (result.code !== 0 && !(mutation.proxy === null && result.code === 5)) throw fail('Git 无法生成代理配置副本，未修改原文件')
      }
      const result = await run(['--null', '--list'])
      if (result.code !== 0) throw fail('Git 配置语法检查失败，未修改原文件')
      const entries = result.stdout.split('\0').filter(Boolean).map((entry): [string, string] => { const at = entry.indexOf('\n'); return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)] })
      if (entries.length > 8192) throw fail('Git 配置项超过限制')
      return { raw: (await readProxyFile(file, signal)).raw, entries }
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  }
  async inspect(tool: ProxyTool, state: EnvironmentState, signal: AbortSignal): Promise<ProxyConfiguration> {
    const data = tool === 'git' ? Object.fromEntries((await this.#git(state.raw, signal)).entries) : npmValues(state.raw)
    const values = proxyKeys(tool).map(key => displayProxy(key, data[key])).filter((value): value is ProxyValue => !!value)
    const notices = [tool === 'git' ? '这里显示所列用户文件中的通用 HTTP/HTTPS 代理；Include、另一个用户文件、网址专用配置及项目配置可能覆盖它' : '这里显示所列用户 .npmrc 中的代理；项目、全局配置及环境变量可能覆盖它']
    const envKeys = Object.keys(this.environment).filter(key => /^(?:https?_proxy|all_proxy|no_proxy|npm_config_(?:proxy|https_proxy)|git_config_(?:count|parameters))$/i.test(key))
    if (envKeys.length) notices.push(`当前客户端环境另有 ${envKeys.join('、')}；现有终端可能继承不同环境`)
    return { tool, location: state.location, exists: state.exists, values, notices }
  }
  async change(tool: ProxyTool, state: EnvironmentState, proxy: string | null, signal: AbortSignal): Promise<EnvironmentState> {
    let raw: string
    if (tool === 'npm') raw = replaceNpmProxy(state.raw, proxy)
    else {
      const before = await this.#git(state.raw, signal), after = await this.#git(state.raw, signal, { proxy })
      if (!isDeepStrictEqual(before.entries.filter(([key]) => key !== 'http.proxy'), after.entries.filter(([key]) => key !== 'http.proxy'))) throw fail('Git 其他配置发生变化，停止写入')
      const targets = after.entries.filter(([key]) => key === 'http.proxy')
      if (proxy === null ? targets.length !== 0 : targets.length !== 1 || targets[0]![1] !== proxy) throw fail('Git 代理副本核验失败')
      raw = after.raw
    }
    if (Buffer.byteLength(raw) > 256 * 1024) throw fail('修改后的代理配置超过限制')
    return { ...state, exists: state.exists || proxy !== null, raw }
  }
  async write(tool: ProxyTool, before: EnvironmentState, after: EnvironmentState, signal: AbortSignal) {
    if (before.location !== after.location || before.source !== 'user' || after.source !== 'user' || (!after.exists && after.raw !== '')) throw fail('代理配置写入目标无效')
    if (environmentRevision(await this.read(tool, signal)) !== environmentRevision(before)) throw fail('代理配置已变化，请重新读取')
    if (before.exists && !((await fs.lstat(before.location)).mode & 0o200)) throw fail('代理配置为只读文件，未修改')
    const adapter = this.adapter()
    let recoveryPath: string | undefined, writeFailure: unknown
    try {
      if (!after.exists) {
        if (!before.exists) return
        if (!adapter.trash) throw fail('安全文件组件不支持恢复到不存在的状态')
        const file = await adapter.pin(before.location, 'file', ['read'], signal)
        try {
          if ((await adapter.read(file, [], 256 * 1024, signal)).toString('utf8') !== before.raw) throw fail('恢复前代理配置已变化')
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
        throw fail(`${writeFailure instanceof Error ? writeFailure.message + '；' : ''}安全文件组件退出未确认：${error instanceof Error ? error.message : '清理失败'}；请检查配置 ${before.location}${recoveryPath ? ` 与保留的原文件 ${recoveryPath}` : ''}`)
      }
    }
  }
}
