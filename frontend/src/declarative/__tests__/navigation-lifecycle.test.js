import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { Action, ActionPanel, Form, List, useEffect, useNavigation, useState } from '@ztools/declarative-ui'
import DeclarativeView from '../DeclarativeView.vue'
import { useDeclarativeStack } from '../composables/useDeclarativeStack.js'
import { _resetKeymapForTesting } from '@/utils/keymap.js'

const mounted = []
const stacks = []
const root = () => List({ navigationTitle: '根页面' }, [])

function mountStack(component = root) {
  let stack
  const wrapper = mount(defineComponent({ setup() {
    stack = useDeclarativeStack(component)
    return () => h('div')
  } }))
  mounted.push(wrapper)
  stacks.push(stack)
  return { wrapper, stack }
}

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  for (const stack of stacks.splice(0)) stack.clear()
  vi.useRealTimers()
  _resetKeymapForTesting()
  delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
  document.body.innerHTML = ''
})

describe('导航归属于创建它的页面', () => {
  it('退出插件后迟到 push 不挂载隐形页或启动定时器', async () => {
    vi.useFakeTimers()
    let navigation
    const started = vi.fn()
    const { wrapper, stack } = mountStack(() => { navigation = useNavigation(); return root() })
    const delayed = Promise.resolve().then(() => navigation.push(() => {
      useEffect(() => {
        started()
        const timer = setInterval(() => {}, 1000)
        return () => clearInterval(timer)
      }, [])
      return root()
    }))
    wrapper.unmount()
    await delayed
    stack.push(root)
    expect(started).not.toHaveBeenCalled()
    expect(stack.stack.value).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('换根后旧导航失效，新根导航仍可正常进入和返回', () => {
    let oldNavigation, freshNavigation
    const { stack } = mountStack(() => { oldNavigation = useNavigation(); return root() })
    stack.clear()
    stack.push(() => { freshNavigation = useNavigation(); return root() })
    oldNavigation.push(() => Form({ navigationTitle: '已过期' }, []))
    expect(stack.stack.value).toHaveLength(1)
    freshNavigation.push(() => Form({ navigationTitle: '新表单' }, []))
    expect(stack.currentDescriptor.value.props.navigationTitle).toBe('新表单')
    expect(stack.pop()).toBe(true)
    freshNavigation.push(() => Form({ navigationTitle: '再次进入' }, []))
    expect(stack.currentDescriptor.value.props.navigationTitle).toBe('再次进入')
  })

  it('effect 更新时同步返回仍清理资源且不运行后续 effect', async () => {
    vi.useFakeTimers()
    let close
    const clean = vi.fn(), afterClose = vi.fn()
    const { stack } = mountStack()
    stack.push(() => {
      const [leave, setLeave] = useState(false)
      close = setLeave
      const { pop } = useNavigation()
      useEffect(() => {
        if (!leave) return
        const timer = setInterval(() => {}, 1000)
        pop()
        return () => { clean(); clearInterval(timer) }
      }, [leave])
      useEffect(() => { if (leave) afterClose() }, [leave])
      return Form({}, [])
    })
    close(true)
    await settle()
    expect(stack.stack.value).toHaveLength(1)
    expect(clean).toHaveBeenCalledTimes(1)
    expect(afterClose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('键盘保存挂起时 Esc 返回再编辑，旧保存不关闭新表单或丢失输入', async () => {
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const saved = vi.fn(() => pending)
    const Editor = () => {
      const { pop } = useNavigation()
      const [text, setText] = useState('')
      return Form({ navigationTitle: '编辑', actions: ActionPanel({}, [
        Action.SubmitForm({ title: '保存', onSubmit: async () => { await saved(text); pop() } })
      ]) }, [Form.TextField({ id: 'text', title: '内容', value: text, onChange: setText })])
    }
    const Root = () => {
      const { push } = useNavigation()
      return List({ navigationTitle: '根页面' }, [List.Item({ id: 'edit', title: '编辑',
        actions: ActionPanel({}, [Action({ title: '打开编辑', onAction: () => push(Editor) })]) })])
    }
    const wrapper = mount(DeclarativeView, { props: { rootComponent: Root }, attachTo: document.body })
    mounted.push(wrapper)
    await settle()
    await wrapper.trigger('keydown', { key: 'Enter' })
    await settle()
    await wrapper.find('input').setValue('第一次保存')
    await settle()
    await wrapper.find('input').trigger('keydown', { key: 'Enter', metaKey: true })
    expect(saved).toHaveBeenCalledWith('第一次保存')
    await wrapper.find('input').trigger('keydown', { key: 'Escape' })
    await settle()
    expect(wrapper.text()).toContain('根页面')
    await wrapper.trigger('keydown', { key: 'Enter' })
    await settle()
    await wrapper.find('input').setValue('第二次尚未保存')
    finish()
    await settle()
    expect(wrapper.find('input').element.value).toBe('第二次尚未保存')
    expect(wrapper.text()).not.toContain('根页面')
    expect(saved).toHaveBeenCalledTimes(1)
  })
})
