import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ServiceClient } from '../../src/main/service/service-client.js'
import {
  decodeServiceContextMenuCheckAdmin,
  decodeServiceContextMenuRestartExplorer,
  decodeServiceDllCall,
  decodeServiceDllTaskCode,
  decodeServiceDllTaskId,
  decodeServiceDllTaskStatus,
  decodeServiceDllTaskSuccess,
  decodeServicePolicyStatus,
  encodeServiceContextMenuCheckAdmin,
  encodeServiceContextMenuRestartExplorer,
  encodeServiceDllCall,
  encodeServiceDllCallAsync,
  encodeServiceDllCallWithCallback,
  encodeServiceDllTaskCancel,
  encodeServiceDllTaskClear,
  encodeServiceDllTaskQuery,
  encodeServicePolicyCheck,
  encodeServiceSubscribeTaskEvents,
  SERVICE_COMMAND_HEADER_BYTES,
  SERVICE_COMMAND_MAGIC,
  SERVICE_COMMAND_VERSION,
  SERVICE_POLICY_STATUS_BYTES,
  SERVICE_POLICY_STATUS_MAGIC,
  SERVICE_POLICY_STATUS_VERSION
} from '../../src/main/service/service-command.js'
import {
  deriveServiceSessionKey,
  encodeServiceFrame,
  makeServiceClientProof,
  makeServiceServerProof,
  openServiceFrame,
  sealServiceFrame,
  SERVICE_MAX_PAYLOAD_BYTES,
  SERVICE_NONCE_BYTES,
  SERVICE_PROOF_BYTES,
  ServiceFrameDecoder,
  ServiceFrameType,
  type ServiceFrame
} from '../../src/main/service/service-protocol.js'

const knownSecret = Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 1))

function policyStatusPayload(flags = 2, allowedTargetCount = 1): Buffer {
  const payload = Buffer.alloc(SERVICE_POLICY_STATUS_BYTES)
  payload.writeUInt32LE(SERVICE_POLICY_STATUS_MAGIC, 0)
  payload.writeUInt16LE(SERVICE_POLICY_STATUS_VERSION, 4)
  payload.writeUInt16LE(flags, 6)
  payload.writeUInt32LE(allowedTargetCount, 8)
  return payload
}

function pipeName(name: string): string {
  return `\\\\.\\pipe\\ztools-service-${process.pid}-${Date.now()}-${name}`
}

