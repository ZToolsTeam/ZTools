/**
 * PP-OCRv5 文字识别流程（检测 → 裁剪 → 识别 → 排版），纯计算、不依赖推理库，便于单元测试。
 * 前后处理参数与 PaddleOCR / RapidOCR 的默认值一致；检测后处理不依赖 OpenCV，用连通域 + 最小外接矩形实现。
 */

/** BGRA 像素（Electron nativeImage.toBitmap 的格式） */
export type { BgraImage } from './ocr-worker-engine.js'
import type { BgraImage } from './ocr-worker-engine.js'

/** 推理接口：输入 NCHW float32，返回原始输出；生产由 onnxruntime 实现，测试可替换 */
export interface OcrModelRunner {
  /** 检测模型：输出 [1,1,H,W] 的文字概率图 */
  detect(input: Float32Array, height: number, width: number): Promise<Float32Array>
  /** 识别模型：输出 [N,T,C] 的逐时间步字符概率 */
  recognize(input: Float32Array, batch: number, height: number, width: number): Promise<{ data: Float32Array; steps: number; classes: number }>
}

/** 有向矩形：中心、两条单位轴（u 接近水平朝右，v 垂直于 u 朝下）与两轴长度 */
export interface TextBox {
  cx: number
  cy: number
  ux: number
  uy: number
  vx: number
  vy: number
  w: number
  h: number
}

export interface RecognizedLine {
  text: string
  score: number
  box: TextBox
}

const DET_MEAN = [0.485, 0.456, 0.406] as const
const DET_STD = [0.229, 0.224, 0.225] as const
/**
 * 检测输入短边放大到 736，但最多放大 2 倍：截图小字放大后检测更完整，放大过多反而把一行切成碎块（实测）；
 * 总像素不超过 400 万控制耗时。
 */
const DET_MIN_SIDE = 736
const DET_MAX_UPSCALE = 2
const DET_MAX_PIXELS = 4_000_000
const DET_THRESH = 0.3
const DET_BOX_THRESH = 0.5
const DET_UNCLIP_RATIO = 1.6
const DET_MAX_CANDIDATES = 1000
const REC_HEIGHT = 48
/** 识别输入最小宽度（与官方 320 一致，短词补齐后更准），最长不超过高度的 60 倍 */
const REC_MIN_WIDTH = 320
const REC_MAX_WIDTH = REC_HEIGHT * 60
const REC_BATCH = 8
const REC_MIN_SCORE = 0.5

/** 按字典文件内容生成字符表；最后一个空行不算字符 */
export function parseCharacterDictionary(content: string): string[] {
  const lines = content.split('\n').map(line => line.replace(/\r$/, ''))
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 检测模型的输入尺寸：按需放大或缩小，宽高都取 32 的倍数 */
export function detectionSize(width: number, height: number): { width: number; height: number } {
  let ratio = Math.min(width, height) < DET_MIN_SIDE ? Math.min(DET_MAX_UPSCALE, DET_MIN_SIDE / Math.min(width, height)) : 1
  if (width * height * ratio * ratio > DET_MAX_PIXELS) ratio = Math.sqrt(DET_MAX_PIXELS / (width * height))
  return {
    width: Math.max(32, Math.round((width * ratio) / 32) * 32),
    height: Math.max(32, Math.round((height * ratio) / 32) * 32)
  }
}

/** 双线性取 BGRA 第 channel 个通道，坐标越界时取边缘像素 */
function sample(image: BgraImage, x: number, y: number, channel: number): number {
  const { width, height, data } = image
  const cx = Math.min(Math.max(x, 0), width - 1)
  const cy = Math.min(Math.max(y, 0), height - 1)
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, width - 1)
  const y1 = Math.min(y0 + 1, height - 1)
  const fx = cx - x0
  const fy = cy - y0
  const at = (px: number, py: number) => data[(py * width + px) * 4 + channel]!
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
}

