import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  KEYMAP_SCOPES,
  registerKeyHandler,
  dispatchKeyEvent,
  normalizeEventKeyCombo,
  _resetKeymapForTesting,
  isInputElement
} from '../keymap.js'

describe('keymap 统一快捷键分发器测试套件', () => {
  beforeEach(() => {
    _resetKeymapForTesting()
  })

  it('1. [优先级集成链路] 动作面板 > 声明式舞台 > 页面 > 全局分发层级', () => {
    const callOrder = []

    // 注册全局
    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Ctrl+K': () => {
        callOrder.push('global')
        return true
      }
    })

    // 注册页面
    registerKeyHandler(KEYMAP_SCOPES.PAGE, {
      'Ctrl+K': () => {
        callOrder.push('page')
        return true
      }
    })

    // 注册声明式舞台
    registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, {
      'Ctrl+K': () => {
        callOrder.push('declarative')
        return true
      }
    })

    // 注册动作面板
    const unregisterActionPanel = registerKeyHandler(KEYMAP_SCOPES.ACTION_PANEL, {
      'Ctrl+K': () => {
        callOrder.push('action_panel')
        return true
      }
    })

    const evt1 = {
      key: 'k',
      ctrlKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    }

    // 1.1 动作面板开启时，最高优先级拦截
    const handled1 = dispatchKeyEvent(evt1)
    expect(handled1).toBe(true)
    expect(callOrder).toEqual(['action_panel'])
    expect(evt1.preventDefault).toHaveBeenCalled()
    expect(evt1.stopPropagation).toHaveBeenCalled()

    // 1.2 动作面板注销后，声明式舞台接管
    unregisterActionPanel()
    callOrder.length = 0

    const evt2 = {
      key: 'k',
      ctrlKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    }
    const handled2 = dispatchKeyEvent(evt2)
    expect(handled2).toBe(true)
    expect(callOrder).toEqual(['declarative'])
  })

  it('2. [单次消费与穿透控制] 处理器返回 false 时应允许下潜到下一作用域', () => {
    const audit = []

    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Escape': () => {
        audit.push('global_esc')
        return true
      }
    })

    // 声明式舞台选择不处理此特定 Esc
    registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, {
      'Escape': () => {
        audit.push('declarative_esc_passthrough')
        return false // pass through
      }
    })

    const evt = {
      key: 'Escape',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    }

    const handled = dispatchKeyEvent(evt)
    expect(handled).toBe(true)
    expect(audit).toEqual(['declarative_esc_passthrough', 'global_esc'])
  })

  it('3. [核心设计键位规范匹配] Enter, Ctrl+Enter, Ctrl+K, Esc, Ctrl+M, Ctrl+F, Alt+Space', () => {
    const triggered = []

    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Enter': () => { triggered.push('enter'); return true },
      'Ctrl+Enter': () => { triggered.push('ctrl_enter'); return true },
      'Ctrl+K': () => { triggered.push('ctrl_k'); return true },
      'Escape': () => { triggered.push('esc'); return true },
      'Ctrl+M': () => { triggered.push('ctrl_m'); return true },
      'Ctrl+F': () => { triggered.push('ctrl_f'); return true },
      'Alt+Space': () => { triggered.push('alt_space'); return true }
    })

    dispatchKeyEvent({ key: 'Enter' })
    dispatchKeyEvent({ key: 'Enter', ctrlKey: true })
    dispatchKeyEvent({ key: 'k', ctrlKey: true })
    dispatchKeyEvent({ key: 'Escape' })
    dispatchKeyEvent({ key: 'm', metaKey: true }) // Cmd+M on macOS
    dispatchKeyEvent({ key: 'f', ctrlKey: true })
    dispatchKeyEvent({ key: ' ', altKey: true, code: 'Space' })

    expect(triggered).toEqual([
      'enter',
      'ctrl_enter',
      'ctrl_k',
      'esc',
      'ctrl_m',
      'ctrl_f',
      'alt_space'
    ])

    // 验证 normalizeEventKeyCombo 正确格式化 Space
    expect(normalizeEventKeyCombo({ key: ' ', altKey: true, code: 'Space' })).toBe('Alt+Space')
    expect(normalizeEventKeyCombo({ key: ' ', code: 'Space' })).toBe('Space')
    expect(normalizeEventKeyCombo({ key: ' ', ctrlKey: true, code: 'Space' })).toBe('Ctrl+Space')
  })

  it('4. [Beyond Happy Path 异常容错] 非法输入、空事件、异常隔离与注销幂等', () => {
    // 4.1 空事件分发
    expect(dispatchKeyEvent(null)).toBe(false)
    expect(dispatchKeyEvent(undefined)).toBe(false)

    // 4.2 非法 scope 注册拒绝
    expect(() => registerKeyHandler('invalid_scope', () => {})).toThrow(/无效的作用域/)
    expect(() => registerKeyHandler(KEYMAP_SCOPES.GLOBAL, null)).toThrow(/处理器必须/)

    // 4.3 处理器内部抛错隔离
    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Ctrl+K': () => {
        throw new Error('Explosion in handler')
      }
    })

    const evt = { key: 'k', ctrlKey: true }
    expect(() => dispatchKeyEvent(evt)).not.toThrow()

    // 4.4 注销函数幂等性
    const unregister = registerKeyHandler(KEYMAP_SCOPES.PAGE, () => true)
    expect(() => {
      unregister()
      unregister()
      unregister()
    }).not.toThrow()

    // 4.5 isInputElement 工具容错
    expect(isInputElement(null)).toBe(false)
    expect(isInputElement({})).toBe(false)
    expect(isInputElement({ tagName: 'INPUT' })).toBe(true)
    expect(isInputElement({ tagName: 'textarea' })).toBe(true)
    expect(isInputElement({ isContentEditable: true })).toBe(true)
  })
})
