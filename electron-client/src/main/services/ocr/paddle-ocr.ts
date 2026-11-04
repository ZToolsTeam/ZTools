/**
 * 本机文字识别（PP-OCRv5）：主进程一侧的子进程管理。
 * - 第一次识别时才启动子进程，空闲一段时间后结束，释放模型占用的内存；
 * - 请求逐个发送：取消或超时只结束当前子进程，下次识别重新启动；
 * - 子进程一分钟内连续崩溃或超时达到上限后暂停使用，调用方改用系统识别。
 */
import fs from 'node:fs'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { BgraImage } from './paddle-ocr-pipeline.js'
import { PADDLE_OCR_MODEL_FILES, type PaddleOcrWorkerRequest, type PaddleOcrWorkerResponse } from './paddle-ocr-protocol.js'

/** 识别图片文件，返回按阅读顺序排好的文字行 */
export interface LocalOcrPort {
  recognizeImage(imagePath: string, signal?: AbortSignal): Promise<string[]>
  /** 宿主退出时结束识别进程 */
  stop(): void
}

export interface OcrWorkerProcess {
  postMessage(message: PaddleOcrWorkerRequest): void
  onMessage(handler: (message: unknown) => void): void
  onExit(handler: (code: number | null) => void): void
  kill(): void
}

export interface PaddleOcrEngineOptions {
  /** 启动子进程（生产用 utilityProcess.fork，测试用 child_process.fork 或替身） */
  spawnWorker: () => OcrWorkerProcess
  timeoutMs?: number
  idleMs?: number
  maxFailuresPerMinute?: number
  now?: () => number
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

interface InFlight {
  id: number
  resolve(lines: string[]): void
  reject(error: Error): void
}

export class PaddleOcrEngine {
  readonly #spawnWorker: () => OcrWorkerProcess
  readonly #timeoutMs: number
  readonly #idleMs: number
  readonly #maxFailures: number
  readonly #now: () => number
  #worker: OcrWorkerProcess | undefined
  #inFlight: InFlight | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #nextId = 0
  #failures: number[] = []

  constructor(options: PaddleOcrEngineOptions) {
    this.#spawnWorker = options.spawnWorker
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#idleMs = options.idleMs ?? 60_000
    this.#maxFailures = options.maxFailuresPerMinute ?? 3
    this.#now = options.now ?? Date.now
  }

  /** 一分钟内失败次数达到上限后暂停使用 */
  get suspended(): boolean {
    const since = this.#now() - 60_000
    this.#failures = this.#failures.filter(time => time > since)
    return this.#failures.length >= this.#maxFailures
  }

  recognize(image: BgraImage, signal?: AbortSignal): Promise<string[]> {
    const run = this.#queue.then(() => this.#run(image, signal))
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** 宿主退出时结束子进程 */
  stop(): void {
    this.#clearIdle()
    this.#terminate(new ZToolsError(errorCodes.appStopping, '应用正在退出'))
  }

  #run(image: BgraImage, signal?: AbortSignal): Promise<string[]> {
    if (signal?.aborted) return Promise.reject(new ZToolsError(errorCodes.cancelled, 'OCR 识别已取消'))
    if (this.suspended) return Promise.reject(new ZToolsError(errorCodes.serviceUnavailable, '本机文字识别连续失败，已暂停使用'))
    this.#clearIdle()
    return new Promise<string[]>((resolve, reject) => {
      let worker: OcrWorkerProcess
      try {
        worker = this.#ensureWorker()
      } catch (error) {
        this.#failures.push(this.#now())
        reject(new ZToolsError(errorCodes.processError, `无法启动文字识别进程：${error instanceof Error ? error.message : String(error)}`))
        return
      }
      const id = ++this.#nextId
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.#inFlight?.id === id) this.#inFlight = undefined
        this.#scheduleIdle()
      }
      const timer = setTimeout(() => {
        this.#failures.push(this.#now())
        this.#terminate(new ZToolsError(errorCodes.requestTimeout, '本机文字识别超时'))
      }, this.#timeoutMs)
      const onAbort = () => this.#terminate(new ZToolsError(errorCodes.cancelled, 'OCR 识别已取消'))
      this.#inFlight = {
        id,
        resolve: lines => { finish(); resolve(lines) },
        reject: error => { finish(); reject(error) }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ type: 'recognize', id, width: image.width, height: image.height, data: image.data })
      } catch (error) {
        this.#failures.push(this.#now())
        this.#terminate(new ZToolsError(errorCodes.processError, `无法发送识别请求：${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  #ensureWorker(): OcrWorkerProcess {
    if (this.#worker) return this.#worker
    const worker = this.#spawnWorker()
    this.#worker = worker
    worker.onMessage(message => {
      if (worker !== this.#worker) return
      const response = message as PaddleOcrWorkerResponse | null
      const inFlight = this.#inFlight
      if (!inFlight || !response || response.id !== inFlight.id) return
      if (response.ok === true && Array.isArray(response.lines) && response.lines.every(line => typeof line === 'string')) {
        inFlight.resolve(response.lines)
      } else if (response.ok === false && typeof response.error === 'string') {
        inFlight.reject(new ZToolsError(errorCodes.processError, response.error))
      } else {
        inFlight.reject(new ZToolsError(errorCodes.processError, '文字识别进程返回了无效结果'))
      }
    })
    worker.onExit(code => {
      if (worker !== this.#worker) return
      this.#worker = undefined
      if (this.#inFlight) {
        this.#failures.push(this.#now())
        this.#inFlight.reject(new ZToolsError(errorCodes.processError, `文字识别进程意外退出（退出码 ${code ?? '未知'}）`))
      }
    })
    return worker
  }

  /** 结束当前子进程，正在进行的识别以 error 失败 */
  #terminate(error: Error): void {
    const worker = this.#worker
    this.#worker = undefined
    const inFlight = this.#inFlight
    this.#inFlight = undefined
    try { worker?.kill() } catch (killError) { console.warn('[PaddleOcr] 结束文字识别进程失败:', killError) }
    inFlight?.reject(error)
  }

  #scheduleIdle(): void {
    this.#clearIdle()
    if (!this.#worker) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (!this.#inFlight) this.#terminate(new ZToolsError(errorCodes.cancelled, '文字识别进程已空闲退出'))
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }
}

/** Electron utilityProcess 子进程的最小接口 */
interface UtilityProcessLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
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
    spawnWorker: () => {
      const child = dependencies.forkUtilityProcess(path.join(__dirname, 'paddle-ocr-worker.js'), [dependencies.modelDirectory], { serviceName: 'ztools-ocr' })
      return {
        postMessage: message => child.postMessage(message),
        onMessage: handler => { child.on('message', handler) },
        onExit: handler => { child.on('exit', handler) },
        kill: () => { child.kill() }
      }
    }
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
