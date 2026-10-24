import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { CdpClient, runMainPrebootIsolationGate, validatePrebootPathReadback, validatePrebootProfile } from './lib/normal-app-preboot-isolation.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preboot-gate-'))
  const appRoot = path.join(outputRoot, 'app')
  const profileRoot = path.join(outputRoot, randomUUID())
  fs.mkdirSync(appRoot)
  fs.mkdirSync(profileRoot)
  const profile = { root: profileRoot, appDataPath: path.join(profileRoot, 'appData'),
    userDataPath: path.join(profileRoot, 'userData'), sessionDataPath: path.join(profileRoot, 'sessionData') }
  for (const directory of [profile.appDataPath, profile.userDataPath, profile.sessionDataPath]) fs.mkdirSync(directory)
  const appArchivePath = appRoot
  const entryPath = path.join(appRoot, 'out', 'main', 'bootstrap.js')
  fs.mkdirSync(path.dirname(entryPath), { recursive: true })
  const executablePath = path.join(appRoot, 'electron.exe')
  const config = { childPid: 48210, inspectPort: 41231, executablePath, appRoot, appArchivePath, entryPath,
    appVersion: '1.1.7.1', electronVersion: '43.4.1', processArch: 'x64', isPackaged: false,
    outputRoot, profile, timeoutMs: 1000 }
  return { outputRoot, profile, config }
}

function setupClient(config, { identity = {}, pause = {}, pauses, identities = {}, configuredPaths = {}, verifiedPaths = {},
  scriptSource = '"use strict";\nvar firstStatement;' } = {}) {
  const calls = []
  let disposed = false
  let identityEvaluations = 0
  const pauseQueue = [...(pauses ?? [])]
  const correctIdentity = { pid: config.childPid, execPath: config.executablePath, argv: [config.launcherAppPath ?? config.appRoot], processArch: config.processArch,
    electronVersion: config.electronVersion, mainEntry: config.entryPath, appPath: config.appArchivePath,
    appName: config.appName ?? 'ZTools', appVersion: config.appVersion, isPackaged: config.isPackaged, ...identity }
  const correctPaths = Object.fromEntries(['appDataPath', 'userDataPath', 'sessionDataPath'].map(key => [key, config.profile[key]]))
  const correctVerified = { ...correctPaths, appDataRealPath: config.profile.appDataPath,
    userDataRealPath: config.profile.userDataPath, sessionDataRealPath: config.profile.sessionDataPath }
  const defaultPause = { reason: 'Break on start', callFrames: [{ callFrameId: 'frame-1',
    url: pathToFileURL(config.entryPath).href, location: { scriptId: 'script-1', lineNumber: 0 } }] }
  const client = {
    on(method) { calls.push(`on:${method}`); return () => {} },
    waitForEvent(method, accept = () => true) {
      calls.push(`wait:${method}`)
      const events = pauseQueue.length ? pauseQueue : [{ ...defaultPause, ...pause }]
      const index = events.findIndex(accept)
      if (index < 0) return Promise.reject(new Error('TEST_PAUSE_EVENT_NOT_FOUND'))
      return Promise.resolve(events.splice(index, 1)[0])
    },
    async call(method) {
      calls.push(method)
      if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: 'bp-main' }
      if (method === 'Debugger.getScriptSource') return { scriptSource }
      return {}
    },
    async evaluatePausedFrame(callFrameId, expression) {
      calls.push(`evaluate:${callFrameId}`)
      if (expression.includes('app.setPath')) return { ...correctPaths, ...configuredPaths }
      if (expression.includes('appDataRealPath')) return { ...correctVerified, ...verifiedPaths }
      identityEvaluations += 1
      return { ...correctIdentity, ...(identities[callFrameId] ?? {}), ...identity }
    },
    dispose() { disposed = true }
  }
  const fetchImpl = async () => ({ ok: true, json: async () => [{ type: 'node', id: 'owned-main',
    webSocketDebuggerUrl: `ws://127.0.0.1:${config.inspectPort}/owned-main` }] })
  const connect = async (url, port, prefix) => {
    calls.push(`connect:${url}:${port}:${prefix}`)
    return client
  }
  return { calls, client, fetchImpl, connect, disposed: () => disposed, identityEvaluations: () => identityEvaluations }
}

