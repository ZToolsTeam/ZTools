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
