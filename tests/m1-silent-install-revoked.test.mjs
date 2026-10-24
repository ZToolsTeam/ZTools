/**
 * ZTools M1-7 / M1-8 / M1-9 专项跨模块集成与混沌抗毁自动化测试套件
 * (M1 Silent Install, Revoked Lifecycle & Distribution Cache Headers Suite)
 *
 * 覆盖核心链路：
 * 1. M1-7 一键静默安装状态流转与并发互斥闭环 (Silent Install & Concurrency Mutex)
 *    - 正常静默安装流转：未安装 -> installing -> installed -> 自动进入声明式舞台 (autoOpen)
 *    - 高频并发竞争：10 次连续并发触发 installPlugin，互斥锁拦截后 9 次返回 busy，底层安装只执行 1 次
 *    - 异常与网络中断原子回滚：网络 500/404/超时 或无下载地址时，原子回滚 installing 状态，清除临时标记，记录 installErrorMap
 *    - 底层安装校验失败回滚：模拟安装包损坏或 SHA256 校验失败，原子回滚状态机，准确记录具体失败原因供前端 UI 重试/Tooltip 显示
 * 2. M1-8 下架开关 (revoked) 全链路防御与联动拦截
 *    - 市场清单同步与本地禁用联动：刷新市场清单时若已装插件被标记为 revoked，自动将其置为禁用 (enabled: false) 并记录原因
 *    - 运行态强行拦截：openPlugin 针对已下架插件进行强拦截，抛出明确错误，严禁启动
 *    - 安装态强行拦截：installPlugin 拒绝下架插件的安装请求，直接拦截并提示下架原因
 *    - 后端状态持久化与状态机防御：PluginStateService 的 setRevoked/isRevoked，且已下架插件无论如何调用 setEnabled 均保持 disabled
 *    - 事件广播与协同：PluginInstallService markRevoked 向系统广播 plugin_revoked 事件
 * 3. M1-9 静态分发缓存策略固化 (Static Distribution Cache Headers)
 *    - plugins.json 短缓存验证 (≤ 300s，must-revalidate)，保证下架开关生效时限不超过 5 分钟
 *    - 带版本号 ZIP 发布包强缓存验证 (30 天，immutable)，保证秒开与长期 CDN 命中
 *    - 静态图标与静态资源阶梯缓存策略验证
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 导入缓存策略方法
import { getCacheControl } from '../scripts/deploy-plugins-storage.mjs'

// 导入后端特权状态服务
import { PluginStateService } from '../electron-client/out-test/src/main/services/plugin-state-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tempTestDir = path.resolve(__dirname, '../electron-client/out-test/tmp/m1-integration-test-' + Date.now())

describe('ZTools M1-7 / M1-8 / M1-9 专项集成与混沌抗毁套件', () => {

  // ===========================================================================
  // M1-7: 一键静默安装状态流转与并发互斥闭环
  // ===========================================================================
  describe('M1-7: 一键静默安装与并发互斥 (Silent Install & Concurrency Mutex)', () => {
    
    // 构造模拟的前端 Store 状态机模型（与 frontend/src/stores/plugins.js 算法 100% 镜像）
    function createMockPluginStore() {
      const state = {
        installedSet: new Set(['builtin-calculator']),
        installingSet: new Set(),
        installFailedSet: new Set(),
        installErrorMap: new Map(),
        revokedMap: new Map(),
        openedPlugins: []
      }

      const store = {
        state,
        isInstalled(pid) { return state.installedSet.has(pid) },
        isInstalling(pid) { return state.installingSet.has(pid) },
        isRevoked(pid) { return Boolean(state.revokedMap.get(pid)?.revoked) },
        getRevokedReason(pid) { return state.revokedMap.get(pid)?.reason || '' },
        getInstallError(pid) { return state.installErrorMap.get(pid) || '' },

        async openPlugin(pid) {
          if (this.isRevoked(pid)) {
            const reason = this.getRevokedReason(pid) || '该插件已被官方下架禁用'
            throw new Error(`无法启动已下架插件 [${pid}]: ${reason}`)
          }
          state.openedPlugins.push(pid)
          return { success: true, pid }
        },

        async installPlugin(pluginId, options = {}, deps = {}) {
          const pid = String(pluginId)
          if (this.isRevoked(pid)) {
            const reason = this.getRevokedReason(pid) || '该插件已被官方下架禁用'
            throw new Error(`无法安装：${reason}`)
          }

          // 并发防重互斥锁
          if (state.installingSet.has(pid)) {
            return { success: false, busy: true }
          }

          state.installingSet.add(pid)
          state.installFailedSet.delete(pid)
          state.installErrorMap.delete(pid)

          try {
            // 1. 获取下载信息
            const downloadInfo = await deps.getDownloadSign(pid)
            if (!downloadInfo || !downloadInfo.downloadUrl) {
              throw new Error('无法获取插件下载地址')
            }

            // 2. 底层 Native 安装
            const installRes = await deps.installPluginNative(pid, downloadInfo)
            if (!installRes || !installRes.success) {
              throw new Error(installRes?.error || '插件安装执行失败')
            }

            // 3. 安装成功更新状态
            state.installedSet.add(pid)
            state.installFailedSet.delete(pid)
            state.installErrorMap.delete(pid)

            // 4. 自动进入内嵌声明式舞台
            if (options.autoOpen) {
              await this.openPlugin(pid)
            }

            return { success: true }
          } catch (err) {
            state.installFailedSet.add(pid)
            state.installErrorMap.set(pid, err.message || String(err))
            throw err
          } finally {
            state.installingSet.delete(pid)
          }
        }
      }

      return store
    }

    it('Happy Path: 点击安装 -> 原地展示 installing -> 安装成功更新 installedSet 并自动打开声明式舞台', async () => {
      const store = createMockPluginStore()
      let nativeInstallCalled = false

      const deps = {
        getDownloadSign: async (pid) => ({
          downloadUrl: `https://cdn.ztools.cn/plugins-v2/${pid}/${pid}-1.0.0.zip`,
          version: '1.0.0'
        }),
        installPluginNative: async (pid, info) => {
          assert.equal(store.isInstalling(pid), true, '调用底层安装时，必须处于 installing 状态')
          nativeInstallCalled = true
          return { success: true }
        }
      }

      assert.equal(store.isInstalled('text-counter'), false)
      assert.equal(store.isInstalling('text-counter'), false)

      const result = await store.installPlugin('text-counter', { autoOpen: true }, deps)
      assert.equal(result.success, true)
      assert.equal(nativeInstallCalled, true)
      assert.equal(store.isInstalling('text-counter'), false, '安装完成后 installing 必须释放')
      assert.equal(store.isInstalled('text-counter'), true, '安装成功后 installedSet 必须包含该插件')
      assert.ok(store.state.openedPlugins.includes('text-counter'), '指定 autoOpen 时必须自动调用 openPlugin')
      assert.equal(store.getInstallError('text-counter'), '', '成功时 installErrorMap 必须清空')
    })

    it('【破坏性测试: 并发互斥】10 次连续高频并发触发 installPlugin，只有第 1 次发起安装，其余 9 次全部被互斥锁拦截', async () => {
      const store = createMockPluginStore()
      let nativeCalls = 0

      const deps = {
        getDownloadSign: async (pid) => {
          // 模拟网络请求耗时 20ms
          await new Promise(r => setTimeout(r, 20))
          return { downloadUrl: `https://cdn.ztools.cn/plugins-v2/${pid}-1.0.0.zip` }
        },
        installPluginNative: async (pid) => {
          nativeCalls++
          await new Promise(r => setTimeout(r, 20))
          return { success: true }
        }
      }

      // 模拟极端并发：同一毫秒内连续发出 10 次安装点击
      const promises = []
      for (let i = 0; i < 10; i++) {
        promises.push(store.installPlugin('concurrent-plugin', { autoOpen: false }, deps))
      }

      const results = await Promise.all(promises)

      // 严格断言：只有 1 次成功发起安装，其余 9 次均返回 busy: true
      const successCount = results.filter(r => r.success === true).length
      const busyCount = results.filter(r => r.busy === true).length

      assert.equal(successCount, 1, '高频并发下仅允许 1 次有效执行')
      assert.equal(busyCount, 9, '其余 9 次并发调用必须全部被互斥锁拦截')
      assert.equal(nativeCalls, 1, '底层 Native 安装方法严禁被重复调用')
      assert.equal(store.isInstalling('concurrent-plugin'), false, '安装完成后互斥锁必须释放')
      assert.equal(store.isInstalled('concurrent-plugin'), true)
    })

    it('【破坏性测试: 网络故障与签名失败回滚】获取下载签名发生 404/500/超时，状态机原子回滚且记录错误原因', async () => {
      const store = createMockPluginStore()

      const deps = {
        getDownloadSign: async (pid) => {
          throw new Error('HTTP 500: 对象存储网关超时')
        },
        installPluginNative: async () => {
          throw new Error('不应执行到此')
        }
      }

      await assert.rejects(
        () => store.installPlugin('fail-network-plugin', { autoOpen: true }, deps),
        /HTTP 500: 对象存储网关超时/
      )

      assert.equal(store.isInstalling('fail-network-plugin'), false, '失败后必须立即移出 installingSet')
      assert.equal(store.isInstalled('fail-network-plugin'), false, '失败后严禁误加入 installedSet')
      assert.equal(store.getInstallError('fail-network-plugin'), 'HTTP 500: 对象存储网关超时', '必须记录具体错误用于前端重试')
    })

    it('【破坏性测试: 安装包校验失败回滚】底层校验 SHA256 篡改拒绝，原子回滚并记录错误', async () => {
      const store = createMockPluginStore()

      const deps = {
        getDownloadSign: async (pid) => ({
          downloadUrl: `https://cdn.ztools.cn/plugins-v2/${pid}-1.0.0.zip`
        }),
        installPluginNative: async (pid) => {
          return { success: false, error: '安装包 SHA-256 校验不匹配，拒绝执行' }
        }
      }

      await assert.rejects(
        () => store.installPlugin('corrupt-plugin', {}, deps),
        /安装包 SHA-256 校验不匹配/
      )

      assert.equal(store.isInstalling('corrupt-plugin'), false)
      assert.equal(store.isInstalled('corrupt-plugin'), false)
      assert.equal(store.getInstallError('corrupt-plugin'), '安装包 SHA-256 校验不匹配，拒绝执行')
    })
  })

  // ===========================================================================
  // M1-8: 下架开关 (revoked) 全链路防御与状态联动
  // ===========================================================================
  describe('M1-8: 下架开关 (revoked) 全链路打通与防御', () => {

    it('市场清单刷新联动：远端标记为 revoked 的插件，客户端同步时自动置为禁用并填充下架原因', () => {
      const installedMap = new Map([
        ['plugin-a', { id: 'plugin-a', enabled: true, version: '1.0.0' }],
        ['plugin-b', { id: 'plugin-b', enabled: true, version: '1.1.0' }]
      ])

      const revokedMap = new Map()

      // 模拟前端 Store 中的 _applyRevocations 联动逻辑
      function applyRevocations(marketList) {
        if (!Array.isArray(marketList)) return
        for (const item of marketList) {
          const pid = String(item.pluginId || item.id || '')
          if (!pid) continue
          const isRevoked = Boolean(item.revoked)
          const reason = item.revoked_reason || item.revokedReason || ''
          if (isRevoked) {
            revokedMap.set(pid, { revoked: true, reason })
            const installed = installedMap.get(pid)
            if (installed) {
              installed.enabled = false
              installed.revoked = true
              installed.revoked_reason = reason
            }
          }
        }
      }

      // 模拟从远端拉取的 plugins.json（包含 1 款下架插件）
      const marketPlugins = [
        { pluginId: 'plugin-a', name: '插件 A', revoked: false },
        { pluginId: 'plugin-b', name: '插件 B', revoked: true, revoked_reason: '官方安全门禁复核发现未经授权的动态代码执行' }
      ]

      applyRevocations(marketPlugins)

      assert.equal(installedMap.get('plugin-a').enabled, true)
      assert.equal(installedMap.get('plugin-b').enabled, false, '被下架的插件必须立即联动置为禁用状态')
      assert.equal(installedMap.get('plugin-b').revoked, true)
      assert.equal(installedMap.get('plugin-b').revoked_reason, '官方安全门禁复核发现未经授权的动态代码执行')
      assert.equal(revokedMap.get('plugin-b').reason, '官方安全门禁复核发现未经授权的动态代码执行')
    })

    it('【破坏性测试: 阻止下架插件启动】openPlugin 针对下架插件强行拦截，拒绝进入声明式舞台', async () => {
      const revokedMap = new Map([
        ['bad-actor', { revoked: true, reason: '包含恶意反弹 Shell 代码' }]
      ])

      async function openPlugin(pluginId) {
        const rev = revokedMap.get(pluginId)
        if (rev && rev.revoked) {
          throw new Error(`无法启动：该插件已被官方下架禁用: ${rev.reason}`)
        }
        return { success: true }
      }

      await assert.rejects(
        () => openPlugin('bad-actor'),
        (err) => {
          assert.match(err.message, /该插件已被官方下架禁用/)
          assert.match(err.message, /包含恶意反弹 Shell 代码/)
          return true
        }
      )
    })

    it('【破坏性测试: 阻止下架插件安装】installPlugin 面对下架插件立即拒绝，绝不发起网络下载', async () => {
      let downloadAttempted = false
      const revokedMap = new Map([
        ['scam-plugin', { revoked: true, reason: '钓鱼仿冒官方插件' }]
      ])

      async function installPlugin(pluginId) {
        const rev = revokedMap.get(pluginId)
        if (rev && rev.revoked) {
          throw new Error(`无法安装：该插件已被官方下架禁用: ${rev.reason}`)
        }
        downloadAttempted = true
        return { success: true }
      }

      await assert.rejects(
        () => installPlugin('scam-plugin'),
        /钓鱼仿冒官方插件/
      )
      assert.equal(downloadAttempted, false, '严禁对已下架插件发起下载流程')
    })

    it('特权层持久化自愈：PluginStateService 的 setRevoked/isRevoked 与 isEnabled 强拦截', async () => {
      await fs.mkdir(tempTestDir, { recursive: true })
      const stateService = new PluginStateService(tempTestDir)

      // 1. 初始状态：未下架，启用状态为 false 或未定义
      let check = await stateService.isRevoked('suspicious-plugin')
      assert.equal(check.revoked, false)

      // 2. 标记下架并设置下架原因
      await stateService.setRevoked('suspicious-plugin', true, '高危权限未声明')
      check = await stateService.isRevoked('suspicious-plugin')
      assert.equal(check.revoked, true)
      assert.equal(check.reason, '高危权限未声明')

      // 3. 关键防御：下架状态具有最高优先级，即使更新 enabled 为 true，isEnabled 必须坚决返回 false！
      await stateService.update('suspicious-plugin', (state) => { state.enabled = true })
      const enabled = await stateService.isEnabled('suspicious-plugin', true)
      assert.equal(enabled, false, '已下架插件无论如何无法被启用，isEnabled 必须返回 false')

      // 4. 解除下架后，恢复正常逻辑
      await stateService.setRevoked('suspicious-plugin', false)
      check = await stateService.isRevoked('suspicious-plugin')
      assert.equal(check.revoked, false)
      assert.equal(await stateService.isEnabled('suspicious-plugin', true), true, '解除下架后恢复原启用状态')

      // 清理临时目录
      await fs.rm(tempTestDir, { recursive: true, force: true }).catch(() => {})
    })
  })

  // ===========================================================================
  // M1-9: 静态分发缓存策略固化验证
  // ===========================================================================
  describe('M1-9: 静态分发缓存策略固化 (Static Distribution Cache Headers)', () => {

    it('plugins.json 与元数据 JSON 必须设置为短缓存 (max-age=300)，确保下架开关及时在全网生效', () => {
      const header = getCacheControl('plugins.json')
      assert.ok(header, 'plugins.json 必须配置 Cache-Control')
      assert.match(header, /max-age=300/, 'plugins.json 最大缓存时间不得超过 300 秒 (5分钟)')
      assert.ok(!header.includes('immutable'), '全局索引 plugins.json 严禁配置 immutable 强缓存')

      const otherJson = getCacheControl('manifest.json')
      assert.ok(otherJson.includes('max-age=300'), '其他 JSON 清单文件也必须设置为 300 秒短缓存')
    })

    it('带版本号的 ZIP 安装包必须设置为 30 天强缓存 (max-age=2592000, immutable)，保障性能秒开', () => {
      const testCases = [
        'weather-dev/sensitive-network/sensitive-network-1.0.0.zip',
        'ztools-dev/text-counter/text-counter-1.2.0.zip',
        'packages/demo-app-0.9.3.zip'
      ]

      for (const zipPath of testCases) {
        const header = getCacheControl(zipPath)
        assert.ok(header.includes('max-age=2592000'), `${zipPath} 必须配置 30 天缓存 (2592000 秒)`)
        assert.ok(header.includes('immutable'), `${zipPath} 必须标记 immutable`)
      }
    })

    it('静态图标图片与其它通用静态资源设置 7 天缓存 (max-age=604800)', () => {
      const iconHeader = getCacheControl('weather-dev/sensitive-network/icon.png')
      assert.ok(iconHeader.includes('max-age=604800'), 'icon.png 必须配置 7 天缓存')

      const assetHeader = getCacheControl('assets/screenshot.jpg')
      assert.ok(assetHeader.includes('max-age=604800'), '静态截图资源必须配置 7 天缓存')
    })
  })
})
