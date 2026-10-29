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

  describe('macOS：登录项走配置 system.autostart，不调用只支持 Windows 的 sys 接口', () => {
    beforeEach(() => { globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin' })
    afterEach(() => { delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ })

    it('读取登录项状态', async () => {
      const getAutostart = vi.fn()
      const get = vi.fn().mockResolvedValue('true')
      window.ztools = { isElectron: () => true, sys: { getAutostart }, config: { get } }
      await expect(native.getAutostart()).resolves.toBe(true)
      expect(get).toHaveBeenCalledWith('system.autostart', 'false')
      expect(getAutostart).not.toHaveBeenCalled()
    })

    it('设置后按系统实际状态回读确认', async () => {
      const setAutostart = vi.fn()
      const set = vi.fn().mockResolvedValue(true)
      const get = vi.fn().mockResolvedValue('true')
      window.ztools = { isElectron: () => true, sys: { setAutostart }, config: { get, set } }
      await expect(native.setAutostart(true)).resolves.toBe(true)
      expect(set).toHaveBeenCalledWith('system.autostart', 'true', true)
      expect(setAutostart).not.toHaveBeenCalled()
    })

    it('[破坏性] 写入失败、被拒绝或系统未生效时都返回 false', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const get = vi.fn().mockResolvedValue('false')
      window.ztools = { isElectron: () => true, config: { get, set: vi.fn().mockResolvedValue(true) } }
      await expect(native.setAutostart(true)).resolves.toBe(false)
      window.ztools.config.set = vi.fn().mockResolvedValue(false)
      await expect(native.setAutostart(true)).resolves.toBe(false)
      window.ztools.config.set = vi.fn().mockRejectedValue(new Error('开发态不修改 macOS 登录启动设置'))
      await expect(native.setAutostart(true)).resolves.toBe(false)
    })

    it('[破坏性] 读取失败时抛错，不把失败当成未开启', async () => {
      window.ztools = { isElectron: () => true, config: { get: vi.fn().mockRejectedValue(new Error('读取 macOS 登录启动设置失败')) } }
      await expect(native.getAutostart()).rejects.toThrow('读取 macOS 登录启动设置失败')
    })
  })
})
