import assert from 'node:assert/strict'
import test from 'node:test'
import { createReferenceFileRuntime } from '../../src/main/platform/reference-file-runtime.js'
import { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { AnchoredFileSystemService } from '../../src/main/services/anchored-file-system-service.js'
import { EventService } from '../../src/main/services/event-service.js'
import type { PathAccessAdapter } from '../../src/main/platform/path-access.js'
import type { PathWriteRecoveryService } from '../../src/main/services/path-write-recovery-service.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'

// 这些用例依赖 Windows 路径语义（C:\\ / E:\\）或 Windows 宿主能力（DLL、进程启动、更新安装链、本地 .exe 软件），
// 在其他平台上功能代码按设计会拒绝执行，因此只在 Windows 宿主运行；Windows CI 上照常覆盖。
const windowsOnly = { skip: process.platform === 'win32' ? false : '依赖 Windows 路径或宿主能力，仅在 Windows 上运行' }


function fixture(failStop = false) {
  const log: string[] = [], listeners = new Set<(owner: number) => void>()
  const target = { id: 42, isDestroyed: () => false, mainFrame: { url: 'ztools://web/index.html' } }
  const caller = { type: 'main' as const, webContentsId: 42 }
  const registry = { get: (owner: number) => owner === 42 ? caller : undefined, getWebContents: (owner: number) => owner === 42 ? target : undefined,
    getSdkApiLane: () => 2,
    send: () => true, getSession: () => undefined, onRemoved: (listener: (owner: number) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } as unknown as WindowRegistry
  const events = new EventService(registry)
  let next = 0
  const unsupported = async (): Promise<never> => { throw new Error('unexpected port') }
  const adapter: PathAccessAdapter = {
    platform: 'win32', pin: async (_path, kind) => ({ handle: String(++next), kind, displayName: 'synthetic.txt' }),
    read: async () => Buffer.from('composed runtime'), readRange: async () => Buffer.from('composed runtime'),
    createDirectory: async () => ({ status: 'created' }), deriveDirectory: async (_object, segments) => ({ handle: String(++next), kind: 'directory', displayName: segments.at(-1)! }),
    deriveRead: async () => ({ handle: String(++next), kind: 'file', displayName: 'synthetic.txt' }),
    deriveSave: async () => ({ handle: String(++next), kind: 'save', displayName: 'synthetic.txt' }),
    pinCommittedSave: async object => ({ handle: String(++next), kind: 'file', displayName: object.displayName }),
    describe: async object => ({ isDirectory: object.kind === 'directory', size: 16, lastModifiedMs: 1000 }),
    list: async () => [], save: unsupported, streamSave: unsupported, copy: unsupported, remove: unsupported, move: unsupported,
    release: async object => { log.push('release:' + object.handle) }, stop: async () => { log.push('adapter-stop') }
  }
  const options: Parameters<typeof createReferenceFileRuntime>[0] = {
    pathAccess: { executable: 'E:/synthetic/broker.exe', dataRoot: 'E:/synthetic/Data', platform: 'win32',
      sealer: { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() } },
    registry, events, authorize: () => true, legacyFiles: {} as FileSystemService,
    dialogProvider: { select: async () => ({ canceled: false, selections: [{ absolutePath: 'E:/synthetic/selected.txt', kind: 'file' }] }) },
    clipboard: { availableFormats: () => [], clear() {}, has: () => false, readText: () => '', writeText() {}, writeImage() {},
      readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(0) }) },
    images: { createFromBuffer: () => { throw new Error('unused image port') },
      createFromDataURL: () => { throw new Error('unused image port') }, createFromBitmap: () => { throw new Error('unused image port') } },
    fileClipboard: { readFiles: async () => [], writeFiles: async () => {} },
    screen: { getSources: unsupported, createFromBitmap: () => { throw new Error('unused screen port') },
      getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => { throw new Error('unused screen port') },
      getAllDisplays: () => [], getDisplayNearestPoint: () => { throw new Error('unused screen port') }, getDisplayMatching: () => { throw new Error('unused screen port') } }
  }
  const dependencies: Parameters<typeof createReferenceFileRuntime>[1] = { createPathRuntime: async input => {
    const grants = new PathGrantService(adapter, Date.now, 50, input.owners)
    return { grants, fileSystem: new AnchoredFileSystemService(grants), recovery: {} as PathWriteRecoveryService,
      stop: async () => { log.push('native-runtime-stop'); await grants.stop(); if (failStop) throw new Error('native stop unconfirmed') } }
  } }
  return { options, dependencies, events, listeners, log, adapter, caller, event: { sender: target, senderFrame: target.mainFrame } }
}

