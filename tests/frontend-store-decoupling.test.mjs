/**
 * ZTools 客户端源码环境解耦、自营金标与安全熔断专项测试套件
 * (Frontend Store Decoupling, Official Golden Badge, 1-Byte Tamper Chaos & Kill-Switch Suite)
 *
 * 严格遵照 AGENTS.md 与测试用例规范：
 * 1. 默认包含集成测试 (Integration Tests by Default)：
 *    - 验证跨模块端到端链路：StoreCatalogManager -> 状态机 -> PluginInstallService 流式 SHA-256 校验与 Kill-Switch 拦截
 *    - 验证真实调用闭环：无纯浅层 Mock，搭建真实 HTTP 服务与真实磁盘文件
 * 2. 严禁仅写 Happy Path (Beyond Happy Path & Chaos Testing)：
 *    - 源码去中心化解耦：VITE_API_BASE_URL 为空/异常时的本地优先自愈与零报错降级
 *    - 供应链单字节恶意篡改注入（1-byte bit-flip）：精准拦截 CHECKSUM_MISMATCH 并安全清理，严禁解压
 *    - 全网下架 Kill-Switch 实时熔断：拦截启动、禁用安装、前端状态置灰并保留一键安全卸载
 *    - 自营金标与三态源过滤：official 置顶排序、三态过滤、官网链接与源码链接行为隔离
 */

import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import http from 'node:http'

import {
  StoreCatalogManager,
  resolveApiBaseUrl,
  normalizePluginId,
  matchPlugin
} from '../frontend/src/utils/storeCatalogManager.js'

import {
  PluginInstallService,
  verifyArchiveSha256
} from '../electron-client/out-test/src/main/services/plugin-install-service.js'

import {
  PluginStateService
} from '../electron-client/out-test/src/main/services/plugin-state-service.js'

import {
  errorCodes,
  ZToolsError
} from '../electron-client/out-test/src/contracts/errors.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

