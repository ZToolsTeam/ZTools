import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { ClipboardAdapter, ClipboardImageFactory } from '../../src/main/services/clipboard-service.js'
import type { ReferenceImageFactory } from '../../src/main/services/reference-image-service.js'
import type { ReferenceFileResources } from '../../src/main/protocol/reference-file-resources.js'
import type { EventService } from '../../src/main/services/event-service.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { createAndAttachElectronReferenceRuntime, type ElectronReferenceRuntimeOptions } from '../../src/main/platform/electron-reference-runtime.js'
import { createReferenceFileRuntime } from '../../src/main/platform/reference-file-runtime.js'
import type { ScreenClipboardAdapters } from '../../src/main/platform/screen-clipboard.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import { canCallReferenceMethod } from '../../src/contracts/reference-capabilities.js'
import type { ReferenceRuntimeAttachment } from '../../src/main/ipc/router.js'

type Runtime = Awaited<ReturnType<typeof createReferenceFileRuntime>>
type RuntimeOptions = Parameters<typeof createReferenceFileRuntime>[0]

function runtimeFixture() {
  const resources = {} as ReferenceFileResources
  let stopCalls = 0
  const runtime = {
    endpoint: { call: async () => ({}), cancel: async () => ({}), acceptDrop: async () => ({}) },
    resources,
    closeIngress() {},
    drain: async () => {},
    stop: async () => { stopCalls++ }
  } as unknown as Runtime
  return { runtime, resources, stopCalls: () => stopCalls }
}

function fixture(platform: NodeJS.Platform = 'win32') {
  const controller = new AbortController()
  const attached: ReferenceRuntimeAttachment[] = []
  const image = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(0) }
  const clipboard: ClipboardAdapter = {
    availableFormats: () => [], clear() {}, has: () => false,
    readImage: () => image, readText: () => '', writeImage() {}, writeText() {}
  }
  const images = {
    createFromBuffer: () => image,
    createFromDataURL: () => image,
    createFromBitmap: () => image
  } as unknown as ClipboardImageFactory & ReferenceImageFactory
  const screenClipboard = {
    screen: {}, screenCaptureFallback: {},
    fileClipboard: { isAvailable: () => true, readFiles: async () => [], writeFiles: async () => {} }
  } as unknown as ScreenClipboardAdapters
  const router = {
    attachReferenceRuntime(runtime: ReferenceRuntimeAttachment) { attached.push(runtime) },
    fileService: {} as FileSystemService,
    eventService: {} as EventService
  } as unknown as ElectronReferenceRuntimeOptions['router']
  const options: ElectronReferenceRuntimeOptions = {
    platform,
    isPackaged: false,
    appPath: platform === 'darwin' ? '/app/ZTools.app/Contents/Resources/app' : 'C:\\app',
    resourcesPath: platform === 'darwin' ? '/app/ZTools.app/Contents/Resources' : 'C:\\resources',
    dataRoot: platform === 'darwin' ? '/Users/test/Library/Application Support/ZTools/Data' : 'C:\\Users\\test\\Data',
    signal: controller.signal,
    router,
    registry: {} as WindowRegistry,
    screenClipboard,
    clipboard,
    images
  }
  return { options, controller, attached }
}

function availableBroker(platform: 'win32' | 'darwin' = 'win32') {
  return platform === 'win32'
    ? { available: true as const, executable: 'C:\\app\\out\\native\\win32-x64\\bin\\ZToolsPathAccessBroker.exe', platform, arch: 'x64' as const }
    : { available: true as const, executable: '/app/out/native/darwin-universal/path-access/native/ZToolsPathAccessBroker', platform, arch: 'universal' as const }
}

function baseDependencies(runtime: Runtime) {
  return {
    resolveBroker: () => availableBroker(),
    isJournalEncryptionAvailable: async () => true,
    createPdfRenderer: () => ({ render: async () => Buffer.alloc(0), stop() {} }),
    createReferenceRuntime: async () => runtime,
    cleanupTimeoutMs: 50,
    runtimeInitializationTimeoutMs: 50,
    journalPreflightTimeoutMs: 50
  }
}

test('missing helper or unavailable/timed-out journal encryption keeps the app usable without a runtime', async () => {
  const missing = fixture(), noRuntime = runtimeFixture()
  let preflights = 0, creations = 0
  const unavailable = await createAndAttachElectronReferenceRuntime(missing.options, {
    resolveBroker: () => ({ available: false, reason: 'not-found' }),
    isJournalEncryptionAvailable: async () => { preflights++; return true },
    createReferenceRuntime: async () => { creations++; return noRuntime.runtime }
  })
  assert.deepEqual(unavailable, { available: false, reason: 'not-found' })
  assert.equal(preflights, 0)
  assert.equal(creations, 0)
  assert.equal(missing.attached.length, 0)

  const noEncryption = fixture(), second = runtimeFixture()
  const denied = await createAndAttachElectronReferenceRuntime(noEncryption.options, {
    ...baseDependencies(second.runtime),
    isJournalEncryptionAvailable: async () => false,
    createReferenceRuntime: async () => { creations++; return second.runtime }
  })
  assert.deepEqual(denied, { available: false, reason: 'journal-sealer-unavailable' })
  assert.equal(creations, 0)
  assert.equal(noEncryption.attached.length, 0)

  const timeoutFixture = fixture(), third = runtimeFixture()
  let resolvePreflight!: (available: boolean) => void
  const timedOut = await createAndAttachElectronReferenceRuntime(timeoutFixture.options, {
    ...baseDependencies(third.runtime),
    journalPreflightTimeoutMs: 5,
    isJournalEncryptionAvailable: () => new Promise(resolve => { resolvePreflight = resolve }),
    createReferenceRuntime: async () => { creations++; return third.runtime }
  })
  assert.deepEqual(timedOut, { available: false, reason: 'journal-sealer-timeout' })
  assert.equal(creations, 0)
  assert.equal(timeoutFixture.attached.length, 0)
  resolvePreflight(true)
})

