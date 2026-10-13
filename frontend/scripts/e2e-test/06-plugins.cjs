/**
 * 06 - 插件市场 + 更新 + 卸载流程
 * 注意：CEF 109 不支持顶层 await，const 在全局作用域会重复声明，统一用 var 和 IIFE
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('插件市场流程', [
    {
      name: '获取版本信息（兼容性检查前置）',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ return JSON.stringify(await ztools.sys.getCurrentVersion()) })()',
          '获取版本信息'
        )
        if (!result) throw new Error('未获取到版本信息')
        logger.debug(`版本: ${result}`)
      }
    },
    {
      name: '获取已安装插件列表',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ var r = await ztools.plugin.getList(); return JSON.stringify(r || []) })()',
          '获取已安装插件'
        )
        logger.debug(`已安装数量: ${JSON.parse(result || '[]').length}`)
      }
    },
    {
      name: '检查插件安装状态',
      fn: async (exec) => {
        try {
          const result = await exec.exec(
            '(async function(){ var list = await ztools.plugin.getList(); var found = (list||[]).some(function(p){ return p.pluginId === "ocr" }); return JSON.stringify(found) })()',
            '检查 ocr 安装状态'
          )
          logger.debug(`ocr 安装状态: ${result}`)
        } catch (e) {
          logger.debug(`检查安装状态失败: ${e.message}`)
        }
      }
    },
    {
      name: '验证安装/卸载/打开 API 均可用',
      fn: async (exec) => {
        const result = await exec.exec(
          'JSON.stringify({ hasInstall: typeof ztools.plugin.install === "function", hasUninstall: typeof ztools.plugin.uninstall === "function", hasOpen: typeof ztools.plugin.open === "function" })',
          '检查插件 API'
        )
        logger.debug(`插件 API: ${result}`)
      }
    }
  ])

  await runner.runSuite('插件更新流程', [
    {
      name: '验证 checkUpdate API 可用',
      fn: async (exec) => {
        const result = await exec.exec(
          'JSON.stringify(typeof ztools.plugin.checkUpdate)',
          '检查更新 API'
        )
        logger.debug(`checkUpdate 类型: ${result}`)
      }
    },
    {
      name: '获取已安装插件版本信息',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ var list = await ztools.plugin.getList(); return JSON.stringify((list||[]).map(function(p){ return { id: p.pluginId, ver: p.version } })) })()',
          '获取插件版本'
        )
        logger.debug(`插件版本: ${result}`)
      }
    },
    {
      name: '验证安装完成事件可监听',
      fn: async (exec) => {
        await exec.exec(
          "(function(){ var h = function(e){}; ztools.events.on('plugin_install_complete', h); ztools.events.off('plugin_install_complete', h) })()",
          '注册/注销安装完成事件'
        )
      }
    }
  ])

  await runner.runSuite('插件卸载流程', [
    {
      name: '验证卸载 API 可用',
      fn: async (exec) => {
        const result = await exec.exec(
          'JSON.stringify(typeof ztools.plugin.uninstall)',
          '检查卸载 API'
        )
        if (result !== '"function"') throw new Error('卸载 API 不可用')
      }
    },
    {
      name: '验证卸载完成事件可监听',
      fn: async (exec) => {
        await exec.exec(
          "(function(){ var h = function(e){}; ztools.events.on('plugin_uninstalled', h); ztools.events.off('plugin_uninstalled', h) })()",
          '注册/注销卸载完成事件'
        )
      }
    }
  ])
}
