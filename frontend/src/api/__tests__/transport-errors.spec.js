import { afterEach, describe, expect, it, vi } from 'vitest'

class TestMockProvider {
  generate() {
    throw new Error('该测试不应使用 MockProvider')
  }
}

const transports = []

async function createTransport({ electronMethods, legacy = false } = {}) {
  if (legacy) {
    window.ztools = {
      _sendMessage: vi.fn()
    }
    delete window.__ztoolsElectron
  } else {
    window.__ztoolsElectron = {
      transport: {
        methods: electronMethods || {}
      }
    }
    delete window.ztools
  }

  vi.resetModules()
  const [{ default: environment }, { default: Transport }] = await Promise.all([
    import('../../../public/js/cef-ipc/src/core/environment.js'),
    import('../../../public/js/cef-ipc/src/core/transport.js')
  ])
  globalThis.environment = environment
  globalThis.MockProvider = TestMockProvider

  const transport = new Transport({ timeout: 1000 })
  transports.push(transport)
  return transport
}

describe('SDK transport error compatibility', () => {
  afterEach(() => {
    while (transports.length > 0) transports.pop().destroy()
    delete window.ztools
    delete window.__ztoolsElectron
    delete globalThis.environment
    delete globalThis.MockProvider
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('preserves structured Electron preload error codes and messages and clears pending state', async () => {
    vi.useFakeTimers()
    const transport = await createTransport({
      electronMethods: {
        diagnostics_get: async (request) => ({
          messageId: request.messageId,
          success: false,
          error: { code: 'PERMISSION_DENIED', message: '拒绝访问' }
        })
      }
    })

    const failure = await transport.call('diagnostics_get', {}).catch(error => error)
    expect(failure).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '拒绝访问'
    })
    expect(failure.requestId).toMatch(/^js_[0-9]+_[0-9]+_diagnostics_get$/)
    expect(Object.keys(failure)).not.toContain('requestId')
    expect(JSON.stringify(failure)).not.toContain(failure.requestId)
    expect(transport.getPendingCallsCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps legacy CEF message-only failures rejectable and clears pending state', async () => {
    vi.useFakeTimers()
    const transport = await createTransport({ legacy: true })
    const call = transport.call('get_system_info', {})
    expect(transport.getPendingCallsCount()).toBe(1)

    const [, paramsJson] = window.ztools._sendMessage.mock.calls[0]
    const { _messageId: messageId } = JSON.parse(paramsJson)
    transport.handleMessage('response', {
      _messageId: messageId,
      success: false,
      error: '旧宿主错误信息'
    })

    const failure = await call.catch(error => error)
    expect(failure).toMatchObject({ message: '旧宿主错误信息' })
    expect(failure.requestId).toBe(messageId)
    expect(Object.keys(failure)).not.toContain('requestId')
    expect(transport.getPendingCallsCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
