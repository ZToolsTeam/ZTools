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
export const NATIVE_TRUST_RESOURCE_FILES = Object.freeze([
  'native-trust-public-keys.json',
  'native-trust-revocations.json',
  'legacy-frozen-dlls.json'
])
export const REVOKED_DEV_NATIVE_TRUST_KEY_IDS = Object.freeze(['ztools-native-2026-v1'])
export const EMPTY_NATIVE_TRUST_PUBLIC_KEYS_JSON = '[]'
export const EMPTY_NATIVE_TRUST_REVOCATIONS_JSON =
  '{"schemaVersion":1,"revokedKeyIds":[],"revokedManifestSha256":[],"revokedFileSha256":[],"minPluginVersions":{}}'
export const EMPTY_NATIVE_TRUST_LEGACY_FROZEN_JSON = '[]'
export const NATIVE_TRUST_ALGORITHM = 'ecdsa-p256-sha256'
const KEY_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEX_128_REGEX = /^[a-f0-9]{128}$/
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/
const ALLOWED_KEY_USAGES = new Set(['native', 'native-privileged', 'commonlibs'])

/** 与 CMake ZTOOLS_NATIVE_TRUST_BUNDLE_SHA256 及 TS native-trust-verifier 逐字节一致的计算公式 */
export function computeNativeTrustBundleSha256({
  publicKeysText = EMPTY_NATIVE_TRUST_PUBLIC_KEYS_JSON,
  revocationsText = EMPTY_NATIVE_TRUST_REVOCATIONS_JSON,
  legacyFrozenText = EMPTY_NATIVE_TRUST_LEGACY_FROZEN_JSON
} = {}) {
  const p = String(publicKeysText).replace(/\r\n/g, '\n').trim()
  const r = String(revocationsText).replace(/\r\n/g, '\n').trim()
  const l = String(legacyFrozenText).replace(/\r\n/g, '\n').trim()
  const text = `publicKeys=${p}\nrevocations=${r}\nlegacyFrozen=${l}\n`
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 校验 manifest.nativeTrust 元数据结构 */
export function verifyWindowsNativeTrustMetadata(nativeTrust) {
  if (
    !exactKeys(nativeTrust, [
      'algorithm',
      'keyIds',
      'usages',
      'revocations',
      'legacyFrozenCount',
      'bundleSha256'
    ]) ||
    nativeTrust.algorithm !== NATIVE_TRUST_ALGORITHM ||
    !Array.isArray(nativeTrust.keyIds) ||
    !nativeTrust.keyIds.every((id) => typeof id === 'string' && KEY_ID_REGEX.test(id)) ||
    !Array.isArray(nativeTrust.usages) ||
    !nativeTrust.usages.every((usage) => typeof usage === 'string' && ALLOWED_KEY_USAGES.has(usage)) ||
    !exactKeys(nativeTrust.revocations, ['keys', 'manifests', 'files', 'minVersions']) ||
    !Number.isSafeInteger(nativeTrust.revocations.keys) || nativeTrust.revocations.keys < 0 ||
    !Number.isSafeInteger(nativeTrust.revocations.manifests) || nativeTrust.revocations.manifests < 0 ||
    !Number.isSafeInteger(nativeTrust.revocations.files) || nativeTrust.revocations.files < 0 ||
    !Number.isSafeInteger(nativeTrust.revocations.minVersions) || nativeTrust.revocations.minVersions < 0 ||
    !Number.isSafeInteger(nativeTrust.legacyFrozenCount) || nativeTrust.legacyFrozenCount < 0 ||
    typeof nativeTrust.bundleSha256 !== 'string' ||
    !SHA256_HEX_REGEX.test(nativeTrust.bundleSha256)
  ) {
    throw new Error('产物 manifest nativeTrust 元数据无效')
  }
  return nativeTrust
}

/**
 * 从 resources/native 目录加载三份原生信任根 JSON 并生成 manifest.nativeTrust 元数据。
 * 缺失文件按空表回退（适配 Open-Core 公开构建）；存在但不是受控普通文件或 JSON 格式非法时立即抛错。
 */
export function loadWindowsNativeTrustBundle(nativeDir, fsApi = fs) {
  const readOptional = (fileName, fallbackText) => {
    const filePath = path.join(nativeDir, fileName)
    let stats
    try {
      stats = fsApi.lstatSync(filePath)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { exists: false, filePath, text: fallbackText }
      }
      throw error
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`原生信任根文件不是受控普通文件: ${filePath}`)
    }
    return { exists: true, filePath, text: fsApi.readFileSync(filePath, 'utf8') }
  }

  const publicKeysFile = readOptional('native-trust-public-keys.json', EMPTY_NATIVE_TRUST_PUBLIC_KEYS_JSON)
  const revocationsFile = readOptional('native-trust-revocations.json', EMPTY_NATIVE_TRUST_REVOCATIONS_JSON)
  const legacyFrozenFile = readOptional('legacy-frozen-dlls.json', EMPTY_NATIVE_TRUST_LEGACY_FROZEN_JSON)

  const publicKeys = JSON.parse(publicKeysFile.text)
  if (!Array.isArray(publicKeys)) throw new Error('native-trust-public-keys.json 必须为数组')
  const seenKeyIds = new Set()
  for (const entry of publicKeys) {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.keyId !== 'string' || !KEY_ID_REGEX.test(entry.keyId) ||
      typeof entry.publicKeyHex !== 'string' || !HEX_128_REGEX.test(entry.publicKeyHex) ||
      !Array.isArray(entry.usages) || entry.usages.length === 0 ||
      !entry.usages.every((usage) => typeof usage === 'string' && ALLOWED_KEY_USAGES.has(usage))
    ) {
      throw new Error(`native-trust-public-keys.json 包含无效公钥条目: ${entry?.keyId ?? '?'}`)
    }
    if (seenKeyIds.has(entry.keyId)) {
      throw new Error(`native-trust-public-keys.json 包含重复 keyId: ${entry.keyId}`)
    }
    seenKeyIds.add(entry.keyId)
  }

  const revocations = JSON.parse(revocationsFile.text)
  if (
    !revocations || typeof revocations !== 'object' || Array.isArray(revocations) ||
    revocations.schemaVersion !== 1 ||
    !Array.isArray(revocations.revokedKeyIds) ||
    !revocations.revokedKeyIds.every((id) => typeof id === 'string' && KEY_ID_REGEX.test(id)) ||
    !Array.isArray(revocations.revokedManifestSha256) ||
    !revocations.revokedManifestSha256.every((hash) => typeof hash === 'string' && SHA256_HEX_REGEX.test(hash)) ||
    !Array.isArray(revocations.revokedFileSha256) ||
    !revocations.revokedFileSha256.every((hash) => typeof hash === 'string' && SHA256_HEX_REGEX.test(hash)) ||
    !revocations.minPluginVersions || typeof revocations.minPluginVersions !== 'object' ||
    Array.isArray(revocations.minPluginVersions) ||
    !Object.entries(revocations.minPluginVersions).every(
      ([pluginId, version]) => typeof pluginId === 'string' && pluginId.trim().length > 0 && typeof version === 'string' && version.trim().length > 0
    )
  ) {
    throw new Error('native-trust-revocations.json 格式无效')
  }

  const legacyFrozen = JSON.parse(legacyFrozenFile.text)
  if (!Array.isArray(legacyFrozen)) throw new Error('legacy-frozen-dlls.json 必须为数组')
  for (const entry of legacyFrozen) {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.pluginId !== 'string' || entry.pluginId.trim().length === 0 ||
      typeof entry.dllId !== 'string' || entry.dllId.trim().length === 0 ||
      typeof entry.sha256 !== 'string' || !SHA256_HEX_REGEX.test(entry.sha256) ||
      !Array.isArray(entry.functions) || entry.functions.length === 0 ||
      !entry.functions.every((fn) => typeof fn === 'string' && fn.trim().length > 0)
    ) {
      throw new Error(`legacy-frozen-dlls.json 包含无效冻结条目: ${entry?.pluginId ?? '?'}/${entry?.dllId ?? '?'}`)
    }
  }

  const bundleSha256 = computeNativeTrustBundleSha256({
    publicKeysText: publicKeysFile.text,
    revocationsText: revocationsFile.text,
    legacyFrozenText: legacyFrozenFile.text
  })
  const metadata = verifyWindowsNativeTrustMetadata({
    algorithm: NATIVE_TRUST_ALGORITHM,
    keyIds: publicKeys.map((entry) => entry.keyId),
    usages: [...new Set(publicKeys.flatMap((entry) => entry.usages))].sort(),
    revocations: {
      keys: revocations.revokedKeyIds.length,
      manifests: revocations.revokedManifestSha256.length,
      files: revocations.revokedFileSha256.length,
      minVersions: Object.keys(revocations.minPluginVersions).length
    },
    legacyFrozenCount: legacyFrozen.length,
    bundleSha256
  })

  return {
    metadata,
    publicKeys,
    revocations,
    legacyFrozen,
    files: {
      'native-trust-public-keys.json': publicKeysFile,
      'native-trust-revocations.json': revocationsFile,
      'legacy-frozen-dlls.json': legacyFrozenFile
    }
  }
}

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
  nativeTrust,
  pathAccessBrokerSha256
}) {
  const verifiedNativeTrust = verifyWindowsNativeTrustMetadata(nativeTrust)
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
    nativeTrust: verifiedNativeTrust,
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
