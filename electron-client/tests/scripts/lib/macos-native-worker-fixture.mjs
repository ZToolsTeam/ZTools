import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const HEADER_BYTES = 36
const MAX_PAYLOAD_BYTES = 1024 * 1024
const WIRE_VERSION = 1
const FRAME = Object.freeze({
  HANDSHAKE: 1,
  INIT: 2,
  INFO: 3,
  CALL: 4,
  CANCEL: 5,
  QUERY: 6,
  CLEAR: 7,
  DESTROY: 8,
  SHUTDOWN: 9,
  PROGRESS: 0x8001,
  CALLBACK: 0x8002,
  RESPONSE: 0x8003,
  CANCELLED: 0x8004,
  ERROR: 0x80ff,
})

function makeFrame(type, owner, generation, taskId, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  if (data.length > MAX_PAYLOAD_BYTES) throw new Error('FRAME_PAYLOAD_TOO_LARGE')
  const frame = Buffer.alloc(HEADER_BYTES + data.length)
  frame.write('ZTMN', 0, 4, 'ascii')
  frame.writeUInt16LE(WIRE_VERSION, 4)
  frame.writeUInt16LE(type, 6)
  frame.writeUInt32LE(data.length, 8)
  frame.writeBigUInt64LE(BigInt(owner), 12)
  frame.writeBigUInt64LE(BigInt(generation), 20)
  frame.writeBigUInt64LE(BigInt(taskId), 28)
  data.copy(frame, HEADER_BYTES)
  return frame
}

