import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { awaitPublicPluginInstall, awaitPublicPluginUpdateFailure, publicPluginInstallExpression,
  publicPluginUpdateFailureExpression } from './normal-app-plugin-install.mjs'

function fixture(install) {
  const handlers = new Set(), timers = new Set()
  let unsubscribed = 0
  const events = {
    on: (_, handler) => handlers.add(handler), off: (_, handler) => handlers.delete(handler),
    subscribe: async () => ({ success: true }),
    unsubscribe: async () => { unsubscribed++; return { success: true } }
  }
  const emit = payload => { for (const handler of handlers) handler({ payload }) }
  const request = { pluginId: 'memo', zipUrl: 'http://127.0.0.1:3333/memo.zip',
    options: { version: '1.2.1', checksum: 'a'.repeat(64), fileSize: 42 },
    expectedIsUpdate: true, timeoutMs: 1000, events,
    clock: { setTimeout: callback => { timers.add(callback); return callback }, clearTimeout: id => timers.delete(id) },
    plugin: { install: (...args) => install({ emit, fireTimeout: () => [...timers].forEach(fn => fn()), args }) }
  }
  return { request, clean: () => { assert.equal(handlers.size, 0); assert.equal(timers.size, 0) },
    unsubscribed: () => unsubscribed }
}

function updateFixture(downloadPlugin) {
  const handlers = new Set(), timers = new Set()
  let unsubscribed = 0
  const events = {
    on: (_, handler) => handlers.add(handler), off: (_, handler) => handlers.delete(handler),
    subscribe: async () => ({ success: true }),
    unsubscribe: async () => { unsubscribed++; return { success: true } }
  }
  const emit = payload => { for (const handler of handlers) handler({ payload }) }
  const request = { pluginId: 'memo', info: { downloadUrl: 'http://127.0.0.1:3333/update.zip',
    version: '1.2.2', checksum: 'b'.repeat(64), fileSize: 84 }, expectedErrorCode: 'NOT_SUPPORTED', timeoutMs: 1000,
    events, update: { downloadPlugin: (...args) => downloadPlugin({ emit, args, fireTimeout: () => [...timers].forEach(fn => fn()) }) },
    clock: { setTimeout: callback => { timers.add(callback); return callback }, clearTimeout: id => timers.delete(id) } }
  return { request, clean: () => { assert.equal(handlers.size, 0); assert.equal(timers.size, 0) },
    unsubscribed: () => unsubscribed }
}

const accepted = { success: true, operationId: 'expected-id', isUpdate: true }
const completion = { pluginId: 'memo', operationId: 'expected-id', success: true, isUpdate: true, version: '1.2.1' }

test('early completion is buffered, unrelated operations are ignored, and subscriptions are paired', async () => {
  const f = fixture(({ emit }) => {
    emit({ ...completion, operationId: 'unrelated-id', success: false })
    emit(completion)
    return accepted
  })
  assert.deepEqual(await awaitPublicPluginInstall(f.request), { accepted, completion })
  f.clean(); assert.equal(f.unsubscribed(), 1)
})

test('failed terminal and invalid acceptance reject without leaking timers or handlers', async () => {
  for (const failure of ['terminal', 'acceptance', 'throw']) {
    const f = fixture(({ emit }) => {
      if (failure === 'throw') throw new Error('controlled install rejection')
      emit({ ...completion, success: false })
      return failure === 'acceptance' ? { success: false } : accepted
    })
    await assert.rejects(awaitPublicPluginInstall(f.request), /PLUGIN_INSTALL_|controlled install rejection/)
    f.clean(); assert.equal(f.unsubscribed(), 1)
  }
})

test('missing completion has a bounded timeout and wrong operation cannot satisfy it', async () => {
  const f = fixture(({ emit, fireTimeout }) => { emit({ ...completion, operationId: 'wrong' }); fireTimeout(); return accepted })
  await assert.rejects(awaitPublicPluginInstall(f.request), { message: 'PLUGIN_INSTALL_COMPLETION_TIMEOUT' })
  f.clean()
})

test('an installation that never acknowledges is bounded and the listener is removed', async () => {
  const f = fixture(({ fireTimeout }) => { fireTimeout(); return new Promise(() => {}) })
  await assert.rejects(awaitPublicPluginInstall(f.request), { message: 'PLUGIN_INSTALL_COMPLETION_TIMEOUT' })
  f.clean(); assert.equal(f.unsubscribed(), 1)
})

test('event subscription failure cleans up before any install is attempted', async () => {
  let installs = 0
  const f = fixture(() => { installs++; return accepted })
  f.request.events.subscribe = async () => ({ success: false })
  await assert.rejects(awaitPublicPluginInstall(f.request), { message: 'PLUGIN_INSTALL_EVENT_SUBSCRIBE_FAILED' })
  assert.equal(installs, 0); assert.equal(f.unsubscribed(), 0); f.clean()
})

test('generated CDP expression is public API only, validates inputs, and actually executes', async () => {
  const args = { pluginId: 'memo', zipUrl: 'http://127.0.0.1:3333/memo.zip', version: '1.2.1',
    checksum: 'a'.repeat(64), fileSize: 42, expectedIsUpdate: true }
  const f = fixture(({ emit }) => { emit(completion); return accepted })
  const context = vm.createContext({ window: { ztools: { plugin: f.request.plugin, events: f.request.events } },
    hostSetTimeout: setTimeout, hostClearTimeout: clearTimeout })
  vm.runInContext(`globalThis.setTimeout = function(...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return hostSetTimeout(...args);
  }; globalThis.clearTimeout = function(...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return hostClearTimeout(...args);
  };`, context)
  const result = await vm.runInContext(publicPluginInstallExpression(args), context)
  assert.equal(result.completion.operationId, accepted.operationId); f.clean()
  for (const patch of [{ pluginId: undefined }, { zipUrl: 'https://example.com/a.zip' },
    { zipUrl: 'http://127.0.0.1:3333/a.zip#x' }, { timeoutMs: 0 }, { checksum: '' }, { fileSize: 0 }]) {
    assert.throws(() => publicPluginInstallExpression({ ...args, ...patch }), { message: 'PLUGIN_INSTALL_ARGUMENT_INVALID' })
  }
})

