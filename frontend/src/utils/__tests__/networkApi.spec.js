import { describe, expect, it, vi } from 'vitest'
import NetworkAPI from '../../../public/js/cef-ipc/src/api/network.js'
import MockProvider from '../../../public/js/cef-ipc/src/core/mock-provider.js'

describe('NetworkAPI', () => {
  it('keeps AbortSignal out of IPC params and gives the transport a small deadline margin', async () => {
    const call = vi.fn(async () => ({
      success: true,
      data: { statusCode: 200, statusText: 'OK', body: '{}' }
    }))
    const network = new NetworkAPI({ call })
    const controller = new AbortController()

    await expect(network.request({
      method: 'post',
      url: 'https://example.com/api',
      body: { ok: true },
      timeout: 45_000,
      signal: controller.signal
    })).resolves.toEqual({
      success: true,
      data: { statusCode: 200, statusText: 'OK', body: '{}' }
    })
    expect(call).toHaveBeenCalledWith(
      'network_http_request',
      {
        method: 'POST',
        url: 'https://example.com/api',
        headers: undefined,
        body: '{"ok":true}',
        timeout: 45_000
      },
      { timeout: 45_250, signal: controller.signal }
    )
    expect(call.mock.calls[0][1]).not.toHaveProperty('signal')
  })

  it('keeps the outer IPC deadline after NetworkService even at the maximum request timeout', async () => {
    const call = vi.fn(async () => ({ success: true, data: { statusCode: 200, body: '{}' } }))
    await new NetworkAPI({ call }).request({ method: 'GET', url: 'https://example.com', timeout: 300_000 })
    expect(call.mock.calls[0][2]).toEqual({ timeout: 300_250 })
  })

  it('keeps browser mock response shapes aligned with native hosts', () => {
    const mock = new MockProvider()
    expect(mock.generate('network_http_request', {})).toMatchObject({
      success: true,
      data: { statusCode: 200, statusText: 'OK' }
    })
    expect(mock.generate('network_get_cookie', { url: 'https://example.com' })).toEqual([])
  })

  it('uses the bounded transfer timeout and reports terminal progress', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ success: true, path: 'C:\\save.bin', size: 12 })
      .mockResolvedValueOnce({ success: true, data: { statusCode: 201, body: '{}' } })
    const network = new NetworkAPI({ call })
    const downloadProgress = vi.fn()
    const uploadProgress = vi.fn()

    await network.download('https://example.com/file', 'C:\\save.bin', {
      timeout: 60_000,
      onProgress: downloadProgress
    })
    await network.upload('https://example.com/upload', 'C:\\upload.bin', {
      fieldName: 'document',
      timeout: 45_000,
      onProgress: uploadProgress
    })

    expect(call).toHaveBeenNthCalledWith(1, 'network_http_download', {
      url: 'https://example.com/file',
      savePath: 'C:\\save.bin',
      headers: undefined,
      timeout: 60_000
    }, { timeout: 60_000 })
    expect(call).toHaveBeenNthCalledWith(2, 'network_http_upload', {
      url: 'https://example.com/upload',
      filePath: 'C:\\upload.bin',
      fieldName: 'document',
      headers: undefined,
      timeout: 45_000
    }, { timeout: 45_000 })
    expect(downloadProgress).toHaveBeenCalledWith(12, 12)
    expect(uploadProgress).toHaveBeenCalledWith(1, 1)
  })
})
