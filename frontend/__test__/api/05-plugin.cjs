/**
 * API 测试 - 插件管理 API (ztools.plugin)
 * 测试本地插件列表、DLL 插件等
 */

module.exports = async (runner) => {
  await runner.runSuite('API: 插件管理', [
    {
      name: 'plugin.getList 获取本地插件列表',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          '(async function(){ var r = await ztools.plugin.getList(); var list = r && r.data ? r.data : r; return JSON.stringify({ isArray: Array.isArray(list), length: Array.isArray(list) ? list.length : -1 }); })()'
        )
        const info = JSON.parse(raw)
        assert.ok(info.isArray, '插件列表应为数组')
      }
    },
    {
      name: 'dllplugin.getList 获取 DLL 插件列表',
      fn: async (cdp, assert) => {
        const result = await cdp.evaluateJSON('(async()=>await ztools.dllplugin.getList())()')
        assert.ok(result !== undefined, 'DLL 插件列表不应为 undefined')
      }
    },
    {
      name: 'plugin.open 打开不存在的插件应返回错误',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          '(async function(){ var r = await ztools.plugin.open("nonexistent-plugin-xyz"); var d = r && r.data ? r.data : r; return JSON.stringify({ success: d && d.success, action: d && d.action, error: d && d.error }); })()'
        )
        const result = JSON.parse(raw)
        assert.ok(
          result.success === false || result.action === 'navigate_to_detail' || result.error,
          '打开不存在的插件应返回错误信息'
        )
      }
    }
  ])
}
