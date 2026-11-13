import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMacCapabilityBaseline, collectMacDisplayBaseline, collectMacOwnedProcessBaseline, validateCapabilityBaseline, validateDisplayBaseline, validateOwnedProcessBaseline } from './macos-readonly-cases.mjs'

const snapshot = (capability, revision = 0, osPermission = 'unknown') => ({ contractVersion: 1, capability, revision,
  target: { platform: 'macos', runtime: 'electron', arch: 'arm64' }, implementation: 'supported', authorization: 'unknown', osPermission })
const capabilities = () => ['screen.capture', 'clipboard.files.read', 'system.hibernate'].map(id => snapshot(id))
const display = (id, index, primary, x, scaleFactor) => ({ id, index, primary, name: 'Synthetic display',
  bounds: { x, y: -30, width: 800, height: 600 }, workArea: { x, y: 0, width: 800, height: 570 }, scaleFactor, rotation: 0, touchSupport: 'unknown' })
function topology() {
  const primary = display(1, 0, true, 0, 2), other = display(2, 1, false, -800, 1)
  return { displays: [primary, other], primary, nearest: other, matching: primary, cursor: { x: -5, y: 0 } }
}

test('M05 collector calls only read-only capability SDK methods and preserves manual pending', async () => {
  const calls = []
  const sdk = { sys: { getCapability: async id => { calls.push(id); return snapshot(id) } } }
  const data = await collectMacCapabilityBaseline(sdk)
  assert.equal(calls.length, 6)
  assert.equal(validateCapabilityBaseline(data, 'arm64').status, 'MANUAL_PENDING')
  assert.equal(validateCapabilityBaseline(data, 'arm64').checks, 'PASS')
})

test('M05 requires independent axes, target architecture, and monotonic revision', () => {
  const data = { first: capabilities(), second: capabilities() }
  data.second[0] = snapshot('screen.capture', 1, 'denied')
  assert.equal(validateCapabilityBaseline(data, 'arm64').checks, 'PASS')
  data.second[0].revision = 0
  assert.equal(validateCapabilityBaseline(data, 'arm64').code, 'CAPABILITY_REVISION_MISMATCH')
  assert.equal(validateCapabilityBaseline({ first: capabilities(), second: capabilities() }, 'x64').code, 'CAPABILITY_CONTRACT_MISMATCH')
  const stable = { first: capabilities(), second: capabilities() }
  stable.second[0].revision = 1
  assert.equal(validateCapabilityBaseline(stable, 'arm64').checks, 'PASS') // Other queries may observe transitions between these samples.
  stable.first[0].revision = 2
  assert.equal(validateCapabilityBaseline(stable, 'arm64').code, 'CAPABILITY_REVISION_MISMATCH')
})

test('M06 collects real SDK layout queries; mixed scaling and negative coordinates accepted', async () => {
  const value = topology(), calls = []
  const sdk = { screen: {
    getAllDisplays: async () => value.displays,
    getPrimaryDisplay: async () => value.primary,
    getCursorScreenPoint: async () => value.cursor,
    getDisplayNearestPoint: async point => { calls.push(point); return value.nearest },
    getDisplayMatching: async rect => { calls.push(rect); return value.matching }
  } }
  assert.deepEqual(await collectMacDisplayBaseline(sdk), value)
  assert.deepEqual(calls, [value.cursor, value.primary.bounds])
  assert.equal(validateDisplayBaseline(value).status, 'MANUAL_PENDING')
})

test('M06 rejects empty/malformed data, duplicate displays, missing primary and wrong matching display', () => {
  for (const edit of [v => { v.displays = [] }, v => { v.displays[0].scaleFactor = 0 }, v => { v.cursor.x = Infinity }]) {
    const value = topology(); edit(value)
    assert.equal(validateDisplayBaseline(value).code, 'DISPLAY_CONTRACT_MISMATCH')
  }
  for (const edit of [v => { v.displays[1].id = 1 }, v => { v.displays[1].primary = true }, v => { v.matching = v.nearest }]) {
    const value = topology(); edit(value)
    assert.equal(validateDisplayBaseline(value).code, 'DISPLAY_TOPOLOGY_MISMATCH')
  }
})

test('M08 queries only the owned PID, redacts unrelated inventory, and validates invalid PID rejection', async () => {
  const own = { pid: 42, name: 'node', path: '', cpuUsage: 0.5, memoryUsage: 4096, extraSecret: 'never-log-this',
    fieldAvailability: { path: false, cpuUsage: true, memoryUsage: true } }
  const sdk = { process: {
    list: async () => [{ ...own, pid: 99, name: 'private-other-app' }, own],
    getInfo: async pid => { if (pid === 0) throw { code: 'INVALID_REQUEST' }; assert.equal(pid, 42); return { success: true, data: own } },
    exists: async pid => { assert.equal(pid, 42); return { success: true, data: { exists: true } } },
    find: async name => { assert.equal(name, 'node'); return [{ pid: 99, name: 'other-node' }, own] }
  } }
  const value = await collectMacOwnedProcessBaseline(sdk, 42)
  assert.equal(JSON.stringify(value).includes('private-other-app'), false)
  assert.equal(JSON.stringify(value).includes('other-node'), false)
  assert.equal(JSON.stringify(value).includes('never-log-this'), false)
  assert.equal(validateOwnedProcessBaseline(value, 42).checks, 'PASS')
  assert.equal(validateOwnedProcessBaseline(value, 42).status, 'MANUAL_PENDING')
  for (const edit of [v => { v.exists = false }, v => { v.info.pid = 99 }, v => { v.listed.fieldAvailability.path = true }, v => { v.invalidPidCode = null }]) {
    const invalid = structuredClone(value); edit(invalid)
    assert.equal(validateOwnedProcessBaseline(invalid, 42).status, 'FAIL')
  }
})
