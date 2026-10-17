import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { DatabaseGetParams, DatabasePutParams } from '../../src/contracts/method-params.js'
import type {
  NativeDllEvent,
  NativeDllEventListener,
  NativeDllTaskStartAttempt,
  NativeDllTaskStartOutcome,
  NativeDllTaskStatus
} from '../../src/main/native-host/native-host-client.js'
import type { NativeDllInvocationContext } from '../../src/main/native-host/dll-client-port.js'
import { DllPluginService } from '../../src/main/services/dll-plugin-service.js'
import type { RuntimeCapabilityLease } from '../../src/main/services/runtime-capability-authorization-service.js'
import type { PluginManifest, PluginManifestRuntimeMetadata } from '../../src/main/services/plugin-install-service.js'
import { NativeMediaPathPolicy } from '../../src/main/services/native-media-policy.js'

// 这些用例依赖 Windows 路径语义（C:\\ / E:\\）或 Windows 宿主能力（DLL、进程启动、更新安装链、本地 .exe 软件），
// 在其他平台上功能代码按设计会拒绝执行，因此只在 Windows 宿主运行；Windows CI 上照常覆盖。
const windowsOnly = { skip: process.platform === 'win32' ? false : '依赖 Windows 路径或宿主能力，仅在 Windows 上运行' }


const standardManifest: PluginManifest = {
  id: 'clipboard-manager',
  name: 'Clipboard Manager',
  version: '1.0.0',
  entry: 'index.html',
  dllloader: 'lib/ClipboardManagerPlugin.dll',
  requireAdmin: false,
  commonLibs: []
}

const adminManifest: PluginManifest = {
  id: 'context-menu',
  name: 'Context Menu',
  version: '1.0.0',
  entry: 'index.html',
  dllloader: 'lib/ContextMenuPlugin.dll',
  requireAdmin: true,
  commonLibs: []
}

const clipboardCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 21,
  pluginId: standardManifest.id,
  pluginInstanceId: 'clipboard-1'
}

const contextMenuCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 22,
  pluginId: adminManifest.id,
  pluginInstanceId: 'context-1'
}

class FakeManifestSource {
  readonly manifests = new Map<string, PluginManifest>([
    [standardManifest.id, standardManifest],
    [adminManifest.id, adminManifest]
  ])
  onManifestResolve: (() => void) | null = null
  manifestResolveGate: Promise<void> | null = null

  async list(): Promise<{ success: true; data: Record<string, unknown>[] }> {
    return { success: true, data: [...this.manifests.values()] }
  }

  async withPluginManifest<T>(
    pluginId: string,
    action: (manifest: PluginManifest) => Promise<T>
  ): Promise<T> {
    this.onManifestResolve?.()
    if (this.manifestResolveGate) await this.manifestResolveGate
    const manifest = this.manifests.get(pluginId)
    if (!manifest) throw new ZToolsError(errorCodes.pluginNotFound, 'plugin missing')
    return await action(manifest)
  }
}

