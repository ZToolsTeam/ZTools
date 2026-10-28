import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { MacStartupItem, MacStartupScan } from '../../contracts/startup-manager.js'
import { runStartupCommand, startupCommandOutput, type StartupCommand } from './startup-command.js'

export const STARTUP_FILE_LIMIT = 1024 * 1024
export const startupHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const startupRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const labelPattern = /^[A-Za-z0-9_.-]{1,255}$/
export interface StartupEnvironment { home: string; uid: number; systemAgents: string; daemons: string }
export const startupEnvironment = (): StartupEnvironment => ({ home: os.homedir(), uid: process.getuid?.() ?? -1, systemAgents: '/Library/LaunchAgents', daemons: '/Library/LaunchDaemons' })
export interface StartupSnapshot { item: MacStartupItem; bytes: Buffer; identity: string; revision: string; disabledOverride: boolean | null; plistDisabled: boolean }

export async function readStartupBytes(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > STARTUP_FILE_LIMIT) throw new Error('启动配置不是普通单链接文件或超过 1 MiB')
    const buffer = Buffer.alloc(STARTUP_FILE_LIMIT + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const bytes = buffer.subarray(0, length), after = await handle.stat(), named = await fs.lstat(file)
    if (bytes.length > STARTUP_FILE_LIMIT || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || named.dev !== after.dev || named.ino !== after.ino) throw new Error('启动配置读取期间变化，请重新扫描')
    return { bytes, identity: `${after.dev}:${after.ino}`, revision: startupHash(bytes), uid: after.uid, mode: after.mode }
  } finally { await handle.close() }
}

export function parseStartupOverrides(output: string) {
  const result = new Map<string, boolean>()
  const lines = output.trim().split(/\r?\n/)
  if (lines.shift()?.trim() !== 'disabled services = {' || lines.pop()?.trim() !== '}') throw new Error('无法识别系统自启状态')
  for (const line of lines) {
    if (!line.trim()) continue
    const match = /^\s*"([^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)\s*$/.exec(line)
    if (!match || result.has(match[1]!)) throw new Error('系统自启状态包含无法识别或重复的条目')
    result.set(match[1]!, match[2] === 'true' || match[2] === 'disabled')
  }
  return result
}

export async function readStartupLoaded(domain: string, label: string, signal: AbortSignal, run: StartupCommand) {
  const reply = await run(['print', `${domain}/${label}`], signal)
  if (reply.code === 113 && /Could not find service/.test(reply.stderr)) return { loaded: false, running: false, pid: null, loadedPath: null }
  const output = startupCommandOutput(reply)
  const state = /^\s*state = ([^\r\n]+)/m.exec(output)?.[1]?.trim()
  if (!state) throw new Error('无法确认启动项当前运行状态')
  const pidText = /^\s*pid = (\d+)\s*$/m.exec(output)?.[1]
  const pid = pidText ? Number(pidText) : null
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('启动项进程编号无效')
  const loadedPath = /^\s*path = ([^\r\n]+)$/m.exec(output)?.[1]?.trim() ?? null
  return { loaded: true, running: state === 'running', pid, loadedPath }
}

export async function parseStartupPlist(bytes: Buffer, signal: AbortSignal, run: StartupCommand) {
  const value: unknown = JSON.parse(startupCommandOutput(await run(['-convert', 'json', '-o', '-', '--', '-'], signal, bytes)))
  if (!startupRecord(value) || typeof value.Label !== 'string' || !labelPattern.test(value.Label)) throw new Error('启动配置缺少有效 Label')
  if (value.Disabled !== undefined && typeof value.Disabled !== 'boolean') throw new Error('启动配置 Disabled 不是布尔值')
  const rawArgs = value.ProgramArguments ?? []
  if (!Array.isArray(rawArgs) || rawArgs.length > 512 || rawArgs.some(v => typeof v !== 'string' || v.length > 16384 || v.includes('\0'))) throw new Error('启动命令参数无效')
  const args = rawArgs as string[], program = value.Program ?? args[0]
  if (typeof program !== 'string' || !program || program.length > 16384 || program.includes('\0')) throw new Error('启动配置缺少有效程序路径')
  return { label: value.Label, program, args, disabled: value.Disabled === true,
    scheduled: value.StartInterval !== undefined || value.StartCalendarInterval !== undefined,
    background: value.KeepAlive !== undefined || value.MachServices !== undefined }
}

