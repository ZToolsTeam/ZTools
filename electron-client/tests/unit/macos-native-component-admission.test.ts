import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes } from '../../src/contracts/errors.js'
import { resolvePluginRuntimeTarget, type MacNativeCatalogLookup } from '../../src/main/services/plugin-runtime-target-resolver.js'

const runtime = { platform: 'darwin', runtime: 'electron', arch: 'arm64' }
const component = { id: 'native-test', targetId: 'mac-universal', kind: 'shared-library', arch: 'universal',
  abi: 'ztools-mac-native/v1', protocolVersion: 1, entry: 'lib/native-test.dylib' }
const manifest = { id: 'plugin.test', targets: [{ id: 'mac-universal', platform: 'macos', runtime: 'electron', arch: 'universal' }],
  nativeComponents: [component] }
const lookup: MacNativeCatalogLookup = (pluginId, componentId) => pluginId === 'plugin.test' && componentId === 'native-test'
  ? { relativePath: component.entry, sha256: 'a'.repeat(64) } : undefined
const options = { sdkContractVersion: 1, macNativeCatalogLookup: lookup }

test('Mac native admission requires a Main catalog and preserves the exact logical component identity', () => {
  assert.throws(() => resolvePluginRuntimeTarget(manifest, runtime), { code: errorCodes.notSupported })
  const resolved = resolvePluginRuntimeTarget(manifest, runtime, options)
  assert.deepEqual(resolved.nativeComponents, [component])
  assert.equal(resolved.legacyWindows, false)
  assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, id: 'plugin.other' }, runtime, options), { code: errorCodes.notSupported })
  assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, nativeComponents: [{ ...component, id: 'Native-test' }] }, runtime, options))
})

test('Main catalog mismatch, invalid hash, lookup failure and unrecognized ABI all fail closed', () => {
  for (const catalog of [
    () => undefined,
    () => ({ relativePath: 'lib/other.dylib', sha256: 'a'.repeat(64) }),
    () => ({ relativePath: component.entry, sha256: 'bad' }),
    () => { throw new Error('private catalog diagnostic') }
  ]) {
    assert.throws(() => resolvePluginRuntimeTarget(manifest, runtime, { sdkContractVersion: 1, macNativeCatalogLookup: catalog }),
      { code: errorCodes.notSupported })
  }
  for (const [fields, code] of [
    [{ abi: 'node-api/v1' }, errorCodes.notSupported],
    [{ protocolVersion: 2 }, errorCodes.pluginPackageInvalid],
    [{ kind: 'worker' }, errorCodes.pluginPackageInvalid],
    [{ entry: 'native/test.dylib' }, errorCodes.pluginPackageInvalid]
  ] as const) {
    assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, nativeComponents: [{ ...component, ...fields }] }, runtime, options),
      { code })
  }
})

test('Mac catalog does not allow legacy/admin fields, unbound dependencies, or architecture mismatch', () => {
  for (const fields of [{ dllloader: 'lib/legacy.dll' }, { requireAdmin: true }, { commonLibs: ['legacy'] }]) {
    assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, ...fields }, runtime, options), { code: errorCodes.notSupported })
  }
  assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, nativeComponents: [{ ...component, arch: 'x64' }] }, runtime, options),
    { code: errorCodes.pluginPackageInvalid })
  assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, nativeComponents: [{ ...component, hostComponentId: 'other' }] }, runtime, options),
    { code: errorCodes.pluginPackageInvalid })
  assert.throws(() => resolvePluginRuntimeTarget({ ...manifest,
    targets: [{ id: 'windows-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }],
    nativeComponents: [{ ...component, targetId: 'windows-x64', arch: 'x64' }] },
    { platform: 'win32', runtime: 'electron', arch: 'x64' }, options), { code: errorCodes.pluginPackageInvalid })
})

test('pure JS Mac targets do not consult native authority and manifest fields cannot supply it', () => {
  let consulted = false
  resolvePluginRuntimeTarget({ ...manifest, nativeComponents: [] }, runtime,
    { sdkContractVersion: 1, macNativeCatalogLookup: () => { consulted = true; return undefined } })
  assert.equal(consulted, false)
  assert.throws(() => resolvePluginRuntimeTarget({ ...manifest, macNativeCatalogLookup: lookup }, runtime), { code: errorCodes.notSupported })
})