test('SDK update rejection correlates the exact asynchronous failure event and preserves its operation ID', async () => {
  const terminal = { pluginId: 'memo', operationId: 'update-op-1', success: false, isUpdate: true,
    errorCode: 'NOT_SUPPORTED', error: 'SDK v2 is not supported' }
  const f = updateFixture(({ emit, args }) => {
    emit({ ...terminal, pluginId: 'other' })
    emit({ ...terminal, isUpdate: false })
    emit(terminal)
    assert.equal(args[0], 'memo')
    assert.equal(args[1].version, '1.2.2')
    return true
  })
  const result = await awaitPublicPluginUpdateFailure(f.request)
  assert.equal(result.publicApiAccepted, true)
  assert.equal(result.operationId, 'update-op-1')
  assert.equal(result.completion.errorCode, 'NOT_SUPPORTED')
  assert.equal(result.completion.isUpdate, true)
  assert.match(result.operationIdSource, /terminal event/)
  f.clean(); assert.equal(f.unsubscribed(), 1)
})

test('SDK update rejects wrong terminal error, false acceptance, missing completion, and subscription failure', async () => {
  const terminal = { pluginId: 'memo', operationId: 'update-op-2', success: false, isUpdate: true,
    errorCode: 'INVALID_REQUEST' }
  const wrongError = updateFixture(({ emit }) => { emit(terminal); return true })
  await assert.rejects(awaitPublicPluginUpdateFailure(wrongError.request), error =>
    error.message === 'PLUGIN_UPDATE_COMPLETION_UNEXPECTED' && error.updateCompletion?.errorCode === 'INVALID_REQUEST')
  wrongError.clean(); assert.equal(wrongError.unsubscribed(), 1)

  const missingOperation = updateFixture(({ emit }) => { emit({ ...terminal, operationId: '' }); return true })
  await assert.rejects(awaitPublicPluginUpdateFailure(missingOperation.request), { message: 'PLUGIN_UPDATE_TERMINAL_OPERATION_ID_MISSING' })
  missingOperation.clean(); assert.equal(missingOperation.unsubscribed(), 1)

  const notAccepted = updateFixture(() => false)
  await assert.rejects(awaitPublicPluginUpdateFailure(notAccepted.request), { message: 'PLUGIN_UPDATE_NOT_ACCEPTED' })
  notAccepted.clean(); assert.equal(notAccepted.unsubscribed(), 1)

  const missing = updateFixture(({ fireTimeout }) => { fireTimeout(); return new Promise(() => {}) })
  await assert.rejects(awaitPublicPluginUpdateFailure(missing.request), { message: 'PLUGIN_UPDATE_COMPLETION_TIMEOUT' })
  missing.clean(); assert.equal(missing.unsubscribed(), 1)

  let updates = 0
  const subscription = updateFixture(() => { updates++; return true })
  subscription.request.events.subscribe = async () => ({ success: false })
  await assert.rejects(awaitPublicPluginUpdateFailure(subscription.request), { message: 'PLUGIN_UPDATE_EVENT_SUBSCRIBE_FAILED' })
  assert.equal(updates, 0); subscription.clean(); assert.equal(subscription.unsubscribed(), 0)
})

test('generated SDK update failure expression uses only public APIs and validates the fixture request', async () => {
  const args = { pluginId: 'memo', downloadUrl: 'http://127.0.0.1:3333/update.zip', version: '1.2.2',
    checksum: 'b'.repeat(64), fileSize: 84, expectedErrorCode: 'NOT_SUPPORTED' }
  const terminal = { pluginId: 'memo', operationId: 'update-op-public', success: false, isUpdate: true,
    errorCode: 'NOT_SUPPORTED' }
  const f = updateFixture(({ emit, args: received }) => {
    assert.equal(received[0], 'memo')
    assert.deepEqual(JSON.parse(JSON.stringify(received[1])), { downloadUrl: args.downloadUrl, version: args.version,
      checksum: args.checksum, fileSize: args.fileSize })
    emit(terminal)
    return true
  })
  const context = vm.createContext({ window: { ztools: { update: f.request.update, events: f.request.events } },
    hostSetTimeout: setTimeout, hostClearTimeout: clearTimeout })
  vm.runInContext(`globalThis.setTimeout = function(...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return hostSetTimeout(...args);
  }; globalThis.clearTimeout = function(...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return hostClearTimeout(...args);
  };`, context)
  const result = await vm.runInContext(publicPluginUpdateFailureExpression(args), context)
  assert.equal(result.operationId, 'update-op-public'); f.clean()
  for (const patch of [{ pluginId: undefined }, { downloadUrl: 'https://example.com/update.zip' },
    { downloadUrl: 'http://127.0.0.1:3333/update.zip#fragment' }, { expectedErrorCode: 'NOT_SUPPORTED\n' },
    { timeoutMs: 0 }, { checksum: '' }, { fileSize: 0 }]) {
    assert.throws(() => publicPluginUpdateFailureExpression({ ...args, ...patch }), { message: 'PLUGIN_UPDATE_ARGUMENT_INVALID' })
  }
})
