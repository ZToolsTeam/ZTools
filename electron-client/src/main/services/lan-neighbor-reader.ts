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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MAC 地址回执无效')
  const result = value as Record<string, unknown>
  if (result.version !== 1 || typeof result.success !== 'boolean') throw new Error('MAC 地址回执无效')
  if (!result.success) {
    if (result.code === 'TOPOLOGY_PERMISSION_REQUIRED') throw new Error('此客户端尚未配置 macOS 网络拓扑权限，请使用已配置该权限的签名客户端；远程唤醒仍可手动输入 MAC')
    throw new Error('系统未能读取设备 MAC 地址，请确认网卡仍已连接后重试')
  }
  if (!Array.isArray(result.entries) || result.entries.length > 65536) throw new Error('MAC 地址列表无效')
  const entries = new Map<string, string>()
  for (const raw of result.entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.ip !== 'string' || !net.isIPv4(raw.ip) || typeof raw.mac !== 'string') throw new Error('MAC 地址条目无效')
    const mac = normalizeLanMac(raw.mac)
    if (mac === '02:00:00:00:00:00' || (entries.has(raw.ip) && entries.get(raw.ip) !== mac)) throw new Error('系统未提供可靠的 MAC 地址')
    entries.set(raw.ip, mac)
  }
  return entries
}

export async function readLanNeighbors(helperPath: string, iface: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!/^[\w.:-]{1,15}$/.test(iface)) throw new Error('网卡名称无效')
  const stat = fs.lstatSync(helperPath, { throwIfNoEntry: false })
  if (!path.isAbsolute(helperPath) || !stat?.isFile() || stat.isSymbolicLink()) throw new Error('网络拓扑组件未构建，请更新客户端')
  const result = await exec(helperPath, [iface], { shell: false, signal, timeout: 3000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
  if (result.stderr.trim()) throw new Error('网络拓扑组件返回异常，请更新客户端后重试')
  return parseLanNeighbors(result.stdout)
}
