import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { DnsWriteOutcomeUnknownError, runDnsWriteCommand } from './dns-write-command.js'
import { validDnsServers, validNetworkService, type DnsNetworkService } from '../../contracts/dns-benchmark.js'

export type DnsCommand = (file: string, args: readonly string[], signal: AbortSignal, timeoutMs?: number) => Promise<string>
const exec = promisify(execFile)
export const runDnsCommand: DnsCommand = async (file, args, signal, timeoutMs = 8000) => {
  const result = await exec(file, [...args], { encoding: 'utf8', shell: false, signal, timeout: timeoutMs, maxBuffer: 128 * 1024, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
  if (result.stderr.trim() || /(?:^|\n)\s*(?:\*\*\s*)?(?:Error:|You need administrator|Authorization failed)/i.test(result.stdout)) {
    throw new Error((result.stderr || result.stdout).trim().slice(0, 1000))
  }
  return result.stdout
}
export function parseMacNetworkServices(output: string): { name: string; device: string }[] {
  const result: { name: string; device: string }[] = [], names = new Set<string>()
  let pending: string | null = null
  for (const line of output.split(/\r?\n/)) {
    const service = /^\((\d+|\*)\)\s+(.+)$/.exec(line)
    if (service) {
      if (pending) throw new Error('网络服务缺少设备映射，已停止读取')
      const name = service[2] ?? ''
      pending = service[1] === '*' || name.startsWith('*') ? null : name
      if (pending && !validNetworkService(pending)) throw new Error('网络服务名称无法安全识别')
      continue
    }
    if (!pending) continue
    const hardware = /^\(Hardware Port: .*, Device:\s*([^)]*)\)$/.exec(line)
    if (!hardware) continue
    const device = (hardware[1] ?? '').trim()
    if (device) {
      if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(device) || names.has(pending)) throw new Error('网络服务映射重复或无效')
      result.push({ name: pending, device }); names.add(pending)
    }
    pending = null
  }
  if (pending || result.length > 128) throw new Error('网络服务列表不完整或过大')
  if (!result.length && !output.includes('An asterisk (*) denotes')) throw new Error('无法识别系统网络服务列表')
  return result
}
export function parseMacDnsServers(output: string, service: string): string[] {
  const text = output.trim()
  if (text === `There aren't any DNS Servers set on ${service}.`) return []
  const servers = text.split(/\r?\n/).map(v => v.trim())
  if (!validDnsServers(servers) || !servers.length) throw new Error('无法确认原 DNS 配置，已停止操作')
  return servers
}
export interface DnsNetworkProvider {
  list(signal: AbortSignal): Promise<DnsNetworkService[]>
  read(service: string, signal: AbortSignal): Promise<string[]>
  write(service: string, device: string, expected: string[], servers: string[], signal: AbortSignal): Promise<void>
  flush(signal: AbortSignal): Promise<void>
}
export function macDnsHelperPath(isPackaged: boolean, resourcesPath: string) {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacDns') : path.resolve(__dirname, '../../mac-dns-native/native/ZToolsMacDns')
}
export class MacDnsNetworkProvider implements DnsNetworkProvider {
  constructor(private readonly run: DnsCommand = runDnsCommand, private readonly interfaces = os.networkInterfaces, private readonly helperPath?: string, private readonly writeCommand: DnsCommand = runDnsWriteCommand) {}
  async list(signal: AbortSignal): Promise<DnsNetworkService[]> {
    const mapping = parseMacNetworkServices(await this.run('/usr/sbin/networksetup', ['-listnetworkserviceorder'], signal))
    const networks = this.interfaces(), result: DnsNetworkService[] = []
    for (const item of mapping) {
      signal.throwIfAborted()
      const addresses = (networks[item.device] ?? []).filter(v => !v.internal).map(v => v.address)
      if (addresses.length) result.push({ ...item, addresses, servers: await this.read(item.name, signal), backup: null })
    }
    return result
  }
  async read(service: string, signal: AbortSignal) {
    if (!validNetworkService(service)) throw new Error('网络服务名称无效')
    return parseMacDnsServers(await this.run('/usr/sbin/networksetup', ['-getdnsservers', service], signal), service)
  }
  async write(service: string, device: string, expected: string[], servers: string[], signal: AbortSignal) {
    if (!validNetworkService(service) || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(device) || !validDnsServers(expected) || !validDnsServers(servers)) throw new Error('DNS 配置无效')
    const stat = this.helperPath && fs.lstatSync(this.helperPath, { throwIfNoEntry: false })
    if (!this.helperPath || !path.isAbsolute(this.helperPath) || !stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('DNS 安全配置组件未构建，请更新客户端')
    const output = await this.writeCommand(this.helperPath, ['--apply', service, device, JSON.stringify(expected), JSON.stringify(servers), '--authorize'], signal, 90000)
    let result: Record<string, unknown> | null
    try { result = JSON.parse(output) as Record<string, unknown> | null } catch { throw new DnsWriteOutcomeUnknownError() }
    const failures = ['INVALID_REQUEST', 'INVALID_EXPECTED_DNS', 'INVALID_TARGET_DNS', 'ADMIN_PERMISSION_REQUIRED', 'PREFERENCES_UNAVAILABLE',
      'CONFIGURATION_BUSY', 'CONFIGURATION_LOCK_FAILED', 'NETWORK_SET_UNAVAILABLE', 'NETWORK_SERVICES_UNAVAILABLE', 'AMBIGUOUS_SERVICE',
      'NETWORK_SERVICE_UNAVAILABLE', 'NETWORK_DEVICE_CHANGED', 'DNS_PROTOCOL_UNAVAILABLE', 'INVALID_EXISTING_DNS', 'DNS_CONFIGURATION_CHANGED',
      'DNS_CONFIGURATION_REJECTED', 'DNS_COMMIT_FAILED', 'DNS_APPLY_FAILED', 'REQUEST_CANCELLED', 'PARENT_UNAVAILABLE']
    if (!result || result.version !== 1 || typeof result.success !== 'boolean' || typeof result.code !== 'string' ||
      !(result.success ? ['UNCHANGED', 'APPLIED'] : failures).includes(result.code)) throw new DnsWriteOutcomeUnknownError()
    if (!result.success) {
      const code = result.code === 'ADMIN_PERMISSION_REQUIRED' ? '未获得系统授权，DNS 没有写入' : result.code
      throw new Error(`系统 DNS 写入未成功：${code}`)
    }
  }
  async flush(signal: AbortSignal) {
    // 命令完全固定，不插入插件参数；系统负责请求管理员授权，取消或失败均向上返回。
    await this.run('/usr/bin/osascript', ['-e', 'do shell script "/usr/bin/dscacheutil -flushcache && /usr/bin/killall -HUP mDNSResponder" with administrator privileges'], signal, 90000)
  }
}
