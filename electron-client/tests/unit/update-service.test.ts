import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { UpdateService, type UpdateSource } from '../../src/main/services/update-service.js'
import { getLocaleSetting, getResolvedLocale, setLocale } from '../../src/main/i18n/index.js'

// Windows 更新器只在进程边界替换；路径、文件与下载服务使用真实实现，可跨平台回归。
// 更新来源由主进程版本提供；这里用一个经测试 fetch 读取的通用来源，覆盖与版本无关的校验、比较与下载链路
const TEST_LATEST_URL = 'https://updates.example/latest.json'
function testUpdateSource(fetchImpl: typeof fetch): UpdateSource {
  return {
    async fetchLatest({ signal }) {
      const response = await fetchImpl(TEST_LATEST_URL, { signal })
      return await response.json() as unknown
    }
  }
}


test('update service preserves the legacy response shape and verifies downloads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-service-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const body = Buffer.from('verified installer payload')
  const checksum = createHash('sha256').update(body).digest('hex')
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === TEST_LATEST_URL) {
      return new Response(JSON.stringify({
        app: { version: '2.0.0', url: 'https://cdn.example/ZToolsSetup.exe', file_size: body.length, checksum },
        web: {
          version: '2.0.0',
          url: 'https://cdn.example/web.zip',
          file_size: 0,
          checksum: '',
          min_app_version: '1.0.0'
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
  }
  const service = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    updateSource: testUpdateSource(fetchImpl),
    fetchImpl
  })
  const progress: number[] = []
  const removeProgressListener = service.onProgress((event) => progress.push(event.percent))

  const checked = await service.check({ source: 'manual' })
  assert.equal(checked.success, true)
  assert.equal(checked.app?.downloadUrl, 'https://cdn.example/ZToolsSetup.exe')
  assert.equal(checked.app?.fileSize, body.length)
  assert.equal(checked.web?.version, '2.0.0')
  assert.equal(checked.web?.minAppVersion, '1.0.0')

  const downloaded = await service.download({
    type: 'app',
    version: '2.0.0',
    downloadUrl: 'https://cdn.example/ZToolsSetup.exe',
    checksum,
    fileSize: body.length
  })
  assert.equal(await fs.readFile(downloaded.path, 'utf8'), body.toString('utf8'))
  assert.ok(progress.length >= 2)
  assert.equal(progress.at(-1), 100)
  const restartedService = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl
  })
  const restarted = await restartedService.download({
    type: 'app',
    version: '2.0.0',
    downloadUrl: 'https://cdn.example/ZToolsSetup.exe',
    checksum,
    fileSize: body.length
  })
  assert.equal(restarted.operationId, downloaded.operationId)
  assert.equal(calls.length, 2)
  const repeated = await service.download({
    type: 'app',
    version: '2.0.0',
    downloadUrl: 'https://cdn.example/ZToolsSetup.exe',
    checksum,
    fileSize: body.length
  })
  assert.equal(repeated.operationId, downloaded.operationId)
  assert.equal(calls.length, 2)
  const cancelled = service.cancel()
  assert.deepEqual(cancelled.cancelled, [downloaded.operationId])
  // cancel() 触发异步 fs.rm 清理，在并发测试磁盘负载下有界轮询等待删除落盘
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const stillExists = await fs.access(downloaded.path).then(() => true, () => false)
    if (!stillExists) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await assert.rejects(fs.access(downloaded.path))
  removeProgressListener()
  await fs.rm(root, { recursive: true, force: true })
})

test('web package installation requires the independent resource service', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-web-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const service = new UpdateService({
    platform: 'win32',
    runtimePaths: runtimePathsForBusinessDataRoot(path.join(root, 'Data')),
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl: async () => new Response(Buffer.from('unused'))
  })
  await assert.rejects(
    service.install({
      type: 'web',
      version: '2.0.0',
      downloadUrl: 'https://cdn.example/web.zip',
      checksum: '',
      fileSize: 0
    }),
    /Web 更新资源服务尚未启用/
  )
  await fs.rm(root, { recursive: true, force: true })
})

