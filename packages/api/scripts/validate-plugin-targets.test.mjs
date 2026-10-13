import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const validatorPath = resolve(scriptsDir, 'validate-plugin.mjs')
const pluginSchemaPath = [
  resolve(scriptsDir, '../schema/plugin.schema.json'),
  resolve(scriptsDir, '../sdk/js/plugin.schema.json')
].find(existsSync) ?? resolve(scriptsDir, '../schema/plugin.schema.json')
const contractFixturesPath = [
  resolve(scriptsDir, '../contracts/fixtures'),
  resolve(scriptsDir, '../sdk/contracts/fixtures')
].find(existsSync) ?? resolve(scriptsDir, '../contracts/fixtures')

function readContractFixture(relativePath) {
  return JSON.parse(readFileSync(resolve(contractFixturesPath, relativePath), 'utf8'))
}

test('plugin schema resolves its target reference to the shared contract file', () => {
  const pluginSchema = JSON.parse(readFileSync(pluginSchemaPath, 'utf8'))
  const contractSchemaPath = resolve(dirname(pluginSchemaPath), '../contracts/platform-target.schema.json')
  const contractSchema = JSON.parse(readFileSync(contractSchemaPath, 'utf8'))
  const targetProperty = pluginSchema.properties.targets

  assert.ok(targetProperty)
  assert.equal(contractSchema.properties.minSdkContractVersion.type, 'integer')
  assert.equal(contractSchema.properties.minSdkContractVersion.minimum, 1)
  assert.ok(!pluginSchema.required.includes('targets'), 'targets must remain optional for legacy manifests')
  assert.equal(targetProperty.minItems, 1)
  assert.equal(targetProperty.uniqueItems, true)
  const targetReference = targetProperty.items.allOf.find((schema) => schema.$ref)
  assert.equal(new URL(targetReference.$ref, pluginSchema.$id).href, contractSchema.$id)
  assert.ok(targetProperty.items.allOf.some((schema) => schema.required?.includes('id')))
  assert.equal(pluginSchema.properties.nativeComponents.type, 'array')
  assert.ok(!pluginSchema.properties.nativeComponents.minItems, 'an empty array represents a JavaScript-only plugin')
  assert.ok(pluginSchema.allOf.some((rule) => rule.if?.required?.includes('targets') &&
    rule.then?.required?.includes('nativeComponents')))
  const nativeComponent = pluginSchema.$defs.nativeComponent
  assert.ok(nativeComponent.properties.hostComponentId)
  assert.ok(nativeComponent.allOf.some((rule) =>
    rule.if?.properties?.abi?.const === 'ztools-native-host/v1' &&
    rule.then?.properties?.arch?.const === 'ia32' &&
    rule.then?.properties?.protocolVersion?.const === 1 &&
    rule.then?.required?.includes('protocolVersion')
  ))
  assert.ok(nativeComponent.allOf.some((rule) =>
    rule.if?.properties?.abi?.const === 'windows-pe/v1' &&
    rule.then?.properties?.kind?.const === 'shared-library' &&
    rule.then?.properties?.arch?.const === 'ia32' &&
    rule.then?.properties?.entry?.pattern === '\\.[dD][lL][lL]$'
  ))
  const strictTargetRootRule = pluginSchema.allOf.find((rule) =>
    rule.if?.required?.includes('targets') && rule.then?.propertyNames?.enum
  )
  assert.deepEqual(new Set(strictTargetRootRule.then.propertyNames.enum), new Set(Object.keys(pluginSchema.properties)))
  assert.equal(pluginSchema.additionalProperties, true, 'legacy manifests retain their extension behavior')
  const componentSchema = pluginSchema.$defs.nativeComponent
  assert.ok(componentSchema.required.includes('targetId'))
  assert.equal(new URL(componentSchema.properties.abi.$ref, pluginSchema.$id).href,
    `${contractSchema.$id}#/properties/abi`)
  assert.equal(new URL(componentSchema.properties.id.$ref, pluginSchema.$id).href,
    `${contractSchema.$id}#/properties/id`)
  assert.equal(new URL(componentSchema.properties.arch.allOf[0].$ref, pluginSchema.$id).href,
    `${contractSchema.$id}#/properties/arch`)
  assert.equal(componentSchema.properties.arch.allOf[1].not.const, 'any')

  const unsafePathPattern = new RegExp(pluginSchema.$defs.relativePath.not.pattern)
  for (const path of ['../escape', '/absolute', 'C:\\absolute', 'nested/stream:name', 'nul\u0000path']) {
    assert.equal(unsafePathPattern.test(path), true, `schema should reject ${JSON.stringify(path)}`)
  }
})

