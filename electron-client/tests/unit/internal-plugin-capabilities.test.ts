import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canCall,
  isAllowedMethod,
  isInternalPlugin,
  isPrivilegedMethod,
  registerTrustedInternalPlugin,
  unregisterTrustedInternalPlugin,
  TRUSTED_INTERNAL_PLUGINS,
  PRIVILEGED_METHODS,
  type CallerIdentity
} from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { ZToolsRequest } from '../../src/contracts/ipc.js'
import {
  authorizeIpcRequest,
  dispatchAuthorizedIpcRequest,
  assertNoPluginIdSpoofing,
  validateCallerWebContents
} from '../../src/main/ipc/router.js'

function makeRequest(method: string, params: unknown = {}, messageId = 'req-1'): ZToolsRequest {
  return {
    messageId,
    method,
    params
  }
}

function makePluginCaller(pluginId: string, webContentsId = 100, pluginInstanceId = 'inst-1'): CallerIdentity {
  return {
    type: 'plugin',
    webContentsId,
    pluginId,
    pluginInstanceId
  }
}

function makeMainCaller(webContentsId = 1): CallerIdentity {
  return {
    type: 'main',
    webContentsId
  }
}

function makeSender(url: string, id = 100) {
  return {
    id,
    getURL: () => url
  }
}

test('isInternalPlugin correctly identifies officially registered internal plugins', () => {
  // 官方系统内置插件应全部识别为 true
  for (const pluginId of TRUSTED_INTERNAL_PLUGINS) {
    assert.equal(isInternalPlugin(pluginId), true, `${pluginId} 必须被识别为内置插件`)
  }

  // 命名未带 internal- 前缀但名称类似者，必须拒绝
  assert.equal(isInternalPlugin('developer'), false)
  assert.equal(isInternalPlugin('settings'), false)
  assert.equal(isInternalPlugin('super-panel'), false)
  assert.equal(isInternalPlugin('clipboard'), false)

  // 命名带 internal- 前缀但未经系统受信任列表登记的伪造插件，必须拒绝
  assert.equal(isInternalPlugin('internal-evil'), false)
  assert.equal(isInternalPlugin('internal-hacker'), false)
  assert.equal(isInternalPlugin('internal-untrusted'), false)

  // 空值或非字符串
  assert.equal(isInternalPlugin(''), false)
  assert.equal(isInternalPlugin(undefined), false)
  assert.equal(isInternalPlugin(null), false)
  assert.equal(isInternalPlugin(123 as unknown as string), false)
})

test('supports dynamic trusted internal plugin registration for tests/extensions', () => {
  const dynamicId = 'internal-test-custom'
  assert.equal(isInternalPlugin(dynamicId), false)

  // 必须以 internal- 前缀才能注册
  registerTrustedInternalPlugin('invalid-prefix-plugin')
  assert.equal(isInternalPlugin('invalid-prefix-plugin'), false)

  registerTrustedInternalPlugin(dynamicId)
  assert.equal(isInternalPlugin(dynamicId), true)

  unregisterTrustedInternalPlugin(dynamicId)
  assert.equal(isInternalPlugin(dynamicId), false)
})

