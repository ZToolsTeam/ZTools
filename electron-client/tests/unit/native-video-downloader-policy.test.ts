import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { BuiltinPluginHostService } from '../../src/main/services/builtin-plugin-host-service.js'
import { DllPluginService } from '../../src/main/services/dll-plugin-service.js'
import {
  isBuiltInNativeMediaDll,
  NativeMediaPathPolicy,
  type NativeMediaLstat,
  type NativeMediaPathResolver,
  type NativeMediaStat
} from '../../src/main/services/native-media-policy.js'
import {
  isProtectedVideoOutputDirectory,
  VIDEO_DOWNLOADER_ALLOWED_FUNCTIONS
} from '../../src/main/services/native-video-downloader-policy.js'

class FakeVideoPathResolver implements NativeMediaPathResolver {
  readonly calls: Array<{ value: string; caller: CallerIdentity; access: 'read' | 'write'; allowMissing: boolean }> = []
  readonly grants = new Map<string, string>()

  allow(caller: CallerIdentity, access: 'read' | 'write', rawValue: string, resolvedPath: string): void {
    this.grants.set(`${caller.webContentsId}:${access}:${rawValue}`, resolvedPath)
  }

  async resolveAuthorizedPath(
    value: string,
    caller: CallerIdentity,
    access: 'read' | 'write',
    allowMissing: boolean
  ): Promise<string> {
    this.calls.push({ value, caller, access, allowMissing })
    const mapped = this.grants.get(`${caller.webContentsId}:${access}:${value}`)
    if (!mapped) {
      throw new ZToolsError(errorCodes.permissionDenied, 'path not authorized')
    }
    return mapped
  }
}

function directoryStats(): NativeMediaStat {
  return { size: 0, isFile: () => false, isDirectory: () => true }
}

function fileStats(size = 64): NativeMediaStat {
  return { size, isFile: () => true, isDirectory: () => false }
}

function createPolicy(options: {
  resolver?: FakeVideoPathResolver
  lstat?: (target: string) => Promise<NativeMediaLstat>
} = {}) {
  const resolver = options.resolver ?? new FakeVideoPathResolver()
  const stats = new Map<string, NativeMediaStat>()
  const policy = new NativeMediaPathPolicy(resolver, [], {
    stat: async (target) => {
      const value = stats.get(target)
      if (!value) throw new Error(`missing test stat: ${target}`)
      return value
    },
    ...(options.lstat ? { lstat: options.lstat } : {})
  })
  return { policy, resolver, stats }
}

const caller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 501,
  pluginId: 'video-downloader',
  pluginInstanceId: 'vd-inst-1'
}

test('VideoDownloaderPlugin 已纳入内置原生媒体策略（Fail-Fast 登记）', () => {
  assert.equal(isBuiltInNativeMediaDll('VideoDownloaderPlugin'), true)
  assert.equal(isBuiltInNativeMediaDll('videodownloaderplugin'), true)
  const { policy } = createPolicy()
  assert.equal(policy.hasPolicy('VideoDownloaderPlugin'), true)
  assert.equal(VIDEO_DOWNLOADER_ALLOWED_FUNCTIONS.length, 15)
})

