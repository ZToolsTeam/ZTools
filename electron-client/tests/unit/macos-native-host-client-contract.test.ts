import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMacNativePluginReleasePayload,
  resolveApprovedMacComponent
} from '../../src/main/platform/macos/native-host-client.js'
import { parseMacNativeRuntimePolicy } from '../../src/main/platform/macos/native-runtime-policy.js'

const policy = parseMacNativeRuntimePolicy({
  schemaVersion: 1,
  appBundleId: 'com.example.ztools',
  teamId: 'ABCDE12345',
  hostBundleId: 'com.example.ztools.native-host',
  workerBundleId: 'com.example.ztools.native-worker',
  minimumOs: '13.0',
  architectures: ['arm64', 'x86_64'],
  components: [{
    pluginId: 'fixture-plugin',
    dllId: 'fixture-native',
    relativePath: 'lib/fixture-native.dylib',
    identifier: 'com.example.fixture-native',
    sha256: 'a'.repeat(64)
  }]
})
assert.ok(policy)

test('Mac native catalog admission returns only an exact sealed entry while ready', () => {
  assert.equal(resolveApprovedMacComponent(policy, 'starting', 'fixture-plugin', 'fixture-native'), undefined)
  assert.equal(resolveApprovedMacComponent(policy, 'unavailable', 'fixture-plugin', 'fixture-native'), undefined)
  assert.equal(resolveApprovedMacComponent(policy, 'ready', 'other-plugin', 'fixture-native'), undefined)
  assert.equal(resolveApprovedMacComponent(policy, 'ready', 'fixture-plugin', 'FIXTURE-NATIVE'), undefined)
  assert.equal(resolveApprovedMacComponent(policy, 'ready', '../fixture-plugin', 'fixture-native'), undefined)

  const approved = resolveApprovedMacComponent(policy, 'ready', 'fixture-plugin', 'fixture-native')
  assert.deepEqual(approved, {
    relativePath: 'lib/fixture-native.dylib',
    sha256: 'a'.repeat(64)
  })
  assert.equal(Object.isFrozen(approved), true)
  assert.notEqual(approved, policy.components[0])
})

test('Mac plugin maintenance requests release every worker for one exact plugin id', () => {
  const payload = createMacNativePluginReleasePayload('fixture-plugin')
  assert.deepEqual(payload, { operation: 'releasePlugin', pluginId: 'fixture-plugin' })
  assert.equal(Object.isFrozen(payload), true)
  assert.throws(() => createMacNativePluginReleasePayload('fixture-plugin/other'), {
    message: 'MAC_NATIVE_PLUGIN_ID_INVALID'
  })
})
