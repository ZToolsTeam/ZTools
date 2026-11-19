import assert from 'node:assert/strict'
import test from 'node:test'
import {
  macosAppSubmenuItems,
  macosViewMenuItems,
  type MacosApplicationMenuOptions
} from '../../src/main/platform/macos/application-menu.js'

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

test('macosAppSubmenuItems 在传入 onOpenPreferences 时包含 Command+, 偏好设置项并触发回调', () => {
  let openPreferencesCount = 0
  const items = macosAppSubmenuItems({
    onOpenPreferences: () => {
      openPreferencesCount += 1
    }
  })

  const prefItem = items.find(item => item.label === '偏好设置...')
  assert.ok(prefItem, '应包含“偏好设置...”菜单项')
  assert.equal(prefItem.accelerator, 'Command+,')
  assert.equal(typeof prefItem.click, 'function')

  prefItem.click?.({} as never, undefined, {} as never)
  prefItem.click?.({} as never, undefined, {} as never)
  assert.equal(openPreferencesCount, 2)

  assert.deepEqual(
    items.map(item => item.label ?? item.role ?? item.type),
    [
      'about',
      'separator',
      '偏好设置...',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit'
    ]
  )
})

test('macosAppSubmenuItems 在未传或传入无效 onOpenPreferences 时不包含偏好设置项且无多余分隔线', () => {
  const expectedRoles = [
    'about',
    'separator',
    'services',
    'separator',
    'hide',
    'hideOthers',
    'unhide',
    'separator',
    'quit'
  ]

  for (const options of [
    undefined,
    {},
    { onOpenPreferences: null } as unknown as MacosApplicationMenuOptions,
    { onOpenPreferences: 'invalid' } as unknown as MacosApplicationMenuOptions
  ]) {
    const items = options === undefined ? macosAppSubmenuItems() : macosAppSubmenuItems(options)
    assert.equal(items.some(item => item.label === '偏好设置...'), false)
    assert.deepEqual(items.map(item => item.label ?? item.role ?? item.type), expectedRoles)
  }
})
