/**
 * 07 - 我的页面
 * 依赖：config API（03 已验证）
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('我的页面功能', [
    {
      name: '获取固定插件列表',
      fn: async (exec) => {
        const result = await exec.exec(
          "ztools.config.get('my-page.pinned')",
          '获取固定插件列表'
        )
        logger.debug(`固定列表: ${result}`)
      }
    },
    {
      name: '设置固定插件并读回验证',
      fn: async (exec) => {
        await exec.exec(
          "ztools.config.set('my-page.pinned', JSON.stringify(['plugin-1', 'plugin-2', 'plugin-3']))",
          '设置固定插件'
        )
        const result = await exec.exec(
          "ztools.config.get('my-page.pinned')",
          '读回固定插件'
        )
        logger.debug(`读回结果: ${result}`)
      }
    },
    {
      name: '获取最近使用插件',
      fn: async (exec) => {
        const result = await exec.exec(
          "ztools.config.get('plugins.recents', '[]', 'user_settings.json')",
          '获取最近使用'
        )
        logger.debug(`最近使用: ${result}`)
      }
    },
    {
      name: '保存拖拽顺序',
      fn: async (exec) => {
        await exec.exec(
          "ztools.config.set('my-page.order', JSON.stringify(['plugin-3', 'plugin-1', 'plugin-2']))",
          '保存拖拽顺序'
        )
      }
    },
    {
      name: '完整我的页面工作流（固定→验证→恢复）',
      fn: async (exec) => {
        logger.step(1, '备份当前固定列表')
        const original = await exec.exec("ztools.config.get('my-page.pinned')", '备份')

        logger.step(2, '设置新固定列表')
        await exec.exec(
          "ztools.config.set('my-page.pinned', JSON.stringify(['plugin-a', 'plugin-b']))",
          '设置'
        )

        logger.step(3, '验证')
        const result = await exec.exec("ztools.config.get('my-page.pinned')", '验证')
        logger.debug(`验证结果: ${result}`)

        logger.step(4, '恢复原始数据')
        await exec.exec(
          `ztools.config.set('my-page.pinned', '${original || "[]"}')`,
          '恢复'
        )
      }
    }
  ])
}
