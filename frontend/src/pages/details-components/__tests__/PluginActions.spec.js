import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

import PluginActions from '../PluginActions.vue'

// 下拉菜单默认不渲染浮层，这里把 antd Dropdown 换成直接展开浮层的替身，便于检查 RcMenu 的菜单项
const stubs = {
  'a-button': { template: '<button class="a-button"><slot /></button>' },
  'a-tooltip': { template: '<div><slot /></div>' },
  ADropdown: { template: '<div class="a-dropdown"><slot /><slot name="overlay" /></div>' }
}

function menuTexts(wrapper) {
  return wrapper.findAll('.rc-menu-item').map((item) => item.text())
}

describe('插件详情操作菜单', () => {
  it('普通已安装插件（Windows）：显示快捷键、桌面快捷方式与卸载', () => {
    const wrapper = mount(PluginActions, { props: { isInstalled: true }, global: { stubs } })
    const texts = menuTexts(wrapper)
    expect(texts.some((text) => text.includes('设置快捷键'))).toBe(true)
    expect(texts.some((text) => text.includes('生成桌面快捷方式'))).toBe(true)
    expect(texts.some((text) => text.includes('卸载'))).toBe(true)
  })

  it('内置插件：没有卸载项和对应的分隔线', () => {
    const wrapper = mount(PluginActions, {
      props: { isInstalled: true, canUninstall: false },
      global: { stubs }
    })
    expect(menuTexts(wrapper).some((text) => text.includes('卸载'))).toBe(false)
    expect(wrapper.find('.rc-menu-separator').exists()).toBe(false)
  })

  it('随包内置插件提供普通管理入口，普通插件的卸载动作仍保持独立', async () => {
    const wrapper = mount(PluginActions, { props: { isInstalled: true, isBundled: true }, global: { stubs } })
    const item = wrapper.findAll('.rc-menu-item').find((entry) => entry.text().includes('管理内置插件'))
    expect(item.classes()).not.toContain('is-danger')
    expect(menuTexts(wrapper)).not.toContain('卸载')
    await item.trigger('click')
    expect(wrapper.emitted('uninstall')).toHaveLength(1)
  })

  it('非 Windows：没有“生成桌面快捷方式”（宿主在这些平台必然报不支持）', () => {
    const wrapper = mount(PluginActions, {
      props: { isInstalled: true, canCreateShortcut: false },
      global: { stubs }
    })
    const texts = menuTexts(wrapper)
    expect(texts.some((text) => text.includes('生成桌面快捷方式'))).toBe(false)
    expect(texts.some((text) => text.includes('卸载'))).toBe(true)
  })

  it('点击卸载项仍然发出 uninstall 事件', async () => {
    const wrapper = mount(PluginActions, { props: { isInstalled: true }, global: { stubs } })
    const uninstallItem = wrapper.findAll('.rc-menu-item').find((item) => item.text().includes('卸载'))
    await uninstallItem.trigger('click')
    expect(wrapper.emitted('uninstall')).toHaveLength(1)
  })

  it('已绑定快捷键时菜单项显示「修改快捷键」并在右侧按平台渲染组合键帽；点击发出 set-hotkey', async () => {
    const winWrapper = mount(PluginActions, {
      props: { isInstalled: true, hotkeyText: 'Ctrl+Shift+M' },
      global: { stubs }
    })
    const winItem = winWrapper.findAll('.rc-menu-item').find((el) => el.text().includes('修改快捷键'))
    expect(winItem.findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', 'Shift', 'M'])
    await winItem.trigger('click')
    expect(winWrapper.emitted('set-hotkey')).toHaveLength(1)
    winWrapper.unmount()

    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
    try {
      const macWrapper = mount(PluginActions, {
        props: { isInstalled: true, hotkeyText: 'Ctrl+Shift+M' },
        global: { stubs }
      })
      const macItem = macWrapper.findAll('.rc-menu-item').find((el) => el.text().includes('修改快捷键'))
      expect(macItem.findAll('kbd').map((k) => k.text())).toEqual(['⌘', '⇧', 'M'])
      macWrapper.unmount()
    } finally {
      delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
    }
  })

  it('正在生成桌面快捷方式时该项禁用，点击不会重复发出事件', async () => {
    const wrapper = mount(PluginActions, { props: { isInstalled: true, creatingShortcut: true }, global: { stubs } })
    const item = wrapper.findAll('.rc-menu-item').find((el) => el.text().includes('正在生成'))
    expect(item.attributes('disabled')).toBeDefined()
    await item.trigger('click')
    expect(wrapper.emitted('create-shortcut')).toBeUndefined()
  })
})
