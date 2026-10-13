import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const sdkSource = readFileSync(
  resolve(process.cwd(), 'public/js/cef-ipc/src/api/dllplugin.js'),
  'utf8'
)
const DLLPluginAPI = new Function(
  sdkSource.replace(/export default DLLPluginAPI\s*$/, 'return DLLPluginAPI')
)()

class FakeEvents {
  listeners = new Map()

  on(type, listener) {
    const listeners = this.listeners.get(type) || new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  emit(type, payload) {
    for (const listener of this.listeners.get(type) || []) listener({ payload })
  }
}

function createApi() {
  const events = new FakeEvents()
  const calls = []
  let beforeResponse = null
  let callbackResponsePromise = null
  let asyncResponse = { success: true, taskId: 'native_async_task' }
  let clearResponse = Promise.resolve({ success: true })
  let queryResponse = {
    queryOk: true,
    taskDone: true,
    taskStatus: 'cancelled',
    taskError: 'cancel confirmed'
  }
  const transport = {
    _debug: false,
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'dllplugin_call_with_callback') {
        beforeResponse?.(method, params, events)
        return callbackResponsePromise
          ? await callbackResponsePromise
          : { success: true, taskId: params.params.taskId }
      }
      if (method === 'dllplugin_call_async') {
        beforeResponse?.(method, params, events)
        return asyncResponse
      }
      if (method === 'dllplugin_query_task') {
        return queryResponse
      }
      if (method === 'dllplugin_cancel_task') return { success: true }
      if (method === 'dllplugin_clear_callback_task') return await clearResponse
      throw new Error(`unexpected method: ${method}`)
    }
  }
  const api = new DLLPluginAPI(transport, events)

  return {
    api,
    calls,
    events,
    setBeforeResponse(callback) { beforeResponse = callback },
    setCallbackResponsePromise(promise) { callbackResponsePromise = promise },
    setCallbackResponse(response) { callbackResponsePromise = Promise.resolve(response) },
    setAsyncResponse(response) { asyncResponse = response },
    setQueryResponse(response) { queryResponse = response },
    setClearResponse(response) { clearResponse = Promise.resolve(response) },
    setClearPromise(promise) { clearResponse = promise }
  }
}

