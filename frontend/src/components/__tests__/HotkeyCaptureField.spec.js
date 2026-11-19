import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import HotkeyCaptureField from '../HotkeyCaptureField.vue'
import ShortcutKeys from '../base/ShortcutKeys.vue'
import { interpretRecorderKeydown, resetHotkeyRecorderState } from '@/utils/hotkeyRecorder'

const key = (init) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
const opts = { platform: 'windows', allowDoubleTap: false }

describe('interpretRecorderKeydown 录入按键归类', () => {
  beforeEach(() => resetHotkeyRecorderState())

  it('Esc 取消；单独 ⌫ / Delete 清除', () => {
    expect(interpretRecorderKeydown(key({ key: 'Escape' }), opts).action).toBe('cancel')
    expect(interpretRecorderKeydown(key({ key: 'Backspace' }), opts).action).toBe('clear')
    expect(interpretRecorderKeydown(key({ key: 'Delete' }), opts).action).toBe('clear')
  })

  it('[边界] 带修饰键的 ⌫ 不当作清除，交给组合键解析', () => {
    expect(interpretRecorderKeydown(key({ key: 'Backspace', ctrlKey: true }), opts).action).not.toBe('clear')
  })

  it('只按下修饰键时是待定状态，文字是组合键（键帽显示）；完整组合键为 valid', () => {
    const pending = interpretRecorderKeydown(key({ key: 'Control', ctrlKey: true }), opts)
    expect(pending.action).toBe('pending')
    expect(pending.isKeys).toBe(true)
    const valid = interpretRecorderKeydown(key({ key: 'k', ctrlKey: true, shiftKey: true }), opts)
    expect(valid.action).toBe('valid')
    expect(valid.hotkey).toBeTruthy()
    expect(valid.isKeys).toBe(true)
  })

  it('[异常] 不支持的按键给出提示语，不当作键帽显示', () => {
    const invalid = interpretRecorderKeydown(key({ key: 'a' }), opts)
    expect(invalid.action).toBe('invalid')
    expect(invalid.isKeys).toBe(false)
    expect(invalid.text).toBeTruthy()
  })
})

