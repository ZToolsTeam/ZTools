import { validateMacBundleVersions } from './macos-bundle-version.mjs'
import { buildMacClipboard } from './build-macos-clipboard.mjs'
import { buildMacVision } from './build-macos-vision.mjs'
import { buildMacPathAccess } from './build-macos-path-access.mjs'
import { compareOsVersions } from './macos-minimum-os.mjs'
import { packager } from '@electron/packager'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyMacosUniversalBundle } from './verify-macos-universal.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const EXPECTED_PACKAGER_VERSION = '20.3.0'
const EXPECTED_ELECTRON_VERSION = '43.4.1'
const EXPECTED_CLASSIC_LEVEL_VERSION = '3.0.0'
const APPLICATION_NAME = 'ZTools'
// 应用图标：由 resources/app/brand/app-icon.svg 生成的 macOS iconset（16–512 及 @2x）
const MAC_APPLICATION_ICON = ['resources', 'app', 'ZTools.icns']

export function macApplicationIconPath(sourceRoot) {
  return path.join(sourceRoot, ...MAC_APPLICATION_ICON)
}
const MAC_NATIVE_LOAD_PROOF_UNAVAILABLE = 'MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE'
const RUNTIME_TARGET_MANIFEST_FILE = 'ztools-runtime-target.json'
const RUNTIME_TARGET_MANIFEST_VERSION = 1
const CLASSIC_LEVEL_UNIVERSAL_ADDON =
  'Contents/Resources/app.asar.unpacked/node_modules/classic-level/prebuilds/darwin-x64+arm64/classic-level.node'

const ignoredMacPackagingPaths = [
  /^\/artifacts(?:\/|$)/,
  /^\/out\/(?!assets(?:\/|$)|contracts(?:\/|$)|main(?:\/|$)|preload(?:\/|$))/,
  /^\/out-test(?:\/|$)/,
  /^\/tests(?:\/|$)/,
  /^\/native(?:\/|$)/,
  // 主进程启动时读取 resources/app/app-icon.png 作为托盘与窗口图标（macOS 的 nativeImage 不支持 ICO），只放行这一个文件
  /^\/resources\/(?!app$|app\/app-icon\.png$)/,
  /^\/src(?:\/|$)/,
  /^\/scripts(?:\/|$)/,
  /^\/tsconfig(?:\.|$)/,
  /^\/README\.md$/,
  /^\/TESTING\.md$/,
  /^\/package-lock\.json$/,
  /^\/\.gitignore$/,
  /^\/\.gitattributes$/,
  /\.(?:exp|ilk|lib|map|obj|pdb)$/i,
  /^\/\.git(?:\/|$)/,
  /^\/node_modules\/\.package-lock\.json$/,
  /^\/node_modules\/(?:.*\/)?tests?(?:\/|$)/,
  /^\/node_modules\/(?:.*\/)?(?:AUTHORS|CHANGELOG|README|SECURITY|UPGRADING)\.md$/i,
  /^\/node_modules\/classic-level\/deps(?:\/|$)/,
  /^\/node_modules\/.*\.(?:c|cc|cpp|h|hpp|gyp|d\.ts)$/,
  /^\/node_modules\/classic-level\/prebuilds\/(?!darwin-x64\+arm64(?:\/|$))/
]

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function validateAppBundleId(value) {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error('必须通过 --app-bundle-id 显式提供 macOS Bundle ID；仓库中没有已确认的产品标识')
  }
  const parts = value.split('.')
  const validLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
  if (parts.length < 2 || parts.some((part) => !validLabel.test(part))) {
    throw new Error(`macOS Bundle ID 格式无效: ${value}`)
  }
  return value
}

