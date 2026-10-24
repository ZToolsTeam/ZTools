import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class TestMockProvider {
  generate() {
    throw new Error('Electron 环境不应使用 MockProvider')
  }
}

async function createTransport(methods = {}) {
  window.__ztoolsElectron = {
    transport: {
      methods,
      setMessageCallback: vi.fn()
    }
  }
  vi.resetModules()
  const [{ default: detectedEnvironment }, { default: Transport }] =
    await Promise.all([
      import('../../../public/js/cef-ipc/src/core/environment.js'),
      import('../../../public/js/cef-ipc/src/core/transport.js')
    ])
  globalThis.environment = detectedEnvironment
  globalThis.MockProvider = TestMockProvider
  return { transport: new Transport({ timeout: 1000 }), environment: detectedEnvironment }
}

async function createCEFTransport() {
  window.ztools = {
    _sendMessage: vi.fn(),
    _setMessageCallback: vi.fn()
  }
  vi.resetModules()
  const [{ default: detectedEnvironment }, { default: Transport }] =
    await Promise.all([
      import('../../../public/js/cef-ipc/src/core/environment.js'),
      import('../../../public/js/cef-ipc/src/core/transport.js')
    ])
  globalThis.environment = detectedEnvironment
  globalThis.MockProvider = TestMockProvider
  return { transport: new Transport({ timeout: 1000 }), environment: detectedEnvironment }
}

describe('Electron SDK transport', () => {
  beforeEach(() => {
    delete window.ztools
    delete window.__ztoolsElectron
  })

  afterEach(() => {
    delete window.ztools
    delete window.__ztoolsElectron
    delete globalThis.environment
    delete globalThis.MockProvider
    vi.restoreAllMocks()
  })

  it('detects Electron before browser fallback', async () => {
    const { environment } = await createTransport()
    expect(environment.getInfo()).toMatchObject({
      type: 'electron',
      isElectron: true,
      isCEF: false,
      isBrowser: false
    })
  })

  it('prefers the controlled Electron bridge when CEF bindings also exist', async () => {
    window.ztools = {
      _sendMessage: vi.fn(),
      _setMessageCallback: vi.fn()
    }
    const { environment, transport } = await createTransport()
    expect(environment.getInfo()).toMatchObject({
      type: 'electron',
      isElectron: true,
      isCEF: false
    })
    expect(transport.getElectronTransport()).toBe(window.__ztoolsElectron.transport)
  })

  it('keeps the CEF V8 binding path available on the merged branch', async () => {
    const { transport, environment } = await createCEFTransport()
    const pending = transport.call('app_ready', { status: 'initialized' })
    const [, payload] = window.ztools._sendMessage.mock.calls[0]
    const request = JSON.parse(payload)

    transport.handleMessage('app_ready', {
      _messageId: request._messageId,
      success: true,
      accepted: true
    })

    await expect(pending).resolves.toMatchObject({ accepted: true })
    expect(environment.getInfo()).toMatchObject({
      type: 'cef',
      isElectron: false,
      isCEF: true,
      isBrowser: false
    })
    expect(transport.getElectronTransport()).toBeNull()
  })

  it('falls back to browser mode when no host capability is present', async () => {
    vi.resetModules()
    const { default: detectedEnvironment } = await import(
      '../../../public/js/cef-ipc/src/core/environment.js'
    )
    expect(detectedEnvironment.getInfo()).toMatchObject({
      type: 'browser',
      isElectron: false,
      isCEF: false,
      isBrowser: true
    })
  })

  it('routes calls through the controlled preload bridge', async () => {
    const appReady = vi.fn(async (request) => ({
      messageId: request.messageId,
      success: true,
      data: { accepted: true }
    }))
    const { transport } = await createTransport({ app_ready: appReady })
    const response = await transport.call('app_ready', { status: 'initialized' })
    expect(response).toEqual({ accepted: true })
    expect(appReady).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { status: 'initialized' },
        timeoutMs: 1000
      })
    )
  })

  it('encodes an explicit infinite wait for interactive dialogs', async () => {
    const showDialog = vi.fn(async (request) => ({
      messageId: request.messageId,
      success: true,
      data: { canceled: true }
    }))
    const { transport } = await createTransport({ window_show_open_dialog: showDialog })
    await expect(
      transport.call('window_show_open_dialog', {}, { timeout: Infinity })
    ).resolves.toEqual({ canceled: true })
    expect(showDialog).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 'infinite' })
    )
  })

  it('preserves structured Electron errors', async () => {
    const { transport } = await createTransport({
      diagnostics_get: async (request) => ({
        messageId: request.messageId,
        success: false,
        error: { code: 'PERMISSION_DENIED', message: '拒绝访问' }
      })
    })
    await expect(transport.call('diagnostics_get', {})).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '拒绝访问'
    })
  })

  it('rejects mismatched response identities', async () => {
    const { transport } = await createTransport({
      app_ready: async () => ({
        messageId: 'wrong',
        success: true,
        data: null
      })
    })
    await expect(transport.call('app_ready', { status: 'initialized' })).rejects.toThrow(
      'messageId mismatch'
    )
  })

  it('rejects methods not exposed by preload before IPC', async () => {
    const { transport } = await createTransport()
    await expect(transport.call('shell_open', {})).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND'
    })
  })
})