/** 检测模型输入：缩放到目标尺寸，按 BGR 通道顺序归一化（与 PaddleOCR 用 OpenCV 读图一致） */
export function detectionInput(image: BgraImage, width: number, height: number): Float32Array {
  const plane = width * height
  const out = new Float32Array(3 * plane)
  const scaleX = image.width / width
  const scaleY = image.height / height
  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) * scaleY - 0.5
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) * scaleX - 0.5
      for (let c = 0; c < 3; c++) out[c * plane + y * width + x] = (sample(image, sx, sy, c) / 255 - DET_MEAN[c]!) / DET_STD[c]!
    }
  }
  return out
}

type Point = readonly [number, number]

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Point[] = []
  const upper: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** 旋转卡壳求凸包的最小面积外接矩形，并把轴规整为 u 接近水平朝右、v 朝下 */
export function minAreaRect(hull: readonly Point[]): TextBox | undefined {
  let best: { area: number; box: TextBox } | undefined
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length === 0) continue
    const ux = (b[0] - a[0]) / length
    const uy = (b[1] - a[1]) / length
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const p of hull) {
      const pu = p[0] * ux + p[1] * uy
      const pv = -p[0] * uy + p[1] * ux
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu)
      minV = Math.min(minV, pv); maxV = Math.max(maxV, pv)
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2
      const cv = (minV + maxV) / 2
      best = { area, box: { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, ux, uy, vx: -uy, vy: ux, w: maxU - minU, h: maxV - minV } }
    }
  }
  if (!best) return undefined
  let { ux, uy, w, h } = best.box
  if (Math.abs(ux) < Math.abs(uy)) { [ux, uy] = [-uy, ux]; [w, h] = [h, w] }
  if (ux < 0) { ux = -ux; uy = -uy }
  return { ...best.box, ux, uy, vx: -uy, vy: ux, w, h }
}

/** 矩形内概率图的平均值（PaddleOCR 的 box_score_fast） */
function boxScore(pred: Float32Array, width: number, height: number, box: TextBox): number {
  const hw = box.w / 2 + 0.5
  const hh = box.h / 2 + 0.5
  const extentX = hw * Math.abs(box.ux) + hh * Math.abs(box.vx)
  const extentY = hw * Math.abs(box.uy) + hh * Math.abs(box.vy)
  const x0 = Math.max(0, Math.floor(box.cx - extentX))
  const x1 = Math.min(width - 1, Math.ceil(box.cx + extentX))
  const y0 = Math.max(0, Math.floor(box.cy - extentY))
  const y1 = Math.min(height - 1, Math.ceil(box.cy + extentY))
  let sum = 0
  let count = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - box.cx
      const dy = y - box.cy
      if (Math.abs(dx * box.ux + dy * box.uy) <= hw && Math.abs(dx * box.vx + dy * box.vy) <= hh) {
        sum += pred[y * width + x]!
        count++
      }
    }
  }
  return count > 0 ? sum / count : 0
}

/**
 * 检测后处理（DB）：概率图二值化 → 8 连通域 → 边界点凸包的最小外接矩形 → 按平均概率过滤 → 按比例外扩。
 * 返回检测图坐标系下的文字框。
 */