test('ready composition attaches exactly one runtime with the resolved helper and explicit reference authorization', async () => {
  const f = fixture(), owned = runtimeFixture()
  let received: RuntimeOptions | undefined
  const result = await createAndAttachElectronReferenceRuntime(f.options, {
    ...baseDependencies(owned.runtime),
    createReferenceRuntime: async options => { received = options; return owned.runtime }
  })

  assert.equal(result.available, true)
  if (!result.available) return
  assert.equal(result.runtime, owned.runtime)
  assert.equal(result.resources, owned.resources)
  assert.deepEqual(f.attached, [owned.runtime])
  assert.equal(received?.pathAccess.executable, availableBroker().executable)
  assert.equal(received?.pathAccess.dataRoot, f.options.dataRoot)
  assert.equal(received?.authorize, canCallReferenceMethod)
  assert.equal(received?.authorize('filesystem_list_write_recovery', { type: 'plugin', webContentsId: 9, pluginId: 'test', pluginInstanceId: 'one' }), false)
  assert.equal(received?.authorize('filesystem_read_file', { type: 'main', webContentsId: 9 }), true)
  assert.ok(result.unavailableOptionalProviders.includes('local-vision-ocr'))
})

test('cancellation bounds startup cleanup and stops a runtime that resolves after the caller returned', async () => {
  const f = fixture(), owned = runtimeFixture()
  let finish!: (value: Runtime) => void
  let receivedSignal: AbortSignal | undefined
  const creating = createAndAttachElectronReferenceRuntime(f.options, {
    ...baseDependencies(owned.runtime),
    runtimeInitializationTimeoutMs: 1000,
    cleanupTimeoutMs: 10,
    createReferenceRuntime: options => {
      receivedSignal = options.signal
      return new Promise(resolve => { finish = resolve })
    }
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  f.controller.abort()
  const result = await creating
  assert.deepEqual(result, { available: false, reason: 'cleanup-unconfirmed' })
  assert.equal(receivedSignal?.aborted, true)
  assert.equal(owned.stopCalls(), 0)

  finish(owned.runtime)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(owned.stopCalls(), 1)
  assert.equal(f.attached.length, 0)
})

test('a late runtime whose stop rejects is reported as cleanup-unconfirmed', async () => {
  const f = fixture(), owned = runtimeFixture()
  let finish!: (value: Runtime) => void, stopAttempts = 0
  owned.runtime.stop = async () => { stopAttempts++; throw new Error('late cleanup failed') }
  const creating = createAndAttachElectronReferenceRuntime(f.options, {
    ...baseDependencies(owned.runtime),
    cleanupTimeoutMs: 100,
    createReferenceRuntime: () => new Promise(resolve => { finish = resolve })
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  f.controller.abort()
  setTimeout(() => finish(owned.runtime), 0)
  const result = await creating
  assert.deepEqual(result, { available: false, reason: 'cleanup-unconfirmed' })
  assert.equal(stopAttempts, 1)
  assert.equal(f.attached.length, 0)
})

test('factory failure cleans every still-caller-owned provider and reports an unconfirmed cleanup', async () => {
  const f = fixture('darwin'), stopped: string[] = []
  const options = { ...f.options, regionPreloadPath: path.resolve(process.cwd(), 'src/preload/main.ts') }
  const result = await createAndAttachElectronReferenceRuntime(options, {
    ...baseDependencies(runtimeFixture().runtime),
    resolveBroker: () => availableBroker('darwin'),
    createRegionSelection: () => ({ select: async () => undefined, stop: async () => { stopped.push('region') } }),
    createPdfRenderer: () => ({ render: async () => Buffer.alloc(0), stop: () => { stopped.push('pdf'); throw new Error('injected cleanup failure') } }),
    createReferenceRuntime: async () => { throw new Error('runtime factory rejected') }
  })
  assert.deepEqual(result, { available: false, reason: 'cleanup-unconfirmed' })
  assert.deepEqual(stopped.sort(), ['pdf', 'region'])
  assert.equal(f.attached.length, 0)
})

test('runtime initialization timeout aborts its private signal and retains late runtime cleanup ownership', async () => {
  const f = fixture(), owned = runtimeFixture()
  let finish!: (value: Runtime) => void
  let receivedSignal: AbortSignal | undefined
  const result = await createAndAttachElectronReferenceRuntime(f.options, {
    ...baseDependencies(owned.runtime),
    runtimeInitializationTimeoutMs: 5,
    cleanupTimeoutMs: 10,
    createReferenceRuntime: options => {
      receivedSignal = options.signal
      return new Promise(resolve => { finish = resolve })
    }
  })
  assert.deepEqual(result, { available: false, reason: 'cleanup-unconfirmed' })
  assert.equal(receivedSignal?.aborted, true)
  finish(owned.runtime)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(owned.stopCalls(), 1)
  assert.equal(f.attached.length, 0)
})
