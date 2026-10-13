import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createPackage } from '@electron/asar'
import { buildSandboxPreload } from './build-sandbox-preload.mjs'
import { compareOsVersions, inspectMacDeployment } from './macos-minimum-os.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function imageFixtureLaunch(platform, architecture, executable, args) {
  if (platform === 'win32' && architecture === 'x64') return { executable, args }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(architecture)) {
    return { executable: '/usr/bin/arch', args: [architecture === 'arm64' ? '-arm64' : '-x86_64', executable, ...args] }
  }
  throw new Error('IMAGE_PLATFORM_OR_ARCH_INVALID')
}
export async function runReferenceImageFunctions(expectedPlatform, argv = process.argv.slice(2)) {
let output, report
try {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, broker: { type: 'string' }, 'minimum-os': { type: 'string' }, 'expect-process-arch': { type: 'string' }, 'asar-workers': { type: 'boolean' } } })
  if (values.help) console.log('[可选 --asar-workers：真实ASAR worker运行验证] ' + (expectedPlatform === 'darwin' ? 'npm run test:mac:reference:images -- --broker <absolute Universal ZToolsPathAccessBroker> --minimum-os <approved version> --expect-process-arch arm64|x64' : 'npm run test:win:reference:images -- --broker <absolute ZToolsPathAccessBroker.exe from test:native:path-access>'))
  else {
    if (process.platform !== expectedPlatform) {
      console.log(JSON.stringify({ phase: 1, status: 'NOT_RUN', code: expectedPlatform === 'darwin' ? 'DARWIN_REQUIRED' : 'WINDOWS_X64_REQUIRED' })); process.exitCode = 1; return
    }
    if (expectedPlatform === 'darwin') {
      compareOsVersions(values['minimum-os'], values['minimum-os'])
      if (!['arm64', 'x64'].includes(values['expect-process-arch'])) throw new Error('MAC_ARCH_REQUIRED')
    } else if (process.arch !== 'x64' || values['minimum-os'] || values['expect-process-arch']) throw new Error('WINDOWS_X64_PARAMETERS_REQUIRED')
    const expectedArchitecture = expectedPlatform === 'darwin' ? values['expect-process-arch'] : 'x64'
    const scope = expectedPlatform === 'darwin' ? 'macos-isolated-electron-reference-image-functions' : 'windows-isolated-electron-reference-image-functions'
    if (!values.broker || !path.isAbsolute(values.broker) || !fs.lstatSync(values.broker).isFile() || fs.lstatSync(values.broker).isSymbolicLink()) throw new Error('NATIVE_BROKER_REQUIRED')
    if (expectedPlatform === 'darwin') {
      const inspected = spawnSync('/usr/bin/lipo', ['-archs', values.broker], { shell: false, encoding: 'utf8', timeout: 15000 })
      if (inspected.error || inspected.status !== 0 || JSON.stringify(inspected.stdout.trim().split(/\s+/).sort()) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('UNIVERSAL_BROKER_REQUIRED')
      for (const slice of ['arm64', 'x86_64']) if (compareOsVersions(inspectMacDeployment(values.broker, slice), values['minimum-os']) > 0) throw new Error('MINIMUM_OS_MISMATCH')
      if ((fs.statSync(values.broker).mode & 0o111) === 0) throw new Error('BROKER_EXECUTABLE_REQUIRED')
    }
    const runId = randomUUID(); output = path.join(root, 'out-test/reference-images', runId)
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output)
    const temporary = path.join(output, 'tmp'); fs.mkdirSync(temporary)
    report = { phase: 1, runId, status: 'FAIL', scope, output, expectedArchitecture, ...(expectedPlatform === 'darwin' ? { minimumOs: values['minimum-os'], brokerProcessArchitecture: 'unverified' } : {}) }
    const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }; delete env.ELECTRON_RUN_AS_NODE
    const fixtureEntry = path.join(root, 'tests/native/reference-images/main.cjs')
    const syntax = spawnSync(process.execPath, ['--check', fixtureEntry], { cwd: root, env, shell: false, windowsHide: true, timeout: 10000, encoding: 'utf8' })
    fs.writeFileSync(path.join(output, 'syntax.log'), `${syntax.stdout ?? ''}${syntax.stderr ?? ''}`, { flag: 'wx' })
    if (syntax.error || syntax.status !== 0) throw new Error('FIXTURE_SYNTAX_FAILED')
    const electronRoot = path.join(root, 'node_modules/electron'), executable = path.join(electronRoot, expectedPlatform === 'darwin' ? 'dist/Electron.app/Contents/MacOS/Electron' : 'dist/electron.exe')
    if (JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version !== '43.4.1') throw new Error('ELECTRON_VERSION_MISMATCH')
    const compiled = path.join(output, 'compiled')
    const build = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json', '--outDir', compiled],
      { cwd: root, env, shell: false, windowsHide: true, timeout: 120000, encoding: 'utf8' })
    fs.writeFileSync(path.join(output, 'compile.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`, { flag: 'wx' })
    if (build.error || build.status !== 0) throw new Error('COMPILATION_FAILED')
    report.preloadBundle = buildSandboxPreload({ outputFile: path.join(compiled, 'src/preload/main.js') })
    let runtimeRoot = compiled
    if (values['asar-workers']) {
      const modules = path.join(compiled, 'node_modules'); fs.mkdirSync(modules)
      for (const dependency of ['sql.js', 'gifenc', 'pngjs']) fs.cpSync(path.join(root, 'node_modules', dependency), path.join(modules, dependency), { recursive: true, errorOnExist: true, force: false })
      fs.writeFileSync(path.join(compiled, 'package.json'), JSON.stringify({ name: 'reference-worker-fixture', type: 'commonjs', private: true }), { flag: 'wx' })
      runtimeRoot = path.join(output, 'worker-runtime.asar')
      await createPackage(compiled, runtimeRoot)
      report.workerArchive = runtimeRoot
    }
    const launch = imageFixtureLaunch(expectedPlatform, expectedArchitecture, executable, [fixtureEntry, output, runtimeRoot, values.broker])
    const result = spawnSync(launch.executable, launch.args,
      { cwd: root, env, shell: false, windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    fs.writeFileSync(path.join(output, 'functions.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
    report.fixtureProcess = { pid: result.pid, exitCode: result.status, signal: result.signal, ...(result.error ? { errorCode: result.error.code } : {}) }
    if (result.error || result.status !== 0) throw new Error('IMAGE_FUNCTION_TEST_FAILED')
    const observed = JSON.parse(fs.readFileSync(path.join(output, 'observed.json'), 'utf8'))
    if (observed.status !== 'PASS' || observed.checks !== 83 || observed.electronVersion !== '43.4.1' || observed.processArch !== expectedArchitecture || observed.scope !== scope ||
        observed.realRegionSelectorRenderer !== true || observed.regionWindowPolicy !== 'injected-hidden-windows' || observed.realElectronCodec !== true || observed.realElectronCanvas !== true || observed.realElectronPdf !== true || observed.realZipProvider !== true || observed.realSQLiteSnapshotProvider !== true || observed.realGifEncoder !== true || observed.realOsHardwareSummary !== true || observed.realOsSystemSampling !== true || observed.realOsPortList !== true || observed.realOsProcessList !== true || observed.realNativeGrantIo !== true || observed.productionZToolsAcceptance !== false || observed.asarWorkerRuntime !== Boolean(values['asar-workers'])) throw new Error('IMAGE_RESULT_INVALID')
    report.status = 'PASS'; report.observed = observed
  }
} catch (error) { if (report) report.code = /^[A-Z_]+$/.test(error.message) ? error.message : 'IMAGE_FUNCTION_TEST_FAILED'; console.error('REFERENCE_IMAGE_FUNCTION_TEST_FAILED'); process.exitCode = 1 }
finally { if (output && report) { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report)) } }
}
