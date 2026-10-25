import { callHostTransport } from '../shared/native-ipc.js'
import type { FontLicenseFilter, LicenseType, SystemFontInfo } from './types.js'

interface FreeCommercialRule {
  keywords: string[]
  licenseName: string
  licenseUrl: string
  foundry: string
  chineseName?: string
}

const FREE_COMMERCIAL_RULES: FreeCommercialRule[] = [
  {
    keywords: ['source han sans', '思源黑体', 'noto sans cjk'],
    licenseName: 'SIL Open Font License 1.1 (OFL)',
    licenseUrl: 'https://github.com/adobe-fonts/source-han-sans',
    foundry: 'Adobe & Google',
    chineseName: '思源黑体'
  },
  {
    keywords: ['source han serif', '思源宋体', 'noto serif cjk'],
    licenseName: 'SIL Open Font License 1.1 (OFL)',
    licenseUrl: 'https://github.com/adobe-fonts/source-han-serif',
    foundry: 'Adobe & Google',
    chineseName: '思源宋体'
  },
  {
    keywords: ['lxgw wenkai', '霞鹜文楷', 'lxgwwenkai'],
    licenseName: 'SIL Open Font License 1.1 (OFL)',
    licenseUrl: 'https://github.com/lxgw/LxgwWenKai',
    foundry: 'LXGW (霞鹜)',
    chineseName: '霞鹜文楷'
  },
  {
    keywords: ['alibaba puhuiti', '阿里巴巴普惠体', 'alibabapuhuiti'],
    licenseName: 'Alibaba PuHuiTi Free Commercial License',
    licenseUrl: 'https://fonts.alibabagroup.com/',
    foundry: 'Alibaba',
    chineseName: '阿里巴巴普惠体'
  },
  {
    keywords: ['smiley sans', '得意黑', 'smileysans'],
    licenseName: 'SIL Open Font License 1.1 (OFL)',
    licenseUrl: 'https://github.com/atelier-anchor/smiley-sans',
    foundry: 'Atelier Anchor',
    chineseName: '得意黑'
  },
  {
    keywords: ['harmonyos sans', '鸿蒙黑体', 'harmonyos_sans'],
    licenseName: 'HarmonyOS Sans Free Commercial License',
    licenseUrl: 'https://developer.huawei.com/consumer/cn/design/resource/',
    foundry: 'Huawei',
    chineseName: 'HarmonyOS Sans'
  },
  {
    keywords: ['oppo sans', 'opposans'],
    licenseName: 'OPPO Sans Free Commercial License',
    licenseUrl: 'https://www.coloros.com/',
    foundry: 'OPPO',
    chineseName: 'OPPO Sans'
  },
  {
    keywords: ['misans', '小米兰亭'],
    licenseName: 'MiSans Free Commercial License',
    licenseUrl: 'https://hyperos.mi.com/font',
    foundry: 'Xiaomi',
    chineseName: 'MiSans'
  },
  {
    keywords: ['zcool', '站酷高端黑', '站酷快乐体', '站酷酷黑', '庞门正道'],
    licenseName: 'ZCOOL Free Commercial Font License',
    licenseUrl: 'https://www.zcool.com.cn/special/zcoolfonts/',
    foundry: 'ZCOOL'
  },
  {
    keywords: ['jetbrains mono', 'fira code', 'inter', 'roboto', 'open sans', 'ubuntu'],
    licenseName: 'SIL Open Font License 1.1 / Apache 2.0 (OFL)',
    licenseUrl: 'https://fonts.google.com/',
    foundry: 'Open Source'
  }
]

const COMMERCIAL_RISK_KEYWORDS = [
  'fz',
  '方正',
  'foundertype',
  'hy',
  '汉仪',
  'hanyi',
  '造字工房',
  'makefont',
  'st',
  '华文',
  '文鼎',
  'arphic',
  '微软雅黑',
  'microsoft yahei',
  'msyh',
  '汉鼎',
  '金桥'
]

const SYSTEM_BUILTIN_KEYWORDS = [
  'simsun',
  '宋体',
  'nsimsun',
  '新宋体',
  'simhei',
  '黑体',
  'kaiti',
  '楷体',
  'fangsong',
  '仿宋',
  'arial',
  'times new roman',
  'consolas',
  'segoe ui',
  'calibri',
  'cambria',
  'tahoma',
  'verdana',
  'courier new',
  'pingfang'
]

