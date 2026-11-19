import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { IpcRouterOptions } from '../../src/main/ipc/router.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { IPC_CALL_CHANNEL, type ZToolsRequest, type ZToolsResponse } from '../../src/contracts/ipc.js'
import type { CoreServices } from '../../src/main/services/core-services.js'

// 独立 Node 子进程装配真实 WindowRegistry + IpcRouter + LevelDB DatabaseService，验证完整 IPC 调用与日志过滤闭环
async function runMissingKeyIntegrationFixture(): Promise<void> {
  const modules = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown }
  const originalLoad = modules._load
  const ipcHandlers = new Map<string, (event: unknown, value: unknown) => Promise<ZToolsResponse>>()
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  const ipcMain = Object.assign(new EventEmitter(), {
    handle(channel: string, listener: (event: unknown, value: unknown) => Promise<ZToolsResponse>) {
      ipcHandlers.set(channel, listener)
    },
    removeHandler(channel: string) {
      ipcHandlers.delete(channel)
    }
  })
  const electron = {
    nativeTheme,
    ipcMain,
    shell: {},
    BrowserWindow: {},
    globalShortcut: { isRegistered: () => false, isSuspended: () => false },
    app: { isReady: () => true }
  }
  modules._load = function (name, ...args) {
    return name === 'electron' ? electron : originalLoad.call(this, name, ...args)
  }
  const { IpcRouter } = require('../../src/main/ipc/router.js') as typeof import('../../src/main/ipc/router.js')
  const { WindowRegistry } = require('../../src/main/windows/window-registry.js') as typeof import('../../src/main/windows/window-registry.js')
  const { runtimePathsForBusinessDataRoot } = require('../../src/main/runtime/runtime-paths.js') as typeof import('../../src/main/runtime/runtime-paths.js')
  modules._load = originalLoad

  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-ipc-db-log-'))
  const registry = new WindowRegistry()
  const mainSender = Object.assign(new EventEmitter(), {
    id: 101,
    isDestroyed: () => false,
    getURL: () => 'ztools://web/index.html',
    send() {}
  })
  registry.registerMain(mainSender as never)

  const nativeHost = {
    state: 'ready',
    onDllEvent() { return () => {} },
    onInputEvent() { return () => {} },
    onLifecycleEvent() { return () => {} },
    async configureMouseTrigger() {}
  }
  const services = {
    dataRoot,
    runtimePaths: runtimePathsForBusinessDataRoot(dataRoot),
    appVersion: 'test',
    webVersion: 'test',
    config: { async get() { return JSON.stringify({ enabled: false }) }, async setSetting() {} },
    user: {},
    analytics: { stop() {} },
    clipboardHistory: { useImageThumbnailer() {} },
    nativeHost,
    serviceClient: null,
    update: { onProgress() { return () => {} } },
    async stop() {}
  } as unknown as CoreServices
  const options = {
    toggleMainWindow() {},
    closeConfirmationResolved() {},
    screenClipboardAdapters: {},
    pluginResources: {
      pluginRoot: path.join(dataRoot, 'Plugins'),
      ztoolsApiPath: 'missing-sdk',
      preloadPath: 'missing-preload'
    },
    systemPlatformAdapter: {
      userDataPath: dataRoot,
      getRuntimeTarget() {
        return { platform: process.platform, runtime: 'electron', arch: process.arch }
      },
      async getNativeId() { return '' }
    },
    processDiscoveryAdapter: { async list() { return [] } }
  } as unknown as IpcRouterOptions
  const mainApp = {
    getPath: () => dataRoot,
    getAppPath: () => dataRoot,
    isPackaged: false,
    runningUnderARM64Translation: false,
    async getFileIcon() { return { toDataURL: () => '' } }
  } as unknown as Parameters<typeof IpcRouter.create>[3]

  const errorLogs: unknown[][] = []
  const warnLogs: unknown[][] = []
  const origError = console.error
  const origWarn = console.warn
  let router: Awaited<ReturnType<typeof IpcRouter.create>> | undefined
  try {
    router = await IpcRouter.create(registry, services, options, mainApp)
    router.register()
    const callHandler = ipcHandlers.get(IPC_CALL_CHANNEL)
    assert.ok(callHandler, 'register() 必须挂载 IPC_CALL_CHANNEL 处理器')

    console.error = (...args: unknown[]) => { errorLogs.push(args) }
    console.warn = (...args: unknown[]) => { warnLogs.push(args) }

    // 1. 预期未命中：真实 LevelDB 下 db_get / db_get_secure 读取未写入键，返回 DATABASE_KEY_NOT_FOUND 且零错误/警告日志
    const missGet = await callHandler({ sender: mainSender }, {
      messageId: 'req-miss-get',
      method: 'db_get',
      params: { plugin_id: 'clipboard-manager', key: 'ls:missing-setting' }
    })
    assert.equal(missGet.success, false)
    assert.equal(missGet.error.code, errorCodes.databaseKeyNotFound)
    assert.equal(errorLogs.length, 0, 'db_get 未命中键不应打印 [IPC ROUTER ERROR DETAILS]')
    assert.equal(warnLogs.length, 0, 'db_get 未命中键不应打印 IPC request failed 警告')

    const missSecure = await callHandler({ sender: mainSender }, {
      messageId: 'req-miss-secure',
      method: 'db_get_secure',
      params: { plugin_id: 'clipboard-manager', key: 'missing-token' }
    })
    assert.equal(missSecure.success, false)
    assert.equal(missSecure.error.code, errorCodes.databaseKeyNotFound)
    assert.equal(errorLogs.length, 0, 'db_get_secure 未命中键不应打印错误堆栈')
    assert.equal(warnLogs.length, 0, 'db_get_secure 未命中键不应打印警告')

    // 2. 真实读写闭环：写入后再次 db_get 正常返回持久化的值
    const putRes = await callHandler({ sender: mainSender }, {
      messageId: 'req-put-1',
      method: 'db_put',
      params: { plugin_id: 'clipboard-manager', key: 'ls:theme', value: '"dark"' }
    })
    assert.equal(putRes.success, true)
    const hitGet = await callHandler({ sender: mainSender }, {
      messageId: 'req-hit-1',
      method: 'db_get',
      params: { plugin_id: 'clipboard-manager', key: 'ls:theme' }
    })
    assert.deepEqual(hitGet, {
      messageId: 'req-hit-1',
      success: true,
      data: { success: true, data: '"dark"' }
    })

    // 3. 异常注入：db_get 访问宿主保留凭据键触发 PERMISSION_DENIED、畸形参数（空 key / timeoutMs: 0）与未注册窗口调用必须原样记录错误堆栈与 warn
    const forbiddenKeyRes = await callHandler({ sender: mainSender }, {
      messageId: 'req-cred-reserved',
      method: 'db_get',
      params: { plugin_id: 'clipboard-manager', key: '__ztools_credential_v1__:secret' }
    })
    assert.equal(forbiddenKeyRes.success, false)
    assert.equal(forbiddenKeyRes.error.code, errorCodes.permissionDenied)
    assert.equal(errorLogs.length, 1, 'db_get 权限拒绝必须打印错误详情')
    assert.equal(warnLogs.length, 1, 'db_get 权限拒绝必须打印警告')

    const invalidTimeoutRes = await callHandler({ sender: mainSender }, {
      messageId: 'req-zero-timeout',
      method: 'db_get',
      params: { plugin_id: 'clipboard-manager', key: 'ls:theme' },
      timeoutMs: 0
    })
    assert.equal(invalidTimeoutRes.success, false)
    assert.equal(invalidTimeoutRes.error.code, errorCodes.invalidRequest)
    assert.equal(errorLogs.length, 2, 'timeoutMs 为 0 的非法请求必须记录错误详情')
    assert.equal(warnLogs.length, 2)

    const unregisteredSender = Object.assign(new EventEmitter(), {
      id: 999,
      isDestroyed: () => false,
      getURL: () => 'ztools://web/index.html'
    })
    const unauthRes = await callHandler({ sender: unregisteredSender }, {
      messageId: 'req-unregistered',
      method: 'db_get',
      params: { plugin_id: 'clipboard-manager', key: 'ls:theme' }
    })
    assert.equal(unauthRes.success, false)
    assert.equal(unauthRes.error.code, errorCodes.permissionDenied)
    assert.equal(errorLogs.length, 3, '未注册调用方必须记录错误详情')
    assert.equal(warnLogs.length, 3)
  } finally {
    console.error = origError
    console.warn = origWarn
    await router?.stop()
    assert.equal(ipcHandlers.has(IPC_CALL_CHANNEL), false, 'router.stop() 必须对称卸载 IPC_CALL_CHANNEL')
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--ipc-missing-key-fixture') {
  void runMissingKeyIntegrationFixture().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  const {
    getIpcFailureLogIdentifierFields,
    isIpcCapabilityBoundary,
    isMissingDatabaseKeyError
  } = require('../../src/main/ipc/router.js') as typeof import('../../src/main/ipc/router.js')

  test('credential IPC failure diagnostics do not inspect request parameters', () => {
    for (const method of [
      'credential_v1_status',
      'credential_v1_set',
      'credential_v1_get',
      'credential_v1_delete'
    ]) {
      const request = { method } as unknown as ZToolsRequest
      Object.defineProperty(request, 'params', {
        get() { throw new Error('credential params must not be read') }
      })
      assert.deepEqual(getIpcFailureLogIdentifierFields(request), {}, method)

      const secret = `secret-${method}`
      const malformed = {
        method,
        params: { plugin: secret, func: secret, credential: secret }
      } as unknown as ZToolsRequest
      const fields = getIpcFailureLogIdentifierFields(malformed)
      assert.deepEqual(fields, {}, method)
      assert.equal(JSON.stringify({ method, ...fields }).includes(secret), false, method)
    }
  })

  test('non-credential IPC failures retain safe DLL diagnostic identifiers', () => {
    assert.deepEqual(
      getIpcFailureLogIdentifierFields({
        messageId: 'request-1',
        method: 'dllplugin_call',
        params: { plugin: 'CapturePlugin', func: 'TakeScreenshot' }
      }),
      { dllId: 'CapturePlugin', functionName: 'TakeScreenshot' }
    )
  })

  test('只有显式 NOT_SUPPORTED 的 ZToolsError 视为平台能力边界，其余失败仍按故障记录', () => {
    assert.equal(isIpcCapabilityBoundary(new ZToolsError(errorCodes.notSupported, '当前更新安装链仅支持 Windows')), true)
    for (const error of [
      new ZToolsError(errorCodes.pluginNotFound, '插件不存在'),
      new ZToolsError(errorCodes.permissionDenied, 'denied'),
      Object.assign(new Error('forged'), { code: errorCodes.notSupported }),
      { code: errorCodes.notSupported },
      'NOT_SUPPORTED',
      undefined,
      null
    ]) {
      assert.equal(isIpcCapabilityBoundary(error), false, String((error as { message?: string })?.message ?? error))
    }
  })

  test('只有 db_get / db_get_secure 抛出的显式 DATABASE_KEY_NOT_FOUND ZToolsError 视为预期未命中', () => {
    const missingErr = new ZToolsError(errorCodes.databaseKeyNotFound, 'Key not found')
    assert.equal(isMissingDatabaseKeyError({ method: 'db_get' }, missingErr), true)
    assert.equal(isMissingDatabaseKeyError({ method: 'db_get_secure' }, missingErr), true)

    for (const method of ['db_put', 'db_delete', 'db_query', 'dllplugin_call', '']) {
      assert.equal(isMissingDatabaseKeyError({ method }, missingErr), false, `method=${method}`)
    }
    assert.equal(isMissingDatabaseKeyError(undefined, missingErr), false)

    for (const error of [
      new ZToolsError(errorCodes.permissionDenied, 'denied'),
      new ZToolsError(errorCodes.storageError, 'corrupt'),
      Object.assign(new Error('forged'), { code: errorCodes.databaseKeyNotFound }),
      { code: errorCodes.databaseKeyNotFound },
      'DATABASE_KEY_NOT_FOUND',
      undefined,
      null
    ]) {
      assert.equal(isMissingDatabaseKeyError({ method: 'db_get' }, error), false)
      assert.equal(isMissingDatabaseKeyError({ method: 'db_get_secure' }, error), false)
    }
  })

  test('真实 IpcRouter + LevelDB 端到端链路：db_get 未命中键保持线协议错误码且静默，真实异常仍记录堆栈与警告', async () => {
    await promisify(execFile)(process.execPath, [__filename, '--ipc-missing-key-fixture'], { timeout: 15000 })
  })
}

