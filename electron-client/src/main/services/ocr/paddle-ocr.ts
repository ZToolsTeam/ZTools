/**
 * 本机文字识别（PP-OCRv5）：模型检查、图片解码与子进程入口。
 * 子进程的启动、排队、超时与暂停见 ocr-worker-engine.ts；连续失败暂停后调用方改用系统识别。
 */
import fs from 'node:fs'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { OcrWorkerEngine, wrapUtilityProcess, type BgraImage, type OcrWorkerEngineOptions, type UtilityProcessLike } from './ocr-worker-engine.js'
import { PADDLE_OCR_MODEL_FILES } from './paddle-ocr-protocol.js'

export type { OcrWorkerProcess } from './ocr-worker-engine.js'

/** 识别图片文件，返回按阅读顺序排好的文字行 */
export interface LocalOcrPort {
  recognizeImage(imagePath: string, signal?: AbortSignal): Promise<string[]>
  /** 宿主退出时结束识别进程 */
  stop(): void
}

export type PaddleOcrEngineOptions = Omit<OcrWorkerEngineOptions<string[]>, 'label' | 'parseResult'>

/** 文字识别子进程：成功响应带按阅读顺序排好的文字行 */
export class PaddleOcrEngine extends OcrWorkerEngine<string[]> {
  constructor(options: PaddleOcrEngineOptions) {
    super({
      ...options,
      label: '文字识别',
      parseResult: response => Array.isArray(response.lines) && response.lines.every(line => typeof line === 'string')
        ? response.lines as string[]
        : undefined
    })
  }
}

/** 解码后的像素超过这个数先缩小，避免几十 MB 的位图在进程间复制 */
const MAX_DECODED_PIXELS = 25_000_000

/** 模型文件齐全才启用本机识别；缺文件时调用方改用系统识别 */
export function paddleOcrModelsPresent(modelDirectory: string): boolean {
  return Object.values(PADDLE_OCR_MODEL_FILES).every(name => {
    try { return fs.statSync(path.join(modelDirectory, name)).isFile() } catch { return false }
  })
}

/** 模型目录：安装包在 resources/ocr，开发时在 out/ocr-models（由 npm run fetch:ocr-models 下载） */
export function paddleOcrModelDirectory(isPackaged: boolean, resourcesPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'ocr') : path.resolve(__dirname, '../../../ocr-models')
}

/** Electron nativeImage 的最小接口（便于测试替换） */
export interface DecodableImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): DecodableImage
  toBitmap(): Buffer
}

/** 读取图片为 BGRA 像素；无法解码（格式不支持、文件损坏）时返回 undefined */
export function decodeImage(image: DecodableImage): BgraImage | undefined {
  if (image.isEmpty()) return undefined
  let current = image
  let { width, height } = current.getSize()
  if (width * height > MAX_DECODED_PIXELS) {
    const ratio = Math.sqrt(MAX_DECODED_PIXELS / (width * height))
    current = current.resize({ width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), quality: 'best' })
    ;({ width, height } = current.getSize())
  }
  const data = current.toBitmap()
  if (width < 1 || height < 1 || data.length !== width * height * 4) return undefined
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}

/**
 * Windows 本机识别：模型文件不齐时返回 undefined（调用方改用系统识别）。
 * 图片在主进程用 nativeImage 解码（支持 PNG、JPEG、BMP 等），识别在独立子进程。
 */
export function createLocalOcr(dependencies: {
  modelDirectory: string
  createImageFromPath(imagePath: string): DecodableImage
  forkUtilityProcess(modulePath: string, args: string[], options: { serviceName: string }): UtilityProcessLike
}): LocalOcrPort | undefined {
  if (!paddleOcrModelsPresent(dependencies.modelDirectory)) {
    console.warn(`[PaddleOcr] 识别模型不完整，改用系统文字识别: ${dependencies.modelDirectory}`)
    return undefined
  }
  const engine = new PaddleOcrEngine({
    spawnWorker: () => wrapUtilityProcess(
      dependencies.forkUtilityProcess(path.join(__dirname, 'paddle-ocr-worker.js'), [dependencies.modelDirectory], { serviceName: 'ztools-ocr' }))
  })
  return {
    async recognizeImage(imagePath, signal) {
      const image = decodeImage(dependencies.createImageFromPath(imagePath))
      if (!image) throw new ZToolsError(errorCodes.fileError, '无法读取图片，请确认文件未损坏且格式受支持')
      return engine.recognize(image, signal)
    },
    stop: () => engine.stop()
  }
}
