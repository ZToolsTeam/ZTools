import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'public/js/cef-ipc/src/api/fs.js'), 'utf8')
const FileSystemAPI = new Function(source.replace(/export default FileSystemAPI\s*$/, 'return FileSystemAPI'))()

afterEach(() => { delete window.__ztoolsElectron })

describe('exclusive output SDK contract', () => {
  it('uses atomic exclusive writes while default writes use the streaming API', async () => {
    window.__ztoolsElectron = { transport: {} }
    const call = vi.fn(async (method, params) => {
      if (method === 'filesystem_write_file') return { success: true, size: 5 }
      if (method === 'filesystem_write_file_start') {
        return { success: true, handle: 'write-handle-1', totalSize: params.totalSize }
      }
      if (method === 'filesystem_write_file_chunk') {
        return { success: true, written: params.offset + 5, totalSize: 5 }
      }
      if (method === 'filesystem_write_file_end') return { success: true, size: 5 }
      throw new Error(`unexpected method: ${method}`)
    })
    const api = new FileSystemAPI({ call, isElectronEnvironment: () => true })
    await expect(api.writeFile('selected/output.txt', 'hello', { overwrite: false })).resolves.toBe(true)
    expect(call).toHaveBeenNthCalledWith(1, 'filesystem_write_file', {
      path: 'selected/output.txt', encoding: 'utf8', content: 'hello', overwrite: false
    })
    await api.writeFile('selected/output.txt', 'hello')
    expect(call).toHaveBeenNthCalledWith(2, 'filesystem_write_file_start', {
      path: 'selected/output.txt', totalSize: 5
    })
    expect(call).toHaveBeenNthCalledWith(3, 'filesystem_write_file_chunk', {
      handle: 'write-handle-1', offset: 0, content: 'aGVsbG8='
    })
    expect(call).toHaveBeenNthCalledWith(4, 'filesystem_write_file_end', { handle: 'write-handle-1' })
  })

  it('keeps the main conflict code for actionable per-item failures', async () => {
    window.__ztoolsElectron = { transport: {} }
    const api = new FileSystemAPI({
      call: vi.fn().mockRejectedValue(Object.assign(new Error('Output exists'), { code: 'FILE_ALREADY_EXISTS' })),
      isElectronEnvironment: () => true
    })
    await expect(api.writeFile('selected/output.txt', 'hello', { overwrite: false })).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })
  })

  it('refuses an unsupported host instead of silently overwriting', async () => {
    const call = vi.fn()
    const api = new FileSystemAPI({ call, isElectronEnvironment: () => false })
    await expect(api.writeFile('selected/output.txt', 'hello', { overwrite: false })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(call).not.toHaveBeenCalled()
  })

  it('does not ignore no-overwrite on the cache streaming API', async () => {
    window.__ztoolsElectron = { transport: {} }
    const call = vi.fn()
    const api = new FileSystemAPI({ call, isElectronEnvironment: () => true })

    await expect(api.writeCache('state/output.txt', 'hello', { overwrite: false }))
      .rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(call).not.toHaveBeenCalled()
  })
})
