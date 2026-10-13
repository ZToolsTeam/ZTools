import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import native from '../native.js'

describe('native autostart state', () => {
  beforeEach(() => {
    delete window.__ztoolsElectron
  })

  afterEach(() => {
    delete window.ztools
    delete window.__ztoolsElectron
  })

  it('reads the Electron host setting', async () => {
    const getAutostart = vi.fn().mockResolvedValue({ success: true, enabled: true })
    window.ztools = {
      isElectron: () => true,
      sys: { getAutostart },
      config: { get: vi.fn() }
    }

    await expect(native.getAutostart()).resolves.toBe(true)
    expect(getAutostart).toHaveBeenCalledOnce()
    expect(window.ztools.config.get).not.toHaveBeenCalled()
  })

  it('propagates an unsuccessful host response instead of reporting disabled', async () => {
    window.ztools = {
      isElectron: () => true,
      sys: { getAutostart: vi.fn().mockResolvedValue({ success: false, enabled: false }) }
    }

    await expect(native.getAutostart()).rejects.toThrow('获取开机启动状态失败')
  })

  it('retains the legacy configuration path outside Electron', async () => {
    const get = vi.fn().mockResolvedValue('1')
    window.ztools = { config: { get } }

    await expect(native.getAutostart()).resolves.toBe(true)
    expect(get).toHaveBeenCalledWith('system.autostart', 'false')
  })
})
