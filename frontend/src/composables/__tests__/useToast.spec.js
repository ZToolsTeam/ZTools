import { describe, it, expect, vi } from 'vitest'

// mock ant-design-vue message
const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  loading: vi.fn()
}))

vi.mock('ant-design-vue', () => ({
  message: messageMock
}))

import { CircleXIcon } from '@lucide/vue'
import { useToast } from '../useToast'

describe('useToast', () => {
  const toast = useToast()

  it('success 调用 message.success，默认 3 秒', () => {
    toast.success('操作成功')
    expect(messageMock.success).toHaveBeenCalledWith(expect.objectContaining({
      content: '操作成功',
      duration: 3
    }))
  })

  it('error 调用 message.error', () => {
    toast.error('出错了')
    expect(messageMock.error).toHaveBeenCalledWith(expect.objectContaining({
      content: '出错了',
      duration: 3
    }))
  })

  it('提示图标使用 Lucide 线性图标并带语义色', () => {
    toast.error('图标')
    const { icon } = messageMock.error.mock.calls.at(-1)[0]
    expect(icon.type).toBe(CircleXIcon)
    expect(icon.props.style).toEqual({ color: 'var(--rc-error)' })
  })

  it('info 调用 message.info', () => {
    toast.info('提示信息')
    expect(messageMock.info).toHaveBeenCalledWith(expect.objectContaining({
      content: '提示信息',
      duration: 3
    }))
  })

  it('warning 调用 message.warning', () => {
    toast.warning('警告')
    expect(messageMock.warning).toHaveBeenCalledWith(expect.objectContaining({
      content: '警告',
      duration: 3
    }))
  })

  it('自定义持续时间（毫秒转秒）', () => {
    toast.success('ok', 5000)
    expect(messageMock.success).toHaveBeenCalledWith(expect.objectContaining({
      content: 'ok',
      duration: 5
    }))
  })

  it('loading 默认不自动关闭', () => {
    toast.loading('加载中')
    expect(messageMock.loading).toHaveBeenCalledWith(expect.objectContaining({
      content: '加载中',
      duration: 0
    }))
  })

  it('loading 支持自定义时间', () => {
    toast.loading('加载中', 2000)
    expect(messageMock.loading).toHaveBeenCalledWith(expect.objectContaining({
      content: '加载中',
      duration: 2
    }))
  })

  it('toast 方法根据 type 分发', () => {
    toast.toast('success', '成功')
    expect(messageMock.success).toHaveBeenCalled()

    toast.toast('error', '失败')
    expect(messageMock.error).toHaveBeenCalled()
  })

  it('toast 未知类型回退到 info', () => {
    toast.toast('unknown', '消息')
    expect(messageMock.info).toHaveBeenCalled()
  })

  it('别名方法正确映射', () => {
    expect(toast.toastSuccess).toBe(toast.success)
    expect(toast.toastError).toBe(toast.error)
    expect(toast.toastInfo).toBe(toast.info)
    expect(toast.toastWarning).toBe(toast.warning)
  })
})
