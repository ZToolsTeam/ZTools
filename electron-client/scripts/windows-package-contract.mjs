import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

export const WINDOWS_TARGET = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  artifactDirectory: 'win32-x64',
  applicationDirectory: 'ZTools-win32-x64'
})

export const WINDOWS_ELECTRON_VERSION = '43.4.1'
export const WINDOWS_CLASSIC_LEVEL_VERSION = '3.0.0'
const PATH_ACCESS_BROKER_NAME = 'ZToolsPathAccessBroker.exe'
const PATH_ACCESS_BROKER_RESOURCE_PATH = 'resources/native/ZToolsPathAccessBroker.exe'

const ignoredWindowsPackagingPaths = [
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
  /^\/node_modules\/classic-level\/prebuilds\/(?!win32-x64(?:\/|$))/
]

export function getWindowsArtifactRoot(clientRoot, artifactVersion) {
  return path.join(clientRoot, 'artifacts', artifactVersion, WINDOWS_TARGET.artifactDirectory)
}

export function getWindowsInstallerFileName(artifactVersion) {
  return `ZTools-${artifactVersion}-${WINDOWS_TARGET.artifactDirectory}.exe`
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
    asar: true,
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
    runtimeDependencies: [{ name: 'yauzl', version: '3.4.0' }]
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
