import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PUBLIC_DNS_PRESETS,
  runDnsBenchmark,
  applyAdapterDns,
  resetAdapterToDhcp,
  flushSystemDnsCache
} from '../packages/declarative-ui/dist/examples/dns-benchmark/index.js'

import {
  parseAndNormalizeHotkeyCombo,
  probeGlobalHotkeys,
  filterCheatsheetItems,
  killHotkeySuspectProcess
} from '../packages/declarative-ui/dist/examples/hotkey-radar/index.js'

import {
  isWithinFatTimestampTolerance as isTimestampWithinTolerance,
  areDirectoriesNestedOrIdentical,
  compareFolderTrees as compareSyncDirectories,
  executeFolderSync
} from '../packages/declarative-ui/dist/examples/folder-sync/index.js'

import {
  createVaultEntry,
  encryptVaultEntries,
  decryptVaultEntries,
  generateSecurePassword,
  validateMasterPassword,
  validateNewEntryInput,
  copySecretWithAutoClear
} from '../packages/declarative-ui/dist/examples/password-vault/index.js'

import {
  mbpsToMBps,
  normalizeCustomHostInput,
  buildSpeedtestDiagnosticSummary,
  probeSpeedtestNodes,
  runSpeedtestBandwidth
} from '../packages/declarative-ui/dist/examples/speedtest/index.js'

// ==================== 09. dns-benchmark ====================
test('09. dns-benchmark: 15 组公共 DNS 并发测速排序与一键应用闭环 + 异常与注入拦截', async () => {
  assert.ok(PUBLIC_DNS_PRESETS.length >= 15, '应内置至少 15 组公共 DNS')

  // 1. 并发测速排序 + 部分节点超时隔离
  const mockHost = {
    async dllplugin_call({ func, params }) {
      if (func === 'benchmarkDns') {
        return {
          ok: true,
          results: [
            { id: 'alidns', primary: '223.5.5.5', avgMs: 11, primaryMs: 10, secondaryMs: 12, timeout: false },
            { id: 'dnspod', primary: '119.29.29.29', avgMs: 18, primaryMs: 17, secondaryMs: 19, timeout: false },
            { id: 'google', primary: '8.8.8.8', avgMs: 1500, primaryMs: null, secondaryMs: null, timeout: true }
          ]
        }
      }
      if (func === 'applyDns') {
        if (params.adapterName === 'NoAdminNIC') {
          return {
            ok: false,
            errorCode: 'ADMIN_REQUIRED',
            error: 'ADMIN_REQUIRED: 需要管理员权限修改网卡 DNS'
          }
        }
        return {
          ok: true,
          adapterName: params.adapterName,
          currentDns: [params.primary, params.secondary].filter(Boolean),
          isDhcp: false,
          flushed: true
        }
      }
      if (func === 'resetDhcp') {
        return { ok: true, adapterName: params.adapterName, currentDns: [], isDhcp: true, flushed: true }
      }
      if (func === 'flushCache') {
        return { ok: true, flushed: true }
      }
      return { ok: false, error: 'UNKNOWN_FUNC' }
    }
  }

  const bench = await runDnsBenchmark(['119.29.29.29'], mockHost)
  assert.equal(bench.allTimeout, false)
  assert.equal(bench.fastestDns?.primary, '223.5.5.5')
  assert.equal(bench.items[0].primary, '223.5.5.5')
  assert.equal(bench.items[0].avgMs, 11)
  const dnspodItem = bench.items.find((i) => i.primary === '119.29.29.29')
  assert.equal(dnspodItem?.isCurrentActive, true)
  const googleItem = bench.items.find((i) => i.primary === '8.8.8.8')
  assert.equal(googleItem?.timeout, true)
  // 超时节点排在队尾
  assert.equal(bench.items[bench.items.length - 1].timeout, true)

  // 2. 应用最快 DNS + 恢复 DHCP + 刷新缓存
  const applyRes = await applyAdapterDns('WLAN', '223.5.5.5', '223.6.6.6', mockHost)
  assert.equal(applyRes.ok, true)
  assert.deepEqual(applyRes.currentDns, ['223.5.5.5', '223.6.6.6'])

  const resetRes = await resetAdapterToDhcp('WLAN', mockHost)
  assert.equal(resetRes.ok, true)
  assert.equal(resetRes.isDhcp, true)

  const flushRes = await flushSystemDnsCache(mockHost)
  assert.equal(flushRes.ok, true)

  // 3. 异常用例 1：本机断网全节点超时
  const offlineBench = await runDnsBenchmark([], {
    async dllplugin_call() {
      return { ok: true, results: [] }
    }
  })
  assert.equal(offlineBench.allTimeout, true)
  assert.equal(offlineBench.fastestDns, null)

  // 4. 异常用例 2：管理员权限拒绝拦截 (ADMIN_REQUIRED)
  const deniedRes = await applyAdapterDns('NoAdminNIC', '223.5.5.5', '223.6.6.6', mockHost)
  assert.equal(deniedRes.ok, false)
  assert.equal(deniedRes.errorCode, 'ADMIN_REQUIRED')

  // 5. 异常用例 3：非法 DNS IP 与网卡名称命令注入拦截
  const badIpRes = await applyAdapterDns('WLAN', '999.999.999.999', '', mockHost)
  assert.equal(badIpRes.ok, false)
  assert.equal(badIpRes.errorCode, 'INVALID_DNS_IP')

  const injectIpRes = await applyAdapterDns('WLAN', '8.8.8.8; rm -rf /', '', mockHost)
  assert.equal(injectIpRes.ok, false)
  assert.equal(injectIpRes.errorCode, 'INVALID_DNS_IP')

  const injectNicRes = await applyAdapterDns('WLAN & calc.exe', '223.5.5.5', '', mockHost)
  assert.equal(injectNicRes.ok, false)
  assert.equal(injectNicRes.errorCode, 'INVALID_ADAPTER_NAME')
})

