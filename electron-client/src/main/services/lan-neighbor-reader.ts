import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeLanMac } from '../../contracts/lan-network.js'

const exec = promisify(execFile)
export function macNetworkHelperPath(isPackaged: boolean, resourcesPath: string) {
  const bundle = isPackaged ? path.join(resourcesPath, '../Helpers/ZToolsMacNetwork.app') : path.resolve(__dirname, '../../mac-network-native/ZToolsMacNetwork.app')
  return path.join(bundle, 'Contents/MacOS/ZToolsMacNetwork')
}

export function parseLanNeighbors(output: string): Map<string, string> {
  const value: unknown = JSON.parse(output)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MAC address receipt')
  const result = value as Record<string, unknown>
  if (result.version !== 1 || typeof result.success !== 'boolean') throw new Error('Invalid MAC address receipt')
  if (!result.success) {
    if (result.code === 'TOPOLOGY_PERMISSION_REQUIRED') throw new Error('This client lacks macOS network topology permission; use a signed build with this entitlement, or enter the MAC address manually for Wake-on-LAN')
    throw new Error('System failed to read device MAC addresses; verify the network interface is connected and retry')
  }
  if (!Array.isArray(result.entries) || result.entries.length > 65536) throw new Error('Invalid MAC address list')
  const entries = new Map<string, string>()
  for (const raw of result.entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.ip !== 'string' || !net.isIPv4(raw.ip) || typeof raw.mac !== 'string') throw new Error('Invalid MAC address entry')
    const mac = normalizeLanMac(raw.mac)
    if (mac === '02:00:00:00:00:00' || (entries.has(raw.ip) && entries.get(raw.ip) !== mac)) throw new Error('System did not provide reliable MAC addresses')
    entries.set(raw.ip, mac)
  }
  return entries
}

export async function readLanNeighbors(helperPath: string, iface: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!/^[\w.:-]{1,15}$/.test(iface)) throw new Error('Invalid network interface name')
  const stat = fs.lstatSync(helperPath, { throwIfNoEntry: false })
  if (!path.isAbsolute(helperPath) || !stat?.isFile() || stat.isSymbolicLink()) throw new Error('Network topology helper is not built; update the client')
  const result = await exec(helperPath, [iface], { shell: false, signal, timeout: 3000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
  if (result.stderr.trim()) throw new Error('Network topology helper returned an error; update the client and retry')
  return parseLanNeighbors(result.stdout)
}