test('PRIVILEGED_METHODS covers critical system operations and excludes normal plugin methods', () => {
  // 修改系统设置
  assert.ok(isPrivilegedMethod('settings_set'))
  assert.ok(isPrivilegedMethod('settings_get'))
  assert.ok(isPrivilegedMethod('config_set'))
  assert.ok(isPrivilegedMethod('config_get'))
  assert.ok(isPrivilegedMethod('system_set_autostart'))
  assert.ok(isPrivilegedMethod('system_get_autostart'))
  assert.ok(isPrivilegedMethod('system_set_dark_mode'))
  assert.ok(isPrivilegedMethod('network_set_proxy'))

  // 注册全局热键
  assert.ok(isPrivilegedMethod('trigger_register'))
  assert.ok(isPrivilegedMethod('trigger_unregister'))
  assert.ok(isPrivilegedMethod('trigger_set_enabled'))
  assert.ok(isPrivilegedMethod('system_reload_hotkeys'))

  // 深度系统与硬件监控信息
  assert.ok(isPrivilegedMethod('system_get_hardware_summary'))
  assert.ok(isPrivilegedMethod('system_get_cpu_usage'))
  assert.ok(isPrivilegedMethod('system_get_memory_usage'))
  assert.ok(isPrivilegedMethod('system_get_disk_usage'))
  assert.ok(isPrivilegedMethod('system_get_network_stats'))
  assert.ok(isPrivilegedMethod('system_get_battery_status'))
  assert.ok(isPrivilegedMethod('system_get_native_id'))

  // HMR 重载与插件管理
  assert.ok(isPrivilegedMethod('plugin_refresh'))
  assert.ok(isPrivilegedMethod('plugin_list_get'))
  assert.ok(isPrivilegedMethod('plugin_toggle'))
  assert.ok(isPrivilegedMethod('plugin_install'))
  assert.ok(isPrivilegedMethod('plugin_update'))
  assert.ok(isPrivilegedMethod('plugin_uninstall'))
  assert.ok(isPrivilegedMethod('window_toggle_devtools'))

  // 原生特权与注册表
  assert.ok(isPrivilegedMethod('privileged_execute'))
  assert.ok(isPrivilegedMethod('builtin_reg_write'))
  assert.ok(isPrivilegedMethod('builtin_reg_delete'))
  assert.ok(isPrivilegedMethod('builtin_file_write'))
  assert.ok(isPrivilegedMethod('builtin_restart_explorer'))

  // 非特权普通 API
  assert.equal(isPrivilegedMethod('user_get_info'), false)
  assert.equal(isPrivilegedMethod('analytics_report'), false)
  assert.equal(isPrivilegedMethod('window_get_bounds'), false)
  assert.equal(isPrivilegedMethod('screen_capture'), false)
  assert.equal(isPrivilegedMethod('clipboard_copy_text'), false)
  assert.equal(isPrivilegedMethod('db_put'), false)
  assert.equal(isPrivilegedMethod('db_get'), false)
  assert.equal(isPrivilegedMethod('filesystem_read_file'), false)
})

test('canCall grants privileged methods to internal plugins while restricting normal plugins', () => {
  const internalSettings = makePluginCaller('internal-settings')
  const internalDev = makePluginCaller('internal-developer')
  const normalPlugin = makePluginCaller('third-party-tool')
  const mainCaller = makeMainCaller()

  // 主程序拥有其声明的所有能力
  assert.equal(canCall('config_get', mainCaller), true)
  assert.equal(canCall('settings_set', mainCaller), true)
  assert.equal(canCall('plugin_install', mainCaller), true)

  // 内置插件具备调用主程序与特权 API 的特权
  assert.equal(canCall('settings_set', internalSettings), true)
  assert.equal(canCall('config_set', internalSettings), true)
  assert.equal(canCall('plugin_install', internalDev), true)
  assert.equal(canCall('plugin_refresh', internalDev), true)
  assert.equal(canCall('trigger_register', internalSettings), true)
  assert.equal(canCall('user_get_info', internalSettings), true)

  // 普通第三方插件禁止调用限定 main 的管理类 API
  assert.equal(canCall('config_get', normalPlugin), false)
  assert.equal(canCall('settings_set', normalPlugin), false)
  assert.equal(canCall('plugin_install', normalPlugin), false)
  assert.equal(canCall('update_check', normalPlugin), false)

  // 普通第三方插件允许调用声明的普通 plugin API
  assert.equal(canCall('user_get_info', normalPlugin), true)
  assert.equal(canCall('window_get_bounds', normalPlugin), true)
  assert.equal(canCall('db_put', normalPlugin), true)
})

