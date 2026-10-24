import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export function runMacNativeWorkerKeySourceContracts(root) {
  const nativeSource = path.join(root, 'native', 'ZToolsMacNative')
  const keyHeader = fs.readFileSync(path.join(nativeSource, 'host', 'worker_key_v1.hpp'), 'utf8')
  const keyFixture = fs.readFileSync(path.join(nativeSource, 'fixture', 'worker_key_test.cpp'), 'utf8')
  const hostSource = fs.readFileSync(path.join(nativeSource, 'darwin', 'native_host_main.mm'), 'utf8')
  const workerSource = fs.readFileSync(path.join(nativeSource, 'darwin', 'native_worker_main.mm'), 'utf8')
  const clientSource = fs.readFileSync(path.join(root, 'src', 'main', 'platform', 'macos', 'native-host-client.ts'), 'utf8')

  const checks = [
    /std::tie\(pluginId, owner, generation, pluginInstanceId\)/.test(keyHeader),
    /owner == expectedOwner && generation == expectedGeneration/.test(keyHeader),
    /pluginId == expectedPluginId/.test(keyHeader),
    /const WorkerKey key\{pluginId, frame\.header\.owner, frame\.header\.generation, pluginInstanceId\}/.test(hostSource),
    /entry\.first\.matchesPlugin\(pluginId\)/.test(hostSource),
    /entry\.first\.matchesOwner\(frame\.header\.owner, frame\.header\.generation, pluginInstanceId\)/.test(hostSource),
    /readString\(body, @"pluginId", &pluginId, 128\)/.test(hostSource),
    /operation: 'cancel', pluginId: payload\.pluginId, targetTaskId/.test(clientSource),
    /return resolveApprovedMacComponent\(this\.policy, this\.#state, pluginId, componentId\)/.test(clientSource),
    /const releasePayload = createMacNativePluginReleasePayload\(pluginId\)/.test(clientSource),
    /MacNativeFrameType\.destroy,\s*releasePayload/.test(clientSource),
    /std::map<std::string, LoadedComponent> components;/.test(workerSource),
    /const std::string key = componentKey\(pluginId, dllId\)/.test(workerSource),
    /auto existing = loaded->find\(key\);\s*if \(existing != loaded->end\(\)\) return &existing->second;/.test(workerSource),
    /WORKER_KEY_SECOND_PLUGIN_MISSING/.test(keyFixture),
    /OWNER_RELEASE_DID_NOT_REMOVE_ALL_PLUGIN_WORKERS/.test(keyFixture),
    /PLUGIN_MAINTENANCE_REMOVED_OTHER_PLUGIN/.test(keyFixture),
  ]
  assert.equal(checks.every(Boolean), true, 'MAC_NATIVE_WORKER_KEY_SCOPE_SOURCE_CONTRACT_FAILED')
  return {
    status: 'PASS',
    scope: 'mac-native-worker-key-plugin-owner-instance-multi-component-source-contract',
    checks: checks.length,
  }
}