test('reference startup cancellation is top-level and path options cannot shadow it', () => {
  const pathAccess = {} as Parameters<typeof createReferenceFileRuntime>[0]['pathAccess']
  const nestedSignal = new AbortController().signal
  const invalid: typeof pathAccess = {
    ...pathAccess,
    // @ts-expect-error the reference factory owns one shared top-level startup signal
    signal: nestedSignal
  }
  assert.equal(Reflect.has(invalid, 'signal'), true)
})

test('reference runtime composes native grants, producer handlers and endpoint through one owner lifecycle', windowsOnly, async () => {
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const opened = await runtime.endpoint.call(f.event, { messageId: 'open', method: 'window_show_open_dialog', params: {} })
  assert.equal(opened.success, true)
  const reference = (opened.success ? opened.data : undefined) as { references: { grantId: string }[] }
  const read = await runtime.endpoint.call(f.event, { messageId: 'read', method: 'filesystem_read_file', params: { grantId: reference.references[0]!.grantId } })
  assert.deepEqual(read, { messageId: 'read', success: true, data: { success: true, content: 'composed runtime', size: 16 } })
  const stopped = runtime.stop(); assert.equal(runtime.stop(), stopped); await stopped
  assert.equal(f.listeners.size, 1) // Externally owned EventService remains subscribed.
  assert.ok(f.log.includes('native-runtime-stop')); assert.equal(f.log.at(-1), 'adapter-stop')
  assert.equal((await runtime.endpoint.call(f.event, { messageId: 'after', method: 'filesystem_read_file', params: { grantId: reference.references[0]!.grantId } })).success, false)
  f.events.stop(); assert.equal(f.listeners.size, 0)
})

test('write endpoint returns a confirmed read-only artifact receipt and cleans it if caller is lost before delivery', async () => {
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  let saved = Buffer.alloc(0), artifactHandle = '', artifactIndex = 0
  f.adapter.save = async (_object, bytes) => { saved = Buffer.from(bytes); return { status: 'committed', bytesWritten: bytes.length } }
  f.adapter.pinCommittedSave = async object => {
    artifactHandle = 'artifact:' + String(++artifactIndex)
    return { handle: artifactHandle, kind: 'file', displayName: object.displayName }
  }
  f.adapter.describe = async object => ({ isDirectory: object.kind === 'directory', size: object.kind === 'file' ? saved.length : 0, lastModifiedMs: 1 })
  f.adapter.read = async object => object.handle === artifactHandle ? Buffer.from(saved) : Buffer.from('composed runtime')

  try {
    const save = await runtime.grants.create(42, 'E:/synthetic/output.txt', 'save', ['write'])
    const payload = Buffer.from([0, 255, 7])
    const response = await runtime.endpoint.call(f.event, { messageId: 'write-confirmed', method: 'filesystem_write_file',
      params: { saveGrantId: save.grantId, content: payload.toString('base64'), encoding: 'base64', replace: false } })
    assert.equal(response.success, true)
    const data = response.success ? response.data as { status: string; size: number; reference: { grantId: string; kind: string; operations: string[]; fileUrl: string } } : undefined
    assert.equal(data?.status, 'committed'); assert.equal(data?.size, payload.length)
    assert.equal(data?.reference.kind, 'file'); assert.deepEqual(data?.reference.operations, ['read'])
    assert.match(data?.reference.fileUrl ?? '', /^ztools:\/\/file\/[A-Za-z0-9_-]{43}\/synthetic\.txt$/)
    assert.deepEqual(await runtime.grants.read(42, data!.reference.grantId), payload)
    assert.equal((await runtime.grants.describe(42, data!.reference.grantId)).size, payload.length)
    assert.equal(runtime.grants.canLoadResource(data!.reference.fileUrl, 42), true)
    await assert.rejects(runtime.grants.save(42, data!.reference.grantId, Buffer.from('no')), { code: 'PERMISSION_DENIED' })
    await assert.rejects(runtime.grants.read(99, data!.reference.grantId), { code: 'PERMISSION_DENIED' })
    const registry = f.options.registry as unknown as { getSdkApiLane(): number }
    registry.getSdkApiLane = () => 1
    const wrongLane = await runtime.endpoint.call(f.event, { messageId: 'artifact-lane-1', method: 'filesystem_read_file',
      params: { grantId: data!.reference.grantId, encoding: 'base64' } })
    assert.equal(wrongLane.success, false)
    registry.getSdkApiLane = () => 2

    f.adapter.save = async () => { throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'unconfirmed') }
    const uncertain = await runtime.endpoint.call(f.event, { messageId: 'write-unknown', method: 'filesystem_write_file',
      params: { saveGrantId: save.grantId, content: 'uncertain', encoding: 'utf8', replace: true } })
    assert.equal(uncertain.success, true)
    const unknownReceipt = uncertain.success ? uncertain.data as { success: boolean; status: string; code: string } : undefined
    assert.deepEqual(unknownReceipt, { success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })

    const lost = await runtime.grants.create(42, 'E:/synthetic/lost.txt', 'save', ['write'])
    f.adapter.save = async (_object, bytes) => {
      saved = Buffer.from(bytes)
      f.event.sender.mainFrame.url = 'file:///response-lost.html'
      return { status: 'committed', bytesWritten: bytes.length }
    }
    const undelivered = await runtime.endpoint.call(f.event, { messageId: 'write-caller-lost', method: 'filesystem_write_file',
      params: { saveGrantId: lost.grantId, content: 'saved despite lost response', encoding: 'utf8', replace: true } })
    assert.equal(undelivered.success, false)
    if (!undelivered.success) assert.equal(undelivered.error.code, 'FILE_WRITE_OUTCOME_UNKNOWN')
    assert.equal(saved.toString(), 'saved despite lost response', 'response loss must not claim file rollback')
    assert.ok(f.log.includes('release:' + artifactHandle), 'the undelivered read-only artifact grant is released')
  } finally { await runtime.stop(); f.events.stop() }
})