function parseFrames(buffer, expectedOwner, expectedGeneration) {
  const frames = []
  let offset = 0
  while (buffer.length - offset >= HEADER_BYTES) {
    const magic = buffer.toString('ascii', offset, offset + 4)
    const version = buffer.readUInt16LE(offset + 4)
    const type = buffer.readUInt16LE(offset + 6)
    const payloadLength = buffer.readUInt32LE(offset + 8)
    const owner = buffer.readBigUInt64LE(offset + 12)
    const generation = buffer.readBigUInt64LE(offset + 20)
    const taskId = buffer.readBigUInt64LE(offset + 28)
    if (magic !== 'ZTMN' || version !== WIRE_VERSION) throw new Error('WORKER_WIRE_IDENTITY_INVALID')
    if (payloadLength > MAX_PAYLOAD_BYTES) throw new Error('WORKER_FRAME_TOO_LARGE')
    const frameLength = HEADER_BYTES + payloadLength
    if (buffer.length - offset < frameLength) break
    if (owner !== expectedOwner) throw new Error('WORKER_OWNER_MISMATCH')
    if (generation > expectedGeneration) throw new Error('WORKER_FUTURE_GENERATION')
    const payload = buffer.subarray(offset + HEADER_BYTES, offset + frameLength)
    if (generation === expectedGeneration) frames.push({ type, owner, generation, taskId, payload })
    offset += frameLength
  }
  return { frames, remaining: buffer.subarray(offset) }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

class NativeWorkerFixtureProcess {
  constructor({ executable, component, owner, generation, onEvent, exitWaiter }) {
    this.executable = executable
    this.component = component
    this.owner = BigInt(owner)
    this.generation = BigInt(generation)
    this.onEvent = onEvent
    this.state = 'created'
    this.child = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextTaskId = 0n
    this.activeTask = null
    this.initialized = false
    this.destroyed = false
    this.exitDetails = null
    this.closed = deferred()
    this.stderr = ''
    this.exitWaiter = exitWaiter
  }

  async start() {
    if (this.state !== 'created' || this.owner === 0n || this.generation === 0n) throw new Error('WORKER_START_INVALID_STATE')
    this.state = 'starting'
    this.child = spawn(this.executable, [
      '--test-fixture', this.component,
      '--owner', this.owner.toString(),
      '--generation', this.generation.toString(),
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16 * 1024)
    })
    this.child.on('error', (error) => this.#failPending(error))
    this.child.on('close', (code, signal) => {
      this.exitDetails = { pid: this.child.pid ?? null, code, signal, owned: true, exited: true }
      if (this.state !== 'stopping' && this.state !== 'cancelled' && this.state !== 'timed-out') {
        this.state = 'failed'
        this.#failPending(new Error(`WORKER_EXITED_UNEXPECTEDLY_${code === null ? 'SIGNALLED' : code}`))
      }
      this.closed.resolve(this.exitDetails)
    })
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve)
      this.child.once('error', reject)
    })
    this.state = 'handshaking'
    const handshake = await this.#request(0n, FRAME.HANDSHAKE, Buffer.alloc(0), 5000)
    let decoded
    try { decoded = JSON.parse(handshake.payload.toString('utf8')) } catch { throw new Error('WORKER_HANDSHAKE_INVALID_JSON') }
    if (decoded.status !== 'ready' || decoded.wireVersion !== WIRE_VERSION || decoded.abiVersion !== 1 || decoded.capabilities !== 0) {
      await this.#terminate('failed')
      throw new Error('WORKER_ABI_HANDSHAKE_REJECTED')
    }
    this.state = 'ready'
    return decoded
  }

  async init(config = '{"mode":"fixture"}') {
    this.#requireReady()
    const result = await this.#request(0n, FRAME.INIT, Buffer.from(config, 'utf8'), 5000)
    const decoded = JSON.parse(result.payload.toString('utf8'))
    if (decoded.status !== 0) throw new Error('WORKER_INIT_FAILED')
    this.initialized = true
    return decoded
  }

  async info() {
    this.#requireReady()
    const result = await this.#request(0n, FRAME.INFO, Buffer.alloc(0), 5000)
    return JSON.parse(result.payload.toString('utf8'))
  }

  call(payload, { timeoutMs = 5000, onEvent = this.onEvent } = {}) {
    this.#requireReady()
    if (!this.initialized || this.activeTask !== null) throw new Error('WORKER_TASK_NOT_AVAILABLE')
    const taskId = ++this.nextTaskId
    const pending = deferred()
    this.activeTask = { taskId, state: 'pending', pending, onEvent, timer: null }
    this.activeTask.timer = setTimeout(() => {
      if (this.activeTask?.taskId !== taskId) return
      this.activeTask.state = 'timed-out'
      this.state = 'stopping'
      void this.#terminate('timed-out').then(() => {
        this.pending.delete(taskId.toString())
        this.activeTask = null
        pending.reject(new Error('WORKER_TASK_TIMED_OUT'))
      }).catch((error) => {
        this.pending.delete(taskId.toString())
        this.activeTask = null
        pending.reject(error)
      })
    }, timeoutMs)
    this.pending.set(taskId.toString(), { ...pending, timer: this.activeTask.timer })
    try {
      this.#send(FRAME.CALL, taskId, Buffer.from(payload, 'utf8'))
    } catch (error) {
      clearTimeout(this.activeTask.timer)
      this.pending.delete(taskId.toString())
      this.activeTask = null
      pending.reject(error)
    }
    return { taskId: taskId.toString(), result: pending.promise }
  }

  async query(taskId) {
    this.#requireReady()
    const result = await this.#request(BigInt(taskId), FRAME.QUERY, Buffer.alloc(0), 5000)
    return JSON.parse(result.payload.toString('utf8'))
  }

  async clear(taskId) {
    this.#requireReady()
    const result = await this.#request(BigInt(taskId), FRAME.CLEAR, Buffer.alloc(0), 5000)
    return JSON.parse(result.payload.toString('utf8'))
  }

  async cancel(taskId) {
    const active = this.activeTask
    if (!active || active.taskId !== BigInt(taskId) || this.state !== 'ready') return false
    clearTimeout(active.timer)
    active.state = 'cancelled'
    this.state = 'stopping'
    try {
      await this.#terminate('cancelled')
      this.pending.delete(active.taskId.toString())
      this.activeTask = null
      active.pending.reject(new Error('WORKER_TASK_CANCELLED'))
      return true
    } catch (error) {
      this.pending.delete(active.taskId.toString())
      this.activeTask = null
      active.pending.reject(error)
      throw error
    }
  }

  async stop() {
    if (this.state === 'stopped' && this.exitDetails?.exited) return this.exitDetails
    if (this.state === 'failed' || this.state === 'cancelled' || this.state === 'timed-out' || this.state === 'cleanup-unconfirmed') {
      if (this.exitDetails?.exited) return this.exitDetails
      return this.forceCleanup()
    }
    this.#requireReady()
    if (this.activeTask !== null) throw new Error('WORKER_HAS_ACTIVE_TASK')
    if (this.initialized && !this.destroyed) {
      const destroyed = await this.#request(0n, FRAME.DESTROY, Buffer.alloc(0), 3000)
      if (JSON.parse(destroyed.payload.toString('utf8')).status !== 0) throw new Error('WORKER_DESTROY_FAILED')
      this.destroyed = true
    }
    const stopped = this.#request(0n, FRAME.SHUTDOWN, Buffer.alloc(0), 3000)
    this.state = 'stopping'
    await stopped
    const exit = await this.#waitForExit(3000)
    if (!exit?.exited) {
      try { await this.#terminate('failed') } catch {}
      throw new Error(this.exitDetails?.exited ? 'WORKER_GRACEFUL_EXIT_UNCONFIRMED' : 'WORKER_GRACEFUL_EXIT_AND_CLEANUP_UNCONFIRMED')
    }
    this.exitDetails = exit
    this.state = 'stopped'
    return exit
  }

  async cleanupFailedStart() {
    if (!this.child) return null
    if (this.exitDetails?.exited) return this.exitDetails
    return this.#terminate('failed')
  }

  async forceCleanup() {
    if (!this.child) return null
    if (this.exitDetails?.exited) return this.exitDetails
    const exit = await this.#terminate('failed')
    if (!exit?.exited) throw new Error('OWNED_WORKER_EXIT_UNCONFIRMED')
    return exit
  }

  #requireReady() {
    if (this.state !== 'ready' || !this.child || this.exitDetails) throw new Error('WORKER_NOT_READY')
  }

  #send(type, taskId, payload) {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error('WORKER_PIPE_CLOSED')
    this.child.stdin.write(makeFrame(type, this.owner, this.generation, taskId, payload))
  }

  #request(taskId, type, payload, timeoutMs) {
    if (this.pending.has(taskId.toString())) return Promise.reject(new Error('WORKER_REQUEST_ALREADY_PENDING'))
    const result = deferred()
    const timer = setTimeout(() => {
      this.pending.delete(taskId.toString())
      result.reject(new Error('WORKER_REQUEST_TIMED_OUT'))
      this.state = 'stopping'
      void this.#terminate('timed-out').catch((error) => this.#failPending(error))
    }, timeoutMs)
    this.pending.set(taskId.toString(), { ...result, timer })
    try { this.#send(type, taskId, payload) } catch (error) {
      clearTimeout(timer)
      this.pending.delete(taskId.toString())
      result.reject(error)
    }
    return result.promise
  }

  #onData(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      const parsed = parseFrames(this.buffer, this.owner, this.generation)
      this.buffer = parsed.remaining
      for (const frame of parsed.frames) this.#onFrame(frame)
    } catch (error) {
      this.state = 'failed'
      this.#failPending(error)
      void this.#terminate('failed').catch((cleanupError) => this.#failPending(cleanupError))
    }
  }

  #onFrame(frame) {
    if (frame.type === FRAME.PROGRESS || frame.type === FRAME.CALLBACK) {
      if (this.activeTask?.taskId === frame.taskId) {
        this.activeTask.state = 'running'
        try { this.activeTask.onEvent?.({ type: frame.type, taskId: frame.taskId.toString(), payload: frame.payload.toString('utf8') }) } catch {}
      }
      return
    }
    const pending = this.pending.get(frame.taskId.toString())
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(frame.taskId.toString())
    if (frame.type === FRAME.ERROR) {
      pending.reject(new Error(`WORKER_ERROR:${frame.payload.toString('utf8')}`))
    } else if (frame.type === FRAME.HANDSHAKE || frame.type === FRAME.RESPONSE) {
      if (frame.taskId !== 0n && this.activeTask?.taskId === frame.taskId) {
        clearTimeout(this.activeTask.timer)
        this.activeTask.state = 'completed'
        this.activeTask = null
      }
      pending.resolve(frame)
    } else {
      pending.reject(new Error('WORKER_FRAME_TYPE_UNEXPECTED'))
    }
  }

  #failPending(error) {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(key)
    }
    if (this.activeTask) {
      clearTimeout(this.activeTask.timer)
      this.activeTask.pending.reject(error)
      this.activeTask = null
    }
  }

  async #waitForExit(timeoutMs) {
    if (this.exitDetails) return this.exitDetails
    if (this.exitWaiter) return this.exitWaiter(timeoutMs, this)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      this.closed.promise.then((exit) => {
        clearTimeout(timer)
        resolve(exit)
      })
    })
  }

  async #terminate(outcome) {
    if (!this.child) return null
    if (this.exitDetails?.exited) {
      this.state = outcome === 'failed' ? 'failed' : outcome
      return this.exitDetails
    }
    this.state = 'stopping'
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill('SIGTERM') } catch {}
    }
    let exit = await this.#waitForExit(1000)
    if (!exit?.exited) {
      try { this.child.kill('SIGKILL') } catch {}
      exit = await this.#waitForExit(3000)
    }
    if (!exit?.exited) {
      this.state = 'cleanup-unconfirmed'
      throw new Error('OWNED_WORKER_EXIT_UNCONFIRMED')
    }
    this.exitDetails = exit
    this.state = outcome === 'failed' ? 'failed' : outcome
    return exit
  }
}

