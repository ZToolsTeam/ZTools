import { NETWORK_HELPER_EXECUTABLE } from './macos-network-bundle.mjs'
import assert from 'node:assert/strict'
import { createPackage, createPackageWithOptions, statFile, uncache } from '@electron/asar'
import { createWindowsPackagerOptions } from './windows-package-contract.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertMacApplicationIcon,
  createMacUniversalPackagerOptions,
  macApplicationIconPath,
  main,
  stageMacUniversal,
  verifyPackagedIcon
} from './package-macos-universal.mjs'

// 最小 ICNS 夹具：魔数 icns + 长度，足以通过格式检查
const FIXTURE_ICNS = Buffer.concat([Buffer.from('icns', 'latin1'), Buffer.from([0, 0, 0, 8])])

function seedIcon(sourceRoot, bytes = FIXTURE_ICNS) {
  const iconPath = macApplicationIconPath(sourceRoot)
  fs.mkdirSync(path.dirname(iconPath), { recursive: true })
  fs.writeFileSync(iconPath, bytes)
  return iconPath
}

// 模拟 @electron/packager：把 options.icon 复制为 Contents/Resources/electron.icns
function packIcon(sourceRoot, appBundlePath) {
  const target = path.join(appBundlePath, 'Contents', 'Resources', 'electron.icns')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(macApplicationIconPath(sourceRoot), target)
}

