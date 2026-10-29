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
        action('次项'),
        action('缺 key', { shortcut: { modifiers: ['cmd'] } }),
        action('未知修饰', { shortcut: { modifiers: ['hyper', 'cmd', 'meta'], key: 'k' } }),
        action('非数组', { shortcut: { modifiers: 'cmd', key: 'x' } })
      ]
    })
    const items = wrapper.findAll('.action-panel-item')
    expect(items[2].findAll('kbd')).toHaveLength(0)
    expect(items[3].findAll('kbd')).toHaveLength(2)
    expect(items[4].findAll('kbd')).toHaveLength(1)
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
  describe('定时刷新下的选中项保持', () => {
    const selectedTitle = (wrapper) => wrapper.find('.action-panel-item.is-selected .action-panel-title')?.text()
    const freshActions = (titles, section = '') => titles.map((t) => ({ ...action(t), _sectionTitle: section }))

    it('动作数组每次换新引用（如世界时钟每秒重渲染）时，方向键选中的项保持不变，回车执行它', async () => {
      const wrapper = mountPanel({ actions: freshActions(['复制时间', '复制时区', '删除城市']) })
      const panel = wrapper.find('.action-panel')
      await panel.trigger('keydown', { key: 'ArrowDown' })
      await panel.trigger('keydown', { key: 'ArrowDown' })
      expect(selectedTitle(wrapper)).toBe('删除城市')
      for (let i = 0; i < 5; i++) {
        await wrapper.setProps({ actions: freshActions(['复制时间', '复制时区', '删除城市']) })
      }
      expect(selectedTitle(wrapper)).toBe('删除城市')
      await panel.trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('trigger')[0][0].props.title).toBe('删除城市')
      wrapper.unmount()
    })

    it('选中项前面插入新动作时跟随选中项移动到新位置', async () => {
      const wrapper = mountPanel({ actions: freshActions(['A', 'B', 'C']) })
      await wrapper.find('.action-panel').trigger('keydown', { key: 'ArrowDown' })
      await wrapper.setProps({ actions: freshActions(['新', 'A', 'B', 'C']) })
      expect(selectedTitle(wrapper)).toBe('B')
      wrapper.unmount()
    })

    it('[边界] 同名动作分属不同分组时按分组区分，不会跳到另一分组的同名项', async () => {
      const mk = () => [...freshActions(['打开'], '当前项'), ...freshActions(['打开'], '全局操作')]
      const wrapper = mountPanel({ actions: mk() })
      await wrapper.find('.action-panel').trigger('keydown', { key: 'ArrowDown' })
      await wrapper.setProps({ actions: mk() })
      expect(wrapper.findAll('.action-panel-item')[1].classes()).toContain('is-selected')
      wrapper.unmount()
    })

    it('[边界] 选中项被删除时停在原位置；末项被删除或动作数变少时夹到最后一项', async () => {
      const wrapper = mountPanel({ actions: freshActions(['A', 'B', 'C', 'D']) })
      const panel = wrapper.find('.action-panel')
      await panel.trigger('keydown', { key: 'ArrowDown' })
      await wrapper.setProps({ actions: freshActions(['A', 'C', 'D']) })
      expect(selectedTitle(wrapper)).toBe('C')
      await panel.trigger('keydown', { key: 'ArrowUp' })
      await panel.trigger('keydown', { key: 'ArrowUp' })
      expect(selectedTitle(wrapper)).toBe('D')
      await wrapper.setProps({ actions: freshActions(['A']) })
      expect(selectedTitle(wrapper)).toBe('A')
      await panel.trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('trigger')[0][0].props.title).toBe('A')
      wrapper.unmount()
    })

    it('[边界] 动作变为空数组时不崩溃、回车不触发；恢复后选中第 1 项', async () => {
      const wrapper = mountPanel({ actions: freshActions(['A', 'B']) })
      const panel = wrapper.find('.action-panel')
      await panel.trigger('keydown', { key: 'ArrowDown' })
      await wrapper.setProps({ actions: [] })
      expect(wrapper.find('.action-panel-empty').exists()).toBe(true)
      await panel.trigger('keydown', { key: 'Enter' })
      await panel.trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.emitted('trigger')).toBeUndefined()
      await wrapper.setProps({ actions: freshActions(['X', 'Y']) })
      expect(selectedTitle(wrapper)).toBe('X')
      wrapper.unmount()
    })

    it('搜索词变化时回到第 1 项；搜索中动作数组换引用不重置', async () => {
      const wrapper = mountPanel({ actions: freshActions(['复制 A', '复制 B', '删除']) })
      const panel = wrapper.find('.action-panel')
      await panel.trigger('keydown', { key: 'ArrowDown' })
      await panel.trigger('keydown', { key: 'ArrowDown' })
      await wrapper.find('input').setValue('复制')
      expect(selectedTitle(wrapper)).toBe('复制 A')
      await panel.trigger('keydown', { key: 'ArrowDown' })
      await wrapper.setProps({ actions: freshActions(['复制 A', '复制 B', '删除']) })
      expect(selectedTitle(wrapper)).toBe('复制 B')
      await wrapper.find('input').setValue('')
      expect(selectedTitle(wrapper)).toBe('复制 A')
      wrapper.unmount()
    })

    it('子菜单动作按子菜单标题搜索；重新打开面板时清空搜索并回到第 1 项', async () => {
      const actions = () => [
        ...freshActions(['打开']),
        { ...action('5 个'), _sectionTitle: '生成数量', _fromSubmenu: true },
        { ...action('10 个'), _sectionTitle: '生成数量', _fromSubmenu: true }
      ]
      const wrapper = mountPanel({ actions: actions() })
      const panel = wrapper.find('.action-panel')
      await panel.trigger('keydown', { key: 'ArrowUp' })
      await wrapper.setProps({ actions: actions() })
      expect(selectedTitle(wrapper)).toBe('10 个')
      await wrapper.setProps({ visible: false })
      await wrapper.setProps({ visible: true, actions: actions() })
      expect(selectedTitle(wrapper)).toBe('打开')
      await wrapper.find('input').setValue('数量')
      expect(wrapper.findAll('.action-panel-item')).toHaveLength(2)
      expect(selectedTitle(wrapper)).toBe('5 个')
      wrapper.unmount()
    })
  })

  it('[边界] 面板里 ⌘Enter / Ctrl+Enter 不当作 Enter 执行高亮项，普通 Enter 照常执行', async () => {
    const wrapper = mountPanel({ actions: [action('重命名'), action('删除原文件')] })
    const panel = wrapper.find('.action-panel')
    await panel.trigger('keydown', { key: 'ArrowDown' })
    await panel.trigger('keydown', { key: 'Enter', metaKey: true })
    await panel.trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('trigger')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.find('.action-panel-item.is-selected .action-panel-title').text()).toBe('删除原文件')
    await panel.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('trigger')[0][0].props.title).toBe('删除原文件')
    wrapper.unmount()
  })

  describe('键位提示按原始位置与视图类型计算', () => {
    const kbdTexts = (item) => item.findAll('kbd').map((k) => k.text())

    it('列表：第 1 个提示 Enter、第 2 个提示 ⌘/Ctrl+Enter，第 3 个及子菜单动作不提示', () => {
      const wrapper = mountPanel({
        actions: [action('打开'), action('复制'), action('删除'), { ...action('子项'), _fromSubmenu: true, _sectionTitle: '更多' }]
      })
      const items = wrapper.findAll('.action-panel-item')
      expect(items[0].findAll('kbd')).toHaveLength(1)
      expect(items[1].findAll('kbd')).toHaveLength(2)
      expect(items[2].findAll('kbd')).toHaveLength(0)
      expect(items[3].findAll('kbd')).toHaveLength(0)
      wrapper.unmount()
    })

    it('[时序] 搜索过滤后提示仍跟着原动作，不会把 Enter 挪到过滤后的第 1 项', async () => {
      const wrapper = mountPanel({ actions: [action('打开'), action('复制'), action('删除')] })
      const enterText = kbdTexts(wrapper.findAll('.action-panel-item')[0])
      await wrapper.find('input').setValue('删除')
      const items = wrapper.findAll('.action-panel-item')
      expect(items).toHaveLength(1)
      expect(items[0].text()).toContain('删除')
      expect(items[0].findAll('kbd')).toHaveLength(0)
      await wrapper.find('input').setValue('复制')
      const copy = wrapper.findAll('.action-panel-item')[0]
      expect(copy.findAll('kbd')).toHaveLength(2)
      expect(kbdTexts(copy)).not.toEqual(enterText)
      wrapper.unmount()
    })

    it('表单：第 1 个动作提示 ⌘/Ctrl+Enter，第 2 个不提示（表单里 ⌘Enter 只提交）', () => {
      const wrapper = mountPanel({ viewType: 'Form', actions: [action('保存'), action('清空')] })
      const items = wrapper.findAll('.action-panel-item')
      expect(items[0].findAll('kbd')).toHaveLength(2)
      expect(items[1].findAll('kbd')).toHaveLength(0)
      wrapper.unmount()
    })

    it('插件自己声明的快捷键优先于位置提示', () => {
      const wrapper = mountPanel({ actions: [action('打开', { shortcut: { modifiers: ['cmd'], key: 'o' } })] })
      expect(kbdTexts(wrapper.findAll('.action-panel-item')[0]).at(-1)).toBe('O')
      wrapper.unmount()
    })
  })

  it('危险动作带错误色样式类，普通动作没有', () => {
    const wrapper = mountPanel({ actions: [action('打开'), action('删除', { style: 'destructive' })] })
    const items = wrapper.findAll('.action-panel-item')
    expect(items[0].classes()).not.toContain('is-destructive')
    expect(items[1].classes()).toContain('is-destructive')
    wrapper.unmount()
  })
})
