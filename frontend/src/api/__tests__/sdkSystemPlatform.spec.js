import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemAPI from '../../../public/js/cef-ipc/src/api/sys.js'
import MockProvider from '../../../public/js/cef-ipc/src/core/mock-provider.js'

function createSystemApi(response) {
  const transport = { call: vi.fn().mockResolvedValue(response) }
  return { api: new SystemAPI(transport), transport }
}

describe('SDK system platform detection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves the legacy getInfo success response without reshaping it', async () => {
    const legacyResponse = Object.freeze({
      success: true,
      systemInfo: Object.freeze({ version: 'legacy-value' }),
      extensionField: 'preserved'
    })
    const { api, transport } = createSystemApi(legacyResponse)

    await expect(api.getInfo()).resolves.toBe(legacyResponse)
    expect(transport.call).toHaveBeenCalledWith('get_system_info', {})
  })

  it.each([
    [
      {
        success: true,
        platform: 'windows',
        isWindows: true,
        isMacOS: false,
        isLinux: false
      }
    ],
    [
      {
        success: true,
        platform: 'macos',
        isWindows: false,
        isMacOS: true,
        isLinux: false
      }
    ],
    [
      {
        success: true,
        platform: 'linux',
        isWindows: false,
        isMacOS: false,
        isLinux: true
      }
    ]
  ])('preserves successful host platform response %#', async (response) => {
    const { api, transport } = createSystemApi(response)

    await expect(api.getPlatform()).resolves.toEqual({
      platform: response.platform,
      isWindows: response.isWindows,
      isMacOS: response.isMacOS,
      isLinux: response.isLinux
    })
    expect(transport.call).toHaveBeenCalledWith('system_get_platform', {})
  })

  it.each([
    { success: false },
    undefined,
    new Error('IPC unavailable')
  ])('returns an explicit unknown platform when the host query fails (%#)', async (response) => {
    const transport = {
      call: response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response)
    }
    const api = new SystemAPI(transport)

    await expect(api.getPlatform()).resolves.toEqual({
      platform: 'unknown',
      isWindows: false,
      isMacOS: false,
      isLinux: false
    })
  })

  it('returns false from all platform predicates when the host is unknown', async () => {
    const { api } = createSystemApi({
      success: true,
      platform: 'unknown',
      isWindows: false,
      isMacOS: false,
      isLinux: false
    })

    await expect(
      Promise.all([api.isWindows(), api.isMacOS(), api.isLinux()])
    ).resolves.toEqual([false, false, false])
  })

  it('reports unknown in the browser MockProvider', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new MockProvider()

    expect(provider.generate('system_get_platform', {})).toEqual({
      success: true,
      platform: 'unknown',
      isWindows: false,
      isMacOS: false,
      isLinux: false
    })
  })

  it('queries capability snapshots only through the Electron preload transport', async () => {
    const snapshot = {
      contractVersion: 1,
      target: { platform: 'windows', runtime: 'electron', arch: 'x64' },
      capability: 'screen.capture',
      implementation: 'unavailable',
      authorization: 'unknown',
      osPermission: 'unknown',
      revision: 1
    }
    const transport = {
      call: vi.fn().mockResolvedValue(snapshot),
      isElectronEnvironment: vi.fn().mockReturnValue(true)
    }
    const api = new SystemAPI(transport)

    await expect(api.getCapability('screen.capture')).resolves.toEqual(snapshot)
    expect(transport.call).toHaveBeenCalledWith('runtime_capability_get', {
      capability: 'screen.capture'
    })
  })

  it('queries the current runtime identity without caller-supplied identity fields', async () => {
    const identity = {
      contractVersion: 1,
      appVersion: '1.1.7.1',
      target: { platform: 'macos', runtime: 'electron', arch: 'universal' },
      os: { productVersion: '14.5', kernelVersion: '23.5.0', arch: 'arm64' },
      process: { arch: 'x64', translationMode: 'translated' },
      nativeHost: { state: 'not-applicable', arch: 'unknown', protocolVersion: null }
    }
    const transport = {
      call: vi.fn().mockResolvedValue(identity),
      isElectronEnvironment: vi.fn().mockReturnValue(true)
    }
    const api = new SystemAPI(transport)

    await expect(api.getRuntimeIdentity()).resolves.toEqual(identity)
    expect(transport.call).toHaveBeenCalledWith('system_get_runtime_identity', {})
  })

  it.each([
    { isElectronEnvironment: () => false },
    {}
  ])('fails closed outside Electron or when environment detection is unavailable', async (environment) => {
    const transport = { call: vi.fn(), ...environment }
    const api = new SystemAPI(transport)

    await expect(api.getRuntimeIdentity()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(transport.call).not.toHaveBeenCalled()
  })

  it.each([
    { isElectronEnvironment: () => false },
    {}
  ])('fails closed outside Electron or when environment detection is unavailable', async (environment) => {
    const transport = { call: vi.fn(), ...environment }
    const api = new SystemAPI(transport)

    await expect(api.getCapability('screen.capture')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED'
    })
    expect(transport.call).not.toHaveBeenCalled()
  })
})
