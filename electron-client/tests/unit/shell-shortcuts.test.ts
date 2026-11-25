import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EDITABLE_SHELL_SHORTCUT_IDS,
  parseShellShortcutsOverrides,
  resolveOpenSettingsShortcut,
  SHELL_SHORTCUTS,
  toMenuAccelerator
} from '../../src/contracts/hotkey-rules.js'

test('EDITABLE_SHELL_SHORTCUT_IDS 精确包含 5 个可编辑常用快捷键且已冻结（不含已移除的 toggle-mode）', () => {
  assert.equal(Object.isFrozen(EDITABLE_SHELL_SHORTCUT_IDS), true)
  assert.deepEqual([...EDITABLE_SHELL_SHORTCUT_IDS], [
    'focus-search',
    'action-panel',
    'toggle-sidebar',
    'popout-window',
    'open-settings'
  ])
})

test('parseShellShortcutsOverrides 安全解析 JSON 字符串与对象并防御异常输入和原型污染', () => {
  // 合法 JSON 字符串：保留自定义值、trim 空白以及显式清空 ""；已移除的 toggle-mode 被安全忽略
  assert.deepEqual(
    parseShellShortcutsOverrides('{"focus-search":"  Ctrl+J  ","open-settings":"","toggle-mode":"Ctrl+U"}'),
    {
      'focus-search': 'Ctrl+J',
      'open-settings': ''
    }
  )

  // 合法普通对象
  assert.deepEqual(
    parseShellShortcutsOverrides({
      'action-panel': 'Ctrl+Shift+K',
      'toggle-sidebar': 'Alt+B',
      'popout-window': ''
    }),
    {
      'action-panel': 'Ctrl+Shift+K',
      'toggle-sidebar': 'Alt+B',
      'popout-window': ''
    }
  )

  // 非白名单键、原型污染键、非字符串值、控制字符与超长值均被安全忽略
  const maliciousJson = JSON.stringify({
    '__proto__': { polluted: true },
    constructor: 'Ctrl+X',
    prototype: 'Ctrl+Y',
    'pin-item': 'Ctrl+P',
    'unknown-id': 'Ctrl+Q',
    'focus-search': 12345,
    'action-panel': 'Ctrl+K\nInjected',
    'toggle-mode': 'Ctrl+\0U',
    'toggle-sidebar': 'Ctrl+\tB',
    'popout-window': 'A'.repeat(65),
    'open-settings': 'Ctrl+Shift+,'
  })
  const parsed = parseShellShortcutsOverrides(maliciousJson)
  assert.deepEqual(parsed, { 'open-settings': 'Ctrl+Shift+,' })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)

  // 各种空值 / 非对象 / 损坏 JSON 返回空对象
  for (const invalid of [undefined, null, '', '   ', '{invalid', '[]', '123', '"str"', [], 42, true]) {
    assert.deepEqual(parseShellShortcutsOverrides(invalid), {})
  }
})

test('resolveOpenSettingsShortcut 正确区分未覆盖、自定义与显式清空', () => {
  assert.equal(resolveOpenSettingsShortcut(undefined), SHELL_SHORTCUTS.OPEN_SETTINGS)
  assert.equal(resolveOpenSettingsShortcut(''), SHELL_SHORTCUTS.OPEN_SETTINGS)
  assert.equal(resolveOpenSettingsShortcut('{}'), SHELL_SHORTCUTS.OPEN_SETTINGS)
  assert.equal(resolveOpenSettingsShortcut('{"focus-search":"Ctrl+J"}'), SHELL_SHORTCUTS.OPEN_SETTINGS)
  assert.equal(resolveOpenSettingsShortcut('{broken-json'), SHELL_SHORTCUTS.OPEN_SETTINGS)

  // 显式清空必须返回 "" 而非回退默认值
  assert.equal(resolveOpenSettingsShortcut('{"open-settings":""}'), '')
  assert.equal(resolveOpenSettingsShortcut({ 'open-settings': '   ' }), '')

  // 自定义快捷键返回规范 trim 后的值
  assert.equal(resolveOpenSettingsShortcut('{"open-settings":" Ctrl+Shift+, "}'), 'Ctrl+Shift+,')
})

test('toMenuAccelerator 跨平台规范化并拦截空串、双击修饰键与非法控制字符', () => {
  // darwin: Ctrl / CommandOrControl / CmdOrCtrl / Cmd -> Command，保持物理 Control
  assert.equal(toMenuAccelerator('Ctrl+,', 'darwin'), 'Command+,')
  assert.equal(toMenuAccelerator('CommandOrControl+Shift+,', 'darwin'), 'Command+Shift+,')
  assert.equal(toMenuAccelerator('CmdOrCtrl+J', 'darwin'), 'Command+J')
  assert.equal(toMenuAccelerator('Cmd+K', 'darwin'), 'Command+K')
  assert.equal(toMenuAccelerator('Control+,', 'darwin'), 'Control+,')
  assert.equal(toMenuAccelerator('Control+Shift+P', 'darwin'), 'Control+Shift+P')

  // win32 / linux: 保留 Ctrl，规范 CommandOrControl / CmdOrCtrl
  assert.equal(toMenuAccelerator('Ctrl+,', 'win32'), 'Ctrl+,')
  assert.equal(toMenuAccelerator('ctrl+shift+,', 'win32'), 'Ctrl+shift+,')
  assert.equal(toMenuAccelerator('CmdOrCtrl+J', 'win32'), 'CommandOrControl+J')
  assert.equal(toMenuAccelerator('CommandOrControl+K', 'linux'), 'CommandOrControl+K')

  // 空串、双击修饰键、控制字符、超长均返回 undefined
  for (const rejected of [
    '',
    '   ',
    'DoubleCtrl',
    'DoubleControl',
    'DoubleAlt',
    'DoubleShift',
    'Ctrl+,\nBad',
    'Ctrl+\rK',
    'Ctrl+\0J',
    'Ctrl+\tL',
    'A'.repeat(65)
  ]) {
    assert.equal(toMenuAccelerator(rejected, 'darwin'), undefined, `darwin should reject ${JSON.stringify(rejected)}`)
    assert.equal(toMenuAccelerator(rejected, 'win32'), undefined, `win32 should reject ${JSON.stringify(rejected)}`)
  }
})
