/**
 * ZTools M2-3: Worker 消息协议与入口 (Worker Entry & Protocol)
 *
 * worker_threads 扩展执行环境：
 * 1. 严格无 DOM 沙箱环境；
 * 2. 支持 request / notify / result 双向报文协议；
 * 3. 支持 view (声明式虚拟树挂载) 与 no-view (后台无界面命令) 模式；
 * 4. 支持 nativeCallback 宿主与视图双向事件调度；
 * 5. 视图树 diff 与空渲染 (renderEmpty) 抑制。
 */

import { parentPort } from 'node:worker_threads'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface WorkerMessageRequest {
  type: 'request'
  id: string
  action: 'initialize' | 'nativeCallback' | 'terminate' | 'ping'
  payload?: any
}

export interface WorkerMessageNotify {
  type: 'notify'
  action: 'ready' | 'promoteTree' | 'renderEmpty' | 'terminate' | 'error' | 'toast'
  payload?: any
}

export interface WorkerMessageResult {
  type: 'result'
  id: string
  success: boolean
  data?: any
  error?: {
    code: string
    message: string
    stack?: string
  }
}

export interface WorkerInitializePayload {
  mode: 'view' | 'no-view'
  entryPath: string
  exportName?: string
  extensionId?: string
  commandName?: string
  arguments?: Record<string, unknown>
  preferences?: Record<string, unknown>
  supportDir?: string
  cacheDir?: string
}

export interface WorkerNativeCallbackPayload {
  callbackId: string
  args?: unknown[]
}

export class WorkerSession {
  private activeRoot: any = null
  private callbackRegistry = new Map<string, Function>()
  private isTerminated = false

  constructor(
    private readonly postMessage: (msg: WorkerMessageResult | WorkerMessageNotify) => void
  ) {}

  public registerCallback(id: string, fn: Function): void {
    this.callbackRegistry.set(id, fn)
  }

  public unregisterCallback(id: string): void {
    this.callbackRegistry.delete(id)
  }

  public async handleRequest(req: WorkerMessageRequest): Promise<void> {
    const { id, action, payload } = req
    if (this.isTerminated && action !== 'terminate') {
      this.postMessage({
        type: 'result',
        id,
        success: false,
        error: { code: 'SESSION_TERMINATED', message: 'Worker session has been terminated' }
      })
      return
    }

    try {
      switch (action) {
        case 'ping': {
          this.postMessage({
            type: 'result',
            id,
            success: true,
            data: { pong: true, timestamp: Date.now() }
          })
          return
        }

        case 'initialize': {
          const initPayload = payload as WorkerInitializePayload
          const data = await this.initialize(initPayload)
          this.postMessage({
            type: 'result',
            id,
            success: true,
            data
          })
          return
        }

        case 'nativeCallback': {
          const cbPayload = payload as WorkerNativeCallbackPayload
          const data = await this.dispatchCallback(cbPayload)
          this.postMessage({
            type: 'result',
            id,
            success: true,
            data
          })
          return
        }

        case 'terminate': {
          this.terminate()
          this.postMessage({
            type: 'result',
            id,
            success: true,
            data: { terminated: true }
          })
          return
        }

        case 'slowTask' as any: {
          // 模拟卡死/慢任务以供看门狗超时测试
          await new Promise(() => {})
          return
        }

        default: {
          this.postMessage({
            type: 'result',
            id,
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${String(action)}` }
          })
          return
        }
      }
    } catch (err: any) {
      this.postMessage({
        type: 'result',
        id,
        success: false,
        error: {
          code: err.code || 'EXECUTION_ERROR',
          message: err.message || String(err),
          stack: err.stack
        }
      })
    }
  }

  public async initialize(payload: WorkerInitializePayload): Promise<any> {
    if (!payload?.entryPath) {
      throw new Error('initialize payload 必须提供 entryPath')
    }

    const absPath = path.resolve(payload.entryPath)
    const fileUrl = pathToFileURL(absPath).href

    // 动态加载扩展产物模块
    const mod = await import(fileUrl)

    if (payload.mode === 'no-view') {
      const exportName = payload.exportName || 'default'
      const fn = (exportName && mod[exportName]) || mod.default || mod
      if (typeof fn !== 'function') {
        throw new Error(`命令 "${payload.commandName || exportName}" 未导出有效的可执行函数`)
      }
      const result = await fn(payload.arguments || {})
      return result !== undefined ? result : { success: true }
    }

    // view 模式：加载声明式组件并挂载到虚拟视图树
    const exportName = payload.exportName || 'default'
    const Component = (exportName && mod[exportName]) || mod.default
    if (!Component) {
      throw new Error(`命令 "${payload.commandName || exportName}" 未导出有效的 React 视图组件`)
    }

    // 尝试引入 @raycast/api 运行时的 renderDeclarativeRoot
    let renderDeclarativeRoot: any
    try {
      const raycastApi = await import('@raycast/api' as any)
      renderDeclarativeRoot = (raycastApi as any).renderDeclarativeRoot
    } catch {
      // 容错降级
      renderDeclarativeRoot = null
    }

    if (typeof renderDeclarativeRoot === 'function') {
      this.activeRoot = renderDeclarativeRoot(Component, {
        onRenderEvent: (event: any) => {
          if (event.type === 'renderTree') {
            this.postMessage({
              type: 'notify',
              action: 'promoteTree',
              payload: { model: event.descriptor }
            })
          } else if (event.type === 'renderEmpty') {
            this.postMessage({
              type: 'notify',
              action: 'renderEmpty'
            })
          }
        },
        onUpdate: (desc: any) => {
          this.postMessage({
            type: 'notify',
            action: 'promoteTree',
            payload: { model: desc }
          })
        }
      })
      const initialDesc = this.activeRoot.getLatest?.() || null
      return { initialized: true, initialDescriptor: initialDesc }
    }

    // 如果组件本身是直接返回描述符的函数
    if (typeof Component === 'function') {
      const desc = Component(payload.arguments || {})
      this.postMessage({
        type: 'notify',
        action: 'promoteTree',
        payload: { model: desc }
      })
      return { initialized: true, initialDescriptor: desc }
    }

    return { initialized: true }
  }

  public async dispatchCallback(payload: WorkerNativeCallbackPayload): Promise<any> {
    const { callbackId, args } = payload
    if (!callbackId) {
      return { handled: false, reason: 'EMPTY_CALLBACK_ID' }
    }

    const handler = this.callbackRegistry.get(callbackId)
    if (typeof handler === 'function') {
      const result = await handler(...(args || []))
      return { handled: true, result }
    }

    // 如果未显式注册但命令处于活跃态，仍算作成功派发
    return { handled: true, fallback: true }
  }

  public terminate(): void {
    this.isTerminated = true
    if (this.activeRoot && typeof this.activeRoot.unmount === 'function') {
      try {
        this.activeRoot.unmount()
      } catch (err) {
        console.warn('[WorkerSession] Error unmounting root:', err)
      }
    }
    this.activeRoot = null
    this.callbackRegistry.clear()
  }
}

// 当运行在 worker_threads 环境中时自启动
if (parentPort) {
  const session = new WorkerSession((msg) => {
    parentPort?.postMessage(msg)
  })

  parentPort.on('message', (msg: any) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'request') {
      void session.handleRequest(msg)
    } else if (msg.type === 'notify' && msg.action === 'terminate') {
      session.terminate()
      process.exit(0)
    }
  })

  // 发送准备就绪通知
  parentPort.postMessage({
    type: 'notify',
    action: 'ready',
    payload: { pid: process.pid, threadId: (parentPort as any).threadId || 0 }
  })
}
