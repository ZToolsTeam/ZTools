import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCodes, ZToolsError } from '../out/contracts/errors.js'
import { NativeHostClient } from '../out/main/native-host/native-host-client.js'
import { assertPeMachine, PE_MACHINE_X86 } from './windows-pe-architecture.mjs'
import {
  encodeNativeHostFrame,
  NativeHostFrameDecoder,
  NativeHostFrameType,
  NATIVE_HOST_PROTOCOL_VERSION
} from '../out/main/native-host/protocol.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_EXE ??
  path.join(root, 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe'))
const testOutputRoot = path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_OUTPUT_ROOT ??
  path.join(os.tmpdir(), `ZTools-native-host32-${randomUUID()}`))
const configuredScreenCaptureFixtureRoot = process.env.ZTOOLS_NATIVE_HOST32_SCREEN_CAPTURE_FIXTURE_DIR
const screenCaptureFixtureRoot = configuredScreenCaptureFixtureRoot
  ? (() => {
      assert.ok(
        path.isAbsolute(configuredScreenCaptureFixtureRoot),
        'ZTOOLS_NATIVE_HOST32_SCREEN_CAPTURE_FIXTURE_DIR must be an absolute path'
      )
      return path.resolve(configuredScreenCaptureFixtureRoot)
    })()
  : path.join(root, '..', 'DLLPlugins', 'screenshot', 'Release')
const configuredInvalidAbiFixture = process.env.ZTOOLS_NATIVE_HOST32_INVALID_ABI_FIXTURE
const invalidAbiFixtureSource = configuredInvalidAbiFixture
  ? (() => {
      assert.ok(
        path.isAbsolute(configuredInvalidAbiFixture),
        'ZTOOLS_NATIVE_HOST32_INVALID_ABI_FIXTURE must be an absolute path'
      )
      return path.resolve(configuredInvalidAbiFixture)
    })()
  : path.join(root, 'out', 'native', 'test-win32-ia32', 'ZToolsNativeAbiRejectionFixture.dll')

function hostEnvironment(secret) {
  const environment = { ...process.env }
  const names = new Set([
    'ZTOOLS_NATIVE_HOST_TOKEN',
    'ZTOOLS_NATIVE_PLUGIN_ROOT',
    'ZTOOLS_NATIVE_MANIFEST_SHA256'
  ])
  for (const name of Object.keys(environment)) {
    if (names.has(name.toLocaleUpperCase('en-US'))) delete environment[name]
  }
  environment.ZTOOLS_NATIVE_HOST_TOKEN = secret.toString('hex')
  return environment
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function copyScreenCaptureRuntimeDlls(sourceRoot, targetRoot) {
  const files = []
  const pendingDirectories = [sourceRoot]
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = path.join(currentDirectory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`screen capture runtime must not contain symlinks: ${sourcePath}`)
      }
      if (entry.isDirectory()) {
        pendingDirectories.push(sourcePath)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase('en-US') !== '.dll' ||
          path.basename(sourcePath).toLocaleLowerCase('en-US') === 'screencaptureplugin.dll') {
        continue
      }

      const relativePath = path.relative(sourceRoot, sourcePath)
      const targetPath = path.resolve(targetRoot, relativePath)
      const relativeTarget = path.relative(targetRoot, targetPath)
      assert.ok(
        relativeTarget !== '' && !relativeTarget.startsWith(`..${path.sep}`) &&
          relativeTarget !== '..' && !path.isAbsolute(relativeTarget),
        `screen capture runtime dependency escaped its isolated plugin directory: ${relativePath}`
      )
      assertPeMachine(sourcePath, PE_MACHINE_X86, path.basename(sourcePath))
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.copyFile(sourcePath, targetPath)
      const sourceBytes = await fs.readFile(sourcePath)
      const targetBytes = await fs.readFile(targetPath)
      assert.equal(sha256(targetBytes), sha256(sourceBytes), `runtime dependency copy mismatch: ${relativePath}`)
      files.push({
        relativePath: relativePath.split(path.sep).join('/'),
        sourcePath,
        targetPath,
        size: targetBytes.length,
        sha256: sha256(targetBytes)
      })
    }
  }
  return files
}

function isolateScreenCaptureRuntimeEnvironment(sourceRoot, targetRoot) {
  const pathKey = Object.keys(process.env).find((key) => key.toLocaleUpperCase('en-US') === 'PATH')
  assert.ok(pathKey, 'PATH is required to isolate the screen capture runtime')
  const sourcePath = path.resolve(sourceRoot).toLocaleLowerCase('en-US')
  const pathEntries = (process.env[pathKey] ?? '').split(path.delimiter)
  let removedSourceEntries = 0
  const isolatedPathEntries = pathEntries.filter((entry) => {
    const candidate = entry.trim().replace(/^"(.*)"$/u, '$1')
    if (!candidate) return false
    if (path.resolve(candidate).toLocaleLowerCase('en-US') === sourcePath) {
      removedSourceEntries += 1
      return false
    }
    return true
  })
  process.env[pathKey] = isolatedPathEntries.join(path.delimiter)
  process.env.QT_QPA_PLATFORM_PLUGIN_PATH = path.join(targetRoot, 'platforms')
  process.env.QT_QPA_PLATFORM = 'windows'
  assert.equal(
    process.env[pathKey].split(path.delimiter).some((entry) =>
      path.resolve(entry).toLocaleLowerCase('en-US') === sourcePath),
    false,
    'screen capture source fixture must not remain on the NativeHost32 PATH'
  )
  return {
    pathKey,
    path: process.env[pathKey],
    removedSourceEntries,
    qtQpaPlatform: process.env.QT_QPA_PLATFORM,
    qtQpaPlatformPluginPath: process.env.QT_QPA_PLATFORM_PLUGIN_PATH
  }
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs))
  ])
}