export function matchFontLicense(
  family: string,
  postScriptName?: string
): {
  licenseType: LicenseType
  licenseName?: string
  licenseUrl?: string
  foundry?: string
  chineseName?: string
} {
  const combined = `${family || ''} ${postScriptName || ''}`.trim().toLowerCase()
  if (!combined) {
    return { licenseType: 'unknown' }
  }

  // 1. 优先匹配开源/免费商用白名单
  for (const rule of FREE_COMMERCIAL_RULES) {
    if (rule.keywords.some((kw) => combined.includes(kw))) {
      return {
        licenseType: 'free-commercial',
        licenseName: rule.licenseName,
        licenseUrl: rule.licenseUrl,
        foundry: rule.foundry,
        chineseName: rule.chineseName
      }
    }
  }

  // 2. 匹配高风险商业版权字库（方正 FZ* / 汉仪 HY* / 华文 ST* / 微软雅黑等）
  const tokens = combined.split(/[\s_-]+/)
  const hasFzPrefix = tokens.some(
    (t) =>
      t.startsWith('fz') ||
      t.startsWith('hy') ||
      (t.startsWith('st') && t.length > 3 && !t.startsWith('standard'))
  )
  if (
    hasFzPrefix ||
    COMMERCIAL_RISK_KEYWORDS.some((kw) => kw.length >= 2 && combined.includes(kw))
  ) {
    return {
      licenseType: 'commercial-risk',
      licenseName: '商业版权受限（商用需单独购买官方授权）',
      foundry: combined.includes('方正') || combined.startsWith('fz') ? '方正字库' : '商业字库'
    }
  }

  // 3. 系统默认预装字体
  if (SYSTEM_BUILTIN_KEYWORDS.some((kw) => combined.includes(kw))) {
    return {
      licenseType: 'system-builtin',
      licenseName: '操作系统内置字体',
      foundry: 'OS Builtin'
    }
  }

  return {
    licenseType: 'unknown',
    licenseName: '未知授权（商用前请核实字库协议）'
  }
}

function readUInt16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 8) | buf[offset + 1]!) >>> 0
}

function readUInt32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  )
}

function decodeUtf16BE(bytes: Uint8Array): string {
  const chars: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    chars.push((bytes[i]! << 8) | bytes[i + 1]!)
  }
  return String.fromCharCode(...chars)
    .replace(/\0/g, '')
    .trim()
}

/**
 * 解析 TTF / OTF 二进制缓冲区的 OpenType `name` 表，对 0 字节或损坏文件安全返回 null
 */