class FakeNativeHost {
  readonly diagnostics = {
    state: 'ready' as const,
    pid: 100,
    stderr: '',
    recovering: false,
    restartAttempt: 0
  }
  readonly calls: Array<{ method: string; args: unknown[] }> = []
  readonly invocationContexts: Array<{ method: string; context: NativeDllInvocationContext }> = []
  readonly releasedOwners: NativeDllInvocationContext[] = []
  readonly maintenanceReleased: string[] = []
  readonly #taskIdAliases = new Map<string, string>()
  readonly #actualTaskIds = new Map<string, string>()
  readonly assignedTaskIds: string[] = []
  #asyncTaskIndex = 0
  unloadGate: Promise<void> | null = null
  async releaseOwner(context: NativeDllInvocationContext): Promise<void> { this.releasedOwners.push(context) }
  async acquirePluginMaintenance(pluginId: string): Promise<() => void> {
    return () => { this.maintenanceReleased.push(pluginId) }
  }
  async unloadDll(pluginId: string, dllId: string): Promise<void> {
    this.#record('unloadDll', [pluginId, dllId])
    if (this.unloadGate) await this.unloadGate
  }
  #registerTaskAlias(alias: string, taskId: string): void {
    this.#taskIdAliases.set(taskId, alias)
    this.#actualTaskIds.set(alias, taskId)
  }
  #actualTaskId(taskId: string): string {
    return this.#actualTaskIds.get(taskId) ?? taskId
  }
  #taskIdForLog(taskId: unknown): unknown {
    return typeof taskId === 'string' ? this.#taskIdAliases.get(taskId) ?? taskId : taskId
  }
  #record(method: string, args: unknown[]): void {
    const contextIndexes: Record<string, number> = {
      getDllInfo: 2,
      callDll: 4,
      callDllAsync: 4,
      beginDllAsyncTask: 4,
      beginDllCallbackTask: 4,
      queryDllTask: 3,
      cancelDllTask: 3,
      clearDllTask: 3
    }
    const contextIndex = contextIndexes[method]
    const candidate = contextIndex === undefined ? undefined : args[contextIndex]
    if (contextIndex !== undefined && candidate && typeof candidate === 'object' && 'ownerToken' in candidate &&
        'generation' in candidate && 'pluginInstanceId' in candidate && 'webContentsId' in candidate) {
      const [removed] = args.splice(contextIndex, 1)
      this.invocationContexts.push({ method, context: removed as NativeDllInvocationContext })
    }
    if (method === 'queryDllTask' || method === 'cancelDllTask' || method === 'clearDllTask') {
      args[2] = this.#taskIdForLog(args[2])
    } else if (method === 'callDllAsync' || method === 'beginDllAsyncTask' || method === 'beginDllCallbackTask') {
      args[args.length - 1] = this.#taskIdForLog(args.at(-1))
    }
    this.calls.push({ method, args })
  }
  #listener: NativeDllEventListener | null = null
  callbackStartHook: ((taskId: string) => void) | null = null
  callbackStartGate: Promise<void> | null = null
  callbackStartError: Error | null = null
  onCancelTask: ((pluginId: string, dllId: string, taskId: string) => void) | null = null
  cancelCode = 0
  asyncStartError: Error | null = null
  asyncStartGate: Promise<void> | null = null
  asyncDefinitiveStartError: Error | null = null
  asyncStartHook: ((taskId: string) => void) | null = null
  readonly asyncStartResolvers = new Map<string, (outcome: NativeDllTaskStartOutcome) => void>()
  clearError: Error | null = null
  clearGate: Promise<void> | null = null
  queryStatus: NativeDllTaskStatus['status'] = 'running'
  queryProgress = 35
  queryResult: string | null = null
  readonly #terminalTasks = new Set<string>()
  #callbackTaskIndex = 0
  readonly #callbackStartResolvers = new Map<string, (outcome: NativeDllTaskStartOutcome) => void>()

  get listenerBound(): boolean {
    return this.#listener !== null
  }

  onDllEvent(listener: NativeDllEventListener): () => void {
    this.#listener = listener
    return () => {
      if (this.#listener === listener) this.#listener = null
    }
  }

  emit(event: NativeDllEvent): void {
    const actualTaskId = this.#actualTaskId(event.taskId)
    const deliveredEvent = actualTaskId === event.taskId ? event : { ...event, taskId: actualTaskId }
    if (
      deliveredEvent.type === 'cancelled' ||
      deliveredEvent.type === 'task-error' ||
      deliveredEvent.type === 'async-return' ||
      (deliveredEvent.type === 'callback-return' && deliveredEvent.call.code !== 0)
    ) {
      this.#terminalTasks.add(deliveredEvent.taskId)
    } else if (deliveredEvent.type === 'callback-result') {
      try {
        const result = JSON.parse(deliveredEvent.result) as { type?: unknown; status?: unknown; data?: { status?: unknown } }
        const terminalStatuses = ['completed', 'cancelled', 'error']
        const hasExplicitType = Object.hasOwn(result, 'type')
        const hasUnknownType = hasExplicitType &&
          !['progress', 'completed', 'complete', 'done', 'success', 'cancelled', 'canceled', 'error', 'failed', 'failure']
            .includes(String(result.type).toLowerCase())
        const hasKnownTerminal = !hasUnknownType && result.type !== 'progress' &&
          [result.type, result.status, result.data?.status]
            .some((status) => terminalStatuses.includes(String(status)))
        const isLegacyResult = !hasExplicitType &&
          !Object.hasOwn(result, 'status') && !result.data?.status
        if (hasKnownTerminal || isLegacyResult) {
          this.#terminalTasks.add(deliveredEvent.taskId)
        }
      } catch {
        // Legacy/unknown callback data does not prove the task has stopped.
      }
    }
    this.#listener?.(deliveredEvent)
  }

  async getDllInfo(pluginId: string, dllId: string, context?: NativeDllInvocationContext): Promise<{
    pluginName: string
    version: string
    author: string
    description: string
    functions: string[]
    supportsAsync: boolean
    supportsCallback: boolean
    supportsCancel: boolean
    supportsStopManagedProcesses: boolean
  }> {
    this.#record('getDllInfo', context ? [pluginId, dllId, context] : [pluginId, dllId])
    return {
      pluginName: 'Clipboard Manager Native',
      version: '1.0.0',
      author: 'test',
      description: 'test fixture',
      functions: ['Echo'],
      supportsAsync: true,
      supportsCallback: true,
      supportsCancel: true,
      supportsStopManagedProcesses: false
    }
  }

  async callDll(...args: unknown[]): Promise<{ code: number; result: string }> {
    this.#record('callDll', args)
    return { code: 0, result: '{"echo":"native"}' }
  }

  beginDllAsyncTask(...args: unknown[]): NativeDllTaskStartAttempt {
    const taskId = String(args.at(-1))
    this.assignedTaskIds.push(taskId)
    const alias = this.#asyncTaskIndex === 0 ? 'task_native_async' : `task_native_async_${this.#asyncTaskIndex}`
    this.#asyncTaskIndex += 1
    this.#registerTaskAlias(alias, taskId)
    this.#record('beginDllAsyncTask', args)
    let resolveOutcome!: (outcome: NativeDllTaskStartOutcome) => void
    const outcome = new Promise<NativeDllTaskStartOutcome>((resolve) => { resolveOutcome = resolve })
    this.asyncStartResolvers.set(taskId, resolveOutcome)
    this.asyncStartHook?.(alias)
    const gate = this.asyncStartGate; this.asyncStartGate = null
    const error = this.asyncDefinitiveStartError; this.asyncDefinitiveStartError = null
    const lost = this.asyncStartError; this.asyncStartError = null
    if (!lost) void Promise.resolve().then(async () => {
      if (gate) await gate
      resolveOutcome(error ? { kind: 'not-started', error } : { kind: 'started' })
      this.asyncStartResolvers.delete(taskId)
    })
    return { taskId, outcome }
  }

  resolveAsyncStart(taskId: string, outcome: NativeDllTaskStartOutcome): void {
    const actual = this.#actualTaskId(taskId), resolve = this.asyncStartResolvers.get(actual)
    if (!resolve) throw new Error('async start is not pending')
    resolve(outcome); this.asyncStartResolvers.delete(actual)
  }

  async callDllAsync(...args: unknown[]): Promise<string> {
    const attempt = this.beginDllAsyncTask(...args), outcome = await attempt.outcome
    if (outcome.kind !== 'started') throw outcome.error
    return attempt.taskId
  }

  beginDllCallbackTask(...args: unknown[]): NativeDllTaskStartAttempt {
    const taskId = String(args.at(-1))
    this.assignedTaskIds.push(taskId)
    const alias = this.#callbackTaskIndex === 0
      ? 'task_native_callback'
      : `task_native_callback_${this.#callbackTaskIndex}`
    this.#registerTaskAlias(alias, taskId)
    this.#callbackTaskIndex += 1
    this.#record('beginDllCallbackTask', args)
    let resolveOutcome!: (outcome: NativeDllTaskStartOutcome) => void
    const outcome = new Promise<NativeDllTaskStartOutcome>((resolve) => { resolveOutcome = resolve })
    this.#callbackStartResolvers.set(taskId, resolveOutcome)
    this.callbackStartHook?.(alias)
    const gate = this.callbackStartGate
    this.callbackStartGate = null
    const startError = this.callbackStartError
    this.callbackStartError = null
    void Promise.resolve().then(async () => {
      if (gate) await gate
      if (startError) {
        resolveOutcome({ kind: 'not-started', error: startError })
      } else {
        resolveOutcome({ kind: 'started' })
      }
      this.#callbackStartResolvers.delete(taskId)
    })
    return { taskId, outcome }
  }

  resolveCallbackStart(taskId: string, outcome: NativeDllTaskStartOutcome): void {
    const resolveOutcome = this.#callbackStartResolvers.get(this.#actualTaskId(taskId))
    if (!resolveOutcome) throw new Error(`callback start not pending: ${taskId}`)
    resolveOutcome(outcome)
    this.#callbackStartResolvers.delete(taskId)
  }

  async callDllWithCallback(...args: unknown[]): Promise<string> {
    const attempt = this.beginDllCallbackTask(...args)
    const result = await attempt.outcome
    if (result.kind !== 'started') throw result.error
    return attempt.taskId
  }

  async queryDllTask(...args: unknown[]): Promise<NativeDllTaskStatus> {
    const taskId = String(args[2])
    if (this.queryStatus === 'completed' || this.queryStatus === 'cancelled' || this.queryStatus === 'error') {
      this.#terminalTasks.add(taskId)
    }
    this.#record('queryDllTask', args)
    return {
      taskId,
      mode: 'callback',
      status: this.queryStatus,
      progress: this.queryProgress,
      functionName: 'Watch',
      error: null,
      result: this.queryResult
    } as NativeDllTaskStatus
  }

  async cancelDllTask(...args: unknown[]): Promise<number> {
    this.#record('cancelDllTask', args)
    this.onCancelTask?.(String(args[0]), String(args[1]), String(args[2]))
    return this.cancelCode
  }

  async clearDllTask(...args: unknown[]): Promise<void> {
    const taskId = String(args[2])
    this.#record('clearDllTask', args)
    if (this.clearError) {
      const error = this.clearError
      const gate = this.clearGate
      this.clearGate = null
      if (gate) await gate
      throw error
    }
    if (!this.#terminalTasks.has(taskId)) throw new Error('DLL_BUSY')
    this.#terminalTasks.delete(taskId)
  }
}

class FakeWindowRegistry {
  readonly #listeners = new Set<(webContentsId: number) => void>()

  onRemoved(listener: (webContentsId: number) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  remove(webContentsId: number): void {
    for (const listener of this.#listeners) listener(webContentsId)
  }
}

class FakeServiceClient {
  readonly diagnostics = {
    state: 'ready' as 'ready' | 'closed',
    protocolVersion: 1,
    pipe: 'test',
    lastError: '',
    lastErrorMessage: ''
  }
  readonly calls: unknown[][] = []
  readonly taskCalls: Array<{ method: string; args: unknown[] }> = []
  taskStatus: NativeDllTaskStatus['status'] = 'running'

  async callDll(...args: unknown[]): Promise<unknown> {
    this.calls.push(args)
    return { echo: 'service' }
  }

  async callDllAsync(...args: unknown[]): Promise<string> {
    this.taskCalls.push({ method: 'callDllAsync', args })
    return String(args[3])
  }

  async callDllWithCallback(...args: unknown[]): Promise<string> {
    this.taskCalls.push({ method: 'callDllWithCallback', args })
    return String(args[3])
  }

  async queryDllTask(...args: unknown[]): Promise<NativeDllTaskStatus> {
    this.taskCalls.push({ method: 'queryDllTask', args })
    return {
      taskId: String(args[2]),
      mode: 'callback',
      status: this.taskStatus,
      progress: this.taskStatus === 'completed' ? 100 : 35,
      functionName: 'Watch',
      error: null
    }
  }

  async cancelDllTask(...args: unknown[]): Promise<number> {
    this.taskCalls.push({ method: 'cancelDllTask', args })
    return 0
  }

  async clearDllTask(...args: unknown[]): Promise<void> {
    this.taskCalls.push({ method: 'clearDllTask', args })
  }
}

class FakeWatermarkSettingsDatabase {
  readonly writes: Array<{ params: DatabasePutParams; caller: CallerIdentity }> = []
  readonly #values = new Map<string, string>()

  async put(params: DatabasePutParams, caller: CallerIdentity): Promise<{ success: true; data: 'OK' }> {
    if (caller.type === 'plugin' && caller.pluginId !== params.plugin_id) {
      throw new ZToolsError(errorCodes.permissionDenied, 'plugin namespace mismatch')
    }
    this.writes.push({ params, caller })
    this.#values.set(`${params.plugin_id}:${params.key}`, JSON.stringify(params.value))
    return { success: true, data: 'OK' }
  }

  async get(params: DatabaseGetParams, caller: CallerIdentity): Promise<{ success: true; data: string }> {
    if (caller.type === 'plugin' && caller.pluginId !== params.plugin_id) {
      throw new ZToolsError(errorCodes.permissionDenied, 'plugin namespace mismatch')
    }
    const data = this.#values.get(`${params.plugin_id}:${params.key}`)
    if (data === undefined) throw new ZToolsError(errorCodes.databaseKeyNotFound, 'missing')
    return { success: true, data }
  }
}

class FakeEvents {
  readonly published: Array<{
    type: string
    payload: unknown
    pluginId: string
    owner: CallerIdentity
  }> = []
  publishError: Error | null = null

  publishHostToOwner(type: string, payload: unknown, owner: CallerIdentity): {
    success: true
    delivered: number
  } {
    if (this.publishError) throw this.publishError
    this.published.push({
      type,
      payload,
      pluginId: owner.pluginId ?? '',
      owner: { ...owner }
    })
    return { success: true, delivered: 1 }
  }
}

function createHarness(
  registry?: FakeWindowRegistry,
  lifecycleOptions?: { taskQuiesceTimeoutMs?: number; taskQuiescePollIntervalMs?: number; taskStartAckTimeoutMs?: number }
): {
  dllPlugins: DllPluginService
  native: FakeNativeHost
  service: FakeServiceClient
  events: FakeEvents
  registry?: FakeWindowRegistry
} {
  const native = new FakeNativeHost()
  const service = new FakeServiceClient()
  const events = new FakeEvents()
  return {
    dllPlugins: new DllPluginService(
      new FakeManifestSource(),
      native,
      service,
      events,
      registry,
      lifecycleOptions
    ),
    native,
    service,
    events,
    ...(registry ? { registry } : {})
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, 'condition did not become true before timeout')
}

function createScreenCaptureHarness() {
  const native = new FakeNativeHost()
  const events = new FakeEvents()
  const leaseAbort = new AbortController()
  let released = 0
  const lease: RuntimeCapabilityLease = {
    signal: leaseAbort.signal,
    assertCurrent() {
      if (leaseAbort.signal.aborted) throw new ZToolsError(errorCodes.permissionDenied, 'revoked')
    },
    release() { released += 1 }
  }
  const authorization = { beginOperation: () => lease }
  const dllPlugins = new DllPluginService(
    new FakeManifestSource(), native, null, events, undefined, undefined, undefined, undefined, 'win32', authorization
  )
  return { dllPlugins, native, events, leaseAbort, released: () => released }
}

test('plugin screen-capture DLL calls fail closed without the shared authorization service', async () => {
  const native = new FakeNativeHost()
  const dllPlugins = new DllPluginService(new FakeManifestSource(), native, null, new FakeEvents())
  await assert.rejects(dllPlugins.call({
    plugin: 'ScreenCapturePlugin', func: 'CaptureScreen', params: {}
  }, clipboardCaller), { code: errorCodes.notSupported })
  assert.equal(native.calls.length, 0)
  await dllPlugins.stop()
})

test('screen-capture async DLL task keeps its authorization lease after taskId and suppresses late result data', async () => {
  const f = createScreenCaptureHarness()
  const started = await f.dllPlugins.callAsync({
    plugin: 'ScreenCapturePlugin', func: 'CaptureRegion', params: {}
  }, clipboardCaller)
  const taskId = String(started.taskId)
  assert.ok(taskId)

  f.leaseAbort.abort(errorCodes.permissionDenied)
  await waitFor(() => f.native.calls.some(call => call.method === 'cancelDllTask'))
  f.native.emit({
    type: 'callback-result', pluginId: 'CommonPlugins', dllId: 'ScreenCapturePlugin', taskId: 'task_native_async',
    result: '{"type":"completed","data":{"captured":"must-not-escape"}}'
  })

  const result = await f.dllPlugins.queryTask({ plugin: 'ScreenCapturePlugin', taskId }, clipboardCaller)
  assert.equal(result.taskPermissionRevoked, true)
  assert.equal(result.taskCancelRequested, true)
  assert.equal(result.taskStatus, 'error')
  assert.equal(Object.hasOwn(result, 'taskData'), false)
  assert.equal(String(result.taskError).includes('可能无法回滚'), true)
  assert.equal(f.events.published.some(event => event.type === 'dllplugin_callback_result'), false)
  assert.equal(f.released(), 1)
  await f.dllPlugins.clearCallbackTask({ taskId }, clipboardCaller)
  await f.dllPlugins.stop()
})

test('screen-capture callback DLL task retains its lease through a late terminal callback', async () => {
  const f = createScreenCaptureHarness()
  const taskId = 'screen_capture_callback_task'
  await f.dllPlugins.callWithCallback({
    plugin: 'ScreenCapturePlugin', func: 'CaptureRegion', params: { taskId }
  }, clipboardCaller)

  f.leaseAbort.abort(errorCodes.permissionDenied)
  await waitFor(() => f.native.calls.some(call => call.method === 'cancelDllTask'))
  f.native.emit({
    type: 'callback-result', pluginId: 'CommonPlugins', dllId: 'ScreenCapturePlugin', taskId: 'task_native_callback',
    result: '{"type":"completed","data":{"captured":"must-not-escape"}}'
  })

  const result = await f.dllPlugins.queryTask({ plugin: 'ScreenCapturePlugin', taskId }, clipboardCaller)
  assert.equal(result.taskPermissionRevoked, true)
  assert.equal(result.taskStatus, 'error')
  assert.equal(Object.hasOwn(result, 'taskData'), false)
  assert.equal(f.events.published.some(event => event.type === 'dllplugin_callback_result'), false)
  assert.equal(f.released(), 1)
  await f.dllPlugins.clearCallbackTask({ taskId }, clipboardCaller)
  await f.dllPlugins.stop()
})

test('ordinary and administrator DLL calls use separate trusted transports', windowsOnly, async () => {
  const { dllPlugins, native, service } = createHarness()
  assert.deepEqual(await dllPlugins.call({
    plugin: 'ClipboardManagerPlugin',
    func: 'Echo',
    params: { value: 1 }
  }, clipboardCaller), {
    success: true,
    data: { echo: 'native' }
  })
  assert.deepEqual(native.calls.at(-1), {
    method: 'callDll',
    args: ['clipboard-manager', 'ClipboardManagerPlugin', 'Echo', { value: 1 }]
  })
  assert.equal(service.calls.length, 0)

  assert.deepEqual(await dllPlugins.call({
    plugin: 'ContextMenuPlugin',
    func: 'CheckAdmin',
    params: {}
  }, contextMenuCaller), {
    success: true,
    data: { echo: 'service' }
  })
  assert.deepEqual(service.calls, [[
    'context-menu',
    'ContextMenuPlugin',
    'CheckAdmin',
    {}
  ]])
  assert.equal(native.calls.filter((call) => call.method === 'callDll').length, 1)
  dllPlugins.stop()
})

test('ordinary DLL calls carry both the Main-owned identity and IPC cancellation signal', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  const controller = new AbortController()
  await dllPlugins.call({ plugin: 'ClipboardManagerPlugin', func: 'Echo', params: {} }, clipboardCaller, controller.signal)

  assert.strictEqual(native.calls[0]?.args.at(-1), controller.signal)
  assert.strictEqual(native.invocationContexts[0]?.method, 'callDll')
  assert.equal(native.invocationContexts[0]?.context.pluginInstanceId, clipboardCaller.pluginInstanceId)
  await dllPlugins.stop()
})

test('unload drains and clears active tasks before taking the maintenance lock', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  native.queryStatus = 'completed'

  await dllPlugins.unloadPlugin(standardManifest.id)

  assert.deepEqual(native.calls.map((call) => call.method), [
    'beginDllAsyncTask', 'cancelDllTask', 'queryDllTask', 'clearDllTask', 'unloadDll'
  ])
  assert.deepEqual(native.maintenanceReleased, [standardManifest.id])
  await dllPlugins.stop()
})

test('an async task with a lost start response remains reserved and sends pending cancellation after a Host event', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  native.asyncStartError = new Error('start response lost')
  const started = await dllPlugins.callAsync({
    plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {}
  }, clipboardCaller)
  assert.equal(started.taskStartPending, true)
  const taskId = String(started.taskId)

  const unresolved = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  assert.equal(unresolved.taskStartPending, true)
  await dllPlugins.cancelTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  assert.equal(native.calls.some((call) => call.method === 'cancelDllTask'), false)

  native.emit({
    type: 'progress', pluginId: standardManifest.id, dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_async', percent: 10, message: 'running'
  })
  await waitFor(() => native.calls.some((call) => call.method === 'cancelDllTask'))
  const observed = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  assert.equal(observed.taskStartPending, undefined)
  assert.equal(observed.taskDone, false)
  assert.equal(observed.taskCancelRequested, true)

  native.emit({
    type: 'cancelled', pluginId: standardManifest.id, dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_async', code: 0
  })
  const terminal = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  assert.equal(terminal.taskDone, true)
  assert.equal(terminal.taskStatus, 'cancelled')
  assert.equal(native.calls.filter((call) => call.method === 'cancelDllTask').length, 1)
  await dllPlugins.clearCallbackTask({ taskId }, clipboardCaller)
  await dllPlugins.stop()
})

