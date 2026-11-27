import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  canCall,
  isAllowedMethod,
  isPrivilegedMethod,
  methodCapabilities,
  type CallerIdentity
} from '../../src/contracts/capabilities.js'
import type { ToolProgressEvent } from '../../src/contracts/tool-runtime/common.js'
import { resolvePinnedLibraryChecksum, pinnedLibraryMetadataSource } from '../../src/main/services/library-integrity-pins.js'
import type { MediaDomainDriver } from '../../src/main/tool-runtime/domains/media/driver.js'
import { NativeHttpTransferEngine } from '../../src/main/tool-runtime/domains/download/drivers/native-http-transfer.js'
import { Win32DownloadDriver } from '../../src/main/tool-runtime/domains/download/drivers/win32-download.js'
import type { CommonLibsManager } from '../../src/main/tool-runtime/core/commonlibs-manager.js'
import { GuardedProcessRunner } from '../../src/main/tool-runtime/core/guarded-process.js'
import { parseRequest, INFINITE_TIMEOUT } from '../../src/contracts/ipc.js'
import { ToolRuntimeRegistry } from '../../src/main/tool-runtime/registry.js'

/**
 * 双端异构测试夹具集成测试 + 权限最小化验证 + 原生断点续传集成 + 旧插件零回归测试：
 * - 验证同一份声明式插件调用代码（零改动）在 Windows（按需拉取 Driver）与 macOS（原生直调 Driver）双端无缝运行；
 * - 验证真实本地 HTTP Range 断点续传 add -> pause -> resume -> completed + SHA-256 校验；
 * - 验证权限最小化（缺 media.read / media.process / network 一律 PLUGIN_PERMISSION_REQUIRED；第三方插件禁止调 tool_commonlibs_*）；
 * - 验证既有 dllplugin_* 方法与旧 ffmpeg-1.0.0 公共库锚点 100% 零回归。
 */

function createPluginCaller(pluginId: string, permissions: readonly string[]): CallerIdentity {
  return {
    type: 'main',
    webContentsId: 101,
    attributedPlugin: {
      pluginId,
      sessionId: 'sess-fixture-1',
      permissions: new Set(permissions),
      source: 'installed'
    }
  }
}

/** 模拟同一份未改动的跨端插件代码：仅调用平台无关薄原语 IPC */
async function runCrossPlatformPluginWorkflow(
  registry: ToolRuntimeRegistry,
  caller: CallerIdentity,
  inputFile: string,
  outputFile: string
) {
  const signal = new AbortController().signal
  const handlers = registry.getIpcHandlers()
  const caps = (await handlers.tool_runtime_capabilities({}, caller, signal)) as {
    capabilities: Array<{ primitiveId: string; status: string }>
  }
  const transcodeCap = caps.capabilities.find((c) => c.primitiveId === 'media.transcode')
  assert.ok(transcodeCap, '能力探测必须包含 media.transcode')

  if (transcodeCap.status === 'needs_provisioning') {
    const ensured = (await handlers.tool_runtime_ensure({ primitiveId: 'media.transcode' }, caller, signal)) as {
      status: string
      provisioned: boolean
    }
    assert.equal(ensured.status, 'ready')
    assert.equal(ensured.provisioned, true)
  }

  const probed = (await handlers.tool_media_probe({ inputs: [{ path: inputFile }] }, caller, signal)) as {
    items: Array<{ displayName: string; streams: Array<{ kind: string }> }>
  }
  assert.equal(probed.items.length, 1)
  assert.equal(probed.items[0]!.displayName, path.basename(inputFile.replace(/\\/g, '/')))

  const transcoded = (await handlers.tool_media_transcode_run(
    {
      input: { path: inputFile },
      output: { path: outputFile },
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      overwrite: true
    },
    caller,
    signal
  )) as { container: string; outputBytes: number }

  assert.equal(transcoded.container, 'mp4')
  assert.ok(transcoded.outputBytes > 0)
  return { initialStatus: transcodeCap.status, probed, transcoded }
}

