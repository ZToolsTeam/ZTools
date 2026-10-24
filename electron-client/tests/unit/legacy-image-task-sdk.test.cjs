const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const test = require('node:test')

function fixture() {
  const handlers = new Map(), calls = [], timers = new Set()
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/dllplugin.js', 'utf8').replace(/^export .+$/mg, '')
  const Constructor = vm.runInNewContext(source + '\nDLLPluginAPI', {
    console: { log() {}, error() {} }, Date, AbortController, Error,
    setTimeout(fn, ms) { const handle = setTimeout(() => { timers.delete(handle); fn() }, ms); timers.add(handle); return handle },
    clearTimeout(handle) { timers.delete(handle); clearTimeout(handle) }
  })
  let response = async (method) => method === 'dllplugin_call_async'
    ? { success: true, taskId: 'task_test', taskStartPending: true }
    : { success: true, queryOk: true, taskStatus: 'invoking', taskStartPending: true }
  const transport = { call: async (method, params, options) => { calls.push({ method, params, options }); return response(method, params, options) } }
  const api = new Constructor(transport, { on(type, handler) { handlers.set(type, handler) } })
  return { api, calls, timers, transport, response(fn) { response = fn },
    emit(payload) { handlers.get('dllplugin_progress')({ payload }) } }
}

test('ordinary async records pending start and keeps typed definitive rejection', async () => {
  const f = fixture()
  const taskId = await f.api.callAsync('ImagePlugin', 'GetInfo', {})
  assert.equal(f.api._tasks.get(taskId).startPending, true)
  f.response(async () => ({ success: false, code: 'PERMISSION_DENIED', error: 'rejected',
    taskStartResolved: 'not-started', workNotStarted: true }))
  await assert.rejects(f.api.callAsync('ImagePlugin', 'GetInfo', {}), {
    code: 'PERMISSION_DENIED', workNotStarted: true, taskStartResolved: 'not-started'
  })
})

test('a lost start reply before task ID delivery is unknown and cannot trigger replay', async () => {
  const f = fixture()
  f.response(async () => { throw Object.assign(new Error('IPC start reply timed out'), { code: 'REQUEST_TIMEOUT' }) })
  await assert.rejects(f.api.callAsync('ImagePlugin', 'Compress', {}), {
    code: 'REQUEST_TIMEOUT', workOutcome: 'unknown', noReplay: true
  })
  await assert.rejects(f.api.callAsync('', 'Compress', {}), { code: 'INVALID_REQUEST', workNotStarted: true })
  assert.equal(f.calls.length, 1)
})

test('legacy image selects an explicit finite observation timeout', async () => {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/image.js', 'utf8').replace(/^export .+$/mg, '')
  let waitArgs
  const Constructor = vm.runInNewContext(source + '\nImageAPI', { window: { ztools: { dllplugin: {
    callAsync: async () => 'task_image', waitTask: async (...args) => { waitArgs = args; return { result: { width: 2, height: 3 } } },
    clearCallback: async () => ({ success: true })
  } } }, console })
  const api = new Constructor({})
  await api.getInfo('C:\\fixture.png')
  assert.equal(waitArgs[0], 'task_image')
  assert.ok(Number.isFinite(waitArgs[2]) && waitArgs[2] > 0)
})

test('finite wait preserves unknown task and stops polling without native cancellation', async () => {
  const f = fixture(), taskId = await f.api.callAsync('ImagePlugin', 'Compress', {})
  await assert.rejects(f.api.waitTask(taskId, 2, 12), error => {
    assert.equal(error.taskId, taskId); assert.equal(error.workOutcome, 'unknown'); assert.equal(error.noReplay, true)
    return true
  })
  const count = f.calls.length
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.calls.length, count); assert.equal(f.timers.size, 0)
  assert.equal(f.api._tasks.get(taskId).status, 'invoking')
  assert.equal(f.calls.some(call => call.method.includes('cancel')), false)
})

test('late no-start event remains typed and an early terminal event cannot be overwritten by the start response', async () => {
  const f = fixture()
  let release
  f.response(async method => method === 'dllplugin_call_async'
    ? new Promise(resolve => { release = resolve })
    : { success: true, queryOk: true, taskStatus: 'running' })
  const call = f.api.callAsync('ImagePlugin', 'Compress', {})
  f.emit({ plugin: 'ImagePlugin', taskId: 'task_early', status: 'error', error: 'refused',
    taskStartResolved: 'not-started', taskStartPending: false, workNotStarted: true, code: 'PERMISSION_DENIED' })
  release({ success: true, taskId: 'task_early', taskStartPending: true })
  const taskId = await call
  await assert.rejects(f.api.waitTask(taskId, 1, 20), { code: 'PERMISSION_DENIED',
    taskId, workNotStarted: true, taskDone: true })
  assert.equal(f.api._tasks.get(taskId).startPending, false)
  assert.equal(f.calls.length, 1)
})