export async function runMacNativeWorkerFixtureCases({
  workerExecutable,
  supportedFixture,
  unsupportedFixture,
  injectFailureAfterFirstWorker = false,
}) {
  let checks = 0
  const ownedPids = new Set()
  const ownedWorkers = new Set()
  const failedStarts = []
  const cleanupResults = []
  let result
  let failure
  const check = (condition, code) => {
    if (!condition) throw new Error(code)
    checks++
  }
  const open = async ({ owner, generation = 1, component = supportedFixture, requireAdmin = false, onEvent }) => {
    if (requireAdmin) throw new Error('ADMIN_NATIVE_DENIED')
    const worker = new NativeWorkerFixtureProcess({ executable: workerExecutable, component, owner, generation, onEvent })
    ownedWorkers.add(worker)
    try {
      await worker.start()
    } catch (error) {
      if (Number.isInteger(worker.child?.pid)) ownedPids.add(worker.child.pid)
      failedStarts.push(worker)
      error.workerInstance = worker
      throw error
    }
    check(Number.isInteger(worker.child.pid), 'WORKER_PID_MISSING')
    ownedPids.add(worker.child.pid)
    return worker
  }

  try {
  const normalEvents = []
  const primary = await open({ owner: 1001, generation: 4, onEvent: (event) => normalEvents.push(event) })
  check(primary.state === 'ready', 'PRIMARY_WORKER_NOT_READY')
  await primary.init()
  if (injectFailureAfterFirstWorker) throw new Error('INJECTED_WORKER_FIXTURE_FAILURE')
  const info = await primary.info()
  check(info.id === 'abi-fixture' && info.abiVersion === 1, 'WORKER_INFO_MISMATCH')
  const normalCall = primary.call('{"payload":"worker-echo","value":1}')
  const echoed = await normalCall.result
  check(echoed.payload.toString('utf8') === '{"payload":"worker-echo","value":1}', 'WORKER_CALL_RESULT_MISMATCH')
  check(normalEvents.some((event) => event.type === FRAME.PROGRESS && event.taskId === normalCall.taskId), 'WORKER_PROGRESS_EVENT_MISSING')
  check((await primary.query(normalCall.taskId)).state === 'completed', 'WORKER_QUERY_MISMATCH')
  check((await primary.clear(normalCall.taskId)).cleared === true, 'WORKER_CLEAR_MISMATCH')

  const countBeforeAdminReject = ownedPids.size
  let adminRejected = false
  try { await open({ owner: 1002, requireAdmin: true }) } catch (error) { adminRejected = error.message === 'ADMIN_NATIVE_DENIED' }
  check(adminRejected && ownedPids.size === countBeforeAdminReject, 'ADMIN_WORKER_WAS_SPAWNED')

  let abiRejected = false
  try { await open({ owner: 1003, component: unsupportedFixture }) } catch (error) {
    abiRejected = error.message === 'WORKER_ABI_HANDSHAKE_REJECTED'
  }
  check(abiRejected, 'UNKNOWN_ABI_WORKER_ACCEPTED')
  check(failedStarts.at(-1)?.exitDetails?.exited === true, 'REJECTED_ABI_WORKER_NOT_CLEANED')

  const cancelWorker = await open({ owner: 1004 })
  await cancelWorker.init()
  const cancelledTask = cancelWorker.call('{"test":"hang"}', { timeoutMs: 10000 })
  await delay(100)
  check(await cancelWorker.cancel(cancelledTask.taskId), 'WORKER_CANCEL_FAILED')
  let cancelRejected = false
  try { await cancelledTask.result } catch (error) { cancelRejected = error.message === 'WORKER_TASK_CANCELLED' }
  check(cancelRejected && cancelWorker.state === 'cancelled' && cancelWorker.exitDetails?.exited, 'CANCEL_OWNED_WORKER_NOT_CLEANED')

  const timeoutWorker = await open({ owner: 1005 })
  await timeoutWorker.init()
  const timedTask = timeoutWorker.call('{"test":"hang"}', { timeoutMs: 150 })
  let timedOut = false
  try { await timedTask.result } catch (error) { timedOut = error.message === 'WORKER_TASK_TIMED_OUT' }
  check(timedOut && timeoutWorker.state === 'timed-out' && timeoutWorker.exitDetails?.exited, 'TIMEOUT_OWNED_WORKER_NOT_CLEANED')

  const crashWorker = await open({ owner: 1006 })
  await crashWorker.init()
  const crashTask = crashWorker.call('{"test":"crash"}')
  let crashObserved = false
  try { await crashTask.result } catch { crashObserved = true }
  check(crashObserved && crashWorker.state === 'failed' && crashWorker.exitDetails?.code !== 0,
    'WORKER_CRASH_NOT_ISOLATED')
  check((await primary.call('{"payload":"survives-peer-crash"}').result).payload.toString('utf8') ===
    '{"payload":"survives-peer-crash"}', 'PEER_WORKER_DAMAGED_BY_CRASH')

  const primaryExit = await primary.stop()
  check(primary.state === 'stopped' && primaryExit?.exited && primaryExit.owned, 'NORMAL_WORKER_OWNED_CLEANUP_FAILED')
  result = {
    status: 'PASS',
    scope: 'windows-synthetic-worker-process-isolation',
    checks,
    ownedPids: [...ownedPids],
    ownerGenerationBound: true,
    timeoutAndCancelKillOnlyOwnedChild: true,
    ownershipScope: 'runner-owned direct test-worker processes only; fixture workers create no descendants',
    descendantTreeCleanup: 'NOT_EXERCISED_NO_DESCENDANTS',
    unconfirmedExitBehavior: 'FIXTURE_FAILS_AND_REPORTS_UNCONFIRMED',
    macComponentLoad: 'NOT_RUN',
    productionHost: false,
  }
  } catch (error) {
    failure = error
  } finally {
    for (const worker of ownedWorkers) {
      const pid = worker.child?.pid
      if (Number.isInteger(pid)) ownedPids.add(pid)
      try {
        const exit = await worker.forceCleanup()
        cleanupResults.push({ pid: Number.isInteger(pid) ? pid : null, confirmed: !worker.child || exit?.exited === true, state: worker.state })
      } catch (error) {
        cleanupResults.push({ pid: Number.isInteger(pid) ? pid : null, confirmed: false, state: worker.state, failureCode: error.message })
      }
    }
  }

  const cleanupFailures = cleanupResults.filter((entry) => !entry.confirmed)
  if (failure || cleanupFailures.length > 0) {
    const finalError = failure ?? new Error('WORKER_FIXTURE_CLEANUP_UNCONFIRMED')
    finalError.workerCleanup = cleanupResults
    if (cleanupFailures.length > 0) finalError.cleanupFailureCode = 'WORKER_FIXTURE_CLEANUP_UNCONFIRMED'
    throw finalError
  }
  result.cleanup = cleanupResults
  result.ownedPids = [...ownedPids]
  return result
}

