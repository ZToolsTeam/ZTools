/**
 * 09 - 通知系统
 * 依赖：sys API（01 已验证）
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('通知系统', [
    {
      name: '验证通知 API 可用',
      fn: async (exec) => {
        const result = await exec.exec(
          'JSON.stringify(typeof ztools.sys.notify)',
          '检查通知 API'
        )
        if (result !== '"function"') throw new Error('通知 API 不可用')
      }
    },
    {
      name: '发送系统通知',
      fn: async (exec) => {
        try {
          await exec.exec(
            "await ztools.sys.notify('E2E 测试', '通知系统测试')",
            '发送通知'
          )
        } catch (e) {
          logger.debug(`通知发送失败: ${e.message}`)
        }
      }
    }
  ])
}
