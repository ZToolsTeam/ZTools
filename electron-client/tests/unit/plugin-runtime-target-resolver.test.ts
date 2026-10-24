import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, toPublicError } from '../../src/contracts/errors.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from '../../src/contracts/protocol-versions.js'
import {
  resolvePluginRuntimeTarget,
  type PluginRuntimeTargetResolverOptions,
  type PluginRuntimeIdentity
} from '../../src/main/services/plugin-runtime-target-resolver.js'

const macX64: PluginRuntimeIdentity = { platform: 'darwin', runtime: 'electron', arch: 'x64' }
const macArm64: PluginRuntimeIdentity = { platform: 'darwin', runtime: 'electron', arch: 'arm64' }
const windowsIa32: PluginRuntimeIdentity = { platform: 'win32', runtime: 'electron', arch: 'ia32' }
const windowsX64: PluginRuntimeIdentity = { platform: 'win32', runtime: 'electron', arch: 'x64' }

function payloadHost(overrides: Record<string, unknown> = {}) {
  return { id: 'host', targetId: 'win-x64', kind: 'dll', arch: 'ia32', abi: 'ztools-native-host/v1',
    protocolVersion: 1, entry: 'lib/plugin.dll', sha256: 'a'.repeat(64), payloadFiles: [
      { entry: 'lib/helper.exe', format: 'pe', arch: 'x64', sha256: 'b'.repeat(64) },
      { entry: 'lib/model.bin', format: 'data', sha256: 'c'.repeat(64) }
    ], ...overrides }
}

test('payload is selected packaging metadata while native execution components stay unchanged', () => {
  const host = payloadHost()
  const result = resolvePluginRuntimeTarget(manifest([target('win-x64', 'windows', 'x64')], [host]), windowsX64)
  assert.deepEqual(result.nativeComponents, [host])
  assert.deepEqual(result.payloadFiles?.map(file => [file.entry, file.ownerComponentId, file.targetId]), [
    ['lib/helper.exe', 'host', 'win-x64'], ['lib/model.bin', 'host', 'win-x64']
  ])
  const mac = resolvePluginRuntimeTarget(manifest([target('win-x64', 'windows', 'x64'), target('mac-js', 'macos', 'any')], [host]), macArm64)
  assert.equal(mac.payloadFiles, undefined)
  assert.deepEqual(mac.nativeComponents, [])
})

test('payload declaration is closed, hashed and restricted to a valid Windows NativeHost DLL', () => {
  const cases: Record<string, unknown>[] = [
    { sha256: undefined }, { sha256: 'A'.repeat(64) }, { payloadFiles: null },
    { kind: 'worker', arch: 'x64', entry: 'lib/helper.exe', abi: 'worker/v1' },
    { kind: 'shared-library', abi: 'windows-pe/v1' }, { protocolVersion: 2 }, { entry: 'native/host.dll' }
  ]
  for (const fields of cases) assert.throws(() => resolvePluginRuntimeTarget(
    manifest([target('win-x64', 'windows', 'x64')], [payloadHost(fields)]), windowsX64),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid)
  for (const entry of ['../lib/a.exe', '/lib/a.exe', 'C:/lib/a.exe', 'lib/a:ads.exe', 'lib//a.exe',
    'lib/./a.exe', 'lib/../a.exe', 'lib/a\\b.exe', 'lib/*.exe', 'lib/nul.exe', 'lib/a. /b.exe', 'lib/a\u0000.exe']) {
    assert.throws(() => resolvePluginRuntimeTarget(manifest([target('win-x64', 'windows', 'x64')], [payloadHost({
      payloadFiles: [{ entry, format: 'pe', arch: 'ia32', sha256: 'b'.repeat(64) }]
    })]), windowsX64), (error: any) => error?.code === errorCodes.pluginPackageInvalid)
  }
  for (const file of [
    { entry: 'lib/a.exe', format: 'pe', sha256: 'b'.repeat(64) },
    { entry: 'lib/a.exe', format: 'pe', arch: 'any', sha256: 'b'.repeat(64) },
    { entry: 'lib/a.exe', format: 'data', sha256: 'b'.repeat(64) },
    { entry: 'lib/a.bin', format: 'data', arch: 'ia32', sha256: 'b'.repeat(64) },
    { entry: 'lib/a.bin', format: 'other', sha256: 'b'.repeat(64) },
    { entry: 'lib/a.bin', format: 'data', sha256: 'b'.repeat(64), protocolVersion: 1 }
  ]) assert.throws(() => resolvePluginRuntimeTarget(manifest([target('win-x64', 'windows', 'x64')], [payloadHost({ payloadFiles: [file] })]), windowsX64),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid)
})