async function fixtureNative({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacClipboard')
  fs.writeFileSync(executable, 'fixture native helper')
  return { executable }
}

async function fixtureVision({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacVision')
  fs.writeFileSync(executable, 'fixture local Vision helper')
  return { executable }
}

async function fixtureAudio({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacAudio')
  fs.writeFileSync(executable, 'fixture local Audio helper')
  return { executable }
}

async function fixtureInputLock({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacInputLock')
  fs.writeFileSync(executable, 'fixture input lock helper')
  return { executable }
}
async function fixtureDns({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacDns')
  fs.writeFileSync(executable, 'fixture input lock helper')
  return { executable }
}

async function fixtureHotkeys({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacHotkeys')
  fs.writeFileSync(executable, 'fixture hotkey helper')
  return { executable }
}
async function fixtureNetwork({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacNetwork')
  fs.writeFileSync(executable, 'fixture network helper')
  return { executable }
}
async function fixtureDisplay({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacDisplay'), notice = path.join(outputRoot, 'NOTICE.md')
  fs.writeFileSync(executable, 'fixture display helper')
  fs.writeFileSync(notice, 'fixture third-party license')
  return { executable, notice }
}
async function fixtureStartup({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacStartup')
  fs.writeFileSync(executable, 'fixture startup helper')
  return { executable }
}
async function fixtureHosts({ outputRoot }) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const executable = path.join(outputRoot, 'ZToolsMacHosts')
  fs.writeFileSync(executable, 'fixture hosts helper')
  return { executable }
}

async function fixturePathAccess({ outputRoot }) {
  const nativeRoot = path.join(outputRoot, 'native')
  fs.mkdirSync(nativeRoot, { recursive: true })
  const executable = path.join(nativeRoot, 'ZToolsPathAccessBroker')
  fs.writeFileSync(executable, 'fixture path access broker')
  return { executable }
}

const sourcePackage = {
  version: '1.1.7.1',
  devDependencies: {
    '@electron/packager': '20.3.0',
    electron: '43.4.1'
  },
  dependencies: {
    'classic-level': '3.0.0'
  }
}

function isIgnored(options, filePath) {
  return options.ignore.some((pattern) => pattern.test(filePath))
}

test('refuses to run the macOS package entry point on Windows before parsing or building', async () => {
  const messages = []
  let buildCalled = false
  let packageCalled = false
  const exitCode = await main([], {
    platform: 'win32',
    stderr: (message) => messages.push(message),
    build: async () => { buildCalled = true },
    packageApp: async () => { packageCalled = true }
  })

  assert.equal(exitCode, 1)
  assert.match(messages[0], /只能在 Darwin 构建机运行/)
  assert.equal(buildCalled, false)
  assert.equal(packageCalled, false)
})

test('rejects a requested Mac NativeHost group before staging or building', async () => {
  let buildCalled = false
  let packageCalled = false
  const messages = []
  const exitCode = await main(['--include-native-host', '--native-catalog', '/approved/catalog.json'], {
    platform: 'darwin',
    stderr: (message) => messages.push(message),
    build: async () => { buildCalled = true },
    packageApp: async () => { packageCalled = true }
  })
  assert.equal(exitCode, 1)
  assert.match(messages[0], /MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE/)
  assert.equal(buildCalled, false)
  assert.equal(packageCalled, false)

  await assert.rejects(stageMacUniversal({
    nativeHostMode: 'enabled',
    platform: 'darwin',
    build: async () => { buildCalled = true },
    packageApp: async () => { packageCalled = true }
  }), /MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE/)
  assert.equal(buildCalled, false)
  assert.equal(packageCalled, false)
})

test('requires an explicit Bundle ID because no product Bundle ID is defined in the repository', async () => {
  const messages = []
  const exitCode = await main([], {
    platform: 'darwin',
    stderr: (message) => messages.push(message)
  })

  assert.equal(exitCode, 1)
  assert.match(messages[0], /必须通过 --app-bundle-id 显式提供/)
})

test('keeps only the combined Darwin classic-level prebuild and excludes build/test inputs', () => {
  const options = createMacUniversalPackagerOptions({
    sourceRoot: 'C:/workspace/electron-client',
    outputRoot: 'C:/workspace/electron-client/artifacts/1.1.7.1/darwin-universal',
    appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171'
  })

  assert.equal(isIgnored(options, '/node_modules/classic-level/prebuilds/darwin-x64+arm64/classic-level.node'), false)
  assert.equal(isIgnored(options, '/node_modules/classic-level/prebuilds/win32-ia32/classic-level.node'), true)
  assert.equal(isIgnored(options, '/node_modules/classic-level/prebuilds/linux-x64/classic-level.node'), true)
  assert.equal(isIgnored(options, '/tests/unit/example.test.ts'), true)
  // 打包后主进程要读 resources/app/app-icon.png，缺了它应用启动即失败；其余 resources 仍不进包
  assert.equal(isIgnored(options, '/resources'), false)
  assert.equal(isIgnored(options, '/resources/app'), false)
  assert.equal(isIgnored(options, '/resources/app/app-icon.png'), false)
  assert.equal(isIgnored(options, '/resources/app/LOGO.ico'), true)
  assert.equal(isIgnored(options, '/resources/app/brand/app-icon.svg'), true)
  assert.equal(isIgnored(options, '/resources/app/app-icon.png.bak'), true)
  assert.equal(isIgnored(options, '/resources/other/file.txt'), true)
  assert.equal(isIgnored(options, '/out/main/bootstrap.js'), false)
  assert.equal(isIgnored(options, '/out/native/win32-ia32/ZToolsNativeHost32.exe'), true)
  // 顶层只放行 package.json、node_modules、out、resources：开发机上的编译缓存、无用的冒烟页面、
  // 测试在当前目录误建的目录（如名字带反斜杠的 C:\Windows\System32，asar 会直接拒绝打包）都不能进包
  assert.equal(isIgnored(options, '/package.json'), false)
  assert.equal(isIgnored(options, '/node_modules'), false)
  assert.equal(isIgnored(options, '/out'), false)
  assert.equal(isIgnored(options, '/dist'), true)
  assert.equal(isIgnored(options, '/dist/.compile-cache/v24-arm64/a.js'), true)
  assert.equal(isIgnored(options, '/assets/smoke/index.html'), true)
  assert.equal(isIgnored(options, '/C:\\Windows\\System32'), true)
  assert.equal(isIgnored(options, '/package.json.bak'), true)
  assert.equal(isIgnored(options, '/.env.local'), true)
  assert.equal(isIgnored(options, '/node_modules_old/x.js'), true)
})

test('configures the locked Universal target and skips a second lipo of classic-level', () => {
  const options = createMacUniversalPackagerOptions({
    sourceRoot: '/workspace/electron-client',
    outputRoot: '/workspace/electron-client/artifacts/1.1.7.1/darwin-universal',
    appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171'
  })

  assert.equal(options.name, 'ZTools')
  assert.equal(options.platform, 'darwin')
  assert.equal(options.arch, 'universal')
  assert.equal(options.electronVersion, '43.4.1')
  assert.equal(options.appBundleId, 'org.example.ztools')
  assert.equal(options.appVersion, '1.1.7')
  assert.equal(options.buildVersion, '1171')
  assert.deepEqual(options.extendInfo.CFBundleURLTypes, [
    { CFBundleURLName: 'ZTools plugin open', CFBundleURLSchemes: ['ztools'] }
  ])
  assert.match(options.extendInfo.NSAppleEventsUsageDescription, /控制其他应用/)
  assert.deepEqual(options.asar, { unpack: '**/{.**,**}/**/*.node', unpackDir: '**/node_modules/exiftool-vendored.*' })
  assert.equal(options.overwrite, false)
  assert.equal(options.prune, true)
  assert.equal(
    options.osxUniversal.x64ArchFiles,
    'Contents/Resources/app.asar.unpacked/node_modules/classic-level/prebuilds/darwin-x64+arm64/classic-level.node'
  )
  assert.equal(
    path.matchesGlob(
      options.osxUniversal.x64ArchFiles,
      options.osxUniversal.x64ArchFiles
    ),
    true
  )
  assert.equal(
    path.matchesGlob(
      'Contents/Resources/app.asar.unpacked/node_modules/classic-level/prebuilds/win32-ia32/classic-level.node',
      options.osxUniversal.x64ArchFiles
    ),
    false
  )
  assert.equal('osxSign' in options, false)
  assert.equal('osxNotarize' in options, false)
})

test('双端 ASAR 配置保留原生模块与 ExifTool 实体文件', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-asar-native-'))
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  const sourceRoot = path.join(temporaryRoot, 'source')
  const nativeFile = 'node_modules/classic-level/prebuilds/darwin-x64+arm64/classic-level.node'
  const exiftoolFile = 'node_modules/exiftool-vendored.pl/bin/exiftool'
  for (const relative of [nativeFile, exiftoolFile, 'out/main/index.js']) {
    const file = path.join(sourceRoot, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `fixture: ${relative}`)
  }
  const configurations = [
    createMacUniversalPackagerOptions({ sourceRoot, outputRoot: temporaryRoot,
      appBundleId: 'org.example.ztools', shortVersion: '1.1.8', buildVersion: '1.1.8005' }),
    createWindowsPackagerOptions({ clientRoot: sourceRoot, outputRoot: temporaryRoot })
  ]
  for (const options of configurations) {
    const archive = path.join(temporaryRoot, `${options.platform}.asar`)
    t.after(() => uncache(archive))
    await createPackageWithOptions(sourceRoot, archive, options.asar)
    for (const relative of [nativeFile, exiftoolFile]) {
      assert.equal(statFile(archive, relative).unpacked, true, `${options.platform}: ${relative}`)
      assert.deepEqual(fs.readFileSync(path.join(`${archive}.unpacked`, relative)),
        fs.readFileSync(path.join(sourceRoot, relative)))
    }
    assert.notEqual(statFile(archive, 'out/main/index.js').unpacked, true)
    assert.equal(fs.existsSync(path.join(`${archive}.unpacked`, 'out/main/index.js')), false)
  }
})

test('rejects a pre-existing staging directory before building or invoking Packager', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-stage-test-'))
  seedIcon(temporaryRoot)
  const outputRoot = path.join(temporaryRoot, 'artifacts', sourcePackage.version, 'darwin-universal')
  fs.mkdirSync(outputRoot, { recursive: true })
  let buildCalled = false
  let packageCalled = false

  try {
    await assert.rejects(stageMacUniversal({
      appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
      platform: 'darwin',
      sourceRoot: temporaryRoot,
      sourcePackage,
      minimumOs: '13.0',
      buildNative: fixtureNative,
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision, buildAudioNative: fixtureAudio, buildInputLockNative: fixtureInputLock, buildDnsNative: fixtureDns, buildHostsNative: fixtureHosts, buildStartupNative: fixtureStartup, buildDisplayNative: fixtureDisplay, buildHotkeysNative: fixtureHotkeys, buildNetworkNative: fixtureNetwork,
      build: async () => { buildCalled = true },
      packageApp: async () => { packageCalled = true }
    }), /输出目录已存在/)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }

  assert.equal(buildCalled, false)
  assert.equal(packageCalled, false)
})

test('writes the versioned read-only runtime target marker only after the final architecture audit', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-stage-test-'))
  seedIcon(temporaryRoot)
  const expectedPackagePath = path.join(
    temporaryRoot,
    'artifacts',
    sourcePackage.version,
    'darwin-universal',
    'ZTools-darwin-universal'
  )
  const appBundlePath = path.join(expectedPackagePath, 'ZTools.app')
  const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources')
  const manifestPath = path.join(resourcesPath, 'ztools-runtime-target.json')
  const addonPath = path.join(
    appBundlePath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'classic-level',
    'prebuilds',
    'darwin-x64+arm64',
    'classic-level.node'
  )
  let verificationCalled = false

  try {
    const result = await stageMacUniversal({
      appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
      platform: 'darwin',
      sourceRoot: temporaryRoot,
      sourcePackage,
      minimumOs: '13.0',
      buildNative: fixtureNative,
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision, buildAudioNative: fixtureAudio, buildInputLockNative: fixtureInputLock, buildDnsNative: fixtureDns, buildHostsNative: fixtureHosts, buildStartupNative: fixtureStartup, buildDisplayNative: fixtureDisplay, buildHotkeysNative: fixtureHotkeys, buildNetworkNative: fixtureNetwork,
      build: async () => {},
      packageApp: async () => {
        fs.mkdirSync(path.dirname(addonPath), { recursive: true })
        fs.writeFileSync(addonPath, 'fixture addon')
        packIcon(temporaryRoot, appBundlePath)
        return [expectedPackagePath]
      },
      verifyBundle: ({ bundlePath }) => {
        assert.equal(bundlePath, appBundlePath)
        assert.equal(fs.existsSync(manifestPath), false)
        assert.equal(fs.readFileSync(path.join(resourcesPath, 'native', 'ZToolsMacClipboard'), 'utf8'), 'fixture native helper')
        assert.equal(fs.readFileSync(path.join(resourcesPath, 'native', 'ZToolsPathAccessBroker'), 'utf8'), 'fixture path access broker')
        verificationCalled = true
        return { machoFiles: [NETWORK_HELPER_EXECUTABLE, 'Contents/MacOS/ZTools', 'Contents/Resources/native/ZToolsMacClipboard', 'Contents/Resources/native/ZToolsPathAccessBroker', 'Contents/Resources/native/ZToolsMacVision', 'Contents/Resources/native/ZToolsMacAudio', 'Contents/Resources/native/ZToolsMacInputLock', 'Contents/Resources/native/ZToolsMacDns', 'Contents/Resources/native/ZToolsMacHosts', 'Contents/Resources/native/ZToolsMacHotkeys', 'Contents/Resources/native/ZToolsMacStartup', 'Contents/Resources/native/ZToolsMacDisplay'] }
      },
      stdout: () => {}
    })

    assert.equal(verificationCalled, true)
    assert.equal(fs.readFileSync(result.visionHelperPath, 'utf8'), 'fixture local Vision helper')
    // 返回值是解析过符号链接的真实路径（macOS 的 /var → /private/var），与下一条清单断言保持一致
    assert.equal(result.pathAccessHelperPath, path.join(fs.realpathSync(resourcesPath), 'native', 'ZToolsPathAccessBroker'))
    assert.equal(result.runtimeTargetManifestPath, path.join(fs.realpathSync(resourcesPath), 'ztools-runtime-target.json'))
    assert.deepEqual(JSON.parse(fs.readFileSync(result.runtimeTargetManifestPath, 'utf8')), {
      manifestVersion: 1,
      target: { platform: 'macos', runtime: 'electron', arch: 'universal' }
    })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resourcesPath, 'ztools-bundle-versions.json'), 'utf8')), {
      schemaVersion: 1, appVersion: '1.1.7.1', shortVersion: '1.1.7', buildVersion: '1171', nativeHostMode: 'disabled'
    })
    assert.equal(result.nativeHostMode, 'disabled')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(result.runtimeTargetManifestPath).mode & 0o222, 0)
    }
  } finally {
    if (process.platform === 'win32' && fs.existsSync(manifestPath)) fs.chmodSync(manifestPath, 0o666)
    const versionsPath = path.join(resourcesPath, 'ztools-bundle-versions.json')
    if (process.platform === 'win32' && fs.existsSync(versionsPath)) fs.chmodSync(versionsPath, 0o666)
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('passes universal options to the injected packager after reserving a fresh output root', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-stage-test-'))
  seedIcon(temporaryRoot)
  let receivedOptions
  try {
    await assert.rejects(stageMacUniversal({
      appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
      platform: 'darwin',
      sourceRoot: temporaryRoot,
      sourcePackage,
      minimumOs: '13.0',
      buildNative: fixtureNative,
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision, buildAudioNative: fixtureAudio, buildInputLockNative: fixtureInputLock, buildDnsNative: fixtureDns, buildHostsNative: fixtureHosts, buildStartupNative: fixtureStartup, buildDisplayNative: fixtureDisplay, buildHotkeysNative: fixtureHotkeys, buildNetworkNative: fixtureNetwork,
      build: async () => {},
      packageApp: async (options) => {
        receivedOptions = options
        throw new Error('stop after options capture')
      }
    }), /stop after options capture/)

    assert.equal(receivedOptions.arch, 'universal')
    assert.equal(receivedOptions.platform, 'darwin')
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'artifacts', sourcePackage.version, 'darwin-universal')), true)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('staging refuses either required native helper missing from the Mach-O audit before writing its target marker', async () => {
  for (const missing of ['ZToolsMacNetwork', 'ZToolsMacClipboard', 'ZToolsPathAccessBroker', 'ZToolsMacVision', 'ZToolsMacAudio', 'ZToolsMacInputLock', 'ZToolsMacDns', 'ZToolsMacHosts', 'ZToolsMacHotkeys', 'ZToolsMacStartup', 'ZToolsMacDisplay']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-required-helper-'))
    seedIcon(root)
    const packagePath = path.join(root, 'artifacts', sourcePackage.version, 'darwin-universal', 'ZTools-darwin-universal')
    const app = path.join(packagePath, 'ZTools.app'), resources = path.join(app, 'Contents', 'Resources')
    await assert.rejects(stageMacUniversal({ appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
      platform: 'darwin', sourceRoot: root, sourcePackage, minimumOs: '13.0', buildNative: fixtureNative,
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision, buildAudioNative: fixtureAudio, buildInputLockNative: fixtureInputLock, buildDnsNative: fixtureDns, buildHostsNative: fixtureHosts, buildStartupNative: fixtureStartup, buildDisplayNative: fixtureDisplay, buildHotkeysNative: fixtureHotkeys, buildNetworkNative: fixtureNetwork, build: async () => {}, stdout: () => {},
      packageApp: async () => {
        const addon = path.join(resources, 'app.asar.unpacked', 'node_modules', 'classic-level', 'prebuilds', 'darwin-x64+arm64', 'classic-level.node')
        fs.mkdirSync(path.dirname(addon), { recursive: true }); fs.writeFileSync(addon, 'fixture addon'); packIcon(root, app); return [packagePath]
      }, verifyBundle: () => ({ machoFiles: [...(missing === 'ZToolsMacNetwork' ? [] : [NETWORK_HELPER_EXECUTABLE]), 'Contents/MacOS/ZTools', ...['ZToolsMacClipboard', 'ZToolsPathAccessBroker', 'ZToolsMacVision', 'ZToolsMacAudio', 'ZToolsMacInputLock', 'ZToolsMacDns', 'ZToolsMacHosts', 'ZToolsMacHotkeys', 'ZToolsMacStartup', 'ZToolsMacDisplay']
        .filter(name => name !== missing).map(name => `Contents/Resources/native/${name}`)] })
    }), /REQUIRED_MAC_HELPER_MACHO_MISSING/)
    assert.equal(fs.existsSync(path.join(resources, 'ztools-runtime-target.json')), false)
    // Retain the failed, owned synthetic staging for diagnosis.
  }
})

test('Universal staging rejects a PathAccessBroker result outside its fresh build root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-path-broker-location-'))
  seedIcon(root)
  try {
    await assert.rejects(stageMacUniversal({
      appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
      platform: 'darwin', sourceRoot: root, sourcePackage, minimumOs: '13.0',
      buildNative: fixtureNative,
      buildPathAccessNative: async ({ outputRoot }) => {
        fs.mkdirSync(outputRoot, { recursive: true })
        const executable = path.join(root, 'outside', 'ZToolsPathAccessBroker')
        fs.mkdirSync(path.dirname(executable), { recursive: true })
        fs.writeFileSync(executable, 'fixture')
        return { executable }
      },
      buildVisionNative: fixtureVision, buildAudioNative: fixtureAudio, buildInputLockNative: fixtureInputLock, buildDnsNative: fixtureDns, buildHostsNative: fixtureHosts, buildStartupNative: fixtureStartup, buildDisplayNative: fixtureDisplay, buildHotkeysNative: fixtureHotkeys, buildNetworkNative: fixtureNetwork,
      build: async () => {},
      stdout: () => {}
    }), /INVALID_MAC_PATH_ACCESS_HELPER_LOCATION/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 应用图标 ────────────────────────────────────────────────────────────

test('打包参数指向仓库内的 ZTools.icns，不使用 Electron 默认图标', () => {
  const options = createMacUniversalPackagerOptions({
    sourceRoot: '/workspace/electron-client',
    outputRoot: '/workspace/electron-client/artifacts/1.1.7.1/darwin-universal',
    appBundleId: 'org.example.ztools', minimumOs: '13.0', shortVersion: '1.1.7', buildVersion: '1171'
  })
  assert.equal(options.icon, path.join('/workspace/electron-client', 'resources', 'app', 'ZTools.icns'))
})

test('仓库内提交的 ZTools.icns 是有效 ICNS 文件', () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  assert.doesNotThrow(() => assertMacApplicationIcon(fs, macApplicationIconPath(sourceRoot)))
})

test('[破坏性] 图标缺失或不是 ICNS 时在构建之前就失败', async () => {
  for (const [label, prepare, pattern] of [
    ['缺失', () => {}, /缺少 macOS 应用图标/],
    ['PNG 冒充', (root) => seedIcon(root, Buffer.from('\x89PNG\r\n', 'latin1')), /不是 ICNS 格式/],
    ['空文件', (root) => seedIcon(root, Buffer.alloc(0)), /不是有效的普通文件/]
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-icon-'))
    let buildCalled = false
    try {
      prepare(root)
      await assert.rejects(stageMacUniversal({
        appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
        platform: 'darwin', sourceRoot: root, sourcePackage, minimumOs: '13.0',
        buildNative: fixtureNative, buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision, buildAudioNative: fixtureAudio, buildInputLockNative: fixtureInputLock, buildDnsNative: fixtureDns, buildHostsNative: fixtureHosts, buildStartupNative: fixtureStartup, buildDisplayNative: fixtureDisplay, buildHotkeysNative: fixtureHotkeys, buildNetworkNative: fixtureNetwork,
        build: async () => { buildCalled = true }, packageApp: async () => []
      }), pattern, label)
      assert.equal(buildCalled, false, label)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('[破坏性] 打包产物缺少图标或与源图标不一致时拒绝，并校验 app.asar 内嵌运行态 PNG 图标', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-icon-verify-'))
  try {
    const iconPath = seedIcon(root)
    const app = path.join(root, 'ZTools.app')
    assert.throws(() => verifyPackagedIcon(fs, app, iconPath), /MAC_APPLICATION_ICON_NOT_PACKAGED/)
    const packaged = path.join(app, 'Contents', 'Resources', 'electron.icns')
    fs.mkdirSync(path.dirname(packaged), { recursive: true })
    fs.writeFileSync(packaged, Buffer.from('icns-electron-default', 'latin1'))
    assert.throws(() => verifyPackagedIcon(fs, app, iconPath), /MAC_APPLICATION_ICON_MISMATCH/)
    fs.copyFileSync(iconPath, packaged)
    assert.doesNotThrow(() => verifyPackagedIcon(fs, app, iconPath))

    // 当存在 app.asar 但缺少 resources/app/app-icon.png 时拒绝
    const asarSrc = path.join(root, 'asar-src')
    const asarPath = path.join(app, 'Contents', 'Resources', 'app.asar')
    fs.mkdirSync(path.join(asarSrc, 'out'), { recursive: true })
    fs.writeFileSync(path.join(asarSrc, 'package.json'), '{"name":"ztools"}')
    await createPackage(asarSrc, asarPath)
    assert.throws(() => verifyPackagedIcon(fs, app, iconPath), /MAC_ASAR_RUNTIME_ICON_NOT_PACKAGED/)

    // 当 app.asar 内的 app-icon.png 不是有效 PNG 时拒绝
    fs.mkdirSync(path.join(asarSrc, 'resources', 'app'), { recursive: true })
    fs.writeFileSync(path.join(asarSrc, 'resources', 'app', 'app-icon.png'), Buffer.from('not-a-png'))
    await createPackage(asarSrc, asarPath)
    assert.throws(() => verifyPackagedIcon(fs, app, iconPath), /MAC_ASAR_RUNTIME_ICON_INVALID/)

    // 当 app.asar 内包含有效 PNG 图标时通过
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    fs.writeFileSync(path.join(asarSrc, 'resources', 'app', 'app-icon.png'), validPng)
    await createPackage(asarSrc, asarPath)
    assert.doesNotThrow(() => verifyPackagedIcon(fs, app, iconPath))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 包内版本号 ──────────────────────────────────────────────────────────

test('打 asar 前把包内 package.json 版本改回四段式完整版本，打包后核对', async () => {
  const { restorePackagedAppVersion, verifyPackagedAppVersion } = await import('./package-macos-universal.mjs')
  const { createPackage } = await import('@electron/asar')
  const options = createMacUniversalPackagerOptions({
    sourceRoot: '/workspace/electron-client', outputRoot: '/workspace/out',
    appBundleId: 'org.example.ztools', shortVersion: '1.1.8', buildVersion: '1.1.1', appPackageVersion: '1.1.8.1'
  })
  assert.equal(options.appVersion, '1.1.8', 'Info.plist 仍用三段式')
  assert.equal(options.beforeAsar.length, 1)
  assert.equal(createMacUniversalPackagerOptions({ sourceRoot: '/w', outputRoot: '/o', appBundleId: 'org.example.ztools', shortVersion: '1.1.8', buildVersion: '1' }).beforeAsar, undefined)
  assert.throws(() => restorePackagedAppVersion('1.1.8.1; rm -rf /'), /INVALID_APP_PACKAGE_VERSION/)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-version-'))
  try {
    // 模拟打包器把版本改成了三段式
    const buildPath = path.join(root, 'app')
    fs.mkdirSync(buildPath)
    fs.writeFileSync(path.join(buildPath, 'package.json'), '﻿' + JSON.stringify({ name: 'ztools', version: '1.1.8', main: 'out/main/index.js' }))
    await options.beforeAsar[0]({ buildPath })
    const restored = JSON.parse(fs.readFileSync(path.join(buildPath, 'package.json'), 'utf8'))
    assert.deepEqual(restored, { name: 'ztools', version: '1.1.8.1', main: 'out/main/index.js' })

    const bundle = path.join(root, 'ZTools.app')
    const resources = path.join(bundle, 'Contents', 'Resources')
    fs.mkdirSync(resources, { recursive: true })
    await createPackage(buildPath, path.join(resources, 'app.asar'))
    assert.doesNotThrow(() => verifyPackagedAppVersion(fs, bundle, '1.1.8.1'))
    assert.throws(() => verifyPackagedAppVersion(fs, bundle, '1.1.8.2'), /MAC_PACKAGED_VERSION_MISMATCH/)
    fs.writeFileSync(path.join(resources, 'app.asar'), 'corrupted')
    assert.throws(() => verifyPackagedAppVersion(fs, bundle, '1.1.8.1'), /MAC_ASAR_PACKAGE_JSON_UNREADABLE/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