test('preboot gate proves Main first line and process identity before setting paths, re-reads them, then resumes once', async () => {
  const { config } = fixture()
  const fake = setupClient(config)
  const result = await runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: fake.fetchImpl, connect: fake.connect })
  assert.equal(result.status, 'PASS')
  assert.equal(result.childPid, config.childPid)
  assert.equal(result.profile.appDataPath, config.profile.appDataPath)
  assert.equal(result.resumed, true)
  assert.equal(fake.calls.at(-1), 'Debugger.resume')
  assert.equal(fake.calls.filter(value => value === 'Debugger.resume').length, 1)
  const identityIndex = fake.calls.findIndex(value => value.startsWith('evaluate:'))
  const pathConfigurationIndex = fake.calls.findIndex((value, index) => index > identityIndex && value.startsWith('evaluate:'))
  const resumeIndex = fake.calls.indexOf('Debugger.resume')
  assert.ok(identityIndex > fake.calls.indexOf('Runtime.runIfWaitingForDebugger'))
  assert.ok(pathConfigurationIndex > identityIndex)
  assert.ok(resumeIndex > pathConfigurationIndex)
  assert.equal(fake.disposed(), false)
})

test('approved Electron launcher is isolated at its first line before bootstrap is allowed to run', async () => {
  const { config } = fixture()
  const launcherPath = path.join(config.appRoot, 'resources', 'default_app.asar', 'main.js')
  config.launcherPath = launcherPath
  config.appName = 'ztools-electron-client'
  const launcherPause = { reason: 'Break on start', callFrames: [{ callFrameId: 'loader-frame',
    url: pathToFileURL(launcherPath).href, location: { scriptId: 'loader-script', lineNumber: 0 } }] }
  const bootstrapPause = { reason: 'other', hitBreakpoints: ['bp-main'], callFrames: [{ callFrameId: 'main-frame',
    url: pathToFileURL(config.entryPath).href, location: { scriptId: 'main-script', lineNumber: 0 } }] }
  const fake = setupClient(config, { pauses: [launcherPause, bootstrapPause], identities: {
    'loader-frame': { mainEntry: launcherPath }, 'main-frame': { mainEntry: config.entryPath }
  } })
  const result = await runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: fake.fetchImpl, connect: fake.connect })
  assert.equal(result.status, 'PASS')
  assert.equal(result.launcherIdentity.mainEntry, launcherPath)
  assert.equal(result.entryIdentity.mainEntry, config.entryPath)
  assert.equal(fake.calls.filter(value => value === 'Debugger.resume').length, 2)
  const loaderIdentityIndex = fake.calls.indexOf('evaluate:loader-frame')
  const firstPathSetIndex = fake.calls.indexOf('evaluate:loader-frame', loaderIdentityIndex + 1)
  const pathReadbackIndex = fake.calls.indexOf('evaluate:loader-frame', firstPathSetIndex + 1)
  const breakpointIndex = fake.calls.indexOf('Debugger.setBreakpointByUrl')
  const firstResumeIndex = fake.calls.indexOf('Debugger.resume')
  assert.ok(loaderIdentityIndex < firstPathSetIndex && firstPathSetIndex < pathReadbackIndex)
  assert.ok(pathReadbackIndex < breakpointIndex && breakpointIndex < firstResumeIndex)
})

