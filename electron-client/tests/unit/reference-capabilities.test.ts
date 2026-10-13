import assert from 'node:assert/strict'
import test from 'node:test'
import { REFERENCE_METHODS } from '../../src/contracts/reference-transport.js'
import { canCallReferenceMethod, referenceMethodCallers } from '../../src/contracts/reference-capabilities.js'

test('all canonical reference methods have an explicit immutable caller policy', () => {
  assert.deepEqual(Object.keys(referenceMethodCallers).sort(), [...REFERENCE_METHODS].sort())
  assert.equal(Object.isFrozen(referenceMethodCallers), true)
  for (const method of REFERENCE_METHODS) {
    assert.equal(Object.isFrozen(referenceMethodCallers[method]), true)
    assert.equal(canCallReferenceMethod(method, { type: 'main', webContentsId: 1 }), true)
    assert.equal(canCallReferenceMethod(method, { type: 'plugin', webContentsId: 2, pluginId: 'example', pluginInstanceId: 'one' }),
      !['filesystem_list_write_recovery', 'filesystem_inspect_write_recovery'].includes(method))
  }
})

test('unknown and inherited method names never grant reference capability', () => {
  for (const method of ['constructor', '__proto__', 'toString', 'native_load', '', null, undefined, 2]) {
    assert.equal(canCallReferenceMethod(method, { type: 'main', webContentsId: 1 }), false)
  }
})