test('App package formats leave install-scope resolution to the native updater', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-updater-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  await fs.mkdir(runtimePaths.installRoot, { recursive: true })
  await fs.writeFile(path.join(runtimePaths.installRoot, 'ZToolsUpdater.exe'), 'updater')
  const payload = Buffer.from('verified package')
  const checksum = createHash('sha256').update(payload).digest('hex')
  const launches: Array<{
    executable: string
    argumentsList: string[]
    cwd: string
    updaterContents: string
  }> = []
  const createService = () => new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl: async () => new Response(payload, { status: 200 }),
    runUpdaterImpl: async (executable, argumentsList, cwd) => {
      launches.push({ executable, argumentsList, cwd, updaterContents: await fs.readFile(executable, 'utf8') })
      return 0
    }
  })

  for (const extension of ['exe', 'zip']) {
    const service = createService()
    const downloadUrl = `https://cdn.example/ZToolsSetup.${extension}`
    const result = await service.install({
      type: 'app',
      version: `2.0.${extension === 'exe' ? '0' : '1'}`,
      downloadUrl,
      checksum,
      fileSize: payload.length
    })
    const launch = launches.at(-1)
    assert.equal(result.success, true)
    assert.ok(launch)
    assert.equal(path.basename(launch.executable), 'ZToolsUpdater.exe')
    assert.equal(launch.argumentsList[0]?.startsWith('--source='), true)
    assert.equal(path.extname(launch.argumentsList[0]?.slice('--source='.length) ?? ''), `.${extension}`)
    assert.equal(launch.argumentsList[1], `--target=${runtimePaths.installRoot}`)
    assert.deepEqual(launch.argumentsList.slice(2), ['--updated', '--need-cleanup', `--lang=${getResolvedLocale()}`])
    assert.equal(launch.cwd, path.dirname(launch.executable))
    assert.equal(launch.updaterContents, 'updater')
    await assert.rejects(service.install({ type: 'app', version: '3.0.0', downloadUrl, checksum, fileSize: payload.length }), /已交接/)
    await service.stop()
  }

  await fs.rm(root, { recursive: true, force: true })
})

test('UAC cancellation and updater launch failures remain visible and retryable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-updater-errors-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  await fs.mkdir(runtimePaths.installRoot, { recursive: true })
  await fs.writeFile(path.join(runtimePaths.installRoot, 'ZToolsUpdater.exe'), 'updater')
  const payload = Buffer.from('verified package')
  const checksum = createHash('sha256').update(payload).digest('hex')
  let launchError: Error | undefined = new Error('spawn ENOENT')
  let exitCode = 1223
  let downloadCalls = 0
  const service = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl: async () => {
      downloadCalls += 1
      return new Response(payload, { status: 200 })
    },
    runUpdaterImpl: async () => {
      if (launchError) throw launchError
      return exitCode
    }
  })
  const params = {
    type: 'app' as const,
    version: '2.0.0',
    downloadUrl: 'https://cdn.example/ZToolsSetup.exe',
    checksum,
    fileSize: payload.length
  }

  await assert.rejects(service.install(params), (error: unknown) =>
    error instanceof ZToolsError &&
    error.code === errorCodes.processError &&
    error.message.includes('准备应用更新失败: spawn ENOENT')
  )
  launchError = undefined
  await assert.rejects(service.install(params), (error: unknown) =>
    error instanceof ZToolsError &&
    error.code === errorCodes.cancelled &&
    error.message.includes('用户取消了 UAC 授权')
  )
  exitCode = 7
  await assert.rejects(service.install(params), (error: unknown) =>
    error instanceof ZToolsError &&
    error.code === errorCodes.processError &&
    error.message.includes('退出代码 7')
  )
  exitCode = 0
  const retried = await service.install(params)
  assert.equal(retried.success, true)
  assert.equal(downloadCalls, 1)
  await fs.rm(root, { recursive: true, force: true })
})

