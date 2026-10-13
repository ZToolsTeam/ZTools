import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { errorCodes, toPublicError, ZToolsError } from '../../src/contracts/errors.js'
import { INFINITE_TIMEOUT, MAX_REQUEST_BYTES, MAX_TIMEOUT_MS, parseRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { RUNTIME_CAPABILITY_IDS } from '../../src/contracts/runtime-capability.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { ScreenService, type ScreenAdapter } from '../../src/main/services/screen-service.js'

interface PublicErrorFixture {
  code: string
  message: string
}

const publicErrorFixtureRoot = resolve(__dirname, '../../../..', 'packages/api/contracts/fixtures/errors')
const capabilityFixtureRoot = resolve(__dirname, '../../../..', 'packages/api/contracts/fixtures/capabilities')

function loadPublicErrorFixture(name: string): PublicErrorFixture {
  return JSON.parse(readFileSync(join(publicErrorFixtureRoot, name), 'utf8')) as PublicErrorFixture
}

test('parseRequest accepts a valid request', () => {
  assert.deepEqual(parseRequest({ messageId: 'test:1', method: 'app_ready', params: {} }), {
    messageId: 'test:1',
    method: 'app_ready',
    params: {}
  })
})

test('runtime capability IPC accepts only the explicit stable capability catalog', () => {
  assert.deepEqual(RUNTIME_CAPABILITY_IDS, [
    'screen.capture',
    'clipboard.files.read',
    'system.hibernate'
  ])
  for (const capability of RUNTIME_CAPABILITY_IDS) {
    assert.doesNotThrow(() => validateMethodParams('runtime_capability_get', { capability }))
  }

  const fixtureIds = new Set<string>()
  for (const file of readdirSync(capabilityFixtureRoot).filter((name) => name.endsWith('.json')).sort()) {
    const fixture = JSON.parse(readFileSync(join(capabilityFixtureRoot, file), 'utf8')) as { capability: string }
    fixtureIds.add(fixture.capability)
    assert.doesNotThrow(
      () => validateMethodParams('runtime_capability_get', { capability: fixture.capability }),
      `shared capability fixture ${file} must use a registered ID`
    )
  }
  assert.deepEqual([...fixtureIds].sort(), [...RUNTIME_CAPABILITY_IDS].sort())
})

test('runtime capability authorization IPC validates plugin and Main request shapes', () => {
  assert.doesNotThrow(() => validateMethodParams('runtime_capability_request', { capability: 'screen.capture' }))
  assert.doesNotThrow(() => validateMethodParams('runtime_capability_revoke', { capability: 'screen.capture' }))
  assert.doesNotThrow(() => validateMethodParams('runtime_capability_grants_list', {}))
  assert.doesNotThrow(() => validateMethodParams('runtime_capability_grant_revoke', { grantId: 'a'.repeat(43) }))
  assert.throws(() => validateMethodParams('runtime_capability_request', { capability: 'unknown' }))
  assert.throws(() => validateMethodParams('runtime_capability_revoke', { capability: 'screen.capture', pluginId: 'spoofed' }))
  assert.throws(() => validateMethodParams('runtime_capability_grants_list', { pluginId: 'spoofed' }))
  for (const grantId of ['', 'too-short', 'x'.repeat(129)]) {
    assert.throws(() => validateMethodParams('runtime_capability_grant_revoke', { grantId }))
  }
})

test('parseRequest rejects unknown fields', () => {
  assert.throws(
    () => parseRequest({ messageId: 'test:1', method: 'app_ready', params: {}, pluginId: 'spoofed' }),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('credential v1 IPC does not accept caller-supplied plugin identity', () => {
  assert.doesNotThrow(() => validateMethodParams('credential_v1_status', {}))
  assert.doesNotThrow(() => validateMethodParams('credential_v1_set', { key: 'api-token', value: 'secret' }))
  assert.doesNotThrow(() => validateMethodParams('credential_v1_get', { key: 'api-token' }))
  assert.doesNotThrow(() => validateMethodParams('credential_v1_delete', { key: 'api-token' }))

  assert.throws(() => validateMethodParams('credential_v1_status', { pluginId: 'spoofed' }))
  assert.throws(() => validateMethodParams('credential_v1_set', {
    key: 'api-token', value: 'secret', plugin_id: 'other-plugin'
  }))
  assert.throws(() => validateMethodParams('credential_v1_get', { key: 'api-token', pluginId: 'other-plugin' }))
})

test('parseRequest rejects zero and excessive timeouts', () => {
  for (const timeoutMs of [0, 300_001]) {
    assert.throws(() => parseRequest({ messageId: 'test:1', method: 'app_ready', params: {}, timeoutMs }))
  }
  assert.equal(parseRequest({
    messageId: 'network:deadline',
    method: 'network_http_request',
    params: {},
    timeoutMs: 300_250
  }).timeoutMs, 300_250)
  assert.throws(() => parseRequest({
    messageId: 'other:deadline',
    method: 'app_ready',
    params: {},
    timeoutMs: 300_250
  }))
  assert.throws(() => parseRequest({
    messageId: 'network:too-long',
    method: 'network_http_request',
    params: {},
    timeoutMs: 300_251
  }))
})

test('trigger accelerators accept Electron 43 key codes and reject malformed syntax as invalid requests', () => {
  const triggerParams = (key: string) => ({
    pluginId: 'plugin.test',
    type: 'hotkey',
    enabled: false,
    config: { key },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  })
  for (const key of [
    'Ctrl+Shift+Z',
    'CommandOrControl+Alt+Space',
    'CmdOrCtrl+num3',
    'Shift+F24',
    'Meta+Esc',
    'A+Ctrl',
    'Ctrl+Plus',
    'Ctrl+\\',
    "Ctrl+'"
  ]) {
    assert.doesNotThrow(() => validateMethodParams('trigger_register', triggerParams(key)))
    assert.doesNotThrow(() => validateMethodParams('trigger_check_conflict', { key, pluginId: '' }))
  }

  for (const key of [
    'Ctrl',
    'Ctrl+',
    '+A',
    'Ctrl++',
    'Ctrl+Shift+A+B',
    'Ctrl+F25',
    'Ctrl+NotAKey',
    'DoubleCtrl',
    'Ctrl+\nA'
  ]) {
    assert.throws(
      () => validateMethodParams('trigger_register', triggerParams(key)),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    assert.throws(
      () => validateMethodParams('trigger_check_conflict', { key, pluginId: '' }),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
})

test('public IPC error fixtures preserve known errors and redact unknown exception details', () => {
  const permissionDenied = loadPublicErrorFixture('permission-denied.json')
  assert.equal(permissionDenied.code, errorCodes.permissionDenied)
  assert.deepEqual(
    toPublicError(new ZToolsError(errorCodes.permissionDenied, permissionDenied.message)),
    permissionDenied
  )

  const internalError = loadPublicErrorFixture('internal-error-redacted.json')
  assert.equal(internalError.code, errorCodes.internalError)
  const privateDetail = 'secret-token /Users/test/private.txt'
  const publicError = toPublicError(new Error(privateDetail))
  assert.deepEqual(publicError, internalError)
  assert.equal(JSON.stringify(publicError).includes(privateDetail), false)

  for (const code of Object.values(errorCodes)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
  }
})

test('screen capture TCC denial preserves its structured public IPC error', async () => {
  const adapter: ScreenAdapter = {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getPrimaryDisplay: () => { throw new Error('must not inspect displays before permission preflight') },
    getAllDisplays: () => { throw new Error('must not inspect displays before permission preflight') },
    getDisplayNearestPoint: () => { throw new Error('unused') },
    getDisplayMatching: () => { throw new Error('unused') },
    getSources: async () => { throw new Error('must not call desktopCapturer before permission grant') },
    createFromBitmap: () => { throw new Error('unused') },
    getScreenCapturePermissionStatus: () => 'denied'
  }
  const service = new ScreenService({} as FileSystemService, adapter)
  const caller: CallerIdentity = { type: 'main', webContentsId: 1 }

  await assert.rejects(
    service.capture({}, caller, new AbortController().signal),
    (error) => {
      const publicError = toPublicError(error)
      assert.equal(publicError.code, errorCodes.permissionDenied)
      assert.match(publicError.message, /TCC 状态：denied/)
      return true
    }
  )
})

test('parseRequest only permits explicit infinite waits for dialogs', () => {
  assert.equal(
    parseRequest({
      messageId: 'dialog:1',
      method: 'window_show_open_dialog',
      params: {},
      timeoutMs: INFINITE_TIMEOUT
    }).timeoutMs,
    INFINITE_TIMEOUT
  )
  assert.throws(() => parseRequest({
    messageId: 'test:1',
    method: 'app_ready',
    params: {},
    timeoutMs: INFINITE_TIMEOUT
  }))
  assert.equal(
    parseRequest({
      messageId: 'process:wait',
      method: 'process_wait',
      params: { pid: 1234, timeout: 0 },
      timeoutMs: INFINITE_TIMEOUT
    }).timeoutMs,
    INFINITE_TIMEOUT
  )
  assert.equal(parseRequest({
    messageId: 'update:install',
    method: 'update_install_start',
    params: { type: 'app', version: '2.0.0' },
    timeoutMs: INFINITE_TIMEOUT
  }).timeoutMs, INFINITE_TIMEOUT)
})

test('parseRequest rejects oversized params', () => {
  const params = { value: 'x'.repeat(MAX_REQUEST_BYTES + 1) }
  assert.throws(() => parseRequest({ messageId: 'test:1', method: 'app_ready', params }))
})

test('parseRequest only raises the request limit for bounded file or image payloads', () => {
  const content = 'A'.repeat(MAX_REQUEST_BYTES + 4)
  assert.doesNotThrow(() => parseRequest({
    messageId: 'file:1',
    method: 'filesystem_write_file',
    params: { path: 'cache.bin', encoding: 'base64', content }
  }))
  assert.throws(() => parseRequest({
    messageId: 'app:large',
    method: 'app_ready',
    params: { value: content }
  }))
  assert.doesNotThrow(() => parseRequest({
    messageId: 'clipboard:image',
    method: 'clipboard_copy_image',
    params: { image: content }
  }))
  assert.doesNotThrow(() => parseRequest({
    messageId: 'database:put',
    method: 'db_put',
    params: { plugin_id: 'test', key: 'large', value: content }
  }))
})

test('method params reject unknown and invalid fields', () => {
  assert.doesNotThrow(() => validateMethodParams('app_ready', { status: 'initialized' }))
  assert.doesNotThrow(() => validateMethodParams('diagnostics_get', {}))
  assert.doesNotThrow(() => validateMethodParams('diagnostics_get', { requestIds: ['js_1_2_sys_get_diagnostics'] }))
assert.doesNotThrow(() => validateMethodParams('runtime_capability_get', { capability: 'screen.capture' }))
assert.throws(() => validateMethodParams('runtime_capability_get', {
  capability: 'screen.capture',
  pluginId: 'spoofed-plugin'
}))
assert.throws(() => validateMethodParams('runtime_capability_get', {
  capability: 'runtime.unregistered.read'
}))
  assert.throws(() => validateMethodParams('app_ready', { status: 'ready' }))
  assert.throws(() => validateMethodParams('diagnostics_get', { pluginId: 'spoofed' }))
  assert.throws(() => validateMethodParams('diagnostics_get', { requestIds: ['../outside'] }))
  assert.throws(() => validateMethodParams('diagnostics_get', { requestIds: Array.from({ length: 65 }, (_, index) => `req-${index}`) }))
  assert.doesNotThrow(() => validateMethodParams('config_get', {
    file: 'user_settings.json',
    path: 'ui.theme',
    default: null
  }))
  assert.doesNotThrow(() => validateMethodParams('config_get', {
    file: 'user_settings.json',
    path: 'super_panel',
    default: { enabled: true }
  }))
  assert.doesNotThrow(() => validateMethodParams('config_set', {
    file: 'user_settings.json',
    path: 'super_panel',
    value: '{"enabled":true}',
    sync_enabled: true
  }))
  assert.doesNotThrow(() => validateMethodParams('user_set_token', {
    token: 'access',
    refresh_token: 'refresh',
    user_id: 'user-1',
    expires_at: '2026-08-25T00:00:00.000Z'
  }))
  assert.doesNotThrow(() => validateMethodParams('analytics_report', {
    event: 'app_launch',
    plugin_id: '',
    web_version: '1.0.0'
  }))
  assert.doesNotThrow(() => validateMethodParams('plugin_list_get', {}))
  assert.doesNotThrow(() => validateMethodParams('plugin_data_list', { pluginId: 'plugin.test' }))
  assert.doesNotThrow(() => validateMethodParams('plugin_data_restore', {
    pluginId: 'plugin.test',
    preservationId: 'snapshot-1',
    assets: ['user-data.json']
  }))
  assert.throws(() => validateMethodParams('plugin_data_restore', {
    pluginId: 'plugin.test',
    preservationId: 'snapshot-1',
    assets: []
  }))
  assert.doesNotThrow(() => validateMethodParams('plugin_open', {
    pluginId: 'plugin.test',
    payload: { source: 'test', nested: { value: 1 } }
  }))
  assert.doesNotThrow(() => validateMethodParams('plugin_window_close', { pluginId: 'plugin.test' }))
  assert.doesNotThrow(() => validateMethodParams('plugin_window_close', {
    pluginId: 'plugin.test',
    instanceId: '01234567-89ab-4cde-8fab-0123456789ab'
  }))
  for (const invalid of [
    { pluginId: '../outside' },
    { pluginId: 'plugin.test', instanceId: 'not-a-uuid' },
    { pluginId: 'plugin.test', instanceId: 'C:\\plugin\\window' },
    { pluginId: 'plugin.test', unexpected: true }
  ]) {
    assert.throws(() => validateMethodParams('plugin_window_close', invalid))
  }
  assert.throws(() => validateMethodParams('plugin_open', {
    pluginId: 'plugin.test',
    payload: ['not-an-object']
  }))
  assert.throws(() => validateMethodParams('plugin_open', {
    pluginId: 'plugin.test',
    payload: { value: 'x'.repeat(64 * 1024) }
  }))
  assert.doesNotThrow(() => validateMethodParams('plugin_install', {
    pluginId: 'plugin.test',
    url: 'https://cdn.example.com/plugin.zip',
    version: '1.2.3',
    fileSize: 1024
  }))
  assert.throws(() => validateMethodParams('plugin_install', {
    pluginId: '../outside',
    url: 'https://cdn.example.com/plugin.zip',
    version: '1.2.3',
    checksum: 'a'.repeat(64),
    fileSize: 1024
  }))
  assert.throws(() => validateMethodParams('plugin_update', {
    pluginId: 'plugin.test',
    url: 'https://cdn.example.com/plugin.zip',
    version: '1.2.3',
    checksum: 'not-a-checksum',
    fileSize: 1024
  }))
  assert.throws(() => validateMethodParams('config_get', {
    file: 'user_settings.json',
    path: '__proto__.polluted',
    default: ''
  }))
  assert.throws(() => validateMethodParams('analytics_report', {
    event: 'x'.repeat(101),
    plugin_id: '',
    web_version: ''
  }))
  assert.doesNotThrow(() => validateMethodParams('window_set_size', {
    width: 900,
    height: 600,
    animate: true
  }))
  assert.doesNotThrow(() => validateMethodParams('window_show_open_dialog', {
    title: '选择文件',
    filters: '文本文件 (*.txt)|*.txt',
    properties: ['openFile', 'multiSelections'],
    timeout: MAX_TIMEOUT_MS
  }))
  for (const method of [
    'window_show_open_dialog',
    'window_show_save_dialog',
    'window_show_select_folder_dialog'
  ] as const) {
    assert.doesNotThrow(() => validateMethodParams(method, { timeout: MAX_TIMEOUT_MS }))
    assert.throws(() => validateMethodParams(method, { timeout: 0 }))
    assert.throws(() => validateMethodParams(method, { timeout: MAX_TIMEOUT_MS + 1 }))
    assert.throws(() => validateMethodParams(method, { timeout: MAX_TIMEOUT_MS, legacy: true }))
  }
  assert.throws(() => validateMethodParams('window_set_opacity', { opacity: 1.1 }))
  assert.throws(() => validateMethodParams('window_show_open_dialog', {
    properties: ['openFile', 'arbitraryCapability']
  }))
  assert.throws(() => validateMethodParams('ui_close_confirm_result', {
    confirmed: true,
    doNotAskAgain: false,
    action: 'delete'
  }))
  assert.doesNotThrow(() => validateMethodParams('event_subscribe', { key: 'channel:updates' }))
  assert.doesNotThrow(() => validateMethodParams('event_publish', {
    envelope: {
      envelopeId: 'env_test_1',
      version: 'v1',
      timestamp: Date.now(),
      type: 'page.Test',
      scope: 'system',
      source: { kind: 'page' },
      target: { broadcast: true },
      payload: { ok: true }
    }
  }))
  assert.throws(() => validateMethodParams('event_publish', {
    envelope: {
      envelopeId: 'env_test_1',
      version: 'v1',
      timestamp: Date.now(),
      type: 'page.Test',
      scope: 'system',
      source: { kind: 'page', pluginId: 'spoofed' },
      target: { broadcast: true },
      payload: {}
    }
  }))
  assert.throws(() => validateMethodParams('event_request', {
    envelope: {
      envelopeId: 'env_test_1',
      version: 'v1',
      timestamp: Date.now(),
      type: 'rpc.test',
      scope: 'system',
      source: { kind: 'page' },
      target: { broadcast: true },
      payload: {},
      replyTo: 'env_other'
    }
  }))
  assert.doesNotThrow(() => validateMethodParams('network_http_request', {
    method: 'POST',
    url: 'http://localhost:6800/jsonrpc',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    timeout: 30_000
  }))
  assert.throws(() => validateMethodParams('network_http_request', {
    method: 'GET',
    url: 'file:///C:/Windows/win.ini',
    timeout: 30_000
  }))
  assert.doesNotThrow(() => validateMethodParams('network_http_download', {
    url: 'https://example.com/file.zip',
    savePath: 'C:\\selected\\file.zip',
    timeout: 120_000
  }))
  assert.doesNotThrow(() => validateMethodParams('network_http_upload', {
    url: 'https://example.com/upload',
    filePath: 'C:\\selected\\file.zip',
    fieldName: 'document',
    timeout: MAX_TIMEOUT_MS
  }))
  assert.throws(() => validateMethodParams('network_http_upload', {
    url: 'https://example.com/upload',
    filePath: 'C:\\selected\\file.zip',
    fieldName: 'bad\r\nname'
  }))
  assert.throws(() => validateMethodParams('network_http_request', {
    method: 'GET',
    url: 'https://example.com',
    headers: { Host: 'internal.example' },
    timeout: 30_000
  }))
  assert.doesNotThrow(() => validateMethodParams('network_set_cookie', {
    name: 'session',
    value: 'value',
    domain: '.example.com',
    path: '/'
  }))
  assert.throws(() => validateMethodParams('network_set_cookie', {
    name: 'session',
    value: 'value'
  }))
  assert.doesNotThrow(() => validateMethodParams('network_set_proxy', {
    host: 'localhost',
    port: 80,
    username: 'user',
    password: 'pass'
  }))
  assert.doesNotThrow(() => validateMethodParams('filesystem_write_file', {
    path: 'C:\\selected\\data.bin',
    encoding: 'base64',
    content: 'AAEC/w=='
  }))
  assert.doesNotThrow(() => validateMethodParams('filesystem_read_cache', {
    relativePath: 'state/data.json',
    encoding: 'utf8'
  }))
  assert.throws(() => validateMethodParams('filesystem_write_file', {
    path: 'C:\\selected\\data.bin',
    encoding: 'base64',
    content: 'not-base64'
  }))
  assert.throws(() => validateMethodParams('filesystem_read_cache', {
    relativePath: '../secrets.json',
    encoding: 'utf8'
  }))
  assert.doesNotThrow(() => validateMethodParams('shell_open_external', {
    url: 'https://example.com/path'
  }))
  assert.throws(() => validateMethodParams('shell_open_external', {
    url: 'file:///C:/Windows/win.ini'
  }))
  assert.doesNotThrow(() => validateMethodParams('process_start', {
    path: 'C:\\selected\\tool.exe',
    args: ['--input', 'a b'],
    workingDir: 'C:\\selected',
    show: false
  }))
  assert.throws(() => validateMethodParams('process_start', {
    path: 'C:\\selected\\tool.exe',
    args: '--input a b',
    workingDir: 'C:\\selected',
    show: false
  }))
  assert.throws(() => validateMethodParams('process_kill', {
    pid: 0,
    force: true
  }))
  assert.doesNotThrow(() => validateMethodParams('process_kill_by_name', {
    name: 'node.exe',
    force: false
  }))
  assert.throws(() => validateMethodParams('process_kill_by_name', {
    name: 'C:\\selected\\tool.exe',
    force: true
  }))
  assert.doesNotThrow(() => validateMethodParams('screen_capture', {
    rect: { x: -1920, y: 0, width: 1920, height: 1080 }
  }))
  assert.doesNotThrow(() => validateMethodParams('screen_get_display_nearest', {
    point: { x: -1, y: 20 }
  }))
  assert.throws(() => validateMethodParams('screen_capture', {
    rect: { x: 0, y: 0, width: 0, height: 100 }
  }))
  assert.throws(() => validateMethodParams('screen_get_display_matching', {
    rect: { x: 0, y: 0, width: 100, height: 100, displayId: 1 }
  }))
  assert.doesNotThrow(() => validateMethodParams('clipboard_copy_text', { text: 'value' }))
  assert.doesNotThrow(() => validateMethodParams('clipboard_copy_text', { tempFile: 'C:\\selected\\text.tmp' }))
  assert.throws(() => validateMethodParams('clipboard_copy_text', {
    text: 'value',
    tempFile: 'C:\\selected\\text.tmp'
  }))
  assert.doesNotThrow(() => validateMethodParams('clipboard_copy_image', {
    image: 'data:image/png;base64,AA=='
  }))
  assert.throws(() => validateMethodParams('clipboard_copy_image', {
    image: 'data:text/plain;base64,AA=='
  }))
  assert.doesNotThrow(() => validateMethodParams('clipboard_copy_files', {
    filePaths: ['C:\\selected\\a.txt', 'C:\\selected\\b.txt']
  }))
  assert.throws(() => validateMethodParams('clipboard_copy_files', { filePaths: [] }))
  assert.doesNotThrow(() => validateMethodParams('clipboard_read_image', {}))
  assert.throws(() => validateMethodParams('clipboard_clear', { arbitrary: true }))
  assert.doesNotThrow(() => validateMethodParams('db_put', {
    plugin_id: 'plugin.test',
    key: 'document:1',
    value: { _id: 'document:1', enabled: true }
  }))
  assert.doesNotThrow(() => validateMethodParams('db_query', {
    plugin_id: 'plugin.test',
    prefix: 'document:',
    limit: 100
  }))
  assert.doesNotThrow(() => validateMethodParams('db_batch', {
    plugin_id: 'plugin.test',
    operations: [
      { op: 'put', key: 'a', value: 'value' },
      { op: 'delete', key: 'b' }
    ]
  }))
  assert.doesNotThrow(() => validateMethodParams('db_put', {
    plugin_id: 'plugin.test',
    key: 'binary',
    value: 'AAEC/w==',
    is_base64: true
  }))
  assert.throws(() => validateMethodParams('db_put', {
    plugin_id: '../outside',
    key: 'key',
    value: 'value'
  }))
  assert.throws(() => validateMethodParams('db_put', {
    plugin_id: 'CON.data',
    key: 'key',
    value: 'value'
  }))
  assert.throws(() => validateMethodParams('db_batch', {
    plugin_id: 'plugin.test',
    operations: [{ op: 'delete', key: 'a', value: 'unexpected' }]
  }))
})

test('M2-E facade and trigger params are strictly bounded', () => {
  assert.doesNotThrow(() => validateMethodParams('update_check', { source: 'manual' }))
  assert.throws(() => validateMethodParams('update_check', { source: 'background' }))
  assert.doesNotThrow(() => validateMethodParams('update_download_start', {
    version: '1.2.3',
    downloadUrl: 'https://cdn.example.com/ZTools-Electron.exe',
    checksum: 'a'.repeat(64),
    fileSize: 1024
  }))
  assert.throws(() => validateMethodParams('update_install_start', {
    type: 'app',
    version: '1.2.3'
  }))
  assert.doesNotThrow(() => validateMethodParams('privileged_execute', {
    cmd: 'approved-command',
    args: ['--value'],
    timeout: 1000,
    show: false
  }))
  assert.throws(() => validateMethodParams('privileged_execute', {
    cmd: 'command',
    shell: true
  }))
  assert.doesNotThrow(() => validateMethodParams('builtin_reg_write', {
    path: 'HKEY_LOCAL_MACHINE\\Software\\ZTools',
    name: 'Enabled',
    value: '1',
    view: 64
  }))
  assert.throws(() => validateMethodParams('builtin_reg_delete', {
    path: 'HKEY_LOCAL_MACHINE\\Software\\ZTools',
    name: 'Enabled',
    view: 0
  }))
  assert.doesNotThrow(() => validateMethodParams('trigger_register', {
    id: 'global_wake_hotkey',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Shift+Z' },
    actionMode: 'builtin',
    actionTarget: 'toggle_main_window',
    actionParams: {}
  }))
  assert.doesNotThrow(() => validateMethodParams('trigger_register', {
    pluginId: 'plugin.test',
    type: 'hotkey',
    enabled: false,
    config: { key: 'Alt+F10' },
    action: { mode: 'window', target: 'plugin.test', params: {} }
  }))
  assert.throws(() => validateMethodParams('trigger_register', {
    pluginId: 'plugin.test',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+T', extra: true },
    action: { mode: 'window', target: 'plugin.test', params: {} }
  }))
  assert.throws(() => validateMethodParams('trigger_register', {
    pluginId: 'plugin.test',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+T' },
    action: { mode: 'window', target: 'plugin.test', params: {} },
    actionMode: 'window',
    actionTarget: 'plugin.test',
    actionParams: {}
  }))
  assert.doesNotThrow(() => validateMethodParams('trigger_check_conflict', {
    key: 'Ctrl+Shift+Z',
    pluginId: ''
  }))
})

test('M2-F1 system params are strictly bounded', () => {
  assert.doesNotThrow(() => validateMethodParams('system_notify', {
    title: 'ZTools',
    message: 'message',
    modal: false
  }))
  assert.throws(() => validateMethodParams('system_notify', {
    title: 'ZTools',
    message: 'message',
    modal: false,
    icon: 'file:///C:/secret.png'
  }))
  assert.doesNotThrow(() => validateMethodParams('system_get_path', { name: 'downloads' }))
  assert.throws(() => validateMethodParams('system_get_path', { name: 'root' }))
  assert.doesNotThrow(() => validateMethodParams('system_shutdown', {
    force: false,
    timeout: 0
  }))
  assert.throws(() => validateMethodParams('system_shutdown', {
    force: false,
    timeout: 86_401
  }))
  assert.doesNotThrow(() => validateMethodParams('system_simulate_mouse_click', {
    button: 'left',
    x: -1920,
    y: 10
  }))
  assert.throws(() => validateMethodParams('system_simulate_mouse_click', {
    button: 'left',
    x: 10
  }))
  assert.doesNotThrow(() => validateMethodParams('system_get_disk_usage', { drive: 'C:\\' }))
  assert.doesNotThrow(() => validateMethodParams('system_get_disk_usage', { drive: 'C:\\Windows' }))
  assert.doesNotThrow(() => validateMethodParams('system_get_disk_usage', { drive: '/Volumes/External Disk' }))
  assert.doesNotThrow(() => validateMethodParams('system_get_disk_usage', {}))
  assert.throws(() => validateMethodParams('system_get_disk_usage', { drive: 'C:relative' }))
  assert.throws(() => validateMethodParams('system_get_disk_usage', { drive: '/Volumes/invalid\0path' }))
})

test('M2-F2 DLL facade params reject identity and payload abuse', () => {
  assert.doesNotThrow(() => validateMethodParams('dllplugin_list', {}))
  assert.doesNotThrow(() => validateMethodParams('dllplugin_call', {
    plugin: 'ImagePlugin',
    func: 'Resize',
    params: { input: 'C:\\selected\\in.png', width: 800 }
  }))
  assert.throws(() => validateMethodParams('dllplugin_call', {
    plugin: '..\\outside.dll',
    func: 'Resize',
    params: {}
  }))
  assert.throws(() => validateMethodParams('dllplugin_call_async', {
    plugin: 'ImagePlugin',
    func: 'Resize;Start-Process cmd',
    params: {}
  }))
  assert.throws(() => validateMethodParams('dllplugin_call_with_callback', {
    plugin: 'ImagePlugin',
    func: 'Resize',
    params: []
  }))
  assert.doesNotThrow(() => validateMethodParams('dllplugin_query_task', {
    plugin: 'ImagePlugin',
    taskId: 'callback_1787585340000_ab12cd34'
  }))
  assert.throws(() => validateMethodParams('dllplugin_cancel_task', {
    plugin: 'ImagePlugin',
    taskId: '../other-task'
  }))
  assert.doesNotThrow(() => validateMethodParams('dllplugin_clear_callback_task', {
    taskId: 'callback_1787585340000_ab12cd34'
  }))
})

test('exclusive file writes validate a boolean flag and reject attempts to supply identity', () => {
  const params = { path: 'C:\\selected\\out.txt', encoding: 'utf8', content: 'data' }
  assert.doesNotThrow(() => validateMethodParams('filesystem_write_file', { ...params, overwrite: false }))
  assert.doesNotThrow(() => validateMethodParams('filesystem_write_file', { ...params, overwrite: true }))
  for (const overwrite of [0, 'false', null, {}]) assert.throws(() => validateMethodParams('filesystem_write_file', { ...params, overwrite }))
  assert.throws(() => validateMethodParams('filesystem_write_file', { ...params, overwrite: false, pluginId: 'other' }))
})

test('file Base64 validation accepts 8/16 MiB without recursive regex overflow', () => {
  const params = { path: 'C:/selected/out.bin', encoding: 'base64', overwrite: false }
  for (const size of [0, 1, 2, 3, 8 * 1024 * 1024, 16 * 1024 * 1024]) {
    assert.doesNotThrow(() => validateMethodParams('filesystem_write_file', { ...params, content: Buffer.alloc(size).toString('base64') }))
  }
  for (const content of ['A', 'AAA', 'A===', '=AAA', 'AA=A', 'AAAA=', 'AA\nA', 'AAAA!AAA', 'AAAA====']) {
    assert.throws(() => validateMethodParams('filesystem_write_file', { ...params, content }), /Base64/)
  }
  const boundary = Buffer.alloc(8 * 1024 * 1024).toString('base64')
  assert.throws(() => validateMethodParams('filesystem_write_file', { ...params, content: boundary.slice(0, -4) + '!AAA' }), /Base64/)
})

test('local app trigger IDs are admitted only for the exact existing Windows builtin action', () => {
  const appId = 'localapp:ABCD1234'
  const base = { pluginId: appId, type: 'hotkey', enabled: true, config: { key: 'Ctrl+Alt+F24' } }
  assert.doesNotThrow(() => validateMethodParams('trigger_register', {
    ...base, action: { mode: 'builtin', target: 'launch_local_app', params: { appId } }
  }))
  assert.doesNotThrow(() => validateMethodParams('trigger_register', {
    ...base, actionMode: 'builtin', actionTarget: 'launch_local_app', actionParams: { appId }
  }))
  assert.doesNotThrow(() => validateMethodParams('trigger_list', { pluginId: appId }))
  assert.doesNotThrow(() => validateMethodParams('trigger_check_conflict', { pluginId: appId, key: 'Ctrl+Alt+F24' }))
  for (const action of [
    { mode: 'builtin', target: 'launch_local_app', params: { appId, path: 'C:/untrusted.exe' } },
    { mode: 'builtin', target: 'launch_local_app', params: { appId: 'localapp:1234ABCD' } },
    { mode: 'builtin', target: 'toggle_main_window', params: {} },
    { mode: 'script', target: 'launch_local_app', params: { appId } }
  ]) assert.throws(() => validateMethodParams('trigger_register', { ...base, action }))
  assert.throws(() => validateMethodParams('trigger_register', {
    ...base, type: 'timer', config: {}, action: { mode: 'builtin', target: 'launch_local_app', params: { appId } }
  }))
})

test('local trigger owner syntax never widens generic plugin identity or admits a Mac shortcut promise', () => {
  for (const pluginId of ['localapp:ABCD1234', 'localapp:mac:' + 'A'.repeat(64)]) {
    assert.throws(() => validateMethodParams('plugin_open', { pluginId }))
  }
  const pluginId = 'localapp:mac:' + 'A'.repeat(64)
  assert.throws(() => validateMethodParams('trigger_register', {
    pluginId, type: 'hotkey', enabled: true, config: { key: 'Ctrl+Alt+F24' },
    action: { mode: 'builtin', target: 'launch_local_app', params: { appId: pluginId } }
  }))
  assert.throws(() => validateMethodParams('trigger_list', { pluginId }))
  assert.throws(() => validateMethodParams('trigger_check_conflict', { pluginId, key: 'Ctrl+Alt+F24' }))
})
