import { describe, it, expect, beforeEach, vi } from 'vitest'

// mock http
const httpMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn()
}))

vi.mock('@/utils/http', () => ({ default: httpMock }))

import {
  getCategories,
  getMarketPlugins,
  getPluginDetails,
  getPluginDownloadUrl,
  getDownloadSign,
  PLUGIN_VERSION_INCOMPATIBLE,
  getPluginVersionIncompatibleMessage,
  getPluginComments,
  postPluginComment
} from '../plugins'

describe('plugins API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete window.ztools
  })

  describe('getCategories', () => {
    it('成功时返回分类数据', async () => {
      const data = [{ id: 1, name: '工具' }]
      httpMock.get.mockResolvedValue({ success: true, data })
      const result = await getCategories()
      expect(result).toEqual(data)
      expect(httpMock.get).toHaveBeenCalledWith('/api/plugins/categories')
    })

    it('失败时抛出错误', async () => {
      httpMock.get.mockResolvedValue({ success: false, message: '服务器错误' })
      await expect(getCategories()).rejects.toThrow('服务器错误')
    })
  })

  describe('getMarketPlugins', () => {
    it('正确传递查询参数', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: { list: [], total: 0 } })
      await getMarketPlugins({ search: 'test', category: 'tools', page: 2, per_page: 10 })
      expect(httpMock.get).toHaveBeenCalledWith('/api/plugins', {
        params: expect.objectContaining({
          search: 'test',
          category: 'tools',
          page: 2,
          per_page: 10
        })
      })
    })

    it('keyword 映射为 search', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: { list: [] } })
      await getMarketPlugins({ keyword: 'hello' })
      expect(httpMock.get).toHaveBeenCalledWith('/api/plugins', {
        params: expect.objectContaining({ search: 'hello' })
      })
    })

    it('ids 数组转为逗号分隔字符串', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: { list: [] } })
      await getMarketPlugins({ ids: ['a', 'b', 'c'] })
      expect(httpMock.get).toHaveBeenCalledWith('/api/plugins', {
        params: expect.objectContaining({ ids: 'a,b,c' })
      })
    })

    it('默认分页参数', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: { list: [] } })
      await getMarketPlugins()
      expect(httpMock.get).toHaveBeenCalledWith('/api/plugins', {
        params: expect.objectContaining({ per_page: 15, page: 1 })
      })
    })
  })

  describe('getPluginDetails', () => {
    it('成功时返回插件详情', async () => {
      const data = { pluginId: 'test', name: 'Test' }
      httpMock.get.mockResolvedValue({ success: true, data })
      const result = await getPluginDetails('test')
      expect(result).toEqual(data)
    })

    it('携带客户端版本参数', async () => {
      window.ztools = {
        sys: {
          getCurrentVersion: vi.fn().mockResolvedValue({
            appVersion: '2.0.0',
            webVersion: '1.0.4'
          })
        }
      }
      httpMock.get.mockResolvedValue({ success: true, data: {} })
      await getPluginDetails('test')
      expect(httpMock.get).toHaveBeenCalledWith('/api/plugins/test', {
        params: expect.objectContaining({
          app_version: '2.0.0',
          web_version: '1.0.4'
        })
      })
    })

    it('获取版本失败时静默忽略', async () => {
      window.ztools = {
        sys: { getCurrentVersion: vi.fn().mockRejectedValue(new Error('fail')) }
      }
      httpMock.get.mockResolvedValue({ success: true, data: {} })
      await expect(getPluginDetails('test')).resolves.toBeDefined()
    })
  })

  describe('getPluginDownloadUrl', () => {
    it('返回下载地址', async () => {
      httpMock.get.mockResolvedValue({
        success: true,
        data: { downloadUrl: 'https://example.com/dl.zip' }
      })
      const url = await getPluginDownloadUrl('test')
      expect(url).toBe('https://example.com/dl.zip')
    })
  })

  describe('getDownloadSign', () => {
    it('返回签名数据', async () => {
      httpMock.get.mockResolvedValue({
        success: true,
        data: { downloadUrl: 'https://cdn.example.com/signed', pluginId: 'test' }
      })
      const result = await getDownloadSign('test')
      expect(result.downloadUrl).toBe('https://cdn.example.com/signed')
    })

    it('携带客户端版本参数', async () => {
      window.ztools = {
        sys: {
          getCurrentVersion: vi.fn().mockResolvedValue({
            appVersion: '1.0.3',
            webVersion: '1.0.4'
          })
        }
      }
      httpMock.get.mockResolvedValue({
        success: true,
        data: { downloadUrl: 'https://cdn.example.com/signed', pluginId: 'test' }
      })

      await getDownloadSign('test')

      expect(httpMock.get).toHaveBeenCalledWith('/api/download/sign/test', {
        params: {
          app_version: '1.0.3',
          web_version: '1.0.4'
        }
      })
    })

    it('后端返回不兼容时抛出可识别升级错误', async () => {
      httpMock.get.mockRejectedValue({
        status: 426,
        message: '当前客户端版本不满足此插件要求，请先升级客户端',
        data: {
          code: PLUGIN_VERSION_INCOMPATIBLE,
          errors: {
            currentAppVersion: '1.0.3',
            minAppVersion: '1.0.4'
          }
        }
      })

      await expect(getDownloadSign('screenshot')).rejects.toMatchObject({
        code: PLUGIN_VERSION_INCOMPATIBLE,
        status: 426,
        minAppVersion: '1.0.4'
      })
    })

    it('兼容旧后端 data 为 null 的情况', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: null })

      await expect(getDownloadSign('screenshot')).rejects.toMatchObject({
        code: PLUGIN_VERSION_INCOMPATIBLE
      })
    })

    it('生成升级提示文案', () => {
      const message = getPluginVersionIncompatibleMessage({
        currentAppVersion: '1.0.3',
        minAppVersion: '1.0.4'
      })

      expect(message).toBe('当前 App 版本 1.0.3 低于插件要求 1.0.4，请先升级客户端')
    })
  })

  describe('getPluginComments / postPluginComment', () => {
    it('获取留言列表', async () => {
      const data = { data: [], total: 0 }
      httpMock.get.mockResolvedValue({ success: true, data })
      const result = await getPluginComments('test', { page: 1 })
      expect(result).toEqual(data)
    })

    it('提交留言', async () => {
      const comment = { id: 1, content: '好用' }
      httpMock.post.mockResolvedValue({ success: true, data: comment })
      const result = await postPluginComment('test', { content: '好用' })
      expect(result).toEqual(comment)
    })
  })
})
