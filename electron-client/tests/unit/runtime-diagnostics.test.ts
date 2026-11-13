import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNativeRuntimeDiagnosticsFallback,
  RuntimeDiagnosticFailureStore,
  sanitizeRuntimeDiagnosticDetails
} from '../../src/main/services/runtime-diagnostics.js'

test('native helper diagnostics distinguish unsupported platforms from closed Windows helpers', () => {
  assert.deepEqual(createNativeRuntimeDiagnosticsFallback('darwin'), {
    nativeHost: { state: 'unsupported', stderr: '' },
    service: {
      state: 'unsupported',
      protocolVersion: 1,
      pipe: '',
      lastError: '',
      lastErrorMessage: ''
    }
  })
  assert.equal(createNativeRuntimeDiagnosticsFallback('win32').nativeHost.state, 'closed')
  assert.equal(createNativeRuntimeDiagnosticsFallback('linux').service.state, 'unsupported')
  assert.equal(createNativeRuntimeDiagnosticsFallback('plan9').nativeHost.state, 'unknown')
  // 旧超级面板输入诊断已移除，回退结构只剩 nativeHost 与 service
  assert.deepEqual(Object.keys(createNativeRuntimeDiagnosticsFallback('win32')).sort(), ['nativeHost', 'service'])
})

test('runtime diagnostics hide raw helper, pipe, and platform error text', () => {
  const sanitized = sanitizeRuntimeDiagnosticDetails({
    nativeHost: {
      state: 'crashed',
      pid: 123,
      stderr: 'failed at /Users/alice/private/install path'
    },
    service: {
      state: 'unavailable',
      protocolVersion: 1,
      pipe: '\\\\.\\pipe\\ztools-private',
      lastError: 'SERVICE_UNAVAILABLE',
      lastErrorMessage: 'connect failed at C:\\Users\\alice\\private\\service.key'
    }
  })

  assert.deepEqual(sanitized, {
    nativeHost: {
      state: 'crashed',
      pid: 123,
      stderr: 'Native Host 原始错误详情已隐藏'
    },
    service: {
      state: 'unavailable',
      protocolVersion: 1,
      pipe: '已配置',
      lastError: 'SERVICE_UNAVAILABLE',
      lastErrorMessage: 'ZToolsService 原始错误详情已隐藏'
    }
  })

  assert.equal(
    sanitizeRuntimeDiagnosticDetails({
      nativeHost: { state: 'ready', stderr: '' },
      service: {
        state: 'ready',
        protocolVersion: 1,
        pipe: '',
        lastError: '',
        lastErrorMessage: ''
      }
    }).service.lastError,
    ''
  )
  assert.equal(
    sanitizeRuntimeDiagnosticDetails({
      nativeHost: { state: 'ready', stderr: '' },
      service: {
        state: 'unavailable',
        protocolVersion: 1,
        pipe: '',
        lastError: 'C:\\Users\\alice\\secret.key',
        lastErrorMessage: ''
      }
    }).service.lastError,
    'INTERNAL_ERROR'
  )
})

test('request failure diagnostics are bounded, redacted, and scoped to the actual caller instance', () => {
  let now = Date.parse('2026-10-09T01:00:00.000Z')
  const store = new RuntimeDiagnosticFailureStore(() => now)
  const owner = { type: 'plugin' as const, webContentsId: 17, pluginId: 'sample', pluginInstanceId: 'instance-a' }
  const otherInstance = { ...owner, webContentsId: 18, pluginInstanceId: 'instance-b' }
  store.record(owner, {
    requestId: 'js_1_2_network_http_request', method: 'network_http_request',
    failureStage: 'validation', errorCode: 'INVALID_REQUEST'
  })
  store.record(otherInstance, {
    requestId: 'js_1_3_network_http_request', method: 'network_http_request',
    failureStage: 'execute', errorCode: 'NETWORK_ERROR'
  })

  assert.deepEqual(store.read(owner, ['js_1_2_network_http_request']), [{
    schemaVersion: 1,
    layer: 'main',
    requestId: 'js_1_2_network_http_request',
    method: 'network_http_request',
    failureStage: 'validation',
    errorCode: 'INVALID_REQUEST',
    occurredAt: '2026-10-09T01:00:00.000Z'
  }])
  assert.deepEqual(store.read(owner, ['js_1_3_network_http_request']), [])
  assert.deepEqual(store.read(otherInstance, ['js_1_2_network_http_request']), [])

  store.record(owner, {
    requestId: 'js_1_4_network_http_request', method: 'network_http_request',
    failureStage: 'unknown/path', errorCode: 'C:\\Users\\private\\secret.txt'
  })
  const safe = store.read(owner, ['js_1_4_network_http_request'])[0]
  assert.equal(safe?.failureStage, 'unknown')
  assert.equal(safe?.errorCode, 'INTERNAL_ERROR')
  assert.equal(JSON.stringify(safe).includes('private'), false)

  now += 30 * 60 * 1000 + 1
  assert.deepEqual(store.read(owner, ['js_1_2_network_http_request']), [])
})

test('request failure diagnostics reject malformed IDs and evict oldest entries at the ring bound', () => {
  let now = Date.parse('2026-10-09T02:00:00.000Z')
  const store = new RuntimeDiagnosticFailureStore(() => now)
  const owner = { type: 'plugin' as const, webContentsId: 21, pluginId: 'sample', pluginInstanceId: 'instance-c' }
  store.record(owner, { requestId: 'bad/id', method: 'network_http_request', failureStage: 'execute', errorCode: 'FILE_ERROR' })
  assert.deepEqual(store.read(owner, ['bad/id']), [])
  for (let index = 0; index < 300; index += 1) {
    store.record(owner, {
      requestId: `req-${index}`, method: 'network_http_request', failureStage: 'execute', errorCode: 'FILE_ERROR'
    })
    now += 1
  }
  assert.deepEqual(store.read(owner, ['req-0']), [])
  assert.equal(store.read(owner, ['req-299']).length, 1)
  assert.equal(store.read(owner, Array.from({ length: 65 }, (_, index) => `req-${index}`)).length, 0)
})
