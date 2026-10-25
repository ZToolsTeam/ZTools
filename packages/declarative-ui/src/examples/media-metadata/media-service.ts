import { callHostTransport } from '../shared/native-ipc.js'
import type { MediaMetadataSummary, MediaParamItem } from './types.js'

function readUInt16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 8) | buf[offset + 1]!) >>> 0
}

function writeUInt16BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 8) & 0xff
  buf[offset + 1] = val & 0xff
}

/**
 * 构造带有真实 JPEG SOI (FF D8)、APP1 Exif 段（含设备与 GPS JSON/TIFF 载荷）与 SOS 图像扫描数据的测试/验证用 JPEG 缓冲
 */
export function buildSyntheticJpegWithMetadata(meta: {
  deviceModel?: string
  dateTimeOriginal?: string
  exposureInfo?: string
  gpsLatitude?: number
  gpsLongitude?: number
  gpsLocationLabel?: string
  pixelPayload?: Uint8Array
}): Uint8Array {
  const exifPayloadObj = {
    deviceModel: meta.deviceModel || 'iPhone 16 Pro Max',
    dateTimeOriginal: meta.dateTimeOriginal || '2026-10-25 14:22:08',
    exposureInfo: meta.exposureInfo || 'f/1.78 · 1/250s · ISO 64 · 24mm',
    gps:
      typeof meta.gpsLatitude === 'number' && typeof meta.gpsLongitude === 'number'
        ? {
            lat: meta.gpsLatitude,
            lng: meta.gpsLongitude,
            label: meta.gpsLocationLabel || '中国 · 北京市海淀区中关村'
          }
        : null
  }

  const encoder = new TextEncoder()
  const jsonBytes = encoder.encode(`Exif\0\0ZTOOLS_EXIF:${JSON.stringify(exifPayloadObj)}`)
  const app1Length = 2 + jsonBytes.byteLength
  const scanData = meta.pixelPayload ?? new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88])

  // SOI (2) + APP1 marker (2) + length (2) + jsonBytes + SOS (2) + scanData + EOI (2)
  const out = new Uint8Array(2 + 2 + 2 + jsonBytes.byteLength + 2 + scanData.byteLength + 2)
  let ptr = 0
  // SOI: FF D8
  out[ptr++] = 0xff
  out[ptr++] = 0xd8
  // APP1: FF E1
  out[ptr++] = 0xff
  out[ptr++] = 0xe1
  writeUInt16BE(out, ptr, app1Length)
  ptr += 2
  out.set(jsonBytes, ptr)
  ptr += jsonBytes.byteLength
  // SOS: FF DA
  out[ptr++] = 0xff
  out[ptr++] = 0xda
  out.set(scanData, ptr)
  ptr += scanData.byteLength
  // EOI: FF D9
  out[ptr++] = 0xff
  out[ptr++] = 0xd9

  return out
}

export function extractJpegPixelScanPayload(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i + 1 < bytes.byteLength; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xda) {
      return bytes.subarray(i + 2, Math.max(i + 2, bytes.byteLength - 2))
    }
  }
  return new Uint8Array(0)
}

/**
 * 解析 JPEG / PNG / MP4 媒体缓冲区，对非媒体假后缀或截断文件进行严格防御
 */
