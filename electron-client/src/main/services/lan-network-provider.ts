import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import dgram from 'node:dgram'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { macNetworkHelperPath, readLanNeighbors } from './lan-neighbor-reader.js'
import { LAN_PORTS, ipv4Text, normalizeLanMac, subnetBounds, type LanHost, type LanInterface } from '../../contracts/lan-network.js'

const exec = promisify(execFile)
// Windows 网卡名可含空格、括号与中文（“以太网 2”“vEthernet (WSL)”），只排除会破坏网卡编号的竖线、控制字符与超长名称
const windowsNameOk = (name: string) => name.length >= 1 && name.length <= 64 && !/[|\u0000-\u001f\u007f]/.test(name)
const macNameOk = (name: string) => /^[\w.:-]{1,64}$/.test(name) && !/^(lo|utun|awdl|llw|gif|stf|ipsec)/i.test(name)
// Windows 默认选中顺序：真实网卡优先，虚拟交换机与 169.254 自动私有地址排后（只调整顺序，不隐藏）
const windowsRank = (v: LanInterface) => (v.ip.startsWith('169.254.') ? 2 : 0) + (/^(vEthernet|VMware|VirtualBox)/i.test(v.name) ? 1 : 0)
export function listLanInterfaces(source = os.networkInterfaces(), platform: string = process.platform): LanInterface[] {
  const result: LanInterface[] = [], nameOk = platform === 'win32' ? windowsNameOk : macNameOk
  for (const [name, entries] of Object.entries(source)) {
    if (!nameOk(name)) continue
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      const bounds = subnetBounds(entry.address, entry.netmask)
      if (bounds.prefix < 1) continue
      result.push({ id: `${name}|${entry.address}|${entry.netmask}`, name, ip: entry.address, netmask: entry.netmask,
        subnet: `${ipv4Text(bounds.first)}/${bounds.prefix}`, prefix: bounds.prefix, broadcast: bounds.prefix < 31 ? ipv4Text(bounds.last) : null })
    }
  }
  return platform === 'win32' ? result.map((v, i) => ({ v, i })).sort((a, b) => windowsRank(a.v) - windowsRank(b.v) || a.i - b.i).map(x => x.v) : result
}
export async function probeLanPing(ip: string, source: string, signal: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await exec('/sbin/ping', ['-n', '-c', '1', '-W', '350', '-t', '1', '-S', source, ip], { signal, timeout: 1800, maxBuffer: 8192, env: { ...process.env, LC_ALL: 'C' } })
    const match = stdout.match(/time[=<]([\d.]+)\s*ms/)
    if (!match || !Number.isFinite(Number(match[1]))) throw new Error('系统 ping 回执无有效延迟')
    return Number(match[1])
  } catch (error) {
    signal.throwIfAborted()
    if ((error as { code?: unknown }).code === 2) return null
    throw error
  }
}
export function probeLanTcp(ip: string, port: number, source: string, signal: AbortSignal): Promise<{ open: boolean; responded: boolean; ms: number }> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = new net.Socket(), start = performance.now()
    let done = false
    const finish = (open: boolean, responded: boolean, error?: Error) => {
      if (done) return
      done = true; signal.removeEventListener('abort', cancel); socket.destroy()
      if (error) reject(error)
      else resolve({ open, responded, ms: Math.max(0, performance.now() - start) })
    }
    const cancel = () => finish(false, false, new Error('局域网扫描已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    socket.once('connect', () => finish(true, true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') finish(false, true)
      else if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ECONNRESET'].includes(error.code ?? '')) finish(false, false)
      else finish(false, false, error)
    })
    socket.setTimeout(350, () => finish(false, false))
    try { socket.connect({ host: ip, port, localAddress: source }) } catch (error) { finish(false, false, error as Error) }
  })
}
export function wolPacket(mac: string) {
  const address = Buffer.from(normalizeLanMac(mac).replace(/:/g, ''), 'hex'), packet = Buffer.alloc(102, 0xff)
  for (let offset = 6; offset < 102; offset += 6) address.copy(packet, offset)
  return packet
}
export function sendLanWake(mac: string, source: string, broadcast: string, signal: AbortSignal, port = 9): Promise<number> {
  signal.throwIfAborted()
  const packet = wolPacket(mac)
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    let done = false
    const finish = (error?: Error, bytes?: number) => {
      if (done) return
      done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel)
      try { socket.close() } catch (closeError) { error ??= closeError as Error }
      if (error) reject(error); else if (bytes !== 102) reject(new Error('系统未确认完整发送唤醒包')); else resolve(bytes)
    }
    const cancel = () => finish(new Error('唤醒包发送已取消，设备状态未知'))
    const timer = setTimeout(() => finish(new Error('唤醒包发送超时，设备状态未知')), 2000)
    signal.addEventListener('abort', cancel, { once: true }); socket.once('error', finish)
    try { socket.bind(0, source, () => {
      if (done) return
      try { socket.setBroadcast(true); socket.send(packet, port, broadcast, (error, bytes) => finish(error ?? undefined, bytes)) }
      catch (error) { finish(error as Error) }
    }) } catch (error) { finish(error as Error) }
  })
}
async function workers<T>(items: T[], concurrency: number, signal: AbortSignal, job: (item: T) => Promise<void>) {
  let cursor = 0
  const cancel = new AbortController(), combined = AbortSignal.any([signal, cancel.signal])
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    try { while (cursor < items.length) { combined.throwIfAborted(); await job(items[cursor++]!) } }
    catch (error) { cancel.abort(error); throw error }
  }))
  const failed = results.find(r => r.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
export interface LanNetworkProvider {
  interfaces(): LanInterface[]
  scan(iface: LanInterface, addresses: string[], signal: AbortSignal): Promise<{ devices: LanHost[]; warnings: string[] }>
  wake(mac: string, iface: LanInterface, signal: AbortSignal): Promise<number>
}
/** ping 结果：null 为本次无回复；有回复但系统输出里解析不到延迟（如俄语“время<1мс”）时 latencyMs 为 null，不编造数值 */
export type LanPingReply = { latencyMs: number | null }
export type LanPing = (ip: string, source: string, signal: AbortSignal) => Promise<LanPingReply | null>
export type LanNeighbors = (iface: LanInterface, signal: AbortSignal) => Promise<Map<string, string>>
export interface LanScanOptions { pingConcurrency?: number; tcp?: typeof probeLanTcp }
/**
 * Mac 与 Windows 共用的扫描流程：ICMP 与 TCP 并行探测，只记录本次真实响应的地址；MAC 只给已响应设备（含本机）补充，读取失败转为提示。
 * 系统 ping 失败（源地址失效、General failure 等）的输出随系统语言变化无法可靠识别，因此按结果判断：
 * 除本机外没有任何 ICMP 回复时给出提示，避免把“ping 全部失败”静默显示成“只有这些设备”。
 */
export async function scanLan(iface: LanInterface, addresses: string[], signal: AbortSignal, ping: LanPing, neighbors: LanNeighbors, options: LanScanOptions = {}) {
  const devices = new Map<string, LanHost>(), controller = new AbortController(), tcp = options.tcp ?? probeLanTcp
  const combined = AbortSignal.any([signal, controller.signal]), warnings: string[] = []
  const add = (ip: string, response: LanHost['response'], ms: number | null) => {
    const host = devices.get(ip) ?? { ip, mac: null, openPorts: [], response, latencyMs: ms }
    if (response === 'ICMP') { host.response = response; host.latencyMs = ms }
    devices.set(ip, host); return host
  }
  const jobs = [workers(addresses, options.pingConcurrency ?? 16, combined, async ip => {
    const reply = await ping(ip, iface.ip, combined)
    if (reply !== null) add(ip, 'ICMP', reply.latencyMs)
  }), workers(addresses.flatMap(ip => LAN_PORTS.map(port => ({ ip, port }))), 64, combined, async ({ ip, port }) => {
    const probe = await tcp(ip, port, iface.ip, combined)
    if (probe.responded) { const host = add(ip, 'TCP', probe.ms); if (probe.open) host.openPorts.push(port) }
  })]
  for (const job of jobs) void job.catch(error => { controller.abort(error) })
  const settled = await Promise.allSettled(jobs), failed = settled.find(r => r.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  combined.throwIfAborted()
  const others = [...devices.values()].filter(host => host.ip !== iface.ip)
  if (addresses.some(ip => ip !== iface.ip)) {
    if (!others.length) warnings.push('除本机外未收到任何 ping 回复，也没有设备的 TCP 端口响应：可能网段内没有其他在线设备、被防火墙拦截或系统 ping 失败')
    else if (!others.some(host => host.response === 'ICMP')) warnings.push('未收到任何 ping 回复：可能被防火墙拦截或系统 ping 失败，结果只包含 TCP 端口有响应的设备')
  }
  if (addresses.includes(iface.ip)) {
    if (!devices.has(iface.ip)) devices.set(iface.ip, { ip: iface.ip, mac: null, openPorts: [], response: '本机', latencyMs: null })
    else devices.get(iface.ip)!.response = '本机'
  }
  // 始终读取邻居表：macOS 邻居表含本机条目，本机行也带上 MAC；空表只在有其他响应设备时提示（Windows 空 ARP 表在 readWindowsNeighbors 中按空表处理）
  try {
    const arp = await neighbors(iface, combined)
    for (const host of devices.values()) host.mac = arp.get(host.ip) ?? null
    if (!arp.size && others.length) warnings.push('系统未提供邻居 MAC 地址；仍可查看响应设备和端口，远程唤醒请手动输入设备 MAC')
  } catch (error) { combined.throwIfAborted(); warnings.push(`MAC 地址读取失败：${error instanceof Error ? error.message : String(error)}`) }
  return { devices: [...devices.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })).map(h => ({ ...h, openPorts: h.openPorts.sort((a, b) => a - b) })), warnings }
}
/** 广播地址来自真实掩码计算的 iface.broadcast；/31、/32 点对点网段没有广播地址，直接拒绝 */
export function wakeLan(mac: string, iface: LanInterface, signal: AbortSignal) {
  if (!iface.broadcast) throw new Error('所选点对点网段不支持广播唤醒')
  return sendLanWake(mac, iface.ip, iface.broadcast, signal)
}
export class MacLanNetworkProvider implements LanNetworkProvider {
  constructor(private readonly helperPath = macNetworkHelperPath(
    typeof process.resourcesPath === 'string' && !process.defaultApp, process.resourcesPath ?? '')) {}
  interfaces() { return listLanInterfaces(os.networkInterfaces(), 'darwin') }
  scan(iface: LanInterface, addresses: string[], signal: AbortSignal) {
    const ping: LanPing = async (ip, source, abort) => { const ms = await probeLanPing(ip, source, abort); return ms === null ? null : { latencyMs: ms } }
    return scanLan(iface, addresses, signal, ping, (value, abort) => readLanNeighbors(this.helperPath, value.name, abort))
  }
  wake(mac: string, iface: LanInterface, signal: AbortSignal) { return wakeLan(mac, iface, signal) }
}
// ---- Windows：系统自带 PING.EXE / ARP.EXE，按 latin1 读取，只解析语言无关的数字、IP、MAC 与固定英文关键字 ----
export interface WindowsToolResult { stdout: string; exitCode: number | null; timedOut: boolean }
export type WindowsToolRunner = (file: string, args: string[], options: { signal: AbortSignal; timeout: number; maxBuffer: number }) => Promise<WindowsToolResult>
export function windowsSystemTool(name: 'PING.EXE' | 'ARP.EXE', root = process.env.SystemRoot || process.env.windir || '') {
  return path.win32.join(path.win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', name)
}
/** 非零退出码作为结果返回（由解析函数判定含义）；超时单独标记；找不到程序、输出超限、被取消一律抛错 */
export const runWindowsTool: WindowsToolRunner = (file, args, { signal, timeout, maxBuffer }) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  execFile(file, args, { encoding: 'latin1', windowsHide: true, shell: false, signal, timeout, maxBuffer }, (error, stdout) => {
    if (!error) { resolve({ stdout, exitCode: 0, timedOut: false }); return }
    if (signal.aborted) { reject(signal.reason ?? error); return }
    const failure = error as Error & { code?: unknown; killed?: boolean }
    if (typeof failure.code === 'number') resolve({ stdout, exitCode: failure.code, timedOut: false })
    else if (typeof failure.code !== 'string' && failure.killed) resolve({ stdout, exitCode: null, timedOut: true })
    else reject(error)
  })
})
const ipToken = (ip: string) => new RegExp(`(^|[^\\d.])${ip.replace(/\./g, '\\.')}([^\\d.]|$)`)
/**
 * 解析一次 Windows ping 的输出。退出码 1 为无回复；网关代发“无法访问目标主机”时退出码也可能为 0，
 * 所以必须有同时含目标地址与 TTL=数字 的回复行才算在线。延迟取该行的 “=12ms” / “<1ms”（<1ms 记 1）；
 * 延迟单位随语言变化（俄语“мс”按 latin1 读取后是乱码），解析不到时只记在线、latencyMs 为 null，不让整次扫描失败。
 */
