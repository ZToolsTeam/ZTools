import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'
import {
  getWindowsArtifactRoot,
  getWindowsInstallerFileName,
  verifyWindowsPathAccessBrokerDependency,
  WINDOWS_ELECTRON_VERSION,
  WINDOWS_TARGET
} from './windows-package-contract.mjs'
import {
  assertPeMachine,
  PE_MACHINE_X86,
  verifyWindowsArtifactPeFiles
} from './windows-pe-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const buildQualifier = process.env.ZTOOLS_BUILD_QUALIFIER ?? ''
if (buildQualifier && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(buildQualifier)) {
  throw new Error('ZTOOLS_BUILD_QUALIFIER 格式无效')
}
const artifactVersion = buildQualifier ? `${packageJson.version}-${buildQualifier}` : packageJson.version
const artifactRoot = getWindowsArtifactRoot(root, artifactVersion)
const repositoryRoot = path.resolve(root, '..')
const setupSource = path.join(repositoryRoot, 'installer', 'Setup', 'ZToolsSetup.exe')
const uninstallerSource = path.join(repositoryRoot, 'installer', 'Uninstall', 'ZToolsUninstall.exe')
const expectedLocales = ['en-US.pak', 'zh-CN.pak']

if (!fs.existsSync(artifactRoot)) throw new Error(`产物目录不存在: ${artifactRoot}`)

function findFiles(directory, predicate) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...findFiles(target, predicate))
    else if (predicate(target)) files.push(target)
  }
  return files
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const manifests = findFiles(artifactRoot, (file) => path.basename(file) === 'manifest.json')
if (manifests.length !== 1) throw new Error(`manifest.json 数量必须为 1，实际 ${manifests.length}`)
const applicationRoot = path.dirname(manifests[0])
const applicationExecutable = path.join(applicationRoot, 'ZTools.exe')
const manifest = JSON.parse(fs.readFileSync(manifests[0], 'utf8'))
if (!fs.existsSync(applicationExecutable) || !fs.statSync(applicationExecutable).isFile()) {
  throw new Error(`Electron 主程序不存在: ${applicationExecutable}`)
}
if (
  path.basename(applicationRoot) !== WINDOWS_TARGET.applicationDirectory ||
  manifest.platform !== WINDOWS_TARGET.platform ||
  manifest.arch !== WINDOWS_TARGET.arch ||
  manifest.electronVersion !== WINDOWS_ELECTRON_VERSION ||
  !Array.isArray(manifest.supportedNativeOsArch) ||
  manifest.supportedNativeOsArch.length !== 1 ||
  manifest.supportedNativeOsArch[0] !== 'x64' ||
  !Number.isSafeInteger(manifest.sdkContractVersion) ||
  manifest.sdkContractVersion < 1 ||
  manifest.wow64OnX64 !== false
) {
  throw new Error('产物 manifest 平台、架构或 Electron 版本无效')
}
if (
  !Array.isArray(manifest.nativeDependencies) ||
  manifest.nativeDependencies.length !== 4 ||
  manifest.nativeDependencies[0]?.name !== 'classic-level' ||
  manifest.nativeDependencies[0]?.version !== '3.0.0' ||
  manifest.nativeDependencies[0]?.arch !== 'x64' ||
  manifest.nativeDependencies[1]?.name !== 'ZToolsNativeHost32' ||
  manifest.nativeDependencies[1]?.protocolVersion !== 1 ||
  manifest.nativeDependencies[1]?.arch !== 'ia32' ||
  manifest.nativeDependencies[2]?.name !== 'ZToolsService' ||
  manifest.nativeDependencies[2]?.protocolVersion !== 1 ||
  manifest.nativeDependencies[2]?.arch !== 'ia32' ||
  manifest.nativeDependencies[3]?.name !== 'ZToolsPathAccessBroker'
) {
  throw new Error('产物 manifest nativeDependencies 无效')
}
if (
  !Array.isArray(manifest.runtimeDependencies) ||
  manifest.runtimeDependencies.length !== 1 ||
  manifest.runtimeDependencies[0]?.name !== 'yauzl' ||
  manifest.runtimeDependencies[0]?.version !== '3.4.0'
) {
  throw new Error('产物 manifest runtimeDependencies 无效')
}

