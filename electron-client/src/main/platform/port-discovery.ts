import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
export interface PortSummary {
  protocol: 'TCP' | 'UDP'; localAddress: string; localPort: number; remoteAddress: string; remotePort: number | null
  state: string; pid: number; processName: string
  fieldAvailability: { processName: boolean; processPath: false; startTime: false }
}
/**
 * source：darwin-netstat 为当前 macOS 实现（netstat -anv 无需 root 即可列出系统服务套接字），darwin-lsof 为旧实现保留的兼容值。
 * visibility：all-sockets 表示列出了全部本地套接字；visible-processes 表示只列出当前用户可见进程的套接字。
 */
export interface PortSnapshot { data: PortSummary[]; source: 'darwin-netstat' | 'darwin-lsof' | 'windows-netstat'; visibility: 'all-sockets' | 'visible-processes'; queriedAt: string }
export interface PortDiscoveryAdapter { list(signal: AbortSignal): Promise<PortSnapshot> }
type Execute = (file: string, args: string[], options: { encoding: 'utf8'; shell: false; timeout: number; maxBuffer: number; signal: AbortSignal; windowsHide: true }) => Promise<{ stdout: string; stderr?: string }>
const execute: Execute = promisify(execFile)
const invalid = () => new ZToolsError(errorCodes.processError, '端口列表无效或未完整返回')
const MAX_BYTES = 4 * 1024 * 1024, MAX_ROWS = 20000
function boundedOutput(value: string) { if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw invalid() }
function endpoint(value: string): { address: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^\[\]]+)):(\d{1,5})$/.exec(value)
  if (!match) throw invalid()
  const address = match[1] ?? match[2] ?? '', port = Number(match[3]), parts = address.split('%')
  if (port > 65535 || address.length > 128 || parts.length > 2 || (parts[1] !== undefined && !/^[a-zA-Z0-9_.-]{1,32}$/.test(parts[1])) || (address !== '*' && !isIP(parts[0]!))) throw invalid()
  return { address, port }
}
function unique(rows: PortSummary[]): PortSummary[] {
  const result = [...new Map(rows.map(row => [JSON.stringify([row.protocol, row.localAddress, row.localPort, row.remoteAddress, row.remotePort, row.state, row.pid]), row])).values()]
  if (result.length > MAX_ROWS) throw invalid()
  return result.sort((a, b) => a.localPort - b.localPort || a.pid - b.pid || a.protocol.localeCompare(b.protocol))
}
function availability(name: string) { return { processName: !!name, processPath: false as const, startTime: false as const } }
export function parseWindowsPorts(output: string): PortSummary[] {
  boundedOutput(output); const rows: PortSummary[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/), protocol = fields[0]
    if (protocol !== 'TCP' && protocol !== 'UDP') continue
    if (fields.length !== (protocol === 'TCP' ? 5 : 4)) throw invalid()
    const local = endpoint(fields[1]!), remote = fields[2] === '*:*' ? undefined : endpoint(fields[2]!), pid = Number(fields.at(-1))
    if (!/^\d+$/.test(fields.at(-1)!) || !Number.isSafeInteger(pid) || pid < 0 || pid > 0xffffffff) throw invalid()
    if (!local.port) continue
    const state = protocol === 'UDP' ? 'BOUND' : fields[3]!
    if (!/^[A-Z0-9_]{1,32}$/.test(state)) throw invalid()
    rows.push({ protocol, localAddress: local.address, localPort: local.port, remoteAddress: remote?.address ?? '', remotePort: remote?.port || null, state, pid, processName: '', fieldAvailability: availability('') })
    if (rows.length > MAX_ROWS) throw invalid()
  }
  return unique(rows)
}
/** Apple lsof -F0: process sets begin with p; socket sets begin with f; NUL fields, NL set terminators. */
export function parseMacosPorts(output: string): PortSummary[] {
  boundedOutput(output); if (output && !output.includes('\0')) throw invalid()
  const rows: PortSummary[] = []; let pid = 0, name = '', socket: Record<string, string> | undefined
  const flush = () => {
    if (!socket) return
    if (!['IPv4', 'IPv6'].includes(socket.t ?? '') || !['TCP', 'UDP'].includes(socket.P ?? '') || !socket.n || !pid) throw invalid()
    if (socket.n === '*:*') { socket = undefined; return } // Unbound sockets have no occupied local port.
    const protocol = socket.P as 'TCP' | 'UDP', endpoints = socket.n.split('->'); if (endpoints.length > 2) throw invalid()
    const local = endpoint(endpoints[0]!), remote = endpoints[1] ? endpoint(endpoints[1]) : undefined
    if (!local.port) { socket = undefined; return }
    const state = protocol === 'UDP' ? 'BOUND' : socket.T ?? 'UNKNOWN'
    if (!/^[A-Z0-9_]{1,32}$/.test(state)) throw invalid()
    rows.push({ protocol, localAddress: local.address, localPort: local.port, remoteAddress: remote?.address ?? '', remotePort: remote?.port || null, state, pid, processName: name, fieldAvailability: availability(name) })
    if (rows.length > MAX_ROWS) throw invalid()
    socket = undefined
  }
  for (const raw of output.split('\0')) {
    const field = raw.replace(/^\n/, ''); if (!field || field === '\n') continue
    if (/[\u0000-\u001f\u007f]/.test(field)) throw invalid()
    const code = field[0]!, value = field.slice(1)
    switch (code) {
      case 'p': flush(); if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 0x7fffffff) throw invalid(); pid = Number(value); name = ''; break
      case 'c': if (!pid || value.length > 512) throw invalid(); name = value; break
      case 'f': flush(); if (!pid || !/^[0-9]+[a-z]?$/.test(value)) throw invalid(); socket = {}; break
      case 't': case 'P': case 'n': if (!socket || socket[code] !== undefined) throw invalid(); socket[code] = value; break
      case 'T': if (!socket || !value.startsWith('ST=') || socket.T !== undefined) throw invalid(); socket.T = value.slice(3); break
      default: throw invalid()
    }
  }
  flush(); return unique(rows)
}
interface NetstatLayout { numericBeforeProcess: number; processColumn: 'process:pid' | 'pid' }

