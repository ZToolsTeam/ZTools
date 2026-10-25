import type {
  ChmodCalculationResult,
  ChmodRoleBreakdown,
  CidrCalculationResult,
} from './types.js'

function ipToUint32(ip: string): number {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) {
    throw new Error(`INVALID_IPV4_FORMAT: IPv4 地址必须包含 4 个八位组 (${ip})`)
  }
  let val = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`INVALID_IPV4_OCTET: 非法八位组 "${part}"`)
    }
    const num = Number(part)
    if (num < 0 || num > 255) {
      throw new Error(`IPV4_OCTET_OUT_OF_RANGE: 八位组超出 0~255 范围 (${part})`)
    }
    val = ((val << 8) | num) >>> 0
  }
  return val >>> 0
}

function uint32ToIp(num: number): string {
  const u = num >>> 0
  return [
    (u >>> 24) & 255,
    (u >>> 16) & 255,
    (u >>> 8) & 255,
    u & 255,
  ].join('.')
}

function uint32ToBinaryDotted(num: number): string {
  const u = num >>> 0
  return [
    ((u >>> 24) & 255).toString(2).padStart(8, '0'),
    ((u >>> 16) & 255).toString(2).padStart(8, '0'),
    ((u >>> 8) & 255).toString(2).padStart(8, '0'),
    (u & 255).toString(2).padStart(8, '0'),
  ].join('.')
}

function classifyIpScope(ipUint: number): string {
  const first = (ipUint >>> 24) & 255
  const second = (ipUint >>> 16) & 255
  if (first === 10) return 'RFC 1918 A类私有内网 (10.0.0.0/8)'
  if (first === 172 && second >= 16 && second <= 31) {
    return 'RFC 1918 B类私有内网 (172.16.0.0/12)'
  }
  if (first === 192 && second === 168) {
    return 'RFC 1918 C类私有内网 (192.168.0.0/16)'
  }
  if (first === 127) return 'Loopback 本地回环地址 (127.0.0.0/8)'
  if (first === 100 && second >= 64 && second <= 127) {
    return 'RFC 6598 运营商级 CGNAT 地址段 (100.64.0.0/10)'
  }
  if (first === 169 && second === 254) {
    return 'APIPA 链路本地地址 (169.254.0.0/16)'
  }
  return '公网可路由单播地址 (Public Unicast)'
}

export function calculateIpv4Cidr(rawInput: string): CidrCalculationResult {
  const trimmed = String(rawInput || '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_CIDR_INPUT: 请输入 IPv4 CIDR（如 192.168.1.0/24）')
  }

  const parts = trimmed.split('/')
  const ipStr = parts[0].trim()
  const prefixStr = parts.length > 1 ? parts[1].trim() : '24'

  if (!/^\d{1,2}$/.test(prefixStr)) {
    throw new Error(`INVALID_CIDR_PREFIX: 掩码前缀长度必须是 0~32 的整数 (/${prefixStr})`)
  }
  const prefixLength = Number(prefixStr)
  if (prefixLength < 0 || prefixLength > 32) {
    throw new Error(`CIDR_PREFIX_OUT_OF_RANGE: 掩码前缀必须在 /0 ~ /32 之间 (当前 /${prefixLength})`)
  }

  const ipUint = ipToUint32(ipStr)
  const maskUint =
    prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  const wildcardUint = (~maskUint) >>> 0
  const networkUint = (ipUint & maskUint) >>> 0
  const broadcastUint = (networkUint | wildcardUint) >>> 0

  const totalHosts = Math.pow(2, 32 - prefixLength)
  let usableHosts: number
  let firstUsableUint: number
  let lastUsableUint: number
  let usageHint: string

  if (prefixLength === 32) {
    usableHosts = 1
    firstUsableUint = networkUint
    lastUsableUint = networkUint
    usageHint = '/32 单机主机路由 (Host Route)，仅包含唯一指定 IP'
  } else if (prefixLength === 31) {
    usableHosts = 2
    firstUsableUint = networkUint
    lastUsableUint = broadcastUint
    usageHint = '/31 点对点链路 (RFC 3021 Point-to-Point)，无独立广播地址浪费'
  } else {
    usableHosts = Math.max(0, totalHosts - 2)
    firstUsableUint = (networkUint + 1) >>> 0
    lastUsableUint = (broadcastUint - 1) >>> 0
    usageHint = `标准子网，已扣除网络地址 (${uint32ToIp(networkUint)}) 与广播地址 (${uint32ToIp(
      broadcastUint,
    )})`
  }

  return {
    input: `${ipStr}/${prefixLength}`,
    ipAddress: uint32ToIp(ipUint),
    prefixLength,
    netmask: uint32ToIp(maskUint),
    wildcardMask: uint32ToIp(wildcardUint),
    networkAddress: uint32ToIp(networkUint),
    broadcastAddress: uint32ToIp(broadcastUint),
    firstUsableIp: uint32ToIp(firstUsableUint),
    lastUsableIp: uint32ToIp(lastUsableUint),
    totalHosts,
    usableHosts,
    netmaskBinary: uint32ToBinaryDotted(maskUint),
    addressScope: classifyIpScope(ipUint),
    usageHint,
  }
}

