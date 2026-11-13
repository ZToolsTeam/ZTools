/**
 * 公式识别模型的下载与本地管理。模型不打进安装包，用户第一次使用时下载到 <数据目录>/Models/<模型 ID>。
 *
 * 状态：missing（没有模型）→ downloading → ready；下载失败回到 failed（带原因，可重试），取消回到 missing。
 * - 同一时间只有一个下载；重复请求直接返回当前进度；
 * - 每个文件依次尝试各下载地址，写到 .download 临时文件，边下边算 SHA-256，校验一致才改名为正式文件；
 * - 已下载且校验一致的文件不重复下载（中断后再下只补缺的文件）；
 * - 一个地址 30 秒没有收到数据就换下一个地址；本次下载里失败过的地址，后面的文件不再尝试（避免每个文件都等一次超时）；
 * - 全部文件校验通过后写入 model.json 标记，之后启动只核对标记与文件大小，不再重新计算校验值。
 * 下载只取模型文件，识别的图片始终在本机处理。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { FORMULA_MODEL, FORMULA_MODEL_TOTAL_BYTES, type FormulaModelFile } from './formula-ocr-protocol.js'

export type FormulaModelStatus =
  | { state: 'missing'; totalBytes: number }
  | { state: 'downloading'; receivedBytes: number; totalBytes: number }
  | { state: 'ready'; totalBytes: number }
  | { state: 'failed'; error: string; totalBytes: number }

export interface FormulaModelStoreOptions {
  /** 模型目录，如 <数据目录>/Models/pix2text-mfr-1.5 */
  directory: string
  /** 生产用 Electron net.fetch（走系统代理），测试用替身 */
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  /** 多久没收到数据就放弃当前地址 */
  stallTimeoutMs?: number
  model?: { id: string; files: readonly FormulaModelFile[]; sources: readonly string[] }
}

const MARKER = 'model.json'

async function sha256OfFile(file: string): Promise<string | undefined> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

export class FormulaModelStore {
  readonly directory: string
  readonly #fetch: FormulaModelStoreOptions['fetch']
  readonly #stallTimeoutMs: number
  readonly #model: NonNullable<FormulaModelStoreOptions['model']>
  readonly #totalBytes: number
  #ready: boolean | undefined
  #download: { controller: AbortController; receivedBytes: number; done: Promise<void> } | undefined
  #lastError: string | undefined