// ==================== 10. hotkey-radar ====================
test('10. hotkey-radar: 热键冲突探测、归一化解析、速查表检索与系统进程保护拦截', async () => {
  // 1. 组合键解析与归一化
  const parsed = parseAndNormalizeHotkeyCombo('alt + ctrl + a')
  assert.equal(parsed.valid, true)
  assert.equal(parsed.normalized, 'Ctrl+Alt+A')

  // 2. 冲突探测 + 立即释放锁 + 冲突项置顶
  const mockHost = {
    async dllplugin_call({ func }) {
      if (func === 'probeHotkeys') {
        return {
          ok: true,
          results: [
            {
              keyCombo: 'CTRL+ALT+A',
              isOccupied: true,
              isSystemReserved: false,
              suspectApp: '微信 (WeChat)',
              suspectProcess: 'WeChat.exe',
              suspectPid: 8420
            },
            {
              keyCombo: 'WIN+L',
              isOccupied: true,
              isSystemReserved: true,
              suspectApp: 'Windows 系统锁屏',
              suspectProcess: 'explorer.exe',
              suspectPid: 1200
            }
          ]
        }
      }
      return { ok: true }
    }
  }

  const probed = await probeGlobalHotkeys(undefined, 'Ctrl+Shift+M', mockHost)
  assert.ok(probed.length > 0)
  // 已被占用的排在最前
  assert.equal(probed[0].isOccupied, true)
  const wechatKey = probed.find((k) => k.keyCombo === 'Ctrl+Alt+A')
  assert.equal(wechatKey?.isOccupied, true)
  assert.equal(wechatKey?.suspectPid, 8420)

  // 3. 五大软件快捷键速查检索
  const excelMatches = filterCheatsheetItems('sheet:all', '冻结窗格')
  assert.ok(excelMatches.length >= 1)
  assert.equal(excelMatches[0].category, 'excel')

  // 4. 异常用例 1：非法单字母或畸形热键输入拦截
  const singleLetter = parseAndNormalizeHotkeyCombo('A')
  assert.equal(singleLetter.valid, false)
  assert.match(String(singleLetter.error), /MISSING_MODIFIER/)

  const onlyMods = parseAndNormalizeHotkeyCombo('Ctrl+Alt+')
  assert.equal(onlyMods.valid, false)
  assert.match(String(onlyMods.error), /MALFORMED_HOTKEY|MISSING_MAIN_KEY/)

  // 5. 异常用例 2：系统保留热键与核心外壳进程防误杀拦截
  const killWinL = await killHotkeySuspectProcess(
    {
      isSystemReserved: true,
      suspectPid: 1200,
      suspectProcess: 'explorer.exe',
      suspectApp: 'Windows 系统锁屏'
    },
    mockHost
  )
  assert.equal(killWinL.ok, false)
  assert.equal(killWinL.errorCode, 'PROTECTED_SYSTEM_PROCESS')
})

