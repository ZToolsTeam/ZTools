import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync('../frontend/public/sdk/plugin-sdk.js', 'utf8')
interface SDK { onPluginOut(callback: (isKill: boolean) => unknown): () => void }
function fixture() {
  const handlers = new Map<string, (value: unknown) => Promise<void>>()
  const documentHandlers = new Map<string, () => void>()
  const replies: Array<{ id: string; payload: { ok: boolean } }> = []
  const errors: unknown[][] = []
  const window = { location: { href: 'ztools://plugins/calculator/index.html' }, ztoolsPlugin: undefined as unknown as SDK,
    ztools: { events: { on: (type: string, handler: (value: unknown) => Promise<void>) => handlers.set(type, handler),
      respond: async (id: string, payload: { ok: boolean }) => { replies.push({ id, payload }) } } } }
  vm.runInNewContext(source, { window, document: { readyState: 'loading', documentElement: { classList: { toggle() {} } },
    addEventListener: (type: string, handler: () => void) => documentHandlers.set(type, handler) },
    TextEncoder, setTimeout, clearTimeout, console: { log() {}, error: (...args: unknown[]) => errors.push(args) } })
  documentHandlers.get('DOMContentLoaded')!()
  return { sdk: window.ztoolsPlugin, replies, errors, emit: (id: string, isKill: unknown = false) => handlers.get('plugin_out')!({
    envelopeId: id, correlationId: id, source: { kind: 'host' }, payload: { isKill } }) }
}

test('exit waits for every callback and confirms only after asynchronous work completes', async () => {
  const f = fixture()
  let finish!: () => void
  f.sdk.onPluginOut(isKill => { assert.equal(isKill, false); return new Promise<void>(resolve => { finish = resolve }) })
  const exit = f.emit('host_one')
  await Promise.resolve()
  assert.equal(f.replies.length, 0)
  finish()
  await exit
  assert.equal(f.replies.length, 1)
  assert.equal(f.replies[0]!.id, 'host_one')
  assert.equal(f.replies[0]!.payload.ok, true)
})

test('synchronous and asynchronous callback errors produce failed acknowledgement without raw errors', async () => {
  const f = fixture()
  f.sdk.onPluginOut(() => { throw new Error('synthetic-secret-value') })
  f.sdk.onPluginOut(async () => { throw new Error('synthetic-secret-value') })
  await f.emit('host_two', true)
  assert.equal(f.replies[0]!.payload.ok, false)
  assert.ok(f.errors.length > 0)
  assert.equal(JSON.stringify(f.errors).includes('synthetic-secret-value'), false)
})

test('duplicate exit is one-shot and a competing request cannot run callbacks twice', async () => {
  const f = fixture()
  let finish!: () => void
  let calls = 0
  f.sdk.onPluginOut(() => { calls++; return new Promise<void>(resolve => { finish = resolve }) })
  const exit = f.emit('host_three')
  await f.emit('host_three')
  await f.emit('host_competing')
  assert.equal(calls, 1)
  assert.equal(f.replies[0]!.payload.ok, false)
  finish()
  await exit
  await f.emit('host_three')
  assert.equal(calls, 1)
  assert.equal(f.replies.length, 2)
})

test('invalid host payload fails without invoking callbacks and removed handlers remain removed', async () => {
  const f = fixture()
  let calls = 0
  const unsubscribe = f.sdk.onPluginOut(() => { calls++ })
  await f.emit('host_bad', 'false')
  assert.equal(calls, 0)
  assert.equal(f.replies[0]!.payload.ok, false)
  unsubscribe()
  unsubscribe()
  await f.emit('host_empty')
  assert.equal(calls, 0)
  assert.equal(f.replies[1]!.payload.ok, true)
})