function createPlugin(overrides = {}, prepare = () => {}) {
  const pluginDir = mkdtempSync(join(tmpdir(), 'ztools-plugin-targets-'))
  const manifest = {
    id: 'fixture-plugin',
    name: 'Fixture Plugin',
    version: '1.0.0',
    description: 'Validator fixture',
    author: 'Tests',
    entry: 'index.html',
    icon: 'icon.svg',
    keyword: 'fixture',
    window: {
      width: 640,
      height: 480,
      resizable: true,
      singleInstance: false
    },
    ...overrides
  }

  writeFileSync(join(pluginDir, 'index.html'), [
    '<script src="ztools://web/sdk/ztools-api.js"></script>',
    '<script src="ztools://web/sdk/plugin-sdk.js"></script>'
  ].join('\n'))
  writeFileSync(join(pluginDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  prepare(pluginDir, manifest)
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2))
  return pluginDir
}

function runValidator(pluginDir, { targetsOnly = false } = {}) {
  return spawnSync(process.execPath, [validatorPath, ...(targetsOnly ? ['--targets-only'] : []), pluginDir], { encoding: 'utf8' })
}

function withPlugin(t, overrides, prepare) {
  const pluginDir = createPlugin(overrides, prepare)
  t.after(() => rmSync(pluginDir, { recursive: true, force: true }))
  return pluginDir
}

const windowsElectron = {
  id: 'windows-electron-ia32',
  platform: 'windows',
  runtime: 'electron',
  arch: 'ia32',
  abi: 'ztools-electron-plugin/v1',
  minSdkContractVersion: 1
}

const windowsElectronX64 = {
  ...windowsElectron,
  id: 'windows-electron-x64',
  arch: 'x64'
}

const macosElectronUniversal = {
  id: 'macos-electron-universal',
  platform: 'macos',
  runtime: 'electron',
  arch: 'universal',
  minSdkContractVersion: 2
}

const windowsNativeComponent = {
  id: 'image-engine',
  kind: 'worker',
  targetId: windowsElectron.id,
  arch: windowsElectron.arch,
  abi: 'ztools-image-engine/v1',
  entry: 'native/win32/image-engine',
  protocolVersion: 1
}

const windowsDllComponent = {
  id: 'legacy-dll',
  kind: 'dll',
  targetId: windowsElectron.id,
  arch: windowsElectron.arch,
  abi: 'ztools-legacy-dll/v1',
  entry: 'lib/Legacy.dll'
}

const nativeHost32DllComponent = {
  id: 'native-host32-dll',
  kind: 'dll',
  targetId: windowsElectronX64.id,
  arch: 'ia32',
  abi: 'ztools-native-host/v1',
  entry: 'lib/Plugin.dll',
  protocolVersion: 1
}

const windowsPeDependencyComponent = {
  id: 'media-service',
  kind: 'shared-library',
  targetId: windowsElectronX64.id,
  arch: 'ia32',
  abi: 'windows-pe/v1',
  entry: 'lib/MediaService.dll',
  hostComponentId: nativeHost32DllComponent.id
}

test('legacy Windows manifest remains valid and does not imply macOS support', (t) => {
  const pluginDir = withPlugin(t, {
    dllloader: 'lib/Legacy.dll',
    requireAdmin: true
  }, (dir) => {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'Legacy.dll'), 'fixture')
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /不推断 macOS 支持/)
})

test('target-only validation ignores unrelated entry HTML SDK rules but still rejects invalid targets', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [macosElectronUniversal],
    nativeComponents: []
  }, (dir) => {
    writeFileSync(join(dir, 'index.html'), '<main>Target contract fixture</main>')
  })

  const fullResult = runValidator(pluginDir)
  assert.equal(fullResult.status, 1)
  assert.match(fullResult.stderr, /入口 HTML 必须引入/)

  const targetResult = runValidator(pluginDir, { targetsOnly: true })
  assert.equal(targetResult.status, 0, targetResult.stdout + targetResult.stderr)

  const invalidDir = withPlugin(t, {
    targets: [{ ...macosElectronUniversal, unexpected: true }],
    nativeComponents: []
  })
  const invalidResult = runValidator(invalidDir, { targetsOnly: true })
  assert.equal(invalidResult.status, 1)
  assert.match(invalidResult.stderr, /unexpected 不是支持的目标字段/)
})

