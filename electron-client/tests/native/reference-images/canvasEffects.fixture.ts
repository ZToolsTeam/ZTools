export type CanvasEffect =
  | { operation: 'watermark'; text: string; fontSize: number; color: string; position: string }
  | { operation: 'border'; width: number; padding: number; color: string; background: string; opacity: number }
  | { operation: 'round'; radii: [number, number, number, number] }
const active = (signal: AbortSignal) => { if (signal.aborted) throw Object.assign(new Error('图片处理已取消'), { code: 'CALLER_DESTROYED' }) }
const color = (value: string) => { if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) throw new Error('图片颜色无效'); return value }
const size = (width: number, height: number) => {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || width * height > 8 * 1024 * 1024) throw new Error('图片超过8Mi像素或8192边长')
}
/** Pure browser canvas renderer, shared by previews and final exports. No paths or host-specific code. */
export async function renderCanvasEffect(bytes: ArrayBuffer, effect: CanvasEffect, signal: AbortSignal) {
  active(signal)
  if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new Error('图片为空或超过16MiB')
  const bitmap = await createImageBitmap(new Blob([bytes]))
  try {
    active(signal); size(bitmap.width, bitmap.height)
    let margin = 0
    if (effect.operation === 'border') {
      if (![effect.width, effect.padding].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2048) ||
          !Number.isFinite(effect.opacity) || effect.opacity < 0 || effect.opacity > 1) throw new Error('边框参数无效')
      color(effect.color); color(effect.background); margin = effect.width + effect.padding
    }
    const width = bitmap.width + margin * 2, height = bitmap.height + margin * 2
    size(width, height)
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建图片处理画布')
    if (effect.operation === 'border') {
      context.fillStyle = effect.background; context.fillRect(0, 0, width, height)
      context.save(); context.globalAlpha = effect.opacity; context.fillStyle = effect.color
      context.fillRect(0, 0, width, effect.width); context.fillRect(0, height - effect.width, width, effect.width)
      context.fillRect(0, effect.width, effect.width, height - effect.width * 2)
      context.fillRect(width - effect.width, effect.width, effect.width, height - effect.width * 2); context.restore()
    } else if (effect.operation === 'round') {
      if (effect.radii.length !== 4 || effect.radii.some(value => !Number.isFinite(value) || value < 0 || value > 4096)) throw new Error('圆角参数无效')
      context.beginPath(); context.roundRect(0, 0, width, height, effect.radii); context.clip()
    } else if (effect.operation !== 'watermark') throw new Error('图片画布操作无效')
    context.drawImage(bitmap, margin, margin)
    if (effect.operation === 'watermark') {
      if (typeof effect.text !== 'string' || !effect.text || Array.from(effect.text).length > 256 ||
          !Number.isFinite(effect.fontSize) || effect.fontSize < 1 || effect.fontSize > 512 ||
          !['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(effect.position)) throw new Error('水印参数无效')
      context.font = effect.fontSize + 'px Arial, sans-serif'; context.fillStyle = color(effect.color)
      context.textBaseline = 'top'
      const measured = context.measureText(effect.text).width, padding = 20
      const x = effect.position === 'center' ? (width - measured) / 2 : effect.position.endsWith('right') ? width - measured - padding : padding
      const y = effect.position === 'center' ? (height - effect.fontSize) / 2 : effect.position.startsWith('bottom') ? height - effect.fontSize - padding : padding
      context.fillText(effect.text, x, y)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0)); active(signal)
    const result = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    active(signal)
    if (!result.byteLength || result.byteLength > 16 * 1024 * 1024) throw new Error('处理后图片超过16MiB')
    return { bytes: result, width, height }
  } finally { bitmap.close() }
}

export interface MergeSettings { direction: 'vertical' | 'horizontal' | 'grid'; canvasSize: number; columns: number; spacing: number; background: string }
export interface MergeLayout { width: number; height: number; rectangles: { x: number; y: number; width: number; height: number }[] }
export function createMergeLayout(images: { width: number; height: number }[], options: MergeSettings): MergeLayout {
  if (!images.length || images.length > 64 || !['vertical', 'horizontal', 'grid'].includes(options.direction) ||
      !Number.isSafeInteger(options.canvasSize) || options.canvasSize < 16 || options.canvasSize > 4096 ||
      !Number.isSafeInteger(options.columns) || options.columns < 1 || options.columns > 8 ||
      !Number.isSafeInteger(options.spacing) || options.spacing < 0 || options.spacing > 256) throw new Error('拼图参数无效')
  images.forEach(image => size(image.width, image.height)); color(options.background)
  const rectangles: MergeLayout['rectangles'] = [], spacing = options.spacing
  let width = options.canvasSize, height = options.canvasSize
  if (options.direction === 'horizontal') {
    const innerHeight = height - spacing * 2
    if (innerHeight <= 0) throw new Error('拼图间距超过画布尺寸')
    let x = spacing
    for (const image of images) {
      const w = Math.max(1, Math.round(image.width * innerHeight / image.height))
      rectangles.push({ x, y: spacing, width: w, height: innerHeight }); x += w + spacing
    }
    width = x
  } else {
    const columns = options.direction === 'grid' ? Math.min(options.columns, images.length) : 1
    const innerWidth = Math.floor((width - spacing * (columns + 1)) / columns)
    if (innerWidth <= 0) throw new Error('拼图间距超过画布尺寸')
    let y = spacing
    for (let offset = 0; offset < images.length; offset += columns) {
      let rowHeight = 0
      for (const [column, image] of images.slice(offset, offset + columns).entries()) {
        const h = Math.max(1, Math.round(image.height * innerWidth / image.width))
        rectangles.push({ x: spacing + column * (innerWidth + spacing), y, width: innerWidth, height: h }); rowHeight = Math.max(rowHeight, h)
      }
      y += rowHeight + spacing
    }
    height = y
  }
  size(width, height); return { width, height, rectangles }
}
/** Read/decode one source at a time so a 64-file merge does not hold every decoded image. */
export async function renderCanvasMerge(images: { width: number; height: number }[], options: MergeSettings,
  load: (index: number) => Promise<ArrayBuffer>, signal: AbortSignal) {
  active(signal)
  const layout = createMergeLayout(images, options), canvas = new OffscreenCanvas(layout.width, layout.height), context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建拼图画布')
  context.fillStyle = options.background; context.fillRect(0, 0, layout.width, layout.height)
  for (const [index, rectangle] of layout.rectangles.entries()) {
    active(signal)
    const bytes = await load(index); active(signal)
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new Error('拼图源文件为空或超过16MiB')
    const bitmap = await createImageBitmap(new Blob([bytes]))
    try {
      active(signal)
      if (bitmap.width !== images[index]!.width || bitmap.height !== images[index]!.height) throw new Error('拼图源图片内容发生变化')
      context.drawImage(bitmap, rectangle.x, rectangle.y, rectangle.width, rectangle.height)
    } finally { bitmap.close() }
    await new Promise<void>(resolve => setTimeout(resolve, 0)); active(signal)
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()); active(signal)
  if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new Error('合并图片超过16MiB')
  return { bytes, width: layout.width, height: layout.height }
}
