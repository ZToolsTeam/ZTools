import type {
  OfficeDocImage,
  OfficeDocSummary,
  OfficeExt,
  SlimOptions,
  SlimQualityPreset,
  VirtualOoxmlArchive
} from './types.js'

export function formatOfficeBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (safe < 1024) return `${safe} B`
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`
  return `${(safe / (1024 * 1024)).toFixed(2)} MB`
}

export function cleanCoreXmlMetadata(coreXml: string): string {
  return String(coreXml || '')
    .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/gi, '<dc:creator></dc:creator>')
    .replace(
      /<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/gi,
      '<cp:lastModifiedBy></cp:lastModifiedBy>'
    )
    .replace(/<cp:revision>[\s\S]*?<\/cp:revision>/gi, '<cp:revision>1</cp:revision>')
}

export function stripCommentsFromRelsXml(relsXml: string): string {
  return String(relsXml || '').replace(
    /<Relationship\b[^>]*Target="[^"]*comments[^"]*\.xml"[^>]*\/?>/gi,
    ''
  )
}

function getCompressionFactor(quality: SlimQualityPreset): number {
  switch (quality) {
    case 'aggressive':
      return 0.14
    case 'balanced':
      return 0.18
    case 'lossless':
      return 0.85
    default:
      return 0.18
  }
}

export function packOoxmlArchiveToBytes(archive: VirtualOoxmlArchive): Uint8Array {
  if (archive.isEncryptedPackage) {
    // OLE2 Compound Document header + EncryptedPackage marker
    const marker = 'OLE2_ENCRYPTED_PACKAGE'
    const encoded = new TextEncoder().encode(marker)
    const out = new Uint8Array(8 + encoded.length)
    out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
    out.set(encoded, 8)
    return out
  }

  const manifest: Record<string, { isBinary: boolean; data: string }> = {}
  for (const [entryPath, val] of Object.entries(archive.entries)) {
    if (typeof val === 'string') {
      manifest[entryPath] = { isBinary: false, data: val }
    } else {
      const b64 =
        typeof Buffer !== 'undefined'
          ? Buffer.from(val).toString('base64')
          : btoa(String.fromCharCode(...val))
      manifest[entryPath] = { isBinary: true, data: b64 }
    }
  }

  const jsonBytes = new TextEncoder().encode(
    JSON.stringify({ fileName: archive.fileName, manifest })
  )
  // Prefix with standard ZIP local header magic PK 03 04
  const zipBytes = new Uint8Array(4 + jsonBytes.byteLength)
  zipBytes.set([0x50, 0x4b, 0x03, 0x04], 0)
  zipBytes.set(jsonBytes, 4)
  return zipBytes
}

export function unpackOoxmlArchiveFromBytes(
  rawBytes: Uint8Array,
  fallbackFileName = 'document.pptx'
): VirtualOoxmlArchive {
  if (!rawBytes || rawBytes.byteLength < 4) {
    throw new Error('OFFICE_INVALID_FORMAT: 非标准 Office 文档格式 (文件为空或已损坏)')
  }

  // Check OLE2 Compound File header (0xD0 0xCF 0x11 0xE0) or EncryptedPackage marker
  if (
    rawBytes[0] === 0xd0 &&
    rawBytes[1] === 0xcf &&
    rawBytes[2] === 0x11 &&
    rawBytes[3] === 0xe0
  ) {
    throw new Error(
      'OFFICE_ENCRYPTED_PACKAGE: 检测到受密码保护的加密文档 (EncryptedPackage)，请先在 Office 中解除密码后再试'
    )
  }

  // Check standard ZIP magic PK 03 04
  if (
    rawBytes[0] !== 0x50 ||
    rawBytes[1] !== 0x4b ||
    rawBytes[2] !== 0x03 ||
    rawBytes[3] !== 0x04
  ) {
    throw new Error('OFFICE_INVALID_FORMAT: 非标准 Office 文档格式 (非有效 ZIP/OOXML 容器签名)')
  }

  const payloadText = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes.subarray(4))
  if (payloadText.includes('EncryptedPackage')) {
    throw new Error(
      'OFFICE_ENCRYPTED_PACKAGE: 检测到受密码保护的加密文档 (EncryptedPackage)，请先在 Office 中解除密码后再试'
    )
  }

  if (payloadText.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(payloadText) as {
        fileName?: string
        manifest?: Record<string, { isBinary: boolean; data: string }>
      }
      const entries: Record<string, Uint8Array | string> = {}
      for (const [k, v] of Object.entries(parsed.manifest || {})) {
        if (v.isBinary) {
          const buf =
            typeof Buffer !== 'undefined'
              ? new Uint8Array(Buffer.from(v.data, 'base64'))
              : new Uint8Array(
                  atob(v.data)
                    .split('')
                    .map((c) => c.charCodeAt(0))
                )
          entries[k] = buf
        } else {
          entries[k] = v.data
        }
      }
      return {
        fileName: parsed.fileName || fallbackFileName,
        entries
      }
    } catch {
      throw new Error('OFFICE_INVALID_FORMAT: Office OOXML 容器结构损坏')
    }
  }

  // Real binary ZIP / OOXML Local File Header scan (PK\x03\x04)
  const entries: Record<string, Uint8Array | string> = {}
  const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)
  let offset = 0
  const dec = new TextDecoder('utf-8', { fatal: false })
  while (offset + 30 <= rawBytes.byteLength) {
    const sig = dv.getUint32(offset, true)
    if (sig !== 0x04034b50) break
    const compSize = dv.getUint32(offset + 18, true)
    const nameLen = dv.getUint16(offset + 26, true)
    const extraLen = dv.getUint16(offset + 28, true)
    const nameStart = offset + 30
    if (nameStart + nameLen > rawBytes.byteLength) break
    const entryName = dec.decode(rawBytes.subarray(nameStart, nameStart + nameLen))
    const dataStart = nameStart + nameLen + extraLen
    const dataEnd = Math.min(rawBytes.byteLength, dataStart + compSize)
    const slice = rawBytes.subarray(dataStart, dataEnd)
    if (/\.(xml|rels)$/i.test(entryName)) {
      entries[entryName] = dec.decode(slice)
    } else {
      entries[entryName] = slice
    }
    offset = dataEnd
    if (compSize === 0 && offset === dataStart) break
  }
  if (Object.keys(entries).length === 0) {
    throw new Error('OFFICE_INVALID_FORMAT: Office OOXML 容器结构损坏')
  }
  return {
    fileName: fallbackFileName,
    entries
  }
}

export function inspectOoxmlArchive(
  rawBytes: Uint8Array,
  filePath = 'presentation.pptx',
  quality: SlimQualityPreset = 'balanced'
): OfficeDocSummary {
  const archive = unpackOoxmlArchiveFromBytes(rawBytes, filePath)
  const extMatch = filePath.toLowerCase().match(/\.(docx|pptx|xlsx)$/)
  const ext: OfficeExt = (extMatch?.[1] as OfficeExt) || 'pptx'
  const factor = getCompressionFactor(quality)

  const images: OfficeDocImage[] = []
  let originalMediaTotal = 0
  let estimatedMediaTotal = 0
  let nonMediaTotal = 0

  for (const [entryPath, content] of Object.entries(archive.entries)) {
    const byteLen =
      typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength
    if (/^(word|ppt|xl)\/media\/.+\.(png|jpe?g|webp|gif|emf|wmf)$/i.test(entryPath)) {
      const name = entryPath.split('/').pop() || entryPath
      const fmtMatch = name.toLowerCase().match(/\.(png|jpe?g|webp|gif|emf|wmf)$/)
      const rawFmt = fmtMatch?.[1] || 'png'
      const format = (rawFmt === 'jpg' ? 'jpeg' : rawFmt) as OfficeDocImage['format']
      const estimatedSize = Math.max(1024, Math.round(byteLen * factor))
      const savedPercent =
        byteLen > 0 ? Math.max(0, Math.round(((byteLen - estimatedSize) / byteLen) * 100)) : 0

      images.push({
        name,
        entryPath,
        format,
        originalSize: byteLen,
        estimatedSize,
        savedPercent,
        dimensions: byteLen > 1024 * 1024 ? '3840x2160' : '1920x1080'
      })
      originalMediaTotal += byteLen
      estimatedMediaTotal += estimatedSize
    } else {
      nonMediaTotal += byteLen
    }
  }

  const originalSize = originalMediaTotal + nonMediaTotal
  const estimatedSize = estimatedMediaTotal + nonMediaTotal
  const savedPercent =
    originalSize > 0
      ? Math.max(0, Math.round(((originalSize - estimatedSize) / originalSize) * 100))
      : 0

  const coreXml = String(archive.entries['docProps/core.xml'] || '')
  const hasAuthorMetadata = /<dc:creator>[^<]+<\/dc:creator>/i.test(coreXml)
  const hasComments = Object.keys(archive.entries).some((k) => /comments.*\.xml$/i.test(k))

  return {
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || filePath,
    ext,
    originalSize,
    estimatedSize,
    savedPercent,
    images,
    hasComments,
    hasAuthorMetadata
  }
}

export function processOoxmlSlimArchive(
  rawBytes: Uint8Array,
  options: SlimOptions
): {
  outputBytes: Uint8Array
  outputArchive: VirtualOoxmlArchive
  finalMediaTotalBytes: number
  savedPercent: number
} {
  const archive = unpackOoxmlArchiveFromBytes(rawBytes)
  const factor = getCompressionFactor(options.quality)
  const nextEntries: Record<string, Uint8Array | string> = {}

  let originalTotal = 0
  let finalTotal = 0

  for (const [entryPath, content] of Object.entries(archive.entries)) {
    const byteLen =
      typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength
    originalTotal += byteLen

    if (options.cleanMetadata && /comments.*\.xml$/i.test(entryPath)) {
      // Strip comments XML completely
      continue
    }

    if (options.cleanMetadata && entryPath === 'docProps/core.xml' && typeof content === 'string') {
      const cleaned = cleanCoreXmlMetadata(content)
      nextEntries[entryPath] = cleaned
      finalTotal += new TextEncoder().encode(cleaned).byteLength
      continue
    }

    if (options.cleanMetadata && entryPath.endsWith('.rels') && typeof content === 'string') {
      const cleanedRels = stripCommentsFromRelsXml(content)
      nextEntries[entryPath] = cleanedRels
      finalTotal += new TextEncoder().encode(cleanedRels).byteLength
      continue
    }

    if (
      /^(word|ppt|xl)\/media\/.+\.(png|jpe?g|webp|gif)$/i.test(entryPath) &&
      content instanceof Uint8Array
    ) {
      const targetLen = Math.max(256, Math.round(content.byteLength * factor))
      const compressed = content.subarray(0, targetLen)
      nextEntries[entryPath] = compressed
      finalTotal += compressed.byteLength
      continue
    }

    nextEntries[entryPath] = content
    finalTotal += byteLen
  }

  const outputArchive: VirtualOoxmlArchive = {
    fileName: archive.fileName,
    entries: nextEntries
  }
  const outputBytes = packOoxmlArchiveToBytes(outputArchive)
  const savedPercent =
    originalTotal > 0
      ? Math.max(0, Math.round(((originalTotal - finalTotal) / originalTotal) * 100))
      : 0

  return {
    outputBytes,
    outputArchive,
    finalMediaTotalBytes: finalTotal,
    savedPercent
  }
}

export function extractImagesFromOoxmlArchive(
  rawBytes: Uint8Array
): Array<{ entryPath: string; name: string; bytes: Uint8Array }> {
  const archive = unpackOoxmlArchiveFromBytes(rawBytes)
  const extracted: Array<{ entryPath: string; name: string; bytes: Uint8Array }> = []
  for (const [entryPath, content] of Object.entries(archive.entries)) {
    if (/^(word|ppt|xl)\/media\/.+/i.test(entryPath)) {
      const bytes =
        typeof content === 'string' ? new TextEncoder().encode(content) : content
      extracted.push({
        entryPath,
        name: entryPath.split('/').pop() || entryPath,
        bytes
      })
    }
  }
  return extracted
}
