import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileSystemAPI from '../../../public/js/cef-ipc/src/api/fs.js'

describe('Electron FileSystem SDK', () => {
  let call
  let api

  beforeEach(() => {
    call = vi.fn()
    api = new FileSystemAPI({
      call,
      isElectronEnvironment: () => true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads text and binary data through the asynchronous bridge', async () => {
    call.mockImplementation(async (method, params) => {
      expect(method).toBe('filesystem_read_file_chunk')
      const content = params.path.endsWith('hello.txt') ? btoa('hello') : 'AAEC/g=='
      const bytes = params.path.endsWith('hello.txt') ? 5 : 4
      return {
        success: true,
        content,
        offset: params.offset,
        size: bytes,
        totalSize: bytes
      }
    })
    const progress = vi.fn()

    await expect(api.readFile('C:\\selected\\hello.txt', { onProgress: progress })).resolves.toBe('hello')
    await expect(api.readFileAsBinary('C:\\selected\\data.bin')).resolves.toEqual(new Uint8Array([0, 1, 2, 254]))
    expect(call).toHaveBeenNthCalledWith(1, 'filesystem_read_file_chunk', {
      path: 'C:\\selected\\hello.txt',
      offset: 0,
      length: 2 * 1024 * 1024
    })
    expect(call).toHaveBeenNthCalledWith(2, 'filesystem_read_file_chunk', {
      path: 'C:\\selected\\data.bin',
      offset: 0,
      length: 2 * 1024 * 1024
    })
    expect(progress).toHaveBeenCalledWith(5, 5)
  })

  it('assembles multiple native read chunks in order', async () => {
    const source = new TextEncoder().encode('chunked-你好-world')
    const offsets = []
    const progress = vi.fn()
    call.mockImplementation(async (method, params) => {
      expect(method).toBe('filesystem_read_file_chunk')
      offsets.push(params.offset)
      const chunk = source.subarray(
        params.offset,
        Math.min(params.offset + params.length, source.byteLength)
      )
      let binary = ''
      for (const byte of chunk) binary += String.fromCharCode(byte)
      return {
        success: true,
        content: btoa(binary),
        offset: params.offset,
        size: chunk.byteLength,
        totalSize: source.byteLength
      }
    })

    await expect(
      api.readFile('C:\\selected\\large.txt', { chunkSize: 5, onProgress: progress })
    ).resolves.toBe('chunked-你好-world')
    expect(offsets).toEqual([0, 5, 10, 15])
    expect(progress).toHaveBeenLastCalledWith(source.byteLength, source.byteLength)
  })

  it('writes text, binary and cache data without using CEF globals', async () => {
    let nextHandle = 0
    const totals = new Map()
    call.mockImplementation(async (method, params) => {
      if (method.endsWith('_start')) {
        const handle = `handle-${++nextHandle}`
        totals.set(handle, params.totalSize)
        return { success: true, handle, totalSize: params.totalSize }
      }
      if (method.endsWith('_chunk')) {
        return {
          success: true,
          written: params.offset + atob(params.content).length,
          totalSize: totals.get(params.handle)
        }
      }
      if (method.endsWith('_end')) {
        return { success: true, size: totals.get(params.handle) }
      }
      throw new Error(`unexpected method: ${method}`)
    })

    await expect(api.writeFile('C:\\selected\\text.txt', 'text')).resolves.toBe(true)
    await expect(api.writeFile('C:\\selected\\data.bin', new Uint8Array([0, 1, 2, 255]))).resolves.toBe(true)
    await expect(api.writeCache('state/data.json', '{}')).resolves.toBe(true)

    expect(call).toHaveBeenNthCalledWith(1, 'filesystem_write_file_start', {
      path: 'C:\\selected\\text.txt',
      totalSize: 4
    })
    expect(call).toHaveBeenNthCalledWith(2, 'filesystem_write_file_chunk', {
      handle: 'handle-1',
      offset: 0,
      content: 'dGV4dA=='
    })
    expect(call).toHaveBeenNthCalledWith(3, 'filesystem_write_file_end', { handle: 'handle-1' })
    expect(call).toHaveBeenNthCalledWith(4, 'filesystem_write_file_start', {
      path: 'C:\\selected\\data.bin',
      totalSize: 4
    })
    expect(call).toHaveBeenNthCalledWith(7, 'filesystem_write_cache_start', {
      relativePath: 'state/data.json',
      totalSize: 2
    })
  })

  it('writes large native payloads as bounded sequential chunks', async () => {
    const data = new Uint8Array(2 * 1024 * 1024 + 3)
    data.forEach((_, index) => {
      data[index] = index % 251
    })
    const chunks = []
    const progress = vi.fn()
    call.mockImplementation(async (method, params) => {
      if (method === 'filesystem_write_file_start') {
        return { success: true, handle: 'handle-large-0001', totalSize: params.totalSize }
      }
      if (method === 'filesystem_write_file_chunk') {
        const binary = atob(params.content)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        chunks.push({ offset: params.offset, bytes })
        return {
          success: true,
          written: params.offset + bytes.byteLength,
          totalSize: data.byteLength
        }
      }
      if (method === 'filesystem_write_file_end') {
        return { success: true, size: data.byteLength, totalSize: data.byteLength }
      }
      throw new Error(`unexpected method: ${method}`)
    })

    await expect(
      api.writeFile('C:\\selected\\large.bin', data, {
        chunkSize: 1024 * 1024,
        onProgress: progress
      })
    ).resolves.toBe(true)

    expect(chunks.map(({ offset }) => offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024])
    expect(chunks.every(({ bytes }) => bytes.byteLength <= 1024 * 1024)).toBe(true)
    const merged = new Uint8Array(data.byteLength)
    for (const chunk of chunks) merged.set(chunk.bytes, chunk.offset)
    expect(merged).toEqual(data)
    expect(progress).toHaveBeenLastCalledWith(data.byteLength, data.byteLength)
  }, 20000)

  it('cancels a native write when the service returns an invalid total size', async () => {
    call.mockImplementation(async (method) => {
      if (method === 'filesystem_write_file_start') {
        return { success: true, handle: 'handle-invalid-0001', totalSize: 99 }
      }
      if (method === 'filesystem_write_file_cancel') return { success: true }
      throw new Error(`unexpected method: ${method}`)
    })

    await expect(api.writeFile('C:\\selected\\invalid.bin', 'data')).rejects.toThrow(
      'invalid total size'
    )
    expect(call).toHaveBeenCalledWith('filesystem_write_file_cancel', {
      handle: 'handle-invalid-0001'
    })
  })

  it('reads cache by relative path and rejects malformed native responses', async () => {
    call
      .mockResolvedValueOnce({
        success: true,
        content: 'eyJvayI6dHJ1ZX0=',
        offset: 0,
        size: 11,
        totalSize: 11
      })
      .mockResolvedValueOnce({ success: true, size: 1 })

    await expect(api.readCache('state/data.json')).resolves.toBe('{"ok":true}')
    await expect(api.readFile('C:\\selected\\broken.txt')).rejects.toThrow('invalid data')
    expect(call).toHaveBeenNthCalledWith(1, 'filesystem_read_cache_chunk', {
      relativePath: 'state/data.json',
      offset: 0,
      length: 2 * 1024 * 1024
    })
  })

  it('rejects native read responses larger than the stream limit', async () => {
    call.mockResolvedValue({
      success: true,
      content: '',
      offset: 0,
      size: 0,
      totalSize: 4 * 1024 * 1024 * 1024 + 1
    })

    await expect(api.readFile('C:\\selected\\oversized.bin')).rejects.toThrow('invalid data')
  })

  it('preserves structured permission errors through compatibility wrappers', async () => {
    const denied = Object.assign(new Error('路径未授权'), { code: 'PERMISSION_DENIED' })
    call.mockRejectedValue(denied)

    await expect(api.readFile('C:\\Windows\\win.ini')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      cause: denied
    })
  })
})
