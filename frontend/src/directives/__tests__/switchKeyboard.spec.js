import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { vSwitchKeyboard } from '../switchKeyboard'

/**
 * 属性测试：Switch 键盘行为修复
 * Feature: 02-26-switch-keyboard-fix
 */

describe('vSwitchKeyboard Directive', () => {
  let element
  let handler

  beforeEach(() => {
    // 创建测试用的 DOM 元素
    element = document.createElement('div')
    document.body.appendChild(element)
  })

  afterEach(() => {
    // 清理 DOM
    if (element && element.parentNode) {
      element.parentNode.removeChild(element)
    }
  })

  describe('Directive Lifecycle', () => {
    it('should register keydown event listener on mount', () => {
      const addEventListenerSpy = vi.spyOn(element, 'addEventListener')

      vSwitchKeyboard.mounted(element)

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function),
        true
      )
      expect(element._switchKeyboardHandler).toBeDefined()

      addEventListenerSpy.mockRestore()
    })

    it('should remove keydown event listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(element, 'removeEventListener')

      vSwitchKeyboard.mounted(element)
      const savedHandler = element._switchKeyboardHandler

      vSwitchKeyboard.unmounted(element)

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        savedHandler,
        true
      )
      expect(element._switchKeyboardHandler).toBeUndefined()

      removeEventListenerSpy.mockRestore()
    })

    it('should handle unmount gracefully when handler is not set', () => {
      const removeEventListenerSpy = vi.spyOn(element, 'removeEventListener')

      // 不调用 mounted，直接调用 unmounted
      vSwitchKeyboard.unmounted(element)

      expect(removeEventListenerSpy).not.toHaveBeenCalled()

      removeEventListenerSpy.mockRestore()
    })
  })

  describe('Property 1: 允许的单键正常通过', () => {
    /**
     * Property 1: 允许的单键正常通过
     *
     * For any 键盘事件，当按键为 Enter 或 Space 且无任何修饰键
     * （altKey、ctrlKey、shiftKey、metaKey 均为 false）时，
     * 事件处理器不应调用 preventDefault 或 stopPropagation。
     *
     * Validates: Requirements 1.1, 1.2
     */

    it('should allow Enter key without modifiers', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      expect(preventDefaultSpy).not.toHaveBeenCalled()
      expect(stopPropagationSpy).not.toHaveBeenCalled()
    })

    it('should allow Space key without modifiers', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: ' ',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      expect(preventDefaultSpy).not.toHaveBeenCalled()
      expect(stopPropagationSpy).not.toHaveBeenCalled()
    })

    it('Property 1: 允许的单键正常通过 - 属性测试', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      // 使用 fast-check 生成允许的按键事件
      fc.assert(
        fc.property(fc.constantFrom('Enter', ' '), (key) => {
          const event = new KeyboardEvent('keydown', {
            key,
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false
          })

          const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
          const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

          handler(event)

          // 验证：允许的按键不应被阻止
          expect(preventDefaultSpy).not.toHaveBeenCalled()
          expect(stopPropagationSpy).not.toHaveBeenCalled()

          preventDefaultSpy.mockRestore()
          stopPropagationSpy.mockRestore()

          return true
        }),
        { numRuns: 100 }
      )
    })
  })

  describe('Property 2: 非允许的按键事件被阻止', () => {
    /**
     * Property 2: 非允许的按键事件被阻止
     *
     * For any 键盘事件，当满足以下任一条件时，
     * 事件处理器应调用 preventDefault 和 stopPropagation：
     * - 存在任意修饰键（altKey、ctrlKey、shiftKey、metaKey 中至少一个为 true）
     * - 按键不是 Enter 且不是 Space（且无修饰键）
     *
     * Validates: Requirements 1.3, 1.4
     */

    it('should block Alt+Space combination', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: ' ',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()
    })

    it('should block Ctrl+Enter combination', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: false,
        ctrlKey: true,
        shiftKey: false,
        metaKey: false
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()
    })

    it('should block Shift+Space combination', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: ' ',
        altKey: false,
        ctrlKey: false,
        shiftKey: true,
        metaKey: false
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()
    })

    it('should block Meta+Enter combination', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: true
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()
    })

    it('should block other single keys without modifiers', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const otherKeys = [
        'a',
        'b',
        'ArrowUp',
        'ArrowDown',
        'Tab',
        'Escape',
        '1',
        '2'
      ]

      otherKeys.forEach((key) => {
        const event = new KeyboardEvent('keydown', {
          key,
          altKey: false,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false
        })

        const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
        const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

        handler(event)

        expect(preventDefaultSpy).toHaveBeenCalled()
        expect(stopPropagationSpy).toHaveBeenCalled()

        preventDefaultSpy.mockRestore()
        stopPropagationSpy.mockRestore()
      })
    })

    it('Property 2: 非允许的按键事件被阻止 - 属性测试（有修饰键）', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      // 使用 fast-check 生成带修饰键的事件
      fc.assert(
        fc.property(
          fc.string(),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          (key, altKey, ctrlKey, shiftKey, metaKey) => {
            // 至少有一个修饰键
            const hasModifier = altKey || ctrlKey || shiftKey || metaKey
            if (!hasModifier) return true

            const event = new KeyboardEvent('keydown', {
              key,
              altKey,
              ctrlKey,
              shiftKey,
              metaKey
            })

            const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
            const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

            handler(event)

            // 验证：有修饰键的事件应被阻止
            expect(preventDefaultSpy).toHaveBeenCalled()
            expect(stopPropagationSpy).toHaveBeenCalled()

            preventDefaultSpy.mockRestore()
            stopPropagationSpy.mockRestore()

            return true
          }
        ),
        { numRuns: 100 }
      )
    })

    it('Property 2: 非允许的按键事件被阻止 - 属性测试（非允许的按键）', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      // 使用 fast-check 生成非 Enter/Space 的按键
      fc.assert(
        fc.property(
          fc.string().filter((key) => key !== 'Enter' && key !== ' '),
          (key) => {
            const event = new KeyboardEvent('keydown', {
              key,
              altKey: false,
              ctrlKey: false,
              shiftKey: false,
              metaKey: false
            })

            const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
            const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

            handler(event)

            // 验证：非允许的按键应被阻止
            expect(preventDefaultSpy).toHaveBeenCalled()
            expect(stopPropagationSpy).toHaveBeenCalled()

            preventDefaultSpy.mockRestore()
            stopPropagationSpy.mockRestore()

            return true
          }
        ),
        { numRuns: 100 }
      )
    })
  })

  describe('Integration Tests', () => {
    it('should not affect mouse click events', () => {
      vSwitchKeyboard.mounted(element)

      const mouseEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true
      })

      const preventDefaultSpy = vi.spyOn(mouseEvent, 'preventDefault')

      // 鼠标事件不会触发 keydown 处理器
      element.dispatchEvent(mouseEvent)

      // 验证：鼠标事件不被阻止
      expect(preventDefaultSpy).not.toHaveBeenCalled()

      preventDefaultSpy.mockRestore()
    })

    it('should handle undefined event.key gracefully', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: undefined,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      // 验证：undefined 按键应被阻止
      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()

      preventDefaultSpy.mockRestore()
      stopPropagationSpy.mockRestore()
    })

    it('should handle multiple modifiers simultaneously', () => {
      vSwitchKeyboard.mounted(element)
      const handler = element._switchKeyboardHandler

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: true,
        ctrlKey: true,
        shiftKey: true,
        metaKey: true
      })

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      handler(event)

      // 验证：多个修饰键应被阻止
      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()

      preventDefaultSpy.mockRestore()
      stopPropagationSpy.mockRestore()
    })
  })
})