describe('HotkeyCaptureField 录入框', () => {
  it('未录入：显示已绑定的组合键与清除按钮；点击发出 start，清除发出 clear', async () => {
    const wrapper = mount(HotkeyCaptureField, { props: { hotkey: 'Ctrl+K' } })
    expect(wrapper.findComponent(ShortcutKeys).props('combo')).toBe('Ctrl+K')
    await wrapper.find('.hotkey-recorder').trigger('click')
    expect(wrapper.emitted('start')).toHaveLength(1)
    await wrapper.find('.clear-btn').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('未绑定时显示占位文案，没有清除按钮；禁用或保存中点击无效', async () => {
    const wrapper = mount(HotkeyCaptureField, { props: { emptyText: '点击录入', disabled: true } })
    expect(wrapper.find('.no-hotkey').text()).toBe('点击录入')
    expect(wrapper.find('.clear-btn').exists()).toBe(false)
    await wrapper.find('.hotkey-recorder').trigger('click')
    await wrapper.setProps({ disabled: false, loading: true })
    await wrapper.find('.hotkey-recorder').trigger('click')
    expect(wrapper.emitted('start')).toBeUndefined()
  })

  it('进入录入时聚焦隐藏输入框；按键只在录入中转发；失焦发出 cancel', async () => {
    const wrapper = mount(HotkeyCaptureField, { attachTo: document.body, props: { hotkey: '' } })
    const input = wrapper.find('.hotkey-hidden-input')
    await input.trigger('keydown', { key: 'k' })
    expect(wrapper.emitted('keydown')).toBeUndefined()
    await wrapper.setProps({ recording: true })
    await nextTick()
    expect(document.activeElement).toBe(input.element)
    await input.trigger('keydown', { key: 'k', ctrlKey: true })
    expect(wrapper.emitted('keydown')).toHaveLength(1)
    await input.trigger('blur')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('录入中：组合键用键帽显示并在待定时补省略号；提示语用文字显示；保存中显示保存提示', async () => {
    const wrapper = mount(HotkeyCaptureField, { props: { recording: true, recordingText: 'Ctrl+Shift+...', recordingIsKeys: true } })
    expect(wrapper.findComponent(ShortcutKeys).props('combo')).toBe('Ctrl+Shift')
    expect(wrapper.find('.recording-more').exists()).toBe(true)
    await wrapper.setProps({ recordingText: '不支持该组合', recordingIsKeys: false })
    expect(wrapper.findComponent(ShortcutKeys).exists()).toBe(false)
    expect(wrapper.find('.recording-text').text()).toContain('不支持该组合')
    await wrapper.setProps({ loading: true })
    expect(wrapper.find('.recording-text').text()).toBe('保存中…')
    // 录入中不显示清除按钮
    expect(wrapper.find('.clear-btn').exists()).toBe(false)
  })

  it('录制状态上报：默认未录制挂载零上报，切换录入框时后置释放不会冲掉新激活态', async () => {
    const previousZtools = window.ztools
    const [{ default: Events }, { validateMethodParams }] = await Promise.all([
      import('../../../public/js/cef-ipc/src/core/events.js'),
      import('../../../../electron-client/src/contracts/method-params.ts')
    ])
    const publishedPayloads = []
    const transport = {
      _debug: false,
      call: async (method, params) => {
        const cloned = structuredClone(params)
        validateMethodParams(method, cloned)
        if (method === 'event_publish' && cloned.envelope.type === 'hotkey_recorder_active') {
          publishedPayloads.push(cloned.envelope.payload)
        }
        return { success: true }
      }
    }
    window.ztools = { events: new Events(transport) }

    try {
      const first = mount(HotkeyCaptureField, { attachTo: document.body, props: { hotkey: 'Ctrl+1' } })
      const second = mount(HotkeyCaptureField, { attachTo: document.body, props: { hotkey: 'Ctrl+2' } })
      await nextTick()
      // 初始未录制挂载多个录入框，不应发送任何无意义的 hotkey_recorder_active 事件
      expect(publishedPayloads).toEqual([])

      // 先激活第 2 个录入框
      await second.setProps({ recording: true })
      await nextTick()
      expect(publishedPayloads.at(-1)).toEqual({ active: true })

      // 从第 2 个录入框直接切换到第 1 个录入框：第 1 个开启（含 focusin 幂等上报），第 2 个释放时检测到仍有激活框绝不发 false
      publishedPayloads.length = 0
      await first.setProps({ recording: true })
      await second.setProps({ recording: false })
      await nextTick()
      expect(publishedPayloads.length).toBeGreaterThanOrEqual(1)
      expect(publishedPayloads.every((item) => item.active === true)).toBe(true)

      // 结束第 1 个录入框录制，此时无其他激活录入框，正常发送 { active: false }
      await first.setProps({ recording: false })
      await nextTick()
      expect(publishedPayloads.at(-1)).toEqual({ active: false })

      first.unmount()
      second.unmount()
    } finally {
      window.ztools = previousZtools
    }
  })

  it('消除焦点黑洞：外层容器支持回车触发，退出录制时主动失焦隐藏输入框并将焦点归还外层容器', async () => {
    const wrapper = mount(HotkeyCaptureField, { attachTo: document.body, props: { hotkey: 'Alt+Space' } })
    const recorder = wrapper.find('.hotkey-recorder')
    const input = wrapper.find('.hotkey-hidden-input')

    // 非录制态可通过键盘 Enter 激活录入
    expect(recorder.attributes('tabindex')).toBe('0')
    await recorder.trigger('keydown.enter')
    expect(wrapper.emitted('start')).toHaveLength(1)

    // 进入录制态后焦点落在隐藏输入框
    await wrapper.setProps({ recording: true })
    await nextTick()
    expect(document.activeElement).toBe(input.element)

    // 取消或完成录制退出录制态后，隐藏输入框立即失焦，焦点归还给外层容器
    await wrapper.setProps({ recording: false })
    await nextTick()
    expect(document.activeElement).toBe(recorder.element)
    wrapper.unmount()
  })

  it('不支持双击修饰键时不向 <ShortcutKeys> 传入 Double* 或中文说明文字', async () => {
    const wrapper = mount(HotkeyCaptureField, {
      props: {
        hotkey: 'DoubleCtrl',
        platform: 'macos',
        supportsDoubleModifier: false
      }
    })
    expect(wrapper.findComponent(ShortcutKeys).exists()).toBe(false)
    expect(wrapper.text()).toContain('当前宿主不支持')

    // 即使 recordingIsKeys 误设为 true，中文说明文字也不会进入 <ShortcutKeys>
    await wrapper.setProps({
      recording: true,
      recordingText: '该组合与系统快捷键冲突',
      recordingIsKeys: true
    })
    expect(wrapper.findComponent(ShortcutKeys).exists()).toBe(false)
    expect(wrapper.find('.recording-text').text()).toContain('该组合与系统快捷键冲突')
  })
})