test('Windows app update falls back to direct .exe installer when ZToolsUpdater.exe is missing or blocked by policy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-direct-fallback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  await fs.mkdir(runtimePaths.installRoot, { recursive: true })
  const payload = Buffer.from('verified setup exe')
  const checksum = createHash('sha256').update(payload).digest('hex')
  const launches: Array<{ executable: string; argumentsList: string[]; cwd: string }> = []

  // 1) 便携版安装目录缺失 ZToolsUpdater.exe 时，.exe 包自动回退直装，而 .zip 包拒绝作为进程启动
  const portableZipService = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl: async () => new Response(payload, { status: 200 }),
    runUpdaterImpl: async (executable, argumentsList, cwd) => {
      launches.push({ executable, argumentsList, cwd })
      return 0
    }
  })
  await assert.rejects(
    portableZipService.install({
      type: 'app',
      version: '2.0.0',
      downloadUrl: 'https://cdn.example/ZToolsPortable.zip',
      checksum,
      fileSize: payload.length
    }),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.processError
  )
  assert.equal(launches.length, 0)
  await portableZipService.stop()

  const portableExeService = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl: async () => new Response(payload, { status: 200 }),
    runUpdaterImpl: async (executable, argumentsList, cwd) => {
      launches.push({ executable, argumentsList, cwd })
      return 0
    }
  })
  const directRes = await portableExeService.install({
    type: 'app',
    version: '2.0.0',
    downloadUrl: 'https://cdn.example/ZToolsSetup.exe',
    checksum,
    fileSize: payload.length
  })
  assert.equal(directRes.success, true)
  assert.equal(launches.length, 1)
  assert.equal(path.extname(launches[0]?.executable ?? '').toLowerCase(), '.exe')
  assert.notEqual(path.basename(launches[0]?.executable ?? ''), 'ZToolsUpdater.exe')
  assert.deepEqual(launches[0]?.argumentsList, [
    '/S',
    `/D=${runtimePaths.installRoot}`,
    '--updated',
    '--need-cleanup',
    `--lang=${getResolvedLocale()}`
  ])
  await portableExeService.stop()

  // 2) ZToolsUpdater.exe 存在但临时目录执行被系统策略拦截（EACCES）时，自动回退直接运行已校验安装包
  await fs.writeFile(path.join(runtimePaths.installRoot, 'ZToolsUpdater.exe'), 'updater')
  launches.length = 0
  const policyBlockedService = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
    fetchImpl: async () => new Response(payload, { status: 200 }),
    runUpdaterImpl: async (executable, argumentsList, cwd) => {
      launches.push({ executable, argumentsList, cwd })
      if (path.basename(executable) === 'ZToolsUpdater.exe') {
        const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
        throw err
      }
      return 0
    }
  })
  const policyRes = await policyBlockedService.install({
    type: 'app',
    version: '2.0.1',
    downloadUrl: 'https://cdn.example/ZToolsSetup-2.0.1.exe',
    checksum,
    fileSize: payload.length
  })
  assert.equal(policyRes.success, true)
  assert.equal(launches.length, 2)
  assert.equal(path.basename(launches[0]?.executable ?? ''), 'ZToolsUpdater.exe')
  assert.deepEqual(launches[1]?.argumentsList, [
    '/S',
    `/D=${runtimePaths.installRoot}`,
    '--updated',
    '--need-cleanup',
    `--lang=${getResolvedLocale()}`
  ])
  await policyBlockedService.stop()

  await fs.rm(root, { recursive: true, force: true })
})

test('update service compares all four numeric version components and rejects malformed versions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-version-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const service = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0.9',
    webVersion: '1.0.0.9',
    updateSource: testUpdateSource(async () => new Response(JSON.stringify({
      app: { version: '1.0.0.10', url: 'https://cdn.example/ZToolsSetup.exe', file_size: 0 },
      web: { version: '1.0.0.8', url: 'https://cdn.example/web.zip', file_size: 0 }
    }), { status: 200 }))
  })
  const checked = await service.check({ source: 'manual' })
  assert.equal(checked.app?.version, '1.0.0.10')
  assert.equal(checked.web, null)

  const malformed = new UpdateService({
    platform: 'win32',
    runtimePaths,
    appVersion: '1.0.0.9',
    webVersion: '1.0.0.9',
    updateSource: testUpdateSource(async () => new Response(JSON.stringify({
      app: { version: 'release-latest', url: 'https://cdn.example/ZToolsSetup.exe', file_size: 0 }
    }), { status: 200 }))
  })
  await assert.rejects(malformed.check({ source: 'manual' }), /版本格式无效/)
  await fs.rm(root, { recursive: true, force: true })
})

