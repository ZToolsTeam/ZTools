import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let output, report
try {
  const { values } = parseArgs({ options: { help: { type: 'boolean' } } })
  if (values.help) console.log('npm run test:win:path-journal:sealing — isolated Windows Electron 43.4.1 asynchronous OS-key sealing; no production app or user data')
  else {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED')
    const runId = randomUUID(); output = path.join(root, 'out-test', 'path-journal-sealing', runId)
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output)
    const temporary = path.join(output, 'tmp'); fs.mkdirSync(temporary)
    report = { phase: 1, runId, platform: process.platform, status: 'FAIL', scope: 'windows-isolated-electron-async-key-sealing', output }
    const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    const electronRoot = path.join(root, 'node_modules', 'electron'), executable = path.join(electronRoot, 'dist', 'electron.exe')
    if (JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version !== '43.4.1') throw new Error('ELECTRON_VERSION_MISMATCH')
    if (!fs.lstatSync(executable).isFile() || fs.lstatSync(executable).isSymbolicLink()) throw new Error('ELECTRON_EXECUTABLE_INVALID')
    assertPeMachine(executable, PE_MACHINE_X64)
    const compiled = path.join(output, 'compiled')
    const compilation = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.test.json', '--outDir', compiled],
      { cwd: root, env, shell: false, windowsHide: true, timeout: 120_000, encoding: 'utf8' })
    fs.writeFileSync(path.join(output, 'compile.log'), `${compilation.stdout ?? ''}${compilation.stderr ?? ''}`, { flag: 'wx' })
    if (compilation.error || compilation.status !== 0) throw new Error('COMPILATION_FAILED')
    const module = path.join(compiled, 'src', 'main', 'platform', 'path-write-journal-crypto.js')
    const fixture = path.join(root, 'tests', 'native', 'path-journal-sealing', 'main.cjs')
    const result = spawnSync(executable, [fixture, output, module], { cwd: root, env, shell: false, windowsHide: true,
      timeout: 60_000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    fs.writeFileSync(path.join(output, 'native.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
    if (result.error || result.status !== 0) throw new Error('NATIVE_SEALING_FAILED')
    const observed = JSON.parse(result.stdout.trim())
    if (observed.status !== 'PASS' || observed.tests !== 10 || observed.electronVersion !== '43.4.1' || observed.processArch !== 'x64' ||
        observed.scope !== report.scope || observed.realOsKeySealing !== true || observed.productionZToolsAcceptance !== false) throw new Error('INVALID_NATIVE_RESULT')
    report.status = 'PASS'; report.observed = observed
    report.inputs = [executable, fixture, module].map(file => ({ file: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }))
  }
} catch { console.error('PATH_JOURNAL_SEALING_TEST_FAILED'); process.exitCode = 1 }
finally { if (output && report) { fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); console.log(JSON.stringify(report)) } }