async function programState(program: string): Promise<MacStartupItem['programState']> {
  // 相对程序名由 launchd 的环境解析；不能将解析不了误判为已卸载。
  if (!path.isAbsolute(program)) return 'unknown'
  try { return (await fs.stat(program)).isFile() ? 'available' : 'unknown' }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '') ? 'missing' : 'unknown' }
}

export class MacStartupReader {
  constructor(readonly env = startupEnvironment(), readonly run: StartupCommand = runStartupCommand) {}
  async read(file: string, scope: MacStartupItem['scope'], overrides: Map<string, boolean>, signal: AbortSignal): Promise<StartupSnapshot> {
    signal.throwIfAborted()
    const data = await readStartupBytes(file), config = await parseStartupPlist(data.bytes, signal, this.run)
    const domain = scope === 'daemon' ? 'system' : `gui/${this.env.uid}`, disabledOverride = overrides.get(config.label) ?? null
    const legacyDisabled = file.endsWith('.plist.disabled'), apple = config.label.startsWith('com.apple.')
    const current = await readStartupLoaded(domain, config.label, signal, this.run)
    const blockedReason = apple ? '系统保护项' : legacyDisabled ? '旧版改名禁用的配置，需要恢复原文件名后重新扫描' :
      current.loaded && current.loadedPath !== file ? '当前已加载的配置路径与扫描结果不一致' :
      scope === 'user-agent' && (data.uid !== this.env.uid || (data.mode & 0o022)) ? '配置所有者或写入权限异常' : null
    return { ...data, disabledOverride, plistDisabled: config.disabled, item: {
      id: startupHash(`${domain}\0${file}\0${config.label}`), label: config.label, file, domain, scope,
      program: config.program, args: config.args, scheduled: config.scheduled,
      enabled: !legacyDisabled && !(disabledOverride ?? config.disabled), ...current,
      programState: await programState(config.program), requiresAdmin: scope !== 'user-agent', blockedReason
    } }
  }
  async scan(signal: AbortSignal): Promise<{ result: MacStartupScan; snapshots: StartupSnapshot[] }> {
    const warnings: string[] = [], snapshots: StartupSnapshot[] = [], domains = new Map<string, Map<string, boolean>>()
    let totalBytes = 0, readableDirectories = 0, candidates = 0
    const sources: { directory: string; scope: MacStartupItem['scope'] }[] = [
      { directory: path.join(this.env.home, 'Library/LaunchAgents'), scope: 'user-agent' },
      { directory: this.env.systemAgents, scope: 'system-agent' }, { directory: this.env.daemons, scope: 'daemon' }
    ]
    for (const domain of [`gui/${this.env.uid}`, 'system']) {
      try { domains.set(domain, parseStartupOverrides(startupCommandOutput(await this.run(['print-disabled', domain], signal)))) }
      catch (error) { signal.throwIfAborted(); warnings.push(`${domain}：${String(error).slice(0, 700)}`) }
    }
    if (!domains.size) throw new Error(`无法读取系统启动状态：${warnings.join('；')}`)
    for (const { directory, scope } of sources) {
      signal.throwIfAborted()
      const overrides = domains.get(scope === 'daemon' ? 'system' : `gui/${this.env.uid}`)
      if (!overrides) continue
      let names: string[]
      try {
        names = (await fs.readdir(directory)).filter(n => /\.plist(?:\.disabled)?$/.test(n)).sort()
        readableDirectories++; candidates += names.length
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${directory}：读取失败 ${String(error).slice(0, 500)}`)
        continue
      }
      if (names.length > 512) throw new Error('启动项超过单目录 512 项，请先在系统设置中检查')
      for (const name of names) {
        try {
          const snapshot = await this.read(path.join(directory, name), scope, overrides, signal)
          totalBytes += snapshot.bytes.length
          snapshots.push(snapshot)
        }
        catch (error) { signal.throwIfAborted(); warnings.push(`${name}：${String(error).slice(0, 700)}`) }
        if (totalBytes > 16 * 1024 * 1024) throw new Error('启动配置合计超过 16 MiB，已停止扫描')
      }
    }
    if (!snapshots.length && warnings.length && (!readableDirectories || candidates)) throw new Error(`无法读取启动配置：${warnings.slice(0, 4).join('；')}`)
    const seen = new Map<string, StartupSnapshot>()
    for (const s of snapshots) {
      const key = `${s.item.domain}/${s.item.label}`, previous = seen.get(key)
      if (previous) { s.item.blockedReason = previous.item.blockedReason = '多个配置使用同一 Label，不能确定对应关系' }
      seen.set(key, s)
    }
    signal.throwIfAborted()
    return { result: { success: true, items: snapshots.map(s => s.item), warnings }, snapshots }
  }
}
