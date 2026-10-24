/**
 * 局域网免密快传与二维码投送中枢 (LanShare 2.0 Logic)
 * 真实扫描本机局域网 IPv4 地址与 Downloads / Desktop 文件，
 * 通过宿主内网 HTTP 文件服务器与标准 ISO/IEC 18004 QR Code 编码器生成真实可扫二维码
 */

import {
  callHostTransport,
  invokePluginService,
  isRealElectronHost,
  getRealEnvPaths,
  scanRealDirectoryTree,
  readRealClipboardText,
  showRealItemInFolder,
  formatBytes,
  invokeDllPluginCapability
} from '../shared/native-ipc.js'

export { formatBytes }

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export type LanShareCategory = 'portal' | 'clipboard' | 'files'
export type LanShareFilterMode = 'all' | 'clipboard' | 'files'

export interface LanShareItem {
  id: string
  title: string
  subtitle: string
  category: LanShareCategory
  categoryLabel: string
  filePath: string
  sizeBytes: number
  shareUrl: string
  qrCodeDataUri: string
  isShared: boolean
  downloadCount: number
  textPreview?: string
}

export interface LanShareSnapshot {
  items: LanShareItem[]
  lanIp: string
  port: number
  portalUrl: string
  serverRunning?: boolean
  sharedCount: number
  totalSharedBytes: number
}

export const DLL_PLUGIN_NAME = 'LanSharePlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('^(?:C:\\\\Windows\\\\System32\\\\config\\\\SAM|\\.ssh\\\\id_rsa)$', 'i')
export const FORBIDDEN_REASON = '严禁将系统 SAM 密码库或私钥文件暴露至局域网 HTTP 共享服务'

// ============================================================================
// 标准 ISO/IEC 18004 QR Code 矩阵编码器 (Version 1~6, Level L, Byte Mode)
// ============================================================================

interface QrVersionSpec {
  version: number
  size: number
  dataCodewords: number
  ecCodewordsPerBlock: number
  numBlocks: number
  alignmentCenters: number[]
}

const QR_VERSION_SPECS_L: QrVersionSpec[] = [
  { version: 1, size: 21, dataCodewords: 19, ecCodewordsPerBlock: 7, numBlocks: 1, alignmentCenters: [] },
  { version: 2, size: 25, dataCodewords: 34, ecCodewordsPerBlock: 10, numBlocks: 1, alignmentCenters: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecCodewordsPerBlock: 15, numBlocks: 1, alignmentCenters: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecCodewordsPerBlock: 20, numBlocks: 1, alignmentCenters: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecCodewordsPerBlock: 26, numBlocks: 1, alignmentCenters: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, ecCodewordsPerBlock: 18, numBlocks: 2, alignmentCenters: [6, 34] }
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) {
      x ^= 0x11d
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]
  }
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function buildRsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function computeRsRemainder(data: Uint8Array, ecDegree: number): Uint8Array {
  const gen = buildRsGeneratorPoly(ecDegree)
  const rem = new Uint8Array(ecDegree)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0]
    rem.copyWithin(0, 1)
    rem[ecDegree - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < ecDegree; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor)
      }
    }
  }
  return rem
}

function computeBchFormatBits(ecLevelBits: number, maskPattern: number): number {
  const data = ((ecLevelBits & 0x3) << 3) | (maskPattern & 0x7)
  let rem = data << 10
  const generator = 0b10100110111
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= generator << (i - 10)
    }
  }
  return (((data << 10) | rem) ^ 0b101010000010010) & 0x7fff
}

/**
 * 标准 ISO/IEC 18004 QR Code 矩阵生成函数（Byte 模式 + GF(256) Reed-Solomon 纠错码）
 */
