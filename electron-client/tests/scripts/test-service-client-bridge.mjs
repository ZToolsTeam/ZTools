import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../out/contracts/errors.js'
import { ServiceClient } from '../../out/main/service/service-client.js'
import { ServiceBridgeTransport } from '../../out/main/service/service-transport.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = process.env.ZTOOLS_SERVICE_TEST_OUTPUT_ROOT ?? path.join(root, 'out', 'native')
const testCandidate = path.join(output, 'test-win32-ia32', 'ZToolsService.exe')
const executable = fs.existsSync(testCandidate)
  ? testCandidate
  : path.join(output, 'service-win32-ia32', 'ZToolsService.exe')
const pipeName = () => String.raw`\\.\pipe\ztools-bridge-integration-${randomUUID()}`

async function deadline(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Bridge operation exceeded ${milliseconds}ms`)), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function trackedBridge(name, timeout, owner) {
  return new ServiceBridgeTransport(executable, name, timeout, (file, args) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    owner.child = child
    owner.closed = new Promise(resolve => child.once('close', resolve))
    return child
  })
}

async function assertChildExited(owner) {
  if (!owner.child) return
  try {
    await deadline(owner.closed, 2000)
  } catch (error) {
    const child = owner.child
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
    }
    throw error
  }
  assert(owner.child.exitCode !== null || owner.child.signalCode !== null)
}

test('default native bridge rejects a separately owned fake service without sending a handshake', async () => {
  const pipe = pipeName()
  const sockets = []
  let bytes = 0
  const server = createServer(socket => {
    sockets.push(socket)
    socket.on('data', data => { bytes += data.length })
  })
  const client = new ServiceClient({ bridgeExecutable: executable, pipeName: pipe })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipe, resolve)
    })
    await assert.rejects(deadline(client.start(2000), 3000), error =>
      error instanceof ZToolsError && error.code === errorCodes.serviceAuthentication)
    assert.equal(client.diagnostics.lastError, errorCodes.serviceAuthentication)
    assert.equal(bytes, 0)
    assert.equal(sockets.length, 1)
  } finally {
    client.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

test('missing optional service returns promptly even when given a 60 second connection budget', async () => {
  const owner = {}
  const client = new ServiceClient({
    pipeName: pipeName(),
    createTransport: name => trackedBridge(name, 60000, owner)
  })
  try {
    assert.equal(await deadline(client.start(60000), 1500), false)
    assert.equal(client.diagnostics.lastError, errorCodes.serviceUnavailable)
  } finally {
    client.stop()
    await assertChildExited(owner)
  }
})

for (const cancellation of ['stop', 'abort']) {
  test(`native bridge ${cancellation} leaves no child after cancelling startup`, async () => {
    const owner = {}
    const controller = new AbortController()
    const client = new ServiceClient({
      pipeName: pipeName(),
      createTransport: name => trackedBridge(name, 60000, owner)
    })
    try {
      const starting = client.start(60000, controller.signal)
      if (cancellation === 'stop') client.stop()
      else controller.abort()
      assert.equal(await deadline(starting, 1500), false)
      assert.equal(client.diagnostics.state, 'closed')
    } finally {
      client.stop()
      await assertChildExited(owner)
    }
  })
}
