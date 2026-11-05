import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MacAppUpdater, type MacAutoUpdater, type MacUpdateCommand } from '../../src/main/platform/macos/app-update.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { UpdateService } from '../../src/main/services/update-service.js'
import { WebResourceService } from '../../src/main/services/web-resource-service.js'

class NativeUpdater extends EventEmitter {
  feedUrl = ''
  mode: 'success' | 'error' | 'hang' = 'success'
  archive: Buffer | undefined
  restarted = 0
  feedRequests = 0
  setFeedURL(options: { url: string }): void { this.feedUrl = options.url }
  checkForUpdates(): void {
    if (this.mode === 'hang') return
    void this.consume().catch(error => this.emit('error', error))
  }
  async consume(): Promise<void> {
    this.feedRequests++
    const feed = await fetch(this.feedUrl)
    const body = await feed.json() as { url: string }
    const unknown = await fetch(new URL('/wrong-token/update.zip', this.feedUrl))
    assert.equal(unknown.status, 404)
    const response = await fetch(body.url)
    this.archive = Buffer.from(await response.arrayBuffer())
    if (this.mode === 'error') this.emit('error', new Error('原生签名校验失败'))
    else this.emit('update-downloaded')
  }
  quitAndInstall(): void { this.restarted++ }
}

async function fixture(t: test.TestContext, options: {
  releaseVersion?: string; shortVersion?: string; buildVersion?: string; bundleId?: string
  failTool?: string; nativeTimeoutMs?: number
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-mac-update-'))
  const current = path.join(root, 'ZTools.app')
  await fs.mkdir(current)
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const native = new NativeUpdater()
  const commands: { file: string; args: string[] }[] = []
  const runCommand: MacUpdateCommand = async (file, args, signal) => {
    signal?.throwIfAborted()
    commands.push({ file, args })
    if (file === options.failTool) throw new Error('工具执行失败')
    if (file.endsWith('/hdiutil') && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1]!
      await fs.mkdir(path.join(mount, 'ZTools.app'))
    }
    if (file.endsWith('/hdiutil') && args[0] === 'detach') {
      await fs.rmdir(path.join(args.at(-1)!, 'ZTools.app'))
    }
    if (file.endsWith('/plutil')) {
      const candidate = args.at(-1) !== path.join(current, 'Contents', 'Info.plist')
      const values: Record<string, string> = {
        CFBundleIdentifier: candidate ? options.bundleId ?? 'cn.ztools.test' : 'cn.ztools.test',
        CFBundleShortVersionString: options.shortVersion ?? '1.1.8',
        CFBundleVersion: options.buildVersion ?? '1.1.8009'
      }
      const value = values[args[1]!]
      assert.notEqual(value, undefined, '只允许读取预期的包元数据')
      return { stdout: value!, stderr: '' }
    }
    if (file.endsWith('/codesign') && args[0] === '--display') {
      return { stdout: 'designated => identifier "cn.ztools.test" and anchor apple generic', stderr: 'TeamIdentifier=ABCDEFGHIJ' }
    }
    if (file.endsWith('/ditto')) await fs.writeFile(args.at(-1)!, 'verified signed application zip')
    return { stdout: '', stderr: '' }
  }
  let quitRequests = 0
  const updater = new MacAppUpdater({ appPath: current, isPackaged: true, stagingRoot: path.join(root, 'staging'),
    autoUpdater: native as unknown as MacAutoUpdater, requestQuit: () => { quitRequests++ },
    reportRestartError: () => assert.fail('不应出现重启错误'), runCommand,
    ...(options.nativeTimeoutMs ? { nativeTimeoutMs: options.nativeTimeoutMs } : {}) })
  const payload = Buffer.from('verified dmg payload')
  const params = { type: 'app' as const, version: options.releaseVersion ?? '1.1.8.9', downloadUrl: 'https://updates.example/ZTools.dmg',
    fileSize: payload.length, checksum: createHash('sha256').update(payload).digest('hex') }
  let fetches = 0
  const service = new UpdateService({ platform: 'darwin', runtimePaths, appVersion: '1.1.8.8', webVersion: '1.1.8.8', macUpdater: updater,
    fetchImpl: async () => { fetches++; return new Response(payload, { headers: { 'content-length': String(payload.length) } }) } })
  t.after(async () => { await service.stop(); updater.dispose(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, current, runtimePaths, params, service, updater, native, commands, get fetches() { return fetches }, get quitRequests() { return quitRequests } }
}

test('Mac 下载校验、只读挂载、签名与版本检查、本机 feed、原生重启完整协作', async t => {
  const f = await fixture(t)
  const progress: number[] = []
  f.service.onProgress(event => progress.push(event.percent))
  const [first, second] = await Promise.all([f.service.download(f.params), f.service.download(f.params)])
  assert.equal(first.operationId, second.operationId)
  assert.equal(f.fetches, 1)
  assert.equal(path.extname(first.path), '.dmg')
  assert.equal(progress.at(-1), 100)
  const result = await f.service.install(f.params)
  assert.equal(result.state, 'started')
  assert.equal(result.restartRequired, true)
  assert.equal(f.native.archive?.toString(), 'verified signed application zip')
  assert.equal(f.native.feedRequests, 1)
  assert.ok(f.commands.find(command => command.file.endsWith('/hdiutil') && command.args.includes('-readonly')))
  assert.ok(f.commands.find(command => command.file.endsWith('/codesign') && command.args.includes('-R')))
  assert.deepEqual(await fs.readdir(path.join(f.root, 'staging')), [])
  assert.deepEqual(await fs.readdir(f.current), [])
  assert.equal(f.service.cancel().installing, true)
  await assert.rejects(f.service.install(f.params), /已交接/)
  await assert.rejects(fetch(f.native.feedUrl))
  await new Promise(resolve => setTimeout(resolve, 175))
  assert.equal(f.quitRequests, 1)
  await f.service.stop()
  assert.equal(f.updater.quitAndInstall(), true)
  assert.equal(f.native.restarted, 1)
  assert.equal(f.updater.quitAndInstall(), false)
})

test('Mac 下载 SHA 错误或本地包被替换时拒绝挂载，不改动旧应用', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.download({ ...f.params, checksum: '0'.repeat(64) }))
  const download = await f.service.download(f.params)
  await fs.writeFile(download.path, 'corrupted package')
  await assert.rejects(f.service.install(f.params))
  assert.equal(f.commands.length, 0)
  assert.equal(f.native.feedRequests, 0)
  assert.equal(f.quitRequests, 0)
})

