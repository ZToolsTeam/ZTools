/**
 * DLL Plugin API - DLL 插件接口
 * 提供 DLL 插件调用和任务管理功能
 */
const PROGRESS_EVENT_TYPE = 'dllplugin_progress'
const CALLBACK_RESULT_EVENT_TYPE = 'dllplugin_callback_result'


function copyTaskStartMetadata(taskInfo, value) {
  if (value.taskStartResolved === true || value.taskStartResolved === 'not-started' || value.taskStartPending === false) {
    taskInfo.startPending = false
  } else if (value.taskStartPending === true && taskInfo.startPending !== false) taskInfo.startPending = true
  for (const key of ['code', 'taskStartResolved', 'workNotStarted', 'workOutcome', 'noReplay']) {
    if (value[key] !== undefined) taskInfo[key] = value[key]
  }
}

function dllTaskFailure(value, message, taskId) {
  const error = new Error(message)
  for (const key of ['code', 'taskStartResolved', 'workNotStarted', 'workOutcome', 'noReplay']) {
    if (value?.[key] !== undefined) error[key] = value[key]
  }
  if (taskId) error.taskId = taskId
  return error
}

function taskObservationFailure(taskInfo, taskId, message, code = 'DLL_TASK_OUTCOME_UNKNOWN') {
  return Object.assign(new Error(message), {
    code, taskId, workOutcome: 'unknown', noReplay: true,
    startPending: taskInfo.startPending === true
  })
}

// 日志输出
function dllLog(...args) {
  console.log('[dllplugin]', ...args)
}

function dllError(...args) {
  console.error('[dllplugin]', ...args)
}

function toNumber(value, fallback = 0) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
}

function normalizeTaskStatus(value) {
  if (typeof value !== 'string') return null
  switch (value.toLowerCase()) {
    case 'invoking':
      return 'invoking'
    case 'progress':
    case 'pending':
    case 'processing':
    case 'running':
      return 'running'
    case 'complete':
    case 'completed':
    case 'done':
    case 'success':
      return 'completed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'error':
    case 'failed':
    case 'failure':
      return 'error'
    default:
      return null
  }
}

function isTerminalTaskStatus(status) {
  return status === 'completed' || status === 'cancelled' || status === 'error'
}

function getCallbackResultStatus(result, explicitError = null) {
  const isObject = result && typeof result === 'object' && !Array.isArray(result)
  const data = isObject && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data
    : null
  const typeStatus = normalizeTaskStatus(isObject ? result.type : null)
  const status = normalizeTaskStatus(isObject ? result.status : null)
  const nestedStatus = normalizeTaskStatus(data?.status)
  const error = explicitError || (isObject && result.error) || data?.error || null

  if (isObject && Object.hasOwn(result, 'type') && typeStatus === null) return 'unknown'
  if (typeStatus === 'running') {
    return 'running'
  }
  if (typeStatus === 'error') return 'error'
  if (typeStatus === 'cancelled') return 'cancelled'
  if (typeStatus === 'completed') return 'completed'
  if (status === 'error' || nestedStatus === 'error' || error) return 'error'
  if (status === 'cancelled' || nestedStatus === 'cancelled') return 'cancelled'
  if (status === 'completed' || nestedStatus === 'completed') return 'completed'
  if (typeStatus === 'running' || status === 'running' || nestedStatus === 'running') return 'running'

  if (isObject && (
    typeof result.type === 'string' ||
    typeof result.status === 'string' ||
    typeof data?.status === 'string'
  )) return 'unknown'

  // Older DLLs return a result object without a type/status envelope.
  return 'completed'
}

function getCallbackProgress(result, fallback = {}) {
  const data = result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result
  const directPercent = typeof result?.percent === 'number'
    ? result.percent
    : typeof data?.percent === 'number'
      ? data.percent
      : undefined
  const progress = typeof result?.progress === 'number'
    ? result.progress
    : typeof data?.progress === 'number'
      ? data.progress
      : undefined
  const rawPercent = directPercent ?? progress ?? fallback.percent ?? 0
  const percent = directPercent !== undefined || rawPercent > 1 ? rawPercent : rawPercent * 100
  return {
    percent: Math.max(0, Math.min(100, percent)),
    current: toNumber(data?.current, toNumber(data?.currentIndex, fallback.current || 0)),
    total: toNumber(data?.total, toNumber(data?.totalFiles, fallback.total || 0)),
    message: typeof data?.message === 'string' ? data.message : fallback.message || ''
  }
}

