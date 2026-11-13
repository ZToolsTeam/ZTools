import assert from 'node:assert/strict'
import test from 'node:test'
import { installIsolatedClipboardGuard, CdpClient, startLoopbackZipServer, waitForMainPageTarget, WindowsNormalAppHarness } from './windows-normal-app-harness.mjs'

test('malformed report and log phase reject before profile access, ports or process launch', async () => {
  const harness = new WindowsNormalAppHarness({ appRoot: '.', executable: 'missing.exe', outputRoot: '.',
    versions: { electronVersion: '43.4.1' } })
  for (const report of [null, {}, { phases: [] }, { phases: Object.freeze({}) }]) {
    await assert.rejects(harness.start({ profile: null, phase: 'test', report }), { message: 'NORMAL_APP_REPORT_INVALID' })
  }
  await assert.rejects(harness.start({ profile: null, phase: '../escape', report: { phases: {} } }),
    { message: 'NORMAL_APP_PHASE_INVALID' })
})

test('invalid artifact is rejected before a ZIP server or App can be started', async () => {
  for (const artifact of [undefined, { zipPath: 'fixture.zip', fileSize: 100 },
    { path: '', fileSize: 100 }, { path: 'fixture.zip', fileSize: 0 },
    { path: 'fixture.zip', fileSize: 1.5 }]) {
    await assert.rejects(startLoopbackZipServer(artifact, 'fixture.zip', 'controlled-run'),
      { message: 'ZIP_ARTIFACT_INVALID' })
  }
})

class FakeSocket {
  listeners = new Map()
  closeCalls = 0
  sends = 0
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  send() { this.sends += 1 }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  close() { this.closeCalls += 1; this.emit('close') }
}

for (const [event, code, expectedCloseCalls] of [
  ['close', 'CDP_CLOSED', 0], ['error', 'CDP_SOCKET_ERROR', 1]
]) {
  test(`remote ${event} settles commands and events and rejects new work`, async () => {
    const socket = new FakeSocket()
    const client = new CdpClient(socket)
    try {
      const command = client.call('Runtime.enable', {}, 60)
      const waiter = client.waitForEvent('Debugger.paused', () => true, 60)
      const checks = Promise.all([
        assert.rejects(command, { message: code }),
        assert.rejects(waiter, { message: code })
      ])
      socket.emit(event)
      await checks
      const sends = socket.sends
      await assert.rejects(client.call('Runtime.enable', {}, 60), { message: 'CDP_CLOSED' })
      await assert.rejects(client.waitForEvent('Debugger.paused', () => true, 60), { message: 'CDP_CLOSED' })
      assert.equal(socket.sends, sends)
      client.dispose()
      client.dispose()
      assert.equal(socket.closeCalls, expectedCloseCalls)
    } finally { client.dispose() }
  })
}

test('explicit disposal rejects waiters and commands and closes only once', async () => {
  const socket = new FakeSocket()
  const client = new CdpClient(socket)
  const command = client.call('Runtime.enable', {}, 60)
  const waiter = client.waitForEvent('Debugger.paused', () => true, 60)
  const checks = Promise.all([
    assert.rejects(command, { message: 'CDP_CLOSED' }),
    assert.rejects(waiter, { message: 'CDP_CLOSED' })
  ])
  client.dispose()
  client.dispose()
  await checks
  assert.equal(socket.closeCalls, 1)
})

test('main page target lookup retries a transient CDP_TARGET_NOT_READY response', async () => {
  let calls = 0
  const target = { id: 'main', url: 'ztools://web/' }
  const result = await waitForMainPageTarget(async () => {
    calls += 1
    if (calls === 1) throw new Error('CDP_TARGET_NOT_READY')
    return [target]
  }, 1000)
  assert.equal(result, target)
  assert.equal(calls, 2)
})

test('main page target lookup preserves the outer deadline when CDP is never ready', async () => {
  let calls = 0
  await assert.rejects(waitForMainPageTarget(async () => {
    calls += 1
    throw new Error('CDP_TARGET_NOT_READY')
  }, 330), { message: 'NORMAL_MAIN_ZTOOLS_TARGET_NOT_FOUND' })
  assert.ok(calls >= 2)
})

test('main page target lookup does not swallow unrelated errors', async () => {
  const failure = new Error('CDP_METHOD_FAILED')
  let calls = 0
  await assert.rejects(waitForMainPageTarget(async () => {
    calls += 1
    throw failure
  }, 1000), error => error === failure)
  assert.equal(calls, 1)
})

test('preboot clipboard guard never reads or writes the real clipboard', () => {
  let accesses = 0
  const real = () => { accesses += 1; throw new Error('REAL_CLIPBOARD_ACCESSED') }
  const clipboard = Object.fromEntries(['readText', 'readImage', 'availableFormats', 'has', 'readBuffer', 'writeText', 'clear'].map(name => [name, real]))
  const result = installIsolatedClipboardGuard({ clipboard, nativeImage: { createEmpty: () => ({ empty: true }) } })
  assert.equal(result.status, 'PASS')
  assert.equal(clipboard.readText(), '')
  assert.deepEqual(clipboard.readImage(), { empty: true })
  assert.deepEqual(clipboard.availableFormats(), [])
  assert.equal(clipboard.has('FileNameW'), false)
  assert.equal(clipboard.readBuffer().length, 0)
  assert.throws(() => clipboard.writeText('fixture'), { message: 'ISOLATED_CLIPBOARD_WRITE_BLOCKED' })
  assert.throws(() => clipboard.clear(), { message: 'ISOLATED_CLIPBOARD_WRITE_BLOCKED' })
  assert.equal(accesses, 0)
  assert.throws(() => installIsolatedClipboardGuard({ clipboard: { readFuture: real } }), { message: 'ISOLATED_CLIPBOARD_METHOD_UNSUPPORTED' })
})
