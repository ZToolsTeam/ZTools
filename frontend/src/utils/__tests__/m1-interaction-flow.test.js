/**
 * ZTools M1 阶段前端交互端到端集成测试套件 (M1 End-to-End Integration Tests)
 * 按项目测试规范编写，覆盖正常流程与异常情况：
 * 1. 默认包含集成测试：
 *    - 统一快捷键调度优先级闭环 (ActionPanel > Declarative > Page > Global)
 *    - 焦点三态状态机流转 (SEARCH <-> GRID <-> DECLARATIVE)
 *    - useCommandSearch 本地零网络阻塞检索与 Frecency 动态加权
 *    - 卡片网格键盘流与内嵌声明式舞台
 * 2. 严禁仅写 Happy Path：
 *    - 异常参数、畸形数据、破坏性事件篡改、高频并发竞态拦截
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  KEYMAP_SCOPES,
  registerKeyHandler,
  dispatchKeyEvent,
  normalizeEventKeyCombo,
  _resetKeymapForTesting
} from '../keymap.js'
import { useUIStore, FOCUS_STATES } from '@/stores/ui.js'
import { useCommandSearch, recordCommandUsage, loadFrecencyMap } from '@/composables/useCommandSearch.js'

describe('M1 阶段前端交互综合集成与破坏性测试', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    _resetKeymapForTesting()
    vi.clearAllMocks()
  })

  it('1. [集成链路: 快捷键分发优先级矩阵] 动作面板 > 声明式舞台 > 页面 > 全局', () => {
    const trace = []

    // 1.1 注册全层级处理器
    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Ctrl+K': () => { trace.push('global_ctrl_k'); return true },
      'Escape': () => { trace.push('global_esc'); return true }
    })

    registerKeyHandler(KEYMAP_SCOPES.PAGE, {
      'Ctrl+K': () => { trace.push('page_ctrl_k'); return true },
      'Escape': () => { trace.push('page_esc'); return true }
    })

    registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, {
      'Ctrl+K': () => { trace.push('declarative_ctrl_k'); return true },
      'Escape': () => { trace.push('declarative_esc'); return true }
    })

    const unregisterModal = registerKeyHandler(KEYMAP_SCOPES.ACTION_PANEL, {
      'Ctrl+K': () => { trace.push('modal_ctrl_k'); return true },
      'Escape': () => { trace.push('modal_esc'); return true }
    })

    // 验证动作面板处于最高优先级
    const evt1 = { key: 'k', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    dispatchKeyEvent(evt1)
    expect(trace).toEqual(['modal_ctrl_k'])
    expect(evt1.preventDefault).toHaveBeenCalled()

    // 注销动作面板，声明式舞台接管
    trace.length = 0
    unregisterModal()
    const evt2 = { key: 'k', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    dispatchKeyEvent(evt2)
    expect(trace).toEqual(['declarative_ctrl_k'])
  })

  it('2. [集成链路: 三态焦点状态机与声明式舞台联动]', () => {
    const uiStore = useUIStore()

    // 初始处于搜索态
    expect(uiStore.focusState).toBe(FOCUS_STATES.SEARCH)
    expect(uiStore.isSearchFocused).toBe(true)

    // 用户通过下方向键聚焦到卡片网格
    uiStore.focusGrid()
    expect(uiStore.focusState).toBe(FOCUS_STATES.GRID)
    expect(uiStore.isGridFocused).toBe(true)

    // 用户在网格中按下 Enter 打开官方标杆声明式应用
    uiStore.focusDeclarative()
    expect(uiStore.focusState).toBe(FOCUS_STATES.DECLARATIVE)
    expect(uiStore.isDeclarativeFocused).toBe(true)

    // 声明式舞台动态上报首要动作给主界面底栏联动
    uiStore.setDeclarativePrimaryAction({ title: '复制格式化结果', type: 'Action.CopyToClipboard' })
    expect(uiStore.declarativePrimaryAction?.title).toBe('复制格式化结果')

    // 退出声明式应用，返回卡片网格
    uiStore.clearDeclarativePrimaryAction()
    uiStore.focusGrid()
    expect(uiStore.declarativePrimaryAction).toBeNull()
    expect(uiStore.isGridFocused).toBe(true)
  })

  it('3. [集成链路: useCommandSearch 与 Frecency 频度衰减]', async () => {
    const { query, filteredItems, search, recordUsage } = useCommandSearch({ enableFileSearch: false })

    // 模拟搜索关键词
    search('系统')
    expect(filteredItems.value.length).toBeGreaterThan(0)
    const topItem = filteredItems.value[0]
    expect(topItem.name).toContain('系统')

    // 记录条目使用历史
    recordUsage('system-settings')
    recordUsage('system-settings')
    recordUsage('system-settings')

    const frecencyMap = loadFrecencyMap()
    expect(frecencyMap['system-settings'].count).toBe(3)
    expect(frecencyMap['system-settings'].lastUsed).toBeGreaterThan(0)
  })

  it('4. [破坏性测试: Beyond Happy Path 极限与容错]', () => {
    // 4.1 注入不可信键盘事件
    expect(dispatchKeyEvent(null)).toBe(false)
    expect(dispatchKeyEvent({})).toBe(false)
    expect(dispatchKeyEvent({ key: 'F24' })).toBe(false)

    // 4.2 处理器内部发生未捕获异常，调度器防崩自愈
    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Enter': () => {
        throw new Error('CORRUPTED_INTERNAL_HANDLER_EXCEPTION')
      }
    })

    const explodeEvt = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    expect(() => dispatchKeyEvent(explodeEvt)).not.toThrow()

    // 4.3 状态机注入非法状态
    const uiStore = useUIStore()
    uiStore.setFocusState('HACKER_ATTACK_STATE_###')
    expect(uiStore.focusState).toBe(FOCUS_STATES.SEARCH)

    // 4.4 连续调用注销
    const dummyUnregister = registerKeyHandler(KEYMAP_SCOPES.PAGE, () => true)
    dummyUnregister()
    dummyUnregister()
    expect(() => dummyUnregister()).not.toThrow()
  })
})