test('unload refuses to forget a task whose stopped state remains unknown', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness(undefined, {
    taskQuiesceTimeoutMs: 80,
    taskQuiescePollIntervalMs: 10
  })
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'unload_unknown_task' }
  }, clipboardCaller)

  await assert.rejects(
    dllPlugins.unloadPlugin(standardManifest.id),
    (error) => error instanceof ZToolsError && error.code === errorCodes.pluginBusy
  )
  assert.equal(native.calls.some((call) => call.method === 'unloadDll'), false)
  const status = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'unload_unknown_task'
  }, clipboardCaller)
  assert.equal(status.taskDone, false)
  await dllPlugins.stop()
})

test('unload has a deadline and keeps the maintenance lock until a late host response settles', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness(undefined, { taskQuiesceTimeoutMs: 70 })
  let releaseUnload!: () => void
  native.unloadGate = new Promise<void>((resolve) => { releaseUnload = resolve })

  const unload = dllPlugins.unloadPlugin(standardManifest.id)
  await waitFor(() => native.calls.some((call) => call.method === 'unloadDll'))
  await assert.rejects(
    unload,
    (error) => error instanceof ZToolsError && error.code === errorCodes.pluginBusy
  )
  assert.deepEqual(native.maintenanceReleased, [])

  releaseUnload()
  await waitFor(() => native.maintenanceReleased.length === 1)
  await dllPlugins.stop()
})

test('plugin callers cannot address another plugin DLL', windowsOnly, async () => {
  const { dllPlugins, native, service } = createHarness()
  await assert.rejects(
    dllPlugins.call({
      plugin: 'ContextMenuPlugin',
      func: 'CheckAdmin',
      params: {}
    }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  assert.equal(native.calls.length, 0)
  assert.equal(service.calls.length, 0)
  dllPlugins.stop()
})

test('DLL lookup errors do not echo caller input or manifest identifiers', windowsOnly, async () => {
  const manifests = new FakeManifestSource()
  const native = new FakeNativeHost()
  const service = new FakeServiceClient()
  const events = new FakeEvents()
  const dllPlugins = new DllPluginService(manifests, native, service, events)
  const mainCaller: CallerIdentity = { type: 'main', webContentsId: 99 }
  const suppliedPath = '/Users/alice/private/installer-token-123.dll'

  await assert.rejects(
    dllPlugins.call({ plugin: suppliedPath, func: 'Read', params: {} }, mainCaller),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.pluginNotFound &&
      error.message === 'DLL 插件不存在' &&
      !error.message.includes(suppliedPath)
  )

  manifests.manifests.set('duplicate-dll', {
    ...standardManifest,
    id: 'duplicate-dll',
    dllloader: adminManifest.dllloader
  })
  await assert.rejects(
    dllPlugins.call({ plugin: 'ContextMenuPlugin', func: 'Read', params: {} }, mainCaller),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.permissionDenied &&
      error.message === 'DLL 插件名称不唯一' &&
      !error.message.includes('ContextMenuPlugin')
  )
  dllPlugins.stop()
})

test('missing DLL declaration errors do not echo manifest identifiers', async () => {
  const manifests = new FakeManifestSource()
  const secretPath = '/Users/alice/private/manifest-token-456'
  manifests.manifests.set(secretPath, {
    ...standardManifest,
    id: secretPath,
    dllloader: ''
  })
  const dllPlugins = new DllPluginService(
    manifests,
    new FakeNativeHost(),
    new FakeServiceClient(),
    new FakeEvents()
  )

  await assert.rejects(
    dllPlugins.call({ plugin: 'MissingDll', func: 'Read', params: {} }, {
      type: 'plugin',
      webContentsId: 100,
      pluginId: secretPath,
      pluginInstanceId: 'missing-dll-instance'
    }),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.pluginNotFound &&
      error.message === '插件未声明 DLL' &&
      !error.message.includes(secretPath)
  )
  dllPlugins.stop()
})

test('administrator DLL tasks use Service and wait for terminal status after cancellation', windowsOnly, async () => {
  const { dllPlugins, native, service } = createHarness()
  const started = await dllPlugins.callAsync({
    plugin: 'ContextMenuPlugin',
    func: 'Watch',
    params: {}
  }, contextMenuCaller)
  assert.equal(started.success, true)
  assert.equal(service.taskCalls[0]?.method, 'callDllAsync')
  assert.equal(native.calls.length, 0)
  assert.equal(service.calls.length, 0)

  await dllPlugins.cancelTask({ plugin: 'ContextMenuPlugin', taskId: String(started.taskId) }, contextMenuCaller)
  const cancelAcknowledged = await dllPlugins.queryTask({
    plugin: 'ContextMenuPlugin', taskId: String(started.taskId)
  }, contextMenuCaller)
  assert.equal(cancelAcknowledged.taskDone, false)
  assert.equal(cancelAcknowledged.taskCancelRequested, true)

  service.taskStatus = 'completed'
  const terminal = await dllPlugins.queryTask({
    plugin: 'ContextMenuPlugin', taskId: String(started.taskId)
  }, contextMenuCaller)
  assert.equal(terminal.taskDone, true)
  await dllPlugins.stop()
})

test('service diagnostics details are not exposed through administrator DLL errors', windowsOnly, async () => {
  const { dllPlugins, service } = createHarness()
  service.diagnostics.state = 'closed'
  service.diagnostics.lastErrorMessage = 'socket failed at /Users/alice/private/secret-install-path'

  await assert.rejects(
    dllPlugins.call({
      plugin: 'ContextMenuPlugin',
      func: 'Execute',
      params: {}
    }, contextMenuCaller),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.serviceUnavailable &&
      error.message === 'ZToolsService 尚未认证' &&
      !error.message.includes('secret-install-path')
  )
  dllPlugins.stop()
})

test('callback task ids are translated and events stay scoped to the owning plugin', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness()
  assert.deepEqual(await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_external_1' }
  }, clipboardCaller), {
    success: true,
    taskId: 'callback_external_1'
  })

  native.emit({
    type: 'callback-result',
    pluginId: 'clipboard-manager',
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"queued","value":2}'
  })
  assert.deepEqual(events.published, [{
    type: 'dllplugin_callback_result',
    pluginId: 'clipboard-manager',
    owner: clipboardCaller,
    payload: {
      plugin: 'ClipboardManagerPlugin',
      taskId: 'callback_external_1',
      result: '{"type":"queued","value":2}'
    }
  }])

  assert.deepEqual(await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'callback_external_1'
  }, clipboardCaller), {
    success: true,
    queryOk: true,
    taskId: 'callback_external_1',
    pluginName: 'ClipboardManagerPlugin',
    funcName: 'Watch',
    taskDone: false,
    taskStatus: 'running',
    taskProgress: 35
  })
  assert.deepEqual(native.calls.at(-1), {
    method: 'queryDllTask',
    args: ['clipboard-manager', 'ClipboardManagerPlugin', 'task_native_callback']
  })

  await assert.rejects(
    dllPlugins.clearCallbackTask({ taskId: 'callback_external_1' }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.pluginBusy
  )
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed","data":{"value":2}}'
  })
  assert.deepEqual(await dllPlugins.clearCallbackTask({
    taskId: 'callback_external_1'
  }, clipboardCaller), { success: true })
  assert.deepEqual(native.calls.at(-1), {
    method: 'clearDllTask',
    args: ['clipboard-manager', 'ClipboardManagerPlugin', 'task_native_callback']
  })
  dllPlugins.stop()
})