test('unapproved launcher identity fails before path mutation or resume', async () => {
  const { config } = fixture()
  config.launcherPath = path.join(config.appRoot, 'resources', 'default_app.asar', 'main.js')
  const launcherPause = { reason: 'Break on start', callFrames: [{ callFrameId: 'loader-frame',
    url: pathToFileURL(config.launcherPath).href, location: { scriptId: 'loader-script', lineNumber: 0 } }] }
  const fake = setupClient(config, { pauses: [launcherPause], identities: {
    'loader-frame': { mainEntry: config.launcherPath, argv: [path.join(config.appRoot, 'other-app')] }
  } })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: fake.fetchImpl, connect: fake.connect }),
    /LAUNCHER_APP_ARGUMENT_MISMATCH/)
  assert.equal(fake.calls.some(value => value.startsWith('evaluate:loader-frame') && value !== 'evaluate:loader-frame'), false)
  assert.equal(fake.calls.includes('Debugger.setBreakpointByUrl'), false)
  assert.equal(fake.calls.includes('Debugger.resume'), false)
})

test('a wrong Main PID stops before path mutation and never resumes the process', async () => {
  const { config } = fixture()
  const fake = setupClient(config, { identity: { pid: config.childPid + 1 } })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: fake.fetchImpl, connect: fake.connect }),
    error => error.message === 'MAIN_PID_MISMATCH' && error.prebootIsolationPaused === true)
  assert.equal(fake.calls.includes('Debugger.resume'), false)
  assert.equal(fake.calls.filter(value => value.startsWith('evaluate:')).length, 1)
  assert.equal(fake.disposed(), false)
})

test('a non-entry or non-first-line pause is fail-closed before Main evaluation', async () => {
  const { config } = fixture()
  const wrongUrl = setupClient(config, { pause: { callFrames: [{ callFrameId: 'frame-2',
    url: pathToFileURL(path.join(config.appRoot, 'wrong.js')).href, location: { lineNumber: 0 } }] } })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: wrongUrl.fetchImpl, connect: wrongUrl.connect }),
    /BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED/)
  assert.equal(wrongUrl.identityEvaluations(), 0)
  assert.equal(wrongUrl.calls.includes('Debugger.resume'), false)

  const wrongLine = setupClient(config, { pause: { callFrames: [{ callFrameId: 'frame-3',
    url: pathToFileURL(config.entryPath).href, location: { lineNumber: 2 } }] } })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: wrongLine.fetchImpl, connect: wrongLine.connect }),
    /BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED/)
  assert.equal(wrongLine.identityEvaluations(), 0)
  assert.equal(wrongLine.calls.includes('Debugger.resume'), false)

  const unsafePrefix = setupClient(config, { pause: { callFrames: [{ callFrameId: 'frame-4',
    url: pathToFileURL(config.entryPath).href, location: { scriptId: 'script-4', lineNumber: 1 } }] },
    scriptSource: 'globalThis.started = true;\nvar firstStatement;' })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: unsafePrefix.fetchImpl, connect: unsafePrefix.connect }),
    /BOOTSTRAP_PREFIX_UNSAFE/)
  assert.equal(unsafePrefix.identityEvaluations(), 0)
  assert.equal(unsafePrefix.calls.some(value => value.startsWith('evaluate:')), false)
  assert.equal(unsafePrefix.calls.includes('Debugger.resume'), false)
})

test('path set and path readback mismatches both fail before resume', async () => {
  const first = fixture()
  const wrongSet = setupClient(first.config, { configuredPaths: { appDataPath: path.join(first.outputRoot, 'elsewhere') } })
  await assert.rejects(runMainPrebootIsolationGate(first.config, { platform: 'win32', fetchImpl: wrongSet.fetchImpl, connect: wrongSet.connect }),
    /ISOLATED_PATH_CONFIGURATION_FAILED/)
  assert.equal(wrongSet.calls.includes('Debugger.resume'), false)

  const second = fixture()
  const wrongReadback = setupClient(second.config, { verifiedPaths: { sessionDataRealPath: second.outputRoot } })
  await assert.rejects(runMainPrebootIsolationGate(second.config, { platform: 'win32', fetchImpl: wrongReadback.fetchImpl, connect: wrongReadback.connect }),
    /ISOLATED_PATH_READBACK_FAILED/)
  assert.equal(wrongReadback.calls.includes('Debugger.resume'), false)
})

