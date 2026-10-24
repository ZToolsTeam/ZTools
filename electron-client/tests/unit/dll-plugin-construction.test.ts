import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeDllEventListener } from '../../src/main/native-host/native-host-client.js'
import { DllPluginService } from '../../src/main/services/dll-plugin-service.js'

test('removes the NativeHost listener when the later window subscription fails', () => {
  const listeners = new Set<NativeDllEventListener>()
  const constructionFailure = new Error('window subscription failed')
  const cleanupFailure = new Error('native listener removal failed')
  const nativeHost = {
    onDllEvent(listener: NativeDllEventListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        throw cleanupFailure
      }
    }
  }

  assert.throws(
    () => new DllPluginService(
      {} as never,
      nativeHost as never,
      null,
      {} as never,
      { onRemoved() { throw constructionFailure } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [constructionFailure, cleanupFailure])
      return true
    }
  )
  assert.equal(listeners.size, 0)
})