test('reference runtime clipboard monitor starts only for Registry lane 2 subscribers', async () => {
  const f = fixture()
  let formatReads = 0
  f.options.clipboard.availableFormats = () => { formatReads++; return [] }
  const registry = f.options.registry as unknown as { getSdkApiLane(caller: { webContentsId: number }): number }
  registry.getSdkApiLane = caller => caller.webContentsId === 43 ? 1 : 2
  const runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const lane1 = { type: 'plugin' as const, webContentsId: 43, pluginId: 'example', pluginInstanceId: 'legacy' }
  try {
    f.events.subscribe({ key: 'clipboard_change' }, lane1)
    assert.equal(formatReads, 0)
    f.events.subscribe({ key: 'clipboard_change' }, f.caller)
    assert.ok(formatReads > 0)
  } finally { await runtime.stop(); f.events.stop() }
})

test('reference runtime init failure cleans only owned listeners/native objects while preserving stopped event checks', async () => {
  const f = fixture(); f.events.stop()
  await assert.rejects(createReferenceFileRuntime(f.options, f.dependencies), { code: 'FILE_ERROR' })
  assert.equal(f.listeners.size, 0); assert.ok(f.log.includes('native-runtime-stop'))
})

test('reference runtime stop is idempotent and reports failed native cleanup', async () => {
  const f = fixture(true), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const stopped = runtime.stop(); await assert.rejects(stopped, { code: 'FILE_ERROR' })
  assert.equal(runtime.stop(), stopped); assert.equal(f.listeners.size, 1); f.events.stop(); assert.equal(f.listeners.size, 0); assert.equal(f.listeners.size, 0)
})

test('reference runtime still drains requests and native grants after synchronous resource cleanup fails', async () => {
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const original = runtime.resources.stop.bind(runtime.resources)
  runtime.resources.stop = () => { original(); throw new Error('resource cleanup failed') }
  runtime.closeIngress()
  assert.equal((await runtime.endpoint.call(f.event, { messageId: 'closed-before-stop', method: 'window_show_open_dialog', params: {} })).success, false)
  const stopped = runtime.stop()
  await assert.rejects(stopped, { code: 'FILE_ERROR' })
  assert.equal(runtime.stop(), stopped)
  assert.ok(f.log.includes('native-runtime-stop'))
  assert.equal(f.listeners.size, 1)
  const result = await runtime.endpoint.call(f.event, { messageId: 'after-failed-stop', method: 'window_show_open_dialog', params: {} })
  assert.equal(result.success, false)
  f.events.stop()
})