test('callback progress does not complete tasks and accepted cancellation waits for terminal confirmation', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  const externalTaskId = 'callback_lifecycle_1'
  native.queryProgress = 0
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: externalTaskId }
  }, clipboardCaller)

  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: JSON.stringify({ type: 'progress', data: { progress: 0.25, status: 'completed' } })
  })
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: JSON.stringify({ type: 'progress', status: 'cancelled', data: { progress: 0.1 } })
  })
  const duringProgress = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller)
  assert.equal(duringProgress.taskStatus, 'running')
  assert.equal(duringProgress.taskDone, false)
  assert.equal(duringProgress.taskProgress, 25)

  native.emit({
    type: 'progress',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    percent: 80,
    message: 'high water mark'
  })
  native.emit({
    type: 'progress',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    percent: 20,
    message: 'out of order progress'
  })
  const afterOutOfOrderProgress = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller)
  assert.equal(afterOutOfOrderProgress.taskProgress, 80)

  assert.deepEqual(await dllPlugins.cancelTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller), { success: true })
  assert.deepEqual(await dllPlugins.cancelTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller), { success: true })
  const afterCancelRequest = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller)
  assert.equal(afterCancelRequest.taskStatus, 'running')
  assert.equal(afterCancelRequest.taskDone, false)
  assert.equal(afterCancelRequest.taskCancelRequested, true)
  assert.equal(native.calls.filter((call) => call.method === 'cancelDllTask').length, 1)

  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: JSON.stringify({ type: 'completed', data: { ok: true } })
  })
  native.emit({
    type: 'progress',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    percent: 82,
    message: 'late progress'
  })
  native.emit({
    type: 'cancelled',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    code: 0
  })
  native.emit({
    type: 'task-error',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    error: 'late error'
  })

  const queryCount = native.calls.filter((call) => call.method === 'queryDllTask').length
  const completed = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller)
  assert.equal(completed.taskStatus, 'completed')
  assert.equal(completed.taskDone, true)
  assert.equal(completed.taskProgress, 100)
  assert.deepEqual(completed.taskData, { type: 'completed', data: { ok: true } })
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask').length, queryCount)
  await dllPlugins.cancelTask({ plugin: 'ClipboardManagerPlugin', taskId: externalTaskId }, clipboardCaller)
  assert.equal(native.calls.filter((call) => call.method === 'cancelDllTask').length, 1)
  await dllPlugins.clearCallbackTask({ taskId: externalTaskId }, clipboardCaller)
  await dllPlugins.stop()
})

test('native callback events arriving before the task id response are replayed through the external id mapping', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness()
  const externalTaskId = 'callback_early_1'
  native.callbackStartHook = (taskId) => {
    native.emit({
      type: 'callback-result',
      pluginId: standardManifest.id,
      dllId: 'ClipboardManagerPlugin',
      taskId,
      result: JSON.stringify({ type: 'completed', data: { early: true } })
    })
  }

  assert.deepEqual(await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: externalTaskId }
  }, clipboardCaller), { success: true, taskId: externalTaskId })

  assert.equal(events.published.at(-1)?.type, 'dllplugin_callback_result')
  assert.deepEqual(events.published.at(-1)?.payload, {
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId,
    result: JSON.stringify({ type: 'completed', data: { early: true } })
  })
  assert.equal((await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: externalTaskId
  }, clipboardCaller)).taskStatus, 'completed')
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask').length, 0)
  await assert.rejects(
    dllPlugins.queryTask({
      plugin: 'ClipboardManagerPlugin',
      taskId: 'task_native_callback'
    }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await dllPlugins.clearCallbackTask({ taskId: externalTaskId }, clipboardCaller)
  await dllPlugins.stop()
})

test('callback start ack timeout keeps the external/native mapping until late acknowledgement', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness(undefined, { taskStartAckTimeoutMs: 20 })
  let releaseStart!: () => void
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })

  assert.deepEqual(await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_late_ack_1' }
  }, clipboardCaller), {
    success: true,
    taskId: 'callback_late_ack_1',
    taskStartPending: true
  })

  const pendingQuery = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'callback_late_ack_1'
  }, clipboardCaller)
  assert.equal(pendingQuery.taskStartPending, true)
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask').length, 0)
  await assert.rejects(
    dllPlugins.clearCallbackTask({ taskId: 'callback_late_ack_1' }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.pluginBusy
  )
  await assert.rejects(
    dllPlugins.callWithCallback({
      plugin: 'ClipboardManagerPlugin',
      func: 'Watch',
      params: { taskId: 'callback_late_ack_1' }
    }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.equal(native.calls.filter((call) => call.method === 'beginDllCallbackTask').length, 1)

  releaseStart()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const acknowledged = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'callback_late_ack_1'
  }, clipboardCaller)
  assert.equal(acknowledged.taskStartPending, undefined)
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask').length, 1)

  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed","data":{"lateAck":true}}'
  })
  assert.deepEqual(await dllPlugins.clearCallbackTask({ taskId: 'callback_late_ack_1' }, clipboardCaller), { success: true })
  await dllPlugins.stop()
})

test('late definitive no-start releases only its own callback mapping and notifies the SDK', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness(undefined, { taskStartAckTimeoutMs: 15 })
  let releaseStart!: () => void
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_no_start_late' }
  }, clipboardCaller)
  native.resolveCallbackStart('task_native_callback', {
    kind: 'not-started',
    error: Object.assign(new Error('blocked host rejected start'), { code: 'INVALID_REQUEST' })
  })
  await waitFor(() => events.published.some((event) =>
    event.type === 'dllplugin_callback_result' &&
    (event.payload as { taskId?: string; taskStartResolved?: string }).taskId === 'callback_no_start_late' &&
    (event.payload as { taskStartResolved?: string }).taskStartResolved === 'not-started'
  ))
  const noStartEvent = events.published.find((event) => event.type === 'dllplugin_callback_result')
  assert.deepEqual(noStartEvent?.payload, {
    plugin: 'ClipboardManagerPlugin',
    taskId: 'callback_no_start_late',
    error: 'blocked host rejected start',
    taskStartResolved: 'not-started',
    workNotStarted: true,
    code: 'INVALID_REQUEST'
  })

  await assert.rejects(
    dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: 'callback_no_start_late' }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.deepEqual(await dllPlugins.clearCallbackTask({ taskId: 'callback_no_start_late' }, clipboardCaller), { success: true })
  releaseStart()
  await dllPlugins.stop()
})

test('definitive no-start before the acknowledgement deadline returns a typed failure without retaining a task', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  native.callbackStartError = Object.assign(new Error('host rejected start'), { code: 'INVALID_REQUEST' })

  assert.deepEqual(await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_no_start_now' }
  }, clipboardCaller), {
    success: false,
    error: 'host rejected start',
    taskStartResolved: 'not-started',
    workNotStarted: true,
    code: 'INVALID_REQUEST'
  })
  assert.equal(native.calls.filter((call) => call.method === 'beginDllCallbackTask').length, 1)
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask').length, 0)
  assert.deepEqual(await dllPlugins.clearCallbackTask({ taskId: 'callback_no_start_now' }, clipboardCaller), { success: true })
  await dllPlugins.stop()
})

test('owner close records cancellation intent for an ack-unknown callback and cancels it once when ack arrives', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry, {
    taskStartAckTimeoutMs: 15,
    taskQuiesceTimeoutMs: 500,
    taskQuiescePollIntervalMs: 10
  })
  let releaseStart!: () => void
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })
  native.onCancelTask = (pluginId, dllId, taskId) => {
    native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
  }

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_close_unknown' }
  }, clipboardCaller)
  registry.remove(clipboardCaller.webContentsId)
  await new Promise<void>((resolve) => setTimeout(resolve, 25))
  assert.equal(native.calls.filter((call) => call.method === 'cancelDllTask').length, 0)

  releaseStart()
  await waitFor(() => native.calls.some((call) => call.method === 'clearDllTask'))
  assert.equal(native.calls.filter((call) => call.method === 'cancelDllTask').length, 1)
  assert.equal(native.calls.filter((call) => call.method === 'clearDllTask').length, 1)
  await dllPlugins.stop()
})

test('bounded service stop retains an unresolved start mapping and listener until Host exit confirms it', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness(undefined, {
    taskStartAckTimeoutMs: 10,
    taskQuiesceTimeoutMs: 80,
    taskQuiescePollIntervalMs: 10
  })
  let releaseStart!: () => void
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_stop_unknown' }
  }, clipboardCaller)

  const startedAt = Date.now()
  await dllPlugins.stop()
  assert.ok(Date.now() - startedAt >= 60)
  assert.equal(native.listenerBound, true)
  assert.equal(events.published.some((event) =>
    (event.payload as { taskId?: string }).taskId === 'callback_stop_unknown'
  ), false)

  events.publishError = new ZToolsError(errorCodes.appStopping, '事件服务已停止')
  native.resolveCallbackStart('task_native_callback', {
    kind: 'host-exited',
    error: new Error('host exited after shutdown deadline')
  })
  await waitFor(() => !native.listenerBound)
  assert.equal(events.published.some((event) =>
    event.type === 'dllplugin_progress' &&
    (event.payload as { taskId?: string; status?: string }).taskId === 'callback_stop_unknown' &&
    (event.payload as { status?: string }).status === 'error'
  ), false)
  releaseStart()
})