export function parseOpenTypeNameTable(buffer: Uint8Array): {
  family: string
  subfamily: string
  postScriptName?: string
  chineseName?: string
  copyright?: string
} | null {
  try {
    if (!buffer || buffer.byteLength < 12) {
      return null
    }
    const sfntVersion = readUInt32BE(buffer, 0)
    // 0x00010000 (TrueType), 0x4F54544F ('OTTO'), 0x74727565 ('true')
    if (
      sfntVersion !== 0x00010000 &&
      sfntVersion !== 0x4f54544f &&
      sfntVersion !== 0x74727565
    ) {
      return null
    }
    const numTables = readUInt16BE(buffer, 4)
    if (numTables === 0 || numTables > 128 || buffer.byteLength < 12 + numTables * 16) {
      return null
    }

    let nameTableOffset = 0
    let nameTableLength = 0
    for (let i = 0; i < numTables; i++) {
      const entryOffset = 12 + i * 16
      const tag = String.fromCharCode(
        buffer[entryOffset]!,
        buffer[entryOffset + 1]!,
        buffer[entryOffset + 2]!,
        buffer[entryOffset + 3]!
      )
      if (tag === 'name') {
        nameTableOffset = readUInt32BE(buffer, entryOffset + 8)
        nameTableLength = readUInt32BE(buffer, entryOffset + 12)
        break
      }
    }

    if (
      nameTableOffset === 0 ||
      nameTableOffset + 6 > buffer.byteLength ||
      nameTableLength < 6
    ) {
      return null
    }

    const count = readUInt16BE(buffer, nameTableOffset + 2)
    const stringStorageOffset = nameTableOffset + readUInt16BE(buffer, nameTableOffset + 4)
    if (nameTableOffset + 6 + count * 12 > buffer.byteLength) {
      return null
    }

    let family = ''
    let subfamily = 'Regular'
    let postScriptName = ''
    let chineseName = ''
    let copyright = ''

    const textDecoder = new TextDecoder('utf-8', { fatal: false })

    for (let i = 0; i < count; i++) {
      const recOffset = nameTableOffset + 6 + i * 12
      const platformID = readUInt16BE(buffer, recOffset)
      const languageID = readUInt16BE(buffer, recOffset + 4)
      const nameID = readUInt16BE(buffer, recOffset + 6)
      const strLen = readUInt16BE(buffer, recOffset + 8)
      const strOffset = readUInt16BE(buffer, recOffset + 10)

      const absStart = stringStorageOffset + strOffset
      const absEnd = absStart + strLen
      if (strLen === 0 || absEnd > buffer.byteLength) continue

      const slice = buffer.subarray(absStart, absEnd)
      const decoded =
        platformID === 3 || platformID === 0
          ? decodeUtf16BE(slice)
          : textDecoder.decode(slice).replace(/\0/g, '').trim()

      if (!decoded) continue
      const isChineseLang =
        languageID === 0x0804 || languageID === 0x0404 || /[\u4e00-\u9fa5]/.test(decoded)

      if (nameID === 0 && !copyright) copyright = decoded
      if (nameID === 1) {
        if (isChineseLang && !chineseName) {
          chineseName = decoded
        } else if (!family) {
          family = decoded
        }
      }
      if (nameID === 2 && decoded) subfamily = decoded
      if (nameID === 6 && !postScriptName) postScriptName = decoded
    }

    if (!family && chineseName) {
      family = chineseName
    }
    if (!family) return null

    return {
      family,
      subfamily,
      postScriptName: postScriptName || undefined,
      chineseName: chineseName || undefined,
      copyright: copyright || undefined
    }
  } catch {
    return null
  }
}

function writeUInt16BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 8) & 0xff
  buf[offset + 1] = val & 0xff
}

function writeUInt32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff
  buf[offset + 1] = (val >>> 16) & 0xff
  buf[offset + 2] = (val >>> 8) & 0xff
  buf[offset + 3] = val & 0xff
}

function encodeUtf16BE(str: string): Uint8Array {
  const out = new Uint8Array(str.length * 2)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    out[i * 2] = (code >>> 8) & 0xff
    out[i * 2 + 1] = code & 0xff
  }
  return out
}

/**
 * 构造符合 OpenType 规范的最小化真实二进制字体头（含 `name` 表，供集成测试校验解析器）
 */
export function buildSyntheticOpenTypeFontBuffer(meta: {
  family: string
  subfamily?: string
  postScriptName?: string
  chineseName?: string
  copyright?: string
}): Uint8Array {
  const records: Array<{ nameID: number; languageID: number; bytes: Uint8Array }> = [
    { nameID: 0, languageID: 0x0409, bytes: encodeUtf16BE(meta.copyright || 'OFL-1.1') },
    { nameID: 1, languageID: 0x0409, bytes: encodeUtf16BE(meta.family) },
    { nameID: 2, languageID: 0x0409, bytes: encodeUtf16BE(meta.subfamily || 'Regular') },
    {
      nameID: 6,
      languageID: 0x0409,
      bytes: encodeUtf16BE(meta.postScriptName || meta.family.replace(/\s+/g, '-'))
    }
  ]
  if (meta.chineseName) {
    records.push({
      nameID: 1,
      languageID: 0x0804,
      bytes: encodeUtf16BE(meta.chineseName)
    })
  }

  const nameHeaderSize = 6 + records.length * 12
  const totalStringsSize = records.reduce((acc, r) => acc + r.bytes.length, 0)
  const nameTableLength = nameHeaderSize + totalStringsSize
  const sfntHeaderSize = 12 + 16 // 1 table ('name')
  const buf = new Uint8Array(sfntHeaderSize + nameTableLength)

  writeUInt32BE(buf, 0, 0x00010000)
  writeUInt16BE(buf, 4, 1) // numTables = 1
  writeUInt16BE(buf, 6, 16)
  writeUInt16BE(buf, 8, 0)
  writeUInt16BE(buf, 10, 0)

  // Table record: 'name'
  buf[12] = 0x6e // n
  buf[13] = 0x61 // a
  buf[14] = 0x6d // m
  buf[15] = 0x65 // e
  writeUInt32BE(buf, 16, 0)
  writeUInt32BE(buf, 20, sfntHeaderSize)
  writeUInt32BE(buf, 24, nameTableLength)

  // name table header
  const ntOffset = sfntHeaderSize
  writeUInt16BE(buf, ntOffset, 0)
  writeUInt16BE(buf, ntOffset + 2, records.length)
  writeUInt16BE(buf, ntOffset + 4, nameHeaderSize)

  let strOffset = 0
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    const recPos = ntOffset + 6 + i * 12
    writeUInt16BE(buf, recPos, 3) // platformID = 3 (Windows)
    writeUInt16BE(buf, recPos + 2, 1) // encodingID = 1 (Unicode BMP)
    writeUInt16BE(buf, recPos + 4, rec.languageID)
    writeUInt16BE(buf, recPos + 6, rec.nameID)
    writeUInt16BE(buf, recPos + 8, rec.bytes.length)
    writeUInt16BE(buf, recPos + 10, strOffset)
    buf.set(rec.bytes, ntOffset + nameHeaderSize + strOffset)
    strOffset += rec.bytes.length
  }

  return buf
}

