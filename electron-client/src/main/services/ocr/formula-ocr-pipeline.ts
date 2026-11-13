/**
 * 公式识别流程（Pix2Text-MFR 1.5）：裁边 → 归一化 → 逐词元贪心解码 → 字节级 BPE 还原 → 整理 LaTeX。
 * 纯计算、不依赖推理库与 Electron，便于单元测试；缩放由调用方完成（主进程用 nativeImage 高质量缩放）。
 */
import type { BgraImage } from './ocr-worker-engine.js'
import { FORMULA_INPUT_SIZE, FORMULA_TOKENS } from './formula-ocr-protocol.js'

export interface ContentLayout {
  /** 内容外接框（含留白），原图像素坐标 */
  x: number
  y: number
  width: number
  height: number
  /** 深色背景（如深色模式截图）：送入模型前要反色成白底深字 */
  darkBackground: boolean
}

/** 与背景亮度相差超过这个值算笔画 */
const INK_CONTRAST = 60

function luminance(data: Uint8Array, offset: number): number {
  const alpha = data[offset + 3]! / 255
  // 透明像素按白色处理（PNG 截图常带透明背景）
  const mix = (value: number) => value * alpha + 255 * (1 - alpha)
  return 0.114 * mix(data[offset]!) + 0.587 * mix(data[offset + 1]!) + 0.299 * mix(data[offset + 2]!)
}

/**
 * 找出公式所在区域：用四条边的亮度中位数估计背景，与背景差别明显的像素算笔画，
 * 外接框四周留出内容高度 10%（至少 4 像素）的空白。框得很松的截图裁掉多余空白后识别更准。
 * 整张图没有笔画时返回 undefined（空白截图）。
 */
export function analyzeContent(image: BgraImage): ContentLayout | undefined {
  const { width, height, data } = image
  if (width < 1 || height < 1 || data.length !== width * height * 4) throw new Error('图片像素数据无效')
  const border: number[] = []
  const step = Math.max(1, Math.floor((width + height) / 400))
  for (let x = 0; x < width; x += step) border.push(luminance(data, x * 4), luminance(data, ((height - 1) * width + x) * 4))
  for (let y = 0; y < height; y += step) border.push(luminance(data, y * width * 4), luminance(data, (y * width + width - 1) * 4))
  border.sort((a, b) => a - b)
  const background = border[Math.floor(border.length / 2)]!
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.abs(luminance(data, (y * width + x) * 4) - background) <= INK_CONTRAST) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return undefined
  const margin = Math.max(4, Math.round((bottom - top + 1) * 0.1))
  const x = Math.max(0, left - margin), y = Math.max(0, top - margin)
  return {
    x,
    y,
    width: Math.min(width, right + margin + 1) - x,
    height: Math.min(height, bottom + margin + 1) - y,
    darkBackground: background < 128
  }
}

/** 反色（深底浅字 → 白底深字），透明像素先按深色背景合成，保持不透明 */
export function invertImage(image: BgraImage): BgraImage {
  const data = new Uint8Array(image.data.length)
  for (let i = 0; i < data.length; i += 4) {
    const alpha = image.data[i + 3]! / 255
    for (let c = 0; c < 3; c++) data[i + c] = 255 - Math.round(image.data[i + c]! * alpha)
    data[i + 3] = 255
  }
  return { width: image.width, height: image.height, data }
}

/** 384×384 BGRA → 模型输入 NCHW（RGB，(v/255 - 0.5) / 0.5），透明像素按白色处理 */
export function toPixelValues(image: BgraImage): Float32Array {
  const size = FORMULA_INPUT_SIZE
  if (image.width !== size || image.height !== size || image.data.length !== size * size * 4) {
    throw new Error(`公式识别输入必须是 ${size}×${size} 像素`)
  }
  const plane = size * size
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    const offset = i * 4
    const alpha = image.data[offset + 3]! / 255
    const value = (channel: number) => ((image.data[offset + channel]! * alpha + 255 * (1 - alpha)) / 255 - 0.5) / 0.5
    out[i] = value(2)
    out[plane + i] = value(1)
    out[2 * plane + i] = value(0)
  }
  return out
}