/** 按表头定位列：不同 macOS 版本 (state) 与进程列之间的数值列数不同（新版 rxbytes txbytes rhiwat shiwat，旧版 rhiwat shiwat）。 */
function netstatLayout(header: string): NetstatLayout {
  const columns = header.replace(/Local Address/g, 'Local_Address').replace(/Foreign Address/g, 'Foreign_Address').trim().split(/\s+/)
  const stateIndex = columns.indexOf('(state)')
  let processIndex = columns.indexOf('process:pid')
  const processColumn: NetstatLayout['processColumn'] = processIndex >= 0 ? 'process:pid' : 'pid'
  if (processIndex < 0) processIndex = columns.indexOf('pid')
  if (columns[0] !== 'Proto' || columns[3] !== 'Local_Address' || columns[4] !== 'Foreign_Address' || stateIndex !== 5 || processIndex <= stateIndex) throw invalid()
  return { numericBeforeProcess: processIndex - stateIndex - 1, processColumn }
}

/** netstat 地址写法 a.b.c.d.port / *.port / v6地址.port（v6 可能被截断显示）；*.* 表示无对端 */
function netstatEndpoint(value: string): { address: string; port: number } | null | undefined {
  if (value === '*.*') return undefined
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const address = value.slice(0, dot), portText = value.slice(dot + 1)
  if (!/^\d{1,5}$/.test(portText) || !/^[0-9A-Za-z:.%*_-]{1,128}$/.test(address)) return null
  const port = Number(portText)
  return port > 65535 ? null : { address, port }
}

