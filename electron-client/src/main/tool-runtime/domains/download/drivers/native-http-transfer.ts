import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolTaskId
} from '../../../../../contracts/tool-runtime/common.js'
import type {
  DownloadTransferRecord,
  DownloadTransferState
} from '../../../../../contracts/tool-runtime/domains/download.js'
import {
  createToolRuntimeError,
  extractToolProgressFailureMeta,
  formatErrorMessage
} from '../../../core/errors.js'
import type { ToolTaskProgressPayload } from '../../../core/task-manager.js'
import type { ResolvedDownloadTransferAddJob } from '../driver.js'

/**
 * 平台原生多连接 HTTP Range 断点续传下载引擎：
 * - 支持 HEAD 探测 Accept-Ranges: bytes 后的多连接（1~16）并发分片写入同一 .part 文件；
 * - 支持暂停（保留已下载进度与分片状态）、恢复（按已落盘偏移续传）、取消（立即清理 .part）；
 * - 支持字节级令牌桶限速与完成后 SHA-256 完整性校验，校验通过后原子重命名至目标文件；
 * - 零外部二进制依赖，Windows / macOS 双端均可无预下载直接就绪。
 */

interface RangeSegment {
  readonly index: number
  readonly start: number
  readonly end: number
  downloaded: number
  completed: boolean
}

interface ManagedTransfer {
  readonly taskId: ToolTaskId
  readonly url: string
  readonly outputDir: string
  readonly fileName: string
  readonly finalPath: string
  readonly partPath: string
  readonly maxConnections: number
  readonly maxRateBytesPerSec?: number
  readonly overwrite: boolean
  readonly expectedSha256?: string
  readonly createdAt: number
  readonly onProgress?: (payload: ToolTaskProgressPayload) => void
  state: DownloadTransferState
  downloadedBytes: number
  totalBytes?: number
  supportsRanges: boolean
  segments: RangeSegment[]
  speedBytesPerSec: number
  activeConnections: number
  errorCode?: string
  errorMessage?: string
  updatedAt: number
  controller?: AbortController
  runPromise?: Promise<void>
}

export interface NativeHttpTransferEngineOptions {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

export class NativeHttpTransferEngine {
  readonly #fetchImpl: typeof fetch
  readonly #now: () => number
  readonly #transfers = new Map<ToolTaskId, ManagedTransfer>()
  #stopped = false

  constructor(options: NativeHttpTransferEngineOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
  }