export function parseWindowsPing(stdout: string, exitCode: number | null, target: string): LanPingReply | null {
  if (!net.isIPv4(target)) throw new Error('ping 目标地址无效')
  if (exitCode === 1) return null
  if (exitCode !== 0) throw new Error(`系统 ping 异常退出（退出码 ${exitCode ?? '未知'}）`)
  const token = ipToken(target), line = stdout.split(/\r?\n/).find(v => /(^|[^A-Za-z])TTL=\d+/i.test(v) && token.test(v))
  if (!line) return null
  const match = line.match(/[=<]\s*(\d+(?:\.\d+)?)\s*ms/i), ms = match ? Number(match[1]) : NaN
  return { latencyMs: Number.isFinite(ms) ? ms : null }
}
/** 超时（例如本网段无此主机时 Windows 等待 ARP 超过 -w）视为本次无回复，不算失败 */
export async function probeWindowsPing(ip: string, source: string, signal: AbortSignal, run: WindowsToolRunner = runWindowsTool) {
  signal.throwIfAborted()
  const result = await run(windowsSystemTool('PING.EXE'), ['-4', '-n', '1', '-w', '350', '-i', '1', '-S', source, ip], { signal, timeout: 1500, maxBuffer: 16384 })
  return result.timedOut ? null : parseWindowsPing(result.stdout, result.exitCode, ip)
}
/**
 * 解析 “arp -a -N 本机IP” 输出：只取 “本机IP --- 0x..” 段内的 “IPv4  xx-xx-xx-xx-xx-xx” 行，
 * 广播/组播/全零地址跳过；同一 IP 出现不同 MAC 视为不可靠并报错。
 */
