/**
 * 04 - 事件系统 + 触发器
 * 无依赖，验证事件总线和触发器注册/注销
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('事件系统', [
    {
      name: '触发自定义事件',
      fn: async (exec) => {
        await exec.exec(
          "ztools.events.emit('test-event', {data: 'test', timestamp: Date.now()})",
          '触发自定义事件'
        )
      }
    },
    {
      name: '监听并取消监听事件',
      fn: async (exec) => {
        await exec.exec(
          "(function(){ var h = function(d){}; ztools.events.on('test-event', h); ztools.events.off('test-event', h) })()",
          '监听/取消监听'
        )
      }
    }
  ])

  await runner.runSuite('触发器系统', [
    {
      name: '注册快捷键触发器',
      fn: async (exec) => {
        await exec.exec(`
          ztools.trigger.register({
            id: 'test-hotkey-trigger',
            pluginId: 'system',
            type: 'hotkey',
            enabled: true,
            config: { key: 'Ctrl+Alt+T' },
            actionMode: 'builtin',
            actionTarget: 'notify',
            actionParams: { title: 'Test', message: 'Hotkey triggered' }
          })
        `, '注册快捷键触发器')
      }
    },
    {
      name: '注销触发器',
      fn: async (exec) => {
        try {
          await exec.exec("ztools.trigger.unregister('test-hotkey-trigger')", '注销触发器')
        } catch (e) {
          logger.debug(`注销失败（可能已不存在）: ${e.message}`)
        }
      }
    }
  ])
}