test('payload groups require bound dependency hashes and reject case-fold duplicates', () => {
  const dependency = { id: 'dependency', targetId: 'win-x64', kind: 'shared-library', arch: 'ia32',
    abi: 'windows-pe/v1', entry: 'lib/dependency.dll', hostComponentId: 'host' }
  assert.throws(() => resolvePluginRuntimeTarget(manifest([target('win-x64', 'windows', 'x64')], [payloadHost(), dependency]), windowsX64),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid)
  assert.equal(resolvePluginRuntimeTarget(manifest([target('win-x64', 'windows', 'x64')], [payloadHost(), { ...dependency, sha256: 'd'.repeat(64) }]), windowsX64).nativeComponents.length, 2)
  for (const entry of ['lib/PLUGIN.dll', 'lib/HELPER.exe']) assert.throws(() => resolvePluginRuntimeTarget(
    manifest([target('win-x64', 'windows', 'x64')], [payloadHost({ payloadFiles: [
      ...payloadHost().payloadFiles, { entry, format: 'pe', arch: 'ia32', sha256: 'd'.repeat(64) }
    ] })]), windowsX64), (error: any) => error?.code === errorCodes.pluginPackageInvalid)
})

function target(
  id: string,
  platform: 'windows' | 'macos',
  arch: 'any' | 'ia32' | 'x64' | 'arm64' | 'universal',
  runtime: 'electron' | 'legacy-delphi' = 'electron'
) {
  return { id, platform, runtime, arch }
}

function manifest(targets: unknown[], nativeComponents: unknown[] = [], fields: Record<string, unknown> = {}) {
  return { targets, nativeComponents, ...fields }
}

function component(
  id: string,
  targetId: string,
  arch: 'any' | 'ia32' | 'x64' | 'arm64' | 'universal',
  kind: 'dll' | 'shared-library' | 'worker' = 'shared-library',
  entry = 'native/component.node'
) {
  return { id, kind, targetId, arch, abi: 'node-api/v1', entry }
}

test('allows the current Windows Electron ia32 runtime to read legacy manifests without targets', () => {
  const result = resolvePluginRuntimeTarget({ entry: 'index.html' }, windowsIa32)
  assert.equal(result.legacyWindows, true)
  assert.equal(result.target, undefined)
  assert.deepEqual(result.nativeComponents, [])
})

test('rejects a targetless manifest on macOS with an actionable NOT_SUPPORTED error', () => {
  assert.throws(
    () => resolvePluginRuntimeTarget({ entry: 'index.html' }, macArm64),
    (error: any) => error?.code === errorCodes.notSupported && /未声明 targets/.test(error.message)
  )
})

test('matches explicit macOS x64 and arm64 targets exactly', () => {
  assert.equal(resolvePluginRuntimeTarget(manifest([target('mac-x64', 'macos', 'x64')]), macX64).target?.id, 'mac-x64')
  assert.equal(resolvePluginRuntimeTarget(manifest([target('mac-arm64', 'macos', 'arm64')]), macArm64).target?.id, 'mac-arm64')
})

test('matches a macOS universal target on both supported Electron architectures', () => {
  const targets = [target('mac-universal', 'macos', 'universal')]
  assert.equal(resolvePluginRuntimeTarget(manifest(targets), macX64).target?.id, 'mac-universal')
  assert.equal(resolvePluginRuntimeTarget(manifest(targets), macArm64).target?.id, 'mac-universal')
})

test('rejects unsupported ia32 Mac runtime identities and target declarations', () => {
  const macIa32: PluginRuntimeIdentity = { platform: 'darwin', runtime: 'electron', arch: 'ia32' }
  assert.throws(
    () => resolvePluginRuntimeTarget(manifest([target('mac-ia32', 'macos', 'ia32')]), macArm64),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /macOS Electron 目标不支持 ia32/.test(error.message)
  )
  assert.throws(
    () => resolvePluginRuntimeTarget(manifest([target('mac-x64', 'macos', 'x64')]), macIa32),
    (error: any) => error?.code === errorCodes.notSupported && /不支持 ia32 进程架构/.test(error.message)
  )
})