function digitToSymbolic(d: number): string {
  return `${(d & 4) !== 0 ? 'r' : '-'}${(d & 2) !== 0 ? 'w' : '-'}${(d & 1) !== 0 ? 'x' : '-'}`
}

function symbolicTriadToDigit(triad: string): number {
  if (triad.length !== 3 || !/^[r-][w-][x-]$/.test(triad)) {
    throw new Error(`INVALID_CHMOD_TRIAD: 权限符号组不合法 (${triad})`)
  }
  return (
    (triad[0] === 'r' ? 4 : 0) +
    (triad[1] === 'w' ? 2 : 0) +
    (triad[2] === 'x' ? 1 : 0)
  )
}

export function convertChmod(rawInput: string): ChmodCalculationResult {
  const cleaned = String(rawInput || '')
    .trim()
    .replace(/^chmod\s+(-R\s+)?/i, '')
    .trim()

  if (!cleaned) {
    throw new Error('EMPTY_CHMOD_INPUT: 请输入八进制权限（如 755）或符号权限（如 rwxr-xr-x）')
  }

  let digits: [number, number, number]

  if (/^0?[0-7]{3}$/.test(cleaned)) {
    const three = cleaned.slice(-3)
    digits = [Number(three[0]), Number(three[1]), Number(three[2])]
  } else {
    const sym = cleaned.length === 10 && /^[dlcbps-]/.test(cleaned) ? cleaned.slice(1) : cleaned
    if (sym.length !== 9) {
      throw new Error(
        `INVALID_CHMOD_INPUT: 无法识别权限表达式 "${cleaned}"，支持 3 位八进制 (000~777) 或 9 位符号 (rwxr-xr-x)`,
      )
    }
    digits = [
      symbolicTriadToDigit(sym.slice(0, 3)),
      symbolicTriadToDigit(sym.slice(3, 6)),
      symbolicTriadToDigit(sym.slice(6, 9)),
    ]
  }

  const roleNames: Array<'Owner (u)' | 'Group (g)' | 'Others (o)'> = [
    'Owner (u)',
    'Group (g)',
    'Others (o)',
  ]

  const roles: ChmodRoleBreakdown[] = digits.map((digit, idx) => ({
    role: roleNames[idx],
    digit,
    symbolic: digitToSymbolic(digit),
    read: (digit & 4) !== 0,
    write: (digit & 2) !== 0,
    execute: (digit & 1) !== 0,
  }))

  const octal = digits.join('')
  const symbolic = roles.map((r) => r.symbolic).join('')
  const isWorldWritable = (digits[2] & 2) !== 0

  return {
    octal,
    symbolic,
    lsSymbolic: `-${symbolic}`,
    chmodCommand: `chmod ${octal} <file>`,
    chmodRecursiveCommand: `chmod -R ${octal} <directory>`,
    isWorldWritable,
    securityWarning: isWorldWritable
      ? `高危权限告警 (${octal}): Others 组拥有写入权限 (w)，任何系统用户均可篡改或替换目标文件，生产环境推荐使用 755 或 644`
      : undefined,
    roles,
  }
}
