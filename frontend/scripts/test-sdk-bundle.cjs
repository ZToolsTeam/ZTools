const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const sdkPath = path.join(__dirname, '../public/sdk/ztools-api.js')
const referenceContractSource = fs.readFileSync(path.join(__dirname, '../../electron-client/src/contracts/reference-transport.ts'), 'utf8')
const mutatingMethodList = referenceContractSource.match(/export const REFERENCE_MUTATING_METHODS = \[([\s\S]*?)\] as const/)
const referenceMethodList = referenceContractSource.match(/export const REFERENCE_METHODS = \[\.\.\.REFERENCE_MUTATING_METHODS,([\s\S]*?)\] as const/)
assert.ok(mutatingMethodList && referenceMethodList, 'canonical reference method lists must remain statically readable')
const parseMethods = block => [...block.matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1])
const referenceMethods = [...parseMethods(mutatingMethodList[1]), ...parseMethods(referenceMethodList[1])]

function evaluateSdk(sdk, host) {
  const errors = []
  const window = {
    __ztoolsElectron: host,
    addEventListener() {}, removeEventListener() {}, location: { protocol: 'ztools:', hostname: 'web' }
  }
  vm.runInNewContext(sdk, { window, console: { log() {}, warn() {}, error(...args) { errors.push(args) } },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder,
    navigator: { userAgent: 'Electron/43.4.1', platform: 'Win32' }, document: { readyState: 'complete', addEventListener() {}, removeEventListener() {} } })
  return { window, errors }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('bounded wait expired while waiting for the SDK bridge call')
    await new Promise(resolve => setImmediate(resolve))
  }
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)) }

function createReferenceBridge({ incompleteMethod, incompleteCancellation } = {}) {
  const methodCalls = []
  const cancellationCalls = []
  const pendingReads = new Map()
  let holdNextRead = false
  const fileReference = Object.freeze({ grantId: 'F'.repeat(43), displayName: 'input.txt', kind: 'file', operations: Object.freeze(['read']) })
  const saveReference = Object.freeze({ grantId: 'S'.repeat(43), displayName: 'output.txt', kind: 'save', operations: Object.freeze(['write']) })
  const response = (request, data) => ({ messageId: request.messageId, success: true, data })
  const methods = {
    app_ready(request) {
      methodCalls.push({ method: 'app_ready', request })
      return Promise.resolve(response(request, {}))
    }
  }
  for (const method of referenceMethods) {
    if (method === incompleteMethod) continue
    methods[method] = request => {
      methodCalls.push({ method, request })
      if (method === 'window_show_open_dialog') {
        return Promise.resolve(response(request, { success: true, canceled: false, references: [fileReference] }))
      }
      if (method === 'window_show_save_dialog') {
        return Promise.resolve(response(request, { success: true, canceled: false, references: [saveReference] }))
      }
      if (method === 'filesystem_read_file' && holdNextRead) {
        holdNextRead = false
        return new Promise(resolve => pendingReads.set(request.messageId, resolve))
      }
      if (method === 'filesystem_read_file') {
        const content = 'bundle fixture'
        return Promise.resolve(response(request, { success: true, content, size: Buffer.byteLength(content) }))
      }
      if (method === 'filesystem_write_file') {
        return Promise.resolve(response(request, { success: true, status: 'committed', size: Buffer.byteLength(request.params.content) }))
      }
      return Promise.resolve(response(request, { success: true }))
    }
  }
  const cancellations = {}
  for (const method of referenceMethods) {
    if (method === incompleteCancellation) continue
    cancellations[method] = request => {
      cancellationCalls.push({ method, request })
      const pending = pendingReads.get(request.messageId)
      if (pending) {
        pendingReads.delete(request.messageId)
        pending({ messageId: request.messageId, success: false, error: { code: 'CALLER_DESTROYED', message: 'request cancelled' } })
      }
      return Promise.resolve({ success: true })
    }
  }
  const transport = Object.freeze({
    methods: Object.freeze(methods),
    cancellations: Object.freeze(cancellations),
    setMessageCallback() {}
  })
  return {
    host: Object.freeze({ contractVersion: 2, app: Object.freeze({}), transport }),
    methodCalls,
    cancellationCalls,
    fileReference,
    saveReference,
    holdNextRead() { holdNextRead = true }
  }
}

