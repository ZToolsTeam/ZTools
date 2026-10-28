import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { buildRuntimeCapabilityPromptPreload, buildSandboxPreload } from './build-sandbox-preload.mjs'
import { runInBoundedModuleShim } from '../tests/helpers/sandbox-preload-shim.mjs'
import { createPluginSessionHolder, createScopedHostBridge, createScopedWindow } from '../../frontend/src/declarative/pluginSession.js'
import SystemAPI from '../../frontend/public/js/cef-ipc/src/api/sys.js'

const RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL = 'ztools:runtime-capability-prompt:answer'
const RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL = 'ztools:runtime-capability-prompt:request'
const RUNTIME_CAPABILITY_PROMPT_URL = 'ztools://web/platform/runtime-permission-consent.html'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'out-test/preload-bundle', randomUUID())
fs.mkdirSync(output, { recursive: true })

test('the maintained application preload bundles its local helpers into one sandbox script', () => {
  const outputFile = path.join(output, 'actual/main.js')
  assert.deepEqual(buildSandboxPreload({ outputFile }).externalModules, ['electron'])
  const compiled = fs.readFileSync(outputFile, 'utf8')
  assert.ok(compiled.includes('__ztoolsElectron'))
  assert.ok(fs.existsSync(outputFile + '.map'))
  const exposed = runInBoundedModuleShim(compiled)
  assert.equal(exposed.get('__ztoolsElectron').contractVersion, 1)
  assert.equal(typeof exposed.get('__ztoolsElectron').transport.methods.config_get, 'function')
  for (const method of ['system_power_session', 'system_list_volumes', 'filesystem_move_file_no_replace', 'clipboard_history_restore', 'db_compare_and_set', 'credential_v1_compare_and_set']) {
    assert.equal(typeof exposed.get('__ztoolsElectron').transport.methods[method], 'function', method + ' 应从实际沙箱预加载脚本暴露')
  }
})

test('公开电源API经实际预加载与声明式作用域通道透传各插件归属', async () => {
  const outputFile = path.join(output, 'power/main.js')
  buildSandboxPreload({ outputFile })
  const calls = []
  const exposed = runInBoundedModuleShim(fs.readFileSync(outputFile, 'utf8'), {
    invoke: async (channel, request) => {
      assert.equal(channel, 'ztools:call')
      calls.push(request)
      return { messageId: request.messageId, success: true, data: { success: true, token: request.pluginSession, action: request.params.action } }
    }
  })
  const real = exposed.get('__ztoolsElectron')
  const unscopedSys = new SystemAPI({ call() { throw new Error('不应走宿主未归属通道') } })
  const makeWindow = token => createScopedWindow({ ztools: { sys: unscopedSys } }, createScopedHostBridge({
    pluginId: token, token, pending: null, track: fn => fn()
  }, real))
  const first = makeWindow('plugin-a'), second = makeWindow('plugin-b')
  assert.equal((await first.ztools.sys.managePowerSession({ action: 'start', mode: 'display', durationMinutes: 1 })).token, 'plugin-a')
  assert.equal((await second.ztools.sys.managePowerSession({ action: 'start' })).token, 'plugin-b')
  assert.equal((await first.ztools.sys.managePowerSession({ action: 'stop' })).token, 'plugin-a')
  assert.deepEqual(calls.map(r => [r.method, r.pluginSession]), [
    ['system_power_session', 'plugin-a'], ['system_power_session', 'plugin-b'], ['system_power_session', 'plugin-a']
  ])
  assert.equal(first.ztools.sys, first.ztools.sys)
  assert.notEqual(first.ztools.sys, second.ztools.sys)
  assert.equal(unscopedSys.transport.call.name, 'call')
})

test('插件申请会话失败或会话已释放时，公开电源API拒绝调用且不触达宿主', async () => {
  const outputFile = path.join(output, 'power-failure/main.js')
  buildSandboxPreload({ outputFile })
  const calls = []
  const exposed = runInBoundedModuleShim(fs.readFileSync(outputFile, 'utf8'), {
    invoke: async (_channel, request) => { calls.push(request); throw new Error('不应触达宿主') }
  })
  for (const failed of [true, false]) {
    let closed
    const closing = new Promise(resolve => { closed = resolve })
    const holder = createPluginSessionHolder('caffeine', { graceMs: 0, call: async method => {
      if (method === 'declarative_session_close') { closed(); return { success: true } }
      if (failed) throw Object.assign(new Error('会话不可用'), { code: 'HOST_METHOD_UNAVAILABLE' })
      return { data: { token: 'test-token', sessionId: 'test-session' } }
    } })
    const release = await holder.acquire()
    release()
    if (!failed) await closing
    const scoped = createScopedWindow({ ztools: { sys: new SystemAPI({}) } },
      createScopedHostBridge(holder, exposed.get('__ztoolsElectron')))
    await assert.rejects(scoped.ztools.sys.managePowerSession({ action: 'start' }), { code: 'PLUGIN_SESSION_REQUIRED' })
    assert.equal(calls.length, 0)
  }
})

