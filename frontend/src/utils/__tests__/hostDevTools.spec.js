import { afterEach, describe, expect, it, vi } from 'vitest'
import { isHostDevBuild, toggleHostDevTools } from '../hostDevTools'

function mockHost({ isDev, toggle = vi.fn().mockResolvedValue({ success: true }) } = {}) {
  window.ztools = {
    sys: { isDev: typeof isDev === 'function' ? isDev : vi.fn().mockResolvedValue(isDev) },
    window: { toggleDevTools: toggle }
  }
  return toggle
}

describe('宿主开发者工具（仅开发版）', () => {
  afterEach(() => {
    delete window.ztools
    vi.restoreAllMocks()
  })

  it('开发版切换 Chromium 开发者工具', async () => {
    const toggle = mockHost({ isDev: true })
    await expect(toggleHostDevTools()).resolves.toBe(true)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('正式版不打开开发者工具', async () => {
    const toggle = mockHost({ isDev: false })
    await expect(toggleHostDevTools()).resolves.toBe(false)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('[破坏性] 读取开发版标记失败时按正式版处理', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const toggle = mockHost({ isDev: vi.fn().mockRejectedValue(new Error('IPC 断开')) })
    await expect(isHostDevBuild()).resolves.toBe(false)
    await expect(toggleHostDevTools()).resolves.toBe(false)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('[破坏性] 切换失败时返回 false 不抛错；宿主接口不存在时不做任何事', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockHost({ isDev: true, toggle: vi.fn().mockRejectedValue(new Error('窗口已销毁')) })
    await expect(toggleHostDevTools()).resolves.toBe(false)
    delete window.ztools
    await expect(toggleHostDevTools()).resolves.toBe(false)
  })
})