test('update check without a source makes no request; source faults surface as typed errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-source-'))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const base = { platform: 'win32' as const, runtimePaths, appVersion: '1.0.0', webVersion: '1.0.0' }
  try {
    let fetched = 0
    const countingFetch = (async () => { fetched += 1; return new Response('{}') }) as typeof fetch
    for (const updateSource of [undefined, null]) {
      const noSource = new UpdateService({ ...base, fetchImpl: countingFetch, ...(updateSource === null ? { updateSource } : {}) })
      for (const source of ['startup', 'manual'] as const) {
        assert.deepEqual(await noSource.check({ source }), { success: true, source, app: null, web: null })
      }
    }
    assert.equal(fetched, 0, '没有更新来源时不能发出任何请求')

    const cases: Array<[string, UpdateSource, string]> = [
      ['来源抛普通错误', { fetchLatest: async () => { throw new TypeError('socket hang up') } }, errorCodes.networkError],
      ['来源抛类型化错误', { fetchLatest: async () => { throw new ZToolsError(errorCodes.dataCorrupt, '坏数据') } }, errorCodes.dataCorrupt],
      ['来源返回数组', { fetchLatest: async () => [1, 2] }, errorCodes.dataCorrupt],
      ['来源返回 null', { fetchLatest: async () => null }, errorCodes.dataCorrupt],
      ['更新描述缺版本', { fetchLatest: async () => ({ app: { url: 'https://cdn.example/a.exe' } }) }, errorCodes.dataCorrupt],
      ['篡改的下载地址', { fetchLatest: async () => ({ app: { version: '9.0.0', url: 'file:///C:/evil.exe' } }) }, errorCodes.dataCorrupt],
      ['超大文件', { fetchLatest: async () => ({ web: { version: '2.0.0', url: 'https://cdn.example/w.zip', file_size: Number.MAX_SAFE_INTEGER } }) }, errorCodes.dataCorrupt]
    ]
    for (const [name, updateSource, code] of cases) {
      const service = new UpdateService({ ...base, updateSource })
      await assert.rejects(service.check({ source: 'manual' }), (error: unknown) =>
        error instanceof ZToolsError && error.code === code, name)
    }

    // 来源收到的请求参数与可中止信号；旧版本、同版本不算更新
    let seenSignal: AbortSignal | undefined
    const echo = new UpdateService({ ...base, updateSource: { fetchLatest: async (request) => {
      seenSignal = request.signal
      assert.deepEqual({ appVersion: request.appVersion, webVersion: request.webVersion, source: request.source },
        { appVersion: '1.0.0', webVersion: '1.0.0', source: 'manual' })
      return { app: { version: '1.0.0', url: 'https://cdn.example/a.exe' }, web: { version: '0.9.0', url: 'https://cdn.example/w.zip', file_size: 1 } }
    } } })
    assert.deepEqual(await echo.check({ source: 'manual' }), { success: true, source: 'manual', app: null, web: null })
    assert.equal(seenSignal?.aborted, true, '检查结束后释放请求及未读取的响应体')

    // 20 次并发检查互不干扰
    let concurrent = 0
    const parallel = new UpdateService({ ...base, updateSource: { fetchLatest: async () => {
      concurrent += 1
      await new Promise((resolve) => setImmediate(resolve))
      return { app: { version: '2.0.0', url: 'https://cdn.example/a.exe' }, web: null }
    } } })
    const results = await Promise.all(Array.from({ length: 20 }, () => parallel.check({ source: 'startup' })))
    assert.equal(concurrent, 20)
    assert.ok(results.every((result) => result.app?.version === '2.0.0' && result.web === null))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cleanupConsumedDownloads removes consumed, outdated, and orphan artifacts while preserving pending newer updates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-cleanup-'))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'DataV2'))
  const downloadRoot = path.join(runtimePaths.transactionRoot, 'Downloads')
  const maintenanceDir = path.join(runtimePaths.transactionRoot, 'Maintenance', 'stale-session')
  await fs.mkdir(downloadRoot, { recursive: true })
  await fs.mkdir(maintenanceDir, { recursive: true })

  try {
    // 1. 已消费的当前版本更新包（state = 'started'）-> 应被清理
    const consumedExe = path.join(downloadRoot, 'app-2.0.0-op1.exe')
    const consumedMeta = consumedExe + '.json'
    await fs.writeFile(consumedExe, 'consumed-binary')
    await fs.writeFile(consumedMeta, JSON.stringify({
      schemaVersion: 1,
      state: 'started',
      operationId: 'op1',
      type: 'app',
      version: '2.0.0',
      downloadUrl: 'https://cdn.example/ZTools-2.0.0.exe',
      checksum: 'a'.repeat(64),
      fileSize: 15,
      path: consumedExe
    }))

    // 2. 低于当前版本的历史下载包（version = '1.5.0' < '2.0.0'）-> 应被清理
    const outdatedExe = path.join(downloadRoot, 'app-1.5.0-op2.exe')
    const outdatedMeta = outdatedExe + '.json'
    await fs.writeFile(outdatedExe, 'outdated-binary')
    await fs.writeFile(outdatedMeta, JSON.stringify({
      schemaVersion: 1,
      state: 'downloaded',
      operationId: 'op2',
      type: 'app',
      version: '1.5.0',
      downloadUrl: 'https://cdn.example/ZTools-1.5.0.exe',
      checksum: 'b'.repeat(64),
      fileSize: 15,
      path: outdatedExe
    }))

    // 3. 高于当前版本且尚未消费的待安装包（version = '2.1.0' > '2.0.0', state = 'downloaded'）-> 必须保留
    const futureExe = path.join(downloadRoot, 'app-2.1.0-op3.exe')
    const futureMeta = futureExe + '.json'
    await fs.writeFile(futureExe, 'future-binary')
    await fs.writeFile(futureMeta, JSON.stringify({
      schemaVersion: 1,
      state: 'downloaded',
      operationId: 'op3',
      type: 'app',
      version: '2.1.0',
      downloadUrl: 'https://cdn.example/ZTools-2.1.0.exe',
      checksum: 'c'.repeat(64),
      fileSize: 13,
      path: futureExe
    }))

    // 4. 无元数据的孤立安装包与残留 Maintenance 目录 -> needCleanup=true 时应被清理
    const orphanExe = path.join(downloadRoot, 'app-1.9.0-orphan.exe')
    const orphanTmp = path.join(downloadRoot, 'app-2.0.0-partial.exe.tmp')
    await fs.writeFile(orphanExe, 'orphan')
    await fs.writeFile(orphanTmp, 'partial')
    await fs.writeFile(path.join(maintenanceDir, 'ZToolsUpdater.exe'), 'updater-copy')

    const service = new UpdateService({
      platform: 'win32',
      runtimePaths,
      appVersion: '2.0.0',
      webVersion: '2.0.0'
    })

    await service.cleanupConsumedDownloads({ needCleanup: true, retryDelaysMs: [10, 20] })

    await assert.rejects(fs.stat(consumedExe))
    await assert.rejects(fs.stat(consumedMeta))
    await assert.rejects(fs.stat(outdatedExe))
    await assert.rejects(fs.stat(outdatedMeta))
    await assert.rejects(fs.stat(orphanExe))
    await assert.rejects(fs.stat(orphanTmp))
    await assert.rejects(fs.stat(maintenanceDir))

    assert.equal(await fs.readFile(futureExe, 'utf8'), 'future-binary')
    assert.ok((await fs.stat(futureMeta)).isFile())
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
