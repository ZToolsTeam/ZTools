import assert from 'node:assert/strict'
import test from 'node:test'
import { getIpcFailureLogIdentifierFields, isIpcCapabilityBoundary } from '../../src/main/ipc/router.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
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

test('只有显式 NOT_SUPPORTED 的 ZToolsError 视为平台能力边界，其余失败仍按故障记录', () => {
  assert.equal(isIpcCapabilityBoundary(new ZToolsError(errorCodes.notSupported, '当前更新安装链仅支持 Windows')), true)
  for (const error of [
    new ZToolsError(errorCodes.pluginNotFound, '插件不存在'),
    new ZToolsError(errorCodes.permissionDenied, 'denied'),
    Object.assign(new Error('forged'), { code: errorCodes.notSupported }),
    { code: errorCodes.notSupported },
    'NOT_SUPPORTED',
    undefined,
    null
  ]) {
    assert.equal(isIpcCapabilityBoundary(error), false, String((error as { message?: string })?.message ?? error))
  }
})

