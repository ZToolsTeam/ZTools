import { execFile } from 'node:child_process'
import path from 'node:path'
import { parse as parsePlist } from 'plist'
import { fileUnlockRecord, type FileLockProcess } from '../../contracts/file-unlock.js'
import { parseMacVolumes } from './volume-service.js'

export interface LockCommandResult { stdout: string; code: number }
export type LockCommand = (file: string, args: string[], signal: AbortSignal, allowEmpty?: boolean) => Promise<LockCommandResult>
export const runLockCommand: LockCommand = (file, args, signal, allowEmpty = false) => {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }, (error, stdout, stderr) => {
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) reject(new Error('文件占用检测已取消'))
      else if (stderr.trim() || (error && !(allowEmpty && error.code === 1 && !error.killed && !error.signal))) reject(new Error(`系统占用检测未完成：${stderr.trim().slice(0, 300) || error?.message || '未知错误'}`))
      else resolve({ stdout, code: error ? 1 : 0 })
    })
    const cancel = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', cancel, { once: true })
    child.stdin?.end()
    if (signal.aborted) cancel()
  })
}
export interface MacProcessIdentity { pid: number; uid: number; started: string; executable: string; zombie: boolean }
export interface InspectedLock extends FileLockProcess { identity?: MacProcessIdentity }
interface LsofProcess { pid: number; name: string; uid: number; paths: string[] }

/** -F0 的换行只分隔记录；文件名中的换行由 lsof 转义，不按行切分字段。 */
export function parseLsofRecords(text: string): LsofProcess[] {
  if (!text) return []
  const rows: LsofProcess[] = [], pids = new Set<number>()
  let current: LsofProcess | undefined, file: { descriptor: string; type?: string; name?: string } | undefined
  const endFile = () => {
    if (!file) return
    if (!current || !file.descriptor || !file.type || !file.name) throw new Error('占用检测文件记录不完整')
    if (!current.paths.includes(file.name)) current.paths.push(file.name)
    if (current.paths.length > 4096) throw new Error('占用条目过多，停止检测')
    file = undefined
  }
  for (const raw of text.split('\0')) {
    const field = raw.replace(/^\n/, '')
    if (!field) continue
    const key = field[0], value = field.slice(1)
    if (key === 'p') {
      endFile()
      const pid = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid < 1 || pids.has(pid) || rows.length >= 1024) throw new Error('占用检测进程记录无效')
      current = { pid, name: '', uid: -1, paths: [] }; pids.add(pid); rows.push(current)
    } else if (!current) throw new Error('占用检测缺少进程编号')
    else if (key === 'c' && !file && !current.name) current.name = value
    else if (key === 'u' && !file && current.uid === -1 && /^\d+$/.test(value)) current.uid = Number(value)
    else if (key === 'f') { endFile(); file = { descriptor: value } }
    else if (key === 't' && file && !file.type) file.type = value
    else if (key === 'n' && file && !file.name) file.name = value
    else throw new Error('占用检测返回无法识别的字段')
  }
  endFile()
  if (rows.some(row => !row.name || row.uid < 0 || !Number.isSafeInteger(row.uid) || !row.paths.length)) throw new Error('占用检测结果不完整')
  return rows
}
export function sameMacProcess(a: MacProcessIdentity, b: MacProcessIdentity) {
  return a.pid === b.pid && a.uid === b.uid && a.started === b.started && a.executable === b.executable && !b.zombie
}
export class MacFileLocks {
  constructor(private readonly run: LockCommand = runLockCommand, private readonly protectedPids: () => Promise<Iterable<number>> | Iterable<number> = () => [process.pid, process.ppid]) {}
  async identity(pid: number, signal: AbortSignal): Promise<MacProcessIdentity | undefined> {
    const result = await this.run('/bin/ps', ['-p', String(pid), '-o', 'pid=,uid=,lstart=,stat=,comm='], signal, true)
    if (result.code === 1 && !result.stdout.trim()) return undefined
    const match = result.stdout.trimEnd().match(/^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+([^\r\n]+)$/)
    if (!match || Number(match[1]) !== pid || !match[5]!.startsWith('/')) throw new Error('无法确认占用进程的启动时间和程序路径，禁止结束')
    return { pid, uid: Number(match[2]), started: match[3]!, zombie: match[4]!.includes('Z'), executable: match[5]! }
  }
  async scan(target: string, directory: boolean, signal: AbortSignal, ownBrokerPid?: number, onlyPid?: number): Promise<InspectedLock[]> {
    const args = ['-nP', '-F0pcuftn', ...(onlyPid ? ['-a', '-p', String(onlyPid)] : []), ...(directory ? ['+D', target] : ['--', target])]
    const result = await this.run('/usr/sbin/lsof', args, signal, true)
    const rows = parseLsofRecords(result.stdout), locks: InspectedLock[] = []
    const protectedPids = new Set([process.pid, process.ppid, ...await this.protectedPids()])
    for (const row of rows) {
      signal.throwIfAborted()
      // 仅排除本次会话用于固定目标对象的组件进程，不排除其他占用文件的 ZTools 进程。
      if (row.pid === ownBrokerPid) continue
      let identity: MacProcessIdentity | undefined, reason = ''
      try { identity = await this.identity(row.pid, signal) }
      catch (error) { reason = error instanceof Error ? error.message : String(error) }
      signal.throwIfAborted()
      if (!reason && (!identity || identity.zombie)) continue
      if (identity && identity.uid !== row.uid) reason = '检测期间进程身份已变化，请重新扫描'
      const name = identity ? path.basename(identity.executable) : row.name
      if (row.pid <= 1 || protectedPids.has(row.pid) || ['launchd', 'kernel_task', 'windowserver', 'loginwindow', 'ztoolspathaccessbroker'].includes(name.toLowerCase())) reason = '系统或客户端关键进程受保护'
      if (identity && process.getuid && identity.uid !== process.getuid()) reason = '其他用户的进程，不能在此结束'
      locks.push({ pid: row.pid, name, executablePath: identity?.executable || '', userId: row.uid, paths: row.paths, protected: Boolean(reason), reason, ...(identity ? { identity } : {}) })
    }
    return locks
  }
  async drives(signal: AbortSignal) {
    // 包含外接磁盘的 APFS 合成卷；只筛 physical 会漏掉其实际挂载点。
    const result = await this.run('/usr/sbin/diskutil', ['list', '-plist', 'external'], signal)
    const data: unknown = parsePlist(result.stdout)
    if (!fileUnlockRecord(data) || !Array.isArray(data.AllDisksAndPartitions)) throw new Error('外接磁盘列表格式无效')
    return parseMacVolumes(data).filter(volume => volume.path !== '/').map(volume => ({ path: volume.path, label: volume.label }))
  }
}