export function encodeQrCodeMatrix(text: string): boolean[][] {
  const normalized = String(text || 'http://127.0.0.1:18580')
  const rawBytes = new TextEncoder().encode(normalized)
  // 若超过 Version 6 容量（134 字节），截断至 134 字节以确保编码合法
  const payloadBytes = rawBytes.length > 134 ? rawBytes.slice(0, 134) : rawBytes

  const spec =
    QR_VERSION_SPECS_L.find((s) => payloadBytes.length + 2 <= s.dataCodewords) ||
    QR_VERSION_SPECS_L[QR_VERSION_SPECS_L.length - 1]

  const bitBuffer: number[] = []
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bitBuffer.push((val >>> i) & 1)
    }
  }

  // Mode indicator: Byte mode = 0100
  pushBits(0b0100, 4)
  // Character count indicator (Version 1~9 Byte mode = 8 bits)
  pushBits(payloadBytes.length, 8)
  for (const b of payloadBytes) {
    pushBits(b, 8)
  }

  const maxDataBits = spec.dataCodewords * 8
  const terminatorLen = Math.min(4, maxDataBits - bitBuffer.length)
  pushBits(0, terminatorLen)

  while (bitBuffer.length % 8 !== 0) {
    bitBuffer.push(0)
  }

  const dataWords = new Uint8Array(spec.dataCodewords)
  const byteLen = bitBuffer.length / 8
  for (let i = 0; i < byteLen; i++) {
    let b = 0
    for (let bit = 0; bit < 8; bit++) {
      b = (b << 1) | bitBuffer[i * 8 + bit]
    }
    dataWords[i] = b
  }

  const padBytes = [0xec, 0x11]
  for (let i = byteLen; i < spec.dataCodewords; i++) {
    dataWords[i] = padBytes[(i - byteLen) % 2]
  }

  // 分块计算 Reed-Solomon 纠错码并交织
  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  const blockDataSize = Math.floor(spec.dataCodewords / spec.numBlocks)
  for (let b = 0; b < spec.numBlocks; b++) {
    const slice = dataWords.slice(b * blockDataSize, (b + 1) * blockDataSize)
    dataBlocks.push(slice)
    ecBlocks.push(computeRsRemainder(slice, spec.ecCodewordsPerBlock))
  }

  const finalCodewords: number[] = []
  for (let i = 0; i < blockDataSize; i++) {
    for (let b = 0; b < spec.numBlocks; b++) {
      finalCodewords.push(dataBlocks[b][i])
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (let b = 0; b < spec.numBlocks; b++) {
      finalCodewords.push(ecBlocks[b][i])
    }
  }

  const size = spec.size
  const modules: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false))

  const setFunctionModule = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r][c] = dark
      isFunction[r][c] = true
    }
  }

  // 1. Finder patterns (7x7) + White Separators (8x8)
  const drawFinderWithSeparator = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr
        const c = c0 + dc
        if (r < 0 || r >= size || c < 0 || c >= size) continue
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const isOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6
          const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
          setFunctionModule(r, c, isOuter || isInner)
        } else {
          setFunctionModule(r, c, false)
        }
      }
    }
  }

  drawFinderWithSeparator(0, 0)
  drawFinderWithSeparator(0, size - 7)
  drawFinderWithSeparator(size - 7, 0)

  // 2. Alignment patterns (5x5)
  const centers = spec.alignmentCenters
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) {
        continue
      }
      const cr = centers[i]
      const cc = centers[j]
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          setFunctionModule(cr + dr, cc + dc, dist !== 1)
        }
      }
    }
  }

  // 3. Timing patterns (row 6, col 6)
  for (let i = 8; i < size - 8; i++) {
    if (!isFunction[6][i]) setFunctionModule(6, i, i % 2 === 0)
    if (!isFunction[i][6]) setFunctionModule(i, 6, i % 2 === 0)
  }

  // 4. Dark module & Reserved Format Info areas
  setFunctionModule(4 * spec.version + 9, 8, true)
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) setFunctionModule(8, i, false)
    if (!isFunction[i][8]) setFunctionModule(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false)
    if (!isFunction[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false)
  }

  // 5. Zigzag bit placement
  const allBits: number[] = []
  for (const cw of finalCodewords) {
    for (let b = 7; b >= 0; b--) {
      allBits.push((cw >>> b) & 1)
    }
  }

  let bitIdx = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const c = right - j
        if (!isFunction[r][c]) {
          const dark = bitIdx < allBits.length ? allBits[bitIdx] === 1 : false
          bitIdx++
          // Apply Mask 0: (r + c) % 2 === 0
          modules[r][c] = (r + c) % 2 === 0 ? !dark : dark
        }
      }
    }
    upward = !upward
  }

  // 6. Write BCH(15,5) Format Information (Level L = 0b01, Mask = 0)
  const formatBits = computeBchFormatBits(0b01, 0)
  for (let i = 0; i <= 5; i++) setFunctionModule(8, i, ((formatBits >>> i) & 1) === 1)
  setFunctionModule(8, 7, ((formatBits >>> 6) & 1) === 1)
  setFunctionModule(8, 8, ((formatBits >>> 7) & 1) === 1)
  setFunctionModule(7, 8, ((formatBits >>> 8) & 1) === 1)
  for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, ((formatBits >>> i) & 1) === 1)

  for (let i = 0; i < 8; i++) setFunctionModule(8, size - 1 - i, ((formatBits >>> i) & 1) === 1)
  for (let i = 8; i < 15; i++) setFunctionModule(size - 15 + i, 8, ((formatBits >>> i) & 1) === 1)

  return modules
}