function parseArguments(argv) {
  let appBundleId, minimumOs, shortVersion, buildVersion
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (/^--(?:include-native-host(?:=|$)|native(?:-|=|$))/i.test(argument)) {
      throw new Error(MAC_NATIVE_LOAD_PROOF_UNAVAILABLE)
    }
    if (argument === '--short-version' || argument.startsWith('--short-version=')) {
      if (shortVersion !== undefined) throw new Error('DUPLICATE_SHORT_VERSION')
      shortVersion = argument === '--short-version' ? argv[++index] : argument.slice('--short-version='.length)
      continue
    }
    if (argument === '--build-version' || argument.startsWith('--build-version=')) {
      if (buildVersion !== undefined) throw new Error('DUPLICATE_BUILD_VERSION')
      buildVersion = argument === '--build-version' ? argv[++index] : argument.slice('--build-version='.length)
      continue
    }
    if (argument === '--minimum-os' || argument.startsWith('--minimum-os=')) {
      if (minimumOs !== undefined) throw new Error('DUPLICATE_MINIMUM_OS')
      minimumOs = argument === '--minimum-os' ? argv[++index] : argument.slice('--minimum-os='.length)
      compareOsVersions(minimumOs, minimumOs)
      continue
    }
    if (argument === '--app-bundle-id') {
      if (appBundleId !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error('用法: npm run package:app:darwin:universal -- --app-bundle-id <已批准的 Bundle ID>')
      }
      appBundleId = argv[index + 1]
      index += 1
      continue
    }
    if (argument.startsWith('--app-bundle-id=')) {
      if (appBundleId !== undefined) {
        throw new Error('--app-bundle-id 只能指定一次')
      }
      appBundleId = argument.slice('--app-bundle-id='.length)
      continue
    }
    throw new Error(`不支持的参数: ${argument}`)
  }
  const validatedBundleId = validateAppBundleId(appBundleId)
  compareOsVersions(minimumOs, minimumOs)
  return { appBundleId: validatedBundleId, minimumOs, ...validateMacBundleVersions(shortVersion, buildVersion) }
}

function assertBuildDependencies(sourcePackage) {
  if (sourcePackage.devDependencies?.['@electron/packager'] !== EXPECTED_PACKAGER_VERSION) {
    throw new Error(`@electron/packager 必须锁定为 ${EXPECTED_PACKAGER_VERSION}`)
  }
  if (sourcePackage.devDependencies?.electron !== EXPECTED_ELECTRON_VERSION) {
    throw new Error(`Electron 必须锁定为 ${EXPECTED_ELECTRON_VERSION}`)
  }
  if (sourcePackage.dependencies?.['classic-level'] !== EXPECTED_CLASSIC_LEVEL_VERSION) {
    throw new Error(`classic-level 必须锁定为 ${EXPECTED_CLASSIC_LEVEL_VERSION}`)
  }
}

function resolveOutputRoot({ sourceRoot, sourcePackage, buildQualifier }) {
  const qualifier = buildQualifier ?? ''
  if (qualifier && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(qualifier)) {
    throw new Error('ZTOOLS_BUILD_QUALIFIER 格式无效')
  }
  const version = sourcePackage.version
  if (typeof version !== 'string' || !/^[0-9A-Za-z.-]+$/.test(version)) {
    throw new Error('package.json version 格式无效')
  }
  const artifactVersion = qualifier ? `${version}-${qualifier}` : version
  return path.join(sourceRoot, 'artifacts', artifactVersion, 'darwin-universal')
}

export function createMacUniversalPackagerOptions({ sourceRoot, outputRoot, appBundleId, minimumOs, shortVersion, buildVersion }) {
  const validatedBundleId = validateAppBundleId(appBundleId)
  validateMacBundleVersions(shortVersion, buildVersion)
  return {
    dir: sourceRoot,
    name: APPLICATION_NAME,
    out: outputRoot,
    platform: 'darwin',
    arch: 'universal',
    electronVersion: EXPECTED_ELECTRON_VERSION,
    appBundleId: validatedBundleId,
    appVersion: shortVersion,
    buildVersion,
    // 未指定时打包器会使用 Electron 默认图标
    icon: macApplicationIconPath(sourceRoot),
    extendInfo: {
      CFBundleURLTypes: [{ CFBundleURLName: 'ZTools plugin open', CFBundleURLSchemes: ['ztools'] }],
      ...(minimumOs ? { LSMinimumSystemVersion: minimumOs } : {})
    },
    asar: true,
    overwrite: false,
    prune: true,
    ignore: [...ignoredMacPackagingPaths],
    osxUniversal: {
      x64ArchFiles: CLASSIC_LEVEL_UNIVERSAL_ADDON
    }
  }
}

