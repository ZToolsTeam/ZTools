import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithStdioTuple
} from 'node:child_process'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { NativeDllInvocationContext } from '../../src/main/native-host/dll-client-port.js'
import { NativeHostClient } from '../../src/main/native-host/native-host-client.js'
import {
  encodeNativeHostFrame,
  NativeHostFrameDecoder,
  NativeHostFrameType,
  NATIVE_HOST_NONCE_BYTES,
  NATIVE_HOST_PROTOCOL_VERSION,
  type NativeHostFrame
} from '../../src/main/native-host/protocol.js'

interface FakeHostProcess {
  child: ChildProcessWithoutNullStreams
  exit(code: number): void
  killCount(): number
  taskRequests: NativeHostFrame[]
  send(frame: NativeHostFrame): void
}

function invocationContext(): NativeDllInvocationContext {
  return {
    ownerToken: 'unit-test-owner',
    generation: '1',
    pluginInstanceId: 'unit-test-plugin-instance',
    webContentsId: 1
  }
}

function createFakeHostProcess(
  options: SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>,
  respondToHello: boolean,
  holdTaskStarts = false
): FakeHostProcess {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let exitCode: number | null = null
  let kills = 0
  const taskRequests: NativeHostFrame[] = []
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    pid: 34567,
    kill() {
      kills++
      if (exitCode === null) exit(0)
      return true
    }
  }) as unknown as ChildProcessWithoutNullStreams
  Object.defineProperty(child, 'exitCode', { get: () => exitCode })

  const decoder = new NativeHostFrameDecoder()
  stdin.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === NativeHostFrameType.Hello && respondToHello) {
        const token = options.env?.ZTOOLS_NATIVE_HOST_TOKEN
        assert.equal(typeof token, 'string')
        const secret = Buffer.from(token as string, 'hex')
        const serverNonce = randomBytes(NATIVE_HOST_NONCE_BYTES)
        const proof = createHmac('sha256', secret)
          .update(Buffer.from('ztools-native-host-server-v1\0', 'ascii'))
          .update(Buffer.from(frame.sessionId, 'utf8'))
          .update(Buffer.from([0]))
          .update(frame.payload.subarray(0, NATIVE_HOST_NONCE_BYTES))
          .update(serverNonce)
          .digest()
        secret.fill(0)
        stdout.write(encodeNativeHostFrame({
          protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
          type: NativeHostFrameType.HelloAck,
          sessionId: frame.sessionId,
          requestId: frame.requestId,
          pluginId: '',
          dllId: '',
          method: 'hello_ack',
          payload: Buffer.concat([serverNonce, proof])
        }))
      } else if (frame.method === 'shutdown') {
        const payload = Buffer.from(JSON.stringify({
          completed: true,
          timedOut: false,
          cancelAttempted: 0,
          cancelFailed: 0,
          stopAttempted: 0,
          stopFailed: 0,
          tasksCleared: 0,
          sessionsUnloaded: 0,
          remainingTasks: 0,
          remainingActiveInvocations: 0,
          internalFailures: 0
        }))
        stdout.write(encodeNativeHostFrame({
          protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
          type: NativeHostFrameType.Response,
          sessionId: frame.sessionId,
          requestId: frame.requestId,
          pluginId: '',
          dllId: '',
          method: 'shutdown',
          payload
        }))
      } else if (frame.method === 'dll_call_async' || frame.method === 'dll_call_with_callback') {
        taskRequests.push(frame)
        if (holdTaskStarts) continue
        const taskLength = frame.payload.readUInt16LE(0)
        const taskId = frame.payload.toString('utf8', 4, 4 + taskLength)
        stdout.write(encodeNativeHostFrame({
          protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
          type: NativeHostFrameType.Response,
          sessionId: frame.sessionId,
          requestId: frame.requestId,
          pluginId: '',
          dllId: '',
          method: frame.method,
          payload: Buffer.from(taskId, 'utf8')
        }))
      }
    }
  })
  stdin.on('finish', () => exit(0))

  function exit(code: number): void {
    if (exitCode !== null) return
    exitCode = code
    events.emit('exit', code, null)
  }

  return {
    child,
    exit,
    killCount: () => kills,
    taskRequests,
    send: frame => { stdout.write(encodeNativeHostFrame(frame)) }
  }
}

