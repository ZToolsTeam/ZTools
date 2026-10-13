import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { isAllowedMethod } from '../../src/contracts/capabilities.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'

function api(call: (method: string, params: unknown) => Promise<unknown>) {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/plugin.js', 'utf8')
    .replace(/^export .+$/mg, '')
  const PluginAPI = vm.runInNewContext(`${source}\nPluginAPI`, {}) as new (
    transport: { call: typeof call }
  ) => { refresh(): Promise<unknown>; close(pluginId: string, instanceId?: unknown): Promise<unknown> }
  return new PluginAPI({ call })
}

test('refresh rescans through the existing allowed plugin-list contract and returns its installed data', async () => {
  const installed = { success: true, data: [{ id: 'batch-text-convert', version: '1.0.0' }] }
  let called = false
  const result = await api(async (method, params) => {
    called = true
    assert.equal(method, 'plugin_list_get')
    if (!isAllowedMethod(method)) assert.fail('SDK used an unopened method')
    validateMethodParams(method, params)
    assert.deepEqual(JSON.parse(JSON.stringify(params)), {})
    return installed
  }).refresh()
  assert.equal(called, true)
  assert.equal(result, installed)
})

test('refresh propagates an unavailable catalog instead of manufacturing a successful result', async () => {
  const failure = new Error('catalog unavailable')
  await assert.rejects(api(async () => { throw failure }).refresh(), error => error === failure)
})

test('public close carries the exact selected instance through the Main-only contract', async () => {
  const instanceId = '37ad8f2b-cc3b-481f-9439-2d1d6160c829'
  let calls = 0
  const plugin = api(async (method, params) => {
    calls++
    assert.equal(method, 'plugin_window_close')
    if (!isAllowedMethod(method)) assert.fail('SDK used an unopened method')
    validateMethodParams(method, params)
    assert.deepEqual(JSON.parse(JSON.stringify(params)), { pluginId: 'batch-text-convert', instanceId })
    return { success: true, closed: 1 }
  })
  await plugin.close('batch-text-convert', instanceId)
  assert.equal(calls, 1)
})

test('invalid falsy instance values cannot silently become a close-all request', async () => {
  let calls = 0
  const plugin = api(async () => { calls++; return { success: true } })
  for (const instanceId of [null, false, 0, {}, []]) {
    await assert.rejects(plugin.close('batch-text-convert', instanceId), /instanceId must be a string/)
  }
  assert.equal(calls, 0)
})