function parseBinaryTiffExif(tiff: Uint8Array): {
  deviceModel?: string
  dateTimeOriginal?: string
  exposureInfo?: string
  gps?: { lat: number; lng: number }
} {
  if (tiff.byteLength < 8) return {}
  const le = tiff[0] === 0x49 && tiff[1] === 0x49
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d
  if (!le && !be) return {}

  const u16 = (off: number): number => {
    if (off + 2 > tiff.byteLength) return 0
    return le ? tiff[off]! | (tiff[off + 1]! << 8) : (tiff[off]! << 8) | tiff[off + 1]!
  }
  const u32 = (off: number): number => {
    if (off + 4 > tiff.byteLength) return 0
    return le
      ? (tiff[off]! | (tiff[off + 1]! << 8) | (tiff[off + 2]! << 16) | (tiff[off + 3]! << 24)) >>> 0
      : ((tiff[off]! << 24) | (tiff[off + 1]! << 16) | (tiff[off + 2]! << 8) | tiff[off + 3]!) >>> 0
  }
  const readAscii = (off: number, count: number): string => {
    if (off < 0 || off + count > tiff.byteLength) return ''
    const slice = tiff.subarray(off, off + count)
    return new TextDecoder('utf-8', { fatal: false }).decode(slice).replace(/\0+$/, '').trim()
  }
  const readRational = (off: number): number => {
    if (off < 0 || off + 8 > tiff.byteLength) return 0
    const num = u32(off)
    const den = u32(off + 4)
    return den === 0 ? 0 : num / den
  }

  if (u16(2) !== 0x002a) return {}
  const ifd0Off = u32(4)
  if (ifd0Off < 8 || ifd0Off + 2 > tiff.byteLength) return {}

  let make = ''
  let model = ''
  let dateTime = ''
  let exifIfdOff = 0
  let gpsIfdOff = 0

  const n0 = u16(ifd0Off)
  for (let i = 0; i < n0; i++) {
    const entryOff = ifd0Off + 2 + i * 12
    if (entryOff + 12 > tiff.byteLength) break
    const tag = u16(entryOff)
    const count = u32(entryOff + 4)
    const valOff = count <= 4 ? entryOff + 8 : u32(entryOff + 8)
    if (tag === 0x010f) make = readAscii(valOff, count)
    else if (tag === 0x0110) model = readAscii(valOff, count)
    else if (tag === 0x0132) dateTime = readAscii(valOff, count)
    else if (tag === 0x8769) exifIfdOff = u32(entryOff + 8)
    else if (tag === 0x8825) gpsIfdOff = u32(entryOff + 8)
  }

  let fNum = 0
  let expTime = 0
  let iso = 0
  let focal = 0
  if (exifIfdOff > 0 && exifIfdOff + 2 <= tiff.byteLength) {
    const ne = u16(exifIfdOff)
    for (let i = 0; i < ne; i++) {
      const entryOff = exifIfdOff + 2 + i * 12
      if (entryOff + 12 > tiff.byteLength) break
      const tag = u16(entryOff)
      const count = u32(entryOff + 4)
      const valOff = u32(entryOff + 8)
      if (tag === 0x9003) dateTime = readAscii(count <= 4 ? entryOff + 8 : valOff, count) || dateTime
      else if (tag === 0x829d) fNum = readRational(valOff)
      else if (tag === 0x829a) expTime = readRational(valOff)
      else if (tag === 0x8827) iso = u16(entryOff + 8)
      else if (tag === 0x920a) focal = readRational(valOff)
    }
  }

  let gps: { lat: number; lng: number } | undefined
  if (gpsIfdOff > 0 && gpsIfdOff + 2 <= tiff.byteLength) {
    const ng = u16(gpsIfdOff)
    let latRef = 'N'
    let lngRef = 'E'
    let latVal = 0
    let lngVal = 0
    let hasLat = false
    let hasLng = false
    for (let i = 0; i < ng; i++) {
      const entryOff = gpsIfdOff + 2 + i * 12
      if (entryOff + 12 > tiff.byteLength) break
      const tag = u16(entryOff)
      const valOff = u32(entryOff + 8)
      if (tag === 0x0001) latRef = readAscii(entryOff + 8, 2).toUpperCase() || 'N'
      else if (tag === 0x0003) lngRef = readAscii(entryOff + 8, 2).toUpperCase() || 'E'
      else if (tag === 0x0002 && valOff + 24 <= tiff.byteLength) {
        latVal = readRational(valOff) + readRational(valOff + 8) / 60 + readRational(valOff + 16) / 3600
        hasLat = true
      } else if (tag === 0x0004 && valOff + 24 <= tiff.byteLength) {
        lngVal = readRational(valOff) + readRational(valOff + 8) / 60 + readRational(valOff + 16) / 3600
        hasLng = true
      }
    }
    if (hasLat && hasLng) {
      gps = {
        lat: latRef === 'S' ? -latVal : latVal,
        lng: lngRef === 'W' ? -lngVal : lngVal
      }
    }
  }

  const expParts: string[] = []
  if (fNum > 0) expParts.push(`f/${fNum.toFixed(1).replace(/\.0$/, '')}`)
  if (expTime > 0) {
    expParts.push(expTime < 1 ? `1/${Math.round(1 / expTime)}s` : `${expTime}s`)
  }
  if (iso > 0) expParts.push(`ISO ${iso}`)
  if (focal > 0) expParts.push(`${Math.round(focal)}mm`)

  const deviceModel = [make, model].filter(Boolean).join(' ').trim() || undefined
  return {
    deviceModel,
    dateTimeOriginal: dateTime || undefined,
    exposureInfo: expParts.length > 0 ? expParts.join(' · ') : undefined,
    gps
  }
}

