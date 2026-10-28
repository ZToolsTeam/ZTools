import fs from 'node:fs/promises'
import fsSync, { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { HOSTS_MAX_BYTES, hostsRecord, type HostsSnapshot } from '../../contracts/hosts-manager.js'
import { runDnsCommand, MacDnsNetworkProvider, type DnsCommand } from './dns-network-provider.js'

export interface HostsProvider {
  read(signal: AbortSignal): Promise<HostsSnapshot>
  write(before: HostsSnapshot, content: string, signal: AbortSignal): Promise<{ recoveryPath: string }>
  flush(signal: AbortSignal): Promise<void>
}
export function macHostsHelperPath(isPackaged: boolean, resourcesPath: string) {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacHosts') : path.resolve(__dirname, '../../mac-hosts-native/native/ZToolsMacHosts')
}
export function hostsRevision(content: string) { return createHash('sha256').update(content).digest('hex') }
export async function readHostsFile(file: string, signal: AbortSignal): Promise<HostsSnapshot> {
  signal.throwIfAborted()
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > HOSTS_MAX_BYTES) throw new Error('Hosts 不是普通单链接文件或超过 1 MiB')
    const bytes = await handle.readFile(), after = await handle.stat(), named = await fs.lstat(file)
    if (bytes.length > HOSTS_MAX_BYTES || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || named.dev !== after.dev || named.ino !== after.ino) throw new Error('Hosts 读取期间变化，请重试')
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Hosts 包含二进制内容，停止读取')
    signal.throwIfAborted()
    return { content, identity: `${after.dev}:${after.ino}`, revision: hostsRevision(content), path: file }
  } finally { await handle.close() }
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
export class MacHostsProvider implements HostsProvider {
  constructor(private readonly helper: string, private readonly run: DnsCommand = runDnsCommand,
    private readonly file = '/private/etc/hosts', private readonly dns = new MacDnsNetworkProvider()) {}
  read(signal: AbortSignal) { return readHostsFile(this.file, signal) }
  flush(signal: AbortSignal) { return this.dns.flush(signal) }
  async write(before: HostsSnapshot, content: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (process.platform !== 'darwin') throw new Error('此 Hosts 写入组件仅用于 macOS')
    const helper = await fs.lstat(this.helper)
    if (!path.isAbsolute(this.helper) || !helper.isFile() || helper.isSymbolicLink()) throw new Error('Hosts 安全写入组件不可用，请更新客户端')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-hosts-request-'))
    const file = path.join(directory, 'request.json'), cancel = path.join(directory, 'cancel')
    let cancelError: unknown
    const abort = () => {
      try { fsSync.writeFileSync(cancel, 'cancel', { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          cancelError = error
          // 标记写入失败时撤销请求，原生组件会拒绝执行已不存在的请求。
          try { fsSync.unlinkSync(file) } catch (removeError) { cancelError = removeError }
        }
      }
    }
    try {
      await fs.chmod(directory, 0o700)
      await fs.writeFile(file, JSON.stringify({ version: 1, expected: before.content, content, identity: before.identity, deadline: Date.now() + 85000 }), { flag: 'wx', mode: 0o600 })
      signal.addEventListener('abort', abort, { once: true }); signal.throwIfAborted()
      // 参数逐个 shell 转义，再作为 AppleScript 字符串；仅固定组件可以修改固定的系统 hosts。
      const command = [this.helper, '--apply', file, String(process.getuid!())].map(shellQuote).join(' ')
      const appleScript = `do shell script ${JSON.stringify(command)} with administrator privileges`
      let output: string
      try { output = await this.run('/usr/bin/osascript', ['-e', appleScript], AbortSignal.timeout(100000), 100000) }
      catch (error) { throw new Error(`系统授权或写入未确认，请重新读取 Hosts；${error instanceof Error ? error.message : String(error)}`) }
      let reply: unknown
      try { reply = JSON.parse(output) } catch { throw new Error('Hosts 写入结果无法解析，请重新读取系统文件') }
      if (!hostsRecord(reply) || reply.version !== 1 || typeof reply.success !== 'boolean' || typeof reply.recoveryPath !== 'string' || typeof reply.code !== 'string') throw new Error('Hosts 写入结果不完整，请重新读取')
      if (!reply.success) throw new Error(`Hosts 未确认写入：${reply.code}${reply.recoveryPath ? `；原文件恢复目录 ${reply.recoveryPath}` : ''}${cancelError ? '；取消标记写入失败' : ''}`)
      if (!['APPLIED', 'UNCHANGED'].includes(reply.code)) throw new Error('Hosts 写入状态未知，请重新读取')
      const current = await this.read(AbortSignal.timeout(10000))
      if (current.content !== content) throw new Error(`Hosts 写入后校验不一致；恢复目录 ${reply.recoveryPath}`)
      return { recoveryPath: reply.recoveryPath }
    } finally {
      signal.removeEventListener('abort', abort)
      // 请求是本次创建的私有临时数据；删除后尚未开始的提权请求无法再执行。
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
