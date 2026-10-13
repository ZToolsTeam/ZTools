import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// mock update store
const storeMock = vi.hoisted(() => ({
  setError: vi.fn(),
  reset: vi.fn(),
  versionInfo: {
    version: '2.0.0',
    downloadUrl: 'https://example.com/update.zip',
    checksum: 'abc123',
    fileSize: 1024
  }
}))

vi.mock('@/stores/update', () => ({
  useUpdateStore: () => storeMock
}))

import { useAppUpdate } from '../useAppUpdate'

describe('useAppUpdate', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.ztools = {
      update: {
        check: vi.fn().mockResolvedValue({ hasUpdate: true }),
        downloadAndInstall: vi.fn().mockResolvedValue({ success: true })
      },
      sys: {
        getAppVersion: vi.fn().mockResolvedValue('2.0.0'),
        performUpdate: vi.fn().mockResolvedValue({ success: true })
      }
    }
  })

  afterEach(() => {
    delete window.ztools
  })

  describe('checkVersion', () => {
    it('调用 ztools.update.check 并返回结果', async () => {
      const { checkVersion } = useAppUpdate()
      const result = await checkVersion()
      expect(window.ztools.update.check).toHaveBeenCalledWith('manual')
      expect(result).toEqual({ hasUpdate: true })
    })

    it('透传启动自动检查来源', async () => {
      const { checkVersion } = useAppUpdate()
      await checkVersion('startup')
      expect(window.ztools.update.check).toHaveBeenCalledWith('startup')
    })

    it('失败时设置 store error 并抛出', async () => {
      window.ztools.update.check.mockRejectedValue(new Error('网络错误'))
      const { checkVersion } = useAppUpdate()
      await expect(checkVersion()).rejects.toThrow('网络错误')
      expect(storeMock.setError).toHaveBeenCalledWith('网络错误')
    })
  })

  describe('silentWebUpdate', () => {
    it('exe 版本满足要求时调用 Web 更新入口', async () => {
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0.0',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        fileSize: 1024,
        minAppVersion: '1.0.0.0'
      })
      expect(result).toBe(true)
      expect(window.ztools.sys.performUpdate).toHaveBeenCalledWith('web', {
        version: '1.1.0.0',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        fileSize: 1024,
        minAppVersion: '1.0.0.0'
      })
    })

    it('三位和四位 exe 版本按缺省 0 兼容比较', async () => {
      window.ztools.sys.getAppVersion.mockResolvedValue('1.0.8')
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        minAppVersion: '1.0.8.0'
      })
      expect(result).toBe(true)
      expect(window.ztools.sys.performUpdate).toHaveBeenCalled()
    })

    it('四位版本第四段更低时跳过', async () => {
      window.ztools.sys.getAppVersion.mockResolvedValue('1.0.8.0')
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0',
        minAppVersion: '1.0.8.1'
      })
      expect(result).toBe(false)
      expect(window.ztools.sys.performUpdate).not.toHaveBeenCalled()
    })

    it('exe 版本低于要求时跳过', async () => {
      window.ztools.sys.getAppVersion.mockResolvedValue('1.0.0')
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0',
        minAppVersion: '2.0.0'
      })
      expect(result).toBe(false)
      expect(window.ztools.sys.performUpdate).not.toHaveBeenCalled()
    })

    it('App 版本不符合严格数字契约时失败关闭', async () => {
      window.ztools.sys.getAppVersion.mockResolvedValue('1.0.8-beta')
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0',
        minAppVersion: '1.0.0'
      })
      expect(result).toBe(false)
      expect(window.ztools.sys.performUpdate).not.toHaveBeenCalled()
    })

    it('Web 更新版本标签不参与 App 最低版本比较', async () => {
      window.ztools.sys.getAppVersion.mockResolvedValue('1.0.8')
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0-beta.1',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        minAppVersion: '1.0.8.0'
      })
      expect(result).toBe(true)
      expect(window.ztools.sys.performUpdate).toHaveBeenCalledWith(
        'web',
        expect.objectContaining({ version: '1.1.0-beta.1' })
      )
    })

    it.each([0, false])('无效的非字符串最低 App 版本 %j 失败关闭', async (minAppVersion) => {
      window.ztools.sys.getAppVersion.mockResolvedValue('2.0.0')
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({ version: '1.1.0', minAppVersion })
      expect(result).toBe(false)
      expect(window.ztools.sys.performUpdate).not.toHaveBeenCalled()
    })

    it('获取 exe 版本失败时向调用方报告失败', async () => {
      window.ztools.sys.getAppVersion.mockRejectedValue(new Error('fail'))
      const { silentWebUpdate } = useAppUpdate()
      await expect(silentWebUpdate({ version: '1.1.0' })).rejects.toThrow('fail')
    })

    it('Web 更新入口失败时向调用方报告失败', async () => {
      window.ztools.sys.performUpdate.mockRejectedValue(new Error('Web 更新失败'))
      const { silentWebUpdate } = useAppUpdate()
      await expect(silentWebUpdate({
        version: '1.1.0',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        minAppVersion: '1.0.0'
      })).rejects.toThrow('Web 更新失败')
    })

    it('Web 更新成功后返回 true', async () => {
      const { silentWebUpdate } = useAppUpdate()
      const result = await silentWebUpdate({
        version: '1.1.0',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        minAppVersion: '1.0.0'
      })
      expect(result).toBe(true)
      expect(window.ztools.sys.performUpdate).toHaveBeenCalledWith('web', expect.objectContaining({
        version: '1.1.0',
        checksum: 'a'.repeat(64)
      }))
    })

    it('防止重复触发', async () => {
      const { silentWebUpdate } = useAppUpdate()
      const update = {
        version: '1.1.0',
        downloadUrl: 'https://example.com/web.zip',
        checksum: 'a'.repeat(64),
        minAppVersion: '1.0.0'
      }
      const p1 = silentWebUpdate(update)
      const p2 = silentWebUpdate(update)
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBe(true)
      expect(r2).toBe(false) // 第二次被跳过
      expect(window.ztools.sys.performUpdate).toHaveBeenCalledTimes(1)
    })
  })

  describe('downloadAndInstall', () => {
    it('使用 store 中的版本信息发起下载', async () => {
      const { downloadAndInstall } = useAppUpdate()
      await downloadAndInstall()
      expect(window.ztools.update.downloadAndInstall).toHaveBeenCalledWith({
        version: '2.0.0',
        downloadUrl: 'https://example.com/update.zip',
        checksum: 'abc123',
        fileSize: 1024
      })
    })

    it('失败时设置 store error', async () => {
      window.ztools.update.downloadAndInstall.mockRejectedValue(new Error('下载失败'))
      const { downloadAndInstall } = useAppUpdate()
      await expect(downloadAndInstall()).rejects.toThrow('下载失败')
      expect(storeMock.setError).toHaveBeenCalledWith('下载失败')
    })
  })

  describe('cancelUpdate', () => {
    it('调用 store.reset', () => {
      const { cancelUpdate } = useAppUpdate()
      cancelUpdate()
      expect(storeMock.reset).toHaveBeenCalled()
    })
  })
})