class DLLPluginAPI {
  constructor(transport, events) {
    this.transport = transport
    this.events = events
    this._listeners = {}
    this._tasks = new Map()
    this._callbackHandlers = new Map()
    this._startingTasks = new Set()
    this._eventsBound = false

    // 初始化事件桥接
    this._initEventBridge()
  }

  /**
   * 初始化事件桥接
   * @private
   */
  _initEventBridge() {
    if (!this.events || typeof this.events.on !== 'function') {
      dllError('Events module not available')
      return
    }

    const handler = (envelope) => {
      if (!envelope || !envelope.payload) {
        return
      }

      const payload = envelope.payload
      const taskId = payload.taskId || payload.id
      if (!taskId) {
        return
      }

      const now = Date.now()
      let taskInfo = this._tasks.get(taskId)
      if (!taskInfo) {
        taskInfo = {
          pluginName: payload.plugin || null,
          funcName: payload.func || '',
          params: {},
          status: 'running',
          startTime: now,
          percent: 0,
          current: 0,
          total: 0,
          message: '',
          updatedAt: now,
          completeEmitted: false,
          errorEmitted: false,
          cancelledEmitted: false,
          cancelRequested: false
        }
        this._tasks.set(taskId, taskInfo)
      }
      copyTaskStartMetadata(taskInfo, payload)
      if (isTerminalTaskStatus(taskInfo.status)) {
        if (
          normalizeTaskStatus(payload.status) === taskInfo.status &&
          taskInfo.status === 'completed' &&
          taskInfo.result === undefined &&
          payload.data !== undefined
        ) {
          taskInfo.result = payload.data
          taskInfo.updatedAt = now
        }
        return
      }

      if (payload.taskStartResolved === true || payload.taskStartPending === false) {
        taskInfo.startPending = false
        this._startingTasks.delete(taskId)
      }
      if (payload.settingsSavedPending === true) taskInfo.settingsSavedPending = true
      if (typeof payload.settingsSaved === 'boolean') {
        taskInfo.settingsSaved = payload.settingsSaved
        taskInfo.settingsSavedPending = false
      }

      const pluginName = payload.plugin || taskInfo.pluginName || null
      const current = toNumber(payload.current, taskInfo.current || 0)
      const total = toNumber(payload.total, taskInfo.total || 0)
      const percent = Math.max(
        toNumber(taskInfo.percent, 0),
        Math.max(0, Math.min(100, toNumber(payload.percent, taskInfo.percent || 0)))
      )
      const statusFromPayload = normalizeTaskStatus(payload.status)
      const message = payload.message || taskInfo.message || ''

      const progressEvent = {
        pluginName,
        taskId,
        current,
        total,
        percent,
        message,
        status: statusFromPayload || 'running',
        timestamp: now
      }

      if (payload.error) {
        progressEvent.error = payload.error
        progressEvent.status = 'error'
      }

      if (payload.data !== undefined) {
        progressEvent.data = payload.data
      }
      if (progressEvent.status === 'completed') progressEvent.percent = 100

      this._emit('progress', progressEvent)

      taskInfo.pluginName = pluginName
      taskInfo.current = current
      taskInfo.total = total
      taskInfo.percent = percent
      taskInfo.message = message
      taskInfo.status = progressEvent.status
      taskInfo.updatedAt = now
      if (isTerminalTaskStatus(taskInfo.status)) taskInfo.cancelRequested = false

      if (isTerminalTaskStatus(progressEvent.status) && progressEvent.data !== undefined) {
        taskInfo.result = progressEvent.data
      }

      if (progressEvent.status === 'completed' && !taskInfo.completeEmitted) {
        taskInfo.completeEmitted = true
        this._emit('complete', {
          taskId,
          data: taskInfo.result
        })
      }

      if (progressEvent.status === 'error' && !taskInfo.errorEmitted) {
        taskInfo.errorEmitted = true
        taskInfo.error = progressEvent.error || progressEvent.message
        this._emit('error', {
          taskId,
          error: taskInfo.error
        })
      }

      if (progressEvent.status === 'cancelled' && !taskInfo.cancelledEmitted) {
        taskInfo.cancelledEmitted = true
        taskInfo.cancelRequested = false
        this._emit('cancelled', { taskId })
      }
    }

    this.events.on(PROGRESS_EVENT_TYPE, handler)

    // 监听回调结果事件
    const callbackResultHandler = (envelope) => {
      if (!envelope || !envelope.payload) {
        return
      }

      const payload = envelope.payload
      const taskId = payload.taskId || payload.id
      if (!taskId) {
        return
      }

      const now = Date.now()
      let taskInfo = this._tasks.get(taskId)
      if (!taskInfo) {
        taskInfo = {
          pluginName: payload.plugin || null,
          funcName: payload.func || '',
          params: {},
          status: 'running',
          startTime: now,
          updatedAt: now,
          completeEmitted: false,
          errorEmitted: false,
          cancelledEmitted: false,
          cancelRequested: false
        }
        this._tasks.set(taskId, taskInfo)
      }
      taskInfo.startPending = false
      this._startingTasks.delete(taskId)
      const wasTerminal = isTerminalTaskStatus(taskInfo.status)
      taskInfo.pluginName = payload.plugin || taskInfo.pluginName

      // 解析回调结果
      let resultData = null
      let error = null
      let hasResultData = false
      if (payload.result !== undefined && payload.result !== null) {
        try {
          resultData =
            typeof payload.result === 'string'
              ? JSON.parse(payload.result)
              : payload.result
          hasResultData = true
        } catch (e) {
          dllError('Failed to parse callback result JSON:', e)
          error = '回调结果解析失败: ' + (e instanceof Error ? e.message : String(e))
        }
      } else if (payload.data !== undefined) {
        resultData = payload.data
        hasResultData = true
      }

      if (payload.error) {
        error = payload.error
      }
      const resultDataObject = resultData && typeof resultData === 'object' && !Array.isArray(resultData)
        ? resultData
        : null
      const nestedData = resultDataObject?.data && typeof resultDataObject.data === 'object'
        ? resultDataObject.data
        : null
      if (!error) error = resultDataObject?.error || nestedData?.error || null

      const resultStatus = getCallbackResultStatus(resultData, error)
      if (wasTerminal) {
        if (resultStatus === taskInfo.status) {
          if (taskInfo.status === 'error' && !taskInfo.error && error) {
            taskInfo.error = error
          }
          if (taskInfo.result === undefined && hasResultData) {
            taskInfo.result = resultData
            if (taskInfo.status === 'completed') taskInfo.percent = 100
            taskInfo.updatedAt = now
            this._emit('callback', {
              taskId,
              data: resultData,
              ...(taskInfo.status === 'error' && taskInfo.error ? { error: taskInfo.error } : {})
            })
          } else if (taskInfo.status === 'error' && !taskInfo.error && error) {
            taskInfo.error = error
            taskInfo.updatedAt = now
          }
        }
        return
      }

      taskInfo.updatedAt = now
      if (resultStatus === 'running') {
        const progress = getCallbackProgress(resultData, taskInfo)
        taskInfo.current = progress.current
        taskInfo.total = progress.total
        taskInfo.percent = Math.max(toNumber(taskInfo.percent, 0), progress.percent)
        taskInfo.message = progress.message
        taskInfo.status = 'running'
        taskInfo.updatedAt = now
        this._emit('progress', {
          pluginName: taskInfo.pluginName,
          taskId,
          current: progress.current,
          total: progress.total,
          percent: progress.percent,
          message: progress.message,
          status: 'running',
          timestamp: now,
          data: resultData
        })
        this._emit('callback', { taskId, data: resultData })
      } else if (resultStatus === 'cancelled') {
        taskInfo.status = 'cancelled'
        if (hasResultData) taskInfo.result = resultData
        taskInfo.cancelRequested = false
        taskInfo.updatedAt = now
        if (hasResultData) this._emit('callback', { taskId, data: resultData })
        if (!taskInfo.cancelledEmitted) {
          taskInfo.cancelledEmitted = true
          this._emit('cancelled', { taskId })
        }
      } else if (resultStatus === 'error') {
        error = error || 'DLL 回调调用失败'
        taskInfo.status = 'error'
        if (hasResultData) taskInfo.result = resultData
        taskInfo.error = error
        const workNotStarted = payload.taskStartResolved === 'not-started' || payload.workNotStarted === true
        if (workNotStarted) taskInfo.workNotStarted = true
        if (typeof payload.code === 'string') taskInfo.errorCode = payload.code
        taskInfo.cancelRequested = false
        if (!taskInfo.errorEmitted) {
          taskInfo.errorEmitted = true
          this._emit('callback', {
            taskId,
            error: error,
            data: resultData,
            ...(workNotStarted ? { workNotStarted: true } : {}),
            ...(typeof payload.code === 'string' ? { code: payload.code } : {})
          })
          this._emit('error', {
            taskId,
            error: error,
            ...(workNotStarted ? { workNotStarted: true } : {}),
            ...(typeof payload.code === 'string' ? { code: payload.code } : {})
          })
        }
      } else if (resultStatus === 'completed') {
        taskInfo.status = 'completed'
        taskInfo.result = resultData
        taskInfo.percent = 100
        taskInfo.cancelRequested = false
        if (!taskInfo.completeEmitted) {
          taskInfo.completeEmitted = true
          this._emit('callback', {
            taskId,
            data: resultData
          })
          this._emit('complete', {
            taskId,
            data: resultData
          })
        }
      } else {
        this._emit('callback', { taskId, data: resultData })
      }
    }

    this.events.on(CALLBACK_RESULT_EVENT_TYPE, callbackResultHandler)

    this._eventsBound = true
    // dllLog('DLL 插件进度事件桥接已启用')
  }