test('internal plugin can successfully authorize and invoke privileged methods', () => {
  // 1. internal-settings 调用设置与配置修改
  const settingsCaller = makePluginCaller('internal-settings')
  const settingsSender = makeSender('ztools://plugins/internal-settings/index.html')

  const setSettingsReq = makeRequest('settings_set', { key: 'theme', value: 'dark' })
  assert.doesNotThrow(() => authorizeIpcRequest(settingsCaller, setSettingsReq, settingsSender))
  const setSettingsRes = dispatchAuthorizedIpcRequest(settingsCaller, setSettingsReq, settingsSender)
  assert.deepEqual(setSettingsRes, { success: true })

  const setConfigReq = makeRequest('config_set', { file: 'user.json', path: 'general.lang', value: 'zh-CN' })
  assert.doesNotThrow(() => authorizeIpcRequest(settingsCaller, setConfigReq, settingsSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(settingsCaller, setConfigReq, settingsSender), { success: true })

  const setAutostartReq = makeRequest('system_set_autostart', { enabled: true })
  assert.doesNotThrow(() => authorizeIpcRequest(settingsCaller, setAutostartReq, settingsSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(settingsCaller, setAutostartReq, settingsSender), { success: true })

  // 2. internal-super-panel 调用全局快捷键注册
  const panelCaller = makePluginCaller('internal-super-panel')
  const panelSender = makeSender('ztools://plugins/internal-super-panel/index.html')
  const triggerReq = makeRequest('trigger_register', {
    id: 'sp_hotkey',
    type: 'hotkey',
    config: { key: 'Alt+Space' },
    action: { mode: 'builtin', target: 'toggle_super_panel', params: {} }
  })
  assert.doesNotThrow(() => authorizeIpcRequest(panelCaller, triggerReq, panelSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(panelCaller, triggerReq, panelSender), { success: true })

  // 3. internal-developer 调用热重载、性能监控与调试工具
  const devCaller = makePluginCaller('internal-developer')
  const devSender = makeSender('ztools://plugins/internal-developer/index.html')

  const refreshReq = makeRequest('plugin_refresh')
  assert.doesNotThrow(() => authorizeIpcRequest(devCaller, refreshReq, devSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(devCaller, refreshReq, devSender), { success: true })

  const cpuUsageReq = makeRequest('system_get_cpu_usage')
  assert.doesNotThrow(() => authorizeIpcRequest(devCaller, cpuUsageReq, devSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(devCaller, cpuUsageReq, devSender), { success: true })

  const devtoolsReq = makeRequest('window_toggle_devtools')
  assert.doesNotThrow(() => authorizeIpcRequest(devCaller, devtoolsReq, devSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(devCaller, devtoolsReq, devSender), { success: true })
})

test('normal third-party plugin attempting privileged methods is blocked with PERMISSION_DENIED', () => {
  const untrustedCaller = makePluginCaller('my-third-party-tool')
  const untrustedSender = makeSender('ztools://plugins/my-third-party-tool/index.html')

  const privilegedCalls: Array<{ method: string; params?: unknown }> = [
    { method: 'settings_set', params: { key: 'theme', value: 'dark' } },
    { method: 'config_set', params: { file: 'conf.json', path: 'a.b', value: 1 } },
    { method: 'trigger_register', params: { id: 't1', type: 'hotkey', config: { key: 'Ctrl+F' } } },
    { method: 'trigger_unregister', params: { triggerId: 't1' } },
    { method: 'system_reload_hotkeys' },
    { method: 'system_set_autostart', params: { enabled: true } },
    { method: 'system_set_dark_mode', params: { isDark: true } },
    { method: 'system_get_hardware_summary' },
    { method: 'system_get_cpu_usage' },
    { method: 'system_get_native_id' },
    { method: 'plugin_refresh' },
    { method: 'plugin_toggle', params: { pluginId: 'my-third-party-tool' } },
    { method: 'window_toggle_devtools' },
    { method: 'privileged_execute', params: { command: 'cmd.exe' } },
    { method: 'builtin_reg_write', params: { key: 'HKCU\\Test', name: 'val', value: '1' } }
  ]

  for (const { method, params } of privilegedCalls) {
    const req = makeRequest(method, params ?? {})
    assert.throws(
      () => authorizeIpcRequest(untrustedCaller, req, untrustedSender),
      (error: unknown) => {
        assert.ok(error instanceof ZToolsError)
        assert.equal(error.code, errorCodes.permissionDenied)
        return true
      },
      `第三方插件调用 ${method} 必须抛出 PERMISSION_DENIED`
    )

    const response = dispatchAuthorizedIpcRequest(untrustedCaller, req, untrustedSender)
    assert.equal(response.success, false)
    assert.equal(response.error.code, 'PERMISSION_DENIED')
  }

  // 但第三方插件调用非特权普通 API 应当通过
  const safeReq = makeRequest('user_get_info')
  assert.doesNotThrow(() => authorizeIpcRequest(untrustedCaller, safeReq, untrustedSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(untrustedCaller, safeReq, untrustedSender), { success: true })

  const safeBoundsReq = makeRequest('window_get_bounds')
  assert.doesNotThrow(() => authorizeIpcRequest(untrustedCaller, safeBoundsReq, untrustedSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(untrustedCaller, safeBoundsReq, untrustedSender), { success: true })
})

test('blocks spoofed pluginId parameter attack scenarios with PERMISSION_DENIED', () => {
  const untrustedCaller = makePluginCaller('my-third-party-tool')
  const untrustedSender = makeSender('ztools://plugins/my-third-party-tool/index.html')

  // 场景 1：普通插件调用普通 API，但在 params 中试图指定内置插件 pluginId 伪装身份
  const spoofNormalReq = makeRequest('analytics_report', {
    event: 'test',
    pluginId: 'internal-settings'
  })
  assert.throws(
    () => authorizeIpcRequest(untrustedCaller, spoofNormalReq, untrustedSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      assert.ok(error.message.includes('pluginId 与注册身份不匹配'))
      return true
    }
  )
  const spoofNormalRes = dispatchAuthorizedIpcRequest(untrustedCaller, spoofNormalReq, untrustedSender)
  assert.equal(spoofNormalRes.success, false)
  assert.equal(spoofNormalRes.error.code, 'PERMISSION_DENIED')

  // 场景 2：普通插件试图在 trigger_register 中伪造 pluginId: 'internal-developer'
  const spoofPrivilegedReq = makeRequest('trigger_register', {
    pluginId: 'internal-developer',
    id: 'spoof_id'
  })
  assert.throws(
    () => authorizeIpcRequest(untrustedCaller, spoofPrivilegedReq, untrustedSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      return true
    }
  )
  const spoofPrivilegedRes = dispatchAuthorizedIpcRequest(untrustedCaller, spoofPrivilegedReq, untrustedSender)
  assert.equal(spoofPrivilegedRes.success, false)
  assert.equal(spoofPrivilegedRes.error.code, 'PERMISSION_DENIED')

  // 场景 3：普通插件试图操作其它普通插件 pluginId: 'victim-tool'
  const spoofVictimReq = makeRequest('plugin_window_close', {
    pluginId: 'victim-tool'
  })
  assert.throws(
    () => authorizeIpcRequest(untrustedCaller, spoofVictimReq, untrustedSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      assert.ok(error.message.includes('pluginId 与注册身份不匹配'))
      return true
    }
  )
  const spoofVictimRes = dispatchAuthorizedIpcRequest(untrustedCaller, spoofVictimReq, untrustedSender)
  assert.equal(spoofVictimRes.success, false)
  assert.equal(spoofVictimRes.error.code, 'PERMISSION_DENIED')

  // 场景 4：插件名称本身伪装为 internal-fake，但未经系统登记认证
  const fakeInternalCaller = makePluginCaller('internal-fake')
  const fakeInternalSender = makeSender('ztools://plugins/internal-fake/index.html')
  const fakePrivilegedReq = makeRequest('settings_set', { key: 'a', value: 'b' })
  assert.throws(
    () => authorizeIpcRequest(fakeInternalCaller, fakePrivilegedReq, fakeInternalSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      return true
    }
  )
  const fakePrivilegedRes = dispatchAuthorizedIpcRequest(fakeInternalCaller, fakePrivilegedReq, fakeInternalSender)
  assert.equal(fakePrivilegedRes.success, false)
  assert.equal(fakePrivilegedRes.error.code, 'PERMISSION_DENIED')

  // 场景 5：内置插件（如 internal-developer）管理其它插件时，允许携带目标 pluginId
  const internalDevCaller = makePluginCaller('internal-developer')
  const internalDevSender = makeSender('ztools://plugins/internal-developer/index.html')
  const devManageReq = makeRequest('plugin_toggle', { pluginId: 'any-target-plugin' })
  assert.doesNotThrow(() => authorizeIpcRequest(internalDevCaller, devManageReq, internalDevSender))
  assert.deepEqual(dispatchAuthorizedIpcRequest(internalDevCaller, devManageReq, internalDevSender), { success: true })
})

test('blocks spoofed WebContents origin URL tampering with PERMISSION_DENIED', () => {
  // 攻击者注册为 untrusted-app，但通过伪造 sender.getURL 返回 internal-settings
  const caller = makePluginCaller('untrusted-app')
  const maliciousSender = makeSender('ztools://plugins/internal-settings/index.html')
  const req = makeRequest('user_get_info')

  assert.throws(
    () => authorizeIpcRequest(caller, req, maliciousSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      assert.ok(error.message.includes('来源 URL 与注册插件身份不匹配'))
      return true
    }
  )

  // 主程序身份但 sender 来源是插件域
  const mainCaller = makeMainCaller()
  const fakeMainSender = makeSender('ztools://plugins/my-plugin/index.html')
  const mainReq = makeRequest('config_get', { file: 'conf.json', path: 'k' })
  assert.throws(
    () => authorizeIpcRequest(mainCaller, mainReq, fakeMainSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      assert.ok(error.message.includes('主程序 WebContents 来源无效'))
      return true
    }
  )

  // 内置插件来源为外链 http
  const internalCaller = makePluginCaller('internal-settings')
  const externalSender = makeSender('http://malicious-website.com/attack.html')
  assert.throws(
    () => validateCallerWebContents(internalCaller, externalSender),
    (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      return true
    }
  )
})