test('profile must be a real UUID-owned directory below the fresh output root', () => {
  const { outputRoot, profile, config } = fixture()
  assert.equal(validatePrebootProfile(profile, outputRoot, { platform: 'win32' }).status, 'PASS')
  assert.equal(validatePrebootProfile({ ...profile, root: path.dirname(outputRoot) }, outputRoot, { platform: 'win32' }).code,
    'PROFILE_OUTSIDE_RUN_ROOT')
  const malformed = { ...profile, appDataPath: path.join(outputRoot, 'other') }
  assert.equal(validatePrebootProfile(malformed, outputRoot, { platform: 'win32' }).code, 'ISOLATED_PROFILE_PATH_MISMATCH')
})

test('Darwin profile layout and consumed Main path realpath readback match production appData/ZTools policy', () => {
  const id = randomUUID()
  const outputRoot = '/f12/output'
  const root = `${outputRoot}/profiles/${id}`
  const profile = { root, appDataPath: `${root}/appData`, userDataPath: `${root}/appData/ZTools`, sessionDataPath: `${root}/sessionData` }
  const directories = new Set([outputRoot, root, profile.appDataPath, profile.userDataPath, profile.sessionDataPath])
  const fsApi = {
    lstatSync(value) {
      if (!directories.has(value)) throw new Error('ENOENT')
      return { isDirectory: () => true, isSymbolicLink: () => false }
    },
    realpathSync(value) {
      if (!directories.has(value)) throw new Error('ENOENT')
      return value
    }
  }
  assert.equal(validatePrebootProfile(profile, outputRoot, { platform: 'darwin', fsApi }).status, 'PASS')
  assert.equal(validatePrebootProfile({ ...profile, userDataPath: `${root}/userData` }, outputRoot,
    { platform: 'darwin', fsApi }).code, 'ISOLATED_PROFILE_PATH_MISMATCH')

  const consumed = { appDataPath: profile.appDataPath, userDataPath: profile.userDataPath,
    sessionDataPath: profile.sessionDataPath }
  const verified = { ...consumed, appDataRealPath: profile.appDataPath,
    userDataRealPath: profile.userDataPath, sessionDataRealPath: profile.sessionDataPath }
  assert.equal(validatePrebootPathReadback(consumed, profile, { platform: 'darwin' }).status, 'PASS')
  assert.equal(validatePrebootPathReadback(verified, profile, { platform: 'darwin', requireRealPaths: true }).status, 'PASS')
  assert.equal(validatePrebootPathReadback({ ...consumed, userDataPath: `${root}/userData` }, profile,
    { platform: 'darwin' }).code, 'ISOLATED_PATH_CONFIGURATION_FAILED')
  assert.equal(validatePrebootPathReadback({ ...verified, userDataRealPath: `${root}/userData` }, profile,
    { platform: 'darwin', requireRealPaths: true }).code, 'ISOLATED_PATH_READBACK_FAILED')
})

test('inspector target must be owned loopback endpoint with exactly one Node Main target', async () => {
  const { config } = fixture()
  const fake = setupClient(config)
  const badEndpoint = async () => ({ ok: true, json: async () => [{ type: 'node', id: 'other',
    webSocketDebuggerUrl: `ws://example.test:${config.inspectPort}/other` }] })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: badEndpoint, connect: fake.connect }),
    /INVALID_MAIN_INSPECTOR_ENDPOINT/)
  assert.equal(fake.calls.some(value => value.startsWith('connect:')), false)
  const ambiguous = async () => ({ ok: true, json: async () => [
    { type: 'node', id: 'one', webSocketDebuggerUrl: `ws://127.0.0.1:${config.inspectPort}/one` },
    { type: 'node', id: 'two', webSocketDebuggerUrl: `ws://127.0.0.1:${config.inspectPort}/two` }
  ] })
  await assert.rejects(runMainPrebootIsolationGate(config, { platform: 'win32', fetchImpl: ambiguous, connect: fake.connect }),
    /AMBIGUOUS_MAIN_INSPECTOR_TARGET/)
})

