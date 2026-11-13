import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isPluginTarget, validateMacPluginBaseline, runMacPluginBaseline, MAC_PLUGIN_BASELINE_IDS } from './macos-plugin-baseline.mjs'
import { parseMacIntegrationArguments } from './macos-app-integration.mjs'

const args = ['--app', path.resolve('Test.app'), '--output', path.resolve('reports'), '--bundle-id', 'test.ztools.fixture',
  '--minimum-os', '13.0', '--expect-process-arch', 'arm64']
const options = { pluginId: 'todo', expectedArch: 'arm64', appVersion: '1.1.7.1' }
function baseline() {
  return { pluginId: 'todo', url: 'ztools://plugins/todo/index.html', isElectron: true,
    nodeType: 'undefined', requireType: 'undefined', invalidCapabilityCode: 'INVALID_REQUEST',
    dom: { ready: 'complete', children: 1, width: 800, height: 600 },
    identity: { contractVersion: 1, appVersion: '1.1.7.1', target: { platform: 'macos', runtime: 'electron', arch: 'universal' }, process: { arch: 'arm64' } } }
}

test('all implemented cases are selectable; plugin baseline requires M13 and a prepared ID', () => {
  for (const id of ['M01', 'M02', 'M03', 'M05', 'M06', 'M08']) assert.equal(parseMacIntegrationArguments([...args, '--case', id]).case, id)
  for (const id of MAC_PLUGIN_BASELINE_IDS) assert.equal(parseMacIntegrationArguments([...args, '--case=M13', `--plugin=${id}`]).plugin, id)
  for (const extra of [['--case', 'M04'], ['--case', 'M13'], ['--case', 'M13', '--plugin', '../todo'],
    ['--plugin', 'todo'], ['--case', 'M05', '--plugin', 'todo'], ['--case=M05', '--case', 'M05'],
    ['--case=M13', '--plugin=todo', '--plugin=todo']]) assert.throws(() => parseMacIntegrationArguments([...args, ...extra]))
})

test('plugin page identity, isolation, DOM and error contract are verified without declaring business acceptance', () => {
  assert.equal(validateMacPluginBaseline(baseline(), 'todo', 'arm64', '1.1.7.1').status, 'MANUAL_PENDING')
  for (const url of ['https://plugins/todo/index.html', 'ztools://web/todo/', 'ztools://plugins/todo-other/index.html', 'ztools://plugins/%2Ftodo/index.html', 'invalid']) assert.equal(isPluginTarget(url, 'todo'), false)
  for (const change of [s => { s.identity.process.arch = 'x64' }, s => { s.nodeType = 'object' },
    s => { s.dom.width = 0 }, s => { s.dom.children = 0 }, s => { s.invalidCapabilityCode = 'UNAUTHORIZED' }]) {
    const value = baseline(); change(value)
    assert.equal(validateMacPluginBaseline(value, 'todo', 'arm64', '1.1.7.1').status, 'FAIL')
  }
})

test('normal-app SDK open selects exact installed plugin target and closes on success', async () => {
  const expressions = []; let disposed = false
  const main = { call: async (_method, params) => { expressions.push(params.expression); return { result: { value: { success: true } } } } }
  const result = await runMacPluginBaseline(main, options, {
    targets: async () => [{ type: 'page', url: 'ztools://plugins/todo-other/index.html' },
      { type: 'page', url: baseline().url, webSocketDebuggerUrl: 'owned-test' }],
    connect: async url => { assert.equal(url, 'owned-test'); return { call: async () => ({ result: { value: baseline() } }), dispose() { disposed = true } } }
  })
  assert.equal(result.status, 'MANUAL_PENDING'); assert.equal(disposed, true)
  assert.deepEqual(expressions, ['window.ztools.plugin.open("todo")', 'window.ztools.plugin.close("todo")'])
})

test('failed open, collection and close remain failures with paired cleanup', async () => {
  for (const mode of ['open', 'collection', 'close', 'target']) {
    const calls = []
    const result = await runMacPluginBaseline({ call: async (_method, params) => {
      const action = params.expression.includes('.open(') ? 'open' : 'close'; calls.push(action)
      return action === mode ? { exceptionDetails: {} } : { result: { value: { success: true } } }
    } }, options, {
      timeoutMs: 0,
      targets: async () => mode === 'target' ? [] : [{ type: 'page', url: baseline().url }],
      connect: async () => ({ call: async () => ({ exceptionDetails: {} }), dispose() {} })
    })
    assert.equal(result.status, 'FAIL'); assert.deepEqual(calls, ['open', 'close'])
  }
})
