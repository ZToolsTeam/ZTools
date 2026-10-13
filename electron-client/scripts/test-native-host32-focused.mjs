import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCodes, ZToolsError } from '../out/contracts/errors.js'
import { NativeHostClient } from '../out/main/native-host/native-host-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_EXE ??
  path.join(root, 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe'))
const fixtureSource = path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_PLUGIN ??
  path.join(root, 'out', 'native', 'test-win32-ia32', 'ZToolsNativeTestPlugin.dll'))
const evidence = { productionZToolsAcceptance: false, scope: 'real-native-host-isolated-fixture', tests: [] }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function waitForDllEvent(client, events, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for NativeHost32 DLL event'))
    }, timeoutMs)
    const finish = (event) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    }
    unsubscribe = client.onDllEvent((event) => {
      if (predicate(event)) finish(event)
    })
    const existing = events.find(predicate)
    if (existing) finish(existing)
  })
}

function expectNativeHostError(promise, code, hostCode) {
  return assert.rejects(
    promise,
    (error) => error instanceof ZToolsError && error.code === code &&
      (hostCode === undefined || error.details?.hostCode === hostCode)
  )
}

function requestBlockingDllWithTimeout(client) {
  const functionName = Buffer.from('blockHostDispatch', 'utf8')
  const params = Buffer.from('{}', 'utf8')
  const payload = Buffer.allocUnsafe(2 + functionName.length + params.length)
  payload.writeUInt16LE(functionName.length, 0)
  functionName.copy(payload, 2)
  params.copy(payload, 2 + functionName.length)
  // callDll intentionally has no deadline; use the bounded request API to test queue timeout.
  return client.request('dll_call', payload, {
    pluginId: 'native-host-test',
    dllId: 'ZToolsNativeTestPlugin',
    timeoutMs: 5_000
  })
}

