import CredentialsAPI from '../../../public/js/cef-ipc/src/api/credentials.js'
import MockProvider from '../../../public/js/cef-ipc/src/core/mock-provider.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const transportSource = readFileSync(
  path.resolve(process.cwd(), 'public/js/cef-ipc/src/core/transport.js'),
  'utf8'
).replace(/^export default Transport\s*$/m, '')
const transportHelpers = vm.runInNewContext(`${transportSource}\n({ shouldRedactParams })`, {
  MockProvider: class {},
  environment: {},
  window: { localStorage: undefined },
  console
})

function createTestTransport(logs) {
  const environment = {
    isElectron: () => false,
    isElectronEnvironment: () => false,
    getElectronTransport: () => undefined,
    showEnvironmentWarning: () => undefined,
    getInfo: () => ({ type: 'test' })
  }
  let transport
  const window = {
    localStorage: undefined,
    ztools: {
      _sendMessage(method, serializedParams) {
        const params = JSON.parse(serializedParams)
        const value = method === 'credential_v1_get' || method === 'db_get_secure'
          ? 'sensitive-response-value'
          : 'OK'
        transport.handleMessage(method, JSON.stringify({
          _messageId: params._messageId,
          success: true,
          data: value
        }))
      }
    }
  }
  const runtime = vm.runInNewContext(`${transportSource}\n({ Transport })`, {
    MockProvider: class {},
    environment,
    window,
    setTimeout,
    clearTimeout,
    console,
    Date,
    Promise,
    Map,
    Error
  })
  transport = new runtime.Transport({ timeout: 1000 })
  transport._log = (...args) => logs.push(args)
  return transport
}

describe('credentials.v1 SDK API', () => {
  it('uses only the existing transport and does not accept a renderer plugin ID', async () => {
    const transport = { call: vi.fn(async () => 'OK') }
    const credentials = new CredentialsAPI(transport)
    expect(await credentials.v1.set('oauth:token', 'secret')).toBe(true)
    expect(transport.call).toHaveBeenCalledWith('credential_v1_set', {
      key: 'oauth:token', value: 'secret'
    })
    expect(transport.call.mock.calls[0][1]).not.toHaveProperty('plugin_id')
    expect(transport.call.mock.calls[0][1]).not.toHaveProperty('pluginId')
  })

  it('validates the UTF-8 limit and maps host failures without exposing raw error text', async () => {
    const transport = { call: vi.fn(async () => 'OK') }
    const credentials = new CredentialsAPI(transport)
    await expect(credentials.v1.set('token', '😀'.repeat(16_385))).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(transport.call).not.toHaveBeenCalled()

    transport.call.mockRejectedValueOnce(Object.assign(new Error('secret/path and token value'), {
      code: 'NOT_SUPPORTED'
    }))
    await expect(credentials.v1.set('token', 'secret')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED', message: '宿主安全凭据存储不可用'
    })
  })

  it('returns explicit unavailable and missing states and supports idempotent delete results', async () => {
    const transport = { call: vi.fn() }
    transport.call.mockResolvedValueOnce({
      success: true, data: { status: 'unavailable', reason: 'insecure-backend' }
    })
    transport.call.mockResolvedValueOnce({ success: true, data: { status: 'missing' } })
    transport.call.mockResolvedValueOnce({ success: true, data: 'OK' })
    const credentials = new CredentialsAPI(transport)
    expect(await credentials.v1.status()).toEqual({ status: 'unavailable', reason: 'insecure-backend' })
    expect(await credentials.v1.get('token')).toBeNull()
    expect(await credentials.v1.delete('token')).toBe(true)
  })

  it('never stores credential values in browser mock storage and redacts transport parameters', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const provider = new MockProvider()
      const response = provider.generate('credential_v1_set', { key: 'token', value: 'secret-token-value' })
      expect(response.success).toBe(false)
      expect(response.error.code).toBe('NOT_SUPPORTED')
      expect(writes).not.toHaveBeenCalled()
      expect(logs.mock.calls.flat().join(' ')).not.toContain('secret-token-value')
      for (const method of ['credential_v1_set', 'credential_v1_get', 'db_put_secure', 'db_get_secure']) {
        expect(transportHelpers.shouldRedactParams(method)).toBe(true)
      }
      expect(transportHelpers.shouldRedactParams('db_put')).toBe(false)
    } finally {
      writes.mockRestore()
      logs.mockRestore()
    }
  })

  it('redacts sensitive request and response payloads in transport debug logs', async () => {
    const logs = []
    const transport = createTestTransport(logs)
    try {
      await transport.call('credential_v1_set', { key: 'token', value: 'sensitive-request-value' })
      await transport.call('credential_v1_get', { key: 'token' })
      await transport.call('db_put_secure', { key: 'token', value: 'sensitive-request-value' })
      await transport.call('db_get_secure', { key: 'token' })
      expect(logs.flat().join(' ')).not.toContain('sensitive-request-value')
      expect(logs.flat().join(' ')).not.toContain('sensitive-response-value')
      expect(logs.flat().join(' ')).toContain('[REDACTED]')
    } finally {
      transport.destroy()
    }
  })
})
