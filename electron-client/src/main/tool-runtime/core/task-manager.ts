import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolProgressEvent,
  type ToolProvisionStage,
  type ToolRuntimeErrorCode,
  type ToolRuntimeUserAction,
  type ToolTaskCancelResult,
  type ToolTaskId
} from '../../../contracts/tool-runtime/common.js'
import { isHostCaller, resolvePluginPrincipal } from '../../ipc/plugin-principal.js'
import {
  attachPrimitiveContext,
  createToolRuntimeError,
  extractToolProgressFailureMeta
} from './errors.js'

const TASK_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/

export interface ToolTaskProgressPayload {
  readonly phase: ToolProgressEvent['phase']
  readonly percent?: number
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly speedBytesPerSec?: number
  readonly stage?: ToolProvisionStage
  readonly errorCode?: ToolRuntimeErrorCode
  readonly retryable?: boolean
  readonly userAction?: ToolRuntimeUserAction
  readonly message?: string
}

export interface ManagedToolTask {
  readonly taskId: ToolTaskId
  readonly primitiveId: string
  readonly ownerWebContentsId: number
  readonly pluginId?: string
  readonly caller: CallerIdentity
  readonly signal: AbortSignal
  emitProgress(payload: ToolTaskProgressPayload): void
  finish(): void
}

interface ActiveTaskRecord {
  readonly taskId: ToolTaskId
  readonly primitiveId: string
  readonly ownerWebContentsId: number
  readonly pluginId?: string
  readonly caller: CallerIdentity
  readonly controller: AbortController
  readonly cleanupUpstream?: () => void
  finished: boolean
}

export type ToolProgressEmitter = (event: ToolProgressEvent, caller: CallerIdentity) => void

export interface ToolTaskManagerOptions {
  readonly onProgress?: ToolProgressEmitter
  readonly now?: () => number
}

/**
 * 统一工具任务生命周期管理器：
 * - 生成/校验唯一 taskId 并管理 AbortController；
 * - 向所属调用窗口广播结构化 ToolProgressEvent；
 * - 支持窗口销毁自动取消、插件卸载自动取消以及按归属校验手动取消。
 */
export class ToolTaskManager {
  readonly #tasks = new Map<ToolTaskId, ActiveTaskRecord>()
  readonly #onProgress?: ToolProgressEmitter
  readonly #now: () => number
  #stopped = false

  constructor(options: ToolTaskManagerOptions = {}) {
    if (options.onProgress) {
      this.#onProgress = options.onProgress
    }
    this.#now = options.now ?? Date.now
  }

  get activeCount(): number {
    return this.#tasks.size
  }

  hasTask(taskId: ToolTaskId): boolean {
    return this.#tasks.has(taskId)
  }

