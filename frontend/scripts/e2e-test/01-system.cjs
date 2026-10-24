/**
 * 01 - 系统基础 + 版本兼容性
 * 注意：CEF 109 不支持顶层 await，所有 async 代码需包在 (async()=>{...})() 中
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  await runner.runSuite('系统基础功能', [
    {
      name: '获取版本号',
      fn: async (exec) => {
        const result = await exec.exec('ztools.getVersion()', '获取版本号')
        if (!result) throw new Error('未获取到版本号')
      }
    },
    {
      name: '获取环境信息',
      fn: async (exec) => {
        const result = await exec.exec('JSON.stringify(ztools.getEnvironment())', '获取环境信息')
        if (!result) throw new Error('未获取到环境信息')
      }
    },
    {
      name: '检测 CEF 环境',
      fn: async (exec) => {
        const result = await exec.exec('ztools.isCEF()', '检测 CEF 环境')
        logger.debug(`CEF 检测结果: ${result}`)
      }
    }
  ])

  await runner.runSuite('版本兼容性检查', [
    {
      name: '获取 App 和 Web 版本',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ return JSON.stringify(await ztools.sys.getCurrentVersion()) })()',
          '获取版本'
        )
        const ver = JSON.parse(result || '{}')
        logger.debug(`appVersion: ${ver.appVersion}, webVersion: ${ver.webVersion}`)
        if (!ver.appVersion) throw new Error('未获取到 appVersion')
      }
    },
    {
      name: '验证版本号格式',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ return JSON.stringify(await ztools.sys.getCurrentVersion()) })()',
          '获取版本格式'
        )
        const ver = JSON.parse(result || '{}')
        if (ver.appVersion && !/^\d+\.\d+\.\d+/.test(ver.appVersion)) {
          throw new Error(`appVersion 格式异常: ${ver.appVersion}`)
        }
        logger.debug(`版本格式验证通过: ${ver.appVersion}`)
      }
    },
    {
      name: '模拟兼容性检查逻辑',
      fn: async (exec) => {
        const result = await exec.exec(
          '(async function(){ var ver = await ztools.sys.getCurrentVersion(); var appVer = ver.appVersion || "1.0.0"; var parts = appVer.split(".").map(Number); var isValid = parts.length >= 2 && parts.every(function(n){ return !isNaN(n) }); return JSON.stringify({ appVer: appVer, isValid: isValid }) })()',
          '兼容性检查逻辑'
        )
        const res = JSON.parse(result || '{}')
        if (!res.isValid) throw new Error(`版本号无效: ${res.appVer}`)
        logger.debug(`兼容性检查: ${JSON.stringify(res)}`)
      }
    }
  ])
}
