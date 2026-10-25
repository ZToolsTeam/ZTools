import {
  FetchWifiProfilesOptions,
  WifiBand,
  WifiParseDetailResult,
  WifiProfileInfo,
  WifiSecurityFilter,
  WifiSecurityType,
  WifiSortBy
} from './types.js'
import { callHostTransport, isRealElectronHost } from '../shared/native-ipc.js'

export const SAMPLE_WIFI_PROFILES: readonly WifiProfileInfo[] = Object.freeze([
  {
    id: 'wifi-office-5g',
    ssid: 'ZTools-Office-5G',
    password: 'ZTools@2026#Secure!',
    authType: 'WPA3-Personal',
    cipher: 'GCMP',
    band: '5 GHz',
    isConnected: true,
    isOpenNetwork: false,
    isEnterprise: false,
    signalPercent: 98,
    interfaceName: 'WLAN',
    lastConnected: '当前已连接',
    pinyin: 'ztools office 5g bangongshi',
    notes: '公司研发中心高速 5G 频段'
  },
  {
    id: 'wifi-home-dual',
    ssid: 'Xiaomi_Home_WiFi6',
    password: 'HomeSweetHome888',
    authType: 'WPA2-Personal',
    cipher: 'CCMP (AES)',
    band: 'Dual-Band (2.4/5 GHz)',
    isConnected: false,
    isOpenNetwork: false,
    isEnterprise: false,
    signalPercent: 86,
    interfaceName: 'WLAN',
    lastConnected: '昨天 22:30',
    pinyin: 'xiaomi home wifi6 jiali',
    notes: '家里客厅小米路由器'
  },
  {
    id: 'wifi-guest',
    ssid: 'ZTools-Guest',
    password: 'Guest123456',
    authType: 'WPA2-Personal',
    cipher: 'CCMP (AES)',
    band: '2.4 GHz',
    isConnected: false,
    isOpenNetwork: false,
    isEnterprise: false,
    signalPercent: 75,
    interfaceName: 'WLAN',
    lastConnected: '3 天前',
    pinyin: 'ztools guest fangke',
    notes: '访客接待专用网络'
  },
  {
    id: 'wifi-cafe-open',
    ssid: 'Starbucks_Free_WiFi',
    password: '',
    authType: 'Open',
    cipher: 'None',
    band: '2.4 GHz',
    isConnected: false,
    isOpenNetwork: true,
    isEnterprise: false,
    signalPercent: 62,
    interfaceName: 'WLAN',
    lastConnected: '1 周前',
    pinyin: 'starbucks free wifi xingbake',
    notes: '开放网络（无密码，网页认证）'
  },
  {
    id: 'wifi-corp-8021x',
    ssid: 'Corp-Dot1X-Internal',
    password: '',
    authType: 'WPA2-Enterprise',
    cipher: 'CCMP (AES)',
    band: '5 GHz',
    isConnected: false,
    isOpenNetwork: false,
    isEnterprise: true,
    signalPercent: 80,
    interfaceName: 'WLAN',
    lastConnected: '2 周前',
    pinyin: 'corp dot1x internal qiye',
    notes: '802.1X 证书企业内网（无预共享明文密钥）'
  }
])

export function parseNetshWlanProfiles(output: string): string[] {
  if (typeof output !== 'string' || !output.trim()) {
    return []
  }

  const userProfiles: string[] = []
  const seen = new Set<string>()
  const lines = output.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    const isEnglishProfile =
      trimmed.startsWith('All User Profile') || trimmed.startsWith('Current User Profile')
    const isChineseProfile =
      trimmed.startsWith('所有用户配置文件') || trimmed.startsWith('当前用户配置文件')

    if (isEnglishProfile || isChineseProfile) {
      const colonIdx = trimmed.indexOf(':')
      const fullWidthColonIdx = trimmed.indexOf('：')
      const idx = colonIdx !== -1 ? colonIdx : fullWidthColonIdx
      if (idx !== -1) {
        const ssid = trimmed.slice(idx + 1).trim()
        if (ssid && !seen.has(ssid)) {
          seen.add(ssid)
          userProfiles.push(ssid)
        }
      }
    }
  }

  return userProfiles
}

export const parseWindowsWlanProfiles = parseNetshWlanProfiles

const OPEN_AUTH_VALUES = new Set(['open', 'none', '开放式', '无'])
const ENTERPRISE_AUTH_PATTERNS = [/enterprise/i, /802\.1x/i, /企业/]

