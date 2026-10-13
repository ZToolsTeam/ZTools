import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MacRegionSelection, REGION_SELECTION_URL } from '../../src/main/platform/macos/region-selection.js'
const bounds = [{ x: 0, y: 0, width: 800, height: 600 }, { x: -640, y: -100, width: 640, height: 480 }]
class Overlay extends EventEmitter {
  destroyed = false; shown = false; zoom = 0; destroyCalls = 0; loadCalls = 0; stuck = false; loadFailure = false
  readonly webContents = { id: Math.floor(Math.random() * 10000), mainFrame: {}, getURL: () => REGION_SELECTION_URL, setZoomFactor: (value: number) => { this.zoom = value } }
  async loadURL(url: string) { this.loadCalls++; assert.equal(url, REGION_SELECTION_URL); if (this.loadFailure) throw new Error('load'); return undefined }
  show() { this.shown = true }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyCalls++; if (!this.stuck) setTimeout(() => { this.destroyed = true; this.emit('closed') }, 5) }
}
function fixture(timeoutMs = 10000, configure?: (window: Overlay, index: number) => void, screenEvents = new EventEmitter()) {
  const windows: Overlay[] = []; let nonce = '', detached = 0
  let listener!: (event: { sender: unknown; senderFrame: unknown }, value: unknown) => void
  const selection = new MacRegionSelection(process.execPath, { platform: 'darwin', timeoutMs, closeTimeoutMs: 30,
    createWindow: (_bounds, token) => { nonce = token; const window = new Overlay(); configure?.(window, windows.length); windows.push(window); return window },
    listen: callback => { listener = callback; return () => { detached++ } }, screenEvents: screenEvents as never
  })
  return { selection, windows, screenEvents, detached: () => detached, message: (index: number, value: object, frame?: unknown) => { const window = windows[index]!; listener({ sender: window.webContents, senderFrame: frame ?? window.webContents.mainFrame }, { nonce, ...value }) }, spoof: (value: object) => listener({ sender: {}, senderFrame: {} }, { nonce, ...value }) }
}
test('Mac selector gates Windows/preabort/invalid display geometry without creating overlays', async () => {
  const win = new MacRegionSelection(process.execPath, { platform: 'win32', createWindow: () => { throw Error('must not run') } })
  await assert.rejects(win.select(bounds, new AbortController().signal), { code: 'NOT_SUPPORTED' })
  const f = fixture(), c = new AbortController(); c.abort(); await assert.rejects(f.selection.select(bounds, c.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.windows.length, 0)
  for (const value of [[], Array(9).fill(bounds[0]), [{ x: 0, y: 0, width: 0, height: 1 }]]) await assert.rejects(f.selection.select(value, new AbortController().signal)); assert.equal(f.windows.length, 0)
})
test('Mac selector resolves negative desktop coordinates only after all owned windows actually close', async () => {
  const f = fixture(), pending = f.selection.select(bounds, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve)); assert.ok(f.windows.every(window => window.shown && window.zoom === 1))
  f.message(1, { rect: { x: 10, y: 20, width: 100, height: 80 } })
  assert.deepEqual(await pending, { x: -630, y: -80, width: 100, height: 80 }); assert.ok(f.windows.every(window => window.destroyed && window.destroyCalls === 1)); assert.equal(f.detached(), 1); await f.selection.stop()
})
test('Mac selector ignores spoofed/child-frame/wrong nonce/out-of-screen inputs before accepting its real overlay', async () => {
  const f = fixture(), pending = f.selection.select(bounds, new AbortController().signal)
  let settled = false; void pending.then(() => { settled = true })
  const rect = { x: 10, y: 10, width: 100, height: 100 }
  f.spoof({ rect }); f.message(0, { rect }, {}); f.message(0, { nonce: 'wrong', rect }); f.message(0, { rect: { ...rect, width: 900 } }); f.message(0, { rect: { ...rect, x: -1 } }); f.message(0, { rect: { ...rect, width: 0 } }); f.message(0, { rect, path: '/private' })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); f.message(0, { rect }); assert.deepEqual(await pending, rect)
})
test('Esc or a user-closed overlay cancels without returning a screenshot region', async () => {
  const f = fixture(), pending = f.selection.select(bounds, new AbortController().signal); f.message(0, { cancel: true }); assert.equal(await pending, undefined); assert.ok(f.windows.every(window => window.destroyed))
  const other = fixture(), next = other.selection.select(bounds, new AbortController().signal); other.windows[0]!.destroy(); assert.equal(await next, undefined); assert.ok(other.windows.every(window => window.destroyed))
})
test('display add/remove/metrics changes cancel the active selection, close every overlay, and detach listeners', async () => {
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    const f = fixture(), pending = f.selection.select(bounds, new AbortController().signal)
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(f.screenEvents.listenerCount(name), 1)
    const rejected = assert.rejects(pending, { code: 'SCREEN_ERROR' })
    f.screenEvents.emit(event, {}, {})
    await rejected
    assert.ok(f.windows.every(window => window.destroyed && window.destroyCalls === 1))
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(f.screenEvents.listenerCount(name), 0)
  }
})
test('a display change during overlay construction stops further creation and closes the constructed window', async () => {
  const screenEvents = new EventEmitter()
  const f = fixture(10000, (_window, index) => { if (index === 0) screenEvents.emit('display-removed') }, screenEvents)
  await assert.rejects(f.selection.select(bounds, new AbortController().signal), { code: 'SCREEN_ERROR' })
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0]?.loadCalls, 0)
  assert.ok(f.windows[0]?.destroyed); assert.equal(screenEvents.listenerCount('display-removed'), 0)
})
test('partial display-event subscription failure fails closed and removes listeners already attached', async () => {
  class FailingScreenEvents extends EventEmitter {
    override on(event: string | symbol, listener: (...args: any[]) => void) {
      if (event === 'display-removed') throw new Error('listener setup failed')
      return super.on(event, listener)
    }
  }
  const screenEvents = new FailingScreenEvents(), f = fixture(10000, undefined, screenEvents)
  await assert.rejects(f.selection.select(bounds, new AbortController().signal), { code: 'SCREEN_ERROR' })
  assert.equal(f.windows.length, 0); assert.equal(screenEvents.listenerCount('display-added'), 0)
  assert.equal(screenEvents.listenerCount('display-removed'), 0); assert.equal(screenEvents.listenerCount('display-metrics-changed'), 0)
})
test('repeated display events race once with abort, detach before reentry, and do not change the first result', async () => {
  const f = fixture(), controller = new AbortController(), pending = f.selection.select(bounds, controller.signal)
  const rejected = assert.rejects(pending, { code: 'SCREEN_ERROR' })
  f.screenEvents.emit('display-removed'); controller.abort(); f.screenEvents.emit('display-metrics-changed'); f.screenEvents.emit('display-added')
  await rejected
  assert.ok(f.windows.every(window => window.destroyed && window.destroyCalls === 1))
  assert.equal(f.screenEvents.listenerCount('display-added'), 0); assert.equal(f.screenEvents.listenerCount('display-removed'), 0); assert.equal(f.screenEvents.listenerCount('display-metrics-changed'), 0)
  const next = f.selection.select([bounds[0]!], new AbortController().signal)
  assert.equal(f.screenEvents.listenerCount('display-added'), 1); assert.equal(f.screenEvents.listenerCount('display-removed'), 1); assert.equal(f.screenEvents.listenerCount('display-metrics-changed'), 1)
  f.message(2, { cancel: true }); assert.equal(await next, undefined)
  assert.equal(f.screenEvents.listenerCount('display-added'), 0); assert.equal(f.screenEvents.listenerCount('display-removed'), 0); assert.equal(f.screenEvents.listenerCount('display-metrics-changed'), 0)

  const aborted = fixture(), abortController = new AbortController(), abortPending = aborted.selection.select(bounds, abortController.signal)
  const abortRejected = assert.rejects(abortPending, { code: 'CALLER_DESTROYED' })
  abortController.abort(); aborted.screenEvents.emit('display-added'); await abortRejected
  assert.ok(aborted.windows.every(window => window.destroyed && window.destroyCalls === 1))
  assert.equal(aborted.screenEvents.listenerCount('display-added'), 0); assert.equal(aborted.screenEvents.listenerCount('display-removed'), 0); assert.equal(aborted.screenEvents.listenerCount('display-metrics-changed'), 0)
})
test('Mac selector abort/timeout/stop are bounded, drain all overlays and reject new concurrent selection', async () => {
  const f = fixture(), c = new AbortController(), pending = f.selection.select(bounds, c.signal); const rejection = assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  await assert.rejects(f.selection.select(bounds, new AbortController().signal), { code: 'PLUGIN_BUSY' }); c.abort(); await rejection; assert.ok(f.windows.every(window => window.destroyed))
  const timeout = fixture(20); await assert.rejects(timeout.selection.select(bounds, new AbortController().signal), { code: 'REQUEST_TIMEOUT' }); assert.ok(timeout.windows.every(window => window.destroyed))
  const stop = fixture(), stopped = stop.selection.select(bounds, new AbortController().signal); const rejected = assert.rejects(stopped, { code: 'CALLER_DESTROYED' }); await stop.selection.stop(); await rejected; assert.ok(stop.windows.every(window => window.destroyed)); await assert.rejects(stop.selection.select(bounds, new AbortController().signal), { code: 'CALLER_DESTROYED' })
})
test('load/construction failure closes already created overlays and never returns a region', async () => {
  const load = fixture(10000, (window, index) => { window.loadFailure = index === 1 }); await assert.rejects(load.selection.select(bounds, new AbortController().signal), { code: 'SCREEN_ERROR' }); assert.ok(load.windows.every(window => window.destroyed))
  const failure = fixture(10000, (_window, index) => { if (index === 1) throw new Error('fixture creation failed') }); await assert.rejects(failure.selection.select(bounds, new AbortController().signal)); assert.equal(failure.windows[0]?.destroyed, true)
})
test('unconfirmed overlay destruction reports failure and keeps only owned windows for a later stop retry', async () => {
  const f = fixture(10000, window => { window.stuck = true }), pending = f.selection.select([bounds[0]!], new AbortController().signal); const rejected = assert.rejects(pending, { code: 'SCREEN_ERROR' }); f.message(0, { rect: { x: 1, y: 1, width: 10, height: 10 } }); await rejected; assert.equal(f.windows[0]?.destroyed, false)
  await assert.rejects(f.selection.select(bounds, new AbortController().signal), { code: 'PLUGIN_BUSY' }); f.windows[0]!.stuck = false; await f.selection.stop(); assert.equal(f.windows[0]?.destroyed, true)
})
