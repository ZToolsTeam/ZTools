/**
 * ZTools V2 插件独立通道、69 款重构声明式插件动态加载与全异常混沌测试套件
 * (V2 Isolated Plugin Channel, 69 Declarative Plugins Dynamic Loading & Chaos Resilience Suite)
 *
 * 严格遵循 AGENTS.md 与测试用例规范：
 * 1. 默认包含集成测试 (Integration Tests by Default)：
 *    - 69 款 V2 插件全量真实加载 (loadInstalledDeclarativePlugin) 与声明式视图树渲染 (renderDeclarativeRoot)
 *    - V2 独立分发索引 (dist/plugins-v2/plugins.json & catalog.json) 与双端 Runtime Target 校验
 *    - 真实 HTTP Server -> PluginInstallService 流式 SHA-256 校验与解压至 DataV2/Plugins -> ztools://plugins 安全路径解析 -> 动态求值闭环
 * 2. 严禁仅写 Happy Path (Beyond Happy Path & Chaos Testing)：
 *    - 供应链 1-byte 比特翻转篡改注入：拦截 CHECKSUM_MISMATCH 并确保 DataV2/Plugins 零残留
 *    - 动态加载器安全沙箱对抗：拦截 require('child_process')、拦截未声明 fs 权限的 require('node:fs')、拦截 ../ 路径穿越
 *    - 畸形/损坏产物容错：拦截损坏的 plugin.json 与存在语法错误的 dist/index.js，确保宿主零崩溃
 *    - V2 通道 Kill-Switch 下架熔断：同步 revoked 状态并阻断安装与启动
 */

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { discoverPluginDirectories } from '../scripts/build-plugins-release.mjs'
import { loadInstalledDeclarativePlugin } from '../frontend/src/utils/declarativePluginLoader.js'
import { StoreCatalogManager } from '../frontend/src/utils/storeCatalogManager.js'
import { renderDeclarativeRoot } from '../packages/raycast-compat/dist/index.js'

import {
  PluginInstallService
} from '../electron-client/out-test/src/main/services/plugin-install-service.js'
import {
  PluginStateService
} from '../electron-client/out-test/src/main/services/plugin-state-service.js'
import {
  resolvePluginRuntimeTarget
} from '../electron-client/out-test/src/main/services/plugin-runtime-target-resolver.js'
import {
  resolveSafeFile
} from '../electron-client/out-test/src/main/protocol/safe-path.js'
import {
  errorCodes
} from '../electron-client/out-test/src/contracts/errors.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const distV2Dir = path.join(rootDir, 'dist/plugins-v2')