function runTextCommand(file, args, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${path.basename(file)} timeout`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (code === 0) finish(undefined, stdout)
      else finish(new Error(`${path.basename(file)} exited with ${code}: ${stderr}`))
    })
  })
}

async function waitForChildProcess(parentPid, imageName, timeoutMs = 5_000) {
  const escapedImageName = imageName.replaceAll("'", "''")
  const script = `$items = @(Get-CimInstance Win32_Process -Filter "Name='${escapedImageName}'" | ` +
    `Where-Object { $_.ParentProcessId -eq ${parentPid} } | ` +
    'ForEach-Object { [int]$_.ProcessId }); ' +
    '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $items))'
  const deadline = Date.now() + timeoutMs
  do {
    const output = await runTextCommand(
      'powershell.exe', ['-NoProfile', '-Command', script]
    )
    const processIds = JSON.parse(output)
    if (processIds.length > 0) return processIds[0]
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`${imageName} did not start under process ${parentPid}`)
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  do {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`process ${pid} did not exit`)
}

function waitForFrame(child) {
  const decoder = new NativeHostFrameDecoder()
  return withTimeout(new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      try {
        const frames = decoder.push(chunk)
        if (frames[0]) resolve(frames[0])
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`host exited before response: ${code}`)))
  }), 5_000, 'raw host response')
}

async function verifyAuthenticationFailure() {
  const bootstrapSecret = randomBytes(32)
  const wrongSecret = randomBytes(32)
  const sessionId = randomUUID()
  const requestId = randomUUID()
  const nonce = randomBytes(32)
  const proof = createHmac('sha256', wrongSecret)
    .update(Buffer.from('ztools-native-host-client-v1\0', 'ascii'))
    .update(Buffer.from(sessionId, 'utf8'))
    .update(Buffer.from([0]))
    .update(nonce)
    .digest()
  const child = spawn(executable, [], {
    env: hostEnvironment(bootstrapSecret),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const responsePromise = waitForFrame(child)
  const exitPromise = withTimeout(new Promise((resolve) => child.once('exit', resolve)), 5_000, 'auth failure exit')
  child.stdin.end(encodeNativeHostFrame({
    protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
    type: NativeHostFrameType.Hello,
    sessionId,
    requestId,
    pluginId: '',
    dllId: '',
    method: 'hello',
    payload: Buffer.concat([nonce, proof])
  }))
  const response = await responsePromise
  assert.equal(response.type, NativeHostFrameType.Error)
  assert.equal(JSON.parse(response.payload.toString('utf8')).code, 'AUTH_FAILED')
  const exitCode = await exitPromise
  assert.equal(exitCode, 13)
  bootstrapSecret.fill(0)
  wrongSecret.fill(0)
  nonce.fill(0)
  proof.fill(0)
}

async function verifyProtocolFailure() {
  const bootstrapSecret = randomBytes(32)
  const child = spawn(executable, [], {
    env: hostEnvironment(bootstrapSecret),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const responsePromise = waitForFrame(child)
  const exitPromise = withTimeout(new Promise((resolve) => child.once('exit', resolve)), 5_000, 'protocol failure exit')
  child.stdin.end(encodeNativeHostFrame({
    protocolVersion: NATIVE_HOST_PROTOCOL_VERSION + 1,
    type: NativeHostFrameType.Hello,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    pluginId: '',
    dllId: '',
    method: 'hello',
    payload: Buffer.alloc(64)
  }))
  const response = await responsePromise
  assert.equal(response.type, NativeHostFrameType.Error)
  assert.equal(JSON.parse(response.payload.toString('utf8')).code, 'PROTOCOL_MISMATCH')
  const exitCode = await exitPromise
  assert.equal(exitCode, 13)
  bootstrapSecret.fill(0)
}

async function verifyOversizedFrameFailure() {
  const bootstrapSecret = randomBytes(32)
  const child = spawn(executable, [], {
    env: hostEnvironment(bootstrapSecret),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(1024 * 1024 + 1)
  child.stdin.end(prefix)
  const exitCode = await withTimeout(new Promise((resolve) => child.once('exit', resolve)), 5_000, 'oversized frame exit')
  assert.equal(exitCode, 12)
  bootstrapSecret.fill(0)
}

async function verifyTruncatedPrefixFailure() {
  const bootstrapSecret = randomBytes(32)
  const child = spawn(executable, [], {
    env: hostEnvironment(bootstrapSecret),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdin.end(Buffer.from([40, 0]))
  const exitCode = await withTimeout(new Promise((resolve) => child.once('exit', resolve)), 5_000, 'truncated prefix exit')
  assert.equal(exitCode, 12)
  bootstrapSecret.fill(0)
}

async function verifyClientLifecycle() {
  const client = new NativeHostClient(executable)
  await client.start()
  assert.equal(client.state, 'ready')
  assert.ok(client.diagnostics.pid)

  const ping = Buffer.from('{"ping":"m3-002"}')
  assert.deepEqual(await client.request('ping', ping), ping)
  await assert.rejects(
    () => client.request('ping', Buffer.from('{}'), { pluginId: '../escape' }),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    () => client.request('unknown_method', Buffer.from('{}')),
    (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostProtocol
  )
  assert.equal(client.state, 'ready')

  await client.stop()
  assert.equal(client.state, 'closed')
  assert.equal(client.diagnostics.pid, undefined)
}

function manifestXml(pathValue, x86Digest, x64Digest, pluginId = 'plugin.test', extraPlugins = '') {
  return `<?xml version="1.0" encoding="utf-8"?>
<nativeHostManifest version="1">
  <plugin id="${pluginId}">
    <dll id="GoodPlugin" path="${pathValue}" sha256="${x86Digest}" arch="x86">
      <function name="allowed_function"/>
    </dll>
    <dll id="WrongArch" path="lib/WrongArch.dll" sha256="${x64Digest}" arch="x86">
      <function name="allowed_function"/>
    </dll>
  </plugin>
${extraPlugins}
</nativeHostManifest>
`
}

async function expectHostError(action, code, hostCode) {
  await assert.rejects(
    action,
    (error) => error instanceof ZToolsError && error.code === code &&
      (hostCode === undefined || error.details?.hostCode === hostCode)
  )
}

function waitForDllEvent(client, events, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      const recentEvents = events.slice(-5)
        .map((event) => `${event.taskId}:${event.type}`)
        .join(', ')
      reject(new Error(
        `Timed out waiting for NativeHost32 DLL event ${predicate.toString()}; ` +
        `recent events: ${recentEvents || '(none)'}`
      ))
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

function waitForLifecycleEvent(client, events, predicate, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for NativeHost32 lifecycle event'))
    }, timeoutMs)
    const finish = (event) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    }
    unsubscribe = client.onLifecycleEvent((event) => {
      if (predicate(event)) finish(event)
    })
    const existing = events.find(predicate)
    if (existing) finish(existing)
  })
}

async function verifyTaskQueryResultCompatibility() {
  const client = new NativeHostClient(executable)
  const taskId = 'task_query-result-compatibility'
  let payload = Buffer.from(JSON.stringify({
    taskId,
    mode: 'callback',
    status: 'completed',
    progress: 100,
    functionName: 'callbackTask',
    error: null
  }))
  client.request = async () => payload
  const legacyStatus = await client.queryDllTask('native-host-test', 'ZToolsNativeTestPlugin', taskId)
  assert.equal(legacyStatus.result, undefined)

  payload = Buffer.from(JSON.stringify({
    taskId,
    mode: 'callback',
    status: 'completed',
    progress: 100,
    functionName: 'callbackTask',
    error: null,
    result: '{"type":"completed","value":42}'
  }))
  const resultStatus = await client.queryDllTask('native-host-test', 'ZToolsNativeTestPlugin', taskId)
  assert.equal(resultStatus.result, '{"type":"completed","value":42}')

  payload = Buffer.from(JSON.stringify({
    taskId,
    mode: 'callback',
    status: 'completed',
    progress: 100,
    functionName: 'callbackTask',
    error: null,
    result: 42
  }))
  await assert.rejects(
    () => client.queryDllTask('native-host-test', 'ZToolsNativeTestPlugin', taskId),
    (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostProtocol
  )

  payload = Buffer.from(JSON.stringify({
    taskId,
    mode: 'callback',
    status: 'running',
    progress: 0,
    functionName: 'callbackTask',
    error: null,
    result: 'premature'
  }))
  await assert.rejects(
    () => client.queryDllTask('native-host-test', 'ZToolsNativeTestPlugin', taskId),
    (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostProtocol
  )
}

async function verifyTrustedManifestBoundary() {
  const runtime = testOutputRoot
  await fs.mkdir(runtime, { recursive: false })
  const pluginRoot = path.join(runtime, 'Plugins')
  const libraryRoot = path.join(pluginRoot, 'plugin.test', 'lib')
  const manifestPath = path.join(pluginRoot, '.ztools-native-host.xml')
  const x86Source = path.join(root, 'node_modules', 'classic-level', 'prebuilds', 'win32-ia32', 'classic-level.node')
  const x64Source = path.join(root, 'node_modules', 'classic-level', 'prebuilds', 'win32-x64', 'classic-level.node')
  const x86Target = path.join(libraryRoot, 'GoodPlugin.dll')
  const x64Target = path.join(libraryRoot, 'WrongArch.dll')
  const batchRenameSource = path.join(
    root, '..', 'DLLPlugins', 'batch-rename', 'Release', 'BatchRenamePlugin.dll'
  )
  const batchRenameAbiTest = path.join(
    root, '..', 'DLLPlugins', 'batch-rename', 'PluginTest', 'build', 'bin', 'Release',
    'BatchRenamePluginTest.exe'
  )
  const batchRenameRoot = path.join(pluginRoot, 'batch-rename', 'lib')
  const batchRenameTarget = path.join(batchRenameRoot, 'BatchRenamePlugin.dll')
  const clipboardManagerSource = path.join(
    root, 'out', 'native', 'plugin-tests', 'clipboard-manager-build-win32', 'Release',
    'ClipboardManagerPlugin.dll'
  )
  const clipboardManagerRoot = path.join(pluginRoot, 'clipboard-manager', 'lib')
  const clipboardManagerTarget = path.join(
    clipboardManagerRoot, 'ClipboardManagerPlugin.dll'
  )
  const screenCaptureSourceRoot = screenCaptureFixtureRoot
  const screenCaptureDllSource = path.join(screenCaptureSourceRoot, 'ScreenCapturePlugin.dll')
  const screenCaptureWorkerSource = path.join(screenCaptureSourceRoot, 'ScreenCapturePlugin.exe')
  const screenCaptureRoot = path.join(pluginRoot, 'screencapture', 'lib')
  const screenCaptureDllTarget = path.join(screenCaptureRoot, 'ScreenCapturePlugin.dll')
  const screenCaptureWorkerTarget = path.join(screenCaptureRoot, 'ScreenCapturePlugin.exe')
  const invalidAbiFixtureRoot = path.join(pluginRoot, 'native-abi-rejection', 'lib')
  const invalidAbiFixtureTarget = path.join(
    invalidAbiFixtureRoot, 'ZToolsNativeAbiRejectionFixture.dll'
  )
  const fixtureSource = path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_PLUGIN ??
    path.join(root, 'out', 'native', 'test-win32-ia32', 'ZToolsNativeTestPlugin.dll'))
  const fixtureRoot = path.join(pluginRoot, 'native-host-test', 'lib')
  const fixtureTarget = path.join(fixtureRoot, 'ZToolsNativeTestPlugin.dll')
  const abiTestOutput = await runTextCommand(
    batchRenameAbiTest, [batchRenameSource], 35_000
  )
  assert.match(abiTestOutput, /结果: 10\/10 通过/u)
  assertPeMachine(screenCaptureDllSource, PE_MACHINE_X86, 'ScreenCapturePlugin.dll')
  assertPeMachine(screenCaptureWorkerSource, PE_MACHINE_X86, 'ScreenCapturePlugin.exe')
  assertPeMachine(invalidAbiFixtureSource, PE_MACHINE_X86, 'ZToolsNativeAbiRejectionFixture.dll')
  await fs.mkdir(libraryRoot, { recursive: true })
  await fs.mkdir(batchRenameRoot, { recursive: true })
  await fs.mkdir(clipboardManagerRoot, { recursive: true })
  await fs.mkdir(screenCaptureRoot, { recursive: true })
  await fs.mkdir(invalidAbiFixtureRoot, { recursive: true })
  await fs.mkdir(fixtureRoot, { recursive: true })
  await fs.copyFile(x86Source, x86Target)
  await fs.copyFile(x64Source, x64Target)
  await fs.copyFile(batchRenameSource, batchRenameTarget)
  await fs.copyFile(clipboardManagerSource, clipboardManagerTarget)
  await fs.copyFile(screenCaptureDllSource, screenCaptureDllTarget)
  await fs.copyFile(screenCaptureWorkerSource, screenCaptureWorkerTarget)
  await fs.copyFile(invalidAbiFixtureSource, invalidAbiFixtureTarget)
  assert.equal(
    sha256(await fs.readFile(screenCaptureDllTarget)),
    sha256(await fs.readFile(screenCaptureDllSource)),
    'isolated screen capture DLL copy must match the selected fixture'
  )
  assert.equal(
    sha256(await fs.readFile(screenCaptureWorkerTarget)),
    sha256(await fs.readFile(screenCaptureWorkerSource)),
    'isolated screen capture helper copy must match the selected fixture'
  )
  const screenCaptureRuntimeDependencies = await copyScreenCaptureRuntimeDlls(
    screenCaptureSourceRoot, screenCaptureRoot
  )
  const screenCaptureUsesDynamicQt = screenCaptureRuntimeDependencies.some((file) =>
    path.dirname(file.relativePath) === '.' && /^Qt5.+\.dll$/iu.test(path.basename(file.relativePath))
  )
  let screenCaptureRuntimeEnvironment = null
  if (screenCaptureUsesDynamicQt) {
    assert.ok(
      screenCaptureRuntimeDependencies.some((file) => file.relativePath === 'platforms/qwindows.dll'),
      'dynamic Qt screen capture fixture must provide its Windows platform plugin'
    )
    screenCaptureRuntimeEnvironment = isolateScreenCaptureRuntimeEnvironment(
      screenCaptureSourceRoot, screenCaptureRoot
    )
    assert.equal(
      await fs.readFile(path.join(screenCaptureRoot, 'platforms', 'qwindows.dll'))
        .then((bytes) => sha256(bytes)),
      screenCaptureRuntimeDependencies.find((file) => file.relativePath === 'platforms/qwindows.dll')
        .sha256
    )
  }
  const screenCaptureRuntimeEvidence = {
    sourceRoot: screenCaptureSourceRoot,
    isolatedPluginRoot: screenCaptureRoot,
    dynamicQt: screenCaptureUsesDynamicQt,
    hostEnvironment: screenCaptureRuntimeEnvironment,
    screenCaptureDll: {
      sourcePath: screenCaptureDllSource,
      isolatedPath: screenCaptureDllTarget,
      sha256: sha256(await fs.readFile(screenCaptureDllTarget))
    },
    helper: {
      sourcePath: screenCaptureWorkerSource,
      isolatedPath: screenCaptureWorkerTarget,
      sha256: sha256(await fs.readFile(screenCaptureWorkerTarget))
    },
    runtimeDependencies: screenCaptureRuntimeDependencies
  }
  await fs.writeFile(
    path.join(runtime, 'screen-capture-runtime-evidence.json'),
    `${JSON.stringify(screenCaptureRuntimeEvidence, null, 2)}\n`,
    'utf8'
  )
  console.log(`NativeHost32 screen capture fixture: ${screenCaptureSourceRoot}`)
  if (screenCaptureRuntimeEnvironment) {
    console.log(
      `NativeHost32 isolated dynamic Qt runtime: ${screenCaptureRuntimeDependencies.length} DLLs; ` +
      `source PATH entries removed: ${screenCaptureRuntimeEnvironment.removedSourceEntries}`
    )
  }
  console.log(`NativeHost32 ABI rejection fixture: ${invalidAbiFixtureSource}`)
  await fs.copyFile(fixtureSource, fixtureTarget)
  const x86Bytes = await fs.readFile(x86Target)
  const x64Bytes = await fs.readFile(x64Target)
  const batchRenameBytes = await fs.readFile(batchRenameTarget)
  const clipboardManagerBytes = await fs.readFile(clipboardManagerTarget)
  const screenCaptureBytes = await fs.readFile(screenCaptureDllTarget)
  const invalidAbiFixtureBytes = await fs.readFile(invalidAbiFixtureTarget)
  const fixtureBytes = await fs.readFile(fixtureTarget)
  const productionPluginManifest = `  <plugin id="batch-rename">
    <dll id="BatchRenamePlugin" path="lib/BatchRenamePlugin.dll" sha256="${sha256(batchRenameBytes)}" arch="x86">
      <function name="previewRename"/>
      <function name="batchRename"/>
    </dll>
  </plugin>
  <plugin id="clipboard-manager">
    <dll id="ClipboardManagerPlugin" path="lib/ClipboardManagerPlugin.dll" sha256="${sha256(clipboardManagerBytes)}" arch="x86">
      <function name="GetStatus"/>
      <function name="PasteToPreviousEditor"/>
    </dll>
  </plugin>
  <plugin id="screencapture">
    <dll id="ScreenCapturePlugin" path="lib/ScreenCapturePlugin.dll" sha256="${sha256(screenCaptureBytes)}" arch="x86">
      <function name="GetScreenList"/>
    </dll>
  </plugin>
  <plugin id="native-host-test">
    <dll id="ZToolsNativeTestPlugin" path="lib/ZToolsNativeTestPlugin.dll" sha256="${sha256(fixtureBytes)}" arch="x86">
      <function name="blockingTask"/>
      <function name="progressTask"/>
      <function name="callbackTask"/>
      <function name="spawnJobChild"/>
    </dll>
  </plugin>
  <plugin id="native-abi-rejection">
    <dll id="ZToolsNativeAbiRejectionFixture" path="lib/ZToolsNativeAbiRejectionFixture.dll" sha256="${sha256(invalidAbiFixtureBytes)}" arch="x86">
      <function name="abi_probe"/>
    </dll>
  </plugin>`
  const validManifest = manifestXml(
    'lib/GoodPlugin.dll', sha256(x86Bytes), sha256(x64Bytes), 'plugin.test', productionPluginManifest
  )
  await fs.writeFile(manifestPath, validManifest, 'utf8')

  async function verifyRejectedManifest(source, pluginId = 'plugin.test') {
    await fs.writeFile(manifestPath, source, 'utf8')
    const client = new NativeHostClient(executable, {
      pluginRoot,
      trustedManifestSha256: sha256(Buffer.from(source, 'utf8'))
    })
    try {
      await client.start()
      await expectHostError(
        () => client.checkDllAccess(pluginId, 'GoodPlugin', 'allowed_function'),
        errorCodes.pluginIntegrity
      )
    } finally {
      await client.stop()
    }
  }

  const trustedClient = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: sha256(Buffer.from(validManifest, 'utf8'))
  })
  let stopCollectingEvents = () => {}
  let trustedShutdown
  let normalJobChildPid
  let normalHostPid
  let screenCaptureWorkerPid
  try {
    await trustedClient.start()
    await trustedClient.configureMouseTrigger(null)
    await trustedClient.configureMouseTrigger({
      button: 'middle',
      action: 'long',
      longPressMs: 275
    })
    await trustedClient.configureMouseTrigger(null)
    const dllEvents = []
    stopCollectingEvents = trustedClient.onDllEvent((event) => dllEvents.push(event))
    await trustedClient.checkDllAccess('plugin.test', 'GoodPlugin', 'allowed_function')
    const clipboardInfo = await trustedClient.getDllInfo(
      'clipboard-manager', 'ClipboardManagerPlugin'
    )
    assert.equal(clipboardInfo.pluginName, 'ClipboardManagerPlugin')
    assert.ok(clipboardInfo.functions.includes('GetStatus'))
    const clipboardStatus = await trustedClient.callDll(
      'clipboard-manager', 'ClipboardManagerPlugin', 'GetStatus', {}
    )
    assert.equal(clipboardStatus.code, 0)
    assert.deepEqual(JSON.parse(clipboardStatus.result), {
      plugin: 'ClipboardManagerPlugin',
      success: true,
      version: '1.0.0'
    })
    await trustedClient.unloadDll('clipboard-manager', 'ClipboardManagerPlugin')
    const info = await trustedClient.getDllInfo('batch-rename', 'BatchRenamePlugin')
    assert.equal(info.pluginName, 'BatchRenamePlugin')
    assert.equal(info.version, '1.0.0')
    assert.ok(info.functions.includes('previewRename'))
    assert.equal(info.supportsAsync, true)
    assert.equal(info.supportsCallback, true)
    assert.equal(info.supportsCancel, true)
    await expectHostError(
      () => trustedClient.getDllInfo(
        'native-abi-rejection', 'ZToolsNativeAbiRejectionFixture'
      ),
      errorCodes.nativeHostProtocol,
      'DLL_EXPORTS_INVALID'
    )
    const call = await trustedClient.callDll(
      'batch-rename', 'BatchRenamePlugin', 'previewRename', { files: [] }
    )
    assert.equal(call.code, 0)
    assert.deepEqual(JSON.parse(call.result), { results: [] })
    await expectHostError(
      () => trustedClient.callDll('batch-rename', 'BatchRenamePlugin', 'getFileList', {}),
      errorCodes.permissionDenied
    )

    const completedTask = await trustedClient.callDllAsync(
      'native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', {}
    )
    const completedProgress = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === completedTask && event.type === 'progress' && event.percent === 100
    )
    assert.deepEqual(JSON.parse(completedProgress.message), { ok: true })
    const completedReturn = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === completedTask && event.type === 'async-return'
    )
    assert.equal(completedReturn.call.code, 0)
    assert.equal(JSON.parse(completedReturn.call.result).result, completedTask)
    const completedStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', completedTask
    )
    assert.equal(completedStatus.status, 'completed')
    assert.equal(completedStatus.result, completedReturn.call.result)
    await trustedClient.clearDllTask('native-host-test', 'ZToolsNativeTestPlugin', completedTask)

    const fullProgressPendingTask = await trustedClient.callDllAsync(
      'native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', {
        holdAtFullProgress: true
      }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === fullProgressPendingTask &&
        event.type === 'progress' && event.percent === 100
    )
    const fullProgressPendingStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', fullProgressPendingTask
    )
    assert.equal(fullProgressPendingStatus.progress, 100)
    assert.equal(fullProgressPendingStatus.status, 'running')
    const fullProgressPendingReturn = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === fullProgressPendingTask && event.type === 'async-return'
    )
    assert.equal(fullProgressPendingReturn.call.code, 0)
    const fullProgressCompletedStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', fullProgressPendingTask
    )
    assert.equal(fullProgressCompletedStatus.status, 'completed')
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', fullProgressPendingTask
    )

    const regressingAsyncTask = await trustedClient.callDllAsync(
      'native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', {
        regressingProgress: true
      }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === regressingAsyncTask && event.type === 'progress' &&
        event.percent === 80
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === regressingAsyncTask && event.type === 'progress' &&
        event.percent === 12
    )
    const regressingAsyncStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', regressingAsyncTask
    )
    assert.equal(regressingAsyncStatus.status, 'running')
    assert.equal(regressingAsyncStatus.progress, 80)
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === regressingAsyncTask && event.type === 'async-return'
    )
    const regressingAsyncCompleted = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', regressingAsyncTask
    )
    assert.equal(regressingAsyncCompleted.status, 'completed')
    assert.equal(regressingAsyncCompleted.result, '{"result":"' + regressingAsyncTask + '"}')
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', regressingAsyncTask
    )

    const silentAsyncTask = await trustedClient.callDllAsync(
      'native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', { silent: true }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === silentAsyncTask && event.type === 'async-return'
    )
    const silentAsyncStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', silentAsyncTask
    )
    assert.equal(silentAsyncStatus.status, 'completed')
    assert.equal(silentAsyncStatus.result, '{"result":"' + silentAsyncTask + '"}')
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', silentAsyncTask
    )

    const jobChildCall = await trustedClient.callDll(
      'native-host-test', 'ZToolsNativeTestPlugin', 'spawnJobChild', {}
    )
    normalJobChildPid = JSON.parse(jobChildCall.result).pid
    normalHostPid = trustedClient.diagnostics.pid
    assert.ok(normalJobChildPid > 0)
    assert.ok(normalHostPid)
    assert.doesNotThrow(() => process.kill(normalJobChildPid, 0))

    const cancelledTask = await trustedClient.callDllAsync(
      'native-host-test', 'ZToolsNativeTestPlugin', 'progressTask', { slow: true }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === cancelledTask && event.type === 'progress' && event.percent === 10
    )
    assert.equal(await trustedClient.cancelDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', cancelledTask
    ), 0)
    assert.equal((await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', cancelledTask
    )).status, 'running')
    await expectHostError(
      () => trustedClient.clearDllTask(
        'native-host-test', 'ZToolsNativeTestPlugin', cancelledTask
      ),
      errorCodes.dllError,
      'DLL_BUSY'
    )
    const cancelledEvent = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === cancelledTask && event.type === 'cancelled',
      7_000
    )
    assert.equal(cancelledEvent.code, 0)
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === cancelledTask && event.type === 'async-return'
    )
    const cancelledStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', cancelledTask
    )
    assert.equal(cancelledStatus.status, 'cancelled')
    assert.equal(cancelledStatus.result, '{"result":"' + cancelledTask + '"}')
    assert.equal(await trustedClient.cancelDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', cancelledTask
    ), 0)
    await trustedClient.clearDllTask('native-host-test', 'ZToolsNativeTestPlugin', cancelledTask)

    const callbackTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', {}
    )
    const callbackResult = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === callbackTask && event.type === 'callback-result'
    )
    assert.deepEqual(JSON.parse(callbackResult.result), { value: 42 })
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === callbackTask && event.type === 'callback-return'
    )
    const callbackStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', callbackTask
    )
    assert.equal(callbackStatus.status, 'completed')
    assert.equal(callbackStatus.result, callbackResult.result)
    await expectHostError(
      () => trustedClient.unloadDll('native-host-test', 'ZToolsNativeTestPlugin'),
      errorCodes.dllError,
      'DLL_BUSY'
    )
    await expectHostError(
      () => trustedClient.queryDllTask('batch-rename', 'BatchRenamePlugin', callbackTask),
      errorCodes.dllError,
      'DLL_TASK_NOT_FOUND'
    )
    await trustedClient.clearDllTask('native-host-test', 'ZToolsNativeTestPlugin', callbackTask)
    await expectHostError(
      () => trustedClient.queryDllTask(
        'native-host-test', 'ZToolsNativeTestPlugin', callbackTask
      ),
      errorCodes.dllError,
      'DLL_TASK_NOT_FOUND'
    )

    const oversizedResultTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', {
        callbackMode: 'oversized-result'
      }
    )
    const oversizedResultEvent = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === oversizedResultTask && event.type === 'callback-result'
    )
    assert.equal(oversizedResultEvent.result.length, 200_000)
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === oversizedResultTask && event.type === 'callback-return'
    )
    await expectHostError(
      () => trustedClient.queryDllTask(
        'native-host-test', 'ZToolsNativeTestPlugin', oversizedResultTask
      ),
      errorCodes.nativeHostProtocol,
      'DLL_TASK_RESULT_TOO_LARGE'
    )
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', oversizedResultTask
    )

    const envelopeProgressTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { callbackMode: 'progress' }
    )
    const envelopeProgress = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeProgressTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'progress'
    )
    assert.equal(JSON.parse(envelopeProgress.result).progress, 80)
    assert.equal(JSON.parse(envelopeProgress.result).data.status, 'completed')
    assert.equal((await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeProgressTask
    )).status, 'running')
    const envelopeRegressingProgress = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeProgressTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'progress' && JSON.parse(event.result).progress === 12
    )
    assert.equal(JSON.parse(envelopeRegressingProgress.result).data.progress, 20)
    const progressStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeProgressTask
    )
    assert.equal(progressStatus.status, 'running')
    assert.equal(progressStatus.progress, 80)
    const envelopeCompleted = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeProgressTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'completed'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeProgressTask && event.type === 'callback-return'
    )
    const envelopeCompletedStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeProgressTask
    )
    assert.equal(envelopeCompletedStatus.status, 'completed')
    assert.equal(envelopeCompletedStatus.result, envelopeCompleted.result)
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeProgressTask
    )

    const dataProgressTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', {
        callbackMode: 'data-progress'
      }
    )
    const dataProgress = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === dataProgressTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'progress'
    )
    assert.equal(JSON.parse(dataProgress.result).data.progress, 42)
    assert.equal(JSON.parse(dataProgress.result).data.currentFileProgress, 97)
    const dataProgressStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', dataProgressTask
    )
    assert.equal(dataProgressStatus.progress, 42)
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === dataProgressTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'completed'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === dataProgressTask && event.type === 'callback-return'
    )
    const dataProgressCompleted = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', dataProgressTask
    )
    assert.equal(dataProgressCompleted.status, 'completed')
    assert.equal(dataProgressCompleted.result, '{"type":"completed","value":42}')
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', dataProgressTask
    )

    const envelopeErrorTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { callbackMode: 'error' }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeErrorTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'error'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeErrorTask && event.type === 'callback-return'
    )
    const envelopeErrorStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeErrorTask
    )
    assert.equal(envelopeErrorStatus.status, 'error')
    assert.equal(envelopeErrorStatus.result, '{"type":"error","message":"fixture failure"}')
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeErrorTask
    )

    const envelopeCancelledTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { callbackMode: 'cancelled' }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeCancelledTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'cancelled'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === envelopeCancelledTask && event.type === 'callback-return'
    )
    const envelopeCancelledStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeCancelledTask
    )
    assert.equal(envelopeCancelledStatus.status, 'cancelled')
    assert.equal(envelopeCancelledStatus.result, '{"type":"cancelled"}')
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', envelopeCancelledTask
    )

    const lateCallbackTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { callbackMode: 'late' }
    )
    const lateCompleted = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === lateCallbackTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'completed'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === lateCallbackTask && event.type === 'callback-return'
    )
    const lateCallbackStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', lateCallbackTask
    )
    assert.equal(lateCallbackStatus.status, 'completed')
    assert.equal(lateCallbackStatus.result, lateCompleted.result)
    await trustedClient.clearDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', lateCallbackTask
    )

    const clearedTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { slow: true }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === clearedTask && event.type === 'callback-return'
    )
    assert.equal((await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', clearedTask
    )).status, 'running')
    await expectHostError(
      () => trustedClient.clearDllTask(
        'native-host-test', 'ZToolsNativeTestPlugin', clearedTask
      ),
      errorCodes.dllError,
      'DLL_BUSY'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === clearedTask && event.type === 'callback-result'
    )
    assert.equal((await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', clearedTask
    )).status, 'completed')
    await trustedClient.clearDllTask('native-host-test', 'ZToolsNativeTestPlugin', clearedTask)
    const unloadStartedAt = Date.now()
    await expectHostError(
      () => trustedClient.unloadDll('native-host-test', 'ZToolsNativeTestPlugin'),
      errorCodes.dllError,
      'DLL_BUSY'
    )
    assert.ok(Date.now() - unloadStartedAt < 1_500)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(
      dllEvents.some((event) => event.taskId === clearedTask && event.type === 'callback-result'),
      true
    )
    await trustedClient.unloadDll('native-host-test', 'ZToolsNativeTestPlugin')
    assert.doesNotThrow(() => process.kill(normalJobChildPid, 0))

    const missingPath = path.join(runtime, 'missing-original.txt')
    const batchRenameParams = {
      files: [{
        path: missingPath,
        directory: runtime,
        oldName: 'missing-original',
        extension: '.txt'
      }],
      replaceRule: { type: 'regex', pattern: 'missing-original', replacement: 'missing-renamed' }
    }
    const batchAsyncTask = await trustedClient.callDllAsync(
      'batch-rename', 'BatchRenamePlugin', 'batchRename', batchRenameParams
    )
    const batchAsyncReturn = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === batchAsyncTask && event.type === 'async-return'
    )
    assert.equal(batchAsyncReturn.call.code, 0)
    assert.deepEqual(JSON.parse(batchAsyncReturn.call.result), {
      failCount: 1,
      results: [{
        message: '重命名失败',
        newPath: path.join(runtime, 'missing-renamed.txt'),
        oldPath: missingPath,
        success: false
      }],
      successCount: 0,
      total: 1
    })
    assert.equal((await trustedClient.queryDllTask(
      'batch-rename', 'BatchRenamePlugin', batchAsyncTask
    )).status, 'completed')
    assert.equal(
      dllEvents.some((event) => event.taskId === batchAsyncTask && event.type === 'progress'),
      false
    )
    await trustedClient.clearDllTask('batch-rename', 'BatchRenamePlugin', batchAsyncTask)

    const batchCallbackTask = await trustedClient.callDllWithCallback(
      'batch-rename',
      'BatchRenamePlugin',
      'batchRename',
      batchRenameParams
    )
    const batchProgress = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === batchCallbackTask && event.type === 'callback-result'
    )
    assert.deepEqual(JSON.parse(batchProgress.result), {
      current: 1,
      total: 1,
      percent: 100,
      successCount: 0,
      failCount: 1
    })
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === batchCallbackTask && event.type === 'callback-return'
    )
    assert.equal(await fs.stat(missingPath).then(() => true, () => false), false)
    await trustedClient.clearDllTask('batch-rename', 'BatchRenamePlugin', batchCallbackTask)
    await trustedClient.unloadDll('batch-rename', 'BatchRenamePlugin')
    assert.equal(
      (await trustedClient.getDllInfo('batch-rename', 'BatchRenamePlugin')).pluginName,
      'BatchRenamePlugin'
    )

    const screenInfo = await trustedClient.getDllInfo('screencapture', 'ScreenCapturePlugin')
    assert.equal(screenInfo.pluginName, 'ScreenCapturePlugin')
    assert.equal(screenInfo.supportsAsync, true)
    assert.equal(screenInfo.supportsCallback, true)
    assert.equal(screenInfo.supportsCancel, true)
    assert.equal(screenInfo.supportsStopManagedProcesses, true)
    const screenCall = await trustedClient.callDll(
      'screencapture', 'ScreenCapturePlugin', 'GetScreenList', {}
    )
    assert.equal(screenCall.code, 0)
    const screenCallResult = JSON.parse(screenCall.result)
    assert.equal(screenCallResult.success, true)
    assert.ok(Array.isArray(screenCallResult.screens))
    const trustedHostPid = trustedClient.diagnostics.pid
    assert.ok(trustedHostPid)
    screenCaptureWorkerPid = await waitForChildProcess(
      trustedHostPid, 'ScreenCapturePlugin.exe'
    )

    const screenAsyncTask = await trustedClient.callDllAsync(
      'screencapture', 'ScreenCapturePlugin', 'GetScreenList', {}
    )
    const screenAsyncReturn = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === screenAsyncTask && event.type === 'async-return'
    )
    assert.equal(screenAsyncReturn.call.code, 0)
    assert.equal(JSON.parse(screenAsyncReturn.call.result).success, true)
    assert.equal((await trustedClient.queryDllTask(
      'screencapture', 'ScreenCapturePlugin', screenAsyncTask
    )).status, 'completed')
    await trustedClient.clearDllTask('screencapture', 'ScreenCapturePlugin', screenAsyncTask)

    const screenCallbackTask = await trustedClient.callDllWithCallback(
      'screencapture', 'ScreenCapturePlugin', 'GetScreenList', {}
    )
    const screenCallbackReturn = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === screenCallbackTask && event.type === 'callback-return'
    )
    assert.equal(screenCallbackReturn.call.code, 0)
    const screenCallbackResult = await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === screenCallbackTask && event.type === 'callback-result'
    )
    assert.equal(JSON.parse(screenCallbackResult.result).success, true)
    assert.equal((await trustedClient.queryDllTask(
      'screencapture', 'ScreenCapturePlugin', screenCallbackTask
    )).status, 'completed')
    await trustedClient.clearDllTask('screencapture', 'ScreenCapturePlugin', screenCallbackTask)

    await expectHostError(
      () => trustedClient.checkDllAccess('plugin.test', 'GoodPlugin', 'blocked_function'),
      errorCodes.permissionDenied
    )
    await expectHostError(
      () => trustedClient.checkDllAccess('plugin.test', 'WrongArch', 'allowed_function'),
      errorCodes.pluginIntegrity
    )
    await fs.appendFile(x86Target, 'tampered')
    await expectHostError(
      () => trustedClient.checkDllAccess('plugin.test', 'GoodPlugin', 'allowed_function'),
      errorCodes.pluginIntegrity
    )
    assert.equal(
      (await trustedClient.getDllInfo(
        'native-host-test', 'ZToolsNativeTestPlugin'
      )).supportsStopManagedProcesses,
      true
    )

    const malformedTypedTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', {
        callbackMode: 'malformed-type'
      }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === malformedTypedTask && event.type === 'callback-result' &&
        event.result === '{"type":"future-status",'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === malformedTypedTask && event.type === 'callback-return'
    )
    const malformedTypedStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', malformedTypedTask
    )
    assert.equal(malformedTypedStatus.status, 'running')
    assert.equal(malformedTypedStatus.result, null)
    await expectHostError(
      () => trustedClient.clearDllTask(
        'native-host-test', 'ZToolsNativeTestPlugin', malformedTypedTask
      ),
      errorCodes.dllError,
      'DLL_BUSY'
    )

    const unknownTypedTask = await trustedClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { callbackMode: 'unknown' }
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === unknownTypedTask && event.type === 'callback-result' &&
        JSON.parse(event.result).type === 'future-status'
    )
    await waitForDllEvent(
      trustedClient,
      dllEvents,
      (event) => event.taskId === unknownTypedTask && event.type === 'callback-return'
    )
    const unknownTypedStatus = await trustedClient.queryDllTask(
      'native-host-test', 'ZToolsNativeTestPlugin', unknownTypedTask
    )
    assert.equal(unknownTypedStatus.status, 'running')
    assert.equal(unknownTypedStatus.result, null)
    await expectHostError(
      () => trustedClient.clearDllTask(
        'native-host-test', 'ZToolsNativeTestPlugin', unknownTypedTask
      ),
      errorCodes.dllError,
      'DLL_BUSY'
    )
    await expectHostError(
      () => trustedClient.unloadDll('native-host-test', 'ZToolsNativeTestPlugin'),
      errorCodes.dllError,
      'DLL_BUSY'
    )
  } finally {
    stopCollectingEvents()
    const shutdownRequest = trustedClient.stop()
    assert.strictEqual(trustedClient.stop(), shutdownRequest)
    trustedShutdown = await shutdownRequest
  }
  assert.equal(trustedShutdown.completed, true)
  assert.equal(trustedShutdown.timedOut, false)
  assert.equal(trustedShutdown.forced, false)
  assert.ok(trustedShutdown.stopAttempted >= 2)
  assert.equal(trustedShutdown.stopFailed, 0)
  assert.ok(screenCaptureWorkerPid)
  await waitForProcessExit(screenCaptureWorkerPid)
  assert.ok(normalHostPid)
  await waitForProcessExit(normalHostPid)
  assert.equal(trustedClient.diagnostics.exitCode, 0)
  assert.ok(normalJobChildPid)
  await waitForProcessExit(normalJobChildPid)
  assert.ok(trustedShutdown.sessionsUnloaded >= 1)
  assert.equal(trustedShutdown.remainingTasks, 0)
  assert.equal(trustedShutdown.remainingActiveInvocations, 0)

  const timeoutClient = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: sha256(Buffer.from(validManifest, 'utf8'))
  })
  let stopCollectingTimeoutEvents = () => {}
  try {
    await timeoutClient.start()
    const fixtureInfo = await timeoutClient.getDllInfo(
      'native-host-test', 'ZToolsNativeTestPlugin'
    )
    assert.equal(fixtureInfo.supportsStopManagedProcesses, true)
    const timeoutEvents = []
    stopCollectingTimeoutEvents = timeoutClient.onDllEvent((event) => timeoutEvents.push(event))
    const childCall = await timeoutClient.callDll(
      'native-host-test', 'ZToolsNativeTestPlugin', 'spawnJobChild', {}
    )
    const forcedJobChildPid = JSON.parse(childCall.result).pid
    assert.ok(forcedJobChildPid > 0)
    assert.doesNotThrow(() => process.kill(forcedJobChildPid, 0))
    const blockingTask = await timeoutClient.callDllAsync(
      'native-host-test', 'ZToolsNativeTestPlugin', 'blockingTask', {}
    )
    await waitForDllEvent(
      timeoutClient,
      timeoutEvents,
      (event) => event.taskId === blockingTask && event.type === 'progress' && event.percent === 10
    )
    const hostPid = timeoutClient.diagnostics.pid
    const stopStartedAt = Date.now()
    const timeoutShutdown = await timeoutClient.stop(500)
    const stopElapsedMs = Date.now() - stopStartedAt
    assert.equal(timeoutShutdown.completed, false)
    assert.equal(timeoutShutdown.timedOut, true)
    assert.equal(timeoutShutdown.forced, true)
    assert.equal(timeoutShutdown.cancelAttempted, 1)
    assert.equal(timeoutShutdown.cancelFailed, 0)
    assert.equal(timeoutShutdown.stopAttempted, 0)
    assert.equal(timeoutShutdown.remainingTasks, 1)
    assert.equal(timeoutShutdown.remainingActiveInvocations, 1)
    assert.ok(stopElapsedMs < 2_000)
    assert.equal(timeoutClient.state, 'closed')
    assert.ok(hostPid)
    assert.throws(() => process.kill(hostPid, 0))
    assert.equal(timeoutClient.diagnostics.exitCode, 18)
    await waitForProcessExit(forcedJobChildPid)
  } finally {
    stopCollectingTimeoutEvents()
    await timeoutClient.stop()
  }

  const gracefulClient = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: sha256(Buffer.from(validManifest, 'utf8'))
  })
  const gracefulEvents = []
  const stopCollectingGracefulEvents = gracefulClient.onDllEvent((event) => {
    gracefulEvents.push(event)
  })
  try {
    await gracefulClient.start()
    await gracefulClient.getDllInfo('native-host-test', 'ZToolsNativeTestPlugin')
    const childCall = await gracefulClient.callDll(
      'native-host-test', 'ZToolsNativeTestPlugin', 'spawnJobChild', {}
    )
    const gracefulJobChildPid = JSON.parse(childCall.result).pid
    assert.ok(gracefulJobChildPid > 0)
    assert.doesNotThrow(() => process.kill(gracefulJobChildPid, 0))
    const slowTask = await gracefulClient.callDllWithCallback(
      'native-host-test', 'ZToolsNativeTestPlugin', 'callbackTask', { verySlow: true }
    )
    await waitForDllEvent(
      gracefulClient,
      gracefulEvents,
      (event) => event.taskId === slowTask && event.type === 'callback-return'
    )
    const gracefulStopStartedAt = Date.now()
    const gracefulShutdown = await gracefulClient.stop()
    const gracefulStopElapsedMs = Date.now() - gracefulStopStartedAt
    assert.equal(gracefulShutdown.completed, true)
    assert.equal(gracefulShutdown.timedOut, false)
    assert.equal(gracefulShutdown.forced, false)
    assert.ok(gracefulStopElapsedMs >= 6_000 && gracefulStopElapsedMs < 12_000)
    assert.equal(gracefulClient.diagnostics.exitCode, 0)
    await waitForProcessExit(gracefulJobChildPid)
  } finally {
    stopCollectingGracefulEvents()
    await gracefulClient.stop()
  }

  const recoveryClient = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: sha256(Buffer.from(validManifest, 'utf8'))
  })
  const lifecycleEvents = []
  const stopCollectingLifecycleEvents = recoveryClient.onLifecycleEvent((event) => {
    lifecycleEvents.push(event)
  })
  try {
    await recoveryClient.start()
    await recoveryClient.getDllInfo('native-host-test', 'ZToolsNativeTestPlugin')
    const firstPid = recoveryClient.diagnostics.pid
    assert.ok(firstPid)
    const pendingCall = recoveryClient.callDll(
      'native-host-test', 'ZToolsNativeTestPlugin', 'blockingTask', {}
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    process.kill(firstPid)
    await assert.rejects(
      pendingCall,
      (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostCrashed
    )
    await assert.rejects(
      () => recoveryClient.request('ping', Buffer.from('{}')),
      (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostCrashed
    )

    const firstRestart = await waitForLifecycleEvent(
      recoveryClient,
      lifecycleEvents,
      (event) => event.type === 'restarted' && event.attempt === 1
    )
    assert.ok(firstRestart.pid)
    assert.notEqual(firstRestart.pid, firstPid)
    await recoveryClient.getDllInfo('native-host-test', 'ZToolsNativeTestPlugin')

    for (const attempt of [2, 3]) {
      const currentPid = recoveryClient.diagnostics.pid
      assert.ok(currentPid)
      const restarted = waitForLifecycleEvent(
        recoveryClient,
        lifecycleEvents,
        (event) => event.type === 'restarted' && event.attempt === attempt
      )
      process.kill(currentPid)
      const event = await restarted
      assert.ok(event.pid)
      assert.notEqual(event.pid, currentPid)
    }

    const exhaustedPid = recoveryClient.diagnostics.pid
    assert.ok(exhaustedPid)
    const exhausted = waitForLifecycleEvent(
      recoveryClient,
      lifecycleEvents,
      (event) => event.type === 'restart-exhausted'
    )
    process.kill(exhaustedPid)
    const exhaustedEvent = await exhausted
    assert.equal(exhaustedEvent.failuresInWindow, 4)
    assert.equal(recoveryClient.state, 'crashed')
    assert.equal(recoveryClient.diagnostics.pid, undefined)
    assert.equal(recoveryClient.diagnostics.recovering, false)
    assert.throws(() => process.kill(exhaustedPid, 0))
    await assert.rejects(
      () => recoveryClient.request('ping', Buffer.from('{}')),
      (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostCrashed
    )
    assert.deepEqual(
      lifecycleEvents
        .filter((event) => event.type === 'restart-scheduled')
        .map((event) => [event.attempt, event.delayMs]),
      [[1, 250], [2, 500], [3, 1_000]]
    )
    assert.equal(lifecycleEvents.filter((event) => event.type === 'crashed').length, 4)
    assert.equal(lifecycleEvents.filter((event) => event.type === 'restarted').length, 3)
  } finally {
    stopCollectingLifecycleEvents()
    await recoveryClient.stop()
  }

  const stoppingRecoveryClient = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: sha256(Buffer.from(validManifest, 'utf8'))
  })
  const stoppingLifecycleEvents = []
  const stopCollectingStoppingEvents = stoppingRecoveryClient.onLifecycleEvent((event) => {
    stoppingLifecycleEvents.push(event)
  })
  try {
    await stoppingRecoveryClient.start()
    const hostPid = stoppingRecoveryClient.diagnostics.pid
    assert.ok(hostPid)
    const scheduled = waitForLifecycleEvent(
      stoppingRecoveryClient,
      stoppingLifecycleEvents,
      (event) => event.type === 'restart-scheduled' && event.attempt === 1
    )
    process.kill(hostPid)
    await scheduled
    await stoppingRecoveryClient.stop()
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(stoppingRecoveryClient.state, 'closed')
    assert.equal(stoppingRecoveryClient.diagnostics.pid, undefined)
    assert.equal(
      stoppingLifecycleEvents.some((event) => event.type === 'restarted'),
      false
    )
  } finally {
    stopCollectingStoppingEvents()
    await stoppingRecoveryClient.stop()
  }

  const untrustedClient = new NativeHostClient(executable, { pluginRoot })
  try {
    await untrustedClient.start()
    await expectHostError(
      () => untrustedClient.checkDllAccess('plugin.test', 'GoodPlugin', 'allowed_function'),
      errorCodes.permissionDenied
    )
    await expectHostError(
      () => untrustedClient.getDllInfo('batch-rename', 'BatchRenamePlugin'),
      errorCodes.permissionDenied
    )
  } finally {
    await untrustedClient.stop()
  }

  const wrongDigestClient = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: '0'.repeat(64)
  })
  try {
    await wrongDigestClient.start()
    await expectHostError(
      () => wrongDigestClient.checkDllAccess('plugin.test', 'GoodPlugin', 'allowed_function'),
      errorCodes.pluginIntegrity
    )
  } finally {
    await wrongDigestClient.stop()
  }

  for (const unsafePath of ['../escape.dll', 'C:/escape.dll']) {
    const unsafeManifest = manifestXml(unsafePath, sha256(x86Bytes), sha256(x64Bytes))
    await verifyRejectedManifest(unsafeManifest)
  }

  const namespacedManifest = validManifest.replace(
    '<nativeHostManifest version="1">',
    '<nativeHostManifest version="1" xmlns="urn:ztools:untrusted">'
  )
  await verifyRejectedManifest(namespacedManifest)

  const outsidePlugin = path.join(runtime, 'outside-plugin')
  await fs.mkdir(path.join(outsidePlugin, 'lib'), { recursive: true })
  await fs.copyFile(x86Source, path.join(outsidePlugin, 'lib', 'GoodPlugin.dll'))
  await fs.symlink(outsidePlugin, path.join(pluginRoot, 'plugin.link'), 'junction')
  const junctionManifest = manifestXml(
    'lib/GoodPlugin.dll', sha256(x86Bytes), sha256(x64Bytes), 'plugin.link'
  )
  await verifyRejectedManifest(junctionManifest, 'plugin.link')

  console.log(`NativeHost32 isolated fixture retained at ${runtime}`)
}

await verifyAuthenticationFailure()
await verifyProtocolFailure()
await verifyOversizedFrameFailure()
await verifyTruncatedPrefixFailure()
await verifyClientLifecycle()
await verifyTaskQueryResultCompatibility()
await verifyTrustedManifestBoundary()
console.log('NativeHost32 integration passed (auth/protocol, ordinary DLL use, production ABI, bounded shutdown, crash recovery)')