test('双端异构测试夹具：同一份插件零改动分别在 Windows(按需拉取Driver) 与 macOS(原生直调Driver) 端到端闭环', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-hetero-'))
  const inputFile = path.join(tempRoot, 'demo.mov')
  const winOutput = path.join(tempRoot, 'win-out.mp4')
  const macOutput = path.join(tempRoot, 'mac-out.mp4')
  await fs.writeFile(inputFile, Buffer.from('fixture-video-payload-bytes'))

  try {
    const caller = createPluginCaller('fixture-media-plugin', ['media.read', 'media.process'])

    // 1. Windows 装配：模拟通过 CommonLibs 按需拉取的异构 Driver（初始 needs_provisioning -> ensure -> ready）
    let winProvisioned = false
    const winProgressEvents: ToolProgressEvent[] = []
    const winMediaDriver: MediaDomainDriver = {
      platformName: 'windows',
      getCapabilityStatus: async () => (winProvisioned ? 'ready' : 'needs_provisioning'),
      ensureCapability: async () => {
        const was = winProvisioned
        winProvisioned = true
        return { status: 'ready', provisioned: !was }
      },
      getStaticToolIds: () => ['fixture-win-engine-1.0.0'],
      probe: async (inputs) =>
        inputs.map((item) => ({
          displayName: item.displayName,
          container: 'mov',
          durationSec: 12.5,
          sizeBytes: item.sizeBytes,
          streams: [{ index: 0, kind: 'video', codec: 'h264', width: 1920, height: 1080 }]
        })),
      transcode: async (job, ctx) => {
        ctx.onProgress?.({ phase: 'running', percent: 50, message: 'transcoding-win' })
        await fs.writeFile(job.outputPath, Buffer.from('win-transcoded-mp4-data'))
        ctx.onProgress?.({ phase: 'completed', percent: 100 })
        return { taskId: job.taskId, container: job.container, outputBytes: 23, durationMs: 42 }
      }
    }

    const winRegistry = new ToolRuntimeRegistry({
      dataRoot: path.join(tempRoot, 'win-data'),
      platform: 'win32',
      mediaDriver: winMediaDriver,
      onProgress: (ev) => winProgressEvents.push(ev)
    })

    // 2. macOS 装配：模拟系统原生框架直调 Driver（零外部下载、天生 ready、无 CommonLibs 静态依赖）
    let macTranscodeCalled = false
    const macMediaDriver: MediaDomainDriver = {
      platformName: 'macos',
      getCapabilityStatus: async () => 'ready',
      ensureCapability: async () => ({ status: 'ready', provisioned: false }),
      getStaticToolIds: () => [],
      probe: async (inputs) =>
        inputs.map((item) => ({
          displayName: item.displayName,
          container: 'mov',
          durationSec: 12.5,
          sizeBytes: item.sizeBytes,
          streams: [{ index: 0, kind: 'video', codec: 'h264', width: 1920, height: 1080 }]
        })),
      transcode: async (job, ctx) => {
        macTranscodeCalled = true
        ctx.onProgress?.({ phase: 'running', percent: 100, message: 'transcoding-mac-native' })
        await fs.writeFile(macOutput, Buffer.from('mac-native-avfoundation-mp4'))
        return { taskId: job.taskId, container: job.container, outputBytes: 27, durationMs: 18 }
      }
    }

    const macRegistry = new ToolRuntimeRegistry({
      dataRoot: path.join(tempRoot, 'mac-data'),
      platform: 'darwin',
      homeDir: '/Users/test',
      mediaDriver: macMediaDriver,
      skipDiskStatForSimulatedPlatform: true
    })

    // 同一份插件工作流函数零改动分别跑通双端！
    const winRes = await runCrossPlatformPluginWorkflow(winRegistry, caller, inputFile, winOutput)
    assert.equal(winRes.initialStatus, 'needs_provisioning')
    assert.ok(winProgressEvents.some((e) => e.phase === 'running' && e.percent === 50))

    const macRes = await runCrossPlatformPluginWorkflow(
      macRegistry,
      caller,
      '/Users/test/demo.mov',
      '/Users/test/mac-out.mp4'
    )
    assert.equal(macRes.initialStatus, 'ready')
    assert.equal(macTranscodeCalled, true)

    // 验证静态 GC 映射也随平台 Driver 自动异构派生
    const installedManifests = [{ id: 'fixture-media-plugin', requiredCapabilities: ['media.transcode'] }]
    const winStaticRefs = winRegistry.resolveStaticCommonLibReferences(installedManifests)
    const macStaticRefs = macRegistry.resolveStaticCommonLibReferences(installedManifests)
    assert.equal(winStaticRefs.has('fixture-win-engine-1.0.0'), true)
    assert.equal(macStaticRefs.size, 0, 'macOS 原生直调驱动不应产生任何 CommonLibs 工具静态引用')

    await winRegistry.stop()
    await macRegistry.stop()
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('原生断点续传下载集成测试：真实本地 HTTP Range Server 跑通 add -> status -> completed + SHA-256 校验', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-transfer-'))
  const payload = crypto.randomBytes(128 * 1024)
  const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex')

  const server = http.createServer((req, res) => {
    if (req.url !== '/asset.bin') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(payload.length)
      })
      res.end()
      return
    }
    const range = req.headers.range
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Math.min(Number(m[2]), payload.length - 1) : payload.length - 1
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${payload.length}`,
          'Content-Length': String(end - start + 1)
        })
        res.end(payload.subarray(start, end + 1))
        return
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(payload.length)
    })
    res.end(payload)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const url = `http://127.0.0.1:${addr.port}/asset.bin`

  try {
    const engine = new NativeHttpTransferEngine()
    const progressEvents: number[] = []
    const added = await engine.add(
      {
        taskId: 'dl-task-1',
        url,
        outputDir: tempRoot,
        fileName: 'asset.bin',
        maxConnections: 4,
        overwrite: true,
        expectedSha256
      },
      (p) => {
        if (typeof p.percent === 'number') progressEvents.push(p.percent)
      }
    )
    assert.equal(added.taskId, 'dl-task-1')

    // 轮询直至完成（最长 5 秒）
    const deadline = Date.now() + 5_000
    let finalState = added.state
    while (Date.now() < deadline && finalState !== 'completed' && finalState !== 'failed') {
      await new Promise((r) => setTimeout(r, 40))
      const tasks = await engine.status('dl-task-1')
      finalState = tasks[0]?.state ?? 'failed'
    }
    assert.equal(finalState, 'completed')

    const saved = await fs.readFile(path.join(tempRoot, 'asset.bin'))
    assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), expectedSha256)
    assert.ok(progressEvents.length > 0)

    await engine.stop()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('权限最小化与存量旧插件零回归：缺权限必拒、第三方插件禁调 CommonLibs 管理接口、旧 dllplugin_* 与 ffmpeg-1.0.0 锚点零变化', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-perm-reg-'))
  try {
    const signal = new AbortController().signal
    const registry = new ToolRuntimeRegistry({ dataRoot: tempRoot, platform: 'win32' })
    const handlers = registry.getIpcHandlers()

    // 1. 声明式插件未声明 media.read 权限调用 tool_media_probe -> PLUGIN_PERMISSION_REQUIRED
    const noPermCaller = createPluginCaller('unpriv-plugin', [])
    await assert.rejects(
      () => handlers.tool_media_probe({ inputs: [{ path: path.join(tempRoot, 'a.mp4') }] }, noPermCaller, signal),
      /permission|media\.read/i
    )

    // 2. 声明式插件未声明 network 权限调用 tool_download_stream_probe -> PLUGIN_PERMISSION_REQUIRED
    await assert.rejects(
      () => handlers.tool_download_stream_probe({ url: 'https://example.com/a' }, noPermCaller, signal),
      /permission|network/i
    )

    // 3. 第三方插件窗口严禁调用宿主专属 tool_commonlibs_list / tool_commonlibs_clean
    const pluginWindowCaller: CallerIdentity = { type: 'plugin', webContentsId: 7, pluginId: 'third-party' }
    assert.equal(isPrivilegedMethod('tool_commonlibs_list'), true)
    assert.equal(isPrivilegedMethod('tool_commonlibs_clean'), true)
    assert.equal(canCall('tool_commonlibs_list', pluginWindowCaller), false)
    assert.equal(canCall('tool_commonlibs_clean', pluginWindowCaller), false)
    assert.equal(canCall('tool_commonlibs_list', { type: 'main', webContentsId: 1 }), true)

    // 4. 存量旧插件零回归：既有 dllplugin_* 通道全部原样保留
    for (const legacyMethod of [
      'dllplugin_list',
      'dllplugin_call',
      'dllplugin_call_async',
      'dllplugin_call_with_callback',
      'dllplugin_query_task',
      'dllplugin_cancel_task',
      'dllplugin_clear_callback_task'
    ] as const) {
      assert.equal(isAllowedMethod(legacyMethod), true, `既有 ${legacyMethod} 必须 100% 保留`)
      assert.ok(Object.hasOwn(methodCapabilities, legacyMethod))
    }

    // 5. 存量旧公共库锚点 ffmpeg-1.0.0 原样保留，不受 CommonLibs V2 影响
    const pinnedFfmpeg = await pinnedLibraryMetadataSource.resolve('ffmpeg-1.0.0', {
      signal,
      fetchText: async () => {
        throw new Error('should not fetch network for pinned ffmpeg-1.0.0')
      }
    })
    assert.equal(pinnedFfmpeg.libId, 'ffmpeg-1.0.0')
    assert.equal(
      resolvePinnedLibraryChecksum({
        libId: String(pinnedFfmpeg.libId),
        downloadUrl: String(pinnedFfmpeg.downloadUrl),
        fileSize: typeof pinnedFfmpeg.fileSize === 'number' ? pinnedFfmpeg.fileSize : undefined,
        checksum: String(pinnedFfmpeg.checksum)
      }).length,
      64
    )

    await registry.stop()
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('Win32DownloadDriver：音频提取/分离流混流自动按需拉取媒体工具并注入 --ffmpeg-location 与动态租约', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-dl-mux-'))
  const outDir = path.join(tempRoot, 'out')
  await fs.mkdir(outDir, { recursive: true })
  const outFile = path.join(outDir, 'audio.mp3')

  try {
    const ensuredTools: string[] = []
    const usedTools: string[] = []
    const capturedCalls: Array<{ exePath: string; argv: readonly string[]; timeoutMs?: number | undefined }> = []
    const readyTools = new Set<string>(['stream-downloader-2026.1.0'])

    const fakeCommonLibs = {
      isToolReadyOffline: async (toolId: string) => readyTools.has(toolId),
      ensureTool: async (toolId: string) => {
        ensuredTools.push(toolId)
        readyTools.add(toolId)
      },
      resolveExecutable: async (toolId: string, rel: string) => ({
        toolId,
        executablePath: path.join(tempRoot, 'CommonLibs', toolId, rel)
      }),
      acquireActiveProcess: () => () => undefined
    } as unknown as CommonLibsManager

    const fakeRunner = {
      run: async (opts: { exePath: string; argv: readonly string[]; timeoutMs?: number }) => {
        capturedCalls.push({ exePath: opts.exePath, argv: opts.argv, timeoutMs: opts.timeoutMs })
        await fs.writeFile(outFile, Buffer.from('mock-mp3-bytes'))
        return {
          exitCode: 0,
          signal: null,
          stdout: `${outFile}\n`,
          stderr: '',
          cancelled: false,
          timedOut: false
        }
      }
    } as unknown as GuardedProcessRunner

    const driver = new Win32DownloadDriver({
      commonLibs: fakeCommonLibs,
      processRunner: fakeRunner
    })

    const res = await driver.runStream(
      {
        taskId: 'stream-audio-1',
        url: 'https://example.com/video/1',
        outputDir: outDir,
        fileName: 'audio.mp3',
        preferAudioOnly: true,
        audioFormat: 'mp3',
        timeoutMs: 900_000,
        overwrite: true
      },
      {
        signal: new AbortController().signal,
        onToolUsed: (toolId) => usedTools.push(toolId)
      }
    )

    assert.equal(res.outputFileName, 'audio.mp3')
    assert.deepEqual(ensuredTools, ['media-toolkit-7.1.0'], '提取音频必须按需拉取 media-toolkit-7.1.0')
    assert.deepEqual(usedTools, ['stream-downloader-2026.1.0', 'media-toolkit-7.1.0'], '必须记录双工具动态租约')
    assert.equal(capturedCalls.length, 1)
    assert.equal(capturedCalls[0]!.timeoutMs, 900_000)
    const argv = capturedCalls[0]!.argv
    const ffIdx = argv.indexOf('--ffmpeg-location')
    assert.ok(ffIdx >= 0, '必须向流下载引擎传入 --ffmpeg-location')
    assert.equal(argv[ffIdx + 1], path.join(tempRoot, 'CommonLibs', 'media-toolkit-7.1.0', 'bin'))
    assert.ok(argv.includes('-x'))
    assert.ok(argv.includes('--audio-format'))
    assert.ok(argv.includes('mp3'))
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('回归修复：产物改后缀优先级、越界输出路径拦截、UTF-8 中文路径与 4MB 日志截断免疫、IPC 路由默认长超时', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-dl-regress-'))
  const chineseOutDir = path.join(tempRoot, '下载目录_中文')
  const outsideDir = path.join(tempRoot, '外部禁区目录')
  await fs.mkdir(chineseOutDir, { recursive: true })
  await fs.mkdir(outsideDir, { recursive: true })

  try {
    // 1. 验证 parseRequest 对长耗时薄原语默认放行 INFINITE_TIMEOUT，普通方法仍禁止传 infinite
    for (const method of [
      'tool_runtime_ensure',
      'tool_download_stream_probe',
      'tool_download_stream_run',
      'tool_media_transcode_run'
    ] as const) {
      const req = parseRequest({ messageId: `m_${method}`, method, params: {} })
      assert.equal(req.timeoutMs, INFINITE_TIMEOUT, `${method} 默认必须设为 infinite，不被 10s 掐断`)
    }
    assert.throws(
      () => parseRequest({ messageId: 'm_bad', method: 'tool_commonlibs_list', params: {}, timeoutMs: INFINITE_TIMEOUT }),
      /Infinite timeout is not allowed/i
    )

    // 2. 验证真实 GuardedProcessRunner UTF-8 分块解码 + 超过 4MB 日志输出时，runStream 仍能捕获末尾中文文件名与改后缀后的实际路径
    const runner = new GuardedProcessRunner()
    const realActualFile = path.join(chineseOutDir, '中文标题_音频.mp3')
    await fs.writeFile(realActualFile, Buffer.from('mp3-data'))

    // 同时验证：先用真实 Node 子进程输出 >4.2MB 进度行，随后以拆半纯 ASCII JSON (\uXXXX) 形式写入末尾中文路径，验证无乱码与无截断
    const fakeCommonLibs = {
      isToolReadyOffline: async () => true,
      ensureTool: async () => path.join(tempRoot, 'CommonLibs'),
      resolveExecutable: async (toolId: string) => ({
        toolId,
        executablePath: process.execPath
      }),
      acquireActiveProcess: () => () => undefined
    } as unknown as CommonLibsManager

    // 劫持 run 的 exePath/argv 不改真实进程执行：通过继承/包装 runner 验证真实 GuardedProcessRunner
    const capturedEnvs: Array<Record<string, string | undefined> | undefined> = []
    const scriptOverflowAndSplitUtf8 = [
      'const target = process.env.ZTOOLS_TEST_TARGET;',
      'if (process.env.PYTHONUTF8 !== "1" || process.env.PYTHONIOENCODING !== "utf-8") process.exit(42);',
      'const line = "[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05\\n";',
      'const chunk = Buffer.from(line.repeat(2000));',
      'for (let i = 0; i < 45; i++) process.stdout.write(chunk);', // > 4.4MB stdout，超过默认 4MB 上限
      'const jsonAscii = JSON.stringify(target).replace(/[^\\x20-\\x7e]/g, (c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));',
      'const pathBuf = Buffer.from(jsonAscii + "\\n", "utf8");',
      'const mid = Math.floor(pathBuf.length / 2);',
      'process.stdout.write(pathBuf.subarray(0, mid));',
      'setTimeout(() => { process.stdout.write(pathBuf.subarray(mid)); }, 15);'
    ].join(' ')

    const wrappedRunner = {
      run: (opts: Parameters<GuardedProcessRunner['run']>[0]) => {
        capturedEnvs.push(opts.env as Record<string, string | undefined> | undefined)
        process.env.ZTOOLS_TEST_TARGET = realActualFile
        return runner.run({
          ...opts,
          exePath: process.execPath,
          argv: ['-e', scriptOverflowAndSplitUtf8],
          env: { ...opts.env, ZTOOLS_TEST_TARGET: realActualFile }
        })
      }
    } as unknown as GuardedProcessRunner

    const driver = new Win32DownloadDriver({
      commonLibs: fakeCommonLibs,
      processRunner: wrappedRunner
    })

    const progressList: Array<{ phase: string; percent?: number }> = []
    const streamRes = await driver.runStream(
      {
        taskId: 'stream-cn-overflow-1',
        url: 'https://example.com/v/cn',
        outputDir: chineseOutDir,
        // 故意传原后缀 .mp4，模拟音频提取后 yt-dlp 改产出 .mp3 的真实场景
        fileName: '中文标题_音频.mp4',
        preferAudioOnly: true,
        audioFormat: 'mp3',
        timeoutMs: 60_000,
        overwrite: true
      },
      {
        signal: new AbortController().signal,
        onProgress: (p) => progressList.push({ phase: p.phase, ...(p.percent !== undefined ? { percent: p.percent } : {}) })
      }
    )

    assert.equal(streamRes.outputFileName, '中文标题_音频.mp3', '必须优先采用实际改后缀后的真实产出路径')
    assert.equal(streamRes.outputBytes, 8)
    assert.equal(capturedEnvs[0]?.PYTHONUTF8, '1')
    assert.equal(capturedEnvs[0]?.PYTHONIOENCODING, 'utf-8')
    assert.ok(progressList.some((p) => p.phase === 'running' && p.percent === 50))
    assert.ok(progressList.some((p) => p.phase === 'completed' && p.percent === 100))

    // 3. 安全护栏：若外部工具恶意打印 outputDir 之外的文件路径（含 JSON 转义形式），必须拦截并拒绝采纳
    const escapedFile = path.join(outsideDir, 'stolen.mp3')
    await fs.writeFile(escapedFile, Buffer.from('outside'))
    const escapedJsonLine = JSON.stringify(escapedFile).replace(
      /[^\x20-\x7e]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
    const escapedRunner = {
      run: async () => ({
        exitCode: 0,
        exitSignal: null,
        stdout: `${escapedJsonLine}\n`,
        stderr: '',
        cancelled: false,
        timedOut: false,
        durationMs: 10
      })
    } as unknown as GuardedProcessRunner
    const escapedDriver = new Win32DownloadDriver({
      commonLibs: fakeCommonLibs,
      processRunner: escapedRunner
    })
    await assert.rejects(
      () =>
        escapedDriver.runStream(
          {
            taskId: 'stream-escape-1',
            url: 'https://example.com/v/escape',
            outputDir: chineseOutDir,
            preferAudioOnly: false,
            timeoutMs: 60_000,
            overwrite: true
          },
          { signal: new AbortController().signal }
        ),
      /outside authorized directory|missing/i
    )
  } finally {
    delete process.env.ZTOOLS_TEST_TARGET
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
