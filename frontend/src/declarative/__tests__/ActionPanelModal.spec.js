import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ActionPanelModal from '../components/ActionPanelModal.vue'

const action = (title, extra = {}) => ({ type: 'Action', props: { title, ...extra } })

function mountPanel(props = {}) {
  return mount(ActionPanelModal, {
    props: { visible: true, actions: [], ...props },
    attachTo: document.body
  })
}

describe('ActionPanelModal 动作面板', () => {
  it('不可见时不渲染', () => {
    const wrapper = mountPanel({ visible: false, actions: [action('复制')] })
    expect(wrapper.find('.action-panel').exists()).toBe(false)
  })

  it('选中项带标记；插件声明的快捷键逐键显示，首项无快捷键时提示回车', () => {
    const wrapper = mountPanel({
      actions: [action('打开'), action('复制路径', { shortcut: { modifiers: ['cmd', 'shift'], key: 'c' } })]
    })
    const items = wrapper.findAll('.action-panel-item')
    expect(items).toHaveLength(2)
    expect(items[0].classes()).toContain('is-selected')
    expect(items[0].attributes('aria-selected')).toBe('true')
    expect(items[0].findAll('kbd')).toHaveLength(1)
    // ⌘ ⇧ C（Windows 下为 Ctrl Shift C），共三枚键帽
    expect(items[1].findAll('kbd')).toHaveLength(3)
    expect(items[1].findAll('kbd').at(-1).text()).toBe('C')
    wrapper.unmount()
  })

  it('[边界] 畸形快捷键（缺 key、未知修饰键、重复修饰键）不崩溃，只展示可识别部分', () => {
    const wrapper = mountPanel({
      actions: [
        action('首项'),
        action('缺 key', { shortcut: { modifiers: ['cmd'] } }),
        action('未知修饰', { shortcut: { modifiers: ['hyper', 'cmd', 'meta'], key: 'k' } }),
        action('非数组', { shortcut: { modifiers: 'cmd', key: 'x' } })
      ]
    })
    const items = wrapper.findAll('.action-panel-item')
    expect(items[1].findAll('kbd')).toHaveLength(0)
    expect(items[2].findAll('kbd')).toHaveLength(2)
    expect(items[3].findAll('kbd')).toHaveLength(1)
    wrapper.unmount()
  })

  it('方向键循环选择、回车执行后关闭、Esc 关闭', async () => {
    const wrapper = mountPanel({ actions: [action('A'), action('B')] })
    const panel = wrapper.find('.action-panel')
    await panel.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.findAll('.action-panel-item')[1].classes()).toContain('is-selected')
    await panel.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.findAll('.action-panel-item')[0].classes()).toContain('is-selected')
    await panel.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('trigger')[0][0].props.title).toBe('A')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await panel.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })

  it('[边界] 搜索无结果时显示空状态，回车不触发任何动作', async () => {
    const wrapper = mountPanel({ actions: [action('复制')] })
    await wrapper.find('input').setValue('不存在')
    expect(wrapper.find('.action-panel-empty').text()).toBe('无匹配动作')
    await wrapper.find('.action-panel').trigger('keydown', { key: 'Enter' })
    await wrapper.find('.action-panel').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('trigger')).toBeUndefined()
    wrapper.unmount()
  })

  it('打开时聚焦搜索框；placement 控制居中或贴右下角；点击遮罩关闭', async () => {
    const wrapper = mountPanel({ visible: false, actions: [action('A')], placement: 'corner' })
    await wrapper.setProps({ visible: true })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('input').element)
    expect(wrapper.find('.action-panel-scrim').classes()).toContain('is-corner')
    await wrapper.find('.action-panel-scrim').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('[边界] 面板弹出时停在原处的鼠标不会抢走键盘选中项，移动鼠标才跟随', async () => {
    const wrapper = mountPanel({ actions: [action('A'), action('B')] })
    const items = wrapper.findAll('.action-panel-item')
    await items[1].trigger('mouseenter')
    expect(items[0].classes()).toContain('is-selected')
    await items[1].trigger('mousemove')
    expect(items[1].classes()).toContain('is-selected')
    wrapper.unmount()
  })

  it('动作都没有图标时不显示图标列；部分有图标时无图标项留空位对齐', () => {
    const plain = mountPanel({ actions: [action('启动'), action('查看详情')] })
    expect(plain.findAll('.action-panel-icon')).toHaveLength(0)
    expect(plain.findAll('.action-panel-icon-slot')).toHaveLength(0)
    plain.unmount()

    const mixed = mountPanel({ actions: [action('复制', { icon: 'copy' }), action('删除')] })
    const items = mixed.findAll('.action-panel-item')
    expect(items[0].find('.action-panel-icon').exists()).toBe(true)
    expect(items[1].find('.action-panel-icon').exists()).toBe(false)
    expect(items[1].find('.action-panel-icon-slot').exists()).toBe(true)
    mixed.unmount()
  })
})
