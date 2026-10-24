import type { PrivilegedDllClientPort } from '../native-host/dll-client-port.js'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import path from 'node:path'
import { errorCodes, ZToolsError, type ZToolsErrorCode } from '../../contracts/errors.js'
import { MAX_TIMEOUT_MS } from '../../contracts/ipc.js'
import {
  decodeServiceDllCall,
  decodeServiceDllTaskCode,
  decodeServiceDllTaskId,
  decodeServiceDllTaskStatus,
  decodeServiceDllTaskSuccess,
  decodeServiceContextMenuCheckAdmin,
  decodeServiceContextMenuRestartExplorer,
  decodeServicePolicyStatus,
  encodeServiceDllCall,
  encodeServiceDllCallAsync,
  encodeServiceDllCallWithCallback,
  encodeServiceDllTaskCancel,
  encodeServiceDllTaskClear,
  encodeServiceDllTaskQuery,
  encodeServiceContextMenuCheckAdmin,
  encodeServiceContextMenuRestartExplorer,
  encodeServicePolicyCheck,
  encodeServiceSubscribeTaskEvents,
  type ServiceDllTaskStatus,
  type ServicePolicyStatus
} from './service-command.js'
import {
  deriveServiceSessionKey,
  encodeServiceFrame,
  makeServiceClientProof,
  makeServiceServerProof,
  openServiceFrame,
  sealServiceFrame,
  SERVICE_MAX_PAYLOAD_BYTES,
  SERVICE_NONCE_BYTES,
  SERVICE_PIPE_NAME,
  SERVICE_PROOF_BYTES,
  SERVICE_SECRET_BYTES,
  ServiceFrameDecoder,
  ServiceFrameType,
  type ServiceFrame
} from './service-protocol.js'

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_QUEUED_FRAMES = 4
const RECOVERABLE_SERVICE_REJECTIONS = new Map<string, {
  code: ZToolsErrorCode
  message: string
}>([
  ['MANIFEST_UNTRUSTED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 清单未受信'
  }],
  ['MANIFEST_INTEGRITY', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 清单完整性校验失败'
  }],
  ['MANIFEST_INVALID', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 清单无效'
  }],
  ['MANIFEST_UNAVAILABLE', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 清单不可用'
  }],
  ['DLL_NOT_ALLOWED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 未授权'
  }],
  ['FUNCTION_NOT_ALLOWED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 函数未授权'
  }],
  ['DLL_INTEGRITY', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 完整性校验失败'
  }],
  ['COMMAND_INVALID', {
    code: errorCodes.invalidRequest,
    message: 'ZToolsService 命令格式无效'
  }],
  ['COMMAND_TOO_LARGE', {
    code: errorCodes.invalidRequest,
    message: 'ZToolsService 命令载荷过大'
  }],
  ['INVALID_REQUEST', {
    code: errorCodes.invalidRequest,
    message: 'ZToolsService 请求参数无效'
  }],
  ['NOT_SUPPORTED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService 高权限命令尚未开放'
  }],
  ['COMMAND_NOT_ALLOWED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService 命令不在允许清单中'
  }],
  ['TARGET_NOT_ALLOWED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService 高权限目标未授权'
  }],
  ['EXECUTION_DISABLED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService 高权限执行尚未开放'
  }],
  ['DLL_ARCH_INVALID', {
    code: errorCodes.pluginIntegrity,
    message: 'ZToolsService DLL 架构无效'
  }],
  ['DLL_PATH_INVALID', {
    code: errorCodes.pluginIntegrity,
    message: 'ZToolsService DLL 路径无效'
  }],
  ['DLL_UNAVAILABLE', {
    code: errorCodes.pluginNotFound,
    message: 'ZToolsService DLL 不可用'
  }],
  ['DLL_LOAD_FAILED', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL 或非系统依赖无法加载'
  }],
  ['DLL_HOST_INTERNAL', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL 宿主内部失败'
  }],
  ['DLL_NAME_COLLISION', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL 名称与已加载模块冲突'
  }],
  ['DLL_PATH_CHANGED', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL 加载路径已变化'
  }],
  ['DLL_COMMAND_NOT_ALLOWED', {
    code: errorCodes.permissionDenied,
    message: 'ZToolsService DLL 命令未授权'
  }],
  ['DLL_EXPORTS_INVALID', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL ABI 导出无效'
  }],
  ['DLL_INIT_FAILED', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL 初始化失败'
  }],
  ['DLL_INFO_INVALID', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService DLL 信息无效'
  }],
  ['HOST_STOPPING', {
    code: errorCodes.appStopping,
    message: 'ZToolsService 正在退出'
  }],
  ['DLL_CALL_FAILED', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 调用失败'
  }],
  ['DLL_RESPONSE_TOO_LARGE', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 响应过大'
  }],
  ['DLL_RESPONSE_INVALID', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 响应无效'
  }],
  ['DLL_ASYNC_UNSUPPORTED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 不支持异步调用'
  }],
  ['DLL_CALLBACK_UNSUPPORTED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 不支持回调调用'
  }],
  ['DLL_CANCEL_UNSUPPORTED', {
    code: errorCodes.notSupported,
    message: 'ZToolsService DLL 不支持取消任务'
  }],
  ['DLL_FUNCTION_NOT_FOUND', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 函数不存在'
  }],
  ['DLL_TASK_NOT_FOUND', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 任务不存在'
  }],
  ['DLL_TASK_NOT_RUNNING', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 任务未运行'
  }],
  ['DLL_TASK_DUPLICATE', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 任务标识重复'
  }],
  ['DLL_TASK_LIMIT', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 任务容量已满'
  }],
  ['DLL_BUSY', {
    code: errorCodes.dllError,
    message: 'ZToolsService DLL 仍有活动任务'
  }],
  ['DEPENDENCY_POLICY_UNAVAILABLE', {
    code: errorCodes.nativeHostError,
    message: 'ZToolsService System32-only 依赖策略不可用'
  }],
  ['EXPLORER_RESTART_UNAVAILABLE', {
    code: errorCodes.shellError,
    message: 'ZToolsService Explorer 重启执行器不可用'
  }],
  ['EXPLORER_ENUM_FAILED', {
    code: errorCodes.shellError,
    message: 'ZToolsService 无法枚举 Explorer'
  }],
  ['EXPLORER_OPEN_FAILED', {
    code: errorCodes.shellError,
    message: 'ZToolsService 无法打开 Explorer'
  }],
  ['EXPLORER_SESSION_INVALID', {
    code: errorCodes.shellError,
    message: 'ZToolsService Explorer 会话身份校验失败'
  }],
  ['EXPLORER_PATH_INVALID', {
    code: errorCodes.shellError,
    message: 'ZToolsService Explorer 路径校验失败'
  }],
  ['EXPLORER_NOT_FOUND', {
    code: errorCodes.shellError,
    message: 'ZToolsService 未找到当前会话 Explorer'
  }],
  ['EXPLORER_STOP_FAILED', {
    code: errorCodes.shellError,
    message: 'ZToolsService 停止 Explorer 失败'
  }],
  ['EXPLORER_STOP_TIMEOUT', {
    code: errorCodes.shellError,
    message: 'ZToolsService 停止 Explorer 超时'
  }],
  ['EXPLORER_START_FAILED', {
    code: errorCodes.shellError,
    message: 'ZToolsService 启动 Explorer 失败'
  }],
  ['CLIENT_SESSION_INVALID', {
    code: errorCodes.shellError,
    message: 'ZToolsService 客户端会话无效'
  }],
  ['USER_TOKEN_UNAVAILABLE', {
    code: errorCodes.shellError,
    message: 'ZToolsService 用户令牌不可用'
  }],
  ['USER_ENVIRONMENT_UNAVAILABLE', {
    code: errorCodes.shellError,
    message: 'ZToolsService 用户环境不可用'
  }]
])