const localesDirectory = path.join(applicationRoot, 'locales')
if (!fs.existsSync(localesDirectory) || !fs.statSync(localesDirectory).isDirectory()) {
  throw new Error('Electron 语言包目录不存在')
}
const packagedLocales = fs.readdirSync(localesDirectory).sort()
if (JSON.stringify(packagedLocales) !== JSON.stringify(expectedLocales)) {
  throw new Error(`Electron 语言包必须仅包含中英文，实际: ${packagedLocales.join(', ')}`)
}

const buildIntermediates = findFiles(applicationRoot, (file) => /\.(?:exp|ilk|lib|map|obj|pdb)$/i.test(file))
if (buildIntermediates.length > 0) {
  throw new Error(`应用目录包含编译中间文件: ${buildIntermediates[0]}`)
}

const asarFiles = findFiles(artifactRoot, (file) => path.basename(file) === 'app.asar')
if (asarFiles.length !== 1) throw new Error(`app.asar 数量必须为 1，实际 ${asarFiles.length}`)
const asarEntries = listPackage(asarFiles[0]).map((entry) => entry.replaceAll('\\', '/'))
const forbiddenAsarEntries = asarEntries.filter((entry) =>
  /^\/(?:src|tests|scripts|native)(?:\/|$)/.test(entry) ||
  /^\/TESTING\.md$/i.test(entry) ||
  /^\/out\/(?!assets(?:\/|$)|contracts(?:\/|$)|main(?:\/|$)|preload(?:\/|$))/.test(entry) ||
  /^\/\.gitattributes$/.test(entry) ||
  /\.map$/i.test(entry) ||
  /^\/node_modules\/(?:.*\/)?tests?(?:\/|$)/i.test(entry) ||
  /^\/node_modules\/(?:.*\/)?(?:AUTHORS|CHANGELOG|README|SECURITY|UPGRADING)\.md$/i.test(entry) ||
  /^\/node_modules\/.*\.(?:c|cc|cpp|h|hpp|gyp|d\.ts)$/i.test(entry) ||
  /^\/node_modules\/classic-level\/prebuilds\/(?!win32-x64(?:\/|$))/i.test(entry)
)
if (forbiddenAsarEntries.length > 0) {
  throw new Error(`ASAR 包含源码、测试或错误架构预编译: ${forbiddenAsarEntries[0]}`)
}
const nativeEntry = '/node_modules/classic-level/prebuilds/win32-x64/classic-level.node'
if (asarEntries.filter((entry) => entry === nativeEntry).length !== 1) {
  throw new Error('ASAR 中 classic-level x64 native binding 数量无效')
}

const nativeFiles = findFiles(artifactRoot, (file) => /\.node$/i.test(file))
if (
  nativeFiles.length !== 1 ||
  !nativeFiles[0].replaceAll('\\', '/').endsWith('/app.asar.unpacked/node_modules/classic-level/prebuilds/win32-x64/classic-level.node')
) {
  throw new Error('ASAR 解包目录中的 classic-level x64 native binding 无效')
}

const nativeHosts = findFiles(artifactRoot, (file) => path.basename(file) === 'ZToolsNativeHost32.exe')
if (
  nativeHosts.length !== 1 ||
  !nativeHosts[0].replaceAll('\\', '/').endsWith('/resources/native/ZToolsNativeHost32.exe')
) {
  throw new Error('NativeHost32 打包位置或数量无效')
}

const services = findFiles(artifactRoot, (file) => path.basename(file) === 'ZToolsService.exe')
if (
  services.length !== 1 ||
  !services[0].replaceAll('\\', '/').endsWith(`/${WINDOWS_TARGET.applicationDirectory}/ZToolsService.exe`)
) {
  throw new Error('ZToolsService 打包位置或数量无效')
}

