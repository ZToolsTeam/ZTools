import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import { ONNXRUNTIME_WEB_IGNORED_PATHS, ONNXRUNTIME_WEB_PACKAGED_FILES, ONNXRUNTIME_WEB_UNPACK_DIR, ONNXRUNTIME_WEB_VERSION, pruneOnnxRuntimeDependencies } from './onnxruntime-package-contract.mjs'

export { ONNXRUNTIME_WEB_PACKAGED_FILES }

export const WINDOWS_TARGET = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  artifactDirectory: 'windows-x64',
  applicationDirectory: 'ZTools-win32-x64'
})

export const WINDOWS_ELECTRON_VERSION = '43.4.1'
export const WINDOWS_CLASSIC_LEVEL_VERSION = '3.0.0'
export const WINDOWS_ONNXRUNTIME_WEB_VERSION = ONNXRUNTIME_WEB_VERSION
/** 识别模型复制到应用目录 resources/ocr（文件名与 fetch-ocr-models.mjs 一致） */
export const OCR_MODEL_RESOURCE_DIRECTORY = 'resources/ocr'
const PATH_ACCESS_BROKER_NAME = 'ZToolsPathAccessBroker.exe'
const PATH_ACCESS_BROKER_RESOURCE_PATH = 'resources/native/ZToolsPathAccessBroker.exe'
/** Windows 原生侧车可执行文件列表（编译输出位于 out/native/win32-x64/bin，打包位于 resources/native） */
export const WINDOWS_NATIVE_SIDECARS = Object.freeze([
  'ztools-indexer.exe',
  'ztools-uiaccess.exe',
  'ztools-uiaccess-standard.exe'
])

const ignoredWindowsPackagingPaths = [
  // 顶层只放行运行需要的 package.json、node_modules、out，其余一律排除：
  // 开发机上不受 git 管理的目录（编译缓存 dist/.compile-cache、测试在当前目录误建的目录等）不能混进安装包
  /^\/(?!(?:package\.json|node_modules|out)(?:\/|$))[^/]/,
  /^\/(?:Data|data)(?:\/|$)/,
  /^\/artifacts(?:\/|$)/,
  /^\/out\/(?!assets(?:\/|$)|contracts(?:\/|$)|main(?:\/|$)|preload(?:\/|$))/,
  /^\/out-test(?:\/|$)/,
  /^\/tests(?:\/|$)/,
  /^\/native(?:\/|$)/,
  /^\/resources(?:\/|$)/,
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
  /^\/node_modules\/classic-level\/prebuilds\/(?!win32-x64(?:\/|$))/,
  ...ONNXRUNTIME_WEB_IGNORED_PATHS
]

export function getWindowsArtifactRoot(clientRoot, artifactVersion) {
  return path.join(clientRoot, 'artifacts', artifactVersion, WINDOWS_TARGET.artifactDirectory)
}

export function getWindowsInstallerFileName(artifactVersion) {
  return `ZTools-${artifactVersion}-${WINDOWS_TARGET.artifactDirectory}.exe`
}

export function getWindowsPortableZipFileName(artifactVersion) {
  return `ZTools-${artifactVersion}-${WINDOWS_TARGET.artifactDirectory}-portable.zip`
}

export function createWindowsPackagerOptions({ clientRoot, outputRoot, applicationIcon }) {
  return {
    dir: clientRoot,
    name: 'ZTools',
    out: outputRoot,
    platform: WINDOWS_TARGET.platform,
    arch: WINDOWS_TARGET.arch,
    electronVersion: WINDOWS_ELECTRON_VERSION,
    icon: applicationIcon,
    // onnxruntime-web 的工作线程要从真实文件加载 wasm 运行时，整个目录解到 asar 外
    asar: { unpack: '**/{.**,**}/**/*.node', unpackDir: `{**/node_modules/exiftool-vendored.*,${ONNXRUNTIME_WEB_UNPACK_DIR}}` },
    afterPrune: [pruneOnnxRuntimeDependencies],
    overwrite: false,
    prune: true,
    ignore: [...ignoredWindowsPackagingPaths]
  }
}

