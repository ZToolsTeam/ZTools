import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ApplicationLifecycle,
  ApplicationLifecycleTimeoutError,
  runCleanupActions
} from '../../src/main/application-lifecycle.js'
import { createMacosNativeRuntime } from '../../src/main/platform/macos/native-runtime.js'
import { createPlatformNativeRuntime } from '../../src/main/platform/native-runtime.js'
import { createWindowsNativeRuntime } from '../../src/main/platform/windows/native-runtime.js'

function deferred<T = void>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve: (value?: T) => resolve(value as T) }
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('normal startup reaches running and repeated stop shares successful cleanup', async () => {
  const lifecycle = new ApplicationLifecycle(100, 100)
  let initialized = 0
  let cleaned = 0
  const startup = lifecycle.start(async (signal) => {
    assert.strictEqual(signal, lifecycle.signal)
    assert.equal(lifecycle.canContinueStartup(), true)
    initialized++
  })

  assert.ok(startup)
  await startup
  assert.equal(lifecycle.phase, 'running')

  const stop = lifecycle.stop(async (signal) => {
    assert.strictEqual(signal, lifecycle.signal)
    cleaned++
  })
  assert.strictEqual(lifecycle.stop(() => { cleaned++ }), stop)
  await stop
  assert.equal(lifecycle.phase, 'stopped')
  assert.equal(initialized, 1)
  assert.equal(cleaned, 1)
})

test('stop before Electron ready prevents a late ready callback from initializing', async () => {
  const lifecycle = new ApplicationLifecycle(100, 100)
  let initialized = false
  await lifecycle.stop(() => {})

  assert.equal(lifecycle.start(() => { initialized = true }), null)
  await waitForTurn()
  assert.equal(initialized, false)
  assert.equal(lifecycle.phase, 'stopped')
})

test('stop during an awaited startup stage waits for it and blocks later resource creation', async () => {
  const lifecycle = new ApplicationLifecycle(100, 100)
  const stageStarted = deferred()
  const finishStage = deferred()
  let laterResourceCreated = false
  let cleaned = false
  const startup = lifecycle.start(async (signal) => {
    stageStarted.resolve()
    await finishStage.promise
    if (signal.aborted || !lifecycle.canContinueStartup()) return
    laterResourceCreated = true
  })
  assert.ok(startup)
  await stageStarted.promise

  const stop = lifecycle.stop(() => { cleaned = true })
  assert.equal(lifecycle.signal.aborted, true)
  await waitForTurn()
  assert.equal(cleaned, false)

  finishStage.resolve()
  await Promise.all([startup, stop])
  assert.equal(cleaned, true)
  assert.equal(laterResourceCreated, false)
  assert.equal(lifecycle.phase, 'stopped')
})

test('startup failure is cleaned through stop without catch self-wait', async () => {
  const lifecycle = new ApplicationLifecycle(100, 100)
  let cleaned = 0
  const startup = lifecycle.start(() => { throw new Error('startup failed') })
  assert.ok(startup)

  const handled = startup.catch(() => lifecycle.stop(() => { cleaned++ }))
  let failTimer: NodeJS.Timeout | undefined
  await Promise.race([
    handled,
    new Promise<never>((_resolve, reject) => {
      failTimer = setTimeout(() => reject(new Error('stop self-waited')), 200)
    })
  ]).finally(() => {
    if (failTimer) clearTimeout(failTimer)
  })
  assert.equal(cleaned, 1)
  assert.equal(lifecycle.phase, 'failed')
})

test('cleanup actions continue after failures and preserve all errors', async () => {
  const calls: string[] = []
  await assert.rejects(
    runCleanupActions([
      () => { calls.push('tray'); throw new Error('tray failed') },
      async () => { calls.push('panel'); throw new Error('panel failed') },
      () => { calls.push('router') }
    ], 100),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2
  )
  assert.deepEqual(calls, ['tray', 'panel', 'router'])
})

test('startup-drain timeout fails deterministically, aborts the shared signal, and ignores late completion', async () => {
  const lifecycle = new ApplicationLifecycle(10, 100)
  const stageStarted = deferred()
  const finishStage = deferred()
  let lateResourceCreated = false
  let cleanupSignal: AbortSignal | undefined
  const startup = lifecycle.start(async (signal) => {
    stageStarted.resolve()
    await finishStage.promise
    if (signal.aborted || !lifecycle.canContinueStartup()) return
    lateResourceCreated = true
  })
  assert.ok(startup)
  await stageStarted.promise

  await assert.rejects(
    lifecycle.stop((signal) => { cleanupSignal = signal }),
    (error: unknown) => error instanceof ApplicationLifecycleTimeoutError && error.operation === 'startup-drain'
  )
  assert.strictEqual(cleanupSignal, lifecycle.signal)
  assert.equal(cleanupSignal?.aborted, true)
  assert.equal(lifecycle.phase, 'failed')

  finishStage.resolve()
  await startup
  assert.equal(lateResourceCreated, false)
  assert.equal(lifecycle.phase, 'failed')
})