  constructor(options: FormulaModelStoreOptions) {
    this.directory = options.directory
    this.#fetch = options.fetch
    this.#stallTimeoutMs = options.stallTimeoutMs ?? 30_000
    this.#model = options.model ?? FORMULA_MODEL
    this.#totalBytes = this.#model.files.reduce((sum, file) => sum + file.size, 0)
    if (!options.model && this.#totalBytes !== FORMULA_MODEL_TOTAL_BYTES) throw new Error('公式识别模型清单无效')
  }

  async status(): Promise<FormulaModelStatus> {
    const totalBytes = this.#totalBytes
    if (this.#download) return { state: 'downloading', receivedBytes: this.#download.receivedBytes, totalBytes }
    if (await this.isReady()) return { state: 'ready', totalBytes }
    if (this.#lastError) return { state: 'failed', error: this.#lastError, totalBytes }
    return { state: 'missing', totalBytes }
  }

  /** 模型文件齐全且与标记一致（标记只在全部校验通过后写入） */
  async isReady(): Promise<boolean> {
    if (this.#ready !== undefined) return this.#ready
    this.#ready = await this.#checkMarker()
    return this.#ready
  }

  /** 开始下载（已在下载时不重复开始）；立即返回当前状态，进度用 status() 查询 */
  async download(): Promise<FormulaModelStatus> {
    if (!this.#download && !(await this.isReady())) {
      const controller = new AbortController()
      const run = { controller, receivedBytes: 0, done: Promise.resolve() }
      this.#download = run
      this.#lastError = undefined
      run.done = this.#downloadAll(run).then(
        () => { this.#ready = true },
        (error: unknown) => {
          // 取消不算失败：回到“没有模型”，下次重新开始（已校验的文件会保留）
          this.#lastError = controller.signal.aborted ? undefined : (error instanceof Error ? error.message : String(error))
          if (this.#lastError) console.warn('[FormulaModel] 下载失败:', this.#lastError)
        }
      ).finally(() => { if (this.#download === run) this.#download = undefined })
    }
    return this.status()
  }

  /** 取消正在进行的下载；没有下载时无操作 */
  async cancel(): Promise<FormulaModelStatus> {
    const run = this.#download
    if (run) {
      run.controller.abort()
      await run.done
    }
    return this.status()
  }

  /** 模型文件在使用中被删除等情况：下次查询重新核对 */
  invalidate(): void {
    if (!this.#download) this.#ready = undefined
  }

  /** 宿主退出时停止下载 */
  stop(): void {
    this.#download?.controller.abort()
  }

  /** 等待当前下载结束（测试用） */
  async settled(): Promise<void> {
    await this.#download?.done
  }

  async #checkMarker(): Promise<boolean> {
    try {
      const marker = JSON.parse(await fs.readFile(path.join(this.directory, MARKER), 'utf8')) as { id?: unknown; files?: unknown }
      if (marker.id !== this.#model.id || !Array.isArray(marker.files)) return false
      const recorded = new Map((marker.files as Array<{ name?: unknown; sha256?: unknown }>).map(item => [item.name, item.sha256]))
      for (const file of this.#model.files) {
        if (recorded.get(file.name) !== file.sha256) return false
        const stat = await fs.stat(path.join(this.directory, file.name))
        if (!stat.isFile() || stat.size !== file.size) return false
      }
      return true
    } catch {
      return false
    }
  }

  async #downloadAll(run: { controller: AbortController; receivedBytes: number }): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    // 标记先删掉：下载过程中中断不会留下“看起来已就绪”的目录
    await fs.rm(path.join(this.directory, MARKER), { force: true })
    const failedSources = new Set<string>()
    for (const file of this.#model.files) {
      const target = path.join(this.directory, file.name)
      if (await sha256OfFile(target) === file.sha256) {
        run.receivedBytes += file.size
        continue
      }
      const base = run.receivedBytes
      const issues: string[] = []
      let done = false
      // 全部地址都失败过时仍逐个重试一遍，不因为前面的文件失败就直接放弃
      const sources = this.#model.sources.filter(source => !failedSources.has(source))
      for (const source of sources.length ? sources : this.#model.sources) {
        if (run.controller.signal.aborted) throw new ZToolsError(errorCodes.cancelled, '下载已取消')
        try {
          await this.#downloadFile(source + file.name, file, target, run.controller.signal, bytes => { run.receivedBytes = base + bytes })
          done = true
          break
        } catch (error) {
          if (run.controller.signal.aborted) throw new ZToolsError(errorCodes.cancelled, '下载已取消')
          issues.push(`${new URL(source).host}：${error instanceof Error ? error.message : String(error)}`)
          failedSources.add(source)
          run.receivedBytes = base
        }
      }
      if (!done) throw new ZToolsError(errorCodes.networkError, `下载 ${file.name} 失败（${issues.join('；')}）`)
      run.receivedBytes = base + file.size
    }
    const marker = { id: this.#model.id, files: this.#model.files.map(file => ({ name: file.name, sha256: file.sha256 })) }
    await fs.writeFile(path.join(this.directory, MARKER), JSON.stringify(marker, null, 2))
  }

  async #downloadFile(url: string, file: FormulaModelFile, target: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let stallTimer: NodeJS.Timeout | undefined
    let stalled = false
    const armStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => { stalled = true; controller.abort() }, this.#stallTimeoutMs)
    }
    const temporary = `${target}.download`
    try {
      armStall()
      const response = await this.#fetch(url, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) !== file.size && (response.headers.get('content-encoding') ?? 'identity') === 'identity') {
        throw new Error('文件大小与清单不一致')
      }
      const hash = createHash('sha256')
      const output = createWriteStream(temporary)
      const closed = new Promise<void>((resolve, reject) => { output.on('close', resolve); output.on('error', reject) })
      // 写盘出错（磁盘满、没有权限）时写入流不会再发 drain，等待要同时监听 error，否则下载会一直停在“下载中”
      closed.catch(() => undefined)
      const drained = () => new Promise<void>((resolve, reject) => {
        const onDrain = () => { output.off('error', onError); resolve() }
        const onError = (error: Error) => { output.off('drain', onDrain); reject(error) }
        output.once('drain', onDrain)
        output.once('error', onError)
      })
      let bytes = 0
      try {
        const reader = response.body.getReader()
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          armStall()
          bytes += part.value.byteLength
          if (bytes > file.size) throw new Error('文件大小与清单不一致')
          hash.update(part.value)
          if (!output.write(part.value)) await drained()
          progress(bytes)
        }
      } finally {
        output.end()
        await closed
      }
      if (bytes !== file.size) throw new Error('文件不完整')
      if (hash.digest('hex') !== file.sha256) throw new Error('校验值不一致')
      await fs.rename(temporary, target)
    } catch (error) {
      // 校验失败等提前结束时取消请求，不让连接在后台继续下载
      controller.abort()
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      if (stalled) throw new Error(`${Math.round(this.#stallTimeoutMs / 1000)} 秒没有收到数据`)
      throw error
    } finally {
      clearTimeout(stallTimer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
