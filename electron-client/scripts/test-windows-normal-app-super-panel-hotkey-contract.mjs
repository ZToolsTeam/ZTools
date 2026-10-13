import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {
  createSuperPanelHotkeyConfig,
  electronAcceleratorForProbe,
  mainShortcutRegistrationProbe
} from './test-windows-normal-app-super-panel-hotkey.mjs'

test('runner config changes only the keyboard binding and keeps native mouse input disabled', () => {
  const existing = {
    enabled: false,
    panelPosition: 'cursor',
    keyboardHotkey: { enabled: false, modifiers: ['Alt'], key: 'Space', customFlag: 'preserved' },
    mouseHotkey: { enabled: true, button: 'middle_long', longPressMs: 300 },
    shortcuts: [{ prefix: '/', pluginId: 'todo' }]
  }
  const shortcut = { modifiers: ['Ctrl', 'Alt', 'Shift'], key: 'F23' }
  const enabled = createSuperPanelHotkeyConfig(existing, shortcut, true)

  assert.equal(enabled.enabled, true)
  assert.equal(enabled.panelPosition, 'cursor')
  assert.deepEqual(enabled.keyboardHotkey, {
    enabled: true,
    modifiers: ['Ctrl', 'Alt', 'Shift'],
    key: 'F23',
    customFlag: 'preserved'
  })
  assert.deepEqual(enabled.shortcuts, [{ prefix: '/', pluginId: 'todo' }])
  assert.equal(enabled.mouseHotkey.enabled, false)
  assert.equal(existing.enabled, false)
  assert.equal(existing.keyboardHotkey.key, 'Space')
})

test('registration probe uses the Windows portable Ctrl alias and only reads Main globalShortcut state', () => {
  const shortcut = { modifiers: ['Ctrl', 'Alt', 'Shift'], key: 'F23' }
  const accelerator = electronAcceleratorForProbe(shortcut)
  const expression = mainShortcutRegistrationProbe(accelerator)

  assert.equal(accelerator, 'CommandOrControl+Alt+Shift+F23')
  assert.match(expression, /globalShortcut\.isRegistered\(/)
  assert.doesNotMatch(expression, /globalShortcut\.(?:register|unregister)\(/)
  assert.doesNotMatch(expression, /app\.quit\(/)
  assert.doesNotThrow(() => new vm.Script(expression))
})
