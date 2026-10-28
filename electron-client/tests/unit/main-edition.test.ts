import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { EDITION_ENTRY, loadMainEdition, mainEdition, type EditionLoaderIo } from '../../src/main/edition.js'
import { ossEdition } from '../../src/main/edition-oss/index.js'
import type { MainEdition } from '../../src/main/edition-types.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { createCoreServices } from '../../src/main/services/core-services.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { UpdateService } from '../../src/main/services/update-service.js'

// 主进程版本选择与开源版实现：开源版不联网、始终未登录、没有凭据、没有更新来源；
// 其他版本的入口文件不存在时用开源版，入口文件存在但加载失败或导出不合法时必须报错，不能悄悄退化。

async function tempRoot(t: { after(fn: () => Promise<void>): void }, name: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ztools-edition-${name}-`))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

/** 记录期间发生的全部 fetch；开源版任何网络请求都算失败 */
function trapFetch(t: { after(fn: () => void): void }): string[] {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(input instanceof Request ? input.url : String(input))
    throw new Error('开源版不应发出网络请求')
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return calls
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

function loaderIo(exists: boolean, load: () => unknown): EditionLoaderIo & { loaded: string[]; probed: string[] } {
  const loaded: string[] = []
  const probed: string[] = []
  return {
    loaded,
    probed,
    exists(file) { probed.push(file); return exists },
    load(file) { loaded.push(file); return load() }
  }
}

const validCommercial: MainEdition = { id: 'commercial', storeFiles: ['user_account.json'], createServices: ossEdition.createServices }

test('loader uses the open-source edition when the entry file is absent and never tries to load it', () => {
  const io = loaderIo(false, () => { throw new Error('不应加载') })
  assert.equal(loadMainEdition(io), ossEdition)
  assert.deepEqual(io.probed, [EDITION_ENTRY])
  assert.deepEqual(io.loaded, [])
  assert.equal(path.basename(EDITION_ENTRY), 'edition.js')
  assert.equal(path.basename(path.dirname(EDITION_ENTRY)), 'commercial')
})

test('loader refuses to silently downgrade when the entry file exists but cannot load', () => {
  const missingDependency = Object.assign(new Error("Cannot find module '../services/gone.js'"), { code: 'MODULE_NOT_FOUND' })
  assert.throws(() => loadMainEdition(loaderIo(true, () => { throw missingDependency })), /gone\.js/)
  assert.throws(() => loadMainEdition(loaderIo(true, () => { throw new SyntaxError('Unexpected token') })), SyntaxError)
  assert.throws(() => loadMainEdition(loaderIo(true, () => { throw 'boom' })), (error: unknown) => error === 'boom')
})

test('loader rejects malformed exports instead of trusting them', () => {
  assert.equal(loadMainEdition(loaderIo(true, () => ({ mainEdition: validCommercial }))), validCommercial)
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['非对象', 'module'],
    ['空对象', {}],
    ['导出开源版冒充', { mainEdition: ossEdition }],
    ['id 未知', { mainEdition: { ...validCommercial, id: 'enterprise' } }],
    ['缺 createServices', { mainEdition: { id: 'commercial', storeFiles: [] } }],
    ['storeFiles 不是数组', { mainEdition: { ...validCommercial, storeFiles: 'user_account.json' } }],
    ['storeFiles 路径穿越', { mainEdition: { ...validCommercial, storeFiles: ['../../secrets.json'] } }],
    ['storeFiles 子目录', { mainEdition: { ...validCommercial, storeFiles: ['sub/a.json'] } }],
    ['storeFiles 非 JSON', { mainEdition: { ...validCommercial, storeFiles: ['user_account.exe'] } }],
    ['storeFiles 非字符串', { mainEdition: { ...validCommercial, storeFiles: [42] } }]
  ]
  for (const [name, exported] of cases) {
    assert.throws(() => loadMainEdition(loaderIo(true, () => exported)), /导出无效/, name)
  }
})

test('real loader picks the other edition exactly when its compiled entry exists, and loads once per process', () => {
  const expected = fs.existsSync(EDITION_ENTRY) ? 'commercial' : 'oss'
  assert.equal(loadMainEdition().id, expected)
  assert.equal(mainEdition().id, expected)
  assert.equal(mainEdition(), mainEdition(), '进程内只加载一次')
})

test('open-source edition: logged out, no credentials, refuses to store tokens and never touches disk or network', async (t) => {
  const calls = trapFetch(t)
  const root = await tempRoot(t, 'oss-services')
  const store = new JsonFileStore(root, new Set([...ConfigService.allowedStoreFiles, ...ossEdition.storeFiles]))
  const services = ossEdition.createServices({ appVersion: '1.0.0', webVersion: '1.0.0', dataRoot: root, store })

  assert.deepEqual(ossEdition.storeFiles, [])
  assert.deepEqual(await services.user.getInfo(), { success: true, logged_in: false })
  assert.deepEqual(await services.user.getInfo({ includeCredentials: true }), { success: true, logged_in: false }, '宿主调用也拿不到任何凭据')
  assert.equal(await services.user.setToken({ token: 't', refresh_token: 'r', user_id: 'u' }), false)
  assert.deepEqual(await services.user.getInfo(), { success: true, logged_in: false }, '拒绝保存后仍是未登录')
  await services.user.logout()

  // 返回值是副本：调用方改动不会污染下一次结果
  const first = await services.user.getInfo()
  first.logged_in = true
  assert.deepEqual(await services.user.getInfo(), { success: true, logged_in: false })

  // 高频并发交替调用也不会出现登录态
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => index % 3 === 0
    ? services.user.setToken({ token: `t${index}`, refresh_token: '', user_id: `u${index}` })
    : index % 3 === 1 ? services.user.getInfo({ includeCredentials: true }) : services.user.logout()))
  assert.ok(results.every((value) => value === false || value === undefined || (value as Record<string, unknown>).logged_in === false))

  // 统计：所有入口都是空操作，任何输入都不抛错
  assert.doesNotThrow(() => {
    services.analytics.report({ event: 'plugin_open', plugin_id: 'x', web_version: '1' }, { type: 'plugin', webContentsId: 2, pluginId: 'x' })
    services.analytics.reportHost('plugin_install', 'x', { version: '1.0.0' })
    services.analytics.reportPluginOpened('x', { instanceId: 'i' })
    services.analytics.reportLaunch({ launchId: 'l', source: 'installer', installerMode: 'silent' })
    services.analytics.reportStartup()
    services.analytics.stop()
    services.analytics.reportHost('after_stop', '')
  })
  await settle()

  assert.equal(services.updateSource, null, '开源版没有更新来源')
  assert.deepEqual(calls, [], '开源版不能发出任何网络请求')
  assert.deepEqual(await fsp.readdir(root), [], '开源版不能写任何账号或统计文件')
  // 账号文件不在开源版放行的存储文件里
  await assert.rejects(store.read('user_account.json'), ZToolsError)
})

test('open-source edition: update check has no source and makes no request', async (t) => {
  const calls = trapFetch(t)
  const root = await tempRoot(t, 'oss-update')
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const { updateSource } = ossEdition.createServices({ appVersion: '1.0.0', webVersion: '1.0.0', dataRoot: root, store })
  const update = new UpdateService({
    platform: 'win32',
    runtimePaths: runtimePathsForBusinessDataRoot(path.join(root, 'Data')),
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    updateSource
  })
  for (const source of ['startup', 'manual'] as const) {
    assert.deepEqual(await update.check({ source }), { success: true, source, app: null, web: null })
  }
  assert.deepEqual(calls, [])
})

test('open-source edition: shared libraries resolve only from built-in integrity pins', async (t) => {
  const calls = trapFetch(t)
  const root = await tempRoot(t, 'oss-library')
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const { libraryMetadata } = ossEdition.createServices({ appVersion: '1.0.0', webVersion: '1.0.0', dataRoot: root, store })
  const io = {
    signal: new AbortController().signal,
    async fetchText(url: string) { calls.push(url); return { ok: false, status: 599, text: '' } }
  }
  const pinned = await libraryMetadata.resolve('ffmpeg-1.0.0', io)
  assert.equal(pinned.libId, 'ffmpeg-1.0.0')
  assert.match(String(pinned.downloadUrl), /^https:\/\//)
  assert.match(String(pinned.checksum), /^[a-f0-9]{64}$/)
  // 返回副本：改动不会影响内置锚点
  pinned.downloadUrl = 'https://evil.example/x.zip'
  assert.notEqual((await libraryMetadata.resolve('ffmpeg-1.0.0', io)).downloadUrl, 'https://evil.example/x.zip')
  for (const libId of ['toolkit-1.0.0', 'ffmpeg-2.0.0', '../ffmpeg-1.0.0', 'FFMPEG-1.0.0', '']) {
    await assert.rejects(libraryMetadata.resolve(libId, io), (error: unknown) =>
      error instanceof ZToolsError && error.code === errorCodes.notSupported, libId)
  }
  assert.deepEqual(calls, [], '内置锚点之外不请求任何地址')
})

test('core services wire the open-source edition end to end', async (t) => {
  const calls = trapFetch(t)
  const root = await tempRoot(t, 'oss-core')
  const core = createCoreServices(runtimePathsForBusinessDataRoot(root), '1.0.0', '1.0.0', null, null, null, null, ossEdition)
  try {
    assert.equal(core.edition, 'oss')
    assert.deepEqual(await core.user.getInfo({ includeCredentials: true }), { success: true, logged_in: false })
    assert.equal(await core.user.setToken({ token: 't', refresh_token: 'r', user_id: 'u' }), false)
    core.analytics.reportStartup()
    core.analytics.reportPluginOpened('kill-process')
    if (process.platform === 'win32') {
      assert.deepEqual(await core.update.check({ source: 'startup' }), { success: true, source: 'startup', app: null, web: null })
    }
    await assert.rejects(core.config.get('user_account.json', 'current_token', ''), (error: unknown) =>
      error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
    await settle()
    assert.deepEqual(calls, [])
    assert.equal(fs.existsSync(path.join(root, 'user_account.json')), false)
  } finally {
    await core.stop()
  }
})

test('router keeps the shared IPC names; saving a login without account support reports logged out', async () => {
  const routerSource = await fsp.readFile(path.resolve('src', 'main', 'ipc', 'router.ts'), 'utf8')
  const handler = /async user_set_token\(params\) \{[\s\S]*?\n      \},/.exec(routerSource)?.[0] ?? ''
  assert.notEqual(handler, '', '未找到 user_set_token 处理函数')
  assert.match(handler, /saved \? \{ success: true \} : \{ success: false, logged_in: false \}/)
  for (const method of ['user_get_info', 'user_logout', 'analytics_report']) {
    assert.match(routerSource, new RegExp(`async ${method}\\(`), method)
  }
})

// 路由的接线：行为测试在 plugin-uninstall-flow.test 与 account-events.test，这里守住路由确实接到了这两处
test('router wiring: account events after saving / clearing credentials, uninstall through the cleanup flow', async () => {
  const routerSource = await fsp.readFile(path.resolve('src', 'main', 'ipc', 'router.ts'), 'utf8')
  const handlerOf = (method: string) =>
    new RegExp(`async ${method}\\(params\\) \\{[\\s\\S]*?\\n      \\},`).exec(routerSource)?.[0] ??
    new RegExp(`async ${method}\\(\\) \\{[\\s\\S]*?\\n      \\},`).exec(routerSource)?.[0] ?? ''

  const setToken = handlerOf('user_set_token')
  assert.match(setToken, /if \(saved\) notifyAccountChanged\('user\.login'\)/, '只有真正保存后才通知登录')
  const logout = handlerOf('user_logout')
  assert.match(logout, /await services\.user\.logout\(\)[\s\S]*notifyAccountChanged\('user\.logout'\)/, '清除凭据后才通知退出')
  assert.match(routerSource, /publishAccountChanged\(events, type\)/)

  const uninstall = handlerOf('plugin_uninstall')
  assert.match(uninstall, /return uninstallPluginWithCleanup\(input\.pluginId, \{/)
  assert.match(uninstall, /planShortcutCleanup: \(pluginId\) => pluginShortcuts\.planUninstallCleanup\(pluginId\)/)
  assert.doesNotMatch(uninstall, /pluginShortcuts\.remove\(/, '卸载不能再先删快捷方式（macOS 会直接抛不支持）')
  assert.doesNotMatch(uninstall, /await triggers\.removePlugin\(/, '快捷键只能在卸载成功后由清理流程删除')
})