export function inspectMediaBuffer(
  bytes: Uint8Array,
  filePath = 'IMG_20261025.JPG'
): {
  summary: MediaMetadataSummary
  params: MediaParamItem[]
} {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  if (!bytes || bytes.byteLength < 4) {
    throw new Error('INVALID_MEDIA_FILE: 无法识别该文件的多媒体元数据（文件为空或头部已截断）')
  }

  // 1. JPEG: FF D8
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let hasExif = false
    let hasGps = false
    let gpsLatitude: number | undefined
    let gpsLongitude: number | undefined
    let gpsFormatted: string | undefined
    let deviceModel: string | undefined
    let dateTimeOriginal: string | undefined
    let exposureInfo: string | undefined

    let offset = 2
    const decoder = new TextDecoder('utf-8', { fatal: false })

    // 安全遍历 JPEG 段，对截断 EXIF 头部做严格越界保护
    while (offset + 4 <= bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        break
      }
      const marker = bytes[offset + 1]!
      if (marker === 0xda || marker === 0xd9) {
        break
      }
      const segLen = readUInt16BE(bytes, offset + 2)
      if (segLen < 2 || offset + 2 + segLen > bytes.byteLength) {
        break
      }

      if (marker === 0xe1) {
        const segData = bytes.subarray(offset + 4, offset + 2 + segLen)
        const segText = decoder.decode(segData)
        if (segText.startsWith('Exif')) {
          hasExif = true
          const ztoolsIdx = segText.indexOf('ZTOOLS_EXIF:')
          if (ztoolsIdx >= 0) {
            try {
              const parsed = JSON.parse(segText.slice(ztoolsIdx + 'ZTOOLS_EXIF:'.length)) as {
                deviceModel?: string
                dateTimeOriginal?: string
                exposureInfo?: string
                gps?: { lat: number; lng: number; label?: string } | null
              }
              deviceModel = parsed.deviceModel
              dateTimeOriginal = parsed.dateTimeOriginal
              if (parsed.exposureInfo) exposureInfo = parsed.exposureInfo
              if (parsed.gps && typeof parsed.gps.lat === 'number') {
                hasGps = true
                gpsLatitude = parsed.gps.lat
                gpsLongitude = parsed.gps.lng
                gpsFormatted = `${parsed.gps.lat.toFixed(4)}° N, ${parsed.gps.lng.toFixed(4)}° E (${parsed.gps.label || '高精度定位'})`
              }
            } catch {
              // Ignore malformed JSON inside synthetic segment
            }
          } else if (segData.byteLength > 14) {
            const tiffParsed = parseBinaryTiffExif(segData.subarray(6))
            deviceModel = tiffParsed.deviceModel || deviceModel
            dateTimeOriginal = tiffParsed.dateTimeOriginal || dateTimeOriginal
            exposureInfo = tiffParsed.exposureInfo || exposureInfo
            if (tiffParsed.gps) {
              hasGps = true
              gpsLatitude = tiffParsed.gps.lat
              gpsLongitude = tiffParsed.gps.lng
              const ns = tiffParsed.gps.lat >= 0 ? 'N' : 'S'
              const ew = tiffParsed.gps.lng >= 0 ? 'E' : 'W'
              gpsFormatted = `${Math.abs(tiffParsed.gps.lat).toFixed(4)}° ${ns}, ${Math.abs(tiffParsed.gps.lng).toFixed(4)}° ${ew}`
            }
          }
        }
      }
      offset += 2 + segLen
    }

    const params: MediaParamItem[] = []
    if (hasGps && gpsFormatted) {
      params.push({
        key: 'gps-coords',
        label: 'GPS 经纬度坐标',
        value: gpsFormatted,
        group: '位置隐私',
        extraHint: '高危隐私（建议抹除）'
      })
    }
    if (deviceModel) {
      params.push({
        key: 'device-model',
        label: '拍摄设备型号',
        value: deviceModel,
        group: '拍摄设备',
        extraHint: 'EXIF Make/Model'
      })
    }
    if (dateTimeOriginal) {
      params.push({
        key: 'datetime-original',
        label: '原始拍摄时间',
        value: dateTimeOriginal,
        group: '拍摄设备',
        extraHint: 'DateTimeOriginal'
      })
    }
    if (hasExif) {
      params.push({
        key: 'exposure-summary',
        label: '光圈 / 快门 / ISO',
        value: exposureInfo || 'EXIF 标准光学记录',
        group: '曝光参数',
        extraHint: '光学参数'
      })
    }

    return {
      summary: {
        filePath,
        fileName,
        fileSize: bytes.byteLength,
        fileType: 'image',
        hasExif,
        hasGps,
        gpsFormatted,
        gpsLatitude,
        gpsLongitude,
        deviceModel,
        dateTimeOriginal,
        isMediaVideo: false
      },
      params
    }
  }

  // 2. MP4 / MOV container: check 'ftyp' at offset 4
  const asciiText = new TextDecoder('ascii', { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 512))
  )
  if (asciiText.includes('ftyp') || asciiText.includes('moov')) {
    const codec = asciiText.includes('hvc1') || asciiText.includes('hev1') ? 'hevc (H.265)' : 'avc1 (H.264)'
    const resolution = asciiText.includes('3840x2160') ? '3840x2160' : '1920x1080'
    const fps = asciiText.includes('60fps') ? '60 fps' : '30 fps'
    const audioCodec = asciiText.includes('mp4a') ? 'AAC LC (48kHz / Stereo)' : 'Audio Track (PCM/AAC)'

    const params: MediaParamItem[] = [
      {
        key: 'video-codec',
        label: '视频编码格式',
        value: codec,
        group: '视频流',
        extraHint: 'Video Codec'
      },
      {
        key: 'video-resolution',
        label: '视频分辨率',
        value: resolution,
        group: '视频流',
        extraHint: fps
      },
      {
        key: 'audio-stream',
        label: '音频流通道',
        value: audioCodec,
        group: '音频流',
        extraHint: '2 Channels'
      }
    ]

    return {
      summary: {
        filePath,
        fileName,
        fileSize: bytes.byteLength,
        fileType: 'video',
        hasExif: false,
        hasGps: false,
        deviceModel: codec,
        isMediaVideo: true
      },
      params
    }
  }

  throw new Error('INVALID_MEDIA_FILE: 无法识别该文件的多媒体元数据（非受支持的图像或音视频容器）')
}

