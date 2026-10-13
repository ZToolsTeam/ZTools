/**
 * ZTools M2-1: 扩展宿主进程 (Extension Host Process)
 *
 * 对齐 Raycast 扩展宿主进程架构：
 * 1. 使用 Electron utilityProcess 启动独立扩展宿主进程（生产环境）；
 *    在纯 Node 测试环境中自动平滑降级为 child_process.fork；
 * 2. 懒启动（Lazy Start）：首次调度第三方扩展时启动；
 * 3. 崩溃退避自动重启（Crash Backoff）：
 *    退避阶梯为 1s, 2s, 4s；1 分钟内连续 3 次失败停止重启并触发警告；
 * 4. 优雅停止（Graceful Shutdown）：退出时发送 terminate 报文，超时 2s 强制杀进程。
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fork as cpFork } from 'node:child_process'

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()

export interface ProcessBridge {
  postMessage(data: unknown): void
  onMessage(handler: (data: unknown) => void): void
  onExit(handler: (code: number | null) => void): void
  kill(signal?: string): void
  readonly pid?: number | undefined
}

export interface ExtensionHostProcessOptions {
  hostEntryPath?: string
  backoffDelaysMs?: number[]
  maxCrashesPerMinute?: number
  shutdownTimeoutMs?: number
  defaultTimeoutMs?: number
  spawnAdapter?: ((entryPath: string) => ProcessBridge) | undefined
}

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: any) => void
  timer?: NodeJS.Timeout
}

export class ExtensionHostProcess extends EventEmitter {
  private bridge: ProcessBridge | null = null
  private isStarting = false
  private isStopping = false
  private isDisabled = false
  private crashTimestamps: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private pendingRequests = new Map<string, PendingRequest>()

  private readonly hostEntryPath: string
  private readonly backoffDelaysMs: number[]
  private readonly maxCrashesPerMinute: number
  private readonly shutdownTimeoutMs: number
  private readonly defaultTimeoutMs: number
  private readonly spawnAdapter: ((entryPath: string) => ProcessBridge) | undefined

  constructor(options: ExtensionHostProcessOptions = {}) {
    super()
    this.backoffDelaysMs = options.backoffDelaysMs || [1000, 2000, 4000]
    this.maxCrashesPerMinute = options.maxCrashesPerMinute || 3
    this.shutdownTimeoutMs = options.shutdownTimeoutMs || 2000
    this.defaultTimeoutMs = options.defaultTimeoutMs || 30_000
    this.spawnAdapter = options.spawnAdapter

    const possibleEntries = [
      options.hostEntryPath,
      path.join(currentDir, 'host-entry.js'),
      path.join(currentDir, 'host-entry.ts'),
      path.resolve(process.cwd(), 'electron-client/src/main/extension-host/host-entry.ts')
    ].filter(Boolean) as string[]

    this.hostEntryPath = possibleEntries.find(p => fs.existsSync(p)) || path.join(__dirname, 'host-entry.js')
  }

  public get isRunning(): boolean {
    return this.bridge !== null && !this.isStopping
  }

  public get isTerminated(): boolean {
    return this.isDisabled
  }

  public get processPid(): number | undefined {
    return this.bridge?.pid
  }

  /**
   * 懒启动：确保扩展宿主进程正在运行
   */
  public async ensureStarted(): Promise<void> {
    if (this.isRunning) return
    await this.start()
  }

  /**
   * 启动扩展宿主进程
   */
  public async start(): Promise<void> {
    if (this.isDisabled) {
      throw new Error('[ExtensionHostProcess] 宿主进程因 1 分钟内连续崩溃超限已停用')
    }

    if (this.bridge) return
    if (this.isStarting) {
      return new Promise<void>((resolve, reject) => {
        this.once('ready', resolve)
        this.once('error', reject)
      })
    }

    this.isStarting = true
    this.isStopping = false

    try {
      this.bridge = this.createBridge()

      this.bridge.onMessage((msg: any) => {
        this.handleMessage(msg)
      })

      this.bridge.onExit((code) => {
        this.handleExit(code)
      })

      // 等待 ready 事件
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve() // 握手超时兜底继续
        }, 3000)

        const onReady = () => {
          clearTimeout(timeout)
          resolve()
        }

        const onError = (err: any) => {
          clearTimeout(timeout)
          reject(err)
        }

        this.once('ready', onReady)
        this.once('error', onError)
      })

      this.isStarting = false
      this.emit('started', { pid: this.bridge?.pid })
    } catch (err) {
      this.isStarting = false
      this.bridge = null
      throw err
    }
  }

  private createBridge(): ProcessBridge {
    if (this.spawnAdapter) {
      return this.spawnAdapter(this.hostEntryPath)
    }

    // 1. 如果在 Electron 渲染/主进程环境下且支持 utilityProcess
    try {
      const electron = require('electron')
      if (electron?.utilityProcess?.fork) {
        const child = electron.utilityProcess.fork(this.hostEntryPath, [], {
          serviceName: 'ztools-extension-host',
          env: { ...process.env }
        })

        return {
          postMessage: (data: unknown) => child.postMessage(data),
          onMessage: (handler: (data: unknown) => void) => {
            child.on('message', handler)
          },
          onExit: (handler: (code: number | null) => void) => {
            child.on('exit', handler)
          },
          kill: (_signal?: string) => {
            child.kill()
          },
          pid: child.pid
        }
      }
    } catch {}

    // 2. 纯 Node.js 测试环境平滑降级为 child_process.fork
    const cp = cpFork(this.hostEntryPath, [], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })

    const bridge: ProcessBridge = {
      postMessage: (data: unknown) => {
        if (cp.send) {
          cp.send(data as any)
        }
      },
      onMessage: (handler: (data: unknown) => void) => {
        cp.on('message', handler)
      },
      onExit: (handler: (code: number | null) => void) => {
        cp.on('exit', handler)
      },
      kill: (signal?: string) => {
        cp.kill((signal as any) || 'SIGTERM')
      },
      ...(typeof cp.pid === 'number' ? { pid: cp.pid } : {})
    }
    return bridge
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'notify') {
      if (msg.action === 'ready') {
        this.emit('ready', msg.payload)
      }
      this.emit('notify', msg)
      this.emit(msg.action, msg.payload, msg.sessionId)
      return
    }

    if (msg.type === 'result') {
      const req = this.pendingRequests.get(msg.id)
      if (!req) return
      this.pendingRequests.delete(msg.id)
      if (req.timer) clearTimeout(req.timer)

      if (msg.success) {
        req.resolve(msg.data)
      } else {
        const err = new Error(msg.error?.message || '宿主指令执行失败')
        if (msg.error?.code) (err as any).code = msg.error.code
        req.reject(err)
      }
    }
  }

  /**
   * 崩溃退避重启状态机
   */
  private handleExit(code: number | null): void {
    this.bridge = null

    // 拒绝所有未决请求
    for (const req of this.pendingRequests.values()) {
      if (req.timer) clearTimeout(req.timer)
      req.reject(new Error(`Extension host process crashed with code ${code}`))
    }
    this.pendingRequests.clear()

    this.emit('exit', code)

    // 如果是主动正常停止，不触发崩溃重启
    if (this.isStopping) {
      return
    }

    // 记录崩溃时间戳并过滤 1 分钟以前的历史
    const now = Date.now()
    this.crashTimestamps = this.crashTimestamps.filter(t => now - t <= 60_000)
    this.crashTimestamps.push(now)

    if (this.crashTimestamps.length >= this.maxCrashesPerMinute) {
      this.isDisabled = true
      console.warn(
        `[ExtensionHostProcess] 扩展宿主进程在 1 分钟内连续失败 ${this.crashTimestamps.length} 次，停止重启并警告。`
      )
      this.emit('crash-exhausted', { crashes: this.crashTimestamps.length })
      return
    }

    // 计算退避延迟 (1s, 2s, 4s)
    const delayIdx = Math.min(this.crashTimestamps.length - 1, this.backoffDelaysMs.length - 1)
    const delayMs = this.backoffDelaysMs[delayIdx] ?? 1000

    this.emit('restarting', { delayMs, attempt: this.crashTimestamps.length })

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch((err) => {
        console.warn('[ExtensionHostProcess] 重启扩展宿主进程失败:', err)
      })
    }, delayMs)
  }

  /**
   * 发送 RPC 请求给宿主进程
   */
  public async sendRequest<T = any>(action: string, payload?: any, timeoutMs?: number): Promise<T> {
    if (this.isDisabled) {
      throw new Error('[ExtensionHostProcess] 扩展宿主进程已停用')
    }

    // 懒启动
    if (!this.isRunning) {
      await this.start()
    }

    const effectiveTimeout = timeoutMs || this.defaultTimeoutMs
    const id = randomUUID()

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`[ExtensionHostProcess] Action [${action}] 请求超时 (${effectiveTimeout}ms)`))
      }, effectiveTimeout)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.bridge?.postMessage({
        type: 'request',
        id,
        action,
        payload
      })
    })
  }

  /**
   * 启动扩展命令会话
   */
  public async startCommand(payload: {
    sessionId: string
    entryPath: string
    mode?: 'view' | 'no-view'
    exportName?: string
    extensionId?: string
    commandName?: string
    arguments?: Record<string, unknown>
    preferences?: Record<string, unknown>
    supportDir?: string
    cacheDir?: string
  }): Promise<any> {
    return this.sendRequest('startCommand', payload)
  }

  /**
   * 分发前端回传的 nativeCallback
   */
  public async dispatchNativeCallback(sessionId: string, callbackId: string, args?: unknown[]): Promise<any> {
    return this.sendRequest('nativeCallback', { sessionId, callbackId, args })
  }

  /**
   * 销毁指定会话
   */
  public async terminateSession(sessionId: string): Promise<any> {
    return this.sendRequest('terminateSession', { sessionId })
  }

  /**
   * 心跳探测
   */
  public async ping(): Promise<{ pong: boolean; pid: number }> {
    return this.sendRequest('ping')
  }

  /**
   * 优雅停止：发送 terminate 超时 2s 强制杀
   */
  public async stop(): Promise<void> {
    this.isStopping = true

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    if (!this.bridge) {
      this.isStopping = false
      return
    }

    const bridge = this.bridge
    this.bridge = null

    return new Promise<void>((resolve) => {
      let finished = false
      const done = () => {
        if (!finished) {
          finished = true
          clearTimeout(forceKillTimer)
          this.isStopping = false
          this.emit('stopped')
          resolve()
        }
      }

      // 超时 2s 强制杀死
      const forceKillTimer = setTimeout(() => {
        try {
          bridge.kill('SIGKILL')
        } catch {}
        done()
      }, this.shutdownTimeoutMs)

      try {
        bridge.onExit(() => done())
        bridge.postMessage({ type: 'notify', action: 'terminate' })
      } catch {
        try {
          bridge.kill('SIGKILL')
        } catch {}
        done()
      }
    })
  }
}
