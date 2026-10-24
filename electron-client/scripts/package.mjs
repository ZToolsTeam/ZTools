import { packager } from '@electron/packager'
import { readNativeHostManifest } from './native-host-manifest.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createWindowsApplicationManifest,
  createWindowsPackagerOptions,
  getWindowsArtifactRoot,
  WINDOWS_CLASSIC_LEVEL_VERSION,
  WINDOWS_ELECTRON_VERSION
} from './windows-package-contract.mjs'
import { stageWindowsPathAccessBroker } from './windows-path-access-broker.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const electronVersion = WINDOWS_ELECTRON_VERSION
const buildQualifier = process.env.ZTOOLS_BUILD_QUALIFIER ?? ''
if (buildQualifier && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(buildQualifier)) {
  throw new Error('ZTOOLS_BUILD_QUALIFIER 格式无效')
}
const artifactVersion = buildQualifier ? `${packageJson.version}-${buildQualifier}` : packageJson.version
const outputRoot = getWindowsArtifactRoot(root, artifactVersion)
const nativeHostSource = path.join(root, 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe')
const serviceSource = path.join(root, 'out', 'native', 'service-win32-ia32', 'ZToolsService.exe')
const pathAccessBrokerSource = path.join(root, 'out', 'native', 'win32-x64', 'bin', 'ZToolsPathAccessBroker.exe')
const pluginSourceRoot = path.resolve(root, '..', 'bin', 'Data', 'Plugins')
const privilegedManifestSource = path.join(
  root,
  'resources',
  'service',
  'privileged-dlls-v1.xml'
)
// 应用图标随客户端仓库维护（resources/app/brand 为 SVG 源文件），不再依赖未纳入版本管理的旧 framework 目录
const applicationIcon = path.join(root, 'resources', 'app', 'LOGO.ico')
const retainedLocales = new Set(['en-US.pak', 'zh-CN.pak'])
const privilegedDll = {
  pluginId: 'context-menu',
  dllId: 'ContextMenuPlugin',
  path: 'lib/ContextMenuPlugin.dll',
  functions: [
    'CheckAdmin',
    'ScanMenuItems',
    'EnableMenuItem',
    'DisableMenuItem',
    'DeleteMenuItem',
    'AddCustomMenuItem',
    'InspectMenuItems',
    'RefreshExplorer'
  ]
}

// 公开源码没有 ../bin/Data/Plugins（商业 DLL 只在内部仓库）：只打包宿主，特权清单为空，ZToolsService 不加载任何特权 DLL
const hostOnly = !fs.existsSync(pluginSourceRoot)

function createEmptyPrivilegedManifest() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<privilegedDllManifest version="1">',
    '</privilegedDllManifest>',
    ''
  ].join('\n')
}

function createPrivilegedManifest() {
  if (hostOnly) return createEmptyPrivilegedManifest()
  const dllPath = path.join(
    pluginSourceRoot,
    privilegedDll.pluginId,
    ...privilegedDll.path.split('/')
  )
  const stats = fs.lstatSync(dllPath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`ZToolsService DLL 不是普通文件: ${dllPath}`)
  }
  const sha256 = createHash('sha256').update(fs.readFileSync(dllPath)).digest('hex')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<privilegedDllManifest version="1">',
    `  <plugin id="${privilegedDll.pluginId}">`,
    `    <dll id="${privilegedDll.dllId}" path="${privilegedDll.path}" sha256="${sha256}" arch="x86">`,
    ...privilegedDll.functions.map((name) => `      <function name="${name}"/>`),
    '    </dll>',
    '  </plugin>',
    '</privilegedDllManifest>',
    ''
  ].join('\n')
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function iconFingerprint(file, _executable) {
  const iconExpression = `[Drawing.Icon]::ExtractAssociatedIcon(${powershellLiteral(file)})`
  const script = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Drawing',
    `$icon=${iconExpression}`,
    'if($null -eq $icon){throw "无法读取图标"}',
    '$bitmap=$icon.ToBitmap()',
    '$stream=[IO.MemoryStream]::new()',
    '$sha=[Security.Cryptography.SHA256]::Create()',
    'try{$bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png);[BitConverter]::ToString($sha.ComputeHash($stream.ToArray())).Replace("-","")}finally{$sha.Dispose();$stream.Dispose();$bitmap.Dispose();$icon.Dispose()}'
  ].join(';')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
}

function prunePackagedApplication(applicationPath) {
  const localesDirectory = path.join(applicationPath, 'locales')
  if (!fs.existsSync(localesDirectory) || !fs.statSync(localesDirectory).isDirectory()) {
    throw new Error(`Electron 语言包目录不存在: ${localesDirectory}`)
  }

  const localeEntries = fs.readdirSync(localesDirectory, { withFileTypes: true })
  for (const locale of retainedLocales) {
    if (!localeEntries.some((entry) => entry.isFile() && entry.name === locale)) {
      throw new Error(`必需的 Electron 语言包不存在: ${locale}`)
    }
  }

  let removedLocaleCount = 0
  let removedLocaleBytes = 0
  for (const entry of localeEntries) {
    if (!entry.isFile()) throw new Error(`Electron 语言包目录包含非文件项: ${entry.name}`)
    if (retainedLocales.has(entry.name)) continue
    const target = path.join(localesDirectory, entry.name)
    removedLocaleBytes += fs.statSync(target).size
    fs.rmSync(target)
    removedLocaleCount += 1
  }
  return { removedLocaleCount, removedLocaleBytes }
}

