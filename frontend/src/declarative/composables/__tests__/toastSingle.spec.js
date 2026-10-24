import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { showToast, Toast } from '@ztools/declarative-ui'

vi.mock('ant-design-vue', () => ({ Modal: { confirm: vi.fn(() => ({ destroy() {} })) } }))
// useDeclarativeStack 内部使用 onUnmounted，脱离组件调用时不需要真实生命周期
vi.mock('vue', async (importOriginal) => ({ ...(await importOriginal()), onUnmounted: () => {} }))

import { useDeclarativeStack } from '../useDeclarativeStack'

describe('声明式 Toast：同一时间只显示一条', () => {
  let toasts

  beforeEach(() => {
    vi.useFakeTimers()
    ;({ toasts } = useDeclarativeStack(null))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('加载提示后再弹结果提示：加载提示被替换，不会叠在一起', async () => {
    await showToast({ style: Toast.Style.Animated, title: '正在结束 Python', message: 'PID 1' })
    expect(toasts.value.map((t) => t.title)).toEqual(['正在结束 Python'])

    await showToast({ style: Toast.Style.Success, title: '已结束占用 :8080 的进程' })
    expect(toasts.value.map((t) => t.title)).toEqual(['已结束占用 :8080 的进程'])

    vi.advanceTimersByTime(3000)
    expect(toasts.value).toEqual([])
  })

  it('连续多次结束进程：始终只有一条提示，最后全部消失', async () => {
    for (let i = 0; i < 5; i++) {
      await showToast({ style: Toast.Style.Animated, title: `正在结束 ${i}` })
      await showToast({ style: Toast.Style.Failure, title: `失败 ${i}` })
    }
    expect(toasts.value.map((t) => t.title)).toEqual(['失败 4'])
    vi.advanceTimersByTime(3000)
    expect(toasts.value).toEqual([])
  })

  it('加载提示单独存在时不会自动消失，插件 hide 后消失', async () => {
    const handle = await showToast({ style: Toast.Style.Animated, title: '正在扫描' })
    vi.advanceTimersByTime(10_000)
    expect(toasts.value).toHaveLength(1)
    await handle.hide()
    expect(toasts.value).toEqual([])
  })

  it('加载提示改成成功后 3 秒自动消失', async () => {
    const handle = await showToast({ style: Toast.Style.Animated, title: '正在扫描' })
    handle.style = Toast.Style.Success
    handle.title = '扫描完成'
    expect(toasts.value.map((t) => t.title)).toEqual(['扫描完成'])
    vi.advanceTimersByTime(3000)
    expect(toasts.value).toEqual([])
  })

  it('旧提示的倒计时不会提前关掉新提示；旧句柄 hide/update 不影响新提示', async () => {
    const old = await showToast({ style: Toast.Style.Success, title: '旧' })
    vi.advanceTimersByTime(2000)
    await showToast({ style: Toast.Style.Success, title: '新' })
    vi.advanceTimersByTime(1500)
    expect(toasts.value.map((t) => t.title)).toEqual(['新'])

    old.title = '旧-改'
    await old.hide()
    expect(toasts.value.map((t) => t.title)).toEqual(['新'])

    vi.advanceTimersByTime(1500)
    expect(toasts.value).toEqual([])
  })

  it('成功提示被加载提示替换后，旧倒计时取消，加载提示一直保留', async () => {
    await showToast({ style: Toast.Style.Success, title: '已复制' })
    await showToast({ style: Toast.Style.Animated, title: '正在结束' })
    vi.advanceTimersByTime(5000)
    expect(toasts.value.map((t) => t.title)).toEqual(['正在结束'])
  })
})