  createTask(params: {
    readonly requestedTaskId?: string
    readonly primitiveId: string
    readonly caller: CallerIdentity
    readonly upstreamSignal?: AbortSignal
  }): ManagedToolTask {
    if (this.#stopped) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskCancelled,
        'Tool task manager is stopping'
      )
    }
    const taskId = params.requestedTaskId ?? `tool_${randomUUID()}`
    if (!TASK_ID_REGEX.test(taskId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'Invalid taskId format'
      )
    }
    if (this.#tasks.has(taskId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        `Task "${taskId}" is already active`
      )
    }

    const controller = new AbortController()
    let cleanupUpstream: (() => void) | undefined
    if (params.upstreamSignal) {
      if (params.upstreamSignal.aborted) {
        controller.abort(params.upstreamSignal.reason)
      } else {
        const onUpstreamAbort = (): void => {
          controller.abort(params.upstreamSignal?.reason)
        }
        params.upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true })
        cleanupUpstream = () => params.upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
      }
    }

    const principal = resolvePluginPrincipal(params.caller)
    const record: ActiveTaskRecord = {
      taskId,
      primitiveId: params.primitiveId,
      ownerWebContentsId: params.caller.webContentsId,
      ...(principal?.pluginId ? { pluginId: principal.pluginId } : {}),
      caller: params.caller,
      controller,
      ...(cleanupUpstream ? { cleanupUpstream } : {}),
      finished: false
    }
    this.#tasks.set(taskId, record)

    const emitProgress = (payload: ToolTaskProgressPayload): void => {
      if (!this.#onProgress) return
      const event: ToolProgressEvent = {
        taskId,
        primitiveId: params.primitiveId,
        phase: payload.phase,
        ...(payload.percent !== undefined ? { percent: Math.max(0, Math.min(100, payload.percent)) } : {}),
        ...(payload.transferredBytes !== undefined ? { transferredBytes: payload.transferredBytes } : {}),
        ...(payload.totalBytes !== undefined ? { totalBytes: payload.totalBytes } : {}),
        ...(payload.speedBytesPerSec !== undefined ? { speedBytesPerSec: payload.speedBytesPerSec } : {}),
        ...(payload.stage !== undefined ? { stage: payload.stage } : {}),
        ...(payload.errorCode !== undefined ? { errorCode: payload.errorCode } : {}),
        ...(payload.retryable !== undefined ? { retryable: payload.retryable } : {}),
        ...(payload.userAction !== undefined ? { userAction: payload.userAction } : {}),
        ...(payload.message !== undefined ? { message: payload.message } : {}),
        timestamp: this.#now()
      }
      try {
        this.#onProgress(event, params.caller)
      } catch (error) {
        console.warn('推送工具进度事件失败', error)
      }
    }

    const finish = (): void => {
      if (record.finished) return
      record.finished = true
      record.cleanupUpstream?.()
      this.#tasks.delete(taskId)
    }

    return {
      taskId,
      primitiveId: params.primitiveId,
      ownerWebContentsId: record.ownerWebContentsId,
      ...(record.pluginId ? { pluginId: record.pluginId } : {}),
      caller: params.caller,
      signal: controller.signal,
      emitProgress,
      finish
    }
  }

  /**
   * 创建并执行受管薄原语任务：
   * - 统一追踪终态进度事件避免重复发送；
   * - 异常时自动补齐 primitiveId 上下文并补发带 errorCode/retryable/userAction 的 failed/cancelled 进度事件；
   * - 结束时确保调用 task.finish() 释放活跃登记。
   */
  async runManagedTask<T>(
    params: {
      readonly requestedTaskId?: string
      readonly primitiveId: string
      readonly caller: CallerIdentity
      readonly upstreamSignal?: AbortSignal
      /** 仅在过程中确实发出过进度事件且未发终态时自动补发 completed（适合 probe / ensure 等按需预热场景） */
      readonly autoCompleteIfProgressed?: boolean
    },
    runner: (context: {
      readonly task: ManagedToolTask
      readonly emitProgress: (payload: ToolTaskProgressPayload) => void
    }) => Promise<T>
  ): Promise<T> {
    const task = this.createTask(params)
    let emittedProgress = false
    let terminalEmitted = false
    const emitProgress = (payload: ToolTaskProgressPayload): void => {
      emittedProgress = true
      if (payload.phase === 'completed' || payload.phase === 'cancelled' || payload.phase === 'failed') {
        terminalEmitted = true
      }
      task.emitProgress(payload)
    }

    try {
      const result = await runner({ task, emitProgress })
      if (params.autoCompleteIfProgressed && emittedProgress && !terminalEmitted) {
        emitProgress({ phase: 'completed', percent: 100 })
      }
      return result
    } catch (error) {
      const enriched = attachPrimitiveContext(error, params.primitiveId)
      if (!terminalEmitted) {
        const failure = extractToolProgressFailureMeta(enriched)
        if (failure.errorCode === TOOL_RUNTIME_ERROR_CODES.taskCancelled) {
          emitProgress({ phase: 'cancelled', message: failure.message })
        } else {
          emitProgress({
            phase: 'failed',
            errorCode: failure.errorCode,
            retryable: failure.retryable,
            userAction: failure.userAction,
            message: failure.message
          })
        }
      }
      throw enriched
    } finally {
      task.finish()
    }
  }

  /** 按调用方身份校验归属并取消指定任务 */
  cancelTask(taskId: ToolTaskId, caller: CallerIdentity): ToolTaskCancelResult {
    const record = this.#tasks.get(taskId)
    if (!record) {
      return { taskId, cancelled: false }
    }
    const callerPluginId = resolvePluginPrincipal(caller)?.pluginId
    const authorized =
      isHostCaller(caller) ||
      record.ownerWebContentsId === caller.webContentsId ||
      (callerPluginId !== undefined && record.pluginId === callerPluginId)
    if (!authorized) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'Caller is not authorized to cancel this tool task'
      )
    }
    record.controller.abort(TOOL_RUNTIME_ERROR_CODES.taskCancelled)
    return { taskId, cancelled: true }
  }

  /** 窗口销毁时自动取消该窗口全部活跃任务 */
  cancelOwnerTasks(ownerWebContentsId: number): number {
    let cancelled = 0
    for (const record of this.#tasks.values()) {
      if (record.ownerWebContentsId === ownerWebContentsId) {
        record.controller.abort(TOOL_RUNTIME_ERROR_CODES.taskCancelled)
        cancelled += 1
      }
    }
    return cancelled
  }

  /** 插件卸载或禁用时自动取消该插件全部活跃任务 */
  cancelPluginTasks(pluginId: string): number {
    const target = pluginId.toLowerCase()
    let cancelled = 0
    for (const record of this.#tasks.values()) {
      if (record.pluginId?.toLowerCase() === target) {
        record.controller.abort(TOOL_RUNTIME_ERROR_CODES.taskCancelled)
        cancelled += 1
      }
    }
    return cancelled
  }

  /** 宿主退出时终止所有活跃任务 */
  stop(): void {
    this.#stopped = true
    for (const record of this.#tasks.values()) {
      record.controller.abort(TOOL_RUNTIME_ERROR_CODES.taskCancelled)
      record.cleanupUpstream?.()
    }
    this.#tasks.clear()
  }
}