test('四段发布版本按真实 Mac 显示版本与构建号校验，包括第四段两位数及跨补丁边界', async t => {
  for (const [releaseVersion, shortVersion, buildVersion] of [
    ['1.1.8.10', '1.1.8', '1.1.8010'],
    ['1.1.8.999', '1.1.8', '1.1.8999'],
    ['1.1.9.0', '1.1.9', '1.1.9000'],
    ['2.0.0.0', '2.0.0', '2.0.0']
  ] as const) {
    const f = await fixture(t, { releaseVersion, shortVersion, buildVersion })
    await f.service.download(f.params)
    assert.equal((await f.service.install(f.params)).success, true)
    assert.equal(f.native.feedRequests, 1)
    assert.ok(f.commands.some(command => command.file.endsWith('/plutil') && command.args[1] === 'CFBundleVersion'))
  }
})

test('1.1.8.10 更新不能接受同显示版本的旧构建或其他构建', async t => {
  for (const buildVersion of ['1.1.8009', '1.1.8011']) {
    const f = await fixture(t, { releaseVersion: '1.1.8.10', buildVersion })
    await f.service.download(f.params)
    await assert.rejects(f.service.install(f.params), {
      code: 'DATA_CORRUPT', message: '更新包中的应用标识或版本与发布信息不一致'
    })
    assert.equal(f.native.feedRequests, 0)
    assert.equal(f.quitRequests, 0)
    assert.deepEqual(await fs.readdir(path.join(f.root, 'staging')), [])
    assert.deepEqual(await fs.readdir(f.current), [])
  }
})

