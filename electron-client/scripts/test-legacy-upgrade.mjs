import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const defaultOutputRoot = path.join(root, 'out-test', 'legacy-upgrade')
const footerSize = 52

function parseArguments(values) {
  const options = {
    artifact: process.env.ZTOOLS_LEGACY_ARTIFACT ?? '',
    fixtureRoot: process.env.ZTOOLS_LEGACY_FIXTURE_ROOT ?? '',
    runRoot: process.env.ZTOOLS_LEGACY_RUN_ROOT ?? '',
    legacyClient: process.env.ZTOOLS_LEGACY_CLIENT ?? '',
    legacyArgs: [],
    expectedPlugins: Number.parseInt(process.env.ZTOOLS_LEGACY_PLUGIN_COUNT ?? '57', 10)
  }
  for (const value of values) {
    if (value.startsWith('--artifact=')) options.artifact = value.slice('--artifact='.length)
    else if (value.startsWith('--fixture-root=')) options.fixtureRoot = value.slice('--fixture-root='.length)
    else if (value.startsWith('--run-root=')) options.runRoot = value.slice('--run-root='.length)
    else if (value.startsWith('--legacy-client=')) options.legacyClient = value.slice('--legacy-client='.length)
    else if (value.startsWith('--legacy-arg=')) options.legacyArgs.push(value.slice('--legacy-arg='.length))
    else if (value.startsWith('--expected-plugins=')) options.expectedPlugins = Number.parseInt(value.slice('--expected-plugins='.length), 10)
    else throw new Error(`未知参数: ${value}`)
  }
  return options
}

function ordinaryStats(target, label) {
  const stats = fs.lstatSync(target, { throwIfNoEntry: false })
  if (!stats || stats.isSymbolicLink()) throw new Error(`${label}不存在或包含符号链接: ${target}`)
  return stats
}

function requireDirectory(target, label) {
  if (!ordinaryStats(target, label).isDirectory()) throw new Error(`${label}不是普通目录: ${target}`)
}

function requireFile(target, label) {
  if (!ordinaryStats(target, label).isFile()) throw new Error(`${label}不是普通文件: ${target}`)
}

