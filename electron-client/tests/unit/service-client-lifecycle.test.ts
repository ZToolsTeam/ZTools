import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import net, { type Socket } from 'node:net'
import test from 'node:test'
import { ServiceClient } from '../../src/main/service/service-client.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'

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
  const pipeName = ownPipeName()
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
    client = new ServiceClient({
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
  }
})

for (const lateError of [new Error('late generic failure'),
  new ZToolsError(errorCodes.serviceAuthentication, 'late authentication failure'),
  new ZToolsError(errorCodes.serviceProtocol, 'late protocol failure')]) {
test(`a failed old secret read cannot change a newer ServiceClient start: ${lateError.message}`, {
  skip: process.platform !== 'win32'
}, async () => {
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
    client = new ServiceClient({
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
    releaseFirstSecret(lateError)
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
  }
})
}

test('a successful old secret read cannot replace a newer ServiceClient connection', {
  skip: process.platform !== 'win32'
}, async () => {
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
    client = new ServiceClient({
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
  }
})

test('stop() or AbortSignal during socket connecting settles start() immediately without timeout', {
  skip: process.platform !== 'win32'
}, async () => {
  const pipeName = ownPipeName()
  let client: ServiceClient | undefined
  const startedAt = Date.now()
  try {
    client = new ServiceClient({
      pipeName,
      secret: Buffer.alloc(32, 0x5a)
    })
    const controller = new AbortController()
    const startPromise = client.start(5000, controller.signal)
    // 让 createConnection 先进入 connecting 状态，再立即中止停机
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    client.stop()

    assert.equal(await startPromise, false)
    assert.ok(Date.now() - startedAt < 500, '并行停机时连接等待应立即退出，不能拖到 5000ms 超时')
    assert.equal(client.diagnostics.state, 'closed')
  } finally {
    client?.stop()
  }
})

for (const code of [errorCodes.serviceAuthentication, errorCodes.serviceProtocol]) {
  test(`current ServiceClient generation propagates the original ${code} and remains restartable`, async () => {
    const failure = new ZToolsError(code, 'typed startup failure')
    let attempts = 0
    const client = new ServiceClient({
      pipeName: ownPipeName(),
      readSecret: async () => {
        if (++attempts === 1) throw failure
        return Buffer.alloc(32, 0x5a)
      }
    })
    try {
      await assert.rejects(client.start(1000), (error: unknown) => error === failure)
      assert.equal(client.diagnostics.state, 'unavailable')
      assert.equal(client.diagnostics.lastError, code)
      assert.equal(client.diagnostics.lastErrorMessage, failure.message)
      assert.equal(await client.start(1000), false, 'a missing optional pipe still reports unavailable')
      assert.equal(client.diagnostics.lastError, errorCodes.serviceUnavailable)
    } finally {
      client.stop()
    }
  })

  for (const cancellation of ['stop', 'abort'] as const) {
    test(`${cancellation} suppresses late ${code} from the cancelled generation`, async () => {
      const failure = new ZToolsError(code, 'late cancelled failure')
      let releaseFailure!: (error: Error) => void
      let enterRead!: () => void
      const entered = new Promise<void>((resolve) => { enterRead = resolve })
      const controller = new AbortController()
      const client = new ServiceClient({
        pipeName: ownPipeName(),
        readSecret: () => {
          enterRead()
          return new Promise<Buffer>((_resolve, reject) => { releaseFailure = reject })
        }
      })
      try {
        const starting = client.start(1000, controller.signal)
        await entered
        if (cancellation === 'stop') client.stop()
        else controller.abort()
        releaseFailure(failure)
        assert.equal(await starting, false)
        assert.equal(client.diagnostics.state, 'closed')
        assert.equal(client.diagnostics.lastError, '')
        assert.equal(client.diagnostics.lastErrorMessage, '')
      } finally {
        client.stop()
      }
    })
  }
}
