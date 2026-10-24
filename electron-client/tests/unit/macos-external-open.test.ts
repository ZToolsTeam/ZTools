import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateMacosOpenFilePath,
  validateMacosOpenUrl,
  MACOS_EXTERNAL_OPEN_LIMITS
} from '../../src/contracts/external-open.js'
import {
  installMacosExternalOpenListeners,
  MacosExternalOpenCoordinator,
  type MacosExternalOpenAppEvents
} from '../../src/main/platform/macos/external-open.js'

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

test('validates absolute OS file paths without rewriting spaces, Unicode, or read-only bundle locations', () => {
  const filePath = '/Volumes/ZTools Installer/ZTools.app/Contents/Resources/Manual/使用指南.pdf'
  assert.deepEqual(validateMacosOpenFilePath(filePath), { valid: true, value: filePath })
  assert.deepEqual(validateMacosOpenFilePath('/Users/test/中文 文件.txt'), { valid: true, value: '/Users/test/中文 文件.txt' })
  assert.equal(validateMacosOpenFilePath('/Users/test/../private').valid, false)
  assert.equal(validateMacosOpenFilePath('/Users/test/./file').valid, false)
  assert.equal(validateMacosOpenFilePath('/Users//test/file').valid, false)
  assert.equal(validateMacosOpenFilePath('relative.txt').valid, false)
  assert.equal(validateMacosOpenFilePath('file:///Users/test/file.txt').valid, false)
  assert.equal(validateMacosOpenFilePath('/Users/test/\0file').valid, false)
  assert.deepEqual(validateMacosOpenFilePath(`/${'x'.repeat(MACOS_EXTERNAL_OPEN_LIMITS.maxFilePathBytes)}`), {
    valid: false,
    reason: 'file-path-too-long'
  })
})

test('accepts only the exact ztools plugin-open URL grammar', () => {
  assert.deepEqual(validateMacosOpenUrl('ztools://open/calculator'), {
    valid: true,
    value: { kind: 'plugin-open', pluginId: 'calculator' }
  })
  assert.deepEqual(validateMacosOpenUrl('ztools://open/File_Compare.v2'), {
    valid: true,
    value: { kind: 'plugin-open', pluginId: 'File_Compare.v2' }
  })
  for (const url of [
    'https://example.test/',
    'javascript:alert(1)',
    'ztools://web/index.html',
    'ztools://open/calculator?path=/private/file',
    'ztools://open/calculator#payload',
    'ztools://open/calculator/extra',
    'ztools://open/%63alculator',
    'ztools://user@open/calculator',
    'ztools://open:443/calculator',
    'ztools://open/CON',
    'ztools://open/..'
  ]) assert.equal(validateMacosOpenUrl(url).valid, false, url)
  assert.deepEqual(validateMacosOpenUrl('https://example.test/'), { valid: false, reason: 'unsupported-url' })
})

test('captures startup file and approved URL events before ready, coalesces duplicates, then delivers each once', async () => {
  const delivered: unknown[] = []
  const coordinator = new MacosExternalOpenCoordinator({ handle: request => { delivered.push(request) } })

  assert.deepEqual(coordinator.captureFile('/Users/test/待处理 文件.pdf'), { status: 'queued' })
  assert.deepEqual(coordinator.captureFile('/Users/test/待处理 文件.pdf'), { status: 'duplicate' })
  assert.deepEqual(coordinator.captureUrl('ztools://open/calculator'), { status: 'queued' })
  assert.deepEqual(coordinator.captureUrl('ztools://open/CALCULATOR'), { status: 'duplicate' })
  assert.deepEqual(coordinator.captureUrl('ztools://web/index.html'), { status: 'rejected', reason: 'invalid-url' })
  assert.deepEqual(delivered, [])

  coordinator.markReady()
  coordinator.markReady()
  await coordinator.whenIdle()
  assert.deepEqual(delivered, [
    { kind: 'file', filePath: '/Users/test/待处理 文件.pdf' },
    { kind: 'plugin-open', pluginId: 'calculator' }
  ])

  assert.deepEqual(coordinator.captureFile('/Users/test/待处理 文件.pdf'), { status: 'queued' })
  await coordinator.whenIdle()
  assert.equal(delivered.length, 3)
  await coordinator.stop()
})

