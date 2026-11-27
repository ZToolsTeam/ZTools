import { resolveSdkText } from '../core/environment.js'

const TOOL_RUNTIME_PROGRESS_EVENT = 'tool_runtime_progress'

const TOOL_RUNTIME_SDK_ERROR_CODES = Object.freeze({
  invalidRequest: 'TOOL_INVALID_REQUEST',
  capabilityUnsupported: 'TOOL_CAPABILITY_UNSUPPORTED',
  capabilityProvisionFailed: 'TOOL_CAPABILITY_PROVISION_FAILED',
  pathDenied: 'TOOL_PATH_DENIED',
  policyViolation: 'TOOL_POLICY_VIOLATION',
  trustVerificationFailed: 'TOOL_TRUST_VERIFICATION_FAILED',
  toolRevoked: 'TOOL_REVOKED',
  toolRollbackBlocked: 'TOOL_ROLLBACK_BLOCKED',
  taskCancelled: 'TOOL_TASK_CANCELLED',
  taskNotFound: 'TOOL_TASK_NOT_FOUND',
  concurrencyLimited: 'TOOL_CONCURRENCY_LIMITED',
  executionTimeout: 'TOOL_EXECUTION_TIMEOUT',
  toolBinaryUnavailable: 'TOOL_BINARY_UNAVAILABLE',
  executionFailed: 'TOOL_EXECUTION_FAILED'
})

function inferFallbackToolMeta(code, toolCode) {
  const effective = toolCode || code
  switch (effective) {
    case 'TOOL_INVALID_REQUEST':
    case 'TOOL_POLICY_VIOLATION':
    case 'TOOL_TASK_NOT_FOUND':
    case 'INVALID_REQUEST':
      return { stage: 'validation', retryable: false, userAction: 'none' }
    case 'TOOL_CAPABILITY_UNSUPPORTED':
    case 'NOT_SUPPORTED':
    case 'PLATFORM_NOT_SUPPORTED':
      return { stage: 'validation', retryable: false, userAction: 'update_client' }
    case 'TOOL_PATH_DENIED':
    case 'PERMISSION_DENIED':
    case 'PLUGIN_PERMISSION_REQUIRED':
      return { stage: 'validation', retryable: false, userAction: 'check_permissions' }
    case 'TOOL_CAPABILITY_PROVISION_FAILED':
    case 'NETWORK_ERROR':
      return { stage: 'provisioning', retryable: true, userAction: 'check_network' }
    case 'TOOL_TRUST_VERIFICATION_FAILED':
    case 'PLUGIN_INTEGRITY_ERROR':
      return { stage: 'verifying', retryable: true, userAction: 'reinstall_tool' }
    case 'TOOL_REVOKED':
    case 'TOOL_ROLLBACK_BLOCKED':
      return { stage: 'verifying', retryable: false, userAction: 'update_client' }
    case 'TOOL_TASK_CANCELLED':
    case 'CANCELLED':
    case 'CALLER_DESTROYED':
      return { stage: 'executing', retryable: false, userAction: 'none' }
    case 'TOOL_CONCURRENCY_LIMITED':
    case 'PLUGIN_BUSY':
      return { stage: 'executing', retryable: true, userAction: 'retry' }
    case 'TOOL_EXECUTION_TIMEOUT':
    case 'REQUEST_TIMEOUT':
    case 'CALL_TIMEOUT':
      return { stage: 'executing', retryable: true, userAction: 'retry' }
    case 'TOOL_BINARY_UNAVAILABLE':
      return { stage: 'executing', retryable: true, userAction: 'reinstall_tool' }
    default:
      return { stage: 'executing', retryable: true, userAction: 'retry' }
  }
}