test('closeIngress attempts endpoint, file-resource and clipboard shutdown after synchronous failures', async () => {
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const calls: string[] = []
  let endpointCloses = 0, resourceCloses = 0, clipboardStops = 0
  const closeEndpoint = runtime.endpoint.closeIngress.bind(runtime.endpoint)
  const closeResources = runtime.resources.closeIngress.bind(runtime.resources)
  const stopClipboard = runtime.clipboard.stop.bind(runtime.clipboard)
  let clipboardStopping: Promise<void> | undefined
  runtime.endpoint.closeIngress = () => { endpointCloses += 1; calls.push(endpointCloses === 1 ? 'endpoint' : 'endpoint-retry'); closeEndpoint(); if (endpointCloses === 1) throw new Error('endpoint close failed') }
  runtime.resources.closeIngress = () => { resourceCloses += 1; calls.push(resourceCloses === 1 ? 'resources' : 'resources-retry'); closeResources(); if (resourceCloses === 1) throw new Error('resource close failed') }
  runtime.clipboard.stop = async () => {
    clipboardStops += 1
    calls.push('clipboard')
    clipboardStopping = stopClipboard()
    await clipboardStopping
  }
  let resourceStops = 0
  const stopResources = runtime.resources.stop.bind(runtime.resources)
  runtime.resources.stop = () => { resourceStops++; stopResources() }

  runtime.closeIngress()
  assert.deepEqual(calls, ['endpoint', 'resources', 'clipboard'])
  assert.ok(clipboardStopping)
  await clipboardStopping
  await assert.rejects(runtime.stop(), { code: 'FILE_ERROR' })
  assert.equal(resourceStops, 1)
  assert.equal(clipboardStops, 1)
  assert.deepEqual(calls, ['endpoint', 'resources', 'clipboard', 'endpoint-retry', 'resources-retry'])
  assert.ok(f.log.includes('native-runtime-stop'))
  f.events.stop()
})

test('runtime closeIngress cancels a slow producer before drain, then stop and repeated exits share cleanup', async () => {
  const f = fixture(), bounds = { x: 0, y: 0, width: 32, height: 24 }
  let started!: () => void, finished = false, providerStops = 0
  const producerStarted = new Promise<void>(resolve => { started = resolve })
  f.options.screen.getAllDisplays = () => [{ id: 1, label: 'fixture', bounds, workArea: bounds, scaleFactor: 1, rotation: 0, touchSupport: 'unknown' }]
  f.options.screen.getPrimaryDisplay = () => f.options.screen.getAllDisplays()[0]!
  f.options.regionSelection = {
    select: (_bounds, signal) => new Promise(resolve => {
      started()
      signal.addEventListener('abort', () => setTimeout(() => { finished = true; resolve(undefined) }, 10), { once: true })
    }),
    stop: async () => { assert.equal(finished, true); assert.equal(f.log.includes('native-runtime-stop'), false); providerStops++ }
  }
  const runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const pending = runtime.endpoint.call(f.event, { messageId: 'slow-region', method: 'screen_capture_region', params: {} })
  await producerStarted

  runtime.closeIngress()
  runtime.closeIngress()
  assert.equal((await runtime.endpoint.call(f.event, { messageId: 'after-close', method: 'screen_capture_region', params: {} })).success, false)
  assert.equal((await runtime.endpoint.cancel(f.event, { messageId: 'slow-region', method: 'screen_capture_region', reason: 'cancel' })).success, false)
  const draining = runtime.drain()
  assert.equal(runtime.drain(), draining)
  const stopping = runtime.stop()
  assert.equal(runtime.stop(), stopping)
  await stopping
  assert.equal((await pending).success, false)
  assert.equal(finished, true)
  assert.equal(providerStops, 1)
  assert.ok(f.log.includes('native-runtime-stop'))
  f.events.stop()
})

