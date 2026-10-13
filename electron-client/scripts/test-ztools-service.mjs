import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCodes, ZToolsError } from '../out/contracts/errors.js'
import { ServiceClient } from '../out/main/service/service-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeOutput = process.env.ZTOOLS_SERVICE_TEST_OUTPUT_ROOT ?? path.join(root, 'out', 'native')
const executable = path.resolve(nativeOutput, 'service-win32-ia32', 'ZToolsService.exe')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function spawnIntegrationServer(pipeName, extraArgs = []) {
  const child = spawn(executable, ['--integration-test-server', pipeName, ...extraArgs], {
    cwd: root,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 64 * 1024) stderr += String(chunk)
  })
  return { child, getStderr: () => stderr }
}

function waitForReady(server) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error('ZToolsService integration startup timed out')), 10_000)
    const onExit = (code) => {
      clearTimeout(timer)
      reject(new Error(`ZToolsService exited before ready: ${code}; ${server.getStderr()}`))
    }
    server.child.once('exit', onExit)
    server.child.stdout.setEncoding('utf8')
    server.child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (!stdout.includes('READY')) return
      clearTimeout(timer)
      server.child.off('exit', onExit)
      resolve()
    })
  })
}

function waitForExit(server) {
  return new Promise((resolve, reject) => {
    if (server.child.exitCode !== null) {
      resolve(server.child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      server.child.kill()
      reject(new Error('ZToolsService integration shutdown timed out'))
    }, 10_000)
    server.child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function runMissingPluginRootIntegration() {
  const pipeName = `\\\\.\\pipe\\ZToolsPrivilegedService.v1.integration.${process.pid}.${Date.now()}.untrusted`
  const server = spawnIntegrationServer(pipeName)
  const client = new ServiceClient({ pipeName })
  let testError
  try {
    await waitForReady(server)
    await delay(5_500)
    const started = await client.start()
    assert.equal(started, true, JSON.stringify(client.diagnostics))
    assert.equal(client.diagnostics.state, 'ready')
    await delay(5_500)
    assert.deepEqual(await client.policyStatus(), {
      manifestTrusted: false,
      systemOnlyDependencies: true,
      allowedTargetCount: 1
    })
    await assert.rejects(
      client.contextMenuCheckAdmin(),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported && error.details?.hostCode === 'MANIFEST_UNTRUSTED'
    )
    assert.equal(client.diagnostics.state, 'ready')
    await assert.rejects(
      client.request(Buffer.from('integration-probe')),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    assert.equal(client.diagnostics.state, 'ready')
  } catch (error) {
    testError = error
  } finally {
    client.stop()
    server.child.stdin.end()
  }

  assert.equal(await waitForExit(server), 0, server.getStderr())
  if (testError) throw testError
}

async function makeTrustedFixture() {
  const fixtureRoot = path.resolve(process.env.ZTOOLS_SERVICE_TEST_FIXTURE_ROOT ??
    path.join(os.tmpdir(), `ZTools-service-fixture-${randomUUID()}`))
  await fs.mkdir(fixtureRoot, { recursive: false })
  const dataRoot = path.join(fixtureRoot, 'Data')
  const serviceRoot = path.join(dataRoot, 'Service')
  const contextDllRoot = path.join(dataRoot, 'Plugins', 'context-menu', 'lib')
  const batchDllRoot = path.join(dataRoot, 'Plugins', 'batch-rename', 'lib')
  await Promise.all([
    fs.mkdir(serviceRoot, { recursive: true }),
    fs.mkdir(contextDllRoot, { recursive: true }),
    fs.mkdir(batchDllRoot, { recursive: true })
  ])
  const contextSource = path.join(
    root, '..', 'plugins', 'create-plugin', 'src', 'plugins', 'context-menu', 'lib',
    'ContextMenuPlugin.dll'
  )
  const batchSource = path.join(
    root, '..', 'plugins', 'create-plugin', 'src', 'plugins', 'batch-rename', 'lib',
    'BatchRenamePlugin.dll'
  )
  const contextTarget = path.join(contextDllRoot, 'ContextMenuPlugin.dll')
  const batchTarget = path.join(batchDllRoot, 'BatchRenamePlugin.dll')
  await Promise.all([
    fs.copyFile(contextSource, contextTarget),
    fs.copyFile(batchSource, batchTarget)
  ])
  const contextDigest = createHash('sha256').update(await fs.readFile(contextTarget)).digest('hex')
  const batchDigest = createHash('sha256').update(await fs.readFile(batchTarget)).digest('hex')
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<privilegedDllManifest version="1">
  <plugin id="context-menu">
    <dll id="ContextMenuPlugin" path="lib/ContextMenuPlugin.dll" sha256="${contextDigest}" arch="x86">
      <function name="CheckAdmin"/>
    </dll>
  </plugin>
  <plugin id="batch-rename">
    <dll id="BatchRenamePlugin" path="lib/BatchRenamePlugin.dll" sha256="${batchDigest}" arch="x86">
      <function name="batchRename"/>
    </dll>
  </plugin>
</privilegedDllManifest>
`
  await fs.writeFile(path.join(serviceRoot, 'privileged-dlls-v1.xml'), manifest, 'utf8')
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex')
  return { dataRoot, fixtureRoot, manifestSha256 }
}

async function waitForTask(client, pluginId, dllId, taskId, predicate) {
  const deadline = Date.now() + 5_000
  let status
  do {
    status = await client.queryDllTask(pluginId, dllId, taskId)
    if (predicate(status)) return status
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error(`ZToolsService task did not reach the expected state: ${JSON.stringify(status)}`)
}

async function runTrustedTaskIntegration() {
  const fixture = await makeTrustedFixture()
  const pipeName = `\\\\.\\pipe\\ZToolsPrivilegedService.v1.integration.${process.pid}.${Date.now()}.trusted`
  const server = spawnIntegrationServer(pipeName, [fixture.dataRoot, fixture.manifestSha256])
  const client = new ServiceClient({ pipeName })
  let testError
  try {
    await waitForReady(server)
    await delay(5_500)
    assert.equal(await client.start(), true, JSON.stringify(client.diagnostics))
    assert.deepEqual(await client.policyStatus(), {
      manifestTrusted: true,
      systemOnlyDependencies: true,
      allowedTargetCount: 1
    })

    assert.equal(await client.enableTaskEvents(), true)
    assert.equal(client.taskEventsEnabled, true)
    const changedTasks = new Set()
    const removeListener = client.onTaskChange((taskIds) => {
      for (const taskId of taskIds) changedTasks.add(taskId)
    })
    const expectedAdmin = await client.contextMenuCheckAdmin()
    assert.equal(typeof expectedAdmin, 'boolean')
    const asyncTaskId = `task_service_async_${Date.now()}`
    assert.equal(
      await client.callDllAsync(
        'context-menu', 'ContextMenuPlugin', 'CheckAdmin', asyncTaskId, {}
      ),
      asyncTaskId
    )
    const completed = await waitForTask(
      client,
      'context-menu',
      'ContextMenuPlugin',
      asyncTaskId,
      (status) => status.status === 'completed' && status.resultReady === true
    )
    const checkAdminResult = JSON.parse(completed.result ?? 'null')
    assert.deepEqual(checkAdminResult, { isAdmin: expectedAdmin, success: true })
    await client.clearDllTask('context-menu', 'ContextMenuPlugin', asyncTaskId)

    const callbackTaskId = `task_service_callback_${Date.now()}`
    const missingPath = path.join(fixture.fixtureRoot, 'missing.txt')
    await client.callDllWithCallback(
      'batch-rename',
      'BatchRenamePlugin',
      'batchRename',
      callbackTaskId,
      {
        files: [{
          path: missingPath,
          directory: fixture.fixtureRoot,
          oldName: 'missing',
          extension: '.txt'
        }],
        replaceRule: { type: 'regex', pattern: 'missing', replacement: 'renamed' }
      }
    )
    const eventDeadline = Date.now() + 5000
    while (!changedTasks.has(callbackTaskId) && Date.now() < eventDeadline) await delay(20)
    assert.ok(changedTasks.has(callbackTaskId), 'callback must notify without querying task status')
    assert.equal(await client.contextMenuCheckAdmin(), expectedAdmin, 'events must not consume request replies')
    const callbackStatus = await waitForTask(
      client,
      'batch-rename',
      'BatchRenamePlugin',
      callbackTaskId,
      (status) => status.status === 'running' && (status.callbackResults?.length ?? 0) > 0
    )
    assert.ok(callbackStatus.callbackResults?.some((result) => result.includes('"percent"')))
    await client.clearDllTask('batch-rename', 'BatchRenamePlugin', callbackTaskId)
    removeListener()
    console.log(`Isolated ZToolsService trust fixture retained at ${fixture.fixtureRoot}`)
  } catch (error) {
    testError = error
  } finally {
    client.stop()
    server.child.stdin.end()
  }

  assert.equal(await waitForExit(server), 0, server.getStderr())
  if (testError) throw testError
}

await runMissingPluginRootIntegration()
await runTrustedTaskIntegration()
console.log('ZToolsService x86/Node named-pipe and privileged task integration passed')