function buildElectronApplication(sourceRoot) {
  const npmCli = process.env.npm_execpath
  if (!npmCli || !fs.existsSync(npmCli)) {
    throw new Error('无法定位 npm CLI，请通过 npm run package:app:darwin:universal 执行')
  }
  const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: sourceRoot,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`npm run build 执行失败，退出码 ${result.status ?? 'unknown'}`)
  }
}

function reserveOutputRoot(fsApi, outputRoot) {
  if (fsApi.existsSync(outputRoot)) {
    throw new Error(`macOS staging 输出目录已存在，请先归档后重试: ${outputRoot}`)
  }
  fsApi.mkdirSync(path.dirname(outputRoot), { recursive: true })
  try {
    fsApi.mkdirSync(outputRoot)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error(`macOS staging 输出目录已存在，请先归档后重试: ${outputRoot}`)
    }
    throw error
  }
}

export function assertMacApplicationIcon(fsApi, iconPath) {
  let stats
  try {
    stats = fsApi.lstatSync(iconPath)
  } catch {
    throw new Error(`缺少 macOS 应用图标: ${iconPath}`)
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`macOS 应用图标不是有效的普通文件: ${iconPath}`)
  }
  const header = fsApi.readFileSync(iconPath).subarray(0, 4).toString('latin1')
  if (header !== 'icns') throw new Error(`macOS 应用图标不是 ICNS 格式: ${iconPath}`)
}

/** 打包器会把图标复制为 Contents/Resources/electron.icns；逐字节比对，防止静默回退为 Electron 默认图标 */
export function verifyPackagedIcon(fsApi, appBundlePath, iconPath) {
  const packaged = path.join(appBundlePath, 'Contents', 'Resources', 'electron.icns')
  let bundled
  try {
    bundled = fsApi.readFileSync(packaged)
  } catch {
    throw new Error('MAC_APPLICATION_ICON_NOT_PACKAGED')
  }
  if (!Buffer.from(bundled).equals(Buffer.from(fsApi.readFileSync(iconPath)))) {
    throw new Error('MAC_APPLICATION_ICON_MISMATCH')
  }
}

function verifyPackagedAddon(fsApi, addonPath) {
  let stats
  try {
    stats = fsApi.lstatSync(addonPath)
  } catch (error) {
    throw new Error(`缺少 classic-level macOS Universal native addon: ${addonPath} (${errorMessage(error)})`)
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`classic-level macOS native addon 必须是普通文件: ${addonPath}`)
  }
}

function validatedResourcesRoot(fsApi, appBundlePath) {
  if (typeof appBundlePath !== 'string' || !path.isAbsolute(appBundlePath)) {
    throw new Error('macOS runtime target manifest requires an absolute application bundle path')
  }
  const resolvedBundlePath = path.resolve(appBundlePath)
  const contentsPath = path.resolve(resolvedBundlePath, 'Contents')
  const resourcesPath = path.resolve(resolvedBundlePath, 'Contents', 'Resources')
  if (path.dirname(resourcesPath) !== contentsPath) {
    throw new Error('macOS runtime target manifest path is outside the verified application bundle')
  }

  const bundleStats = fsApi.lstatSync(resolvedBundlePath)
  const contentsStats = fsApi.lstatSync(contentsPath)
  const resourcesStats = fsApi.lstatSync(resourcesPath)
  if (!bundleStats.isDirectory() || bundleStats.isSymbolicLink() ||
      !contentsStats.isDirectory() || contentsStats.isSymbolicLink() ||
      !resourcesStats.isDirectory() || resourcesStats.isSymbolicLink() ||
      path.resolve(fsApi.realpathSync(contentsPath)) !== path.resolve(fsApi.realpathSync(resolvedBundlePath), 'Contents') ||
      path.resolve(fsApi.realpathSync(resourcesPath)) !== path.resolve(fsApi.realpathSync(contentsPath), 'Resources')) {
    throw new Error('macOS runtime target manifest requires real bundle and Resources directories')
  }

  const canonicalResourcesPath = fsApi.realpathSync(resourcesPath)
  return canonicalResourcesPath
}

