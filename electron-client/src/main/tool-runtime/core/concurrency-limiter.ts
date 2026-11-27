import { TOOL_RUNTIME_ERROR_CODES } from '../../../contracts/tool-runtime/common.js'
import { createToolRuntimeError } from './errors.js'

export interface ConcurrencyLimiterOptions {
  /** 全局最大并发任务数（默认 4） */
  readonly maxGlobal?: number
  /** 单插件最大并发任务数（默认 2） */
  readonly maxPerPlugin?: number
  /** 等待队列总容量上限（默认 64，超出立即拒绝防止内存积压） */
  readonly maxQueued?: number
}

interface Waiter {
  readonly pluginKey: string
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

/**
 * 双维度信号量并发控制器：
 * - 同时约束全局并发上限与单插件维度并发上限；
 * - 支持等待队列响应 AbortSignal 即时取消，避免僵尸排队占槽。
 */
export class ConcurrencyLimiter {
  readonly #maxGlobal: number
  readonly #maxPerPlugin: number
  readonly #maxQueued: number
  #activeGlobal = 0
  readonly #activeByPlugin = new Map<string, number>()
  readonly #queue: Waiter[] = []
  #stopped = false

  constructor(options: ConcurrencyLimiterOptions = {}) {
    this.#maxGlobal = Math.max(1, options.maxGlobal ?? 4)
    this.#maxPerPlugin = Math.max(1, options.maxPerPlugin ?? 2)
    this.#maxQueued = Math.max(1, options.maxQueued ?? 64)
  }

  get activeGlobal(): number {
    return this.#activeGlobal
  }

  get queuedCount(): number {
    return this.#queue.length
  }

  activeForPlugin(pluginKey: string): number {
    return this.#activeByPlugin.get(pluginKey) ?? 0
  }

  async acquire(pluginKey: string, signal?: AbortSignal): Promise<() => void> {
    if (this.#stopped) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskCancelled,
        'Tool runtime concurrency limiter has stopped'
      )
    }
    if (signal?.aborted) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskCancelled,
        'Task was cancelled before acquiring execution slot'
      )
    }
    if (this.#canGrant(pluginKey)) {
      return this.#grant(pluginKey)
    }
    if (this.#queue.length >= this.#maxQueued) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.concurrencyLimited,
        'Tool runtime execution queue is full'
      )
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#queue.indexOf(waiter)
        if (index >= 0) this.#queue.splice(index, 1)
        waiter.cleanup()
        reject(
          createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.taskCancelled,
            'Task was cancelled while waiting for execution slot'
          )
        )
      }
      const waiter: Waiter = {
        pluginKey,
        resolve,
        reject,
        cleanup: () => {
          if (signal) signal.removeEventListener('abort', onAbort)
        }
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#queue.push(waiter)
    })
  }

  async run<T>(pluginKey: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(pluginKey, signal)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  stop(): void {
    this.#stopped = true
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift()
      if (!waiter) break
      waiter.cleanup()
      waiter.reject(
        createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.taskCancelled,
          'Tool runtime stopped while task was queued'
        )
      )
    }
  }

  #canGrant(pluginKey: string): boolean {
    if (this.#activeGlobal >= this.#maxGlobal) return false
    const current = this.#activeByPlugin.get(pluginKey) ?? 0
    return current < this.#maxPerPlugin
  }

  #grant(pluginKey: string): () => void {
    this.#activeGlobal += 1
    this.#activeByPlugin.set(pluginKey, (this.#activeByPlugin.get(pluginKey) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#activeGlobal = Math.max(0, this.#activeGlobal - 1)
      const remaining = (this.#activeByPlugin.get(pluginKey) ?? 1) - 1
      if (remaining > 0) {
        this.#activeByPlugin.set(pluginKey, remaining)
      } else {
        this.#activeByPlugin.delete(pluginKey)
      }
      this.#drainQueue()
    }
  }

  #drainQueue(): void {
    if (this.#stopped) return
    let index = 0
    while (index < this.#queue.length && this.#activeGlobal < this.#maxGlobal) {
      const waiter = this.#queue[index]
      if (!waiter) break
      if (this.#canGrant(waiter.pluginKey)) {
        this.#queue.splice(index, 1)
        waiter.cleanup()
        const release = this.#grant(waiter.pluginKey)
        waiter.resolve(release)
      } else {
        index += 1
      }
    }
  }
}