test('destroying one plugin window cancels only its tasks and stop drains the remaining task', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry)
  const secondCaller: CallerIdentity = {
    ...clipboardCaller,
    webContentsId: 23,
    pluginInstanceId: 'clipboard-2'
  }
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'window_task_1' }
  }, clipboardCaller)
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'window_task_2' }
  }, secondCaller)
  native.onCancelTask = (pluginId, dllId, taskId) => {
    native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
  }

  registry.remove(clipboardCaller.webContentsId)
  await waitFor(() => native.calls.some((call) =>
    call.method === 'clearDllTask' && call.args[2] === 'task_native_callback'
  ))
  assert.deepEqual(native.calls.filter((call) => call.method === 'cancelDllTask').map((call) => call.args[2]), [
    'task_native_callback'
  ])
  assert.equal((await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'window_task_2'
  }, secondCaller)).taskStatus, 'running')

  await dllPlugins.stop()
  assert.deepEqual(native.calls.filter((call) => call.method === 'cancelDllTask').map((call) => call.args[2]), [
    'task_native_callback',
    'task_native_callback_1'
  ])
  assert.equal(native.calls.filter((call) => call.method === 'clearDllTask').length, 2)
})

test('window removal during callback startup still cancels and clears after native id arrives', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry)
  let signalEntered!: () => void
  let releaseStart!: () => void
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })
  native.callbackStartHook = () => signalEntered()
  native.onCancelTask = (pluginId, dllId, taskId) => {
    native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
  }

  const start = dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'window_startup_task' }
  }, clipboardCaller)
  await entered
  registry.remove(clipboardCaller.webContentsId)
  releaseStart()

  assert.deepEqual(await start, { success: true, taskId: 'window_startup_task' })
  await waitFor(() => native.calls.some((call) => call.method === 'clearDllTask'))
  assert.deepEqual(native.calls.filter((call) => call.method === 'cancelDllTask').map((call) => call.args[2]), [
    'task_native_callback'
  ])
  assert.deepEqual(native.calls.filter((call) => call.method === 'clearDllTask').map((call) => call.args[2]), [
    'task_native_callback'
  ])
  await dllPlugins.stop()
})

test('window close retries a busy terminal clear when the native callback call later returns', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry)
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'window_busy_clear_task' }
  }, clipboardCaller)
  native.cancelCode = 1
  registry.remove(clipboardCaller.webContentsId)
  await waitFor(() => native.calls.some((call) => call.method === 'cancelDllTask'))

  native.clearError = new Error('DLL_BUSY')
  let releaseClear!: () => void
  native.clearGate = new Promise<void>((resolve) => { releaseClear = resolve })
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed","data":{"ok":true}}'
  })
  await waitFor(() => native.calls.some((call) => call.method === 'clearDllTask'))
  native.clearError = null
  native.emit({
    type: 'callback-return',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    call: { code: 0, result: null }
  })
  releaseClear()
  await waitFor(() => native.calls.filter((call) => call.method === 'clearDllTask').length >= 2)

  await assert.rejects(
    dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: 'window_busy_clear_task' }, clipboardCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await dllPlugins.stop()
})

test('window removal while resolving the manifest prevents a detached caller from starting a native task', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const manifests = new FakeManifestSource()
  const native = new FakeNativeHost()
  const service = new FakeServiceClient()
  const events = new FakeEvents()
  const dllPlugins = new DllPluginService(manifests, native, service, events, registry)
  let signalEntered!: () => void
  let releaseResolve!: () => void
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  manifests.manifestResolveGate = new Promise<void>((resolve) => { releaseResolve = resolve })
  manifests.onManifestResolve = () => signalEntered()

  const start = dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'manifest_startup_task' }
  }, clipboardCaller)
  await entered
  registry.remove(clipboardCaller.webContentsId)
  releaseResolve()

  await assert.rejects(
    start,
    (error) => error instanceof ZToolsError && error.code === errorCodes.appStopping
  )
  assert.equal(native.calls.filter((call) => call.method === 'beginDllCallbackTask').length, 0)
  await dllPlugins.stop()
})

test('task owner permission checks still reject a different plugin', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'owned_callback_task' }
  }, clipboardCaller)

  await assert.rejects(
    dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: 'owned_callback_task' }, contextMenuCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    dllPlugins.cancelTask({ plugin: 'ClipboardManagerPlugin', taskId: 'owned_callback_task' }, contextMenuCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask' || call.method === 'cancelDllTask').length, 0)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed"}'
  })
  await dllPlugins.clearCallbackTask({ taskId: 'owned_callback_task' }, clipboardCaller)
  await dllPlugins.stop()
})

test('same-plugin windows can reuse an external task id without sharing status, events, or close cleanup', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native, events } = createHarness(registry)
  const secondCaller: CallerIdentity = {
    ...clipboardCaller,
    webContentsId: 23,
    pluginInstanceId: 'clipboard-2'
  }
  let signalEntered!: () => void
  let releaseStart!: () => void
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })
  native.callbackStartHook = (taskId) => {
    if (taskId === 'task_native_callback') signalEntered()
  }

  const firstStart = dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'shared_external_task' }
  }, clipboardCaller)
  await entered

  assert.deepEqual(await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'shared_external_task' }
  }, secondCaller), { success: true, taskId: 'shared_external_task' })
  assert.equal(native.calls.filter((call) => call.method === 'beginDllCallbackTask').length, 2)

  releaseStart()
  assert.deepEqual(await firstStart, { success: true, taskId: 'shared_external_task' })
  native.emit({
    type: 'progress',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    percent: 20,
    message: 'first window'
  })
  native.emit({
    type: 'progress',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_1',
    percent: 80,
    message: 'second window'
  })

  const firstTask = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'shared_external_task'
  }, clipboardCaller)
  const secondTask = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'shared_external_task'
  }, secondCaller)
  assert.equal(firstTask.taskProgress, 35)
  assert.equal(secondTask.taskProgress, 80)
  const progressEvents = events.published.filter((event) => event.type === 'dllplugin_progress')
  assert.deepEqual(progressEvents.map((event) => event.owner.webContentsId), [
    clipboardCaller.webContentsId,
    secondCaller.webContentsId
  ])

  native.onCancelTask = (pluginId, dllId, taskId) => {
    native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
  }
  registry.remove(clipboardCaller.webContentsId)
  await waitFor(() => native.calls.some((call) =>
    call.method === 'clearDllTask' && call.args[2] === 'task_native_callback'
  ))
  assert.deepEqual(native.calls.filter((call) => call.method === 'cancelDllTask').map((call) => call.args[2]), [
    'task_native_callback'
  ])
  assert.equal((await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'shared_external_task'
  }, secondCaller)).taskStatus, 'running')
  assert.equal(native.calls.some((call) => call.method === 'clearDllTask' && call.args[2] === 'task_native_callback_1'), false)

  await dllPlugins.stop()
  assert.deepEqual(native.calls.filter((call) => call.method === 'cancelDllTask').map((call) => call.args[2]), [
    'task_native_callback',
    'task_native_callback_1'
  ])
})

test('same-plugin windows cannot query or cancel each other tasks and clear remains non-enumerable', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  const secondCaller: CallerIdentity = {
    ...clipboardCaller,
    webContentsId: 23,
    pluginInstanceId: 'clipboard-2'
  }
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'owner_only_task' }
  }, clipboardCaller)

  let unknownError: unknown
  await assert.rejects(
    dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: 'unknown_task' }, secondCaller),
    (error) => {
      unknownError = error
      return error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    }
  )
  let crossWindowError: unknown
  await assert.rejects(
    dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: 'owner_only_task' }, secondCaller),
    (error) => {
      crossWindowError = error
      return error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    }
  )
  assert.ok(unknownError instanceof ZToolsError)
  assert.ok(crossWindowError instanceof ZToolsError)
  assert.equal(crossWindowError.message, unknownError.message)

  const queryCount = native.calls.filter((call) => call.method === 'queryDllTask').length
  const cancelCount = native.calls.filter((call) => call.method === 'cancelDllTask').length
  const clearCount = native.calls.filter((call) => call.method === 'clearDllTask').length
  await assert.rejects(
    dllPlugins.cancelTask({ plugin: 'ClipboardManagerPlugin', taskId: 'owner_only_task' }, secondCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.deepEqual(await dllPlugins.clearCallbackTask({ taskId: 'owner_only_task' }, secondCaller), { success: true })
  assert.equal(native.calls.filter((call) => call.method === 'queryDllTask').length, queryCount)
  assert.equal(native.calls.filter((call) => call.method === 'cancelDllTask').length, cancelCount)
  assert.equal(native.calls.filter((call) => call.method === 'clearDllTask').length, clearCount)
  assert.equal((await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'owner_only_task'
  }, clipboardCaller)).taskStatus, 'running')

  native.onCancelTask = (pluginId, dllId, taskId) => {
    native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
  }
  await dllPlugins.cancelTask({ plugin: 'ClipboardManagerPlugin', taskId: 'owner_only_task' }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId: 'owner_only_task' }, clipboardCaller)
  await dllPlugins.stop()
})

test('a new plugin generation on the same WebContents id is independent of the removed owner cleanup', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry, {
    taskQuiesceTimeoutMs: 300,
    taskQuiescePollIntervalMs: 5
  })
  const nextGeneration: CallerIdentity = {
    ...clipboardCaller,
    pluginInstanceId: 'clipboard-next-generation'
  }
  const params = {
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'reused_external_task' }
  }

  await dllPlugins.callWithCallback(params, clipboardCaller)
  native.onCancelTask = (pluginId, dllId, taskId) => {
    if (taskId === 'task_native_callback') {
      native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
    }
  }
  registry.remove(clipboardCaller.webContentsId)

  assert.deepEqual(await dllPlugins.callWithCallback(params, nextGeneration), {
    success: true,
    taskId: 'reused_external_task'
  })
  assert.equal(native.calls.filter((call) => call.method === 'beginDllCallbackTask').length, 2)
  assert.equal((await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'reused_external_task'
  }, nextGeneration)).taskStatus, 'running')

  await waitFor(() => native.calls.some((call) =>
    call.method === 'clearDllTask' && call.args[2] === 'task_native_callback'
  ))
  assert.deepEqual(native.calls.filter((call) => call.method === 'cancelDllTask').map((call) => call.args[2]), [
    'task_native_callback'
  ])
  assert.equal(native.calls.some((call) =>
    call.method === 'clearDllTask' && call.args[2] === 'task_native_callback_1'
  ), false)
  assert.equal((await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin', taskId: 'reused_external_task'
  }, nextGeneration)).taskStatus, 'running')

  await dllPlugins.stop()
})