function assertRunRoot(target) {
  if (!path.isAbsolute(target)) throw new Error(`隔离运行目录必须是绝对路径: ${target}`)
  const normalizedRoot = path.resolve(target)
  const protectedRoots = [path.resolve(root), path.resolve(path.dirname(root))]
  const evidenceRoot = path.resolve(root, 'out-test')
  const isUnder = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`)
  if (protectedRoots.some((protectedRoot) => isUnder(protectedRoot, normalizedRoot)) && !isUnder(evidenceRoot, normalizedRoot)) {
    throw new Error(`拒绝把隔离运行目录设置在源码目录内: ${normalizedRoot}`)
  }
  if (fs.existsSync(normalizedRoot)) throw new Error(`隔离运行目录已存在，请使用新的目录: ${normalizedRoot}`)
  return normalizedRoot
}

function copyTree(source, destination) {
  requireDirectory(source, 'fixture root')
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    const stats = ordinaryStats(sourcePath, 'fixture entry')
    if (stats.isDirectory()) copyTree(sourcePath, destinationPath)
    else if (stats.isFile()) fs.copyFileSync(sourcePath, destinationPath)
    else throw new Error(`fixture 包含不支持的文件类型: ${sourcePath}`)
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function snapshotTree(directory) {
  requireDirectory(directory, 'business data root')
  const result = []
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name)
      const stats = ordinaryStats(target, 'business data entry')
      const relative = path.relative(directory, target).replaceAll(path.sep, '/')
      if (stats.isDirectory()) {
        result.push({ relative, type: 'directory' })
        visit(target)
      } else if (stats.isFile()) {
        result.push({ relative, type: 'file', size: stats.size, sha256: sha256(target) })
      } else {
        throw new Error(`business data 包含不支持的文件类型: ${target}`)
      }
    }
  }
  visit(directory)
  return result
}

function snapshotDigest(directory) {
  return sha256Buffer(Buffer.from(JSON.stringify(snapshotTree(directory)), 'utf8'))
}

function gitValue(directory, args) {
  try {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unavailable'
  }
}

function createMetadata(runId) {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const repositories = {}
  for (const [name, directory] of [
    ['workspace', workspace],
    ['electronClient', root],
    ['frontend', path.join(workspace, 'frontend')],
    ['plugins', path.join(workspace, 'plugins')],
    ['dllPlugins', path.join(workspace, 'DLLPlugins')],
    ['bin', path.join(workspace, 'bin')]
  ]) {
    repositories[name] = fs.existsSync(directory) ? gitValue(directory, ['rev-parse', 'HEAD']) : 'missing'
  }
  return {
    runId,
    sourceVersion: 'unknown',
    targetVersion: packageJson.version,
    platform: 'win32',
    arch: 'ia32',
    scope: 'user',
    locale,
    timezone,
    node: process.version,
    os: os.version(),
    repositories,
    gitDirty: gitValue(root, ['status', '--porcelain']) !== ''
  }
}

function redact(value, replacements) {
  let result = value
  for (const [source, replacement] of replacements) {
    if (source) result = result.replaceAll(source, replacement)
  }
  return result
}

function runProcess(executable, args, environment, label, logPath, replacements = []) {
  const result = spawnSync(executable, args, {
    cwd: path.dirname(executable),
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, redact(output, replacements), 'utf8')
  }
  if (result.error) throw new Error(`${label}启动失败: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}返回 ${result.status ?? 'unknown'}: ${output.trim()}`)
  return output
}

function waitForPathAbsent(target, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (fs.existsSync(target) && Date.now() < deadline) {
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitBuffer, 0, 0, 100)
  }
  return !fs.existsSync(target)
}

function readAppendedArchive(installer, outputPath) {
  const content = fs.readFileSync(installer)
  if (content.length < footerSize || content.toString('ascii', content.length - footerSize, content.length - footerSize + 8) !== 'ZTLSPK01') {
    throw new Error('安装包尾部格式无效')
  }
  const archiveSize = Number(content.readBigUInt64LE(content.length - footerSize + 12))
  if (!Number.isSafeInteger(archiveSize) || archiveSize <= 0 || archiveSize > content.length - footerSize) {
    throw new Error('安装包尾部归档长度无效')
  }
  const archiveStart = content.length - footerSize - archiveSize
  const archive = content.subarray(archiveStart, content.length - footerSize)
  const expected = content.subarray(content.length - footerSize + 20, content.length - footerSize + 52).toString('hex')
  if (sha256Buffer(archive) !== expected) throw new Error('安装包尾部归档哈希无效')
  fs.writeFileSync(outputPath, archive)
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function findFirstFile(directory, basename) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    const stats = ordinaryStats(target, 'artifact entry')
    if (stats.isDirectory()) {
      const nested = findFirstFile(target, basename)
      if (nested) return nested
    } else if (stats.isFile() && entry.name === basename) {
      return target
    }
  }
  return undefined
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function createPluginResults(pluginRoot) {
  const entries = fs.readdirSync(pluginRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
  return entries.map((entry) => {
    const target = path.join(pluginRoot, entry.name)
    const stats = ordinaryStats(target, 'fixture plugin')
    if (!stats.isDirectory()) throw new Error(`fixture 插件不是目录: ${target}`)
    return {
      pluginId: entry.name,
      fixtureSha256: snapshotDigest(target),
      status: 'blocked',
      routes: {
        oldInstaller: 'not-run',
        zipUpdater: 'not-run',
        legacyClient: 'not-run'
      }
    }
  })
}

function comparePluginSnapshots(pluginResults, dataPluginRoot, route) {
  for (const plugin of pluginResults) {
    const target = path.join(dataPluginRoot, plugin.pluginId)
    const current = fs.existsSync(target) ? snapshotDigest(target) : 'missing'
    plugin.routes[route] = current === plugin.fixtureSha256 ? 'passed' : 'failed'
    if (plugin.routes[route] === 'failed') {
      throw new Error(`插件 ${plugin.pluginId} 的数据摘要在 ${route} 路由后发生变化`)
    }
  }
}

function finalizePluginStatuses(pluginResults) {
  for (const plugin of pluginResults) {
    const states = Object.values(plugin.routes)
    plugin.status = states.includes('failed')
      ? 'failed'
      : states.includes('blocked')
        ? 'blocked'
        : states.includes('not-run')
          ? 'blocked'
          : 'passed'
  }
}

const options = parseArguments(process.argv.slice(2))
const reportPath = path.join(root, 'out-test', 'test-reports', 'legacy-upgrade-latest.json')
const reportRunId = `legacy-${Date.now()}-${process.pid}`
const report = {
  schemaVersion: 1,
  state: 'failed',
  metadata: createMetadata(reportRunId),
  route: {
    legacyClient: 'blocked',
    oldInstallerArguments: 'not-run',
    zipArguments: 'not-run',
    uninstallArguments: 'not-run'
  },
  checks: {},
  plugins: [],
  logs: {},
  inputs: {
    artifactSha256: null,
    fixtureSha256: null,
    legacyInstallSha256: null,
    expectedPlugins: options.expectedPlugins
  },
  artifact: '<artifact>',
  fixtureRoot: '<fixture-root>',
  runRoot: '<run-root>'
}

try {
  if (!Number.isInteger(options.expectedPlugins) || options.expectedPlugins <= 0) throw new Error('expected plugin count is invalid')
  requireFile(options.artifact, 'legacy-upgrade artifact')
  requireDirectory(options.fixtureRoot, 'legacy-upgrade fixture')
  const fixtureData = path.join(options.fixtureRoot, 'data')
  const fixtureInstall = path.join(options.fixtureRoot, 'legacy-install')
  requireDirectory(fixtureData, 'fixture data')
  requireDirectory(fixtureInstall, 'fixture legacy install')
  const pluginRoot = path.join(fixtureData, 'Plugins')
  requireDirectory(pluginRoot, 'fixture plugins')
  const pluginCount = fs.readdirSync(pluginRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  if (pluginCount !== options.expectedPlugins) throw new Error(`fixture plugin count ${pluginCount} != ${options.expectedPlugins}`)
  report.inputs.artifactSha256 = sha256(options.artifact)
  report.inputs.fixtureSha256 = snapshotDigest(options.fixtureRoot)

  const runRoot = assertRunRoot(options.runRoot || path.join(defaultOutputRoot, `run-${Date.now()}`))
  const appDataRoot = path.join(runRoot, 'appdata')
  const oldInstallRoot = path.join(runRoot, 'old-install')
  const targetRoot = path.join(runRoot, 'new-install')
  const zipTargetRoot = path.join(runRoot, 'zip-install')
  const uninstallTargetRoot = path.join(runRoot, 'uninstall-install')
  const dataRoot = path.join(appDataRoot, 'ZTools', 'Data')
  const evidenceRoot = path.join(runRoot, 'evidence')
  fs.mkdirSync(appDataRoot, { recursive: true })
  copyTree(fixtureData, dataRoot)
  copyTree(fixtureInstall, oldInstallRoot)
  report.inputs.legacyInstallSha256 = snapshotDigest(oldInstallRoot)
  report.plugins = createPluginResults(path.join(dataRoot, 'Plugins'))
  const beforeData = snapshotTree(dataRoot)
  report.checks.businessDataBeforeSha256 = sha256Buffer(Buffer.from(JSON.stringify(beforeData), 'utf8'))
  const environment = {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: path.join(runRoot, 'localappdata'),
    TEMP: path.join(runRoot, 'temp'),
    TMP: path.join(runRoot, 'temp'),
    ZTOOLS_DEPLOYMENT_ISOLATED: '1'
  }
  fs.mkdirSync(environment.TEMP, { recursive: true })
  const redactions = [
    [runRoot, '<run-root>'],
    [appDataRoot, '<data-root>'],
    [path.resolve(options.artifact), '<artifact>'],
    [path.resolve(options.fixtureRoot), '<fixture-root>']
  ]

  const oldInstallerLog = path.join(evidenceRoot, 'old-installer.log')
  report.logs.oldInstaller = '<run-root>/evidence/old-installer.log'
  runProcess(options.artifact, ['/S', `/D="${targetRoot}"`], environment, 'legacy installer argument route', oldInstallerLog, redactions)
  report.route.oldInstallerArguments = 'passed'
  report.checks.installedRoot = fs.existsSync(path.join(targetRoot, 'ZTools.exe'))
  if (!report.checks.installedRoot) throw new Error('old installer argument route did not create ZTools.exe')
  if (JSON.stringify(snapshotTree(dataRoot)) !== JSON.stringify(beforeData)) throw new Error('old installer route changed business data')
  report.checks.oldInstallerDataSha256 = snapshotDigest(dataRoot)
  comparePluginSnapshots(report.plugins, path.join(dataRoot, 'Plugins'), 'oldInstaller')

  const updater = findFirstFile(path.dirname(options.artifact), 'ZToolsUpdater.exe')
  if (!updater) throw new Error('ZToolsUpdater.exe is not available for the --zip route')
  const zipPath = path.join(runRoot, 'payload.zip')
  readAppendedArchive(options.artifact, zipPath)
  const zipUpdaterLog = path.join(evidenceRoot, 'zip-updater.log')
  report.logs.zipUpdater = '<run-root>/evidence/zip-updater.log'
  runProcess(updater, [`--zip=${zipPath}`, `--target=${zipTargetRoot}`, `--data-root=${dataRoot}`], environment, 'zip update route', zipUpdaterLog, redactions)
  report.route.zipArguments = 'passed'
  report.checks.zipInstalledRoot = fs.existsSync(path.join(zipTargetRoot, 'ZTools.exe'))
  if (!report.checks.zipInstalledRoot) throw new Error('zip route did not create ZTools.exe')
  if (JSON.stringify(snapshotTree(dataRoot)) !== JSON.stringify(beforeData)) throw new Error('zip route changed business data')
  report.checks.zipUpdaterDataSha256 = snapshotDigest(dataRoot)
  comparePluginSnapshots(report.plugins, path.join(dataRoot, 'Plugins'), 'zipUpdater')

  const uninstallInstallerLog = path.join(evidenceRoot, 'uninstall-installer.log')
  report.logs.uninstallInstaller = '<run-root>/evidence/uninstall-installer.log'
  runProcess(options.artifact, ['/S', `/D="${uninstallTargetRoot}"`], environment, 'uninstall fixture install', uninstallInstallerLog, redactions)
  const installedUninstaller = path.join(uninstallTargetRoot, 'ZToolsUninstall.exe')
  requireFile(installedUninstaller, 'installed uninstaller')
  const uninstaller = path.join(path.dirname(options.artifact), 'ZToolsUninstall.exe')
  requireFile(uninstaller, 'artifact uninstaller')
  if (sha256(installedUninstaller) !== sha256(uninstaller)) {
    throw new Error('installed uninstaller does not match the artifact uninstaller')
  }
  report.checks.uninstallerSha256Match = 'passed'
  const uninstallLog = path.join(evidenceRoot, 'uninstall.log')
  report.logs.uninstall = '<run-root>/evidence/uninstall.log'
  runProcess(uninstaller, ['/S', `/D="${uninstallTargetRoot}"`, '--preserve-data'], environment, 'uninstall route', uninstallLog, redactions)
  report.route.uninstallArguments = 'passed'
  report.checks.uninstallCompletion = waitForPathAbsent(uninstallTargetRoot) ? 'passed' : 'timeout'
  report.checks.uninstallRemovedRoot = !fs.existsSync(uninstallTargetRoot)
  if (report.checks.uninstallCompletion !== 'passed') throw new Error('uninstall route did not finish within the evidence timeout')
  if (!report.checks.uninstallRemovedRoot) throw new Error('uninstall route did not remove the install root')
  if (JSON.stringify(snapshotTree(dataRoot)) !== JSON.stringify(beforeData)) throw new Error('uninstall route changed business data')

  if (!options.legacyClient) {
    report.state = 'blocked'
    report.checks.realLegacyClient = 'missing'
    for (const plugin of report.plugins) plugin.routes.legacyClient = 'blocked'
    throw new Error('real legacy client is required; set --legacy-client or ZTOOLS_LEGACY_CLIENT')
  }
  requireFile(options.legacyClient, 'real legacy client')
  const legacyClientLog = path.join(evidenceRoot, 'legacy-client.log')
  report.logs.legacyClient = '<run-root>/evidence/legacy-client.log'
  runProcess(options.legacyClient, options.legacyArgs, environment, 'real legacy client', legacyClientLog, redactions)
  report.route.legacyClient = 'passed'
  if (!fs.existsSync(path.join(targetRoot, 'ZTools.exe'))) throw new Error('real legacy client route did not leave an installed client')
  if (JSON.stringify(snapshotTree(dataRoot)) !== JSON.stringify(beforeData)) throw new Error('real legacy client route changed business data')
  report.checks.legacyClientDataSha256 = snapshotDigest(dataRoot)
  comparePluginSnapshots(report.plugins, path.join(dataRoot, 'Plugins'), 'legacyClient')
  report.checks.realLegacyClient = 'passed'
  report.state = 'passed'
} catch (error) {
  report.error = redact(
    error instanceof Error ? error.message : String(error),
    [
      [options.artifact, '<artifact>'],
      [options.fixtureRoot, '<fixture-root>'],
      [options.runRoot, '<run-root>']
    ]
  )
  if (report.state !== 'blocked') report.state = report.route.legacyClient === 'blocked' && report.error.includes('real legacy client is required') ? 'blocked' : 'failed'
} finally {
  finalizePluginStatuses(report.plugins)
  report.checks.pluginResults = report.plugins.length
  writeReport(reportPath, report)
}

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.state === 'passed' ? 0 : 1