function writeRuntimeTargetManifest(fsApi, appBundlePath, versions) {
  const canonicalResourcesPath = validatedResourcesRoot(fsApi, appBundlePath)
  const manifestPath = path.resolve(canonicalResourcesPath, RUNTIME_TARGET_MANIFEST_FILE)
  if (path.dirname(manifestPath) !== canonicalResourcesPath) {
    throw new Error('macOS runtime target manifest path is outside the verified application bundle')
  }

  fsApi.writeFileSync(path.join(canonicalResourcesPath, 'ztools-bundle-versions.json'), `${JSON.stringify({ schemaVersion: 1, ...versions }, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o444
  })
  const manifest = {
    manifestVersion: RUNTIME_TARGET_MANIFEST_VERSION,
    target: {
      platform: 'macos',
      runtime: 'electron',
      arch: 'universal'
    }
  }
  fsApi.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444
  })
  return manifestPath
}

export async function stageMacUniversal({
  appBundleId,
  minimumOs,
  shortVersion,
  buildVersion,
  nativeHostMode = 'disabled',
  includeNativeHost = false,
  nativeCatalog,
  buildNative = buildMacClipboard,
  buildPathAccessNative = buildMacPathAccess,
  buildVisionNative = buildMacVision,
  platform = process.platform,
  sourceRoot = root,
  sourcePackage = packageJson,
  buildQualifier = process.env.ZTOOLS_BUILD_QUALIFIER ?? '',
  fsApi = fs,
  build = buildElectronApplication,
  packageApp = packager,
  verifyBundle = verifyMacosUniversalBundle,
  stdout = console.log,
  ...nativeGroupOptions
}) {
  if (platform !== 'darwin') {
    throw new Error(`macOS Universal staging 只能在 Darwin 构建机运行，当前平台: ${platform}`)
  }
  const unrecognizedNativeGroupInput = Object.keys(nativeGroupOptions).some((key) =>
    /native|team|catalog|hostbundle|workerbundle|slice|cmake/i.test(key))
  if (nativeHostMode !== 'disabled' || includeNativeHost || nativeCatalog !== undefined || unrecognizedNativeGroupInput) {
    throw new Error(MAC_NATIVE_LOAD_PROOF_UNAVAILABLE)
  }
  const validatedBundleId = validateAppBundleId(appBundleId)
  compareOsVersions(minimumOs, minimumOs)
  validateMacBundleVersions(shortVersion, buildVersion)
  assertBuildDependencies(sourcePackage)
  // 在耗时的构建与 Universal 合并之前先确认图标可用
  assertMacApplicationIcon(fsApi, macApplicationIconPath(sourceRoot))
  const outputRoot = resolveOutputRoot({ sourceRoot, sourcePackage, buildQualifier })
  if (fsApi.existsSync(outputRoot)) {
    throw new Error(`macOS staging 输出目录已存在，请先归档后重试: ${outputRoot}`)
  }

  await build(sourceRoot)
  reserveOutputRoot(fsApi, outputRoot)
  const native = await buildNative({ outputRoot: path.join(outputRoot, 'native-build'), minimumOs })
  const pathAccessBuildRoot = path.join(outputRoot, 'path-access-native-build')
  const pathAccessNative = await buildPathAccessNative({ outputRoot: pathAccessBuildRoot, minimumOs })
  const expectedPathAccessExecutable = path.join(pathAccessBuildRoot, 'native', 'ZToolsPathAccessBroker')
  if (typeof pathAccessNative?.executable !== 'string' ||
      path.resolve(pathAccessNative.executable) !== path.resolve(expectedPathAccessExecutable)) {
    throw new Error('INVALID_MAC_PATH_ACCESS_HELPER_LOCATION')
  }
  const visionNative = await buildVisionNative({ outputRoot: path.join(outputRoot, 'vision-native-build'), minimumOs })

  const options = createMacUniversalPackagerOptions({
    sourceRoot,
    outputRoot,
    appBundleId: validatedBundleId,
    minimumOs,
    shortVersion,
    buildVersion
  })
  const packagePaths = await packageApp(options)
  const expectedPackagePath = path.resolve(outputRoot, `${APPLICATION_NAME}-darwin-universal`)
  if (!Array.isArray(packagePaths) || packagePaths.length !== 1 ||
      path.resolve(packagePaths[0]) !== expectedPackagePath) {
    throw new Error(`Universal 打包器返回了非预期输出路径: ${JSON.stringify(packagePaths)}`)
  }

  const appBundlePath = path.join(expectedPackagePath, `${APPLICATION_NAME}.app`)
  const addonPath = path.join(appBundlePath, ...CLASSIC_LEVEL_UNIVERSAL_ADDON.split('/'))
  verifyPackagedAddon(fsApi, addonPath)
  verifyPackagedIcon(fsApi, appBundlePath, macApplicationIconPath(sourceRoot))
  const helperStats = fsApi.lstatSync(native.executable)
  if (!helperStats.isFile() || helperStats.isSymbolicLink()) throw new Error('INVALID_MAC_CLIPBOARD_HELPER')
  const nativeDestination = path.join(validatedResourcesRoot(fsApi, appBundlePath), 'native')
  fsApi.mkdirSync(nativeDestination)
  const helperPath = path.join(nativeDestination, 'ZToolsMacClipboard')
  fsApi.copyFileSync(native.executable, helperPath, fs.constants.COPYFILE_EXCL)
  fsApi.chmodSync(helperPath, 0o755)
  const pathAccessStats = fsApi.lstatSync(pathAccessNative.executable)
  if (!pathAccessStats.isFile() || pathAccessStats.isSymbolicLink()) throw new Error('INVALID_MAC_PATH_ACCESS_HELPER')
  const pathAccessHelperPath = path.join(nativeDestination, 'ZToolsPathAccessBroker')
  fsApi.copyFileSync(pathAccessNative.executable, pathAccessHelperPath, fs.constants.COPYFILE_EXCL)
  fsApi.chmodSync(pathAccessHelperPath, 0o755)
  const visionStats = fsApi.lstatSync(visionNative.executable)
  if (!visionStats.isFile() || visionStats.isSymbolicLink()) throw new Error('INVALID_MAC_VISION_HELPER')
  const visionHelperPath = path.join(nativeDestination, 'ZToolsMacVision')
  fsApi.copyFileSync(visionNative.executable, visionHelperPath, fs.constants.COPYFILE_EXCL)
  fsApi.chmodSync(visionHelperPath, 0o755)
  const verification = verifyBundle({ bundlePath: appBundlePath, minimumOs })
  for (const helper of ['ZToolsMacClipboard', 'ZToolsPathAccessBroker', 'ZToolsMacVision']) {
    if (!Array.isArray(verification?.machoFiles) || !verification.machoFiles.includes(`Contents/Resources/native/${helper}`)) {
      throw new Error('REQUIRED_MAC_HELPER_MACHO_MISSING')
    }
  }
  const runtimeTargetManifestPath = writeRuntimeTargetManifest(fsApi, appBundlePath, {
    appVersion: sourcePackage.version,
    shortVersion,
    buildVersion,
    nativeHostMode: 'disabled'
  })
  stdout(`macOS Universal staging 完成: ${appBundlePath}`)
  stdout(`Mach-O 架构检查: ${verification.machoFiles.length} 个二进制均含 arm64 与 x86_64`)
  stdout('Mac NativeHost/Worker未启用：生产同对象加载证明尚未成立。')
  stdout('此产物未配置 Developer ID 签名或公证；仍需在 Mac 上验证 classic-level 实际加载。')
  return {
    outputRoot,
    packagePath: expectedPackagePath,
    appBundlePath,
    runtimeTargetManifestPath,
    helperPath,
    visionHelperPath,
    pathAccessHelperPath,
    nativeHostMode: 'disabled',
    minimumOs,
    verification
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  const stderr = dependencies.stderr ?? console.error
  if (argv.length === 1 && argv[0] === '--help') {
    (dependencies.stdout ?? console.log)('npm run package:app:darwin:universal -- --app-bundle-id <approved ID> --minimum-os <approved OS> --short-version <approved major.minor.patch> --build-version <approved one-to-three components> (Mac NativeHost/Worker staging is blocked until pre-initializer same-object proof exists)')
    return 0
  }
  if (platform !== 'darwin') {
    stderr(`macOS Universal staging 只能在 Darwin 构建机运行，当前平台: ${platform}`)
    return 1
  }

  try {
    const { appBundleId, minimumOs, shortVersion, buildVersion } = parseArguments(argv)
    await stageMacUniversal({ ...dependencies, appBundleId, minimumOs, shortVersion, buildVersion, platform })
    return 0
  } catch (error) {
    stderr(`macOS Universal staging 失败: ${errorMessage(error)}`)
    return 1
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = await main()
}