export function detectionBoxes(pred: Float32Array, width: number, height: number): TextBox[] {
  if (pred.length !== width * height) throw new Error('Detection model output size does not match input')
  const label = new Uint8Array(width * height)
  const boxes: TextBox[] = []
  const stack: number[] = []
  for (let start = 0; start < pred.length && boxes.length < DET_MAX_CANDIDATES; start++) {
    if (label[start] || pred[start]! <= DET_THRESH) continue
    label[start] = 1
    stack.push(start)
    const border: Point[] = []
    while (stack.length > 0) {
      const p = stack.pop()!
      const x = p % width
      const y = (p - x) / width
      let isBorder = false
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          const straight = dx === 0 || dy === 0
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) { if (straight) isBorder = true; continue }
          const q = ny * width + nx
          if (pred[q]! <= DET_THRESH) { if (straight) isBorder = true; continue }
          if (!label[q]) { label[q] = 1; stack.push(q) }
        }
      }
      if (isBorder) border.push([x, y])
    }
    if (border.length < 4) continue
    const rect = minAreaRect(convexHull(border))
    if (!rect || Math.min(rect.w, rect.h) < 3) continue
    if (boxScore(pred, width, height, rect) < DET_BOX_THRESH) continue
    // 多边形外扩距离 = 面积 × 比例 / 周长；矩形外扩后的最小外接矩形即四边各加该距离
    const distance = (rect.w * rect.h * DET_UNCLIP_RATIO) / (2 * (rect.w + rect.h))
    const expanded = { ...rect, w: rect.w + 2 * distance, h: rect.h + 2 * distance }
    if (Math.min(expanded.w, expanded.h) < 5) continue
    boxes.push(expanded)
  }
  return boxes
}

/** 把检测图坐标系的框换算到原图（两轴缩放比例可能不同） */
export function scaleBox(box: TextBox, scaleX: number, scaleY: number): TextBox {
  const ulen = Math.hypot(box.ux * scaleX, box.uy * scaleY)
  const vlen = Math.hypot(box.vx * scaleX, box.vy * scaleY)
  const ux = (box.ux * scaleX) / ulen
  const uy = (box.uy * scaleY) / ulen
  return { cx: box.cx * scaleX, cy: box.cy * scaleY, ux, uy, vx: -uy, vy: ux, w: box.w * ulen, h: box.h * vlen }
}

/**
 * 识别模型输入：沿框的方向裁出文字行，缩放到高 48、按比例定宽，右侧补零到最小宽度；
 * 竖排（高宽比 ≥ 1.5）先逆时针转 90°，与 PaddleOCR get_rotate_crop_image 一致。
 */
export function recognitionInput(image: BgraImage, box: TextBox): { data: Float32Array; width: number } {
  let { ux, uy, vx, vy, w, h } = box
  let ox = box.cx - (w / 2) * ux - (h / 2) * vx
  let oy = box.cy - (w / 2) * uy - (h / 2) * vy
  if (h / Math.max(w, 1e-6) >= 1.5) {
    ox += w * ux
    oy += w * uy
    ;[ux, uy, vx, vy] = [vx, vy, -ux, -uy]
    ;[w, h] = [h, w]
  }
  const contentWidth = Math.max(1, Math.min(Math.ceil((REC_HEIGHT * w) / Math.max(h, 1)), REC_MAX_WIDTH))
  const width = Math.max(REC_MIN_WIDTH, contentWidth)
  const plane = REC_HEIGHT * width
  const data = new Float32Array(3 * plane)
  const stepX = w / contentWidth
  const stepY = h / REC_HEIGHT
  for (let y = 0; y < REC_HEIGHT; y++) {
    const b = (y + 0.5) * stepY
    for (let x = 0; x < contentWidth; x++) {
      const a = (x + 0.5) * stepX
      const px = ox + a * ux + b * vx - 0.5
      const py = oy + a * uy + b * vy - 0.5
      for (let c = 0; c < 3; c++) data[c * plane + y * width + x] = (sample(image, px, py, c) / 255 - 0.5) / 0.5
    }
  }
  return { data, width }
}

/** CTC 贪心解码：逐步取最大概率，合并重复、去掉空白（下标 0）；末位类别是空格 */
export function ctcDecode(probs: Float32Array, steps: number, classes: number, dictionary: readonly string[]): { text: string; score: number } {
  let text = ''
  let sum = 0
  let count = 0
  let previous = 0
  for (let t = 0; t < steps; t++) {
    let best = 0
    let bestValue = -Infinity
    for (let k = 0; k < classes; k++) {
      const value = probs[t * classes + k]!
      if (value > bestValue) { bestValue = value; best = k }
    }
    if (best !== 0 && best !== previous) {
      text += best <= dictionary.length ? dictionary[best - 1]! : ' '
      sum += bestValue
      count++
    }
    previous = best
  }
  return { text, score: count > 0 ? sum / count : 0 }
}

