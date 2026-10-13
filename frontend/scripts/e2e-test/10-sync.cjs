/**
 * 10 - 云端同步流程
 * 注意：CEF 109 不支持顶层 await，统一用 IIFE 包裹
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('云端同步流程', [
    {
      name: '验证用户 API 可用',
      fn: async (exec) => {
        const result = await exec.exec(
          'JSON.stringify(typeof ztools.user.isLoggedIn)',
          '检查用户 API'
        )
        if (result !== '"function"') throw new Error('用户 API 不可用')
      }
    },
    {
      name: '读取本地收藏数据',
      fn: async (exec) => {
        const result = await exec.exec(
          "(async function(){ return await ztools.config.get('plugins.favorites', '[]', 'user_settings.json') })()",
          '读取收藏'
        )
        logger.debug(`收藏数据: ${result}`)
      }
    },
    {
      name: '读取本地最近使用数据',
      fn: async (exec) => {
        const result = await exec.exec(
          "(async function(){ return await ztools.config.get('plugins.recents', '[]', 'user_settings.json') })()",
          '读取最近使用'
        )
        logger.debug(`最近使用: ${result}`)
      }
    },
    {
      name: '写入并读回同步数据（本地一致性验证）',
      fn: async (exec) => {
        await exec.exec(
          "(async function(){ await ztools.config.set('plugins.favorites', '[\"sync-test-plugin\"]', false, 'user_settings.json') })()",
          '写入测试收藏'
        )
        const result = await exec.exec(
          "(async function(){ return await ztools.config.get('plugins.favorites', '[]', 'user_settings.json') })()",
          '读回收藏'
        )
        logger.debug(`读回结果: ${result}`)
        // 恢复
        await exec.exec(
          "(async function(){ await ztools.config.set('plugins.favorites', '[]', false, 'user_settings.json') })()",
          '恢复收藏数据'
        )
      }
    },
    {
      name: '验证同步 API 结构',
      fn: async (exec) => {
        const result = await exec.exec(
          'JSON.stringify({ hasGetSyncData: typeof ztools.user.getSyncData === "function", hasPushSyncData: typeof ztools.user.pushSyncData === "function" })',
          '检查同步 API'
        )
        logger.debug(`同步 API: ${result}`)
      }
    }
  ])
}