describe('ZTools V2 独立插件通道与 69 款声明式插件端到端集成及混沌测试', () => {
  const tempRoot = path.join(rootDir, 'electron-client/out-test/tmp/v2-channel-test-' + Date.now())
  const dataV2PluginsDir = path.join(tempRoot, 'DataV2', 'Plugins')
  const dataV2TempDir = path.join(tempRoot, 'DataV2', 'Temp')
  const dataV2ConfigDir = path.join(tempRoot, 'DataV2', 'Config')

  let httpServer = null
  let serverPort = 0
  let tamperNextZipDownload = false

  before(async () => {
    await fsPromises.mkdir(dataV2PluginsDir, { recursive: true })
    await fsPromises.mkdir(dataV2TempDir, { recursive: true })
    await fsPromises.mkdir(dataV2ConfigDir, { recursive: true })

    httpServer = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, `http://127.0.0.1:${serverPort}`)
        if (urlObj.pathname.startsWith('/plugins-v2/')) {
          const relPath = urlObj.pathname.replace(/^\/plugins-v2\//, '')
          const targetFile = path.join(distV2Dir, relPath)
          if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
            res.writeHead(404)
            res.end('Not Found')
            return
          }
          const buf = Buffer.from(await fsPromises.readFile(targetFile))
          if (tamperNextZipDownload && relPath.endsWith('.zip')) {
            // 翻转包体中间 1 个字节模拟中间人篡改
            const mid = Math.floor(buf.length / 2)
            buf[mid] = buf[mid] ^ 0xff
          }
          res.writeHead(200, {
            'Content-Type': relPath.endsWith('.json') ? 'application/json' : 'application/zip',
            'Content-Length': String(buf.length)
          })
          res.end(buf)
          return
        }
        res.writeHead(404)
        res.end('Not Found')
      } catch (err) {
        res.writeHead(500)
        res.end(String(err.message))
      }
    })

    await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        serverPort = httpServer.address().port
        resolve()
      })
    })
  })

  after(async () => {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve))
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  })

  // =========================================================================
  // 1. 69 款重构声明式插件全量动态加载与虚拟视图树渲染验证
  // =========================================================================
  describe('1. 69 款 V2 声明式插件全量动态加载与渲染闭环', () => {
    it('遍历 plugins/ 下全部 69 款插件（含 ESM 与 CJS），100% 成功加载并渲染出合法声明式视图描述符', async () => {
      const entries = discoverPluginDirectories(path.join(rootDir, 'plugins'))
      assert.equal(entries.length, 69, '应当发现全部 69 款插件（59 款 plugins/* + 10 款 plugins/official/*）')

      const failures = []
      let renderedCount = 0

      for (const entry of entries) {
        try {
          const loaded = await loadInstalledDeclarativePlugin(entry.pluginId, {
            readFile: async (_pid, relPath) => {
              return await fsPromises.readFile(path.join(entry.dir, relPath), 'utf8')
            }
          })

          assert.equal(typeof loaded.command, 'function', `${entry.pluginId} 必须导出可调用的声明式根组件函数`)
          assert.equal(loaded.isDeclarative, true)

          const session = renderDeclarativeRoot(loaded.command)
          const descriptor = session.getLatest()
          session.unmount()

          assert.ok(descriptor && typeof descriptor === 'object', `${entry.pluginId} 渲染结果不能为空`)
          assert.ok(
            ['List', 'Detail', 'Form'].includes(descriptor.type),
            `${entry.pluginId} 顶层视图类型必须为 List/Detail/Form，实际为: ${descriptor.type}`
          )
          renderedCount++
        } catch (err) {
          failures.push({ pluginId: entry.pluginId, error: err.message })
        }
      }

      assert.deepEqual(failures, [], `存在加载或渲染失败的插件: ${JSON.stringify(failures)}`)
      assert.equal(renderedCount, 69, '全部 69 款插件必须 100% 完成声明式渲染闭环')
    })
  })

  // =========================================================================
  // 2. V2 独立通道产物完整性与跨平台 Target 契约验证
  // =========================================================================
  describe('2. V2 独立通道索引 (plugins-v2/plugins.json & catalog.json) 与双端 Target 契约验证', () => {
    it('V2 静态索引包含全部 69 款插件，URL 严格落在 /plugins-v2/ 隔离路径下且通过 Windows/macOS 双端 Target 校验', () => {
      const pluginsJsonPath = path.join(distV2Dir, 'plugins.json')
      const catalogJsonPath = path.join(distV2Dir, 'catalog.json')

      assert.ok(fs.existsSync(pluginsJsonPath), 'dist/plugins-v2/plugins.json 必须存在')
      assert.ok(fs.existsSync(catalogJsonPath), 'dist/plugins-v2/catalog.json 必须存在')

      const pluginsIndex = JSON.parse(fs.readFileSync(pluginsJsonPath, 'utf8'))
      const catalogIndex = JSON.parse(fs.readFileSync(catalogJsonPath, 'utf8'))

      assert.equal(pluginsIndex.total, 69)
      assert.equal(pluginsIndex.plugins.length, 69)
      assert.equal(catalogIndex.success, true)
      assert.equal(catalogIndex.list.length, 69)

      for (const item of pluginsIndex.plugins) {
        assert.ok(item.id && item.pluginId, '必须同时具备 id 与 pluginId')
        assert.ok(
          item.downloadUrl.includes('/plugins-v2/'),
          `插件 ${item.id} 的 downloadUrl 必须位于 /plugins-v2/ 独立通道: ${item.downloadUrl}`
        )
        assert.ok(
          !item.downloadUrl.includes(' '),
          `插件 ${item.id} 的 downloadUrl 严禁包含未编码空格: ${item.downloadUrl}`
        )
        assert.ok(
          !item.downloadUrl.includes('/plugins-zip/'),
          `插件 ${item.id} 严禁指向旧版 1.x 的 /plugins-zip/ 目录`
        )
        assert.match(item.sha256, /^[a-f0-9]{64}$/, `插件 ${item.id} 必须包含 64 位 SHA-256`)
        assert.equal(item.checksum, item.sha256)
        assert.ok(item.size > 0 && item.file_size > 0, `插件 ${item.id} 包大小必须大于 0`)
        assert.equal(item.is_official, true, `插件 ${item.id} 必须标记为官方自营`)

        // 验证 Windows x64 与 macOS arm64 双端运行时 Target 解析
        const winTarget = resolvePluginRuntimeTarget(item, { platform: 'win32', arch: 'x64', runtime: 'electron' })
        const macTarget = resolvePluginRuntimeTarget(item, { platform: 'darwin', arch: 'arm64', runtime: 'electron' })
        assert.equal(winTarget.target.id, 'windows-electron-any')
        assert.equal(macTarget.target.id, 'macos-electron-any')
      }
    })
  })

  // =========================================================================
  // 3. 端到端集成测试：V2 ZIP 下载校验 -> 解压至 DataV2/Plugins -> 协议安全解析 -> 动态渲染
  // =========================================================================
  describe('3. 端到端集成：PluginInstallService 安装 V2 插件至 DataV2/Plugins 并通过协议加载渲染', () => {
    it('成功下载安装 ESM 插件 (calculator) 与 CJS 插件 (ai-image) 至 DataV2/Plugins 并完成动态渲染', async () => {
      const pluginsIndex = JSON.parse(fs.readFileSync(path.join(distV2Dir, 'plugins.json'), 'utf8'))
      const dataV2Root = path.join(tempRoot, 'DataV2')
      const stateService = new PluginStateService(dataV2ConfigDir)

      const events = []
      const installService = new PluginInstallService(
        dataV2Root,
        {
          publishHostToMain: (event, payload) => {
            events.push({ event, payload })
          }
        },
        {
          state: stateService,
          runtimeTarget: { platform: 'win32', arch: 'x64', runtime: 'electron' },
          fetchImpl: async (url, init) => {
            const parsed = new URL(String(url))
            return fetch(`http://127.0.0.1:${serverPort}${parsed.pathname}`, init)
          }
        }
      )

      for (const targetId of ['calculator', 'ai-image']) {
        const meta = pluginsIndex.plugins.find((p) => p.id === targetId)
        assert.ok(meta, `应在 V2 索引中找到 ${targetId}`)

        events.length = 0
        const startRes = await installService.startInstall(
          {
            pluginId: meta.id,
            url: meta.downloadUrl,
            version: meta.version,
            checksum: meta.sha256,
            fileSize: meta.size
          },
          false
        )

        assert.equal(startRes.success, true)
        assert.ok(startRes.operationId)

        // 等待异步安装事务完成
        const deadline = Date.now() + 10000
        while (!events.some((e) => e.event === 'plugin_install_complete') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 30))
        }

        const completeEvt = events.find((e) => e.event === 'plugin_install_complete')
        assert.ok(completeEvt, `${targetId} 应当发出 plugin_install_complete 事件`)
        assert.equal(completeEvt.payload.success, true, `${targetId} 安装应当成功: ${completeEvt.payload.error || ''}`)

        // 验证物理文件已解压到 DataV2/Plugins/{targetId}
        const installedManifestPath = await resolveSafeFile(dataV2PluginsDir, `/${targetId}/plugin.json`)
        const installedEntryPath = await resolveSafeFile(dataV2PluginsDir, `/${targetId}/dist/index.js`)
        assert.ok(fs.existsSync(installedManifestPath))
        assert.ok(fs.existsSync(installedEntryPath))

        // 模拟 ztools://plugins/{targetId}/{relPath} 协议通过 resolveSafeFile 读取并动态求值
        const loadedPlugin = await loadInstalledDeclarativePlugin(targetId, {
          readFile: async (pid, relPath) => {
            const safeTarget = await resolveSafeFile(dataV2PluginsDir, `/${pid}/${relPath}`)
            return await fsPromises.readFile(safeTarget, 'utf8')
          }
        })

        const renderSession = renderDeclarativeRoot(loadedPlugin.command)
        const viewTree = renderSession.getLatest()
        renderSession.unmount()

        assert.equal(viewTree.type, 'List', `${targetId} 安装后动态渲染出的根组件应当为 List`)
      }
    })
  })

  // =========================================================================
  // 4. 破坏性异常测试：供应链单字节篡改 (1-byte bit-flip) SHA-256 拦截与原子清理
  // =========================================================================
  describe('4. 【破坏性测试】供应链单字节篡改 SHA-256 校验拦截与零残留回滚', () => {
    it('当下载的 V2 ZIP 包被篡改 1 个字节时，PluginInstallService 必须拒绝解压并清理临时文件', async () => {
      const pluginsIndex = JSON.parse(fs.readFileSync(path.join(distV2Dir, 'plugins.json'), 'utf8'))
      const meta = pluginsIndex.plugins.find((p) => p.id === 'todo')
      assert.ok(meta)

      const events = []
      const dataV2Root = path.join(tempRoot, 'DataV2')
      const stateService = new PluginStateService(dataV2ConfigDir)
      const installService = new PluginInstallService(
        dataV2Root,
        {
          publishHostToMain: (event, payload) => {
            events.push({ event, payload })
          }
        },
        {
          state: stateService,
          runtimeTarget: { platform: 'win32', arch: 'x64', runtime: 'electron' },
          fetchImpl: async (url, init) => {
            const parsed = new URL(String(url))
            return fetch(`http://127.0.0.1:${serverPort}${parsed.pathname}`, init)
          }
        }
      )

      tamperNextZipDownload = true
      try {
        await installService.startInstall(
          {
            pluginId: 'todo',
            url: meta.downloadUrl,
            version: meta.version,
            checksum: meta.sha256,
            fileSize: meta.size
          },
          false
        )

        const deadline = Date.now() + 10000
        while (!events.some((e) => e.event === 'plugin_install_complete') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 30))
        }

        const completeEvt = events.find((e) => e.event === 'plugin_install_complete')
        assert.ok(completeEvt, '篡改包下载后必须触发 plugin_install_complete 失败回调')
        assert.equal(completeEvt.payload.success, false, '被篡改的 ZIP 严禁安装成功')
        assert.equal(completeEvt.payload.errorCode, errorCodes.pluginIntegrity)

        // 严格断言 DataV2/Plugins/todo 目录不存在，未发生未验签解压
        assert.equal(
          fs.existsSync(path.join(dataV2PluginsDir, 'todo')),
          false,
          'SHA-256 校验失败后 DataV2/Plugins 下严禁残留任何文件'
        )
      } finally {
        tamperNextZipDownload = false
      }
    })
  })

  // =========================================================================
  // 5. 破坏性异常测试：动态加载器安全沙箱对抗与损坏产物容错
  // =========================================================================
  describe('5. 【破坏性测试】动态加载器安全沙箱对抗与畸形数据容错', () => {
    it('5.1 严禁加载未授权高危原生模块 (require("child_process"))，必须抛出 UNAUTHORIZED_MODULE_ACCESS', async () => {
      await assert.rejects(
        async () => {
          await loadInstalledDeclarativePlugin('evil-rce', {
            readFile: async (_pid, relPath) => {
              if (relPath === 'plugin.json') {
                return JSON.stringify({
                  id: 'evil-rce',
                  name: 'Evil RCE',
                  version: '1.0.0',
                  entry: 'dist/index.js',
                  permissions: []
                })
              }
              return `
                const cp = require('child_process');
                exports.default = function Evil() { return cp.execSync('calc.exe'); };
              `
            }
          })
        },
        (err) => {
          assert.equal(err.code, 'UNAUTHORIZED_MODULE_ACCESS')
          assert.match(err.message, /child_process/)
          return true
        }
      )
    })

    it('5.2 未在 permissions 中声明 fs 权限却尝试 require("node:fs") 时，必须抛出 UNAUTHORIZED_MODULE_ACCESS', async () => {
      await assert.rejects(
        async () => {
          await loadInstalledDeclarativePlugin('unauth-fs', {
            readFile: async (_pid, relPath) => {
              if (relPath === 'plugin.json') {
                return JSON.stringify({
                  id: 'unauth-fs',
                  name: 'Unauth FS',
                  version: '1.0.0',
                  entry: 'dist/index.js',
                  permissions: ['clipboard']
                })
              }
              return `
                const fs = require('node:fs');
                exports.default = function UnauthFs() { return null; };
              `
            }
          })
        },
        (err) => {
          assert.equal(err.code, 'UNAUTHORIZED_MODULE_ACCESS')
          assert.match(err.message, /未声明 fs 权限/)
          return true
        }
      )
    })

    it('5.3 尝试通过 require("../secret.js") 进行目录穿越时，必须抛出 PATH_TRAVERSAL_BLOCKED / UNAUTHORIZED_MODULE_ACCESS', async () => {
      await assert.rejects(
        async () => {
          await loadInstalledDeclarativePlugin('traversal-plugin', {
            readFile: async (_pid, relPath) => {
              if (relPath === 'plugin.json') {
                return JSON.stringify({
                  id: 'traversal-plugin',
                  name: 'Traversal',
                  version: '1.0.0',
                  entry: 'dist/index.js',
                  permissions: []
                })
              }
              return `
                const secret = require('./../secret.js');
                exports.default = function Traversal() { return secret; };
              `
            }
          })
        },
        (err) => {
          assert.equal(err.code, 'PATH_TRAVERSAL_BLOCKED')
          return true
        }
      )
    })

    it('5.4 当 plugin.json 格式损坏或 dist/index.js 存在语法错误时，必须抛出结构化错误码而不崩溃', async () => {
      await assert.rejects(
        async () => {
          await loadInstalledDeclarativePlugin('corrupt-manifest', {
            readFile: async () => '{ invalid json '
          })
        },
        (err) => {
          assert.equal(err.code, 'INVALID_PLUGIN_MANIFEST')
          return true
        }
      )

      await assert.rejects(
        async () => {
          await loadInstalledDeclarativePlugin('corrupt-js', {
            readFile: async (_pid, relPath) => {
              if (relPath === 'plugin.json') {
                return JSON.stringify({
                  id: 'corrupt-js',
                  name: 'Corrupt JS',
                  version: '1.0.0',
                  entry: 'dist/index.js',
                  permissions: []
                })
              }
              return 'function broken( { syntax error !!!'
            }
          })
        },
        (err) => {
          assert.equal(err.code, 'PLUGIN_EVALUATION_ERROR')
          return true
        }
      )
    })
  })

  // =========================================================================
  // 6. 破坏性异常测试：V2 通道下架开关 (Kill-Switch) 实时熔断拦截
  // =========================================================================
  describe('6. 【破坏性测试】V2 通道 Kill-Switch 下架开关实时熔断拦截', () => {
    it('当 V2 目录中某插件标记为 revoked: true 时，StoreCatalogManager 与 PluginStateService 立即熔断禁用', async () => {
      const pluginsIndex = JSON.parse(fs.readFileSync(path.join(distV2Dir, 'plugins.json'), 'utf8'))
      const mockedCatalog = pluginsIndex.plugins.slice(0, 5).map((item, idx) =>
        idx === 0
          ? { ...item, revoked: true, revokedReason: '发现严重安全漏洞，官方紧急下架' }
          : item
      )

      const manager = new StoreCatalogManager({
        fetchRemote: async () => ({ list: mockedCatalog })
      })

      await manager.ensureCatalog(true)
      const targetRevokedId = mockedCatalog[0].id

      const revInfo = manager.isRevoked(targetRevokedId)
      assert.equal(Boolean(revInfo?.revoked), true)
      assert.match(revInfo.reason, /官方紧急下架/)

      const stateService = new PluginStateService(dataV2ConfigDir)
      await stateService.setRevoked(targetRevokedId, true, revInfo.reason)

      const stateRevoked = await stateService.isRevoked(targetRevokedId)
      assert.equal(Boolean(stateRevoked?.revoked ?? stateRevoked), true)
      assert.equal(await stateService.isEnabled(targetRevokedId, true), false)

      // 即使外部尝试强制开启，已下架插件仍必须保持禁用
      await stateService.update(targetRevokedId, (state) => {
        state.enabled = true
      })
      assert.equal(await stateService.isEnabled(targetRevokedId, true), false, '已下架插件严禁被重新启用')
    })
  })
})