/**
 * 根据输入 URL 生成符合 ISO/IEC 18004 标准的单色高对比度 QR 码内联 SVG Data URI
 */
export function generateQrCodeSvgDataUri(text: string): string {
  const grid = encodeQrCodeMatrix(text)
  const size = grid.length
  const cell = 6
  const pad = 16
  const totalPx = size * cell + pad * 2
  const rects: string[] = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        rects.push(`<rect x="${pad + c * cell}" y="${pad + r * cell}" width="${cell}" height="${cell}" fill="#18181b"/>`)
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalPx}" height="${totalPx}" viewBox="0 0 ${totalPx} ${totalPx}"><rect width="100%" height="100%" rx="12" fill="#f4f4f5"/>${rects.join('')}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export function getCapabilityItems(): CapabilityActionItem[] {
  return [
    {
      id: 'lan-start-server',
      title: '启动局域网免密 HTTP 闪电文件投送服务',
      subtitle: '绑定本机局域网 IPv4 端口并生成手机扫码即下二维码',
      tag: '内网投送',
      method: 'StartLanShareServer',
      params: { port: 18580 }
    },
    {
      id: 'lan-share-clipboard',
      title: '投送当前系统剪贴板文本至局域网设备',
      subtitle: '同一 Wi-Fi 下手机扫码直接复制 PC 剪贴板长文本或代码',
      tag: '文本投送',
      method: 'ShareClipboardText',
      params: {}
    }
  ]
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q)
  )
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || !method.trim()) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' && FORBIDDEN_TARGET_PATTERN.test(v.trim())) {
      return { valid: false, error: `SECURITY_INTERCEPTED (${k}): ${FORBIDDEN_REASON}` }
    }
  }
  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const check = validateInvocationPayload(method, params)
  if (!check.valid) {
    throw new Error(check.error || '参数校验失败')
  }
  return invokeDllPluginCapability(DLL_PLUGIN_NAME, method.trim(), params, hostBridge)
}

let currentDetectedLanIp = '127.0.0.1'
let currentDetectedLanPort = 18580

