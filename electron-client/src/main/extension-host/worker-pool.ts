/**
 * ZTools M2-2: Worker 预热池 (Prewarmed Worker Pool)
 *
 * 对齐 Raycast 官方扩展工作线程池实现：
 * 1. 默认池大小为 1，采用 getFromPool() 借出；
 * 2. 借出后通过 setImmediate() 异步补齐预热池，消除后续冷启动延迟；
 * 3. 严格资源纪律：每个 Worker 硬限制 maxOldGenerationSizeMb = 100MB；
 * 4. 环境变量隔离注入 NODE_PATH 与 NODE_COMPILE_CACHE；
 * 5. 内置高精度看门狗超时（Watchdog Timeout）熔断机制。
 */

import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()

export interface WorkerPoolOptions {
  poolSize?: number
  workerEntryPath?: string
  nodePath?: string
  compileCacheDir?: string
  defaultTimeoutMs?: number
  maxOldGenerationSizeMb?: number
}

export interface WorkerPendingRequest {
  resolve: (value: any) => void
  reject: (reason: any) => void
  watchdogTimer?: NodeJS.Timeout
}

export class PooledWorker {
  public readonly id: string
  public readonly worker: Worker
  public isReady = false
  public isTerminated = false
  public onNotify?: (action: string, payload: any) => void
  private pending = new Map<string, WorkerPendingRequest>()

  constructor(worker: Worker, id = randomUUID()) {
    this.id = id
    this.worker = worker

    this.worker.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'notify') {
        if (msg.action === 'ready') {
          this.isReady = true
        }
        this.onNotify?.(msg.action, msg.payload)
        return
      }