  async add(
    job: ResolvedDownloadTransferAddJob,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<DownloadTransferRecord> {
    if (this.#stopped) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskCancelled,
        'Download transfer engine is stopped'
      )
    }
    if (this.#transfers.has(job.taskId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        `Transfer task "${job.taskId}" already exists`
      )
    }
    await fs.mkdir(job.outputDir, { recursive: true })
    const finalPath = path.join(job.outputDir, job.fileName)
    if (!job.overwrite) {
      const exists = await fs.lstat(finalPath).then(() => true).catch(() => false)
      if (exists) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.policyViolation,
          `Output file "${job.fileName}" already exists and overwrite is false`
        )
      }
    }

    const nowMs = this.#now()
    const transfer: ManagedTransfer = {
      taskId: job.taskId,
      url: job.url,
      outputDir: job.outputDir,
      fileName: job.fileName,
      finalPath,
      partPath: `${finalPath}.${job.taskId.replace(/[^A-Za-z0-9_-]/g, '_')}.ztools-part`,
      maxConnections: job.maxConnections,
      ...(job.maxRateBytesPerSec !== undefined ? { maxRateBytesPerSec: job.maxRateBytesPerSec } : {}),
      overwrite: job.overwrite,
      ...(job.expectedSha256 !== undefined ? { expectedSha256: job.expectedSha256 } : {}),
      createdAt: nowMs,
      ...(onProgress ? { onProgress } : {}),
      state: 'queued',
      downloadedBytes: 0,
      supportsRanges: false,
      segments: [],
      speedBytesPerSec: 0,
      activeConnections: 0,
      updatedAt: nowMs
    }
    this.#transfers.set(job.taskId, transfer)
    this.#startTransfer(transfer)
    return this.#snapshot(transfer)
  }

  async pause(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    const transfer = this.#requireTransfer(taskId)
    if (transfer.state === 'completed' || transfer.state === 'cancelled') {
      return this.#snapshot(transfer)
    }
    transfer.state = 'paused'
    transfer.speedBytesPerSec = 0
    transfer.activeConnections = 0
    transfer.updatedAt = this.#now()
    transfer.controller?.abort('paused')
    if (transfer.runPromise) {
      await transfer.runPromise.catch(() => undefined)
    }
    return this.#snapshot(transfer)
  }

  async resume(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    const transfer = this.#requireTransfer(taskId)
    if (transfer.state !== 'paused' && transfer.state !== 'failed') {
      return this.#snapshot(transfer)
    }
    delete transfer.errorCode
    delete transfer.errorMessage
    transfer.state = 'queued'
    transfer.updatedAt = this.#now()
    this.#startTransfer(transfer)
    return this.#snapshot(transfer)
  }

  async cancel(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    const transfer = this.#requireTransfer(taskId)
    if (transfer.state === 'completed') {
      return this.#snapshot(transfer)
    }
    transfer.state = 'cancelled'
    transfer.speedBytesPerSec = 0
    transfer.activeConnections = 0
    transfer.updatedAt = this.#now()
    transfer.controller?.abort('cancelled')
    if (transfer.runPromise) {
      await transfer.runPromise.catch(() => undefined)
    }
    await fs.unlink(transfer.partPath).catch(() => undefined)
    transfer.onProgress?.({ phase: 'cancelled' })
    return this.#snapshot(transfer)
  }

  status(taskId?: ToolTaskId): readonly DownloadTransferRecord[] {
    if (taskId !== undefined) {
      const transfer = this.#transfers.get(taskId)
      if (!transfer) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.taskNotFound,
          `Transfer task "${taskId}" was not found`
        )
      }
      return [this.#snapshot(transfer)]
    }
    return Array.from(this.#transfers.values()).map((item) => this.#snapshot(item))
  }

  async stop(): Promise<void> {
    this.#stopped = true
    const running: Promise<void>[] = []
    for (const transfer of this.#transfers.values()) {
      if (transfer.state === 'running' || transfer.state === 'queued') {
        transfer.state = 'cancelled'
        transfer.controller?.abort('stopped')
      }
      if (transfer.runPromise) {
        running.push(transfer.runPromise.catch(() => undefined))
      }
    }
    await Promise.allSettled(running)
  }

  #requireTransfer(taskId: ToolTaskId): ManagedTransfer {
    const transfer = this.#transfers.get(taskId)
    if (!transfer) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskNotFound,
        `Transfer task "${taskId}" was not found`
      )
    }
    return transfer
  }

  #snapshot(transfer: ManagedTransfer): DownloadTransferRecord {
    return {
      taskId: transfer.taskId,
      url: transfer.url,
      fileName: transfer.fileName,
      state: transfer.state,
      downloadedBytes: transfer.downloadedBytes,
      ...(transfer.totalBytes !== undefined ? { totalBytes: transfer.totalBytes } : {}),
      speedBytesPerSec: transfer.speedBytesPerSec,
      connections: transfer.activeConnections,
      ...(transfer.errorCode !== undefined ? { errorCode: transfer.errorCode } : {}),
      ...(transfer.errorMessage !== undefined ? { errorMessage: transfer.errorMessage } : {}),
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt
    }
  }

  #startTransfer(transfer: ManagedTransfer): void {
    const controller = new AbortController()
    transfer.controller = controller
    transfer.state = 'running'
    transfer.updatedAt = this.#now()

    const promise = this.#executeTransfer(transfer, controller.signal)
      .catch((error: unknown) => {
        if (transfer.state === 'paused' || transfer.state === 'cancelled') {
          return
        }
        const failure = extractToolProgressFailureMeta(error)
        transfer.state = 'failed'
        transfer.speedBytesPerSec = 0
        transfer.activeConnections = 0
        transfer.errorCode = failure.errorCode
        transfer.errorMessage = formatErrorMessage(error)
        transfer.updatedAt = this.#now()
        transfer.onProgress?.({
          phase: 'failed',
          errorCode: failure.errorCode,
          retryable: failure.retryable,
          userAction: failure.userAction,
          message: transfer.errorMessage
        })
      })
      .finally(() => {
        if (transfer.controller === controller) {
          delete transfer.controller
        }
      })

    transfer.runPromise = promise
  }

  async #executeTransfer(transfer: ManagedTransfer, signal: AbortSignal): Promise<void> {
    if (transfer.segments.length === 0) {
      await this.#probeRemoteAndPlanSegments(transfer, signal)
    }

    if (transfer.supportsRanges && transfer.totalBytes !== undefined && transfer.totalBytes > 0 && transfer.segments.length > 0) {
      await this.#runSegmentedRangeDownload(transfer, signal)
    } else {
      await this.#runSingleStreamDownload(transfer, signal)
    }

    if (signal.aborted || transfer.state !== 'running') return

    // 完成后可选 SHA-256 校验，再原子落盘至最终文件
    transfer.onProgress?.({
      phase: 'finalizing',
      percent: 99,
      transferredBytes: transfer.downloadedBytes,
      ...(transfer.totalBytes !== undefined ? { totalBytes: transfer.totalBytes } : {})
    })
    if (transfer.expectedSha256) {
      const actualDigest = await computeFileSha256(transfer.partPath)
      if (actualDigest !== transfer.expectedSha256) {
        await fs.unlink(transfer.partPath).catch(() => undefined)
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Downloaded file SHA-256 mismatch (expected ${transfer.expectedSha256}, got ${actualDigest})`
        )
      }
    }

    await fs.rename(transfer.partPath, transfer.finalPath)
    transfer.state = 'completed'
    transfer.speedBytesPerSec = 0
    transfer.activeConnections = 0
    transfer.updatedAt = this.#now()
    transfer.onProgress?.({
      phase: 'completed',
      percent: 100,
      transferredBytes: transfer.downloadedBytes,
      ...(transfer.totalBytes !== undefined ? { totalBytes: transfer.totalBytes } : {})
    })
  }

  async #probeRemoteAndPlanSegments(transfer: ManagedTransfer, signal: AbortSignal): Promise<void> {
    try {
      const headRes = await this.#fetchImpl(transfer.url, {
        method: 'HEAD',
        signal,
        cache: 'no-store'
      })
      if (headRes.ok) {
        const lenHeader = headRes.headers.get('content-length')
        const acceptRanges = headRes.headers.get('accept-ranges') ?? ''
        const total = lenHeader ? Number(lenHeader) : Number.NaN
        if (Number.isSafeInteger(total) && total > 0) {
          transfer.totalBytes = total
          transfer.supportsRanges = acceptRanges.toLowerCase().includes('bytes')
        }
      }
    } catch {
      // HEAD 失败时优雅降级到 GET 单流下载
    }

    if (transfer.supportsRanges && transfer.totalBytes !== undefined && transfer.totalBytes > 0) {
      const connCount = Math.min(transfer.maxConnections, Math.max(1, Math.ceil(transfer.totalBytes / (64 * 1024))))
      const chunkSize = Math.ceil(transfer.totalBytes / connCount)
      const segments: RangeSegment[] = []
      for (let i = 0; i < connCount; i += 1) {
        const start = i * chunkSize
        const end = Math.min(transfer.totalBytes - 1, start + chunkSize - 1)
        if (start <= end) {
          segments.push({ index: i, start, end, downloaded: 0, completed: false })
        }
      }
      transfer.segments = segments
    }
  }

  async #runSegmentedRangeDownload(transfer: ManagedTransfer, signal: AbortSignal): Promise<void> {
    // 严禁使用 'a+'（O_APPEND 会忽略 offset 强制追加到文件末尾）；已存在用 'r+' 随机写，不存在先用 'w+' 创建
    let fileHandle: fs.FileHandle
    try {
      fileHandle = await fs.open(transfer.partPath, 'r+')
    } catch {
      fileHandle = await fs.open(transfer.partPath, 'w+')
    }
    try {
      if (transfer.totalBytes !== undefined && transfer.downloadedBytes === 0) {
        await fileHandle.truncate(transfer.totalBytes)
      }
      const perConnLimit =
        transfer.maxRateBytesPerSec !== undefined
          ? Math.max(1024, Math.floor(transfer.maxRateBytesPerSec / Math.max(1, transfer.segments.length)))
          : undefined

      const pendingSegments = transfer.segments.filter((seg) => !seg.completed)
      transfer.activeConnections = pendingSegments.length
      let lastSpeedTick = this.#now()
      let bytesSinceTick = 0

      // 内部联动取消器：任一分片失败时立即中止其余分片，待全部协程退出后再关闭文件句柄，杜绝句柄关闭后竞态写入与连接泄漏
      const segmentController = new AbortController()
      const combinedSignal = AbortSignal.any([signal, segmentController.signal])

      const workers = pendingSegments.map(async (segment) => {
        const rangeStart = segment.start + segment.downloaded
        if (rangeStart > segment.end) {
          segment.completed = true
          return
        }
        const res = await this.#fetchImpl(transfer.url, {
          method: 'GET',
          headers: { Range: `bytes=${rangeStart}-${segment.end}` },
          signal: combinedSignal,
          cache: 'no-store'
        })
        // 多分片或非 0 偏移请求必须严格返回 HTTP 206，严禁将忽略 Range 的 HTTP 200 全量体错位写入分片偏移
        const allowFull200 =
          res.status === 200 &&
          transfer.segments.length === 1 &&
          rangeStart === 0
        if (res.status !== 206 && !allowFull200) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionFailed,
            `Range download expected HTTP 206 but received HTTP ${res.status}`
          )
        }
        if (!res.body) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionFailed,
            'Remote server returned empty body for range download'
          )
        }
        const reader = res.body.getReader()
        let windowStart = this.#now()
        let windowBytes = 0

        try {
          while (true) {
            if (combinedSignal.aborted) return
            const { done, value } = await reader.read()
            if (done) break
            const buf = Buffer.from(value)
            const remainingInSegment = segment.end - (segment.start + segment.downloaded) + 1
            const toWrite = buf.byteLength <= remainingInSegment ? buf : buf.subarray(0, remainingInSegment)
            if (toWrite.byteLength <= 0) break

            const offset = segment.start + segment.downloaded
            await fileHandle.write(toWrite, 0, toWrite.byteLength, offset)
            segment.downloaded += toWrite.byteLength
            transfer.downloadedBytes += toWrite.byteLength
            bytesSinceTick += toWrite.byteLength
            windowBytes += toWrite.byteLength

            const nowMs = this.#now()
            if (nowMs - lastSpeedTick >= 200) {
              const elapsedSec = Math.max(0.05, (nowMs - lastSpeedTick) / 1000)
              transfer.speedBytesPerSec = Math.round(bytesSinceTick / elapsedSec)
              transfer.updatedAt = nowMs
              bytesSinceTick = 0
              lastSpeedTick = nowMs
              this.#emitTransferProgress(transfer)
            }

            if (perConnLimit !== undefined) {
              const expectedMs = (windowBytes / perConnLimit) * 1000
              const actualMs = this.#now() - windowStart
              if (expectedMs > actualMs + 10) {
                await this.#sleepAbortable(Math.min(1000, expectedMs - actualMs), combinedSignal)
              }
              if (this.#now() - windowStart >= 1000) {
                windowStart = this.#now()
                windowBytes = 0
              }
            }
          }
          if (segment.start + segment.downloaded > segment.end) {
            segment.completed = true
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      })

      try {
        await Promise.all(workers)
      } catch (error) {
        segmentController.abort('segment_failed')
        await Promise.allSettled(workers)
        throw error
      }
      transfer.activeConnections = 0
      transfer.updatedAt = this.#now()
      this.#emitTransferProgress(transfer)
    } finally {
      await fileHandle.close()
    }
  }

  async #runSingleStreamDownload(transfer: ManagedTransfer, signal: AbortSignal): Promise<void> {
    const existingSize = await fs
      .stat(transfer.partPath)
      .then((s) => s.size)
      .catch(() => 0)

    const headers: Record<string, string> = {}
    if (existingSize > 0) {
      headers.Range = `bytes=${existingSize}-`
    }
    const res = await this.#fetchImpl(transfer.url, {
      method: 'GET',
      headers,
      signal,
      cache: 'no-store'
    })
    if (!res.ok || !res.body) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.executionFailed,
        `Download failed with HTTP ${res.status}`
      )
    }

    const resumed = res.status === 206 && existingSize > 0
    const lenHeader = res.headers.get('content-length')
    const contentLen = lenHeader ? Number(lenHeader) : Number.NaN
    if (Number.isSafeInteger(contentLen) && contentLen >= 0) {
      transfer.totalBytes = resumed ? existingSize + contentLen : contentLen
    }

    const fileHandle = await fs.open(transfer.partPath, resumed ? 'a' : 'w')
    transfer.downloadedBytes = resumed ? existingSize : 0
    transfer.activeConnections = 1
    let lastSpeedTick = this.#now()
    let bytesSinceTick = 0
    let windowStart = this.#now()
    let windowBytes = 0
    const reader = res.body.getReader()

    try {
      while (true) {
        if (signal.aborted) return
        const { done, value } = await reader.read()
        if (done) break
        const buf = Buffer.from(value)
        await fileHandle.write(buf, 0, buf.byteLength)
        transfer.downloadedBytes += buf.byteLength
        bytesSinceTick += buf.byteLength
        windowBytes += buf.byteLength

        const nowMs = this.#now()
        if (nowMs - lastSpeedTick >= 200) {
          const elapsedSec = Math.max(0.05, (nowMs - lastSpeedTick) / 1000)
          transfer.speedBytesPerSec = Math.round(bytesSinceTick / elapsedSec)
          transfer.updatedAt = nowMs
          bytesSinceTick = 0
          lastSpeedTick = nowMs
          this.#emitTransferProgress(transfer)
        }

        if (transfer.maxRateBytesPerSec !== undefined) {
          const expectedMs = (windowBytes / transfer.maxRateBytesPerSec) * 1000
          const actualMs = this.#now() - windowStart
          if (expectedMs > actualMs + 10) {
            await this.#sleepAbortable(Math.min(1000, expectedMs - actualMs), signal)
          }
          if (this.#now() - windowStart >= 1000) {
            windowStart = this.#now()
            windowBytes = 0
          }
        }
      }
      transfer.activeConnections = 0
      transfer.updatedAt = this.#now()
      this.#emitTransferProgress(transfer)
    } finally {
      reader.releaseLock()
      await fileHandle.close()
    }
  }

  #emitTransferProgress(transfer: ManagedTransfer): void {
    const percent =
      transfer.totalBytes && transfer.totalBytes > 0
        ? Math.min(99, Math.round((transfer.downloadedBytes / transfer.totalBytes) * 100))
        : undefined
    transfer.onProgress?.({
      phase: 'running',
      ...(percent !== undefined ? { percent } : {}),
      transferredBytes: transfer.downloadedBytes,
      ...(transfer.totalBytes !== undefined ? { totalBytes: transfer.totalBytes } : {}),
      speedBytesPerSec: transfer.speedBytesPerSec
    })
  }

  #sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