export async function toggleLanShareServer(
  enable = true,
  port = 18580,
  hostOverride?: any
): Promise<{ ok: boolean; running: boolean; lanIp: string; port: number; portalUrl: string; message: string }> {
  const action = enable ? 'startShareServer' : 'stopShareServer'
  const res = await invokePluginService<any>(DLL_PLUGIN_NAME, action, { port }, hostOverride)
  if (res.ok && res.data && res.data.ok !== false) {
    const lanIp = String(res.data.lanIp ?? res.data.primaryIp ?? '127.0.0.1')
    const actualPort = Number(res.data.port || port)
    currentDetectedLanIp = lanIp
    currentDetectedLanPort = actualPort
    const running = typeof res.data.running === 'boolean' ? res.data.running : enable
    const portalUrl = String(res.data.portalUrl || `http://${lanIp}:${actualPort}`)
    return {
      ok: true,
      running,
      lanIp,
      port: actualPort,
      portalUrl,
      message: running ? `局域网 HTTP 投送服务已启动 (${portalUrl})` : '局域网 HTTP 投送服务已停止'
    }
  }
  if (isRealElectronHost(hostOverride) || hostOverride) {
    return {
      ok: false,
      running: false,
      lanIp: '127.0.0.1',
      port,
      portalUrl: `http://127.0.0.1:${port}`,
      message: res.data?.error || res.error || '无法启动或停止局域网 HTTP 共享服务'
    }
  }
  return {
    ok: true,
    running: enable,
    lanIp: currentDetectedLanIp,
    port,
    portalUrl: `http://${currentDetectedLanIp}:${port}`,
    message: enable ? '已启动局域网快传服务 (离线预览)' : '已停止局域网快传服务 (离线预览)'
  }
}

export async function addRealFileToShareQueue(
  filePath: string,
  hostOverride?: any
): Promise<{ ok: boolean; item?: LanShareItem; message: string }> {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : ''
  if (!trimmed) {
    return { ok: false, message: '文件路径不能为空' }
  }
  if (FORBIDDEN_TARGET_PATTERN.test(trimmed)) {
    return { ok: false, message: FORBIDDEN_REASON }
  }

  const res = await invokePluginService<any>(
    DLL_PLUGIN_NAME,
    'syncShareFiles',
    { files: [{ path: trimmed }] },
    hostOverride
  )
  if (res.ok && res.data && res.data.ok !== false) {
    const lanIp = String(res.data.lanIp ?? res.data.primaryIp ?? currentDetectedLanIp)
    const port = Number(res.data.port || currentDetectedLanPort)
    currentDetectedLanIp = lanIp
    currentDetectedLanPort = port
    const portalUrl = String(res.data.portalUrl || `http://${lanIp}:${port}`)
    const fileName = trimmed.split(/[\\/]/).pop() || trimmed
    const shareUrl = `${portalUrl}/dl/${encodeURIComponent(fileName)}`
    const item: LanShareItem = {
      id: `lan-file-${encodeURIComponent(trimmed)}`,
      title: fileName,
      subtitle: trimmed,
      category: 'files',
      categoryLabel: '本地文件',
      filePath: trimmed,
      sizeBytes: Number(res.data.sizeBytes || 0),
      shareUrl,
      qrCodeDataUri: generateQrCodeSvgDataUri(shareUrl),
      isShared: true,
      downloadCount: Number(res.data.downloadCount || 0)
    }
    return { ok: true, item, message: `已将 ${fileName} 加入局域网 HTTP 共享队列` }
  }

  if (isRealElectronHost(hostOverride) || hostOverride) {
    return { ok: false, message: res.data?.error || res.error || '同步共享文件至宿主 HTTP 服务失败' }
  }

  const fileName = trimmed.split(/[\\/]/).pop() || trimmed
  const shareUrl = `http://${currentDetectedLanIp}:${currentDetectedLanPort}/dl/${encodeURIComponent(fileName)}`
  return {
    ok: true,
    item: {
      id: `lan-file-${encodeURIComponent(trimmed)}`,
      title: fileName,
      subtitle: trimmed,
      category: 'files',
      categoryLabel: '本地文件',
      filePath: trimmed,
      sizeBytes: 0,
      shareUrl,
      qrCodeDataUri: generateQrCodeSvgDataUri(shareUrl),
      isShared: true,
      downloadCount: 0
    },
    message: `已加入共享队列 (${fileName})`
  }
}

