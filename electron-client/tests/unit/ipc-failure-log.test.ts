import assert from 'node:assert/strict'
import test from 'node:test'
import { getIpcFailureLogIdentifierFields } from '../../src/main/ipc/router.js'
import type { ZToolsRequest } from '../../src/contracts/ipc.js'

test('credential IPC failure diagnostics do not inspect request parameters', () => {
  for (const method of [
    'credential_v1_status',
    'credential_v1_set',
    'credential_v1_get',
    'credential_v1_delete'
  ]) {
    const request = { method } as unknown as ZToolsRequest
    Object.defineProperty(request, 'params', {
      get() { throw new Error('credential params must not be read') }
    })
    assert.deepEqual(getIpcFailureLogIdentifierFields(request), {}, method)

    const secret = `secret-${method}`
    const malformed = {
      method,
      params: { plugin: secret, func: secret, credential: secret }
    } as unknown as ZToolsRequest
    const fields = getIpcFailureLogIdentifierFields(malformed)
    assert.deepEqual(fields, {}, method)
    assert.equal(JSON.stringify({ method, ...fields }).includes(secret), false, method)
  }
})

test('non-credential IPC failures retain safe DLL diagnostic identifiers', () => {
  assert.deepEqual(
    getIpcFailureLogIdentifierFields({
      messageId: 'request-1',
      method: 'dllplugin_call',
      params: { plugin: 'CapturePlugin', func: 'TakeScreenshot' }
    }),
    { dllId: 'CapturePlugin', functionName: 'TakeScreenshot' }
  )
})
