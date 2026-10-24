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