test('Mac 拒绝错误版本及签名失败，卸载映像并保留旧版', async t => {
  for (const options of [
    { shortVersion: '1.1.7' }, { buildVersion: '1.1.8008' }, { bundleId: 'cn.other.app' },
    { failTool: '/usr/bin/plutil' }, { failTool: '/usr/bin/codesign' }, { failTool: '/usr/bin/ditto' }
  ]) {
    const f = await fixture(t, options)
    await f.service.download(f.params)
    await assert.rejects(f.service.install(f.params))
    assert.equal(f.native.feedRequests, 0)
    assert.equal(f.quitRequests, 0)
    assert.deepEqual(await fs.readdir(path.join(f.root, 'staging')), [])
    assert.deepEqual(await fs.readdir(f.current), [])
  }
})

test('无效四段发布版本不能交给原生更新器，挂载目录正确清理', async t => {
  for (const version of ['1.1.8', '1.1.8.1000', '01.1.8.9', '1.1.8.-1', '1.1.9007199254740991.9']) {
    const f = await fixture(t)
    await assert.rejects(f.updater.prepare(path.join(f.root, 'update.dmg'), version, new AbortController().signal),
      { code: 'DATA_CORRUPT', message: 'macOS 更新发布版本号无效' })
    assert.equal(f.native.feedRequests, 0)
    assert.equal(f.quitRequests, 0)
    assert.deepEqual(await fs.readdir(path.join(f.root, 'staging')), [])
    assert.deepEqual(await fs.readdir(f.current), [])
  }
})

test('原生校验失败不返回成功，保留下载包供重试', async t => {
  const f = await fixture(t)
  f.native.mode = 'error'
  const downloaded = await f.service.download(f.params)
  await assert.rejects(f.service.install(f.params), /原生签名校验失败/)
  assert.equal(f.quitRequests, 0)
  await fs.access(downloaded.path)
  f.native.mode = 'success'
  assert.equal((await f.service.install(f.params)).success, true)
  assert.equal(f.fetches, 1)
})

test('原生超时后保留错误监听并禁止重复安装，迟到成功可在下次退出安装', async t => {
  const f = await fixture(t, { nativeTimeoutMs: 30 })
  f.native.mode = 'hang'
  await f.service.download(f.params)
  await assert.rejects(f.service.install(f.params), /超时/)
  await assert.rejects(fetch(f.native.feedUrl))
  await assert.rejects(f.service.install(f.params), /正在安装/)
  assert.equal(f.native.listenerCount('error'), 1)
  f.native.emit('update-downloaded')
  assert.equal(f.quitRequests, 0)
  assert.equal(f.updater.quitAndInstall(), true)
})

test('应用退出能中止无响应的原生交接，迟到错误不会变成未处理事件', async t => {
  const f = await fixture(t)
  f.native.mode = 'hang'
  await f.service.download(f.params)
  const install = f.service.install(f.params)
  const rejected = assert.rejects(install)
  while (!f.native.feedUrl) await new Promise(resolve => setTimeout(resolve, 5))
  await f.service.stop()
  await rejected
  await assert.rejects(fetch(f.native.feedUrl))
  f.native.emit('error', new Error('退出后迟到的下载失败'))
  assert.equal(f.quitRequests, 0)
  assert.equal(f.updater.quitAndInstall(), false)
})

test('开发环境、DMG 运行和 App Translocation 在下载前拒绝；Mac 不允许 Web 更新', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.download({ ...f.params, type: 'web' }))
  for (const [isPackaged, appPath] of [[false, f.current], [true, '/Volumes/ZTools/ZTools.app'], [true, '/private/tmp/AppTranslocation/test/ZTools.app']] as const) {
    const updater = new MacAppUpdater({ isPackaged, appPath, stagingRoot: f.root,
      autoUpdater: f.native as unknown as MacAutoUpdater, requestQuit: () => assert.fail(), reportRestartError: () => assert.fail() })
    try { assert.throws(() => updater.assertSupported()) } finally { updater.dispose() }
  }
  assert.equal(f.fetches, 0)
})