export async function fetchLanShareSnapshot(hostOverride?: any): Promise<LanShareSnapshot> {
  const realHost = isRealElectronHost(hostOverride) || Boolean(hostOverride)
  let lanIp = '127.0.0.1'
  let port = 18580
  let serverRunning = false
  let hostDownloadMap: Record<string, number> = {}
  let hostSharedFiles: Array<{ id?: string; name?: string; title?: string; path?: string; filePath?: string; size?: number; sizeBytes?: number; downloadCount?: number; shareUrl?: string; isShared?: boolean }> = []

  if (realHost) {
    const statusRes = await invokePluginService<any>(DLL_PLUGIN_NAME, 'getLanShareStatus', {}, hostOverride)
    if (statusRes.ok && statusRes.data) {
      const resolvedIp = statusRes.data.lanIp ?? statusRes.data.primaryIp
      if (resolvedIp) lanIp = String(resolvedIp)
      if (statusRes.data.port) port = Number(statusRes.data.port)
      serverRunning = Boolean(statusRes.data.running)
      if (statusRes.data.downloadCounts && typeof statusRes.data.downloadCounts === 'object') {
        hostDownloadMap = statusRes.data.downloadCounts
      }
      const rawFiles = statusRes.data.files ?? statusRes.data.sharedFiles
      if (Array.isArray(rawFiles)) {
        hostSharedFiles = rawFiles
      }
    }
  }

  currentDetectedLanIp = lanIp
  currentDetectedLanPort = port

  const portalUrl = `http://${lanIp}:${port}`
  const portalDownloads = Number(hostDownloadMap['portal'] ?? 0)

  const items: LanShareItem[] = [
    {
      id: 'lan-portal-entry',
      title: `本机局域网快传门户 (${portalUrl})`,
      subtitle: '同一 Wi-Fi 下手机或平板浏览器扫码即可双向收发文件与文本',
      category: 'portal',
      categoryLabel: '内网门户',
      filePath: '',
      sizeBytes: 0,
      shareUrl: portalUrl,
      qrCodeDataUri: generateQrCodeSvgDataUri(portalUrl),
      isShared: true,
      downloadCount: portalDownloads
    }
  ]

  let clipText = ''
  if (realHost) {
    clipText = await readRealClipboardText(hostOverride)
  }
  const effectiveClip =
    clipText.trim() || (realHost ? '' : 'git clone https://github.com/ZTools-Team/ZTools.git && npm install && npm start')
  if (effectiveClip || !realHost) {
    const clipUrl = `${portalUrl}/clip/latest`
    items.push({
      id: 'lan-clip-share',
      title: '当前系统剪贴板文本实时投送',
      subtitle: (effectiveClip || '当前剪贴板为空').replace(/\s+/g, ' ').slice(0, 72),
      category: 'clipboard',
      categoryLabel: '剪贴板投送',
      filePath: '',
      sizeBytes: effectiveClip.length,
      shareUrl: clipUrl,
      qrCodeDataUri: generateQrCodeSvgDataUri(clipUrl),
      isShared: true,
      downloadCount: Number(hostDownloadMap['clipboard'] ?? 0),
      textPreview: effectiveClip
    })
  }

  let realFilesAdded = false
  if (hostSharedFiles.length > 0) {
    hostSharedFiles.forEach((f, idx) => {
      const fPath = String(f.path ?? f.filePath ?? '')
      const fName = String(f.name ?? f.title ?? (fPath.split(/[\\/]/).pop() || `file-${idx + 1}`))
      const encodedName = encodeURIComponent(fName)
      const fileUrl = f.shareUrl || `${portalUrl}/dl/${idx + 1}/${encodedName}`
      items.push({
        id: f.id || `lan-file-${idx}`,
        title: fName,
        subtitle: fPath,
        category: 'files',
        categoryLabel: '本地文件',
        filePath: fPath,
        sizeBytes: Number(f.size ?? f.sizeBytes ?? 0),
        shareUrl: fileUrl,
        qrCodeDataUri: generateQrCodeSvgDataUri(fileUrl),
        isShared: f.isShared !== false,
        downloadCount: Number(f.downloadCount ?? hostDownloadMap[fPath] ?? 0)
      })
      realFilesAdded = true
    })
  } else if (realHost) {
    const env = await getRealEnvPaths(hostOverride)
    const [dlScan, deskScan] = await Promise.all([
      scanRealDirectoryTree(env.downloads, { maxFiles: 8, hostOverride }),
      scanRealDirectoryTree(env.desktop, { maxFiles: 6, hostOverride })
    ])
    const combined = [...dlScan.files, ...deskScan.files].filter((f) => !f.isDir && f.size > 0).slice(0, 8)
    if (combined.length > 0) {
      const syncRes = await invokePluginService<any>(
        DLL_PLUGIN_NAME,
        'syncShareFiles',
        { files: combined.map((f) => ({ name: f.name, path: f.path, size: f.size })) },
        hostOverride
      )
      if (syncRes.ok && syncRes.data) {
        const syncedIp = syncRes.data.lanIp ?? syncRes.data.primaryIp
        if (syncedIp) {
          lanIp = String(syncedIp)
          currentDetectedLanIp = lanIp
        }
        if (syncRes.data.port) {
          port = Number(syncRes.data.port)
          currentDetectedLanPort = port
        }
      }
    }
    for (const [idx, f] of combined.entries()) {
      const encodedName = encodeURIComponent(f.name)
      const fileUrl = `http://${lanIp}:${port}/dl/${idx + 1}/${encodedName}`
      items.push({
        id: `lan-file-${idx}`,
        title: f.name,
        subtitle: f.path,
        category: 'files',
        categoryLabel: '本地文件',
        filePath: f.path,
        sizeBytes: f.size,
        shareUrl: fileUrl,
        qrCodeDataUri: generateQrCodeSvgDataUri(fileUrl),
        isShared: true,
        downloadCount: Number(hostDownloadMap[f.path] ?? 0)
      })
      realFilesAdded = true
    }
  }

  // 仅在非真实 Electron 宿主且未传入 hostOverride 时，才提供离线预览样本数据
  if (!realFilesAdded && !realHost) {
    const sampleFiles = [
      {
        name: 'ZTools_Setup_1.1.7_x64.exe',
        path: 'C:\\Users\\User\\Downloads\\ZTools_Setup_1.1.7_x64.exe',
        size: 68420000,
        downloads: 0
      },
      {
        name: 'Architecture_Whitepaper_2026.pdf',
        path: 'C:\\Users\\User\\Desktop\\Architecture_Whitepaper_2026.pdf',
        size: 12840000,
        downloads: 0
      }
    ]
    sampleFiles.forEach((f, idx) => {
      const fileUrl = `${portalUrl}/dl/${idx + 1}/${encodeURIComponent(f.name)}`
      items.push({
        id: `lan-file-${idx}`,
        title: f.name,
        subtitle: f.path,
        category: 'files',
        categoryLabel: '本地文件',
        filePath: f.path,
        sizeBytes: f.size,
        shareUrl: fileUrl,
        qrCodeDataUri: generateQrCodeSvgDataUri(fileUrl),
        isShared: true,
        downloadCount: f.downloads
      })
    })
  }

  const sharedCount = items.filter((i) => i.isShared).length
  const totalSharedBytes = items.reduce((acc, cur) => acc + (cur.sizeBytes || 0), 0)

  return {
    items,
    lanIp,
    port,
    portalUrl: `http://${lanIp}:${port}`,
    serverRunning,
    sharedCount,
    totalSharedBytes
  }
}

