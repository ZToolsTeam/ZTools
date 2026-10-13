/**
 * API 测试 - 系统基础 API (ztools.sys / ztools 顶层)
 * 测试 Native API 中的系统相关接口
 */

module.exports = async (runner) => {
  await runner.runSuite('API: 系统基础', [
    {
      name: 'ztools 对象存在',
      fn: async (cdp, assert) => {
        const exists = await cdp.evaluate('typeof window.ztools === "object"')
        assert.ok(exists, 'window.ztools 应为对象')
      }
    },
    {
      name: 'getVersion 返回版本号',
      fn: async (cdp, assert) => {
        const ver = await cdp.evaluate('ztools.getVersion()')
        assert.ok(ver, '版本号不应为空')
        assert.typeOf(ver, 'string', '版本号应为字符串')
      }
    },
    {
      name: 'getEnvironment 返回环境信息',
      fn: async (cdp, assert) => {
        const env = await cdp.evaluateJSON('ztools.getEnvironment()')
        assert.ok(env, '环境信息不应为空')
        assert.typeOf(env, 'object', '环境信息应为对象')
      }
    },
    {
      name: 'isCEF 返回布尔值',
      fn: async (cdp, assert) => {
        const result = await cdp.evaluate('ztools.isCEF()')
        assert.typeOf(result, 'boolean', 'isCEF 应返回布尔值')
      }
    },
    {
      name: 'sys.getInfo 返回系统信息',
      fn: async (cdp, assert) => {
        const info = await cdp.evaluateJSON('(async()=>await ztools.sys.getInfo())()')
        assert.ok(info, '系统信息不应为空')
      }
    },
    {
      name: 'sys.getNativeId 返回设备标识',
      fn: async (cdp, assert) => {
        const id = await cdp.evaluate('(async()=>await ztools.sys.getNativeId())()')
        assert.ok(id, '设备标识不应为空')
        assert.typeOf(id, 'string', '设备标识应为字符串')
      }
    },
    {
      name: 'sys.getPath 获取系统路径',
      fn: async (cdp, assert) => {
        const desktop = await cdp.evaluate('(async()=>await ztools.sys.getPath("desktop"))()')
        assert.ok(desktop, '桌面路径不应为空')
        assert.includes(desktop.toLowerCase(), 'desktop', '应包含 desktop')
      }
    },
    {
      name: 'sys.getCurrentVersion 返回版本对象',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate('(async function(){ return JSON.stringify(await ztools.sys.getCurrentVersion()) })()')
        assert.ok(raw, '版本对象不应为空')
        const ver = JSON.parse(raw)
        assert.ok(ver.appVersion, 'appVersion 不应为空')
        assert.match(ver.appVersion, /^\d+\.\d+\.\d+/, 'appVersion 格式应为 x.y.z')
      }
    }
  ])
}