export function sanitizePreviewSampleText(input: string, maxLen = 64): string {
  const clean = String(input ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (!clean) {
    return '天地玄黄 宇宙洪荒 永和九年 岁在癸丑 12345 ABC abc'
  }
  const codePoints = Array.from(clean)
  if (codePoints.length > maxLen) {
    return codePoints.slice(0, maxLen).join('') + '...'
  }
  return clean
}

export function filterInstalledFonts(
  fonts: SystemFontInfo[],
  licenseFilter: FontLicenseFilter,
  searchText: string
): SystemFontInfo[] {
  const q = searchText.trim().toLowerCase()
  return fonts.filter((f) => {
    if (licenseFilter === 'free-commercial' && f.licenseType !== 'free-commercial') {
      return false
    }
    if (licenseFilter === 'commercial-risk' && f.licenseType !== 'commercial-risk') {
      return false
    }
    if (licenseFilter === 'system' && f.licenseType !== 'system-builtin') {
      return false
    }
    if (!q) return true
    return (
      f.family.toLowerCase().includes(q) ||
      (f.chineseName ?? '').toLowerCase().includes(q) ||
      (f.postScriptName ?? '').toLowerCase().includes(q) ||
      (f.foundry ?? '').toLowerCase().includes(q)
    )
  })
}

export async function scanInstalledFonts(hostOverride?: unknown): Promise<SystemFontInfo[]> {
  type FontScanPayload = {
    fonts?: Array<{
      uniqueId: string
      family: string
      chineseName?: string
      postScriptName?: string
      weight: string
      format: 'ttf' | 'otf' | 'ttc' | 'woff'
      filePath: string
      fileSize: number
    }>
  }
  let res = await callHostTransport<FontScanPayload>(
    'dllplugin_call',
    { plugin: 'FontManagerPlugin', func: 'scan', params: { action: 'scan' } },
    hostOverride
  )
  if (!res.ok || !Array.isArray(res.data?.fonts)) {
    res = await callHostTransport<FontScanPayload>('font_manager', { action: 'scan' }, hostOverride)
  }

  if (!res.ok || !Array.isArray(res.data?.fonts)) {
    return []
  }

  const out: SystemFontInfo[] = []
  for (const raw of res.data.fonts) {
    if (!raw || !raw.family || raw.fileSize <= 0) {
      continue
    }
    const matched = matchFontLicense(raw.family, raw.postScriptName)
    const lowerPath = String(raw.filePath ?? '').toLowerCase()
    const isSystemProtected =
      lowerPath.includes('\\windows\\fonts\\') || lowerPath.startsWith('/system/library/fonts/')
    out.push({
      uniqueId: raw.uniqueId,
      family: raw.family,
      chineseName: raw.chineseName || matched.chineseName,
      postScriptName: raw.postScriptName || raw.family.replace(/\s+/g, '-'),
      weight: raw.weight || 'Regular',
      format: raw.format || 'ttf',
      filePath: raw.filePath,
      fileSize: raw.fileSize,
      licenseType: matched.licenseType,
      licenseName: matched.licenseName,
      licenseUrl: matched.licenseUrl,
      foundry: matched.foundry,
      isSystemProtected
    })
  }
  return out
}