const pathAccessBrokerFiles = findFiles(artifactRoot, (file) => path.basename(file) === 'ZToolsPathAccessBroker.exe')
const pathAccessBrokerVerification = verifyWindowsPathAccessBrokerDependency({
  sdkContractVersion: manifest.sdkContractVersion,
  dependency: manifest.nativeDependencies[3],
  applicationRoot,
  brokerFiles: pathAccessBrokerFiles
})

const privilegedManifests = findFiles(
  artifactRoot,
  (file) => path.basename(file) === 'privileged-dlls-v1.xml'
)
if (
  privilegedManifests.length !== 1 ||
  !privilegedManifests[0].replaceAll('\\', '/').endsWith(
    '/resources/service/privileged-dlls-v1.xml'
  ) ||
  manifest.privilegedManifest?.path !== 'resources/service/privileged-dlls-v1.xml' ||
  manifest.privilegedManifest?.sha256 !== sha256(privilegedManifests[0])
) {
  throw new Error('ZToolsService 生产特权清单打包位置或摘要无效')
}

const expectedInstallerName = getWindowsInstallerFileName(artifactVersion)
const installer = path.join(artifactRoot, expectedInstallerName)
const installerChecksum = `${installer}.sha256`
if (!fs.existsSync(installer) || !fs.statSync(installer).isFile()) throw new Error(`最终安装包不存在: ${installer}`)
if (!fs.existsSync(installerChecksum) || !fs.statSync(installerChecksum).isFile()) {
  throw new Error(`最终安装包校验文件不存在: ${installerChecksum}`)
}
const installerSha256 = sha256(installer)
const expectedChecksum = `${installerSha256}  ${expectedInstallerName}`
if (fs.readFileSync(installerChecksum, 'utf8').trim() !== expectedChecksum) {
  throw new Error('最终安装包 SHA-256 校验文件无效')
}
if (
  manifest.distribution?.format !== 'original-delphi-offline-installer' ||
  manifest.distribution?.installerFile !== expectedInstallerName ||
  manifest.distribution?.installerSha256 !== installerSha256 ||
  manifest.distribution?.uninstallerFile !== 'ZToolsUninstall.exe' ||
  manifest.distribution?.minWindowsVersion !== '10.0'
) {
  throw new Error('原 Delphi 安装器/卸载器发布元数据无效')
}
for (const file of [setupSource, uninstallerSource]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`原安装/卸载器不存在: ${file}`)
  assertPeMachine(file, PE_MACHINE_X86, '原 Delphi 安装/卸载引导器')
}
if (
  manifest.distribution.setupSourceSha256 !== sha256(setupSource) ||
  manifest.distribution.uninstallerSourceSha256 !== sha256(uninstallerSource)
) {
  throw new Error('打包记录与原安装器/卸载器不一致')
}
const peFiles = findFiles(artifactRoot, (file) => /\.(exe|dll|node)$/i.test(file))
if (peFiles.length === 0) throw new Error('未找到 PE 文件')
const peArchitectureCounts = verifyWindowsArtifactPeFiles(peFiles, {
  applicationRoot,
  installerPath: installer
})
if (manifest.gitDirty !== false) throw new Error('产物来自脏工作区')

const signatureScript = [
  '$ErrorActionPreference="Stop"',
  '$bad=@()',
  ...[...peFiles, uninstallerSource].map(
    (file) => `$s=Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; if($s.Status -ne 'Valid'){$bad+='${file.replaceAll("'", "''")}='+$s.Status}`
  ),
  'if($bad.Count){$bad|ForEach-Object{[Console]::Error.WriteLine($_)};exit 1}'
].join(';')
execFileSync('pwsh.exe', ['-NoProfile', '-Command', signatureScript], { stdio: 'inherit' })

console.log(
  `Windows artifact checks passed (${peArchitectureCounts.x64} x64, ${peArchitectureCounts.x86} explicitly x86 PE files, ${asarEntries.length} ASAR entries; ` +
  `SDK ${manifest.sdkContractVersion}; PathAccessBroker ${pathAccessBrokerVerification.available ? 'available' : 'unavailable'}; ` +
  `referenceRuntimeAvailable=${pathAccessBrokerVerification.referenceRuntimeAvailable}). This is not Mac or complete release acceptance.`
)