export function normalizeSecurityType(rawAuth: string): WifiSecurityType {
  const val = (rawAuth || '').trim()
  if (!val) return 'Unknown'
  const lower = val.toLowerCase()

  if (OPEN_AUTH_VALUES.has(lower)) return 'Open'
  if (lower.includes('wpa3') && ENTERPRISE_AUTH_PATTERNS.some((p) => p.test(val))) return 'WPA3-Enterprise'
  if (lower.includes('wpa2') && ENTERPRISE_AUTH_PATTERNS.some((p) => p.test(val))) return 'WPA2-Enterprise'
  if (ENTERPRISE_AUTH_PATTERNS.some((p) => p.test(val))) return 'WPA2-Enterprise'
  if (lower.includes('wpa3')) return 'WPA3-Personal'
  if (lower.includes('wpa2') && lower.includes('wpa/')) return 'WPA/WPA2-Personal'
  if (lower.includes('wpa2')) return 'WPA2-Personal'
  if (lower.includes('wep')) return 'WEP'
  return 'WPA2-Personal'
}

export function parseWindowsWlanProfileDetail(ssidInput: string, output: string): WifiParseDetailResult {
  const cleanInputSsid = (ssidInput || '').trim()
  if (typeof output !== 'string' || !output.trim()) {
    return {
      ssid: cleanInputSsid,
      password: '',
      authType: 'Unknown',
      cipher: 'Unknown',
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: 'InvalidInput',
        message: 'Empty netsh output'
      }
    }
  }

  if (
    (output.includes('Profile "') && output.includes('is not found on the system')) ||
    output.includes('系统上没有配置文件') ||
    output.includes('找不到配置文件')
  ) {
    return {
      ssid: cleanInputSsid,
      password: '',
      authType: 'Unknown',
      cipher: 'Unknown',
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: 'ProfileNotFound',
        message: `未在系统中找到 Wi-Fi 配置文件 "${cleanInputSsid}"`
      }
    }
  }

  let ssidName = cleanInputSsid
  let authentication = ''
  let cipher = 'CCMP (AES)'
  let securityKeyState: 'present' | 'absent' | null = null
  let keyContent = ''
  let keyContentFound = false

  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    const colonIdx = trimmed.indexOf(':') !== -1 ? trimmed.indexOf(':') : trimmed.indexOf('：')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const val = trimmed.slice(colonIdx + 1).trim()

    if (key.startsWith('SSID name') || key.startsWith('SSID 名称')) {
      let parsedSsid = val
      if (parsedSsid.startsWith('"') && parsedSsid.endsWith('"')) {
        parsedSsid = parsedSsid.slice(1, -1)
      }
      if (parsedSsid) ssidName = parsedSsid
    } else if (key === 'Authentication' || key === '身份验证') {
      authentication = val
    } else if (key === 'Cipher' || key === '密码' || key === '加密') {
      cipher = val
    } else if (key === 'Security key' || key === 'Security Key' || key === '安全密钥') {
      const lowerVal = val.toLowerCase()
      if (lowerVal === 'present' || val === '存在') {
        securityKeyState = 'present'
      } else if (lowerVal === 'absent' || val === '不存在') {
        securityKeyState = 'absent'
      }
    } else if (key === 'Key Content' || key === '关键内容') {
      keyContent = val
      keyContentFound = true
    }
  }

  const authType = normalizeSecurityType(authentication)
  const isOpenNetwork = authType === 'Open'
  const isEnterprise = authType === 'WPA2-Enterprise' || authType === 'WPA3-Enterprise'

  if (isOpenNetwork) {
    return {
      ssid: ssidName,
      password: '',
      authType,
      cipher: 'None',
      isOpenNetwork: true,
      isEnterprise: false
    }
  }

  if (isEnterprise || securityKeyState === 'absent') {
    return {
      ssid: ssidName,
      password: '',
      authType: isEnterprise ? authType : 'WPA2-Enterprise',
      cipher,
      isOpenNetwork: false,
      isEnterprise: true,
      error: {
        code: 'EnterpriseNetwork',
        message: `"${ssidName}" 使用企业级 802.1X/证书认证，本机不存储预共享明文密码`
      }
    }
  }

  if (securityKeyState === 'present' && !keyContentFound) {
    return {
      ssid: ssidName,
      password: '',
      authType,
      cipher,
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: 'PermissionDenied',
        message: 'Windows 隐藏了关键内容，请以管理员身份运行以读取明文密钥'
      }
    }
  }

  if (securityKeyState === null && !keyContentFound) {
    return {
      ssid: ssidName,
      password: '',
      authType,
      cipher,
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: 'Unknown',
        message: '无法从 netsh 输出中解析出安全密钥信息'
      }
    }
  }

  return {
    ssid: ssidName,
    password: keyContent,
    authType,
    cipher,
    isOpenNetwork: false,
    isEnterprise: false
  }
}