test('unknown root fields are rejected only for explicit target manifests', (t) => {
  const legacyDir = withPlugin(t, { localExtension: true })
  const legacyResult = runValidator(legacyDir, { targetsOnly: true })
  assert.equal(legacyResult.status, 0, legacyResult.stdout + legacyResult.stderr)

  const targetDir = withPlugin(t, {
    targets: [macosElectronUniversal],
    nativeComponents: [],
    minSdkContractVresion: 2
  })
  const targetResult = runValidator(targetDir, { targetsOnly: true })
  assert.equal(targetResult.status, 1)
  assert.match(targetResult.stderr, /plugin\.json\.minSdkContractVresion 不是支持的顶层字段/)
})

test('explicit Windows and macOS targets validate as separate declarations', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [
      windowsElectron,
      macosElectronUniversal
    ],
    nativeComponents: [],
    requireAdmin: false
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /OK /)
})

test('rejects a 32-bit Mac target even when the architecture name is otherwise known', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [{ id: 'macos-electron-ia32', platform: 'macos', runtime: 'electron', arch: 'ia32' }],
    nativeComponents: []
  })

  const result = runValidator(pluginDir, { targetsOnly: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /targets\[0\]\.arch 值不受支持/)
})

test('rejects the shared macOS ia32 target fixture', (t) => {
  const target = readContractFixture('invalid/platform-target/macos-electron-ia32.json')
  const pluginDir = withPlugin(t, { targets: [target], nativeComponents: [] })
  const result = runValidator(pluginDir, { targetsOnly: true })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /targets\[0\]\.arch 值不受支持/)
})

test('targets must be non-empty and each declaration must include id, platform, runtime, and arch', (t) => {
  const emptyTargetsDir = withPlugin(t, { targets: [], nativeComponents: [] })
  const emptyTargetsResult = runValidator(emptyTargetsDir)
  assert.equal(emptyTargetsResult.status, 1)
  assert.match(emptyTargetsResult.stderr, /targets 至少要声明一个目标/)

  const missingFieldsDir = withPlugin(t, {
    targets: [{ platform: 'macos', arch: 'arm64' }],
    nativeComponents: []
  })
  const missingFieldsResult = runValidator(missingFieldsDir)
  assert.equal(missingFieldsResult.status, 1)
  assert.match(missingFieldsResult.stderr, /targets\[0\]\.runtime/)
  assert.match(missingFieldsResult.stderr, /targets\[0\]\.id/)
})

test('unknown contract fields, invalid ABI, and invalid SDK version are rejected', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [{
      ...windowsElectron,
      abi: 'not-versioned',
      minSdkContractVersion: 0,
      host: 'unknown'
    }],
    nativeComponents: []
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /targets\[0\]\.abi/)
  assert.match(result.stderr, /targets\[0\]\.minSdkContractVersion/)
  assert.match(result.stderr, /targets\[0\]\.host/)
})

test('plugin validator rejects the shared wrong-type minimum contract version fixture', (t) => {
  const invalidTarget = readContractFixture('invalid/platform-target/invalid-min-contract-version-type.json')
  const pluginDir = withPlugin(t, { targets: [invalidTarget], nativeComponents: [] })
  const result = runValidator(pluginDir)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /targets\[0\]\.minSdkContractVersion 类型不正确/)
})

