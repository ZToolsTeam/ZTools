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
export interface PortSnapshot { data: PortSummary[]; source: 'darwin-lsof' | 'windows-netstat'; visibility: 'visible-processes'; queriedAt: string }
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
export function createPlatformPortDiscoveryAdapter(platform: NodeJS.Platform, run: Execute = execute): PortDiscoveryAdapter {
  if (platform !== 'win32' && platform !== 'darwin') throw new ZToolsError(errorCodes.notSupported, '当前平台未提供端口查询')
  return { async list(signal) {
    if (signal.aborted) throw signal.reason ?? invalid()
    const file = platform === 'darwin' ? '/usr/sbin/lsof' : path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe')
    const args = platform === 'darwin' ? ['-nP', '-iTCP', '-iUDP', '-F0pcfnPtT', '-Ts'] : ['-ano']
    let stdout: string
    try {
      const result = await run(file, args, { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: MAX_BYTES, signal, windowsHide: true })
      if (result.stderr?.trim()) throw invalid(); stdout = result.stdout
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? invalid()
      const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean }
      // lsof exit1 with no selection and no diagnostics is its explicit empty result.
      if (platform === 'darwin' && result.code === 1 && result.stdout === '' && !result.stderr?.trim() && !result.killed) stdout = ''
      else throw invalid()
    }
    if (signal.aborted) throw signal.reason ?? invalid()
    return { data: platform === 'darwin' ? parseMacosPorts(stdout) : parseWindowsPorts(stdout), source: platform === 'darwin' ? 'darwin-lsof' : 'windows-netstat', visibility: 'visible-processes', queriedAt: new Date().toISOString() }
  } }
}
