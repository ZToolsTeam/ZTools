import { describe, it, expect, vi } from 'vitest'
import { List, Form, useEffect, useNavigation, useState } from '@ztools/declarative-ui'

vi.mock('ant-design-vue', () => ({ Modal: { confirm: vi.fn() } }))
vi.mock('vue', async importOriginal => ({ ...(await importOriginal()), onUnmounted: () => {} }))
import { useDeclarativeStack } from '../useDeclarativeStack'

describe('首次渲染中的插件导航', () => {
  it('根页面首次effect打开表单，表单保持栈顶，返回仍为完整根页面', async () => {
    const clean = []
    let updateRoot
    const Child = () => {
      useEffect(() => () => clean.push('child'), [])
      return Form({ navigationTitle: '新建' }, [])
    }
    const Root = () => {
      const [text, setText] = useState('初始')
      updateRoot = setText
      const { push } = useNavigation()
      useEffect(() => { push(Child); return () => clean.push('root') }, [])
      return List({ navigationTitle: text }, [])
    }
    const stack = useDeclarativeStack(Root)
    try {
      expect(stack.stack.value.map(x => x.descriptor.type)).toEqual(['List', 'Form'])
      expect(stack.currentDescriptor.value.type).toBe('Form')
      updateRoot('更新后')
      await Promise.resolve()
      expect(stack.currentDescriptor.value.type).toBe('Form')
      expect(stack.pop()).toBe(true)
      expect(stack.currentDescriptor.value.props.navigationTitle).toBe('更新后')
      expect(clean).toEqual(['child'])
    } finally { stack.clear() }
    expect(clean).toEqual(['child', 'root'])
  })

  it('连续两级初始化导航按父到子入栈，清理释放每层', () => {
    let disposed = 0
    const Page = depth => () => {
      const { push } = useNavigation()
      useEffect(() => { if (depth < 2) push(Page(depth + 1)); return () => { disposed++ } }, [])
      return List({ navigationTitle: String(depth) }, [])
    }
    const stack = useDeclarativeStack(Page(0))
    try {
      expect(stack.stack.value.map(x => x.descriptor.props.navigationTitle)).toEqual(['0', '1', '2'])
      expect(stack.currentDescriptor.value.props.navigationTitle).toBe('2')
    } finally { stack.clear() }
    expect(disposed).toBe(3)
  })

  it('子页在初始化effect立即返回时也释放root与清理函数', () => {
    let disposed = 0
    const afterPop = vi.fn()
    const stack = useDeclarativeStack(() => List({ navigationTitle: '根' }, []))
    const AutoClose = () => {
      const { pop } = useNavigation()
      useEffect(() => { pop(); return () => { disposed++ } }, [])
      useEffect(afterPop, [])
      return Form({ navigationTitle: '立即返回' }, [])
    }
    try {
      stack.push(AutoClose)
      expect(stack.stack.value).toHaveLength(1)
      expect(stack.currentDescriptor.value.props.navigationTitle).toBe('根')
      expect(disposed).toBe(1)
      expect(afterPop).not.toHaveBeenCalled()
    } finally { stack.clear() }
    expect(disposed).toBe(1)
  })
})
