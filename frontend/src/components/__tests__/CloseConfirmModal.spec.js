import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import CloseConfirmModal from '../CloseConfirmModal.vue'
import { useUIStore } from '@/stores/ui'

describe('CloseConfirmModal 键盘 Esc 取消与操作反馈', () => {
  let pinia
  let uiStore
  let originalZtools

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    uiStore = useUIStore()
    originalZtools = window.ztools
    window.ztools = {
      settings: { set: vi.fn().mockResolvedValue(true) },
      win: { sendCloseConfirmResult: vi.fn().mockResolvedValue(true) }
    }
  })

  afterEach(() => {
    window.ztools = originalZtools
  })

  it('打开退出确认弹窗时按 Escape 直接取消关闭并通知宿主；组字期间 Esc 不误关', async () => {
    const wrapper = mount(CloseConfirmModal, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open" data-testid="close-confirm-body"><slot /><slot name="footer" /></div>'
          },
          ACheckbox: {
            props: ['checked'],
            template: '<input type="checkbox" :checked="checked" @change="$emit(\'update:checked\', $event.target.checked)" />'
          }
        }
      }
    })

    uiStore.openCloseConfirm()
    await flushPromises()
    expect(uiStore.showCloseConfirm).toBe(true)

    // 输入法组字期间按 Escape 不得误取消关闭流程
    const composingEsc = new KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(composingEsc)
    await flushPromises()
    expect(uiStore.showCloseConfirm).toBe(true)
    expect(window.ztools.win.sendCloseConfirmResult).not.toHaveBeenCalled()

    // 正常按 Escape 直接取消关闭弹窗并上报 action: 'cancel'
    const cancelEsc = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(cancelEsc)
    await flushPromises()
    expect(cancelEsc.defaultPrevented).toBe(true)
    expect(window.ztools.win.sendCloseConfirmResult).toHaveBeenCalledWith({
      confirmed: false,
      doNotAskAgain: false,
      action: 'cancel'
    })
    expect(uiStore.showCloseConfirm).toBe(false)

    wrapper.unmount()
  })

  it('点击最小化到托盘或立即退出会携带勾选状态写入配置并防重入', async () => {
    const wrapper = mount(CloseConfirmModal, {
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /><slot name="footer" /></div>'
          },
          ACheckbox: {
            props: ['checked'],
            template: '<input type="checkbox" :checked="checked" />'
          }
        }
      }
    })

    uiStore.openCloseConfirm()
    await flushPromises()

    const minimizeBtn = wrapper.findAll('button').find((b) => b.text().includes('最小化到托盘'))
    await minimizeBtn.trigger('click')
    await flushPromises()

    expect(window.ztools.settings.set).toHaveBeenCalledWith('closeConfirm', false)
    expect(window.ztools.settings.set).toHaveBeenCalledWith('minimizeToTray', true)
    expect(window.ztools.win.sendCloseConfirmResult).toHaveBeenCalledWith({
      confirmed: false,
      doNotAskAgain: true,
      action: 'minimize'
    })
    expect(uiStore.showCloseConfirm).toBe(false)

    // 再次打开测试立即退出
    window.ztools.settings.set.mockClear()
    window.ztools.win.sendCloseConfirmResult.mockClear()
    uiStore.openCloseConfirm()
    await flushPromises()

    const exitBtn = wrapper.findAll('button').find((b) => b.text().includes('立即退出'))
    await exitBtn.trigger('click')
    await flushPromises()

    expect(window.ztools.settings.set).toHaveBeenCalledWith('minimizeToTray', false)
    expect(window.ztools.win.sendCloseConfirmResult).toHaveBeenCalledWith({
      confirmed: true,
      doNotAskAgain: true,
      action: 'exit'
    })

    wrapper.unmount()
  })
})
