import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SUPER_PANEL_CONFIG,
  decodeSuperPanelConfig,
  panelDimensions,
  parseSuperPanelConfig
} from '../../src/main/super-panel/config.js'

test('normalizes the legacy super panel configuration', () => {
  const config = parseSuperPanelConfig({
    enabled: true,
    keyboardHotkey: { enabled: true, modifiers: ['ctrl', 'Alt', 'CTRL'], key: 'X' },
    mouseHotkey: { enabled: true, button: 'forward_press', longPressMs: 275 },
    panelPosition: 'cursor',
    panelSize: 'large',
    defaultTab: 'all',
    maxRecentCount: 20,
    shortcuts: [
      { prefix: '/br', pluginId: 'batch-rename' },
      { prefix: '/BR', pluginId: 'duplicate' },
      { prefix: '/', pluginId: '../bad' }
    ],
    pinnedLocalApps: [
      'localapp:1234ABCD',
      'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
      '../bad',
      'localapp:1234ABCD'
    ]
  })
  assert.equal(config.keyboard.accelerator, 'Ctrl+Alt+X')
  assert.deepEqual(config.mouse.trigger, { button: 'forward', action: 'press', longPressMs: 275 })
  assert.equal(config.position, 'cursor')
  assert.deepEqual(panelDimensions(config.size), { width: 800, height: 600 })
  assert.deepEqual(config.shortcuts, [{ prefix: '/br', pluginId: 'batch-rename' }])
  assert.deepEqual(config.pinnedLocalApps, [
    'localapp:1234ABCD',
    'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'
  ])
})

test('preserves physical Control separately from portable Ctrl accelerators', () => {
  const physicalControl = parseSuperPanelConfig({
    keyboardHotkey: { enabled: true, modifiers: ['Control'], key: 'K' }
  })
  const portableCommand = parseSuperPanelConfig({
    keyboardHotkey: { enabled: true, modifiers: ['Ctrl'], key: 'K' }
  })
  const lowercaseControlAlias = parseSuperPanelConfig({
    keyboardHotkey: { enabled: true, modifiers: ['control'], key: 'K' }
  })
  assert.equal(physicalControl.keyboard.accelerator, 'Control+K')
  assert.equal(portableCommand.keyboard.accelerator, 'Ctrl+K')
  assert.equal(lowercaseControlAlias.keyboard.accelerator, 'Control+K')
})

test('falls back safely for damaged or out-of-range configuration', () => {
  const config = decodeSuperPanelConfig('{broken')
  assert.equal(config.enabled, true)
  // Alt+Space 留给全局唤醒，超级面板默认改为 Alt+Shift+Space
  assert.equal(config.keyboard.accelerator, 'Alt+Shift+Space')
  assert.deepEqual(config.mouse.trigger, { button: 'middle', action: 'long', longPressMs: 300 })
  assert.deepEqual(panelDimensions('medium'), { width: 400, height: 600 })
  assert.deepEqual(panelDimensions('small'), { width: 400, height: 300 })
})

test('超级面板默认快捷键与全局唤醒默认值不同；只缺修饰键时也按新默认补齐', () => {
  assert.equal(DEFAULT_SUPER_PANEL_CONFIG.keyboard.accelerator, 'Alt+Shift+Space')
  assert.equal(decodeSuperPanelConfig('{}').keyboard.accelerator, 'Alt+Shift+Space')
  assert.equal(decodeSuperPanelConfig(JSON.stringify({ keyboardHotkey: { enabled: true, key: 'Space' } })).keyboard.accelerator, 'Alt+Shift+Space')
  // 用户明确保存的组合键原样保留
  assert.equal(decodeSuperPanelConfig(JSON.stringify({ keyboardHotkey: { enabled: true, modifiers: ['Alt'], key: 'Space' } })).keyboard.accelerator, 'Alt+Space')
})
