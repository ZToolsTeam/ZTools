import { describe, it, expect, beforeEach, vi } from 'vitest'

const httpMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn()
}))

vi.mock('@/utils/http', () => ({ default: httpMock }))

import { getSyncData, pushSyncData } from '../sync'

describe('sync API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getSyncData', () => {
    it('成功时返回同步数据', async () => {
      const data = { favorites: ['a'], updated_at: '2026-01-01' }
      httpMock.get.mockResolvedValue({ success: true, data })
      const result = await getSyncData()
      expect(result).toEqual(data)
    })

    it('失败时抛出错误', async () => {
      httpMock.get.mockResolvedValue({ success: false, message: '未登录' })
      await expect(getSyncData()).rejects.toThrow('未登录')
    })
  })

  describe('pushSyncData', () => {
    it('成功时返回 success: true', async () => {
      httpMock.put.mockResolvedValue({ success: true, data: { updated_at: 'now' } })
      const result = await pushSyncData({ favorites: ['a'] })
      expect(result.success).toBe(true)
    })

    it('服务端返回失败时返回 success: false', async () => {
      httpMock.put.mockResolvedValue({ success: false, message: '数据无效' })
      const result = await pushSyncData({})
      expect(result.success).toBe(false)
    })

    it('409 冲突时返回 conflict: true', async () => {
      httpMock.put.mockRejectedValue({
        status: 409,
        data: { data: { favorites: ['b'] } }
      })
      const result = await pushSyncData({ favorites: ['a'] })
      expect(result.conflict).toBe(true)
      expect(result.data).toEqual({ favorites: ['b'] })
    })

    it('其他错误直接抛出', async () => {
      httpMock.put.mockRejectedValue({ status: 500, message: '服务器错误' })
      await expect(pushSyncData({})).rejects.toEqual(
        expect.objectContaining({ status: 500 })
      )
    })
  })
})