// ==================== 11. folder-sync ====================
test('11. folder-sync: 目录差异对比、FAT32 2秒时间戳容差、嵌套死循环拦截与文件占用容错', async () => {
  // 1. FAT32 2000ms 时间戳容差不变量
  assert.equal(isTimestampWithinTolerance(1700000000000, 1700000001500), true)
  assert.equal(isTimestampWithinTolerance(1700000000000, 1700000003500), false)

  // 2. 差异对比与增量同步闭环
  const mockHost = {
    async dllplugin_call({ func, params }) {
      if (func === 'compareDirs') {
        return {
          ok: true,
          sourceDir: params.sourceDir,
          targetDir: params.targetDir,
          diffs: [
            {
              relPath: 'docs/spec.md',
              diffType: 'added',
              diffLabel: '新增文件',
              direction: 'src->dst',
              directionText: '源目录 → 目标目录',
              sizeBytes: 4096,
              sizeText: '4.0 KB',
              mtimeMs: 1700000000000
            },
            {
              relPath: 'src/app.ts',
              diffType: 'modified',
              diffLabel: '内容已更新',
              direction: 'src->dst',
              directionText: '源目录 → 目标目录',
              sizeBytes: 8192,
              sizeText: '8.0 KB',
              mtimeMs: 1700000005000
            }
          ],
          transferBytes: 12288,
          targetFreeBytes: 10 * 1024 * 1024 * 1024
        }
      }
      if (func === 'executeSync') {
        if (params.mockTargetFreeBytes === 100) {
          return {
            ok: false,
            errorCode: 'ENOSPC',
            error: 'ENOSPC: 目标磁盘剩余空间不足'
          }
        }
        if (Array.isArray(params.simulateLockedRelPaths) && params.simulateLockedRelPaths.length > 0) {
          return {
            ok: false,
            syncedCount: 1,
            deletedCount: 0,
            transferredBytes: 4096,
            failures: [
              {
                relPath: params.simulateLockedRelPaths[0],
                errorCode: 'EBUSY',
                error: 'EBUSY: 文件正被其它进程占用'
              }
            ]
          }
        }
        return {
          ok: true,
          syncedCount: 2,
          deletedCount: 0,
          transferredBytes: 12288,
          failures: []
        }
      }
      return { ok: false }
    }
  }

  const cmp = await compareSyncDirectories({
    sourceDir: 'D:/Work/ProjectA',
    targetDir: 'E:/Backup/ProjectA',
    syncMode: 'incremental',
    ignoreDevJunk: true,
    hostOverride: mockHost
  })
  assert.equal(cmp.ok, true)
  assert.equal(cmp.totalDiffs, 2)
  assert.equal(cmp.transferBytes, 12288)

  const syncOk = await executeFolderSync({
    sourceDir: 'D:/Work/ProjectA',
    targetDir: 'E:/Backup/ProjectA',
    syncMode: 'incremental',
    hostOverride: mockHost
  })
  assert.equal(syncOk.ok, true)
  assert.equal(syncOk.syncedCount, 2)

  // 3. 异常用例 1：源目录与目标目录嵌套或相同死循环拦截 (NESTED_DIRECTORY_FORBIDDEN)
  assert.equal(areDirectoriesNestedOrIdentical('D:\\Work\\ProjectA', 'd:/work/projecta/backup'), true)
  const nestedCmp = await compareSyncDirectories({
    sourceDir: 'D:\\Work\\ProjectA',
    targetDir: 'D:\\Work\\ProjectA\\sub-backup',
    hostOverride: mockHost
  })
  assert.equal(nestedCmp.ok, false)
  assert.equal(nestedCmp.errorCode, 'NESTED_DIRECTORY_FORBIDDEN')

  // 4. 异常用例 2：目标磁盘空间不足拦截 (ENOSPC)
  const noSpaceRes = await executeFolderSync({
    sourceDir: 'D:/Work/ProjectA',
    targetDir: 'E:/Backup/ProjectA',
    mockTargetFreeBytes: 100,
    hostOverride: mockHost
  })
  assert.equal(noSpaceRes.ok, false)
  assert.equal(noSpaceRes.errorCode, 'ENOSPC')

  // 5. 异常用例 3：单个文件被占用 (EBUSY) 跳过容错不中断其余文件
  const partialRes = await executeFolderSync({
    sourceDir: 'D:/Work/ProjectA',
    targetDir: 'E:/Backup/ProjectA',
    simulateLockedRelPaths: ['src/app.ts'],
    hostOverride: mockHost
  })
  assert.equal(partialRes.ok, false)
  assert.equal(partialRes.syncedCount, 1)
  assert.equal(partialRes.failures.length, 1)
  assert.equal(partialRes.failures[0].errorCode, 'EBUSY')
})

