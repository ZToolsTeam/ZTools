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
        getInfo: vi.fn().mockResolvedValue({ platform: 'windows' })
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

  it('编辑已有快捷键时传递 excludeTriggerId 给 checkConflict，且按 Esc 取消录入后归还焦点不滞留隐藏输入框', async () => {
    window.ztools.trigger.list.mockResolvedValue([
      createLaunchTrigger('existing-trigger-id', 'Ctrl+A')
    ])

    const wrapper = mount(PluginHotkeyModal, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          },
          AInput: true,
          AInputSearch: true
        }
      }
    })

    await wrapper.vm.show()
    await flushPromises()
    const recorder = wrapper.find('.hotkey-recorder')
    const hiddenInput = wrapper.find('.hotkey-hidden-input')

    await recorder.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(hiddenInput.element)

    // 在录制框内按 Esc 取消录制：隐藏输入框必须失去焦点且将焦点归还给外层容器，以免吞掉后续关闭弹窗的 Esc
    await hiddenInput.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(recorder.classes()).not.toContain('recording')
    expect(document.activeElement).toBe(recorder.element)

    // 再次录入 Ctrl+B：向 checkConflict 携带 existing-trigger-id 避免自我冲突
    await recorder.trigger('click')
    await flushPromises()
    await hiddenInput.trigger('keydown', { key: 'B', ctrlKey: true })
    await flushPromises()

    expect(window.ztools.trigger.checkConflict).toHaveBeenCalledWith(
      'Ctrl+B',
      'demo',
      'existing-trigger-id'
    )
    wrapper.unmount()
  })

  it('传入 pluginId 打开时自动填充搜索并高亮匹配目标行', async () => {
    usePluginsStore().installedPlugins = [
      { pluginId: 'demo', name: 'Demo A' },
      { pluginId: 'target-plugin', name: '目标插件' }
    ]
    window.ztools.trigger.list.mockResolvedValue([])

    const wrapper = mount(PluginHotkeyModal, {
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          },
          AInput: true,
          AInputSearch: true
        }
      }
    })

    await wrapper.vm.show({ pluginId: 'target-plugin' })
    await flushPromises()

    const rows = wrapper.findAll('.plugin-hotkey-item')
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes('data-target-id')).toBe('target-plugin')
    expect(rows[0].classes()).toContain('is-highlighted')
  })

  it('打开弹窗时不再调用 getPanelLocalApps，安全忽略残留 launch_local_app 触发器并正确渲染无插件空状态', async () => {
    const getPanelLocalAppsSpy = vi.fn()
    window.ztools.sys.getPanelLocalApps = getPanelLocalAppsSpy
    usePluginsStore().installedPlugins = []
    window.ztools.trigger.list.mockResolvedValue([
      {
        id: 'legacy-local-trigger',
        pluginId: 'localapp:old',
        type: 'hotkey',
        config: { key: 'Ctrl+Alt+L' },
        action: { mode: 'builtin', target: 'launch_local_app', params: { appId: 'localapp:old' } }
      }
    ])

    const wrapper = mount(PluginHotkeyModal, {
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          },
          AInput: {
            props: ['placeholder', 'value'],
            template: '<input :placeholder="placeholder" :value="value" />'
          }
        }
      }
    })

    await wrapper.vm.show()
    await flushPromises()

    expect(getPanelLocalAppsSpy).not.toHaveBeenCalled()
    expect(wrapper.vm.configuredCount).toBe(0)
    expect(wrapper.find('input').attributes('placeholder')).toBe('搜索插件...')
    expect(wrapper.find('.empty-tip').text()).toBe('暂无可配置的插件')
    expect(wrapper.findAll('.plugin-hotkey-item')).toHaveLength(0)
  })
})