test('VideoDownloaderPlugin 正常调用：覆盖全部 15 个白名单方法与 __locale 忽略语义', async () => {
  const { policy, resolver, stats } = createPolicy()
  const safeOutput = path.join(os.tmpdir(), 'ztools-vd-safe-output')
  resolver.allow(caller, 'write', 'downloads', safeOutput)
  stats.set(safeOutput, directoryStats())

  // 空参数方法与 __locale 兼容
  for (const fn of ['CheckTools', 'GetAllTasks', 'ClearHistory'] as const) {
    assert.deepEqual(await policy.authorizeCall('VideoDownloaderPlugin', fn, {}, caller), {})
    assert.deepEqual(
      await policy.authorizeCall('VideoDownloaderPlugin', fn, { __locale: 'zh-CN' }, caller),
      {}
    )
  }

  // 解析类方法：支持纯 http(s):// 链接与纯 B 站 BV 号（自动规范化为标准 https 链接）
  assert.deepEqual(
    await policy.authorizeCall('VideoDownloaderPlugin', 'GetVideoInfo', {
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      __locale: 'en-US'
    }, caller),
    { url: 'https://www.bilibili.com/video/BV1xx411c7mD' }
  )
  assert.deepEqual(
    await policy.authorizeCall('VideoDownloaderPlugin', 'StartParseAsync', {
      url: 'BV1Ab411c7mD'
    }, caller),
    { url: 'https://www.bilibili.com/video/BV1Ab411c7mD' }
  )
  // 含引号、空格或拼接选项的解析输入必须被拒绝（防止透传给原生命令行）
  for (const badUrl of [
    'https://example.com/v?a=1" --exec calc',
    '分享视频 BV1Ab411c7mD 精彩合集',
    'file:///C:/Windows/win.ini'
  ]) {
    await assert.rejects(
      () => policy.authorizeCall('VideoDownloaderPlugin', 'GetVideoInfo', { url: badUrl }, caller),
      /INVALID_REQUEST|url/i
    )
  }

  // 任务控制方法
  for (const fn of ['GetParseStatus', 'CancelParse', 'GetTaskStatus', 'PauseTask', 'ResumeTask', 'CancelTaskById'] as const) {
    assert.deepEqual(
      await policy.authorizeCall('VideoDownloaderPlugin', fn, { taskId: 'task_2026:01-abc.9' }, caller),
      { taskId: 'task_2026:01-abc.9' }
    )
  }

  // 历史记录分页与删除
  assert.deepEqual(
    await policy.authorizeCall('VideoDownloaderPlugin', 'GetDownloadHistory', {}, caller),
    {}
  )
  assert.deepEqual(
    await policy.authorizeCall('VideoDownloaderPlugin', 'GetDownloadHistory', { limit: 50, offset: 0 }, caller),
    { limit: 50, offset: 0 }
  )
  assert.deepEqual(
    await policy.authorizeCall('VideoDownloaderPlugin', 'DeleteHistory', { id: 42 }, caller),
    { id: 42 }
  )

  // StartDownload：全字段 + |http DASH 音轨拼接 + 大写音频格式归一化 + socks5 代理 + outputDir 规范化写回
  const downloadParams = await policy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', {
    url: 'https://example.com/watch?v=123',
    format: '30080|https://cdn.example.com/audio.m4s?token=abc',
    outputDir: 'downloads',
    extractAudio: true,
    audioFormat: 'FLAC',
    proxy: 'socks5://127.0.0.1:1080',
    title: '测试视频标题 1080P',
    __locale: 'zh-CN'
  }, caller)
  assert.deepEqual(downloadParams, {
    url: 'https://example.com/watch?v=123',
    format: '30080|https://cdn.example.com/audio.m4s?token=abc',
    outputDir: path.resolve(safeOutput),
    extractAudio: true,
    audioFormat: 'flac',
    proxy: 'socks5://127.0.0.1:1080',
    title: '测试视频标题 1080P'
  })

  // StartDownload：空串 proxy 也合法
  const emptyProxy = await policy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', {
    url: 'http://example.com/video.mp4',
    outputDir: 'downloads',
    proxy: ''
  }, caller)
  assert.equal(emptyProxy.proxy, '')

  // StartDirectDownload
  const directParams = await policy.authorizeCall('VideoDownloaderPlugin', 'StartDirectDownload', {
    videoUrl: 'https://cdn.example.com/direct/clip.mp4',
    title: '直链视频',
    outputDir: 'downloads'
  }, caller)
  assert.deepEqual(directParams, {
    videoUrl: 'https://cdn.example.com/direct/clip.mp4',
    title: '直链视频',
    outputDir: path.resolve(safeOutput)
  })
})

