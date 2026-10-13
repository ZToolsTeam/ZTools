import assert from 'node:assert/strict'
import test from 'node:test'
import { canCall, isAllowedMethod } from '../../src/contracts/capabilities.js'

test('only declared methods are allowed', () => {
  assert.equal(isAllowedMethod('app_ready'), true)
  assert.equal(isAllowedMethod('diagnostics_get'), true)
  assert.equal(isAllowedMethod('shell_exec'), true)
  assert.equal(isAllowedMethod('db_batch'), true)
  assert.equal(isAllowedMethod('credential_v1_status'), true)
  assert.equal(isAllowedMethod('update_check'), true)
  assert.equal(isAllowedMethod('plugin_open'), true)
  assert.equal(isAllowedMethod('plugin_window_close'), true)
  assert.equal(isAllowedMethod('privileged_execute'), true)
  assert.equal(isAllowedMethod('trigger_register'), true)
  assert.equal(isAllowedMethod('get_system_info'), true)
  assert.equal(isAllowedMethod('system_prevent_sleep'), true)
  assert.equal(isAllowedMethod('runtime_capability_get'), true)
  assert.equal(isAllowedMethod('dllplugin_call_async'), true)
  assert.equal(isAllowedMethod('shell_command_unbounded'), false)
})

test('plugins can read user authentication for OCR without changing the account', () => {
  const plugin = { type: 'plugin', webContentsId: 16, pluginId: 'ocr' } as const
  const main = { type: 'main', webContentsId: 1 } as const

  assert.equal(canCall('user_get_info', plugin), true)
  assert.equal(canCall('user_get_info', main), true)
  for (const method of ['user_set_token', 'user_logout'] as const) {
    assert.equal(canCall(method, plugin), false)
    assert.equal(canCall(method, main), true)
  }
})

test('diagnostics are available to plugins only through owner-filtered request IDs', () => {
  assert.equal(canCall('diagnostics_get', {
    type: 'plugin', webContentsId: 2, pluginId: 'test', pluginInstanceId: 'instance-1'
  }), true)
  assert.equal(canCall('diagnostics_get', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('config_get', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), false)
  assert.equal(canCall('analytics_report', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('window_get_bounds', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('pluginwin_hide', { type: 'main', webContentsId: 1 }), false)
  assert.equal(canCall('ui_close_confirm_result', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), false)
  assert.equal(canCall('event_publish', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('event_publish', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('network_http_request', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('network_set_cookie', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('network_set_proxy', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), false)
  assert.equal(canCall('network_set_proxy', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('filesystem_read_file', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('filesystem_write_cache', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('process_start', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('screen_capture', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('runtime_capability_get', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('clipboard_read_image', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('db_put', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  for (const method of ['credential_v1_status', 'credential_v1_set', 'credential_v1_get', 'credential_v1_delete'] as const) {
    assert.equal(canCall(method, { type: 'plugin', webContentsId: 2, pluginId: 'test', pluginInstanceId: 'instance-a' }), true)
    assert.equal(canCall(method, { type: 'main', webContentsId: 1 }), false)
  }
  assert.equal(canCall('plugin_install', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), false)
  assert.equal(canCall('plugin_open', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('plugin_window_close', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('plugin_window_close', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('app_ready', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('plugin_install', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('plugin_uninstall', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), false)
  assert.equal(canCall('update_check', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), false)
  assert.equal(canCall('update_check', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('privileged_execute', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('trigger_register', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('system_get_path', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
  assert.equal(canCall('dllplugin_call', { type: 'plugin', webContentsId: 2, pluginId: 'test' }), true)
})