// 辅助函数：构造标准 ZIP 文件 Buffer
function createZipBuffer(files) {
  const localHeaders = []
  const centralHeaders = []
  let offset = 0

  for (const [filePath, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(filePath, 'utf8')
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const crc = zlib.crc32(dataBuf)
    const compressed = zlib.deflateRawSync(dataBuf)

    const localHeader = Buffer.alloc(30 + nameBuf.length)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(dataBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    nameBuf.copy(localHeader, 30)

    const centralHeader = Buffer.alloc(46 + nameBuf.length)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(dataBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    nameBuf.copy(centralHeader, 46)

    localHeaders.push(localHeader, compressed)
    centralHeaders.push(centralHeader)
    offset += localHeader.length + compressed.length
  }

  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(Object.keys(files).length, 8)
  endRecord.writeUInt16LE(Object.keys(files).length, 10)
  endRecord.writeUInt32LE(centralDirSize, 12)
  endRecord.writeUInt32LE(offset, 16)
  endRecord.writeUInt16LE(0, 20)

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord])
}

describe('客户端源码环境解耦、自营金标与安全熔断专项测试', () => {
  const tempTestDir = path.resolve(rootDir, 'electron-client/out-test/tmp/decoupling-test-' + Date.now())
  let mockServer = null
  let mockServerPort = 0
  let mockCatalogResponse = null
  let mockServerStatus = 200

  before(async () => {
    await fsPromises.mkdir(tempTestDir, { recursive: true })

    mockServer = http.createServer((req, res) => {
      if (mockServerStatus !== 200) {
        res.writeHead(mockServerStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Server Error ' + mockServerStatus }))
        return
      }

      if (req.url === '/api/plugins/catalog') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mockCatalogResponse || { success: true, list: [] }))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found' }))
    })

    await new Promise((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockServerPort = mockServer.address().port
        resolve()
      })
    })
  })

  after(async () => {
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve))
    }
    await fsPromises.rm(tempTestDir, { recursive: true, force: true }).catch(() => undefined)
  })

  // =========================================================================
  // 1. 源码去中心化解耦测试 (Decentralized Open Source Decoupling)
  // =========================================================================
  describe('1. 源码去中心化解耦测试 (开源中立 & 零报错降级)', () => {
    it('1.1 resolveApiBaseUrl 正确识别环境变量、空值与末尾斜杠去除', () => {
      assert.equal(resolveApiBaseUrl(''), '')
      assert.equal(resolveApiBaseUrl('   '), '')
      assert.equal(resolveApiBaseUrl(null), '')
      assert.equal(resolveApiBaseUrl(undefined), '')
      assert.equal(resolveApiBaseUrl('https://store.ztools.top/'), 'https://store.ztools.top')
      assert.equal(resolveApiBaseUrl('https://store.ztools.top///'), 'https://store.ztools.top')
      assert.equal(resolveApiBaseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
    })

    it('1.2 VITE_API_BASE_URL 为空时自动采用去中心化静态 Catalog 模式，无任何报错', async () => {
      const builtinPlugins = [
        { id: 'builtin-calc', name: '内置计算器', is_official: true, version: '1.0.0' },
        { id: 'community-notes', name: '社区便签', is_official: false, version: '1.2.0' }
      ]

      const manager = new StoreCatalogManager({
        apiBaseUrl: '', // 模拟开源社区开发者未配置任何官方服务地址
        getStaticCatalog: () => builtinPlugins
      })

      assert.equal(manager.apiBaseUrl, '')

      const res = await manager.ensureCatalog()
      assert.equal(res.source, 'decentralized_static')
      assert.equal(res.catalog.length, 2)
      assert.equal(res.catalog[0].id, 'builtin-calc')
      assert.equal(res.catalog[0].isOfficial, true)

      // 查询操作正常执行，零异常
      const searchRes = await manager.query({ keyword: '便签' })
      assert.equal(searchRes.total, 1)
      assert.equal(searchRes.list[0].id, 'community-notes')
    })

    it('1.3 VITE_API_BASE_URL 已配置时优先请求官方 Catalog，拉取成功后写入本地快照', async () => {
      let savedSnapshot = null
      mockServerStatus = 200
      mockCatalogResponse = {
        success: true,
        list: [
          {
            id: 'official-ocr',
            name: '官方 OCR 文字识别',
            version: '2.0.0',
            is_official: true,
            official_badge: '官方自营',
            downloads: 50000
          }
        ]
      }

      const manager = new StoreCatalogManager({
        apiBaseUrl: `http://127.0.0.1:${mockServerPort}`,
        saveLocalSnapshot: async (data) => {
          savedSnapshot = data
        }
      })

      const res = await manager.ensureCatalog()
      assert.equal(res.source, 'remote')
      assert.equal(res.catalog.length, 1)
      assert.equal(res.catalog[0].id, 'official-ocr')
      assert.equal(res.catalog[0].officialBadge, '官方自营')
      assert.ok(savedSnapshot !== null, '成功拉取后必须触发本地快照保存')
    })

    it('1.4 容灾与故障注入：远端接口 500、网络中断或返回畸形数据时，平滑回退至本地快照与静态兜底', async () => {
      mockServerStatus = 500 // 注入 500 熔断故障

      const fallbackStatic = [
        { id: 'offline-tool', name: '离线工具', version: '1.0.0', is_official: true }
      ]

      const manager = new StoreCatalogManager({
        apiBaseUrl: `http://127.0.0.1:${mockServerPort}`,
        loadLocalSnapshot: async () => null, // 无本地快照
        getStaticCatalog: () => fallbackStatic
      })

      // 绝不能抛出未捕获异常或引起前端崩溃
      const res = await manager.ensureCatalog()
      assert.ok(
        res.source === 'official_builtin' || res.source === 'builtin' || res.source === 'decentralized_static',
        '应平滑降级至内置/静态清单'
      )
      assert.equal(res.catalog.length, 1)
      assert.equal(res.catalog[0].id, 'offline-tool')
    })
  })

  // =========================================================================
  // 2. 自营金标、三态源过滤与置顶排序测试 (Official Golden Badge & Source Filtering)
  // =========================================================================
  describe('2. 自营金标、三态源过滤与置顶排序 (Official Golden Badge & Source Filtering)', () => {
    const mixedPlugins = [
      {
        id: 'community-git',
        name: 'Git 快捷助手',
        author: 'GeekCoder',
        downloads: 999999,
        is_official: false,
        source_type: 'community',
        repo_url: 'https://github.com/geek/git-helper'
      },
      {
        id: 'official-pdf',
        name: '官方 PDF 极速工具箱',
        author: 'ZTools 官方',
        downloads: 10,
        is_official: true,
        official_badge: '官方自营',
        source_type: 'official',
        homepage_url: 'https://ztools.cn/plugins/official-pdf'
      },
      {
        id: 'community-calc',
        name: '超算器',
        author: 'MathDev',
        downloads: 88888,
        is_official: false,
        source_type: 'community',
        repo_url: 'https://github.com/math/calc'
      },
      {
        id: 'official-ocr',
        name: '官方 OCR 识别',
        author: 'ZTools 官方',
        downloads: 50,
        is_official: true,
        official_badge: '官方自营',
        source_type: 'official',
        homepage_url: 'https://ztools.cn/plugins/official-ocr'
      }
    ]

    let manager = null

    beforeEach(() => {
      manager = new StoreCatalogManager({
        apiBaseUrl: '',
        getStaticCatalog: () => mixedPlugins
      })
    })

    it('2.1 元数据规范化：自营插件规范化 isOfficial=true 与 officialBadge=官方自营', async () => {
      const res = await manager.ensureCatalog()
      const officialPdf = res.catalog.find((p) => p.id === 'official-pdf')
      const communityGit = res.catalog.find((p) => p.id === 'community-git')

      assert.equal(officialPdf.isOfficial, true)
      assert.equal(officialPdf.is_official, true)
      assert.equal(officialPdf.officialBadge, '官方自营')
      assert.equal(officialPdf.homepageUrl, 'https://ztools.cn/plugins/official-pdf')

      assert.equal(communityGit.isOfficial, false)
      assert.equal(communityGit.is_official, false)
      assert.equal(communityGit.officialBadge, null)
      assert.equal(communityGit.repo_url, 'https://github.com/geek/git-helper')
    })

    it('2.2 置顶规则：在全部列表 (sourceType: all) 下，官方自营插件永远强制置顶排在最前', async () => {
      await manager.ensureCatalog()
      const queryRes = await manager.query({ sourceType: 'all', pageSize: 10 })

      assert.equal(queryRes.list.length, 4)
      // 前两名必须全部是官方自营插件（即便下载量仅有 10 和 50，远小于社区插件的 999999）
      assert.equal(queryRes.list[0].isOfficial, true)
      assert.equal(queryRes.list[1].isOfficial, true)
      assert.equal(queryRes.list[2].isOfficial, false)
      assert.equal(queryRes.list[3].isOfficial, false)

      const topPluginIds = [queryRes.list[0].id, queryRes.list[1].id]
      assert.ok(topPluginIds.includes('official-pdf'))
      assert.ok(topPluginIds.includes('official-ocr'))
    })

    it('2.3 三态过滤：sourceType: official 仅返回官方自营插件', async () => {
      await manager.ensureCatalog()
      const queryRes = await manager.query({ sourceType: 'official' })

      assert.equal(queryRes.total, 2)
      assert.equal(queryRes.list.length, 2)
      for (const item of queryRes.list) {
        assert.equal(item.isOfficial, true)
        assert.equal(item.officialBadge, '官方自营')
      }
    })

    it('2.4 三态过滤：sourceType: community 仅返回社区精选插件', async () => {
      await manager.ensureCatalog()
      const queryRes = await manager.query({ sourceType: 'community' })

      assert.equal(queryRes.total, 2)
      assert.equal(queryRes.list.length, 2)
      for (const item of queryRes.list) {
        assert.equal(item.isOfficial, false)
        assert.ok(item.repo_url !== undefined)
      }
    })

    it('2.5 分类别名兼容：category: official 或 category: 官方自营 同步触发自营过滤', async () => {
      await manager.ensureCatalog()
      const res1 = await manager.query({ category: 'official' })
      assert.equal(res1.total, 2)

      const res2 = await manager.query({ category: '官方自营' })
      assert.equal(res2.total, 2)
    })
  })

  // =========================================================================
  // 3. 客户端 SHA-256 完整性强校验与单字节篡改破坏性测试 (SHA-256 Tamper Chaos)
  // =========================================================================
  describe('3. 客户端 SHA-256 完整性校验与单字节篡改混沌测试 (SHA-256 Tamper Chaos)', () => {
    let validZipBuffer = null
    let validChecksum = ''
    let validZipPath = ''
    let tamperedZipPath = ''

    before(async () => {
      const pluginManifest = {
        id: 'secure-crypto-tool',
        name: '安全密码学测试组件',
        version: '1.0.0',
        author: 'SecurityTeam',
        entry: 'index.html',
        targets: [
          {
            id: 'windows-any',
            platform: 'windows',
            runtime: 'electron',
            arch: 'any'
          }
        ],
        nativeComponents: []
      }

      validZipBuffer = createZipBuffer({
        'plugin.json': JSON.stringify(pluginManifest, null, 2),
        'index.html': '<!DOCTYPE html><html><body>Secure Component</body></html>'
      })

      validChecksum = crypto.createHash('sha256').update(validZipBuffer).digest('hex')

      validZipPath = path.join(tempTestDir, 'valid-component.zip')
      tamperedZipPath = path.join(tempTestDir, 'tampered-component.zip')

      await fsPromises.writeFile(validZipPath, validZipBuffer)
    })

    it('3.1 真实 ZIP 压缩包在哈希吻合时流式校验成功并返回标准摘要', async () => {
      const computed = await verifyArchiveSha256(validZipPath, validChecksum)
      assert.equal(computed.toLowerCase(), validChecksum.toLowerCase())
      // 验证未被误删
      assert.ok(fs.existsSync(validZipPath))
    })

    it('3.2 供应链单字节恶意篡改注入：翻转 1 比特后必须精准拦截 CHECKSUM_MISMATCH 并安全清理', async () => {
      // 构造单字节篡改的畸形文件
      const tamperedBuffer = Buffer.from(validZipBuffer)
      // 恶意翻转第 16 字节中的第 1 位
      tamperedBuffer[16] ^= 0x01
      await fsPromises.writeFile(tamperedZipPath, tamperedBuffer)

      assert.ok(fs.existsSync(tamperedZipPath), '篡改文件应已落盘')

      // 执行流式校验：期望预期哈希依然是 validChecksum，但文件已被篡改
      let caughtError = null
      try {
        await verifyArchiveSha256(tamperedZipPath, validChecksum)
      } catch (error) {
        caughtError = error
      }

      assert.ok(caughtError !== null, '必须抛出异常拒绝篡改文件')
      assert.ok(
        caughtError instanceof ZToolsError || caughtError.code === errorCodes.checksumMismatch,
        '必须抛出标准 CHECKSUM_MISMATCH 错误码'
      )
      assert.equal(caughtError.code, errorCodes.checksumMismatch)
      assert.match(caughtError.message, /CHECKSUM_MISMATCH/)

      // 验证安全回滚防御：被篡改的文件必须被强制清理删除，防止任何残留或被意外解压
      assert.equal(fs.existsSync(tamperedZipPath), false, '校验失败后必须彻底销毁物理磁盘上的篡改包')
    })

    it('3.3 异常边界测试：畸形期望哈希（格式无效、非十六进制、过长或过短）直接拦截', async () => {
      const dummyPath = path.join(tempTestDir, 'dummy.zip')
      await fsPromises.writeFile(dummyPath, Buffer.from('not a zip'))

      // 长度不合规（不是 64 字符）
      await assert.rejects(
        verifyArchiveSha256(dummyPath, 'abc123invalid'),
        (err) => err instanceof ZToolsError && (err.code === errorCodes.checksumMismatch || err.code === errorCodes.pluginIntegrity)
      )

      // 含有非 16 进制字符
      await assert.rejects(
        verifyArchiveSha256(dummyPath, 'z'.repeat(64)),
        (err) => err instanceof ZToolsError && (err.code === errorCodes.checksumMismatch || err.code === errorCodes.pluginIntegrity)
      )

      await fsPromises.rm(dummyPath, { force: true })
    })

    it('3.4 集成验证：PluginInstallService verifyArchiveChecksum 方法接入校验闭环', async () => {
      const installService = new PluginInstallService(
        tempTestDir,
        { publishHostToMain() {} }
      )

      // 正常校验成功
      const result = await installService.verifyArchiveChecksum(validZipPath, validChecksum)
      assert.equal(result, validChecksum)

      // 篡改校验失败拦截
      const corruptPath = path.join(tempTestDir, 'corrupt-temp.zip')
      await fsPromises.writeFile(corruptPath, Buffer.from('corrupted zip bytes'))
      await assert.rejects(
        installService.verifyArchiveChecksum(corruptPath, validChecksum),
        (err) => err instanceof ZToolsError && err.code === errorCodes.checksumMismatch
      )
      assert.equal(fs.existsSync(corruptPath), false, 'corrupt 文件已被清理')
    })
  })

  // =========================================================================
  // 4. 全网紧急下架 Kill-Switch 实时熔断与卸载引导 (Kill-Switch Real-time Linkage)
  // =========================================================================
  describe('4. 全网紧急下架 Kill-Switch 实时熔断与卸载引导 (Kill-Switch Linkage)', () => {
    const revokedPluginId = 'vulnerable-malicious-plugin'
    const revocationReason = '该插件包含未经授权的外部网络窃密代码，已被官方全网紧急下架'
    let stateService = null
    let installService = null
    let publishedEvents = []

    before(async () => {
      const pluginDir = path.join(tempTestDir, 'Plugins', revokedPluginId)
      await fsPromises.mkdir(pluginDir, { recursive: true })
      await fsPromises.writeFile(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({
          id: revokedPluginId,
          name: '高危问题插件',
          version: '1.0.0',
          entry: 'index.html',
          enabled: true,
          targets: [
            {
              id: 'windows-any',
              platform: 'windows',
              runtime: 'electron',
              arch: 'any'
            }
          ],
          nativeComponents: []
        })
      )
      await fsPromises.writeFile(path.join(pluginDir, 'index.html'), '<h1>Exploit</h1>')

      stateService = new PluginStateService(tempTestDir)
      publishedEvents = []

      installService = new PluginInstallService(
        tempTestDir,
        {
          publishHostToMain(type, payload) {
            publishedEvents.push({ type, payload })
          }
        },
        { state: stateService }
      )
    })

    it('4.1 StoreCatalogManager 接收到 revoked 标记后，维护下架状态与原因', async () => {
      const manager = new StoreCatalogManager({
        apiBaseUrl: '',
        getStaticCatalog: () => [
          {
            id: revokedPluginId,
            name: '高危问题插件',
            revoked: true,
            revoked_reason: revocationReason
          }
        ]
      })

      await manager.ensureCatalog()
      const revInfo = manager.isRevoked(revokedPluginId)
      assert.equal(revInfo.revoked, true)
      assert.equal(revInfo.reason, revocationReason)
      assert.equal(manager.isRevoked('safe-plugin').revoked, false)
    })

    it('4.2 PluginStateService 持久化熔断标记：已下架插件无论如何调用 setEnabled 均保持禁用', async () => {
      // 写入下架标记
      await stateService.setRevoked(revokedPluginId, true, revocationReason)

      const status = await stateService.isRevoked(revokedPluginId)
      assert.equal(status.revoked, true)
      assert.equal(status.reason, revocationReason)

      // 无论 manifest 或调用方如何尝试更新为 enabled: true，isEnabled 必须坚决返回 false
      await stateService.update(revokedPluginId, (s) => {
        s.enabled = true
      })
      const isEnabled = await stateService.isEnabled(revokedPluginId, true)
      assert.equal(isEnabled, false, '被下架插件严禁被重新激活启用')
    })

    it('4.3 PluginInstallService 运行态强行拦截：withPluginManifest 拒绝启动并抛出权限拒绝', async () => {
      let launchError = null
      try {
        await installService.withPluginManifest(revokedPluginId, async () => {
          return 'should never run'
        })
      } catch (error) {
        launchError = error
      }

      assert.ok(launchError !== null, '必须拦截启动')
      assert.equal(launchError.code, errorCodes.permissionDenied)
      assert.match(launchError.message, /该插件已被官方下架禁用/)
      assert.match(launchError.message, new RegExp(revocationReason))
    })

    it('4.4 PluginInstallService 安装态强行拦截：startInstall 拒绝下架插件的安装请求', async () => {
      await assert.rejects(
        installService.startInstall(
          {
            pluginId: revokedPluginId,
            version: '1.0.1',
            url: 'http://127.0.0.1/exploit.zip',
            checksum: '0'.repeat(64)
          },
          false
        ),
        (err) => {
          return err instanceof ZToolsError &&
            err.code === errorCodes.permissionDenied &&
            err.message.includes('该插件已被官方下架，禁止安装')
        }
      )
    })

    it('4.5 PluginInstallService list() 输出准确标记 revoked: true, enabled: false 并提供下架原因', async () => {
      const listRes = await installService.list()
      const found = listRes.data.find((p) => p.pluginId === revokedPluginId)

      assert.ok(found !== undefined, '应能列出该已安装插件')
      assert.equal(found.revoked, true)
      assert.equal(found.enabled, false)
      assert.equal(found.revoked_reason, revocationReason)
      assert.equal(found.revokedReason, revocationReason)
    })

    it('4.6 引导安全卸载：已下架插件仍然允许安全卸载清理', async () => {
      const uninstallRes = await installService.uninstall({ pluginId: revokedPluginId })
      assert.equal(uninstallRes.success, true)

      // 验证插件目录已彻底清理
      const pluginDir = path.join(tempTestDir, 'Plugins', revokedPluginId)
      assert.equal(fs.existsSync(pluginDir), false, '卸载后插件目录必须被物理清空')
    })
  })
})