test('natural CDP close and socket error immediately reject pending commands and event waiters', async () => {
  class FakeSocket {
    listeners = new Map()
    closeCalls = 0
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set()
      listeners.add(listener)
      this.listeners.set(type, listeners)
    }
    send() {}
    emit(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    close() { this.closeCalls += 1; this.emit('close') }
  }

  for (const [eventName, expectedCode, expectedCloseCalls] of [
    ['close', 'CDP_CLOSED', 0], ['error', 'CDP_SOCKET_ERROR', 1]
  ]) {
    const socket = new FakeSocket()
    const client = new CdpClient(socket)
    const pendingCommand = client.call('Runtime.enable', {}, 30_000)
    const pendingEvent = client.waitForEvent('Debugger.paused', () => true, 30_000)
    socket.emit(eventName)
    await Promise.all([
      assert.rejects(pendingCommand, new RegExp(expectedCode)),
      assert.rejects(pendingEvent, new RegExp(expectedCode))
    ])
    await assert.rejects(client.call('Runtime.evaluate', {}, 30_000), /CDP_CLOSED/)
    await assert.rejects(client.waitForEvent('Runtime.executionContextCreated', () => true, 30_000), /CDP_CLOSED/)
    client.dispose()
    client.dispose()
    assert.equal(socket.closeCalls, expectedCloseCalls)
  }
})

async function freeLoopbackPort(excludedPorts = new Set()) {
  const server = net.createServer()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (!excludedPorts.has(port)) return port
  }
  throw new Error('LOOPBACK_PORT_ALLOCATION_FAILED')
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener('exit', onExit); reject(new Error('REAL_GATE_APP_EXIT_TIMEOUT')) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve() }
    child.once('exit', onExit)
  })
}

