import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

import PluginActions from '../PluginActions.vue'

// 下拉菜单默认不渲染浮层，这里把浮层直接展开，便于检查菜单项
const stubs = {
  'a-button': { template: '<button class="a-button"><slot /></button>' },
  'a-tooltip': { template: '<div><slot /></div>' },
  'a-dropdown': { template: '<div class="a-dropdown"><slot /><slot name="overlay" /></div>' },
  'a-menu': { template: '<div class="a-menu"><slot /></div>' },
  // @click 会透传到根元素上，不需要在替身里再手动 emit
  'a-menu-item': { props: ['disabled'], template: '<div class="a-menu-item"><slot /></div>' },
  'a-menu-divider': { template: '<hr class="a-menu-divider" />' },
  BrandGlyph: true
}

function menuTexts(wrapper) {
  return wrapper.findAll('.a-menu-item').map((item) => item.text())
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
    expect(wrapper.find('.a-menu-divider').exists()).toBe(false)
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
    const uninstallItem = wrapper.findAll('.a-menu-item').find((item) => item.text().includes('卸载'))
    await uninstallItem.trigger('click')
    expect(wrapper.emitted('uninstall')).toHaveLength(1)
  })
})