test('plain TypeScript output cannot replace the bundled preload in the sandbox', () => {
  const requireLocal = createRequire(path.join(root, 'package.json'))
  const ts = requireLocal('typescript')
  const entry = fs.readFileSync(path.join(root, 'src/preload/main.ts'), 'utf8')
  const emitted = ts.transpileModule(entry, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  assert.throws(() => runInBoundedModuleShim(emitted), /SANDBOX_MODULE_UNAVAILABLE:/)
})

test('Node modules and dynamic module loading are rejected before application output is written', () => {
  for (const [label, code] of [['node', 'module.exports = require("node:fs")'],
    ['dynamic', 'module.exports = require(globalThis.requestedModule)']]) {
    const entryFile = path.join(output, label + '.js'), outputFile = path.join(output, label + '-result.js')
    fs.writeFileSync(entryFile, code)
    assert.throws(() => buildSandboxPreload({ entryFile, outputFile }), /SANDBOX_PRELOAD_FORBIDDEN_MODULE/)
    assert.equal(fs.existsSync(outputFile), false)
  }
})

function runPromptPreload(code, { isMainFrame = true, href = RUNTIME_CAPABILITY_PROMPT_URL } = {}) {
  const exposed = new Map(), listeners = new Map(), calls = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }
  }
  electron['ipc' + 'Renderer'] = {
    on(channel, listener) { listeners.set(channel, listener) },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
    invoke(channel, value) { calls.push({ channel, value }); return Promise.resolve({ success: true }) }
  }
  vm.runInNewContext(code, {
    require: name => {
      if (name !== 'electron') throw new Error('SANDBOX_MODULE_UNAVAILABLE:' + name)
      return electron
    },
    exports: {}, module: { exports: {} }, process: { isMainFrame }, location: { href }
  }, { timeout: 1000 })
  return { exposed, listeners, calls }
}

test('runtime permission prompt preload exposes only fixed one-shot methods to its top-level trusted page', async () => {
  const outputFile = path.join(output, 'actual/runtime-capability-prompt.js')
  assert.deepEqual(buildRuntimeCapabilityPromptPreload({ outputFile }).externalModules, ['electron'])
  const code = fs.readFileSync(outputFile, 'utf8')
  const main = runPromptPreload(code)
  const api = main.exposed.get('ztoolsRuntimeCapabilityPrompt')
  assert.ok(api)
  assert.deepEqual(Object.keys(api).sort(), ['answer', 'onRequest'])
  assert.equal([...main.exposed.keys()].length, 1)
  assert.equal(main.listeners.size, 0)

  const received = []
  const unsubscribe = api.onRequest(value => received.push(value))
  assert.deepEqual([...main.listeners.keys()], [RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL])
  const listener = main.listeners.get(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL)
  listener({}, { pluginName: '<img src=x>', pluginId: 'safe-id', purpose: 'screen capture', nonce: 'ignored' })
  listener({}, { pluginName: ['invalid'], pluginId: 'safe-id', purpose: 'screen capture' })
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ pluginName: '<img src=x>', pluginId: 'safe-id', purpose: 'screen capture' }])
  assert.throws(() => api.onRequest(null), /权限提示回调无效/)
  await assert.rejects(api.answer('yes'), /权限提示响应无效/)
  assert.deepEqual(main.calls, [])
  await api.answer(false)
  assert.deepEqual(main.calls, [{ channel: RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL, value: false }])
  unsubscribe()
  assert.equal(main.listeners.has(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL), false)

  for (const options of [{ isMainFrame: false }, { href: 'ztools://web/other.html' }]) {
    const untrusted = runPromptPreload(code, options)
    assert.equal(untrusted.exposed.has('ztoolsRuntimeCapabilityPrompt'), false)
    assert.equal(untrusted.listeners.size, 0)
    assert.equal(untrusted.calls.length, 0)
  }
})
