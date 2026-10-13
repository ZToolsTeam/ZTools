/**
 * API 测试 - 配置管理 API (ztools.config)
 * 测试配置读写、收藏夹、系统设置等
 */

module.exports = async (runner) => {
  await runner.runSuite('API: 配置管理', [
    {
      name: 'config.get 读取配置',
      fn: async (cdp, assert) => {
        const val = await cdp.evaluate(
          '(async()=>await ztools.config.get("system.autostart", "false"))()'
        )
        assert.ok(val === 'true' || val === 'false', '自启动配置应为 true/false 字符串')
      }
    },
    {
      name: 'config.set/get 写入并读取测试配置',
      fn: async (cdp, assert) => {
        const testKey = '__test__.config.value'
        const testVal = 'test-' + Date.now()
        await cdp.evaluate(
          `(async()=>await ztools.config.set("${testKey}", "${testVal}", false))()`
        )
        const read = await cdp.evaluate(
          `(async()=>await ztools.config.get("${testKey}", ""))()`
        )
        assert.equal(read, testVal, '读取值应与写入值一致')
      }
    },
    {
      name: '读取全局热键配置',
      fn: async (cdp, assert) => {
        const hotkey = await cdp.evaluate(
          '(async()=>await ztools.config.get("hotkey.global", ""))()'
        )
        // 热键可能为空（未设置），只要不抛异常即可
        assert.typeOf(hotkey, 'string', '热键应为字符串')
      }
    },
    {
      name: '读取最小化到托盘配置',
      fn: async (cdp, assert) => {
        const val = await cdp.evaluate(
          '(async()=>await ztools.config.get("system.minimizeToTray", "true"))()'
        )
        assert.ok(val === 'true' || val === 'false', '最小化到托盘应为布尔字符串')
      }
    },
    {
      name: '读取关闭确认配置',
      fn: async (cdp, assert) => {
        const val = await cdp.evaluate(
          '(async()=>await ztools.config.get("system.closeConfirm", "true"))()'
        )
        assert.ok(val === 'true' || val === 'false', '关闭确认应为布尔字符串')
      }
    }
  ])
}
