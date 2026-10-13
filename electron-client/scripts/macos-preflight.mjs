import { extractFile } from '@electron/asar'
import { validateMacBundleVersions } from './macos-bundle-version.mjs'
import { compareOsVersions } from './macos-minimum-os.mjs'
export { compareOsVersions } from './macos-minimum-os.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

export function parseMacTestArguments(argv) {
  const seen = new Set()
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue
    const name = argument.split('=')[0]
    if (seen.has(name)) throw new Error('参数不可重复')
    seen.add(name)
  }
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, app: { type: 'string' }, output: { type: 'string' },
    'bundle-id': { type: 'string' }, 'minimum-os': { type: 'string' },
    'expect-process-arch': { type: 'string' }, fixtures: { type: 'string' }
  } })
  if (values.help) return values
  for (const key of ['app', 'output']) {
    if (!values[key] || !path.isAbsolute(values[key])) throw new Error(`${key} 必须为绝对路径`)
  }
  if (!values.app.endsWith('.app')) throw new Error('app 必须为 .app bundle')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(values['bundle-id'] ?? '')) {
    throw new Error('必须显式提供合法 --bundle-id')
  }
  if (!/^(?:[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/.test(values['minimum-os'] ?? '')) {
    throw new Error('必须显式提供 --minimum-os major.minor[.patch]')
  }
  if (!['x64', 'arm64'].includes(values['expect-process-arch'])) throw new Error('必须指定实际待验进程架构 x64/arm64')
  if (values.fixtures && !path.isAbsolute(values.fixtures)) throw new Error('fixtures 必须为绝对路径')
  const relative = path.relative(values.app, values.output)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('报告目录不能在App内')
  }
  return values
}

