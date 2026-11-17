import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia } from 'pinia'
import DeclarativeView from '../DeclarativeView.vue'
import { List, Detail, ActionPanel, Action, useState } from '@ztools/declarative-ui'
import { _resetKeymapForTesting } from '@/utils/keymap'

const mounted = []

function mountView(rootComponent) {
  const wrapper = mount(DeclarativeView, {
    props: { rootComponent },
    attachTo: document.body,
    global: {
      plugins: [createPinia()]
    }
  })
  mounted.push(wrapper)
  return wrapper
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

function press(target, key, init = {}) {
  const { keyCode, ...rest } = init
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...rest
  })
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode })
  target.dispatchEvent(event)
  return event
}

describe('声明式渲染器键盘与视觉一致性专项回归测试', () => {
  beforeEach(() => {
    _resetKeymapForTesting()
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'win32'
  })

  afterEach(() => {
    while (mounted.length) mounted.pop().unmount()
    delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
    _resetKeymapForTesting()
    document.body.innerHTML = ''
  })

  it('1. [D-02] 布局二鼠标点击左栏导航项后同步激活左栏，紧接按 ↓ 移动左栏而非右栏', async () => {
    const log = []
    const files = {
      cat1: ['1-a.png', '1-b.png'],
      cat2: ['2-a.png', '2-b.png'],
      cat3: ['3-a.png']
    }

    const wrapper = mountView(() => {
      const [activeCat, setActiveCat] = useState('cat1')
      return List(
        {
          subList: {
            title: '明细',
            items: (files[activeCat] || []).map((f) =>
              List.Item({
                id: f,
                title: f,
                actions: ActionPanel({}, [Action({ title: `打开 ${f}`, onAction: () => log.push(`file:${f}`) })])
              })
            )
          }
        },
        [
          List.Item({
            id: 'cat1',
            title: '分类一',
            onSelect: () => {
              setActiveCat('cat1')
              log.push('nav:cat1')
            },
            actions: ActionPanel({}, [Action({ title: '分类一操作', onAction: () => log.push('act:cat1') })])
          }),
          List.Item({
            id: 'cat2',
            title: '分类二',
            onSelect: () => {
              setActiveCat('cat2')
              log.push('nav:cat2')
            },
            actions: ActionPanel({}, [Action({ title: '分类二操作', onAction: () => log.push('act:cat2') })])
          }),
          List.Item({
            id: 'cat3',
            title: '分类三',
            onSelect: () => {
              setActiveCat('cat3')
              log.push('nav:cat3')
            },
            actions: ActionPanel({}, [Action({ title: '分类三操作', onAction: () => log.push('act:cat3') })])
          })
        ]
      )
    })
    await flush()

    // 鼠标点击左栏「分类二」
    const navRow2 = wrapper.findAll('.decl-row').find((r) => r.text().includes('分类二'))
    await navRow2.trigger('click')
    await flush()
    expect(log).toContain('nav:cat2')
    expect(wrapper.text()).toContain('分类二操作')
    expect(wrapper.text()).toContain('2-a.png')

    // 紧接着按 ↓：应切到左栏「分类三」并触发 onSelect，而不是移动右栏文件！
    const input = wrapper.find('input[type="text"]').element
    press(input, 'ArrowDown')
    await flush()
    expect(log).toContain('nav:cat3')
    expect(wrapper.text()).toContain('3-a.png')
  })

  it('2. [D-03] 布局二右栏为空 & 布局三空队列时，按 ↑/↓ 绝不越界穿透篡改左栏或隐藏项', async () => {
    const navSelectSpy = vi.fn()
    // 场景 A：布局二当前分类下右栏无文件
    const wrapper2 = mountView(() =>
      List(
        { subList: { title: '空目录', items: [] } },
        [
          List.Item({ id: 'c1', title: '空分类', onSelect: navSelectSpy }),
          List.Item({ id: 'c2', title: '有数据分类', onSelect: navSelectSpy })
        ]
      )
    )
    await flush()
    const input2 = wrapper2.find('input[type="text"]').element
    press(input2, 'ArrowDown')
    press(input2, 'ArrowUp')
    await flush()
    // 左栏选中项仍应保持在 c1，不能静默跳到 c2
    const rows = wrapper2.findAll('.decl-row')
    expect(rows[0].classes()).toContain('is-selected')
    expect(rows[1].classes()).not.toContain('is-selected')

    // 场景 B：布局三 workbenchPanel + 空队列 + 隐藏 children
    const hiddenLog = []
    const wrapper3 = mountView(() =>
      List(
        {
          workbenchPanel: { title: '参数工作台', fields: [{ id: 'fmt', label: '格式', value: 'MP4' }] },
          subList: { title: '待处理队列', items: [] }
        },
        [
          List.Item({ id: 'h1', title: '隐藏预设1', actions: ActionPanel({}, [Action({ title: '预设1', onAction: () => hiddenLog.push(1) })]) }),
          List.Item({ id: 'h2', title: '隐藏预设2', actions: ActionPanel({}, [Action({ title: '预设2', onAction: () => hiddenLog.push(2) })]) })
        ]
      )
    )
    await flush()
    const input3 = wrapper3.find('input[type="text"]').element
    press(input3, 'ArrowDown')
    await flush()
    // 未穿透篡改隐藏列表选中态
    expect(wrapper3.vm.$.setupState.listRendererRef.getSelectedItem()?.props?.id).toBe('h1')
  })

  it('3. [D-01] 布局二搜索框非空时，按 ↓ 进入列表导航态后可一键 ←/→ 切栏，继续输入恢复光标移动', async () => {
    const wrapper = mountView(() =>
      List(
        {
          subList: {
            title: '明细',
            items: [
              List.Item({ id: 'f1', title: 'demo1.mp4', actions: ActionPanel({}, [Action({ title: '执行文件1', onAction: () => {} })]) }),
              List.Item({ id: 'f2', title: 'demo2.mp4', actions: ActionPanel({}, [Action({ title: '执行文件2', onAction: () => {} })]) })
            ]
          }
        },
        [
          List.Item({ id: 'n1', title: '全部视频', actions: ActionPanel({}, [Action({ title: '分类动作', onAction: () => {} })]) })
        ]
      )
    )
    await flush()
    const input = wrapper.find('input[type="text"]').element
    input.focus()
    input.value = 'demo'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.setSelectionRange(2, 2) // 光标在中间

    // 刚输入完尚未按上下键：按 ← 正常移动光标，不切栏
    const ev1 = press(input, 'ArrowLeft')
    await flush()
    expect(ev1.defaultPrevented).toBe(false)
    expect(wrapper.text()).not.toContain('分类动作')

    // 按 ↓ 进入键盘浏览列表态，此时光标仍在中间(2,2)，按 ← 直接一步切到左栏！
    press(input, 'ArrowDown')
    await flush()
    const ev2 = press(input, 'ArrowLeft')
    await flush()
    expect(ev2.defaultPrevented).toBe(true)
    expect(wrapper.text()).toContain('分类动作')

    // 再按 → 直接一步切回右栏！
    const ev3 = press(input, 'ArrowRight')
    await flush()
    expect(ev3.defaultPrevented).toBe(true)
    expect(wrapper.text()).toContain('执行文件2')
  })

  it('4. [D-04 & D-07] 获焦按钮/外部按钮不被捕获阶段 Enter/Space 劫持，无修饰 Delete 快捷键正常生效', async () => {
    const log = []
    const extBtn = document.createElement('button')
    extBtn.textContent = '宿主顶栏外部按钮'
    extBtn.addEventListener('click', () => log.push('external-click'))
    document.body.appendChild(extBtn)

    const wrapper = mountView(() =>
      List(
        {
          segmentedControl: {
            value: 'all',
            options: [
              { label: '全部', value: 'all' },
              { label: '已选', value: 'checked' }
            ],
            onChange: (v) => log.push(`seg:${v}`)
          }
        },
        [
          List.Item({
            id: 'item1',
            title: '压缩包条目',
            checkable: true,
            checked: false,
            onCheckChange: (v) => log.push(`item-check:${v}`),
            actions: ActionPanel({}, [
              Action({ title: '解压', onAction: () => log.push('primary') }),
              Action({ title: '移除条目', shortcut: { modifiers: [], key: 'delete' }, onAction: () => log.push('delete-item') })
            ])
          })
        ]
      )
    )
    await flush()

    // 1) 聚焦在视图外部按钮按 Enter：绝不误触发列表 primary 动作
    extBtn.focus()
    const extEnter = press(extBtn, 'Enter')
    await flush()
    expect(extEnter.defaultPrevented).toBe(false)
    expect(log).toEqual([])

    // 2) 聚焦在内嵌 SegmentedControl 单选胶囊按 → 切换选项，按 Enter 不误触列表主动作
    const segRadios = wrapper.findAll('[role="radio"]')
    expect(segRadios).toHaveLength(2)
    segRadios[0].element.focus()
    await segRadios[0].trigger('keydown', { key: 'ArrowRight' })
    await flush()
    expect(log).toContain('seg:checked')
    const segEnter = press(segRadios[1].element, 'Enter')
    expect(segEnter.defaultPrevented).toBe(false)
    expect(log).not.toContain('primary')

    // 3) 搜索框为空时按 Delete 触发无修饰 delete 动作；搜索框有文字时让给输入框删字
    const input = wrapper.find('input[type="text"]').element
    input.focus()
    input.value = 'zip'
    const delWithText = press(input, 'Delete')
    await flush()
    expect(delWithText.defaultPrevented).toBe(false)
    expect(log).not.toContain('delete-item')

    input.value = ''
    const delEmpty = press(input, 'Delete')
    await flush()
    expect(delEmpty.defaultPrevented).toBe(true)
    expect(log).toContain('delete-item')

    extBtn.remove()
  })

  it('5. [D-06] 独立 Detail 页面自动将焦点落入内部正文滚动容器以支持原生方向键滚屏', async () => {
    const wrapper = mountView(() =>
      Detail({
        markdown: '# 标题\n\n长文档正文内容'
      })
    )
    await flush()
    const scrollEl = wrapper.find('[data-decl-detail-scroll]').element
    expect(scrollEl).toBeTruthy()
    expect(document.activeElement).toBe(scrollEl)
  })
})
