import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let output, report
try {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, broker: { type: 'string' } } })
  if (values.help) console.log('node scripts/test-file-resource-dispatch.mjs --broker <absolute Windows x64 broker> — isolated Electron CDP/WebRequest; no production App acceptance')
  else if (process.platform !== 'win32' || process.arch !== 'x64') { console.log(JSON.stringify({ status: 'NOT_RUN', code: 'WINDOWS_X64_REQUIRED' })); process.exitCode = 1 }
  else {
    if (!values.broker || !path.isAbsolute(values.broker) || !fs.lstatSync(values.broker).isFile() || fs.lstatSync(values.broker).isSymbolicLink()) throw Error('BROKER_REQUIRED')
    assertPeMachine(values.broker, PE_MACHINE_X64)
    const runId = randomUUID(); output = path.join(root, 'out-test/file-resource-dispatch', runId)
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output); const temporary = path.join(output, 'tmp'); fs.mkdirSync(temporary)
    report = { status: 'FAIL', runId, output, scope: 'isolated-electron-cdp-resource-dispatch', productionZToolsAcceptance: false }
    const compiled = path.join(output, 'compiled'), env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }; delete env.ELECTRON_RUN_AS_NODE
    const compilation = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json', '--outDir', compiled],
      { cwd: root, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000 })
    fs.writeFileSync(path.join(output, 'compile.log'), `${compilation.stdout ?? ''}${compilation.stderr ?? ''}`, { flag: 'wx' })
    if (compilation.error || compilation.status !== 0) throw Error('COMPILATION_FAILED')
    const electronRoot = path.join(root, 'node_modules/electron')
    if (JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version !== '43.4.1') throw Error('ELECTRON_VERSION_MISMATCH')
    const result = spawnSync(path.join(electronRoot, 'dist/electron.exe'), [path.join(root, 'tests/native/file-resource-dispatch/main.cjs'), output, compiled, values.broker],
      { cwd: root, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 })
    fs.writeFileSync(path.join(output, 'native.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
    report.process = { pid: result.pid, exitCode: result.status, signal: result.signal }
    if (result.error || result.status !== 0) throw Error('RESOURCE_CDP_FAILED')
    const observed = JSON.parse(fs.readFileSync(path.join(output, 'observed.json'), 'utf8'))
    if (observed.status !== 'PASS' || observed.observations.length !== 9 || observed.electronVersion !== '43.4.1' || observed.productionZToolsAcceptance !== false) throw Error('INVALID_RESULT')
    report.status = 'PASS'; report.observed = observed
  }
} catch (error) { if (report) report.code = /^[A-Z_]+$/.test(error.message) ? error.message : 'RESOURCE_CDP_FAILED'; console.error('FILE_RESOURCE_DISPATCH_FAILED'); process.exitCode = 1 }
finally { if (report) { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report)) } }