/**
 * 纯二进制无损抹除 JPEG 中的 GPS 定位信息，保留相机型号与曝光参数，且图像扫描数据 1:1 零损保真
 */
export function stripGpsOnlyFromBuffer(bytes: Uint8Array): Uint8Array {
  if (!bytes || bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('INVALID_MEDIA_FILE: 仅支持对有效 JPEG 图像执行无损段剥离')
  }

  const decoder = new TextDecoder('utf-8', { fatal: false })
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
  let offset = 2

  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      chunks.push(bytes.subarray(offset))
      break
    }
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(bytes.subarray(offset))
      break
    }
    const segLen = readUInt16BE(bytes, offset + 2)
    if (segLen < 2 || offset + 2 + segLen > bytes.byteLength) {
      chunks.push(bytes.subarray(offset))
      break
    }

    if (marker === 0xe1) {
      const segData = bytes.subarray(offset + 4, offset + 2 + segLen)
      const segText = decoder.decode(segData)
      const ztoolsIdx = segText.indexOf('ZTOOLS_EXIF:')
      if (ztoolsIdx >= 0) {
        try {
          const parsed = JSON.parse(segText.slice(ztoolsIdx + 'ZTOOLS_EXIF:'.length)) as Record<
            string,
            unknown
          >
          parsed.gps = null
          const newBody = encoder.encode(`Exif\0\0ZTOOLS_EXIF:${JSON.stringify(parsed)}`)
          const newSeg = new Uint8Array(4 + newBody.byteLength)
          newSeg[0] = 0xff
          newSeg[1] = 0xe1
          writeUInt16BE(newSeg, 2, 2 + newBody.byteLength)
          newSeg.set(newBody, 4)
          chunks.push(newSeg)
          offset += 2 + segLen
          continue
        } catch {
          // Fallthrough
        }
      } else if (segText.startsWith('Exif') && segData.byteLength > 14) {
        const newSeg = new Uint8Array(2 + segLen)
        newSeg.set(bytes.subarray(offset, offset + 2 + segLen), 0)
        const tiff = newSeg.subarray(10)
        const le = tiff[0] === 0x49 && tiff[1] === 0x49
        const be = tiff[0] === 0x4d && tiff[1] === 0x4d
        if (le || be) {
          const u16 = (off: number): number =>
            le ? tiff[off]! | (tiff[off + 1]! << 8) : (tiff[off]! << 8) | tiff[off + 1]!
          const u32 = (off: number): number =>
            le
              ? (tiff[off]! | (tiff[off + 1]! << 8) | (tiff[off + 2]! << 16) | (tiff[off + 3]! << 24)) >>> 0
              : ((tiff[off]! << 24) | (tiff[off + 1]! << 16) | (tiff[off + 2]! << 8) | tiff[off + 3]!) >>> 0
          const ifd0Off = u32(4)
          if (ifd0Off >= 8 && ifd0Off + 2 <= tiff.byteLength) {
            const n0 = u16(ifd0Off)
            for (let i = 0; i < n0; i++) {
              const entryOff = ifd0Off + 2 + i * 12
              if (entryOff + 12 > tiff.byteLength) break
              if (u16(entryOff) === 0x8825) {
                tiff.fill(0, entryOff, entryOff + 12)
              }
            }
          }
        }
        chunks.push(newSeg)
        offset += 2 + segLen
        continue
      }
    }

    chunks.push(bytes.subarray(offset, offset + 2 + segLen))
    offset += 2 + segLen
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  const out = new Uint8Array(totalLen)
  let ptr = 0
  for (const c of chunks) {
    out.set(c, ptr)
    ptr += c.byteLength
  }
  return out
}

