import { callHostTransport } from '../shared/native-ipc.js'
import type { LanDevice, NetworkInterfaceInfo } from './types.js'

const OUI_VENDOR_MAP: Record<string, string> = {
  '00:11:32': '群晖 (Synology)',
  '90:09:D0': '群晖 (Synology)',
  'F0:18:98': '苹果 (Apple)',
  'BC:D0:74': '苹果 (Apple)',
  '3C:22:FB': '苹果 (Apple)',
  '00:E0:4C': '瑞昱 (Realtek)',
  'B8:27:EB': '树莓派 (Raspberry Pi)',
  'DC:A6:32': '树莓派 (Raspberry Pi)',
  '00:E0:FC': '华为 (Huawei)',
  '48:8E:EF': '华为 (Huawei)',
  '28:6C:07': '小米 (Xiaomi)',
  '64:09:80': '小米 (Xiaomi)',
  'A4:BB:6D': '戴尔 (Dell)',
  '3C:52:82': '惠普 (HP)',
  '00:1B:21': '英特尔 (Intel)'
}

export function normalizeMacAddress(rawMac: string): string {
  const clean = String(rawMac ?? '')
    .trim()
    .toUpperCase()
    .replace(/[:-]/g, '')
  if (!/^[0-9A-F]{12}$/.test(clean)) {
    throw new Error('INVALID_MAC_ADDRESS: MAC 地址格式不合法，必须为 12 位十六进制字符')
  }
  return clean.match(/.{2}/g)!.join(':')
}

export function lookupOuiVendor(mac?: string): string {
  if (!mac) return '未知厂商'
  try {
    const norm = normalizeMacAddress(mac)
    const prefix = norm.slice(0, 8)
    return OUI_VENDOR_MAP[prefix] || '通用网络设备'
  } catch {
    return '未知厂商'
  }
}

/**
 * 构造符合 IEEE 802.3 规范的 102 字节 Wake-on-LAN 魔术包（6 字节 0xFF + 16 组 6 字节 MAC）
 */
export function buildWolMagicPacketBytes(mac: string): Uint8Array {
  const norm = normalizeMacAddress(mac)
  const macOctets = norm.split(':').map((h) => parseInt(h, 16))
  const packet = new Uint8Array(102)
  packet.fill(0xff, 0, 6)
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = macOctets[j]!
    }
  }
  return packet
}

export function parseArpTableOutput(arpOutput: string): LanDevice[] {
  const lines = String(arpOutput ?? '').replace(/\r\n/g, '\n').split('\n')
  const devices: LanDevice[] = []
  const seenIps = new Set<string>()

  for (const line of lines) {
    const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/i)
    if (!m?.[1] || !m[2]) continue
    const ip = m[1]
    if (ip.endsWith('.255') || ip.startsWith('224.') || ip.startsWith('239.') || seenIps.has(ip)) {
      continue
    }
    try {
      const mac = normalizeMacAddress(m[2])
      if (mac === 'FF:FF:FF:FF:FF:FF') continue
      seenIps.add(ip)
      const vendor = lookupOuiVendor(mac)
      devices.push({
        ip,
        mac,
        vendor,
        pingMs: 2,
        openPorts: [],
        openPortsText: 'ARP 在线',
        hasRdp: false,
        isFavorite: false
      })
    } catch {
      // skip malformed MAC
    }
  }

  return devices
}

export async function detectActiveInterfaces(
  options?: { simulateOffline?: boolean },
  hostOverride?: unknown
): Promise<NetworkInterfaceInfo[]> {
  const res = await callHostTransport<{ interfaces?: NetworkInterfaceInfo[] }>(
    'dllplugin_call',
    {
      plugin: 'LanScannerPlugin',
      func: 'detectActiveInterfaces',
      params: options || {}
    },
    hostOverride
  )
  return res.data?.interfaces ?? []
}

export async function scanSubnet(
  iface?: NetworkInterfaceInfo,
  options?: { simulateOffline?: boolean },
  hostOverride?: unknown
): Promise<LanDevice[]> {
  const res = await callHostTransport<{ arpRaw?: string; errorCode?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'LanScannerPlugin',
      func: 'scanSubnet',
      params: { iface, ...options }
    },
    hostOverride
  )
  if (!res.ok) {
    throw new Error(res.error || res.data?.error || 'NETWORK_OFFLINE: 未连接局域网')
  }
  return parseArpTableOutput(res.data?.arpRaw || '')
}

export async function sendWakeOnLan(
  mac: string,
  broadcastIp = '255.255.255.255',
  options?: { dryRun?: boolean },
  hostOverride?: unknown
): Promise<{ success: boolean; byteLength: number; packetHex: string }> {
  // Validate locally first to fail fast on malformed MAC
  const packet = buildWolMagicPacketBytes(mac)
  const res = await callHostTransport<{ byteLength?: number; packetHex?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'LanScannerPlugin',
      func: 'sendWakeOnLan',
      params: { mac, broadcastIp, ...options }
    },
    hostOverride
  )
  if (!res.ok) {
    throw new Error(res.error || res.data?.error || '发送 WOL 魔术包失败')
  }
  return {
    success: true,
    byteLength: res.data?.byteLength ?? packet.byteLength,
    packetHex:
      res.data?.packetHex ??
      Array.from(packet)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
  }
}