describe('DLL plugin task lifecycle', () => {
  it('keeps progress envelopes running and emits completion only for a terminal envelope', async () => {
    const { api, events } = createApi()
    const onComplete = vi.fn()
    const onProgress = vi.fn()
    const onCallback = vi.fn()
    api.on('complete', onComplete)
    api.on('progress', onProgress)
    api.on('callback', onCallback)
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_progress_1' })

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_progress_1',
      result: JSON.stringify({ type: 'progress', data: { progress: 0.5, status: 'completed' } })
    })

    expect(api.getTaskInfo('sdk_progress_1').status).toBe('running')
    expect(api.getTaskInfo('sdk_progress_1').percent).toBe(50)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onCallback).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_progress_1',
      result: JSON.stringify({ type: 'progress', status: 'cancelled', data: { progress: 0.1 } })
    })
    expect(api.getTaskInfo('sdk_progress_1').status).toBe('running')
    expect(api.getTaskInfo('sdk_progress_1').percent).toBe(50)

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_progress_1',
      result: JSON.stringify({ type: 'progress', data: { progress: 0.8 } })
    })
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_progress_1',
      result: JSON.stringify({ type: 'progress', data: { progress: 0.2 } })
    })
    expect(api.getTaskInfo('sdk_progress_1').percent).toBe(80)

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_progress_1',
      result: JSON.stringify({ type: 'completed', data: { ok: true } })
    })
    events.emit('dllplugin_progress', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_progress_1',
      status: 'cancelled',
      percent: 100
    })

    expect(api.getTaskInfo('sdk_progress_1').status).toBe('completed')
    expect(api.getTaskInfo('sdk_progress_1').cancelRequested).toBe(false)
    expect(api.getTaskInfo('sdk_progress_1').percent).toBe(100)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(api.getTaskInfo('sdk_progress_1').cancelledEmitted).toBe(false)
  })

  it('preserves cancelled query status and treats cancel success as a request only', async () => {
    const { api, events, setQueryResponse } = createApi()
    const onCancelled = vi.fn()
    api.on('cancelled', onCancelled)
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_cancel_1' })

    await expect(api.queryTask('ClipboardManagerPlugin', 'sdk_cancel_1')).resolves.toMatchObject({
      status: 'cancelled',
      completed: true,
      error: 'cancel confirmed'
    })
    expect(api.getTaskInfo('sdk_cancel_1').status).toBe('cancelled')

    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_error_1' })
    setQueryResponse({
      queryOk: true,
      taskDone: true,
      taskStatus: 'error',
      taskError: 'native failure'
    })
    await expect(api.queryTask('ClipboardManagerPlugin', 'sdk_error_1')).resolves.toMatchObject({
      status: 'error',
      completed: true,
      error: 'native failure'
    })
    expect(api.getTaskInfo('sdk_error_1').status).toBe('error')

    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_cancel_2' })
    expect(await api.cancelTask('ClipboardManagerPlugin', 'sdk_cancel_2')).toBe(true)
    expect(api.getTaskInfo('sdk_cancel_2')).toMatchObject({ status: 'running', cancelRequested: true })
    expect(onCancelled).not.toHaveBeenCalled()

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_cancel_2',
      result: JSON.stringify({ type: 'cancelled' })
    })
    expect(api.getTaskInfo('sdk_cancel_2').status).toBe('cancelled')
    expect(onCancelled).toHaveBeenCalledTimes(1)
  })

  it('returns error and cancelled partial results while keeping the first terminal state immutable', async () => {
    const { api, events, setQueryResponse } = createApi()
    const partialError = {
      type: 'error',
      error: '任务处理失败',
      data: { success: false, results: [{ file: 'E:/audio/a.wav', success: false }, { file: 'E:/audio/b.wav', success: true }] }
    }
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_error_rows_query' })
    setQueryResponse({
      queryOk: true,
      taskDone: true,
      taskStatus: 'error',
      taskError: '任务处理失败',
      taskData: partialError
    })

    await expect(api.queryTask('ClipboardManagerPlugin', 'sdk_error_rows_query')).resolves.toMatchObject({
      status: 'error',
      completed: true,
      data: partialError,
      error: '任务处理失败'
    })
    expect(api.getTaskInfo('sdk_error_rows_query')).toMatchObject({ status: 'error', result: partialError })

    const immediateCallback = vi.fn()
    await api.callWithCallback(
      'ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_error_rows_callback' }, immediateCallback
    )
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_error_rows_callback',
      result: JSON.stringify(partialError)
    })
    expect(immediateCallback).toHaveBeenCalledWith(partialError, '任务处理失败')
    expect(api.getTaskInfo('sdk_error_rows_callback')).toMatchObject({
      status: 'error',
      result: partialError
    })

    const onError = vi.fn()
    const onComplete = vi.fn()
    const onCallback = vi.fn()
    api.on('error', onError)
    api.on('complete', onComplete)
    await api.callWithCallback(
      'ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_error_rows_late' }, onCallback
    )
    events.emit('dllplugin_progress', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_error_rows_late',
      status: 'error',
      error: '任务处理失败'
    })
    const beforeEnrichment = api.getTaskInfo('sdk_error_rows_late')
    expect(beforeEnrichment.status).toBe('error')
    expect(beforeEnrichment.result).toBeUndefined()

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_error_rows_late',
      result: JSON.stringify(partialError)
    })
    expect(api.getTaskInfo('sdk_error_rows_late')).toMatchObject({
      status: 'error',
      error: '任务处理失败',
      result: partialError
    })
    expect(onCallback).toHaveBeenCalledTimes(1)
    expect(onCallback).toHaveBeenCalledWith(partialError, '任务处理失败')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_error_rows_late',
      result: JSON.stringify({ type: 'completed', data: { conflict: true } })
    })
    expect(api.getTaskInfo('sdk_error_rows_late')).toMatchObject({ status: 'error', result: partialError })
    expect(onCallback).toHaveBeenCalledTimes(1)

    const partialCancellation = {
      type: 'cancelled',
      data: { results: [{ file: 'E:/audio/partial.wav', success: true }] }
    }
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_cancel_rows_query' })
    setQueryResponse({
      queryOk: true,
      taskDone: true,
      taskStatus: 'cancelled',
      taskData: partialCancellation
    })
    await expect(api.queryTask('ClipboardManagerPlugin', 'sdk_cancel_rows_query')).resolves.toMatchObject({
      status: 'cancelled',
      completed: true,
      data: partialCancellation
    })
    expect(api.getTaskInfo('sdk_cancel_rows_query')).toMatchObject({
      status: 'cancelled',
      result: partialCancellation
    })
  })

  it('does not overwrite callback or async terminal events that arrive before call returns', async () => {
    const { api, events, setBeforeResponse } = createApi()
    setBeforeResponse((method, params, eventBus) => {
      if (method === 'dllplugin_call_with_callback') {
        eventBus.emit('dllplugin_callback_result', {
          plugin: params.plugin,
          taskId: params.params.taskId,
          result: JSON.stringify({ type: 'completed', data: 'callback early' })
        })
      } else if (method === 'dllplugin_call_async') {
        eventBus.emit('dllplugin_progress', {
          plugin: params.plugin,
          taskId: 'native_async_task',
          status: 'completed',
          percent: 100,
          data: 'async early'
        })
      }
    })

    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_early_callback' })
    await api.callAsync('ClipboardManagerPlugin', 'Watch')

    expect(api.getTaskInfo('sdk_early_callback').status).toBe('completed')
    expect(api.getTaskInfo('native_async_task').status).toBe('completed')
    expect(api.getTaskInfo('native_async_task').result).toBe('async early')
  })

  it('returns a clear promise and removes local task state only after the host confirms clear', async () => {
    const { api, calls, setClearPromise } = createApi()
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_clear_1' })
    let resolveClear
    setClearPromise(new Promise((resolve) => { resolveClear = resolve }))

    let settled = false
    const clearPromise = api.clearCallback('sdk_clear_1', true).then((response) => {
      settled = true
      return response
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(api.getTaskInfo('sdk_clear_1')).not.toBeNull()
    expect(calls.at(-1)).toMatchObject({
      method: 'dllplugin_clear_callback_task',
      params: { taskId: 'sdk_clear_1' }
    })

    resolveClear({ success: true })
    await expect(clearPromise).resolves.toEqual({ success: true })
    expect(api.getTaskInfo('sdk_clear_1')).toBeNull()
  })

  it('retains local task state when the host refuses to clear a non-terminal task', async () => {
    const { api, setClearResponse } = createApi()
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_busy_clear' })
    setClearResponse({ success: false, error: 'DLL_BUSY' })

    await expect(api.clearCallback('sdk_busy_clear', true)).rejects.toThrow('DLL_BUSY')
    expect(api.getTaskInfo('sdk_busy_clear').status).toBe('running')
  })

  it('keeps callback handlers after a refused clear and removes them only after host confirmation', async () => {
    const { api, events, setClearResponse } = createApi()
    const onCallback = vi.fn()
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_callback_clear' }, onCallback)
    setClearResponse({ success: false, error: 'DLL_BUSY' })

    await expect(api.clearCallback('sdk_callback_clear', true)).rejects.toThrow('DLL_BUSY')
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_callback_clear',
      result: JSON.stringify({ type: 'progress', data: { progress: 0.2 } })
    })
    expect(onCallback).toHaveBeenCalledTimes(1)
    expect(api.getTaskInfo('sdk_callback_clear').status).toBe('running')
    const terminalResult = { type: 'completed', data: { final: true } }
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_callback_clear',
      result: JSON.stringify(terminalResult)
    })
    expect(onCallback).toHaveBeenCalledTimes(2)
    expect(onCallback).toHaveBeenLastCalledWith(terminalResult, null)
    expect(api.getTaskInfo('sdk_callback_clear').status).toBe('completed')

    setClearResponse({ success: true })
    await expect(api.clearCallback('sdk_callback_clear', true)).resolves.toMatchObject({ success: true })
    expect(api.getTaskInfo('sdk_callback_clear')).toBeNull()
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_callback_clear',
      result: JSON.stringify({ type: 'progress', data: { progress: 0.4 } })
    })
    expect(onCallback).toHaveBeenCalledTimes(2)
    expect(api.getTaskInfo('sdk_callback_clear').status).toBe('running')
  })

  it('enriches a terminal query with a late matching result without emitting complete twice', async () => {
    const { api, events, setQueryResponse } = createApi()
    const onComplete = vi.fn()
    const onCallback = vi.fn()
    api.on('complete', onComplete)
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_query_before_result' }, onCallback)
    setQueryResponse({
      queryOk: true,
      taskDone: true,
      taskStatus: 'completed',
      taskProgress: 100
    })

    await expect(api.waitTask('sdk_query_before_result', 10, 1_000)).resolves.toBeUndefined()
    expect(api.getTaskInfo('sdk_query_before_result').status).toBe('completed')
    expect(onComplete).toHaveBeenCalledTimes(1)

    const lateResult = { type: 'completed', data: { late: true } }
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_query_before_result',
      result: JSON.stringify(lateResult)
    })
    expect(api.getTaskInfo('sdk_query_before_result').result).toEqual(lateResult)
    expect(onCallback).toHaveBeenCalledTimes(1)
    expect(onCallback).toHaveBeenCalledWith(lateResult, null)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate local callback task ids without replacing the first callback', async () => {
    const { api, calls, events } = createApi()
    const firstCallback = vi.fn()
    const duplicateCallback = vi.fn()
    const firstStart = api.callWithCallback(
      'ClipboardManagerPlugin',
      'Watch',
      { taskId: 'sdk_duplicate_task' },
      firstCallback
    )
    const duplicateStart = api.callWithCallback(
      'ClipboardManagerPlugin',
      'Watch',
      { taskId: 'sdk_duplicate_task' },
      duplicateCallback
    )

    await expect(firstStart).resolves.toBe('sdk_duplicate_task')
    await expect(duplicateStart).rejects.toThrow('DLL 回调任务ID已被占用')
    expect(calls.filter((call) => call.method === 'dllplugin_call_with_callback')).toHaveLength(1)

    const result = { type: 'completed', data: { original: true } }
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_duplicate_task',
      result: JSON.stringify(result)
    })
    expect(api.getTaskInfo('sdk_duplicate_task').status).toBe('completed')
    expect(firstCallback).toHaveBeenCalledTimes(1)
    expect(firstCallback).toHaveBeenCalledWith(result, null)
    expect(duplicateCallback).not.toHaveBeenCalled()
  })

  it('keeps a provisional callback task and duplicate-ID reservation when start IPC fails and clear is busy', async () => {
    const { api, events, setClearResponse, setCallbackResponsePromise } = createApi()
    const onCallback = vi.fn()
    let rejectResponse
    setCallbackResponsePromise(new Promise((_, reject) => { rejectResponse = reject }))

    const start = api.callWithCallback(
      'ClipboardManagerPlugin',
      'Watch',
      { taskId: 'sdk_provisional_busy' },
      onCallback
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(api.getTaskInfo('sdk_provisional_busy')).toMatchObject({ status: 'running', startPending: true })
    expect(api._startingTasks.has('sdk_provisional_busy')).toBe(true)
    await expect(api.callWithCallback(
      'ClipboardManagerPlugin',
      'Watch',
      { taskId: 'sdk_provisional_busy' }
    )).rejects.toThrow('DLL 回调任务ID已被占用')

    setClearResponse({ success: false, error: 'PLUGIN_BUSY' })
    rejectResponse(new Error('response channel closed'))
    await expect(start).rejects.toThrow('response channel closed')
    expect(api.getTaskInfo('sdk_provisional_busy')).toMatchObject({ status: 'running', startPending: true })
    expect(api._callbackHandlers.has('sdk_provisional_busy')).toBe(true)
    expect(api._startingTasks.has('sdk_provisional_busy')).toBe(true)

    const lateProgress = { type: 'progress', data: { progress: 0.4 } }
    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_provisional_busy',
      result: JSON.stringify(lateProgress)
    })
    expect(onCallback).toHaveBeenCalledWith(lateProgress, null)

    setClearResponse({ success: true })
    await expect(api.clearCallback('sdk_provisional_busy', true)).resolves.toMatchObject({ success: true })
    expect(api.getTaskInfo('sdk_provisional_busy')).toBeNull()
    expect(api._startingTasks.has('sdk_provisional_busy')).toBe(false)
  })

  it('keeps ack-pending status until a matching service resolution event arrives', async () => {
    const { api, events, setCallbackResponse } = createApi()
    setCallbackResponse({ success: true, taskId: 'sdk_late_ack', taskStartPending: true })
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_late_ack' })

    expect(api.getTaskInfo('sdk_late_ack').startPending).toBe(true)
    expect(api._startingTasks.has('sdk_late_ack')).toBe(true)
    events.emit('dllplugin_progress', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_late_ack',
      status: 'running',
      taskStartResolved: true,
      taskStartPending: false
    })

    expect(api.getTaskInfo('sdk_late_ack').status).toBe('running')
    expect(api.getTaskInfo('sdk_late_ack').startPending).toBe(false)
    expect(api._startingTasks.has('sdk_late_ack')).toBe(false)
  })

  it('surfaces a definitive no-start response as a typed error and clears its provisional task once', async () => {
    const { api, calls, setCallbackResponse } = createApi()
    setCallbackResponse({
      success: false,
      error: 'NativeHost32 rejected start',
      code: 'INVALID_REQUEST',
      taskStartResolved: 'not-started',
      workNotStarted: true
    })

    let caught
    try {
      await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_no_start' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      message: 'NativeHost32 rejected start',
      code: 'INVALID_REQUEST',
      workNotStarted: true
    })
    expect(calls.filter((call) => call.method === 'dllplugin_clear_callback_task')).toHaveLength(1)
    expect(api.getTaskInfo('sdk_no_start')).toBeNull()
    expect(api._startingTasks.has('sdk_no_start')).toBe(false)
  })

  it('delivers late definitive no-start as a terminal callback error for the adapter', async () => {
    const { api, events, setCallbackResponse } = createApi()
    const onCallback = vi.fn()
    const onCallbackEvent = vi.fn()
    api.on('callback', onCallbackEvent)
    setCallbackResponse({ success: true, taskId: 'sdk_late_no_start', taskStartPending: true })
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_late_no_start' }, onCallback)

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_late_no_start',
      error: 'NativeHost32 rejected start',
      code: 'INVALID_REQUEST',
      taskStartResolved: 'not-started',
      workNotStarted: true
    })

    expect(api.getTaskInfo('sdk_late_no_start')).toMatchObject({
      status: 'error',
      startPending: false,
      workNotStarted: true,
      errorCode: 'INVALID_REQUEST'
    })
    expect(api._startingTasks.has('sdk_late_no_start')).toBe(false)
    expect(onCallback).toHaveBeenCalledWith(null, 'NativeHost32 rejected start')
    expect(onCallbackEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'sdk_late_no_start',
      error: 'NativeHost32 rejected start',
      workNotStarted: true,
      code: 'INVALID_REQUEST'
    }))
  })

  it('settles caller-scoped watermark persistence metadata after a late start acknowledgement', async () => {
    const { api, events, setCallbackResponse, setAsyncResponse } = createApi()
    setCallbackResponse({
      success: true,
      taskId: 'sdk_watermark_pending',
      taskStartPending: true,
      settingsSavedPending: true
    })
    await api.callWithCallback('BatchVideoPlugin', 'BatchAddWatermark', { taskId: 'sdk_watermark_pending' })
    expect(api.getTaskInfo('sdk_watermark_pending')).toMatchObject({ settingsSavedPending: true })
    events.emit('dllplugin_progress', {
      plugin: 'BatchVideoPlugin',
      taskId: 'sdk_watermark_pending',
      status: 'running',
      taskStartResolved: true,
      taskStartPending: false,
      settingsSaved: true
    })
    expect(api.getTaskInfo('sdk_watermark_pending')).toMatchObject({
      startPending: false,
      settingsSaved: true,
      settingsSavedPending: false
    })

    setAsyncResponse({ success: true, taskId: 'native_async_watermark', settingsSaved: true })
    await api.callAsync('BatchVideoPlugin', 'BatchAddWatermark')
    expect(api.getTaskInfo('native_async_watermark')).toMatchObject({ settingsSaved: true })
  })

  it('does not treat an unknown explicit callback status as successful completion', async () => {
    const { api, events } = createApi()
    const onComplete = vi.fn()
    api.on('complete', onComplete)
    await api.callWithCallback('ClipboardManagerPlugin', 'Watch', { taskId: 'sdk_unknown_status' })

    events.emit('dllplugin_callback_result', {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'sdk_unknown_status',
      result: JSON.stringify({ type: 'queued', status: 'completed', data: { value: 1 } })
    })

    expect(api.getTaskInfo('sdk_unknown_status').status).toBe('running')
    expect(onComplete).not.toHaveBeenCalled()
  })
})