test('a failed native callback start releases its external task id reservation', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  native.callbackStartError = new Error('native start failed')
  const params = {
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'retryable_external_task' }
  }

  assert.deepEqual(await dllPlugins.callWithCallback(params, clipboardCaller), {
    success: false,
    error: 'native start failed',
    taskStartResolved: 'not-started',
    workNotStarted: true
  })
  assert.deepEqual(await dllPlugins.callWithCallback(params, clipboardCaller), {
    success: true,
    taskId: 'retryable_external_task'
  })
  assert.equal(native.calls.filter((call) => call.method === 'beginDllCallbackTask').length, 2)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_1',
    result: '{"type":"completed"}'
  })
  await dllPlugins.clearCallbackTask({ taskId: 'retryable_external_task' }, clipboardCaller)
  await dllPlugins.stop()
})

test('query terminal status can be enriched by the matching late result without changing status', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness()
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'query_before_result_task' }
  }, clipboardCaller)
  native.queryStatus = 'completed'
  native.queryResult = null

  const queried = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'query_before_result_task'
  }, clipboardCaller)
  assert.equal(queried.taskStatus, 'completed')
  assert.equal('taskData' in queried, false)

  const lateResult = JSON.stringify({ type: 'completed', data: { late: true } })
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: lateResult
  })
  const resultEventCount = events.published.filter((event) => event.type === 'dllplugin_callback_result').length
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed","data":{"late":false}}'
  })
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"cancelled"}'
  })
  const enriched = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'query_before_result_task'
  }, clipboardCaller)
  assert.equal(enriched.taskStatus, 'completed')
  assert.deepEqual(enriched.taskData, { type: 'completed', data: { late: true } })
  assert.equal(events.published.filter((event) => event.type === 'dllplugin_callback_result').length, resultEventCount)
  assert.deepEqual(events.published.at(-1)?.payload, {
    plugin: 'ClipboardManagerPlugin',
    taskId: 'query_before_result_task',
    result: lateResult
  })

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'query_cached_result_task' }
  }, clipboardCaller)
  native.queryResult = JSON.stringify({ type: 'completed', data: { fromQuery: true } })
  const cachedResult = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'query_cached_result_task'
  }, clipboardCaller)
  assert.equal(cachedResult.taskStatus, 'completed')
  assert.deepEqual(cachedResult.taskData, { type: 'completed', data: { fromQuery: true } })
  await dllPlugins.clearCallbackTask({ taskId: 'query_before_result_task' }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId: 'query_cached_result_task' }, clipboardCaller)
  await dllPlugins.stop()
})

test('error and cancellation query results retain terminal rows without changing the first terminal status', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness()
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'query_error_rows_task' }
  }, clipboardCaller)

  const errorEnvelope = {
    type: 'error',
    error: '任务处理失败',
    data: {
      success: false,
      results: [
        { file: 'E:/audio/existing.wav', success: false, error: 'output exists' },
        { file: 'E:/audio/new.wav', success: true, output: 'E:/out/new.mp3' }
      ]
    }
  }
  native.queryStatus = 'error'
  native.queryResult = JSON.stringify(errorEnvelope)
  const queriedError = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'query_error_rows_task'
  }, clipboardCaller)
  assert.equal(queriedError.taskStatus, 'error')
  assert.equal(queriedError.taskDone, true)
  assert.equal(queriedError.taskError, '任务处理失败')
  assert.deepEqual(queriedError.taskData, errorEnvelope)

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'late_error_rows_task' }
  }, clipboardCaller)
  native.queryResult = null
  const terminalWithoutRows = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'late_error_rows_task'
  }, clipboardCaller)
  assert.equal(terminalWithoutRows.taskStatus, 'error')
  assert.equal('taskData' in terminalWithoutRows, false)

  const lateErrorEnvelope = JSON.stringify(errorEnvelope)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_1',
    result: lateErrorEnvelope
  })
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_1',
    result: JSON.stringify({ type: 'completed', data: { conflicting: true } })
  })
  const lateErrorQuery = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'late_error_rows_task'
  }, clipboardCaller)
  assert.equal(lateErrorQuery.taskStatus, 'error')
  assert.deepEqual(lateErrorQuery.taskData, errorEnvelope)
  assert.equal(events.published.filter((event) =>
    event.type === 'dllplugin_callback_result' &&
    (event.payload as { taskId?: string }).taskId === 'late_error_rows_task'
  ).length, 1)

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'cancelled_rows_task' }
  }, clipboardCaller)
  const cancelledEnvelope = {
    type: 'cancelled',
    data: { results: [{ file: 'E:/audio/partial.wav', success: true, output: 'E:/out/partial.mp3' }] }
  }
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'cancelled_query_rows_task' }
  }, clipboardCaller)
  native.queryStatus = 'cancelled'
  native.queryResult = JSON.stringify(cancelledEnvelope)
  const cancelledQueryRows = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'cancelled_query_rows_task'
  }, clipboardCaller)
  assert.equal(cancelledQueryRows.taskStatus, 'cancelled')
  assert.deepEqual(cancelledQueryRows.taskData, cancelledEnvelope)

  native.queryStatus = 'error'
  native.queryResult = null
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_2',
    result: JSON.stringify(cancelledEnvelope)
  })
  const cancelledQuery = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'cancelled_rows_task'
  }, clipboardCaller)
  assert.equal(cancelledQuery.taskStatus, 'cancelled')
  assert.deepEqual(cancelledQuery.taskData, cancelledEnvelope)

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'callback_error_rows_task' }
  }, clipboardCaller)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_4',
    result: JSON.stringify(errorEnvelope)
  })
  const callbackErrorQuery = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'callback_error_rows_task'
  }, clipboardCaller)
  assert.equal(callbackErrorQuery.taskStatus, 'error')
  assert.deepEqual(callbackErrorQuery.taskData, errorEnvelope)
  assert.equal(callbackErrorQuery.taskError, '任务处理失败')

  await dllPlugins.clearCallbackTask({ taskId: 'query_error_rows_task' }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId: 'late_error_rows_task' }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId: 'cancelled_query_rows_task' }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId: 'cancelled_rows_task' }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId: 'callback_error_rows_task' }, clipboardCaller)
  await dllPlugins.stop()
})

test('legacy untyped callback result remains compatible while explicit unknown type stays running', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'legacy_untyped_result_task' }
  }, clipboardCaller)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback',
    result: '{"value":2}'
  })
  const completed = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'legacy_untyped_result_task'
  }, clipboardCaller)
  assert.equal(completed.taskStatus, 'completed')
  assert.deepEqual(completed.taskData, { value: 2 })
  await dllPlugins.clearCallbackTask({ taskId: 'legacy_untyped_result_task' }, clipboardCaller)

  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'unknown_typed_result_task' }
  }, clipboardCaller)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_1',
    result: '{"type":"queued","status":"completed","data":{"value":3}}'
  })
  const unknown = await dllPlugins.queryTask({
    plugin: 'ClipboardManagerPlugin',
    taskId: 'unknown_typed_result_task'
  }, clipboardCaller)
  assert.equal(unknown.taskStatus, 'running')
  assert.equal(unknown.taskDone, false)
  native.emit({
    type: 'callback-result',
    pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin',
    taskId: 'task_native_callback_1',
    result: '{"type":"completed"}'
  })
  await dllPlugins.clearCallbackTask({ taskId: 'unknown_typed_result_task' }, clipboardCaller)
  await dllPlugins.stop()
})

test('failed cancel and clear drain yields to native events and retains unconfirmed mappings', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness(undefined, {
    taskQuiesceTimeoutMs: 240,
    taskQuiescePollIntervalMs: 20
  })
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin',
    func: 'Watch',
    params: { taskId: 'busy_stop_task' }
  }, clipboardCaller)
  native.cancelCode = 1
  native.clearError = new Error('DLL_BUSY')

  let eventLoopContinued = false
  const startedAt = Date.now()
  setTimeout(() => {
    eventLoopContinued = true
    native.emit({
      type: 'callback-result',
      pluginId: standardManifest.id,
      dllId: 'ClipboardManagerPlugin',
      taskId: 'task_native_callback',
      result: '{"type":"completed","data":{"stopped":true}}'
    })
  }, 0)
  await dllPlugins.stop()
  const elapsedMs = Date.now() - startedAt

  assert.equal(eventLoopContinued, true)
  assert.ok(elapsedMs >= 200 && elapsedMs < 1_000, `unexpected drain duration: ${elapsedMs}ms`)
  assert.equal(native.listenerBound, true)
  assert.equal(events.published.some((event) =>
    event.type === 'dllplugin_callback_result' &&
    (event.payload as { taskId?: string }).taskId === 'busy_stop_task'
  ), true)
  assert.ok(native.calls.filter((call) => call.method === 'clearDllTask').length > 0)
  await new Promise<void>((resolve) => setTimeout(resolve, 60))
})

test('native rejection created at the stop deadline remains handled and retains its mapping', windowsOnly, async (context) => {
  const { dllPlugins, native } = createHarness(undefined, { taskQuiesceTimeoutMs: 20 })
  await dllPlugins.callWithCallback({
    plugin: 'ClipboardManagerPlugin', func: 'Watch', params: { taskId: 'expired_clear_rejection' }
  }, clipboardCaller)
  native.emit({ type: 'callback-result', pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin', taskId: 'task_native_callback',
    result: '{"type":"completed","data":{"stopped":true}}' })
  let clock = 1000
  let clearAttempts = 0
  context.mock.method(Date, 'now', () => clock)
  context.mock.method(native, 'clearDllTask', () => {
    clearAttempts += 1
    clock += 100
    return Promise.reject(new Error('DLL_BUSY_AT_DEADLINE'))
  })
  try {
    await dllPlugins.stop()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(clearAttempts, 1)
    assert.equal(native.listenerBound, true)
  } finally {
    context.mock.restoreAll()
  }
})

