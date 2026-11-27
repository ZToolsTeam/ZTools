import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolProgressEvent,
  type ToolRuntimeErrorCode
} from '../../src/contracts/tool-runtime/common.js'
import { toLocalizedPublicError } from '../../src/main/ipc/error-localizer.js'
import {
  CommonLibsManager,
  type CommonLibDownloadProgress
} from '../../src/main/tool-runtime/core/commonlibs-manager.js'
import {
  COMMONLIBS_CATALOG_DOMAIN_PREFIX,
  loadCommonLibsTrustBundle,
  type CommonLibsPublicKeyEntry
} from '../../src/main/tool-runtime/core/commonlibs-trust.js'
import {
  createToolRuntimeError,
  sanitizePublicErrorDetail
} from '../../src/main/tool-runtime/core/errors.js'
import {
  GuardedProcessRunner,
  type GuardedProcessResult,
  type GuardedProcessRunOptions
} from '../../src/main/tool-runtime/core/guarded-process.js'
import { DarwinMediaDriver } from '../../src/main/tool-runtime/domains/media/drivers/darwin-media.js'
import { Win32MediaDriver } from '../../src/main/tool-runtime/domains/media/drivers/win32-media.js'
import { ToolRuntimeRegistry } from '../../src/main/tool-runtime/registry.js'

