/**
 * 本机识别子进程管理（文字识别与公式识别共用）：
 * - 第一次识别时才启动子进程，空闲一段时间后结束，释放模型占用的内存；
 * - 请求逐个发送：取消或超时只结束当前子进程，下次识别重新启动；
 * - 子进程一分钟内连续崩溃或超时达到上限后暂停使用。
 */
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'

/** BGRA 像素图 */
export interface BgraImage {
  width: number
  height: number
  data: Uint8Array
}

/** 发给识别子进程的请求：一张 BGRA 图片 */
export interface OcrWorkerImageRequest {
  type: 'recognize'
  id: number
  width: number
  height: number
  /** BGRA 像素 */
  data: Uint8Array
}

export interface OcrWorkerProcess {
  postMessage(message: OcrWorkerImageRequest): void
  onMessage(handler: (message: unknown) => void): void
  onExit(handler: (code: number | null) => void): void
  kill(): void
}

export interface OcrWorkerEngineOptions<Result> {
  /** 启动子进程（生产用 utilityProcess.fork，测试用 child_process.fork 或替身） */
  spawnWorker: () => OcrWorkerProcess
  /** 用在错误信息里的名称，如“文字识别” */
  label: string
  /** 从成功响应里取出结果；格式不对返回 undefined */
  parseResult: (response: Record<string, unknown>) => Result | undefined
  timeoutMs?: number
  idleMs?: number
  maxFailuresPerMinute?: number
  now?: () => number
}

interface InFlight<Result> {
  id: number
  resolve(result: Result): void
  reject(error: Error): void
}

export class OcrWorkerEngine<Result> {
  readonly #spawnWorker: () => OcrWorkerProcess
  readonly #label: string
  readonly #parseResult: (response: Record<string, unknown>) => Result | undefined
  readonly #timeoutMs: number
  readonly #idleMs: number
  readonly #maxFailures: number
  readonly #now: () => number
  #worker: OcrWorkerProcess | undefined
  #inFlight: InFlight<Result> | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #nextId = 0
  #failures: number[] = []

  constructor(options: OcrWorkerEngineOptions<Result>) {
    this.#spawnWorker = options.spawnWorker
    this.#label = options.label
    this.#parseResult = options.parseResult
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

  recognize(image: BgraImage, signal?: AbortSignal): Promise<Result> {
    const run = this.#queue.then(() => this.#run(image, signal))
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** 宿主退出时结束子进程 */
  stop(): void {
    this.#clearIdle()
    this.#terminate(new ZToolsError(errorCodes.appStopping, 'Application is shutting down'))
  }

  #run(image: BgraImage, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted) return Promise.reject(new ZToolsError(errorCodes.cancelled, 'OCR recognition cancelled'))
    if (this.suspended) return Promise.reject(new ZToolsError(errorCodes.serviceUnavailable, `Local ${this.#label} suspended after consecutive failures`))
    this.#clearIdle()
    return new Promise<Result>((resolve, reject) => {
      let worker: OcrWorkerProcess
      try {
        worker = this.#ensureWorker()
      } catch (error) {
        this.#failures.push(this.#now())
        reject(new ZToolsError(errorCodes.processError, `Failed to start ${this.#label} worker: ${error instanceof Error ? error.message : String(error)}`))
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
        this.#terminate(new ZToolsError(errorCodes.requestTimeout, `Local ${this.#label} timed out`))
      }, this.#timeoutMs)
      const onAbort = () => this.#terminate(new ZToolsError(errorCodes.cancelled, 'OCR recognition cancelled'))
      this.#inFlight = {
        id,
        resolve: result => { finish(); resolve(result) },
        reject: error => { finish(); reject(error) }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ type: 'recognize', id, width: image.width, height: image.height, data: image.data })
      } catch (error) {
        this.#failures.push(this.#now())
        this.#terminate(new ZToolsError(errorCodes.processError, `Failed to send recognition request: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  #ensureWorker(): OcrWorkerProcess {
    if (this.#worker) return this.#worker
    const worker = this.#spawnWorker()
    this.#worker = worker
    worker.onMessage(message => {
      if (worker !== this.#worker) return
      const response = message as Record<string, unknown> | null
      const inFlight = this.#inFlight
      if (!inFlight || !response || typeof response !== 'object' || response.id !== inFlight.id) return
      const result = response.ok === true ? this.#parseResult(response) : undefined
      if (result !== undefined) {
        inFlight.resolve(result)
      } else if (response.ok === false && typeof response.error === 'string') {
        inFlight.reject(new ZToolsError(errorCodes.processError, response.error))
      } else {
        inFlight.reject(new ZToolsError(errorCodes.processError, `${this.#label} worker returned an invalid result`))
      }
    })
    worker.onExit(code => {
      if (worker !== this.#worker) return
      this.#worker = undefined
      if (this.#inFlight) {
        this.#failures.push(this.#now())
        this.#inFlight.reject(new ZToolsError(errorCodes.processError, `${this.#label} worker exited unexpectedly (exit code ${code ?? 'unknown'})`))
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
    try { worker?.kill() } catch (killError) { console.warn(`[OcrWorker] Failed to terminate ${this.#label} worker:`, killError) }
    inFlight?.reject(error)
  }

  #scheduleIdle(): void {
    this.#clearIdle()
    if (!this.#worker) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (!this.#inFlight) this.#terminate(new ZToolsError(errorCodes.cancelled, `${this.#label} worker exited after idle timeout`))
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }
}

/** Electron utilityProcess 子进程的最小接口 */
export interface UtilityProcessLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

/** 把 utilityProcess 包装成识别子进程接口 */
export function wrapUtilityProcess(child: UtilityProcessLike): OcrWorkerProcess {
  return {
    postMessage: message => child.postMessage(message),
    onMessage: handler => { child.on('message', handler) },
    onExit: handler => { child.on('exit', handler) },
    kill: () => { child.kill() }
  }
}
