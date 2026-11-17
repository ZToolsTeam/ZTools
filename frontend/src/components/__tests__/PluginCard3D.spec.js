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
    const reportSpy = vi.fn()
    window.ztools = { analytics: { report: reportSpy } }

    try {
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
      expect(reportSpy).toHaveBeenCalledWith('plugin_update', 'plugin-1')
      expect(wrapper.find('.card-icon-btn.update').attributes('aria-label')).toBe('更新')
      expect(wrapper.text()).not.toContain('更新')
      // 更新完成由 plugin_install_complete 事件异步驱动，不是同步 emit
      // 此处只验证 API 被正确调用且没有抛出异常
    } finally {
      delete window.ztools
    }
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

  it('卡片去除官方与社区 UI 显示区分：官方与社区插件均不显示官方盾形标记', () => {
    const wrapper = mount(PluginCard3D, {
      props: {
        plugin: {
          pluginId: 'official-memory',
          name: '系统内存与进程',
          isOfficial: true
        }
      }
    })

    expect(wrapper.find('.card-mark-official').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('官方插件')
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

  it('插件卡片用系统标志显示支持的平台：两个都支持就并排两个；未声明平台时不显示', () => {
    const t = (platform) => ({ id: `${platform}-electron-any`, platform, runtime: 'electron', arch: 'any' })
    const cases = [
      [[t('windows'), t('macos')], '支持 Windows 和 macOS', ['brand-logo-windows', 'brand-logo-apple']],
      [[t('windows')], '仅支持 Windows', ['brand-logo-windows']],
      [[t('macos')], '仅支持 macOS', ['brand-logo-apple']]
    ]
    for (const [targets, label, logos] of cases) {
      const wrapper = mount(PluginCard3D, { props: { plugin: { pluginId: 'p', name: 'P', targets } } })
      const mark = wrapper.find('.card-platforms')
      expect(mark.attributes('title')).toBe(label)
      expect(mark.attributes('aria-label')).toBe(label)
      expect(mark.findAll('svg').map((svg) => svg.classes().find((c) => c.startsWith('brand-logo-')))).toEqual(logos)
      // 卡片上只放标志，不再出现「跨平台」这类文字
      expect(wrapper.text()).not.toContain('跨平台')
      wrapper.unmount()
    }
    const legacy = mount(PluginCard3D, { props: { plugin: { pluginId: 'p', name: 'P' } } })
    expect(legacy.find('.card-platforms').exists()).toBe(false)
  })

  it('底层官方判定逻辑保留，但界面不渲染官方角标 UI', () => {
    const community = mount(PluginCard3D, { props: { plugin: { pluginId: 'caffeine', name: '防休眠常亮', author: 'ZTools Community', source_type: 'community' } } })
    expect(community.find('.card-mark-official').exists()).toBe(false)
    expect(community.vm.isOfficial).toBe(false)
    community.unmount()

    const official = mount(PluginCard3D, { props: { plugin: { pluginId: 'clipboard-manager', name: '剪贴板历史', author: 'ZTools Team', source_type: 'official', is_official: true } } })
    expect(official.find('.card-mark-official').exists()).toBe(false)
    expect(official.vm.isOfficial).toBe(true)
    official.unmount()

    const unattributed = mount(PluginCard3D, { props: { plugin: { pluginId: 'caffeine', name: '防休眠常亮' } } })
    expect(unattributed.find('.card-mark-official').exists()).toBe(false)
    expect(unattributed.vm.isOfficial).toBe(true)
    unattributed.unmount()
  })

  it('评分：只有真实汇总有平均分时显示星与分数；人数不足、没有汇总、目录里的旧 rating 字段都不显示', () => {
    const plugin = { pluginId: 'plugin-1', name: 'Plugin 1', description: 'd', rating: 4.8 }
    const rated = mount(PluginCard3D, { props: { plugin, ratingSummary: { average: 4.56, count: 12 } } })
    expect(rated.find('.card-rating').text()).toBe('4.6')
    expect(rated.find('.card-rating').attributes('title')).toBe('平均 4.6 / 5，12 人评分')

    for (const ratingSummary of [{ average: null, count: 2 }, null, undefined, { average: 'x', count: 3 }, { average: 7, count: 3 }]) {
      const wrapper = mount(PluginCard3D, { props: { plugin, ratingSummary } })
      expect(wrapper.find('.card-rating').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('4.8')
    }
  })
})
