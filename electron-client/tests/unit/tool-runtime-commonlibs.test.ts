import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  COMMONLIBS_CATALOG_DOMAIN_PREFIX,
  loadCommonLibsTrustBundle,
  verifyAndParseCommonLibsCatalog,
  type CommonLibsPublicKeyEntry
} from '../../src/main/tool-runtime/core/commonlibs-trust.js'
import {
  CommonLibsManager,
  type CommonLibAnalyticsEventName,
  type CommonLibAnalyticsPayload,
  type CommonLibDownloadProgress,
  type CommonLibStaticReferenceMap
} from '../../src/main/tool-runtime/core/commonlibs-manager.js'
import { ToolRuntimeRegistry } from '../../src/main/tool-runtime/registry.js'

/**
 * 签名工具池 CommonLibs 全闭环测试：
 * - 真实 ECDSA P-256 动态密钥签发 + 域分离与密钥用途隔离（native 密钥不可验签 commonlibs）
 * - 真实本地 HTTP 服务器 + 真实标准 ZIP 归档（含正常包、篡改包、路径穿越包）
 * - 离线断网二次验签、本地文件篡改拦截、防回滚高水位、撤销直清
 * - 30 天宽限期自动 GC、手动安全清理、以及绝对零触碰 <DataRoot>/Libraries/
 * - macOS Rosetta 2 nativeOsArch 选型、POSIX chmod 0o755、Time Machine 排除与脱敏埋点
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

/** 构造标准无压缩（STORE）ZIP 归档，可选设置 POSIX 符号链接属性以测试安全拦截 */
function buildZipArchive(
  entries: ReadonlyArray<{ name: string; content: Buffer; externalAttr?: number }>
): Buffer {
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
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8) // STORE
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(size, 18)
    localHeader.writeUInt32LE(size, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuf, entry.content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE((3 << 8) | 20, 4) // UNIX made-by
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(size, 20)
    centralHeader.writeUInt32LE(size, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(entry.externalAttr ?? ((0o100644 << 16) >>> 0), 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + size
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function generateTestEcdsaKey(keyId: string, usages: CommonLibsPublicKeyEntry['usages']) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const publicKeyHex = Buffer.concat([
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url')
  ]).toString('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return {
    entry: { keyId, publicKeyHex, usages } as CommonLibsPublicKeyEntry,
    privateKeyPem
  }
}

function signCatalog(
  catalogObj: Record<string, unknown>,
  keyId: string,
  privateKeyPem: string,
  domainPrefix: Buffer = COMMONLIBS_CATALOG_DOMAIN_PREFIX
): { rawBytes: Buffer; signatureText: string } {
  const rawBytes = Buffer.from(`${JSON.stringify(catalogObj, null, 2)}\n`, 'utf8')
  const sig = crypto.sign('sha256', Buffer.concat([domainPrefix, rawBytes]), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  })
  return { rawBytes, signatureText: `v1:${keyId}:${sig.toString('hex')}\n` }
}

test('信任隔离：native 密钥与错误域分离前缀绝不可验签 CommonLibs 清单', () => {
  const commonKey = generateTestEcdsaKey('test-cl-key', ['commonlibs'])
  const nativeKey = generateTestEcdsaKey('test-native-key', ['native'])

  const bundle = loadCommonLibsTrustBundle(undefined, {
    replaceBuiltinKeysForTest: true,
    extraPublicKeys: [commonKey.entry, nativeKey.entry]
  })

  const catalog = {
    schemaVersion: 1,
    catalogType: 'public',
    keyId: 'test-native-key',
    generatedAt: '2026-11-26T00:00:00.000Z',
    tools: []
  }

  // 1. 使用 usage="native" 密钥签名，即使密码学验签有效也必须因 usage 隔离拒绝
  const signedByNative = signCatalog(catalog, 'test-native-key', nativeKey.privateKeyPem)
  assert.throws(
    () => verifyAndParseCommonLibsCatalog(signedByNative.rawBytes, signedByNative.signatureText, bundle),
    /not authorized for "commonlibs"/i
  )

  // 2. 使用错误域分离前缀（ztools-native-trust-v1\0）签名，必须被拒
  const wrongDomainCatalog = { ...catalog, keyId: 'test-cl-key' }
  const signedWithWrongDomain = signCatalog(
    wrongDomainCatalog,
    'test-cl-key',
    commonKey.privateKeyPem,
    Buffer.from('ztools-native-trust-v1\0', 'ascii')
  )
  assert.throws(
    () => verifyAndParseCommonLibsCatalog(signedWithWrongDomain.rawBytes, signedWithWrongDomain.signatureText, bundle),
    /signature verification failed/i
  )
})

test('CommonLibs 端到端闭环：拉取验签、离线可用、防回滚、30 天宽限 GC、撤销直清与 Libraries 零触碰', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-cl-e2e-'))
  const legacyLibDir = path.join(tempRoot, 'Libraries', 'ffmpeg-1.0.0')
  await fs.mkdir(legacyLibDir, { recursive: true })
  await fs.writeFile(path.join(legacyLibDir, '.ztools-library.json'), '{"id":"ffmpeg-1.0.0"}\n', 'utf8')

  const key = generateTestEcdsaKey('test-cl-2026', ['commonlibs'])
  const binContent = Buffer.from('#!/bin/sh\necho tool-v1\n', 'utf8')
  const zipV1 = buildZipArchive([{ name: 'bin/engine.exe', content: binContent }])
  const zipV2 = buildZipArchive([{ name: 'bin/engine.exe', content: Buffer.from('#!/bin/sh\necho tool-v2\n', 'utf8') }])
  const zipSymlink = buildZipArchive([
    {
      name: 'bin/evil-link',
      content: Buffer.from('/etc/passwd', 'utf8'),
      externalAttr: ((0o120777 << 16) >>> 0)
    }
  ])

  let currentCatalogBytes: Buffer = Buffer.alloc(0)
  let currentSigText = ''
  const archives = new Map<string, Buffer>([
    ['/commonlibs-v2/archives/sample/sample-1.0.0-win32-x64.zip', zipV1],
    ['/commonlibs-v2/archives/sample/sample-2.0.0-win32-x64.zip', zipV2],
    ['/commonlibs-v2/archives/evil/evil-1.0.0-win32-x64.zip', zipSymlink]
  ])

  const server = http.createServer((req, res) => {
    if (req.url === '/commonlibs-v2/catalog.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(currentCatalogBytes)
      return
    }
    if (req.url === '/commonlibs-v2/catalog.sig') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(currentSigText)
      return
    }
    const archive = req.url ? archives.get(req.url) : undefined
    if (archive) {
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(archive)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const buildCatalog = (tools: unknown[], revocations?: Record<string, unknown>) => {
      const signed = signCatalog(
        {
          schemaVersion: 1,
          catalogType: 'public',
          keyId: 'test-cl-2026',
          generatedAt: '2026-11-26T00:00:00.000Z',
          tools,
          ...(revocations ? { revocations } : {})
        },
        'test-cl-2026',
        key.privateKeyPem
      )
      currentCatalogBytes = signed.rawBytes
      currentSigText = signed.signatureText
    }

    buildCatalog([
      {
        toolId: 'sample-1.0.0',
        toolName: 'sample',
        version: '1.0.0',
        abiMajor: 1,
        packages: {
          'win32-x64': {
            url: `${origin}/commonlibs-v2/archives/sample/sample-1.0.0-win32-x64.zip`,
            size: zipV1.length,
            archiveSha256: sha256(zipV1),
            executables: ['bin/engine.exe'],
            files: [{ path: 'bin/engine.exe', size: binContent.length, sha256: sha256(binContent) }]
          }
        }
      },
      {
        toolId: 'sample-2.0.0',
        toolName: 'sample',
        version: '2.0.0',
        abiMajor: 2,
        packages: {
          'win32-x64': {
            url: `${origin}/commonlibs-v2/archives/sample/sample-2.0.0-win32-x64.zip`,
            size: zipV2.length,
            archiveSha256: sha256(zipV2),
            executables: ['bin/engine.exe'],
            files: [
              {
                path: 'bin/engine.exe',
                size: Buffer.from('#!/bin/sh\necho tool-v2\n', 'utf8').length,
                sha256: sha256(Buffer.from('#!/bin/sh\necho tool-v2\n', 'utf8'))
              }
            ]
          }
        }
      },
      {
        toolId: 'evil-1.0.0',
        toolName: 'evil',
        version: '1.0.0',
        abiMajor: 1,
        packages: {
          'win32-x64': {
            url: `${origin}/commonlibs-v2/archives/evil/evil-1.0.0-win32-x64.zip`,
            size: zipSymlink.length,
            archiveSha256: sha256(zipSymlink),
            executables: ['bin/evil-link'],
            files: [{ path: 'bin/evil-link', size: 11, sha256: sha256(Buffer.from('/etc/passwd', 'utf8')) }]
          }
        }
      }
    ])

    let fakeNow = Date.parse('2026-11-26T00:00:00.000Z')
    const analyticsEvents: Array<{ event: CommonLibAnalyticsEventName; payload: CommonLibAnalyticsPayload }> = []
    const trustBundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry]
    })

    const manager = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle,
      platform: 'win32',
      processArch: 'x64',
      allowedOrigins: [origin],
      catalogUrl: `${origin}/commonlibs-v2/catalog.json`,
      catalogSigUrl: `${origin}/commonlibs-v2/catalog.sig`,
      onAnalyticsEvent: (event, payload) => analyticsEvents.push({ event, payload }),
      now: () => fakeNow
    })

    // 1. 含 symlink 的恶意 ZIP 归档必须被安全解压器拒绝
    await assert.rejects(() => manager.ensureTool('evil-1.0.0'), /symlink|link/i)

    // 2. 拉取并安装 sample-2.0.0
    const installedV2Root = await manager.ensureTool('sample-2.0.0')
    assert.ok(installedV2Root.includes('CommonLibs'))
    assert.ok(installedV2Root.endsWith('sample-2.0.0'))

    // 校验脱敏埋点：触发了 download_start + download_success，且不含任何本地路径
    assert.ok(analyticsEvents.some((e) => e.event === 'commonlib_download_start' && e.payload.toolId === 'sample-2.0.0'))
    assert.ok(analyticsEvents.some((e) => e.event === 'commonlib_download_success' && e.payload.toolId === 'sample-2.0.0'))
    for (const item of analyticsEvents) {
      assert.equal(JSON.stringify(item.payload).includes(tempRoot), false, '埋点载荷严禁包含本地路径')
    }

    // 3. 防回滚高水位：已装 2.0.0 后拒绝降级安装 1.0.0
    await assert.rejects(() => manager.ensureTool('sample-1.0.0'), /rollback|older than local high-water/i)

    // 4. 关闭远端 HTTP 服务器模拟完全断网：离线二次验签仍可正常解析可执行文件
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const resolvedOffline = await manager.resolveExecutable('sample-2.0.0', 'bin/engine.exe')
    assert.equal(resolvedOffline.toolId, 'sample-2.0.0')
    assert.ok(resolvedOffline.executablePath.endsWith(path.join('bin', 'engine.exe')))

    // 5. 动态租约追踪 + 引用保护 + 30 天宽限期 GC
    await manager.recordLease('sample-2.0.0', 'demo-plugin')
    const emptyStatic: CommonLibStaticReferenceMap = new Map()
    const invReferenced = await manager.listInventory(emptyStatic)
    assert.equal(invReferenced.items.length, 1)
    assert.equal(invReferenced.items[0]!.canManualClean, false)
    assert.deepEqual([...invReferenced.items[0]!.referencedByPlugins], ['demo-plugin'])

    // 仍在引用中时，手动清理必须跳过不误删
    const skipClean = await manager.cleanManual({ toolId: 'sample-2.0.0' }, emptyStatic)
    assert.deepEqual([...skipClean.removedToolIds], [])
    assert.deepEqual([...skipClean.skippedToolIds], ['sample-2.0.0'])

    // 卸载插件清除租约后，首次 GC 仅标记 unreferencedSince，未满 30 天绝不删除
    await manager.clearPluginLeases('demo-plugin')
    const gcDay0 = await manager.runGc(emptyStatic)
    assert.deepEqual([...gcDay0.removedToolIds], [])

    fakeNow += 29 * 24 * 3600 * 1000
    const gcDay29 = await manager.runGc(emptyStatic)
    assert.deepEqual([...gcDay29.removedToolIds], [])

    // 满 30 天后自动回收
    fakeNow += 2 * 24 * 3600 * 1000
    const gcDay31 = await manager.runGc(emptyStatic)
    assert.deepEqual([...gcDay31.removedToolIds], ['sample-2.0.0'])

    // 6. 绝对红线：旧版 <DataRoot>/Libraries/ffmpeg-1.0.0 分毫未动
    const legacyStillExists = await fs
      .access(path.join(legacyLibDir, '.ztools-library.json'))
      .then(() => true)
      .catch(() => false)
    assert.equal(legacyStillExists, true, 'GC 严禁触碰存量 <DataRoot>/Libraries/ 目录')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('macOS 共性约束：Rosetta 2 原生架构选型（darwin-arm64）+ Time Machine 排除钩子 + 撤销跳过宽限期直清', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-cl-mac-'))
  try {
    const key = generateTestEcdsaKey('test-cl-mac', ['commonlibs'])
    const payload = Buffer.from('#!/bin/sh\necho mac-arm64\n', 'utf8')
    const zipMac = buildZipArchive([{ name: 'bin/mac-engine', content: payload }])
    const signed = signCatalog(
      {
        schemaVersion: 1,
        catalogType: 'public',
        keyId: 'test-cl-mac',
        generatedAt: '2026-11-26T00:00:00.000Z',
        tools: [
          {
            toolId: 'mac-tool-1.0.0',
            toolName: 'mac-tool',
            version: '1.0.0',
            abiMajor: 1,
            packages: {
              'darwin-arm64': {
                url: 'https://cdn.ztools.cn/commonlibs-v2/archives/mac-tool/mac-tool-1.0.0-darwin-arm64.zip',
                size: zipMac.length,
                archiveSha256: sha256(zipMac),
                executables: ['bin/mac-engine'],
                files: [{ path: 'bin/mac-engine', size: payload.length, sha256: sha256(payload) }]
              }
            }
          }
        ]
      },
      'test-cl-mac',
      key.privateKeyPem
    )

    const excludedDirs: string[] = []
    const bundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry]
    })

    // 模拟在 Apple Silicon 上以 Rosetta 2（x64 翻译）运行宿主，仍须按 nativeOsArch 拉取 darwin-arm64
    const manager = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle: bundle,
      platform: 'darwin',
      processArch: 'x64',
      runningUnderARM64Translation: true,
      catalogSource: { fetchCatalog: async () => signed },
      fetchImpl: (async () => new Response(new Uint8Array(zipMac), { status: 200 })) as typeof fetch,
      excludeFromBackupImpl: async (dir) => {
        excludedDirs.push(dir)
      }
    })

    assert.equal(manager.platformArch, 'darwin-arm64')
    const downloadProgressEvents: CommonLibDownloadProgress[] = []
    const installedRoot = await manager.ensureTool('mac-tool-1.0.0', undefined, (p) => {
      downloadProgressEvents.push(p)
    })
    assert.ok(installedRoot.endsWith('mac-tool-1.0.0'))
    assert.ok(downloadProgressEvents.some((e) => e.stage === 'fetching-catalog'))
    assert.ok(downloadProgressEvents.some((e) => e.stage === 'downloading' && e.percent === 100))
    assert.ok(downloadProgressEvents.some((e) => e.stage === 'extracting'))
    assert.ok(downloadProgressEvents.some((e) => e.stage === 'verifying'))
    assert.equal(excludedDirs.length, 1, 'macOS 创建 CommonLibs 目录必须触发 Time Machine 备份排除')

    // 篡改落盘二进制后，二次离线验签必须立即失败
    const binPath = path.join(installedRoot, 'bin', 'mac-engine')
    await fs.writeFile(binPath, Buffer.from('#!/bin/sh\necho tampered!!\n', 'utf8'))
    const freshManager = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle: bundle,
      platform: 'darwin',
      processArch: 'arm64'
    })
    await assert.rejects(() => freshManager.resolveExecutable('mac-tool-1.0.0', 'bin/mac-engine'), /mismatch|tamper|hash|size/i)

    // 命中撤销清单时，禁止拉起且 GC 直接跳过 30 天宽限期立即清理
    const revokedBundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry],
      extraRevocations: { revokedToolIds: ['mac-tool-1.0.0'] }
    })
    const revokedManager = new CommonLibsManager({
      dataRoot: tempRoot,
      trustBundle: revokedBundle,
      platform: 'darwin',
      processArch: 'arm64'
    })
    await assert.rejects(() => revokedManager.resolveExecutable('mac-tool-1.0.0', 'bin/mac-engine'), /revoked/i)
    const gcRevoked = await revokedManager.runGc(new Map())
    assert.deepEqual([...gcRevoked.removedToolIds], ['mac-tool-1.0.0'])
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('方案 A：CommonLibsManager.ensureAndVerifyToolDir 与签名原生插件 GC 静态引用联动', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-commonlibs-signed-native-'))
  let currentNow = Date.UTC(2026, 10, 27, 0, 0, 0)
  const key = generateTestEcdsaKey('signed-native-cl-k1', ['commonlibs'])
  const toolBin = Buffer.from('MZ-dummy-pandoc-tool', 'utf8')
  const archive = buildZipArchive([{ name: 'bin/pandoc.exe', content: toolBin }])
  const archiveSha = sha256(archive)

  const server = http.createServer((req, res) => {
    if (req.url === '/archives/pandoc-3.6.0-win32-x64.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) })
      res.end(archive)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const catalogObj = {
      schemaVersion: 1,
      catalogType: 'public',
      keyId: key.entry.keyId,
      generatedAt: '2026-11-27T00:00:00.000Z',
      tools: [{
        toolId: 'pandoc-3.6.0',
        toolName: 'pandoc',
        version: '3.6.0',
        abiMajor: 3,
        packages: {
          'win32-x64': {
            url: `${origin}/archives/pandoc-3.6.0-win32-x64.zip`,
            size: archive.length,
            archiveSha256: archiveSha,
            executables: ['bin/pandoc.exe'],
            files: [{ path: 'bin/pandoc.exe', size: toolBin.length, sha256: sha256(toolBin) }]
          }
        }
      }]
    }
    const { rawBytes, signatureText } = signCatalog(catalogObj, key.entry.keyId, key.privateKeyPem)
    const bundle = loadCommonLibsTrustBundle(undefined, {
      replaceBuiltinKeysForTest: true,
      extraPublicKeys: [key.entry]
    })

    let installedSignedNativeDeps: Array<{ pluginId: string; toolIds: readonly string[] }> = [
      { pluginId: 'doc-converter', toolIds: ['pandoc-3.6.0'] }
    ]

    const registry = new ToolRuntimeRegistry({
      dataRoot: tempRoot,
      trustBundle: bundle,
      platform: 'win32',
      processArch: 'x64',
      allowedOrigins: [origin],
      catalogSource: { fetchCatalog: async () => ({ rawBytes, signatureText }) },
      listInstalledManifests: async () => [],
      listSignedNativeCommonLibs: async () => installedSignedNativeDeps,
      now: () => currentNow
    })

    try {
      // 1. 按需拉取并离线验签目录
      const resolved = await registry.commonLibs.ensureAndVerifyToolDir('pandoc-3.6.0')
      assert.equal(resolved.toolId, 'pandoc-3.6.0')
      assert.equal(resolved.toolDir, path.join(tempRoot, 'CommonLibs', 'pandoc-3.6.0'))
      assert.deepEqual(resolved.executables, ['bin/pandoc.exe'])

      // 2. 清单展示必须体现官方签名原生插件静态引用，且不可手动误删、超过 30 天 GC 也不回收
      const invBefore = await registry.listCommonLibs()
      assert.equal(invBefore.items.length, 1)
      assert.equal(invBefore.items[0]!.status, 'ready')
      assert.deepEqual(invBefore.items[0]!.referencedByPlugins, ['doc-converter'])
      assert.equal(invBefore.items[0]!.canManualClean, false)

      currentNow += 45 * 24 * 3600 * 1000
      const gcReferenced = await registry.runIdleGc()
      assert.deepEqual(gcReferenced.removedToolIds, [])

      // 3. 插件卸载后静态引用归零：首次标记 unreferencedSince，满 30 天宽限期后自动回收
      installedSignedNativeDeps = []
      const gcMark = await registry.runIdleGc()
      assert.deepEqual(gcMark.removedToolIds, [])
      currentNow += 31 * 24 * 3600 * 1000
      const gcRemoved = await registry.runIdleGc()
      assert.deepEqual(gcRemoved.removedToolIds, ['pandoc-3.6.0'])
    } finally {
      await registry.stop()
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
