import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { readHardwareSummary } from '../../src/main/services/hardware-summary.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
const cpu = (model: string) => ({ model, speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })
const snapshot = { cpus: [cpu('Apple M3'), cpu('Apple M3')], totalMemory: 16 * 1024 ** 3, release: '23.5.0', processArch: 'x64' as const }
test('hardware summary reports logical CPUs, OS product version and process slice without inventing hardware architecture/sensors', () => {
  const mac = readHardwareSummary('darwin', '14.5', snapshot); assert.equal(mac.osVersion, '14.5'); assert.equal(mac.logicalCpuCount, 2); assert.deepEqual(mac.cpuModels, ['Apple M3']); assert.equal(mac.processArch, 'x64'); assert.equal(mac.totalMemory, snapshot.totalMemory); assert.equal('osArch' in mac, false); assert.equal('temperature' in mac, false); assert.equal('binPath' in mac, false)
  assert.equal(readHardwareSummary('win32', undefined, { ...snapshot, release: '10.0.26100' }).osVersion, '10.0.26100')
})
test('missing data is explicit, unsupported platforms and impossible memory snapshots reject', () => {
  const absent = readHardwareSummary('darwin', undefined, { ...snapshot, cpus: [], totalMemory: 0 }); assert.deepEqual(absent.fieldAvailability, { cpuModels: false, logicalCpuCount: false, totalMemory: false, osVersion: false }); assert.equal(absent.osVersion, '')
  assert.throws(() => readHardwareSummary('linux', undefined, snapshot), { code: 'NOT_SUPPORTED' }); assert.throws(() => readHardwareSummary('darwin', '14.5', { ...snapshot, totalMemory: NaN }), { code: 'INTERNAL_ERROR' }); assert.equal(readHardwareSummary('darwin', 'bad', snapshot).osVersion, '')
})
test('public hardware SDK uses its narrow method and freezes explicit availability metadata', async () => {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/sys.js', 'utf8').replace(/^export .+$/mg, '')
  const Constructor = vm.runInNewContext(source + '\nSystemAPI', {}) as new (transport: unknown) => { getHardwareSummary(): Promise<unknown> }
  const data = readHardwareSummary('darwin', '14.5', snapshot); let response: unknown = { success: true, data }, observed: unknown
  const api = new Constructor({ call: async (...args: unknown[]) => { observed = args; return response } }); const result = await api.getHardwareSummary() as { cpuModels: unknown[]; fieldAvailability: unknown }
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.cpuModels)); assert.ok(Object.isFrozen(result.fieldAvailability)); assert.deepEqual(JSON.parse(JSON.stringify(observed)), ['system_get_hardware_summary', {}]); validateMethodParams('system_get_hardware_summary', {}); assert.throws(() => validateMethodParams('system_get_hardware_summary', { path: '/private' }))
  for (const value of [null, { success: false }, { success: true, data: { ...data, logicalCpuCount: -1 } }, { success: true, data: { ...data, fieldAvailability: { ...data.fieldAvailability, totalMemory: false } } }]) { response = value; await assert.rejects(api.getHardwareSummary(), { code: 'SYSTEM_ERROR' }) }
})