/** 全角标点（中文、日文标点与全角符号，不含全角字母数字）：同一行相邻两块在标点处直接相连 */
const FULL_WIDTH_PUNCTUATION = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u

/** 同一行的几块文字：检测时分成不同块说明中间有明显间隔，用空格隔开；交界处是全角标点时直接相连 */
function joinRow(texts: readonly string[]): string {
  return texts.reduce((joined, text) => {
    if (!joined) return text
    const separator = FULL_WIDTH_PUNCTUATION.test(joined.at(-1)!) || FULL_WIDTH_PUNCTUATION.test(text[0]!) ? '' : ' '
    return joined + separator + text
  }, '')
}

/** 按阅读顺序排版：纵向中心接近（差距小于较矮者一半高度）的框算同一行，行内从左到右连接 */
export function arrangeLines(lines: readonly RecognizedLine[]): string[] {
  const rows: Array<{ cy: number; h: number; items: RecognizedLine[] }> = []
  for (const line of [...lines].sort((a, b) => a.box.cy - b.box.cy)) {
    const height = Math.min(line.box.w, line.box.h)
    const row = rows.find(item => Math.abs(item.cy - line.box.cy) < Math.min(item.h, height) * 0.5)
    if (row) {
      row.items.push(line)
      row.cy += (line.box.cy - row.cy) / row.items.length
    } else {
      rows.push({ cy: line.box.cy, h: height, items: [line] })
    }
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map(row => joinRow(row.items.sort((a, b) => a.box.cx - b.box.cx).map(item => item.text)))
}

/** 完整识别一张图片，返回按阅读顺序排好的文字行 */
export async function recognizeText(image: BgraImage, runner: OcrModelRunner, dictionary: readonly string[]): Promise<string[]> {
  if (image.width < 1 || image.height < 1 || image.data.length < image.width * image.height * 4) throw new Error('Invalid image pixel data')
  const size = detectionSize(image.width, image.height)
  const pred = await runner.detect(detectionInput(image, size.width, size.height), size.height, size.width)
  const boxes = detectionBoxes(pred, size.width, size.height)
    .map(box => scaleBox(box, image.width / size.width, image.height / size.height))
  const crops = boxes.map(box => ({ box, ...recognitionInput(image, box) })).sort((a, b) => a.width - b.width)
  const recognized: RecognizedLine[] = []
  // 宽度相近的行分批识别，批内补零到同宽
  for (let i = 0; i < crops.length; i += REC_BATCH) {
    const group = crops.slice(i, i + REC_BATCH)
    const width = Math.max(...group.map(item => item.width))
    const plane = REC_HEIGHT * width
    const batch = new Float32Array(group.length * 3 * plane)
    group.forEach((item, n) => {
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < REC_HEIGHT; y++) {
          const from = c * REC_HEIGHT * item.width + y * item.width
          batch.set(item.data.subarray(from, from + item.width), n * 3 * plane + c * plane + y * width)
        }
      }
    })
    const output = await runner.recognize(batch, group.length, REC_HEIGHT, width)
    if (output.classes !== dictionary.length + 2) throw new Error('Recognition model does not match character dictionary')
    const stride = output.steps * output.classes
    group.forEach((item, n) => {
      const { text, score } = ctcDecode(output.data.subarray(n * stride, (n + 1) * stride), output.steps, output.classes, dictionary)
      if (text.trim() && score >= REC_MIN_SCORE) recognized.push({ text: text.trim(), score, box: item.box })
    })
  }
  return arrangeLines(recognized)
}