test('rejects malformed inputs and bounds pending startup requests', () => {
  const coordinator = new MacosExternalOpenCoordinator({ handle: () => {}, pendingLimit: 2 })
  assert.deepEqual(coordinator.captureFile('not-absolute'), { status: 'rejected', reason: 'invalid-file-path' })
  assert.deepEqual(coordinator.captureUrl('https://example.test'), { status: 'rejected', reason: 'unsupported-url' })
  assert.deepEqual(coordinator.captureFile('/Users/test/one.txt'), { status: 'queued' })
  assert.deepEqual(coordinator.captureFile('/Users/test/two.txt'), { status: 'queued' })
  assert.deepEqual(coordinator.captureFile('/Users/test/three.txt'), { status: 'rejected', reason: 'queue-overflow' })
  assert.deepEqual(coordinator.captureFile('/Users/test/one.txt'), { status: 'duplicate' })
})

test('cancel signals the in-flight handler, drops queued work, and permits a later user request', async () => {
  const started = deferred<AbortSignal>()
  const finish = deferred()
  const delivered: string[] = []
  const coordinator = new MacosExternalOpenCoordinator({
    handle: async (request, signal) => {
      if (request.kind !== 'file') return
      delivered.push(request.filePath)
      if (request.filePath.endsWith('/first.txt')) {
        started.resolve(signal)
        await finish.promise
      }
    }
  })
  coordinator.captureFile('/Users/test/first.txt')
  coordinator.markReady()
  const signal = await started.promise
  coordinator.captureFile('/Users/test/canceled.txt')

  coordinator.cancelPending()
  assert.equal(signal.aborted, true)
  assert.deepEqual(coordinator.captureFile('/Users/test/canceled.txt'), { status: 'queued' })
  finish.resolve()
  await coordinator.whenIdle()
  assert.deepEqual(delivered, ['/Users/test/first.txt', '/Users/test/canceled.txt'])
  await coordinator.stop()
})

test('quit permanently rejects input, clears pre-ready work, and makes late ready inert', async () => {
  let delivered = 0
  const coordinator = new MacosExternalOpenCoordinator({ handle: () => { delivered++ } })
  coordinator.captureFile('/Users/test/pending.txt')
  const stopped = coordinator.stop()
  assert.strictEqual(coordinator.stop(), stopped)
  coordinator.markReady()
  assert.deepEqual(coordinator.captureFile('/Users/test/late.txt'), { status: 'rejected', reason: 'stopped' })
  await stopped
  assert.equal(delivered, 0)
  assert.equal(coordinator.phase, 'stopped')
})

test('a late handler failure is reported without replay and does not block the next request', async () => {
  const attempted: string[] = []
  const failed: string[] = []
  const coordinator = new MacosExternalOpenCoordinator({
    handle: request => {
      if (request.kind !== 'file') return
      attempted.push(request.filePath)
      if (request.filePath.endsWith('/first.txt')) throw new Error('late consumer failure')
    },
    onDeliveryError: kind => { failed.push(kind) }
  })
  coordinator.captureFile('/Users/test/first.txt')
  coordinator.captureFile('/Users/test/second.txt')
  coordinator.markReady()
  await coordinator.whenIdle()

  assert.deepEqual(attempted, ['/Users/test/first.txt', '/Users/test/second.txt'])
  assert.deepEqual(failed, ['file'])
  assert.deepEqual(coordinator.captureFile('/Users/test/first.txt'), { status: 'queued' })
  await coordinator.whenIdle()
  assert.equal(attempted.filter(filePath => filePath.endsWith('/first.txt')).length, 2)
  await coordinator.stop()
})

test('Electron open-file/open-url listeners prevent default handling and are removed as a pair', async () => {
  type FakeListener = (event: { preventDefault(): void }, value: string) => void
  const listeners = new Map<string, Set<FakeListener>>()
  const app = {
    on(event: string, listener: FakeListener) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
    },
    removeListener(event: string, listener: FakeListener) {
      listeners.get(event)?.delete(listener)
    }
  } as unknown as MacosExternalOpenAppEvents
  const delivered: unknown[] = []
  const coordinator = new MacosExternalOpenCoordinator({ handle: request => { delivered.push(request) } })
  const registration = installMacosExternalOpenListeners(app, coordinator, { platform: 'darwin', isPackaged: true })
  const fileDefaultPrevented = { value: false }
  const urlDefaultPrevented = { value: false }
  const fileListener = [...(listeners.get('open-file') ?? [])][0]
  const urlListener = [...(listeners.get('open-url') ?? [])][0]
  assert.ok(fileListener)
  assert.ok(urlListener)
  fileListener({ preventDefault: () => { fileDefaultPrevented.value = true } }, '/Users/test/from-finder.txt')
  urlListener({ preventDefault: () => { urlDefaultPrevented.value = true } }, 'ztools://open/todo')
  assert.equal(fileDefaultPrevented.value, true)
  assert.equal(urlDefaultPrevented.value, true)
  assert.equal(listeners.get('open-file')?.size, 1)

  registration.dispose()
  registration.dispose()
  assert.equal(listeners.get('open-file')?.size, 0)
  assert.equal(listeners.get('open-url')?.size, 0)
  coordinator.markReady()
  await coordinator.whenIdle()
  assert.deepEqual(delivered, [
    { kind: 'file', filePath: '/Users/test/from-finder.txt' },
    { kind: 'plugin-open', pluginId: 'todo' }
  ])
  await coordinator.stop()
})

