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
import { POPOUT_WINDOW_SHORTCUT } from '../shellShortcuts.js'

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

  it('3. [核心设计键位规范匹配] Enter, Ctrl+Enter, Ctrl+K, Esc, Ctrl+B, Ctrl+F, Ctrl+Shift+P, Alt+Space', () => {
    const triggered = []

    registerKeyHandler(KEYMAP_SCOPES.GLOBAL, {
      'Enter': () => { triggered.push('enter'); return true },
      'Ctrl+Enter': () => { triggered.push('ctrl_enter'); return true },
      'Ctrl+K': () => { triggered.push('ctrl_k'); return true },
      'Escape': () => { triggered.push('esc'); return true },
      'Ctrl+B': () => { triggered.push('ctrl_b'); return true },
      [POPOUT_WINDOW_SHORTCUT]: () => { triggered.push('ctrl_shift_p'); return true },
      'Ctrl+F': () => { triggered.push('ctrl_f'); return true },
      'Alt+Space': () => { triggered.push('alt_space'); return true }
    })

    dispatchKeyEvent({ key: 'Enter' })
    dispatchKeyEvent({ key: 'Enter', ctrlKey: true })
    dispatchKeyEvent({ key: 'k', ctrlKey: true })
    dispatchKeyEvent({ key: 'Escape' })
    dispatchKeyEvent({ key: 'b', ctrlKey: true })
    dispatchKeyEvent({ key: 'p', ctrlKey: true, shiftKey: true })
    dispatchKeyEvent({ key: 'f', ctrlKey: true })
    dispatchKeyEvent({ key: ' ', altKey: true, code: 'Space' })

    expect(triggered).toEqual([
      'enter',
      'ctrl_enter',
      'ctrl_k',
      'esc',
      'ctrl_b',
      'ctrl_shift_p',
      'ctrl_f',
      'alt_space'
    ])

    // 验证 normalizeEventKeyCombo 正确格式化 Space
    expect(normalizeEventKeyCombo({ key: ' ', altKey: true, code: 'Space' })).toBe('Alt+Space')
    expect(normalizeEventKeyCombo({ key: ' ', code: 'Space' })).toBe('Space')
    expect(normalizeEventKeyCombo({ key: ' ', ctrlKey: true, code: 'Space' })).toBe('Ctrl+Space')
  })

  it('3.1 [跨端修饰键归一化矩阵] Windows 与 macOS 分别区分 ⌘/⌃ 与 Win/Ctrl', () => {
    // Windows 下 ctrlKey 映射为 Ctrl，metaKey 保持 Meta
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'win32'
    try {
      expect(normalizeEventKeyCombo({ key: 'u', ctrlKey: true })).toBe('Ctrl+U')
      expect(normalizeEventKeyCombo({ key: 'u', metaKey: true })).toBe('Meta+U')
      expect(normalizeEventKeyCombo({ key: ',', ctrlKey: true })).toBe('Ctrl+,')
      expect(normalizeEventKeyCombo({ key: ',', metaKey: true })).toBe('Meta+,')
      expect(normalizeEventKeyCombo({ key: 'p', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+P')
    } finally {
      delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
    }

    // macOS 下 Command(metaKey) 映射为逻辑 Ctrl，物理 Control(ctrlKey) 保持 Control
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
    try {
      expect(normalizeEventKeyCombo({ key: 'u', metaKey: true })).toBe('Ctrl+U')
      expect(normalizeEventKeyCombo({ key: 'u', ctrlKey: true })).toBe('Control+U')
      expect(normalizeEventKeyCombo({ key: ',', metaKey: true })).toBe('Ctrl+,')
      expect(normalizeEventKeyCombo({ key: ',', ctrlKey: true })).toBe('Control+,')
      expect(normalizeEventKeyCombo({ key: 'p', metaKey: true, shiftKey: true })).toBe('Ctrl+Shift+P')
    } finally {
      delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
    }
  })

  it('4. [Beyond Happy Path 异常容错] 非法输入、空事件、异常隔离与注销幂等', () => {
    // 4.1 空事件分发
    expect(dispatchKeyEvent(null)).toBe(false)
    expect(dispatchKeyEvent(undefined)).toBe(false)

    // 4.2 非法 scope 注册拒绝
    expect(() => registerKeyHandler('invalid_scope', () => {})).toThrow(/Invalid scope/)
    expect(() => registerKeyHandler(KEYMAP_SCOPES.GLOBAL, null)).toThrow(/Handler must be/)

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

      // 1. Windows 常规与中文全角逗号 Ctrl+，
      const fullWidthCtrl = new KeyboardEvent('keydown', { key: '，', code: 'Comma', ctrlKey: true, cancelable: true })
      expect(dispatchKeyEvent(fullWidthCtrl)).toBe(true)
      expect(fullWidthCtrl.defaultPrevented).toBe(true)
      expect(openSettingsHandler).toHaveBeenCalledTimes(1)

      // 2. macOS 下 Command+，命中 Ctrl+,，物理 Control+，保持 Control+, 不误触
      globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
      try {
        const fullWidthMeta = new KeyboardEvent('keydown', { key: '，', metaKey: true, cancelable: true })
        expect(dispatchKeyEvent(fullWidthMeta)).toBe(true)
        expect(openSettingsHandler).toHaveBeenCalledTimes(2)
        const physicalCtrlComma = new KeyboardEvent('keydown', { key: '，', ctrlKey: true, cancelable: true })
        expect(dispatchKeyEvent(physicalCtrlComma)).toBe(false)
      } finally {
        delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
      }

      // 3. Windows 中文输入法未组字态上报 keyCode=229 + key='Process' + code='Comma'
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

      // 4. [异常/边界] 正在拼音组字（isComposing: true 或 target.composing: true）时绝不误触发且不打断输入法
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

      // 5. [边界] Shift 修饰（Ctrl+Shift+,）与国际键盘（法文 AZERTY code=Comma 输出 ';'）不误判为 Ctrl+,
      expect(normalizeEventKeyCombo({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+<')
      expect(normalizeEventKeyCombo({ key: ';', code: 'Comma', ctrlKey: true })).toBe('Ctrl+;')
      expect(normalizeEventKeyCombo(null)).toBe('')
      expect(normalizeEventKeyCombo(undefined)).toBe('')
      expect(openSettingsHandler).toHaveBeenCalledTimes(3)
    })

    it('[打开设置单一信源与中文输入法字母键兼容] OPEN_SETTINGS_SHORTCUT 为 Ctrl+,，非组字 IME 229/KeyU 命中 Ctrl+U，组字中与 Ctrl+Shift+U 绝不误触', () => {
      expect(OPEN_SETTINGS_SHORTCUT).toBe('Ctrl+,')

      const letterShortcutHandler = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { 'Ctrl+U': letterShortcutHandler })

      // 1. 常规 Ctrl+u / macOS Cmd+U
      const normalCtrl = new KeyboardEvent('keydown', { key: 'u', code: 'KeyU', ctrlKey: true, cancelable: true })
      expect(dispatchKeyEvent(normalCtrl)).toBe(true)
      expect(normalCtrl.defaultPrevented).toBe(true)
      expect(letterShortcutHandler).toHaveBeenCalledTimes(1)

      globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
      try {
        const normalMeta = new KeyboardEvent('keydown', { key: 'U', code: 'KeyU', metaKey: true, cancelable: true })
        expect(dispatchKeyEvent(normalMeta)).toBe(true)
        expect(letterShortcutHandler).toHaveBeenCalledTimes(2)
      } finally {
        delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
      }

      // 2. Windows 中文输入法激活但未组字时上报 keyCode=229 + key='Process'/'Unidentified'/'' + code='KeyU'
      for (const placeholderKey of ['Process', 'Unidentified', '']) {
        const imeLetterEvt = new KeyboardEvent('keydown', {
          key: placeholderKey,
          code: 'KeyU',
          ctrlKey: true,
          isComposing: false,
          cancelable: true
        })
        Object.defineProperty(imeLetterEvt, 'keyCode', { value: 229 })
        expect(isComposingEvent(imeLetterEvt)).toBe(false)
        expect(normalizeEventKeyCombo(imeLetterEvt)).toBe('Ctrl+U')
        expect(dispatchKeyEvent(imeLetterEvt)).toBe(true)
        expect(imeLetterEvt.defaultPrevented).toBe(true)
      }
      expect(letterShortcutHandler).toHaveBeenCalledTimes(5)

      // 3. [异常/边界] 正在拼音组字（isComposing: true 或 target.composing: true）或无修饰键 229 时绝不误触
      const activeComposing = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyU',
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
        code: 'KeyU',
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
        code: 'KeyU',
        isComposing: false,
        cancelable: true
      })
      Object.defineProperty(bareImeKey, 'keyCode', { value: 229 })
      expect(isComposingEvent(bareImeKey)).toBe(true)
      expect(dispatchKeyEvent(bareImeKey)).toBe(false)

      // 4. [边界] Ctrl+Shift+U（常规与 IME 229）均归一化为 Ctrl+Shift+U，绝不误触 Ctrl+U；非 IME 占位键保留原布局字符
      const ctrlShiftU = new KeyboardEvent('keydown', {
        key: 'U',
        code: 'KeyU',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true
      })
      expect(normalizeEventKeyCombo(ctrlShiftU)).toBe('Ctrl+Shift+U')
      expect(dispatchKeyEvent(ctrlShiftU)).toBe(false)

      const imeCtrlShiftU = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyU',
        ctrlKey: true,
        shiftKey: true,
        isComposing: false,
        cancelable: true
      })
      Object.defineProperty(imeCtrlShiftU, 'keyCode', { value: 229 })
      expect(normalizeEventKeyCombo(imeCtrlShiftU)).toBe('Ctrl+Shift+U')
      expect(dispatchKeyEvent(imeCtrlShiftU)).toBe(false)

      expect(normalizeEventKeyCombo({ key: 'c', code: 'KeyU', ctrlKey: true })).toBe('Ctrl+C')
      expect(letterShortcutHandler).toHaveBeenCalledTimes(5)
    })

    it('[统一 Esc 先失焦] 普通输入框聚焦时按 Esc 不穿透至 GLOBAL，优先异步失焦；已消费时不强行失焦', async () => {
      const globalEsc = vi.fn(() => true)
      registerKeyHandler(KEYMAP_SCOPES.GLOBAL, { Escape: globalEsc })

      const input = document.createElement('input')
      document.body.appendChild(input)
      try {
        input.focus()
        expect(document.activeElement).toBe(input)

        const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        Object.defineProperty(escEvent, 'target', { value: input })
        expect(dispatchKeyEvent(escEvent)).toBe(false)
        expect(globalEsc).not.toHaveBeenCalled()

        // 微任务后由全局分发器统一失焦
        await Promise.resolve()
        expect(document.activeElement).not.toBe(input)

        // 若页面级已拦截并消费了 Esc，则按原 handler 返回 true，不再下沉也不会误触 global
        const pageEsc = vi.fn(() => true)
        const unregPage = registerKeyHandler(KEYMAP_SCOPES.PAGE, { Escape: pageEsc })
        input.focus()
        const escHandledByPage = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        Object.defineProperty(escHandledByPage, 'target', { value: input })
        expect(dispatchKeyEvent(escHandledByPage)).toBe(true)
        expect(pageEsc).toHaveBeenCalledOnce()
        expect(globalEsc).not.toHaveBeenCalled()
        await Promise.resolve()
        expect(document.activeElement).toBe(input)
        unregPage()
      } finally {
        input.remove()
      }
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
