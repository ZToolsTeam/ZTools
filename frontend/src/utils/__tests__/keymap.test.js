import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  KEYMAP_SCOPES,
  OPEN_SETTINGS_SHORTCUT,
  registerKeyHandler,
  dispatchKeyEvent,
  normalizeEventKeyCombo,
  isComposingEvent,
  _resetKeymapForTesting,
  isInputElement,
  isInputProtectedKey,
  isInteractiveControlTarget,
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

    it('[中文输入法兼容] 全角逗号与非组字 IME 229/Process 物理 Comma 键均命中 Ctrl+,，组字中与 Shift/国际键盘不误判', () => {
      const openSettingsHandler = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { 'Ctrl+,': openSettingsHandler })

      // 1. 中文全角逗号 Ctrl+， / Cmd+，
      const fullWidthCtrl = new KeyboardEvent('keydown', { key: '，', code: 'Comma', ctrlKey: true, cancelable: true })
      expect(dispatchKeyEvent(fullWidthCtrl)).toBe(true)
      expect(fullWidthCtrl.defaultPrevented).toBe(true)
      expect(openSettingsHandler).toHaveBeenCalledTimes(1)

      const fullWidthMeta = new KeyboardEvent('keydown', { key: '，', metaKey: true, cancelable: true })
      expect(dispatchKeyEvent(fullWidthMeta)).toBe(true)
      expect(openSettingsHandler).toHaveBeenCalledTimes(2)

      // 2. Windows 中文输入法未组字态上报 keyCode=229 + key='Process' + code='Comma'
      const imeWrapped = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Comma',
        ctrlKey: true,
        isComposing: false,
        cancelable: true
      })
      Object.defineProperty(imeWrapped, 'keyCode', { value: 229 })
      expect(dispatchKeyEvent(imeWrapped)).toBe(true)
      expect(imeWrapped.defaultPrevented).toBe(true)
      expect(openSettingsHandler).toHaveBeenCalledTimes(3)

      // 3. [异常/边界] 正在拼音组字（isComposing: true 或 target.composing: true）时绝不误触发且不打断输入法
      const activeComposing = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Comma',
        ctrlKey: true,
        isComposing: true,
        cancelable: true
      })
      Object.defineProperty(activeComposing, 'keyCode', { value: 229 })
      expect(dispatchKeyEvent(activeComposing)).toBe(false)
      expect(activeComposing.defaultPrevented).toBe(false)

      const targetComposingEvt = {
        key: '，',
        code: 'Comma',
        ctrlKey: true,
        target: { tagName: 'INPUT', composing: true },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      }
      expect(dispatchKeyEvent(targetComposingEvt)).toBe(false)
      expect(targetComposingEvt.preventDefault).not.toHaveBeenCalled()

      // 4. [边界] Shift 修饰（Ctrl+Shift+,）与国际键盘（法文 AZERTY code=Comma 输出 ';'）不误判为 Ctrl+,
      expect(normalizeEventKeyCombo({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+<')
      expect(normalizeEventKeyCombo({ key: ';', code: 'Comma', ctrlKey: true })).toBe('Ctrl+;')
      expect(normalizeEventKeyCombo(null)).toBe('')
      expect(normalizeEventKeyCombo(undefined)).toBe('')
      expect(openSettingsHandler).toHaveBeenCalledTimes(3)
    })

    it('[打开设置单一信源与中文输入法字母键兼容] OPEN_SETTINGS_SHORTCUT 为 Ctrl+I，非组字 IME 229/KeyI 命中 Ctrl+I，组字中与 Ctrl+Shift+I 绝不误触', () => {
      expect(OPEN_SETTINGS_SHORTCUT).toBe('Ctrl+I')

      const openSettingsHandler = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { [OPEN_SETTINGS_SHORTCUT]: openSettingsHandler })

      // 1. 常规 Ctrl+i / Cmd+I
      const normalCtrl = new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, cancelable: true })
      expect(dispatchKeyEvent(normalCtrl)).toBe(true)
      expect(normalCtrl.defaultPrevented).toBe(true)
      expect(openSettingsHandler).toHaveBeenCalledTimes(1)

      const normalMeta = new KeyboardEvent('keydown', { key: 'I', code: 'KeyI', metaKey: true, cancelable: true })
      expect(dispatchKeyEvent(normalMeta)).toBe(true)
      expect(openSettingsHandler).toHaveBeenCalledTimes(2)

      // 2. Windows 中文输入法激活但未组字时上报 keyCode=229 + key='Process'/'Unidentified'/'' + code='KeyI'
      for (const placeholderKey of ['Process', 'Unidentified', '']) {
        const imeLetterEvt = new KeyboardEvent('keydown', {
          key: placeholderKey,
          code: 'KeyI',
          ctrlKey: true,
          isComposing: false,
          cancelable: true
        })
        Object.defineProperty(imeLetterEvt, 'keyCode', { value: 229 })
        expect(isComposingEvent(imeLetterEvt)).toBe(false)
        expect(normalizeEventKeyCombo(imeLetterEvt)).toBe('Ctrl+I')
        expect(dispatchKeyEvent(imeLetterEvt)).toBe(true)
        expect(imeLetterEvt.defaultPrevented).toBe(true)
      }
      expect(openSettingsHandler).toHaveBeenCalledTimes(5)

      // 3. [异常/边界] 正在拼音组字（isComposing: true 或 target.composing: true）或无修饰键 229 时绝不误触
      const activeComposing = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyI',
        ctrlKey: true,
        isComposing: true,
        cancelable: true
      })
      Object.defineProperty(activeComposing, 'keyCode', { value: 229 })
      expect(isComposingEvent(activeComposing)).toBe(true)
      expect(normalizeEventKeyCombo(activeComposing)).toBe('')
      expect(dispatchKeyEvent(activeComposing)).toBe(false)
      expect(activeComposing.defaultPrevented).toBe(false)

      const targetComposingEvt = {
        keyCode: 229,
        key: 'Process',
        code: 'KeyI',
        ctrlKey: true,
        target: { tagName: 'INPUT', composing: true },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      }
      expect(isComposingEvent(targetComposingEvt)).toBe(true)
      expect(dispatchKeyEvent(targetComposingEvt)).toBe(false)
      expect(targetComposingEvt.preventDefault).not.toHaveBeenCalled()

      const bareImeKey = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyI',
        isComposing: false,
        cancelable: true
      })
      Object.defineProperty(bareImeKey, 'keyCode', { value: 229 })
      expect(isComposingEvent(bareImeKey)).toBe(true)
      expect(dispatchKeyEvent(bareImeKey)).toBe(false)

      // 4. [边界] Ctrl+Shift+I（常规与 IME 229）均归一化为 Ctrl+Shift+I，绝不误触 Ctrl+I；非 IME 占位键保留原布局字符
      const ctrlShiftI = new KeyboardEvent('keydown', {
        key: 'I',
        code: 'KeyI',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true
      })
      expect(normalizeEventKeyCombo(ctrlShiftI)).toBe('Ctrl+Shift+I')
      expect(dispatchKeyEvent(ctrlShiftI)).toBe(false)

      const imeCtrlShiftI = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyI',
        ctrlKey: true,
        shiftKey: true,
        isComposing: false,
        cancelable: true
      })
      Object.defineProperty(imeCtrlShiftI, 'keyCode', { value: 229 })
      expect(normalizeEventKeyCombo(imeCtrlShiftI)).toBe('Ctrl+Shift+I')
      expect(dispatchKeyEvent(imeCtrlShiftI)).toBe(false)

      expect(normalizeEventKeyCombo({ key: 'c', code: 'KeyI', ctrlKey: true })).toBe('Ctrl+C')
      expect(openSettingsHandler).toHaveBeenCalledTimes(5)
    })
  })

  describe('输入框光标导航保护、模态弹层阻断与交互子控件识别', () => {
    it('输入框聚焦时 ← / → / Delete / Backspace / Home / End 绝不穿透至 PAGE/GLOBAL 劫持光标或误删插件', () => {
      const pageLeft = vi.fn(() => true)
      const pageDelete = vi.fn(() => true)
      const searchDown = vi.fn(() => true)
      const globalCtrlI = vi.fn(() => true)

      registerKeyHandler(KEYMAP_SCOPES.SEARCH, { ArrowDown: searchDown })
      registerKeyHandler(KEYMAP_SCOPES.PAGE, {
        ArrowLeft: pageLeft,
        ArrowRight: pageLeft,
        Delete: pageDelete,
        Home: pageLeft,
        End: pageLeft
      })
      registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { 'Ctrl+I': globalCtrlI })

      const input = document.createElement('input')
      document.body.appendChild(input)
      try {
        for (const key of ['ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', 'Home', 'End', 'a']) {
          const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          Object.defineProperty(ev, 'target', { value: input })
          expect(isInputProtectedKey(ev)).toBe(true)
          expect(dispatchKeyEvent(ev)).toBe(false)
          expect(ev.defaultPrevented).toBe(false)
        }
        expect(pageLeft).not.toHaveBeenCalled()
        expect(pageDelete).not.toHaveBeenCalled()

        // SEARCH 作用域的 ArrowDown 与带修饰键的 Ctrl+I 仍照常生效
        const downEv = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        Object.defineProperty(downEv, 'target', { value: input })
        expect(dispatchKeyEvent(downEv)).toBe(true)
        expect(searchDown).toHaveBeenCalledTimes(1)

        const ctrlIEv = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true })
        Object.defineProperty(ctrlIEv, 'target', { value: input })
        expect(dispatchKeyEvent(ctrlIEv)).toBe(true)
        expect(globalCtrlI).toHaveBeenCalledTimes(1)
      } finally {
        input.remove()
      }
    })

    it('ACTION_PANEL 开启 modal: true 时，未命中的按键既不 preventDefault 也不穿透到下层作用域', () => {
      const pageDown = vi.fn(() => true)
      const globalOpenSettings = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.PAGE, { ArrowDown: pageDown })
      registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { 'Ctrl+I': globalOpenSettings })

      const unregisterModal = registerKeyHandler(
        KEYMAP_SCOPES.ACTION_PANEL,
        {
          ArrowDown: () => true
        },
        { modal: true }
      )

      // 命中的 ArrowDown 由模态层消费
      const downEv = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
      expect(dispatchKeyEvent(downEv)).toBe(true)
      expect(pageDown).not.toHaveBeenCalled()

      // 未命中的 Ctrl+I 与单字符输入被 modal 阻断向 PAGE/GLOBAL 穿透，同时不 preventDefault 保证面板搜索框能打字
      const ctrlIEv = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, cancelable: true })
      expect(dispatchKeyEvent(ctrlIEv)).toBe(false)
      expect(ctrlIEv.defaultPrevented).toBe(false)
      expect(globalOpenSettings).not.toHaveBeenCalled()

      const charEv = new KeyboardEvent('keydown', { key: 'x', cancelable: true })
      expect(dispatchKeyEvent(charEv)).toBe(false)
      expect(charEv.defaultPrevented).toBe(false)

      // 关闭模态层后恢复下层响应
      unregisterModal.deactivate()
      expect(dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, cancelable: true }))).toBe(true)
      expect(globalOpenSettings).toHaveBeenCalledTimes(1)
    })

    it('isInteractiveControlTarget 准确识别按钮/复选框/单选胶囊并排除根容器与输入框', () => {
      const root = document.createElement('div')
      root.setAttribute('role', 'button')
      const childBtn = document.createElement('button')
      const spanInBtn = document.createElement('span')
      childBtn.appendChild(spanInBtn)
      const checkboxDiv = document.createElement('div')
      checkboxDiv.setAttribute('role', 'checkbox')
      const input = document.createElement('input')
      root.append(childBtn, checkboxDiv, input)

      expect(isInteractiveControlTarget(null, root)).toBe(false)
      expect(isInteractiveControlTarget(root, root)).toBe(false)
      expect(isInteractiveControlTarget(input, root)).toBe(false)
      expect(isInteractiveControlTarget(childBtn, root)).toBe(true)
      expect(isInteractiveControlTarget(spanInBtn, root)).toBe(true)
      expect(isInteractiveControlTarget(checkboxDiv, root)).toBe(true)
    })
  })
})