const NON_FATAL_SERVICE_ERROR_CODES = new Set<ZToolsErrorCode>([
  errorCodes.invalidRequest,
  errorCodes.notSupported,
  errorCodes.permissionDenied,
  errorCodes.pluginNotFound,
  errorCodes.pluginIntegrity,
  errorCodes.dllError,
  errorCodes.nativeHostError,
  errorCodes.shellError
])

function isNonFatalServiceError(error: unknown): boolean {
  return error instanceof ZToolsError && NON_FATAL_SERVICE_ERROR_CODES.has(error.code)
}

export type ServiceClientState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'unavailable'
  | 'stopping'
  | 'closed'

interface FrameWaiter {
  resolve(frame: ServiceFrame): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class SocketFrameReader {
  readonly #decoder = new ServiceFrameDecoder()
  readonly #queue: ServiceFrame[] = []
  #waiter: FrameWaiter | null = null
  #closedError: Error | null = null

  constructor(socket: Socket, onClose: (error: Error) => void, onEvent: (frame: ServiceFrame) => void) {
    socket.on('data', (chunk) => {
      try {
        for (const frame of this.#decoder.push(chunk)) {
          if (frame.type === ServiceFrameType.TaskChanged) {
            onEvent(frame)
            continue
          }
          if (this.#waiter) {
            const waiter = this.#waiter
            this.#waiter = null
            clearTimeout(waiter.timer)
            waiter.resolve(frame)
          } else {
            if (this.#queue.length >= MAX_QUEUED_FRAMES) {
              throw new Error('Service sent too many unsolicited frames')
            }
            this.#queue.push(frame)
          }
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error('Service frame decode failed'))
        socket.destroy()
      }
    })
    socket.on('error', (error) => {
      this.close(error)
      onClose(error)
    })
    socket.on('close', () => {
      const error = new Error('Service connection closed')
      this.close(error)
      onClose(error)
    })
  }

  read(timeoutMs: number): Promise<ServiceFrame> {
    const queued = this.#queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.#closedError) return Promise.reject(this.#closedError)
    if (this.#waiter) return Promise.reject(new Error('Concurrent Service reads are not allowed'))
    return new Promise<ServiceFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#waiter) return
        this.#waiter = null
        reject(new ZToolsError(errorCodes.requestTimeout, 'ZToolsService 响应超时'))
      }, timeoutMs)
      this.#waiter = { resolve, reject, timer }
    })
  }

  close(error: Error): void {
    this.#closedError ??= error
    if (!this.#waiter) return
    const waiter = this.#waiter
    this.#waiter = null
    clearTimeout(waiter.timer)
    waiter.reject(this.#closedError)
  }
}

export interface ServiceClientOptions {
  pipeName?: string
  dataRoot?: string
  // Optional protocol-test override; production needs no installation key.
  secret?: Buffer
  readSecret?: () => Promise<Buffer>
}

export class ServiceClient implements PrivilegedDllClientPort {
  readonly #installedSecretPath: string | undefined
  #state: ServiceClientState = 'idle'
  #startGeneration = 0
  #startInFlight = false
  #socket: Socket | null = null
  #reader: SocketFrameReader | null = null
  #sessionKey: Buffer | null = null
  #nextRequestId = 1n
  #lastError = ''
  #lastErrorMessage = ''
  #requestInFlight = false
  #lifecycleSignal: AbortSignal | null = null
  #lifecycleAbortListener: (() => void) | null = null
  #taskEventsEnabled = false
  #lastEventId = 0n
  #eventSubscription: Promise<boolean> | undefined
  readonly #taskChangeListeners = new Set<(taskIds: string[]) => void>()
  readonly #requestWaiters: Array<{
    resume: () => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []

  private readonly options: ServiceClientOptions

  constructor(secretPathOrOptions: string | ServiceClientOptions = {}, options: ServiceClientOptions = {}) {
    if (typeof secretPathOrOptions === 'string') {
      this.options = options
      this.#installedSecretPath = secretPathOrOptions
    } else {
      this.options = secretPathOrOptions
      this.#installedSecretPath = secretPathOrOptions.dataRoot
        ? path.join(secretPathOrOptions.dataRoot, 'Service', 'auth-v1.key')
        : undefined
    }
  }

  get diagnostics(): {
    state: ServiceClientState
    protocolVersion: number
    pipe: string
    lastError: string
    lastErrorMessage: string
  } {
    return {
      state: this.#state,
      protocolVersion: 1,
      pipe: this.options.pipeName ?? SERVICE_PIPE_NAME,
      lastError: this.#lastError,
      lastErrorMessage: this.#lastErrorMessage
    }
  }

  async start(timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    if (this.#startInFlight ||
        (this.#state !== 'idle' && this.#state !== 'closed' && this.#state !== 'unavailable')) {
      throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 客户端状态不允许启动')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService 启动超时无效')
    }
    this.#releaseLifecycleAbortListener()
    const generation = ++this.#startGeneration
    this.#startInFlight = true
    if (signal) {
      this.#lifecycleSignal = signal
      const onAbort = (): void => this.stop()
      this.#lifecycleAbortListener = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
    this.#closeSocket()
    this.#state = 'connecting'
    this.#lastError = ''
    this.#lastErrorMessage = ''
    let secret: Buffer | null = null
    try {
      secret = this.options.secret
        ? Buffer.from(this.options.secret)
        : this.options.readSecret
          ? await this.options.readSecret()
          : this.#installedSecretPath
            ? await this.#readInstalledSecret()
            : null
      if (!this.#isCurrentStart(generation, signal)) return false
      const socket = createConnection(this.options.pipeName ?? SERVICE_PIPE_NAME)
      this.#socket = socket
      this.#reader = new SocketFrameReader(socket, (error) => {
        if (this.#socket !== socket ||
            this.#state === 'stopping' || this.#state === 'closed') return
        this.#lastError = errorCodes.serviceUnavailable
        this.#lastErrorMessage = error.message
        this.#state = 'unavailable'
        this.#sessionKey?.fill(0)
        this.#sessionKey = null
        this.#taskEventsEnabled = false
        this.#notifyTaskChange(['*'])
      }, (frame) => this.#handleTaskChange(frame))
      await this.#waitForConnect(socket, timeoutMs)
      if (!this.#isCurrentStart(generation, signal)) return false
      this.#state = 'authenticating'
      await this.#authenticate(secret, timeoutMs)
      if (!this.#isCurrentStart(generation, signal)) return false
      this.#state = 'ready'
      return true
    } catch (error) {
      if (generation === this.#startGeneration && !this.#isStoppingOrClosed()) {
        this.#lastError = error instanceof ZToolsError ? error.code : errorCodes.serviceUnavailable
        this.#lastErrorMessage = error instanceof Error ? error.message : 'ZToolsService 启动失败'
        this.#state = 'unavailable'
        this.#closeSocket()
      }
      return false
    } finally {
      secret?.fill(0)
      if (generation === this.#startGeneration) this.#startInFlight = false
    }
  }

  async request(payload: Uint8Array, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Buffer> {
    if (this.#state !== 'ready' || !this.#socket || !this.#reader || !this.#sessionKey) {
      throw new ZToolsError(errorCodes.serviceUnavailable, 'ZToolsService 尚未认证')
    }
    if (!(payload instanceof Uint8Array) ||
        payload.byteLength > SERVICE_MAX_PAYLOAD_BYTES - SERVICE_PROOF_BYTES) {
      throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService 请求载荷无效')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService 请求超时无效')
    }
    const connection = this.#socket
    const deadline = performance.now() + timeoutMs
    const requestPayload = Buffer.from(payload)
    await this.#acquireRequestSlot(timeoutMs)
    let requestStarted = false
    try {
      if (this.#socket !== connection || this.#state !== 'ready' || !this.#reader || !this.#sessionKey) {
        throw new ZToolsError(errorCodes.serviceUnavailable, 'ZToolsService 连接已变更')
      }
      const remainingMs = Math.ceil(deadline - performance.now())
      if (remainingMs <= 0) {
        throw new ZToolsError(errorCodes.requestTimeout, 'ZToolsService 请求排队超时')
      }
      const requestId = this.#takeRequestId()
      const request = sealServiceFrame(this.#sessionKey, 'client-to-service', {
        type: ServiceFrameType.Request,
        flags: 0,
        requestId,
        payload: requestPayload
      })
      requestStarted = true
      await this.#write(encodeServiceFrame(request))
      const response = openServiceFrame(
        this.#sessionKey,
        'service-to-client',
        await this.#reader.read(Math.max(1, Math.ceil(deadline - performance.now())))
      )
      if (response.requestId !== requestId ||
          (response.type !== ServiceFrameType.Response && response.type !== ServiceFrameType.Error)) {
        throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 响应身份无效')
      }
      if (response.type === ServiceFrameType.Error) {
        const code = response.payload.toString('ascii')
        const rejection = RECOVERABLE_SERVICE_REJECTIONS.get(code)
        if (rejection) {
          throw new ZToolsError(rejection.code, rejection.message, { hostCode: code })
        }
        throw new ZToolsError(
          errorCodes.serviceProtocol,
          `ZToolsService 返回错误: ${code}`,
          { hostCode: code }
        )
      }
      return response.payload
    } catch (error) {
      if (requestStarted && this.#socket === connection && !isNonFatalServiceError(error)) {
        if (!this.#isStoppingOrClosed()) {
          this.#lastError = error instanceof ZToolsError ? error.code : errorCodes.serviceProtocol
          this.#lastErrorMessage = error instanceof Error ? error.message : 'ZToolsService 请求失败'
          this.#state = 'unavailable'
          this.#closeSocket()
        }
      }
      throw error
    } finally {
      this.#releaseRequestSlot()
    }
  }

  #acquireRequestSlot(timeoutMs: number): Promise<void> {
    if (!this.#requestInFlight) {
      this.#requestInFlight = true
      return Promise.resolve()
    }
    if (this.#requestWaiters.length >= 32) {
      return Promise.reject(new ZToolsError(errorCodes.pluginBusy, 'ZToolsService 请求队列已满'))
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resume: resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#requestWaiters.indexOf(waiter)
          if (index >= 0) this.#requestWaiters.splice(index, 1)
          reject(new ZToolsError(errorCodes.requestTimeout, 'ZToolsService 请求排队超时'))
        }, timeoutMs)
      }
      this.#requestWaiters.push(waiter)
    })
  }

  #releaseRequestSlot(): void {
    const waiter = this.#requestWaiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resume()
    } else {
      this.#requestInFlight = false
    }
  }

  get taskEventsEnabled(): boolean { return this.#taskEventsEnabled }

  onTaskChange(listener: (taskIds: string[]) => void): () => void {
    this.#taskChangeListeners.add(listener)
    return () => { this.#taskChangeListeners.delete(listener) }
  }

  enableTaskEvents(): Promise<boolean> {
    if (this.#eventSubscription) return this.#eventSubscription
    this.#eventSubscription = (async () => {
      try {
        const response = await this.request(encodeServiceSubscribeTaskEvents())
        if (response.toString('utf8') !== '{"events":true}') {
          throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 事件订阅响应无效')
        }
        this.#taskEventsEnabled = true
        return true
      } catch (error) {
        if (error instanceof ZToolsError && error.code === errorCodes.notSupported) return false
        throw error
      }
    })()
    return this.#eventSubscription
  }

  #handleTaskChange(frame: ServiceFrame): void {
    if (!this.#sessionKey || this.#state !== 'ready' || !this.#eventSubscription) {
      throw new Error('Unsubscribed or unauthenticated service event')
    }
    const event = openServiceFrame(this.#sessionKey, 'service-to-client', frame)
    if (event.requestId <= this.#lastEventId) throw new Error('Replayed service event')
    const taskIds: unknown = JSON.parse(event.payload.toString('utf8'))
    if (!Array.isArray(taskIds) || taskIds.length > 257 ||
        taskIds.some((id) => typeof id !== 'string' || (id !== '*' && !/^task_[A-Za-z0-9_-]{1,123}$/.test(id)))) {
      throw new Error('Invalid service task notification')
    }
    this.#lastEventId = event.requestId
    this.#notifyTaskChange(taskIds)
  }

  #notifyTaskChange(taskIds: string[]): void {
    for (const listener of this.#taskChangeListeners) {
      try { listener(taskIds) } catch (error) { console.warn('DLL 任务通知处理失败', error) }
    }
  }

  async policyStatus(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ServicePolicyStatus> {
    return decodeServicePolicyStatus(
      await this.request(encodeServicePolicyCheck(), timeoutMs)
    )
  }

  async callDll(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<unknown> {
    return decodeServiceDllCall(
      await this.request(
        encodeServiceDllCall(pluginId, dllId, functionName, params),
        timeoutMs
      )
    )
  }

  async callDllAsync(
    pluginId: string,
    dllId: string,
    functionName: string,
    taskId: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<string> {
    const response = await this.request(
      encodeServiceDllCallAsync(pluginId, dllId, functionName, taskId, params),
      timeoutMs
    )
    decodeServiceDllTaskId(response, taskId)
    return taskId
  }

  async callDllWithCallback(
    pluginId: string,
    dllId: string,
    functionName: string,
    taskId: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<string> {
    const response = await this.request(
      encodeServiceDllCallWithCallback(pluginId, dllId, functionName, taskId, params),
      timeoutMs
    )
    decodeServiceDllTaskId(response, taskId)
    return taskId
  }

  async queryDllTask(
    pluginId: string,
    dllId: string,
    taskId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<ServiceDllTaskStatus> {
    return decodeServiceDllTaskStatus(
      await this.request(encodeServiceDllTaskQuery(pluginId, dllId, taskId), timeoutMs),
      taskId
    )
  }

  async cancelDllTask(
    pluginId: string,
    dllId: string,
    taskId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<number> {
    return decodeServiceDllTaskCode(
      await this.request(encodeServiceDllTaskCancel(pluginId, dllId, taskId), timeoutMs)
    )
  }

  async clearDllTask(
    pluginId: string,
    dllId: string,
    taskId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<void> {
    decodeServiceDllTaskSuccess(
      await this.request(encodeServiceDllTaskClear(pluginId, dllId, taskId), timeoutMs)
    )
  }

  async contextMenuCheckAdmin(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    return decodeServiceContextMenuCheckAdmin(
      await this.request(encodeServiceContextMenuCheckAdmin(), timeoutMs)
    )
  }

  async contextMenuRestartExplorer(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    decodeServiceContextMenuRestartExplorer(
      await this.request(encodeServiceContextMenuRestartExplorer(), timeoutMs)
    )
  }

  stop(): void {
    if (this.#state === 'closed' && !this.#startInFlight) return
    this.#startGeneration++
    this.#startInFlight = false
    this.#releaseLifecycleAbortListener()
    this.#state = 'stopping'
    this.#closeSocket()
    this.#state = 'closed'
  }

  #isStoppingOrClosed(): boolean {
    return this.#state === 'stopping' || this.#state === 'closed'
  }

  #isCurrentStart(generation: number, signal?: AbortSignal): boolean {
    return generation === this.#startGeneration &&
      !signal?.aborted &&
      !this.#isStoppingOrClosed()
  }

  #releaseLifecycleAbortListener(): void {
    const signal = this.#lifecycleSignal
    const listener = this.#lifecycleAbortListener
    this.#lifecycleSignal = null
    this.#lifecycleAbortListener = null
    if (signal && listener) signal.removeEventListener('abort', listener)
  }

  async #readInstalledSecret(): Promise<Buffer> {
    const secretPath = this.#installedSecretPath
    if (!secretPath || !path.isAbsolute(secretPath)) {
      throw new ZToolsError(errorCodes.serviceUnavailable, 'ZToolsService 安装密钥路径不可用')
    }
    let linkStats
    try {
      linkStats = await fs.lstat(secretPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new ZToolsError(
        errorCodes.serviceUnavailable,
        code === 'ENOENT' ? 'ZToolsService 安装密钥不存在' : 'ZToolsService 安装密钥不可读'
      )
    }
    if (!linkStats.isFile() || linkStats.isSymbolicLink() || linkStats.size !== SERVICE_SECRET_BYTES) {
      throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 安装密钥无效')
    }
    const file = await fs.open(secretPath, 'r')
    try {
      const stats = await file.stat()
      if (!stats.isFile() || stats.size !== SERVICE_SECRET_BYTES) {
        throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 安装密钥已变化')
      }
      const secret = Buffer.alloc(SERVICE_SECRET_BYTES)
      const { bytesRead } = await file.read(secret, 0, secret.length, 0)
      if (bytesRead !== secret.length || secret.every((byte) => byte === 0)) {
        secret.fill(0)
        throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 安装密钥无效')
      }
      return secret
    } finally {
      await file.close()
    }
  }

  #waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
    if (!socket.connecting) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(new ZToolsError(errorCodes.requestTimeout, 'ZToolsService 连接超时'))
      }, timeoutMs)
      const onConnect = (): void => {
        cleanup()
        resolve()
      }
      const onError = (error: NodeJS.ErrnoException): void => {
        cleanup()
        const suffix = error.code ? ` (${error.code})` : ''
        reject(new ZToolsError(errorCodes.serviceUnavailable, `ZToolsService 无法连接${suffix}`))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('error', onError)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  async #authenticate(secret: Buffer | null, timeoutMs: number): Promise<void> {
    if ((secret && (secret.length !== SERVICE_SECRET_BYTES || secret.every((byte) => byte === 0))) ||
        !this.#reader) {
      throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 握手参数无效')
    }
    const clientNonce = randomBytes(SERVICE_NONCE_BYTES)
    let serverNonce: Buffer | null = null
    let sessionKey: Buffer | null = null
    try {
      const helloId = this.#takeRequestId()
      await this.#write(encodeServiceFrame({
        type: ServiceFrameType.ClientHello,
        flags: 0,
        requestId: helloId,
        payload: clientNonce
      }))
      const serverHello = await this.#reader.read(timeoutMs)
      if (serverHello.type !== ServiceFrameType.ServerHello || serverHello.flags !== 0 ||
          serverHello.requestId !== helloId ||
          serverHello.payload.length !== SERVICE_NONCE_BYTES + SERVICE_PROOF_BYTES) {
        throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService ServerHello 无效')
      }
      serverNonce = Buffer.from(serverHello.payload.subarray(0, SERVICE_NONCE_BYTES))
      // 无安装密钥模式依赖 Windows 管道身份校验，随机数仅用于会话帧校验。
      const handshakeKey = secret ?? serverNonce
      const suppliedProof = serverHello.payload.subarray(SERVICE_NONCE_BYTES)
      const expectedProof = makeServiceServerProof(handshakeKey, process.pid, clientNonce, serverNonce)
      const serverAuthenticated = timingSafeEqual(suppliedProof, expectedProof)
      expectedProof.fill(0)
      if (!serverAuthenticated) {
        throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 服务端认证失败')
      }
      sessionKey = deriveServiceSessionKey(handshakeKey, process.pid, clientNonce, serverNonce)
      const clientProof = makeServiceClientProof(handshakeKey, process.pid, clientNonce, serverNonce)
      const authId = this.#takeRequestId()
      await this.#write(encodeServiceFrame({
        type: ServiceFrameType.ClientAuth,
        flags: 0,
        requestId: authId,
        payload: clientProof
      }))
      clientProof.fill(0)
      const acknowledged = openServiceFrame(
        sessionKey,
        'service-to-client',
        await this.#reader.read(timeoutMs)
      )
      if (acknowledged.type !== ServiceFrameType.Response || acknowledged.requestId !== authId ||
          acknowledged.payload.toString('ascii') !== 'AUTHENTICATED') {
        throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 客户端认证失败')
      }
      this.#sessionKey = sessionKey
      sessionKey = null
    } finally {
      clientNonce.fill(0)
      serverNonce?.fill(0)
      sessionKey?.fill(0)
    }
  }

  #takeRequestId(): bigint {
    if (this.#nextRequestId > 0xffffffffffffffffn) {
      throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService request ID 已耗尽')
    }
    const value = this.#nextRequestId
    this.#nextRequestId += 1n
    return value
  }

  #write(bytes: Buffer): Promise<void> {
    const socket = this.#socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new ZToolsError(errorCodes.serviceUnavailable, 'ZToolsService 连接已关闭'))
    }
    return new Promise<void>((resolve, reject) => {
      socket.write(bytes, (error?: Error | null) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  #closeSocket(): void {
    this.#taskEventsEnabled = false
    this.#eventSubscription = undefined
    this.#lastEventId = 0n
    for (const waiter of this.#requestWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new ZToolsError(errorCodes.serviceUnavailable, 'ZToolsService 连接已关闭'))
    }
    this.#reader?.close(new Error('Service client closed'))
    this.#reader = null
    this.#socket?.destroy()
    this.#socket = null
    this.#sessionKey?.fill(0)
    this.#sessionKey = null
    this.#nextRequestId = 1n
  }
}
