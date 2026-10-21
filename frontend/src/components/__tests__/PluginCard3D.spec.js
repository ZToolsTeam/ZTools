import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PluginCard3D from '../PluginCard3D.vue'

const apiMocks = vi.hoisted(() => ({
  downloadPluginUpdate: vi.fn()
}))

vi.mock('@/api/apiserver', () => ({
  downloadPluginUpdate: apiMocks.downloadPluginUpdate
}))

describe('PluginCard3D', () => {
  beforeEach(() => {
    // 初始化 Pinia，避免 getActivePinia() 报错
    setActivePinia(createPinia())
    apiMocks.downloadPluginUpdate.mockReset()
  })

  it('updates plugin without throwing and starts download', async () => {
    apiMocks.downloadPluginUpdate.mockResolvedValue({ success: true })

    const wrapper = mount(PluginCard3D, {
      props: {
        plugin: {
          pluginId: 'plugin-1',
          name: 'Plugin 1',
          description: 'test plugin'
        },
        updateInfo: {
          hasUpdate: true,
          version: '1.0.1'
        }
      }
    })

    await wrapper.find('.card-icon-btn.update').trigger('click')
    await flushPromises()

    expect(apiMocks.downloadPluginUpdate).toHaveBeenCalledWith('plugin-1', {
      hasUpdate: true,
      version: '1.0.1'
    })
    // 更新完成由 plugin_install_complete 事件异步驱动，不是同步 emit
    // 此处只验证 API 被正确调用且没有抛出异常
  })

  it('shows favorite button when enabled and emits toggle event', async () => {
    const wrapper = mount(PluginCard3D, {
      props: {
        plugin: {
          pluginId: 'plugin-2',
          name: 'Plugin 2'
        },
        showFavorite: true,
        isFavorite: false
      }
    })

    await wrapper.find('.card-icon-btn').trigger('click')

    expect(wrapper.emitted('toggle-favorite')).toEqual([['plugin-2']])
  })

  it('插件卡片显示平台标签；未声明平台时不显示', () => {
    const t = (platform) => ({ id: `${platform}-electron-any`, platform, runtime: 'electron', arch: 'any' })
    const cases = [
      [[t('windows'), t('macos')], '跨平台'],
      [[t('windows')], '仅 Windows'],
      [[t('macos')], '仅 macOS']
    ]
    for (const [targets, label] of cases) {
      const wrapper = mount(PluginCard3D, { props: { plugin: { pluginId: 'p', name: 'P', targets } } })
      expect(wrapper.find('.card-badge-platform').text()).toBe(label)
      wrapper.unmount()
    }
    const legacy = mount(PluginCard3D, { props: { plugin: { pluginId: 'p', name: 'P' } } })
    expect(legacy.find('.card-badge-platform').exists()).toBe(false)
  })
})

