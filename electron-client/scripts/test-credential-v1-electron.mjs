import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronVersion = JSON.parse(await fs.readFile(path.join(repoRoot, 'node_modules/electron/package.json'), 'utf8')).version
const electronBinary = path.join(repoRoot, 'node_modules/electron/dist/electron.exe')
const runId = randomUUID()
const outputRoot = path.join(repoRoot, 'out-test', 'credential-v1-electron')
const runRoot = path.join(outputRoot, runId)
const appRoot = path.join(runRoot, 'harness-app')
const userDataRoot = path.join(runRoot, 'isolated-user-data')
const reportPath = path.join(runRoot, 'report.json')
const secretMarker = `ZTOOLS_CREDENTIAL_V1_SECRET_${runId}`

if (process.platform !== 'win32') {
  throw new Error('This Electron safeStorage runtime harness is Windows-only.')
}
if (electronVersion !== '43.4.1') {
  throw new Error(`Unexpected Electron version: ${electronVersion}`)
}

const harnessMain = `
const { app, safeStorage } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const repoRoot = process.env.ZTOOLS_CREDENTIAL_TEST_REPO
const phase = process.env.ZTOOLS_CREDENTIAL_TEST_PHASE
const resultPath = process.env.ZTOOLS_CREDENTIAL_TEST_RESULT
const expectedUserData = process.env.ZTOOLS_CREDENTIAL_TEST_USER_DATA
const secretMarker = process.env.ZTOOLS_CREDENTIAL_TEST_SECRET
const pluginId = 'v2-13-runtime-plugin'
const dbRoot = path.join(expectedUserData, 'credential-service', 'LevelDB')
const valueKey = 'restart-token'
const corruptKey = 'corrupt-token'
const credentialKeyPrefix = '__ztools_credential_v1__:'
const recordPrefix = 'ztools-credential-v1:'

function ensure(condition, failureCode) {
  if (!condition) throw Object.assign(new Error('Controlled credential runtime check failed'), { failureCode })
}

function caller(id, owner = pluginId) {
  return { type: 'plugin', webContentsId: id, pluginId: owner, pluginInstanceId: 'instance-' + id }
}

function dbKey(key) {
  return credentialKeyPrefix + Buffer.from(key, 'utf8').toString('base64url')
}

async function writeResult(result) {
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')
}

app.whenReady().then(async () => {
  let service
  const result = {
    phase,
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    osRelease: require('node:os').release(),
    userDataPath: app.getPath('userData'),
    userDataIsolationVerified: path.resolve(app.getPath('userData')) === path.resolve(expectedUserData),
    selectedStorageBackend: null,
    selectedStorageBackendStatus: 'not-exposed',
    safeStorageAvailable: false,
    checks: {}
  }

  try {
    const directAvailability = await safeStorage.isAsyncEncryptionAvailable()
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      try {
        result.selectedStorageBackend = safeStorage.getSelectedStorageBackend()
        result.selectedStorageBackendStatus = 'reported'
      } catch {
        result.selectedStorageBackendStatus = 'not-applicable-on-platform'
      }
    }
    const { electronCredentialProtection } = await import(pathToFileURL(
      path.join(repoRoot, 'out/main/platform/electron-credential-protection.js')
    ).href)
    const { DatabaseService } = await import(pathToFileURL(
      path.join(repoRoot, 'out/main/services/database-service.js')
    ).href)
    result.safeStorageStatus = await electronCredentialProtection.status()
    result.safeStorageAvailable = directAvailability === true && result.safeStorageStatus.status === 'available'
    ensure(result.userDataIsolationVerified, 'USER_DATA_NOT_ISOLATED')
    ensure(result.safeStorageAvailable, 'SAFE_STORAGE_UNAVAILABLE')

    const probe = 'probe-' + secretMarker
    const encryptedProbe = await safeStorage.encryptStringAsync(probe)
    const decryptedProbe = await safeStorage.decryptStringAsync(encryptedProbe)
    result.checks.realSafeStorageRoundTrip = decryptedProbe.result === probe
    ensure(result.checks.realSafeStorageRoundTrip, 'SAFE_STORAGE_ROUND_TRIP_FAILED')

    service = new DatabaseService(dbRoot, electronCredentialProtection)
    const ownerA = caller(101)
    const ownerB = caller(102)
    const otherPlugin = caller(103, 'v2-13-other-plugin')
    const status = await service.credentialV1Status(ownerA)
    result.credentialStatus = status.data
    ensure(status.data.status === 'available', 'CREDENTIAL_STATUS_UNAVAILABLE')

    if (phase === 'write') {
      await service.credentialV1Set({ key: valueKey, value: 'persist-' + secretMarker }, ownerA, new AbortController().signal)
      const samePlugin = await service.credentialV1Get({ key: valueKey }, ownerB, new AbortController().signal)
      result.checks.samePluginInstanceRead = samePlugin.data.status === 'present' && samePlugin.data.value === 'persist-' + secretMarker
      ensure(result.checks.samePluginInstanceRead, 'SAME_PLUGIN_INSTANCE_READ_FAILED')

      const crossPlugin = await service.credentialV1Get({ key: valueKey }, otherPlugin, new AbortController().signal)
      result.checks.crossPluginIsolated = crossPlugin.data.status === 'missing'
      ensure(result.checks.crossPluginIsolated, 'CROSS_PLUGIN_ISOLATION_FAILED')

      await service.credentialV1Set({ key: 'overwrite-token', value: 'before-' + secretMarker }, ownerA, new AbortController().signal)
      await service.credentialV1Set({ key: 'overwrite-token', value: 'after-' + secretMarker }, ownerA, new AbortController().signal)
      const overwritten = await service.credentialV1Get({ key: 'overwrite-token' }, ownerA, new AbortController().signal)
      result.checks.overwrite = overwritten.data.status === 'present' && overwritten.data.value === 'after-' + secretMarker
      ensure(result.checks.overwrite, 'OVERWRITE_FAILED')

      await service.credentialV1Set({ key: 'delete-token', value: 'delete-' + secretMarker }, ownerA, new AbortController().signal)
      await service.credentialV1Delete({ key: 'delete-token' }, ownerA, new AbortController().signal)
      await service.credentialV1Delete({ key: 'delete-token' }, ownerA, new AbortController().signal)
      const deleted = await service.credentialV1Get({ key: 'delete-token' }, ownerA, new AbortController().signal)
      result.checks.idempotentDelete = deleted.data.status === 'missing'
      ensure(result.checks.idempotentDelete, 'DELETE_FAILED')

      await service.credentialV1Set({ key: corruptKey, value: 'corrupt-' + secretMarker }, ownerA, new AbortController().signal)
      result.checks.restartSeeded = true
      await service.stop()
      service = undefined

      const { ClassicLevel } = createRequire(path.join(repoRoot, 'package.json'))('classic-level')
      const ownerHash = crypto.createHash('sha256').update(pluginId, 'utf8').digest('hex')
      const location = path.join(dbRoot, '__ztools_credential_v1__' + ownerHash)
      const store = new ClassicLevel(location, { keyEncoding: 'utf8', valueEncoding: 'buffer', compression: false })
      await store.open()
      try {
        const key = dbKey(corruptKey)
        const record = await store.get(key)
        const encoded = record.toString('utf8')
        ensure(encoded.startsWith(recordPrefix), 'CORRUPT_FIXTURE_PREFIX_INVALID')
        const ciphertext = Buffer.from(encoded.slice(recordPrefix.length), 'base64')
        ensure(ciphertext.length > 1, 'CORRUPT_FIXTURE_TOO_SHORT')
        ciphertext[ciphertext.length - 1] ^= 0xff
        await store.put(key, Buffer.from(recordPrefix + ciphertext.toString('base64'), 'utf8'), { sync: true })
        result.checks.corruptCiphertextInjected = true
      } finally {
        await store.close()
      }
    } else if (phase === 'restart') {
      const reopened = await service.credentialV1Get({ key: valueKey }, caller(201), new AbortController().signal)
      result.checks.samePluginReadAfterRestart = reopened.data.status === 'present' && reopened.data.value === 'persist-' + secretMarker
      ensure(result.checks.samePluginReadAfterRestart, 'RESTART_PERSISTENCE_FAILED')

      const otherAfterRestart = await service.credentialV1Get({ key: valueKey }, caller(202, 'v2-13-other-plugin'), new AbortController().signal)
      result.checks.crossPluginStillIsolated = otherAfterRestart.data.status === 'missing'
      ensure(result.checks.crossPluginStillIsolated, 'CROSS_PLUGIN_RESTART_ISOLATION_FAILED')

      let corruptionError
      try {
        await service.credentialV1Get({ key: corruptKey }, caller(203), new AbortController().signal)
      } catch (error) {
        corruptionError = error
      }
      result.corruptionErrorCode = corruptionError?.code ?? 'NONE'
      result.checks.corruptCiphertextRejected = result.corruptionErrorCode === 'DATA_CORRUPT'
      result.checks.corruptReadReturnedSecret = typeof corruptionError?.message === 'string' && corruptionError.message.includes(secretMarker)
      ensure(result.checks.corruptCiphertextRejected, 'CORRUPT_CIPHERTEXT_NOT_REJECTED')
      ensure(!result.checks.corruptReadReturnedSecret, 'CORRUPT_READ_EXPOSED_SECRET')
    } else {
      ensure(false, 'INVALID_PHASE')
    }

    result.ok = true
    await writeResult(result)
    app.exit(0)
  } catch (error) {
    result.ok = false
    result.failureCode = error?.failureCode ?? 'HARNESS_FAILURE'
    try { if (service) await service.stop() } catch {}
    await writeResult(result)
    app.exit(1)
  }
}).catch(async () => {
  await writeResult({ phase, ok: false, failureCode: 'APP_READY_FAILED' })
  app.exit(1)
})
`

