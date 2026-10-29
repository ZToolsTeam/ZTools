import assert from 'node:assert/strict'
import test from 'node:test'
import { macosViewMenuItems } from '../../src/main/platform/macos/application-menu.js'

const roles = (items: ReturnType<typeof macosViewMenuItems>) => items.map(item => item.role ?? item.type)

test('正式版显示菜单不含重新载入，⌘R / ⌘⇧R 留给插件刷新动作', () => {
  const packaged = roles(macosViewMenuItems(true))
  for (const role of ['reload', 'forceReload', 'toggleDevTools']) assert.ok(!packaged.includes(role as never), role)
  assert.deepEqual(packaged, ['resetZoom', 'zoomIn', 'zoomOut', 'separator', 'togglefullscreen'])
})

test('开发版保留重新载入与开发者工具', () => {
  const development = roles(macosViewMenuItems(false))
  assert.deepEqual(development.slice(0, 3), ['reload', 'forceReload', 'toggleDevTools'])
  assert.ok(development.includes('togglefullscreen'))
})
