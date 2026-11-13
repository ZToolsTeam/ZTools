import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CdpClient, NORMAL_APP_BEFORE_BOOTSTRAP_CONTRACT, runNormalAppBeforeBootstrapHook } from './lib/windows-normal-app-harness.mjs'

const source = fs.readFileSync(new URL('./lib/windows-normal-app-harness.mjs', import.meta.url), 'utf8')

test('optional beforeBootstrap hook keeps no-hook path inert and passes existing paused inspector identity', async () => {
  assert.equal(NORMAL_APP_BEFORE_BOOTSTRAP_CONTRACT, 1)
  assert.deepEqual(await runNormalAppBeforeBootstrapHook({}), { status: 'NOT_CONFIGURED' })
  const client = { evaluatePausedFrame: async () => true }
  let received
  const result = await runNormalAppBeforeBootstrapHook({ client, callFrameId: 'paused-owner', beforeBootstrap: context => {
    received = context
    return { status: 'PASS' }
  } })
  assert.notEqual(received.client, client)
  assert.equal(typeof received.client.evaluatePausedFrame, 'function')
  assert.equal(received.signal.aborted, true)
  assert.equal(received.callFrameId, 'paused-owner')
  assert.deepEqual(result, { status: 'PASS' })
})

test('invalid hook, callback error and bounded timeout reject instead of resuming bootstrap', async () => {
  const client = { evaluatePausedFrame() {} }
  for (const args of [{ beforeBootstrap: true }, { beforeBootstrap() {}, client, callFrameId: '' }, { beforeBootstrap() {}, client, callFrameId: 'frame', timeoutMs: 10001 }]) {
    await assert.rejects(runNormalAppBeforeBootstrapHook(args), /HOOK_INVALID/)
  }
  await assert.rejects(runNormalAppBeforeBootstrapHook({ client, callFrameId: 'frame', beforeBootstrap: () => { throw new Error('guard-rejected') } }), /guard-rejected/)
  await assert.rejects(runNormalAppBeforeBootstrapHook({ client, callFrameId: 'frame', timeoutMs: 20, beforeBootstrap: () => new Promise(() => {}) }), /HOOK_TIMEOUT/)
})

test('hook follows verified owned profile and clipboard isolation before resume; callback failure enters existing owned cleanup', () => {
  const clipboard = source.indexOf("report.phases[`${phase}ClipboardIsolation`]")
  const hook = source.indexOf("report.phases[`${phase}BeforeBootstrapTestHook`]")
  const resume = source.indexOf("await perform('resume-isolated-bootstrap'")
  assert.ok(clipboard >= 0 && hook > clipboard && resume > hook)
  assert.match(source, /if \(beforeBootstrap !== undefined\) \{[\s\S]*runNormalAppBeforeBootstrapHook\(\{ beforeBootstrap, client, callFrameId \}\)/)
  assert.match(source, /this\.ports\.inspect, beforeBootstrap\)/)
  assert.match(source, /const cleanup = await this\.stop\(session\)/)
})

test('fallback cleanup binds actual launch CreationDate and forbids missing or changed creation identity; an absent process never receives SIGTERM', () => {
  assert.match(source, /\$row\.CreationDate\.ToUniversalTime\(\)\.ToString\('o'\)/)
  assert.match(source, /session\.launchIdentity = launchIdentity/)
  assert.match(source, /creationUtc: session\.launchIdentity\?\.creationUtc/)
  assert.match(source, /if \(snapshot === null\) \{[\s\S]*processAbsentConfirmed = true/)
  assert.match(source, /if \(!processAbsentConfirmed && ownershipCheck\.status === 'PASS'/)
  assert.match(source, /cleanupConfirmed: \(Boolean\(exit\) \|\| processAbsentConfirmed\)/)
})

class HookSocket {
  listeners = new Map()
  sends = []
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener); this.listeners.set(type, listeners)
  }
  send(value) { this.sends.push(JSON.parse(value)) }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  close() { this.emit('close') }
}

test('timeout aborts the cooperative hook, cancels its pending transport, and revokes late listeners/resume', async () => {
  const socket = new HookSocket()
  const client = new CdpClient(socket)
  let hookClient, hookSignal, aborts = 0, listenerCalls = 0, pending
  try {
    await assert.rejects(runNormalAppBeforeBootstrapHook({ client, callFrameId: 'owned-pause', timeoutMs: 20,
      beforeBootstrap: async ({ client: scoped, signal }) => {
        hookClient = scoped; hookSignal = signal
        signal.addEventListener('abort', () => { aborts++ }, { once: true })
        scoped.on('Test.event', () => { listenerCalls++ })
        pending = scoped.call('Runtime.enable', {}, 5000).catch(error => error.message)
        await new Promise(() => {})
      } }), /HOOK_TIMEOUT/)
    assert.equal(hookSignal.aborted, true)
    assert.equal(aborts, 1)
    assert.equal(await pending, 'CDP_ABORTED')
    assert.throws(() => hookClient.on('Test.event', () => { listenerCalls++ }), /HOOK_INVALIDATED/)
    await assert.rejects(hookClient.call('Debugger.resume'), /HOOK_INVALIDATED/)
    socket.emit('message', { data: JSON.stringify({ method: 'Test.event', params: {} }) })
    assert.equal(listenerCalls, 0)
    assert.equal(socket.sends.length, 1)
  } finally { client.dispose() }
})

test('successful hook relinquishes listeners and transport while leaving the owned raw client usable', async () => {
  const socket = new HookSocket()
  const client = new CdpClient(socket)
  let scoped, signal, calls = 0
  await runNormalAppBeforeBootstrapHook({ client, callFrameId: 'owned-pause', beforeBootstrap: context => {
    scoped = context.client; signal = context.signal
    scoped.on('Test.event', () => { calls++ })
    return { status: 'PASS' }
  } })
  assert.equal(signal.aborted, true)
  assert.throws(() => scoped.on('Test.event', () => { calls++ }), /HOOK_INVALIDATED/)
  socket.emit('message', { data: JSON.stringify({ method: 'Test.event', params: {} }) })
  assert.equal(calls, 0)
  const unsubscribe = client.on('Test.event', () => { calls++ })
  socket.emit('message', { data: JSON.stringify({ method: 'Test.event', params: {} }) })
  assert.equal(calls, 1)
  unsubscribe(); client.dispose()
  assert.throws(() => client.on('Test.event', () => { calls++ }), /CDP_CLOSED/)
  socket.emit('message', { data: JSON.stringify({ method: 'Test.event', params: {} }) })
  assert.equal(calls, 1)
})

test('raw client refuses aborted event registration and releases an existing abort-bound listener', () => {
  const socket = new HookSocket()
  const client = new CdpClient(socket)
  const controller = new AbortController()
  let calls = 0
  client.on('Test.event', () => { calls++ }, { signal: controller.signal })
  controller.abort()
  assert.throws(() => client.on('Test.event', () => { calls++ }, { signal: controller.signal }), /CDP_ABORTED/)
  socket.emit('message', { data: JSON.stringify({ method: 'Test.event', params: {} }) })
  assert.equal(calls, 0)
  client.dispose()
})