test('VideoDownloaderPlugin 拦截未白名单高危函数与原型链方法名', async () => {
  const { policy } = createPolicy()
  for (const forbiddenFn of [
    'UpdateSettings',
    'BrowseFolder',
    'BrowseFile',
    'OpenFolder',
    'ExecuteCommand',
    'toString',
    'constructor',
    '__proto__'
  ]) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', forbiddenFn, {}, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.methodNotFound,
      `方法 ${forbiddenFn} 必须返回 methodNotFound`
    )
  }
})

test('VideoDownloaderPlugin 拒绝非对象参数、未知键、命令注入字符、非法 audioFormat/proxy/format/taskId', async () => {
  const { policy, resolver, stats } = createPolicy()
  const safeOutput = path.join(os.tmpdir(), 'ztools-vd-invalid-test')
  resolver.allow(caller, 'write', 'downloads', safeOutput)
  stats.set(safeOutput, directoryStats())

  // 非对象参数
  for (const invalidParams of [null, [], 'raw', 123] as unknown[]) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'CheckTools', invalidParams as Record<string, unknown>, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }

  // 未知键
  for (const [fn, params] of [
    ['CheckTools', { extra: true }],
    ['GetAllTasks', { filter: 'all' }],
    ['ClearHistory', { force: true }],
    ['GetVideoInfo', { url: 'https://example.com/v', cookieFile: 'C:\\secret.txt' }],
    ['StartDownload', { url: 'https://example.com/v', outputDir: 'downloads', cookies: 'a=b' }],
    ['StartDirectDownload', { videoUrl: 'https://example.com/v.mp4', outputDir: 'downloads', proxy: 'http://127.0.0.1:8080' }],
    ['GetDownloadHistory', { limit: 10, sql: '1=1' }],
    ['DeleteHistory', { id: 1, all: true }]
  ] as const) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', fn, params as Record<string, unknown>, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest,
      `${fn} 未知键必须被拦截`
    )
  }

  // GetVideoInfo / StartParseAsync 非法 URL 或注入字符
  for (const badUrl of [
    '',
    '   ',
    'not-a-video-link',
    'ftp://example.com/video.mp4',
    'https://example.com/v\n--exec calc',
    'https://example.com/v\r\n--exec calc',
    'https://example.com/v\0bad',
    `https://example.com/${'a'.repeat(4096)}`
  ]) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'GetVideoInfo', { url: badUrl }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest,
      `非法解析 URL 必须拦截: ${JSON.stringify(badUrl.slice(0, 40))}`
    )
  }

  // StartDownload 注入与非法参数
  const badStartDownloadCases: Array<[string, Record<string, unknown>]> = [
    ['非 http(s) url', { url: 'file:///C:/Windows/win.ini', outputDir: 'downloads' }],
    ['url 含换行注入', { url: 'https://example.com/v\n--exec=calc', outputDir: 'downloads' }],
    ['url 含引号', { url: 'https://example.com/v"&&calc', outputDir: 'downloads' }],
    ['format 含双引号注入', { url: 'https://example.com/v', outputDir: 'downloads', format: 'best" --exec calc' }],
    ['format 含换行', { url: 'https://example.com/v', outputDir: 'downloads', format: 'best\n--exec' }],
    ['format 含非法 |http 尾段', { url: 'https://example.com/v', outputDir: 'downloads', format: '30080|http://bad host/a' }],
    ['format 含多个管道', { url: 'https://example.com/v', outputDir: 'downloads', format: '30080|https://a.com/1|https://b.com/2' }],
    ['非法 audioFormat', { url: 'https://example.com/v', outputDir: 'downloads', audioFormat: 'mp4;calc' }],
    ['非法 extractAudio 类型', { url: 'https://example.com/v', outputDir: 'downloads', extractAudio: 'true' }],
    ['proxy 含空格注入', { url: 'https://example.com/v', outputDir: 'downloads', proxy: 'http://127.0.0.1:8080 --exec calc' }],
    ['proxy 非法协议', { url: 'https://example.com/v', outputDir: 'downloads', proxy: 'file:///etc/passwd' }],
    ['proxy 含控制符', { url: 'https://example.com/v', outputDir: 'downloads', proxy: 'http://127.0.0.1:8080\r\n' }],
    ['title 含换行', { url: 'https://example.com/v', outputDir: 'downloads', title: 'ok\n--exec' }],
    ['title 超长', { url: 'https://example.com/v', outputDir: 'downloads', title: 'x'.repeat(257) }]
  ]
  for (const [label, params] of badStartDownloadCases) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', params, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest,
      `StartDownload 应拦截: ${label}`
    )
  }

  // 非法 taskId / limit / offset / id
  for (const badTaskId of ['', 'has space', '../escape', 'a/b', 'a;calc', 't'.repeat(129)]) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'GetTaskStatus', { taskId: badTaskId }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
  for (const badHistory of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }, { offset: 1.2 }]) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'GetDownloadHistory', badHistory, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
  for (const badId of [0, -1, 1.5, '1', Number.NaN]) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'DeleteHistory', { id: badId }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
})

