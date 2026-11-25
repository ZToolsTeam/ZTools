import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
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
  const body = () => new DOMWrapper(document.body)

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
    document.body.replaceChildren()
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

  it('真实挂载 RcDialog 时支持渲染大量功能项并通过右上角关闭按钮关闭并退出录制态', async () => {
    usePluginsStore().installedPlugins = Array.from({ length: 25 }, (_, index) => ({
      pluginId: `plugin-${index}`,
      name: `插件 ${index}`,
      features: [
        { code: `feat-a-${index}`, explain: `功能 A ${index}` },
        { code: `feat-b-${index}`, explain: `功能 B ${index}` }
      ]
    }))

    const wrapper = mount(PluginFeatureHotkeyModal, {
      attachTo: document.body,
      global: {
        plugins: [pinia]
      }
    })

    await wrapper.vm.show()
    await flushPromises()

    const dialog = body().find('.rc-dialog')
    const closeButton = body().find('.rc-dialog-close')
    const list = body().find('.feature-hotkey-list')

    expect(dialog.exists()).toBe(true)
    expect(closeButton.exists()).toBe(true)
    expect(list.exists()).toBe(true)
    expect(body().findAll('.feature-hotkey-item').length).toBe(52)

    // 进入录制态后直接点击关闭按钮，应清理录制态并关闭弹窗
    await body().find('.hotkey-recorder').trigger('click')
    await flushPromises()
    expect(body().find('.hotkey-recorder.recording').exists()).toBe(true)

    await closeButton.trigger('click')
    await flushPromises()

    expect(body().find('.hotkey-recorder.recording').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'RcDialog' }).props('open')).toBe(false)

    wrapper.unmount()
  })
})
