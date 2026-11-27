import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { ConcurrencyLimiter } from '../../src/main/tool-runtime/core/concurrency-limiter.js'
import { GuardedProcessRunner } from '../../src/main/tool-runtime/core/guarded-process.js'
import { PathSlotGuard } from '../../src/main/tool-runtime/core/path-slot-guard.js'
import {
  validateDownloadStreamProbeRequest,
  validateDownloadStreamRunRequest,
  validateDownloadTransferAddRequest,
  validateSafeDownloadUrl,
  validateSafeFileName
} from '../../src/main/tool-runtime/domains/download/policy.js'
import {
  buildSafeStreamRunArgv,
  parseReportedOutputPath,
  parseStreamProbeOutput
} from '../../src/main/tool-runtime/domains/download/drivers/stream-driver-base.js'
import {
  validateMediaProbeRequest,
  validateMediaTranscodeRequest
} from '../../src/main/tool-runtime/domains/media/policy.js'

/**
 * 主进程薄原语破坏性安全护栏全覆盖测试：
 * - 双端（Windows & macOS）系统关键目录、macOS /etc -> /private/etc、~/.ssh、~/Library/Keychains 硬拦截
 * - 宿主 <DataRoot>（CommonLibs/Libraries/Plugins）防写穿、symlink 逃逸、.. 穿越、空字节拦截
 * - PathGrantService 句柄归属/权限校验与拒绝跨 owner 越权
 * - 媒体/下载第一层平台无关白名单（未知字段 fail-closed、0 值安全、危险协议与云元数据 SSRF 拦截）
 * - GuardedProcessRunner 无 shell 启动、取消清理进程树、超时拦截与 ConcurrencyLimiter 并发限流
 */

const hostCaller: CallerIdentity = {
  type: 'main',
  webContentsId: 1
}

