import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { SDK_CONTRACT_VERSION } from '../../src/contracts/protocol-versions.js'
import { createMacosNativeRuntime } from '../../src/main/platform/macos/native-runtime.js'
import { createPlatformNativeRuntime } from '../../src/main/platform/native-runtime.js'
import { createMacosSystemPlatformAdapter } from '../../src/main/platform/macos/system.js'
import { createSystemPlatformAdapter } from '../../src/main/platform/system.js'
import { getRuntimeCapabilityTarget } from '../../src/main/platform/runtime-capability-target.js'
import {
  resolvePluginRuntimeTarget,
  type PluginRuntimeIdentity
} from '../../src/main/services/plugin-runtime-target-resolver.js'
import type { PlatformNativeRuntime } from '../../src/main/platform/native-runtime.js'
import type { SystemPlatformAdapter } from '../../src/main/platform/system.js'

interface ContractTargetFixture {
  id?: string
  platform: string
  runtime: string
  arch: string
  minSdkContractVersion?: number
  [key: string]: unknown
}

interface ContractNegotiationFixture {
  targetRequirement: ContractTargetFixture
  hostSdkContractVersion: number
  runtime: { contractVersion: number }
  expectedCompatible: boolean
}

const contractsRoot = [
  resolve(__dirname, '../../../..', 'packages/api/contracts'),
  resolve(__dirname, '../../../../../', 'packages/api/contracts'),
  resolve(__dirname, '../../../..', 'ztools-open/sdk/contracts'),
  resolve(__dirname, '../../../../../', 'ztools-open/sdk/contracts')
].find(existsSync) ?? resolve(__dirname, '../../../..', 'packages/api/contracts')

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? fixtureFiles(path)
      : entry.isFile() && entry.name.endsWith('.json') ? [path] : []
  }).sort()
}

function electronRuntimeFor(target: ContractTargetFixture, arch = target.arch): PluginRuntimeIdentity {
  return {
    platform: target.platform === 'windows' ? 'win32' : 'darwin',
    runtime: 'electron',
    arch
  }
}

test('macOS native runtime keeps JavaScript services available without Windows helpers', async () => {
  const runtime = createPlatformNativeRuntime('darwin', {
    windows: () => { throw new Error('Windows runtime must not be constructed') },
    macos: () => createMacosNativeRuntime({
      isPackaged: false,
      resourcesPath: '/fixture/ZTools.app/Contents/Resources',
      appPath: '/fixture/ZTools.app/Contents/Resources/app.asar',
      pluginRoot: '/fixture/profile/Plugins',
      processArchitecture: 'arm64',
      runningUnderTranslation: false
    })
  })

  assert.equal(runtime.nativeHost, null)
  assert.equal(runtime.serviceClient, null)
  await runtime.start()
})

