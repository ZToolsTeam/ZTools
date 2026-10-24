import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NativeTooltipInterceptor from '../../../public/js/cef-ipc/src/core/native-tooltip'

const flushMutations = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('NativeTooltipInterceptor', () => {
  let interceptor
  let showTooltip
  let hideTooltip

  beforeEach(() => {
    vi.useFakeTimers()
    showTooltip = vi.fn().mockResolvedValue({ success: true })
    hideTooltip = vi.fn().mockResolvedValue({ success: true })
    interceptor = new NativeTooltipInterceptor({ showTooltip, hideTooltip })
    interceptor.start()
  })

  afterEach(() => {
    interceptor.destroy()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('globally intercepts title and displays it through the native API', async () => {
    const button = document.createElement('button')
    button.title = '添加收藏'
    document.body.appendChild(button)
    await flushMutations()

    expect(button.hasAttribute('title')).toBe(false)
    expect(button.getAttribute('data-system-tooltip')).toBe('添加收藏')
    expect(button.getAttribute('aria-label')).toBe('添加收藏')

    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(500)
    expect(showTooltip).toHaveBeenCalledWith('添加收藏')

    button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    expect(hideTooltip).toHaveBeenCalledOnce()
  })

  it('intercepts dynamically added title attributes', async () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.title = '动态提示'
    await flushMutations()

    expect(button.hasAttribute('title')).toBe(false)
    expect(button.getAttribute('data-system-tooltip')).toBe('动态提示')
  })

  it('cancels a pending tooltip when the pointer leaves early', async () => {
    const button = document.createElement('button')
    button.title = '安装'
    document.body.appendChild(button)
    await flushMutations()

    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(500)

    expect(showTooltip).not.toHaveBeenCalled()
    expect(hideTooltip).not.toHaveBeenCalled()
  })
})