test('selects minSdkContractVersion 2 on the current host and supports version injection', () => {
  assert.equal(SDK_HOST_MAXIMUM_CONTRACT_VERSION, 2, 'the host maximum is the production source of truth')
  const minimumV2 = { ...target('mac-universal-v2', 'macos', 'universal'), minSdkContractVersion: 2 }
  const packageManifest = manifest([minimumV2])

  assert.throws(
    () => resolvePluginRuntimeTarget(packageManifest, macArm64, { sdkContractVersion: 1 }),
    (error: any) => error?.code === errorCodes.notSupported && /要求 SDK 契约版本 2/.test(error.message)
  )
  assert.throws(
    () => resolvePluginRuntimeTarget(packageManifest, macArm64, { sdkContractVersion: 1 }),
    (error: any) => error?.code === errorCodes.notSupported && /要求 SDK 契约版本 2/.test(error.message)
  )
  assert.equal(
    resolvePluginRuntimeTarget(packageManifest, macArm64).target?.id,
    'mac-universal-v2'
  )
  assert.equal(
    resolvePluginRuntimeTarget(packageManifest, macArm64, { sdkContractVersion: 2 }).target?.id,
    'mac-universal-v2'
  )
  assert.equal(
    resolvePluginRuntimeTarget(manifest([target('mac-default-minimum', 'macos', 'arm64')]), macArm64).target?.id,
    'mac-default-minimum',
    'the public minSdkContractVersion field is optional; omission means no extra minimum'
  )
})

test('fails closed when the injected host contract version is missing or invalid', () => {
  const packageManifest = manifest([target('mac-js', 'macos', 'arm64')])
  const invalidOptions: unknown[] = [
    {},
    { sdkContractVersion: undefined },
    { sdkContractVersion: 0 },
    { sdkContractVersion: -1 },
    { sdkContractVersion: 1.5 },
    { sdkContractVersion: Number.NaN },
    { sdkContractVersion: Number.POSITIVE_INFINITY },
    { sdkContractVersion: Number.MAX_SAFE_INTEGER + 1 },
    { sdkContractVersion: '2' },
    { sdkContractVersion: 2, unexpected: true },
    null
  ]

  for (const options of invalidOptions) {
    assert.throws(
      () => resolvePluginRuntimeTarget(
        packageManifest,
        macArm64,
        options as PluginRuntimeTargetResolverOptions
      ),
      (error: any) => error?.code === errorCodes.notSupported
    )
  }
})

test('rejects missing and invalid target minimum contract versions without blocking omitted optional values', () => {
  for (const minSdkContractVersion of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.throws(
      () => resolvePluginRuntimeTarget(
        manifest([{
          ...target('mac-invalid-minimum', 'macos', 'arm64'),
          minSdkContractVersion
        }]),
        macArm64
      ),
      (error: any) => error?.code === errorCodes.pluginPackageInvalid
    )
  }
})

test('allows arch=any only for a JavaScript-only target', () => {
  const targets = [target('mac-js', 'macos', 'any')]
  assert.equal(resolvePluginRuntimeTarget(manifest(targets), macX64).target?.id, 'mac-js')
  assert.equal(resolvePluginRuntimeTarget(manifest(targets), macArm64).target?.id, 'mac-js')
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest(targets, [component('native', 'mac-js', 'any')]),
      macArm64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /不能是 any/.test(error.message)
  )
})

test('returns only the selected target components and leaves Windows DLL assets unselected on macOS', () => {
  const windowsTarget = target('win-ia32', 'windows', 'ia32')
  const macTarget = target('mac-js', 'macos', 'any')
  const windowsDll = component('win-dll', 'win-ia32', 'ia32', 'dll', 'lib/plugin.dll')
  const result = resolvePluginRuntimeTarget(manifest([windowsTarget, macTarget], [windowsDll]), macArm64)

  assert.equal(result.target?.id, 'mac-js')
  assert.deepEqual(result.nativeComponents, [])
})

test('binds an actual ia32 NativeHost32 DLL to the Windows Electron x64 target', () => {
  const windowsX64Target = target('win-x64', 'windows', 'x64')
  const nativeHost32Dll = {
    ...component('native-host32-dll', 'win-x64', 'ia32', 'dll', 'lib/plugin.dll'),
    abi: 'ztools-native-host/v1',
    protocolVersion: 1
  }
  const result = resolvePluginRuntimeTarget(
    manifest([windowsX64Target], [nativeHost32Dll]),
    windowsX64
  )

  assert.equal(result.target?.id, 'win-x64')
  assert.equal(result.nativeComponents[0]?.arch, 'ia32')
  assert.deepEqual(result.nativeComponents, [nativeHost32Dll])
  assert.throws(
    () => resolvePluginRuntimeTarget(manifest([windowsX64Target], [nativeHost32Dll]), windowsIa32),
    (error: any) => error?.code === errorCodes.notSupported && /windows Electron ia32/.test(error.message)
  )
})