const arpDataRow = /^\s*\d{1,3}(?:\.\d{1,3}){3}\s+[\da-f]{2}(?:-[\da-f]{2}){5}(?:\s|$)/im
export function parseWindowsArp(stdout: string, localIp: string): Map<string, string> {
  const entries = new Map<string, string>()
  let section: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const header = line.match(/(\d{1,3}(?:\.\d{1,3}){3})\s+-{3}\s+0x[\da-f]+\s*$/i)
    if (header) { section = header[1]!; continue }
    const row = line.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([\da-f]{2}(?:-[\da-f]{2}){5})(?:\s|$)/i)
    if (!row) continue
    if (section === null) throw new Error('系统 ARP 回执格式无法识别')
    const ip = row[1]!, hex = row[2]!.replace(/-/g, '').toUpperCase()
    if (section !== localIp || !net.isIPv4(ip) || /^0+$/.test(hex) || (parseInt(hex.slice(0, 2), 16) & 1)) continue
    const mac = normalizeLanMac(hex)
    if (entries.has(ip) && entries.get(ip) !== mac) throw new Error('系统 ARP 表中同一地址对应多个 MAC，结果不可靠')
    entries.set(ip, mac)
  }
  return entries
}
export async function readWindowsNeighbors(localIp: string, signal: AbortSignal, run: WindowsToolRunner = runWindowsTool) {
  signal.throwIfAborted()
  const result = await run(windowsSystemTool('ARP.EXE'), ['-a', '-N', localIp], { signal, timeout: 3000, maxBuffer: 1024 * 1024 })
  if (result.timedOut) throw new Error('系统 ARP 表读取超时')
  if (result.exitCode !== 0) {
    // ARP 表为空时 arp.exe 输出“未找到 ARP 项”（随语言变化）并以非零退出；只要输出里没有任何可解析的数据行就按空表处理，有数据行的非零退出仍是失败
    if (!arpDataRow.test(result.stdout)) return new Map<string, string>()
    throw new Error(`系统 ARP 表读取失败（退出码 ${result.exitCode ?? '未知'}）`)
  }
  return parseWindowsArp(result.stdout, localIp)
}
export interface WindowsLanProviderOptions { run?: WindowsToolRunner; source?: () => ReturnType<typeof os.networkInterfaces>; tcp?: typeof probeLanTcp }
export class WindowsLanNetworkProvider implements LanNetworkProvider {
  readonly #run: WindowsToolRunner
  readonly #source: () => ReturnType<typeof os.networkInterfaces>
  readonly #tcp: typeof probeLanTcp
  constructor(options: WindowsLanProviderOptions = {}) { this.#run = options.run ?? runWindowsTool; this.#source = options.source ?? (() => os.networkInterfaces()); this.#tcp = options.tcp ?? probeLanTcp }
  interfaces() { return listLanInterfaces(this.#source(), 'win32') }
  // 每次 ping 要启动进程且未知主机可能等满超时，并发比 Mac 高一档，保证 256 个地址在服务 25 秒总时限内完成
  scan(iface: LanInterface, addresses: string[], signal: AbortSignal) {
    return scanLan(iface, addresses, signal, (ip, source, abort) => probeWindowsPing(ip, source, abort, this.#run),
      (value, abort) => readWindowsNeighbors(value.ip, abort, this.#run), { pingConcurrency: 32, tcp: this.#tcp })
  }
  wake(mac: string, iface: LanInterface, signal: AbortSignal) { return wakeLan(mac, iface, signal) }
}
const unsupported = (): never => { throw new Error('此局域网接口目前仅支持 macOS 和 Windows') }
export function createLanNetworkProvider(platform: string = process.platform): LanNetworkProvider {
  if (platform === 'darwin') return new MacLanNetworkProvider()
  if (platform === 'win32') return new WindowsLanNetworkProvider()
  return { interfaces: unsupported, scan: unsupported, wake: unsupported }
}