export async function toggleFileShare(
  itemId: string,
  shared?: boolean,
  hostOverride?: any
): Promise<{ ok: boolean; isShared: boolean; shareUrl: string; message: string }> {
  if (!itemId || typeof itemId !== 'string' || !itemId.trim()) {
    return { ok: false, isShared: false, shareUrl: '', message: '共享项 ID 不能为空' }
  }
  const nextShared = typeof shared === 'boolean' ? shared : true
  let activeIp = currentDetectedLanIp || '127.0.0.1'
  let activePort = currentDetectedLanPort || 18580
  let shareUrl = `http://${activeIp}:${activePort}/dl/${encodeURIComponent(itemId)}`

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const svcRes = await invokePluginService<any>(
      DLL_PLUGIN_NAME,
      'toggleFileShare',
      { itemId, shared: nextShared },
      hostOverride
    )
    if (svcRes.ok && svcRes.data?.ok !== false) {
      const remoteIp = svcRes.data?.lanIp ?? svcRes.data?.primaryIp
      if (remoteIp) {
        activeIp = String(remoteIp)
        currentDetectedLanIp = activeIp
      }
      if (svcRes.data?.port) {
        activePort = Number(svcRes.data.port)
        currentDetectedLanPort = activePort
      }
      shareUrl = String(svcRes.data?.shareUrl || `http://${activeIp}:${activePort}/dl/${encodeURIComponent(itemId)}`)
      return {
        ok: true,
        isShared: nextShared,
        shareUrl,
        message: nextShared ? '已开启局域网免密直连共享' : '已停止该项局域网共享'
      }
    }
    if (svcRes.ok && svcRes.data?.ok === false) {
      return {
        ok: false,
        isShared: !nextShared,
        shareUrl,
        message: String(svcRes.data?.error || svcRes.data?.message || '切换局域网共享状态失败')
      }
    }
    const fallbackRes = await callHostTransport<any>('lan_share_toggle', { itemId, shared: nextShared }, hostOverride)
    if (!fallbackRes.ok || fallbackRes.data?.ok === false) {
      return {
        ok: false,
        isShared: !nextShared,
        shareUrl,
        message: fallbackRes.error || fallbackRes.data?.error || svcRes.error || '切换局域网共享状态失败'
      }
    }
    const fbIp = fallbackRes.data?.lanIp ?? fallbackRes.data?.primaryIp
    if (fbIp) {
      activeIp = String(fbIp)
      currentDetectedLanIp = activeIp
    }
    if (fallbackRes.data?.port) {
      activePort = Number(fallbackRes.data.port)
      currentDetectedLanPort = activePort
    }
    shareUrl = String(fallbackRes.data?.shareUrl || `http://${activeIp}:${activePort}/dl/${encodeURIComponent(itemId)}`)
  }
  return {
    ok: true,
    isShared: nextShared,
    shareUrl,
    message: nextShared ? '已开启局域网免密直连共享' : '已停止该项局域网共享'
  }
}

export async function openSharedFileLocation(filePath: string, hostOverride?: any): Promise<boolean> {
  if (!filePath) return false
  return showRealItemInFolder(filePath, hostOverride)
}

export function filterLanShareItems(
  items: LanShareItem[],
  query: string,
  mode: LanShareFilterMode | string = 'all'
): LanShareItem[] {
  if (!Array.isArray(items)) return []
  let list = items
  if (mode === 'clipboard') {
    list = list.filter((i) => i.category === 'clipboard' || i.category === 'portal')
  } else if (mode === 'files') {
    list = list.filter((i) => i.category === 'files')
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return list
  return list.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      i.subtitle.toLowerCase().includes(q) ||
      i.shareUrl.toLowerCase().includes(q) ||
      i.categoryLabel.toLowerCase().includes(q)
  )
}