test('fails closed for other cross-architecture bindings and false NativeHost32 ABI claims', () => {
  const windowsX64Target = target('win-x64', 'windows', 'x64')
  const nativeHost32Dll = {
    ...component('native-host32-dll', 'win-x64', 'ia32', 'dll', 'lib/plugin.dll'),
    abi: 'ztools-native-host/v1',
    protocolVersion: 1
  }
  const invalidComponents = [
    { ...nativeHost32Dll, abi: 'unknown-dll/v1' },
    { ...nativeHost32Dll, kind: 'shared-library', entry: 'native/component.node' },
    { ...nativeHost32Dll, kind: 'worker', entry: 'native/worker.exe' },
    { ...nativeHost32Dll, kind: 'shared-library', abi: 'windows-pe/v1', entry: 'lib/component.dll' },
    { ...nativeHost32Dll, kind: 'worker', abi: 'windows-pe/v1', entry: 'native/worker.exe' },
    { ...nativeHost32Dll, kind: 'shared-library', abi: 'unknown-pe/v1', entry: 'lib/component.dll' },
    { ...nativeHost32Dll, arch: 'x64' },
    { ...nativeHost32Dll, protocolVersion: 2 },
    { ...nativeHost32Dll, protocolVersion: undefined },
    { ...nativeHost32Dll, abi: 'unknown-dll/v1', kind: 'worker', entry: 'native/worker.exe' }
  ]

  for (const invalidComponent of invalidComponents) {
    assert.throws(
      () => resolvePluginRuntimeTarget(
        manifest([windowsX64Target], [invalidComponent]),
        windowsX64
      ),
      (error: any) => error?.code === errorCodes.pluginPackageInvalid
    )
  }

  const macTarget = target('mac-x64', 'macos', 'x64')
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([macTarget], [{ ...nativeHost32Dll, targetId: macTarget.id }]),
      macX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid
  )
})

test('binds ia32 Windows PE dependencies to an explicitly identified NativeHost32 DLL', () => {
  const windowsX64Target = target('win-x64', 'windows', 'x64')
  const nativeHost32Dll = {
    ...component('native-host32-dll', 'win-x64', 'ia32', 'dll', 'lib/plugin.dll'),
    abi: 'ztools-native-host/v1',
    protocolVersion: 1
  }
  const mediaService = {
    id: 'media-service',
    kind: 'shared-library',
    targetId: 'win-x64',
    arch: 'ia32',
    abi: 'windows-pe/v1',
    entry: 'lib/MediaService.dll',
    hostComponentId: nativeHost32Dll.id
  }
  const result = resolvePluginRuntimeTarget(
    manifest([windowsX64Target], [mediaService, nativeHost32Dll]),
    windowsX64
  )

  assert.deepEqual(result.nativeComponents, [mediaService, nativeHost32Dll])
  assert.equal(result.nativeComponents[0]?.arch, 'ia32')

  const unboundDependency = { ...mediaService }
  delete (unboundDependency as { hostComponentId?: string }).hostComponentId
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([windowsX64Target], [unboundDependency, nativeHost32Dll]),
      windowsX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /Windows Electron x64 target/.test(error.message)
  )

  const unknownAbiDependency = { ...mediaService, abi: 'unknown-pe/v1' }
  delete (unknownAbiDependency as { hostComponentId?: string }).hostComponentId
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([windowsX64Target], [unknownAbiDependency, nativeHost32Dll]),
      windowsX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /arch 必须与 target/.test(error.message)
  )

  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([windowsX64Target], [{ ...mediaService, entry: 'lib/MediaService.node' }, nativeHost32Dll]),
      windowsX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /使用 windows-pe\/v1 时必须是 \.dll/.test(error.message)
  )

  const unknownHost = { ...mediaService, hostComponentId: 'missing-host' }
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([windowsX64Target], [unknownHost, nativeHost32Dll]),
      windowsX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /未知组件/.test(error.message)
  )

  const chainedDependency = { ...mediaService, hostComponentId: 'media-service-chain' }
  const dependencyChain = { ...mediaService, id: 'media-service-chain', hostComponentId: nativeHost32Dll.id }
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([windowsX64Target], [chainedDependency, dependencyChain, nativeHost32Dll]),
      windowsX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /必须引用 ia32 ztools-native-host\/v1 DLL/.test(error.message)
  )

  const otherTarget = target('win-ia32', 'windows', 'ia32')
  const crossTargetHost = {
    ...nativeHost32Dll,
    id: 'native-host32-other-target',
    targetId: otherTarget.id
  }
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([windowsX64Target, otherTarget], [
        { ...mediaService, hostComponentId: crossTargetHost.id },
        crossTargetHost
      ]),
      windowsX64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /同一 target/.test(error.message)
  )
})

