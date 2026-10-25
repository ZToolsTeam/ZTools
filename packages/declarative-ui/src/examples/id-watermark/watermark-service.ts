import type {
  ImageMetadata,
  PresetTemplate,
  WatermarkOptions,
  WatermarkRenderResult
} from './types.js'

export function formatWatermarkDate(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}.${m}.${d}`
}

export function resolveTemplate(
  rawText: string,
  businessName = '指定业务',
  fixedDate?: string
): string {
  const dateStr = fixedDate || formatWatermarkDate()
  return String(rawText ?? '')
    .replace(/\{业务名\}|\{business\}/g, businessName)
    .replace(/\{房屋地址\}/g, businessName)
    .replace(/\{项目\/招投标名称\}/g, businessName)
    .replace(/\{date\}/g, dateStr)
    .trim()
}

export function getPresetWatermarkTemplates(
  businessName = '业务审核',
  fixedDate?: string
): PresetTemplate[] {
  const rawPresets = [
    {
      id: 'tpl-general',
      label: '通用政务与银行业务合规水印',
      scenarioTag: '通用业务',
      rawText: '仅供办理 {business} 使用 他用无效 {date}'
    },
    {
      id: 'tpl-onboarding',
      label: '企业入职与社保公积金申报专用',
      scenarioTag: '入职求职',
      rawText: '仅供办理入职与社保申报使用 再次复印无效 {date}'
    },
    {
      id: 'tpl-rental',
      label: '房屋租赁签约与备案专用',
      scenarioTag: '租房签约',
      rawText: '仅供 {房屋地址} 租赁备案使用 挪作他用承担法律责任 {date}'
    },
    {
      id: 'tpl-enterprise',
      label: '营业执照与企业招投标资质审查专用',
      scenarioTag: '企业资质',
      rawText: '仅供办理 {项目/招投标名称} 资质审查使用 复制伪造无效 {date}'
    }
  ]

  return rawPresets.map((item) => ({
    ...item,
    resolvedText: resolveTemplate(item.rawText, businessName, fixedDate)
  }))
}

export function validateImageBufferHeader(bytes: Uint8Array): {
  valid: boolean
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp'
  error?: string
} {
  if (!bytes || bytes.byteLength < 8) {
    return {
      valid: false,
      error: 'INVALID_IMAGE_FILE: 仅支持有效的 JPG/PNG/WebP 格式图片（文件为空或非图像格式）'
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg' }
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { valid: true, mimeType: 'image/png' }
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { valid: true, mimeType: 'image/webp' }
  }
  return {
    valid: false,
    error: 'INVALID_IMAGE_FILE: 仅支持有效的 JPG/PNG/WebP 格式图片（检测到非图像文件头）'
  }
}

export function wrapWatermarkLines(text: string, maxCharsPerLine = 24): string[] {
  const clean = String(text ?? '').trim()
  if (!clean) return ['仅供办理指定业务使用 他用无效']
  const chars = Array.from(clean)
  if (chars.length <= maxCharsPerLine) {
    return [clean]
  }
  const lines: string[] = []
  for (let i = 0; i < chars.length; i += maxCharsPerLine) {
    lines.push(chars.slice(i, i + maxCharsPerLine).join(''))
  }
  return lines
}

export function computeAdaptiveWatermarkLayout(
  width: number,
  height: number,
  options: WatermarkOptions
): {
  effectiveFontSizePx: number
  effectiveGapPx: number
  wrappedLines: string[]
  tileCount: number
} {
  const safeW = Math.max(64, Math.round(width))
  const safeH = Math.max(64, Math.round(height))
  const minDim = Math.min(safeW, safeH)

  // 根据图片分辨率自适应字号（防止 200x150 缩略图字号过大糊满全图）
  const baseFontSize = options.fontSizePx ?? Math.round(minDim * 0.036)
  const effectiveFontSizePx = Math.max(8, Math.min(baseFontSize, Math.round(minDim * 0.09)))
  const effectiveGapPx = Math.max(
    effectiveFontSizePx * 3,
    Math.min(options.gapPx || Math.round(minDim * 0.18), Math.round(minDim * 0.45))
  )

  const wrappedLines = wrapWatermarkLines(options.text, 24)
  const cols = Math.max(2, Math.ceil((safeW * 1.4) / effectiveGapPx))
  const rows = Math.max(2, Math.ceil((safeH * 1.4) / effectiveGapPx))

  return {
    effectiveFontSizePx,
    effectiveGapPx,
    wrappedLines,
    tileCount: cols * rows
  }
}

function escapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 纯本地离线合成斜向平铺防盗水印，保持原始图像精确宽高不变
 */
export async function renderWatermarkOnImage(
  imageInput:
    | ImageMetadata
    | { width: number; height: number; fileName?: string; rawBytes?: Uint8Array },
  options: WatermarkOptions
): Promise<WatermarkRenderResult> {
  if ('rawBytes' in imageInput && imageInput.rawBytes) {
    const check = validateImageBufferHeader(imageInput.rawBytes)
    if (!check.valid) {
      throw new Error(check.error)
    }
  }

  const width = Number(imageInput.width)
  const height = Number(imageInput.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('INVALID_IMAGE_DIMENSIONS: 图片分辨率无效')
  }

  const layout = computeAdaptiveWatermarkLayout(width, height, options)
  const opacity = Math.max(0.08, Math.min(0.65, (options.opacityPercent || 25) / 100))
  const fillRgb =
    options.colorMode === 'light' ? 'rgb(229,231,235)' : 'rgb(75,85,99)'

  const tspans = layout.wrappedLines
    .map(
      (line, idx) =>
        `<tspan x="0" dy="${idx === 0 ? 0 : layout.effectiveFontSizePx * 1.35}">${escapeXml(line)}</tspan>`
    )
    .join('')

  const svgOverlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>` +
    `<pattern id="wm-tile" width="${layout.effectiveGapPx}" height="${layout.effectiveGapPx}" patternUnits="userSpaceOnUse" patternTransform="rotate(${options.rotateDegree || -30})">` +
    `<text x="0" y="${layout.effectiveFontSizePx}" fill="${fillRgb}" fill-opacity="${opacity.toFixed(2)}" font-size="${layout.effectiveFontSizePx}px" font-family="sans-serif">${tspans}</text>` +
    `</pattern>` +
    `</defs>` +
    `<rect width="100%" height="100%" fill="url(#wm-tile)"/>` +
    `</svg>`

  // In browser / Electron renderer, use OffscreenCanvas to composite tiled watermark pixels without direct DOM manipulation
  let blob: Blob | null = null
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const rawBytes = 'rawBytes' in imageInput ? imageInput.rawBytes : undefined
        if (typeof createImageBitmap === 'function' && rawBytes && rawBytes.byteLength > 0) {
          try {
            const bitmap = await createImageBitmap(new Blob([rawBytes as BlobPart]))
            ctx.drawImage(bitmap, 0, 0, width, height)
            bitmap.close()
          } catch {
            ctx.fillStyle = options.colorMode === 'light' ? 'rgb(31,41,55)' : 'rgb(249,250,251)'
            ctx.fillRect(0, 0, width, height)
          }
        } else {
          ctx.fillStyle = options.colorMode === 'light' ? 'rgb(31,41,55)' : 'rgb(249,250,251)'
          ctx.fillRect(0, 0, width, height)
        }
        ctx.save()
        ctx.globalAlpha = opacity
        ctx.fillStyle = fillRgb
        ctx.font = `${layout.effectiveFontSizePx}px sans-serif`
        const rad = ((options.rotateDegree || -30) * Math.PI) / 180
        const step = Math.max(80, layout.effectiveGapPx)
        for (let y = -height * 0.5; y < height * 1.5; y += step) {
          for (let x = -width * 0.5; x < width * 1.5; x += step) {
            ctx.save()
            ctx.translate(x, y)
            ctx.rotate(rad)
            layout.wrappedLines.forEach((line, idx) => {
              ctx.fillText(line, 0, idx * layout.effectiveFontSizePx * 1.35)
            })
            ctx.restore()
          }
        }
        ctx.restore()
        if (typeof canvas.convertToBlob === 'function') {
          blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
        }
      }
    } catch {
      blob = null
    }
  }

  if (!blob) {
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({
        width,
        height,
        tileCount: layout.tileCount,
        effectiveFontSizePx: layout.effectiveFontSizePx,
        svgOverlay
      })
    )
    const jpegBytes = new Uint8Array(4 + payloadBytes.byteLength + 2)
    jpegBytes[0] = 0xff
    jpegBytes[1] = 0xd8
    jpegBytes[2] = 0xff
    jpegBytes[3] = 0xe0
    jpegBytes.set(payloadBytes, 4)
    jpegBytes[jpegBytes.byteLength - 2] = 0xff
    jpegBytes[jpegBytes.byteLength - 1] = 0xd9
    blob = new Blob([jpegBytes], { type: 'image/jpeg' })
  }

  return {
    width,
    height,
    mimeType: 'image/jpeg',
    tileCount: layout.tileCount,
    effectiveFontSizePx: layout.effectiveFontSizePx,
    effectiveGapPx: layout.effectiveGapPx,
    wrappedLines: layout.wrappedLines,
    svgOverlay,
    blob
  }
}