export function inspectMacApp(options, { platform = process.platform, fsApi = fs, exec = execFileSync, readAppPackage = appRoot => JSON.parse(extractFile(path.join(appRoot, 'Contents', 'Resources', 'app.asar'), 'package.json').toString('utf8')) } = {}) {
  // Refuse before touching any app, fixture or macOS tool on the wrong host.
  if (platform !== 'darwin') return { status: 'NOT_RUN', code: 'DARWIN_REQUIRED' }
  const run = (tool, argv) => exec(tool, argv, {
    encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 1024 * 1024
  })
  try {
    const appRoot = fsApi.realpathSync(options.app)
    if (!fsApi.statSync(appRoot).isDirectory()) return { status: 'NOT_RUN', code: 'APP_MISSING' }
    const readPlist = target => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', target]))
    const info = readPlist(path.join(appRoot, 'Contents', 'Info.plist'))
    if (info.CFBundleIdentifier !== options['bundle-id']) return { status: 'FAIL', code: 'BUNDLE_ID_MISMATCH' }
    if (typeof info.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9_. -]+$/.test(info.CFBundleExecutable) || ['.', '..'].includes(info.CFBundleExecutable)) {
      return { status: 'FAIL', code: 'INVALID_EXECUTABLE' }
    }
    const executable = path.join(appRoot, 'Contents', 'MacOS', info.CFBundleExecutable)
    const executableReal = fsApi.realpathSync(executable)
    const relative = path.relative(appRoot, executableReal)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fsApi.statSync(executableReal).isFile()) {
      return { status: 'FAIL', code: 'EXECUTABLE_OUTSIDE_BUNDLE' }
    }
    fsApi.accessSync(executableReal, fs.constants.X_OK)
    const systemVersion = run('/usr/bin/sw_vers', ['-productVersion']).trim()
    let minimumComparison, hostComparison
    try {
      minimumComparison = compareOsVersions(info.LSMinimumSystemVersion, options['minimum-os'])
      hostComparison = compareOsVersions(systemVersion, options['minimum-os'])
    } catch { return { status: 'FAIL', code: 'INVALID_OS_METADATA' } }
    if (minimumComparison !== 0) {
      return { status: 'FAIL', code: 'MINIMUM_OS_POLICY_MISMATCH' }
    }
    if (hostComparison < 0) return { status: 'NOT_RUN', code: 'OS_BELOW_MINIMUM' }
    const arches = run('/usr/bin/lipo', ['-archs', executableReal]).trim()
    if (!/^(?:arm64|x86_64)(?:[ \t]+(?:arm64|x86_64))*$/.test(arches)) return { status: 'FAIL', code: 'INVALID_MACHO_ARCHITECTURES' }
    const slices = new Set(arches.split(/[ \t]+/))
    if (!slices.has('arm64') || !slices.has('x86_64')) return { status: 'FAIL', code: 'UNIVERSAL_REQUIRED' }
    const marker = JSON.parse(fsApi.readFileSync(path.join(appRoot, 'Contents', 'Resources', 'ztools-runtime-target.json'), 'utf8'))
    if (marker.manifestVersion !== 1 || marker.target?.platform !== 'macos' || marker.target?.runtime !== 'electron' || marker.target?.arch !== 'universal') {
      return { status: 'FAIL', code: 'RUNTIME_TARGET_MISMATCH' }
    }
    try { validateMacBundleVersions(info.CFBundleShortVersionString, info.CFBundleVersion) }
    catch { return { status: 'FAIL', code: 'INVALID_BUNDLE_VERSION' } }
    const versions = JSON.parse(fsApi.readFileSync(path.join(appRoot, 'Contents', 'Resources', 'ztools-bundle-versions.json'), 'utf8'))
    const appPackage = readAppPackage(appRoot)
    if (versions.schemaVersion !== 1 || typeof appPackage.version !== 'string' || !/^[0-9A-Za-z.-]{1,128}$/.test(appPackage.version) ||
        versions.appVersion !== appPackage.version || versions.shortVersion !== info.CFBundleShortVersionString ||
        versions.buildVersion !== info.CFBundleVersion) return { status: 'FAIL', code: 'APP_VERSION_METADATA_MISMATCH' }
    const addon = path.join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'classic-level', 'prebuilds', 'darwin-x64+arm64', 'classic-level.node')
    const addonReal = fsApi.realpathSync(addon)
    const addonRelative = path.relative(appRoot, addonReal)
    if (addonRelative === '..' || addonRelative.startsWith(`..${path.sep}`) || path.isAbsolute(addonRelative)) {
      return { status: 'FAIL', code: 'LEVELDB_ADDON_OUTSIDE_BUNDLE' }
    }
    if (!fsApi.statSync(addonReal).isFile()) return { status: 'NOT_RUN', code: 'LEVELDB_ADDON_MISSING' }
    if (options.fixtures && !fsApi.statSync(options.fixtures).isDirectory()) return { status: 'NOT_RUN', code: 'FIXTURES_MISSING' }
    return {
      status: 'PASS', scope: 'phase2-readonly-preflight', appRoot, executable: executableReal,
      bundleId: info.CFBundleIdentifier, appVersion: appPackage.version,
      bundleShortVersion: info.CFBundleShortVersionString, bundleBuildVersion: info.CFBundleVersion,
      minimumOs: info.LSMinimumSystemVersion, osVersion: systemVersion, slices: [...slices],
      expectedProcessArch: options['expect-process-arch'],
      executableSha256: createHash('sha256').update(fsApi.readFileSync(executableReal)).digest('hex'),
      // This is Node's arch, never evidence of the tested Electron process slice.
      runnerArch: process.arch, processArch: null, electronVersion: null
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'FAIL', code: 'INVALID_BUNDLE_METADATA' }
    return { status: 'NOT_RUN', code: 'PREFLIGHT_INPUT_OR_TOOL_UNAVAILABLE' }
  }
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  const stderr = dependencies.stderr ?? console.error, stdout = dependencies.stdout ?? console.log
  let options
  try { options = parseMacTestArguments(argv) } catch (error) { stderr(error.message); return 1 }
  if (options.help) {
    stdout('npm run test:mac:preflight -- --app <absolute.app> --bundle-id <approved ID> --minimum-os <approved major.minor> --expect-process-arch <x64|arm64> --output <absolute directory> [--fixtures <absolute directory>]')
    return 0
  }
  const startedAt = new Date().toISOString()
  const result = inspectMacApp(options, dependencies)
  const report = { schemaVersion: 1, runId: randomUUID(), phase: 2, caseId: 'M01-preflight',
    scope: 'readonly-preflight', host: { platform: dependencies.platform ?? process.platform, kernel: os.release(), node: process.version, arch: process.arch },
    startedAt, finishedAt: new Date().toISOString(), cleanup: 'NO_PROCESS_CREATED', result }
  try {
    fs.mkdirSync(options.output, { recursive: true })
    const reportPath = path.join(options.output, `${report.runId}.json`)
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    stdout(JSON.stringify({ status: result.status, code: result.code ?? null, reportPath }))
    return result.status === 'PASS' ? 0 : 1
  } catch { stderr('报告写入失败'); return 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