test('does not install external OS handlers in development builds or on Windows', async () => {
  const listeners: string[] = []
  const app = {
    on(event: string) { listeners.push(event) },
    removeListener() {}
  } as unknown as MacosExternalOpenAppEvents
  const coordinator = new MacosExternalOpenCoordinator({ handle: () => {} })

  installMacosExternalOpenListeners(app, coordinator, { platform: 'darwin', isPackaged: false }).dispose()
  installMacosExternalOpenListeners(app, coordinator, { platform: 'win32', isPackaged: true }).dispose()
  assert.deepEqual(listeners, [])
  await coordinator.stop()
})

test('rolls back the first OS listener when the second subscription fails', () => {
  const removed: string[] = []
  const failure = new Error('subscription failed')
  const app = {
    on(event: string) { if (event === 'open-url') throw failure },
    removeListener(event: string) { removed.push(event) }
  } as unknown as MacosExternalOpenAppEvents
  const coordinator = new MacosExternalOpenCoordinator({ handle: () => {} })
  assert.throws(() => installMacosExternalOpenListeners(app, coordinator,
    { platform: 'darwin', isPackaged: true }), (error) => error === failure)
  assert.deepEqual(removed, ['open-file'])
})

test('attempts both OS listener removals and permits retry after a cleanup failure', () => {
  const removed: string[] = []
  let fail = true
  const app = {
    on() {},
    removeListener(event: string) {
      removed.push(event)
      if (event === 'open-file' && fail) throw new Error('remove failed')
    }
  } as unknown as MacosExternalOpenAppEvents
  const coordinator = new MacosExternalOpenCoordinator({ handle: () => {} })
  const registration = installMacosExternalOpenListeners(app, coordinator,
    { platform: 'darwin', isPackaged: true })
  assert.throws(() => registration.dispose(), AggregateError)
  assert.deepEqual(removed, ['open-file', 'open-url'])
  fail = false
  registration.dispose()
  registration.dispose()
  assert.deepEqual(removed, ['open-file', 'open-url', 'open-file', 'open-url'])
})

test('quit is bounded and reports an unconfirmed consumer instead of claiming it stopped', async () => {
  const started = deferred<AbortSignal>()
  const finish = deferred()
  const coordinator = new MacosExternalOpenCoordinator({
    stopTimeoutMs: 10,
    handle: async (_, signal) => { started.resolve(signal); await finish.promise }
  })
  coordinator.captureUrl('ztools://open/todo')
  coordinator.markReady()
  const signal = await started.promise
  const stopped = coordinator.stop()
  assert.strictEqual(coordinator.stop(), stopped)
  await assert.rejects(stopped, /did not confirm cancellation/)
  assert.equal(signal.aborted, true)
  assert.equal(coordinator.phase, 'stopped')
  assert.deepEqual(coordinator.captureUrl('ztools://open/todo'), { status: 'rejected', reason: 'stopped' })
  finish.resolve()
  await coordinator.whenIdle()
})

test('a consumer requesting stop synchronously cannot bypass the cancellation confirmation', async () => {
  const finish = deferred()
  const started = deferred<Promise<void>>()
  const coordinator = new MacosExternalOpenCoordinator({
    stopTimeoutMs: 10,
    handle: () => {
      started.resolve(coordinator.stop())
      return finish.promise
    }
  })
  coordinator.captureUrl('ztools://open/todo')
  coordinator.markReady()
  // Promise resolution adopts the stop promise; this must reject instead of resolving early.
  await assert.rejects(started.promise, /did not confirm cancellation/)
  finish.resolve()
  await coordinator.whenIdle()
})

test('URL-only admission does not claim the unfinished OS file consumer', async () => {
  const installed: string[] = []
  const removed: string[] = []
  const app = {
    on(event: string) { installed.push(event) },
    removeListener(event: string) { removed.push(event) }
  } as unknown as MacosExternalOpenAppEvents
  const coordinator = new MacosExternalOpenCoordinator({ handle: () => {} })
  const registration = installMacosExternalOpenListeners(app, coordinator, {
    platform: 'darwin', isPackaged: true, includeFileEvents: false
  })
  assert.deepEqual(installed, ['open-url'])
  registration.dispose()
  assert.deepEqual(removed, ['open-url'])
  await coordinator.stop()
})
