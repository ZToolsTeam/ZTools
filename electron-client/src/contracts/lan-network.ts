export const LAN_PORTS = [22, 80, 443, 445, 3389, 5900, 8080, 8443] as const
export interface LanInterface {
  id: string; name: string; ip: string; netmask: string; subnet: string; broadcast: string | null; prefix: number
}
export interface LanHost {
  ip: string; mac: string | null; openPorts: number[]; response: 'ICMP' | 'TCP' | '本机'; latencyMs: number | null
}
export type LanRequest = { action: 'interfaces' } | { action: 'cancel'; operationId: string } |
  { action: 'scan'; operationId: string; interfaceId: string; scanAddress: string } |
  { action: 'wake'; operationId: string; interfaceId: string; mac: string }
export function ipv4Number(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) || value.split('.').some(v => Number(v) > 255)) throw new Error('请输入有效的 IPv4 地址')
  return value.split('.').reduce((n, part) => n * 256 + Number(part), 0)
}
export function ipv4Text(value: number) { return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.') }
export function subnetBounds(ip: string, netmask: string) {
  const address = ipv4Number(ip), mask = ipv4Number(netmask), inverse = (~mask) >>> 0
  if ((inverse & (inverse + 1)) !== 0) throw new Error('网络掩码不连续')
  const prefix = 32 - Math.log2(inverse + 1), first = (address & mask) >>> 0
  return { first, last: first + inverse, prefix }
}
export function lanScanRange(iface: LanInterface, address: string) {
  const ip = ipv4Number(address), bounds = subnetBounds(iface.ip, iface.netmask)
  if (ip < bounds.first || ip > bounds.last) throw new Error('扫描地址必须位于所选网卡的当前网段内')
  const prefix = Math.max(24, bounds.prefix), first = Math.max(bounds.first, Math.floor(ip / 256) * 256)
  const last = Math.min(bounds.last, first + 255), hosts: string[] = []
  for (let n = first; n <= last; n++) {
    if (bounds.prefix < 31 && (n === bounds.first || n === bounds.last)) continue
    hosts.push(ipv4Text(n))
  }
  return { cidr: `${ipv4Text(first)}/${prefix}`, hosts }
}
export function normalizeLanMac(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[\da-f]{12}|[\da-f]{2}(?::[\da-f]{2}){5}|[\da-f]{2}(?:-[\da-f]{2}){5})$/i.test(value)) throw new Error('MAC 地址须为 6 组十六进制字符')
  const hex = value.replace(/[:-]/g, '').toUpperCase()
  if (/^0+$/.test(hex) || (parseInt(hex.slice(0, 2), 16) & 1)) throw new Error('请输入有效的单播设备 MAC 地址')
  return hex.match(/../g)!.join(':')
}
export function validateLanRequest(value: unknown): asserts value is LanRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('局域网请求无效')
  const r = value as Record<string, unknown>
  const fields: Record<string, string[]> = { interfaces: [], cancel: ['operationId'], scan: ['operationId', 'interfaceId', 'scanAddress'], wake: ['operationId', 'interfaceId', 'mac'] }
  if (typeof r.action !== 'string' || !Object.hasOwn(fields, r.action)) throw new Error('局域网操作无效')
  const keys = fields[r.action]!
  if (Object.keys(r).some(k => k !== 'action' && !keys.includes(k)) || keys.some(k => typeof r[k] !== 'string')) throw new Error('局域网请求字段无效')
  if (keys.includes('operationId') && !/^[\w-]{1,100}$/.test(r.operationId as string)) throw new Error('操作编号无效')
  if (keys.includes('interfaceId') && !/^[^|\u0000-\u001f\u007f]{1,64}\|[\d.]+\|[\d.]+$/.test(r.interfaceId as string)) throw new Error('网卡编号无效')
  if (r.action === 'scan') ipv4Number(r.scanAddress)
  if (r.action === 'wake') normalizeLanMac(r.mac)
}
