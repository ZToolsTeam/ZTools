import { execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { parseProbeTarget, type ProbeTarget, type NetworkProbe, type NetworkSnapshot, type NetworkBandwidth } from '../../contracts/network-speedtest.js'

/** 只供宿主固定命令使用；取消时终止只读测量进程，等 close 后释放操作锁。 */
export async function runNetworkCommand(file: string, args: string[], signal: AbortSignal, timeout = 22000): Promise<string> {
  signal.throwIfAborted()
  let output = '', failure: Error | null = null
  const child = execFile(file, args, { encoding: 'utf8', timeout, signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, stdout, stderr) => {
    output = stdout
    if (error) failure = new Error(`${error.message}${stderr ? `：${stderr.trim().slice(0, 800)}` : ''}`)
  })
  await new Promise<void>(resolve => child.once('close', () => resolve()))
  signal.throwIfAborted()
  if (failure) throw failure
  return output
}
export function parseNetworkQuality(raw: string, durationMs: number): NetworkBandwidth {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统测速回执不是有效对象')
  const r = value as Record<string, unknown>
  if (r.error_code !== undefined && r.error_code !== 0) throw new Error(`系统测速未完成：${String(r.error_domain || '网络错误')} (${String(r.error_code)})`)
  const number = (key: string, optional = false): number | null => {
    if (r[key] === undefined && optional) return null
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || r[key] < 0) throw new Error(`系统测速缺少有效的 ${key}，没有生成网速结果`)
    return r[key]
  }
  const download = number('dl_throughput')!, upload = number('ul_throughput')!
  if (!download || !upload || typeof r.interface_name !== 'string' || !/^[\w.:-]{1,64}$/.test(r.interface_name)) throw new Error('系统测速未获得完整的上下行吞吐量或网卡信息')
  return { downloadMbps: download / 1_000_000, uploadMbps: upload / 1_000_000, baseRttMs: number('base_rtt', true), responsivenessRpm: number('responsiveness', true),
    downloadedBytes: number('dl_bytes_transferred', true), uploadedBytes: number('ul_bytes_transferred', true), interfaceName: r.interface_name, durationMs, checkedAt: new Date().toISOString() }
}
export function parseDefaultRoute(raw: string, interfaces = os.networkInterfaces()): NetworkSnapshot {
  const iface = raw.match(/^\s*interface:\s*([\w.:-]+)\s*$/m)?.[1] ?? null
  const gateway = raw.match(/^\s*gateway:\s*(\S+)\s*$/m)?.[1]
  return { interfaceName: iface, localAddresses: iface ? (interfaces[iface] ?? []).filter(a => !a.internal).map(a => a.address) : [],
    gateway: gateway && net.isIP(gateway) ? gateway : null, warning: !iface ? '系统未提供默认网卡' : !gateway || !net.isIP(gateway) ? '默认路由未提供 IP 网关，隧道或 VPN 连接可能没有可探测网关' : null }
}
function probeFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const descriptions: Record<string, string> = { ECONNREFUSED: '目标端口未开放或拒绝连接', ENOTFOUND: '无法解析主机名', EHOSTUNREACH: '目标地址不可达', ENETUNREACH: '当前路由无法连接目标网络', ETIMEDOUT: '连接超时' }
  return code && descriptions[code] ? `${descriptions[code]} (${code})` : error instanceof Error ? error.message : String(error)
}
function tcpSample(target: ProbeTarget, signal: AbortSignal): Promise<{ ms: number; address: string }> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = new net.Socket(), started = performance.now()
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(deadline); signal.removeEventListener('abort', cancel)
      const address = socket.remoteAddress || target.host
      socket.destroy()
      if (error) reject(error); else resolve({ ms: performance.now() - started, address })
    }
    const cancel = () => finish(new Error('节点检测已取消'))
    const deadline = setTimeout(() => finish(new Error('连接超时（2 秒）')), 2000)
    signal.addEventListener('abort', cancel, { once: true })
    socket.once('error', finish); socket.once('connect', () => finish())
    try { socket.connect(target.port, target.host) } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}