if (packageJson.devDependencies.electron !== electronVersion) throw new Error('Electron 版本未精确锁定')
if (packageJson.dependencies?.['classic-level'] !== WINDOWS_CLASSIC_LEVEL_VERSION) throw new Error('classic-level 版本未精确锁定')
if (packageJson.dependencies?.yauzl !== '3.4.0') throw new Error('yauzl 版本未精确锁定')
if (fs.existsSync(outputRoot)) throw new Error(`输出目录已存在，请归档后重试: ${outputRoot}`)
if (!fs.existsSync(nativeHostSource)) throw new Error(`NativeHost32 产物不存在: ${nativeHostSource}`)
if (!fs.existsSync(serviceSource)) throw new Error(`ZToolsService 产物不存在: ${serviceSource}`)
if (!fs.existsSync(pathAccessBrokerSource)) throw new Error(`ZToolsPathAccessBroker 产物不存在: ${pathAccessBrokerSource}`)
if (!fs.existsSync(privilegedManifestSource)) {
  throw new Error(`ZToolsService 生产特权清单不存在: ${privilegedManifestSource}`)
}
if (!fs.existsSync(applicationIcon)) throw new Error(`应用图标不存在: ${applicationIcon}`)
const expectedApplicationIconFingerprint = iconFingerprint(applicationIcon, false)
const nativeHostManifest = readNativeHostManifest(root)
const privilegedManifest = createPrivilegedManifest()
if (hostOnly) {
  console.warn(`未找到商业 DLL 目录 ${pluginSourceRoot}，只打包宿主：特权 DLL 清单为空`)
} else if (fs.readFileSync(privilegedManifestSource, 'utf8') !== privilegedManifest) {
  throw new Error('ZToolsService 生产特权清单与当前 DLL 哈希或函数白名单不一致')
}
const privilegedManifestSha256 = createHash('sha256')
  .update(Buffer.from(privilegedManifest, 'utf8'))
  .digest('hex')

const applicationPaths = await packager(createWindowsPackagerOptions({
  clientRoot: root,
  outputRoot,
  applicationIcon
}))

function assertNoDataPayload(applicationPath) {
  for (const relative of ['Data', 'data', path.join('resources', 'runtime')]) {
    if (fs.existsSync(path.join(applicationPath, relative))) {
      throw new Error('应用目录不应包含业务数据目录: ' + relative)
    }
  }
}

const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const gitDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== ''
for (const applicationPath of applicationPaths) {
  assertNoDataPayload(applicationPath)
  const pruneResult = prunePackagedApplication(applicationPath)
  console.log(
    `已删除 ${pruneResult.removedLocaleCount} 个未使用语言包 ` +
    `(${(pruneResult.removedLocaleBytes / 1048576).toFixed(2)} MB)`
  )
  const applicationExecutable = path.join(applicationPath, 'ZTools.exe')
  if (iconFingerprint(applicationExecutable, true) !== expectedApplicationIconFingerprint) {
    throw new Error(`Electron 主程序图标与原版 ZTools 图标不一致: ${applicationExecutable}`)
  }
  const nativeDirectory = path.join(applicationPath, 'resources', 'native')
  fs.mkdirSync(nativeDirectory, { recursive: true })
  fs.copyFileSync(nativeHostSource, path.join(nativeDirectory, 'ZToolsNativeHost32.exe'))
  const pathAccessBroker = stageWindowsPathAccessBroker({ clientRoot: root, resourcesNativeDirectory: nativeDirectory })
  // 批量改名等安全文件操作依赖该组件，缺失时不能打出功能残缺的安装包
  if (!pathAccessBroker) {
    throw new Error('未找到 x64 ZToolsPathAccessBroker.exe（out/native/win32-x64/bin），请先运行 npm run build:native:win:path-access-broker')
  }
  console.log(`已打包 x64 PathAccessBroker: ${pathAccessBroker}`)
  const pathAccessBrokerSha256 = createHash('sha256').update(fs.readFileSync(pathAccessBroker)).digest('hex')
  fs.writeFileSync(
    path.join(nativeDirectory, '.ztools-native-host.xml'),
    nativeHostManifest,
    'utf8'
  )
  const serviceDirectory = path.join(applicationPath, 'resources', 'service')
  fs.mkdirSync(serviceDirectory, { recursive: true })
  const packagedPrivilegedManifest = path.join(serviceDirectory, 'privileged-dlls-v1.xml')
  // 只打包宿主时写入空清单（与 privilegedManifestSha256 对应），否则照旧复制已校验的源清单
  if (hostOnly) fs.writeFileSync(packagedPrivilegedManifest, privilegedManifest, 'utf8')
  else fs.copyFileSync(privilegedManifestSource, packagedPrivilegedManifest)
  fs.copyFileSync(serviceSource, path.join(applicationPath, 'ZToolsService.exe'))
  const manifest = createWindowsApplicationManifest({
    appVersion: packageJson.version,
    gitCommit,
    gitDirty,
    buildQualifier,
    privilegedManifestSha256,
    pathAccessBrokerSha256
  })
  fs.writeFileSync(path.join(applicationPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

console.log(applicationPaths.join('\n'))
