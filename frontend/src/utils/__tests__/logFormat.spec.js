import { describe, expect, it } from 'vitest'

import { formatLogArg } from '../logFormat'

describe('formatLogArg', () => {
  it('序列化普通对象', () => {
    expect(formatLogArg({ status: 0, message: '网络错误' })).toBe(
      '{"status":0,"message":"网络错误"}'
    )
  })

  it('序列化 Error 的关键字段', () => {
    const error = new Error('boom')
    error.status = 500

    const parsed = JSON.parse(formatLogArg(error))

    expect(parsed.name).toBe('Error')
    expect(parsed.message).toBe('boom')
    expect(parsed.status).toBe(500)
    expect(parsed.stack).toContain('boom')
  })

  it('处理循环引用', () => {
    const value = { name: 'root' }
    value.self = value

    expect(formatLogArg(value)).toBe('{"name":"root","self":"[Circular]"}')
  })
})
