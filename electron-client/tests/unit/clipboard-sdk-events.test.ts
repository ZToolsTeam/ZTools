import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
function fixture() {
  const source = ['core/events', 'api/clipboard'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const constructors = vm.runInNewContext(source + String.fromCharCode(10) + '({ Events, ClipboardAPI })', { window: {}, setTimeout, clearTimeout, console }) as { Events: new (transport: unknown) => { on(key: string, handler: (value: unknown) => void): void; off(key: string, handler?: unknown): void; dispatchEnvelope(value: unknown): void; handlers: Map<string, Set<unknown>> }; ClipboardAPI: new (transport: unknown, events: unknown) => { onChange(handler: unknown): () => void; offChange(handler?: unknown): void } }
  const calls: string[] = [], transport = { call: async (method: string) => { calls.push(method); return { success: true } } }
  const events = new constructors.Events(transport), api = new constructors.ClipboardAPI(transport, events)
  const emit = () => events.dispatchEnvelope({ type: 'clipboard_change', payload: { type: 'text', text: 'one' } })
  return { api, events, calls, emit }
}
const flushEvents = () => new Promise<void>(resolve => setImmediate(resolve))

test('clipboard offChange removes original callback and only unsubscribes after its last listener', async () => {
  const f = fixture(), received: unknown[] = [], handler = (value: unknown) => received.push(value), second = (value: unknown) => received.push(value)
  f.api.onChange(handler); f.api.onChange(second); f.emit(); assert.equal(received.length, 2)
  f.api.offChange(handler); f.emit(); assert.equal(received.length, 3); assert.deepEqual(f.calls, ['event_subscribe'])
  f.api.offChange(second); f.emit(); assert.equal(received.length, 3); await flushEvents(); assert.deepEqual(f.calls, ['event_subscribe', 'event_unsubscribe'])
})
test('clipboard repeated registration/disposal is idempotent and old disposer cannot remove reregistered callback', async () => {
  const f = fixture(); let count = 0; const handler = () => count++
  const dispose = f.api.onChange(handler); assert.equal(f.api.onChange(handler), dispose); f.emit(); assert.equal(count, 1)
  dispose(); dispose(); await flushEvents(); assert.equal(f.calls.filter(call => call === 'event_unsubscribe').length, 1)
  const next = f.api.onChange(handler); dispose(); f.emit(); assert.equal(count, 2); next(); f.emit(); assert.equal(count, 2)
})
test('clipboard offChange with no handler removes its wrappers without removing direct shared event subscribers', () => {
  const f = fixture(); let direct = 0, own = 0
  const outside = () => direct++
  f.events.on('clipboard_change', outside); f.api.onChange(() => own++); f.api.onChange(() => own++)
  assert.throws(() => f.api.offChange('invalid')); f.api.offChange(); f.emit(); assert.equal(direct, 1); assert.equal(own, 0)
  assert.equal(f.events.handlers.get('clipboard_change')?.size, 1); assert.deepEqual(f.calls, ['event_subscribe']); f.events.off('clipboard_change', outside)
})
