import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PluginFeatureHotkeyModal from '../PluginFeatureHotkeyModal.vue'
import { usePluginsStore } from '@/stores/plugins'
import {
  PLUGIN_FEATURE_HOTKEY_SOURCE,
  buildPluginFeatureTriggerId
} from '@/utils/pluginFeatureHotkeys'

describe('PluginFeatureHotkeyModal 动态功能快捷键、焦点归还与冲突剔除', () => {
  let pinia
  let originalZtools

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    usePluginsStore().installedPlugins = [
      {
        pluginId: 'json-format',
        name: 'JSON 格式化',
        features: [{ code: 'pretty', explain: '美化 JSON' }]
      }
    ]

    originalZtools = window.ztools
    window.ztools = {
      config: { get: vi.fn().mockResolvedValue('') },
      trigger: {
        list: vi.fn().mockResolvedValue([]),
        register: vi.fn().mockResolvedValue({ success: true }),
        unregister: vi.fn().mockResolvedValue({ success: true }),
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

  it('同时展示内置功能与已安装插件动态 features[]，注册时携带 excludeTriggerId 并在 Esc 取消后归还焦点', async () => {
    const dynamicTriggerId = buildPluginFeatureTriggerId('json-format', 'pretty')
    window.ztools.trigger.list.mockResolvedValue([
      {
        id: dynamicTriggerId,
        pluginId: 'json-format',
        type: 'hotkey',
        config: { key: 'Ctrl+Alt+J' },
        action: {
          mode: 'window',
          target: 'json-format',
          params: { source: PLUGIN_FEATURE_HOTKEY_SOURCE, featureCode: 'pretty' }
        }
      }
    ])

    const wrapper = mount(PluginFeatureHotkeyModal, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /></div>'
          }
        }
      }
    })

    await wrapper.vm.show()
    await flushPromises()

    const items = wrapper.findAll('.feature-hotkey-item')
    expect(items.length).toBe(3)
    expect(items[2].text()).toContain('JSON 格式化')
    expect(items[2].text()).toContain('美化 JSON')

    const dynamicItem = items[2]
    const recorder = dynamicItem.find('.hotkey-recorder')
    const hiddenInput = dynamicItem.find('.hotkey-hidden-input')

    // 先测 Esc 取消录入后焦点退出隐藏 input 归还给外层容器
    await recorder.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(hiddenInput.element)
    await hiddenInput.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(document.activeElement).toBe(recorder.element)

    // 再测新键录入注册
    await recorder.trigger('click')
    await flushPromises()
    await hiddenInput.trigger('keydown', { key: 'K', ctrlKey: true, altKey: true })
    await flushPromises()

    expect(window.ztools.trigger.checkConflict).toHaveBeenCalledWith(
      'Ctrl+Alt+K',
      'json-format',
      dynamicTriggerId
    )
    expect(window.ztools.trigger.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: dynamicTriggerId,
        pluginId: 'json-format',
        config: { key: 'Ctrl+Alt+K' },
        actionParams: {
          source: PLUGIN_FEATURE_HOTKEY_SOURCE,
          featureCode: 'pretty'
        }
      })
    )
    wrapper.unmount()
  })
})
