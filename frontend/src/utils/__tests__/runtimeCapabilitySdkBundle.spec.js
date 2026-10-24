import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const sdkBundlePath = path.resolve(process.cwd(), 'public/sdk/ztools-api.js')

function loadGeneratedSdk(authorization, requestAuthorization = 'denied') {
  const code = readFileSync(sdkBundlePath, 'utf8')
  const calls = []
  const methods = {}
  for (const method of ['app_ready', 'runtime_capability_get', 'runtime_capability_request', 'screen_capture',
    'filesystem_read_file_chunk', 'filesystem_delete_file']) {
    methods[method] = async request => {
      calls.push({ method, params: request.params })
      let data
      if (method === 'runtime_capability_get') data = { capability: 'screen.capture', authorization, osPermission: 'not-required' }
      else if (method === 'runtime_capability_request') data = { capability: 'screen.capture', authorization: requestAuthorization }
      else if (method === 'screen_capture') data = { success: true, tempFile: 'fixture/capture.png' }
      else if (method === 'filesystem_read_file_chunk') {
        const content = Buffer.from([0x89, 0x50, 0x4e]).toString('base64')
        data = { success: true, offset: 0, size: 3, totalSize: 3, content }
      } else if (method === 'filesystem_delete_file') data = { success: true }
      else data = { success: true }
      return { messageId: request.messageId, success: true, data }
    }
  }
  const transport = { methods, cancellations: {}, setMessageCallback() {} }
  const window = { __ztoolsElectron: { contractVersion: 1, transport }, localStorage: null, addEventListener() {} }
  const context = {
    window,
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: { userAgent: 'fixture', platform: 'Win32' },
    localStorage: { getItem() { return null }, setItem() {} },
    console,
    Date,
    Math,
    Promise,
    Map,
    Set,
    Uint8Array,
    ArrayBuffer,
    TextDecoder,
    setTimeout,
    clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary')
  }
  vm.runInNewContext(code, context, { timeout: 3000, filename: sdkBundlePath })
  return { sdk: window.ztools, calls }
}

describe('generated SDK runtime capability wiring', () => {
  it('loads the bundled helper, requests once when not requested, and blocks capture after denial', async () => {
    const { sdk, calls } = loadGeneratedSdk('not-requested', 'denied')
    try {
      await expect(sdk.screen.capture()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(calls.filter(call => call.method).map(call => call.method)).toContain('runtime_capability_request')
      expect(calls.some(call => call.method === 'screen_capture')).toBe(false)
    } finally {
      sdk.destroy()
    }
  })

  it('keeps the trusted Main-granted path and delivers the returned screenshot bytes', async () => {
    const { sdk, calls } = loadGeneratedSdk('granted')
    try {
      await expect(sdk.screen.capture()).resolves.toBe('data:image/png;base64,iVBO')
      expect(calls.some(call => call.method === 'runtime_capability_request')).toBe(false)
      expect(calls.some(call => call.method === 'screen_capture')).toBe(true)
    } finally {
      sdk.destroy()
    }
  })
})
