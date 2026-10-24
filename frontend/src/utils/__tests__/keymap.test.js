import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  KEYMAP_SCOPES,
  registerKeyHandler,
  dispatchKeyEvent,
  normalizeEventKeyCombo,
  _resetKeymapForTesting,
  isInputElement,
  isModalOpen
} from '../keymap.js'

describe('keymap 统一快捷键分发器测试套件', () => {
  beforeEach(() => {
    _resetKeymapForTesting()
  })
  afterEach(() => _resetKeymapForTesting())

  it.each([
    ['原生组合输入标记', { isComposing: true }],
    ['输入法兼容键码', { keyCode: 229 }],
    ['Vue 输入框组合状态', { target: { tagName: 'INPUT', composing: true } }]
  ])('%s 期间所有快捷键作用域均让出按键且不阻止选字', (_label, state) => {
    const handlers = Object.values(KEYMAP_SCOPES).map(scope => {
      const handler = vi.fn(() => true)
      registerKeyHandler(scope, handler)
      return handler
    })
    for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape', ' ']) {
      const event = { key, ...state, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      expect(dispatchKeyEvent(event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.stopPropagation).not.toHaveBeenCalled()
    }
    handlers.forEach(handler => expect(handler).not.toHaveBeenCalled())
    expect(dispatchKeyEvent({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true)
    expect(handlers[0]).toHaveBeenCalledOnce()
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

  describe('对话框打开时页面快捷键不响应', () => {
    const addWrap = (style = '') => {
      const wrap = document.createElement('div')
      wrap.className = 'ant-modal-wrap'
      if (style) wrap.setAttribute('style', style)
      document.body.appendChild(wrap)
      return wrap
    }

    it('有可见对话框时 dispatchKeyEvent 不分发，Esc 不会触发页面返回', () => {
      const back = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.PAGE, { Escape: back })
      const wrap = addWrap()
      try {
        expect(isModalOpen()).toBe(true)
        expect(dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
        expect(back).not.toHaveBeenCalled()
      } finally {
        wrap.remove()
      }
      expect(dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
      expect(back).toHaveBeenCalledTimes(1)
    })

    it('[边界] 已关闭（display: none）的对话框残留节点不影响快捷键', () => {
      const back = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.PAGE, { Escape: back })
      const wrap = addWrap('display: none;')
      try {
        expect(isModalOpen()).toBe(false)
        expect(dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
      } finally {
        wrap.remove()
      }
    })
  })

  describe('输入法组字与重复分发', () => {
    it('[异常] 组字中的 Enter（isComposing / keyCode 229）不产生组合键、不分发、不 preventDefault', () => {
      const enter = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, { Enter: enter })
      const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true })
      const legacy = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      Object.defineProperty(legacy, 'keyCode', { value: 229 })
      expect(normalizeEventKeyCombo(composing)).toBe('')
      expect(dispatchKeyEvent(composing)).toBe(false)
      expect(dispatchKeyEvent(legacy)).toBe(false)
      expect(composing.defaultPrevented).toBe(false)
      expect(legacy.defaultPrevented).toBe(false)
      expect(enter).not.toHaveBeenCalled()
    })

    it('[并发] 同一事件被窗口监听与根节点先后分发时只处理一次', () => {
      const onKey = vi.fn(() => false)
      registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, { onKeyDown: onKey })
      const ev = new KeyboardEvent('keydown', { key: 'a' })
      dispatchKeyEvent(ev)
      dispatchKeyEvent(ev)
      expect(onKey).toHaveBeenCalledTimes(1)
      dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'a' }))
      expect(onKey).toHaveBeenCalledTimes(2)
    })
  })
})