export async function runMacNativeWorkerFixtureCleanupTests({ workerExecutable, supportedFixture, unsupportedFixture }) {
  let checks = 0
  const expect = (condition, code) => {
    if (!condition) throw new Error(code)
    checks++
  }

  let injectedFailure
  try {
    await runMacNativeWorkerFixtureCases({
      workerExecutable,
      supportedFixture,
      unsupportedFixture,
      injectFailureAfterFirstWorker: true,
    })
  } catch (error) {
    injectedFailure = error
  }
  expect(injectedFailure?.message === 'INJECTED_WORKER_FIXTURE_FAILURE', 'MID_RUN_FAILURE_NOT_PROPAGATED')
  expect(Array.isArray(injectedFailure?.workerCleanup) && injectedFailure.workerCleanup.length === 1,
    'MID_RUN_FAILURE_OWNED_WORKER_NOT_TRACKED')
  expect(injectedFailure.workerCleanup[0]?.confirmed === true && injectedFailure.workerCleanup[0]?.state === 'failed',
    'MID_RUN_FAILURE_OWNED_WORKER_NOT_CLEANED')
  expect(injectedFailure.cleanupFailureCode === undefined, 'MID_RUN_FAILURE_CLEANUP_REPORTED_FAILED')

  const signals = []
  const fake = new NativeWorkerFixtureProcess({
    executable: 'not-spawned',
    component: 'not-loaded',
    owner: 9001,
    generation: 3,
    exitWaiter: async () => null,
  })
  fake.child = {
    pid: 9002,
    exitCode: null,
    signalCode: null,
    stdin: { destroyed: false },
    kill(signal) { signals.push(signal); return true },
  }
  fake.state = 'ready'
  let unconfirmedError
  try { await fake.forceCleanup() } catch (error) { unconfirmedError = error }
  expect(unconfirmedError?.message === 'OWNED_WORKER_EXIT_UNCONFIRMED', 'CLEANUP_TIMEOUT_NOT_OBSERVABLE')
  expect(fake.state === 'cleanup-unconfirmed' && fake.exitDetails === null, 'CLEANUP_TIMEOUT_CLAIMED_STOPPED')
  expect(signals.includes('SIGTERM') && signals.includes('SIGKILL'), 'CLEANUP_TIMEOUT_DID_NOT_ESCALATE_OWNED_CHILD')

  return {
    status: 'PASS',
    scope: 'owned-worker-cleanup-failure-cases',
    checks,
    midRunFailureCleanup: injectedFailure.workerCleanup,
    cleanupTimeout: { failureCode: unconfirmedError.message, state: fake.state, signals },
  }
}
