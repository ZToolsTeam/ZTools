import test from 'node:test'
import assert from 'node:assert/strict'
import { getAppleShortcuts } from '../dist/examples/wrapped-nudges-shortcuts/engine.js'
import { executeHomebrewAction } from '../dist/examples/homebrew/index.js'
import { fetchScriptCommands } from '../dist/examples/script-commands/index.js'
import { getFocusStats, startFocusSession, controlFocusSession, getFocusCurrentSession, createFocusCategory, listFocusCategories } from '../dist/examples/raycast-focus/index.js'
import { fetchNavigationWindows, searchNavigationMenuItems, describeNavigationFailure } from '../dist/examples/navigation/index.js'
import { performWebSearch, quickOpenUrl } from '../dist/examples/web-searches/index.js'

test('快捷指令空列表保持空，权限错误传播，真实名称原样保留', async () => {
  assert.deepEqual(await getAppleShortcuts({ shortcuts_list: async () => ({ items: [] }) }), [])
  await assert.rejects(getAppleShortcuts({ shortcuts_list: async () => { throw new Error('permission denied') } }), /permission denied/)
  const list = await getAppleShortcuts({ shortcuts_list: async () => ({ items: [{ name: '带 空格的指令' }] }) })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '带 空格的指令')
})

test('Homebrew 宿主 isCask 与版本字段原样映射，空列表不把 JSON 当行解析，搜索无结果不报错', async () => {
  const result = await executeHomebrewAction('list', {}, {
    brew_exec: async () => ({ success: true, items: [{ name: 'example-app', version: '1.0', isCask: true, latestVersion: '2.0', outdated: true }] })
  })
  assert.equal(result.packages[0].type, 'cask')
  assert.equal(result.packages[0].outdated, true)
  assert.deepEqual(
    (await executeHomebrewAction('list', {}, {
      brew_exec: async () => ({ success: true, items: [], stdout: '{\n  "formulae": [],\n  "casks": []\n}' })
    })).packages,
    []
  )
  const emptySearch = await executeHomebrewAction('search', { packageName: 'nonexistent' }, {
    brew_exec: async () => ({ success: false, error: 'Error: No formulae or casks found for "nonexistent".' })
  })
  assert.equal(emptySearch.ok, true)
  assert.deepEqual(emptySearch.packages, [])
  assert.equal((await executeHomebrewAction('list', {}, { brew_exec: async () => ({ success: false, error: 'missing brew' }) })).ok, false)
})

test('脚本刷新兼容路由真实 items 结构，刷新失败抛出错误不清列表', async () => {
  const item = { id: 'sample', title: '示例脚本', filePath: '/tmp/sample.sh' }
  const host = {
    script_commands_list: async () => ({ scripts: [item] }),
    script_commands_reload: async () => ({ success: true, count: 1, items: [item] })
  }
  assert.deepEqual(await fetchScriptCommands(true, host), await fetchScriptCommands(false, host))
  await assert.rejects(
    fetchScriptCommands(true, { script_commands_reload: async () => ({ success: false, error: 'directory unreadable' }) }),
    /directory unreadable/
  )
})

test('专注使用真实毫秒、状态、统计与 title 合同；完成后返回空会话；新建分类保留屏蔽应用与网站', async () => {
  const session = { id: 'session-1', title: '写测试', categoryId: 'cat-code', categoryName: '编程', totalDurationMs: 60000, remainingMs: 42000, status: 'running', startedAt: 100 }
  const host = {
    focus_start: async (input) => { assert.equal(input.title, '写测试'); assert.equal(input.categoryId, 'cat-code'); return session },
    focus_get_current: async () => session,
    focus_get_stats: async () => ({ todayFocusMinutes: 0, totalFocusedMinutes: 45, totalCompletedSessions: 0, currentStreakDays: 0 }),
    focus_pause: async () => ({ success: false, error: 'denied' }),
    focus_create_category: async (input) => ({ id: 'cat-custom', name: input.name, defaultDurationMinutes: input.defaultDurationMinutes }),
    focus_list_categories: async () => ({ categories: [{ id: 'cat-custom', name: '深度写作', defaultDurationMinutes: 40 }] })
  }
  assert.equal((await startFocusSession({ goal: '写测试', categoryId: 'cat-code', durationMinutes: 1 }, host)).remainingSeconds, 42)
  assert.equal((await getFocusCurrentSession(host)).status, 'active')
  assert.deepEqual(await getFocusStats(host), { completedSessions: 0, totalFocusedMinutes: 45, currentStreakDays: 0, blockedDistractionsCount: 0 })
  const denied = await controlFocusSession('pause', host)
  assert.equal(denied.ok, false)
  assert.equal(denied.session.status, 'active')
  assert.equal(await getFocusCurrentSession({ focus_get_current: async () => ({ ...session, status: 'completed', remainingMs: 0 }) }), null)
  const created = await createFocusCategory({ name: '深度写作', defaultDurationMinutes: 40, blockedApps: ['Slack'], blockedSites: ['x.com'] }, host)
  assert.deepEqual(created.blockedApps, ['Slack'])
  assert.deepEqual(created.blockedSites, ['x.com'])
  const cats = await listFocusCategories(host)
  assert.deepEqual(cats[0].blockedApps, ['Slack'])
  assert.deepEqual(cats[0].blockedSites, ['x.com'])
  await assert.rejects(startFocusSession({ goal: '不应开始' }, { focus_start: async () => { throw new Error('disconnected') } }), /disconnected/)
})

test('网页打开直接使用引擎 URL，仅在实际通道 opened!==false 时报成功，失败包含错误', async () => {
  const failed = { transport: { call: async () => ({ success: false, error: 'denied' }) } }
  assert.equal((await performWebSearch('google', 'a b', failed)).ok, false)
  assert.equal((await quickOpenUrl('example.com', failed)).ok, false)
  const notOpened = { transport: { call: async () => ({ opened: false }) } }
  assert.equal((await performWebSearch('stackoverflow', 'react', notOpened)).ok, false)
  const openedUrls = []
  const fallback = {
    transport: {
      call: async (method, params) => {
        if (method === 'shell_open_external') {
          openedUrls.push(params.url)
          return { success: true }
        }
        return { success: false, error: 'missing' }
      }
    }
  }
  const so = await performWebSearch('stackoverflow', 'ts generics', fallback)
  assert.equal(so.ok, true)
  assert.match(openedUrls[0], /^https:\/\/stackoverflow\.com\/search\?q=/)
})

test('导航宿主空结果不补示例，权限错误传播并与普通超时区分', async () => {
  assert.deepEqual(await fetchNavigationWindows('', { navigation_list_windows: async () => [] }), [])
  assert.deepEqual(await searchNavigationMenuItems('', { navigation_search_menu_items: async () => [] }), [])
  await assert.rejects(fetchNavigationWindows('', { navigation_list_windows: async () => { throw new Error('permission denied') } }), /permission denied/)
  await assert.rejects(searchNavigationMenuItems('', { navigation_search_menu_items: async () => { throw new Error('permission denied') } }), /permission denied/)
  assert.equal(describeNavigationFailure(null, new Error('osascript timed out'))?.title, '无法读取应用菜单')
  assert.equal(describeNavigationFailure(new Error('ACCESSIBILITY_PERMISSION_DENIED'), null)?.title, '需要辅助功能权限')
})
