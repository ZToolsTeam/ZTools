import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import axios from 'axios'

// mock axios.create 返回一个可控的实例
const requestInterceptors = []
const responseInterceptors = []

const mockAxiosInstance = {
  interceptors: {
    request: { use: (ok, err) => requestInterceptors.push({ ok, err }) },
    response: { use: (ok, err) => responseInterceptors.push({ ok, err }) }
  },
  get: vi.fn(),
  post: vi.fn()
}

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance)
  }
}))

describe('http 模块', () => {
  let httpModule

  beforeEach(async () => {
    requestInterceptors.length = 0
    responseInterceptors.length = 0
    // 动态导入以触发拦截器注册
    vi.resetModules()
    httpModule = await import('../http')
  })

  afterEach(() => {
    delete window.ztools
    vi.clearAllMocks()
  })

  describe('请求拦截器', () => {
    it('CEF 环境下添加 Authorization header', async () => {
      window.ztools = {
        user: { getToken: vi.fn().mockResolvedValue('test-token') }
      }
      const interceptor = requestInterceptors[0]
      const config = { headers: {} }
      const result = await interceptor.ok(config)
      expect(result.headers.Authorization).toBe('Bearer test-token')
    })

    it('无 token 时不添加 Authorization', async () => {
      window.ztools = {
        user: { getToken: vi.fn().mockResolvedValue(null) }
      }
      const interceptor = requestInterceptors[0]
      const config = { headers: {} }
      const result = await interceptor.ok(config)
      expect(result.headers.Authorization).toBeUndefined()
    })

    it('非 CEF 环境下正常通过', async () => {
      const interceptor = requestInterceptors[0]
      const config = { headers: {} }
      const result = await interceptor.ok(config)
      expect(result.headers.Authorization).toBeUndefined()
    })

    it('getToken 抛异常时静默忽略', async () => {
      window.ztools = {
        user: { getToken: vi.fn().mockRejectedValue(new Error('fail')) }
      }
      const interceptor = requestInterceptors[0]
      const config = { headers: {} }
      const result = await interceptor.ok(config)
      expect(result.headers.Authorization).toBeUndefined()
    })
  })

  describe('响应拦截器', () => {
    it('成功响应返回 response.data', () => {
      const interceptor = responseInterceptors[0]
      const result = interceptor.ok({ data: { success: true, data: 'ok' } })
      expect(result).toEqual({ success: true, data: 'ok' })
    })

    it('401 错误调用 logout', async () => {
      const logoutMock = vi.fn().mockResolvedValue(true)
      window.ztools = { user: { logout: logoutMock } }
      const interceptor = responseInterceptors[0]
      const error = {
        response: { status: 401, data: { message: 'Unauthorized' } }
      }
      await expect(interceptor.err(error)).rejects.toEqual(
        expect.objectContaining({ status: 401 })
      )
      expect(logoutMock).toHaveBeenCalled()
    })

    it('网络错误返回 status 0', async () => {
      const interceptor = responseInterceptors[0]
      const error = { request: {} }
      await expect(interceptor.err(error)).rejects.toEqual(
        expect.objectContaining({ status: 0, message: '网络错误，请检查网络连接' })
      )
    })

    it('请求配置错误返回 status -1', async () => {
      const interceptor = responseInterceptors[0]
      const error = { message: 'bad config' }
      await expect(interceptor.err(error)).rejects.toEqual(
        expect.objectContaining({ status: -1 })
      )
    })

    it.each([403, 404, 422, 429, 500])('处理 %d 状态码', async (status) => {
      const interceptor = responseInterceptors[0]
      const error = {
        response: { status, data: { message: `Error ${status}` } }
      }
      await expect(interceptor.err(error)).rejects.toEqual(
        expect.objectContaining({ status })
      )
    })
  })
})
