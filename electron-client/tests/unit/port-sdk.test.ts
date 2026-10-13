import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { validateMethodParams } from '../../src/contracts/method-params.js'
const row = { protocol: 'TCP', localAddress: '127.0.0.1', localPort: 3000, remoteAddress: '', remotePort: null, state: 'LISTEN', pid: 123, processName: 'app', fieldAvailability: { processName: true, processPath: false, startTime: false } }
function fixture() {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/process.js', 'utf8').replace(/^export .+$/mg, '')
  const Constructor = vm.runInNewContext(source + '\nProcessAPI', {}) as new (transport: unknown) => { listPorts(): Promise<unknown> }
  let result: unknown = { success: true, data: [row], source: 'darwin-lsof', visibility: 'visible-processes', queriedAt: '2026-10-05T12:00:00Z' }; const calls: unknown[] = []
  return { api: new Constructor({ call: async (...args: unknown[]) => { calls.push(args); return result } }), calls, result: (value: unknown) => { result = value } }
}
test('port SDK calls only its empty request and returns frozen metadata with unavailable fields', async () => {
  const f = fixture(), result = await f.api.listPorts() as { connections: unknown[] }; assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.connections)); assert.ok(Object.isFrozen(result.connections[0])); assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['process_list_ports', {}, { timeout: 15000 }]])
  validateMethodParams('process_list_ports', {}); assert.throws(() => validateMethodParams('process_list_ports', { command: 'arbitrary' }))
})
test('port SDK refuses unsuccessful, malformed and invented field availability responses', async () => {
  const f = fixture()
  for (const response of [null, { success: false }, { success: true, data: [], source: 'unknown', visibility: 'visible-processes', queriedAt: 'now' }, { success: true, data: [{ ...row, localPort: 0 }], source: 'darwin-lsof', visibility: 'visible-processes', queriedAt: '2026-10-05T12:00:00Z' }, { success: true, data: [{ ...row, fieldAvailability: { processName: true, processPath: true, startTime: false } }], source: 'darwin-lsof', visibility: 'visible-processes', queriedAt: '2026-10-05T12:00:00Z' }]) { f.result(response); await assert.rejects(f.api.listPorts(), { code: 'PROCESS_ERROR' }) }
})
