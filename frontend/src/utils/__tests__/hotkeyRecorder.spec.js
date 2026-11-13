import { describe, expect, it, vi } from 'vitest'

import {
  HOTKEY_UNSUPPORTED_TEXT,
  formatHotkeyForPlatform,
  getHotkeyHostCapabilities,
  getHotkeyRuleDescription,
  parseSupportedHotkeyEvent,
  resetHotkeyRecorderState
} from '../hotkeyRecorder'

const createEvent = ({
  key,
  code,
  ctrlKey = false,
  altKey = false,
  shiftKey = false,
  metaKey = false,
  repeat = false,
  timeStamp = 1000
}) => ({
  key,
  code,
  ctrlKey,
  altKey,
  shiftKey,
  metaKey,
  repeat,
  timeStamp
})

describe('parseSupportedHotkeyEvent', () => {
  it('accepts Ctrl/Alt/Shift with A-Z keys', () => {
    expect(
      parseSupportedHotkeyEvent(createEvent({ key: 'z', ctrlKey: true, shiftKey: true }))
    ).toEqual({
      status: 'valid',
      hotkey: 'Ctrl+Shift+Z',
      text: 'Ctrl+Shift+Z'
    })

    expect(parseSupportedHotkeyEvent(createEvent({ key: 'A', altKey: true }))).toEqual({
      status: 'valid',
      hotkey: 'Alt+A',
      text: 'Alt+A'
    })
  })

  it('accepts function keys with or without modifiers', () => {
    expect(parseSupportedHotkeyEvent(createEvent({ key: 'F1' }))).toEqual({
      status: 'valid',
      hotkey: 'F1',
      text: 'F1'
    })

    expect(parseSupportedHotkeyEvent(createEvent({ key: 'F12', ctrlKey: true }))).toEqual({
      status: 'valid',
      hotkey: 'Ctrl+F12',
      text: 'Ctrl+F12'
    })
  })

  it('accepts Space as a modifier-combination main key', () => {
    expect(parseSupportedHotkeyEvent(createEvent({ key: ' ', ctrlKey: true }))).toEqual({
      status: 'valid',
      hotkey: 'Ctrl+Space',
      text: 'Ctrl+Space'
    })

    expect(parseSupportedHotkeyEvent(createEvent({ key: 'Space', altKey: true }))).toEqual({
      status: 'valid',
      hotkey: 'Alt+Space',
      text: 'Alt+Space'
    })

    expect(parseSupportedHotkeyEvent(createEvent({ key: 'Spacebar', shiftKey: true }))).toEqual({
      status: 'valid',
      hotkey: 'Shift+Space',
      text: 'Shift+Space'
    })

    // Windows 中文输入法 (IME) 下按 Ctrl+Space 产生 key='Process' (keyCode=229) 但 code='Space'
    expect(
      parseSupportedHotkeyEvent(createEvent({ key: 'Process', code: 'Space', ctrlKey: true }))
    ).toEqual({
      status: 'valid',
      hotkey: 'Ctrl+Space',
      text: 'Ctrl+Space'
    })

    expect(
      parseSupportedHotkeyEvent(createEvent({ key: '\u00a0', code: 'Space', altKey: true }))
    ).toEqual({
      status: 'valid',
      hotkey: 'Alt+Space',
      text: 'Alt+Space'
    })

    expect(
      parseSupportedHotkeyEvent(createEvent({ key: '\u3000', code: 'Space', shiftKey: true }))
    ).toEqual({
      status: 'valid',
      hotkey: 'Shift+Space',
      text: 'Shift+Space'
    })
  })

  it.each([
    ['`', false, 'Alt+`'],
    ['~', true, 'Alt+Shift+~']
  ])('Windows 录入 Alt 与 %s 键时保留实际修饰键', (key, shiftKey, hotkey) => {
    expect(
      parseSupportedHotkeyEvent(createEvent({ key, code: 'Backquote', altKey: true, shiftKey }))
    ).toEqual({ status: 'valid', hotkey, text: hotkey })
  })

  it.each([
    [false, 'Alt+`', '⌥+`'],
    [true, 'Alt+Shift+~', '⌥+⇧+~']
  ])('macOS Option 与反引号死键组合可录入（Shift=%s）', (shiftKey, hotkey, text) => {
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Dead', code: 'Backquote', altKey: true, shiftKey }),
        { platform: 'macos' }
      )
    ).toEqual({ status: 'valid', hotkey, text })
  })

  it.each([
    ['~', 'KeyN', true, 'Alt+Shift+N', '⌥+⇧+N'],
    ['~', 'KeyM', false, 'Alt+M', '⌥+M'],
    ['~', 'KeyX', false, 'Alt+X', '⌥+X'],
    ['`', 'KeyB', true, 'Alt+Shift+B', '⌥+⇧+B'],
    ['`', 'Backquote', true, 'Alt+Shift+`', '⌥+⇧+`'],
    ['~', 'Backquote', true, 'Alt+Shift+~', '⌥+⇧+~']
  ])('macOS Option 生成 %s 时按物理键 %s 录入', (key, code, shiftKey, hotkey, text) => {
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key, code, altKey: true, shiftKey }),
        { platform: 'macos' }
      )
    ).toEqual({ status: 'valid', hotkey, text })
  })

  it('反引号和波浪号不能作为无修饰键的全局快捷键', () => {
    for (const key of ['`', '~']) {
      expect(parseSupportedHotkeyEvent(createEvent({ key, code: 'Backquote' }))).toEqual({
        status: 'invalid',
        text: HOTKEY_UNSUPPORTED_TEXT
      })
    }
    expect(
      parseSupportedHotkeyEvent(createEvent({ key: 'Dead', code: 'Quote', altKey: true }), { platform: 'macos' }).status
    ).toBe('invalid')
  })

  it('keeps waiting when only a supported modifier key is pressed', () => {
    expect(parseSupportedHotkeyEvent(createEvent({ key: 'Control', ctrlKey: true }))).toEqual({
      status: 'pending',
      text: 'Ctrl+...'
    })
  })

  it('accepts double-tapped modifier keys', () => {
    resetHotkeyRecorderState()

    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Control', ctrlKey: true, timeStamp: 1000 }),
        { platform: 'windows', allowDoubleTap: true }
      )
    ).toEqual({
      status: 'pending',
      text: 'Ctrl+...'
    })
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Control', ctrlKey: true, timeStamp: 1250 }),
        { platform: 'windows', allowDoubleTap: true }
      )
    ).toEqual({
      status: 'valid',
      hotkey: 'DoubleCtrl',
      text: '双击 Ctrl'
    })

    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Alt', altKey: true, timeStamp: 2000 }),
        { platform: 'windows', allowDoubleTap: true }
      )
    ).toEqual({ status: 'pending', text: 'Alt+...' })
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Alt', altKey: true, timeStamp: 2300 }),
        { platform: 'windows', allowDoubleTap: true }
      )
    ).toEqual({ status: 'valid', hotkey: 'DoubleAlt', text: '双击 Alt' })
  })

  it('rejects unsupported main keys and Meta combinations', () => {
    const unsupported = [
      createEvent({ key: '1', ctrlKey: true }),
      createEvent({ key: ' ' }),
      createEvent({ key: 'F25', ctrlKey: true }),
      createEvent({ key: 'ArrowUp', altKey: true }),
      createEvent({ key: 'z', metaKey: true }),
      createEvent({ key: 'z', ctrlKey: true, metaKey: true })
    ]

    for (const event of unsupported) {
      expect(parseSupportedHotkeyEvent(event)).toEqual({
        status: 'invalid',
        text: HOTKEY_UNSUPPORTED_TEXT
      })
    }
  })

  it('records macOS Command as the portable Ctrl modifier and displays Apple symbols', () => {
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'z', metaKey: true, shiftKey: true }),
        { platform: 'macos' }
      )
    ).toEqual({
      status: 'valid',
      hotkey: 'Ctrl+Shift+Z',
      text: '⌘+⇧+Z'
    })

    expect(formatHotkeyForPlatform('Ctrl+Control+Alt+Shift+Z', 'macos')).toBe('⌘+⌃+⌥+⇧+Z')
    expect(formatHotkeyForPlatform('Ctrl+Shift+Z', 'windows')).toBe('Ctrl+Shift+Z')
  })

  it('keeps macOS Control physical and does not accept unsupported double-tap modifiers', () => {
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'k', ctrlKey: true, metaKey: true, altKey: true }),
        { platform: 'macos' }
      )
    ).toEqual({
      status: 'valid',
      hotkey: 'Ctrl+Control+Alt+K',
      text: '⌘+⌃+⌥+K'
    })

    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Meta', metaKey: true }),
        { platform: 'macos' }
      )
    ).toEqual({ status: 'pending', text: '⌘+...' })

    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Control', ctrlKey: true, timeStamp: 1000 }),
        { platform: 'macos' }
      )
    ).toEqual({ status: 'pending', text: '⌃+...' })
  })

  it('records an Option-produced macOS glyph using its physical letter key', () => {
    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'π', code: 'KeyP', altKey: true }),
        { platform: 'macos' }
      )
    ).toEqual({
      status: 'valid',
      hotkey: 'Alt+P',
      text: '⌥+P'
    })

    expect(
      parseSupportedHotkeyEvent(
        createEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true, metaKey: true, repeat: true }),
        { platform: 'macos' }
      )
    ).toEqual({ status: 'pending', text: '⌘+⇧+...' })
  })

  it('fails closed for double-tap recording without an explicit supported capability', () => {
    resetHotkeyRecorderState()
    const firstTap = parseSupportedHotkeyEvent(
      createEvent({ key: 'Control', ctrlKey: true, timeStamp: 1000 }),
      { platform: 'windows' }
    )
    const secondTap = parseSupportedHotkeyEvent(
      createEvent({ key: 'Control', ctrlKey: true, timeStamp: 1200 }),
      { platform: 'windows' }
    )

    expect(firstTap.status).toBe('pending')
    expect(secondTap.status).toBe('pending')
    expect(getHotkeyRuleDescription('windows')).toContain('当前宿主不支持双击')
    expect(formatHotkeyForPlatform('DoubleCtrl', 'macos')).toBe(
      'DoubleCtrl（当前宿主不支持）'
    )
  })
})

