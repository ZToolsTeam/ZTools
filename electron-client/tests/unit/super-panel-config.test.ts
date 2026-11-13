import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeSuperPanelConfig,
  parseSuperPanelConfig
} from '../../src/main/super-panel/config.js'

test('只解析 pinnedLocalApps：过滤非法 ID 并去重，忽略旧超级面板字段', () => {
  const config = parseSuperPanelConfig({
    enabled: true,
    keyboardHotkey: { enabled: true, modifiers: ['ctrl', 'Alt'], key: 'X' },
    mouseHotkey: { enabled: true, button: 'forward_press', longPressMs: 275 },
    panelPosition: 'cursor',
    panelSize: 'large',
    shortcuts: [{ prefix: '/br', pluginId: 'batch-rename' }],
    pinnedLocalApps: [
      'localapp:1234ABCD',
      'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
      '../bad',
      42,
      'localapp:1234ABCD'
    ]
  })
  // 旧字段（热键、位置、尺寸、快捷前缀）不再出现在解析结果中
  assert.deepEqual(config, {
    pinnedLocalApps: [
      'localapp:1234ABCD',
      'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'
    ]
  })
})

test('pinnedLocalApps 缺失、类型错误或配置损坏时安全回退为空数组', () => {
  assert.deepEqual(parseSuperPanelConfig(undefined), { pinnedLocalApps: [] })
  assert.deepEqual(parseSuperPanelConfig([]), { pinnedLocalApps: [] })
  assert.deepEqual(parseSuperPanelConfig({ pinnedLocalApps: 'localapp:1234ABCD' }), { pinnedLocalApps: [] })
  assert.deepEqual(decodeSuperPanelConfig('{broken'), { pinnedLocalApps: [] })
  assert.deepEqual(decodeSuperPanelConfig('{}'), { pinnedLocalApps: [] })
  assert.deepEqual(
    decodeSuperPanelConfig(JSON.stringify({ pinnedLocalApps: ['localapp:abcd1234'] })),
    { pinnedLocalApps: ['localapp:abcd1234'] }
  )
})

test('pinnedLocalApps 最多保留 1000 条', () => {
  const ids = Array.from({ length: 1200 }, (_, index) =>
    `localapp:${index.toString(16).toUpperCase().padStart(8, '0')}`
  )
  const config = parseSuperPanelConfig({ pinnedLocalApps: ids })
  assert.equal(config.pinnedLocalApps.length, 1000)
  assert.equal(config.pinnedLocalApps[0], ids[0])
  assert.equal(config.pinnedLocalApps[999], ids[999])
})
