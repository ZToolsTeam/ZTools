/**
 * 11 - 集成工作流
 * 注意：CEF 109 不支持顶层 await，统一用 IIFE 包裹
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('集成测试 - 完整工作流', [
    {
      name: '完整设置工作流（读→改→验→恢复）',
      fn: async (exec) => {
        logger.step(1, '读取当前主题')
        const original = await exec.exec(
          "(async function(){ return await ztools.config.get('theme') })()",
          '读取主题'
        )

        logger.step(2, '切换到亮色')
        await exec.exec(
          "(async function(){ await ztools.config.set('theme', 'light') })()",
          '设置亮色'
        )

        logger.step(3, '验证')
        const result = await exec.exec(
          "(async function(){ return await ztools.config.get('theme') })()",
          '验证主题'
        )
        logger.debug(`验证结果: ${result}`)

        logger.step(4, '恢复')
        await exec.exec(
          `(async function(){ await ztools.config.set('theme', '${original || 'dark'}') })()`,
          '恢复主题'
        )
      }
    },
    {
      name: '完整插件安装链路验证（API 可用性）',
      fn: async (exec) => {
        logger.step(1, '获取版本信息')
        const verResult = await exec.exec(
          '(async function(){ return JSON.stringify(await ztools.sys.getCurrentVersion()) })()',
          '获取版本'
        )
        const ver = JSON.parse(verResult || '{}')
        logger.debug(`版本: ${ver.appVersion}`)

        logger.step(2, '获取已安装列表')
        const installed = await exec.exec(
          '(async function(){ var r = await ztools.plugin.getList(); return JSON.stringify((r||[]).map(function(p){ return p.pluginId })) })()',
          '获取已安装'
        )
        logger.debug(`已安装: ${installed}`)

        logger.step(3, '验证安装事件可监听')
        await exec.exec(
          "(function(){ var h = function(){}; ztools.events.on('plugin_install_complete', h); ztools.events.off('plugin_install_complete', h) })()",
          '事件监听注册'
        )

        logger.step(4, '验证核心 API 完整性')
        const apiCheck = await exec.exec(
          'JSON.stringify({ install: typeof ztools.plugin.install === "function", uninstall: typeof ztools.plugin.uninstall === "function", open: typeof ztools.plugin.open === "function" })',
          '检查插件 API'
        )
        logger.debug(`API 检查: ${apiCheck}`)
      }
    }
  ])
}