test('runtime continues producer/cache/native cleanup and rejects when the ingress drain is unconfirmed', async () => {
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  let resourceStops = 0, grantStops = 0
  const originalResourceStop = runtime.resources.stop.bind(runtime.resources)
  const originalGrantStop = runtime.grants.stop.bind(runtime.grants)
  runtime.resources.stop = () => { resourceStops++; return originalResourceStop() }
  runtime.grants.stop = () => { grantStops++; return originalGrantStop() }
  runtime.endpoint.drain = () => Promise.reject(new Error('injected drain timeout'))

  runtime.closeIngress()
  await assert.rejects(runtime.stop(), { code: 'FILE_ERROR' })
  assert.equal(resourceStops, 1)
  assert.equal(grantStops, 1)
  assert.ok(f.log.includes('native-runtime-stop'))
  assert.equal(f.listeners.size, 1) // Runtime listeners are gone; the externally owned EventService remains.
  assert.equal((await runtime.endpoint.call(f.event, { messageId: 'after-failed-drain', method: 'filesystem_read_file', params: {} })).success, false)
  f.events.stop()
})

test('runtime closeIngress immediately aborts file-resource reads and disables the lane-2 clipboard monitor', windowsOnly, async () => {
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  let clipboardReads = 0, readStarted!: () => void, readAborted = false
  const entered = new Promise<void>(resolve => { readStarted = resolve })
  f.options.clipboard.availableFormats = () => { clipboardReads++; return [] }
  f.events.subscribe({ key: 'clipboard_change' }, f.caller)
  assert.ok(clipboardReads > 0)

  try {
    const opened = await runtime.endpoint.call(f.event, {
      messageId: 'open-for-close-ingress', method: 'window_show_open_dialog', params: {}
    })
    assert.equal(opened.success, true)
    const reference = (opened.success ? opened.data : undefined) as { references: { fileUrl: string }[] }
    const fileUrl = reference.references[0]?.fileUrl
    assert.ok(fileUrl)
    f.adapter.readRange = (_object, _segments, _offset, _length, signal) => new Promise<Buffer>((_resolve, reject) => {
      readStarted()
      signal.addEventListener('abort', () => { readAborted = true; reject(new Error('read cancelled')) }, { once: true })
    })
    const requestSignal = new AbortController().signal
    const response = await runtime.resources.respond({
      url: fileUrl, method: 'GET', headers: new Headers(), signal: requestSignal
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const pendingRead = reader.read().catch(() => undefined)
    await entered

    const readsBeforeClose = clipboardReads
    runtime.closeIngress()
    assert.equal(runtime.resources.claimsUrl(fileUrl), false)
    f.events.unsubscribe({ key: 'clipboard_change' }, f.caller)
    f.events.subscribe({ key: 'clipboard_change' }, f.caller)
    assert.equal(clipboardReads, readsBeforeClose)
    await pendingRead
    assert.equal(readAborted, true)
  } finally {
    await runtime.stop()
    f.events.stop()
  }
})

test('reference runtime init cleanup preserves the public failure and releases native ownership when provider stop throws', async () => {
  const f = fixture(); let regionStopped = false
  f.options.pdfRenderer = { render: async () => { throw new Error('unused renderer') }, stop: () => { throw new Error('provider cleanup failed') } }
  f.options.regionSelection = { select: async () => undefined, stop: async () => { regionStopped = true } }
  f.events.stop()
  await assert.rejects(createReferenceFileRuntime(f.options, f.dependencies), { code: 'FILE_ERROR' })
  assert.equal(regionStopped, true)
  assert.ok(f.log.includes('native-runtime-stop'))
  assert.equal(f.listeners.size, 0)
})


test('reference runtime composes optional local OCR through the real reference endpoint and retained owner grant', windowsOnly, async () => {
  const f = fixture(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=', 'base64')
  let request: unknown
  f.options.localOcr = { run: async value => {
    request = value
    return value.operation === 'languages' ? { version: 1, success: true, provider: 'apple-vision-local', revision: 3, languages: ['en-US'] } :
      { version: 1, success: true, provider: 'apple-vision-local', revision: 3, width: 1, height: 1, text: 'OCR', lines: [{ text: 'OCR', confidence: 0.9, box: [0, 0, 1, 1] }] }
  } }
  const create = f.dependencies!.createPathRuntime!
  f.dependencies!.createPathRuntime = async options => { const runtime = await create(options); runtime.grants.read = async () => png; return runtime }
  const runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  try {
    const opened = await runtime.endpoint.call(f.event, { messageId: 'ocr-open', method: 'window_show_open_dialog', params: {} })
    assert.equal(opened.success, true)
    const reference = (opened.success ? opened.data : undefined) as { references: { grantId: string }[] }
    const recognized = await runtime.endpoint.call(f.event, { messageId: 'ocr-local', method: 'ocr_recognize_reference', params: { fileGrantId: reference.references[0]!.grantId, languages: ['en-US'] } })
    assert.equal(recognized.success, true); assert.equal((recognized.success ? recognized.data as { text: string } : undefined)?.text, 'OCR')
    assert.deepEqual(request, { version: 1, operation: 'recognize', imageBase64: png.toString('base64'), languages: ['en-US'] })
  } finally { await runtime.stop(); f.events.stop() }
})

test('reference runtime drains local OCR on stop and missing provider never falls back to DLL/cloud', async () => {
  const f = fixture(); let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  f.options.localOcr = { run: (_value, signal) => new Promise(resolve => {
    started(); signal.addEventListener('abort', () => setTimeout(() => resolve({ version: 1, success: true, provider: 'apple-vision-local', revision: 3, languages: ['en-US'] }), 10), { once: true })
  }) }
  const runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const pending = runtime.endpoint.call(f.event, { messageId: 'ocr-pending', method: 'ocr_local_languages', params: {} }); await entered
  await runtime.stop(); const result = await pending; assert.equal(result.success, false); f.events.stop()
  const absent = fixture(), other = await createReferenceFileRuntime(absent.options, absent.dependencies)
  try { const result = await other.endpoint.call(absent.event, { messageId: 'ocr-absent', method: 'ocr_local_languages', params: {} }); assert.equal(result.success, false); if (!result.success) assert.equal(result.error.code, 'NOT_SUPPORTED') }
  finally { await other.stop(); absent.events.stop() }
})

test('reference runtime composes interactive region selection and returns explicit Esc through its endpoint', async () => {
  const f = fixture(), bounds = { x: -400, y: -100, width: 400, height: 300 }; let stops = 0, selected: unknown
  f.options.screen.getAllDisplays = () => [{ id: 1, label: 'fixture', bounds, workArea: bounds, scaleFactor: 2, rotation: 0, touchSupport: 'unknown' }]
  f.options.screen.getPrimaryDisplay = () => f.options.screen.getAllDisplays()[0]!
  f.options.regionSelection = { select: async value => { selected = value; return undefined }, stop: async () => { stops++ } }
  const runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  try {
    const result = await runtime.endpoint.call(f.event, { messageId: 'region-escape', method: 'screen_capture_region', params: {} })
    assert.deepEqual(result, { messageId: 'region-escape', success: true, data: { success: true, cancelled: true } }); assert.deepEqual(selected, [bounds]); assert.ok(runtime.regionCapture)
  } finally { await runtime.stop(); f.events.stop() }
  assert.equal(stops, 1)
})
test('reference runtime cancels and drains a pending region before stopping the owned native runtime', async () => {
  const f = fixture(), bounds = { x: 0, y: 0, width: 100, height: 100 }; let entered!: () => void, finished = false
  const started = new Promise<void>(resolve => { entered = resolve })
  f.options.screen.getAllDisplays = () => [{ id: 1, label: 'fixture', bounds, workArea: bounds, scaleFactor: 1, rotation: 0, touchSupport: 'unknown' }]
  f.options.screen.getPrimaryDisplay = () => f.options.screen.getAllDisplays()[0]!
  f.options.regionSelection = { select: (_bounds, signal) => new Promise(resolve => { entered(); signal.addEventListener('abort', () => setTimeout(() => { finished = true; resolve(undefined) }, 10), { once: true }) }), stop: async () => { assert.equal(finished, true); assert.equal(f.log.includes('native-runtime-stop'), false) } }
  const runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  const pending = runtime.endpoint.call(f.event, { messageId: 'region-pending', method: 'screen_capture_region', params: {} }); await started
  await runtime.stop(); assert.equal((await pending).success, false); assert.equal(finished, true); assert.ok(f.log.includes('native-runtime-stop')); f.events.stop()
})
test('region provider init cleanup and missing-provider behavior never pretend selection succeeded', async () => {
  const broken = fixture(); let stopped = false; broken.options.regionSelection = { select: async () => undefined, stop: async () => { stopped = true } }; broken.events.stop()
  await assert.rejects(createReferenceFileRuntime(broken.options, broken.dependencies), { code: 'FILE_ERROR' }); assert.equal(stopped, true)
  const f = fixture(), runtime = await createReferenceFileRuntime(f.options, f.dependencies)
  try { const result = await runtime.endpoint.call(f.event, { messageId: 'region-absent', method: 'screen_capture_region', params: {} }); assert.equal(result.success, false); if (!result.success) assert.equal(result.error.code, 'NOT_SUPPORTED') }
  finally { await runtime.stop(); f.events.stop() }
})

test('region and PDF providers remain caller-owned when path runtime acquisition fails', async () => {
  const f = fixture(), stopped: string[] = []
  f.options.regionSelection = { select: async () => undefined, stop: async () => { stopped.push('region') } }
  f.options.pdfRenderer = { render: async () => Buffer.alloc(0), stop: () => { stopped.push('pdf') } }
  f.dependencies.createPathRuntime = async () => { throw new Error('path runtime did not transfer ownership') }

  await assert.rejects(createReferenceFileRuntime(f.options, f.dependencies), { code: 'FILE_ERROR' })
  assert.deepEqual(stopped, [])
  assert.equal(f.listeners.size, 1) // The EventService listener remains externally owned.
  f.events.stop()
  assert.equal(f.listeners.size, 0)
})

test('an aborted reference factory rolls back a path runtime that resolves late and receives the same startup signal', async () => {
  const f = fixture(), startup = new AbortController(), createPathRuntime = f.dependencies.createPathRuntime!
  let entered!: () => void, release!: () => void, passedSignal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.dependencies.createPathRuntime = async input => {
    passedSignal = (input as typeof input & { signal?: AbortSignal }).signal
    const runtime = await createPathRuntime(input)
    entered()
    await gate // Deliberately ignore abort until the fake dependency eventually settles.
    return runtime
  }
  const startupOptions = { ...f.options, signal: startup.signal } as typeof f.options & { signal: AbortSignal }
  const creating = createReferenceFileRuntime(startupOptions, f.dependencies)
  await started
  startup.abort()
  release()
  const outcome = await creating.then(runtime => ({ runtime }), error => ({ error }))
  if ('runtime' in outcome) await outcome.runtime.stop()
  assert.ok('error' in outcome, 'a late path runtime must be rolled back instead of escaping to a stopped bootstrap')
  assert.equal(passedSignal, startup.signal)
  assert.ok(f.log.includes('native-runtime-stop'))
  assert.equal(f.listeners.size, 1) // Only the externally owned EventService remains.
  f.events.stop()
  assert.equal(f.listeners.size, 0)
})

test('a later owner-listener constructor failure removes earlier runtime listeners and its path runtime', async () => {
  const f = fixture(), registry = f.options.registry as unknown as { onRemoved(listener: (owner: number) => void): () => void }
  const original = registry.onRemoved.bind(registry)
  let subscriptions = 0
  registry.onRemoved = listener => {
    subscriptions++
    if (subscriptions === 3) throw new Error('injected ReferenceDirectoryLocations construction failure')
    return original(listener)
  }
  await assert.rejects(createReferenceFileRuntime(f.options, f.dependencies), { code: 'FILE_ERROR' })
  assert.equal(f.listeners.size, 1) // ReferenceCacheRoots and PathGrantService owners were both released.
  assert.ok(f.log.includes('native-runtime-stop'))
  f.events.stop()
  assert.equal(f.listeners.size, 0)
})

test('reference construction rollback continues after synchronous and asynchronous cleanup failures', async () => {
  const f = fixture(), registry = f.options.registry as unknown as { onRemoved(listener: (owner: number) => void): () => void }
  const original = registry.onRemoved.bind(registry)
  let subscriptions = 0
  registry.onRemoved = listener => {
    subscriptions++
    if (subscriptions === 5) throw new Error('injected ReferenceFileDropService construction failure')
    return original(listener)
  }
  const cleanup: string[] = []
  f.options.regionSelection = { select: async () => undefined, stop: async () => { cleanup.push('region'); throw new Error('PRIVATE_REGION_STOP') } }
  f.options.pdfRenderer = { render: async () => Buffer.alloc(0), stop: () => { cleanup.push('pdf'); throw new Error('PRIVATE_PDF_STOP') } }
  await assert.rejects(createReferenceFileRuntime(f.options, f.dependencies), { code: 'FILE_ERROR' })
  assert.deepEqual(cleanup.sort(), ['pdf', 'region'])
  assert.ok(f.log.includes('native-runtime-stop'))
  assert.equal(f.listeners.size, 1)
  f.events.stop()
  assert.equal(f.listeners.size, 0)
})
