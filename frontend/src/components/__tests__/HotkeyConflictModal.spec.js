import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

import HotkeyConflictModal from '../HotkeyConflictModal.vue'
import { PLUGIN_FEATURE_HOTKEY_QUERY_KEY } from '@/utils/pluginFeatureHotkeys'
import { getCurrentLocale, setI18nLocale } from '@/i18n'

describe('HotkeyConflictModal 系统占用与插件重复冲突合并展示', () => {
  let router

  beforeEach(async () => {
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/advanced-settings', name: 'advanced-settings', component: { template: '<div />' } }
      ]
    })
    await router.push('/')
    await router.isReady()
  })

  it('同时展示宿主推送的 { type: "system", key, pluginId, triggerId } 系统占用与插件重复冲突且不互相覆盖', async () => {
    const wrapper = mount(HotkeyConflictModal, {
      global: {
        plugins: [router],
        stubs: {
          AModal: {
            props: ['open', 'title'],
            template: '<div v-if="open" :data-title="title"><slot /><slot name="footer" /></div>'
          }
        }
      }
    })

    // 1. 先收到宿主新版系统唤醒占用格式
    wrapper.vm.show([
      {
        type: 'system',
        key: 'Alt+Space',
        pluginId: 'system',
        triggerId: 'global_wake_hotkey'
      }
    ])
    await flushPromises()

    expect(wrapper.find('[data-testid="system-conflicts-section"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('全局唤醒快捷键')

    // 2. 弹窗未关闭时再次收到插件重复冲突，合并追加且保留第一条
    wrapper.vm.show([
      {
        pluginName: '翻译助手',
        pluginId: 'translate',
        key: 'Ctrl+Alt+T',
        conflictType: 'duplicate',
        conflictWith: '截图助手',
        triggerId: 'launch_translate'
      }
    ])
    await flushPromises()

    expect(wrapper.find('[data-testid="system-conflicts-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="duplicate-conflicts-section"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('系统占用冲突')
    expect(wrapper.text()).toContain('插件重复冲突')
    expect(wrapper.text()).toContain('全局唤醒快捷键')
    expect(wrapper.text()).toContain('翻译助手')
    expect(wrapper.text()).toContain('截图助手')

    // 3. 兼容旧版 mouse/keyboard 格式并去重
    wrapper.vm.show([
      { type: 'mouse', key: 'MouseRightLong' },
      { type: 'system', key: 'Alt+Space', pluginId: 'system', triggerId: 'global_wake_hotkey' }
    ])
    await flushPromises()
    expect(wrapper.findAll('[data-testid="system-conflicts-section"] .conflict-item')).toHaveLength(2)
    expect(wrapper.text()).toContain('鼠标快捷唤醒')

    // 点击「去设置」直接跳转快捷键设置 Tab
    const goSettingsBtn = wrapper.findAll('button').find((b) => b.text().includes('去设置'))
    await goSettingsBtn.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('advanced-settings')
    expect(router.currentRoute.value.query.tab).toBe('shortcuts')

    wrapper.unmount()
  })

  it('仅功能快捷键冲突时「前往设置」携带功能快捷键深链参数', async () => {
    const pushSpy = vi.spyOn(router, 'push')
    const wrapper = mount(HotkeyConflictModal, {
      global: {
        plugins: [router],
        stubs: {
          AModal: {
            props: ['open'],
            template: '<div v-if="open"><slot /><slot name="footer" /></div>'
          }
        }
      }
    })

    wrapper.vm.show([
      {
        pluginName: '截图工具',
        pluginId: 'screenshot',
        key: 'Ctrl+Alt+A',
        conflictType: 'duplicate',
        conflictWith: '文字识别',
        triggerId: 'plugin_feature:screenshot:region'
      }
    ])
    await flushPromises()

    const goSettingsBtn = wrapper.findAll('button').find((b) => b.text().includes('去设置'))
    await goSettingsBtn.trigger('click')
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'advanced-settings',
      query: { [PLUGIN_FEATURE_HOTKEY_QUERY_KEY]: 'true' }
    })
    wrapper.unmount()
  })

  it('弹窗打开期间热切换语言时，标题、系统唤醒名称与冲突说明实时重算不冻结', async () => {
    const prevLocale = getCurrentLocale()
    setI18nLocale('zh-CN')
    const wrapper = mount(HotkeyConflictModal, {
      global: {
        plugins: [router],
        stubs: {
          AModal: {
            props: ['open', 'title'],
            template: '<div v-if="open" :data-title="title"><slot /><slot name="footer" /></div>'
          }
        }
      }
    })

    try {
      wrapper.vm.show([
        { type: 'system', key: 'Alt+Space', pluginId: 'system', triggerId: 'global_wake_hotkey' },
        { type: 'mouse', key: 'MouseRightLong' }
      ])
      await flushPromises()
      expect(wrapper.text()).toContain('全局唤醒快捷键')
      expect(wrapper.text()).toContain('鼠标快捷唤醒')
      expect(wrapper.text()).toContain('系统或其他程序')

      setI18nLocale('en-US')
      await flushPromises()
      expect(wrapper.text()).toContain('Global Wake Hotkey')
      expect(wrapper.text()).toContain('Mouse Quick Wake')
      expect(wrapper.text()).toContain('System or another app')
      expect(wrapper.text()).not.toContain('全局唤醒快捷键')

      // 独立悬浮条快捷键 global_launcher_hotkey 也应按系统冲突项实时随语言切换显示
      wrapper.vm.close()
      await flushPromises()
      setI18nLocale('zh-CN')
      wrapper.vm.show([
        { type: 'system', key: 'Alt+Shift+Space', pluginId: 'system', triggerId: 'global_launcher_hotkey' }
      ])
      await flushPromises()
      expect(wrapper.text()).toContain('显示悬浮条快捷键')
      setI18nLocale('en-US')
      await flushPromises()
      expect(wrapper.text()).toContain('Show Quick Launcher Hotkey')
    } finally {
      setI18nLocale(prevLocale)
      wrapper.unmount()
    }
  })
})