test('plugin validator accepts a valid v2 minimum declaration while v1 runtime negotiation remains incompatible', (t) => {
  const fixture = readContractFixture('negotiation/runtime-contract-version-too-old.json')
  const target = { ...fixture.targetRequirement, id: 'windows-electron-min-sdk-v2' }
  const pluginDir = withPlugin(t, { targets: [target], nativeComponents: [] })
  const result = runValidator(pluginDir)

  assert.equal(fixture.runtime.contractVersion, 1)
  assert.equal(target.minSdkContractVersion, 2)
  assert.equal(fixture.expectedCompatible, false)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('exact duplicates and overlapping architecture selectors are rejected as ambiguous', (t) => {
  const duplicateDir = withPlugin(t, {
    targets: [windowsElectron, windowsElectron],
    nativeComponents: []
  })
  const duplicateResult = runValidator(duplicateDir)
  assert.equal(duplicateResult.status, 1)
  assert.match(duplicateResult.stderr, /匹配范围重叠/)
  assert.match(duplicateResult.stderr, /targets\.id 必须唯一/)

  const overlapDir = withPlugin(t, {
    targets: [
      { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' },
      { id: 'macos-electron-arm64', platform: 'macos', runtime: 'electron', arch: 'arm64' }
    ],
    nativeComponents: []
  })
  const overlapResult = runValidator(overlapDir)
  assert.equal(overlapResult.status, 1)
  assert.match(overlapResult.stderr, /匹配范围重叠/)
})

test('distinct ABI declarations disambiguate otherwise matching targets', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [
      { id: 'windows-electron-v1', platform: 'windows', runtime: 'electron', arch: 'ia32', abi: 'ztools-electron-plugin/v1' },
      { id: 'windows-electron-v2', platform: 'windows', runtime: 'electron', arch: 'ia32', abi: 'ztools-electron-plugin/v2' }
    ],
    nativeComponents: []
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('explicit JavaScript-only targets require an explicit empty component list', (t) => {
  const missingComponentsDir = withPlugin(t, { targets: [windowsElectron] })
  const missingComponentsResult = runValidator(missingComponentsDir)
  assert.equal(missingComponentsResult.status, 1)
  assert.match(missingComponentsResult.stderr, /nativeComponents 必须是数组/)

  const unboundComponentsDir = withPlugin(t, { nativeComponents: [] })
  const unboundComponentsResult = runValidator(unboundComponentsDir)
  assert.equal(unboundComponentsResult.status, 1)
  assert.match(unboundComponentsResult.stderr, /nativeComponents 必须通过显式 targets/)
})

test('native components bind by unique targetId and require exact architecture plus an independent ABI', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [windowsElectron],
    nativeComponents: [windowsNativeComponent]
  }, (dir) => {
    mkdirSync(join(dir, 'native', 'win32'), { recursive: true })
    writeFileSync(join(dir, 'native', 'win32', 'image-engine'), 'fixture')
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.notEqual(windowsNativeComponent.abi, windowsElectron.abi, 'component ABI is independent from target ABI')
})

test('native component schema rejects missing fields, duplicate IDs, dangling targets, and ABI errors', (t) => {
  const cases = [
    {
      components: [{ ...windowsNativeComponent, kind: undefined }],
      expected: /nativeComponents\[0\]\.kind 为必填字段/
    },
    {
      components: [windowsNativeComponent, { ...windowsNativeComponent, entry: 'native/win32/other' }],
      expected: /nativeComponents\[1\]\.id 重复/
    },
    {
      components: [{ ...windowsNativeComponent, targetId: 'missing-target' }],
      expected: /targetId 必须唯一引用一个 targets 项/
    },
    {
      components: [{ ...windowsNativeComponent, abi: 'unversioned-abi' }],
      expected: /nativeComponents\[0\]\.abi/
    }
  ]

  for (const { components, expected } of cases) {
    const pluginDir = withPlugin(t, { targets: [windowsElectron], nativeComponents: components })
    const result = runValidator(pluginDir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, expected)
  }
})

test('native component architecture matches the target except for the explicit NativeHost32 x64 binding', (t) => {
  const mismatchDir = withPlugin(t, {
    targets: [windowsElectron],
    nativeComponents: [{ ...windowsNativeComponent, arch: 'x64' }]
  })
  const mismatchResult = runValidator(mismatchDir)
  assert.equal(mismatchResult.status, 1)
  assert.match(mismatchResult.stderr, /arch 必须与 targets\[0\]\.arch 精确相等/)

  const universalDir = withPlugin(t, {
    targets: [macosElectronUniversal],
    nativeComponents: [{
      ...windowsNativeComponent,
      targetId: macosElectronUniversal.id,
      arch: 'arm64'
    }]
  })
  const universalResult = runValidator(universalDir)
  assert.equal(universalResult.status, 1)
  assert.match(universalResult.stderr, /arch 必须与 targets\[0\]\.arch 精确相等/)
})

test('accepts an x64 target with an ia32 NativeHost32 DLL and explicitly bound ia32 PE dependency', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [windowsElectronX64],
    nativeComponents: [windowsPeDependencyComponent, nativeHost32DllComponent]
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /尚未生成/)
})

const payloadHash = 'a'.repeat(64)
const payloadData = { entry: 'lib/Model/RecDict', format: 'data', sha256: payloadHash }
const payloadPe = { entry: 'lib/OCR/OCR.exe', format: 'pe', arch: 'x64', sha256: payloadHash }
const payloadHost = {
  ...nativeHost32DllComponent,
  sha256: payloadHash,
  payloadFiles: [payloadPe, payloadData]
}

test('payload schema closes fields and requires hashes without changing native component execution kinds', () => {
  const schema = JSON.parse(readFileSync(pluginSchemaPath, 'utf8'))
  const component = schema.$defs.nativeComponent
  const payload = schema.$defs.nativePayloadFile
  assert.deepEqual(component.properties.kind.enum, ['dll', 'shared-library', 'worker'])
  assert.equal(component.properties.sha256.$ref, '#/$defs/sha256')
  assert.equal(component.properties.payloadFiles.items.$ref, '#/$defs/nativePayloadFile')
  assert.equal(payload.additionalProperties, false)
  assert.deepEqual(payload.required, ['entry', 'format', 'sha256'])
  assert.deepEqual(payload.properties.arch.enum, ['ia32', 'x64'])
  assert.ok(component.allOf.some(rule => rule.if?.required?.includes('payloadFiles') &&
    rule.then?.required?.includes('sha256') && rule.then?.properties?.kind?.const === 'dll'))
  assert.ok(payload.allOf.some(rule => rule.then?.required?.includes('arch') &&
    rule.else?.not?.required?.includes('arch')))
  assert.equal(new RegExp(schema.$defs.sha256.pattern).test(payloadHash), true)
  assert.equal(new RegExp(schema.$defs.sha256.pattern).test(payloadHash.toUpperCase()), false)
})

test('accepts NativeHost payload PE architecture independent of its x64 target and data without arch', t => {
  const pluginDir = withPlugin(t, {
    targets: [windowsElectronX64],
    nativeComponents: [payloadHost, { ...windowsPeDependencyComponent, sha256: payloadHash }]
  }, dir => {
    for (const entry of ['lib/Plugin.dll', 'lib/MediaService.dll', payloadPe.entry, payloadData.entry]) {
      mkdirSync(dirname(join(dir, entry)), { recursive: true })
      writeFileSync(join(dir, entry), 'structural fixture; PE/hash bytes checked by build and Main owners')
    }
  })
  for (const targetsOnly of [false, true]) {
    const result = runValidator(pluginDir, { targetsOnly })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
})

test('rejects invalid payload owner, missing owner or bound dependency hashes, including empty payload arrays', t => {
  const cases = [
    { host: { ...payloadHost, sha256: undefined }, expected: /sha256 在声明 payloadFiles 时必填/ },
    { host: { ...payloadHost, sha256: payloadHash.toUpperCase() }, expected: /sha256 必须是64位小写/ },
    { host: { ...payloadHost, payloadFiles: [], sha256: undefined }, expected: /声明 payloadFiles 时必填/ },
    { host: { ...payloadHost, payloadFiles: null }, expected: /payloadFiles 必须是数组/ },
    { host: { ...payloadHost, kind: 'worker' }, expected: /payloadFiles 仅适用于/ },
    { host: { ...payloadHost, kind: 'shared-library' }, expected: /payloadFiles 仅适用于/ },
    { host: { ...payloadHost, abi: 'custom-host/v1' }, expected: /payloadFiles 仅适用于/ },
    { host: { ...payloadHost, arch: 'x64' }, expected: /payloadFiles 仅适用于/ },
    { host: { ...payloadHost, protocolVersion: 2 }, expected: /payloadFiles 仅适用于/ },
    { host: payloadHost, dependency: windowsPeDependencyComponent, expected: /绑定含 payloadFiles 的 Host 时必填/ },
    { host: { ...payloadHost, targetId: macosElectronUniversal.id }, target: macosElectronUniversal, expected: /payloadFiles 仅适用于/ }
  ]
  for (const { host, dependency, target, expected } of cases) {
    const pluginDir = withPlugin(t, {
      targets: [target ?? windowsElectronX64],
      nativeComponents: [host, ...(dependency ? [dependency] : [])]
    })
    const result = runValidator(pluginDir)
    assert.equal(result.status, 1, JSON.stringify(host))
    assert.match(result.stderr, expected)
  }
})

test('payload fields reject arbitrary execution metadata, unsupported formats, architectures, hashes, and unsafe paths', t => {
  const invalidFiles = [
    null, [], {},
    { ...payloadPe, format: 'worker' },
    { ...payloadPe, arch: undefined },
    { ...payloadPe, arch: 'any' },
    { ...payloadPe, arch: 'arm64' },
    { ...payloadPe, entry: 'lib/helper.node' },
    { ...payloadPe, sha256: undefined },
    { ...payloadPe, sha256: 'sha256:' + payloadHash },
    { ...payloadPe, sha256: payloadHash.toUpperCase() },
    { ...payloadData, arch: 'ia32' },
    { ...payloadData, entry: 'lib/fake.dll' },
    { ...payloadData, entry: 'lib/fake.EXE' },
    ...['targetId', 'hostComponentId', 'protocolVersion', 'command', 'args'].map(field => ({ ...payloadData, [field]: 'forbidden' })),
    ...['../escape', '/lib/absolute', 'C:/lib/a', '//server/a', 'lib/a:b', 'lib/a\\b', 'lib//a',
      'lib/./a', 'lib/../a', 'lib/a*', 'lib/a?', 'lib/a|b', 'lib/a<b', 'lib/a"b', 'lib/a.', 'lib/a /b',
      'lib/a\u0000b', 'lib/'].map(entry => ({ ...payloadData, entry }))
  ]
  for (const file of invalidFiles) {
    const pluginDir = withPlugin(t, {
      targets: [windowsElectronX64],
      nativeComponents: [{ ...payloadHost, payloadFiles: [file] }]
    })
    const result = runValidator(pluginDir, { targetsOnly: true })
    assert.equal(result.status, 1, JSON.stringify(file))
    assert.match(result.stderr, /payloadFiles\[0\]/)
  }
})

test('payload and component paths are unique per target and shared target inputs must have consistent metadata', t => {
  const otherHost = { ...payloadHost, id: 'other-host', targetId: windowsElectron.id }
  const cases = [
    [{ ...payloadHost, payloadFiles: [payloadData, { ...payloadData, entry: 'lib/model/RECDICT' }] }],
    [{ ...payloadHost, payloadFiles: [{ ...payloadData, entry: 'lib/plugin.DLL', format: 'pe', arch: 'ia32' }] }],
    [payloadHost, { ...nativeHost32DllComponent, id: 'same-path', entry: 'lib/PLUGIN.dll' }],
    [payloadHost, { ...otherHost, sha256: 'b'.repeat(64) }],
    [payloadHost, { ...otherHost, payloadFiles: [{ ...payloadPe, arch: 'ia32' }] }],
    [payloadHost, { ...otherHost, payloadFiles: [{ ...payloadData, sha256: 'b'.repeat(64) }] }]
  ]
  for (const components of cases) {
    const pluginDir = withPlugin(t, {
      targets: [windowsElectronX64, windowsElectron], nativeComponents: components
    })
    const result = runValidator(pluginDir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /同一 target.*重复|跨 target 复用/)
  }
  const matchingDir = withPlugin(t, {
    targets: [windowsElectronX64, windowsElectron], nativeComponents: [payloadHost, otherHost]
  })
  const matching = runValidator(matchingDir)
  assert.equal(matching.status, 0, matching.stdout + matching.stderr)
})

test('rejects unbound, misbound, or falsely described x64 NativeHost32 components', (t) => {
  const cases = [
    {
      components: [{ ...nativeHost32DllComponent, abi: 'unknown-dll/v1' }],
      expected: /arch 必须与 targets\[0\]\.arch 精确相等/
    },
    {
      components: [{ ...nativeHost32DllComponent, arch: 'x64' }],
      expected: /真实 ia32 架构/
    },
    {
      components: [{ ...nativeHost32DllComponent, protocolVersion: 2 }],
      expected: /protocolVersion 使用 ztools-native-host\/v1 时必须显式等于 1/
    },
    {
      components: [{ ...nativeHost32DllComponent, protocolVersion: undefined }],
      expected: /protocolVersion 使用 ztools-native-host\/v1 时必须显式等于 1/
    },
    {
      components: [{ ...nativeHost32DllComponent, kind: 'shared-library' }],
      expected: /仅支持 Windows Electron kind=dll/
    },
    {
      components: [{ ...nativeHost32DllComponent, kind: 'worker', entry: 'native/worker.exe' }],
      expected: /仅支持 Windows Electron kind=dll/
    },
    {
      components: [{
        ...windowsPeDependencyComponent,
        hostComponentId: undefined,
        abi: 'unknown-pe/v1'
      }],
      expected: /arch 必须与 targets\[0\]\.arch 精确相等/
    },
    {
      components: [{
        ...windowsPeDependencyComponent,
        hostComponentId: undefined,
        kind: 'worker',
        entry: 'native/worker.exe'
      }],
      expected: /仅支持 Windows Electron kind=shared-library/
    },
    {
      components: [{ ...windowsPeDependencyComponent, hostComponentId: undefined }, nativeHost32DllComponent],
      expected: /arch 必须与 targets\[0\]\.arch 精确相等/
    },
    {
      components: [{ ...windowsPeDependencyComponent, hostComponentId: 'missing-host' }, nativeHost32DllComponent],
      expected: /hostComponentId 引用了未知组件/
    },
    {
      components: [{ ...windowsPeDependencyComponent, entry: 'lib/MediaService.node' }, nativeHost32DllComponent],
      expected: /使用 windows-pe\/v1 时必须是 \.dll/
    },
    {
      components: [
        { ...windowsPeDependencyComponent, hostComponentId: 'media-chain' },
        { ...windowsPeDependencyComponent, id: 'media-chain', hostComponentId: nativeHost32DllComponent.id },
        nativeHost32DllComponent
      ],
      expected: /hostComponentId 必须引用 ia32 ztools-native-host\/v1 DLL/
    }
  ]

  for (const { components, expected } of cases) {
    const pluginDir = withPlugin(t, {
      targets: [windowsElectronX64],
      nativeComponents: components
    })
    const result = runValidator(pluginDir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, expected)
  }

  const wrongTargetPlugin = withPlugin(t, {
    targets: [windowsElectronX64, windowsElectron],
    nativeComponents: [
      { ...windowsPeDependencyComponent, hostComponentId: 'native-host32-other-target' },
      { ...nativeHost32DllComponent, id: 'native-host32-other-target', targetId: windowsElectron.id }
    ]
  })
  const wrongTargetResult = runValidator(wrongTargetPlugin)
  assert.equal(wrongTargetResult.status, 1)
  assert.match(wrongTargetResult.stderr, /hostComponentId 必须引用同一 target 的 DLL/)
})

test('native component paths use the same traversal and realpath checks', (t) => {
  const traversalDir = withPlugin(t, {
    targets: [windowsElectron],
    nativeComponents: [{ ...windowsNativeComponent, entry: '../outside.dll' }]
  })
  const traversalResult = runValidator(traversalDir)
  assert.equal(traversalResult.status, 1)
  assert.match(traversalResult.stderr, /nativeComponents\[0\]\.entry 必须是插件目录内的安全相对路径/)

  const anyArchDir = withPlugin(t, {
    targets: [{ ...windowsElectron, arch: 'any' }],
    nativeComponents: [{ ...windowsNativeComponent, arch: 'any' }]
  })
  const anyArchResult = runValidator(anyArchDir)
  assert.equal(anyArchResult.status, 1)
  assert.match(anyArchResult.stderr, /原生组件必须声明实际架构/)
})

test('legacy Windows-only fields cannot be combined with an explicit macOS target', (t) => {
  const pluginDir = withPlugin(t, {
    dllloader: 'lib/Legacy.dll',
    targets: [
      { ...windowsElectron, abi: undefined },
      { id: 'macos-electron-arm64', platform: 'macos', runtime: 'electron', arch: 'arm64' }
    ],
    nativeComponents: []
  }, (dir) => {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'Legacy.dll'), 'fixture')
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /仅适用于 Windows/)
})

test('explicit dllloader requires a matching Windows DLL component', (t) => {
  const mismatchedDir = withPlugin(t, {
    dllloader: 'lib/Legacy.dll',
    targets: [windowsElectron],
    nativeComponents: [{ ...windowsDllComponent, entry: 'lib/Other.dll' }]
  }, (dir) => {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'Legacy.dll'), 'fixture')
    writeFileSync(join(dir, 'lib', 'Other.dll'), 'fixture')
  })
  const mismatchedResult = runValidator(mismatchedDir)
  assert.equal(mismatchedResult.status, 1)
  assert.match(mismatchedResult.stderr, /entry 与 dllloader 完全一致/)

  const matchingDir = withPlugin(t, {
    dllloader: 'lib/Legacy.dll',
    targets: [windowsElectron],
    nativeComponents: [windowsDllComponent]
  }, (dir) => {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'Legacy.dll'), 'fixture')
  })
  const matchingResult = runValidator(matchingDir)
  assert.equal(matchingResult.status, 0, matchingResult.stdout + matchingResult.stderr)
})

