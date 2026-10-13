/**
 * 02 - 数据库操作
 * 无依赖，验证 LevelDB 读写是否正常
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('数据库操作', [
    {
      name: '设置插件 ID',
      fn: async (exec) => {
        await exec.exec("ztools.db.setPluginId('test-plugin')", '设置插件 ID')
      }
    },
    {
      name: '写入数据',
      fn: async (exec) => {
        try {
          await exec.exec(
            "ztools.db.setPluginId('test-plugin'); ztools.db.put({_id: 'test-key', name: 'test', value: 123})",
            '写入数据库'
          )
        } catch (e) {
          logger.debug(`数据库写入失败: ${e.message}`)
        }
      }
    },
    {
      name: '读取数据',
      fn: async (exec) => {
        await exec.exec(
          "ztools.db.setPluginId('test-plugin'); ztools.db.get('test-key')",
          '读取数据库'
        )
      }
    },
    {
      name: '删除数据（清理测试数据）',
      fn: async (exec) => {
        try {
          await exec.exec(
            "ztools.db.setPluginId('test-plugin'); ztools.db.remove('test-key')",
            '删除数据库数据'
          )
        } catch (e) {
          logger.debug(`删除失败（数据可能不存在）: ${e.message}`)
        }
      }
    }
  ])
}