test('media calls across all native transports pass canonical caller-authorized paths', windowsOnly, async () => {
  const manifests = new FakeManifestSource()
  const mediaManifest: PluginManifest = {
    ...standardManifest,
    id: 'batch-audio',
    dllloader: 'lib/BatchAudioPlugin.dll'
  }
  manifests.manifests.set(mediaManifest.id, mediaManifest)
  const mediaCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 401,
    pluginId: mediaManifest.id,
    pluginInstanceId: 'media-401'
  }
  const canonical = (value: string) => `C:\\authorized\\${mediaCaller.webContentsId}\\${value}`
  const policy = new NativeMediaPathPolicy({
    async resolveAuthorizedPath(value, caller, access, allowMissing) {
      assert.equal(caller.webContentsId, mediaCaller.webContentsId)
      assert.equal(allowMissing, false)
      assert.equal(access, value === 'output' ? 'write' : 'read')
      return canonical(value)
    }
  }, [], {
    stat: async (target) => target === canonical('output')
      ? { size: 0, isFile: () => false, isDirectory: () => true }
      : { size: 64, isFile: () => true, isDirectory: () => false }
  })
  const native = new FakeNativeHost()
  const dllPlugins = new DllPluginService(
    manifests,
    native,
    new FakeServiceClient(),
    new FakeEvents(),
    undefined,
    undefined,
    policy
  )

  await dllPlugins.call({
    plugin: 'BatchAudioPlugin', func: 'GetFileInfo', params: { filePath: 'source.wav' }
  }, mediaCaller)
  assert.deepEqual(native.calls.find((call) => call.method === 'callDll')?.args, [
    mediaManifest.id,
    'BatchAudioPlugin',
    'GetFileInfo',
    { filePath: canonical('source.wav') }
  ])

  const asyncStarted = await dllPlugins.callAsync({
    plugin: 'BatchAudioPlugin', func: 'BatchDetectSilence', params: { files: ['source.wav'] }
  }, mediaCaller)
  const asyncArgs = native.calls.find((call) => call.method === 'beginDllAsyncTask')?.args
  assert.deepEqual(asyncArgs?.slice(0, 4), [
    mediaManifest.id,
    'BatchAudioPlugin',
    'BatchDetectSilence',
    { files: [canonical('source.wav')] }
  ])
  assert.equal(asyncStarted.taskId, native.assignedTaskIds[0])
  assert.match(String(native.assignedTaskIds[0]), /^task_[A-Za-z0-9_-]{1,123}$/)

  await dllPlugins.callWithCallback({
    plugin: 'BatchAudioPlugin',
    func: 'BatchConvertFormat',
    params: { taskId: 'media_callback_task', files: ['source.wav'], outputDir: 'output' }
  }, mediaCaller)
  const callbackArgs = native.calls.find((call) => call.method === 'beginDllCallbackTask')?.args
  assert.deepEqual(callbackArgs?.slice(0, 4), [
    mediaManifest.id,
    'BatchAudioPlugin',
    'BatchConvertFormat',
    {
      taskId: 'media_callback_task',
      files: [canonical('source.wav')],
      outputDir: canonical('output')
    }
  ])
  assert.match(String(callbackArgs?.at(-1)), /^task_[A-Za-z0-9_-]{1,123}$/)

  await assert.rejects(
    dllPlugins.call({ plugin: 'BatchAudioPlugin', func: 'UnknownMediaMethod', params: {} }, mediaCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.methodNotFound
  )
  assert.equal(native.calls.some((call) => call.args[2] === 'UnknownMediaMethod'), false)

  native.queryStatus = 'completed'
  await dllPlugins.queryTask({ plugin: 'BatchAudioPlugin', taskId: String(asyncStarted.taskId) }, mediaCaller)
  await dllPlugins.clearCallbackTask({ taskId: String(asyncStarted.taskId) }, mediaCaller)
  native.emit({
    type: 'callback-result',
    pluginId: mediaManifest.id,
    dllId: 'BatchAudioPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed"}'
  })
  await dllPlugins.clearCallbackTask({ taskId: 'media_callback_task' }, mediaCaller)
  await dllPlugins.stop()
})

test('watermark presets are caller-scoped DB data and callback save never reaches DLL CWD', windowsOnly, async () => {
  const manifests = new FakeManifestSource()
  const mediaManifest: PluginManifest = {
    ...standardManifest,
    id: 'batch-video',
    dllloader: 'lib/BatchVideoPlugin.dll'
  }
  manifests.manifests.set(mediaManifest.id, mediaManifest)
  const mediaCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 451,
    pluginId: mediaManifest.id,
    pluginInstanceId: 'video-1'
  }
  const canonical = (value: string) => `C:\\authorized\\${mediaCaller.webContentsId}\\${value}`
  const policy = new NativeMediaPathPolicy({
    async resolveAuthorizedPath(value, caller, access, allowMissing) {
      assert.equal(caller.webContentsId, mediaCaller.webContentsId)
      assert.equal(allowMissing, false)
      assert.equal(access, value === 'output' ? 'write' : 'read')
      return canonical(value)
    }
  }, [], {
    stat: async (target) => target === canonical('output')
      ? { size: 0, isFile: () => false, isDirectory: () => true }
      : { size: 32, isFile: () => true, isDirectory: () => false }
  })
  const native = new FakeNativeHost()
  const database = new FakeWatermarkSettingsDatabase()
  const events = new FakeEvents()
  let releaseStart!: () => void
  native.callbackStartGate = new Promise<void>((resolve) => { releaseStart = resolve })
  const dllPlugins = new DllPluginService(
    manifests,
    native,
    new FakeServiceClient(),
    events,
    undefined,
    { taskStartAckTimeoutMs: 15 },
    policy,
    database
  )
  const expectedSettings = {
    watermarkType: 'text',
    text: 'safe watermark',
    opacity: 0,
    x: 0,
    dynamicLoop: false
  }

  assert.deepEqual(await dllPlugins.call({
    plugin: 'BatchVideoPlugin',
    func: 'SaveWatermarkSettings',
    params: expectedSettings
  }, mediaCaller), {
    success: true,
    data: { success: true, message: '水印设置已保存', settings: expectedSettings }
  })
  assert.deepEqual(database.writes[0], {
    params: {
      plugin_id: mediaManifest.id,
      key: 'dllplugin.watermark-settings.v1',
      value: expectedSettings,
      is_base64: false
    },
    caller: mediaCaller
  })
  assert.deepEqual(await dllPlugins.call({
    plugin: 'BatchVideoPlugin',
    func: 'LoadWatermarkSettings',
    params: {}
  }, mediaCaller), {
    success: true,
    data: { success: true, message: '水印设置已加载', settings: expectedSettings }
  })

  await assert.rejects(
    dllPlugins.call({
      plugin: 'BatchVideoPlugin',
      func: 'SaveWatermarkSettings',
      params: { ...expectedSettings, watermarkFile: 'not-authorized.png' }
    }, mediaCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.equal(database.writes.length, 1)

  const start = await dllPlugins.callWithCallback({
    plugin: 'BatchVideoPlugin',
    func: 'BatchAddWatermark',
    params: {
      taskId: 'video_watermark_task',
      files: ['input.mp4'],
      outputDir: 'output',
      ...expectedSettings,
      saveSettings: true
    }
  }, mediaCaller)
  assert.deepEqual(start, {
    success: true,
    taskId: 'video_watermark_task',
    taskStartPending: true,
    settingsSavedPending: true
  })
  const nativeParams = native.calls.find((call) => call.method === 'beginDllCallbackTask')?.args[3] as Record<string, unknown>
  assert.equal(nativeParams.saveSettings, false)
  assert.equal(database.writes.length, 1, 'watermark settings must wait for positive start acknowledgement')
  releaseStart()
  await waitFor(() => events.published.some((event) =>
    event.type === 'dllplugin_progress' &&
    (event.payload as { taskId?: string; settingsSaved?: boolean }).taskId === 'video_watermark_task' &&
    (event.payload as { settingsSaved?: boolean }).settingsSaved === true
  ))
  assert.deepEqual(database.writes[1]?.params.value, expectedSettings)
  assert.equal(Object.hasOwn(database.writes[1]?.params.value as object, 'files'), false)
  assert.equal(Object.hasOwn(database.writes[1]?.params.value as object, 'outputDir'), false)
  assert.equal(Object.hasOwn(database.writes[1]?.params.value as object, 'taskId'), false)

  await assert.rejects(
    dllPlugins.call({ plugin: 'BatchVideoPlugin', func: 'LoadWatermarkSettings', params: {} }, contextMenuCaller),
    (error) => error instanceof ZToolsError
  )
  assert.equal(database.writes.length, 2)

  native.emit({
    type: 'callback-result',
    pluginId: mediaManifest.id,
    dllId: 'BatchVideoPlugin',
    taskId: 'task_native_callback',
    result: '{"type":"completed"}'
  })
  await dllPlugins.clearCallbackTask({ taskId: 'video_watermark_task' }, mediaCaller)
  await dllPlugins.stop()
})

test('closing a caller during path authorization prevents all native call modes from dispatching', windowsOnly, async () => {
  for (const mode of ['call', 'async', 'callback'] as const) {
    const manifests = new FakeManifestSource()
    const mediaManifest: PluginManifest = {
      ...standardManifest,
      id: 'batch-audio',
      dllloader: 'lib/BatchAudioPlugin.dll'
    }
    manifests.manifests.set(mediaManifest.id, mediaManifest)
    const mediaCaller: CallerIdentity = {
      type: 'plugin',
      webContentsId: 402 + ['call', 'async', 'callback'].indexOf(mode),
      pluginId: mediaManifest.id,
      pluginInstanceId: `media-${mode}`
    }
    const registry = new FakeWindowRegistry()
    let enteredResolve!: () => void
    let authorizeResolve!: () => void
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
    const authorizationGate = new Promise<void>((resolve) => { authorizeResolve = resolve })
    const policy = new NativeMediaPathPolicy({
      async resolveAuthorizedPath(value) {
        enteredResolve()
        await authorizationGate
        return `C:\\authorized\\${mediaCaller.webContentsId}\\${value}`
      }
    }, [], {
      stat: async () => ({ size: 1, isFile: () => true, isDirectory: () => false })
    })
    const native = new FakeNativeHost()
    const dllPlugins = new DllPluginService(
      manifests,
      native,
      new FakeServiceClient(),
      new FakeEvents(),
      registry,
      undefined,
      policy
    )
    const params = {
      plugin: 'BatchAudioPlugin',
      func: 'BatchDetectSilence',
      params: { files: ['source.wav'], ...(mode === 'callback' ? { taskId: `${mode}_task` } : {}) }
    }
    const call = mode === 'call'
      ? dllPlugins.call(params, mediaCaller)
      : mode === 'async'
        ? dllPlugins.callAsync(params, mediaCaller)
        : dllPlugins.callWithCallback(params, mediaCaller)

    await entered
    registry.remove(mediaCaller.webContentsId)
    authorizeResolve()

    await assert.rejects(
      call,
      (error) => error instanceof ZToolsError && error.code === errorCodes.appStopping
    )
    assert.equal(native.calls.length, 0, `${mode} dispatched after caller removal`)
    await dllPlugins.stop()
  }
})

test('native identity is Main-owned, stable for an instance, and renewed after owner removal', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry)
  const params = { plugin: 'ClipboardManagerPlugin', func: 'Echo', params: { ownerToken: '7', generation: '8' } }
  await dllPlugins.call(params, clipboardCaller)
  await dllPlugins.list(clipboardCaller)
  await dllPlugins.call(params, clipboardCaller)
  const contexts = native.invocationContexts.map((item) => item.context)
  assert.ok(contexts.length >= 3)
  assert.strictEqual(contexts[0], contexts[1])
  assert.strictEqual(contexts[0], contexts[2])
  assert.match(contexts[0]!.ownerToken, /^[1-9][0-9]*$/)
  assert.notEqual(contexts[0]!.ownerToken, '7')
  assert.equal(contexts[0]!.generation, '1')
  assert.equal(contexts[0]!.pluginInstanceId, clipboardCaller.pluginInstanceId)
  assert.equal(contexts[0]!.webContentsId, clipboardCaller.webContentsId)
  assert.equal(Object.isFrozen(contexts[0]), true)
  registry.remove(clipboardCaller.webContentsId)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(native.releasedOwners, [contexts[0]])
  await dllPlugins.call(params, { ...clipboardCaller, pluginInstanceId: 'clipboard-2' })
  const renewed = native.invocationContexts.at(-1)!.context
  assert.notEqual(renewed.ownerToken, contexts[0]!.ownerToken)
  assert.equal(renewed.generation, '2')
  await dllPlugins.stop()
  assert.deepEqual(native.releasedOwners, [contexts[0], renewed])
})