export async function measureTcpNode(target: ProbeTarget, signal: AbortSignal): Promise<NetworkProbe> {
  const samplesMs: number[] = []
  let error: string | null = null, address = target.host
  // 先解析并固定本次远端地址；三个计时样本使用同一地址，不把 DNS 耗时混入抖动。
  try { address = (await tcpSample(target, signal)).address }
  catch (e) { signal.throwIfAborted(); return { ...target, protocol: 'TCP', samplesMs, latencyMs: null, jitterMs: null, error: probeFailure(e) } }
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const sample = await tcpSample({ ...target, host: address }, signal); address = sample.address; samplesMs.push(sample.ms) }
    catch (e) { signal.throwIfAborted(); error = probeFailure(e); break }
  }
  const latencyMs = samplesMs.length ? samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length : null
  const jitterMs = samplesMs.length >= 2 ? samplesMs.slice(1).reduce((sum, value, i) => sum + Math.abs(value - samplesMs[i]!), 0) / (samplesMs.length - 1) : null
  return { ...target, protocol: 'TCP', samplesMs, latencyMs, jitterMs, error }
}
const NODES: ProbeTarget[] = [
  { host: 'www.qq.com', name: '腾讯', group: 'domestic', port: 443 },
  { host: 'www.taobao.com', name: '淘宝', group: 'domestic', port: 443 },
  { host: 'www.bilibili.com', name: '哔哩哔哩', group: 'domestic', port: 443 },
  { host: 'github.com', name: 'GitHub', group: 'global', port: 443 },
  { host: 'www.cloudflare.com', name: 'Cloudflare', group: 'global', port: 443 }
]
export interface SpeedtestProvider {
  diagnose(target: string | undefined, signal: AbortSignal): Promise<{ nodes: NetworkProbe[]; network: NetworkSnapshot; checkedAt: string }>
  bandwidth(signal: AbortSignal): Promise<NetworkBandwidth>
}
export class MacSpeedtestProvider implements SpeedtestProvider {
  async bandwidth(signal: AbortSignal) {
    const started = performance.now(), output = await runNetworkCommand('/usr/bin/networkQuality', ['-c', '-M', '15'], signal)
    return parseNetworkQuality(output, performance.now() - started)
  }
  async diagnose(target: string | undefined, signal: AbortSignal) {
    let network: NetworkSnapshot
    try { network = parseDefaultRoute(await runNetworkCommand('/sbin/route', ['-n', 'get', 'default'], signal, 3000)) }
    catch (error) { signal.throwIfAborted(); network = { interfaceName: null, localAddresses: [], gateway: null, warning: `未读取到默认路由：${String(error).slice(0, 300)}` } }
    const targets = target ? [parseProbeTarget(target)] : NODES
    const nodes = await Promise.all(targets.map(node => measureTcpNode(node, signal)))
    if (!target && network.gateway) {
      const gateway = network.gateway, samplesMs: number[] = []; let error: string | null = null
      try {
        const text = await runNetworkCommand(net.isIP(gateway) === 6 ? '/sbin/ping6' : '/sbin/ping', ['-n', '-c', '3', gateway], signal, 4000)
        for (const match of text.matchAll(/time[=<]([\d.]+)\s*ms/g)) samplesMs.push(Number(match[1]))
        if (samplesMs.length !== 3) error = `网关只返回 ${samplesMs.length}/3 次响应`
      } catch (e) { signal.throwIfAborted(); error = String(e).slice(0, 500) }
      nodes.unshift({ host: gateway, port: 0, name: '默认网关', group: 'gateway', protocol: 'ICMP', samplesMs,
        latencyMs: samplesMs.length ? samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length : null,
        jitterMs: samplesMs.length >= 2 ? samplesMs.slice(1).reduce((sum, v, i) => sum + Math.abs(v - samplesMs[i]!), 0) / (samplesMs.length - 1) : null, error })
    }
    return { network, nodes, checkedAt: new Date().toISOString() }
  }
}
