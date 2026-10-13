import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getWindowsArtifactRoot,
  getWindowsInstallerFileName,
  WINDOWS_TARGET
} from './windows-package-contract.mjs'
import { assertPeMachine, PE_MACHINE_X86 } from './windows-pe-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(root, '..')
const installerRoot = path.join(repositoryRoot, 'installer')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const buildQualifier = process.env.ZTOOLS_BUILD_QUALIFIER ?? ''
if (buildQualifier && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(buildQualifier)) {
  throw new Error('ZTOOLS_BUILD_QUALIFIER 格式无效')
}

const artifactVersion = buildQualifier ? `${packageJson.version}-${buildQualifier}` : packageJson.version
const artifactRoot = getWindowsArtifactRoot(root, artifactVersion)
const applicationRoot = path.join(artifactRoot, WINDOWS_TARGET.applicationDirectory)
const applicationManifestPath = path.join(applicationRoot, 'manifest.json')
const setupSource = path.join(installerRoot, 'Setup', 'ZToolsSetup.exe')
const uninstallerSource = path.join(installerRoot, 'Uninstall', 'ZToolsUninstall.exe')
const installerResources = path.join(installerRoot, 'Resources')
const zipScript = path.join(installerResources, 'zip_files.ps1')
const resourceHackerSource = path.join(installerResources, 'ResHacker.exe')
const resourceHackerRuntimeSource = path.join(installerResources, 'rw32core.dll')
const installerName = getWindowsInstallerFileName(artifactVersion)
const installerOutput = path.join(artifactRoot, installerName)
const checksumOutput = `${installerOutput}.sha256`
const temporaryParent = path.join(root, 'out', 'installer')

function requireFile(file, description) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${description}不存在: ${file}`)
  }
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} 执行失败，退出码 ${result.status ?? 'unknown'}`)
  }
}

function digest(file, algorithm) {
  return createHash(algorithm).update(fs.readFileSync(file)).digest('hex')
}

function directorySize(directory) {
  let total = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    total += entry.isDirectory() ? directorySize(target) : fs.statSync(target).size
  }
  return total
}

if (!fs.existsSync(applicationRoot) || !fs.statSync(applicationRoot).isDirectory()) {
  throw new Error(`Electron 应用目录不存在: ${applicationRoot}`)
}
for (const [file, description] of [
  [applicationManifestPath, 'Electron manifest'],
  [path.join(applicationRoot, 'ZTools.exe'), 'Electron 主程序'],
  [path.join(applicationRoot, 'ZToolsService.exe'), 'ZToolsService'],
  [path.join(applicationRoot, 'resources', 'native', 'ZToolsNativeHost32.exe'), 'NativeHost32'],
  [path.join(applicationRoot, 'resources', 'service', 'privileged-dlls-v1.xml'), 'ZToolsService 生产特权清单'],
  [setupSource, '原安装器'],
  [uninstallerSource, '原卸载器'],
  [zipScript, '安装包压缩脚本'],
  [resourceHackerSource, '资源注入工具'],
  [resourceHackerRuntimeSource, '资源注入工具运行库'],
  [path.join(installerResources, 'offline.rc'), '离线资源定义'],
  [path.join(installerResources, 'config.json'), '安装器配置'],
  [path.join(installerResources, 'logo.png'), '安装器 Logo'],
  [path.join(installerResources, 'logo.ico'), '安装器图标']
]) requireFile(file, description)

if (fs.existsSync(installerOutput) || fs.existsSync(checksumOutput)) {
  throw new Error(`安装包输出已存在，请归档后重试: ${installerOutput}`)
}
for (const file of [setupSource, uninstallerSource]) {
  assertPeMachine(file, PE_MACHINE_X86, '原安装/卸载引导器')
}

const applicationManifest = JSON.parse(fs.readFileSync(applicationManifestPath, 'utf8'))
if (
  applicationManifest.appVersion !== packageJson.version ||
  applicationManifest.electronVersion !== packageJson.devDependencies.electron ||
  applicationManifest.platform !== 'win32' ||
  applicationManifest.arch !== WINDOWS_TARGET.arch ||
  applicationManifest.buildQualifier !== (buildQualifier || null)
) {
  throw new Error('Electron 应用 manifest 与当前 win32-x64 构建不一致')
}