test('requireAdmin needs a Windows DLL component, and DLL components cannot target macOS', (t) => {
  const missingDllDir = withPlugin(t, {
    requireAdmin: true,
    targets: [windowsElectron],
    nativeComponents: []
  })
  const missingDllResult = runValidator(missingDllDir)
  assert.equal(missingDllResult.status, 1)
  assert.match(missingDllResult.stderr, /requireAdmin=true 时必须声明绑定到 Windows target 的 kind=dll 组件/)

  const macDllDir = withPlugin(t, {
    targets: [macosElectronUniversal],
    nativeComponents: [{
      ...windowsDllComponent,
      targetId: macosElectronUniversal.id,
      arch: macosElectronUniversal.arch,
      entry: 'lib/Legacy.dll'
    }]
  }, (dir) => {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'Legacy.dll'), 'fixture')
  })
  const macDllResult = runValidator(macDllDir)
  assert.equal(macDllResult.status, 1)
  assert.match(macDllResult.stderr, /kind=dll 只能绑定 Windows target/)
})

test('legacy Delphi runtime is rejected for macOS', (t) => {
  const pluginDir = withPlugin(t, {
    targets: [{ id: 'macos-legacy-delphi', platform: 'macos', runtime: 'legacy-delphi', arch: 'any' }],
    nativeComponents: []
  })

  const result = runValidator(pluginDir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /targets\[0\]\.platform.*windows/)
})