test('generated SDK initializes all public modules on the formal contract 1 bridge', async () => {
  const errors = []
  const window = {
    __ztoolsElectron: { contractVersion: 1, app: {}, transport: {
      methods: { app_ready: async request => ({ messageId: request.messageId, success: true, data: {} }) },
      setMessageCallback() {}
    } },
    addEventListener() {}, removeEventListener() {}, location: { protocol: 'ztools:', hostname: 'web' }
  }
  const sdk = fs.readFileSync(sdkPath, 'utf8')
  vm.runInNewContext(sdk, { window, console: { log() {}, warn() {}, error(...args) { errors.push(args) } },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder,
    navigator: { userAgent: 'Electron/43.4.1' }, document: { readyState: 'complete', addEventListener() {}, removeEventListener() {} } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(window.ztools.isElectron(), true)
  for (const module of ['fs', 'db', 'sys', 'plugin', 'config', 'clipboard', 'screen', 'network', 'process', 'ocr', 'image', 'zip', 'update']) {
    assert.equal(typeof window.ztools[module], 'object', module)
  }
  assert.equal(typeof window.ztools._client.sqlite.readBrowserSnapshot, 'function')
  assert.equal(window.ztools.sqlite, undefined, 'contract 1 must not expose reference SQLite')
  assert.deepEqual(errors, [])
})

test('generated SDK composes contract 2 picker, FileRef IO, and per-method AbortSignal cancellation', async () => {
  const sdk = fs.readFileSync(sdkPath, 'utf8')
  const bridge = createReferenceBridge()
  const { window, errors } = evaluateSdk(sdk, bridge.host)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(window.ztools.isElectron(), true)
  assert.equal(window.ztools._transport.constructor.name, 'ReferenceTransport')
  assert.equal(window.ztools._transport.supportsAbortSignal, true)
  assert.equal(window.ztools.fs.constructor.name, 'ReferenceFileSystemAPI')
  assert.equal(window.ztools.win.constructor.name, 'ReferenceWindowAPI')
  assert.equal(window.ztools.clipboard.constructor.name, 'ReferenceClipboardAPI')
  assert.equal(window.ztools.network.constructor.name, 'ReferenceNetworkAPI')
  const opened = await window.ztools.win.showOpenDialog({ properties: ['openFile'] })
  assert.equal(opened.success, true)
  assert.deepEqual(Array.from(opened.references[0].operations), ['read'])
  const content = await window.ztools.fs.readFile(opened.references[0])
  assert.equal(content, 'bundle fixture')

  const saved = await window.ztools.win.showSaveDialog({ defaultName: 'output.txt' })
  assert.equal(saved.success, true)
  const writeResult = await window.ztools.fs.writeFile(saved.references[0], 'saved fixture')
  assert.equal(writeResult.status, 'committed')

  const pickerCalls = bridge.methodCalls.filter(call => call.method.startsWith('window_show_'))
  assert.deepEqual(pickerCalls.map(call => call.method), ['window_show_open_dialog', 'window_show_save_dialog'])
  const fileRead = bridge.methodCalls.find(call => call.method === 'filesystem_read_file')
  const fileWrite = bridge.methodCalls.find(call => call.method === 'filesystem_write_file')
  assert.deepEqual(cloneJson(fileRead.request.params), { grantId: bridge.fileReference.grantId, relativePath: '', encoding: 'utf8' })
  assert.deepEqual(cloneJson(fileWrite.request.params), { saveGrantId: bridge.saveReference.grantId, content: 'saved fixture', encoding: 'utf8', replace: false })
  assert.equal(Object.keys(fileRead.request.params).some(key => /^(?:filePath|savePath|path|tempFile)$/i.test(key)), false)
  assert.equal(Object.keys(fileWrite.request.params).some(key => /^(?:filePath|savePath|path|tempFile)$/i.test(key)), false)

  bridge.holdNextRead()
  const controller = new AbortController()
  const priorReadCount = bridge.methodCalls.filter(call => call.method === 'filesystem_read_file').length
  const cancelledRead = window.ztools.fs.readFile(opened.references[0], { signal: controller.signal })
  await waitFor(() => bridge.methodCalls.filter(call => call.method === 'filesystem_read_file').length > priorReadCount)
  const pendingCall = bridge.methodCalls.filter(call => call.method === 'filesystem_read_file').at(-1)
  controller.abort()
  await assert.rejects(cancelledRead, error => error.code === 'CALLER_DESTROYED')
  assert.deepEqual(cloneJson(bridge.cancellationCalls.at(-1)), {
    method: 'filesystem_read_file',
    request: { messageId: pendingCall.request.messageId, reason: 'cancel' }
  })
  assert.deepEqual(errors, [])
})

test('generated SDK rejects an incomplete contract 2 bridge before app_ready and preserves contract 1 fallback', async () => {
  const sdk = fs.readFileSync(sdkPath, 'utf8')
  for (const incomplete of [
    createReferenceBridge({ incompleteMethod: 'filesystem_read_file' }),
    createReferenceBridge({ incompleteCancellation: 'filesystem_write_file' })
  ]) {
    assert.throws(() => evaluateSdk(sdk, incomplete.host), error =>
      error.code === 'NOT_SUPPORTED' && error.message === 'SDK合约2宿主缺少完整的逐方法调用与取消入口')
    assert.equal(incomplete.methodCalls.some(call => call.method === 'app_ready'), false)
  }

  const errors = []
  const legacyWindow = {
    __ztoolsElectron: { contractVersion: 1, app: {}, transport: {
      methods: { app_ready: async request => ({ messageId: request.messageId, success: true, data: {} }) },
      setMessageCallback() {}
    } },
    addEventListener() {}, removeEventListener() {}, location: { protocol: 'ztools:', hostname: 'web' }
  }
  vm.runInNewContext(sdk, { window: legacyWindow, console: { log() {}, warn() {}, error(...args) { errors.push(args) } },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder,
    navigator: { userAgent: 'Electron/43.4.1', platform: 'Win32' }, document: { readyState: 'complete', addEventListener() {}, removeEventListener() {} } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof legacyWindow.ztools.fs.readFile, 'function')
  assert.equal(legacyWindow.ztools._transport.constructor.name, 'Transport')
  assert.equal(legacyWindow.ztools.fs.constructor.name, 'FileSystemAPI')
  assert.equal(legacyWindow.ztools.win.constructor.name, 'WindowAPI')
  assert.deepEqual(errors, [])
})