test('Mac 仅在已校验新版启动后清理已消费的 DMG', async t => {
  const f = await fixture(t)
  const downloaded = await f.service.download(f.params)
  const next = new UpdateService({ platform: 'darwin', runtimePaths: f.runtimePaths, appVersion: '1.1.8.9', webVersion: '1.1.8.9' })
  await next.cleanupConsumedDownloads()
  await assert.rejects(fs.access(downloaded.path))
  await next.stop()
})


test('真实 HTTP 下载在 IPC 中止后取消响应流并删除半包，不进入安装', async t => {
  const f = await fixture(t)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': 2 })
    response.write('a')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const service = new UpdateService({ platform: 'darwin', runtimePaths: f.runtimePaths, appVersion: '1.1.8.8', webVersion: '1.1.8.8', macUpdater: f.updater })
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const controller = new AbortController()
  service.onProgress(progress => { if (progress.downloaded > 0) controller.abort() })
  await assert.rejects(service.download({ ...f.params, fileSize: 2, downloadUrl: `http://127.0.0.1:${address.port}/update.dmg` }, controller.signal))
  assert.deepEqual(await fs.readdir(path.join(f.runtimePaths.transactionRoot, 'Downloads')), [])
  assert.equal(f.native.feedRequests, 0)
})


test('正文停止发送后下载总超时会关闭真实 HTTP 连接，不会无限等待', async t => {
  const f = await fixture(t)
  const nativeSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 3_600_000) args[1] = 500
    return nativeSetTimeout(...args)
  }) as typeof setTimeout)
  let responseClosed = false
  const server = createServer((_request, response) => {
    response.on('close', () => { responseClosed = true })
    response.writeHead(200, { 'Content-Length': 2 })
    response.write('a')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const service = new UpdateService({ platform: 'darwin', runtimePaths: f.runtimePaths, appVersion: '1.1.8.8', webVersion: '1.1.8.8', macUpdater: f.updater })
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  let bodyStarted = false
  service.onProgress(progress => { bodyStarted ||= progress.downloaded > 0 })
  await assert.rejects(service.download({ ...f.params, fileSize: 2, downloadUrl: `http://127.0.0.1:${address.port}/update.dmg` }), /超时/)
  for (let i = 0; i < 20 && !responseClosed; i++) await new Promise(resolve => nativeSetTimeout(resolve, 5))
  assert.equal(bodyStarted, true)
  assert.equal(responseClosed, true)
  assert.deepEqual(await fs.readdir(path.join(f.runtimePaths.transactionRoot, 'Downloads')), [])
})

for (const type of ['app', 'web'] as const) {
  test(`直接安装 ${type} 在下载途中取消时关闭连接，不进入安装`, async t => {
    const f = await fixture(t)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': 2 })
      response.write('a')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const service = new UpdateService({ platform: 'win32', runtimePaths: f.runtimePaths, appVersion: '1.1.8.8', webVersion: '1.1.8.8',
      webResources: new WebResourceService({ bundledRoot: f.root, runtimePaths: f.runtimePaths }),
      runUpdaterImpl: async () => { assert.fail('取消后不得交给安装器') } })
    t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const controller = new AbortController()
    service.onProgress(progress => { if (progress.downloaded > 0) controller.abort(new Error('用户中止直接安装')) })
    await assert.rejects(service.install({ ...f.params, type, fileSize: 2, downloadUrl: `http://127.0.0.1:${address.port}/update.zip` }, controller.signal), /用户中止直接安装/)
    assert.deepEqual(await fs.readdir(path.join(f.runtimePaths.transactionRoot, 'Downloads')), [])
  })
}

test('Mac 清理损坏元数据遗留的 DMG 孤儿文件', async t => {
  const f = await fixture(t)
  const downloads = path.join(f.runtimePaths.transactionRoot, 'Downloads')
  await fs.mkdir(downloads, { recursive: true })
  await fs.writeFile(path.join(downloads, 'app-orphan.dmg'), 'incomplete')
  await fs.writeFile(path.join(downloads, 'app-orphan.dmg.json'), '{broken')
  await f.service.cleanupConsumedDownloads({ needCleanup: true })
  assert.deepEqual(await fs.readdir(downloads), [])
})