// ==================== 12. password-vault ====================
test('12. password-vault: PBKDF2 + AES-256-GCM 零明文加解密、剪贴板自动清除与篡改/错密拦截', async () => {
  const masterPwd = 'ZTools#Master2026!'
  const entry = createVaultEntry({
    title: '生产环境 PostgreSQL 主库',
    category: 'server',
    username: 'postgres_admin',
    endpoint: '10.20.30.40:5432',
    secretPlain: 'SuperSecret_DB_Pass_998877!',
    note: '每日凌晨只读备份实例'
  })

  // 1. 加密后信封绝对不包含明文密码或用户名
  const envelope = await encryptVaultEntries(masterPwd, [entry])
  const serialized = JSON.stringify(envelope)
  assert.equal(serialized.includes('SuperSecret_DB_Pass_998877!'), false)
  assert.equal(serialized.includes('postgres_admin'), false)

  // 用正确主密码 100% 无损解密还原
  const decrypted = await decryptVaultEntries(masterPwd, envelope)
  assert.equal(decrypted.length, 1)
  assert.equal(decrypted[0].title, '生产环境 PostgreSQL 主库')
  assert.equal(decrypted[0].secretPlain, 'SuperSecret_DB_Pass_998877!')

  // 2. 复制密码后 30 秒自动清空剪贴板验证
  let clipboardContent = ''
  let scheduledCallback = null
  const mockClipboard = {
    async copy(text) {
      clipboardContent = text
    },
    async readText() {
      return clipboardContent
    },
    async clear() {
      clipboardContent = ''
    }
  }
  await copySecretWithAutoClear(entry.secretPlain, mockClipboard, {
    ttlMs: 30000,
    scheduleTimer(fn) {
      scheduledCallback = fn
    }
  })
  assert.equal(clipboardContent, 'SuperSecret_DB_Pass_998877!')
  assert.ok(typeof scheduledCallback === 'function')
  await scheduledCallback()
  // Allow microtask to complete
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(clipboardContent, '')

  // 3. 高强度随机密码生成器验证
  const randomPwd = generateSecurePassword(24, true)
  assert.equal(randomPwd.length, 24)

  // 4. 异常用例 1：错误主密码解密拦截 (VAULT_INVALID_MASTER_PASSWORD)
  await assert.rejects(
    async () => {
      await decryptVaultEntries('WrongPassword123!', envelope)
    },
    /VAULT_INVALID_MASTER_PASSWORD/
  )

  // 5. 异常用例 2：密文被篡改或损坏拦截 (VAULT_DATA_CORRUPTED)
  const rawBytes = Buffer.from(envelope.cipherTextBase64, 'base64')
  rawBytes[0] ^= 0xff
  const tamperedEnvelope = {
    ...envelope,
    cipherTextBase64: rawBytes.toString('base64')
  }
  await assert.rejects(
    async () => {
      await decryptVaultEntries(masterPwd, tamperedEnvelope, {
        knownOriginalCipherBase64: envelope.cipherTextBase64
      })
    },
    /VAULT_DATA_CORRUPTED/
  )

  // 6. 异常用例 3：弱主密码或空凭据字段拦截
  const weakCheck = validateMasterPassword('123')
  assert.equal(weakCheck.valid, false)
  assert.match(String(weakCheck.error), /VAULT_WEAK_MASTER_PASSWORD/)

  const emptyEntryCheck = validateNewEntryInput({
    title: '  ',
    category: 'login',
    secretPlain: ''
  })
  assert.equal(emptyEntryCheck.valid, false)
  assert.match(String(emptyEntryCheck.error), /VAULT_INVALID_ENTRY/)
})