test('real Windows normal Electron confirms the portable gate on random loopback ports', {
  skip: process.platform !== 'win32' || process.env.ZTOOLS_REAL_NORMAL_APP_PREBOOT_GATE !== '1', timeout: 90_000
}, async () => {
  if (process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED')
  const runId = randomUUID()
  const outputRoot = path.join(clientRoot, 'out-test', 'normal-app-preboot-isolation', runId)
  fs.mkdirSync(outputRoot, { recursive: true })
  const profile = { root: path.join(outputRoot, 'profiles', randomUUID()) }
  fs.mkdirSync(path.dirname(profile.root))
  fs.mkdirSync(profile.root)
  profile.appDataPath = path.join(profile.root, 'appData')
  profile.userDataPath = path.join(profile.root, 'userData')
  profile.sessionDataPath = path.join(profile.root, 'sessionData')
  for (const directory of [profile.appDataPath, profile.userDataPath, profile.sessionDataPath]) fs.mkdirSync(directory)
  const executablePath = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  const packageInfo = JSON.parse(fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8'))
  const electronInfo = JSON.parse(fs.readFileSync(path.join(clientRoot, 'node_modules', 'electron', 'package.json'), 'utf8'))
  if (electronInfo.version !== '43.4.1') throw new Error('ELECTRON_VERSION_MISMATCH')
  const appArchivePath = clientRoot
  const entryPath = path.resolve(clientRoot, packageInfo.main)
  const launcherPath = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'resources', 'default_app.asar', 'main.js')
  const reservedPorts = new Set([9336, 9337])
  const inspectPort = await freeLoopbackPort(reservedPorts)
  const cdpPort = await freeLoopbackPort(new Set([...reservedPorts, inspectPort]))
  const launchArguments = [clientRoot, `--inspect-brk=127.0.0.1:${inspectPort}`,
    `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1']
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executablePath, launchArguments, { cwd: clientRoot, shell: false, windowsHide: true,
    stdio: 'ignore', env })
  let exited = false
  child.once('exit', () => { exited = true })
  child.once('error', () => { exited = true })
  let gate
  try {
    gate = await runMainPrebootIsolationGate({ childPid: child.pid, inspectPort, executablePath,
      appRoot: clientRoot, appArchivePath, entryPath, launcherPath, launcherAppPath: clientRoot,
      appName: packageInfo.productName ?? packageInfo.name,
      appVersion: packageInfo.version, electronVersion: electronInfo.version,
      processArch: 'x64', isPackaged: false, outputRoot, profile, timeoutMs: 8_000 }, { platform: 'win32' })
    assert.equal(gate.status, 'PASS')
    assert.equal(gate.entryIdentity.pid, child.pid)
    assert.equal(gate.pause.lineNumber, 1)
    assert.equal(gate.bootstrapSource.requestedLineNumber, 0)
    assert.equal(gate.bootstrapSource.actualLineNumber, 1)
    assert.equal(gate.bootstrapSource.directiveOnlyPrefix, true)
    const outBootstrapSha256 = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')
    assert.equal(gate.bootstrapSource.sourceSha256, outBootstrapSha256)
    assert.equal(gate.configuredPaths.appDataPath, profile.appDataPath)
    await new Promise(resolve => setTimeout(resolve, 300))
    if (!exited) child.kill('SIGTERM')
    await waitForChildExit(child, 10_000)
    assert.equal(exited, true)
  } catch (error) {
    if (error?.prebootIsolationClient) gate = { client: error.prebootIsolationClient }
    if (error?.identityDiagnostic) error.diagnostic = error.identityDiagnostic
    if (error?.pauseDiagnostic) error.diagnostic = error.pauseDiagnostic
    if (!exited) {
      try { child.kill('SIGTERM') } catch { /* The child handle is the only process target. */ }
      await waitForChildExit(child, 5000).catch(() => {})
    }
    if (!exited) {
      try { child.kill('SIGKILL') } catch { /* Keep cleanup bounded to the owned child handle. */ }
      await waitForChildExit(child, 5000).catch(() => {})
    }
    gate?.client?.dispose()
    throw error
  } finally {
    gate?.client?.dispose()
  }
  assert.equal(fs.existsSync(profile.root), true)
  const reportPath = path.join(outputRoot, 'normal-app-preboot-isolation-report.json')
  const report = { schemaVersion: 1, runId, createdAt: new Date().toISOString(), host: { platform: process.platform,
      node: process.version, arch: process.arch }, status: 'PASS', scope: 'windows-portable-main-preboot-gate',
    applicationAcceptance: false, out: { appVersion: packageInfo.version, electronVersion: electronInfo.version,
      entryPath, entrySourceSha256: createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex'),
      loadedSourceSha256: gate.bootstrapSource.sourceSha256 },
    process: { pid: child.pid, executablePath, processArch: gate.entryIdentity.processArch,
      appPath: gate.entryIdentity.appPath, appName: gate.entryIdentity.appName, appVersion: gate.entryIdentity.appVersion,
      electronVersion: gate.entryIdentity.electronVersion, isPackaged: gate.entryIdentity.isPackaged,
      initialLauncherPath: gate.launcherIdentity ? launcherPath : null },
    isolation: { inspectorPort: inspectPort, cdpPort, requestedLineNumber: gate.bootstrapSource.requestedLineNumber,
      actualLineNumber: gate.bootstrapSource.actualLineNumber, directiveOnlyPrefix: gate.bootstrapSource.directiveOnlyPrefix,
      prefixKind: gate.bootstrapSource.prefixKind, isolatedProfilePath: profile.root,
      appDataPath: gate.verifiedPaths.appDataPath, userDataPath: gate.verifiedPaths.userDataPath,
      sessionDataPath: gate.verifiedPaths.sessionDataPath, resumedAfterReadback: gate.resumed },
    cleanup: 'OWNED_PROCESS_EXITED', profilePreserved: true }
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  console.log(JSON.stringify({ status: 'PASS', runId, reportPath, ownedPid: child.pid, inspectorPort: inspectPort, cdpPort,
    outBootstrapSha256: report.out.entrySourceSha256, appDataPath: profile.appDataPath,
    profilePreserved: true, applicationAcceptance: false }))
})
