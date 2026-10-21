import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  assertMacApplicationIcon,
  assertMacRuntimeIcon,
  createMacUniversalPackagerOptions,
  macApplicationIconPath,
  macRuntimeIconPath,
  main,
  stageMacUniversal,
  verifyPackagedIcon
} from './package-macos-universal.mjs'

// 最小 ICNS 夹具：魔数 icns + 长度，足以通过格式检查
const FIXTURE_ICNS = Buffer.concat([Buffer.from('icns', 'latin1'), Buffer.from([0, 0, 0, 8])])
// 最小 PNG 夹具：8 字节签名 + 1 字节内容，足以通过格式检查
const FIXTURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

function seedRuntimeIcon(sourceRoot, bytes = FIXTURE_PNG) {
  const iconPath = macRuntimeIconPath(sourceRoot)
  fs.mkdirSync(path.dirname(iconPath), { recursive: true })
  fs.writeFileSync(iconPath, bytes)
  return iconPath
}

function seedIcon(sourceRoot, bytes = FIXTURE_ICNS) {
  const iconPath = macApplicationIconPath(sourceRoot)
  fs.mkdirSync(path.dirname(iconPath), { recursive: true })
  fs.writeFileSync(iconPath, bytes)
  seedRuntimeIcon(sourceRoot)
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
  assert.equal(options.asar, true)
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
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision,
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
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision,
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
        return { machoFiles: ['Contents/MacOS/ZTools', 'Contents/Resources/native/ZToolsMacClipboard', 'Contents/Resources/native/ZToolsPathAccessBroker', 'Contents/Resources/native/ZToolsMacVision'] }
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
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision,
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
  for (const missing of ['ZToolsMacClipboard', 'ZToolsPathAccessBroker', 'ZToolsMacVision']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-required-helper-'))
    seedIcon(root)
    const packagePath = path.join(root, 'artifacts', sourcePackage.version, 'darwin-universal', 'ZTools-darwin-universal')
    const app = path.join(packagePath, 'ZTools.app'), resources = path.join(app, 'Contents', 'Resources')
    await assert.rejects(stageMacUniversal({ appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
      platform: 'darwin', sourceRoot: root, sourcePackage, minimumOs: '13.0', buildNative: fixtureNative,
      buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision, build: async () => {}, stdout: () => {},
      packageApp: async () => {
        const addon = path.join(resources, 'app.asar.unpacked', 'node_modules', 'classic-level', 'prebuilds', 'darwin-x64+arm64', 'classic-level.node')
        fs.mkdirSync(path.dirname(addon), { recursive: true }); fs.writeFileSync(addon, 'fixture addon'); packIcon(root, app); return [packagePath]
      }, verifyBundle: () => ({ machoFiles: ['Contents/MacOS/ZTools', ...['ZToolsMacClipboard', 'ZToolsPathAccessBroker', 'ZToolsMacVision']
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
      buildVisionNative: fixtureVision,
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
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
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
        buildNative: fixtureNative, buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision,
        build: async () => { buildCalled = true }, packageApp: async () => []
      }), pattern, label)
      assert.equal(buildCalled, false, label)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('仓库内提交的 app-icon.png 是有效 PNG，且不会被 .gitignore 忽略', () => {
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const iconPath = macRuntimeIconPath(sourceRoot)
  assert.doesNotThrow(() => assertMacRuntimeIcon(fs, iconPath))
  // 退出码 1 表示没有任何忽略规则命中；--no-index 只看规则本身，不受文件是否已被跟踪影响
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path.relative(sourceRoot, iconPath)], { cwd: sourceRoot })
  assert.equal(result.status, 1)
})

test('[破坏性] 运行时 PNG 图标缺失或格式不对时在构建之前就失败', async () => {
  for (const [label, prepare, pattern] of [
    ['缺失', () => {}, /缺少 macOS 运行时图标/],
    ['ICO 冒充', (root) => seedRuntimeIcon(root, Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0])), /不是 PNG 格式/],
    ['空文件', (root) => seedRuntimeIcon(root, Buffer.alloc(0)), /不是有效的普通文件/],
    ['只有签名', (root) => seedRuntimeIcon(root, FIXTURE_PNG.subarray(0, 8)), /不是有效的普通文件/]
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-macos-runtime-icon-'))
    let buildCalled = false
    try {
      const iconsPath = macApplicationIconPath(root)
      fs.mkdirSync(path.dirname(iconsPath), { recursive: true })
      fs.writeFileSync(iconsPath, FIXTURE_ICNS)
      prepare(root)
      await assert.rejects(stageMacUniversal({
        appBundleId: 'org.example.ztools', shortVersion: '1.1.7', buildVersion: '1171',
        platform: 'darwin', sourceRoot: root, sourcePackage, minimumOs: '13.0',
        buildNative: fixtureNative, buildPathAccessNative: fixturePathAccess, buildVisionNative: fixtureVision,
        build: async () => { buildCalled = true }, packageApp: async () => []
      }), pattern, label)
      assert.equal(buildCalled, false, label)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('[破坏性] 打包产物缺少图标或与源图标不一致时拒绝', () => {
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

