import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import Header from '../Header.vue'

vi.mock('@/api/apiserver', () => ({ isNative: true, sys: { getInfo: async () => ({}) } }))
vi.mock('@edition', () => ({
  useUserStore: () => ({ checkLoginStatus() {}, initEventListeners() {}, cleanupEventListeners() {} }),
  headerExtraComponents: []
}))

// 搜索服务不参与窗口焦点；替身仍暴露真实 DOM input，验证浏览器焦点而非调用次数。
vi.mock('../SearchBar.vue', async () => {
  const { defineComponent, h, ref } = await import('vue')
  return { default: defineComponent({
    setup(_, { expose }) {
      const input = ref(null)
      expose({ focusInput: () => input.value.focus() })
      return () => h('input', { ref: input, 'aria-label': '搜索' })
    }
  }) }
})
vi.mock('../HeaderGeekModeTrigger.vue', () => ({ default: { template: '<button>悬浮条</button>' } }))

let wrapper
let router
const settleFocus = async () => { await vi.advanceTimersByTimeAsync(1); await nextTick() }
const activate = () => window.dispatchEvent(new Event('focus'))
const logo = () => wrapper.get('[aria-label="返回主页"]').element
const search = () => wrapper.get('input').element

beforeEach(async () => {
  vi.useFakeTimers()
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'my', component: { template: '<div />' } },
    { path: '/settings', name: 'settings', component: { template: '<div />' } }
  ] })
  await router.push('/')
  await router.isReady()
  wrapper = mount(Header, { attachTo: document.body, global: {
    plugins: [router], stubs: { HeaderGeekModeTrigger: true, BrandMark: true }
  } })
  await settleFocus()
})

afterEach(() => {
  wrapper.unmount()
  document.body.replaceChildren()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('工作台窗口默认焦点', () => {
  it('首次挂载及挂载很久后激活窗口，都将默认 Logo 焦点交给搜索框', async () => {
    expect(document.activeElement).toBe(search())
    await vi.advanceTimersByTimeAsync(1000)
    logo().focus()
    activate()
    await settleFocus()
    expect(document.activeElement).toBe(search())
    expect(logo().tabIndex).toBe(0)
  })

  it.each(['keyboard', 'pointer'])('%s 主动导航到 Logo 后，重新激活仍保留该焦点', async source => {
    if (source === 'keyboard') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    else logo().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    logo().focus()
    window.dispatchEvent(new Event('blur'))
    activate()
    await settleFocus()
    expect(document.activeElement).toBe(logo())
    window.__ztoolsFocusHomeSearch()
    await settleFocus()
    expect(document.activeElement).toBe(search())
  })

  it.each(['input', 'button', 'div'])('激活不抢走用户在 %s 上的焦点', async (tag) => {
    const control = document.createElement(tag)
    control.tabIndex = 0
    if (tag === 'div') control.contentEditable = 'true'
    document.body.append(control)
    control.focus()
    activate()
    await settleFocus()
    expect(document.activeElement).toBe(control)
  })

  it('可见弹窗和非首页不恢复默认焦点，显式搜索快捷键仍然有效', async () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.getClientRects = () => [{ width: 200, height: 100 }]
    document.body.append(dialog)
    logo().focus()
    activate()
    await settleFocus()
    expect(document.activeElement).toBe(logo())
    dialog.remove()
    await router.push('/settings')
    activate()
    await settleFocus()
    expect(document.activeElement).toBe(logo())
    window.__ztoolsFocusHomeSearch()
    await settleFocus()
    expect(document.activeElement).toBe(search())
  })

  it.each(['keydown', 'pointerdown', 'blur'])('%s 取消已排队的默认聚焦，包括 nextTick 等待期间', async (type) => {
    logo().focus()
    activate()
    vi.advanceTimersByTime(1)
    const event = type === 'keydown' ? new KeyboardEvent(type, { key: 'Tab' }) : new Event(type)
    window.dispatchEvent(event)
    await settleFocus()
    expect(document.activeElement).toBe(logo())
  })

  it('卸载取消任务并移除全局入口与窗口监听', async () => {
    activate()
    wrapper.unmount()
    expect(window.__ztoolsFocusHomeSearch).toBeUndefined()
    activate()
    await settleFocus()
    expect(vi.getTimerCount()).toBe(0)
    expect(document.activeElement).toBe(document.body)
  })
})