test('native and system platform selectors reject unknown operating systems', () => {
  const factories = {
    windows: () => ({ nativeHost: null, serviceClient: null, start: async () => {} }),
    macos: () => ({ nativeHost: null, serviceClient: null, start: async () => {} })
  } satisfies {
    windows(): PlatformNativeRuntime
    macos(): PlatformNativeRuntime
  }
  const systemFactories = {
    windows: () => ({
      userDataPath: '',
      getRuntimeTarget: () => ({ platform: 'windows', runtime: 'electron', arch: 'x64' }),
      getNativeId: async () => ''
    }),
    macos: () => ({
      userDataPath: '',
      getRuntimeTarget: () => ({ platform: 'macos', runtime: 'electron', arch: 'arm64' }),
      getNativeId: async () => ''
    })
  } satisfies {
    windows(): SystemPlatformAdapter
    macos(): SystemPlatformAdapter
  }

  assert.throws(() => createPlatformNativeRuntime('aix', factories), (error: unknown) =>
    error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.throws(() => createSystemPlatformAdapter('aix', systemFactories), (error: unknown) =>
    error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})

test('macOS system identity reports unsupported instead of returning a Windows-shaped value', async () => {
  const adapter = createSystemPlatformAdapter('darwin', {
    windows: () => { throw new Error('Windows adapter must not be selected') },
    macos: () => createMacosSystemPlatformAdapter(
      '/Users/test/Library/Application Support/ZTools',
      () => '15.0.1'
    )
  })

  assert.equal(adapter.userDataPath, '/Users/test/Library/Application Support/ZTools')
  assert.deepEqual(adapter.getRuntimeTarget(), {
    platform: 'macos',
    runtime: 'electron',
    arch: process.arch
  })
  assert.equal(adapter.getProductVersion?.(), '15.0.1')
  await assert.rejects(adapter.getNativeId(), (error: unknown) =>
    error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})

test('runtime capability target reports only verified supported Electron OS and process architectures', () => {
  assert.deepEqual(getRuntimeCapabilityTarget('win32', 'ia32'), {
    platform: 'windows', runtime: 'electron', arch: 'ia32'
  })
  assert.deepEqual(getRuntimeCapabilityTarget('win32', 'x64'), {
    platform: 'windows', runtime: 'electron', arch: 'x64'
  })
  assert.deepEqual(getRuntimeCapabilityTarget('darwin', 'x64'), {
    platform: 'macos', runtime: 'electron', arch: 'x64'
  })
  assert.deepEqual(getRuntimeCapabilityTarget('darwin', 'arm64'), {
    platform: 'macos', runtime: 'electron', arch: 'arm64'
  })

  for (const [platform, arch] of [
    ['darwin', 'ia32'],
    ['win32', 'arm64'],
    ['win32', 'universal'],
    ['aix', 'x64']
  ] as const) {
    assert.throws(
      () => getRuntimeCapabilityTarget(platform, arch),
      (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported,
      `${platform}/${arch} must fail closed`
    )
  }
})

test('sandboxed preload fails closed to lane 1 while the host maximum comes from the canonical enum', () => {
  const sourceRoot = [
    resolve(__dirname, '../../../src'),
    resolve(__dirname, '../../../../src')
  ].find((candidate) => existsSync(resolve(candidate, 'preload/main.ts'))) ?? resolve(__dirname, '../../../src')
  const preloadSource = readFileSync(resolve(sourceRoot, 'preload/main.ts'), 'utf8')
  const versionSource = readFileSync(resolve(sourceRoot, 'contracts/protocol-versions.ts'), 'utf8')
  const enumValue = versionSource.match(/SDK_HOST_MAXIMUM_CONTRACT\s*=\s*(\d+)/)
  assert.ok(enumValue, 'the canonical protocol version enum must declare the SDK host maximum')
  assert.equal(Number(enumValue[1]), SDK_CONTRACT_VERSION)
  assert.match(versionSource, /SDK_CONTRACT\s*=\s*1/)
  assert.match(versionSource, /SDK_HOST_MAXIMUM_CONTRACT_VERSION\s*=\s*ProtocolVersionValues\.SDK_HOST_MAXIMUM_CONTRACT/)
  assert.match(versionSource, /SDK_LEGACY_CONTRACT_VERSION\s*=\s*ProtocolVersionValues\.SDK_CONTRACT/)
  assert.match(preloadSource, /contractVersion:\s*referenceTransport\s*\?\s*2\s*:\s*SDK_LEGACY_CONTRACT_VERSION/)
  assert.doesNotMatch(
    preloadSource,
    /import\s*\{\s*SDK_HOST_MAXIMUM_CONTRACT_VERSION\s*\}\s*from\s*['"]\.\.\/contracts\/protocol-versions\.js['"]/
  )
})

test('Electron plugin target resolution consumes shared target fixtures against its SDK contract version', () => {
  const directory = join(contractsRoot, 'fixtures', 'targets')
  const files = fixtureFiles(directory)
  assert.ok(files.length > 0, 'shared public target fixtures must exist')

  for (const file of files) {
    const fixture = loadJson<ContractTargetFixture>(file)
    const fixtureName = basename(file, '.json')
    const target = {
      ...fixture,
      id: fixture.id ?? `fixture-${fixtureName}`
    }

    if (fixture.runtime === 'legacy-delphi') {
      assert.throws(
        () => resolvePluginRuntimeTarget(
          { targets: [target], nativeComponents: [] },
          electronRuntimeFor(fixture)
        ),
        (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported,
        `${fixtureName}: the Electron resolver must not select a legacy Delphi target`
      )
      continue
    }

    const runtimeArchitectures = fixture.arch === 'universal'
      ? ['x64', 'arm64']
      : fixture.arch === 'any'
        ? fixture.platform === 'macos' ? ['x64', 'arm64'] : ['ia32']
        : [fixture.arch]

    for (const arch of runtimeArchitectures) {
      const runtime = electronRuntimeFor(fixture, arch)
      if ((fixture.minSdkContractVersion ?? 1) > SDK_CONTRACT_VERSION) {
        assert.throws(
          () => resolvePluginRuntimeTarget({ targets: [target], nativeComponents: [] }, runtime),
          (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported,
          `${fixtureName}: ${arch} must reject a target that requires a newer SDK contract`
        )
        continue
      }
      const result = resolvePluginRuntimeTarget(
        { targets: [target], nativeComponents: [] },
        runtime
      )
      assert.deepEqual(result.target, target, `${fixtureName}: ${arch} should select the shared target fixture`)
    }
  }
})

test('Windows x64 platform identity selects an x64 plugin target while preserving the NativeHost32 DLL architecture', () => {
  const capabilityTarget = getRuntimeCapabilityTarget('win32', 'x64')
  const runtime = { ...capabilityTarget, platform: 'win32' }
  const target = {
    id: 'windows-electron-x64',
    platform: capabilityTarget.platform,
    runtime: capabilityTarget.runtime,
    arch: capabilityTarget.arch
  }
  const nativeHost32Dll = {
    id: 'batch-audio-dll',
    kind: 'dll',
    targetId: target.id,
    arch: 'ia32',
    abi: 'ztools-native-host/v1',
    entry: 'lib/BatchAudioPlugin.dll',
    protocolVersion: 1
  }
  const mediaService = {
    id: 'media-service',
    kind: 'shared-library',
    targetId: target.id,
    arch: 'ia32',
    abi: 'windows-pe/v1',
    entry: 'lib/MediaService.dll',
    hostComponentId: nativeHost32Dll.id
  }

  const result = resolvePluginRuntimeTarget(
    { targets: [target], nativeComponents: [mediaService, nativeHost32Dll] },
    runtime
  )

  assert.deepEqual(result.target, target)
  assert.deepEqual(result.nativeComponents, [mediaService, nativeHost32Dll])
  assert.equal(result.nativeComponents[0]?.arch, 'ia32')
  assert.equal(result.nativeComponents[0]?.hostComponentId, nativeHost32Dll.id)
  assert.equal(capabilityTarget.arch, 'x64')
})

test('Electron plugin target resolution rejects the shared invalid target fixtures', () => {
  const directory = join(contractsRoot, 'fixtures', 'invalid', 'platform-target')
  const files = fixtureFiles(directory)
  assert.ok(files.length > 0, 'shared invalid target fixtures must exist')

  for (const file of files) {
    const fixture = loadJson<ContractTargetFixture>(file)
    const fixtureName = basename(file, '.json')
    const runtimeArch = fixture.platform === 'macos'
      ? 'arm64'
      : ['ia32', 'x64', 'arm64'].includes(fixture.arch) ? fixture.arch : 'arm64'
    assert.throws(
      () => resolvePluginRuntimeTarget(
        { targets: [fixture], nativeComponents: [] },
        electronRuntimeFor(fixture, runtimeArch)
      ),
      (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.pluginPackageInvalid,
      `${fixtureName}: the Electron resolver must reject the invalid shared target fixture`
    )
  }
})

test('target negotiation keeps a simulated SDK 1 host separate from runtime identity version', () => {
  const fixture = loadJson<ContractNegotiationFixture>(join(
    contractsRoot,
    'fixtures',
    'negotiation',
    'runtime-contract-version-too-old.json'
  ))

  assert.equal(fixture.runtime.contractVersion, 1)
  assert.equal(SDK_CONTRACT_VERSION, 2)
  assert.equal(fixture.hostSdkContractVersion, 1)
  assert.equal(fixture.expectedCompatible, false)
  assert.ok(fixture.hostSdkContractVersion < (fixture.targetRequirement.minSdkContractVersion ?? 1))
  const target = { ...fixture.targetRequirement, id: 'shared-sdk-v2-fixture' }
  assert.throws(
    () => resolvePluginRuntimeTarget(
      { targets: [target], nativeComponents: [] },
      electronRuntimeFor(target),
      { sdkContractVersion: fixture.hostSdkContractVersion }
    ),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})