function assertInsideRunRoot(candidate) {
  const relative = path.relative(runRoot, candidate)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Refusing to clean a path outside the isolated credential test run.')
  }
}

async function runElectronPhase(phase) {
  const resultPath = path.join(runRoot, `${phase}-result.json`)
  const env = {
    ...process.env,
    ZTOOLS_CREDENTIAL_TEST_REPO: repoRoot,
    ZTOOLS_CREDENTIAL_TEST_PHASE: phase,
    ZTOOLS_CREDENTIAL_TEST_RESULT: resultPath,
    ZTOOLS_CREDENTIAL_TEST_USER_DATA: userDataRoot,
    ZTOOLS_CREDENTIAL_TEST_SECRET: secretMarker
  }
  const args = [appRoot, `--user-data-dir=${userDataRoot}`, '--disable-gpu']
  const child = spawn(electronBinary, args, { cwd: repoRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', chunk => output.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => output.push(Buffer.from(chunk)))
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Electron ${phase} harness timed out.`))
    }, 60_000)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
  const processOutput = Buffer.concat(output).toString('utf8')
  const containsSecret = processOutput.includes(secretMarker)
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'))
  return { ...result, exitCode: exit.code, signal: exit.signal ?? null, processOutputContainsSecret: containsSecret }
}

let report
await fs.mkdir(runRoot, { recursive: true })
try {
  await fs.mkdir(appRoot, { recursive: true })
  await fs.mkdir(userDataRoot, { recursive: true })
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
    name: 'ztools-credential-v1-safe-storage-check',
    version: '1.0.0',
    main: 'main.cjs'
  }, null, 2))
  await fs.writeFile(path.join(appRoot, 'main.cjs'), harnessMain)

  const first = await runElectronPhase('write')
  const second = first.ok && first.exitCode === 0
    ? await runElectronPhase('restart')
    : undefined
  const processOutputContainsSecret = first.processOutputContainsSecret || Boolean(second?.processOutputContainsSecret)
  report = {
    runId,
    generatedAt: new Date().toISOString(),
    electronBinary,
    expectedElectronVersion: electronVersion,
    hostPlatform: process.platform,
    hostArch: process.arch,
    hostOsRelease: os.release(),
    isolatedUserDataPath: userDataRoot,
    userDataScope: 'temporary isolated path passed via --user-data-dir; removed after both phases',
    firstPhase: first,
    restartPhase: second ?? null,
    processOutputContainsSecret,
    pass: first.ok === true && first.exitCode === 0 && second?.ok === true && second.exitCode === 0 && !processOutputContainsSecret
  }
} catch (error) {
  report = {
    runId,
    generatedAt: new Date().toISOString(),
    electronBinary,
    expectedElectronVersion: electronVersion,
    hostPlatform: process.platform,
    hostArch: process.arch,
    hostOsRelease: os.release(),
    isolatedUserDataPath: userDataRoot,
    failureCode: 'HARNESS_RUNNER_FAILURE',
    errorName: error instanceof Error ? error.name : 'Error',
    pass: false
  }
} finally {
  for (const cleanupPath of [appRoot, userDataRoot]) {
    assertInsideRunRoot(cleanupPath)
    await fs.rm(cleanupPath, { recursive: true, force: true })
  }
}

await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ reportPath, pass: report.pass, runId }))
if (!report.pass) process.exitCode = 1