function listen(server: Server, pipe: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipe, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function write(socket: Socket, frame: ServiceFrame): void {
  socket.write(encodeServiceFrame(frame))
}

function createAuthenticatedServer(secret?: Buffer, scheduleResponse?: (send: () => void) => void,
  subscribe?: (emit: (ids: string[], sequence: bigint, corrupt?: boolean) => void) => void): Server {
  return createServer((socket) => {
    const decoder = new ServiceFrameDecoder()
    let state: 'hello' | 'auth' | 'ready' = 'hello'
    let clientNonce: Buffer | null = null
    let serverNonce: Buffer | null = null
    let sessionKey: Buffer | null = null
    socket.on('data', (chunk) => {
      try {
        for (const incoming of decoder.push(chunk)) {
          if (state === 'hello') {
            assert.equal(incoming.type, ServiceFrameType.ClientHello)
            assert.equal(incoming.flags, 0)
            assert.equal(incoming.payload.length, SERVICE_NONCE_BYTES)
            clientNonce = Buffer.from(incoming.payload)
            serverNonce = randomBytes(SERVICE_NONCE_BYTES)
            const proof = makeServiceServerProof(secret ?? serverNonce, process.pid, clientNonce, serverNonce)
            write(socket, {
              type: ServiceFrameType.ServerHello,
              flags: 0,
              requestId: incoming.requestId,
              payload: Buffer.concat([serverNonce, proof])
            })
            proof.fill(0)
            state = 'auth'
            continue
          }
          if (state === 'auth') {
            assert(clientNonce && serverNonce)
            assert.equal(incoming.type, ServiceFrameType.ClientAuth)
            const expected = makeServiceClientProof(secret ?? serverNonce, process.pid, clientNonce, serverNonce)
            assert.equal(incoming.payload.length, SERVICE_PROOF_BYTES)
            assert.equal(incoming.payload.equals(expected), true)
            expected.fill(0)
            sessionKey = deriveServiceSessionKey(secret ?? serverNonce, process.pid, clientNonce, serverNonce)
            write(socket, sealServiceFrame(sessionKey, 'service-to-client', {
              type: ServiceFrameType.Response,
              flags: 0,
              requestId: incoming.requestId,
              payload: Buffer.from('AUTHENTICATED', 'ascii')
            }))
            state = 'ready'
            continue
          }
          assert(sessionKey)
          const request = openServiceFrame(sessionKey, 'client-to-service', incoming)
          assert.equal(request.type, ServiceFrameType.Request)
          const policyCheck = request.payload.equals(encodeServicePolicyCheck())
          const checkAdmin = request.payload.equals(encodeServiceContextMenuCheckAdmin())
          const restartExplorer = request.payload.equals(
            encodeServiceContextMenuRestartExplorer()
          )
          const subscription = Boolean(subscribe) && request.payload.equals(encodeServiceSubscribeTaskEvents())
          const accepted = policyCheck || checkAdmin || restartExplorer || subscription
          const response = sealServiceFrame(sessionKey, 'service-to-client', {
            type: accepted ? ServiceFrameType.Response : ServiceFrameType.Error,
            flags: 0,
            requestId: request.requestId,
            payload: subscription ? Buffer.from('{"events":true}') : policyCheck
              ? policyStatusPayload()
              : checkAdmin
                ? Buffer.from('{"isAdmin":true,"success":true}')
                : restartExplorer
                  ? Buffer.from('{"success":true}')
              : Buffer.from('NOT_SUPPORTED', 'ascii')
          })
          const send = () => write(socket, response)
          if (scheduleResponse) scheduleResponse(send)
          else send()
          if (subscription) subscribe?.((ids, sequence, corrupt = false) => {
            const event = sealServiceFrame(sessionKey!, 'service-to-client', {
              type: ServiceFrameType.TaskChanged, flags: 0, requestId: sequence,
              payload: Buffer.from(JSON.stringify(ids))
            })
            if (corrupt) event.payload[0] = event.payload[0]! ^ 1
            write(socket, event)
          })
        }
      } catch {
        socket.destroy()
      }
    })
    socket.on('close', () => {
      clientNonce?.fill(0)
      serverNonce?.fill(0)
      sessionKey?.fill(0)
    })
  })
}

test('Service HMAC known-answer vectors match the native protocol', () => {
  const clientNonce = Buffer.from(Array.from({ length: 32 }, (_value, index) => 0xa0 + index))
  const serverNonce = Buffer.from(Array.from({ length: 32 }, (_value, index) => 0xc0 + index))
  assert.equal(
    makeServiceServerProof(knownSecret, 0x12345678, clientNonce, serverNonce).toString('hex'),
    'eccc3881d58dc948eb07923dd17714c4ca2f464460a0e920e0193785b3e161fb'
  )
  assert.equal(
    makeServiceClientProof(knownSecret, 0x12345678, clientNonce, serverNonce).toString('hex'),
    '6ceaff2ec90bccac78bf70f41a49e2090aa27637a1933790c1e6ad4997bee2b0'
  )
  const sessionKey = deriveServiceSessionKey(knownSecret, 0x12345678, clientNonce, serverNonce)
  assert.equal(
    sessionKey.toString('hex'),
    '8b48aa9f93a388434dae013c9a60dc47e0c713e3aceed5ed6b02a8f36624286b'
  )
  const sealed = sealServiceFrame(sessionKey, 'client-to-service', {
    type: ServiceFrameType.Request,
    flags: 0,
    requestId: 3n,
    payload: Buffer.from('probe')
  })
  assert.equal(
    sealed.payload.subarray(-SERVICE_PROOF_BYTES).toString('hex'),
    '90bdd0a49a8ca806f5e754d4120225667fc95167ae1c1d7d9ea1a3e2a2061ccb'
  )
  assert.equal(openServiceFrame(sessionKey, 'client-to-service', sealed).payload.toString(), 'probe')
  sealed.payload[0] = (sealed.payload[0] ?? 0) ^ 1
  assert.throws(() => openServiceFrame(sessionKey, 'client-to-service', sealed))
  sessionKey.fill(0)
})

test('Service frame decoder handles fragmented and coalesced frames with strict bounds', () => {
  const first = encodeServiceFrame({
    type: ServiceFrameType.ClientHello,
    flags: 0,
    requestId: 1n,
    payload: Buffer.alloc(SERVICE_NONCE_BYTES, 1)
  })
  const second = encodeServiceFrame({
    type: ServiceFrameType.ClientAuth,
    flags: 0,
    requestId: 2n,
    payload: Buffer.alloc(SERVICE_PROOF_BYTES, 2)
  })
  const decoder = new ServiceFrameDecoder()
  assert.equal(decoder.push(first.subarray(0, 3)).length, 0)
  const frames = decoder.push(Buffer.concat([first.subarray(3), second]))
  assert.deepEqual(frames.map((frame) => frame.requestId), [1n, 2n])
  decoder.finish()
  const oversized = Buffer.alloc(4)
  oversized.writeUInt32LE(1024 * 1024 + 1)
  assert.throws(() => new ServiceFrameDecoder().push(oversized))
})

test('Service command policy codec is fixed-width and rejects unknown status bits', () => {
  const command = encodeServicePolicyCheck()
  assert.equal(command.length, SERVICE_COMMAND_HEADER_BYTES)
  assert.equal(command.readUInt32LE(0), SERVICE_COMMAND_MAGIC)
  assert.equal(command.readUInt16LE(4), SERVICE_COMMAND_VERSION)
  assert.equal(command.readUInt16LE(6), 1)
  assert.equal(command.subarray(8).equals(Buffer.alloc(16)), true)
  assert.deepEqual(decodeServicePolicyStatus(policyStatusPayload(3, 7)), {
    manifestTrusted: true,
    systemOnlyDependencies: true,
    allowedTargetCount: 7
  })
  assert.throws(
    () => decodeServicePolicyStatus(Buffer.alloc(SERVICE_POLICY_STATUS_BYTES - 1)),
    (error) => error instanceof ZToolsError && error.code === errorCodes.serviceProtocol
  )
  assert.throws(
    () => decodeServicePolicyStatus(policyStatusPayload(4)),
    (error) => error instanceof ZToolsError && error.code === errorCodes.serviceProtocol
  )
  const checkAdmin = encodeServiceContextMenuCheckAdmin()
  assert.equal(checkAdmin.readUInt16LE(6), 0x100)
  assert.equal(checkAdmin.readUInt16LE(12), Buffer.byteLength('context-menu'))
  assert.equal(checkAdmin.readUInt16LE(14), 0)
  assert.equal(checkAdmin.readUInt16LE(16), Buffer.byteLength('ContextMenuPlugin'))
  assert.equal(checkAdmin.readUInt16LE(18), Buffer.byteLength('CheckAdmin'))
  assert.equal(checkAdmin.readUInt32LE(20), 2)
  const restart = encodeServiceContextMenuRestartExplorer()
  assert.equal(restart.readUInt16LE(6), 0x500)
  assert.equal(restart.readUInt16LE(12), Buffer.byteLength('context-menu'))
  assert.equal(restart.readUInt16LE(14), Buffer.byteLength('restart-explorer'))
  assert.equal(restart.readUInt32LE(20), 0)
  const genericCall = encodeServiceDllCall(
    'context-menu',
    'ContextMenuPlugin',
    'CheckAdmin',
    { scope: 'file' }
  )
  assert.equal(genericCall.readUInt16LE(6), 0x100)
  assert.equal(genericCall.subarray(-16).toString('utf8'), '{"scope":"file"}')
  const taskId = 'task_service_protocol_1'
  const asyncCall = encodeServiceDllCallAsync(
    'context-menu', 'ContextMenuPlugin', 'CheckAdmin', taskId, { scope: 'file' }
  )
  assert.equal(asyncCall.readUInt16LE(6), 0x106)
  const asyncPayload = Buffer.from(JSON.stringify({ scope: 'file', taskId }))
  assert.deepEqual(JSON.parse(asyncCall.subarray(-asyncPayload.length).toString('utf8')), {
    scope: 'file',
    taskId
  })
  const callbackCall = encodeServiceDllCallWithCallback(
    'context-menu', 'ContextMenuPlugin', 'CheckAdmin', taskId, {}
  )
  assert.equal(callbackCall.readUInt16LE(6), 0x102)
  for (const command of [encodeServiceDllTaskQuery, encodeServiceDllTaskCancel, encodeServiceDllTaskClear]) {
    assert.equal(command('context-menu', 'ContextMenuPlugin', taskId).readUInt16LE(6) >= 0x103, true)
  }
  assert.equal(decodeServiceDllTaskId(Buffer.from(taskId), taskId), undefined)
  assert.deepEqual(
    decodeServiceDllTaskStatus(Buffer.from(JSON.stringify({
      taskId,
      mode: 'async',
      status: 'completed',
      progress: 100,
      functionName: 'CheckAdmin',
      error: null,
      resultReady: true,
      result: '{"success":true}'
    })), taskId),
    {
      taskId,
      mode: 'async',
      status: 'completed',
      progress: 100,
      functionName: 'CheckAdmin',
      error: null,
      resultReady: true,
      result: '{"success":true}'
    }
  )
  assert.equal(decodeServiceDllTaskCode(Buffer.from('{"code":0}')), 0)
  assert.equal(decodeServiceDllTaskSuccess(Buffer.from('{"success":true}')), undefined)
  assert.throws(
    () => decodeServiceDllTaskId(Buffer.from('task_other'), taskId),
    (error) => error instanceof ZToolsError && error.code === errorCodes.serviceProtocol
  )
  assert.deepEqual(
    decodeServiceDllCall(Buffer.from('{"success":true,"value":1}')),
    { success: true, value: 1 }
  )
  assert.equal(decodeServiceDllCall(Buffer.from('plain text')), 'plain text')
  assert.throws(
    () => encodeServiceDllCall('../context-menu', 'ContextMenuPlugin', 'CheckAdmin', {}),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.equal(
    decodeServiceContextMenuCheckAdmin(
      Buffer.from('{"success":true,"isAdmin":false}')
    ),
    false
  )
  assert.equal(
    decodeServiceContextMenuRestartExplorer(Buffer.from('{"success":true}')),
    undefined
  )
  assert.throws(
    () => decodeServiceContextMenuCheckAdmin(Buffer.from('{"success":true}')),
    (error) => error instanceof ZToolsError && error.code === errorCodes.serviceProtocol
  )
})

test('ServiceClient reads fail-closed policy and keeps privileged commands closed', async () => {
  const pipe = pipeName('ready')
  const server = createAuthenticatedServer(knownSecret)
  await listen(server, pipe)
  const client = new ServiceClient({ pipeName: pipe, secret: knownSecret })
  try {
    assert.equal(await client.start(), true)
    assert.equal(client.diagnostics.state, 'ready')
    assert.equal(await client.enableTaskEvents(), false, 'older services use polling')
    assert.deepEqual(await client.policyStatus(), {
      manifestTrusted: false,
      systemOnlyDependencies: true,
      allowedTargetCount: 1
    })
    assert.equal(await client.contextMenuCheckAdmin(), true)
    assert.deepEqual(await client.callDll(
      'context-menu',
      'ContextMenuPlugin',
      'CheckAdmin',
      {}
    ), {
      isAdmin: true,
      success: true
    })
    assert.equal(await client.contextMenuRestartExplorer(), undefined)
    await assert.rejects(
      client.request(Buffer.from('probe')),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
    await assert.rejects(
      client.request(Buffer.alloc(SERVICE_MAX_PAYLOAD_BYTES - SERVICE_PROOF_BYTES + 1)),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    await assert.rejects(
      client.request(Buffer.alloc(0), 0),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    assert.equal(client.diagnostics.state, 'ready')
  } finally {
    client.stop()
    await closeServer(server)
  }
  assert.equal(client.diagnostics.state, 'closed')
})

test('ServiceClient connects and exchanges commands without an installation secret', async () => {
  const pipe = pipeName('keyless')
  const server = createAuthenticatedServer()
  await listen(server, pipe)
  const client = new ServiceClient({ pipeName: pipe })
  try {
    assert.equal(await client.start(), true, JSON.stringify(client.diagnostics))
    assert.equal(client.diagnostics.state, 'ready')
    assert.equal(await client.contextMenuCheckAdmin(), true)
    client.stop()
    assert.equal(await client.start(), true, JSON.stringify(client.diagnostics))
    assert.equal(await client.contextMenuCheckAdmin(), true)
  } finally {
    client.stop()
    await closeServer(server)
  }
})

test('ServiceClient reports unavailable pipes and rejects mismatched handshake proofs', async () => {
  const missing = new ServiceClient({ pipeName: pipeName('missing') })
  assert.equal(await missing.start(), false)
  assert.equal(missing.diagnostics.state, 'unavailable')
  assert.equal(missing.diagnostics.lastError, errorCodes.serviceUnavailable)
  missing.stop()

  const pipe = pipeName('wrong-secret')
  const server = createAuthenticatedServer(knownSecret)
  await listen(server, pipe)
  const wrongSecret = Buffer.alloc(32, 0x5a)
  const client = new ServiceClient({ pipeName: pipe, secret: wrongSecret })
  try {
    assert.equal(await client.start(), false)
    assert.equal(client.diagnostics.state, 'unavailable')
    assert.equal(client.diagnostics.lastError, errorCodes.serviceAuthentication)
  } finally {
    client.stop()
    wrongSecret.fill(0)
    await closeServer(server)
  }
})

test('ServiceClient preserves closed state when stop interrupts authentication', async () => {
  const pipe = pipeName('stop-during-auth')
  const connection: { socket: Socket | null } = { socket: null }
  let acknowledgeHello: (() => void) | null = null
  const helloReceived = new Promise<void>((resolve) => {
    acknowledgeHello = resolve
  })
  const server = createServer((socket) => {
    connection.socket = socket
    socket.once('data', () => acknowledgeHello?.())
  })
  await listen(server, pipe)
  const client = new ServiceClient({ pipeName: pipe, secret: knownSecret })
  try {
    const starting = client.start(5_000)
    await helloReceived
    client.stop()
    assert.equal(await starting, false)
    assert.equal(client.diagnostics.state, 'closed')
    assert.equal(client.diagnostics.lastError, '')
  } finally {
    client.stop()
    connection.socket?.destroy()
    await closeServer(server)
  }
})

test('ServiceClient serializes concurrent commands and queue timeouts preserve the connection', async () => {
  const pipe = pipeName('queue')
  let received = 0
  const server = createAuthenticatedServer(knownSecret, (send) => {
    received++
    setTimeout(send, 30)
  })
  await listen(server, pipe)
  const client = new ServiceClient({ pipeName: pipe, secret: knownSecret })
  try {
    assert.equal(await client.start(), true)
    const first = client.policyStatus(1000)
    await assert.rejects(client.policyStatus(5), (error) =>
      error instanceof ZToolsError && error.code === errorCodes.requestTimeout)
    await first
    assert.equal(received, 1)
    assert.equal(client.diagnostics.state, 'ready')
    const results = await Promise.all([client.policyStatus(), client.contextMenuCheckAdmin(), client.policyStatus()])
    assert.equal(results[1], true)
    assert.equal(received, 4)
  } finally {
    client.stop()
    await closeServer(server)
  }
})

test('ServiceClient bounds the queue and rejects waiting requests on close', async () => {
  const pipe = pipeName('queue-limit')
  const server = createAuthenticatedServer(knownSecret, () => {})
  await listen(server, pipe)
  const client = new ServiceClient({ pipeName: pipe, secret: knownSecret })
  try {
    assert.equal(await client.start(), true)
    const pending = Array.from({ length: 33 }, () => client.policyStatus())
    const settled = Promise.allSettled(pending)
    await assert.rejects(client.policyStatus(), (error) =>
      error instanceof ZToolsError && error.code === errorCodes.pluginBusy)
    client.stop()
    const results = await settled
    assert.equal(results.filter((result) => result.status === 'rejected').length, 33)
  } finally {
    client.stop()
    await closeServer(server)
  }
})

for (const invalid of ['replay', 'tampered'] as const) {
  test(`ServiceClient authenticates task events and rejects ${invalid} notifications`, async () => {
    const pipe = pipeName(`events-${invalid}`)
    let emit!: (ids: string[], sequence: bigint, corrupt?: boolean) => void
    const server = createAuthenticatedServer(knownSecret, undefined, (send) => { emit = send })
    await listen(server, pipe)
    const client = new ServiceClient({ pipeName: pipe, secret: knownSecret })
    try {
      assert.equal(await client.start(), true)
      assert.equal(await client.enableTaskEvents(), true)
      const event = new Promise<string[]>((resolve) => client.onTaskChange(resolve))
      emit(['task_changed'], 1n)
      assert.deepEqual(await event, ['task_changed'])
      assert.equal(await client.contextMenuCheckAdmin(), true)
      emit(['task_changed'], invalid === 'replay' ? 1n : 2n, invalid === 'tampered')
      for (let attempt = 0; attempt < 100 && client.diagnostics.state === 'ready'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(client.diagnostics.state, 'unavailable')
      assert.equal(client.taskEventsEnabled, false)
    } finally {
      client.stop()
      await closeServer(server)
    }
  })
}