export function createWindowsApplicationManifest({
  appVersion,
  gitCommit,
  gitDirty,
  buildQualifier,
  privilegedManifestSha256,
  pathAccessBrokerSha256
}) {
  const pathAccessBrokerDependency = pathAccessBrokerSha256 === undefined
    ? { name: 'ZToolsPathAccessBroker', optional: true, status: 'unavailable', reason: 'not-built' }
    : (() => {
      if (typeof pathAccessBrokerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pathAccessBrokerSha256)) {
        throw new Error('PathAccessBroker SHA-256 无效')
      }
      return {
        name: 'ZToolsPathAccessBroker',
        optional: true,
        status: 'available',
        path: PATH_ACCESS_BROKER_RESOURCE_PATH,
        arch: 'x64',
        sha256: pathAccessBrokerSha256
      }
    })()

  return {
    appVersion,
    electronVersion: WINDOWS_ELECTRON_VERSION,
    platform: WINDOWS_TARGET.platform,
    arch: WINDOWS_TARGET.arch,
    supportedNativeOsArch: ['x64'],
    wow64OnX64: false,
    gitCommit,
    gitDirty,
    buildQualifier: buildQualifier || null,
    sdkContractVersion: 1,
    nativeHostProtocolVersion: 1,
    serviceProtocolVersion: 1,
    privilegedManifest: {
      path: 'resources/service/privileged-dlls-v1.xml',
      sha256: privilegedManifestSha256
    },
    nativeDependencies: [
      { name: 'classic-level', version: WINDOWS_CLASSIC_LEVEL_VERSION, arch: 'x64' },
      { name: 'ZToolsNativeHost32', protocolVersion: 1, arch: 'ia32' },
      { name: 'ZToolsService', protocolVersion: 1, arch: 'ia32' },
      pathAccessBrokerDependency
    ],
    runtimeDependencies: [
      { name: 'yauzl', version: '3.4.0' },
      { name: 'onnxruntime-web', version: WINDOWS_ONNXRUNTIME_WEB_VERSION }
    ]
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

/** Check the manifest's optional broker declaration against the packaged file list. */
export function verifyWindowsPathAccessBrokerDependency({ sdkContractVersion, dependency, applicationRoot, brokerFiles }) {
  if (!Number.isSafeInteger(sdkContractVersion) || sdkContractVersion < 1) {
    throw new Error('产物 manifest SDK contract version 无效')
  }
  const expectedKeys = dependency?.status === 'available'
    ? ['name', 'optional', 'status', 'path', 'arch', 'sha256']
    : ['name', 'optional', 'status', 'reason']
  if (!exactKeys(dependency, expectedKeys) || dependency.name !== 'ZToolsPathAccessBroker' || dependency.optional !== true) {
    throw new Error('产物 manifest PathAccessBroker metadata 无效')
  }
  if (!Array.isArray(brokerFiles)) throw new Error('PathAccessBroker 文件清单无效')

  if (dependency.status === 'unavailable') {
    if (dependency.reason !== 'not-built' || brokerFiles.length !== 0) {
      throw new Error('PathAccessBroker unavailable 状态与产物内容不一致')
    }
    if (sdkContractVersion >= 2) throw new Error('SDK 2 或更高版本必须包含 PathAccessBroker')
    return { available: false, referenceRuntimeAvailable: false, sdkContractVersion, reason: dependency.reason }
  }

  if (dependency.status !== 'available' || dependency.path !== PATH_ACCESS_BROKER_RESOURCE_PATH ||
      dependency.arch !== 'x64' || typeof dependency.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.sha256)) {
    throw new Error('产物 manifest PathAccessBroker available metadata 无效')
  }
  const expectedFile = path.resolve(applicationRoot, ...PATH_ACCESS_BROKER_RESOURCE_PATH.split('/'))
  if (brokerFiles.length !== 1 || !samePath(brokerFiles[0], expectedFile) || path.basename(expectedFile) !== PATH_ACCESS_BROKER_NAME) {
    throw new Error('PathAccessBroker 打包位置或数量无效')
  }

  let stats
  try { stats = fs.lstatSync(expectedFile) }
  catch { throw new Error('PathAccessBroker 声明文件不存在') }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('PathAccessBroker 必须是普通文件')
  try {
    if (!samePath(fs.realpathSync(expectedFile), expectedFile)) throw new Error('PathAccessBroker 路径经过链接')
  } catch {
    throw new Error('PathAccessBroker 路径无法安全解析')
  }
  assertPeMachine(expectedFile, PE_MACHINE_X64, 'ZToolsPathAccessBroker')
  if (sha256(expectedFile) !== dependency.sha256) throw new Error('PathAccessBroker SHA-256 与 manifest 不一致')
  return { available: true, referenceRuntimeAvailable: sdkContractVersion >= 2, sdkContractVersion, file: expectedFile }
}