test('callback task reservation fails synchronously before NativeHost is ready', () => {
  const client = new NativeHostClient('ZToolsNativeHost32.exe')

  assert.throws(
    () => client.beginDllCallbackTask('plugin.test', 'TestPlugin', 'callbackTask', {}),
    (error) => error instanceof ZToolsError && error.code === errorCodes.nativeHostUnavailable
  )
  assert.equal(client.state, 'idle')
})

test('async and callback starts keep the owner context and use the preassigned task ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-native-host-task-id-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  const client = new NativeHostClient(executable, {
    spawnProcess: (_path, _args, options) => createFakeHostProcess(options, true).child
  })
  const context = invocationContext()
  try {
    await client.start(1000)
    const asyncTaskId = 'task_reserved_async'
    assert.equal(
      await client.callDllAsync(
        'plugin.test', 'TestPlugin', 'asyncTask', {}, context, undefined, asyncTaskId
      ),
      asyncTaskId
    )

    const callbackTaskId = 'task_reserved_callback'
    const attempt = client.beginDllCallbackTask(
      'plugin.test', 'TestPlugin', 'callbackTask', {}, context, undefined, callbackTaskId
    )
    assert.equal(attempt.taskId, callbackTaskId)
    assert.deepEqual(await attempt.outcome, { kind: 'started' })
    await client.stop(1000)
  } finally {
    if (client.state !== 'closed') await client.stop(1000)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('abort while stat is pending prevents NativeHost32 from being spawned', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-host-stat-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  let spawnCount = 0
  const client = new NativeHostClient(executable, {
    spawnProcess: () => {
      spawnCount++
      throw new Error('cancelled NativeHost32 must not spawn')
    }
  })
  const controller = new AbortController()
  try {
    const startup = client.start(1000, controller.signal)
    controller.abort()
    await assert.rejects(startup, (error: unknown) =>
      error instanceof ZToolsError && error.code === errorCodes.appStopping
    )
    await client.stop(100)
    assert.equal(spawnCount, 0)
    assert.equal(client.state, 'closed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a cancelled old NativeHost launch cannot spawn or overwrite a later explicit start', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-host-generation-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  let spawnCount = 0
  const client = new NativeHostClient(executable, {
    spawnProcess: (_path, _args, options) => {
      spawnCount++
      return createFakeHostProcess(options, true).child
    }
  })
  try {
    const firstStart = client.start(1000)
    await client.stop(100)
    const secondStart = client.start(1000)
    await assert.rejects(firstStart, (error: unknown) =>
      error instanceof ZToolsError && error.code === errorCodes.appStopping
    )
    await secondStart
    assert.equal(spawnCount, 1)
    assert.equal(client.state, 'ready')
    const stopped = await client.stop(1000)
    assert.equal(stopped.completed, true)
    assert.equal(client.state, 'closed')
  } finally {
    if (client.state !== 'closed') await client.stop(1000)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('abort during hello kills only its owned child', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-host-hello-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  const children: FakeHostProcess[] = []
  const client = new NativeHostClient(executable, {
    spawnProcess: (_path, _args, options) => {
      const child = createFakeHostProcess(options, false)
      children.push(child)
      return child.child
    }
  })
  const controller = new AbortController()
  try {
    const startup = client.start(1000, controller.signal)
    const deadline = Date.now() + 1000
    while (children.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(children.length, 1, 'NativeHost child should be created before abort')
    controller.abort()
    await assert.rejects(startup, (error: unknown) =>
      error instanceof ZToolsError && error.code === errorCodes.appStopping
    )
    await client.stop(100)
    assert.equal(children[0]?.killCount(), 1)
    assert.equal(client.state, 'closed')
  } finally {
    if (client.state !== 'closed') await client.stop(1000)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('lifecycle abort clears a scheduled automatic restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-host-restart-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  const children: FakeHostProcess[] = []
  const client = new NativeHostClient(executable, {
    spawnProcess: (_path, _args, options) => {
      const child = createFakeHostProcess(options, true)
      children.push(child)
      return child.child
    }
  })
  const controller = new AbortController()
  try {
    await client.start(1000, controller.signal)
    assert.equal(client.state, 'ready')
    children[0]?.exit(1)
    assert.equal(client.state, 'restarting')
    controller.abort()
    await client.stop(100)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(children.length, 1)
    assert.equal(client.state, 'closed')
  } finally {
    if (client.state !== 'closed') await client.stop(1000)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('trusted resource roots are passed only with an explicit manifest digest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-f03-host-resources-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  let launchEnvironment: NodeJS.ProcessEnv | undefined
  const client = new NativeHostClient(executable, {
    pluginRoot: root,
    trustedManifestSha256: 'A'.repeat(64),
    resourcesRoot: root,
    trustedResourcesManifestSha256: 'B'.repeat(64),
    spawnProcess: (_path, _args, options) => {
      launchEnvironment = options.env
      return createFakeHostProcess(options, true).child
    }
  })
  try {
    await client.start(1000)
    assert.equal(launchEnvironment?.ZTOOLS_NATIVE_PLUGIN_ROOT, path.resolve(root))
    assert.equal(launchEnvironment?.ZTOOLS_NATIVE_MANIFEST_SHA256, 'a'.repeat(64))
    assert.equal(launchEnvironment?.ZTOOLS_NATIVE_RESOURCES_ROOT, path.resolve(root))
    assert.equal(launchEnvironment?.ZTOOLS_NATIVE_RESOURCES_MANIFEST_SHA256, 'b'.repeat(64))
    await client.stop(1000)
  } finally {
    if (client.state !== 'closed') await client.stop(1000)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('DLL calls survive user waits and release on response, abort and stop even with pending writes', async (t) => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    exitCode: null as number | null,
    kill() { exit() },
    stdin: {
      write(_data: Buffer, _callback: (error?: Error) => void) { return true },
      end() { setImmediate(exit) }
    }
  })
  function exit(): void {
    if (child.exitCode !== null) return
    child.exitCode = 0
    child.emit('exit', 0, null)
  }
  const delayedWrites: Array<() => void> = []
  const dllResponses: Array<() => void> = []
  t.mock.method(fs, 'stat', async () => ({ isFile: () => true }))
  t.mock.method(childProcess, 'spawn', (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const secret = Buffer.from(options.env.ZTOOLS_NATIVE_HOST_TOKEN!, 'hex')
    const decoder = new NativeHostFrameDecoder()
    child.stdin.write = (data, callback) => {
      for (const frame of decoder.push(data)) {
        if (frame.type === NativeHostFrameType.Hello) {
          const nonce = Buffer.alloc(NATIVE_HOST_NONCE_BYTES, 7)
          const proof = createHmac('sha256', secret)
            .update(Buffer.from('ztools-native-host-server-v1\0', 'ascii'))
            .update(frame.sessionId).update(Buffer.from([0]))
            .update(frame.payload.subarray(0, NATIVE_HOST_NONCE_BYTES)).update(nonce).digest()
          queueMicrotask(() => child.stdout.emit('data', encodeNativeHostFrame({
            ...frame, type: NativeHostFrameType.HelloAck, method: 'hello_ack',
            payload: Buffer.concat([nonce, proof])
          })))
          callback()
        } else if (frame.method === 'shutdown') {
          queueMicrotask(() => child.stdout.emit('data', encodeNativeHostFrame({
            ...frame, type: NativeHostFrameType.Response,
            payload: Buffer.from(JSON.stringify({
              completed: true, timedOut: false, cancelAttempted: 0, cancelFailed: 0,
              stopAttempted: 0, stopFailed: 0, tasksCleared: 0, sessionsUnloaded: 0,
              remainingTasks: 0, remainingActiveInvocations: 0, internalFailures: 0
            }))
          })))
          callback()
        } else {
          if (frame.method === 'dll_call') {
            dllResponses.push(() => child.stdout.emit('data', encodeNativeHostFrame({
              ...frame, type: NativeHostFrameType.Response, pluginId: '', dllId: '', payload: Buffer.alloc(5)
            })))
          }
          delayedWrites.push(() => callback())
        }
      }
      return true
    }
    return child
  })
  const client = new NativeHostClient('ZToolsNativeHost32.exe')
  try {
    await client.start()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const normalRequest = assert.rejects(client.request('normal'), { code: 'REQUEST_TIMEOUT' })
    let settled = false
    const picking = client.callDll('screen-color-picker', 'ScreenColorPickerPlugin', 'PickColor', {})
    void picking.then(() => { settled = true }, () => { settled = true })
    t.mock.timers.tick(180_000)
    await normalRequest
    assert.equal(settled, false)
    dllResponses.shift()!()
    assert.deepEqual(await picking, { code: 0, result: null })

    const controller = new AbortController()
    const cancelled = assert.rejects(
      client.callDll(
        'screen-color-picker', 'ScreenColorPickerPlugin', 'PickColor', {},
        invocationContext(), controller.signal
      ),
      { code: 'CALLER_DESTROYED' }
    )
    controller.abort()
    await cancelled
    dllResponses.shift()!()
    t.mock.timers.reset()
    const requests = [client.request('first'), client.request('second'),
      client.callDll('screen-color-picker', 'ScreenColorPickerPlugin', 'PickColor', {})]
    const rejected = requests.map((request) => assert.rejects(request, { code: 'APP_STOPPING' }))
    const stopping = client.stop()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await Promise.all(rejected)
    const report = await stopping
    assert.equal(report.completed, true)
    assert.equal(report.forced, false)
    assert.equal(delayedWrites.length, 6)
  } finally {
    for (const completeWrite of delayedWrites) completeWrite()
    await client.stop()
  }
})

async function pendingTaskHost() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-native-start-outcome-'))
  const executable = path.join(root, 'ZToolsNativeHost32.exe')
  await fs.writeFile(executable, 'test executable placeholder')
  let host!: FakeHostProcess
  const client = new NativeHostClient(executable, {
    spawnProcess: (_path, _args, options) => { host = createFakeHostProcess(options, true, true); return host.child }
  })
  await client.start(1000)
  return { client, host, async cleanup() { await client.stop(1000); await fs.rm(root, { recursive: true, force: true }) } }
}

test('ordinary start preflight does not send a frame while unavailable or already aborted', () => {
  const client = new NativeHostClient('ZToolsNativeHost32.exe')
  assert.throws(() => client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {}),
    { code: errorCodes.nativeHostUnavailable })
  const aborted = new AbortController(); aborted.abort()
  assert.throws(() => client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {}, undefined, aborted.signal),
    { code: errorCodes.callerDestroyed })
  assert.equal(client.state, 'idle')
})

test('ordinary wrapper timeout preserves its matching late ACK instead of ignoring it', async t => {
  const f = await pendingTaskHost()
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = f.client.callDllAsync('plugin.test', 'TestPlugin', 'progressTask', {}, undefined, undefined, 'task_late_async')
    const rejected = assert.rejects(pending, { code: errorCodes.requestTimeout })
    t.mock.timers.tick(5_001)
    await rejected
    const frame = f.host.taskRequests[0]!
    f.host.send({ ...frame, type: NativeHostFrameType.Response, pluginId: '', dllId: '', payload: Buffer.from('task_late_async') })
    await Promise.resolve()
    assert.equal(f.client.state, 'ready')
    assert.equal(f.host.killCount(), 0)
    t.mock.timers.reset()
  } finally { await f.cleanup() }
})

for (const mode of ['async', 'callback'] as const) {
  test(`${mode} start distinguishes structured pre-worker refusal from ambiguous Host error`, async () => {
    const f = await pendingTaskHost()
    try {
      const begin = () => mode === 'async'
        ? f.client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {})
        : f.client.beginDllCallbackTask('plugin.test', 'TestPlugin', 'callbackTask', {})
      const refused = begin(), refusalFrame = f.host.taskRequests[0]!
      f.host.send({ ...refusalFrame, type: NativeHostFrameType.Error, method: 'error', pluginId: '', dllId: '',
        payload: Buffer.from(JSON.stringify({ code: 'FUNCTION_NOT_ALLOWED', message: 'not declared' })) })
      const rejected = await refused.outcome
      assert.equal(rejected.kind, 'not-started')
      if (rejected.kind === 'not-started') assert.equal((rejected.error as ZToolsError).code, errorCodes.permissionDenied)
      for (const code of ['DLL_HOST_INTERNAL', 'DLL_TASK_DUPLICATE', 'UNRECOGNIZED_ERROR']) {
        const attempt = begin(), frame = f.host.taskRequests.at(-1)!
        let settled = false
        void attempt.outcome.then(() => { settled = true })
        f.host.send({ ...frame, type: NativeHostFrameType.Error, method: 'error', pluginId: '', dllId: '', payload: Buffer.from(JSON.stringify({ code, message: 'ambiguous' })) })
        await Promise.resolve(); await Promise.resolve()
        assert.equal(settled, false, code + ' must not prove unexecuted work')
        if (code === 'UNRECOGNIZED_ERROR') {
          f.host.exit(1)
          assert.equal((await attempt.outcome).kind, 'host-exited')
        }
      }
    } finally { await f.cleanup() }
  })
}

test('ordinary ACK validates task and owning response identity before reporting started', async () => {
  const f = await pendingTaskHost()
  try {
    const attempt = f.client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {})
    f.host.send({ ...f.host.taskRequests[0]!, type: NativeHostFrameType.Response, dllId: 'OtherPlugin', payload: Buffer.from(attempt.taskId) })
    assert.equal((await attempt.outcome).kind, 'host-exited')
    assert.equal(f.host.killCount(), 1)
  } finally { await f.cleanup() }
})

for (const mode of ['async', 'callback'] as const) {
  test(`${mode} ambiguous response and matching event release observed pending slots in either order`, async () => {
    const f = await pendingTaskHost()
    try {
      for (let index = 0; index < 140; index++) {
        const attempt = mode === 'async'
          ? f.client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {})
          : f.client.beginDllCallbackTask('plugin.test', 'TestPlugin', 'callbackTask', {})
        const request = f.host.taskRequests.at(-1)!
        const payload = Buffer.alloc(4); payload.writeInt32LE(1)
        const event = { ...request, type: NativeHostFrameType.Event, requestId: attempt.taskId,
          method: 'dll_progress', payload }
        const error = { ...request, type: NativeHostFrameType.Error, method: 'error', pluginId: '', dllId: '',
          payload: Buffer.from(JSON.stringify({ code: 'DLL_HOST_INTERNAL', message: 'after worker may start' })) }
        if (index % 2 === 0) { f.host.send(error); f.host.send(event) }
        else { f.host.send(event); f.host.send(error) }
        assert.deepEqual(await attempt.outcome, { kind: 'started' })
      }
      assert.equal(f.host.taskRequests.length, 140)
      assert.equal(f.client.state, 'ready')
    } finally { await f.cleanup() }
  })
}

test('a task event without any start response preserves its tracker for the matching late ACK', async () => {
  const f = await pendingTaskHost()
  try {
    const attempt = f.client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {})
    const request = f.host.taskRequests[0]!, payload = Buffer.alloc(4)
    payload.writeInt32LE(1)
    let settled = false; void attempt.outcome.then(() => { settled = true })
    f.host.send({ ...request, type: NativeHostFrameType.Event, requestId: attempt.taskId, method: 'dll_progress', payload })
    await Promise.resolve(); assert.equal(settled, false)
    f.host.send({ ...request, type: NativeHostFrameType.Response, pluginId: '', dllId: '', payload: Buffer.from(attempt.taskId) })
    assert.deepEqual(await attempt.outcome, { kind: 'started' }); assert.equal(f.client.state, 'ready')
  } finally { await f.cleanup() }
})

for (const mode of ['async', 'callback'] as const) {
  test(`${mode} real response wire fields reject wrong session, request, method, task, or echoed identity`, async () => {
    for (const invalid of ['session', 'request', 'method', 'task', 'identity']) {
      const f = await pendingTaskHost()
      try {
        const attempt = mode === 'async'
          ? f.client.beginDllAsyncTask('plugin.test', 'TestPlugin', 'progressTask', {})
          : f.client.beginDllCallbackTask('plugin.test', 'TestPlugin', 'callbackTask', {})
        const response = { ...f.host.taskRequests[0]!, type: NativeHostFrameType.Response,
          pluginId: '', dllId: '', payload: Buffer.from(attempt.taskId) }
        if (invalid === 'session') response.sessionId = 'different-authenticated-session'
        else if (invalid === 'request') response.requestId = 'unknown-request-id'
        else if (invalid === 'method') response.method = 'wrong_response_method'
        else if (invalid === 'task') response.payload = Buffer.from('task_other')
        else response.pluginId = 'plugin.test'
        f.host.send(response)
        assert.equal((await attempt.outcome).kind, 'host-exited', invalid)
        assert.equal(f.host.killCount(), 1, invalid)
      } finally { await f.cleanup() }
    }
  })
}
