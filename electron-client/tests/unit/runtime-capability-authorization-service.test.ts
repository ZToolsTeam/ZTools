import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  RuntimeCapabilityAuthorizationService,
  type RuntimeCapabilityPromptPort
} from '../../src/main/services/runtime-capability-authorization-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = {
  type: 'plugin', webContentsId: 2, pluginId: 'sample-plugin', pluginInstanceId: 'sample-instance'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

class FakeRegistry {
  readonly owners = new Map<number, CallerIdentity>()
  readonly contents = new Map<number, { isDestroyed(): boolean }>()
  readonly #listeners = new Set<(id: number) => void>()

  add(owner: CallerIdentity): void {
    this.owners.set(owner.webContentsId, { ...owner })
    this.contents.set(owner.webContentsId, { isDestroyed: () => false })
  }

  get = (id: number): CallerIdentity | undefined => this.owners.get(id)
  getWebContents = (id: number): object | undefined => this.contents.get(id)
  onRemoved = (listener: (id: number) => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  remove(id: number): void {
    this.owners.delete(id)
    this.contents.delete(id)
    for (const listener of this.#listeners) listener(id)
  }
}

class FakePrompt implements RuntimeCapabilityPromptPort {
  readonly requests: Array<{
    owner: CallerIdentity
    pluginName: string
    signal: AbortSignal
    answer: (allowed: boolean) => void
  }> = []
  readonly cancelledOwners: CallerIdentity[] = []
  stopped = false

  request(owner: CallerIdentity, pluginName: string, signal: AbortSignal): Promise<boolean> {
    const result = deferred<boolean>()
    const entry = { owner: { ...owner }, pluginName, signal, answer: result.resolve }
    this.requests.push(entry)
    const abort = () => result.resolve(false)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return result.promise
  }

  cancelOwner(owner: CallerIdentity): void { this.cancelledOwners.push({ ...owner }) }
  stop(): void { this.stopped = true }
}

function setup(options: ConstructorParameters<typeof RuntimeCapabilityAuthorizationService>[2] = {}) {
  const registry = new FakeRegistry()
  registry.add(mainCaller)
  registry.add(pluginCaller)
  const prompt = new FakePrompt()
  const service = new RuntimeCapabilityAuthorizationService(
    registry as unknown as WindowRegistry,
    prompt,
    options
  )
  return { registry, prompt, service }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(predicate(), true, 'condition was not met before timeout')
}

test('same-instance request coalesces, denial persists, and explicit request can retry', async () => {
  const { prompt, service } = setup({ resolvePluginName: async () => 'Sample Plugin' })
  const first = service.requestCapability('screen.capture', pluginCaller)
  const second = service.requestCapability('screen.capture', pluginCaller)
  await waitFor(() => prompt.requests.length === 1)
  assert.equal(prompt.requests[0]?.pluginName, 'Sample Plugin')
  prompt.requests[0]!.answer(false)
  assert.deepEqual(await Promise.all([first, second]), ['denied', 'denied'])
  assert.equal(service.getAuthorizationStatus('screen.capture', pluginCaller), 'denied')
  assert.throws(
    () => service.beginOperation('screen.capture', pluginCaller),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  assert.equal(prompt.requests.length, 1, 'capture gate does not create another prompt after denial')

  const retry = service.requestCapability('screen.capture', pluginCaller)
  await waitFor(() => prompt.requests.length === 2)
  prompt.requests[1]!.answer(true)
  assert.equal(await retry, 'granted')
  assert.equal(service.getAuthorizationStatus('screen.capture', pluginCaller), 'granted')
  await service.stop()
})

test('aborting one merged waiter leaves the other request alive', async () => {
  const { prompt, service } = setup()
  const cancelled = new AbortController()
  const first = service.requestCapability('screen.capture', pluginCaller, cancelled.signal)
  const second = service.requestCapability('screen.capture', pluginCaller)
  await waitFor(() => prompt.requests.length === 1)
  cancelled.abort(errorCodes.requestTimeout)
  await assert.rejects(first, { code: errorCodes.requestTimeout })
  assert.equal(prompt.requests[0]?.signal.aborted, false)
  prompt.requests[0]!.answer(true)
  assert.equal(await second, 'granted')
  await service.stop()
})

test('last waiter cancellation blocks a late plugin-name result from opening a prompt', async () => {
  const name = deferred<string>()
  const { prompt, service } = setup({ resolvePluginName: () => name.promise })
  const cancelled = new AbortController()
  const request = service.requestCapability('screen.capture', pluginCaller, cancelled.signal)
  cancelled.abort(errorCodes.requestTimeout)
  await assert.rejects(request, { code: errorCodes.requestTimeout })
  name.resolve('Late Name')
  await waitFor(() => service.getAuthorizationStatus('screen.capture', pluginCaller) === 'not-requested')
  assert.equal(prompt.requests.length, 0)
  await service.stop()
})

test('pre-aborted request creates neither plugin-name lookup nor prompt', async () => {
  let nameLookups = 0
  const { prompt, service } = setup({ resolvePluginName: async () => { nameLookups += 1; return 'Sample' } })
  const controller = new AbortController()
  controller.abort(errorCodes.requestTimeout)
  await assert.rejects(service.requestCapability('screen.capture', pluginCaller, controller.signal), {
    code: errorCodes.requestTimeout
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(nameLookups, 0)
  assert.equal(prompt.requests.length, 0)
  await service.stop()
})

test('Main grant management validates the live Main identity and revocation aborts active leases', async () => {
  const { registry, prompt, service } = setup()
  assert.equal(service.getAuthorizationStatus('screen.capture', mainCaller), 'granted',
    'a verified Main caller retains access to controlled capture without a plugin grant')
  const request = service.requestCapability('screen.capture', pluginCaller)
  await waitFor(() => prompt.requests.length === 1)
  prompt.requests[0]!.answer(true)
  assert.equal(await request, 'granted')

  const lease = service.beginOperation('screen.capture', pluginCaller)!
  assert.equal(lease.signal.aborted, false)
  const [grant] = service.listGrants(mainCaller)
  assert.ok(grant?.grantId)
  assert.deepEqual(service.revokeGrant(grant!.grantId, mainCaller), { success: true, revoked: true })
  assert.equal(lease.signal.aborted, true)
  assert.throws(() => lease.assertCurrent(), { code: errorCodes.permissionDenied })
  lease.release()
  assert.equal(service.getAuthorizationStatus('screen.capture', pluginCaller), 'denied')
  assert.throws(() => service.listGrants(pluginCaller), { code: errorCodes.permissionDenied })
  assert.throws(() => service.beginOperation('screen.capture', { type: 'main', webContentsId: 999 }), {
    code: errorCodes.permissionDenied
  })
  assert.equal(service.getAuthorizationStatus('screen.capture', { ...mainCaller, webContentsId: 999 }), 'denied')

  registry.remove(pluginCaller.webContentsId)
  assert.deepEqual(service.listGrants(mainCaller), [])
  await service.stop()
})

test('owner closure cancels its pending prompt and removes its authorization state', async () => {
  const { registry, prompt, service } = setup()
  const request = service.requestCapability('screen.capture', pluginCaller)
  await waitFor(() => prompt.requests.length === 1)
  registry.remove(pluginCaller.webContentsId)
  await assert.rejects(request, { code: errorCodes.callerDestroyed })
  assert.equal(prompt.requests[0]?.signal.aborted, true)
  assert.equal(prompt.cancelledOwners.length, 1)
  await service.stop()
})

test('stop clears grants, aborts pending work, and status queries do not recreate state', async () => {
  const { prompt, service } = setup()
  const request = service.requestCapability('screen.capture', pluginCaller)
  await waitFor(() => prompt.requests.length === 1)
  await service.stop()
  await assert.rejects(request, { code: errorCodes.appStopping })
  assert.equal(prompt.stopped, true)
  assert.equal(service.getAuthorizationStatus('screen.capture', pluginCaller), 'unknown')
})
