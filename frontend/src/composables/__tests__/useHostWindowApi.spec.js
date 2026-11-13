/**
 * 宿主窗口控制：优先走 preload 注入的 window.ztools.window / win，未注入时懒加载 api 层兜底；
 * 底层失败时原样抛出，不吞错、不伪造成功。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const apiWin = vi.hoisted(() => ({
  setSize: vi.fn(),
  setAlwaysOnTop: vi.fn()
}))

vi.mock('@/api/apiserver', () => ({ win: apiWin }))

import { useHostWindowApi } from '../useHostWindowApi'

describe('useHostWindowApi', () => {
  let originalZtools

  beforeEach(() => {
    originalZtools = window.ztools
    apiWin.setSize.mockReset().mockResolvedValue({ ok: true, via: 'api' })
    apiWin.setAlwaysOnTop.mockReset().mockResolvedValue({ ok: true, via: 'api' })
  })

  afterEach(() => {
    window.ztools = originalZtools
  })

  it('preload 注入了 window.ztools.window 时直接调用，不加载 api 层', async () => {
    const setSize = vi.fn().mockResolvedValue({ ok: true, via: 'preload' })
    const setAlwaysOnTop = vi.fn().mockResolvedValue({ ok: true, via: 'preload' })
    window.ztools = { window: { setSize, setAlwaysOnTop } }

    const hostWindow = useHostWindowApi()
    await expect(hostWindow.setSize(1140, 760, true)).resolves.toEqual({ ok: true, via: 'preload' })
    await expect(hostWindow.setAlwaysOnTop(true)).resolves.toEqual({ ok: true, via: 'preload' })
    expect(setSize).toHaveBeenCalledWith(1140, 760, true)
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(apiWin.setSize).not.toHaveBeenCalled()
    expect(apiWin.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('兼容旧名 window.ztools.win', async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue({ ok: true })
    window.ztools = { win: { setAlwaysOnTop } }

    await useHostWindowApi().setAlwaysOnTop(false)
    expect(setAlwaysOnTop).toHaveBeenCalledWith(false)
    expect(apiWin.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('未注入或注入的对象缺少对应方法时，懒加载 api 层兜底', async () => {
    window.ztools = undefined
    await expect(useHostWindowApi().setSize(800, 600, false)).resolves.toEqual({ ok: true, via: 'api' })
    expect(apiWin.setSize).toHaveBeenCalledWith(800, 600, false)

    // 注入了 window 对象但没有 setAlwaysOnTop：同样兜底
    window.ztools = { window: { setSize: vi.fn() } }
    await useHostWindowApi().setAlwaysOnTop(true)
    expect(apiWin.setAlwaysOnTop).toHaveBeenCalledWith(true)
  })

  it('[故障] 底层调用失败时原样抛出，不伪造成功', async () => {
    window.ztools = { window: { setSize: vi.fn().mockRejectedValue(new Error('IPC 断开')) } }
    await expect(useHostWindowApi().setSize(1140, 760, true)).rejects.toThrow('IPC 断开')

    window.ztools = undefined
    apiWin.setAlwaysOnTop.mockRejectedValueOnce(new Error('窗口已销毁'))
    await expect(useHostWindowApi().setAlwaysOnTop(true)).rejects.toThrow('窗口已销毁')
  })
})
