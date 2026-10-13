import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { canCall, isAllowedMethod, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import type { RuntimeIdentity } from '../../src/contracts/runtime-identity.js'
import { createRuntimeIdentity, type RuntimeIdentityInput } from '../../src/main/platform/runtime-identity.js'

function locateRuntimeFixtures(startDirectory: string): string {
  let directory = startDirectory
  while (true) {
    const candidate = join(directory, 'packages/api/contracts/fixtures/runtime')
    if (existsSync(candidate)) return candidate
    const legacyCandidate = join(directory, 'ztools-open/sdk/contracts/fixtures/runtime')
    if (existsSync(legacyCandidate)) return legacyCandidate
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Unable to locate shared runtime identity fixtures')
    directory = parent
  }
}

const fixtureRoot = locateRuntimeFixtures(__dirname)

function loadFixture(root: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, unknown>
}

function identityInput(overrides: Partial<RuntimeIdentityInput> = {}): RuntimeIdentityInput {
  return {
    target: { platform: 'windows', runtime: 'electron', arch: 'ia32' },
    appVersion: '1.1.7.1',
    platform: 'win32',
    processArch: 'ia32',
    productVersion: '10.0.22631',
    kernelVersion: '10.0.22631',
    runningUnderARM64Translation: false,
    processorArchitecture: 'x86',
    processorArchitew6432: 'AMD64',
    nativeHostState: overrides.platform === 'darwin' ? null : 'ready',
    ...overrides
  }
}

function expectRuntimeFixture(name: string, input: RuntimeIdentityInput): RuntimeIdentity {
  const expected = loadFixture(fixtureRoot, name) as unknown as RuntimeIdentity
  const actual = createRuntimeIdentity(input)
  if (expected.os.kernelVersion === undefined) {
    expected.os.kernelVersion = input.kernelVersion
  }
  assert.deepEqual(actual, expected)
  return actual
}

test('reports a Windows ia32 process on x64 WOW64 and only an acknowledged NativeHost32', () => {
  const identity = expectRuntimeFixture(
    'windows-electron-wow64.json',
    identityInput()
  )
  assert.equal(identity.os.arch, 'x64')
  assert.equal(identity.process.arch, 'ia32')
  assert.equal(identity.process.translationMode, 'compatibility')
  assert.deepEqual(identity.nativeHost, {
    state: 'available',
    arch: 'ia32',
    protocolVersion: 1
  })
})

test('macOS native availability requires an acknowledged protocol and reports the actual process slice', () => {
  for (const processArch of ['arm64', 'x64'] as const) {
    const identity = createRuntimeIdentity(identityInput({
      platform: 'darwin',
      target: { platform: 'macos', runtime: 'electron', arch: 'universal' },
      processArch,
      nativeHostState: 'ready',
      nativeHostProtocolVersion: 1,
      runningUnderARM64Translation: false
    }))
    assert.deepEqual(identity.nativeHost, { state: 'available', arch: processArch, protocolVersion: 1 })
  }
})

test('macOS native identity never infers protocol from Windows or claims a closed host is available', () => {
  const base = identityInput({
    platform: 'darwin',
    target: { platform: 'macos', runtime: 'electron', arch: 'arm64' },
    processArch: 'arm64'
  })
  for (const nativeHostProtocolVersion of [undefined, null, 0, -1, NaN, 1.5]) {
    const identity = createRuntimeIdentity({ ...base, nativeHostState: 'ready', nativeHostProtocolVersion })
    assert.deepEqual(identity.nativeHost, { state: 'unknown', arch: 'unknown', protocolVersion: null })
  }
  for (const nativeHostState of ['idle', 'closed', 'crashed', 'unavailable']) {
    const identity = createRuntimeIdentity({ ...base, nativeHostState, nativeHostProtocolVersion: 1 })
    assert.deepEqual(identity.nativeHost, { state: 'unavailable', arch: 'unknown', protocolVersion: null })
  }
})

test('runtime identity IPC is a no-argument read available to registered main and plugin callers', () => {
  assert.equal(isAllowedMethod('system_get_runtime_identity'), true)
  for (const caller of [
    { type: 'main', webContentsId: 1 },
    { type: 'plugin', webContentsId: 2, pluginId: 'plugin.example' }
  ] satisfies CallerIdentity[]) {
    assert.equal(canCall('system_get_runtime_identity', caller), true)
  }
  assert.doesNotThrow(() => validateMethodParams('system_get_runtime_identity', {}))
  assert.throws(() => validateMethodParams('system_get_runtime_identity', {
    pluginId: 'spoofed-plugin'
  }))
  assert.throws(() => validateMethodParams('system_get_runtime_identity', {
    platform: 'windows'
  }))
})

test('reports unavailable and unknown Windows NativeHost states without claiming availability', () => {
  const unavailable = createRuntimeIdentity(identityInput({ nativeHostState: 'crashed' }))
  assert.deepEqual(unavailable.nativeHost, {
    state: 'unavailable',
    arch: 'unknown',
    protocolVersion: null
  })

  const missing = createRuntimeIdentity(identityInput({ nativeHostState: null }))
  assert.equal(missing.nativeHost.state, 'unavailable')
  assert.notEqual(missing.nativeHost.state, 'available')

  const unknown = createRuntimeIdentity(identityInput({ nativeHostState: 'future-state' }))
  assert.deepEqual(unknown.nativeHost, {
    state: 'unknown',
    arch: 'unknown',
    protocolVersion: null
  })
})

test('reuses the x64 Rosetta fixture while keeping process and OS architecture independent', () => {
  const identity = expectRuntimeFixture(
    'macos-x64-electron-rosetta.json',
    identityInput({
      target: { platform: 'macos', runtime: 'electron', arch: 'x64' },
      platform: 'darwin',
      processArch: 'x64',
      productVersion: '14.5',
      kernelVersion: '23.5.0',
      runningUnderARM64Translation: true
    })
  )
  assert.equal(identity.os.arch, 'arm64')
  assert.equal(identity.process.arch, 'x64')
  assert.equal(identity.process.translationMode, 'translated')
  assert.deepEqual(identity.nativeHost, {
    state: 'not-applicable',
    arch: 'unknown',
    protocolVersion: null
  })
})

test('reuses the native arm64 fixture and returns unknown versions as schema-safe strings', () => {
  const identity = expectRuntimeFixture(
    'macos-arm64-electron.json',
    identityInput({
      target: { platform: 'macos', runtime: 'electron', arch: 'arm64' },
      platform: 'darwin',
      processArch: 'arm64',
      productVersion: '',
      kernelVersion: '',
      runningUnderARM64Translation: false
    })
  )
  assert.equal(identity.os.productVersion, 'unknown')
  assert.equal(identity.os.kernelVersion, 'unknown')
  assert.equal(identity.process.translationMode, 'native')
})

test('packaged Universal runtime fixtures keep target separate from the active process slice', () => {
  const x64Rosetta = expectRuntimeFixture(
    'macos-electron-universal-x64-rosetta.json',
    identityInput({
      target: { platform: 'macos', runtime: 'electron', arch: 'universal' },
      platform: 'darwin',
      processArch: 'x64',
      productVersion: '14.5',
      kernelVersion: '23.5.0',
      runningUnderARM64Translation: true
    })
  )
  assert.equal(x64Rosetta.process.arch, 'x64')
  assert.equal(x64Rosetta.process.translationMode, 'translated')

  const arm64Native = expectRuntimeFixture(
    'macos-electron-universal-arm64.json',
    identityInput({
      target: { platform: 'macos', runtime: 'electron', arch: 'universal' },
      platform: 'darwin',
      processArch: 'arm64',
      productVersion: '14.5',
      kernelVersion: '23.5.0',
      runningUnderARM64Translation: false
    })
  )
  assert.equal(arm64Native.process.arch, 'arm64')
  assert.equal(arm64Native.process.translationMode, 'native')
  assert.deepEqual(arm64Native.nativeHost, {
    state: 'not-applicable',
    arch: 'unknown',
    protocolVersion: null
  })
})

test('unknown host architecture stays unknown and unsupported process targets fail closed', () => {
  const identity = createRuntimeIdentity(identityInput({
    processorArchitecture: 'future-architecture',
    processorArchitew6432: undefined,
    runningUnderARM64Translation: null,
    nativeHostState: 'future-state'
  }))
  assert.equal(identity.os.arch, 'unknown')
  assert.equal(identity.process.translationMode, 'unknown')

  for (const overrides of [
    { platform: 'linux' as NodeJS.Platform },
    { processArch: 'future-architecture' },
    { platform: 'darwin' as NodeJS.Platform, processArch: 'ia32' },
    { target: { platform: 'windows' as const, runtime: 'electron' as const, arch: 'x64' as const } }
  ]) {
    assert.throws(
      () => createRuntimeIdentity(identityInput(overrides)),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
  }
})