test('PathSlotGuard：Windows 系统目录、DataRoot 防写穿、空字节与路径穿越全拦截', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-psg-win-'))
  const dataRoot = path.join(tempRoot, 'DataV2')
  const workDir = path.join(tempRoot, 'workspace')
  await fs.mkdir(path.join(dataRoot, 'CommonLibs'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'Libraries'), { recursive: true })
  await fs.mkdir(workDir, { recursive: true })
  const inputFile = path.join(workDir, 'clip.mp4')
  await fs.writeFile(inputFile, Buffer.from('sample-media-bytes'))

  try {
    const guard = new PathSlotGuard({
      platform: 'win32',
      protectedRoots: [dataRoot],
      maxFilesPerTask: 3,
      maxFileBytes: 1024
    })

    // 正常文件读取放行
    const okRead = await guard.resolveSlot({ path: inputFile }, hostCaller, {
      access: 'read',
      expectKind: 'file'
    })
    assert.equal(okRead.sizeBytes, 18)

    // 正常目录外写新文件放行
    const okWrite = await guard.resolveSlot({ path: path.join(workDir, 'out.mp4') }, hostCaller, {
      access: 'write',
      expectKind: 'file',
      allowMissing: true
    })
    assert.ok(okWrite.resolvedPath.endsWith('out.mp4'))

    // 空字节与 .. 穿越必拦
    await assert.rejects(
      () => guard.resolveSlot({ path: `${workDir}\\a\0b.mp4` }, hostCaller, { access: 'write', expectKind: 'file', allowMissing: true }),
      /null|invalid|denied|unsafe/i
    )
    await assert.rejects(
      () => guard.resolveSlot({ path: `${workDir}\\..\\evil.mp4` }, hostCaller, { access: 'write', expectKind: 'file', allowMissing: true }),
      /traversal|\.\.|denied/i
    )

    // 宿主自身 DataRoot（CommonLibs / Libraries / Plugins）严禁写入
    for (const forbiddenTarget of [
      path.join(dataRoot, 'CommonLibs', 'hijack.exe'),
      path.join(dataRoot, 'Libraries', 'ffmpeg-1.0.0', 'hijack.dll'),
      path.join(dataRoot, 'Plugins', 'demo', 'index.js')
    ]) {
      await assert.rejects(
        () => guard.resolveSlot({ path: forbiddenTarget }, hostCaller, { access: 'write', expectKind: 'file', allowMissing: true }),
        /protected|denied|host/i,
        `宿主受保护目录必须拦截写入: ${forbiddenTarget}`
      )
    }

    // Windows 系统关键目录与用户隐私目录（~/.ssh）硬拦截（使用模拟平台校验防止依赖磁盘权限）
    const winSimGuard = new PathSlotGuard({
      platform: 'win32',
      homeDir: 'C:\\Users\\Test',
      protectedRoots: ['C:\\Users\\Test\\AppData\\Local\\ZTools\\Data'],
      skipDiskStatForSimulatedPlatform: true
    })
    for (const sysPath of [
      'C:\\Windows\\System32\\evil.dll',
      'C:\\Program Files\\App\\a.exe',
      'C:\\Program Files (x86)\\App\\a.exe',
      'C:\\ProgramData\\ZTools\\evil.bin',
      'D:\\System Volume Information\\x',
      'C:\\$Recycle.Bin\\x',
      'C:\\Users\\Test\\.ssh\\authorized_keys'
    ]) {
      await assert.rejects(
        () => winSimGuard.resolveSlot({ path: sysPath }, hostCaller, { access: 'write', expectKind: 'file', allowMissing: true }),
        /protected|system|denied/i,
        `Windows 禁区必须拦截: ${sysPath}`
      )
    }

    // 超出单任务最大文件数限制拦截
    await assert.rejects(
      () =>
        guard.resolveSlots(
          [{ path: inputFile }, { path: inputFile }, { path: inputFile }, { path: inputFile }],
          hostCaller,
          { access: 'read', expectKind: 'file' }
        ),
      /limit|exceed|maximum|too many/i
    )

    // 超出单文件最大体积拦截
    const hugeFile = path.join(workDir, 'huge.bin')
    await fs.writeFile(hugeFile, Buffer.alloc(2048))
    await assert.rejects(
      () => guard.resolveSlot({ path: hugeFile }, hostCaller, { access: 'read', expectKind: 'file' }),
      /size|limit|exceed|large/i
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('PathSlotGuard：macOS /private/etc、/private/var、~/.ssh、~/Library/Keychains 与 /Volumes 根目录硬拦截', async () => {
  const macGuard = new PathSlotGuard({
    platform: 'darwin',
    homeDir: '/Users/test',
    protectedRoots: ['/Users/test/Library/Application Support/ZTools/Data'],
    skipDiskStatForSimulatedPlatform: true
  })

  // 普通用户目录允许写入
  const allowed = await macGuard.resolveSlot(
    { path: '/Users/test/Downloads/output.mp4' },
    hostCaller,
    { access: 'write', expectKind: 'file', allowMissing: true }
  )
  assert.equal(allowed.resolvedPath, '/Users/test/Downloads/output.mp4')

  const forbiddenMacPaths = [
    '/System/Library/CoreServices/a',
    '/Library/Extensions/a',
    '/Applications/ZTools.app/Contents/MacOS/ZTools',
    '/usr/local/bin/evil',
    '/bin/sh',
    '/sbin/mount',
    '/etc/hosts',
    '/private/etc/hosts',
    '/var/db/evil',
    '/private/var/db/evil',
    '/Volumes',
    '/Users/test/.ssh/authorized_keys',
    '/Users/test/Library/Keychains/login.keychain-db',
    '/Users/test/Library/LaunchAgents/com.evil.plist',
    '/Users/test/Library/Application Support/ZTools/Data/CommonLibs/x'
  ]

  for (const target of forbiddenMacPaths) {
    await assert.rejects(
      () => macGuard.resolveSlot({ path: target }, hostCaller, { access: 'write', expectKind: 'file', allowMissing: true }),
      /protected|system|denied/i,
      `macOS 系统/隐私禁区必须拦截: ${target}`
    )
  }
})

test('PathSlotGuard：对接 PathGrantService 句柄校验，拦截跨 owner 越权与只读句柄越权写', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-psg-grant-'))
  const fileA = path.join(tempRoot, 'sample.mp4')
  await fs.writeFile(fileA, Buffer.from('abc'))

  try {
    const guard = new PathSlotGuard({
      platform: process.platform,
      pathGrants: {
        reference: (owner, grantId) => {
          if (owner !== 42 || grantId !== 'grant-readonly-1') {
            throw new Error('File grant is invalid or has been revoked')
          }
          return {
            grantId,
            displayName: 'sample.mp4',
            kind: 'file',
            operations: ['read']
          }
        },
        resolveGrantPath: (_owner, _grantId) => fileA
      }
    })

    const ownerCaller: CallerIdentity = { type: 'plugin', webContentsId: 42, pluginId: 'demo' }
    const otherCaller: CallerIdentity = { type: 'plugin', webContentsId: 99, pluginId: 'other' }

    // 本人持只读句柄读取通过
    const ok = await guard.resolveSlot({ grantId: 'grant-readonly-1' }, ownerCaller, {
      access: 'read',
      expectKind: 'file'
    })
    assert.equal(ok.viaGrant, true)

    // 跨 owner 复用 grantId 必须拒绝
    await assert.rejects(
      () => guard.resolveSlot({ grantId: 'grant-readonly-1' }, otherCaller, { access: 'read', expectKind: 'file' }),
      /grant|denied|invalid/i
    )

    // 只读句柄企图用于 write 必须拒绝
    await assert.rejects(
      () => guard.resolveSlot({ grantId: 'grant-readonly-1' }, ownerCaller, { access: 'write', expectKind: 'file' }),
      /write|permission|denied/i
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('媒体与下载第一层平台无关策略白名单：未知字段 fail-closed、合法 0 值放行、危险 URL/文件名拦截', () => {
  // 1. 媒体域：未知字段 fail-closed
  assert.throws(
    () =>
      validateMediaProbeRequest({
        inputs: [{ path: '/tmp/a.mp4' }],
        extraCliArgs: ['-f', 'lavfi']
      }),
    /unsupported fields/i
  )

  // 2. 媒体域：合法 0 值（startSec=0、opacity=0、marginPx=0）必须通过，绝不被 !val 误判
  const validTranscode = validateMediaTranscodeRequest({
    input: { path: '/tmp/in.mp4' },
    output: { path: '/tmp/out.mp4' },
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    trim: { startSec: 0, durationSec: 10 },
    watermark: {
      imageSlot: { path: '/tmp/logo.png' },
      position: 'bottom-right',
      opacity: 0,
      marginPx: 0
    }
  })
  assert.equal(validTranscode.trim?.startSec, 0)
  assert.equal(validTranscode.watermark?.opacity, 0)
  assert.equal(validTranscode.watermark?.marginPx, 0)

  // 3. 媒体域：矛盾选项与非法编解码器拒绝
  assert.throws(
    () =>
      validateMediaTranscodeRequest({
        input: { path: '/tmp/in.mp4' },
        output: { path: '/tmp/out.mp4' },
        container: 'mp4',
        extractAudioOnly: true,
        stripAudio: true
      }),
    /extractAudioOnly|stripAudio|cannot/i
  )

  // 4. 下载域：URL 协议白名单与云元数据/链路本地地址拦截
  assert.equal(validateSafeDownloadUrl('https://example.com/video/1'), 'https://example.com/video/1')
  for (const badUrl of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/a.zip',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
    'http://0.0.0.0:8080/secret',
    'https://example.com/a\r\nb'
  ]) {
    assert.throws(() => validateSafeDownloadUrl(badUrl), /url|protocol|blocked|control|host/i, `必须拦截危险 URL: ${badUrl}`)
  }

  // 5. 下载域：安全文件名防穿越与保留设备名
  assert.equal(validateSafeFileName('movie-1080p.mp4'), 'movie-1080p.mp4')
  for (const badName of ['../evil.exe', 'sub/dir.mp4', 'sub\\dir.mp4', 'CON.txt', 'a\0b.mp4']) {
    assert.throws(() => validateSafeFileName(badName), /fileName|invalid|reserved|separator|traversal/i)
  }

  // 6. 下载域：未知字段（如企图注入 exec / config）一律 fail-closed
  assert.throws(
    () =>
      validateDownloadStreamProbeRequest({
        url: 'https://example.com/v',
        exec: 'calc.exe'
      }),
    /unsupported fields/i
  )
  assert.throws(
    () =>
      validateDownloadStreamRunRequest({
        url: 'https://example.com/v',
        outputDir: { path: '/tmp' },
        postprocessorArgs: '--exec'
      }),
    /unsupported fields/i
  )
  assert.throws(
    () =>
      validateDownloadTransferAddRequest({
        url: 'https://example.com/file.bin',
        outputDir: { path: '/tmp' },
        maxConnections: 99
      }),
    /maxConnections/i
  )

  // 7. 下载域扩展：audioFormat / mergeContainer / timeoutMs 白名单与互斥拦截
  const validAudioRun = validateDownloadStreamRunRequest({
    url: 'https://example.com/v',
    outputDir: { path: '/tmp' },
    preferAudioOnly: true,
    audioFormat: 'mp3',
    timeoutMs: 1_800_000
  })
  assert.equal(validAudioRun.audioFormat, 'mp3')
  assert.equal(validAudioRun.timeoutMs, 1_800_000)

  const validMergeRun = validateDownloadStreamRunRequest({
    url: 'https://example.com/v',
    outputDir: { path: '/tmp' },
    trackId: '137+140',
    mergeContainer: 'mp4',
    timeoutMs: 600_000
  })
  assert.equal(validMergeRun.mergeContainer, 'mp4')

  assert.throws(
    () =>
      validateDownloadStreamRunRequest({
        url: 'https://example.com/v',
        outputDir: { path: '/tmp' },
        audioFormat: 'mp3'
      }),
    /preferAudioOnly/i
  )
  assert.throws(
    () =>
      validateDownloadStreamRunRequest({
        url: 'https://example.com/v',
        outputDir: { path: '/tmp' },
        preferAudioOnly: true,
        mergeContainer: 'mp4'
      }),
    /mergeContainer/i
  )
  assert.throws(
    () =>
      validateDownloadStreamRunRequest({
        url: 'https://example.com/v',
        outputDir: { path: '/tmp' },
        timeoutMs: 1_000
      }),
    /timeoutMs/i
  )

  // 8. 下载域驱动 argv 与探针元数据清洗验证
  const audioArgv = buildSafeStreamRunArgv(
    {
      taskId: 't-1',
      url: 'https://example.com/v',
      outputDir: '/tmp/out',
      preferAudioOnly: true,
      audioFormat: 'flac',
      timeoutMs: 1_800_000,
      overwrite: true
    },
    { ffmpegLocation: '/data/CommonLibs/media-toolkit-7.1.0/bin' }
  )
  assert.ok(audioArgv.includes('--ffmpeg-location'))
  assert.ok(audioArgv.includes('/data/CommonLibs/media-toolkit-7.1.0/bin'))
  assert.ok(audioArgv.includes('-x'))
  assert.ok(audioArgv.includes('--audio-format'))
  assert.ok(audioArgv.includes('flac'))

  const mergeArgv = buildSafeStreamRunArgv(
    {
      taskId: 't-2',
      url: 'https://example.com/v',
      outputDir: '/tmp/out',
      trackId: '137+140',
      preferAudioOnly: false,
      mergeContainer: 'mp4',
      timeoutMs: 1_800_000,
      overwrite: false
    },
    { ffmpegLocation: '/data/CommonLibs/media-toolkit-7.1.0/bin' }
  )
  assert.ok(mergeArgv.includes('--merge-output-format'))
  assert.ok(mergeArgv.includes('mp4'))
  const printIdx = mergeArgv.indexOf('--print')
  assert.ok(printIdx >= 0, '必须启用 --print 输出真实落盘路径')
  assert.equal(mergeArgv[printIdx + 1], 'after_move:%(filepath)j', '必须使用 JSON Unicode 转义输出以免疫 Windows 代码页乱码')

  // 解析 %(filepath)j 纯 ASCII Unicode 转义路径与破坏性输入拦截
  const sampleAbsPath = process.platform === 'win32'
    ? 'C:\\Users\\测试用户\\工作目录_中文路径\\sample.mp3'
    : '/tmp/工作目录_中文路径/sample.mp3'
  const asciiEscapedJson = JSON.stringify(sampleAbsPath).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  assert.equal(parseReportedOutputPath(asciiEscapedJson), sampleAbsPath)
  assert.equal(parseReportedOutputPath(sampleAbsPath), sampleAbsPath)
  assert.equal(parseReportedOutputPath('[download] 100% of 1.00MiB'), undefined)
  assert.equal(parseReportedOutputPath('"unterminated-json'), undefined)
  assert.equal(parseReportedOutputPath('"relative/path/file.mp3"'), undefined)
  assert.equal(parseReportedOutputPath('"C:\\\\bad\\u0000path\\\\a.mp3"'), undefined)
  assert.equal(parseReportedOutputPath('""'), undefined)

  const probed = parseStreamProbeOutput(
    JSON.stringify({
      title: 'Demo Clip',
      uploader: 'Creator A',
      thumbnail: '//i0.hdslb.com/bfs/archive/cover.jpg',
      webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      duration: 120,
      formats: [{ format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080 }]
    })
  )
  assert.equal(probed.uploader, 'Creator A')
  assert.equal(probed.thumbnail, 'https://i0.hdslb.com/bfs/archive/cover.jpg')
  assert.equal(probed.webpageUrl, 'https://www.bilibili.com/video/BV1xx411c7mD')

  // 危险协议封面与链接必须被静默过滤而非透传
  const unsafeProbed = parseStreamProbeOutput(
    JSON.stringify({
      title: 'Unsafe',
      thumbnail: 'javascript:alert(1)',
      webpage_url: 'file:///etc/passwd',
      formats: []
    })
  )
  assert.equal(unsafeProbed.thumbnail, undefined)
  assert.equal(unsafeProbed.webpageUrl, undefined)
})

test('GuardedProcessRunner 与 ConcurrencyLimiter：无 shell 防注入、AbortSignal 取消进程树与并发排队控制', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-gp-'))
  try {
    const runner = new GuardedProcessRunner({
      activeProcessesFile: path.join(tempRoot, '.active-processes.json')
    })

    // 1. shell: false 防命令注入：包含 & / | / ; 的参数不会被 shell 解释
    const injectedArg = 'safe-value & echo SHOULD_NOT_RUN'
    const echoRes = await runner.run({
      exePath: process.execPath,
      argv: ['-e', 'process.stdout.write(process.argv[1])', injectedArg],
      timeoutMs: 10_000
    })
    assert.equal(echoRes.exitCode, 0)
    assert.equal(echoRes.stdout, injectedArg)

    // 2. AbortSignal 取消立即终止子进程并返回 cancelled: true
    const ac = new AbortController()
    const runningPromise = runner.run({
      exePath: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      signal: ac.signal,
      timeoutMs: 30_000
    })
    setTimeout(() => ac.abort(), 150)
    const cancelledRes = await runningPromise
    assert.equal(cancelledRes.cancelled, true, 'AbortSignal 取消必须终止子进程并标记 cancelled=true')

    // 3. ConcurrencyLimiter 全局并发上限 + 插件并发上限 + 排队取消
    const limiter = new ConcurrencyLimiter({ maxGlobal: 2, maxPerPlugin: 1 })
    const lease1 = await limiter.acquire('plugin-a')
    let secondAcquired = false
    const waitAc = new AbortController()
    const waitPromise = limiter.acquire('plugin-a', waitAc.signal).then((l) => {
      secondAcquired = true
      return l
    })
    // 同插件并发达到 1，第二个请求必须排队
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(secondAcquired, false)
    // 取消排队任务立即释放等待
    waitAc.abort()
    await assert.rejects(() => waitPromise, /cancelled/i)
    lease1()

    // 4. reapOrphanProcesses 防 PID 复用误杀：startTime 不一致时严禁终止进程
    const killedPids: number[] = []
    const activeFile = path.join(tempRoot, '.active-reap-test.json')
    const baseTime = Date.now() - 60_000
    // 借用当前活跃子进程或用当前进程之外不存在 PID 不好断言，改为注入 startTime 校验行为测试（起一个存活子进程做验证）
    const sleeperAc = new AbortController()
    const sleeper = runner.run({
      exePath: process.execPath,
      argv: ['-e', 'setTimeout(() => {}, 10000)'],
      signal: sleeperAc.signal,
      timeoutMs: 10_000
    })
    await new Promise((r) => setTimeout(r, 100))
    const rawActive = JSON.parse(await fs.readFile(path.join(tempRoot, '.active-processes.json'), 'utf8')) as Array<{
      pid: number
      startTime: number
    }>
    assert.ok(rawActive.length >= 1)
    const targetPid = rawActive[0]!.pid
    await fs.writeFile(activeFile, JSON.stringify([{ pid: targetPid, startTime: baseTime - 3600_000 }]), 'utf8')
    const reaperMismatch = new GuardedProcessRunner({
      activeProcessesFile: activeFile,
      getProcessStartTimeMsImpl: async () => baseTime,
      terminateProcessTreeImpl: async (pid) => {
        killedPids.push(pid)
      }
    })
    const reapedMismatch = await reaperMismatch.reapOrphanProcesses()
    assert.equal(reapedMismatch, 0, 'PID 启动时间不匹配时必须跳过防误杀')
    assert.deepEqual(killedPids, [])
    sleeperAc.abort()
    await sleeper
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
