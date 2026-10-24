import test from 'node:test'
import assert from 'node:assert/strict'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { RuntimeCapabilityLease } from '../../src/main/services/runtime-capability-authorization-service.js'
import { ReferenceRegionCaptureService } from '../../src/main/services/reference-region-capture-service.js'
import type { ScreenService } from '../../src/main/services/screen-service.js'
const caller = { type: 'main' as const, webContentsId: 42 }
const display = { id: 2, index: 0, name: 'fixture', primary: true, bounds: { x: -640, y: -100, width: 640, height: 480 }, workArea: { x: -640, y: -100, width: 640, height: 480 }, scaleFactor: 2, rotation: 0, touchSupport: 'unknown', displayFrequency: 60, colorDepth: 24, depthPerComponent: 8 }
function fixture(beginCaptureAuthorization?: () => RuntimeCapabilityLease | undefined) {
  let captures = 0, stopped = false, selectionCalls = 0, current = [structuredClone(display)]
  let select = async (_signal: AbortSignal): Promise<{ x: number; y: number; width: number; height: number } | undefined> => ({ x: -600, y: -80, width: 100, height: 80 })
  const screen: Pick<ScreenService, 'getAllDisplays' | 'captureReference'> & Partial<Pick<ScreenService, 'beginCaptureAuthorization'>> = {
    getAllDisplays: () => ({ success: true as const, displays: current }), captureReference: async (
      params: Parameters<ScreenService['captureReference']>[0], identity: CallerIdentity, signal: AbortSignal
    ) => {
      assert.equal(identity, caller); assert.equal(signal.aborted, false); assert.deepEqual(params, { rect: { x: -600, y: -80, width: 100, height: 80 } }); captures++; return { success: true as const, reference: { grantId: 'a'.repeat(43), displayName: 'capture.png', kind: 'file', operations: ['read'] }, fileUrl: 'ztools://file/a/capture.png', size: 100, width: 100, height: 80 }
    }, ...(beginCaptureAuthorization ? { beginCaptureAuthorization } : {}) }
  const selection = { select: (bounds: typeof display.bounds[], signal: AbortSignal) => { selectionCalls += 1; assert.deepEqual(bounds, [display.bounds]); return select(signal) }, stop: async () => { stopped = true } }
  const service = new ReferenceRegionCaptureService(screen, selection)
  return { service, captures: () => captures, stopped: () => stopped, selectionCalls: () => selectionCalls, select: (next: typeof select) => { select = next }, changeScale: () => { current = current.map(item => ({ ...item, scaleFactor: 1 })) }, disconnect: () => { current = [] } }
}
test('region capture waits for selection completion then requests only the selected DIP rect through its owner', async () => {
  const f = fixture(); assert.equal((await f.service.capture({}, caller, new AbortController().signal)).success, true); assert.equal(f.captures(), 1); await f.service.stop(); assert.equal(f.stopped(), true)
})
test('region capture Esc/preabort/invalid params never fetches any screen pixels', async () => {
  const f = fixture(); f.select(async () => undefined); assert.deepEqual(await f.service.capture({}, caller, new AbortController().signal), { success: true, cancelled: true }); assert.equal(f.captures(), 0)
  const c = new AbortController(); c.abort(); await assert.rejects(f.service.capture({}, caller, c.signal), { code: 'CALLER_DESTROYED' }); await assert.rejects(f.service.capture({ path: '/private' }, caller, new AbortController().signal), { code: 'INVALID_REQUEST' }); assert.equal(f.captures(), 0)
})

test('region capture authorization denies before opening selection and revocation cancels its pending owner', async () => {
  const plugin: CallerIdentity = { type: 'plugin', webContentsId: 43, pluginId: 'sample', pluginInstanceId: 'instance-43' }
  const missingPort = fixture()
  await assert.rejects(missingPort.service.capture({}, plugin, new AbortController().signal), { code: 'NOT_SUPPORTED' })
  assert.equal(missingPort.selectionCalls(), 0)
  const missingLease = fixture(() => undefined)
  await assert.rejects(missingLease.service.capture({}, plugin, new AbortController().signal), { code: 'PERMISSION_DENIED' })
  assert.equal(missingLease.selectionCalls(), 0)

  const denied = fixture(() => { throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }) })
  await assert.rejects(denied.service.capture({}, caller, new AbortController().signal), { code: 'PERMISSION_DENIED' })
  assert.equal(denied.selectionCalls(), 0)

  const authorizationAbort = new AbortController()
  let selectionStarted!: () => void, released = 0
  const entered = new Promise<void>(resolve => { selectionStarted = resolve })
  const pending = fixture(() => ({
    signal: authorizationAbort.signal,
    assertCurrent() {
      if (authorizationAbort.signal.aborted) throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' })
    },
    release() { released += 1 }
  }))
  pending.select(signal => new Promise(resolve => {
    selectionStarted()
    signal.addEventListener('abort', () => resolve({ x: -600, y: -80, width: 20, height: 20 }), { once: true })
  }))
  const operation = pending.service.capture({}, caller, new AbortController().signal)
  await entered
  authorizationAbort.abort('grant revoked')
  await assert.rejects(operation, { code: 'PERMISSION_DENIED' })
  assert.equal(pending.captures(), 0)
  assert.equal(released, 1)
})
test('display removal/scale change or invalid selection never produces a shifted screenshot', async () => {
  const f = fixture(); f.select(async () => { f.disconnect(); return { x: -600, y: -80, width: 100, height: 80 } }); await assert.rejects(f.service.capture({}, caller, new AbortController().signal), { code: 'SCREEN_ERROR' }); assert.equal(f.captures(), 0)
  const changed = fixture(); changed.select(async () => { changed.changeScale(); return { x: -600, y: -80, width: 100, height: 80 } }); await assert.rejects(changed.service.capture({}, caller, new AbortController().signal), { code: 'SCREEN_ERROR' }); assert.equal(changed.captures(), 0)
  const other = fixture(); other.select(async () => ({ x: -600, y: -80, width: 999, height: 80 })); await assert.rejects(other.service.capture({}, caller, new AbortController().signal), { code: 'SCREEN_ERROR' }); assert.equal(other.captures(), 0)
})
test('region stop aborts and drains selection before stopping the backend; pending owners are mutually exclusive', async () => {
  const f = fixture(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  f.select(signal => new Promise(resolve => { entered(); signal.addEventListener('abort', () => setTimeout(() => resolve(undefined), 5), { once: true }) }))
  const pending = f.service.capture({}, caller, new AbortController().signal), rejected = assert.rejects(pending, { code: 'CALLER_DESTROYED' }); await started
  await assert.rejects(f.service.capture({}, { ...caller, webContentsId: 43 }, new AbortController().signal), { code: 'PLUGIN_BUSY' }); await f.service.stop(); await rejected; assert.equal(f.captures(), 0); assert.equal(f.stopped(), true)
})