test('cleanup timeout fails the shared stop promise instead of reporting a clean stop', async () => {
  const lifecycle = new ApplicationLifecycle(100, 10)
  const never = new Promise<void>(() => {})
  const stop = lifecycle.stop(() => never)
  assert.strictEqual(lifecycle.stop(() => {}), stop)
  await assert.rejects(
    stop,
    (error: unknown) => error instanceof ApplicationLifecycleTimeoutError && error.operation === 'cleanup'
  )
  assert.equal(lifecycle.phase, 'failed')
})

test('macOS enters the pure JavaScript startup path without a native plugin host', async () => {
  const lifecycle = new ApplicationLifecycle(100, 100)
  const runtime = createPlatformNativeRuntime('darwin', {
    windows: () => { throw new Error('Windows native runtime must not be constructed') },
    macos: () => createMacosNativeRuntime({
      isPackaged: false,
      resourcesPath: '/fixture/ZTools.app/Contents/Resources',
      appPath: '/fixture/ZTools.app/Contents/Resources/app.asar',
      pluginRoot: '/fixture/profile/Plugins',
      processArchitecture: 'arm64',
      runningUnderTranslation: false
    })
  })
  let mainWindowReady = false
  const startup = lifecycle.start(async (signal) => {
    await runtime.start(signal)
    if (!lifecycle.canContinueStartup()) return
    assert.equal(runtime.nativeHost, null)
    assert.equal(runtime.serviceClient, null)
    mainWindowReady = true
  })

  assert.ok(startup)
  await startup
  assert.equal(mainWindowReady, true)
  assert.equal(lifecycle.phase, 'running')
  await lifecycle.stop(() => {})
})

test('Windows keeps pure JavaScript startup available when optional native clients are unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-win-js-'))
  const runtime = createWindowsNativeRuntime({
    isPackaged: false,
    resourcesPath: path.join(root, 'resources'),
    appPath: root,
    pluginRoot: path.join(root, 'plugins'),
    dataRoot: path.join(root, 'data')
  })
  const lifecycle = new ApplicationLifecycle(1000, 1000)
  let mainWindowReady = false
  try {
    const startup = lifecycle.start(async (signal) => {
      await runtime.start(signal)
      if (!lifecycle.canContinueStartup()) return
      mainWindowReady = true
    })
    assert.ok(startup)
    await startup
    assert.equal(mainWindowReady, true)
    assert.equal(runtime.nativeHost?.state, 'idle')
    assert.equal(runtime.serviceClient?.diagnostics.state, 'unavailable')
    assert.equal(lifecycle.phase, 'running')
  } finally {
    await lifecycle.stop(async () => {
      await runCleanupActions([
        () => runtime.serviceClient?.stop(),
        async () => { await runtime.nativeHost?.stop() }
      ], 1000)
    })
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Windows exit during NativeHost startup prevents late Service startup and window creation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-win-cancel-'))
  const runtime = createWindowsNativeRuntime({
    isPackaged: false,
    resourcesPath: path.join(root, 'resources'),
    appPath: root,
    pluginRoot: path.join(root, 'plugins'),
    dataRoot: path.join(root, 'data')
  })
  const lifecycle = new ApplicationLifecycle(1000, 1000)
  const nativeStartEntered = deferred()
  let mainWindowCreated = false
  try {
    const startup = lifecycle.start(async (signal) => {
      nativeStartEntered.resolve()
      await runtime.start(signal)
      if (lifecycle.canContinueStartup()) mainWindowCreated = true
    })
    assert.ok(startup)
    await nativeStartEntered.promise

    const stop = lifecycle.stop(async (signal) => {
      assert.strictEqual(signal, lifecycle.signal)
      await runCleanupActions([
        () => runtime.serviceClient?.stop(),
        async () => { await runtime.nativeHost?.stop() }
      ], 1000)
    })
    await Promise.all([startup, stop])
    assert.equal(mainWindowCreated, false)
    assert.equal(runtime.serviceClient?.diagnostics.state, 'closed')
    assert.equal(runtime.nativeHost?.state, 'closed')
    assert.equal(lifecycle.phase, 'stopped')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cleanup timeout still starts remaining synchronous cleanup actions', async () => {
  const calls: string[] = []
  const never = new Promise<void>(() => {})
  await assert.rejects(
    runCleanupActions([
      () => { calls.push('hung'); return never },
      () => { calls.push('late') }
    ], 10),
    (error: unknown) => error instanceof ApplicationLifecycleTimeoutError ||
      (error instanceof AggregateError &&
        error.errors.some((item) => item instanceof ApplicationLifecycleTimeoutError))
  )
  assert.deepEqual(calls, ['hung', 'late'])
})
