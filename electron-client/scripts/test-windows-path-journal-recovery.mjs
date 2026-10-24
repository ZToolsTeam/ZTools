import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runnerScript = fileURLToPath(import.meta.url)
let output, report
try {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, broker: { type: 'string' } } })
  if (values.help) {
    console.log('npm run test:win:path-journal:recovery -- --broker <absolute x64 broker from out-test/path-access>')
    console.log('Two isolated Electron processes; real Windows safeStorage + native broker; preserves all synthetic records and scratch objects.')
  } else if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ status: 'NOT_RUN', scope: 'windows-isolated-electron-anchored-write-journal-restart', platform: process.platform, arch: process.arch,
      reason: 'WINDOWS_X64_REQUIRED', macAcceptance: 'NOT_RUN' })); process.exitCode = 1
  } else {
    if (!values.broker || !path.isAbsolute(values.broker)) throw new Error('BROKER_ABSOLUTE_PATH_REQUIRED')
    const broker = path.resolve(values.broker), brokerStat = fs.lstatSync(broker)
    if (!brokerStat.isFile() || brokerStat.isSymbolicLink()) throw new Error('BROKER_INVALID')
    const allowedBrokerRoot = fs.realpathSync(path.join(root, 'out-test', 'path-access'))
    const realBrokerPath = fs.realpathSync(broker)
    const brokerRelativePath = path.relative(allowedBrokerRoot, realBrokerPath)
    if (path.basename(realBrokerPath).toLowerCase() !== 'ztoolspathaccessbroker.exe' || brokerRelativePath === '..' ||
        brokerRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(brokerRelativePath)) throw new Error('BROKER_OUTSIDE_TEST_OUTPUT')
    assertPeMachine(broker, PE_MACHINE_X64)

    const runId = randomUUID()
    output = path.join(root, 'out-test', 'path-journal-recovery', runId)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.mkdirSync(output, { recursive: false })
    const temporary = path.join(output, 'tmp'), compiled = path.join(output, 'compiled')
    fs.mkdirSync(temporary)
    report = { schemaVersion: 1, phase: 1, runId, platform: process.platform, arch: process.arch,
      scope: 'windows-isolated-electron-anchored-write-journal-restart', status: 'FAIL', output,
      electronUserDataIsolated: true, productionZToolsAcceptance: false, macAcceptance: 'NOT_RUN',
      policy: { automaticReplay: false, automaticScratchDeletion: false, businessSuccessPromotion: false } }

    const electronRoot = path.join(root, 'node_modules', 'electron')
    const executable = path.join(electronRoot, 'dist', 'electron.exe')
    if (JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version !== '43.4.1') throw new Error('ELECTRON_VERSION_MISMATCH')
    if (!fs.lstatSync(executable).isFile() || fs.lstatSync(executable).isSymbolicLink()) throw new Error('ELECTRON_EXECUTABLE_INVALID')
    assertPeMachine(executable, PE_MACHINE_X64)

    const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    const sourceFiles = [
      'src/contracts/capabilities.ts', 'src/contracts/errors.ts', 'src/main/platform/path-access.ts',
      'src/main/platform/native-path-access.ts', 'src/main/platform/path-write-journal-crypto.ts',
      'src/main/platform/path-write-journal.ts', 'src/main/platform/path-write-journal-store.ts',
      'src/main/services/path-write-recovery-service.ts'
    ]
    const fixtureTsconfig = path.join(output, 'tsconfig.fixture.json')
    fs.writeFileSync(fixtureTsconfig, `${JSON.stringify({ extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { rootDir: root, outDir: compiled, noUnusedLocals: false, noUnusedParameters: false },
      include: sourceFiles.map(file => path.join(root, file)), exclude: [] }, null, 2)}\n`, { flag: 'wx' })
    const compilation = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', fixtureTsconfig],
      { cwd: root, env, shell: false, windowsHide: true, timeout: 120_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    fs.writeFileSync(path.join(output, 'compile.log'), `${compilation.stdout ?? ''}${compilation.stderr ?? ''}`, { flag: 'wx' })
    if (compilation.error || compilation.status !== 0) throw new Error('COMPILATION_FAILED')

    const fixture = path.join(root, 'tests', 'native', 'path-journal-recovery', 'main.cjs')
    const runFixture = mode => {
      const result = spawnSync(executable, [fixture, mode, output, broker, compiled],
        { cwd: root, env, shell: false, windowsHide: true, timeout: 120_000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
      fs.writeFileSync(path.join(output, `${mode}.stdout.log`), result.stdout ?? '', { flag: 'wx' })
      fs.writeFileSync(path.join(output, `${mode}.stderr.log`), result.stderr ?? '', { flag: 'wx' })
      if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error(`${mode.toUpperCase()}_FIXTURE_FAILED`)
      let observed
      try { observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) } catch { throw new Error(`${mode.toUpperCase()}_FIXTURE_RESULT_INVALID`) }
      if (observed.status !== 'PASS' || observed.mode !== mode || observed.productionZToolsAcceptance !== false || observed.realAsyncOsSealing !== true ||
          observed.realNativeBroker !== true || observed.cleanupConfirmed !== true || !Number.isSafeInteger(observed.pid)) throw new Error(`${mode.toUpperCase()}_FIXTURE_RESULT_INVALID`)
      return observed
    }

    report.inputs = [
      { file: path.relative(root, executable), sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex') },
      { file: path.relative(root, broker), sha256: createHash('sha256').update(fs.readFileSync(broker)).digest('hex') },
      { file: path.relative(root, runnerScript), sha256: createHash('sha256').update(fs.readFileSync(runnerScript)).digest('hex') },
      { file: path.relative(root, fixture), sha256: createHash('sha256').update(fs.readFileSync(fixture)).digest('hex') },
      { file: path.relative(root, fixtureTsconfig), sha256: createHash('sha256').update(fs.readFileSync(fixtureTsconfig)).digest('hex') },
      ...sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }))
    ]
    const written = runFixture('write')
    const recovered = runFixture('recover')
    if (written.pid === recovered.pid || written.runId !== runId || recovered.runId !== runId || written.recordCount !== 4 || recovered.recordCount !== 4 ||
        written.rawPathInSealedStore !== false || recovered.rawPathInSealedStore !== false || recovered.businessStates?.length !== 4 ||
        recovered.businessStates.some(item => item.businessResult !== 'unconfirmed') || recovered.journalUnchanged !== true ||
        recovered.noAutomaticReplay !== true || recovered.noScratchMutation !== true) throw new Error('RECOVERY_RESULT_MISMATCH')
    report.status = 'PASS'
    report.electron = { version: '43.4.1', processArch: 'x64', separateProcessIds: [written.pid, recovered.pid] }
    report.writePhase = written
    report.recoveryPhase = recovered
    report.broker = { file: path.relative(root, realBrokerPath), sha256: report.inputs[1].sha256, nativeArch: 'x64', trustedRoot: 'out-test/path-access' }
  }
} catch (error) {
  const detail = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message) ? error.message :
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'PATH_JOURNAL_RECOVERY_UNCLASSIFIED_FAILURE'
  if (report) report.failureCode = detail
  console.error(detail)
  process.exitCode = 1
} finally {
  if (output && report) {
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify(report))
  }
}
