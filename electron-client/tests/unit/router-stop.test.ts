import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { CoreServices } from '../../src/main/services/core-services.js'
import type { IpcRouterOptions } from '../../src/main/ipc/router.js'

// 独立 Node 子进程隔离 Electron 替身，不启动 Electron、原生辅助进程或系统剪贴板。
async function stopFixture(failFolderCleanup: boolean): Promise<void> {
  const modules = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown }
  const load = modules._load
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  const electron = { nativeTheme, ipcMain: new EventEmitter(), shell: {}, BrowserWindow: {},
    globalShortcut: { isRegistered: () => false, isSuspended: () => false }, app: { isReady: () => true } }
  modules._load = function (name, ...args) { return name === 'electron' ? electron : load.call(this, name, ...args) }
  const { IpcRouter } = require('../../src/main/ipc/router.js') as typeof import('../../src/main/ipc/router.js')
  const { runtimePathsForBusinessDataRoot } = require('../../src/main/runtime/runtime-paths.js') as typeof import('../../src/main/runtime/runtime-paths.js')
  const { FolderSyncService } = require('../../src/main/services/folder-sync-service.js') as typeof import('../../src/main/services/folder-sync-service.js')
  const { FontManagerService } = require('../../src/main/services/font-manager-service.js') as typeof import('../../src/main/services/font-manager-service.js')
  const { MediaMetadataService } = require('../../src/main/services/media-metadata-service.js') as typeof import('../../src/main/services/media-metadata-service.js')
  const { OfficeDocumentService } = require('../../src/main/services/office-document-service.js') as typeof import('../../src/main/services/office-document-service.js')
  modules._load = load
  const calls = { folder: 0, fonts: 0, media: 0, office: 0 }
  let releaseFolder: () => void = () => {}
  const gate = new Promise<void>(resolve => { releaseFolder = resolve })
  const stopFolder = FolderSyncService.prototype.stop
  FolderSyncService.prototype.stop = async function () {
    calls.folder++; await gate; await stopFolder.call(this)
    if (failFolderCleanup) throw new Error('TEST_FOLDER_CLEANUP_FAILED')
  }
  const stopFonts = FontManagerService.prototype.stop
  FontManagerService.prototype.stop = function () { calls.fonts++; stopFonts.call(this) }
  const stopMedia = MediaMetadataService.prototype.stop
  MediaMetadataService.prototype.stop = function () { calls.media++; stopMedia.call(this) }
  const stopOffice = OfficeDocumentService.prototype.stop
  OfficeDocumentService.prototype.stop = function () { calls.office++; stopOffice.call(this) }

  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-router-stop-'))
  const removedListeners = new Set<(id: number) => void>()
  const registry = { onRemoved(listener: (id: number) => void) {
    removedListeners.add(listener); return () => { removedListeners.delete(listener) }
  }, list() { return [] } }
  const nativeHost = { state: 'ready', onDllEvent() { return () => {} }, onInputEvent() { return () => {} },
    onLifecycleEvent() { return () => {} }, async configureMouseTrigger() {} }
  const services = {
    dataRoot, runtimePaths: runtimePathsForBusinessDataRoot(dataRoot), appVersion: 'test', webVersion: 'test',
    config: { async get() { return JSON.stringify({ enabled: false }) }, async setSetting() {} },
    user: {}, analytics: { stop() {} }, clipboardHistory: { useImageThumbnailer() {} }, nativeHost, serviceClient: null,
    update: { onProgress() { return () => {} } }, async stop() {}
  } as unknown as CoreServices
  const options = {
    toggleMainWindow() {}, toggleSuperPanel() {}, async getPanelLocalApps() { return [] }, closeConfirmationResolved() {},
    screenClipboardAdapters: {},
    pluginResources: { pluginRoot: path.join(dataRoot, 'Plugins'), ztoolsApiPath: 'missing-sdk', preloadPath: 'missing-preload' },
    systemPlatformAdapter: { userDataPath: dataRoot, getRuntimeTarget() {
      return { platform: process.platform, runtime: 'electron', arch: process.arch }
    }, async getNativeId() { return '' } }, processDiscoveryAdapter: { async list() { return [] } }
  } as unknown as IpcRouterOptions
  const mainApp = { getPath: () => dataRoot, getAppPath: () => dataRoot, isPackaged: false,
    runningUnderARM64Translation: false, async getFileIcon() { return { toDataURL: () => '' } }
  } as unknown as Parameters<typeof IpcRouter.create>[3]
  let router: Awaited<ReturnType<typeof IpcRouter.create>> | undefined
  try {
    router = await IpcRouter.create(registry as never, services, options, mainApp)
    assert.ok(removedListeners.size > 0)
    const pending = router.stop()
    assert.equal(router.stop(), pending, '重复停止必须共用同一清理任务')
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, { folder: 1, fonts: 1, media: 1, office: 1 })
    assert.equal(settled, false, '必须等待目录同步资源释放完成')
    releaseFolder()
    if (failFolderCleanup) await assert.rejects(pending, error => error instanceof AggregateError &&
      error.errors.some(item => item instanceof Error && item.message === 'TEST_FOLDER_CLEANUP_FAILED'))
    else await pending
    assert.equal(removedListeners.size, 0, '服务失败也必须注销全部窗口关闭监听')
    assert.equal(nativeTheme.listenerCount('updated'), 0)
    assert.deepEqual(calls, { folder: 1, fonts: 1, media: 1, office: 1 })
  } finally {
    releaseFolder()
    await router?.stop().catch(() => {})
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--router-stop-fixture') {
  void stopFixture(process.argv[3] === 'failure').catch(error => { console.error(error); process.exitCode = 1 })
} else {
  for (const scenario of ['success', 'failure']) {
    test(`生产路由正常停止回收四服务与监听，等待清理且隔离单项失败：${scenario}`, async () => {
      await promisify(execFile)(process.execPath, [__filename, '--router-stop-fixture', scenario], { timeout: 15000 })
    })
  }
}