async function createFixtureRoot() {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-native-host-c13-'))
  const pluginRoot = path.join(runtimeRoot, 'Plugins')
  const libraryRoot = path.join(pluginRoot, 'native-host-test', 'lib')
  await fs.mkdir(libraryRoot, { recursive: true })
  const fixtureTarget = path.join(libraryRoot, 'ZToolsNativeTestPlugin.dll')
  await fs.copyFile(fixtureSource, fixtureTarget)
  const fixtureDigest = sha256(await fs.readFile(fixtureTarget))
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<nativeHostManifest version="1">
  <plugin id="native-host-test">
    <dll id="ZToolsNativeTestPlugin" path="lib/ZToolsNativeTestPlugin.dll" sha256="${fixtureDigest}" arch="x86">
      <function name="blockHostDispatch"/>
      <function name="callbackTask"/>
      <function name="progressTask"/>
    </dll>
  </plugin>
</nativeHostManifest>
`
  await fs.writeFile(path.join(pluginRoot, '.ztools-native-host.xml'), manifest, 'utf8')
  return {
    runtimeRoot,
    pluginRoot,
    trustedManifestSha256: sha256(Buffer.from(manifest, 'utf8'))
  }
}

async function removeFixtureRoot(runtimeRoot) {
  const resolved = path.resolve(runtimeRoot)
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  assert.match(path.basename(resolved), /^ztools-native-host-c13-[A-Za-z0-9]+$/u)
  assert.equal((await fs.lstat(resolved)).isSymbolicLink(), false)
  await fs.rm(resolved, { recursive: true, force: true })
}

async function verifyLateStartCancelAndClear(mode = 'callback') {
  const fixtureRoot = await createFixtureRoot()
  const record = { mode, test: 'late-start-cancel-clear', fixtureRoot: fixtureRoot.runtimeRoot,
    trustedManifestSha256: fixtureRoot.trustedManifestSha256, completed: false, cleanup: false }
  evidence.tests.push(record)
  const client = new NativeHostClient(executable, {
    pluginRoot: fixtureRoot.pluginRoot,
    trustedManifestSha256: fixtureRoot.trustedManifestSha256
  })
  const events = []
  const stopCollectingEvents = client.onDllEvent((event) => events.push(event))
  try {
    await client.start()
    record.hostPid = client.diagnostics.pid
    const startedAt = Date.now()
    const blocker = requestBlockingDllWithTimeout(client)
    const attempt = mode === 'async'
      ? client.beginDllAsyncTask('native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', { slow: true, silent: true })
      : client.beginDllCallbackTask('native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { verySlow: true })
    let startSettled = false
    void attempt.outcome.then(() => { startSettled = true })
    assert.match(attempt.taskId, /^task_[A-Za-z0-9_-]+$/u)

    // This cancel frame follows callback-start in the Host's serial stdin queue.
    const cancel = client.cancelDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', attempt.taskId
    )
    const ordinaryTimeoutStartedAt = Date.now()
    await Promise.all([
      expectNativeHostError(blocker, errorCodes.requestTimeout),
      expectNativeHostError(cancel, errorCodes.requestTimeout)
    ])
    assert.ok(Date.now() - ordinaryTimeoutStartedAt >= 4_500)
    assert.equal(startSettled, false, `${mode} start must remain observed beyond the ordinary IPC deadline`)

    const startOutcome = await withTimeout(attempt.outcome, 5_000, `late ${mode} start acknowledgement`)
    record.taskId = attempt.taskId
    record.ackElapsedMs = Date.now() - startedAt
    assert.deepEqual(startOutcome, { kind: 'started' })
    const runningStatus = await client.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', attempt.taskId
    )
    assert.ok(
      runningStatus.status === 'invoking' || runningStatus.status === 'running',
      'cancel acknowledgement must not make an active callback task terminal'
    )
    await expectNativeHostError(
      client.clearDllTask('native-host-test', 'ZToolsNativeTestPlugin', attempt.taskId),
      errorCodes.dllError,
      'DLL_BUSY'
    )

    const cancelled = await waitForDllEvent(
      client,
      events,
      (event) => event.taskId === attempt.taskId && (mode === 'async'
        ? event.type === 'cancelled'
        : event.type === 'callback-result' && JSON.parse(event.result).type === 'cancelled'),
      10_000
    )
    if (mode === 'callback') assert.equal(cancelled.result, '{"type":"cancelled"}')
    await waitForDllEvent(
      client,
      events,
      (event) => event.taskId === attempt.taskId && event.type === (mode === 'async' ? 'async-return' : 'callback-return')
    )
    const terminalStatus = await client.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', attempt.taskId
    )
    assert.equal(terminalStatus.status, 'cancelled')
    record.terminalStatus = terminalStatus.status
    if (mode === 'callback') assert.equal(terminalStatus.result, '{"type":"cancelled"}')
    else assert.equal(JSON.parse(terminalStatus.result).result, attempt.taskId)
    await client.clearDllTask('native-host-test', 'ZToolsNativeTestPlugin', attempt.taskId)

    const rejectedAttempt = mode === 'async'
      ? client.beginDllAsyncTask('native-host-test', 'ZToolsNativeTestPlugin', 'unlistedFixtureFunction', {})
      : client.beginDllCallbackTask('native-host-test', 'ZToolsNativeTestPlugin', 'unlistedFixtureFunction', {})
    const rejectedOutcome = await withTimeout(
      rejectedAttempt.outcome, 3_000, 'explicit callback start rejection'
    )
    assert.equal(rejectedOutcome.kind, 'not-started')

    const shutdown = await client.stop()
    assert.equal(shutdown.completed, true)
    assert.equal(shutdown.timedOut, false)
    assert.equal(client.diagnostics.exitCode, 0)
    record.exitCode = client.diagnostics.exitCode
    record.completed = true
  } finally {
    stopCollectingEvents()
    try {
      await client.stop()
    } finally {
      await removeFixtureRoot(fixtureRoot.runtimeRoot)
      record.cleanup = true
    }
  }
}

async function verifyHostExitResolvesUnknownStart(mode = 'callback') {
  const fixtureRoot = await createFixtureRoot()
  const record = { mode, test: 'host-exit-unknown-start', fixtureRoot: fixtureRoot.runtimeRoot,
    trustedManifestSha256: fixtureRoot.trustedManifestSha256, completed: false, cleanup: false }
  evidence.tests.push(record)
  const client = new NativeHostClient(executable, {
    pluginRoot: fixtureRoot.pluginRoot,
    trustedManifestSha256: fixtureRoot.trustedManifestSha256
  })
  try {
    await client.start()
    const blocker = requestBlockingDllWithTimeout(client)
    const attempt = mode === 'async'
      ? client.beginDllAsyncTask('native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', {})
      : client.beginDllCallbackTask('native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', {})
    const hostPid = client.diagnostics.pid
    record.hostPid = hostPid
    record.taskId = attempt.taskId
    assert.ok(hostPid)
    let startSettled = false
    void attempt.outcome.then(() => { startSettled = true })
    await expectNativeHostError(blocker, errorCodes.requestTimeout)
    assert.equal(startSettled, false, 'unknown start must remain reserved until Host exit')
    process.kill(hostPid)

    const outcome = await withTimeout(attempt.outcome, 5_000, 'Host exit start resolution')
    assert.equal(outcome.kind, 'host-exited')
    record.startOutcome = outcome.kind
    await client.stop()
    assert.equal(client.state, 'closed')
    record.completed = true
  } finally {
    try {
      await client.stop()
    } finally {
      await removeFixtureRoot(fixtureRoot.runtimeRoot)
      record.cleanup = true
    }
  }
}

assert.equal(process.platform, 'win32', 'focused NativeHost32 test requires Windows')
assert.equal(process.arch, 'x64', 'focused NativeHost32 test requires an x64 host OS')
await fs.access(executable)
await fs.access(fixtureSource)
try {
  evidence.executable = { path: executable, sha256: sha256(await fs.readFile(executable)) }
  evidence.fixture = { path: fixtureSource, sha256: sha256(await fs.readFile(fixtureSource)) }
  await verifyLateStartCancelAndClear()
  await verifyHostExitResolvesUnknownStart()
  await verifyLateStartCancelAndClear('async')
  await verifyHostExitResolvesUnknownStart('async')
  console.log('NativeHost32 focused callback and ordinary async start-observation tests passed')
} finally {
  console.log(JSON.stringify(evidence, null, 2))
}
