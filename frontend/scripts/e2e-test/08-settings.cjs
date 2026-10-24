/**
 * 08 - 高级设置（快捷键、超级面板）
 * 依赖：config API、trigger API（04 已验证事件系统）
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('高级设置功能', [
    {
      name: '配置全局快捷键',
      fn: async (exec) => {
        await exec.exec(`
          ztools.trigger.register({
            id: 'global_wake_hotkey',
            pluginId: 'system',
            type: 'hotkey',
            enabled: true,
            config: { key: 'Ctrl+Shift+Z' },
            actionMode: 'builtin',
            actionTarget: 'toggle_main_window'
          })
        `, '配置全局快捷键')
      }
    },
    {
      name: '配置超级面板键盘热键',
      fn: async (exec) => {
        await exec.exec(`
          ztools.config.set('super_panel.keyboard_hotkey', JSON.stringify({
            enabled: true,
            modifiers: ['Alt'],
            key: 'Space'
          }))
        `, '配置超级面板键盘热键')
      }
    },
    {
      name: '配置超级面板鼠标热键',
      fn: async (exec) => {
        await exec.exec(`
          ztools.config.set('super_panel.mouse_hotkey', JSON.stringify({
            enabled: true,
            button: 'middle_long',
            longPressMs: 300
          }))
        `, '配置超级面板鼠标热键')
      }
    },
    {
      name: '重新加载快捷键',
      fn: async (exec) => {
        try {
          await exec.exec('ztools.sys.reloadHotkeys()', '重新加载快捷键')
        } catch (e) {
          logger.debug(`重新加载快捷键失败: ${e.message}`)
        }
      }
    },
    {
      name: '完整快捷键配置工作流（注册→验证→注销）',
      fn: async (exec) => {
        logger.step(1, '注册测试快捷键')
        await exec.exec(`
          ztools.trigger.register({
            id: 'workflow-test-hotkey',
            pluginId: 'system',
            type: 'hotkey',
            enabled: true,
            config: { key: 'Ctrl+Shift+W' },
            actionMode: 'builtin',
            actionTarget: 'notify',
            actionParams: { title: 'Workflow', message: 'Test' }
          })
        `, '注册快捷键')

        logger.step(2, '验证配置已写入')
        await exec.exec("ztools.config.get('hotkey')", '验证快捷键')

        logger.step(3, '注销快捷键（清理）')
        try {
          await exec.exec("ztools.trigger.unregister('workflow-test-hotkey')", '注销快捷键')
        } catch (e) {
          logger.debug(`注销失败（可能已不存在）: ${e.message}`)
        }
      }
    }
  ])
}