/** 推理接口：生产由 onnxruntime 实现，测试可替换 */
export interface FormulaModelRunner {
  /** 编码图片，返回不透明的编码结果（交给 nextLogits） */
  encode(pixelValues: Float32Array): Promise<unknown>
  /** 给定已生成的词元，返回下一个词元的 logits（长度为词表大小） */
  nextLogits(encoded: unknown, tokens: readonly number[]): Promise<Float32Array>
}

/** 最多生成的词元数；正常公式远小于此值，防止模型陷入重复时无限循环 */
export const MAX_FORMULA_TOKENS = 512

/** 贪心解码：每步取概率最大的词元直到结束符；分数是各步最大概率的几何平均 */
export async function greedyDecode(runner: FormulaModelRunner, pixelValues: Float32Array, maxTokens = MAX_FORMULA_TOKENS): Promise<{ tokens: number[]; score: number }> {
  const encoded = await runner.encode(pixelValues)
  const tokens: number[] = [FORMULA_TOKENS.bos]
  let logSum = 0
  let steps = 0
  for (; steps < maxTokens; steps++) {
    const logits = await runner.nextLogits(encoded, tokens)
    if (logits.length !== FORMULA_TOKENS.vocabSize) throw new Error('公式识别模型输出维度无效')
    let best = 0
    for (let k = 1; k < logits.length; k++) if (logits[k]! > logits[best]!) best = k
    let total = 0
    for (let k = 0; k < logits.length; k++) total += Math.exp(logits[k]! - logits[best]!)
    logSum += -Math.log(total)
    if (best === FORMULA_TOKENS.eos) { steps++; break }
    tokens.push(best)
  }
  if (tokens.length > maxTokens) throw new Error('公式过长或无法识别')
  return { tokens: tokens.slice(1), score: steps ? Math.exp(logSum / steps) : 0 }
}

/** 字节级 BPE 的字符 → 字节对照表（GPT-2 约定：可见字符映射到自身，其余字节映射到 U+0100 起） */
function byteLevelTable(): Map<string, number> {
  const bytes: number[] = []
  for (let b = 33; b <= 126; b++) bytes.push(b)
  for (let b = 161; b <= 172; b++) bytes.push(b)
  for (let b = 174; b <= 255; b++) bytes.push(b)
  const chars = bytes.slice()
  let extra = 0
  for (let b = 0; b < 256; b++) {
    if (bytes.includes(b)) continue
    bytes.push(b)
    chars.push(256 + extra++)
  }
  return new Map(bytes.map((byte, index) => [String.fromCharCode(chars[index]!), byte]))
}

const BYTE_LEVEL = byteLevelTable()

/** 读取 tokenizer.json 的词表，返回编号 → 词元 */
export function parseVocabulary(tokenizerJson: string): string[] {
  const parsed = JSON.parse(tokenizerJson) as { model?: { type?: unknown; vocab?: unknown } }
  const vocab = parsed.model?.vocab
  if (parsed.model?.type !== 'BPE' || !vocab || typeof vocab !== 'object') throw new Error('公式识别词表格式无效')
  const tokens: string[] = []
  for (const [token, id] of Object.entries(vocab as Record<string, unknown>)) {
    if (!Number.isSafeInteger(id) || (id as number) < 0 || (id as number) >= FORMULA_TOKENS.vocabSize) throw new Error('公式识别词表编号无效')
    tokens[id as number] = token
  }
  if (tokens.length !== FORMULA_TOKENS.vocabSize || tokens.some(token => token === undefined)) throw new Error('公式识别词表与模型不匹配')
  return tokens
}

/** 词元 → 文字：跳过特殊词元，按字节级 BPE 还原 UTF-8 */
export function decodeTokens(tokens: readonly number[], vocabulary: readonly string[]): string {
  const bytes: number[] = []
  for (const id of tokens) {
    if (id < FORMULA_TOKENS.firstText) continue
    const token = vocabulary[id]
    if (token === undefined) throw new Error('公式识别模型输出了词表外的编号')
    for (const char of token) bytes.push(BYTE_LEVEL.get(char) ?? 0x3f)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 只去掉首尾空白，保留字体、分组、文本空格、注释和换行，避免整理源码改变数学含义。 */
export function cleanLatex(raw: string): string {
  return raw.trim()
}
