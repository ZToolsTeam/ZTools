/**
 * 公式识别（Pix2Text-MFR 1.5）：主进程一侧。macOS 与 Windows 共用。
 * 图片在主进程用 nativeImage 解码、裁掉四周空白、缩放到 384×384（深色背景先反色），识别在独立子进程。
 * 模型按需下载（见 formula-model-store.ts），没下载时识别直接报“模型未下载”，不联网识别。
 */
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { analyzeContent, invertImage } from './formula-ocr-pipeline.js'
import type { FormulaModelStatus, FormulaModelStore } from './formula-model-store.js'
import { FORMULA_INPUT_SIZE } from './formula-ocr-protocol.js'
import { OcrWorkerEngine, wrapUtilityProcess, type BgraImage, type OcrWorkerProcess, type UtilityProcessLike } from './ocr-worker-engine.js'

export interface FormulaResult {
  latex: string
  /** 0–1，各步最大概率的几何平均；低于 FORMULA_LOW_CONFIDENCE 时提示用户核对 */
  score: number
  /** 用户请求时返回有大小上限的原图预览，仅供当前会话核对 */
  previewDataUrl?: string
}

/**
 * 词元分数的经验提醒阈值，不代表公式正确率；高分结果同样需要核对。
 */
export const FORMULA_LOW_CONFIDENCE = 0.93

export interface FormulaOcrPort {
  modelStatus(): Promise<FormulaModelStatus>
  downloadModel(): Promise<FormulaModelStatus>
  cancelDownload(): Promise<FormulaModelStatus>
  /** 识别图片文件里的公式；图片里没有内容时 latex 为空字符串 */
  recognizeImage(imagePath: string, signal?: AbortSignal, options?: { includePreview?: boolean }): Promise<FormulaResult>
  stop(): void
}

/** Electron nativeImage 的最小接口（便于测试替换） */
export interface FormulaImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): FormulaImage
  crop(rect: { x: number; y: number; width: number; height: number }): FormulaImage
  toBitmap(): Buffer
  toPNG(): Buffer
}

/** 预览保持原始宽高比与颜色，限制尺寸和编码大小，避免会话缓存堆积大图。 */
export function createFormulaPreview(source: FormulaImage): string | undefined {
  let image = source
  const { width, height } = image.getSize()
  if (image.isEmpty() || width < 1 || height < 1) return undefined
  const scale = Math.min(1, 1600 / Math.max(width, height))
  if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' })
  for (;;) {
    const bytes = image.toPNG()
    if (bytes.length <= 384 * 1024) return `data:image/png;base64,${bytes.toString('base64')}`
    const size = image.getSize()
    if (Math.max(size.width, size.height) <= 200) return undefined
    image = image.resize({ width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)), quality: 'best' })
  }
}

/** 分析空白边前先把大图缩到这个像素数以内（公式截图通常远小于此） */
const MAX_ANALYZE_PIXELS = 4_000_000

function bitmapOf(image: FormulaImage): BgraImage | undefined {
  const { width, height } = image.getSize()
  const data = image.toBitmap()
  if (width < 1 || height < 1 || data.length !== width * height * 4) return undefined
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}

/** 解码 → 裁边 → 缩放到模型输入；图片里没有内容返回 'blank'，无法解码返回 undefined */
export function prepareFormulaImage(source: FormulaImage): BgraImage | 'blank' | undefined {
  if (source.isEmpty()) return undefined
  let image = source
  const { width, height } = image.getSize()
  if (width * height > MAX_ANALYZE_PIXELS) {
    const ratio = Math.sqrt(MAX_ANALYZE_PIXELS / (width * height))
    image = image.resize({ width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), quality: 'best' })
  }
  const pixels = bitmapOf(image)
  if (!pixels) return undefined
  const layout = analyzeContent(pixels)
  if (!layout) return 'blank'
  const size = FORMULA_INPUT_SIZE
  const input = bitmapOf(image.crop(layout).resize({ width: size, height: size, quality: 'best' }))
  if (!input || input.width !== size || input.height !== size) return undefined
  return layout.darkBackground ? invertImage(input) : input
}

/** 同步准备有界输入和预览；返回后不再持有整张 nativeImage，排队和推理只保留小图。 */
function prepareRecognition(source: FormulaImage, includePreview: boolean) {
  const prepared = prepareFormulaImage(source)
  let previewDataUrl: string | undefined
  if (includePreview && prepared && prepared !== 'blank') {
    try {
      previewDataUrl = createFormulaPreview(source)
    } catch (error) {
      console.warn('[FormulaOcr] 无法生成原图预览:', error)
    }
  }
  return { prepared, previewDataUrl }
}

export class FormulaOcrEngine extends OcrWorkerEngine<FormulaResult> {
  constructor(options: { spawnWorker: () => OcrWorkerProcess; timeoutMs?: number; idleMs?: number; now?: () => number }) {
    super({
      // 长公式逐词元解码较慢，超时比文字识别宽
      timeoutMs: 60_000,
      ...options,
      label: '公式识别',
      parseResult: response => typeof response.latex === 'string' && typeof response.score === 'number' && Number.isFinite(response.score)
        ? { latex: response.latex, score: Math.min(1, Math.max(0, response.score)) }
        : undefined
    })
  }
}

export function createFormulaOcr(dependencies: {
  store: FormulaModelStore
  createImageFromPath(imagePath: string): FormulaImage
  forkUtilityProcess(modulePath: string, args: string[], options: { serviceName: string }): UtilityProcessLike
}): FormulaOcrPort {
  const { store } = dependencies
  const engine = new FormulaOcrEngine({
    spawnWorker: () => wrapUtilityProcess(
      dependencies.forkUtilityProcess(path.join(__dirname, 'formula-ocr-worker.js'), [store.directory], { serviceName: 'ztools-formula-ocr' }))
  })
  return {
    modelStatus: () => store.status(),
    downloadModel: () => store.download(),
    cancelDownload: () => store.cancel(),
    async recognizeImage(imagePath, signal, options) {
      if (!(await store.isReady())) throw new ZToolsError(errorCodes.serviceUnavailable, '公式识别模型还没有下载')
      const { prepared, previewDataUrl } = prepareRecognition(dependencies.createImageFromPath(imagePath), options?.includePreview === true)
      if (!prepared) throw new ZToolsError(errorCodes.fileError, '无法读取图片，请确认文件未损坏且格式受支持')
      if (prepared === 'blank') return { latex: '', score: 0 }
      try {
        const result = await engine.recognize(prepared, signal)
        return result.latex && previewDataUrl ? { ...result, previewDataUrl } : result
      } catch (error) {
        // 子进程读不到模型文件（被手动删除或清理）：重新核对模型，界面会回到下载入口
        if (error instanceof Error && /ENOENT|no such file/i.test(error.message)) {
          store.invalidate()
          throw new ZToolsError(errorCodes.fileError, '公式识别模型文件缺失，请重新下载模型')
        }
        throw error
      }
    },
    stop: () => {
      store.stop()
      engine.stop()
    }
  }
}