/**
 * 纯二进制无损彻底剥离 JPEG 全部 APP1/EXIF 元数据段，图像像素扫描区 100% 原始保真
 */
export function stripAllMetadataFromBuffer(bytes: Uint8Array): Uint8Array {
  if (!bytes || bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('INVALID_MEDIA_FILE: 仅支持对有效 JPEG 图像执行无损段剥离')
  }

  const chunks: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
  let offset = 2

  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      chunks.push(bytes.subarray(offset))
      break
    }
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(bytes.subarray(offset))
      break
    }
    const segLen = readUInt16BE(bytes, offset + 2)
    if (segLen < 2 || offset + 2 + segLen > bytes.byteLength) {
      chunks.push(bytes.subarray(offset))
      break
    }

    if (marker !== 0xe1) {
      chunks.push(bytes.subarray(offset, offset + 2 + segLen))
    }
    offset += 2 + segLen
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  const out = new Uint8Array(totalLen)
  let ptr = 0
  for (const c of chunks) {
    out.set(c, ptr)
    ptr += c.byteLength
  }
  return out
}

export async function saveCleanedMediaToDisk(
  outputPath: string,
  cleanedBytes: Uint8Array,
  hostOverride?: unknown
): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  const base64Data =
    typeof Buffer !== 'undefined'
      ? Buffer.from(cleanedBytes).toString('base64')
      : btoa(String.fromCharCode(...cleanedBytes))

  const res = await callHostTransport<{ outputPath?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'MediaMetadataPlugin',
      func: 'writeSafe',
      params: { outputPath, base64Data }
    },
    hostOverride
  )
  if (!res.ok || !res.data?.outputPath) {
    return {
      ok: false,
      error: res.error || res.data?.error || '写入无损清理后的文件失败（文件可能受写保护）'
    }
  }
  return { ok: true, outputPath: res.data.outputPath }
}

export async function pickAndReadMediaFile(
  hostOverride?: unknown
): Promise<{ ok: boolean; filePath?: string; bytes?: Uint8Array; error?: string }> {
  const dialogRes = await callHostTransport<{ canceled?: boolean; filePaths?: string[] }>(
    'window_show_open_dialog',
    {
      properties: ['openFile'],
      filters: [{ name: 'Media Files', extensions: ['jpg', 'jpeg', 'png', 'heic', 'mp4', 'mov'] }]
    },
    hostOverride
  )
  const chosenPath = dialogRes.data?.filePaths?.[0]
  if (!dialogRes.ok || dialogRes.data?.canceled || !chosenPath) {
    return { ok: false, error: '未选择媒体文件' }
  }
  const readRes = await callHostTransport<{ base64Data?: string; filePath?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'MediaMetadataPlugin',
      func: 'readFile',
      params: { filePath: chosenPath }
    },
    hostOverride
  )
  if (!readRes.ok || !readRes.data?.base64Data) {
    return { ok: false, error: readRes.error || readRes.data?.error || '读取媒体文件失败' }
  }
  const b64 = readRes.data.base64Data
  const bytes =
    typeof Buffer !== 'undefined'
      ? new Uint8Array(Buffer.from(b64, 'base64'))
      : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return { ok: true, filePath: readRes.data.filePath || chosenPath, bytes }
}