      if (msg.type === 'result') {
        const req = this.pending.get(msg.id)
        if (!req) return
        this.pending.delete(msg.id)
        if (req.watchdogTimer) clearTimeout(req.watchdogTimer)

        if (msg.success) {
          req.resolve(msg.data)
        } else {
          const err = new Error(msg.error?.message || 'Worker execution failed')
          if (msg.error?.code) (err as any).code = msg.error.code
          req.reject(err)
        }
      }
    })

    this.worker.on('error', (err) => {
      this.rejectAllPending(err)
    })

    this.worker.on('exit', (code) => {
      this.isTerminated = true
      if (code !== 0) {
        this.rejectAllPending(new Error(`Worker exited with non-zero code ${code} (Possible OOM > 100MB or crash)`))
      }
    })
  }

  private rejectAllPending(err: Error): void {
    for (const req of this.pending.values()) {
      if (req.watchdogTimer) clearTimeout(req.watchdogTimer)
      req.reject(err)
    }
    this.pending.clear()
  }

  /**
   * 发送指令请求，绑定看门狗超时监控
   */
  public postRequest<T = any>(action: string, payload?: any, timeoutMs = 30_000): Promise<T> {
    if (this.isTerminated) {
      return Promise.reject(new Error('Cannot send request to a terminated worker'))
    }

    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const watchdogTimer = setTimeout(() => {
        this.pending.delete(id)
        void this.terminate()
        reject(new Error(`WATCHDOG_TIMEOUT: Command [${action}] exceeded watchdog limit of ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, watchdogTimer })
      this.worker.postMessage({
        type: 'request',
        id,
        action,
        payload
      })
    })
  }

  public notify(action: string, payload?: any): void {
    if (this.isTerminated) return
    this.worker.postMessage({
      type: 'notify',
      action,
      payload
    })
  }

  public async terminate(): Promise<number> {
    this.isTerminated = true
    this.rejectAllPending(new Error('Worker terminated'))
    return this.worker.terminate()
  }
}

export class WorkerPool {
  private pool: PooledWorker[] = []
  private refilling = false
  private isClosed = false
  private readonly poolSize: number
  private readonly workerEntryPath: string
  private readonly nodePath: string
  private readonly compileCacheDir: string
  public readonly defaultTimeoutMs: number
  private readonly maxOldGenerationSizeMb: number

  constructor(options: WorkerPoolOptions = {}) {
    this.poolSize = options.poolSize ?? 1
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ?? 100

    // 默认定位 worker-entry.js / worker-entry.ts
    const possibleEntries = [
      options.workerEntryPath,
      path.join(currentDir, 'worker-entry.js'),
      path.join(currentDir, 'worker-entry.ts'),
      path.resolve(process.cwd(), 'electron-client/src/main/extension-host/worker-entry.ts')
    ].filter(Boolean) as string[]

    this.workerEntryPath = possibleEntries.find(p => fs.existsSync(p)) || path.join(currentDir, 'worker-entry.js')

    // 注入 NODE_PATH 与 NODE_COMPILE_CACHE
    const workspaceRoot = path.resolve(currentDir, '../../../../')
    const defaultNodePath = path.join(workspaceRoot, 'node_modules')
    this.nodePath = options.nodePath || defaultNodePath

    const defaultCacheDir = path.join(workspaceRoot, 'dist/.compile-cache')
    this.compileCacheDir = options.compileCacheDir || defaultCacheDir
  }

  public get poolLength(): number {
    return this.pool.length
  }

  /**
   * 预热 Worker 池至上限
   */
  public async warmUpPool(): Promise<void> {
    if (this.isClosed) return
    while (this.pool.length < this.poolSize) {
      const worker = await this.createWorker()
      this.pool.push(worker)
    }
  }

  /**
   * 对照 Raycast getFromPool: pop 借出并由 setImmediate 异步补齐
   */
  public async getFromPool(): Promise<PooledWorker> {
    if (this.isClosed) {
      throw new Error('WorkerPool is closed')
    }

    let worker = this.pool.pop()
    if (!worker || worker.isTerminated) {
      worker = await this.createWorker()
    }

    // 借出后异步补充预热池
    setImmediate(() => {
      this.refill()
    })

    return worker
  }

  /**
   * 异步自动补齐池
   */
  private refill(): void {
    if (this.isClosed || this.refilling || this.pool.length >= this.poolSize) {
      return
    }

    this.refilling = true
    this.createWorker()
      .then((worker) => {
        if (this.isClosed) {
          void worker.terminate()
        } else {
          this.pool.push(worker)
        }
      })
      .catch((err) => {
        console.warn('[WorkerPool] Failed to refill prewarmed worker:', err)
      })
      .finally(() => {
        this.refilling = false
      })
  }

  /**
   * 创建受配额与看门狗严密保护的 Worker 实例
   */
  public async createWorker(): Promise<PooledWorker> {
    if (!fs.existsSync(this.compileCacheDir)) {
      try {
        fs.mkdirSync(this.compileCacheDir, { recursive: true })
      } catch {}
    }

    const worker = new Worker(this.workerEntryPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.maxOldGenerationSizeMb
      },
      env: {
        ...process.env,
        NODE_PATH: this.nodePath,
        NODE_COMPILE_CACHE: this.compileCacheDir
      }
    })

    const pooled = new PooledWorker(worker)

    // 等待 Worker 启动完成或首次握手
    await new Promise<void>((resolve) => {
      if (pooled.isReady) {
        resolve()
        return
      }
      const timer = setTimeout(() => resolve(), 300)
      const prevNotify = pooled.onNotify
      pooled.onNotify = (action, payload) => {
        prevNotify?.(action, payload)
        if (action === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      }
    })

    return pooled
  }

  /**
   * 借出 Worker 并执行指令，使用看门狗超时监控
   */
  public async executeCommand<T = any>(action: string, payload?: any, timeoutMs?: number): Promise<T> {
    const worker = await this.getFromPool()
    return worker.postRequest<T>(action, payload, timeoutMs || this.defaultTimeoutMs)
  }

  /**
   * 清空预热池，释放所有空闲 Worker
   */
  public async flush(): Promise<void> {
    const workers = [...this.pool]
    this.pool = []
    await Promise.all(workers.map(w => w.terminate()))
  }

  /**
   * 彻底关闭 WorkerPool
   */
  public async close(): Promise<void> {
    this.isClosed = true
    await this.flush()
  }
}
