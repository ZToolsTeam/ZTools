import type { PrivilegedDllClientPort } from '../native-host/dll-client-port.js'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createConnection } from 'node:net'
import { errorCodes, ZToolsError, type ZToolsErrorCode } from '../../contracts/errors.js'
import { MAX_TIMEOUT_MS } from '../../contracts/ipc.js'
import { t } from '../i18n/index.js'
import { ServiceBridgeTransport, type ServiceTransport } from './service-transport.js'
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
  i18nKey: string
}>([
  ['MANIFEST_UNTRUSTED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.MANIFEST_UNTRUSTED' }],
  ['MANIFEST_REVOKED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.MANIFEST_REVOKED' }],
  ['MANIFEST_ROLLBACK', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.MANIFEST_ROLLBACK' }],
  ['MANIFEST_INTEGRITY', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.MANIFEST_INTEGRITY' }],
  ['MANIFEST_INVALID', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.MANIFEST_INVALID' }],
  ['MANIFEST_UNAVAILABLE', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.MANIFEST_UNAVAILABLE' }],
  ['DLL_NOT_ALLOWED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.DLL_NOT_ALLOWED' }],
  ['FUNCTION_NOT_ALLOWED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.FUNCTION_NOT_ALLOWED' }],
  ['DLL_INTEGRITY', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.DLL_INTEGRITY' }],
  ['COMMAND_INVALID', { code: errorCodes.invalidRequest, i18nKey: 'serviceClient.rejection.COMMAND_INVALID' }],
  ['COMMAND_TOO_LARGE', { code: errorCodes.invalidRequest, i18nKey: 'serviceClient.rejection.COMMAND_TOO_LARGE' }],
  ['INVALID_REQUEST', { code: errorCodes.invalidRequest, i18nKey: 'serviceClient.rejection.INVALID_REQUEST' }],
  ['NOT_SUPPORTED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.NOT_SUPPORTED' }],
  ['COMMAND_NOT_ALLOWED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.COMMAND_NOT_ALLOWED' }],
  ['TARGET_NOT_ALLOWED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.TARGET_NOT_ALLOWED' }],
  ['EXECUTION_DISABLED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.EXECUTION_DISABLED' }],
  ['DLL_ARCH_INVALID', { code: errorCodes.pluginIntegrity, i18nKey: 'serviceClient.rejection.DLL_ARCH_INVALID' }],
  ['DLL_PATH_INVALID', { code: errorCodes.pluginIntegrity, i18nKey: 'serviceClient.rejection.DLL_PATH_INVALID' }],
  ['DLL_UNAVAILABLE', { code: errorCodes.pluginNotFound, i18nKey: 'serviceClient.rejection.DLL_UNAVAILABLE' }],
  ['DLL_LOAD_FAILED', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_LOAD_FAILED' }],
  ['DLL_HOST_INTERNAL', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_HOST_INTERNAL' }],
  ['DLL_NAME_COLLISION', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_NAME_COLLISION' }],
  ['DLL_PATH_CHANGED', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_PATH_CHANGED' }],
  ['DLL_COMMAND_NOT_ALLOWED', { code: errorCodes.permissionDenied, i18nKey: 'serviceClient.rejection.DLL_COMMAND_NOT_ALLOWED' }],
  ['DLL_EXPORTS_INVALID', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_EXPORTS_INVALID' }],
  ['DLL_INIT_FAILED', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_INIT_FAILED' }],
  ['DLL_INFO_INVALID', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DLL_INFO_INVALID' }],
  ['HOST_STOPPING', { code: errorCodes.appStopping, i18nKey: 'serviceClient.rejection.HOST_STOPPING' }],
  ['DLL_CALL_FAILED', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_CALL_FAILED' }],
  ['DLL_RESPONSE_TOO_LARGE', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_RESPONSE_TOO_LARGE' }],
  ['DLL_RESPONSE_INVALID', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_RESPONSE_INVALID' }],
  ['DLL_ASYNC_UNSUPPORTED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.DLL_ASYNC_UNSUPPORTED' }],
  ['DLL_CALLBACK_UNSUPPORTED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.DLL_CALLBACK_UNSUPPORTED' }],
  ['DLL_CANCEL_UNSUPPORTED', { code: errorCodes.notSupported, i18nKey: 'serviceClient.rejection.DLL_CANCEL_UNSUPPORTED' }],
  ['DLL_FUNCTION_NOT_FOUND', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_FUNCTION_NOT_FOUND' }],
  ['DLL_TASK_NOT_FOUND', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_TASK_NOT_FOUND' }],
  ['DLL_TASK_NOT_RUNNING', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_TASK_NOT_RUNNING' }],
  ['DLL_TASK_DUPLICATE', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_TASK_DUPLICATE' }],
  ['DLL_TASK_LIMIT', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_TASK_LIMIT' }],
  ['DLL_BUSY', { code: errorCodes.dllError, i18nKey: 'serviceClient.rejection.DLL_BUSY' }],
  ['DEPENDENCY_POLICY_UNAVAILABLE', { code: errorCodes.nativeHostError, i18nKey: 'serviceClient.rejection.DEPENDENCY_POLICY_UNAVAILABLE' }],
  ['EXPLORER_RESTART_UNAVAILABLE', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_RESTART_UNAVAILABLE' }],
  ['EXPLORER_ENUM_FAILED', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_ENUM_FAILED' }],
  ['EXPLORER_OPEN_FAILED', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_OPEN_FAILED' }],
  ['EXPLORER_SESSION_INVALID', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_SESSION_INVALID' }],
  ['EXPLORER_PATH_INVALID', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_PATH_INVALID' }],
  ['EXPLORER_NOT_FOUND', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_NOT_FOUND' }],
  ['EXPLORER_STOP_FAILED', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_STOP_FAILED' }],
  ['EXPLORER_STOP_TIMEOUT', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_STOP_TIMEOUT' }],
  ['EXPLORER_START_FAILED', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.EXPLORER_START_FAILED' }],
  ['CLIENT_SESSION_INVALID', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.CLIENT_SESSION_INVALID' }],
  ['USER_TOKEN_UNAVAILABLE', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.USER_TOKEN_UNAVAILABLE' }],
  ['USER_ENVIRONMENT_UNAVAILABLE', { code: errorCodes.shellError, i18nKey: 'serviceClient.rejection.USER_ENVIRONMENT_UNAVAILABLE' }]
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

  constructor(socket: ServiceTransport, onClose: (error: Error) => void, onEvent: (frame: ServiceFrame) => void) {
    const finishStream = (transportError: Error): Error => {
      if (this.#closedError) return this.#closedError
      try {
        this.#decoder.finish()
        return transportError
      } catch (error) {
        return error instanceof Error
          ? error
          : new ZToolsError(errorCodes.serviceProtocol, 'Service frame decode failed')
      }
    }
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
              throw new ZToolsError(errorCodes.serviceProtocol, 'Service sent too many unsolicited frames')
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
      const failure = finishStream(error)
      this.close(failure)
      onClose(failure)
    })
    socket.on('close', () => {
      const error = finishStream(new Error('Service connection closed'))
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
        reject(new ZToolsError(errorCodes.requestTimeout, t('serviceClient.error.responseTimeout'), {
          i18nKey: 'serviceClient.error.responseTimeout'
        }))
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
  bridgeExecutable?: string
  // 测试宿主可显式提供已由其验证的传输；生产由原生桥持有并核验实际通信管道。
  createTransport?: (pipeName: string) => ServiceTransport
  // 仅用于协议与生命周期单元测试；生产环境通过 Windows 管道身份校验，无需安装密钥。
  secret?: Buffer
  readSecret?: () => Promise<Buffer>
}

export class ServiceClient implements PrivilegedDllClientPort {
  #state: ServiceClientState = 'idle'
  #startGeneration = 0
  #startInFlight = false
  #socket: ServiceTransport | null = null
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

  constructor(private readonly options: ServiceClientOptions = {}) {}

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
      throw new ZToolsError(errorCodes.serviceProtocol, t('serviceClient.error.invalidStartState'), {
        i18nKey: 'serviceClient.error.invalidStartState'
      })
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new ZToolsError(errorCodes.invalidRequest, t('serviceClient.error.invalidStartTimeout'), {
        i18nKey: 'serviceClient.error.invalidStartTimeout'
      })
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
          : null
      if (!this.#isCurrentStart(generation, signal)) return false
      const pipeName = this.options.pipeName ?? SERVICE_PIPE_NAME
      const socket = this.options.createTransport
        ? this.options.createTransport(pipeName)
        : this.options.bridgeExecutable
          ? new ServiceBridgeTransport(this.options.bridgeExecutable, pipeName, timeoutMs)
          : createConnection(pipeName)
      this.#socket = socket
      this.#reader = new SocketFrameReader(socket, (error) => {
        if (this.#socket !== socket ||
            this.#state === 'stopping' || this.#state === 'closed') return
        this.#lastError = error instanceof ZToolsError ? error.code : errorCodes.serviceUnavailable
        this.#lastErrorMessage = error.message
        this.#state = 'unavailable'
        this.#sessionKey?.fill(0)
        this.#sessionKey = null
        this.#taskEventsEnabled = false
        this.#notifyTaskChange(['*'])
      }, (frame) => this.#handleTaskChange(frame))
      await this.#waitForConnect(socket, timeoutMs, signal)
      if (!this.#isCurrentStart(generation, signal)) return false
      if (!secret && !this.options.bridgeExecutable && !this.options.createTransport) {
        throw new ZToolsError(errorCodes.serviceAuthentication, t('serviceClient.error.missingServerAuth'), {
          i18nKey: 'serviceClient.error.missingServerAuth'
        })
      }
      this.#state = 'authenticating'
      await this.#authenticate(secret, timeoutMs)
      if (!this.#isCurrentStart(generation, signal)) return false
      this.#state = 'ready'
      return true
    } catch (error) {
      if (generation === this.#startGeneration && !this.#isStoppingOrClosed()) {
        this.#lastError = error instanceof ZToolsError ? error.code : errorCodes.serviceUnavailable
        this.#lastErrorMessage = this.#resolveLastErrorMessage(error, 'serviceClient.error.startFailed')
        this.#state = 'unavailable'
        this.#closeSocket()
        if (error instanceof ZToolsError &&
            (error.code === errorCodes.serviceAuthentication || error.code === errorCodes.serviceProtocol)) {
          this.#releaseLifecycleAbortListener()
          throw error
        }
      }
      return false
    } finally {
      secret?.fill(0)
      if (generation === this.#startGeneration) this.#startInFlight = false
    }
  }

  async request(payload: Uint8Array, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Buffer> {
    if (this.#state !== 'ready' || !this.#socket || !this.#reader || !this.#sessionKey) {
      throw new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.notAuthenticated'), {
        i18nKey: 'serviceClient.error.notAuthenticated'
      })
    }
    if (!(payload instanceof Uint8Array) ||
        payload.byteLength > SERVICE_MAX_PAYLOAD_BYTES - SERVICE_PROOF_BYTES) {
      throw new ZToolsError(errorCodes.invalidRequest, t('serviceClient.error.invalidRequestPayload'), {
        i18nKey: 'serviceClient.error.invalidRequestPayload'
      })
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new ZToolsError(errorCodes.invalidRequest, t('serviceClient.error.invalidRequestTimeout'), {
        i18nKey: 'serviceClient.error.invalidRequestTimeout'
      })
    }
    const connection = this.#socket
    const deadline = performance.now() + timeoutMs
    const requestPayload = Buffer.from(payload)
    await this.#acquireRequestSlot(timeoutMs)
    let requestStarted = false
    try {
      if (this.#socket !== connection || this.#state !== 'ready' || !this.#reader || !this.#sessionKey) {
        throw new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectionChanged'), {
          i18nKey: 'serviceClient.error.connectionChanged'
        })
      }
      const remainingMs = Math.ceil(deadline - performance.now())
      if (remainingMs <= 0) {
        throw new ZToolsError(errorCodes.requestTimeout, t('serviceClient.error.requestQueueTimeout'), {
          i18nKey: 'serviceClient.error.requestQueueTimeout'
        })
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
        throw new ZToolsError(errorCodes.serviceProtocol, t('serviceClient.error.invalidResponseIdentity'), {
          i18nKey: 'serviceClient.error.invalidResponseIdentity'
        })
      }
      if (response.type === ServiceFrameType.Error) {
        const code = response.payload.toString('ascii')
        const rejection = RECOVERABLE_SERVICE_REJECTIONS.get(code)
        if (rejection) {
          throw new ZToolsError(rejection.code, t(rejection.i18nKey), {
            hostCode: code,
            i18nKey: rejection.i18nKey
          })
        }
        throw new ZToolsError(
          errorCodes.serviceProtocol,
          t('serviceClient.error.returnedError', { code }),
          { hostCode: code, i18nKey: 'serviceClient.error.returnedError', i18nParams: { code } }
        )
      }
      return response.payload
    } catch (error) {
      if (requestStarted && this.#socket === connection && !isNonFatalServiceError(error)) {
        if (!this.#isStoppingOrClosed()) {
          this.#lastError = error instanceof ZToolsError ? error.code : errorCodes.serviceProtocol
          this.#lastErrorMessage = this.#resolveLastErrorMessage(error, 'serviceClient.error.requestFailed')
          this.#state = 'unavailable'
          this.#closeSocket()
        }
      }
      throw error
    } finally {
      this.#releaseRequestSlot()
    }
  }

  #resolveLastErrorMessage(error: unknown, fallbackKey: string): string {
    if (error instanceof ZToolsError) {
      if (error.details?.i18nKey) {
        return t(error.details.i18nKey, error.details.i18nParams)
      }
      return error.message
    }
    return t(fallbackKey)
  }

  #acquireRequestSlot(timeoutMs: number): Promise<void> {
    if (!this.#requestInFlight) {
      this.#requestInFlight = true
      return Promise.resolve()
    }
    if (this.#requestWaiters.length >= 32) {
      return Promise.reject(new ZToolsError(errorCodes.pluginBusy, t('serviceClient.error.requestQueueFull'), {
        i18nKey: 'serviceClient.error.requestQueueFull'
      }))
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resume: resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#requestWaiters.indexOf(waiter)
          if (index >= 0) this.#requestWaiters.splice(index, 1)
          reject(new ZToolsError(errorCodes.requestTimeout, t('serviceClient.error.requestQueueTimeout'), {
            i18nKey: 'serviceClient.error.requestQueueTimeout'
          }))
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
          throw new ZToolsError(errorCodes.serviceProtocol, t('serviceClient.error.invalidEventSubscription'), {
        i18nKey: 'serviceClient.error.invalidEventSubscription'
      })
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

  #waitForConnect(socket: ServiceTransport, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.#isStoppingOrClosed() || socket.destroyed) {
      return Promise.reject(new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectCancelled'), {
        i18nKey: 'serviceClient.error.connectCancelled'
      }))
    }
    if (!socket.connecting) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settleReject = (error: ZToolsError): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const timer = setTimeout(() => {
        socket.destroy()
        settleReject(new ZToolsError(errorCodes.requestTimeout, t('serviceClient.error.connectTimeout'), {
          i18nKey: 'serviceClient.error.connectTimeout'
        }))
      }, timeoutMs)
      const onConnect = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error instanceof ZToolsError &&
            (error.code === errorCodes.serviceAuthentication || error.code === errorCodes.serviceProtocol)) {
          settleReject(error)
          return
        }
        if (error.code) {
          settleReject(new ZToolsError(
            errorCodes.serviceUnavailable,
            t('serviceClient.error.connectFailedWithCode', { code: error.code }),
            { i18nKey: 'serviceClient.error.connectFailedWithCode', i18nParams: { code: error.code } }
          ))
        } else {
          settleReject(new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectFailed'), {
            i18nKey: 'serviceClient.error.connectFailed'
          }))
        }
      }
      const onClose = (): void => {
        settleReject(new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectionClosed'), {
          i18nKey: 'serviceClient.error.connectionClosed'
        }))
      }
      const onAbort = (): void => {
        socket.destroy()
        settleReject(new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectCancelled'), {
          i18nKey: 'serviceClient.error.connectCancelled'
        }))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.once('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async #authenticate(secret: Buffer | null, timeoutMs: number): Promise<void> {
    const clientProcessId = this.#socket?.clientProcessId ?? process.pid
    if ((secret && (secret.length !== SERVICE_SECRET_BYTES || secret.every((byte) => byte === 0))) ||
        !this.#reader) {
      throw new ZToolsError(errorCodes.serviceAuthentication, t('serviceClient.error.invalidHandshake'), {
        i18nKey: 'serviceClient.error.invalidHandshake'
      })
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
        throw new ZToolsError(errorCodes.serviceProtocol, t('serviceClient.error.invalidServerHello'), {
          i18nKey: 'serviceClient.error.invalidServerHello'
        })
      }
      serverNonce = Buffer.from(serverHello.payload.subarray(0, SERVICE_NONCE_BYTES))
      // 无安装密钥模式依赖 Windows 管道身份校验，随机数仅用于会话帧校验。
      const handshakeKey = secret ?? serverNonce
      const suppliedProof = serverHello.payload.subarray(SERVICE_NONCE_BYTES)
      const expectedProof = makeServiceServerProof(handshakeKey, clientProcessId, clientNonce, serverNonce)
      const serverAuthenticated = timingSafeEqual(suppliedProof, expectedProof)
      expectedProof.fill(0)
      if (!serverAuthenticated) {
        throw new ZToolsError(errorCodes.serviceAuthentication, t('serviceClient.error.serverAuthFailed'), {
          i18nKey: 'serviceClient.error.serverAuthFailed'
        })
      }
      sessionKey = deriveServiceSessionKey(handshakeKey, clientProcessId, clientNonce, serverNonce)
      const clientProof = makeServiceClientProof(handshakeKey, clientProcessId, clientNonce, serverNonce)
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
        throw new ZToolsError(errorCodes.serviceAuthentication, t('serviceClient.error.clientAuthFailed'), {
          i18nKey: 'serviceClient.error.clientAuthFailed'
        })
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
      throw new ZToolsError(errorCodes.serviceProtocol, t('serviceClient.error.requestIdExhausted'), {
        i18nKey: 'serviceClient.error.requestIdExhausted'
      })
    }
    const value = this.#nextRequestId
    this.#nextRequestId += 1n
    return value
  }

  #write(bytes: Buffer): Promise<void> {
    const socket = this.#socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectionClosed'), {
        i18nKey: 'serviceClient.error.connectionClosed'
      }))
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
      waiter.reject(new ZToolsError(errorCodes.serviceUnavailable, t('serviceClient.error.connectionClosed'), {
        i18nKey: 'serviceClient.error.connectionClosed'
      }))
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