function assertControlledPath(fileSystem, targetPath, kind, label) {
  let stats
  try {
    stats = fileSystem.lstatSync(targetPath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`${label}不存在: ${targetPath}`)
    }
    throw error
  }
  const matchesKind = kind === 'dir' ? stats.isDirectory() : stats.isFile()
  if (!matchesKind || stats.isSymbolicLink()) {
    throw new Error(`${label}不是受控普通${kind === 'dir' ? '目录' : '文件'}: ${targetPath}`)
  }
  const canonical = path.resolve(fileSystem.realpathSync(targetPath))
  const requested = path.resolve(targetPath)
  if (!samePath(canonical, requested)) {
    throw new Error(`${label}经过非受控链接: ${targetPath}`)
  }
  return requested
}

/** 校验并返回 Windows 原生侧车构建源路径（缺失或非 x64 PE 直接失败） */
export function resolveWindowsNativeSidecarSources(clientRoot, fsApi = fs) {
  if (typeof clientRoot !== 'string' || !clientRoot.trim()) {
    throw new Error('clientRoot 不能为空')
  }
  const binDir = path.join(path.resolve(clientRoot), 'out', 'native', 'win32-x64', 'bin')
  return WINDOWS_NATIVE_SIDECARS.map((name) => {
    const sourcePath = path.join(binDir, name)
    let resolved
    try {
      resolved = assertControlledPath(fsApi, sourcePath, 'file', `原生侧车 ${name}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`${msg}，请先运行 npm run build:native:sidecars`)
    }
    assertPeMachine(resolved, PE_MACHINE_X64, name)
    return { name, sourcePath: resolved }
  })
}

/** 将已校验的 Windows x64 原生侧车复制进打包应用目录 resources/native/ */
export function stageWindowsNativeSidecars({ clientRoot, resourcesNativeDirectory, fsApi = fs }) {
  const destDir = assertControlledPath(fsApi, resourcesNativeDirectory, 'dir', 'Windows native 资源目录')
  const sources = resolveWindowsNativeSidecarSources(clientRoot, fsApi)
  return sources.map(({ name, sourcePath }) => {
    const destination = path.join(destDir, name)
    fsApi.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL)
    return destination
  })
}

/** 校验应用包内的 Windows 原生侧车位置唯一、非链接且为 x64 PE */
export function verifyWindowsNativeSidecars({ applicationRoot, sidecarFilesByName, fsApi = fs }) {
  if (!(sidecarFilesByName instanceof Map)) {
    throw new Error('sidecarFilesByName 必须为 Map')
  }
  const verified = []
  for (const name of WINDOWS_NATIVE_SIDECARS) {
    const expectedFile = path.resolve(applicationRoot, 'resources', 'native', name)
    const matchedFiles = sidecarFilesByName.get(name) ?? []
    if (matchedFiles.length !== 1 || !samePath(matchedFiles[0], expectedFile)) {
      throw new Error(`原生侧车 ${name} 打包位置或数量无效（预期仅位于 resources/native/${name}）`)
    }
    const resolved = assertControlledPath(fsApi, expectedFile, 'file', `打包产物侧车 ${name}`)
    assertPeMachine(resolved, PE_MACHINE_X64, name)
    verified.push(resolved)
  }
  return verified
}
