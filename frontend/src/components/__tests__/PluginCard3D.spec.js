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
    expect(wrapper.find('.card-icon-btn.update').attributes('aria-label')).toBe('更新')
    expect(wrapper.text()).not.toContain('更新')
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

  it('官方插件只显示盾形标记，标题行不占「官方自营」四个字', () => {
    const wrapper = mount(PluginCard3D, {
      props: {
        plugin: {
          pluginId: 'official-memory',
          name: '系统内存与进程',
          isOfficial: true
        }
      }
    })

    const mark = wrapper.find('.card-mark-official')
    expect(mark.exists()).toBe(true)
    expect(mark.attributes('title')).toBe('官方自营')
    expect(mark.attributes('aria-label')).toBe('官方自营')
    expect(wrapper.text()).not.toContain('官方自营')
    expect(wrapper.find('.card-title').attributes('title')).toBe('系统内存与进程')

    const community = mount(PluginCard3D, {
      props: {
        plugin: {
          pluginId: 'community-tool',
          name: '社区工具',
          sourceType: 'community',
          isOfficial: false,
          is_official: false
        }
      }
    })
    expect(community.find('.card-mark-official').exists()).toBe(false)
  })

  it('插件卡片显示平台标签；未声明平台时不显示', () => {
    const t = (platform) => ({ id: `${platform}-electron-any`, platform, runtime: 'electron', arch: 'any' })
    const cases = [
      [[t('windows'), t('macos')], '跨平台'],
      [[t('windows')], '仅 Windows'],
      [[t('macos')], '仅 macOS']
    ]
    const icons = ['anticon-global', 'anticon-windows', 'anticon-apple']
    for (const [index, [targets, label]] of cases.entries()) {
      const wrapper = mount(PluginCard3D, { props: { plugin: { pluginId: 'p', name: 'P', targets } } })
      const mark = wrapper.find('.card-mark-platform')
      expect(mark.attributes('title')).toBe(label)
      expect(mark.attributes('aria-label')).toBe(label)
      expect(mark.find('.anticon').classes()).toContain(icons[index])
      expect(wrapper.text()).not.toContain(label)
      wrapper.unmount()
    }
    const legacy = mount(PluginCard3D, { props: { plugin: { pluginId: 'p', name: 'P' } } })
    expect(legacy.find('.card-mark-platform').exists()).toBe(false)
  })
})

