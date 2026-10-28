import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CoreServices } from '../../src/main/services/core-services.js'
import { IpcRouter, type IpcRouterOptions } from '../../src/main/ipc/router.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { constructWithRouterRollback } from '../../src/main/ipc/router-construction.js'

class FakeRegistry {
  readonly removedListeners = new Set<(webContentsId: number) => void>()

  onRemoved(listener: (webContentsId: number) => void): () => void {
    this.removedListeners.add(listener)
    return () => { this.removedListeners.delete(listener) }
  }
}

class FakeNativeHost {
  state = 'ready'
  readonly dllListeners = new Set<(event: never) => void>()
  readonly inputListeners = new Set<(event: never) => void>()
  readonly lifecycleListeners = new Set<(event: never) => void>()

  onDllEvent(listener: (event: never) => void): () => void {
    this.dllListeners.add(listener)
    return () => { this.dllListeners.delete(listener) }
  }

  onInputEvent(listener: (event: never) => void): () => void {
    this.inputListeners.add(listener)
    return () => { this.inputListeners.delete(listener) }
  }

  onLifecycleEvent(listener: (event: never) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => { this.lifecycleListeners.delete(listener) }
  }

  async configureMouseTrigger(): Promise<void> {}
}

test('IpcRouter factory rolls back real service listeners after a late constructor failure', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-router-construction-'))
  const registry = new FakeRegistry()
  const nativeHost = new FakeNativeHost()
  const thumbnailerChanges: unknown[] = []
  const services = {
    dataRoot,
    runtimePaths: runtimePathsForBusinessDataRoot(dataRoot),
    appVersion: 'test',
    webVersion: 'test',
    config: {
      async get() { return JSON.stringify({ enabled: false }) },
      async setSetting() {}
    },
    user: {},
    analytics: { stop() {} },
    clipboardHistory: { useImageThumbnailer(value: unknown) { thumbnailerChanges.push(value) } },
    nativeHost,
    serviceClient: null,
    update: { onProgress() { return () => {} } },
    async stop() {}
  } as unknown as CoreServices
  const options = {
    toggleMainWindow() {},
    toggleSuperPanel() {},
    async getPanelLocalApps() { return [] },
    closeConfirmationResolved() {},
    screenClipboardAdapters: {},
    pluginResources: { pluginRoot: path.join(dataRoot, "Plugins"), ztoolsApiPath: "missing-sdk", preloadPath: "missing-preload" },
    systemPlatformAdapter: {
      userDataPath: dataRoot,
      getRuntimeTarget() {
        return { platform: process.platform, runtime: 'electron', arch: process.arch }
      },
      async getNativeId() { return '' }
    },
    processDiscoveryAdapter: { async list() { return [] } }
  } as unknown as IpcRouterOptions
  const mainApp = {
    getPath: () => dataRoot,
    getAppPath: () => dataRoot,
    isPackaged: false,
    runningUnderARM64Translation: false,
    async getFileIcon() { return { toDataURL: () => '' } }
  } as unknown as Parameters<typeof IpcRouter.create>[3]

  try {
    await assert.rejects(IpcRouter.create(
      registry as never,
      services,
      options,
      mainApp
    ), (error: unknown) =>
      error instanceof TypeError && error.message.includes('shouldUseDarkColors'))
    assert.equal(registry.removedListeners.size, 0)
    assert.equal(nativeHost.dllListeners.size, 0)
    assert.equal(nativeHost.inputListeners.size, 0)
    assert.equal(nativeHost.lifecycleListeners.size, 0)
    assert.equal(thumbnailerChanges.length, 2)
    assert.equal(typeof thumbnailerChanges[0], 'function')
    assert.equal(thumbnailerChanges[1], undefined)
  } finally {
    const temporaryRoot = path.resolve(os.tmpdir())
    const scratchRoot = path.resolve(dataRoot)
    const relativeScratchRoot = path.relative(temporaryRoot, scratchRoot)
    const isWithinTemporaryRoot = relativeScratchRoot !== '' &&
      relativeScratchRoot !== '..' &&
      !relativeScratchRoot.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeScratchRoot)
    if (!isWithinTemporaryRoot ||
        !path.basename(scratchRoot).startsWith('ztools-router-construction-')) {
      throw new Error('Refusing to recursively remove a path outside the test-owned scratch directory')
    }
    await fs.rm(scratchRoot, { recursive: true, force: true })
  }
})

test('construction rollback is reverse ordered and continues after a cleanup failure', async () => {
  const order: string[] = []
  const constructionFailure = new Error('later constructor failed')
  const cleanupFailure = new Error('one stop failed')

  await assert.rejects(constructWithRouterRollback((scope) => {
    scope.ownCleanup(() => { order.push('files') })
    scope.ownCleanup(() => { order.push('processes') })
    scope.ownCleanup(() => {
      order.push('events')
      throw cleanupFailure
    })
    throw constructionFailure
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0], constructionFailure)
    assert.equal(error.errors[1], cleanupFailure)
    return true
  })

  assert.deepEqual(order, ['events', 'processes', 'files'])
})

test('successful construction commits ownership without running rollback cleanup', async () => {
  let cleaned = false
  const result = await constructWithRouterRollback((scope) => {
    scope.ownCleanup(() => { cleaned = true })
    return 'constructed'
  })

  assert.equal(result, 'constructed')
  assert.equal(cleaned, false)
})
