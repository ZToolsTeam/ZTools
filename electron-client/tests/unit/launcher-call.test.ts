import assert from 'node:assert/strict'
import test from 'node:test'
import {
  handleLauncherCall,
  normalizeDashboardRoute,
  type LauncherCallTarget
} from '../../src/main/windows/launcher-controller.js'

function createTarget(): LauncherCallTarget & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    hide: () => { calls.push('hide') },
    show: () => { calls.push('show') },
    toggle: () => { calls.push('toggle') },
    showMainWindow: () => { calls.push('showMain') },
    navigateMainWindow: (route) => { calls.push(`navigate:${route}`) }
  }
}

test('悬浮条展开到工作台：可附带目标页面，路由按不可信输入校验', async (t) => {
  await t.test('不带目标页面时只收起悬浮条并显示主窗口', () => {
    const target = createTarget()
    assert.deepEqual(handleLauncherCall(target, 'expand_to_dashboard'), { success: true })
    assert.deepEqual(target.calls, ['hide', 'showMain'])
  })

  await t.test('带合法目标页面时先显示主窗口再跳转', () => {
    const target = createTarget()
    assert.deepEqual(handleLauncherCall(target, 'expand_to_dashboard', { route: '/details/json-format' }), { success: true })
    assert.deepEqual(target.calls, ['hide', 'showMain', 'navigate:/details/json-format'])
    const query = createTarget()
    handleLauncherCall(query, 'expand_to_dashboard', { route: '/list?q=%E8%AE%A1%E7%AE%97' })
    assert.equal(query.calls.at(-1), 'navigate:/list?q=%E8%AE%A1%E7%AE%97')
  })

  await t.test('[破坏性] 畸形或恶意路由一律拒绝，且不改变任何窗口状态', () => {
    const bad: unknown[] = [
      { route: 'https://evil.example/' },
      { route: '//evil.example/x' },
      { route: 'javascript:alert(1)' },
      { route: '/details/<script>' },
      { route: '/a b' },
      { route: '/x\n/y' },
      { route: `/${'a'.repeat(600)}` },
      { route: 42 },
      { route: null },
      {},
      'just-a-string',
      ['/details/x']
    ]
    for (const payload of bad) {
      const target = createTarget()
      const result = handleLauncherCall(target, 'expand_to_dashboard', payload)
      assert.equal(result.success, false, JSON.stringify(payload))
      assert.deepEqual(target.calls, [], JSON.stringify(payload))
    }
  })

  await t.test('主窗口不支持跳转时仍能展开，不抛错', () => {
    const target = createTarget()
    delete target.navigateMainWindow
    assert.deepEqual(handleLauncherCall(target, 'expand_to_dashboard', { route: '/details/x' }), { success: true })
    assert.deepEqual(target.calls, ['hide', 'showMain'])
  })

  await t.test('其余动作保持原有行为，未知动作返回错误', () => {
    for (const action of ['hide', 'show', 'toggle']) {
      const target = createTarget()
      assert.deepEqual(handleLauncherCall(target, action), { success: true })
      assert.deepEqual(target.calls, [action])
    }
    const target = createTarget()
    assert.deepEqual(handleLauncherCall(target, 'rm -rf'), { success: false, error: '未知动作' })
    assert.deepEqual(handleLauncherCall(target, undefined), { success: false, error: '未知动作' })
    assert.deepEqual(target.calls, [])
  })

  await t.test('normalizeDashboardRoute 边界：恰好 512 字符可用，513 拒绝', () => {
    assert.equal(normalizeDashboardRoute(`/${'a'.repeat(511)}`)?.length, 512)
    assert.equal(normalizeDashboardRoute(`/${'a'.repeat(512)}`), null)
    assert.equal(normalizeDashboardRoute('/'), '/')
    assert.equal(normalizeDashboardRoute(''), null)
  })
})
