import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMacosNativeRuntime } from '../../src/main/platform/macos/native-runtime.js'
import {
  parseMacNativeRuntimePolicy,
  readMacNativeRuntimePolicy,
  resolveMacNativeComponentLocation,
  resolveMacNativeRuntimeReadiness
} from '../../src/main/platform/macos/native-runtime-policy.js'

const component = {
  pluginId: 'fixture-plugin',
  dllId: 'fixture-native',
  relativePath: 'lib/fixture-native.dylib',
  identifier: 'com.example.fixture-native',
  sha256: 'a'.repeat(64)
}

const policy = {
  schemaVersion: 1,
  appBundleId: 'com.example.ztools',
  teamId: 'ABCDE12345',
  hostBundleId: 'com.example.ztools.native-host',
  workerBundleId: 'com.example.ztools.native-worker',
  minimumOs: '13.0',
  architectures: ['arm64', 'x86_64'],
  components: [component]
}

test('Mac native policy requires every explicit signed-build identity and a nonempty catalog', () => {
  const parsed = parseMacNativeRuntimePolicy(policy)
  assert.ok(parsed)
  assert.equal(parsed.teamId, 'ABCDE12345')
  assert.equal(parsed.components[0]?.sha256, 'a'.repeat(64))
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.components), true)

  for (const invalid of [
    { ...policy, teamId: '' },
    { ...policy, appBundleId: undefined },
    { ...policy, hostBundleId: undefined },
    { ...policy, workerBundleId: undefined },
    { ...policy, minimumOs: undefined },
    { ...policy, components: [] },
    { ...policy, unexpected: true },
    { ...policy, components: [component, component] }
  ]) {
    assert.equal(parseMacNativeRuntimePolicy(invalid), undefined)
  }
})

test('Mac catalog rejects traversal, symlink-shaped and malformed component entries', () => {
  for (const relativePath of [
    '../outside.dylib',
    'lib/../../outside.dylib',
    '/absolute/lib.dylib',
    'lib\\outside.dylib',
    'lib/fixture.dll',
    'lib//fixture.dylib',
    'lib/./fixture.dylib'
  ]) {
    assert.equal(parseMacNativeRuntimePolicy({
      ...policy,
      components: [{ ...component, relativePath }]
    }), undefined, relativePath)
  }

  assert.equal(parseMacNativeRuntimePolicy({
    ...policy,
    components: [{ ...component, sha256: 'not-a-hash' }]
  }), undefined)
  assert.equal(parseMacNativeRuntimePolicy({
    ...policy,
    components: [{ ...component, identifier: 'not-an-identifier' }]
  }), undefined)
})

test('Main resolves only catalog keys under its fixed plugin root and approved architecture', () => {
  const parsed = parseMacNativeRuntimePolicy(policy)
  assert.ok(parsed)
  const pluginRoot = path.resolve('native-plugin-root')
  const candidate = resolveMacNativeComponentLocation(
    parsed,
    pluginRoot,
    'fixture-plugin',
    'fixture-native',
    'arm64'
  )
  assert.ok(candidate)
  assert.equal(candidate.absolutePath, path.join(pluginRoot, 'fixture-plugin', 'lib', 'fixture-native.dylib'))
  assert.equal(candidate.teamId, parsed.teamId)
  assert.equal(candidate.architecture, 'arm64')
  assert.equal(resolveMacNativeComponentLocation(
    parsed,
    pluginRoot,
    'fixture-plugin',
    'other-dll',
    'arm64'
  ), undefined)
  assert.equal(resolveMacNativeComponentLocation(parsed, '/absolute/plugins', 'fixture-plugin', 'fixture-native', 'ia32'), undefined)
  assert.equal(resolveMacNativeComponentLocation(parsed, '/absolute/plugins', 'fixture-plugin', 'fixture-native', 'x64')?.architecture,
    'x86_64')
})

test('runtime readiness is unavailable without packaged policy or on an unapproved slice', () => {
  assert.deepEqual(resolveMacNativeRuntimeReadiness(undefined, 'arm64'), {
    available: false,
    reasons: ['runtime-policy-missing']
  })
  assert.deepEqual(resolveMacNativeRuntimeReadiness(policy, 'arm64', false), {
    available: false,
    reasons: ['runtime-policy-not-packaged']
  })
  assert.deepEqual(resolveMacNativeRuntimeReadiness(policy, 'ia32'), {
    available: false,
    reasons: ['process-architecture-unapproved'],
    policy: parseMacNativeRuntimePolicy(policy)
  })
  assert.deepEqual(resolveMacNativeRuntimeReadiness(policy, 'arm64'), {
    available: false,
    reasons: ['same-object-load-unproven'],
    policy: parseMacNativeRuntimePolicy(policy)
  })
})

test('runtime does not construct a native host when the packaged policy rejects this process slice', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-native-readiness-'))
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  const resourcesPath = path.join(temporaryRoot, 'Resources')
  const nativePath = path.join(resourcesPath, 'native')
  fs.mkdirSync(nativePath, { recursive: true })
  fs.writeFileSync(path.join(nativePath, 'ztools-mac-native-policy.json'), JSON.stringify({
    ...policy,
    architectures: ['x86_64']
  }))

  const runtime = createMacosNativeRuntime({
    isPackaged: true,
    resourcesPath,
    appPath: path.join(temporaryRoot, 'ZTools.app', 'Contents', 'Resources', 'app.asar'),
    pluginRoot: path.join(temporaryRoot, 'Plugins'),
    processArchitecture: 'arm64',
    runningUnderTranslation: false
  })

  assert.equal(runtime.nativeHost, null)
})

test('runtime stays unavailable for a valid packaged policy until pre-initializer load proof exists', () => {
  const temporaryRoot = path.join(process.cwd(), 'out-test', 'mac-native-runtime-policy', randomUUID())
  fs.mkdirSync(temporaryRoot, { recursive: true })
  const resourcesPath = path.join(temporaryRoot, 'Resources')
  const nativePath = path.join(resourcesPath, 'native')
  fs.mkdirSync(nativePath, { recursive: true })
  fs.writeFileSync(path.join(nativePath, 'ztools-mac-native-policy.json'), JSON.stringify(policy))

  const runtime = createMacosNativeRuntime({
    isPackaged: true,
    resourcesPath,
    appPath: path.join(temporaryRoot, 'ZTools.app', 'Contents', 'Resources', 'app.asar'),
    pluginRoot: path.join(temporaryRoot, 'Plugins'),
    processArchitecture: 'arm64',
    runningUnderTranslation: false
  })

  assert.equal(runtime.nativeHost, null)
})

test('runtime policy cannot be loaded from Windows or unpackaged test configuration', () => {
  assert.equal(readMacNativeRuntimePolicy('C:\\ZTools\\Resources', {
    platform: 'win32',
    isPackaged: true
  }), undefined)
  assert.equal(readMacNativeRuntimePolicy('C:\\ZTools\\Resources', {
    platform: 'darwin',
    isPackaged: false
  }), undefined)
})