/**
 * 薄原语容错兜底与插件级错误反馈全链路测试：
 * - 下载瞬时故障指数退避重试 + 多源白名单 CDN 自动切换 + 非可重试错误 Fail-Fast；
 * - 执行期二进制 ENOENT/损坏受控单次自愈 + EACCES 杀软拦截 Fail-Fast 不死循环；
 * - macOS 原生工具（mdls / afconvert）失败自动回退签名工具包；
 * - 非双端平台（linux）显式返回 unsupported 且保持 download.transfer ready；
 * - 超时错误拆分（TOOL_EXECUTION_TIMEOUT）、路径脱敏、全部 14 个 TOOL_* 双语本地化；
 * - tool_runtime_ensure 实时推送 provisioning 进度与失败态结构化错误元数据。
 */

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildZipArchive(entries: ReadonlyArray<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.content)
    const size = entry.content.length

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(size, 18)
    localHeader.writeUInt32LE(size, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localParts.push(localHeader, nameBuf, entry.content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE((3 << 8) | 20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(size, 20)
    centralHeader.writeUInt32LE(size, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt32LE((0o100755 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + size
  }
  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function generateTestKey(keyId: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const publicKeyHex = Buffer.concat([
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url')
  ]).toString('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return {
    entry: { keyId, publicKeyHex, usages: ['commonlibs'] } as CommonLibsPublicKeyEntry,
    privateKeyPem
  }
}

function signCatalog(catalogObj: Record<string, unknown>, keyId: string, privateKeyPem: string) {
  const rawBytes = Buffer.from(`${JSON.stringify(catalogObj, null, 2)}\n`, 'utf8')
  const sig = crypto.sign('sha256', Buffer.concat([COMMONLIBS_CATALOG_DOMAIN_PREFIX, rawBytes]), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  })
  return { rawBytes, signatureText: `v1:${keyId}:${sig.toString('hex')}\n` }
}

function createPluginCaller(pluginId: string, permissions: readonly string[]): CallerIdentity {
  return {
    type: 'main',
    webContentsId: 202,
    attributedPlugin: {
      pluginId,
      sessionId: 'sess-resilience-1',
      permissions: new Set(permissions),
      source: 'installed'
    }
  }
}

test('下载兜底：瞬时 503 指数退避重试 + 主源失效自动切换白名单备用源并验签落盘', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-cl-retry-'))
  try {
    const key = generateTestKey('retry-test-key')
    const binPayload = Buffer.from('#!/bin/sh\necho ok\n', 'utf8')
    const archive = buildZipArchive([{ name: 'bin/ffmpeg.exe', content: binPayload }])
    const primaryOrigin = 'https://primary.cdn.test'
    const backupOrigin = 'https://backup.cdn.test'
    const archivePath = '/commonlibs-v2/archives/media-toolkit/media-toolkit-7.1.0-win32-x64.zip'

    const signed = signCatalog(
      {
        schemaVersion: 1,
        catalogType: 'public',
        keyId: key.entry.keyId,
        generatedAt: '2026-11-27T00:00:00.000Z',
        tools: [
          {
            toolId: 'media-toolkit-7.1.0',
            toolName: 'media-toolkit',
            version: '7.1.0',
            abiMajor: 7,
            packages: {
              'win32-x64': {
                url: `${primaryOrigin}${archivePath}`,
                size: archive.length,
                archiveSha256: sha256(archive),
                executables: ['bin/ffmpeg.exe'],
                files: [{ path: 'bin/ffmpeg.exe', size: binPayload.length, sha256: sha256(binPayload) }]
              }
            }
          }
        ]
      },
      key.entry.keyId,
      key.privateKeyPem
    )

    let primaryCatalogHits = 0
    let backupCatalogHits = 0
    let primaryArchiveHits = 0
    let backupArchiveHits = 0

    const mockFetch: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === `${primaryOrigin}/commonlibs-v2/catalog.json` || url === `${primaryOrigin}/commonlibs-v2/catalog.sig`) {
        primaryCatalogHits += 1
        return new Response('Service Unavailable', { status: 503 })
      }
      if (url === `${backupOrigin}/commonlibs-v2/catalog.json`) {
        backupCatalogHits += 1
        return new Response(new Uint8Array(signed.rawBytes), { status: 200 })
      }
      if (url === `${backupOrigin}/commonlibs-v2/catalog.sig`) {
        return new Response(signed.signatureText, { status: 200 })
      }
      if (url === `${primaryOrigin}${archivePath}`) {
        primaryArchiveHits += 1
        throw new Error('ECONNRESET: transient primary socket reset')
      }
      if (url === `${backupOrigin}${archivePath}`) {
        backupArchiveHits += 1
        // 模拟备用源首次 502、第二次成功，验证备用源内部也支持退避重试
        if (backupArchiveHits === 1) {
          return new Response('Bad Gateway', { status: 502 })
        }
        return new Response(new Uint8Array(archive), { status: 200 })
      }
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    const bundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry]
    })
    const progressEvents: CommonLibDownloadProgress[] = []
    const manager = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle: bundle,
      platform: 'win32',
      processArch: 'x64',
      allowedOrigins: [primaryOrigin, backupOrigin],
      catalogUrl: `${primaryOrigin}/commonlibs-v2/catalog.json`,
      catalogSigUrl: `${primaryOrigin}/commonlibs-v2/catalog.sig`,
      fallbackCatalogBaseUrls: [`${backupOrigin}/commonlibs-v2`],
      maxDownloadRetries: 1,
      retryBaseDelayMs: 5,
      fetchImpl: mockFetch
    })

    const installedDir = await manager.ensureTool('media-toolkit-7.1.0', undefined, (p) => {
      progressEvents.push(p)
    })
    assert.ok(installedDir.endsWith('media-toolkit-7.1.0'))
    assert.ok(primaryCatalogHits >= 2, '主源目录应先执行重试')
    assert.equal(backupCatalogHits, 1, '主源耗尽后应切换备用镜像获取目录')
    assert.equal(primaryArchiveHits, 2, '主源归档应重试 1 次（总计 2 次）')
    assert.equal(backupArchiveHits, 2, '备用源归档首次 502 后应重试并在第 2 次成功')
    assert.ok(
      progressEvents.some((ev) => ev.stage === 'retrying' && ev.attempt !== undefined),
      '重试过程必须推送 stage=retrying 进度事件'
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('执行期二进制缺失受控单次自愈 + 杀软 EACCES 阻拦不死循环', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-bin-recover-'))
  try {
    const key = generateTestKey('recover-key')
    const probeBin = Buffer.from('probe-binary-bytes', 'utf8')
    const archive = buildZipArchive([{ name: 'bin/ffprobe.exe', content: probeBin }])
    const signed = signCatalog(
      {
        schemaVersion: 1,
        catalogType: 'public',
        keyId: key.entry.keyId,
        generatedAt: '2026-11-27T00:00:00.000Z',
        tools: [
          {
            toolId: 'media-toolkit-7.1.0',
            toolName: 'media-toolkit',
            version: '7.1.0',
            abiMajor: 7,
            packages: {
              'win32-x64': {
                url: 'https://cdn.ztools.cn/commonlibs-v2/archives/media-toolkit/media-toolkit-7.1.0-win32-x64.zip',
                size: archive.length,
                archiveSha256: sha256(archive),
                executables: ['bin/ffprobe.exe'],
                files: [{ path: 'bin/ffprobe.exe', size: probeBin.length, sha256: sha256(probeBin) }]
              }
            }
          }
        ]
      },
      key.entry.keyId,
      key.privateKeyPem
    )

    let archiveDownloads = 0
    const bundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry]
    })
    const commonLibs = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle: bundle,
      platform: 'win32',
      processArch: 'x64',
      catalogSource: { fetchCatalog: async () => signed },
      fetchImpl: (async () => {
        archiveDownloads += 1
        return new Response(new Uint8Array(archive), { status: 200 })
      }) as typeof fetch,
      maxDownloadRetries: 0
    })

    // 预先安装好工具包
    await commonLibs.ensureTool('media-toolkit-7.1.0')
    assert.equal(archiveDownloads, 1)

    // 场景 1：执行首次遇到 ENOENT（模拟二进制被外部删掉），触发一次自愈重装并成功返回
    let runCount = 0
    const fakeRunner = {
      run: async (opts: GuardedProcessRunOptions): Promise<GuardedProcessResult> => {
        runCount += 1
        if (runCount === 1) {
          await fs.unlink(opts.exePath)
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable,
            'Failed to spawn process (ENOENT)',
            { stage: 'executing', retryable: true, userAction: 'reinstall_tool' }
          )
        }
        return {
          exitCode: 0,
          exitSignal: null,
          stdout: JSON.stringify({
            format: { format_name: 'mp4', duration: '3.5', size: '1024' },
            streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }]
          }),
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 12
        }
      }
    } as unknown as GuardedProcessRunner

    const driver = new Win32MediaDriver({ commonLibs, processRunner: fakeRunner })
    const items = await driver.probe(
      [{ path: path.join(tempRoot, 'sample.mp4'), displayName: 'sample.mp4', sizeBytes: 1024 }],
      { signal: new AbortController().signal }
    )
    assert.equal(items.length, 1)
    assert.equal(archiveDownloads, 2, '文件确实缺失时应触发 1 次自动重装恢复')
    assert.equal(runCount, 2)

    // 场景 2：文件完好但始终被杀软 EACCES 阻拦，绝不重复下载，直接抛 TOOL_BINARY_UNAVAILABLE
    let blockedRuns = 0
    const blockedRunner = {
      run: async (): Promise<GuardedProcessResult> => {
        blockedRuns += 1
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable,
          'Failed to spawn process (EACCES)',
          { stage: 'executing', retryable: true, userAction: 'reinstall_tool' }
        )
      }
    } as unknown as GuardedProcessRunner

    const blockedDriver = new Win32MediaDriver({ commonLibs, processRunner: blockedRunner })
    await assert.rejects(
      () =>
        blockedDriver.probe(
          [{ path: path.join(tempRoot, 'sample.mp4'), displayName: 'sample.mp4', sizeBytes: 1024 }],
          { signal: new AbortController().signal }
        ),
      (err: unknown) => {
        const pub = (err as { details?: { public?: Record<string, unknown> } }).details?.public
        assert.equal(pub?.toolCode, TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable)
        assert.equal(pub?.userAction, 'reinstall_tool')
        assert.equal(pub?.retryable, true)
        return true
      }
    )
    assert.equal(archiveDownloads, 2, '文件本身完整性正常时不应盲目重下')
    assert.equal(blockedRuns, 1)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('macOS 双向兜底：原生 mdls / afconvert 失败时自动回退签名媒体工具包', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-mac-fallback-'))
  try {
    const key = generateTestKey('mac-fallback-key')
    const probeBin = Buffer.from('#!/bin/sh\necho probe\n', 'utf8')
    const transcodeBin = Buffer.from('#!/bin/sh\necho transcode\n', 'utf8')
    const archive = buildZipArchive([
      { name: 'bin/media-probe', content: probeBin },
      { name: 'bin/media-transcode', content: transcodeBin }
    ])
    const signed = signCatalog(
      {
        schemaVersion: 1,
        catalogType: 'public',
        keyId: key.entry.keyId,
        generatedAt: '2026-11-27T00:00:00.000Z',
        tools: [
          {
            toolId: 'darwin-media-toolkit-7.1.0',
            toolName: 'darwin-media-toolkit',
            version: '7.1.0',
            abiMajor: 7,
            packages: {
              'darwin-arm64': {
                url: 'https://cdn.ztools.cn/commonlibs-v2/archives/darwin-media/darwin-media-toolkit-7.1.0-darwin-arm64.zip',
                size: archive.length,
                archiveSha256: sha256(archive),
                executables: ['bin/media-probe', 'bin/media-transcode'],
                files: [
                  { path: 'bin/media-probe', size: probeBin.length, sha256: sha256(probeBin) },
                  { path: 'bin/media-transcode', size: transcodeBin.length, sha256: sha256(transcodeBin) }
                ]
              }
            }
          }
        ]
      },
      key.entry.keyId,
      key.privateKeyPem
    )

    const bundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry]
    })
    const commonLibs = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle: bundle,
      platform: 'darwin',
      processArch: 'arm64',
      catalogSource: { fetchCatalog: async () => signed },
      fetchImpl: (async () => new Response(new Uint8Array(archive), { status: 200 })) as typeof fetch,
      excludeFromBackupImpl: async () => undefined
    })

    const outputPath = path.join(tempRoot, 'out.wav')
    const invokedExes: string[] = []
    const fakeRunner = {
      run: async (opts: GuardedProcessRunOptions): Promise<GuardedProcessResult> => {
        invokedExes.push(opts.exePath)
        if (opts.exePath === '/usr/bin/mdls' || opts.exePath === '/usr/bin/afconvert') {
          return {
            exitCode: 1,
            exitSignal: null,
            stdout: '',
            stderr: 'native tool unsupported container',
            timedOut: false,
            cancelled: false,
            durationMs: 5
          }
        }
        if (opts.exePath.endsWith('media-probe')) {
          return {
            exitCode: 0,
            exitSignal: null,
            stdout: JSON.stringify({
              format: { format_name: 'matroska', duration: '9.2', size: '4096' },
              streams: [{ index: 0, codec_type: 'audio', codec_name: 'opus', sample_rate: '48000', channels: 2 }]
            }),
            stderr: '',
            timedOut: false,
            cancelled: false,
            durationMs: 10
          }
        }
        await fs.writeFile(outputPath, Buffer.from('RIFF-fake-wav-data'))
        return {
          exitCode: 0,
          exitSignal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 15
        }
      }
    } as unknown as GuardedProcessRunner

    const driver = new DarwinMediaDriver({
      commonLibs,
      processRunner: fakeRunner,
      enableSystemNativeTools: true
    })

    const probed = await driver.probe(
      [{ path: path.join(tempRoot, 'clip.mkv'), displayName: 'clip.mkv', sizeBytes: 4096 }],
      { signal: new AbortController().signal }
    )
    assert.equal(probed[0]?.container, 'matroska')
    assert.equal(invokedExes[0], '/usr/bin/mdls')
    assert.ok(invokedExes[1]?.endsWith('media-probe'), 'mdls 失败后应自动回退签名 media-probe')

    // 清理缓存后测试 afconvert 失败自动回退 media-transcode
    await fs.rm(path.join(tempRoot, 'CommonLibs', 'darwin-media-toolkit-7.1.0'), { recursive: true, force: true })
    commonLibs.invalidateToolCache('darwin-media-toolkit-7.1.0')
    invokedExes.length = 0

    const transcoded = await driver.transcode(
      {
        taskId: 'mac-fallback-task',
        inputPath: path.join(tempRoot, 'clip.ogg'),
        outputPath,
        overwrite: true,
        container: 'wav',
        extractAudioOnly: true,
        stripAudio: false
      },
      { signal: new AbortController().signal }
    )
    assert.equal(transcoded.container, 'wav')
    assert.ok(transcoded.outputBytes > 0)
    assert.equal(invokedExes[0], '/usr/bin/afconvert')
    assert.ok(invokedExes[1]?.endsWith('media-transcode'), 'afconvert 失败后应自动回退签名 media-transcode')
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('非双端平台（linux）显式返回 unsupported，且 tool_runtime_ensure 完整推送进度与失败元数据', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-platform-progress-'))
  try {
    const linuxProgress: ToolProgressEvent[] = []
    const linuxRegistry = new ToolRuntimeRegistry({
      dataRoot: path.join(tempRoot, 'linux-data'),
      platform: 'linux',
      onProgress: (ev) => linuxProgress.push(ev)
    })
    const handlers = linuxRegistry.getIpcHandlers()
    const caller = createPluginCaller('demo-plugin', ['media.read', 'media.process', 'network'])
    const signal = new AbortController().signal

    const snapshot = (await handlers.tool_runtime_capabilities({}, caller, signal)) as {
      platform: string
      capabilities: Array<{ primitiveId: string; status: string }>
    }
    assert.equal(snapshot.platform, 'other')
    assert.equal(snapshot.capabilities.find((c) => c.primitiveId === 'media.probe')?.status, 'unsupported')
    assert.equal(snapshot.capabilities.find((c) => c.primitiveId === 'media.transcode')?.status, 'unsupported')
    assert.equal(snapshot.capabilities.find((c) => c.primitiveId === 'download.stream')?.status, 'unsupported')
    assert.equal(snapshot.capabilities.find((c) => c.primitiveId === 'download.transfer')?.status, 'ready')

    await assert.rejects(
      () => handlers.tool_runtime_ensure({ primitiveId: 'media.probe' }, caller, signal),
      (err: unknown) => {
        const pub = (err as { details?: { public?: Record<string, unknown> } }).details?.public
        assert.equal(pub?.toolCode, TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported)
        assert.equal(pub?.primitiveId, 'media.probe')
        assert.equal(pub?.retryable, false)
        assert.equal(pub?.userAction, 'update_client')
        return true
      }
    )
    assert.ok(
      linuxProgress.some(
        (ev) =>
          ev.primitiveId === 'media.probe' &&
          ev.phase === 'failed' &&
          ev.errorCode === TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported &&
          ev.userAction === 'update_client'
      ),
      'tool_runtime_ensure 失败时必须推送带 errorCode 与 userAction 的 failed 进度事件'
    )

    await linuxRegistry.stop()
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('全部 14 个 TOOL_* 错误码双语本地化完整覆盖、超时拆分与路径脱敏', () => {
  const allToolCodes = Object.values(TOOL_RUNTIME_ERROR_CODES) as ToolRuntimeErrorCode[]
  assert.equal(allToolCodes.length, 14)

  for (const toolCode of allToolCodes) {
    const err = createToolRuntimeError(toolCode, `raw english error for ${toolCode}`, {
      primitiveId: 'media.transcode',
      detail: 'failed reading C:\\Users\\alice\\secret.mp4 and /Users/alice/private/demo.mov'
    })
    const zh = toLocalizedPublicError(err, 'zh-CN')
    const en = toLocalizedPublicError(err, 'en-US')

    assert.ok(/[\u4e00-\u9fa5]/.test(zh.message), `zh-CN 缺失中文本地化词条: ${toolCode} -> ${zh.message}`)
    assert.equal(/[\u4e00-\u9fa5]/.test(en.message), false, `en-US 不应包含中文: ${toolCode}`)
    assert.notEqual(en.message, `raw english error for ${toolCode}`, `en-US 应命中标准词典: ${toolCode}`)

    assert.equal(zh.details?.toolCode, toolCode)
    assert.equal(zh.details?.primitiveId, 'media.transcode')
    assert.equal(typeof zh.details?.stage, 'string')
    assert.equal(typeof zh.details?.retryable, 'boolean')
    assert.equal(typeof zh.details?.userAction, 'string')
    assert.equal(String(zh.details?.detail).includes('alice'), false, '公开 detail 严禁泄漏本机用户路径')
  }

  // 验证超时错误码独立映射到 REQUEST_TIMEOUT
  const timeoutErr = createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.executionTimeout, 'Media transcode timed out', {
    primitiveId: 'media.transcode',
    timedOut: true
  })
  const pubTimeout = toLocalizedPublicError(timeoutErr, 'zh-CN')
  assert.equal(pubTimeout.code, 'REQUEST_TIMEOUT')
  assert.equal(pubTimeout.details?.toolCode, TOOL_RUNTIME_ERROR_CODES.executionTimeout)
  assert.equal(pubTimeout.details?.timedOut, true)
  assert.equal(pubTimeout.details?.retryable, true)

  // 验证脱敏辅助函数
  const sanitized = sanitizePublicErrorDetail('Error at C:\\Users\\dev\\AppData\\Local\\file.mp4 and /Users/dev/a.mkv')
  assert.equal(sanitized?.includes('dev'), false)
  assert.ok(sanitized?.includes('<path>'))
})