describe('getHotkeyHostCapabilities', () => {
  it('identifies the Electron host and disables legacy double modifier shortcuts', async () => {
    const previousZtools = window.ztools
    try {
      window.ztools = {
        sys: { getInfo: vi.fn().mockResolvedValue({ platform: 'windows' }) },
        isElectron: () => false
      }
      await expect(getHotkeyHostCapabilities()).resolves.toMatchObject({
        platform: 'windows',
        hostEnvironment: 'unknown',
        supportsDoubleModifierHotkeys: false
      })

      window.ztools.isElectron = () => true
      await expect(getHotkeyHostCapabilities()).resolves.toMatchObject({
        platform: 'windows',
        hostEnvironment: 'electron',
        supportsDoubleModifierHotkeys: false
      })
    } finally {
      window.ztools = previousZtools
    }
  })
})

describe('notifyHotkeyRecorderActive 真实 Events 与主进程 IPC 契约', () => {
  it('通过真实 Events 实例产出的 event_publish 信封通过主进程 validateMethodParams 契约校验', async () => {
    const previousZtools = window.ztools
    const previousElectron = window.__ztoolsElectron
    try {
      const [{ default: Events }, { validateMethodParams }, {
        dispatchSyntheticRecorderHotkey,
        notifyHotkeyRecorderActive
      }] = await Promise.all([
        import('../../../public/js/cef-ipc/src/core/events.js'),
        import('../../../../electron-client/src/contracts/method-params.ts'),
        import('../hotkeyRecorder')
      ])

      const transportCalls = []
      const transport = {
        _debug: false,
        call: vi.fn(async (method, params) => {
          // 模拟 Electron IPC 结构化克隆后进入主进程参数校验器
          const clonedParams = structuredClone(params)
          validateMethodParams(method, clonedParams)
          transportCalls.push({ method, params: clonedParams })
          return { success: true, delivered: 0 }
        })
      }

      window.ztools = { events: new Events(transport) }

      notifyHotkeyRecorderActive(true)
      notifyHotkeyRecorderActive(false)
      await Promise.resolve()

      expect(transportCalls).toHaveLength(2)
      expect(transportCalls[0].method).toBe('event_publish')
      expect(transportCalls[0].params.envelope).toMatchObject({
        version: 'v1',
        type: 'hotkey_recorder_active',
        scope: 'system',
        source: { kind: 'page' },
        target: { broadcast: true },
        payload: { active: true }
      })
      expect(transportCalls[1].params.envelope).toMatchObject({
        type: 'hotkey_recorder_active',
        payload: { active: false }
      })

      // 验证降级直调 __ztoolsElectron.transport.methods.event_publish 分支同样满足契约
      const rawCalls = []
      window.ztools = undefined
      window.__ztoolsElectron = {
        transport: {
          methods: {
            event_publish: vi.fn(async (params) => {
              const clonedParams = structuredClone(params)
              validateMethodParams('event_publish', clonedParams)
              rawCalls.push(clonedParams)
              return { success: true, delivered: 0 }
            })
          }
        }
      }
      notifyHotkeyRecorderActive(true)
      await Promise.resolve()
      expect(rawCalls).toHaveLength(1)
      expect(rawCalls[0].envelope).toMatchObject({
        version: 'v1',
        type: 'hotkey_recorder_active',
        scope: 'system',
        source: { kind: 'page' },
        target: { broadcast: true },
        payload: { active: true }
      })

      const container = document.createElement('div')
      container.className = 'hotkey-recorder recording'
      const input = document.createElement('input')
      input.className = 'hotkey-hidden-input'
      container.appendChild(input)
      document.body.appendChild(container)
      let capturedResult = null
      input.addEventListener('keydown', (e) => {
        capturedResult = parseSupportedHotkeyEvent(e, { platform: 'windows' })
      })
      document.body.focus()
      expect(dispatchSyntheticRecorderHotkey({ key: ' ', code: 'Space', altKey: true })).toBe(true)
      expect(capturedResult).toEqual({ status: 'valid', hotkey: 'Alt+Space', text: 'Alt+Space' })
      container.remove()
    } finally {
      window.ztools = previousZtools
      window.__ztoolsElectron = previousElectron
    }
  })
})
