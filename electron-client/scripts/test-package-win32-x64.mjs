import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createWindowsApplicationManifest,
  createWindowsPackagerOptions,
  getWindowsArtifactRoot,
  getWindowsInstallerFileName,
  getWindowsPortableZipFileName,
  verifyWindowsPathAccessBrokerDependency,
  WINDOWS_TARGET
} from './windows-package-contract.mjs'
import {
  expectedWindowsArtifactMachine,
  PE_MACHINE_X64,
  PE_MACHINE_X86,
  verifyWindowsArtifactPeFiles
} from './windows-pe-architecture.mjs'
import { stageWindowsPathAccessBroker } from './windows-path-access-broker.mjs'

function writePe(file, machine, signature = 'PE\0\0') {
  const buffer = Buffer.alloc(70)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(64, 0x3c)
  buffer.write(signature, 64, 'binary')
  buffer.writeUInt16LE(machine, 68)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buffer)
}

test('selects one win32-x64 application package and keeps only its classic-level prebuild', () => {
  const options = createWindowsPackagerOptions({
    clientRoot: 'C:/workspace/electron-client',
    outputRoot: 'C:/workspace/electron-client/artifacts/1.1.7.1/win32-x64',
    applicationIcon: 'C:/workspace/framework/Res/LOGO.ico'
  })
  const isIgnored = (filePath) => options.ignore.some((pattern) => pattern.test(filePath))

  assert.equal(WINDOWS_TARGET.platform, 'win32')
  assert.equal(WINDOWS_TARGET.arch, 'x64')
  assert.equal(WINDOWS_TARGET.artifactDirectory, 'win32-x64')
  assert.equal(WINDOWS_TARGET.applicationDirectory, 'ZTools-win32-x64')
  assert.equal(options.platform, 'win32')
  assert.equal(options.arch, 'x64')
  assert.equal(options.electronVersion, '43.4.1')
  assert.equal(isIgnored('/node_modules/classic-level/prebuilds/win32-x64/classic-level.node'), false)
  assert.equal(isIgnored('/node_modules/classic-level/prebuilds/win32-ia32/classic-level.node'), true)
  assert.equal(isIgnored('/node_modules/classic-level/prebuilds/linux-x64/classic-level.node'), true)
  assert.equal(isIgnored('/out/native/win32-ia32/ZToolsNativeHost32.exe'), true)
})

test('exposes x64 Windows packaging commands and removes the former ia32 distribution commands', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  assert.equal(
    packageJson.scripts['package:app:win32:x64'],
    'npm run build:native-host32 && npm run build:ztools-service && npm run build && node scripts/package.mjs'
  )
  assert.equal(
    packageJson.scripts['package:win32:x64'],
    'npm run package:app:win32:x64 && node scripts/package-installer.mjs'
  )
  assert.equal(packageJson.scripts['package:app:win32:ia32'], undefined)
  assert.equal(packageJson.scripts['package:win32:ia32'], undefined)
})

test('records x64 main-process support and keeps isolated native processes explicitly ia32', () => {
  const manifest = createWindowsApplicationManifest({
    appVersion: '1.1.7.1',
    gitCommit: 'abc123',
    gitDirty: false,
    buildQualifier: '',
    privilegedManifestSha256: 'f'.repeat(64)
  })

  assert.equal(manifest.platform, 'win32')
  assert.equal(manifest.arch, 'x64')
  assert.deepEqual(manifest.supportedNativeOsArch, ['x64'])
  assert.equal(manifest.wow64OnX64, false)
  assert.deepEqual(manifest.nativeDependencies, [
    { name: 'classic-level', version: '3.0.0', arch: 'x64' },
    { name: 'ZToolsNativeHost32', protocolVersion: 1, arch: 'ia32' },
    { name: 'ZToolsService', protocolVersion: 1, arch: 'ia32' },
    { name: 'ZToolsPathAccessBroker', optional: true, status: 'unavailable', reason: 'not-built' }
  ])
  assert.equal(getWindowsArtifactRoot('C:/workspace/electron-client', '1.1.7.1'),
    path.join('C:/workspace/electron-client', 'artifacts', '1.1.7.1', 'win32-x64'))
  assert.equal(getWindowsInstallerFileName('1.1.7.1'), 'ZTools-1.1.7.1-win32-x64.exe')
  assert.equal(getWindowsPortableZipFileName('1.1.7.1'), 'ZTools-1.1.7.1-win32-x64-portable.zip')
})

