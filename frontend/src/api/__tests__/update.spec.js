import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const httpMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn()
}))

vi.mock('@/utils/http', () => ({ default: httpMock }))

import { checkAppUpdate, checkPluginUpdate, batchCheckPlugins } from '../update'

describe('update API', () => {
  const setHostPlatform = (platform, { version, platformError } = {}) => {
    window.ztools = {
      sys: {
        getInfo: platformError
          ? vi.fn().mockRejectedValue(platformError)
          : vi.fn().mockResolvedValue({ platform }),
        getCurrentVersion: vi.fn().mockResolvedValue(
          version || { appVersion: '2.0.0', webVersion: '1.0.4' }
        )
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    delete window.ztools
  })

  afterEach(() => {
    delete window.ztools
  })

  describe('checkAppUpdate', () => {
    it.each(['windows', 'macos'])('使用宿主平台 %s', async (platform) => {
      setHostPlatform(platform)
      httpMock.get.mockResolvedValue({ success: true, data: { hasUpdate: false } })
      await checkAppUpdate()
      expect(httpMock.get).toHaveBeenCalledWith('/api/update/app', {
        params: { platform, current_version: '1.0.0' }
      })
    })

    it('传递自定义参数', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: { hasUpdate: true } })
      const result = await checkAppUpdate({ platform: 'macos', current_version: '2.0.0' })
      expect(result.hasUpdate).toBe(true)
    })

    it('宿主平台未知时拒绝请求，不回退到 Windows', async () => {
      setHostPlatform('linux')

      await expect(checkAppUpdate()).rejects.toThrow(
        '当前平台“linux”不支持更新检查（仅支持 Windows/macOS）'
      )
      expect(httpMock.get).not.toHaveBeenCalled()
    })

    it('无法读取宿主平台时拒绝请求', async () => {
      setHostPlatform(undefined, { platformError: new Error('宿主不可用') })

      await expect(checkAppUpdate()).rejects.toThrow(
        '读取宿主平台失败，已取消更新检查'
      )
      expect(httpMock.get).not.toHaveBeenCalled()
    })

    it('失败时抛出错误', async () => {
      setHostPlatform('windows')
      httpMock.get.mockResolvedValue({ success: false, message: '检查失败' })
      await expect(checkAppUpdate()).rejects.toThrow('检查失败')
    })
  })

  describe('checkPluginUpdate', () => {
    it('使用宿主平台并携带客户端版本参数', async () => {
      setHostPlatform('macos')
      httpMock.get.mockResolvedValue({ success: true, data: { hasUpdate: true } })
      await checkPluginUpdate('my-plugin', { current_version: '1.0.0' })
      expect(httpMock.get).toHaveBeenCalledWith('/api/update/plugin/my-plugin', {
        params: expect.objectContaining({
          platform: 'macos',
          app_version: '2.0.0',
          web_version: '1.0.4'
        })
      })
    })

    it('获取版本失败时静默忽略', async () => {
      setHostPlatform('windows')
      window.ztools.sys.getCurrentVersion.mockRejectedValue(new Error('fail'))
      httpMock.get.mockResolvedValue({ success: true, data: {} })
      await expect(checkPluginUpdate('test')).resolves.toBeDefined()
      expect(httpMock.get).toHaveBeenCalledWith(
        '/api/update/plugin/test',
        expect.objectContaining({
          params: expect.objectContaining({ platform: 'windows' })
        })
      )
    })

    it('宿主平台未知时拒绝请求', async () => {
      setHostPlatform('unknown')

      await expect(checkPluginUpdate('test')).rejects.toThrow(
        '当前平台“unknown”不支持更新检查（仅支持 Windows/macOS）'
      )
      expect(httpMock.get).not.toHaveBeenCalled()
    })
  })

  describe('batchCheckPlugins', () => {
    it.each(['windows', 'macos'])('使用宿主平台 %s 构建请求体', async (platform) => {
      setHostPlatform(platform)
      httpMock.post.mockResolvedValue({ success: true, data: {} })
      await batchCheckPlugins({
        plugins: [
          { id: 'a', version: '1.0.0' },
          { pluginId: 'b', version: '2.0.0' }
        ]
      })
      expect(httpMock.post).toHaveBeenCalledWith('/api/update/plugins/batch', expect.objectContaining({
        platform,
        plugins: [
          { id: 'a', version: '1.0.0' },
          { id: 'b', version: '2.0.0' }
        ]
      }))
    })

    it('宿主平台未知时拒绝请求', async () => {
      setHostPlatform('linux')

      await expect(batchCheckPlugins({ plugins: [] })).rejects.toThrow(
        '当前平台“linux”不支持更新检查（仅支持 Windows/macOS）'
      )
      expect(httpMock.post).not.toHaveBeenCalled()
    })
  })
})
