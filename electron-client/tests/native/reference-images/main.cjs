const { app, nativeImage, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const [output, compiled, broker] = process.argv.slice(2)
if (!['win32', 'darwin'].includes(process.platform) || ![output, compiled, broker].every(value => value && path.isAbsolute(value))) process.exit(2)
const userData = path.join(output, 'user-data'); fs.mkdirSync(userData)
app.setPath('userData', userData); app.setPath('sessionData', userData); app.setPath('logs', path.join(output, 'logs'))
app.on('window-all-closed', () => {}) // The fixture exits explicitly after native cleanup, not when its test Renderer closes.
require(path.join(compiled, 'src/main/protocol/ztools-protocol.js')).registerZToolsScheme()
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const load = file => import(pathToFileURL(path.join(compiled, 'src/main', file)).href)
  const { createPathAccessRuntime } = await load('platform/path-access-runtime.js')
  const { ClipboardService } = await load('services/clipboard-service.js')
  const { ReferenceClipboardFilesService } = await load('services/reference-clipboard-files-service.js')
  const { createReferenceClipboardHandlers } = await load('ipc/reference-clipboard-handlers.js')
  const { ProcessService } = await load('services/process-service.js')
  const { createPlatformProcessDiscoveryAdapter } = await load('platform/process-discovery.js')
  const processes = new ProcessService({ onRemoved: () => () => {} }, undefined, Date.now, process.platform, createPlatformProcessDiscoveryAdapter(process.platform))
  const { ScreenService } = await load('services/screen-service.js')
  const { createReferenceScreenHandlers } = await load('ipc/reference-screen-handlers.js')
  const { createReferenceProducerHandlers } = await load('ipc/reference-producer-handlers.js')
  const { createReferenceFileHandlers } = await load('ipc/reference-file-handlers.js')
  const { ReferenceDirectoryLocations } = await load('services/reference-directory-locations.js')
  const { ReferenceImageService } = await load('services/reference-image-service.js')
  const { ReferenceZipExtractionService } = await load('services/reference-zip-extraction-service.js')
  const { ReferenceZipCompressionService } = await load('services/reference-zip-compression-service.js')
  const { ReferenceBrowserSnapshotService } = await load('services/reference-browser-snapshot-service.js')
  const { createReferenceBrowserSnapshotHandlers } = await load('ipc/reference-browser-snapshot-handlers.js')
  const { browserSnapshotFixture } = await import(pathToFileURL(path.join(compiled, 'tests/helpers/browser-snapshot-fixture.js')).href)
  const { ReferenceZipService } = await load('services/reference-zip-service.js')
  const { createReferenceZipHandlers } = await load('ipc/reference-zip-handlers.js')
  const { buildZipFixture } = await import(pathToFileURL(path.join(compiled, 'tests/helpers/zip-fixture.js')).href)
  const { ReferenceGifService } = await load('services/reference-gif-service.js')
  const { gifPngFixture } = await import(pathToFileURL(path.join(compiled, 'tests/helpers/gif-fixture.js')).href)
  const { GifReader } = require('omggif')
  const { ReferencePdfService } = await load('services/reference-pdf-service.js')
  const { ElectronReferencePdfRenderer } = await load('platform/electron-reference-pdf-renderer.js')
  const { createReferenceImageHandlers } = await load('ipc/reference-image-handlers.js')
  const { ReferenceIpcEndpoint } = await load('ipc/reference-endpoint.js')
  const { ReferenceRequestTracker } = await load('services/reference-request-tracker.js')
  const dataRoot = path.join(output, 'Data'); fs.mkdirSync(dataRoot)
  const runtime = await createPathAccessRuntime({ executable: broker, dataRoot, platform: process.platform,
    sealer: { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() } })
  const { ReferenceCacheService } = await load('services/reference-cache-service.js')
  const cacheDirectory = path.join(dataRoot, 'Cache'); fs.mkdirSync(cacheDirectory)
  const cacheRoot = await runtime.grants.create(42, cacheDirectory, 'directory', ['read', 'write', 'list'])
  const cache = new ReferenceCacheService(runtime.grants, async () => cacheRoot)
  const images = new ReferenceImageService(runtime.grants, nativeImage, cache)
  const asarWorkerRuntime = compiled.endsWith('.asar')
  if (asarWorkerRuntime) {
    const lookup = require('node:module').createRequire(path.join(compiled, 'package.json'))
    for (const dependency of ['sql.js', 'gifenc', 'pngjs']) assert.ok(lookup.resolve(dependency).startsWith(compiled + path.sep), 'Worker dependency must come from the owned archive')
  }
  let workerArchiveCalls = 0
  const createWorker = (file, options) => {
    if (asarWorkerRuntime) { assert.ok(require('node:url').fileURLToPath(file).startsWith(compiled + path.sep)); workerArchiveCalls++ }
    return new (require('node:worker_threads').Worker)(file, options)
  }
  const gif = new ReferenceGifService(runtime.grants, nativeImage, { createWorker }, cache)
  const pdf = new ReferencePdfService(runtime.grants, nativeImage, new ElectronReferencePdfRenderer())
  const sqlite = new ReferenceBrowserSnapshotService(runtime.grants, { createWorker })
  const zip = new ReferenceZipService(runtime.grants)
  const zipExtraction = new ReferenceZipExtractionService(zip, runtime.grants)
  const zipCompression = new ReferenceZipCompressionService(runtime.grants)
  const requests = new ReferenceRequestTracker({ isActive: owner => owner === 42, onRemoved: () => () => {} })
  const caller = { type: 'main', webContentsId: 42 }, target = { id: 42, isDestroyed: () => false, mainFrame: { url: 'ztools://web/index.html' } }
  const display = { id: 1, label: 'synthetic', bounds: { x: -2, y: 0, width: 2, height: 2 }, workArea: { x: -2, y: 0, width: 2, height: 2 }, scaleFactor: 1, rotation: 0, touchSupport: 'unknown' }
  const screenService = new ScreenService(undefined, { getCursorScreenPoint: () => ({ x: -1, y: 1 }), getPrimaryDisplay: () => display, getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getDisplayMatching: () => display,
    getSources: async () => [{ displayId: '1', image: nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]), { width: 2, height: 2, scaleFactor: 1 }) }], createFromBitmap: (bytes, size) => nativeImage.createFromBitmap(bytes, { ...size, scaleFactor: 1 }) }, undefined, cache)
  const locations = new ReferenceDirectoryLocations(runtime.grants, { isActive: owner => owner === 42, get: () => caller, onRemoved: () => () => {} })
  const memoryClipboard = { text: '', image: nativeImage.createEmpty(), formats: [], availableFormats() { return this.formats }, has() { return false }, readImage() { return this.image }, readText() { return this.text }, writeText(text) { this.text = text; this.image = nativeImage.createEmpty(); this.formats = ['text/plain'] }, writeImage(image) { this.image = image; this.text = ''; this.formats = ['image/png'] }, clear() { this.text = ''; this.image = nativeImage.createEmpty(); this.formats = [] } }
  const selectedClipboardPaths = [], fileClipboard = { readFiles: async () => [...selectedClipboardPaths], writeFiles: async () => { throw new Error('unused') } }
  const referenceClipboardFiles = new ReferenceClipboardFilesService(fileClipboard, runtime.grants)
  const clipboardService = new ClipboardService(undefined, { onSubscriptionChanged: () => () => {} }, memoryClipboard, nativeImage, fileClipboard, 750, referenceClipboardFiles, { cache, grants: runtime.grants })
  const producers = createReferenceProducerHandlers({ screen: screenService, grants: runtime.grants, dialogs: { show: async () => { throw new Error('unused') } }, clipboardFiles: referenceClipboardFiles, clipboard: clipboardService })
  const regionFixture = await require('./region.cjs')({ load, compiled, runtime, cache, requests, caller, target, createReferenceProducerHandlers, ReferenceIpcEndpoint, producerServices: { grants: runtime.grants, dialogs: { show: async () => { throw new Error('unused') } }, clipboardFiles: referenceClipboardFiles, clipboard: clipboardService } })
  const endpoint = new ReferenceIpcEndpoint({ get: owner => owner === 42 ? caller : undefined,
    getWebContents: owner => owner === 42 ? target : undefined, getSdkApiLane: () => 2 }, requests, { ...createReferenceFileHandlers(runtime.fileSystem, cache, locations), ...producers, ...createReferenceClipboardHandlers(clipboardService), ...createReferenceScreenHandlers(screenService), ...createReferenceImageHandlers(images, pdf, gif), ...createReferenceZipHandlers(zip, zipCompression, zipExtraction), ...createReferenceBrowserSnapshotHandlers(sqlite) }, () => true)
  const event = { sender: target, senderFrame: target.mainFrame }; let sequence = 0, checks = 0
  const call = async (method, params) => {
    const result = await endpoint.call(event, { messageId: 'image-' + ++sequence, method, params })
    if (!result.success) { const error = new Error(result.error.message); error.code = result.error.code; throw error }
    return result.data
  }
  try {
    const bitmap = Buffer.from(Array.from({ length: 32 }, (_, index) => index % 4 === 3 ? 255 : index * 7))
    const source = nativeImage.createFromBitmap(bitmap, { width: 4, height: 2, scaleFactor: 1 })
    const inputPath = path.join(dataRoot, 'input.png'); fs.writeFileSync(inputPath, source.toPNG())
    const input = await runtime.grants.create(42, inputPath, 'file', ['read'])
    assert.deepEqual(await call('image_get_info', { fileGrantId: input.grantId }), { success: true, width: 4, height: 2, format: 'png' }); checks++
    const cases = [
      { operation: 'convert', format: 'jpg', quality: 75, expected: [4, 2] },
      { operation: 'resize', format: 'png', width: 2, height: 2, expected: [2, 1] },
      { operation: 'resize', format: 'png', width: 3, height: 3, keepAspectRatio: false, expected: [3, 3] },
      { operation: 'scale', format: 'png', scaleX: 0.5, scaleY: 2, expected: [2, 4] },
      { operation: 'crop', format: 'png', rect: { x: 1, y: 0, width: 2, height: 1 }, expected: [2, 1] },
      { operation: 'rotate', format: 'png', angle: 90, expected: [2, 4] },
      { operation: 'rotate', format: 'png', angle: 45, expected: [5, 5] },
      { operation: 'flip', format: 'png', direction: 'horizontal', expected: [4, 2] },
      { operation: 'flip', format: 'png', direction: 'vertical', expected: [4, 2] },
      { operation: 'compress', format: 'jpg', quality: 50, expected: [4, 2] }
    ]
    for (const [index, item] of cases.entries()) {
      const { expected, ...options } = item, destination = path.join(dataRoot, `output-${index}.${item.format}`)
      const outputRef = await runtime.grants.create(42, destination, 'save', ['write'])
      const receipt = await call('image_transform', { fileGrantId: input.grantId, saveGrantId: outputRef.grantId, ...options })
      assert.equal(receipt.status, 'committed'); assert.deepEqual([receipt.width, receipt.height], expected)
      const saved = await runtime.grants.create(42, destination, 'file', ['read'])
      const bytes = await runtime.grants.read(42, saved.grantId)
      assert.equal(bytes.length, receipt.size)
      const decoded = nativeImage.createFromBuffer(bytes); assert.equal(decoded.isEmpty(), false)
      assert.deepEqual([decoded.getSize().width, decoded.getSize().height], expected)
      assert.equal((await runtime.recovery.list(caller)).length, index) // Fresh successful saves add no unresolved record.
      await assert.rejects(call('image_transform', { fileGrantId: input.grantId, saveGrantId: outputRef.grantId, ...options }), { code: 'FILE_ALREADY_EXISTS' })
      checks += 2
    }
    const { createReferenceTransportBridge } = await import(pathToFileURL(path.join(compiled, 'src/preload/reference-transport.js')).href)
    const bridge = createReferenceTransportBridge({ invoke: (channel, value) => {
      const cloned = JSON.parse(JSON.stringify(value))
      const selectedEndpoint = cloned.method === 'screen_capture_region' ? regionFixture.endpoint : endpoint
      return channel === 'ztools:reference-cancel' ? selectedEndpoint.cancel(event, cloned) : selectedEndpoint.call(event, cloned)
    } }, { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }, true)
    const sdkRoot = path.resolve(__dirname, '../../../../frontend/public/js/cef-ipc/src')
    const sdkSource = ['core/transport.js', 'core/reference-transport.js', 'api/fs.js', 'api/fs-reference.js', 'api/image-reference.js', 'api/image.js', 'api/zip.js', 'api/sqlite-reference.js', 'api/screen.js', 'api/clipboard.js']
      .map(file => fs.readFileSync(path.join(sdkRoot, file), 'utf8').replace(/^export .+$/mg, '')).join('\n')
    const constructors = vm.runInNewContext(sdkSource + '\n({ ReferenceTransport, ImageAPI, ZipAPI, ReferenceSQLiteAPI, ScreenAPI, ClipboardAPI })', {
      window: { __ztoolsElectron: { contractVersion: 2, transport: bridge }, ztools: { dllplugin: { callAsync() { throw new Error('Legacy DLL must not run') } } } },
      environment: { showEnvironmentWarning() {}, getInfo: () => ({}), isElectron: () => true }, MockProvider: class {},
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout, console
    })
    const transport = new constructors.ReferenceTransport(), sdk = new constructors.ImageAPI(transport)
    try {
      const gifInputs = [], gifOutputs = []
      try {
        const gifFrames = [gifPngFixture(2, 2, [255, 0, 0, 255]), gifPngFixture(1, 1, [0, 0, 255, 255]), gifPngFixture(2, 2, [0, 0, 0, 0]), gifPngFixture(2048, 2, [0, 255, 0, 255])]
        for (const [index, bytes] of gifFrames.entries()) {
          const source = path.join(dataRoot, 'gif-frame-' + index + '.png'); fs.writeFileSync(source, bytes)
          gifInputs.push(await runtime.grants.create(42, source, 'file', ['read']))
        }
        const refs = gifInputs.map(grant => runtime.grants.reference(42, grant.grantId))
        for (const [index, sources, options] of [[0, [refs[0], refs[1]], { interval: 250, loop: true }], [1, [refs[2]], { interval: 100, loop: false }], [2, [refs[3]], { interval: 100, loop: false }]]) {
          const destination = path.join(dataRoot, 'actual-animation-' + index + '.gif'), outputGrant = await runtime.grants.create(42, destination, 'save', ['write'])
          gifOutputs.push(outputGrant)
          assert.equal(await sdk.imagesToGIF(sources, runtime.grants.reference(42, outputGrant.grantId), options), true)
          const encoded = fs.readFileSync(destination), decoded = new GifReader(encoded)
          assert.equal(decoded.numFrames(), sources.length); assert.equal(decoded.loopCount(), options.loop ? 0 : null); assert.equal(decoded.frameInfo(0).delay, options.interval / 10)
          const pixels = Buffer.alloc(decoded.width * decoded.height * 4); decoded.decodeAndBlitFrameRGBA(0, pixels)
          if (index === 0) { assert.deepEqual([decoded.width, decoded.height], [2, 2]); assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 255]); decoded.decodeAndBlitFrameRGBA(1, pixels); assert.deepEqual([...pixels.subarray(0, 4)], [0, 0, 255, 255]); assert.deepEqual([...pixels.subarray(4, 8)], [255, 255, 255, 255]) }
          else if (index === 1) assert.deepEqual([...pixels.subarray(0, 4)], [255, 255, 255, 255])
          else { assert.deepEqual([decoded.width, decoded.height], [1024, 1]); assert.deepEqual([...pixels.subarray(0, 4)], [0, 255, 0, 255]) }
          checks++
        }
        const gifPreview = await sdk.previewGIF([refs[0], refs[1]], { interval: 250, loop: true })
        try { const decoded = new GifReader(await runtime.grants.read(42, gifPreview.reference.grantId)); assert.equal(decoded.numFrames(), 2); assert.equal(decoded.loopCount(), 0); assert.equal(gifPreview.fileUrl, 'ztools://file/' + gifPreview.reference.grantId + '/' + encodeURIComponent(gifPreview.reference.displayName)); checks++ }
        finally { await cache.revokeReference(gifPreview.reference, caller) }
        const existing = path.join(dataRoot, 'actual-animation-0.gif'), before = fs.readFileSync(existing)
        await assert.rejects(sdk.imagesToGIF([refs[0]], runtime.grants.reference(42, gifOutputs[0].grantId)), { code: 'FILE_ALREADY_EXISTS' }); assert.deepEqual(fs.readFileSync(existing), before); checks++
      } finally {
        await Promise.all([...gifInputs, ...gifOutputs].map(grant => runtime.grants.revoke(42, grant.grantId)))
      }
      const sqliteSdk = new constructors.ReferenceSQLiteAPI(transport)
      const snapshotBytes = await browserSnapshotFixture(), snapshotPath = path.join(dataRoot, 'browser-snapshot.sqlite')
      fs.writeFileSync(snapshotPath, snapshotBytes)
      const snapshotGrant = await runtime.grants.create(42, snapshotPath, 'file', ['read']), snapshotRef = runtime.grants.reference(42, snapshotGrant.grantId)
      try {
        const chromiumRows = await sqliteSdk.readBrowserSnapshot(snapshotRef, { kind: 'chromium-history', limit: 1 })
        assert.equal(chromiumRows.rows.length, 1); assert.equal(chromiumRows.truncated, true); assert.equal(chromiumRows.rows[0][1], '百分%_!中文'); checks++
        const firefoxRows = await sqliteSdk.readBrowserSnapshot(snapshotRef, { kind: 'firefox-history', keyword: '%_!' })
        assert.equal(firefoxRows.rows.length, 1); assert.equal(firefoxRows.rows[0][2], 1700000000000000); checks++
        const bookmarkRows = await sqliteSdk.readBrowserSnapshot(snapshotRef, { kind: 'firefox-bookmarks' })
        assert.deepEqual(JSON.parse(JSON.stringify(bookmarkRows.rows.map(row => row[2]))), [2, 1, 3]); assert.ok(Object.isFrozen(bookmarkRows.rows)); checks++
        assert.deepEqual(fs.readFileSync(snapshotPath), snapshotBytes)
      } finally { await runtime.grants.revoke(42, snapshotGrant.grantId) }
      const walBytes = Buffer.from(snapshotBytes); walBytes[18] = 2; walBytes[19] = 2
      const walPath = path.join(dataRoot, 'wal-dependent.sqlite'); fs.writeFileSync(walPath, walBytes)
      const walGrant = await runtime.grants.create(42, walPath, 'file', ['read'])
      try { await assert.rejects(sqliteSdk.readBrowserSnapshot(runtime.grants.reference(42, walGrant.grantId), { kind: 'firefox-history' }), { code: 'FILE_ERROR' }); assert.deepEqual(fs.readFileSync(walPath), walBytes); checks++ }
      finally { await runtime.grants.revoke(42, walGrant.grantId) }
      const markClipboard = name => fs.appendFileSync(path.join(output, 'clipboard-progress.log'), name + String.fromCharCode(10))
      markClipboard('begin')
      const clipboardSdk = new constructors.ClipboardAPI(transport, {})
      assert.equal(await clipboardSdk.copyText('synthetic text'), true); assert.equal(await clipboardSdk.readText(), 'synthetic text'); checks++; markClipboard('direct-text')
      const clipboardTextPath = path.join(dataRoot, 'clipboard-text.txt'); fs.writeFileSync(clipboardTextPath, '原生文本引用')
      const clipboardTextRef = await runtime.grants.create(42, clipboardTextPath, 'file', ['read'])
      assert.equal(await clipboardSdk.copyText(runtime.grants.reference(42, clipboardTextRef.grantId)), true); assert.equal(memoryClipboard.text, '原生文本引用'); await runtime.grants.revoke(42, clipboardTextRef.grantId); checks++; markClipboard('reference-text')
      assert.equal(await clipboardSdk.copyImage(runtime.grants.reference(42, input.grantId)), true)
      const directClipboardImage = await clipboardSdk.readImage(); assert.ok(directClipboardImage.startsWith('data:image/png;base64,')); assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(directClipboardImage.split(',')[1], 'base64')).getSize(), { width: 4, height: 2 }); checks++; markClipboard('direct-image')
      memoryClipboard.image = nativeImage.createFromBitmap(require('node:crypto').randomBytes(512 * 512 * 4), { width: 512, height: 512, scaleFactor: 1 }); memoryClipboard.formats = ['image/png']
      markClipboard('large-image-created')
      const clipboardImageRef = await clipboardSdk.readImageReference()
      markClipboard('large-reference-returned')
      assert.equal(clipboardImageRef.type, 'reference'); assert.ok(clipboardImageRef.size > 512 * 1024)
      assert.deepEqual(nativeImage.createFromBuffer(await runtime.grants.read(42, clipboardImageRef.reference.grantId)).getSize(), { width: 512, height: 512 })
      await clipboardImageRef.release(); await clipboardImageRef.release(); checks++; markClipboard('large-reference-released')
      const largeClipboardImage = await clipboardSdk.readImage(); assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(largeClipboardImage.split(',')[1], 'base64')).getSize(), { width: 512, height: 512 }); checks++; markClipboard('large-convenience')
      const clipboardFolder = path.join(dataRoot, 'clipboard-folder'); fs.mkdirSync(clipboardFolder)
      selectedClipboardPaths.push(inputPath, clipboardFolder, path.join(dataRoot, 'clipboard-missing.txt'))
      const detailedFiles = await clipboardSdk.readFilesDetailed()
      assert.deepEqual(JSON.parse(JSON.stringify(detailedFiles.files.map(ref => ref.kind))), ['file', 'directory']); assert.equal(detailedFiles.errors.length, 1)
      for (const ref of detailedFiles.files) await runtime.grants.revoke(42, ref.grantId); checks++; markClipboard('files-detailed')
      const screenSdk = new constructors.ScreenAPI(transport)
      const captured = await screenSdk.captureReference({ x: -2, y: 0, width: 2, height: 2 })
      assert.deepEqual([captured.width, captured.height], [2, 2])
      assert.deepEqual(nativeImage.createFromBuffer(await runtime.grants.read(42, captured.reference.grantId)).getSize(), { width: 2, height: 2 })
      await runtime.grants.revoke(42, captured.reference.grantId); checks++
      const screenshotBase64 = await screenSdk.captureFullScreen()
      assert.ok(screenshotBase64.startsWith('data:image/png;base64,')); assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(screenshotBase64.split(',')[1], 'base64')).getSize(), { width: 2, height: 2 }); checks++
      assert.deepEqual(JSON.parse(JSON.stringify(await screenSdk.getCursorPos())), { x: -1, y: 1 }); assert.equal((await screenSdk.getAllDisplays())[0].id, 1); checks++
      const zipSdk = new constructors.ZipAPI({ call() { throw new Error('Legacy ZIP DLL must not run') } }, transport)
      const archivePath = path.join(dataRoot, 'sample.zip')
      fs.writeFileSync(archivePath, buildZipFixture([{ name: '文档.txt', data: Buffer.from('hello') }], false, true))
      const archiveGrant = await runtime.grants.create(42, archivePath, 'file', ['read']), archiveRef = runtime.grants.reference(42, archiveGrant.grantId)
      const entries = JSON.parse(JSON.stringify(await zipSdk.list(archiveRef)))
      assert.equal(entries.length, 1); assert.equal(entries[0].name, '文档.txt'); assert.equal(entries[0].size, 5); checks++
      assert.equal(await zipSdk.test(archiveRef), true); checks++
      const badArchivePath = path.join(dataRoot, 'bad-crc.zip'); fs.writeFileSync(badArchivePath, buildZipFixture(undefined, true))
      const badArchive = await runtime.grants.create(42, badArchivePath, 'file', ['read'])
      assert.equal(await zipSdk.test(runtime.grants.reference(42, badArchive.grantId)), false); checks++
      const zipAbort = new AbortController(); zipAbort.abort()
      await assert.rejects(zipSdk.test(archiveRef, { signal: zipAbort.signal }), { code: 'CALLER_DESTROYED' }); checks++
      const generatedZipPath = path.join(dataRoot, 'generated.zip'), zipSave = await runtime.grants.create(42, generatedZipPath, 'save', ['write'])
      assert.equal(await zipSdk.compress({ sources: runtime.grants.reference(42, input.grantId), output: runtime.grants.reference(42, zipSave.grantId), level: 6 }), true); checks++
      const generatedZip = await runtime.grants.create(42, generatedZipPath, 'file', ['read']), generatedRef = runtime.grants.reference(42, generatedZip.grantId)
      assert.equal(await zipSdk.test(generatedRef), true)
      assert.equal((await zipSdk.list(generatedRef))[0].name, 'input.png'); checks++
      const extractPath = path.join(dataRoot, 'extracted'), nestedPath = path.join(dataRoot, 'nested.zip')
      fs.mkdirSync(extractPath)
      fs.writeFileSync(nestedPath, buildZipFixture([{ name: '空目录/', data: Buffer.alloc(0) }, { name: 'folder/文档.txt', data: Buffer.from('native extract') }], false, true))
      const nested = await runtime.grants.create(42, nestedPath, 'file', ['read']), extractDirectory = await runtime.grants.create(42, extractPath, 'directory', ['write'])
      const extractRef = runtime.grants.reference(42, extractDirectory.grantId), nestedRef = runtime.grants.reference(42, nested.grantId)
      assert.equal(await zipSdk.extract({ archive: nestedRef, output: extractRef }), true); checks++
      assert.equal(fs.readFileSync(path.join(extractPath, 'folder', '文档.txt'), 'utf8'), 'native extract'); assert.ok(fs.statSync(path.join(extractPath, '空目录')).isDirectory()); checks++
      await assert.rejects(zipSdk.extract({ archive: nestedRef, output: extractRef }), { code: 'FILE_ALREADY_EXISTS' })
      assert.equal(fs.readFileSync(path.join(extractPath, 'folder', '文档.txt'), 'utf8'), 'native extract'); checks++
      await assert.rejects(zipSdk.extract({ archive: runtime.grants.reference(42, badArchive.grantId), output: extractRef }), { code: 'FILE_ERROR' })
      assert.equal(fs.existsSync(path.join(extractPath, '文档.txt')), false); checks++
      const sourceDirectory = await runtime.grants.create(42, extractPath, 'directory', ['read', 'list'])
      const directoryZipPath = path.join(dataRoot, 'directory.zip'), directoryZipSave = await runtime.grants.create(42, directoryZipPath, 'save', ['write'])
      assert.equal(await zipSdk.compress({ sources: runtime.grants.reference(42, sourceDirectory.grantId), output: runtime.grants.reference(42, directoryZipSave.grantId), level: 0 }), true); checks++
      const directoryZip = await runtime.grants.create(42, directoryZipPath, 'file', ['read']), directoryZipRef = runtime.grants.reference(42, directoryZip.grantId)
      assert.equal(await zipSdk.test(directoryZipRef), true)
      assert.ok((await zipSdk.list(directoryZipRef)).some(entry => entry.name === 'extracted/空目录/' && entry.isDirectory)); checks++
      const roundtripPath = path.join(dataRoot, 'roundtrip'); fs.mkdirSync(roundtripPath)
      const roundtrip = await runtime.grants.create(42, roundtripPath, 'directory', ['write'])
      assert.equal(await zipSdk.extract({ archive: directoryZipRef, output: runtime.grants.reference(42, roundtrip.grantId) }), true)
      assert.equal(fs.readFileSync(path.join(roundtripPath, 'extracted', 'folder', '文档.txt'), 'utf8'), 'native extract'); checks++
      for (const ref of [sourceDirectory, directoryZipSave, directoryZip, roundtrip]) await runtime.grants.revoke(42, ref.grantId)
      await runtime.grants.revoke(42, nested.grantId); await runtime.grants.revoke(42, extractDirectory.grantId)
      await runtime.grants.revoke(42, zipSave.grantId); await runtime.grants.revoke(42, generatedZip.grantId)
      await runtime.grants.revoke(42, archiveGrant.grantId); await runtime.grants.revoke(42, badArchive.grantId)
      const publicFile = runtime.grants.reference(42, input.grantId)
      assert.deepEqual(JSON.parse(JSON.stringify(await sdk.getInfo(publicFile))), { width: 4, height: 2, format: 'png' }); checks++
      const encoded = await sdk.imageToBase64(publicFile)
      assert.equal(encoded.mimeType, 'image/png'); assert.equal(typeof encoded.filePath, 'undefined')
      const base64Bytes = await runtime.grants.read(42, encoded.reference.grantId)
      assert.equal(base64Bytes.toString('ascii'), source.toPNG().toString('base64')); checks++
      for (const format of ['png', 'jpg']) {
        const decodedPath = path.join(dataRoot, 'base64-decoded.' + format)
        const decodeSave = await runtime.grants.create(42, decodedPath, 'save', ['write'])
        assert.equal(await sdk.base64ToImage(encoded.reference, decodeSave, format), true)
        const decoded = nativeImage.createFromPath(decodedPath)
        assert.deepEqual(decoded.getSize(), { width: 4, height: 2 })
        if (format === 'png') assert.deepEqual(decoded.toBitmap(), source.toBitmap())
        checks++
      }
      const textPath = path.join(dataRoot, 'data-uri.txt')
      fs.writeFileSync(textPath, 'data:image/png;base64,' + source.toPNG().toString('base64').replace(/(.{20})/g, '$1\n'))
      const textRef = await runtime.grants.create(42, textPath, 'file', ['read'])
      const dataSave = await runtime.grants.create(42, path.join(dataRoot, 'data-uri.png'), 'save', ['write'])
      assert.equal(await sdk.base64ToImage(textRef, dataSave, 'png'), true); checks++
      const badTextPath = path.join(dataRoot, 'bad-base64.txt'); fs.writeFileSync(badTextPath, 'not!base64')
      const badTextRef = await runtime.grants.create(42, badTextPath, 'file', ['read'])
      const badSave = await runtime.grants.create(42, path.join(dataRoot, 'bad-result.png'), 'save', ['write'])
      await assert.rejects(sdk.base64ToImage(badTextRef, badSave, 'png'), { code: 'INVALID_REQUEST' })
      assert.equal(fs.existsSync(path.join(dataRoot, 'bad-result.png')), false); checks++
      const preview = await sdk.preview(publicFile, 'rotate', { angle: 90 }, { format: 'png' })
      assert.deepEqual([preview.width, preview.height], [2, 4])
      assert.equal(preview.reference.kind, 'file'); assert.deepEqual([...preview.reference.operations], ['read'])
      const previewBytes = await runtime.grants.read(42, preview.reference.grantId)
      assert.deepEqual(nativeImage.createFromBuffer(previewBytes).getSize(), { width: 2, height: 4 }); checks++
      const resizedPreview = await sdk.preview(publicFile, 'resize', { width: 2, height: 2, keepAspectRatio: true })
      assert.deepEqual([resizedPreview.width, resizedPreview.height], [2, 1]); checks++
      const jpegPath = path.join(dataRoot, 'pdf-source.jpg'); fs.writeFileSync(jpegPath, source.toJPEG(85))
      const jpeg = await runtime.grants.create(42, jpegPath, 'file', ['read'])
      const pdfPath = path.join(dataRoot, 'images.pdf'), pdfSave = await runtime.grants.create(42, pdfPath, 'save', ['write'])
      assert.equal(await sdk.imagesToPDF([publicFile, jpeg], pdfSave), true)
      const pdfBytes = fs.readFileSync(pdfPath)
      assert.equal(pdfBytes.toString('ascii', 0, 5), '%PDF-'); assert.ok(pdfBytes.toString('latin1').includes('%%EOF'))
      assert.equal((pdfBytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 2); checks++
      const cancelledPdfPath = path.join(dataRoot, 'cancelled-images.pdf'), cancelledPdfSave = await runtime.grants.create(42, cancelledPdfPath, 'save', ['write'])
      const pdfCancellation = new AbortController(); pdfCancellation.abort()
      await assert.rejects(sdk.imagesToPDF([publicFile], cancelledPdfSave, { signal: pdfCancellation.signal }))
      assert.equal(fs.existsSync(cancelledPdfPath), false); checks++
      const publicSave = await runtime.grants.create(42, path.join(dataRoot, 'public-resize.png'), 'save', ['write'])
      assert.equal(await sdk.resize(publicFile, publicSave, 2, 2), true)
      assert.deepEqual(nativeImage.createFromPath(path.join(dataRoot, 'public-resize.png')).getSize(), { width: 2, height: 1 }); checks++
      const flipPath = path.join(dataRoot, 'public-flip.png'), flipSave = await runtime.grants.create(42, flipPath, 'save', ['write'])
      assert.equal(await sdk.flip(publicFile, flipSave, 'vertical'), true)
      const flipped = nativeImage.createFromPath(flipPath).toBitmap(), original = source.toBitmap()
      assert.deepEqual(flipped, Buffer.concat([original.subarray(16, 32), original.subarray(0, 16)])); checks++
      checks += await regionFixture.run(new constructors.ScreenAPI(transport))
    } finally { transport.destroy() }
    // Execute the maintained pure canvas renderer in an actual sandboxed Electron Renderer.
    const canvasTrace = message => fs.appendFileSync(path.join(output, 'canvas-progress.log'), message + '\n')
    canvasTrace('prepare-renderer')
    const ts = require('typescript')
    const canvasSource = fs.readFileSync(path.resolve(__dirname, '../../../../plugins/create-plugin/src/plugins/image-tool/utils/canvasEffects.ts'), 'utf8')
    const canvasCode = ts.transpileModule(canvasSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /mg, '')
    const canvasWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'reference-canvas-' + path.basename(output) } })
    try {
      canvasTrace('load-renderer')
      await canvasWindow.loadURL('data:text/html;charset=utf-8,<html><body>isolated image canvas fixture</body></html>')
      canvasTrace('renderer-loaded')
      const whiteBytes = nativeImage.createFromBitmap(Buffer.alloc(128 * 64 * 4, 255), { width: 128, height: 64, scaleFactor: 1 }).toPNG()
      const effects = [
        { operation: 'border', width: 2, padding: 1, color: '#ff0000', background: '#0000ff', opacity: 1 },
        { operation: 'border', width: 2, padding: 1, color: '#ff0000', background: '#0000ff', opacity: 0.5 },
        { operation: 'round', radii: [16, 16, 16, 16] },
        { operation: 'watermark', text: 'A', fontSize: 32, color: '#000000', position: 'center' }
      ]
      for (const [index, effect] of effects.entries()) {
        canvasTrace('effect-' + index)
        const rendered = await canvasWindow.webContents.executeJavaScript(`(async () => {
          ${canvasCode}
          const result = await renderCanvasEffect(new Uint8Array(${JSON.stringify([...whiteBytes])}).buffer, ${JSON.stringify(effect)}, new AbortController().signal)
          const bitmap = await createImageBitmap(new Blob([result.bytes])); const canvas = new OffscreenCanvas(result.width, result.height), context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0); bitmap.close()
          const pixels = context.getImageData(0, 0, result.width, result.height).data
          return { bytes: Array.from(result.bytes), width: result.width, height: result.height,
            corner: Array.from(pixels.slice(0, 4)), padding: Array.from(pixels.slice((2 * result.width + 2) * 4, (2 * result.width + 2) * 4 + 4)),
            darkPixels: Array.from(pixels).filter((value, position) => position % 4 !== 3 && value < 200).length }
        })()`)
        if (effect.operation === 'border') {
          assert.deepEqual([rendered.width, rendered.height], [134, 70]); assert.deepEqual(rendered.padding, [0, 0, 255, 255])
          if (effect.opacity === 1) assert.deepEqual(rendered.corner, [255, 0, 0, 255])
          else { assert.ok(Math.abs(rendered.corner[0] - 128) <= 1); assert.ok(Math.abs(rendered.corner[2] - 127) <= 1); assert.equal(rendered.corner[3], 255) }
        } else if (effect.operation === 'round') { assert.deepEqual([rendered.width, rendered.height], [128, 64]); assert.equal(rendered.corner[3], 0) }
        else { assert.deepEqual([rendered.width, rendered.height], [128, 64]); assert.ok(rendered.darkPixels > 0) }
        const cached = await cache.writeGeneratedCacheFile(Buffer.from(rendered.bytes), caller, 'png', new AbortController().signal)
        const destination = path.join(dataRoot, 'canvas-' + index + '.png'), save = await runtime.grants.create(42, destination, 'save', ['write'])
        const receipt = await runtime.grants.save(42, save.grantId, await runtime.grants.read(42, cached.reference.grantId), false)
        assert.equal(receipt.status, 'committed')
        assert.deepEqual(nativeImage.createFromPath(destination).getSize(), { width: rendered.width, height: rendered.height })
        await cache.revokeReference(cached.reference, caller); await runtime.grants.revoke(42, save.grantId); checks++
      }
      for (const [direction, expected] of [['vertical', [128, 194]], ['horizontal', [752, 128]], ['grid', [128, 68]]]) {
        canvasTrace('merge-' + direction)
        const rendered = await canvasWindow.webContents.executeJavaScript(`(async () => {
          ${canvasCode}
          const bytes = new Uint8Array(${JSON.stringify([...whiteBytes])}).buffer
          const result = await renderCanvasMerge([{ width: 128, height: 64 }, { width: 128, height: 64 }, { width: 128, height: 64 }],
            { direction: ${JSON.stringify(direction)}, canvasSize: 128, columns: 2, spacing: 2, background: '#000000' }, async () => bytes, new AbortController().signal)
          const bitmap = await createImageBitmap(new Blob([result.bytes])); const canvas = new OffscreenCanvas(result.width, result.height), context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0); bitmap.close()
          return { bytes: Array.from(result.bytes), width: result.width, height: result.height,
            corner: Array.from(context.getImageData(0, 0, 1, 1).data), firstImage: Array.from(context.getImageData(3, 3, 1, 1).data) }
        })()`)
        assert.deepEqual([rendered.width, rendered.height], expected); assert.deepEqual(rendered.corner, [0, 0, 0, 255]); assert.deepEqual(rendered.firstImage, [255, 255, 255, 255])
        const cached = await cache.writeGeneratedCacheFile(Buffer.from(rendered.bytes), caller, 'png', new AbortController().signal)
        const destination = path.join(dataRoot, 'merge-' + direction + '.png'), save = await runtime.grants.create(42, destination, 'save', ['write'])
        assert.equal((await runtime.grants.save(42, save.grantId, await runtime.grants.read(42, cached.reference.grantId), false)).status, 'committed')
        assert.deepEqual(nativeImage.createFromPath(destination).getSize(), { width: expected[0], height: expected[1] })
        await cache.revokeReference(cached.reference, caller); await runtime.grants.revoke(42, save.grantId); checks++
      }
    } finally { canvasWindow.destroy() }
    const processSource = fs.readFileSync(path.resolve(__dirname, '../../../../frontend/public/js/cef-ipc/src/api/process.js'), 'utf8').replace(/^export .+$/mg, '')
    const ProcessAPI = vm.runInNewContext(processSource + String.fromCharCode(10) + 'ProcessAPI', { window: {}, console })
    const processApi = new ProcessAPI({ call: async (method, params) => { assert.equal(Object.keys(params).length, 0); if (method === 'process_list_ports') return processes.listPorts(AbortSignal.timeout(15000)); assert.equal(method, 'process_list'); return processes.list(AbortSignal.timeout(15000)) } })
    const processRows = await processApi.list()
    assert.ok(processRows.length > 0 && processRows.length <= 10000)
    assert.ok(processRows.some(row => row.pid === process.pid), 'Real OS list must contain this owned Electron process')
    assert.ok(processRows.every(row => Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.name === 'string' && typeof row.fieldAvailability.cpuUsage === 'boolean' && typeof row.fieldAvailability.memoryUsage === 'boolean'))
    checks++
    const cancelledList = new AbortController(); cancelledList.abort()
    await assert.rejects(processes.list(cancelledList.signal)); checks++
    const tcp = require('node:net').createServer(), udp = require('node:dgram').createSocket('udp4')
    try {
      await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve) })
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve) })
      const ports = await processApi.listPorts()
      assert.equal(ports.source, process.platform === 'darwin' ? 'darwin-lsof' : 'windows-netstat'); assert.equal(ports.visibility, 'visible-processes')
      for (const [protocol, port] of [['TCP', tcp.address().port], ['UDP', udp.address().port]]) assert.ok(ports.connections.some(row => row.pid === process.pid && row.protocol === protocol && row.localPort === port), 'Actual OS port list must include both owned loopback sockets')
      checks++
      const cancelledPorts = new AbortController(); cancelledPorts.abort(); await assert.rejects(processes.listPorts(cancelledPorts.signal)); checks++
    } finally {
      if (tcp.listening) await new Promise(resolve => tcp.close(resolve))
      await new Promise(resolve => udp.close(resolve))
    }
    const { SystemService } = await load('services/system-service.js')
    const system = new SystemService({}, { onRemoved: () => () => {} }, { getProductVersion: () => process.getSystemVersion() }, process.platform)
    try {
      const systemSource = fs.readFileSync(path.resolve(__dirname, '../../../../frontend/public/js/cef-ipc/src/api/sys.js'), 'utf8').replace(/^export .+$/mg, '')
      const SystemAPI = vm.runInNewContext(systemSource + '\nSystemAPI', {})
      const systemApi = new SystemAPI({ call: async (method, params) => {
        assert.equal(Object.keys(params).length, 0)
        switch (method) {
          case 'system_get_hardware_summary': return system.getHardwareSummary()
          case 'system_get_cpu_usage': return system.getCpuUsage()
          case 'system_get_memory_usage': return system.getMemoryUsage()
          case 'system_get_disk_usage': return system.getDiskUsage({})
          default: throw new Error('UNEXPECTED_SYSTEM_METHOD')
        }
      } })
      const hardware = await systemApi.getHardwareSummary()
      assert.equal(hardware.platform, process.platform === 'darwin' ? 'macos' : 'windows'); assert.equal(hardware.processArch, process.arch); assert.equal(hardware.logicalCpuCount, require('node:os').cpus().length); assert.equal(hardware.totalMemory, require('node:os').totalmem()); assert.ok(hardware.totalMemory > 0); assert.equal('osArch' in hardware, false); checks++
      const [cpuUsage, memoryUsage, diskUsage] = await Promise.all([systemApi.getCPUUsage(), systemApi.getMemoryUsage(), systemApi.getDiskUsage()])
      assert.ok(cpuUsage.data.total >= 0 && cpuUsage.data.total <= 100); assert.equal(memoryUsage.data.used + memoryUsage.data.available, memoryUsage.data.total); assert.equal(diskUsage.data.used + diskUsage.data.free, diskUsage.data.total); assert.ok(diskUsage.data.total > 0); checks++
    } finally { system.stop() }
    const refusedWrites = await runtime.recovery.list(caller)
    assert.equal(refusedWrites.length, cases.length + 2); // ZIP extraction and GIF output also attempt refused overwrites.
    assert.ok(refusedWrites.every(record => record.phase === 'unknown')); checks++ // Existing conservative ledger retains failed-attempt evidence.
    const corrupt = path.join(dataRoot, 'corrupt.png'); fs.writeFileSync(corrupt, Buffer.from('invalid'))
    const bad = await runtime.grants.create(42, corrupt, 'file', ['read'])
    await assert.rejects(call('image_get_info', { fileGrantId: bad.grantId }), { code: 'FILE_ERROR' }); checks++
    if (asarWorkerRuntime) assert.ok(workerArchiveCalls >= 8, 'GIF/SQLite workers must actually launch from ASAR')
    const observed = { status: 'PASS', asarWorkerRuntime, scope: process.platform === 'darwin' ? 'macos-isolated-electron-reference-image-functions' : 'windows-isolated-electron-reference-image-functions', checks,
      electronVersion: process.versions.electron, processArch: process.arch, realElectronCodec: true, realElectronCanvas: true, realElectronPdf: true, realZipProvider: true, realSQLiteSnapshotProvider: true, realGifEncoder: true, realRegionSelectorRenderer: true, regionWindowPolicy: 'injected-hidden-windows', realNativeGrantIo: true, realOsProcessList: true, realOsPortList: true, realOsHardwareSummary: true, realOsSystemSampling: true, processListSource: process.platform === 'darwin' ? 'darwin-ps' : 'windows-tasklist', screenCaptureSource: 'synthetic', clipboardSource: 'synthetic', productionZToolsAcceptance: false }
    fs.writeFileSync(path.join(output, 'observed.json'), JSON.stringify(observed) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(observed))
  } finally { await regionFixture.stop(); processes.stop(); await gif.stop(); await sqlite.stop(); clipboardService.stop(); locations.stop(); zipExtraction.stop(); zipCompression.stop(); zip.stop(); images.stop(); pdf.stop(); await requests.stop(); await runtime.stop() }
  app.exit(0)
}).catch(error => { console.error('REFERENCE_IMAGE_FUNCTION_TEST_FAILED', error.stack); app.exit(1) })
