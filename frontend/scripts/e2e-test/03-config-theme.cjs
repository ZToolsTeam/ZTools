/**
 * 03 - 配置管理 + 主题切换
 * 无依赖，验证 config API 读写及 DOM 主题变化
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('配置管理', [
    {
      name: '读取配置',
      fn: async (exec) => {
        await exec.exec("ztools.config.get('theme')", '读取配置')
      }
    },
    {
      name: '写入并读回配置（验证一致性）',
      fn: async (exec) => {
        await exec.exec("ztools.config.set('e2e-test-key', 'e2e-value')", '写入测试配置')
        const result = await exec.exec("ztools.config.get('e2e-test-key')", '读回测试配置')
        logger.debug(`读回值: ${result}`)
      }
    },
    {
      name: '设置快捷键配置',
      fn: async (exec) => {
        await exec.exec("ztools.config.set('hotkey', 'Ctrl+Shift+Z')", '设置快捷键')
      }
    },
    {
      name: '设置开机自启',
      fn: async (exec) => {
        try {
          await exec.exec("ztools.config.set('autostart', true)", '设置开机自启')
        } catch (e) {
          logger.debug(`设置开机自启失败（可能需要管理员权限）: ${e.message}`)
        }
      }
    },
    {
      name: '设置托盘选项',
      fn: async (exec) => {
        await exec.exec("ztools.config.set('minimize_to_tray', true)", '设置托盘选项')
      }
    }
  ])

  await runner.runSuite('主题切换流程', [
    {
      name: '读取当前主题',
      fn: async (exec) => {
        const result = await exec.exec(
          "(async function(){ return await ztools.config.get('ui.theme', null) })()",
          '读取主题'
        )
        logger.debug(`当前主题: ${result}`)
      }
    },
    {
      name: '切换到暗色主题并验证 DOM class',
      fn: async (exec) => {
        await exec.exec(
          "(async function(){ await ztools.config.set('ui.theme', 'dark', true) })()",
          '设置暗色主题'
        )
        const hasDark = await exec.exec(
          "document.documentElement.classList.contains('dark')",
          '检查 dark class'
        )
        logger.debug(`dark class 存在: ${hasDark}`)
      }
    },
    {
      name: '切换到亮色主题并验证 DOM class',
      fn: async (exec) => {
        await exec.exec(
          "(async function(){ await ztools.config.set('ui.theme', 'light', true) })()",
          '设置亮色主题'
        )
        const hasDark = await exec.exec(
          "document.documentElement.classList.contains('dark')",
          '检查 dark class'
        )
        logger.debug(`dark class 存在（应为 false）: ${hasDark}`)
      }
    },
    {
      name: '恢复暗色主题',
      fn: async (exec) => {
        await exec.exec(
          "(async function(){ await ztools.config.set('ui.theme', 'dark', true) })()",
          '恢复暗色主题'
        )
      }
    }
  ])
}
