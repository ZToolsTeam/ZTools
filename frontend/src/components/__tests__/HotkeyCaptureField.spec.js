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
})
