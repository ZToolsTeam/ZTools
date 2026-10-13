import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const httpMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn()
}))

vi.mock('@/utils/http', () => ({ default: httpMock }))

import {
  wechatLogin,
  wechatAppLogin,
  deviceLogin,
  refreshToken,
  logout,
  getCurrentUser,
  updateUser,
  uploadAvatar,
  isAuthenticated,
  getToken,
  generateQrcode,
  checkQrcodeStatus
} from '../auth'

describe('auth API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete window.ztools
  })

  afterEach(() => {
    delete window.ztools
  })

  describe('wechatLogin', () => {
    it('成功时保存 token 到 ztools', async () => {
      const setTokenMock = vi.fn().mockResolvedValue(true)
      window.ztools = { user: { setToken: setTokenMock } }
      httpMock.post.mockResolvedValue({
        success: true,
        data: { token: 'tk', user: { id: 1, nickname: '用户' } }
      })
      const result = await wechatLogin('code123')
      expect(result.token).toBe('tk')
      expect(setTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'tk', userId: '1' })
      )
    })

    it('失败时抛出错误', async () => {
      httpMock.post.mockResolvedValue({ success: false, message: '授权失败' })
      await expect(wechatLogin('bad')).rejects.toThrow('授权失败')
    })
  })

  describe('wechatAppLogin', () => {
    it('成功时保存 token', async () => {
      window.ztools = { user: { setToken: vi.fn().mockResolvedValue(true) } }
      httpMock.post.mockResolvedValue({
        success: true,
        data: { token: 'tk2', user: { id: 2, username: 'u2' } }
      })
      const result = await wechatAppLogin('jscode')
      expect(result.token).toBe('tk2')
    })
  })

  describe('deviceLogin', () => {
    it('默认参数成功登录并持久化到客户端', async () => {
      const setTokenMock = vi.fn().mockResolvedValue(true)
      window.ztools = { user: { setToken: setTokenMock } }
      httpMock.post.mockResolvedValue({
        success: true,
        data: {
          token: 'device-token-123',
          user: { id: 888, nickname: 'AI测试专用设备号', openid: 'device:ZTOOLS-TEST-DEVICE-0001' }
        }
      })

      const result = await deviceLogin()
      expect(result.token).toBe('device-token-123')
      expect(result.user.id).toBe(888)
      expect(httpMock.post).toHaveBeenCalledWith('/api/auth/device-login', {
        device_code: 'ZTOOLS-TEST-DEVICE-0001',
        nickname: 'AI测试专用设备号'
      })
      expect(setTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'device-token-123',
          userId: '888',
          username: 'AI测试专用设备号'
        })
      )
    })

    it('使用自定义设备号与昵称登录', async () => {
      httpMock.post.mockResolvedValue({
        success: true,
        data: {
          token: 'custom-tk',
          user: { id: 999, nickname: '自定义机器' }
        }
      })

      const result = await deviceLogin('MY-CUSTOM-DEV-99', '自定义机器')
      expect(result.token).toBe('custom-tk')
      expect(httpMock.post).toHaveBeenCalledWith('/api/auth/device-login', {
        device_code: 'MY-CUSTOM-DEV-99',
        nickname: '自定义机器'
      })
    })

    it('设备号为空时拒绝请求并抛错', async () => {
      await expect(deviceLogin('')).rejects.toThrow('设备号不能为空')
      await expect(deviceLogin('   ')).rejects.toThrow('设备号不能为空')
    })

    it('服务端返回失败时抛出错误', async () => {
      httpMock.post.mockResolvedValue({
        success: false,
        message: '用户已被禁用'
      })

      await expect(deviceLogin('BANNED-DEVICE')).rejects.toThrow('用户已被禁用')
    })
  })

  describe('refreshToken', () => {
    it('成功时更新 token', async () => {
      const setTokenMock = vi.fn().mockResolvedValue(true)
      window.ztools = {
        user: {
          setToken: setTokenMock,
          getInfo: vi.fn().mockResolvedValue({
            refreshToken: 'refresh-tk',
            user: { user_id: '1', username: 'test', email: 'test@test.com' }
          })
        }
      }
      httpMock.post.mockResolvedValue({ success: true, data: { token: 'new-tk' } })
      const result = await refreshToken()
      expect(result).toBe('new-tk')
      expect(httpMock.post).toHaveBeenCalledWith('/api/auth/refresh', {
        refresh_token: 'refresh-tk'
      })
      expect(setTokenMock).toHaveBeenCalled()
    })
  })

  describe('logout', () => {
    it('成功时清除 token', async () => {
      const logoutMock = vi.fn().mockResolvedValue(true)
      window.ztools = { user: { logout: logoutMock } }
      httpMock.post.mockResolvedValue({ success: true })
      await logout()
      expect(logoutMock).toHaveBeenCalled()
    })

    it('请求失败时仍清除 token', async () => {
      const logoutMock = vi.fn().mockResolvedValue(true)
      window.ztools = { user: { logout: logoutMock } }
      httpMock.post.mockRejectedValue(new Error('网络错误'))
      await expect(logout()).rejects.toThrow()
      expect(logoutMock).toHaveBeenCalled()
    })
  })

  describe('getCurrentUser / updateUser', () => {
    it('getCurrentUser 返回用户信息', async () => {
      httpMock.get.mockResolvedValue({ success: true, data: { id: 1, name: 'test' } })
      const user = await getCurrentUser()
      expect(user).toEqual({ id: 1, name: 'test' })
    })

    it('updateUser 发送 PUT 请求', async () => {
      httpMock.put.mockResolvedValue({ success: true, data: { id: 1, nickname: '新名' } })
      const result = await updateUser({ nickname: '新名' })
      expect(result.nickname).toBe('新名')
    })
  })

  describe('uploadAvatar', () => {
    it('使用 multipart/form-data 上传', async () => {
      httpMock.post.mockResolvedValue({
        success: true,
        data: { url: 'https://example.com/avatar.jpg' }
      })
      const file = new File([''], 'avatar.jpg')
      const result = await uploadAvatar(file)
      expect(result.url).toBe('https://example.com/avatar.jpg')
      expect(httpMock.post).toHaveBeenCalledWith(
        '/api/auth/user/avatar',
        expect.any(FormData),
        expect.objectContaining({ headers: { 'Content-Type': 'multipart/form-data' } })
      )
    })
  })

  describe('isAuthenticated', () => {
    it('CEF 环境下调用 ztools.user.isLoggedIn', async () => {
      window.ztools = { user: { isLoggedIn: vi.fn().mockResolvedValue(true) } }
      expect(await isAuthenticated()).toBe(true)
    })

    it('非 CEF 环境返回 false', async () => {
      expect(await isAuthenticated()).toBe(false)
    })

    it('isLoggedIn 异常时返回 false', async () => {
      window.ztools = { user: { isLoggedIn: vi.fn().mockRejectedValue(new Error('fail')) } }
      expect(await isAuthenticated()).toBe(false)
    })
  })

  describe('getToken', () => {
    it('CEF 环境下返回 token', async () => {
      window.ztools = { user: { getToken: vi.fn().mockResolvedValue('my-token') } }
      expect(await getToken()).toBe('my-token')
    })

    it('非 CEF 环境返回 null', async () => {
      expect(await getToken()).toBeNull()
    })
  })

  describe('generateQrcode', () => {
    it('返回二维码数据', async () => {
      httpMock.post.mockResolvedValue({
        success: true,
        data: { scene_id: 's1', qrcode_url: 'https://qr.example.com' }
      })
      const result = await generateQrcode()
      expect(result.scene_id).toBe('s1')
    })
  })

  describe('checkQrcodeStatus', () => {
    it('扫码确认后保存 token', async () => {
      const setTokenMock = vi.fn().mockResolvedValue(true)
      window.ztools = { user: { setToken: setTokenMock } }
      httpMock.post.mockResolvedValue({
        success: true,
        data: { status: 'confirmed', token: 'qr-tk', user: { id: 3, nickname: 'qr-user' } }
      })
      const result = await checkQrcodeStatus('scene1')
      expect(result.status).toBe('confirmed')
      expect(setTokenMock).toHaveBeenCalled()
    })

    it('未确认时不保存 token', async () => {
      window.ztools = { user: { setToken: vi.fn() } }
      httpMock.post.mockResolvedValue({
        success: true,
        data: { status: 'pending' }
      })
      const result = await checkQrcodeStatus('scene1')
      expect(result.status).toBe('pending')
      expect(window.ztools.user.setToken).not.toHaveBeenCalled()
    })
  })
})