function enrichToolRuntimeError(err, rawDetails) {
  if (!err || typeof err !== 'object') return err
  const details =
    rawDetails && typeof rawDetails === 'object'
      ? { ...rawDetails }
      : err.details && typeof err.details === 'object'
        ? { ...err.details }
        : null
  if (!details) return err
  err.details = details
  if (typeof details.toolCode === 'string') err.toolCode = details.toolCode
  if (typeof details.stage === 'string') err.stage = details.stage
  if (typeof details.retryable === 'boolean') err.retryable = details.retryable
  if (typeof details.userAction === 'string') err.userAction = details.userAction
  if (typeof details.primitiveId === 'string') err.primitiveId = details.primitiveId
  if (typeof details.timedOut === 'boolean') err.timedOut = details.timedOut
  if (typeof details.exitCode === 'number') err.exitCode = details.exitCode
  if (typeof details.attempts === 'number') err.attempts = details.attempts
  if (typeof details.detail === 'string') err.detail = details.detail
  return err
}

/**
 * ToolRuntime API - 第三方引擎工具池与主进程薄原语调用桥接
 * 统一封装 tool_runtime_*、tool_task_cancel、tool_commonlibs_*、tool_media_* 与 tool_download_* IPC，
 * 同时提供结构化错误透传/规整（normalizeError）与实时进度事件订阅（onProgress / offProgress）。
 */
class ToolRuntimeAPI {
  constructor(transport, events = null) {
    this.transport = transport
    this.events = events
    this.ERROR_CODES = TOOL_RUNTIME_SDK_ERROR_CODES
    this._progressWrappers = new Map()

    // 能力域与工具池管理子命名空间
    this.commonLibs = {
      list: () => this.listCommonLibs(),
      clean: (request = {}) => this.cleanCommonLibs(request)
    }

    this.media = {
      probe: (request) => this.mediaProbe(request),
      transcode: (request, options = {}) => this.mediaTranscode(request, options)
    }

    this.download = {
      streamProbe: (request) => this.downloadStreamProbe(request),
      streamRun: (request, options = {}) => this.downloadStreamRun(request, options),
      transferAdd: (request) => this.downloadTransferAdd(request),
      transferPause: (taskId) => this.downloadTransferPause(taskId),
      transferResume: (taskId) => this.downloadTransferResume(taskId),
      transferCancel: (taskId) => this.downloadTransferCancel(taskId),
      transferStatus: (taskId) => this.downloadTransferStatus(taskId)
    }
  }

  /**
   * 底层统一调用分发：
   * 1. 若 preload 暴露了 window.__ztoolsElectron.ipc[method]，优先直调并解包标准信封（完整保留 details/toolCode）；
   * 2. 否则走标准 Transport.call（覆盖 window.__ztoolsElectron.transport.methods 与 CEF 通道）。
   */
  async _invoke(method, params = {}, options = {}) {
    const directIpc =
      typeof window !== 'undefined' &&
      window.__ztoolsElectron &&
      window.__ztoolsElectron.ipc &&
      typeof window.__ztoolsElectron.ipc[method] === 'function'
        ? window.__ztoolsElectron.ipc[method]
        : null

    if (directIpc) {
      const response = await directIpc(params)
      if (response && typeof response === 'object' && response.success === false) {
        const message =
          (response.error && response.error.message) ||
          (typeof response.error === 'string' ? response.error : '') ||
          resolveSdkText('工具运行时调用失败', 'Tool runtime call failed')
        const err = new Error(message)
        err.code = (response.error && response.error.code) || response.code || 'TOOL_EXECUTION_FAILED'
        const details = response.error && typeof response.error === 'object' ? response.error.details : undefined
        throw enrichToolRuntimeError(err, details)
      }
      if (response && typeof response === 'object' && response.success === true && 'data' in response) {
        return response.data
      }
      return response
    }

    try {
      return await this.transport.call(method, params, options)
    } catch (error) {
      throw enrichToolRuntimeError(error, error && error.details)
    }
  }

