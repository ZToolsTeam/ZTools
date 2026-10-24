#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const schemaFiles = readdirSync(root).filter((name) => name.endsWith('.schema.json'))
const schemasById = new Map()
const schemasByFile = new Map()

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

for (const file of schemaFiles) {
  const schema = readJson(join(root, file))
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${file}: unexpected JSON Schema draft`)
  assert.equal(typeof schema.$id, 'string', `${file}: $id is required`)
  assert(!schemasById.has(schema.$id), `${file}: duplicate $id ${schema.$id}`)
  schemasById.set(schema.$id, { schema, file: join(root, file) })
  schemasByFile.set(file, { schema, file: join(root, file) })
}

function assertSchemaShape(schema, file, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || seen.has(schema)) return
  seen.add(schema)
  const knownKeywords = new Set([
    '$schema', '$id', '$ref', 'title', 'description', 'type', 'required', 'properties',
    'additionalProperties', 'enum', 'const', 'pattern', 'minLength', 'minimum', 'maximum', 'items', 'allOf', 'if', 'then'
  ])
  for (const keyword of Object.keys(schema)) {
    assert(knownKeywords.has(keyword), `${file}: validator does not implement schema keyword ${keyword}`)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    assert(types.length > 0, `${file}: type must not be empty`)
    for (const type of types) {
      assert(['object', 'array', 'string', 'integer', 'boolean', 'null'].includes(type), `${file}: invalid type ${type}`)
    }
  }
  if (schema.required !== undefined) {
    assert(Array.isArray(schema.required), `${file}: required must be an array`)
    assert.equal(new Set(schema.required).size, schema.required.length, `${file}: required has duplicates`)
  }
  if (schema.pattern !== undefined) assert.doesNotThrow(() => new RegExp(schema.pattern), `${file}: invalid pattern`)
  if (schema.properties !== undefined) {
    for (const child of Object.values(schema.properties)) assertSchemaShape(child, file, seen)
  }
  if (schema.items !== undefined) assertSchemaShape(schema.items, file, seen)
  if (schema.allOf !== undefined) {
    assert(Array.isArray(schema.allOf), `${file}: allOf must be an array`)
    for (const child of schema.allOf) assertSchemaShape(child, file, seen)
  }
  if (schema.if !== undefined) assertSchemaShape(schema.if, file, seen)
  if (schema.then !== undefined) assertSchemaShape(schema.then, file, seen)
  if (schema.$ref !== undefined) {
    const resolved = schemasById.get(new URL(schema.$ref, schemasById.get(readJson(join(root, file)).$id)?.schema.$id).href)
    assert(resolved, `${file}: unresolved local schema reference ${schema.$ref}`)
  }
}

function validate(instance, schema, schemaFile, dataPath = '$') {
  const errors = []
  if (schema.$ref) {
    const base = schemasByFile.get(schemaFiles.find((name) => join(root, name) === schemaFile))?.schema
    const resolvedId = new URL(schema.$ref, base?.$id).href
    const resolved = schemasById.get(resolvedId)
    if (!resolved) return [`${dataPath}: unresolved schema reference ${schema.$ref}`]
    errors.push(...validate(instance, resolved.schema, resolved.file, dataPath))
    if (Object.keys(schema).every((key) => key === '$ref')) return errors
  }

  const matchesType = (type) => type === 'object'
    ? instance !== null && typeof instance === 'object' && !Array.isArray(instance)
    : type === 'array'
      ? Array.isArray(instance)
      : type === 'integer'
        ? Number.isInteger(instance)
        : type === 'null'
          ? instance === null
          : typeof instance === type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(matchesType)) return [`${dataPath}: expected ${types.join(' or ')}`]
  }

  if (schema.enum && !schema.enum.includes(instance)) errors.push(`${dataPath}: value is not in enum`)
  if (schema.const !== undefined && instance !== schema.const) errors.push(`${dataPath}: value does not equal const`)
  if (schema.minLength !== undefined && typeof instance === 'string' && instance.length < schema.minLength) {
    errors.push(`${dataPath}: string is shorter than ${schema.minLength}`)
  }
  if (schema.pattern && typeof instance === 'string' && !new RegExp(schema.pattern).test(instance)) {
    errors.push(`${dataPath}: string does not match pattern`)
  }
  if (schema.minimum !== undefined && typeof instance === 'number' && instance < schema.minimum) {
    errors.push(`${dataPath}: number is less than ${schema.minimum}`)
  }
  if (schema.maximum !== undefined && typeof instance === 'number' && instance > schema.maximum) {
    errors.push(`${dataPath}: number is greater than ${schema.maximum}`)
  }

  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(instance, name)) errors.push(`${dataPath}.${name}: required property is missing`)
    }
    const properties = schema.properties ?? {}
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(instance, name)) errors.push(...validate(instance[name], child, schemaFile, `${dataPath}.${name}`))
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(instance)) {
        if (!Object.hasOwn(properties, name)) errors.push(`${dataPath}.${name}: additional property is not allowed`)
      }
    }
  }
  if ((schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) && Array.isArray(instance) && schema.items) {
    for (let index = 0; index < instance.length; index += 1) {
      errors.push(...validate(instance[index], schema.items, schemaFile, `${dataPath}[${index}]`))
    }
  }
  if (schema.allOf) {
    for (const child of schema.allOf) errors.push(...validate(instance, child, schemaFile, dataPath))
  }
  if (schema.if && schema.then && validate(instance, schema.if, schemaFile, dataPath).length === 0) {
    errors.push(...validate(instance, schema.then, schemaFile, dataPath))
  }
  return errors
}

function assertValid(instance, schemaName, label) {
  const entry = schemasByFile.get(schemaName)
  assert(entry, `missing schema ${schemaName}`)
  const errors = validate(instance, entry.schema, entry.file)
  assert.deepEqual(errors, [], `${label}: ${errors.join('; ')}`)
}

function assertInvalid(instance, schemaName, label) {
  const entry = schemasByFile.get(schemaName)
  const errors = validate(instance, entry.schema, entry.file)
  assert(errors.length > 0, `${label}: expected schema validation to fail`)
}

function fixtureFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? fixtureFiles(path) : entry.isFile() && entry.name.endsWith('.json') ? [path] : []
  }).sort()
}

for (const { schema, file } of schemasById.values()) assertSchemaShape(schema, relative(root, file))

const targetSchema = schemasByFile.get('platform-target.schema.json').schema
assert.deepEqual(targetSchema.properties.platform.enum, ['windows', 'macos'])
assert.deepEqual(targetSchema.properties.runtime.enum, ['electron', 'legacy-delphi'])
assert.deepEqual(targetSchema.properties.arch.enum, ['any', 'ia32', 'x64', 'arm64', 'universal'])
assert.equal(targetSchema.properties.id.pattern, '^[a-z][a-z0-9-]*$')
assert.deepEqual(targetSchema.required, ['platform', 'runtime', 'arch'])
assert.equal(targetSchema.properties.minSdkContractVersion.minimum, 1)
for (const key of Object.keys(targetSchema.properties)) {
  assert(!/channel|minimum.?os|first.?release/i.test(key), `target schema must not set ${key}`)
}

const capabilitySchema = schemasByFile.get('capability-record.schema.json').schema
assert.deepEqual(capabilitySchema.properties.implementation.enum, ['supported', 'unsupported', 'unavailable'])
assert.deepEqual(capabilitySchema.properties.authorization.enum, ['granted', 'denied', 'unknown'])
assert.deepEqual(capabilitySchema.properties.osPermission.enum, [
  'not-required', 'not-determined', 'granted', 'denied', 'restricted', 'unknown'
])
for (const field of ['implementation', 'authorization', 'osPermission']) {
  assert(capabilitySchema.required.includes(field), `capability ${field} dimension must be required`)
}

const fixtureGroups = [
  ['targets', 'platform-target.schema.json'],
  ['runtime', 'runtime-identity.schema.json'],
  ['capabilities', 'capability-record.schema.json'],
  ['errors', 'public-error.schema.json']
]
const loadedFixtures = new Map()
let validatedFixtureCount = 0
let rejectedFixtureCount = 0
for (const [group, schemaName] of fixtureGroups) {
  const directory = join(root, 'fixtures', group)
  const files = fixtureFiles(directory)
  assert(files.length > 0, `no ${group} fixtures found`)
  for (const file of files) {
    const fixture = readJson(file)
    assertValid(fixture, schemaName, relative(root, file))
    loadedFixtures.set(relative(join(root, 'fixtures'), file).replaceAll('\\', '/'), fixture)
    validatedFixtureCount += 1
    console.log(`OK ${relative(root, file)}`)
  }
}

const supportedRuntimeContractVersions = new Set([1])
const supportedSdkContractVersions = new Set([1])
function isSdkContractAccepted(version, minimum) {
  return supportedSdkContractVersions.has(version) && version >= minimum
}

for (const { input, canonical } of readJson(join(root, 'fixtures', 'app-version', 'comparison-cases.json')).valid) {
  assertValid(input, 'application-version.schema.json', `valid App version ${input}`)
  const parts = input.split('.').map(Number)
  while (parts.length < 4) parts.push(0)
  assert.equal(parts.join('.'), canonical, `App version canonicalization mismatch for ${input}`)
}
const appVersionCases = readJson(join(root, 'fixtures', 'app-version', 'comparison-cases.json'))
for (const input of appVersionCases.invalid) {
  assertInvalid(input, 'application-version.schema.json', `invalid App version ${String(input)}`)
}
function compareApplicationVersions(left, right) {
  const toParts = (value) => {
    const parts = value.split('.').map(Number)
    while (parts.length < 4) parts.push(0)
    return parts
  }
  const leftParts = toParts(left)
  const rightParts = toParts(right)
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}
for (const { left, right, result } of appVersionCases.comparisons) {
  assertValid(left, 'application-version.schema.json', `App comparison left ${left}`)
  assertValid(right, 'application-version.schema.json', `App comparison right ${right}`)
  assert.equal(compareApplicationVersions(left, right), result, `App version comparison mismatch: ${left} vs ${right}`)
}

for (const file of fixtureFiles(join(root, 'fixtures', 'negotiation'))) {
  const fixture = readJson(file)
  assertValid(fixture.targetRequirement, 'platform-target.schema.json', `${relative(root, file)} target requirement`)
  if (supportedRuntimeContractVersions.has(fixture.runtime.contractVersion)) {
    assertValid(fixture.runtime, 'runtime-identity.schema.json', `${relative(root, file)} runtime`)
  } else {
    assertInvalid(fixture.runtime, 'runtime-identity.schema.json', `${relative(root, file)} unknown runtime contract`)
  }
  assert(Number.isInteger(fixture.hostSdkContractVersion) && fixture.hostSdkContractVersion >= 1,
    `${relative(root, file)} hostSdkContractVersion must be a positive integer`)
  assert.equal(typeof fixture.expectedCompatible, 'boolean', `${relative(root, file)} expectedCompatible must be boolean`)
  assert.equal(fixture.targetRequirement.platform, fixture.runtime.target.platform, `${relative(root, file)} platform must match`)
  assert.equal(fixture.targetRequirement.runtime, fixture.runtime.target.runtime, `${relative(root, file)} runtime must match`)
  const actualCompatible = supportedRuntimeContractVersions.has(fixture.runtime.contractVersion) &&
    isSdkContractAccepted(fixture.hostSdkContractVersion, fixture.targetRequirement.minSdkContractVersion ?? 1)
  assert.equal(actualCompatible, fixture.expectedCompatible, `${relative(root, file)} contract version negotiation mismatch`)
  validatedFixtureCount += 1
  console.log(`OK ${relative(root, file)}`)
}

const invalidFixtureGroups = [
  ['platform-target', 'platform-target.schema.json'],
  ['runtime-identity', 'runtime-identity.schema.json'],
  ['public-error', 'public-error.schema.json']
]
for (const [group, schemaName] of invalidFixtureGroups) {
  const files = fixtureFiles(join(root, 'fixtures', 'invalid', group))
  assert(files.length > 0, `no invalid ${group} fixtures found`)
  for (const file of files) {
    const fixture = readJson(file)
    assertInvalid(fixture, schemaName, relative(root, file))
    rejectedFixtureCount += 1
    console.log(`REJECT ${relative(root, file)}`)
  }
}

const windowsWow64 = loadedFixtures.get('runtime/windows-electron-wow64.json')
assert.equal(windowsWow64.target.id, 'windows-electron-ia32')
assert.equal(windowsWow64.os.arch, 'x64')
assert.equal(windowsWow64.process.arch, 'ia32')
assert.equal(windowsWow64.nativeHost.arch, 'ia32')
assert.equal(windowsWow64.process.translationMode, 'compatibility')
const rosetta = loadedFixtures.get('runtime/macos-x64-electron-rosetta.json')
assert.equal(rosetta.os.arch, 'arm64')
assert.equal(rosetta.process.arch, 'x64')
assert.equal(rosetta.nativeHost.state, 'not-applicable')
assert.equal(rosetta.nativeHost.arch, 'unknown')
assert.equal(rosetta.nativeHost.protocolVersion, null)
assert.equal(rosetta.process.translationMode, 'translated')
const hostArchDiffers = structuredClone(windowsWow64)
hostArchDiffers.target.arch = 'x64'
hostArchDiffers.process.arch = 'x64'
hostArchDiffers.nativeHost.arch = 'ia32'
assertValid(hostArchDiffers, 'runtime-identity.schema.json', 'native host architecture is independent of process architecture')
assert.notEqual(hostArchDiffers.process.arch, hostArchDiffers.nativeHost.arch)
assert.equal(loadedFixtures.get('runtime/unknown-runtime-values.json').process.translationMode, 'unknown')
for (const section of ['os', 'process', 'nativeHost']) {
  const invalidMacIa32Identity = structuredClone(rosetta)
  invalidMacIa32Identity[section].arch = 'ia32'
  assertInvalid(
    invalidMacIa32Identity,
    'runtime-identity.schema.json',
    `Mac ${section} cannot report ia32 architecture`
  )
}
const invalidMacIa32TargetIdentity = structuredClone(rosetta)
invalidMacIa32TargetIdentity.target.arch = 'ia32'
assertInvalid(invalidMacIa32TargetIdentity, 'runtime-identity.schema.json', 'Mac runtime target cannot declare ia32 architecture')

const probeOnly = loadedFixtures.get('capabilities/os-permission-does-not-authorize-caller.json')
assert.equal(Object.hasOwn(probeOnly.target, 'id'), false)
assert.equal(probeOnly.osPermission, 'granted')
assert.equal(probeOnly.authorization, 'unknown')
assert.notEqual(probeOnly.authorization, 'granted', 'OS permission probe must not authorize a caller')
const unsupportedButAuthorized = loadedFixtures.get('capabilities/unsupported-but-policy-granted.json')
assert.equal(unsupportedButAuthorized.implementation, 'unsupported')
assert.equal(unsupportedButAuthorized.authorization, 'granted')
assert.equal(loadedFixtures.get('capabilities/implementation-and-caller-denied.json').target.id, 'windows-electron-ia32')

const minimumSdkTarget = loadedFixtures.get('targets/macos-electron-universal.json')
assert.equal(minimumSdkTarget.minSdkContractVersion, 2)
const incompatibleRuntime = readJson(join(root, 'fixtures', 'negotiation', 'runtime-contract-version-too-old.json'))
assert.equal(incompatibleRuntime.expectedCompatible, false)
assert.equal(incompatibleRuntime.runtime.contractVersion, 1, 'runtime schema version is independent from SDK contract version')
assert.equal(incompatibleRuntime.hostSdkContractVersion, 1)
assert.equal(incompatibleRuntime.targetRequirement.minSdkContractVersion, 2)
assert.equal(isSdkContractAccepted(incompatibleRuntime.hostSdkContractVersion, incompatibleRuntime.targetRequirement.minSdkContractVersion), false)
const unknownRuntimeContract = readJson(join(root, 'fixtures', 'negotiation', 'unknown-runtime-contract-version.json'))
assert.equal(unknownRuntimeContract.runtime.contractVersion, 2)
assert.equal(unknownRuntimeContract.hostSdkContractVersion, 1)
assert.equal(unknownRuntimeContract.targetRequirement.minSdkContractVersion, 1)
assert.equal(unknownRuntimeContract.expectedCompatible, false, 'unknown future runtime contract versions must fail closed independently from the SDK minimum')
const unknownSdkContract = readJson(join(root, 'fixtures', 'negotiation', 'unknown-host-sdk-contract-version.json'))
assert.equal(unknownSdkContract.hostSdkContractVersion, 2)
assert.equal(unknownSdkContract.targetRequirement.minSdkContractVersion, 1)
assert.equal(unknownSdkContract.runtime.contractVersion, 1)
assert.equal(unknownSdkContract.expectedCompatible, false, 'an unknown future host SDK contract must fail closed even when it exceeds the target minimum')

for (const platform of targetSchema.properties.platform.enum) {
  for (const runtime of targetSchema.properties.runtime.enum) {
    for (const arch of targetSchema.properties.arch.enum) {
      if (platform === 'macos' && runtime === 'legacy-delphi') continue
      const target = { platform, runtime, arch }
      if (platform === 'macos' && arch === 'ia32') {
        assertInvalid(target, 'platform-target.schema.json', `${platform}/${runtime}/${arch} is not a supported Mac process architecture`)
      } else {
        assertValid(target, 'platform-target.schema.json', `${platform}/${runtime}/${arch} syntax`)
      }
    }
  }
}

const validTarget = loadedFixtures.get('targets/windows-electron-ia32.json')
assert.equal(validTarget.id, 'windows-electron-ia32')
assert.equal(Object.hasOwn(loadedFixtures.get('targets/macos-electron-x64.json'), 'id'), false)
assertInvalid({ ...validTarget, platform: 'linux' }, 'platform-target.schema.json', 'unknown platform')
assertInvalid({ ...validTarget, runtime: 'unknown' }, 'platform-target.schema.json', 'unknown runtime')
assertInvalid({ ...validTarget, arch: 'unknown' }, 'platform-target.schema.json', 'unknown target architecture')
assertInvalid({ ...validTarget, platform: 'macos', runtime: 'legacy-delphi' }, 'platform-target.schema.json', 'Mac Delphi target is not a new runtime')
assertInvalid({ ...validTarget, platform: 'macos', arch: 'ia32' }, 'platform-target.schema.json', 'Mac cannot run an ia32 Electron target')
assertInvalid({ ...validTarget, minSdkContractVersion: 0 }, 'platform-target.schema.json', 'zero minimum contract version')
assertInvalid({ ...validTarget, id: 'Windows_Electron' }, 'platform-target.schema.json', 'invalid stable target id')
assertInvalid({ ...validTarget, abi: 'ztools-native-host' }, 'platform-target.schema.json', 'unversioned ABI')
assertInvalid({ ...validTarget, channel: 'stable' }, 'platform-target.schema.json', 'release channel is outside target schema')
assertInvalid({ contractVersion: 0 }, 'runtime-identity.schema.json', 'zero runtime contract version')
assertInvalid({ ...windowsWow64, contractVersion: 2 }, 'runtime-identity.schema.json', 'unknown future runtime identity contract version')
const missingAppVersion = structuredClone(windowsWow64)
delete missingAppVersion.appVersion
assertInvalid(missingAppVersion, 'runtime-identity.schema.json', 'missing App version')
assertInvalid({ ...windowsWow64, appVersion: '1.1.7.1-dev' }, 'runtime-identity.schema.json', 'SemVer suffix is not an App release version')
assertInvalid({ ...windowsWow64, appVersion: 900 }, 'runtime-identity.schema.json', 'App version must be a string')
assertInvalid({ ...windowsWow64, nativeHost: { ...windowsWow64.nativeHost, protocolVersion: '1' } }, 'runtime-identity.schema.json', 'native-host wire version is an integer, not a dotted App version')
assertInvalid({ ...windowsWow64, nativeHost: { ...windowsWow64.nativeHost, protocolVersion: null } }, 'runtime-identity.schema.json', 'available native host must report a protocol version')
assertInvalid({ ...windowsWow64, nativeHost: { state: 'not-applicable', arch: 'unknown', protocolVersion: 1 } }, 'runtime-identity.schema.json', 'not-applicable native host has no wire protocol version')
assertInvalid({ ...windowsWow64, nativeHost: { ...windowsWow64.nativeHost, protocolVersion: 0 } }, 'runtime-identity.schema.json', 'zero is not a valid native-host wire protocol version')
assertInvalid({ ...windowsWow64, nativeHost: { ...windowsWow64.nativeHost, protocolVersion: 65536 } }, 'runtime-identity.schema.json', 'native-host protocol version exceeds its uint16 wire field')
assertInvalid({ ...probeOnly, authorization: true }, 'capability-record.schema.json', 'boolean is not caller authorization state')
const { osPermission: omittedOsPermission, ...missingPermissionState } = probeOnly
void omittedOsPermission
assertInvalid(missingPermissionState, 'capability-record.schema.json', 'missing OS permission state')

const currentApiSemantics = readJson(join(root, 'fixtures', 'current-api-semantics.json'))
assert.equal(currentApiSemantics.snapshotVersion, 1, 'current API semantics snapshot version')
assert.deepEqual(currentApiSemantics.screen, {
  pointUnit: 'electron-dip',
  rectUnit: 'electron-dip',
  displayBoundsUnit: 'electron-dip',
  displayWorkAreaUnit: 'electron-dip',
  negativeVirtualDesktopCoordinates: true,
  capturePngPixelsPerDip: 1,
  displayIdScope: 'runtime-only',
  displayIdPersistent: false,
  displayIndexScope: 'current-list-order',
  displayIndexPersistent: false
}, 'screen coordinate and display identity semantics')
assert.deepEqual(currentApiSemantics.hotkeys, {
  storedCtrlMeaning: 'portable-primary-modifier',
  ctrlMapping: {
    windows: 'Control',
    macos: 'Command',
    electronAdapterToken: 'CommandOrControl'
  },
  controlMeaning: 'physical-Control',
  altMapping: { windows: 'Alt', macos: 'Option' },
  adapterRewritesOnlyCtrl: true,
  macosGlobalShortcutDeviceValidation: 'required'
}, 'cross-platform hotkey vocabulary and current adapter boundary')
assert.deepEqual(currentApiSemantics.ipcRequestTimeout, {
  defaultMs: 10_000,
  maximumMs: 120_000,
  infiniteWaitMethods: [
    'window_show_open_dialog',
    'window_show_save_dialog',
    'window_show_select_folder_dialog',
    'process_wait'
  ],
  timeoutGuaranteesHandlerStopped: false
}, 'IPC request timeout limits and cancellation guarantee')
assert.deepEqual(currentApiSemantics.asyncTasks, {
  genericTaskApiExists: false,
  dllPlugin: {
    scope: 'windows-nativehost-legacy',
    supportedPlatforms: ['windows'],
    macosSupported: false,
    states: ['invoking', 'running', 'completed', 'cancelled', 'error'],
    cancelledMayBeOverwrittenByLaterEvent: true,
    retentionAndCleanupFollowUp: 'unresolved'
  }
}, 'existing asynchronous task surface and unresolved lifecycle behavior')
assert.deepEqual(currentApiSemantics.errorSources, {
  timeoutCodes: [
    { code: 'REQUEST_TIMEOUT', source: 'electron-main-ipc' },
    { code: 'CALL_TIMEOUT', source: 'legacy-js-transport' },
    {
      code: 'TIMEOUT',
      source: 'legacy-event-request',
      resultShape: { ok: false, code: 'TIMEOUT' }
    }
  ],
  timeoutCodesUnified: false,
  screenFailure: {
    rawDetailExposed: false,
    status: 'fixed-sanitized'
  }
}, 'current timeout code boundaries and sanitized screen error disclosure')
console.log('OK fixtures/current-api-semantics.json')

console.log(`Validated ${validatedFixtureCount} valid fixtures, rejected ${rejectedFixtureCount} invalid contract fixtures, and checked ${appVersionCases.valid.length} valid, ${appVersionCases.invalid.length} invalid, and ${appVersionCases.comparisons.length} App-version vectors plus target/capability/protocol boundaries.`)