  /**
   * 添加事件监听器
   */
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = []
    }
    this._listeners[event].push(callback)
  }

  /**
   * 移除事件监听器
   */
  off(event, callback) {
    if (!this._listeners[event]) return
    const index = this._listeners[event].indexOf(callback)
    if (index > -1) {
      this._listeners[event].splice(index, 1)
    }
  }

  /**
   * 触发事件
   * @private
   */
  _emit(event, data) {
    if (!this._listeners[event]) return
    this._listeners[event].forEach((callback) => {
      try {
        callback(data)
      } catch (e) {
        dllError('Event listener error:', e)
      }
    })
  }

  /**
   * 获取所有 DLL 插件列表
   */
  async list() {
    try {
      const response = await this.transport.call('dllplugin_list', {})
      if (response && response.success) {
        return response.plugins || []
      } else {
        throw new Error((response && response.error) || '获取 DLL 插件列表失败')
      }
    } catch (e) {
      dllError('Failed to get DLL plugin list:', e)
      throw e
    }
  }

  /**
   * 获取所有 DLL 插件列表 (别名)
   */
  async getList() {
    return await this.list()
  }

  /**
   * 调用 DLL 插件函数
   * @param {string} pluginName - DLL插件名称  直接使用插件名称，如 'MathPlugin'
   * @param {string} funcName - 函数名称
   * @param {Object} params - 函数参数
   * @returns {Promise<any>} 函数返回值
   */
  async call(pluginName, funcName, params = {}, options = {}) {
    try {
      if (!pluginName || typeof pluginName !== 'string') {
        throw new Error('插件名称无效')
      }

      if (!funcName || typeof funcName !== 'string') {
        throw new Error('函数名称无效')
      }

      const response = await this.transport.call(
        'dllplugin_call',
        {
          plugin: pluginName,
          func: funcName,
          params: params
        },
        options
      )

      if (response && response.success) {
        return response.data
      } else {
        throw new Error(response.error || 'DLL 插件调用失败')
      }
    } catch (e) {
      dllError(`Failed to call DLL plugin ${pluginName}.${funcName}:`, e)
      throw e
    }
  }

  /**
   * 带回调的调用 DLL 插件函数（结果通过回调返回）
   * @param {string} pluginName - DLL插件名称 直接使用插件名称，如 'MathPlugin'
   * @param {string} funcName - 函数名称
   * @param {Object} params - 函数参数（必须包含 taskId）
   * @param {Function} [onCallback] - 回调函数，接收 (data, error) 参数
   * @returns {Promise<string>} taskId - 任务ID
   */
  async callWithCallback(pluginName, funcName, params = {}, onCallback = null) {
    let taskId = ''
    let reservedTaskId = false
    let definitiveNoStartCleared = false
    try {
      if (!pluginName || typeof pluginName !== 'string') {
        throw new Error('插件名称无效')
      }

      if (!funcName || typeof funcName !== 'string') {
        throw new Error('函数名称无效')
      }

      // 生成 taskId（如果未提供）
      if (!params.taskId) {
        params.taskId = `callback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      }

      taskId = params.taskId
      if (
        this._tasks.has(taskId) ||
        this._startingTasks.has(taskId) ||
        this._callbackHandlers.has(taskId)
      ) {
        throw new Error('DLL 回调任务ID已被占用')
      }
      this._startingTasks.add(taskId)
      reservedTaskId = true

      const provisionalTime = Date.now()
      this._tasks.set(taskId, {
        pluginName,
        funcName,
        params,
        status: 'running',
        startPending: true,
        startTime: provisionalTime,
        updatedAt: provisionalTime,
        completeEmitted: false,
        errorEmitted: false,
        cancelledEmitted: false,
        cancelRequested: false
      })

      // 如果提供了回调函数，注册监听器
      if (onCallback && typeof onCallback === 'function') {
        const callbackHandler = (event) => {
          if (event.taskId === taskId) {
            // 调用用户提供的回调函数
            try {
              if (event.error) {
                onCallback(event.data ?? null, event.error)
              } else {
                onCallback(event.data, null)
              }
            } catch (e) {
              dllError('Callback handler error:', e)
            }
          }
        }
        this.on('callback', callbackHandler)
        this._callbackHandlers.set(taskId, callbackHandler)
      }

      const response = await this.transport.call(
        'dllplugin_call_with_callback',
        {
          plugin: pluginName,
          func: funcName,
          params: params
        }
      )

      if (response && response.success) {
        const now = Date.now()
        const taskInfo = this._tasks.get(taskId)
        if (taskInfo) {
          taskInfo.pluginName = pluginName
          taskInfo.funcName = funcName
          taskInfo.params = params
          taskInfo.startTime = taskInfo.startTime || now
          taskInfo.updatedAt = now
          taskInfo.completeEmitted = taskInfo.completeEmitted === true
          taskInfo.errorEmitted = taskInfo.errorEmitted === true
          taskInfo.cancelledEmitted = taskInfo.cancelledEmitted === true
          if (taskInfo.startPending !== false) taskInfo.startPending = response.taskStartPending === true
          if (typeof response.settingsSaved === 'boolean') taskInfo.settingsSaved = response.settingsSaved
          if (response.settingsSavedPending === true) taskInfo.settingsSavedPending = true
        } else {
          this._tasks.set(taskId, {
            pluginName,
            funcName,
            params,
            status: 'running',
            startPending: response.taskStartPending === true,
            ...(typeof response.settingsSaved === 'boolean' ? { settingsSaved: response.settingsSaved } : {}),
            ...(response.settingsSavedPending === true ? { settingsSavedPending: true } : {}),
            startTime: now,
            updatedAt: now,
            completeEmitted: false,
            errorEmitted: false,
            cancelledEmitted: false,
            cancelRequested: false
          })
        }

        return taskId
      } else {
        if (response?.taskStartResolved === 'not-started') {
          await this.clearCallback(taskId, true)
          definitiveNoStartCleared = true
        }
        const responseError = response?.error && typeof response.error === 'object'
          ? response.error
          : null
        const error = new Error(
          responseError?.message || response?.error || 'DLL 插件回调调用失败'
        )
        const code = response?.code || responseError?.code
        Object.assign(error, {
          ...(typeof code === 'string' ? { code } : {}),
          ...(response?.taskStartResolved === 'not-started' || response?.workNotStarted === true
            ? { workNotStarted: true }
            : {})
        })
        throw error
      }
    } catch (e) {
      if (taskId && reservedTaskId && !definitiveNoStartCleared) {
        await this.clearCallback(taskId, true).catch(() => undefined)
      }
      dllError(
        `Failed to call DLL plugin with callback ${pluginName}.${funcName}:`,
        e
      )
      throw e
    } finally {
      const taskInfo = taskId ? this._tasks.get(taskId) : null
      if (reservedTaskId && taskInfo?.startPending !== true) this._startingTasks.delete(taskId)
    }
  }

  /**
   * 清理指定回调任务在当前页面注册的监听器
   */
  async clearCallback(taskId, removeTask = false) {
    if (!taskId) return

    try {
      const response = await this.transport.call('dllplugin_clear_callback_task', { taskId })
      if (!response || response.success !== true) {
        throw new Error(response?.error || '清理 DLL 回调任务失败')
      }
      const callbackHandler = this._callbackHandlers.get(taskId)
      if (callbackHandler) {
        this.off('callback', callbackHandler)
        this._callbackHandlers.delete(taskId)
      }
      if (removeTask) this._tasks.delete(taskId)
      this._startingTasks.delete(taskId)
      return response
    } catch (e) {
      if (this.transport._debug) {
        dllLog('Failed to clear callback task mapping:', e)
      }
      throw e
    }
  }

  /**
   * 检查插件是否存在
   */
  async exists(pluginName) {
    try {
      const plugins = await this.list()
      return plugins.some((p) => p.name === pluginName)
    } catch (e) {
      dllError('Failed to check plugin existence:', e)
      return false
    }
  }

  /**
   * 获取插件信息
   */
  async getInfo(pluginName) {
    try {
      const plugins = await this.list()
      return plugins.find((p) => p.name === pluginName) || null
    } catch (e) {
      dllError('Failed to get plugin info:', e)
      return null
    }
  }

  /**
   * 异步调用 DLL 插件函数（带进度回调）
   * @param {string} pluginName - DLL插件名称 直接使用插件名称，如 'MathPlugin'
   * @param {string} funcName - 函数名称
   * @param {Object} params - 函数参数
   * @returns {Promise<string>} taskId - 任务ID
   */
  async callAsync(pluginName, funcName, params = {}) {
    try {
      if (!pluginName || typeof pluginName !== 'string') {
        throw dllTaskFailure({ code: 'INVALID_REQUEST', workNotStarted: true, taskStartResolved: 'not-started' }, '插件名称无效')
      }

      if (!funcName || typeof funcName !== 'string') {
        throw dllTaskFailure({ code: 'INVALID_REQUEST', workNotStarted: true, taskStartResolved: 'not-started' }, '函数名称无效')
      }

      const response = await this.transport.call('dllplugin_call_async', {
        plugin: pluginName,
        func: funcName,
        params: params
      })

      if (response && response.success) {
        const taskId = response.taskId
        if (typeof taskId !== 'string' || !taskId) throw taskObservationFailure({}, '', '宿主返回无效任务ID')

        const now = Date.now()
        const taskInfo = this._tasks.get(taskId)
        if (taskInfo) {
          taskInfo.pluginName = pluginName
          taskInfo.funcName = funcName
          taskInfo.params = params
          taskInfo.startTime = taskInfo.startTime || now
          taskInfo.percent = taskInfo.percent || 0
          taskInfo.current = taskInfo.current || 0
          taskInfo.total = taskInfo.total || 0
          taskInfo.message = taskInfo.message || ''
          taskInfo.updatedAt = now
          taskInfo.completeEmitted = taskInfo.completeEmitted === true
          taskInfo.errorEmitted = taskInfo.errorEmitted === true
          taskInfo.cancelledEmitted = taskInfo.cancelledEmitted === true
          taskInfo.cancelRequested = taskInfo.cancelRequested === true
          copyTaskStartMetadata(taskInfo, response)
          if (typeof response.settingsSaved === 'boolean') taskInfo.settingsSaved = response.settingsSaved
        } else {
          this._tasks.set(taskId, {
            pluginName,
            funcName,
            params,
            status: response.taskStartPending === true ? 'invoking' : 'running',
            startPending: response.taskStartPending === true,
            startTime: now,
            percent: 0,
            current: 0,
            total: 0,
            message: '',
            updatedAt: now,
            completeEmitted: false,
            errorEmitted: false,
            cancelledEmitted: false,
            cancelRequested: false,
            ...(typeof response.settingsSaved === 'boolean' ? { settingsSaved: response.settingsSaved } : {})
          })
        }

        dllLog(`异步任务已登记: ${taskId}`)
        return taskId
      } else {
        throw dllTaskFailure(response, response?.error || 'DLL 插件异步调用失败', response?.taskId)
      }
    } catch (e) {
      dllError(`Failed to call DLL plugin async ${pluginName}.${funcName}:`, e)
      if (e?.workNotStarted === true) throw e
      const error = dllTaskFailure(e, e instanceof Error ? e.message : String(e), e?.taskId)
      error.workOutcome = 'unknown'
      error.noReplay = true
      throw error
    }
  }

  /**
   * 查询任务状态
   */
  async queryTask(pluginName, taskId, options = {}) {
    try {
      // 参数验证
      if (!pluginName || typeof pluginName !== 'string') {
        throw new Error('插件名称无效: ' + pluginName)
      }
      if (!taskId || typeof taskId !== 'string') {
        throw new Error('任务ID无效: ' + taskId)
      }

      // 调用后端查询任务状态
      const response = await this.transport.call('dllplugin_query_task', {
        plugin: pluginName,
        taskId: taskId
      }, options)

      // 处理响应
      if (!response) {
        throw new Error('查询任务返回空响应')
      }

      const hasTaskStatus = typeof response.taskStatus === 'string' && response.taskStatus.length > 0
      const reportedStatus = hasTaskStatus
        ? normalizeTaskStatus(response.taskStatus) || response.taskStatus
        : response.taskDone
          ? response.taskError
            ? 'error'
            : 'completed'
          : 'running'
      const reportedDone = isTerminalTaskStatus(reportedStatus) || (!hasTaskStatus && response.taskDone === true)
      const taskInfo = this._tasks.get(taskId)
      let effectiveStatus = reportedStatus
      let effectiveDone = reportedDone

      if (taskInfo) {
        taskInfo.updatedAt = Date.now()
        copyTaskStartMetadata(taskInfo, response)
        taskInfo.startPending = response.taskStartPending === true
        if (!taskInfo.startPending) this._startingTasks.delete(taskId)
        if (isTerminalTaskStatus(taskInfo.status)) {
          if (taskInfo.status === reportedStatus) {
            if (taskInfo.result === undefined && response.taskData !== undefined) {
              taskInfo.result = response.taskData
            }
            if (taskInfo.status === 'error' && !taskInfo.error && response.taskError) {
              taskInfo.error = response.taskError
            }
          }
        } else {
          taskInfo.status = reportedStatus
          taskInfo.cancelRequested = reportedDone
            ? false
            : response.taskCancelRequested === true || taskInfo.cancelRequested === true
          if (response.taskData !== undefined) taskInfo.result = response.taskData
          if (response.taskError !== undefined) taskInfo.error = response.taskError
          if (!reportedDone && response.taskProgress !== undefined) {
            taskInfo.progress = response.taskProgress
          }
        }
        if (taskInfo.status === 'completed') taskInfo.percent = 100
        effectiveStatus = taskInfo.status
        effectiveDone = isTerminalTaskStatus(taskInfo.status) || reportedDone
      } else if (response.queryOk) {
        this._tasks.set(taskId, {
          pluginName,
          status: reportedStatus,
          ...(response.taskData !== undefined ? { result: response.taskData } : {}),
          ...(response.taskError !== undefined ? { error: response.taskError } : {}),
          ...(response.taskProgress !== undefined ? { progress: response.taskProgress } : {}),
          cancelRequested: response.taskCancelRequested === true && !reportedDone,
          startPending: response.taskStartPending === true,
          completeEmitted: false,
          errorEmitted: false,
          cancelledEmitted: false,
          updatedAt: Date.now()
        })
      }

      const effectiveTaskInfo = this._tasks.get(taskId)
      if (effectiveTaskInfo && isTerminalTaskStatus(effectiveTaskInfo.status)) {
        effectiveStatus = effectiveTaskInfo.status
        effectiveDone = true
        if (effectiveStatus === 'completed' && !effectiveTaskInfo.completeEmitted) {
          effectiveTaskInfo.completeEmitted = true
          this._emit('complete', {
            plugin: effectiveTaskInfo.pluginName || pluginName,
            taskId,
            result: effectiveTaskInfo.result
          })
        }
      }

      const result = {
        success: response.queryOk === true,
        completed: effectiveDone,
        status: effectiveStatus
      }

      if (isTerminalTaskStatus(effectiveStatus) && effectiveTaskInfo?.result !== undefined) {
        result.data = effectiveTaskInfo.result
      }
      if (effectiveStatus === 'error' || effectiveStatus === 'cancelled') {
        const taskError = effectiveTaskInfo?.error || response.taskError
        if (taskError) result.error = taskError
      } else if (response.taskProgress !== undefined) {
        result.progress = response.taskProgress
      }
      if (effectiveTaskInfo?.cancelRequested) result.cancelRequested = true
      if (effectiveTaskInfo?.startPending) result.startPending = true
      for (const key of ['code', 'taskStartResolved', 'workNotStarted', 'workOutcome', 'noReplay']) {
        if (response[key] !== undefined) result[key] = response[key]
      }

      // 如果查询失败，抛出错误
      if (!response.queryOk) {
        throw new Error(response.taskError || '查询任务失败')
      }

      return result
    } catch (e) {
      // 记录错误
      if (this.transport._debug) {
        console.error('[ztools-dllplugin] QueryTask error:', e)
      }
      throw e
    }
  }

  /**
   * 等待任务完成（轮询）
   */
  async waitTask(taskId, pollInterval = 1000, timeout = 0, options = {}) {
    const taskInfo = this._tasks.get(taskId)
    if (!taskInfo) throw new Error('未知的任务ID: ' + taskId)
    const signal = options?.signal
    if (!Number.isFinite(pollInterval) || pollInterval <= 0 || pollInterval > 60_000 ||
        !Number.isFinite(timeout) || timeout < 0 || timeout > 86_400_000 ||
        (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
      throw Object.assign(new Error('DLL 任务观察参数无效'), { code: 'INVALID_REQUEST' })
    }
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity
    const checkObservation = () => {
      if (signal?.aborted) {
        throw Object.assign(taskObservationFailure(taskInfo, taskId, '已停止观察任务，原生结果仍须确认',
          'DLL_TASK_OBSERVATION_ABORTED'), { name: 'AbortError' })
      }
      if (Date.now() >= deadline) {
        throw taskObservationFailure(taskInfo, taskId, '任务等待超时，原生结果仍须确认', 'DLL_TASK_WAIT_TIMEOUT')
      }
    }
    const terminalResult = () => {
      if (taskInfo.status === 'completed') return { done: true, data: taskInfo.result }
      if (taskInfo.status === 'error' || taskInfo.status === 'cancelled') {
        throw Object.assign(dllTaskFailure(taskInfo, taskInfo.error ||
          (taskInfo.status === 'cancelled' ? '任务已取消' : '任务执行失败'), taskId), { taskDone: true })
      }
      return { done: false }
    }
    while (true) {
      checkObservation()
      const terminal = terminalResult()
      if (terminal.done) return terminal.data
      try {
        // One bounded query remains owned by this observer. An abort does not
        // abandon it or forward a fake native cancellation capability.
        await this.queryTask(taskInfo.pluginName, taskId, {
          timeout: Math.min(10_000, Math.max(1, deadline - Date.now()))
        })
      } catch (error) {
        checkObservation()
        const lateTerminal = terminalResult()
        if (lateTerminal.done) return lateTerminal.data
        throw taskObservationFailure(taskInfo, taskId,
          error instanceof Error ? error.message : String(error))
      }
      checkObservation()
      const queriedTerminal = terminalResult()
      if (queriedTerminal.done) return queriedTerminal.data
      await new Promise(resolve => {
        let timer
        const finish = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', finish)
          resolve()
        }
        timer = setTimeout(finish, Math.min(pollInterval, Math.max(0, deadline - Date.now())))
        signal?.addEventListener('abort', finish, { once: true })
        if (signal?.aborted) finish()
      })
    }
  }

  /**
   * 取消任务
   */
  async cancelTask(pluginName, taskId) {
    try {
      const taskInfo = this._tasks.get(taskId)
      if (taskInfo && (isTerminalTaskStatus(taskInfo.status) || taskInfo.cancelRequested)) return true

      const response = await this.transport.call('dllplugin_cancel_task', {
        plugin: pluginName,
        taskId: taskId
      })

      if (response && response.success) {
        if (taskInfo && !isTerminalTaskStatus(taskInfo.status)) {
          taskInfo.cancelRequested = true
          taskInfo.updatedAt = Date.now()
        }

        dllLog(`已请求取消任务: ${taskId}`)
        return true
      } else {
        throw new Error(response.error || '取消任务失败')
      }
    } catch (e) {
      dllError('Failed to cancel task:', e)
      throw e
    }
  }

  /**
   * 获取任务信息
   */
  getTaskInfo(taskId) {
    return this._tasks.get(taskId) || null
  }

  /**
   * 获取所有任务
   */
  getAllTasks() {
    const tasks = []
    this._tasks.forEach((info, taskId) => {
      tasks.push({ taskId, ...info })
    })
    return tasks
  }
}

export default DLLPluginAPI