test('a query failure stops observation and preserves the pending native state', async () => {
  const f = fixture(), taskId = await f.api.callAsync('ImagePlugin', 'Compress', {})
  f.response(async () => { throw Object.assign(new Error('maintenance busy'), { code: 'PLUGIN_BUSY' }) })
  await assert.rejects(f.api.waitTask(taskId, 1, 100), { taskId, noReplay: true, workOutcome: 'unknown' })
  assert.equal(f.api._tasks.get(taskId).status, 'invoking')
  assert.equal(f.api._tasks.get(taskId).error, undefined)
  assert.equal(f.api._tasks.get(taskId).startPending, true)
  assert.equal(f.timers.size, 0)
})

function observedController() {
  const controller = new AbortController(), listeners = new Set()
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); add(type, listener, options) }
  controller.signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); remove(type, listener, options) }
  return { controller, listeners }
}

test('abort during sleep clears its timer and listener without a native cancellation request', async () => {
  const f = fixture(), taskId = await f.api.callAsync('ImagePlugin', 'Compress', {}), c = observedController()
  const waiting = f.api.waitTask(taskId, 100, 1000, { signal: c.controller.signal })
  const rejected = assert.rejects(waiting, { name: 'AbortError', code: 'DLL_TASK_OBSERVATION_ABORTED', taskId, noReplay: true })
  await new Promise(resolve => setTimeout(resolve, 5)); c.controller.abort(); await rejected
  const count = f.calls.length
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.calls.length, count); assert.equal(f.timers.size, 0); assert.equal(c.listeners.size, 0)
  assert.equal(f.calls.some(call => call.method.includes('cancel')), false)
})

test('abort during the owned query waits for that bounded query and never schedules another poll', async () => {
  const f = fixture(), taskId = await f.api.callAsync('ImagePlugin', 'Compress', {}), c = observedController()
  let release
  f.response(async () => new Promise(resolve => { release = resolve }))
  const waiting = f.api.waitTask(taskId, 1, 100, { signal: c.controller.signal })
  let settled = false
  void waiting.then(() => { settled = true }, () => { settled = true })
  const rejected = assert.rejects(waiting, { code: 'DLL_TASK_OBSERVATION_ABORTED', noReplay: true })
  c.controller.abort(); await Promise.resolve(); assert.equal(settled, false)
  assert.ok(f.calls[1].options.timeout > 0 && f.calls[1].options.timeout <= 100)
  assert.equal(f.calls[1].options.signal, undefined)
  release({ success: true, queryOk: true, taskStatus: 'invoking', taskStartPending: true })
  await rejected
  assert.equal(f.calls.length, 2); assert.equal(f.timers.size, 0); assert.equal(c.listeners.size, 0)
})

test('wait argument validation and a pre-aborted observer dispatch no query', async () => {
  const f = fixture(), taskId = await f.api.callAsync('ImagePlugin', 'GetInfo', {})
  for (const [poll, timeout, options] of [[0, 1, {}], [Infinity, 1, {}], [1, -1, {}], [1, NaN, {}], [1, 1, { signal: {} }]]) {
    await assert.rejects(f.api.waitTask(taskId, poll, timeout, options), { code: 'INVALID_REQUEST' })
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.api.waitTask(taskId, 1, 20, { signal: controller.signal }), { code: 'DLL_TASK_OBSERVATION_ABORTED' })
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0)
})

test('late completion after an observation timeout enriches the original task without replaying work', async () => {
  const f = fixture(), taskId = await f.api.callAsync('ImagePlugin', 'Compress', {})
  await assert.rejects(f.api.waitTask(taskId, 1, 5), { noReplay: true })
  f.emit({ plugin: 'ImagePlugin', taskId, status: 'completed', taskStartPending: false, data: { result: true } })
  const result = await f.api.waitTask(taskId, 1, 20)
  assert.equal(result.result, true)
  assert.equal(f.calls.filter(call => call.method === 'dllplugin_call_async').length, 1)
  assert.equal(f.api._tasks.get(taskId).status, 'completed')
})