export function parseWifiInterface(output: string): string {
  if (typeof output !== 'string' || !output.trim()) return 'en0'
  const lines = output.split(/\r?\n/)
  let inWifiSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === 'Hardware Port: Wi-Fi' || trimmed === 'Hardware Port: AirPort') {
      inWifiSection = true
      continue
    }
    if (inWifiSection && trimmed.startsWith('Device:')) {
      const dev = trimmed.slice('Device:'.length).trim()
      return dev || 'en0'
    }
    if (inWifiSection && trimmed.startsWith('Hardware Port:')) {
      break
    }
  }
  return 'en0'
}

export function escapeWifiQrField(value: string): string {
  if (typeof value !== 'string') return ''
  return value.replace(/([\\;,:""])/g, '\\$1')
}

export function generateWifiQrString(
  ssid: string,
  password = '',
  authType: WifiSecurityType = 'WPA2-Personal'
): string {
  const cleanSsid = (ssid || '').trim()
  if (!cleanSsid) {
    throw new Error('SSID 不能为空')
  }
  const isOpen = authType === 'Open' || !password
  const qrType = isOpen ? 'nopass' : authType === 'WEP' ? 'WEP' : 'WPA'
  const escapedSsid = escapeWifiQrField(cleanSsid)
  const escapedPwd = isOpen ? '' : escapeWifiQrField(password)
  return `WIFI:T:${qrType};S:${escapedSsid};P:${escapedPwd};;`
}

function computeReedSolomonEcc(data: number[], eccCount: number): number[] {
  const exp = new Uint8Array(512)
  const log = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]!
  const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : exp[log[a]! + log[b]!]!)

  let gen = [1]
  for (let i = 0; i < eccCount; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]!
      next[j + 1] ^= gfMul(gen[j]!, exp[i]!)
    }
    gen = next
  }

  const msg = new Uint8Array(data.length + eccCount)
  msg.set(data, 0)
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i]!
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j]!, coef)
      }
    }
  }
  return Array.from(msg.slice(data.length))
}