test('records and verifies optional PathAccessBroker status, SHA-256 and x64 PE without promoting SDK 1', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-win-path-manifest-'))
  const applicationRoot = path.join(temporaryRoot, 'ZTools-win32-x64')
  const brokerPath = path.join(applicationRoot, 'resources', 'native', 'ZToolsPathAccessBroker.exe')
  try {
    const unavailableManifest = createWindowsApplicationManifest({
      appVersion: '1.1.7.1', gitCommit: 'abc123', gitDirty: false, buildQualifier: '',
      privilegedManifestSha256: 'f'.repeat(64)
    })
    assert.equal(unavailableManifest.sdkContractVersion, 1)
    assert.deepEqual(verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: unavailableManifest.sdkContractVersion,
      dependency: unavailableManifest.nativeDependencies[3],
      applicationRoot,
      brokerFiles: []
    }), { available: false, referenceRuntimeAvailable: false, sdkContractVersion: 1, reason: 'not-built' })
    assert.throws(() => verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: 2,
      dependency: unavailableManifest.nativeDependencies[3],
      applicationRoot,
      brokerFiles: []
    }), /SDK 2 或更高版本必须包含 PathAccessBroker/)

    writePe(brokerPath, PE_MACHINE_X64)
    assert.throws(() => verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: 1,
      dependency: unavailableManifest.nativeDependencies[3],
      applicationRoot,
      brokerFiles: [brokerPath]
    }), /unavailable 状态与产物内容不一致/)
    const brokerSha256 = createHash('sha256').update(fs.readFileSync(brokerPath)).digest('hex')
    const availableManifest = createWindowsApplicationManifest({
      appVersion: '1.1.7.1', gitCommit: 'abc123', gitDirty: false, buildQualifier: '',
      privilegedManifestSha256: 'f'.repeat(64), pathAccessBrokerSha256: brokerSha256
    })
    const dependency = availableManifest.nativeDependencies[3]
    assert.deepEqual(dependency, {
      name: 'ZToolsPathAccessBroker', optional: true, status: 'available',
      path: 'resources/native/ZToolsPathAccessBroker.exe', arch: 'x64', sha256: brokerSha256
    })
    assert.deepEqual(verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: availableManifest.sdkContractVersion,
      dependency,
      applicationRoot,
      brokerFiles: [brokerPath]
    }), { available: true, referenceRuntimeAvailable: false, sdkContractVersion: 1, file: brokerPath })
    assert.throws(() => verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: 1, dependency, applicationRoot, brokerFiles: []
    }), /位置或数量无效/)

    assert.throws(() => verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: 1, dependency: { ...dependency, sha256: '0'.repeat(64) }, applicationRoot, brokerFiles: [brokerPath]
    }), /SHA-256 与 manifest 不一致/)
    assert.throws(() => verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: 1, dependency: { ...dependency, path: 'elsewhere/ZToolsPathAccessBroker.exe' }, applicationRoot, brokerFiles: [brokerPath]
    }), /metadata 无效/)

    writePe(brokerPath, PE_MACHINE_X86)
    assert.throws(() => verifyWindowsPathAccessBrokerDependency({
      sdkContractVersion: 1, dependency, applicationRoot, brokerFiles: [brokerPath]
    }), /必须为 x64 PE/)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('classifies x86 PE exceptions only by the exact runtime and installer file roles', () => {
  const applicationRoot = path.resolve('artifacts/1.1.7.1/win32-x64/ZTools-win32-x64')
  const installerPath = path.resolve('artifacts/1.1.7.1/win32-x64/ZTools-1.1.7.1-win32-x64.exe')

  assert.equal(expectedWindowsArtifactMachine(path.join(applicationRoot, 'ZTools.exe'), {
    applicationRoot,
    installerPath
  }), PE_MACHINE_X64)
  assert.equal(expectedWindowsArtifactMachine(path.join(applicationRoot, 'chrome_elf.dll'), {
    applicationRoot,
    installerPath
  }), PE_MACHINE_X64)
  assert.equal(expectedWindowsArtifactMachine(path.join(applicationRoot, 'ZToolsService.exe'), {
    applicationRoot,
    installerPath
  }), PE_MACHINE_X86)
  assert.equal(expectedWindowsArtifactMachine(path.join(
    applicationRoot,
    'resources',
    'native',
    'ZToolsNativeHost32.exe'
  ), { applicationRoot, installerPath }), PE_MACHINE_X86)
  assert.equal(expectedWindowsArtifactMachine(installerPath, { applicationRoot, installerPath }), PE_MACHINE_X86)
  assert.throws(() => expectedWindowsArtifactMachine(path.resolve('unclassified.exe'), {
    applicationRoot,
    installerPath
  }), /未登记的 Windows PE 文件职责/)
})

