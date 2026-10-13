import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import HeaderGeekModeTrigger from '../HeaderGeekModeTrigger.vue'
import * as windowMode from '@/utils/windowMode'

describe('HeaderGeekModeTrigger 交互与全异常覆盖测试套件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('1. [集成链路] 鼠标悬停 150ms 成功展现引导浮层，点击立即试用触发极客模式切换', async () => {
    const switchSpy = vi.spyOn(windowMode, 'switchWindowMode').mockImplementation(() => {})

    const wrapper = mount(HeaderGeekModeTrigger)

    // 初始状态下不展示浮层
    expect(wrapper.find('.rounded-xl').exists()).toBe(false)

    // 鼠标移入外层容器
    await wrapper.trigger('mouseenter')

    // 未满 150ms 前不提前展示（防止快速划过误触发）
    vi.advanceTimersByTime(100)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(false)

    // 满 150ms 触发展示
    vi.advanceTimersByTime(50)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(true)

    // 验证包含立即试用按钮
    const tryBtn = wrapper.findAll('button').find(b => b.text().includes('立即试用'))
    expect(tryBtn).toBeDefined()

    // 点击立即试用
    await tryBtn.trigger('click')

    // 验证关闭浮层并调用 switchWindowMode(WINDOW_MODES.LAUNCHER)
    expect(wrapper.find('.rounded-xl').exists()).toBe(false)
    expect(switchSpy).toHaveBeenCalledWith(windowMode.WINDOW_MODES.LAUNCHER)

    switchSpy.mockRestore()
  })

  it('2. [破坏性测试: 穿过缝隙与离开缓冲] 鼠标向试用按钮移动过程中短暂离开，250ms 内移回保持显示不中断', async () => {
    const wrapper = mount(HeaderGeekModeTrigger)

    // 悬停打开浮层
    await wrapper.trigger('mouseenter')
    vi.advanceTimersByTime(150)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(true)

    // 模拟鼠标向下移动经过缝隙或边界触发 mouseleave
    await wrapper.trigger('mouseleave')

    // 在 100ms 时（未达到 250ms 离开阈值）浮层依然坚挺保持，防止误关
    vi.advanceTimersByTime(100)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(true)

    // 此时鼠标顺利移动到浮层卡片区域，重新触发 mouseenter
    await wrapper.trigger('mouseenter')

    // 即使再过去 300ms，因为离开定时器被及时取消，浮层依旧持续可见
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(true)

    // 当用户完全移出且超过 250ms 时，浮层正常平滑关闭
    await wrapper.trigger('mouseleave')
    vi.advanceTimersByTime(250)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(false)
  })

  it('3. [异常防护: 极速划过防抖] 鼠标以低于 150ms 的速度掠过按钮，不误弹浮层', async () => {
    const wrapper = mount(HeaderGeekModeTrigger)

    // 快速掠过：进入 50ms 后立刻移出
    await wrapper.trigger('mouseenter')
    vi.advanceTimersByTime(50)
    await wrapper.trigger('mouseleave')

    // 无论过去多久，浮层都不应该展示
    vi.advanceTimersByTime(500)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.rounded-xl').exists()).toBe(false)
  })

  it('4. [异常防护: 极限并发抖动与竞态] 10ms 极高频交替进入/移出 20 次，状态机稳定不撕裂', async () => {
    const wrapper = mount(HeaderGeekModeTrigger)

    for (let i = 0; i < 20; i++) {
      await wrapper.trigger(i % 2 === 0 ? 'mouseenter' : 'mouseleave')
      vi.advanceTimersByTime(10)
    }

    // 抖动停止在移出状态，等待超过缓冲期
    await wrapper.trigger('mouseleave')
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()

    // 浮层最终应该安全关闭，定时器无死锁
    expect(wrapper.find('.rounded-xl').exists()).toBe(false)
  })

  it('5. [生命周期安全: 组件卸载清理] 正在等待打开或关闭时组件被卸载，定时器完全清理不泄漏', async () => {
    const wrapper = mount(HeaderGeekModeTrigger)

    // 启动打开定时器
    await wrapper.trigger('mouseenter')

    // 在定时器触发前卸载组件
    wrapper.unmount()

    // 推进时间，不应有未捕获异常或试图操作已销毁组件的报错
    expect(() => {
      vi.advanceTimersByTime(500)
    }).not.toThrow()
  })
})
