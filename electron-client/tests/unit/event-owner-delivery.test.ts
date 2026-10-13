import assert from 'node:assert/strict'
import test from 'node:test'
import { EventService } from '../../src/main/services/event-service.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'

test('capability host events reach only the captured window instance, including wildcard subscribers', () => {
  const sent: { id: number; value: unknown }[] = []
  const events = new EventService({ send: (id, _, value) => { sent.push({ id, value }); return true }, onRemoved: () => () => {} })
  const owner: CallerIdentity = { type: 'plugin', webContentsId: 1, pluginId: 'same', pluginInstanceId: 'one' }
  const second: CallerIdentity = { ...owner, webContentsId: 2, pluginInstanceId: 'two' }
  const main: CallerIdentity = { type: 'main', webContentsId: 3 }
  try {
    for (const caller of [owner, second, main]) events.subscribe({ key: '*' }, caller)
    assert.equal(events.publishHostToOwner('clipboard_change', { grantId: 'private' }, owner).delivered, 1)
    assert.deepEqual(sent.map(item => item.id), [1])
    assert.equal(events.publishHostToOwner('clipboard_change', {}, { ...owner, pluginInstanceId: 'stale' }).delivered, 0)
    assert.equal(events.publishHostToOwner('clipboard_change', {}, { ...owner, type: 'main' }).delivered, 0)
    events.subscribe({ key: '*' }, { ...owner, pluginInstanceId: 'replacement' })
    assert.equal(events.publishHostToOwner('clipboard_change', {}, owner).delivered, 0)
    assert.equal(events.publishHostToOwner('clipboard_change', {}, main).delivered, 1)
    events.unsubscribe({ key: '*' }, main)
    assert.equal(events.publishHostToOwner('clipboard_change', {}, main).delivered, 0)
    assert.deepEqual(sent.map(item => item.id), [1, 3])
  } finally { events.stop() }
})

test('failed owner delivery removes only that owner subscription and stopped events reject delivery', () => {
  const events = new EventService({ send: () => false, onRemoved: () => () => {} })
  const owner: CallerIdentity = { type: 'main', webContentsId: 1 }
  events.subscribe({ key: 'clipboard_change' }, owner)
  assert.equal(events.publishHostToOwner('clipboard_change', {}, owner).delivered, 0)
  assert.deepEqual(events.subscribers('clipboard_change'), [])
  events.stop()
  assert.throws(() => events.publishHostToOwner('clipboard_change', {}, owner))
})