test('absolute, traversing, drive-qualified, and symlink-escaping plugin paths are rejected', (t) => {
  for (const overrides of [
    { entry: '../outside.html' },
    { icon: '/outside.svg' },
    { entry: 'nested/stream:name' },
    { entry: 'nul\u0000path' }
  ]) {
    const maliciousPathDir = withPlugin(t, overrides)
    const maliciousPathResult = runValidator(maliciousPathDir)
    assert.equal(maliciousPathResult.status, 1)
    assert.match(maliciousPathResult.stderr, /必须是插件目录内的安全相对路径/)
  }

  const driveDir = withPlugin(t, { dllloader: 'C:\\outside\\plugin.dll' })
  const driveResult = runValidator(driveDir)
  assert.equal(driveResult.status, 1)
  assert.match(driveResult.stderr, /dllloader 必须是插件目录内的 \.dll 相对路径/)

  let outsideDir
  let symlinkAvailable = true
  const pluginDir = withPlugin(t, { entry: 'linked/outside.html' }, (dir) => {
    outsideDir = mkdtempSync(join(tmpdir(), 'ztools-plugin-outside-'))
    writeFileSync(join(outsideDir, 'outside.html'), '<script src="ztools://web/sdk/ztools-api.js"></script>')
    try {
      symlinkSync(outsideDir, join(dir, 'linked'), 'junction')
      t.after(() => rmSync(outsideDir, { recursive: true, force: true }))
    } catch (error) {
      symlinkAvailable = false
      rmSync(outsideDir, { recursive: true, force: true })
      if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOSYS') throw error
    }
  })
  if (!symlinkAvailable) {
    t.skip('directory symlink creation is unavailable on this host')
    return
  }
  const symlinkResult = runValidator(pluginDir)
  assert.equal(symlinkResult.status, 1)
  assert.match(symlinkResult.stderr, /entry 必须是插件目录内的安全相对路径/)
})
