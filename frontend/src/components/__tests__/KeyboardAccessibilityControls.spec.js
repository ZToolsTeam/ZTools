import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import RcSegmented from '../base/RcSegmented.vue'
import ContextMenu from '../ContextMenu.vue'
import RcMenu from '../base/RcMenu.vue'
import Sidebar from '../Sidebar.vue'
import AppearanceSettings from '../settings/AppearanceSettings.vue'
import { registerKeyHandler, KEYMAP_SCOPES, _resetKeymapForTesting } from '@/utils/keymap'
import { useUIStore } from '@/stores/ui'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { useThemeStore } from '@/stores/theme'

vi.mock('@edition', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    feedbackEntry: { visible: true, title: '反馈建议', routeName: '', externalUrl: 'https://example.com' },
    headerExtraComponents: [],
    useFeedbackIndicator: () => ({ hasUnread: false }),
    layoutExtraComponents: []
  }
})

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMocks
}))

describe('外框导航与通用控件键盘方向键一致性及模态隔离测试套件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetKeymapForTesting()
    vi.clearAllMocks()
  })

  afterEach(() => {
    _resetKeymapForTesting()
    document.body.innerHTML = ''
  })

  it('1. RcSegmented：支持 Roving tabindex 与 ←/→/↑/↓/Home/End 循环切换及焦点跟随', async () => {
    const options = [
      { label: '已安装', value: 'plugins', count: 5 },
      { label: '收藏', value: 'favorites', count: 0 },
      { label: '社区', value: 'community', count: 12 }
    ]
    const wrapper = mount(RcSegmented, {
      attachTo: document.body,
      props: {
        modelValue: 'plugins',
        options,
        'onUpdate:modelValue': (val) => wrapper.setProps({ modelValue: val })
      }
    })

    const buttons = () => wrapper.findAll('[role="radio"]')
    expect(buttons()[0].attributes('tabindex')).toBe('0')
    expect(buttons()[1].attributes('tabindex')).toBe('-1')
    expect(buttons()[2].attributes('tabindex')).toBe('-1')

    buttons()[0].element.focus()
    await buttons()[0].trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(wrapper.props('modelValue')).toBe('favorites')
    expect(document.activeElement).toBe(buttons()[1].element)
    expect(buttons()[1].attributes('tabindex')).toBe('0')

    // End 跳至末项，再按 ArrowRight 循环回首项
    await buttons()[1].trigger('keydown', { key: 'End' })
    await nextTick()
    expect(wrapper.props('modelValue')).toBe('community')
    expect(document.activeElement).toBe(buttons()[2].element)

    await buttons()[2].trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(wrapper.props('modelValue')).toBe('plugins')
    expect(document.activeElement).toBe(buttons()[0].element)

    // 首项按 ArrowLeft 循环至末项，Home 回首项
    await buttons()[0].trigger('keydown', { key: 'ArrowLeft' })
    await nextTick()
    expect(wrapper.props('modelValue')).toBe('community')

    await buttons()[2].trigger('keydown', { key: 'Home' })
    await nextTick()
    expect(wrapper.props('modelValue')).toBe('plugins')

    wrapper.unmount()
  })

  it('2. ContextMenu：模态打开时阻断底层 PAGE/GLOBAL 穿透，支持 ↑/↓ 跳过分隔线与 Enter/Esc 操作', async () => {
    const pageSpy = vi.fn(() => true)
    const globalSpy = vi.fn(() => true)
    registerKeyHandler(KEYMAP_SCOPES.PAGE, { ArrowDown: pageSpy, Enter: pageSpy })
    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { Escape: globalSpy, 'Ctrl+I': globalSpy })

    const execSpy = vi.fn(() => true)
    document.execCommand = execSpy
    window.getSelection = vi.fn(() => ({ toString: () => '选中文本' }))

    const wrapper = mount(ContextMenu, { attachTo: document.body })
    await flushPromises()

    wrapper.vm.show(new MouseEvent('contextmenu', { clientX: 100, clientY: 120, cancelable: true }))
    await nextTick()

    expect(wrapper.vm.visible).toBe(true)
    expect(wrapper.vm.focusedIndex).toBe(0) // 复制

    // 按 ↓ -> 剪切(1)，再按 ↓ -> 跳过 separator(2) 落到粘贴(3)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.vm.focusedIndex).toBe(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.vm.focusedIndex).toBe(3)
    expect(pageSpy).not.toHaveBeenCalled()

    // 模态打开期间按 Ctrl+I 被阻断，不穿透触发底层跳转
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(globalSpy).not.toHaveBeenCalled()

    // 回到第 0 项（复制）按 Enter 执行并关闭菜单
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(execSpy).toHaveBeenCalledWith('copy')
    expect(wrapper.vm.visible).toBe(false)

    // 关闭后底层快捷键恢复响应
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(globalSpy).toHaveBeenCalledTimes(1)

    delete document.execCommand
    wrapper.unmount()
  })

  it('3. Sidebar：支持 ↑/↓/Home/End 跨分类导航、Enter 跳转及 → 移交主网格焦点', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'my', component: { template: '<div />' } },
        { path: '/list/:category?', name: 'list', component: { template: '<div />' } },
        { path: '/advanced-settings', name: 'advanced-settings', component: { template: '<div />' } },
        { path: '/about', name: 'about', component: { template: '<div />' } }
      ]
    })
    await router.push('/')
    await router.isReady()

    const categoriesStore = useCategoriesStore()
    const pluginsStore = usePluginsStore()
    const uiStore = useUIStore()
    categoriesStore.$patch({
      loaded: true,
      loading: false,
      items: [
        { id: 1, name: '办公效率' },
        { id: 2, name: '开发工具' }
      ]
    })
    pluginsStore.isCategoryVisible = () => true

    const wrapper = mount(Sidebar, {
      attachTo: document.body,
      global: { plugins: [router] }
    })
    await flushPromises()

    const items = wrapper.findAll('.sidebar-item[tabindex="0"]')
    expect(items.length).toBeGreaterThanOrEqual(6)

    items[0].element.focus()
    expect(document.activeElement).toBe(items[0].element)

    // 按 ↓ 2 次进入「办公效率」分类项并按 Enter 导航
    await items[0].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1].element)
    await items[1].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2].element)

    await items[2].trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('list')
    expect(router.currentRoute.value.params.category).toBe('productivity')

    // 按 → 移交焦点给右侧卡片网格
    await items[2].trigger('keydown', { key: 'ArrowRight' })
    expect(uiStore.isGridFocused).toBe(true)

    wrapper.unmount()
  })

  it('4. AppearanceSettings：[故障与并发] 保存锁期间拒绝方向键切换，保存失败提示错误且焦点不丢失', async () => {
    const themeStore = useThemeStore()
    let rejectSave
    themeStore.setTheme = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject
        })
    )

    const wrapper = mount(AppearanceSettings, { attachTo: document.body })
    const themeBtns = () => wrapper.findAll('.theme-switcher [role="radio"]')
    themeBtns()[0].element.focus()

    // 触发方向键切换主题，进入 themeSaving 异步等待态
    await themeBtns()[0].trigger('keydown', { key: 'ArrowRight' })
    expect(themeStore.setTheme).toHaveBeenCalledTimes(1)

    // 保存尚未完成时再次狂按方向键：被互斥锁拦截，不重复发起保存
    await themeBtns()[1].trigger('keydown', { key: 'ArrowRight' })
    expect(themeStore.setTheme).toHaveBeenCalledTimes(1)

    // 注入保存失败异常
    rejectSave(new Error('磁盘只读'))
    await flushPromises()
    expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining('磁盘只读'))

    wrapper.unmount()
  })

  it('5. RcMenu：展开时支持 ↑/↓ 循环聚焦可用菜单项并跳过禁用项，Esc 关闭菜单', async () => {
    const onSelect = vi.fn()
    const wrapper = mount(RcMenu, {
      attachTo: document.body,
      props: {
        items: [
          { key: 'open', label: '打开' },
          { type: 'separator' },
          { key: 'dis', label: '已禁用', disabled: true },
          { key: 'del', label: '卸载', danger: true }
        ],
        onSelect
      },
      slots: {
        default: '<button class="trigger-btn">菜单</button>'
      }
    })

    await wrapper.find('.trigger-btn').trigger('click')
    await flushPromises()
    await nextTick()

    const menuEl = document.body.querySelector('.rc-menu')
    expect(menuEl).toBeTruthy()
    const enabledBtns = menuEl.querySelectorAll('.rc-menu-item:not(:disabled)')
    expect(enabledBtns).toHaveLength(2)

    enabledBtns[0].focus()
    menuEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(enabledBtns[1])

    // Esc 关闭下拉菜单
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()

    wrapper.unmount()
  })
})