  /**
   * 将任意薄原语异常规整为面向插件 UI 的稳定结构化错误描述，
   * 便于插件按 toolCode / stage / retryable / userAction 渲染友好提示与操作按钮。
   */
  normalizeError(error) {
    const raw = error && typeof error === 'object' ? error : null
    const details = raw && raw.details && typeof raw.details === 'object' ? raw.details : {}
    const code = (raw && typeof raw.code === 'string' && raw.code) || 'TOOL_EXECUTION_FAILED'
    const toolCode =
      (raw && typeof raw.toolCode === 'string' && raw.toolCode) ||
      (typeof details.toolCode === 'string' && details.toolCode) ||
      (code.startsWith('TOOL_') ? code : undefined)
    const fallbackMeta = inferFallbackToolMeta(code, toolCode)
    const message =
      (raw && typeof raw.message === 'string' && raw.message.trim()) ||
      (typeof error === 'string' && error.trim()) ||
      resolveSdkText('工具运行时调用失败', 'Tool runtime call failed')

    return Object.freeze({
      code,
      ...(toolCode ? { toolCode } : {}),
      message,
      stage:
        (raw && typeof raw.stage === 'string' && raw.stage) ||
        (typeof details.stage === 'string' && details.stage) ||
        fallbackMeta.stage,
      retryable:
        typeof (raw && raw.retryable) === 'boolean'
          ? raw.retryable
          : typeof details.retryable === 'boolean'
            ? details.retryable
            : fallbackMeta.retryable,
      userAction:
        (raw && typeof raw.userAction === 'string' && raw.userAction) ||
        (typeof details.userAction === 'string' && details.userAction) ||
        fallbackMeta.userAction,
      ...(typeof (raw && raw.primitiveId) === 'string'
        ? { primitiveId: raw.primitiveId }
        : typeof details.primitiveId === 'string'
          ? { primitiveId: details.primitiveId }
          : {}),
      ...(typeof (raw && raw.timedOut) === 'boolean'
        ? { timedOut: raw.timedOut }
        : typeof details.timedOut === 'boolean'
          ? { timedOut: details.timedOut }
          : {}),
      ...(typeof (raw && raw.exitCode) === 'number'
        ? { exitCode: raw.exitCode }
        : typeof details.exitCode === 'number'
          ? { exitCode: details.exitCode }
          : {}),
      ...(typeof (raw && raw.attempts) === 'number'
        ? { attempts: raw.attempts }
        : typeof details.attempts === 'number'
          ? { attempts: details.attempts }
          : {}),
      ...(typeof (raw && raw.detail) === 'string'
        ? { detail: raw.detail }
        : typeof details.detail === 'string'
          ? { detail: details.detail }
          : {})
    })
  }

  /**
   * 订阅宿主推送的薄原语实时进度与状态事件（tool_runtime_progress），
   * 支持按 taskId / primitiveId 过滤，返回幂等的取消订阅函数。
   */
  onProgress(listener, filter = {}) {
    if (typeof listener !== 'function') {
      throw new TypeError('onProgress listener must be a function')
    }
    const eventsBus =
      this.events ||
      (typeof window !== 'undefined' && window.ztools && window.ztools.events ? window.ztools.events : null)
    if (!eventsBus || typeof eventsBus.on !== 'function') {
      return () => {}
    }

    const filterTaskId = filter && typeof filter.taskId === 'string' ? filter.taskId : undefined
    const filterPrimitiveId = filter && typeof filter.primitiveId === 'string' ? filter.primitiveId : undefined

    const wrapped = (envelope) => {
      const payload =
        envelope && typeof envelope === 'object' && envelope.payload && typeof envelope.payload === 'object'
          ? envelope.payload
          : envelope
      if (!payload || typeof payload !== 'object') return
      if (filterTaskId && payload.taskId !== filterTaskId) return
      if (filterPrimitiveId && payload.primitiveId !== filterPrimitiveId) return
      listener(payload)
    }

    let entries = this._progressWrappers.get(listener)
    if (!entries) {
      entries = new Set()
      this._progressWrappers.set(listener, entries)
    }
    entries.add(wrapped)
    eventsBus.on(TOOL_RUNTIME_PROGRESS_EVENT, wrapped)

    let active = true
    return () => {
      if (!active) return
      active = false
      eventsBus.off(TOOL_RUNTIME_PROGRESS_EVENT, wrapped)
      const current = this._progressWrappers.get(listener)
      if (current) {
        current.delete(wrapped)
        if (current.size === 0) {
          this._progressWrappers.delete(listener)
        }
      }
    }
  }