const distribution = {
  format: 'original-delphi-offline-installer',
  installerFile: installerName,
  setupSourceSha256: digest(setupSource, 'sha256'),
  uninstallerFile: 'ZToolsUninstall.exe',
  uninstallerSourceSha256: digest(uninstallerSource, 'sha256'),
  minWindowsVersion: '10.0'
}

fs.mkdirSync(temporaryParent, { recursive: true })
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, `${artifactVersion}-`))
const stageRoot = path.join(temporaryRoot, 'stage')
const resourceRoot = path.join(temporaryRoot, 'resources')
const archivePath = path.join(resourceRoot, 'files.zip')
const offlineResource = path.join(resourceRoot, 'offline.res')
const temporaryInstaller = path.join(temporaryRoot, installerName)
let completed = false
let installerCreated = false
let checksumCreated = false

try {
  fs.cpSync(applicationRoot, stageRoot, { recursive: true, errorOnExist: true })
  fs.copyFileSync(uninstallerSource, path.join(stageRoot, 'ZToolsUninstall.exe'))
  fs.writeFileSync(
    path.join(stageRoot, 'manifest.json'),
    `${JSON.stringify({ ...applicationManifest, distribution }, null, 2)}\n`,
    'utf8'
  )

  fs.mkdirSync(resourceRoot, { recursive: true })
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', zipScript,
    '-SourceDir', stageRoot,
    '-DestinationPath', archivePath,
    '-MaxRetries', '3',
    '-RetryDelaySeconds', '1'
  ], repositoryRoot)
  requireFile(archivePath, 'Electron 安装文件归档')

  const originalConfig = JSON.parse(fs.readFileSync(path.join(installerResources, 'config.json'), 'utf8'))
  const applicationSizeMb = Math.ceil(directorySize(stageRoot) / 1048576)
  const installerConfig = {
    ...originalConfig,
    Version: packageJson.version,
    RequiredSpaceMB: Math.max(originalConfig.RequiredSpaceMB ?? 0, Math.ceil(applicationSizeMb * 1.2)),
    PackageSize: fs.statSync(archivePath).size,
    PackageMD5: digest(archivePath, 'md5'),
    PreInstall: {
      ...originalConfig.PreInstall,
      MinWindowsVersion: '10.0'
    }
  }
  fs.writeFileSync(path.join(resourceRoot, 'config.json'), `${JSON.stringify(installerConfig, null, 2)}\n`, 'utf8')
  for (const file of ['offline.rc', 'logo.png', 'logo.ico', 'ResHacker.exe', 'rw32core.dll']) {
    fs.copyFileSync(path.join(installerResources, file), path.join(resourceRoot, file))
  }

  const resourceHacker = path.join(resourceRoot, 'ResHacker.exe')
  run(resourceHacker, ['-open', 'offline.rc', '-save', 'offline.res', '-action', 'compile'], resourceRoot)
  requireFile(offlineResource, 'Electron 离线安装资源')
  run(resourceHacker, [
    '-open', setupSource,
    '-save', temporaryInstaller,
    '-resource', offlineResource,
    '-action', 'addoverwrite'
  ], resourceRoot)
  requireFile(temporaryInstaller, 'Electron 离线安装包')
  assertPeMachine(temporaryInstaller, PE_MACHINE_X86, '最终离线安装包引导器')

  const installerSha256 = digest(temporaryInstaller, 'sha256')
  fs.copyFileSync(temporaryInstaller, installerOutput, fs.constants.COPYFILE_EXCL)
  installerCreated = true
  fs.writeFileSync(checksumOutput, `${installerSha256}  ${installerName}\n`, { encoding: 'utf8', flag: 'wx' })
  checksumCreated = true
  fs.writeFileSync(
    applicationManifestPath,
    `${JSON.stringify({
      ...applicationManifest,
      distribution: { ...distribution, installerSha256 }
    }, null, 2)}\n`,
    'utf8'
  )

  completed = true
  console.log(installerOutput)
  console.log(checksumOutput)
} finally {
  if (!completed) {
    if (installerCreated) fs.rmSync(installerOutput, { force: true })
    if (checksumCreated) fs.rmSync(checksumOutput, { force: true })
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
