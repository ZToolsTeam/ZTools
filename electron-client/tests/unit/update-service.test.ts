import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { UpdateService } from '../../src/main/services/update-service.js'

test('update service preserves the legacy response shape and verifies downloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-service-'))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const body = Buffer.from('verified installer payload')
  const checksum = createHash('sha256').update(body).digest('hex')
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('check-update')) {
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
    runtimePaths,
    appVersion: '1.0.0',
    webVersion: '1.0.0',
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
  await new Promise((resolve) => setTimeout(resolve, 10))
  await assert.rejects(fs.access(downloaded.path))
  removeProgressListener()
  await fs.rm(root, { recursive: true, force: true })
})

test('web package installation requires the independent resource service', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-web-'))
  const service = new UpdateService({
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

test('App package formats leave install-scope resolution to the native updater', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-updater-'))
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
  const service = new UpdateService({
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
    assert.deepEqual(launch.argumentsList.slice(2), ['--updated', '--need-cleanup'])
    assert.equal(launch.cwd, path.dirname(launch.executable))
    assert.equal(launch.updaterContents, 'updater')
  }

  await fs.rm(root, { recursive: true, force: true })
})

test('UAC cancellation and updater launch failures remain visible and retryable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-updater-errors-'))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  await fs.mkdir(runtimePaths.installRoot, { recursive: true })
  await fs.writeFile(path.join(runtimePaths.installRoot, 'ZToolsUpdater.exe'), 'updater')
  const payload = Buffer.from('verified package')
  const checksum = createHash('sha256').update(payload).digest('hex')
  let launchError: Error | undefined = new Error('spawn ENOENT')
  let exitCode = 1223
  let downloadCalls = 0
  const service = new UpdateService({
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
    error.message.includes('启动自提权更新器失败: spawn ENOENT')
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

test('update service compares all four numeric version components and rejects malformed versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-update-version-'))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const service = new UpdateService({
    runtimePaths,
    appVersion: '1.0.0.9',
    webVersion: '1.0.0.9',
    fetchImpl: async () => new Response(JSON.stringify({
      app: { version: '1.0.0.10', url: 'https://cdn.example/ZToolsSetup.exe', file_size: 0 },
      web: { version: '1.0.0.8', url: 'https://cdn.example/web.zip', file_size: 0 }
    }), { status: 200 })
  })
  const checked = await service.check({ source: 'manual' })
  assert.equal(checked.app?.version, '1.0.0.10')
  assert.equal(checked.web, null)

  const malformed = new UpdateService({
    runtimePaths,
    appVersion: '1.0.0.9',
    webVersion: '1.0.0.9',
    fetchImpl: async () => new Response(JSON.stringify({
      app: { version: 'release-latest', url: 'https://cdn.example/ZToolsSetup.exe', file_size: 0 }
    }), { status: 200 })
  })
  await assert.rejects(malformed.check({ source: 'manual' }), /版本格式无效/)
  await fs.rm(root, { recursive: true, force: true })
})