// ==================== 13. speedtest ====================
test('13. speedtest: 三级网络节点连通性探测、带宽换算、自定义主机探测与断网/超时/取消隔离', async () => {
  // 1. 带宽 Mbps -> MB/s 换算与正常诊断报告生成
  assert.equal(mbpsToMBps(500), 62.5)
  assert.equal(normalizeCustomHostInput('https://cloudflare.com/cdn-cgi/trace'), 'cloudflare.com')

  const mockHost = {
    async dllplugin_call({ func, params }) {
      if (func === 'probeNodes') {
        const nodes = [
          {
            id: 'lan-gw',
            name: '默认路由器网关',
            host: '192.168.1.1',
            region: 'lan',
            regionLabel: '内网网关',
            categoryDesc: '第 1 级：本机至路由器局域网链路',
            reachable: true,
            latencyMs: 2,
            statusCode: 200
          },
          {
            id: 'domestic-baidu',
            name: '百度',
            host: 'www.baidu.com',
            region: 'domestic',
            regionLabel: '国内核心',
            categoryDesc: '第 2 级：国内核心互联网节点',
            reachable: true,
            latencyMs: 18,
            statusCode: 200
          },
          {
            id: 'global-github',
            name: 'GitHub',
            host: 'github.com',
            region: 'global',
            regionLabel: '国际开发者',
            categoryDesc: '第 3 级：跨境开发者核心节点',
            reachable: false,
            latencyMs: -1,
            statusCode: 0
          }
        ]
        if (params?.customHost) {
          nodes.unshift({
            id: `custom-${params.customHost}`,
            name: `自定义探测`,
            host: params.customHost,
            region: 'global',
            regionLabel: '自定义目标',
            categoryDesc: '用户自定义输入域名/IP 即时连通性测试',
            reachable: true,
            latencyMs: 36,
            statusCode: 200
          })
        }
        return { ok: true, nodes }
      }
      if (func === 'runBandwidthTest') {
        return {
          ok: true,
          downloadMbps: 500,
          uploadMbps: 80,
          pingMs: 14,
          jitterMs: 3,
          localIp: '192.168.1.108',
          gatewayIp: '192.168.1.1'
        }
      }
      return { ok: false }
    }
  }

  // 2. 自定义域名探测 + 部分国际节点超时隔离验证
  const nodes = await probeSpeedtestNodes({ customHost: 'cloudflare.com' }, mockHost)
  assert.equal(nodes[0].host, 'cloudflare.com')
  assert.equal(nodes[0].reachable, true)
  const ghNode = nodes.find((n) => n.host === 'github.com')
  assert.equal(ghNode?.reachable, false)

  const bw = await runSpeedtestBandwidth({}, mockHost)
  const summary = buildSpeedtestDiagnosticSummary(bw, nodes)
  assert.equal(summary.isOffline, false)
  assert.match(summary.summaryText, /500\.0 Mbps \(62\.5 MB\/s\)/)
  assert.match(summary.summaryText, /国内节点全部畅通/)

  // 3. 异常用例 2：本机完全断网 (ENETUNREACH) 诊断，不出现 NaN
  const offlineSummary = buildSpeedtestDiagnosticSummary(
    { downloadMbps: 0, uploadMbps: 0, pingMs: 0, jitterMs: 0, localIp: '0.0.0.0', gatewayIp: '0.0.0.0' },
    nodes.map((n) => ({ ...n, reachable: false, latencyMs: -1 }))
  )
  assert.equal(offlineSummary.isOffline, true)
  assert.match(offlineSummary.summaryText, /网络已断开/)
  assert.equal(offlineSummary.summaryText.includes('NaN'), false)

  // 4. 异常用例 3：测速中途用户主动取消 (AbortController.abort)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    async () => {
      await probeSpeedtestNodes({ signal: controller.signal }, mockHost)
    },
    /SPEEDTEST_ABORTED/
  )
})