test('VideoDownloaderPlugin 硬拦截未授权目录、系统关键目录、盘符根目录、.. 穿越与符号链接', async () => {
  const { policy, resolver, stats } = createPolicy()

  // 1. 未授权 outputDir 必须被拒绝
  await assert.rejects(
    policy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', {
      url: 'https://example.com/v',
      outputDir: path.join(os.tmpdir(), 'ungranted-dir')
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )

  // 2. 包含 .. 穿越片段在授权解析前即被拦截
  for (const traversal of ['..\\outside', 'a/../b', 'C:\\Users\\..\\Windows']) {
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', {
        url: 'https://example.com/v',
        outputDir: traversal
      }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }

  // 3. 系统关键目录与盘符根目录，即使被错误授予写权限也必须硬拦截
  const protectedTargets = process.platform === 'win32'
    ? ['C:\\', 'D:\\', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/', '/etc', '/usr/bin', '/var']
  for (const target of protectedTargets) {
    assert.equal(isProtectedVideoOutputDirectory(target), true, `应判定为受保护目录: ${target}`)
    resolver.allow(caller, 'write', target, target)
    stats.set(target, directoryStats())
    await assert.rejects(
      policy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', {
        url: 'https://example.com/v',
        outputDir: target
      }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied,
      `系统目录必须硬拦截: ${target}`
    )
  }

  // 4. outputDir 指向普通文件而非目录时拒绝
  const regularFile = path.join(os.tmpdir(), 'ztools-vd-not-dir.txt')
  resolver.allow(caller, 'write', 'not-dir', regularFile)
  stats.set(regularFile, fileStats())
  await assert.rejects(
    policy.authorizeCall('VideoDownloaderPlugin', 'StartDirectDownload', {
      videoUrl: 'https://example.com/v.mp4',
      outputDir: 'not-dir'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )

  // 5. 符号链接目录硬拦截（通过 lstat 适配器精准验证符号链接判定）
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-vd-symlink-'))
  try {
    const symlinkTarget = path.join(tempRoot, 'link-dir')
    const symlinkResolver = new FakeVideoPathResolver()
    symlinkResolver.allow(caller, 'write', symlinkTarget, symlinkTarget)
    const symlinkPolicy = new NativeMediaPathPolicy(symlinkResolver, [], {
      stat: async () => directoryStats(),
      lstat: async (candidate) => ({
        isSymbolicLink: () => path.resolve(candidate) === path.resolve(symlinkTarget)
      })
    })
    await assert.rejects(
      symlinkPolicy.authorizeCall('VideoDownloaderPlugin', 'StartDownload', {
        url: 'https://example.com/v',
        outputDir: symlinkTarget
      }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('network-host handleVideoDownloader 不再返回伪视频解析结果，统一 Fail-Fast 返回 NOT_SUPPORTED', async () => {
  const host = new BuiltinPluginHostService()
  try {
    for (const [fn, params] of [
      ['parseUrl', { url: 'https://www.bilibili.com/video/BV1xx411c7mD' }],
      ['extractInfo', { url: 'https://example.com/watch?v=1' }],
      ['getVideoInfo', { url: 'https://example.com/watch?v=1' }],
      ['startDownload', { url: 'https://example.com/watch?v=1' }],
      ['getTasks', {}]
    ] as const) {
      const res = (await host.handlePluginCall('VideoDownloaderPlugin', fn, params as Record<string, unknown>)) as {
        ok: boolean
        success: boolean
        errorCode?: string
        error?: string
        title?: unknown
        formats?: unknown
        tasks?: unknown
      }
      assert.equal(res.ok, false, `${fn} 必须返回 ok=false`)
      assert.equal(res.success, false, `${fn} 必须返回 success=false`)
      assert.equal(res.errorCode, 'NOT_SUPPORTED', `${fn} 必须返回 errorCode=NOT_SUPPORTED`)
      assert.ok(typeof res.error === 'string' && res.error.length > 0)
      assert.equal(res.title, undefined, '严禁返回伪造 title')
      assert.equal(res.formats, undefined, '严禁返回静态 formats 占位')
      assert.equal(res.tasks, undefined, '严禁返回假任务列表')
    }
  } finally {
    await host.stop()
  }
})

test('DllPluginService 集成：未配置策略时 VideoDownloaderPlugin 强制 Fail-Fast；配置策略后先鉴权再注入 __locale', async () => {
  const manifest = {
    id: 'video-downloader',
    name: 'Video Downloader',
    version: '1.0.0',
    entry: 'index.html',
    dllloader: 'lib/VideoDownloaderPlugin.dll',
    requireAdmin: false,
    commonLibs: []
  }
  const manifestSource = {
    list: async () => ({ success: true as const, data: [manifest] }),
    withPluginManifest: async <T>(
      _pluginId: string,
      action: (item: typeof manifest) => Promise<T>
    ) => await action(manifest)
  }
  const capturedCalls: Array<{ fn: string; params: unknown }> = []
  const fakeNativeHost = {
    onDllEvent: () => () => {},
    acquirePluginMaintenance: async () => () => {},
    callDll: async (_pluginId: string, _dllId: string, fn: string, params: unknown) => {
      capturedCalls.push({ fn, params })
      return { code: 0, result: JSON.stringify({ success: true }) }
    }
  }
  const events = {
    publishHostToOwner: () => ({ success: true as const, delivered: 0 })
  }

  // 1. 未配置 nativeMediaPolicy 时必须 Fail-Fast 抛 notSupported，严禁调用原生 DLL
  const serviceWithoutPolicy = new DllPluginService(
    manifestSource as never,
    fakeNativeHost as never,
    null,
    events
  )
  await assert.rejects(
    serviceWithoutPolicy.call({ plugin: 'VideoDownloaderPlugin', func: 'CheckTools', params: {} }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.equal(capturedCalls.length, 0)

  // 2. 配置 nativeMediaPolicy 后，CheckTools 正常通过且最终透传 __locale 给原生 DLL
  const { policy } = createPolicy()
  const serviceWithPolicy = new DllPluginService(
    manifestSource as never,
    fakeNativeHost as never,
    null,
    events,
    undefined,
    {},
    policy
  )
  const okResult = await serviceWithPolicy.call(
    { plugin: 'VideoDownloaderPlugin', func: 'CheckTools', params: {} },
    caller
  )
  assert.equal(okResult.success, true)
  assert.equal(capturedCalls.length, 1)
  assert.equal(capturedCalls[0]?.fn, 'CheckTools')
  const passedParams = capturedCalls[0]?.params as Record<string, unknown>
  assert.ok(passedParams.__locale === 'zh-CN' || passedParams.__locale === 'en-US')
})