function encodeQrMatrixV4L(payload: string): boolean[][] {
  // ISO/IEC 18004 Version 4-L (33x33): 80 data codewords, 20 ECC codewords
  const size = 33
  const dataCapacity = 80
  const eccCount = 20
  const utf8 = Array.from(new TextEncoder().encode(payload)).slice(0, dataCapacity - 3)
  const bits: number[] = []
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  pushBits(0b0100, 4)
  pushBits(utf8.length, 8)
  for (const b of utf8) pushBits(b, 8)
  pushBits(0, Math.min(4, dataCapacity * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const dataBytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0)
    dataBytes.push(byte)
  }
  let padToggle = true
  while (dataBytes.length < dataCapacity) {
    dataBytes.push(padToggle ? 0xec : 0x11)
    padToggle = !padToggle
  }
  const eccBytes = computeReedSolomonEcc(dataBytes, eccCount)
  const allCodewords = [...dataBytes, ...eccBytes]
  const allBits: number[] = []
  for (const b of allCodewords) pushBits.call({ push: (v: number) => allBits.push(v) }, b, 8)
  const totalBits: number[] = []
  for (const b of allCodewords) {
    for (let i = 7; i >= 0; i--) totalBits.push((b >>> i) & 1)
  }

  const modules: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false))
  const isFunc: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false))

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const inWhite = r >= 1 && r <= 5 && c >= 1 && c <= 5
        const inCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4
        modules[rr]![cc] = inOuter && (!inWhite || inCenter)
        isFunc[rr]![cc] = true
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(0, size - 7)
  placeFinder(size - 7, 0)

  // Alignment pattern at (26, 26) for Version 4
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const rr = 26 + r
      const cc = 26 + c
      modules[rr]![cc] = Math.max(Math.abs(r), Math.abs(c)) !== 1
      isFunc[rr]![cc] = true
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    modules[6]![i] = i % 2 === 0
    isFunc[6]![i] = true
    modules[i]![6] = i % 2 === 0
    isFunc[i]![6] = true
  }

  // Reserve format info areas & dark module
  for (let i = 0; i <= 8; i++) {
    isFunc[8]![i] = true
    isFunc[i]![8] = true
    if (i < 8) {
      isFunc[8]![size - 1 - i] = true
      isFunc[size - 1 - i]![8] = true
    }
  }
  modules[size - 8]![8] = true
  isFunc[size - 8]![8] = true

  // Zigzag data placement with mask 0 ((r + c) % 2 === 0)
  let bitIdx = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const c = right - j
        if (!isFunc[r]![c]) {
          const bit = bitIdx < totalBits.length ? totalBits[bitIdx++] === 1 : false
          const mask = (r + c) % 2 === 0
          modules[r]![c] = bit !== mask
        }
      }
    }
    upward = !upward
  }

  // Format bits for Level L (01) + Mask 0 (000) => 0x77c4
  const formatBits = 0x77c4
  for (let i = 0; i <= 5; i++) modules[8]![i] = ((formatBits >>> i) & 1) === 1
  modules[8]![7] = ((formatBits >>> 6) & 1) === 1
  modules[8]![8] = ((formatBits >>> 7) & 1) === 1
  modules[7]![8] = ((formatBits >>> 8) & 1) === 1
  for (let i = 9; i < 15; i++) modules[14 - i]![8] = ((formatBits >>> i) & 1) === 1
  for (let i = 0; i < 8; i++) modules[8]![size - 1 - i] = ((formatBits >>> i) & 1) === 1
  for (let i = 8; i < 15; i++) modules[size - 15 + i]![8] = ((formatBits >>> i) & 1) === 1

  return modules
}

