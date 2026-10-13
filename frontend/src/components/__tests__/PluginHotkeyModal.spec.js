import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PluginHotkeyModal from '../PluginHotkeyModal.vue'
import { usePluginsStore } from '@/stores/plugins'

const createLaunchTrigger = (id, key) => ({
  id,
  pluginId: 'demo',
  type: 'hotkey',
  config: { key },
  action: { mode: 'window', target: 'demo', params: {} }
})

describe('PluginHotkeyModal', () => {
  let pinia
  let originalZtools

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    usePluginsStore().installedPlugins = [{ pluginId: 'demo', name: 'Demo' }]

    originalZtools = window.ztools
    window.ztools = {
      config: {
        get: vi.fn().mockResolvedValue('')
      },
      trigger: {
        list: vi.fn(),
        unregister: vi.fn().mockResolvedValue({ success: true }),
        register: vi.fn().mockResolvedValue({ triggerId: 'new-trigger' }),
        checkConflict: vi.fn().mockResolvedValue({ hasConflict: false, conflicts: [] })
      },
      sys: {
        getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }),
        getPanelLocalApps: vi.fn().mockResolvedValue([])
      }
    }
  })

  afterEach(() => {
    window.ztools = originalZtools
  })

  it('每次打开时重新读取触发器，显示最新快捷键', async () => {
    window.ztools.trigger.list
      .mockResolvedValueOnce([createLaunchTrigger('old-trigger', 'Ctrl+A')])
      .mockResolvedValueOnce([createLaunchTrigger('new-trigger', 'Ctrl+B')])

    const wrapper = mount(PluginHotkeyModal, {
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          },
          AInputSearch: true
        }
      }
    })

    await wrapper.vm.show()
    await flushPromises()
    expect(wrapper.find('.hotkey-keys').text()).toBe('CtrlA')

    wrapper.vm.hide()
    await wrapper.vm.show()
    await flushPromises()

    expect(window.ztools.trigger.list).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.hotkey-keys').text()).toBe('CtrlB')
  })

  it('修改快捷键时先注册新触发器，再注销该目标的全部历史触发器', async () => {
    window.ztools.trigger.list.mockResolvedValue([
      createLaunchTrigger('old-trigger-1', 'Ctrl+A'),
      createLaunchTrigger('old-trigger-2', 'Ctrl+C')
    ])

    const wrapper = mount(PluginHotkeyModal, {
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          },
          AInputSearch: true
        }
      }
    })

    await wrapper.vm.show()
    await wrapper.find('.hotkey-recorder').trigger('click')
    await wrapper.find('.hotkey-hidden-input').trigger('keydown', {
      key: 'B',
      ctrlKey: true
    })
    await flushPromises()

    expect(window.ztools.trigger.unregister.mock.calls).toEqual([
      ['old-trigger-1'],
      ['old-trigger-2']
    ])
    expect(window.ztools.trigger.register).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'demo',
        config: { key: 'Ctrl+B' }
      })
    )
    expect(window.ztools.trigger.register.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(...window.ztools.trigger.unregister.mock.invocationCallOrder)
    )
  })

  it('新快捷键注册失败时保留已有触发器', async () => {
    window.ztools.trigger.list.mockResolvedValue([
      createLaunchTrigger('old-trigger', 'Ctrl+A')
    ])
    window.ztools.trigger.register.mockResolvedValue({
      success: false,
      error: '快捷键冲突'
    })

    const wrapper = mount(PluginHotkeyModal, {
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          },
          AInputSearch: true
        }
      }
    })

    await wrapper.vm.show()
    await wrapper.find('.hotkey-recorder').trigger('click')
    await wrapper.find('.hotkey-hidden-input').trigger('keydown', {
      key: 'B',
      ctrlKey: true
    })
    await flushPromises()

    expect(window.ztools.trigger.register).toHaveBeenCalledOnce()
    expect(window.ztools.trigger.unregister).not.toHaveBeenCalled()
    expect(wrapper.find('.hotkey-keys').text()).toBe('CtrlA')
  })
})
