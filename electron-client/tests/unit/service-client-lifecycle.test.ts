import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ServiceClient } from '../../src/main/service/service-client.js'

function ownPipeName(): string {
  return String.raw`\\.\pipe\ztools-f03-${randomUUID()}`
}

async function listen(server: net.Server, pipeName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipeName, resolve)
  })
}

test('an aborted lifecycle signal during secret read prevents a late owned-pipe connection', {
  skip: process.platform !== 'win32'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-service-abort-'))
  const pipeName = ownPipeName()
  const secretPath = path.join(root, 'service.key')
  let connections = 0
  const server = net.createServer((socket) => {
    connections++
    socket.destroy()
  })
  const accepted: Socket[] = []
  server.on('connection', (socket) => accepted.push(socket))
  let client: ServiceClient | undefined
  let releaseSecret!: (secret: Buffer) => void
  let secretReadStarted!: () => void
  const readStarted = new Promise<void>((resolve) => { secretReadStarted = resolve })
  const pendingSecret = new Promise<Buffer>((resolve) => { releaseSecret = resolve })
  try {
    await listen(server, pipeName)
    client = new ServiceClient(secretPath, {
      pipeName,
      readSecret: () => {
        secretReadStarted()
        return pendingSecret
      }
    })
    const controller = new AbortController()
    const start = client.start(1000, controller.signal)
    await readStarted
    controller.abort()
    releaseSecret(Buffer.alloc(32, 0x5a))

    assert.equal(await start, false)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(connections, 0)
    assert.equal(client.diagnostics.state, 'closed')
  } finally {
    client?.stop()
    for (const socket of accepted) socket.destroy()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a failed old secret read cannot change a newer ServiceClient start', {
  skip: process.platform !== 'win32'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-service-generation-'))
  const pipeName = ownPipeName()
  let connections = 0
  const accepted: Socket[] = []
  const server = net.createServer((socket) => {
    connections++
    accepted.push(socket)
  })
  let client: ServiceClient | undefined
  let releaseFirstSecret!: (error: Error) => void
  let firstReadStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => { firstReadStarted = resolve })
  let secretReadNumber = 0
  try {
    await listen(server, pipeName)
    client = new ServiceClient(path.join(root, 'unused.key'), {
      pipeName,
      readSecret: () => {
        secretReadNumber++
        if (secretReadNumber === 1) {
          firstReadStarted()
          return new Promise<Buffer>((_resolve, reject) => { releaseFirstSecret = reject })
        }
        return Promise.resolve(Buffer.alloc(32, 0x5a))
      }
    })
    const firstStart = client.start(1000)
    await firstStarted
    client.stop()
    const secondStart = client.start(1000)

    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('new ServiceClient generation did not connect')), 1000)
      server.once('connection', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await connected
    releaseFirstSecret(new Error('old secret read failed late'))
    assert.equal(await firstStart, false)
    assert.equal(client.diagnostics.state, 'authenticating')
    assert.equal(connections, 1)

    client.stop()
    assert.equal(await secondStart, false)
    assert.equal(client.diagnostics.state, 'closed')
  } finally {
    client?.stop()
    for (const socket of accepted) socket.destroy()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a successful old secret read cannot replace a newer ServiceClient connection', {
  skip: process.platform !== 'win32'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-service-success-'))
  const pipeName = ownPipeName()
  const accepted: Socket[] = []
  const server = net.createServer((socket) => accepted.push(socket))
  let client: ServiceClient | undefined
  let resolveFirstSecret!: (secret: Buffer) => void
  let firstReadStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => { firstReadStarted = resolve })
  let secretReadNumber = 0
  try {
    await listen(server, pipeName)
    client = new ServiceClient(path.join(root, 'unused.key'), {
      pipeName,
      readSecret: () => {
        secretReadNumber++
        if (secretReadNumber === 1) {
          firstReadStarted()
          return new Promise<Buffer>((resolve) => { resolveFirstSecret = resolve })
        }
        return Promise.resolve(Buffer.alloc(32, 0x5a))
      }
    })
    const firstStart = client.start(1000)
    await firstStarted
    client.stop()
    const secondStart = client.start(1000)
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('new ServiceClient generation did not connect')), 1000)
      server.once('connection', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await connected

    resolveFirstSecret(Buffer.alloc(32, 0x5a))
    assert.equal(await firstStart, false)
    assert.equal(client.diagnostics.state, 'authenticating')
    assert.equal(accepted.length, 1)

    client.stop()
    assert.equal(await secondStart, false)
    assert.equal(client.diagnostics.state, 'closed')
  } finally {
    client?.stop()
    for (const socket of accepted) socket.destroy()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