test('rejects a target declaration that does not match the current platform/runtime/architecture', () => {
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([target('win-x64', 'windows', 'x64')]),
      macArm64
    ),
    (error: any) => error?.code === errorCodes.notSupported && /macos Electron arm64/.test(error.message)
  )
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([target('win-delphi', 'windows', 'ia32', 'legacy-delphi')]),
      windowsIa32
    ),
    (error: any) => error?.code === errorCodes.notSupported && /windows Electron ia32/.test(error.message)
  )
})

test('rejects duplicate, unknown, and malformed target declarations', () => {
  const duplicateId = [target('same', 'macos', 'arm64'), target('same', 'macos', 'x64')]
  assert.throws(
    () => resolvePluginRuntimeTarget(manifest(duplicateId), macArm64),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /重复/.test(error.message)
  )
  for (const malformed of [
    { id: 'bad', platform: 'linux', runtime: 'electron', arch: 'arm64' },
    { id: 'bad', platform: 'macos', runtime: 'unknown', arch: 'arm64' },
    { id: 'bad', platform: 'macos', runtime: 'electron', arch: 'mips' },
    { id: 'bad', platform: 'macos', runtime: 'electron', arch: 'arm64', surprise: true },
    { platform: 'macos', runtime: 'electron', arch: 'arm64' }
  ]) {
    assert.throws(
      () => resolvePluginRuntimeTarget(manifest([malformed]), macArm64),
      (error: any) => error?.code === errorCodes.pluginPackageInvalid
    )
  }
})

test('unknown manifest property errors do not echo untrusted keys', () => {
  const untrustedKey = 'authorization=Bearer secret-token\r\nforged'
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([{
        ...target('mac-js', 'macos', 'arm64'),
        [untrustedKey]: 'ignored'
      }]),
      macArm64
    ),
    (error: any) => {
      if (error?.code !== errorCodes.pluginPackageInvalid) return false
      const publicError = toPublicError(error)
      return publicError.message === 'targets[0] 包含未知字段' &&
        !publicError.message.includes('secret-token') &&
        !publicError.message.includes('forged')
    }
  )
})

test('rejects ambiguous overlapping targets for the current runtime', () => {
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([target('mac-universal', 'macos', 'universal'), target('mac-arm64', 'macos', 'arm64')]),
      macArm64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /多个/.test(error.message)
  )
})

test('rejects a DLL bound to a macOS target and active legacy DLL fields on macOS', () => {
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest(
        [target('mac-native', 'macos', 'arm64')],
        [component('mac-dll', 'mac-native', 'arm64', 'dll', 'lib/plugin.dll')]
      ),
      macArm64
    ),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid && /只能绑定 Windows/.test(error.message)
  )
  for (const fields of [{ dllloader: 'lib/plugin.dll' }, { requireAdmin: true }]) {
    assert.throws(
      () => resolvePluginRuntimeTarget(
        manifest([target('mac-js', 'macos', 'arm64')], [], fields),
        macArm64
      ),
      (error: any) => error?.code === errorCodes.notSupported && /dllloader\/requireAdmin/.test(error.message)
    )
  }
  assert.throws(
    () => resolvePluginRuntimeTarget({ entry: 'index.html', dllloader: 'lib/plugin.dll' }, macArm64),
    (error: any) => error?.code === errorCodes.notSupported && /dllloader\/requireAdmin/.test(error.message)
  )
})

test('rejects selected macOS native components and unbound common libraries until their runtimes exist', () => {
  const macTarget = target('mac-native', 'macos', 'arm64')
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([macTarget], [component('mac-library', 'mac-native', 'arm64')]),
      macArm64
    ),
    (error: any) => error?.code === errorCodes.notSupported && /只能安装纯 JavaScript/.test(error.message)
  )
  assert.throws(
    () => resolvePluginRuntimeTarget(
      manifest([target('mac-js', 'macos', 'any')], [], { commonLibs: ['ffmpeg-1.0.0'] }),
      macArm64
    ),
    (error: any) => error?.code === errorCodes.notSupported && /未绑定运行目标的 commonLibs/.test(error.message)
  )
  assert.equal(
    resolvePluginRuntimeTarget(
      manifest([target('mac-js', 'macos', 'any')], [], { commonLibs: [] }),
      macArm64
    ).target?.id,
    'mac-js'
  )
})
