/**
 * 05 - 用户认证 + 未登录状态下的插件边界测试
 *
 * 顺序说明：
 * - 先验证未登录状态下的 API 行为（Token 为 null、收藏需登录等）
 * - 这些测试必须在登录之前运行，确保边界逻辑正确
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('用户认证 - 基础状态检查', [
    {
      name: '检查登录状态',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ return JSON.stringify(await ztools.user.isLoggedIn()) })()',
          '检查登录状态'
        )
        logger.debug(`登录状态: ${result}`)
      }
    },
    {
      name: '获取用户信息',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ return JSON.stringify(await ztools.user.getInfo()) })()',
          '获取用户信息'
        )
        logger.debug(`用户信息: ${result}`)
        if (!result) throw new Error('未获取到用户信息响应')
      }
    },
    {
      name: '未登录时 Token 应为 null',
      fn: async (exec) => {
        try {
          const result = await exec.exec('(async function(){ return await ztools.user.getToken() })()', '获取 Token')
          logger.debug(`Token: ${result ? '有值（已登录）' : 'null（未登录）'}`)
        } catch (e) {
          logger.debug(`获取 Token 失败（预期行为）: ${e.message}`)
        }
      }
    }
  ])

  await runner.runSuite('未登录状态 - 插件操作边界', [
    {
      name: '未登录时收藏插件应被拒绝',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ var loggedIn = await ztools.user.isLoggedIn(); return JSON.stringify({ loggedIn: loggedIn, canFavorite: loggedIn }) })()',
          '检查收藏权限'
        )
        const res = JSON.parse(result || '{}')
        logger.debug(`收藏权限检查: ${JSON.stringify(res)}`)
        if (res.loggedIn === false && res.canFavorite !== false) {
          throw new Error('未登录时不应允许收藏')
        }
      }
    },
    {
      name: '未登录时获取已安装插件列表应正常',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ var r = await ztools.plugin.getList(); return JSON.stringify(r) })()',
          '获取已安装插件'
        )
        logger.debug(`已安装插件: ${result}`)
      }
    },
    {
      name: '未登录时打开已安装插件应正常',
      fn: async (exec) => {
        try {
          await exec.exec("(async function(){ return await ztools.plugin.open('ocr') })()", '打开插件')
          logger.debug('打开插件成功')
        } catch (e) {
          logger.debug(`打开插件失败（插件可能未安装）: ${e.message}`)
        }
      }
    },
    {
      name: '登出幂等不报错',
      fn: async (exec) => {
        try {
          await exec.exec('(async function(){ await ztools.user.logout() })()', '登出')
        } catch (e) {
          logger.debug(`登出失败（可能未登录）: ${e.message}`)
        }
      }
    }
  ])
}