test('verifies PE headers and rejects x86 Electron files or unlisted x86 helpers', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-win32-x64-'))
  const applicationRoot = path.join(temporaryRoot, 'ZTools-win32-x64')
  const installerPath = path.join(temporaryRoot, 'ZTools-1.1.7.1-win32-x64.exe')
  const applicationExecutable = path.join(applicationRoot, 'ZTools.exe')
  const addon = path.join(
    applicationRoot,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'classic-level',
    'prebuilds',
    'win32-x64',
    'classic-level.node'
  )
  const nativeHost = path.join(applicationRoot, 'resources', 'native', 'ZToolsNativeHost32.exe')
  const service = path.join(applicationRoot, 'ZToolsService.exe')

  try {
    writePe(applicationExecutable, PE_MACHINE_X64)
    writePe(addon, PE_MACHINE_X64)
    writePe(nativeHost, PE_MACHINE_X86)
    writePe(service, PE_MACHINE_X86)
    writePe(installerPath, PE_MACHINE_X86)
    assert.deepEqual(verifyWindowsArtifactPeFiles(
      [applicationExecutable, addon, nativeHost, service, installerPath],
      { applicationRoot, installerPath }
    ), { x64: 2, x86: 3 })

    writePe(applicationExecutable, PE_MACHINE_X86)
    assert.throws(() => verifyWindowsArtifactPeFiles(
      [applicationExecutable],
      { applicationRoot, installerPath }
    ), /要求 x64/)

    const unlistedHelper = path.join(applicationRoot, 'resources', 'native', 'UnexpectedHelper.exe')
    writePe(unlistedHelper, PE_MACHINE_X86)
    assert.throws(() => verifyWindowsArtifactPeFiles(
      [unlistedHelper],
      { applicationRoot, installerPath }
    ), /要求 x64/)

    writePe(applicationExecutable, PE_MACHINE_X64, 'PX\0\0')
    assert.throws(() => verifyWindowsArtifactPeFiles(
      [applicationExecutable],
      { applicationRoot, installerPath }
    ), /PE 头无效/)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('packages only the fixed fresh-builder x64 broker and leaves missing broker explicitly unavailable', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-win-path-package-'))
  const outputRoot = path.join(temporaryRoot, 'out', 'native', 'win32-x64')
  const sourceDirectory = path.join(outputRoot, 'bin')
  const resourcesNative = path.join(temporaryRoot, 'package', 'resources', 'native')
  fs.mkdirSync(sourceDirectory, { recursive: true })
  fs.mkdirSync(resourcesNative, { recursive: true })
  try {
    assert.equal(stageWindowsPathAccessBroker({ clientRoot: temporaryRoot, resourcesNativeDirectory: resourcesNative }), undefined)

    const source = path.join(sourceDirectory, 'ZToolsPathAccessBroker.exe')
    writePe(source, PE_MACHINE_X64)
    const staged = stageWindowsPathAccessBroker({ clientRoot: temporaryRoot, resourcesNativeDirectory: resourcesNative })
    assert.equal(staged, path.join(resourcesNative, 'ZToolsPathAccessBroker.exe'))
    assert.deepEqual(fs.readFileSync(staged), fs.readFileSync(source))

    const secondDestination = path.join(temporaryRoot, 'second-resources', 'native')
    fs.mkdirSync(secondDestination, { recursive: true })
    writePe(source, PE_MACHINE_X86)
    assert.throws(() => stageWindowsPathAccessBroker({ clientRoot: temporaryRoot, resourcesNativeDirectory: secondDestination }), /必须为 x64 PE/)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
