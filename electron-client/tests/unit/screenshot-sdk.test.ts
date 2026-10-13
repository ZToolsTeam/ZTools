import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
interface API { captureRegion(options?: { signal?: AbortSignal; timeout?: number; pollInterval?: number }): Promise<Record<string, unknown>>; captureScreen(): Promise<Record<string, unknown>> }
function fixture(sys?: unknown) {
  const calls: string[] = [], canceled: string[] = []
  const dll: { callAsync: () => Promise<string>; queryTask: () => Promise<unknown>; cancelTask: (plugin: string, id: string) => Promise<boolean>; call: () => Promise<unknown> } = { callAsync: async () => { calls.push('create'); return 'owned-task' }, queryTask: async () => { calls.push('query'); return { completed: true, status: 'done', data: { success: true, outputPath: 'cache.png', savedPath: 'selected.png', clipboard: true, pinned: true } } }, cancelTask: async (_plugin: string, id: string) => { canceled.push(id); return true }, call: async () => { calls.push('call'); return { success: true, savedPath: 'screen.png', clipboard: true } } }
  const capabilitySource = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/runtime-capability.js', 'utf8').replace(/^export /gm, '')
  const source = capabilitySource + '\n' + fs.readFileSync('../frontend/public/js/cef-ipc/src/api/screenshot.js', 'utf8')
    .replace(/^import .+$/mg, '')
    .replace(/^export .+$/mg, '')
  const Constructor = vm.runInNewContext(source + '\nScreenshotAPI', { AbortController, setTimeout, clearTimeout }) as new (dll: unknown, sys?: unknown) => API
  return { dll, calls, canceled, api: new Constructor(dll, sys) }
}
test('screenshot toolbar save/copy/pin fields survive public normalization', async () => {
  const f = fixture(), result = await f.api.captureRegion()
  assert.equal(result.savedPath, 'selected.png'); assert.equal(result.clipboard, true); assert.equal(result.pinned, true)
  assert.equal((await f.api.captureScreen()).savedPath, 'screen.png'); assert.deepEqual(f.canceled, [])
})
test('preaborted screenshot does not create a native task', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.api.captureRegion({ signal: controller.signal }), { code: 'CALLER_DESTROYED' })
  assert.deepEqual(f.calls, [])
})
test('screenshot cancellation interrupts a pending query and cancels exactly its owned task', async () => {
  const f = fixture(), controller = new AbortController()
  f.dll.queryTask = async () => { controller.abort(); return new Promise(() => {}) }
  await assert.rejects(f.api.captureRegion({ signal: controller.signal }), { code: 'CALLER_DESTROYED' })
  assert.deepEqual(f.canceled, ['owned-task'])
})
test('timeout bounds polling and requests native cancellation', async () => {
  const f = fixture(); f.dll.queryTask = async () => new Promise(() => {})
  await assert.rejects(f.api.captureRegion({ timeout: 10 }), { code: 'REQUEST_TIMEOUT' })
  assert.deepEqual(f.canceled, ['owned-task'])
})
test('late task creation is canceled even after caller already returned', async () => {
  const f = fixture(), controller = new AbortController(); let finish!: (id: string) => void, signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  f.dll.callAsync = () => new Promise(resolve => { finish = resolve; signalStarted() })
  const pending = f.api.captureRegion({ signal: controller.signal }); await started; controller.abort()
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  finish('late-owned-task'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.canceled, ['late-owned-task']); assert.deepEqual(f.calls, [])
})
test('native cancelled status is explicit and error text never determines cancellation', async () => {
  const f = fixture(); f.dll.queryTask = async () => ({ completed: true, status: 'cancelled', data: {}, error: 'user dismissed' }) as never
  assert.equal((await f.api.captureRegion()).cancelled, true)
  f.dll.queryTask = async () => ({ completed: true, status: 'error', data: {}, error: '取消失败，设备错误' }) as never
  await assert.rejects(f.api.captureRegion(), /设备错误/)
})
test('invalid timeout or poll interval cannot create a task', async () => {
  const f = fixture()
  for (const options of [{ timeout: 0 }, { timeout: 600001 }, { pollInterval: 0 }, { pollInterval: NaN }]) await assert.rejects(f.api.captureRegion(options), /参数无效/)
  assert.deepEqual(f.calls, [])
})

test('screenshot first use requests once before dispatching a native capture', async () => {
  const requests: unknown[] = []
  const sys = {
    transport: { isElectronEnvironment: () => true },
    async getCapability() { return { authorization: 'not-requested' } },
    async requestCapability(request: unknown) { requests.push(request); return { authorization: 'granted' } }
  }
  const f = fixture(sys)
  await f.api.captureScreen()
  assert.equal(requests.length, 1)
  assert.equal((requests[0] as { capability?: string }).capability, 'screen.capture')
  assert.deepEqual(f.calls, ['call'])
})

test('a previously denied screenshot does not prompt or dispatch again', async () => {
  let requests = 0
  const sys = {
    transport: { isElectronEnvironment: () => true },
    async getCapability() { return { authorization: 'denied' } },
    async requestCapability() { requests += 1; return { authorization: 'granted' } }
  }
  const f = fixture(sys)
  await assert.rejects(f.api.captureScreen(), { code: 'PERMISSION_DENIED' })
  assert.equal(requests, 0)
  assert.deepEqual(f.calls, [])
})
