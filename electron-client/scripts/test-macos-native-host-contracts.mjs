import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compareOsVersions } from './macos-minimum-os.mjs'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import {
  runMacNativeWorkerFixtureCases,
  runMacNativeWorkerFixtureCleanupTests,
} from './lib/macos-native-worker-fixture.mjs'
import { runMacNativeLoadGateSourceContracts } from './lib/macos-native-load-gate-contract.mjs'
import { runMacNativeWorkerKeySourceContracts } from './lib/macos-native-worker-key-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeSource = path.join(root, 'native', 'ZToolsMacNative')
let reportPath
let report

function writeReport() {
  if (!reportPath || !report || fs.existsSync(reportPath)) return
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}

try {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      cmake: { type: 'string' },
      'expect-native-arch': { type: 'string' },
      'minimum-os': { type: 'string' },
      'expect-process-arch': { type: 'string' },
    },
  })
  if (values.help) {
    console.log('node scripts/test-macos-native-host-contracts.mjs --cmake <absolute CMake path> [Windows: --expect-native-arch x64] [Darwin: --minimum-os <approved version> --expect-process-arch arm64|x64]')
  } else {
    if (!['win32', 'darwin'].includes(process.platform)) throw new Error('PLATFORM_UNSUPPORTED')
    if (!values.cmake || !path.isAbsolute(values.cmake)) throw new Error('CMAKE_REQUIRED')
    const cmakeStat = fs.lstatSync(values.cmake)
    if (!cmakeStat.isFile() || cmakeStat.isSymbolicLink()) throw new Error('CMAKE_REQUIRED')

    let nativeArch = 'x64'
    let processArch = process.arch
    if (process.platform === 'win32') {
      if (values['minimum-os'] || values['expect-process-arch']) throw new Error('MAC_PARAMETERS_ON_WINDOWS')
      nativeArch = values['expect-native-arch'] ?? 'x64'
      if (nativeArch !== 'x64') throw new Error('WINDOWS_SYNTHETIC_ARCH_MUST_BE_X64')
    } else {
      if (values['expect-native-arch']) throw new Error('WINDOWS_PARAMETERS_ON_MAC')
      compareOsVersions(values['minimum-os'], values['minimum-os'])
      if (!['arm64', 'x64'].includes(values['expect-process-arch'])) throw new Error('MAC_ARCH_REQUIRED')
      processArch = values['expect-process-arch']
      nativeArch = 'universal'
    }

    const runId = randomUUID()
    const output = path.join(root, 'out-test', 'macos-native-host', runId)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.mkdirSync(output)
    const temporary = path.join(output, 'temporary')
    fs.mkdirSync(temporary)
    const bin = path.join(output, 'build', 'bin')
    const executable = path.join(bin, `ZToolsMacNativeAbiTest${process.platform === 'win32' ? '.exe' : ''}`)
    const protocolExecutable = path.join(bin, `ZToolsMacNativeWorkerSessionTest${process.platform === 'win32' ? '.exe' : ''}`)
    const workerKeyExecutable = path.join(bin, `ZToolsMacNativeWorkerKeyTest${process.platform === 'win32' ? '.exe' : ''}`)
    const workerExecutable = path.join(bin, `ZToolsMacNativeTestWorker${process.platform === 'win32' ? '.exe' : ''}`)
    const trustGateExecutable = path.join(bin, 'ZToolsMacNativeTrustGateTest')
    const libraryPrefix = process.platform === 'win32' ? '' : 'lib'
    const librarySuffix = process.platform === 'win32' ? '.dll' : '.dylib'
    const supportedFixture = path.join(bin, `${libraryPrefix}ZToolsMacNativeAbiFixture${librarySuffix}`)
    const unsupportedFixture = path.join(bin, `${libraryPrefix}ZToolsMacNativeUnsupportedAbiFixture${librarySuffix}`)
    reportPath = path.join(output, 'report.json')
    report = {
      schemaVersion: 1,
      phase: 1,
      runId,
      platform: process.platform,
      arch: process.arch,
      nativeArch,
      processArch,
      osRelease: os.release(),
      scope: 'mac-native-abi-and-worker-session-contracts',
      status: 'FAIL',
      output,
      macSignatureValidation: 'NOT_RUN',
      sameObjectLoadProof: 'PRODUCTION_LOAD_BLOCKED_UNPROVEN_BY_DESIGN',
      dependencyClosure: 'DECLARED_SYSTEM_ONLY_CLOSURE_GATE_NOT_EXERCISED',
      darwinTrustGate: 'NOT_RUN',
      pending: [
        ...(process.platform === 'win32' ? ['Darwin Security.framework trust-gate runtime (NOT_RUN on Windows)'] : []),
        'normal packaged macOS App/CDP component install-call and actual owner-release verification (not represented by Windows portable fixtures)',
        'verify a real signed candidate against explicit approved identity inputs',
        'verify host identity, hardened-runtime/library-validation state, and main-only policy binding',
        'validate component minimum OS and complete system-only dependency closure',
        'prove same-object identity before dyld can run component initializers; production load remains blocked until then',
        'real signed macOS component load/call',
      ],
    }
    report.workerKeyHostSourceContract = runMacNativeWorkerKeySourceContracts(root)
    report.productionLoadGateSourceContract = runMacNativeLoadGateSourceContracts(root)
    let stage = 0
    const run = (exe, args, failureCode) => {
      const result = spawnSync(exe, args, {
        cwd: root,
        env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      fs.writeFileSync(path.join(output, `${++stage}-stage.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
      if (result.error || result.status !== 0) throw new Error(failureCode)
      return result.stdout ?? ''
    }

    const configureArgs = ['-S', nativeSource, '-B', path.join(output, 'build')]
    if (process.platform === 'win32') configureArgs.push('-G', 'Visual Studio 17 2022', '-A', 'x64')
    else configureArgs.push('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64', `-DCMAKE_OSX_DEPLOYMENT_TARGET=${values['minimum-os']}`)
    run(values.cmake, configureArgs, 'CMAKE_CONFIGURE_FAILED')
    run(values.cmake, ['--build', path.join(output, 'build'), '--config', 'Release'], 'CMAKE_BUILD_FAILED')

    if (process.platform === 'win32') {
      for (const file of [executable, protocolExecutable, workerKeyExecutable, workerExecutable, supportedFixture, unsupportedFixture]) assertPeMachine(file, PE_MACHINE_X64)
    }
    const testOutput = process.platform === 'darwin'
      ? run('/usr/bin/arch', [processArch === 'x64' ? '-x86_64' : '-arm64', executable, supportedFixture, unsupportedFixture], 'ABI_TEST_FAILED')
      : run(executable, [supportedFixture, unsupportedFixture], 'ABI_TEST_FAILED')
    const result = JSON.parse(testOutput.trim().split(/\r?\n/).at(-1))
    if (result.status !== 'PASS' || result.scope !== 'portable-mac-native-abi-synthetic-fixture' ||
        !Number.isInteger(result.checks) || result.checks < 30) {
      throw new Error('INVALID_ABI_TEST_RESULT')
    }
    const protocolOutput = process.platform === 'darwin'
      ? run('/usr/bin/arch', [processArch === 'x64' ? '-x86_64' : '-arm64', protocolExecutable], 'WORKER_SESSION_TEST_FAILED')
      : run(protocolExecutable, [], 'WORKER_SESSION_TEST_FAILED')
    const protocol = JSON.parse(protocolOutput.trim().split(/\r?\n/).at(-1))
    if (protocol.status !== 'PASS' || protocol.scope !== 'mac-native-worker-wire-and-session-state' ||
        !Number.isInteger(protocol.checks) || protocol.checks < 60) {
      throw new Error('INVALID_WORKER_SESSION_RESULT')
    }
    report.abi = result
    report.workerProtocol = protocol
    const workerKeyOutput = process.platform === 'darwin'
      ? run('/usr/bin/arch', [processArch === 'x64' ? '-x86_64' : '-arm64', workerKeyExecutable], 'WORKER_KEY_TEST_FAILED')
      : run(workerKeyExecutable, [], 'WORKER_KEY_TEST_FAILED')
    const workerKey = JSON.parse(workerKeyOutput.trim().split(/\r?\n/).at(-1))
    if (workerKey.status !== 'PASS' || workerKey.scope !== 'mac-native-worker-key-plugin-owner-instance' ||
        !Number.isInteger(workerKey.checks) || workerKey.checks < 8) {
      throw new Error('INVALID_WORKER_KEY_RESULT')
    }
    report.workerKeyIsolation = {
      status: 'PASS',
      scope: workerKey.scope,
      checks: workerKey.checks,
      hostSourceContract: report.workerKeyHostSourceContract.status,
    }
    report.componentLoading = process.platform === 'win32'
      ? 'SYNTHETIC_WINDOWS_DLL_DYNAMIC_LOAD'
      : 'PORTABLE_FIXTURE_DYLIB_DYNAMIC_LOAD_NOT_PRODUCTION'
    if (process.platform === 'win32') {
      const workerCleanup = await runMacNativeWorkerFixtureCleanupTests({ workerExecutable, supportedFixture, unsupportedFixture })
      report.workerCleanupFailureCases = workerCleanup
      const workerProcess = await runMacNativeWorkerFixtureCases({ workerExecutable, supportedFixture, unsupportedFixture })
      report.workerProcessIsolation = workerProcess
    } else {
      report.workerProcessIsolation = { status: 'NOT_RUN', reason: 'PRODUCTION_COMPONENT_LOAD_IS_BLOCKED_UNTIL_PRE_INITIALIZER_SAME_OBJECT_PROOF' }
      const trustOutput = run('/usr/bin/arch', [processArch === 'x64' ? '-x86_64' : '-arm64', trustGateExecutable],
        'DARWIN_TRUST_GATE_TEST_FAILED')
      const trustGate = JSON.parse(trustOutput.trim().split(/\r?\n/).at(-1))
      if (trustGate.status !== 'PASS' || trustGate.scope !== 'darwin-trust-gate-fail-closed-contract' ||
          !Number.isInteger(trustGate.checks) || trustGate.checks < 7 ||
          trustGate.validSignedComponent !== 'NOT_RUN' ||
          trustGate.componentLoad !== 'BLOCKED_SAME_OBJECT_LOAD_UNPROVEN') {
        throw new Error('INVALID_DARWIN_TRUST_GATE_RESULT')
      }
      report.darwinTrustGate = trustGate
    }
    report.macHostAcceptance = false
    report.status = 'PASS'
    writeReport()
    console.log(JSON.stringify(report))
  }
} catch (error) {
  const detail = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message) ? error.message :
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'MAC_NATIVE_ABI_UNCLASSIFIED_FAILURE'
  if (report) {
    report.status = 'FAIL'
    report.failureCode = error?.cleanupFailureCode ?? detail
    if (Array.isArray(error?.workerCleanup)) report.workerCleanup = error.workerCleanup
  }
  writeReport()
  console.error(detail)
  console.error('MAC_NATIVE_ABI_CONTRACTS_FAILED')
  process.exitCode = 1
}