  /** 取消指定的薄原语进度事件监听（不传 listener 则清理当前实例注册的全部监听） */
  offProgress(listener) {
    const eventsBus =
      this.events ||
      (typeof window !== 'undefined' && window.ztools && window.ztools.events ? window.ztools.events : null)
    if (!eventsBus || typeof eventsBus.off !== 'function') return

    if (typeof listener === 'function') {
      const entries = this._progressWrappers.get(listener)
      if (!entries) return
      for (const wrapped of entries) {
        eventsBus.off(TOOL_RUNTIME_PROGRESS_EVENT, wrapped)
      }
      this._progressWrappers.delete(listener)
      return
    }

    for (const entries of this._progressWrappers.values()) {
      for (const wrapped of entries) {
        eventsBus.off(TOOL_RUNTIME_PROGRESS_EVENT, wrapped)
      }
    }
    this._progressWrappers.clear()
  }

  // ============ 运行时能力探测与任务控制 ============

  /** 查询宿主支持的薄原语能力及当前就绪状态 */
  async getCapabilities() {
    return await this._invoke('tool_runtime_capabilities', {})
  }

  /** 确保指定薄原语所需引擎已就绪（按需触发签名拉取） */
  async ensure(primitiveId) {
    return await this._invoke('tool_runtime_ensure', { primitiveId }, { timeout: Infinity })
  }

  /** 取消正在执行的薄原语任务 */
  async cancelTask(taskId) {
    return await this._invoke('tool_task_cancel', { taskId })
  }

  // ============ CommonLibs 工具池与存储管理 ============

  /** 列出本机已缓存的 CommonLibs 版本与磁盘占用 */
  async listCommonLibs() {
    return await this._invoke('tool_commonlibs_list', {})
  }

  /** 清理指定未引用/已撤销工具版本，或执行一次过期引擎垃圾回收 */
  async cleanCommonLibs(request = {}) {
    return await this._invoke('tool_commonlibs_clean', request || {})
  }

  // ============ 媒体能力域（media.*） ============

  /** 探测授权媒体文件的流元信息 */
  async mediaProbe(request) {
    return await this._invoke('tool_media_probe', request)
  }

  /** 执行结构化受控音视频变换 */
  async mediaTranscode(request, options = {}) {
    return await this._invoke('tool_media_transcode_run', request, {
      timeout: Infinity,
      ...options
    })
  }

  // ============ 下载能力域（download.*） ============

  /** 解析流媒体源可选轨道信息 */
  async downloadStreamProbe(request) {
    return await this._invoke('tool_download_stream_probe', request)
  }

  /** 下载指定流媒体轨道至授权目录 */
  async downloadStreamRun(request, options = {}) {
    return await this._invoke('tool_download_stream_run', request, {
      timeout: Infinity,
      ...options
    })
  }

  /** 创建多连接断点续传下载任务 */
  async downloadTransferAdd(request) {
    return await this._invoke('tool_download_transfer_add', request)
  }

  /** 暂停下载任务 */
  async downloadTransferPause(taskId) {
    return await this._invoke('tool_download_transfer_pause', { taskId })
  }

  /** 恢复下载任务 */
  async downloadTransferResume(taskId) {
    return await this._invoke('tool_download_transfer_resume', { taskId })
  }

  /** 取消下载任务 */
  async downloadTransferCancel(taskId) {
    return await this._invoke('tool_download_transfer_cancel', { taskId })
  }

  /** 查询单个或全部传输任务状态 */
  async downloadTransferStatus(taskId) {
    const params = taskId ? { taskId } : {}
    return await this._invoke('tool_download_transfer_status', params)
  }
}

export default ToolRuntimeAPI
