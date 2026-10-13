const { BrowserWindow, nativeImage, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
module.exports = async function regionFixture({ load, compiled, runtime, cache, requests, caller, target, createReferenceProducerHandlers, ReferenceIpcEndpoint, producerServices }) {
  const { MacRegionSelection } = await load('platform/macos/region-selection.js')
  const { ReferenceRegionCaptureService } = await load('services/reference-region-capture-service.js')
  const { ScreenService } = await load('services/screen-service.js')
  const { installZToolsProtocol } = await load('protocol/ztools-protocol.js')
  const web = path.resolve(__dirname, '../../../out/assets/web')
  for (const name of ['region-selector.html', 'region-selector.js']) {
    assert.deepEqual(fs.readFileSync(path.join(web, 'platform', name)), fs.readFileSync(path.resolve(__dirname, '../../../../frontend/public/platform', name)), 'Build must include the current maintained selector')
  }
  installZToolsProtocol({ web, plugins: web, cache: web, temp: web }, runtime.fileSystem)
  // This isolated fixture has no Router. Its unregistered selector must receive a closed lane reply.
  const handshakeChannel = 'ztools:sdk-lane'
  if (ipcMain.listenerCount(handshakeChannel) !== 0) throw new Error('REGION_FIXTURE_HANDSHAKE_ALREADY_REGISTERED')
  const handshakeListener = event => { event.returnValue = null }
  ipcMain.on(handshakeChannel, handshakeListener)
  const windows = [], bounds = { x: -400, y: -100, width: 400, height: 300 }
  let notify, images = 0, selectedRect
  const selection = new MacRegionSelection(path.join(compiled, 'src/preload/main.js'), {
    platform: 'darwin', timeoutMs: 10000,
    createWindow: (rect, nonce) => {
      // Actual Chromium, sandbox preload and IPC; inject hidden window policy. No user desktop pixels are captured.
      const window = new BrowserWindow({ ...rect, show: false, frame: false, webPreferences: { preload: path.join(compiled, 'src/preload/main.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, additionalArguments: ['--ztools-region-selection=' + nonce] } })
      windows.push(window)
      return { webContents: window.webContents, loadURL: async url => { await window.loadURL(url); notify?.(window) }, show() {}, destroy: () => window.destroy(), isDestroyed: () => window.isDestroyed(), once: (event, listener) => window.once(event, listener), removeListener: (event, listener) => window.removeListener(event, listener) }
    }
  })
  const display = { id: 1, label: 'synthetic region', bounds, workArea: bounds, scaleFactor: 1, rotation: 0, touchSupport: 'unknown' }
  const bitmap = Buffer.alloc(bounds.width * bounds.height * 4)
  for (let offset = 0; offset < bitmap.length; offset += 4) { bitmap[offset + 2] = 255; bitmap[offset + 3] = 255 }
  const screen = new ScreenService(undefined, { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => display, getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getDisplayMatching: () => display,
    getSources: async () => { assert.ok(windows.every(window => window.isDestroyed()), 'Selection windows must actually close before capture'); images++; return [{ displayId: '1', image: nativeImage.createFromBitmap(bitmap, { width: 400, height: 300, scaleFactor: 1 }) }] }, createFromBitmap: (bytes, size) => nativeImage.createFromBitmap(bytes, { ...size, scaleFactor: 1 }) }, undefined, cache)
  const captureScreen = { getAllDisplays: () => screen.getAllDisplays(), captureReference: (params, caller, signal) => { selectedRect = params.rect; return screen.captureReference(params, caller, signal) } }
  const region = new ReferenceRegionCaptureService(captureScreen, selection)
  const endpoint = new ReferenceIpcEndpoint({ get: owner => owner === 42 ? caller : undefined, getWebContents: owner => owner === 42 ? target : undefined, getSdkApiLane: () => 2 }, requests, createReferenceProducerHandlers({ ...producerServices, screen, region }), () => true)
  function loaded() {
    let timer
    const promise = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('REGION_FIXTURE_LOAD_TIMEOUT')), 5000); notify = resolve })
    return promise.finally(() => { clearTimeout(timer); notify = undefined })
  }
  return { endpoint, stop: async () => { try { await region.stop() } finally { ipcMain.removeListener(handshakeChannel, handshakeListener) } }, run: async sdk => {
    let count = 0
    let ready = loaded(), pending = sdk.captureRegionReference(), window = await ready
    assert.equal(window.isVisible(), false)
    assert.deepEqual(await window.webContents.executeJavaScript('({ privateBridge: typeof window.__ztoolsRegionSelection.submit, node: typeof require, url: location.href })'), { privateBridge: 'function', node: 'undefined', url: 'ztools://web/platform/region-selector.html' }); count++
    await window.webContents.executeJavaScript(`(() => {
      document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, clientX: 50, clientY: 40 }));
      document.documentElement.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 90, clientY: 70 }));
      document.documentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: 90, clientY: 70 }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    const capture = await pending
    try { assert.deepEqual([capture.width, capture.height], [40, 30]); assert.deepEqual(selectedRect, { x: -350, y: -60, width: 40, height: 30 }); const bytes = await runtime.grants.read(42, capture.reference.grantId); const decoded = nativeImage.createFromBuffer(bytes); assert.deepEqual(decoded.getSize(), { width: 40, height: 30 }); assert.deepEqual([...decoded.toBitmap().subarray(0, 4)], [0, 0, 255, 255]); assert.equal(images, 1); assert.ok(window.isDestroyed()); count++ }
    finally { await runtime.grants.revoke(42, capture.reference.grantId) }
    ready = loaded(); pending = sdk.captureRegionReference(); window = await ready
    await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    assert.equal(await pending, undefined); assert.ok(window.isDestroyed()); assert.equal(images, 1); count++
    const controller = new AbortController(); ready = loaded(); pending = sdk.captureRegionReference({ signal: controller.signal }); const rejected = assert.rejects(pending, { code: 'CALLER_DESTROYED' }); window = await ready; controller.abort(); await rejected
    // SDK cancellation and native cleanup are asynchronous; the owned region service drains before accepting closure.
    await region.stop(); assert.ok(window.isDestroyed()); assert.equal(images, 1); count++
    return count
  } }
}