function netstatRow(fields: string[], protocol: 'TCP' | 'UDP', layout: NetstatLayout): PortSummary | undefined {
  const local = netstatEndpoint(fields[3] ?? ''), remote = netstatEndpoint(fields[4] ?? '')
  if (!local || local.port === 0 || remote === null) return undefined
  let index = 5, state = 'BOUND'
  if (protocol === 'TCP') {
    state = fields[index++] ?? ''
    if (!/^[A-Z0-9_]{1,32}$/.test(state)) return undefined
  } else if (fields[index] !== undefined && /^[A-Z_][A-Z0-9_]{0,31}$/.test(fields[index]!)) {
    index++ // 个别版本 UDP 也带状态列
  }
  for (let count = 0; count < layout.numericBeforeProcess; count++) {
    if (!/^\d+$/.test(fields[index++] ?? '')) return undefined
  }
  let pid: number, name = ''
  if (layout.processColumn === 'pid') {
    if (!/^\d{1,10}$/.test(fields[index] ?? '')) return undefined
    pid = Number(fields[index])
  } else {
    // 进程名可能含空格（如 "Google Chrome He:2289"），以 名称:pid 后紧跟十六进制 state 列为界
    let end = -1
    for (let cursor = index; cursor < Math.min(fields.length, index + 8); cursor++) {
      if (/:\d{1,10}$/.test(fields[cursor]!) && (cursor === fields.length - 1 || /^[0-9a-fA-F]+$/.test(fields[cursor + 1]!))) { end = cursor; break }
    }
    if (end < 0) return undefined
    const last = fields[end]!, colon = last.lastIndexOf(':')
    pid = Number(last.slice(colon + 1))
    name = [...fields.slice(index, end), last.slice(0, colon)].join(' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512)
  }
  if (!Number.isSafeInteger(pid) || pid < 0 || pid > 0x7fffffff) return undefined
  return { protocol, localAddress: local.address, localPort: local.port, remoteAddress: remote?.address ?? '', remotePort: remote?.port || null, state, pid, processName: name, fieldAvailability: availability(name) }
}

/**
 * macOS netstat -anv（-p tcp / -p udp）：无需 root 即可看到 mDNSResponder、netbiosd 等系统进程的套接字。
 * 表头缺失或不可识别时整体拒绝；单条畸形行跳过，不影响其余结果。
 */
export function parseMacosNetstatPorts(output: string): PortSummary[] {
  boundedOutput(output)
  let layout: NetstatLayout | undefined
  const rows: PortSummary[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^Proto\s/.test(trimmed)) { layout = netstatLayout(trimmed); continue }
    const fields = trimmed.split(/\s+/), kind = /^(tcp|udp)(?:4|6|46)$/.exec(fields[0]!)
    if (!kind) continue
    if (!layout) throw invalid()
    const row = netstatRow(fields, kind[1] === 'tcp' ? 'TCP' : 'UDP', layout)
    if (row) rows.push(row)
    if (rows.length > MAX_ROWS) throw invalid()
  }
  if (!layout && output.trim() && !/^Active Internet connections/.test(output.trim())) throw invalid()
  return unique(rows)
}

export function createPlatformPortDiscoveryAdapter(platform: NodeJS.Platform, run: Execute = execute): PortDiscoveryAdapter {
  if (platform !== 'win32' && platform !== 'darwin') throw new ZToolsError(errorCodes.notSupported, '当前平台未提供端口查询')
  return { async list(signal) {
    if (signal.aborted) throw signal.reason ?? invalid()
    if (platform === 'darwin') {
      const runNetstat = async (protocol: 'tcp' | 'udp') => {
        try {
          const result = await run('/usr/sbin/netstat', ['-anv', '-p', protocol], { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: MAX_BYTES, signal, windowsHide: true })
          if (result.stderr?.trim()) throw invalid()
          return result.stdout
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? invalid()
          throw invalid()
        }
      }
      const [tcp, udp] = await Promise.all([runNetstat('tcp'), runNetstat('udp')])
      if (signal.aborted) throw signal.reason ?? invalid()
      const data = unique([...parseMacosNetstatPorts(tcp), ...parseMacosNetstatPorts(udp)])
      return { data, source: 'darwin-netstat', visibility: 'all-sockets', queriedAt: new Date().toISOString() }
    }
    const file = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe')
    let stdout: string
    try {
      const result = await run(file, ['-ano'], { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: MAX_BYTES, signal, windowsHide: true })
      if (result.stderr?.trim()) throw invalid(); stdout = result.stdout
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? invalid()
      throw invalid()
    }
    if (signal.aborted) throw signal.reason ?? invalid()
    return { data: parseWindowsPorts(stdout), source: 'windows-netstat', visibility: 'visible-processes', queriedAt: new Date().toISOString() }
  } }
}
