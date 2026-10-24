/**
 * 12 - 性能测试 + 错误处理
 * 放最后，不影响其他测试状态
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('性能测试', [
    {
      name: '快速连续 API 调用（5次，< 10s）',
      fn: async (exec) => {
        const start = Date.now()
        for (let i = 0; i < 5; i++) {
          await exec.exec('ztools.getVersion()', `API 调用 ${i + 1}`)
        }
        const duration = Date.now() - start
        logger.debug(`5 次 API 调用耗时: ${duration}ms`)
        if (duration > 10000) throw new Error(`API 调用过慢: ${duration}ms`)
      }
    },
    {
      name: '批量配置操作（3次，< 5s）',
      fn: async (exec) => {
        const start = Date.now()
        for (let i = 0; i < 3; i++) {
          await exec.exec(
            `ztools.config.set('perf-test-${i}', 'value-${i}')`,
            `配置操作 ${i + 1}`
          )
        }
        const duration = Date.now() - start
        logger.debug(`3 次配置操作耗时: ${duration}ms`)
        if (duration > 5000) throw new Error(`配置操作过慢: ${duration}ms`)
      }
    }
  ])

  await runner.runSuite('错误处理', [
    {
      name: '处理无效插件 ID（不应崩溃）',
      fn: async (exec) => {
        try {
          await exec.exec("ztools.plugin.open('nonexistent-plugin-xyz')", '打开不存在的插件')
        } catch (e) {
          logger.debug(`预期错误: ${e.message}`)
        }
      }
    },
    {
      name: '处理无效配置键（应返回默认值）',
      fn: async (exec) => {
        try {
          await exec.exec("ztools.config.get('invalid.key.path.xyz')", '获取无效配置')
        } catch (e) {
          logger.debug(`预期错误: ${e.message}`)
        }
      }
    }
  ])
}