test('query cancel and clear retain the original task native owner context', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  const started = await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  const taskId = String(started.taskId)
  await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  await dllPlugins.cancelTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  native.queryStatus = 'cancelled'
  await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  await dllPlugins.clearCallbackTask({ taskId }, clipboardCaller)
  assert.deepEqual(native.invocationContexts.map((item) => item.method), ['beginDllAsyncTask', 'queryDllTask', 'cancelDllTask', 'queryDllTask', 'clearDllTask'])
  for (const { context } of native.invocationContexts) assert.strictEqual(context, native.invocationContexts[0]!.context)
  await dllPlugins.stop()
  assert.strictEqual(native.releasedOwners[0], native.invocationContexts[0]!.context)
})

test('Mac calls and list use only resolved target component ids with exact owner/case', async () => {
  const manifest: PluginManifest = { ...standardManifest, id: 'mac-plugin', dllloader: '', requireAdmin: false }
  const component = { id: 'native-test', kind: 'shared-library', targetId: 'mac-universal', arch: 'universal',
    abi: 'ztools-mac-native/v1', protocolVersion: 1, entry: 'lib/native-test.dylib' } as const
  let metadata: PluginManifestRuntimeMetadata | undefined = { sdkApiLane: 1, macNativeComponents: [component] }
  const manifests = {
    async list() { return { success: true as const, data: [manifest] } },
    async withPluginManifest<T>(_id: string, action: (value: PluginManifest, metadata?: PluginManifestRuntimeMetadata) => Promise<T>) {
      return action(manifest, metadata)
    }
  }
  const native = new FakeNativeHost()
  const service = new DllPluginService(manifests, native, null, new FakeEvents(), undefined, undefined, undefined, undefined, 'darwin')
  const caller: CallerIdentity = { type: 'plugin', webContentsId: 821, pluginId: manifest.id,
    pluginInstanceId: '411f6d1b-fbf9-4707-8b64-4b612f58ba1c' }
  try {
    const list = await service.list(caller)
    assert.equal(list.count, 1)
    assert.equal(list.plugins[0]?.id, component.id)
    await service.call({ plugin: component.id, func: 'Echo', params: {} }, caller)
    assert.deepEqual(native.calls.filter(value => value.method === 'callDll')[0]?.args.slice(0, 2), [manifest.id, component.id])
    await assert.rejects(service.call({ plugin: 'Native-test', func: 'Echo', params: {} }, caller), { code: errorCodes.pluginNotFound })
    await assert.rejects(service.call({ plugin: 'ClipboardManagerPlugin', func: 'Echo', params: {} }, caller), { code: errorCodes.pluginNotFound })
    metadata = undefined
    assert.equal((await service.list(caller)).count, 0)
    await assert.rejects(service.call({ plugin: component.id, func: 'Echo', params: {} }, caller), { code: errorCodes.pluginNotFound })
  } finally { await service.stop() }
})

test('Mac rejects legacy and administrator native manifests without native fallback', async () => {
  for (const manifest of [standardManifest, adminManifest]) {
    const native = new FakeNativeHost(), source = new FakeManifestSource()
    const service = new DllPluginService(source, native, new FakeServiceClient(), new FakeEvents(), undefined, undefined, undefined, undefined, 'darwin')
    try {
      const caller = manifest.requireAdmin ? contextMenuCaller : clipboardCaller
      await assert.rejects(service.call({ plugin: 'ClipboardManagerPlugin', func: 'Echo', params: {} }, caller), { code: errorCodes.notSupported })
      assert.equal(native.calls.length, 0)
      assert.equal((await service.list(caller)).count, 0)
    } finally { await service.stop() }
  }
})

test('ordinary late ACK is retained and ordinary no-start remains queryable without native clear', windowsOnly, async () => {
  const { dllPlugins, native, events } = createHarness(undefined, { taskStartAckTimeoutMs: 10 })
  let release!: () => void
  native.asyncStartGate = new Promise<void>(resolve => { release = resolve })
  const started = await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  const taskId = String(started.taskId)
  assert.equal(started.taskStartPending, true)
  const pending = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  assert.equal(pending.taskStartPending, true)
  assert.equal(native.calls.filter(call => call.method === 'queryDllTask').length, 0)
  native.resolveAsyncStart('task_native_async', { kind: 'not-started',
    error: Object.assign(new Error('explicit pre-worker rejection'), { code: 'PERMISSION_DENIED' }) })
  await waitFor(() => events.published.some(event => (event.payload as { workNotStarted?: boolean }).workNotStarted === true))
  const terminal = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId }, clipboardCaller)
  assert.equal(terminal.taskDone, true); assert.equal(terminal.taskStatus, 'error')
  assert.equal(terminal.workNotStarted, true); assert.equal(terminal.code, 'PERMISSION_DENIED')
  assert.equal(terminal.taskStartPending, undefined)
  await dllPlugins.clearCallbackTask({ taskId }, clipboardCaller)
  assert.equal(native.calls.filter(call => call.method === 'clearDllTask').length, 0)
  release(); await dllPlugins.stop()
})

test('ordinary immediate no-start returns typed failure and no native task cleanup', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness()
  native.asyncDefinitiveStartError = Object.assign(new Error('before worker'), { code: 'INVALID_REQUEST' })
  const result = await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  assert.deepEqual(result, { success: false, error: 'before worker', taskStartResolved: 'not-started',
    workNotStarted: true, code: 'INVALID_REQUEST' })
  await dllPlugins.stop()
  assert.equal(native.calls.filter(call => call.method === 'clearDllTask' || call.method === 'cancelDllTask').length, 0)
})

test('ordinary event before ACK keeps its completed state after contradictory no-start', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness(undefined, { taskStartAckTimeoutMs: 10 })
  native.asyncStartError = new Error('lost acknowledgement')
  native.asyncStartHook = taskId => native.emit({ type: 'async-return', pluginId: standardManifest.id,
    dllId: 'ClipboardManagerPlugin', taskId, call: { code: 0, result: '{"done":true}' } })
  const result = await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  native.resolveAsyncStart('task_native_async', { kind: 'not-started', error: new Error('contradictory rejection') })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const terminal = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: String(result.taskId) }, clipboardCaller)
  assert.equal(terminal.taskStatus, 'completed'); assert.equal(terminal.workNotStarted, undefined)
  await dllPlugins.clearCallbackTask({ taskId: String(result.taskId) }, clipboardCaller); await dllPlugins.stop()
})

test('ordinary owner close before late ACK cancels once then clears only after terminal evidence', windowsOnly, async () => {
  const registry = new FakeWindowRegistry()
  const { dllPlugins, native } = createHarness(registry, { taskStartAckTimeoutMs: 10,
    taskQuiesceTimeoutMs: 35, taskQuiescePollIntervalMs: 5 })
  native.asyncStartError = new Error('lost acknowledgement')
  await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  registry.remove(clipboardCaller.webContentsId)
  await new Promise<void>(resolve => setTimeout(resolve, 45))
  assert.equal(native.calls.some(call => call.method === 'cancelDllTask' || call.method === 'clearDllTask'), false)
  native.onCancelTask = (pluginId, dllId, taskId) => native.emit({ type: 'cancelled', pluginId, dllId, taskId, code: 0 })
  native.resolveAsyncStart('task_native_async', { kind: 'started' })
  await waitFor(() => native.calls.some(call => call.method === 'clearDllTask'))
  assert.equal(native.calls.filter(call => call.method === 'cancelDllTask').length, 1)
  assert.equal(native.calls.filter(call => call.method === 'clearDllTask').length, 1)
  await dllPlugins.stop()
})

test('ordinary Host exit closes unknown start without claiming unexecuted work or issuing native clear', windowsOnly, async () => {
  const { dllPlugins, native } = createHarness(undefined, { taskStartAckTimeoutMs: 10 })
  native.asyncStartError = new Error('lost acknowledgement')
  const started = await dllPlugins.callAsync({ plugin: 'ClipboardManagerPlugin', func: 'Watch', params: {} }, clipboardCaller)
  native.resolveAsyncStart('task_native_async', { kind: 'host-exited', error: new Error('child exited') })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const terminal = await dllPlugins.queryTask({ plugin: 'ClipboardManagerPlugin', taskId: String(started.taskId) }, clipboardCaller)
  assert.equal(terminal.workOutcome, 'unknown'); assert.equal(terminal.noReplay, true)
  assert.equal(terminal.workNotStarted, undefined); assert.equal(terminal.taskStatus, 'error')
  await dllPlugins.clearCallbackTask({ taskId: String(started.taskId) }, clipboardCaller)
  assert.equal(native.calls.some(call => call.method === 'clearDllTask'), false)
  await dllPlugins.stop()
})