export function generateWifiQrSvgDataUrl(profile: WifiProfileInfo): string {
  const ssidSafe = (profile.ssid || 'Wi-Fi').replace(/[<>&"']/g, '')
  const qrPayload = generateWifiQrString(profile.ssid || 'Wi-Fi', profile.password, profile.authType)
  const matrix = encodeQrMatrixV4L(qrPayload)
  const size = matrix.length
  const cells: string[] = []
  const cellSize = 3.6
  const offsetX = 20
  const offsetY = 16
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c]) {
        cells.push(
          `<rect x="${(offsetX + c * cellSize).toFixed(1)}" y="${(offsetY + r * cellSize).toFixed(1)}" width="${cellSize}" height="${cellSize}" fill="rgb(15, 23, 42)" />`
        )
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="175" viewBox="0 0 160 175">
    <rect width="160" height="175" rx="14" fill="rgb(15, 23, 42)" stroke="rgb(51, 65, 85)" stroke-width="2"/>
    <rect x="14" y="10" width="132" height="132" rx="8" fill="rgb(248, 250, 252)" />
    ${cells.join('')}
    <text x="80" y="158" text-anchor="middle" fill="rgb(226, 232, 240)" font-family="sans-serif" font-size="11" font-weight="bold">${ssidSafe.slice(0, 18)}</text>
  </svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')}`
}

export function filterAndSortWifiProfiles(
  profiles: readonly WifiProfileInfo[],
  options: {
    query?: string
    securityFilter?: WifiSecurityFilter
    sortBy?: WifiSortBy
  } = {}
): WifiProfileInfo[] {
  if (!Array.isArray(profiles)) return []
  const q = (options.query || '').trim().toLowerCase()
  const sec = options.securityFilter || 'all'
  const sortBy = options.sortBy || 'connected'

  const filtered = profiles.filter((item) => {
    if (!item || typeof item.ssid !== 'string') return false
    if (sec === 'connected' && !item.isConnected) return false
    if (sec === 'wpa3' && !item.authType.includes('WPA3')) return false
    if (sec === 'wpa2' && !item.authType.includes('WPA2')) return false
    if (sec === 'open' && !item.isOpenNetwork) return false
    if (sec === 'enterprise' && !item.isEnterprise) return false

    if (!q) return true
    const haystack = `${item.ssid} ${item.authType} ${item.band || ''} ${item.pinyin || ''} ${item.notes || ''}`.toLowerCase()
    return haystack.includes(q)
  })

  return [...filtered].sort((a, b) => {
    if (sortBy === 'connected') {
      if (Boolean(a.isConnected) !== Boolean(b.isConnected)) {
        return a.isConnected ? -1 : 1
      }
      return (b.signalPercent ?? 0) - (a.signalPercent ?? 0)
    }
    if (sortBy === 'signal') {
      return (b.signalPercent ?? 0) - (a.signalPercent ?? 0)
    }
    if (sortBy === 'ssid') {
      return a.ssid.localeCompare(b.ssid, 'zh-CN')
    }
    return a.authType.localeCompare(b.authType)
  })
}

export async function revealWifiPasswordFromHost(ssid: string, hostOverride?: unknown): Promise<string> {
  const cleanSsid = (ssid || '').trim()
  if (!cleanSsid) return ''
  let res = await callHostTransport<Record<string, unknown> | string>(
    'wifi_get_password',
    { ssid: cleanSsid },
    hostOverride
  )
  if (!res.ok && (String(res.error || '').startsWith('METHOD_NOT_AVAILABLE:') || res.error === 'NO_WINDOW_ENV')) {
    res = await callHostTransport<Record<string, unknown> | string>(
      'dllplugin_call',
      {
        plugin: 'WifiPasswordPlugin',
        func: 'getPassword',
        params: { ssid: cleanSsid }
      },
      hostOverride
    )
  }
  if (res.ok && res.data !== undefined) {
    if (typeof res.data === 'string') return res.data.trim()
    const dataObj = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>
    if (typeof dataObj.password === 'string') return dataObj.password.trim()
  }
  return ''
}

export async function fetchSavedWifiProfiles(
  options: FetchWifiProfilesOptions = {}
): Promise<WifiProfileInfo[]> {
  const realHost = isRealElectronHost(options.hostOverride)
  const fallback = options.fallbackToSample ?? (!realHost && !options.hostOverride)
  const executor = options.executor

  if (!executor) {
    if (options.hostOverride || realHost) {
      try {
        let res = await callHostTransport<Record<string, unknown> | unknown[]>(
          'wifi_get_profiles',
          { interfaceName: options.interfaceName },
          options.hostOverride
        )
        if (!res.ok && (String(res.error || '').startsWith('METHOD_NOT_AVAILABLE:') || res.error === 'NO_WINDOW_ENV')) {
          res = await callHostTransport<Record<string, unknown> | unknown[]>(
            'dllplugin_call',
            {
              plugin: 'WifiPasswordPlugin',
              func: 'listSavedNetworks',
              params: { interfaceName: options.interfaceName }
            },
            options.hostOverride
          )
        }
        if (res.ok && res.data) {
          const dataObj = (
            !Array.isArray(res.data) && typeof res.data === 'object' ? res.data : {}
          ) as Record<string, unknown>
          const rawList = Array.isArray(res.data)
            ? res.data
            : Array.isArray(dataObj.profiles)
              ? dataObj.profiles
              : []
          if (rawList.length > 0) {
            const mapped = await Promise.all(
              rawList.map(async (rawItem: unknown, idx: number): Promise<WifiProfileInfo | null> => {
                const shouldPrefetchPwd = idx < 5
                if (typeof rawItem === 'string') {
                  const ssid = rawItem.trim()
                  if (!ssid) return null
                  const pwd = shouldPrefetchPwd
                    ? await revealWifiPasswordFromHost(ssid, options.hostOverride)
                    : ''
                  return {
                    id: `host-wifi-${ssid}`,
                    ssid,
                    password: pwd,
                    authType: 'WPA2-Personal',
                    isOpenNetwork: false,
                    isEnterprise: false,
                    signalPercent: 88
                  }
                }
                if (rawItem && typeof rawItem === 'object') {
                  const rec = rawItem as Record<string, unknown>
                  const ssid = String(rec.ssid ?? rec.name ?? '').trim()
                  if (!ssid) return null
                  const pwd =
                    typeof rec.password === 'string' && rec.password
                      ? rec.password
                      : shouldPrefetchPwd
                        ? await revealWifiPasswordFromHost(ssid, options.hostOverride)
                        : ''
                  const authType = rec.authType
                    ? normalizeSecurityType(String(rec.authType))
                    : 'WPA2-Personal'
                  return {
                    id: String(rec.id ?? `host-wifi-${ssid}`),
                    ssid,
                    password: pwd,
                    authType,
                    cipher: String(rec.cipher ?? 'CCMP (AES)'),
                    band: (rec.band as WifiBand) || 'Dual-Band (2.4/5 GHz)',
                    isConnected: Boolean(rec.isConnected),
                    isOpenNetwork: Boolean(rec.isOpenNetwork ?? authType === 'Open'),
                    isEnterprise: Boolean(rec.isEnterprise ?? authType.includes('Enterprise')),
                    signalPercent: typeof rec.signalPercent === 'number' ? rec.signalPercent : 88,
                    interfaceName: String(rec.interfaceName ?? options.interfaceName ?? 'WLAN'),
                    lastConnected: String(rec.lastConnected ?? '已保存'),
                    pinyin: typeof rec.pinyin === 'string' ? rec.pinyin : undefined,
                    notes: typeof rec.notes === 'string' ? rec.notes : undefined
                  }
                }
                return null
              })
            )
            const valid = mapped.filter((x): x is WifiProfileInfo => x !== null)
            return valid
          }
          return []
        }
      } catch {
        // ignore
      }
      if (realHost || options.hostOverride) {
        return []
      }
    }
    return fallback ? [...SAMPLE_WIFI_PROFILES] : []
  }

  const platform = options.platform || 'win32'
  try {
    if (platform === 'win32') {
      const rawList = await executor('netsh', ['wlan', 'show', 'profiles'])
      const stdout = typeof rawList === 'string' ? rawList : rawList.stdout
      const ssids = parseNetshWlanProfiles(stdout)
      if (ssids.length === 0) {
        return fallback ? [...SAMPLE_WIFI_PROFILES] : []
      }

      const results: WifiProfileInfo[] = []
      for (const ssid of ssids) {
        try {
          const detailRaw = await executor('netsh', [
            'wlan',
            'show',
            'profile',
            `name=${ssid}`,
            'key=clear'
          ])
          const detailOut = typeof detailRaw === 'string' ? detailRaw : detailRaw.stdout
          const parsed = parseWindowsWlanProfileDetail(ssid, detailOut)
          results.push({
            id: `win-wifi-${ssid}`,
            ssid: parsed.ssid || ssid,
            password: parsed.password,
            authType: parsed.authType,
            cipher: parsed.cipher,
            band: 'Dual-Band (2.4/5 GHz)',
            isOpenNetwork: parsed.isOpenNetwork,
            isEnterprise: parsed.isEnterprise,
            signalPercent: 85,
            notes: parsed.error?.message
          })
        } catch {
          // ignore
        }
      }
      return results.length > 0 ? results : fallback ? [...SAMPLE_WIFI_PROFILES] : []
    }

    if (platform === 'darwin') {
      const portsRaw = await executor('/usr/sbin/networksetup', ['-listallhardwareports'])
      const iface = parseWifiInterface(typeof portsRaw === 'string' ? portsRaw : portsRaw.stdout)
      const listRaw = await executor('/usr/sbin/networksetup', ['-listpreferredwirelessnetworks', iface])
      const listOut = typeof listRaw === 'string' ? listRaw : listRaw.stdout
      const ssids = listOut
        .split(/\r?\n/)
        .slice(1)
        .map((s) => s.trim())
        .filter(Boolean)

      const results: WifiProfileInfo[] = []
      for (const ssid of ssids) {
        let password = ''
        try {
          const pwRaw = await executor('/usr/bin/security', [
            'find-generic-password',
            '-D',
            'AirPort network password',
            '-a',
            ssid,
            '-w'
          ])
          password = (typeof pwRaw === 'string' ? pwRaw : pwRaw.stdout).trim()
        } catch {
          password = ''
        }
        results.push({
          id: `mac-wifi-${ssid}`,
          ssid,
          password,
          authType: password ? 'WPA2-Personal' : 'Open',
          isOpenNetwork: !password,
          isEnterprise: false,
          interfaceName: iface,
          signalPercent: 90
        })
      }
      return results.length > 0 ? results : fallback ? [...SAMPLE_WIFI_PROFILES] : []
    }
  } catch {
    if (fallback) {
      return [...SAMPLE_WIFI_PROFILES]
    }
    throw new Error('WIFI_COMMAND_EXECUTION_FAILED')
  }

  return fallback ? [...SAMPLE_WIFI_PROFILES] : []
}
