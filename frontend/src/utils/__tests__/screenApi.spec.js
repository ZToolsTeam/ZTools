import { afterEach, describe, expect, it, vi } from 'vitest'
import ScreenAPI from '../../../public/js/cef-ipc/src/api/screen.js'

describe('ScreenAPI', () => {
  afterEach(() => {
    delete window.ztools
  })

  it('reads generated screenshots in chunks and deletes the private cache file', async () => {
    const bytes = new Uint8Array(100_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    const readFileAsBinary = vi.fn().mockResolvedValue(bytes)
    const deleteFile = vi.fn().mockResolvedValue(true)
    window.ztools = { fs: { readFileAsBinary, deleteFile } }
    const transport = {
      call: vi.fn().mockResolvedValue({
        success: true,
        tempFile: 'C:\\cache\\screen.png',
        width: 500,
        height: 200
      })
    }
    const callback = vi.fn()

    const result = await new ScreenAPI(transport).capture(
      { x: -100, y: 0, width: 500, height: 200 },
      callback
    )

    expect(result).toMatch(/^data:image\/png;base64,/)
    expect(atob(result.slice('data:image/png;base64,'.length))).toHaveLength(bytes.length)
    expect(transport.call).toHaveBeenCalledWith('screen_capture', {
      rect: { x: -100, y: 0, width: 500, height: 200 }
    })
    expect(readFileAsBinary).toHaveBeenCalledWith('C:\\cache\\screen.png')
    expect(deleteFile).toHaveBeenCalledWith('C:\\cache\\screen.png')
    expect(callback).toHaveBeenCalledWith(result)
  })

  it('preserves display and cursor response shapes', async () => {
    const transport = {
      call: vi.fn(async (method) => {
        if (method === 'screen_get_cursor_pos') return { success: true, x: -5, y: 10 }
        if (method === 'screen_get_all_displays') return { success: true, displays: [{ id: 1 }] }
        return { success: false, error: 'unexpected' }
      })
    }
    const screen = new ScreenAPI(transport)
    await expect(screen.getCursorScreenPoint()).resolves.toEqual({ x: -5, y: 10 })
    await expect(screen.getAllDisplays()).resolves.toEqual([{ id: 1 }])
  })
})
