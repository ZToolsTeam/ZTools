/**
 * 布局一插件“去假接真”专项集成与异常边界测试套件 (P01 ~ P11)
 *
 * 覆盖范围：
 * - P01 lan-share: ISO/IEC 18004 QR Code 矩阵/SVG 编码器 (Finder/Timing/DarkModule/RS)、HTTP 共享队列同步与敏感文件拦截
 * - P02 network-adapter: 真实网卡列表聚合、公共 DNS 预设切换 (applyDnsPreset) 与无管理员权限失败断言、DNS 缓存刷新
 * - P03 network-rescue: 真实网络连通性诊断 (diagnose)、修复项执行 (repair) 与失败不伪造 ok:true 断言
 * - P04 context-menu: 真实注册表扫描 (scanEntries)、启用/禁用右键项 (toggleEntry)、清理孤立项 (cleanOrphans) 与权限异常拦截
 * - P05 wechat-multi: 真实微信进程扫描与无微信时零假进程断言、启动新实例与未安装微信失败断言、移除 Math.random 假 PID
 * - P06 flow-guard: 五元组连接分组、TerminateProcessByPID 内核白名单拦截与真实宿主禁用 simulated:true
 * - P07 window-management: window_manage_action IPC 联动与宿主失败时如实返回 success:false
 * - P08 system: system_execute_action / SystemActionsPlugin 真实调用与失败时禁止静默返回 success:true
 * - P09 process-monitor: 真实进程列表/详情获取与真实宿主下禁用 simulated:true 兜底
 * - P10 hardware-info: 硬件遥测聚合与真实宿主下禁用 simulated:true 兜底
 * - P11 clipboard-history: 真实 SQLite 历史与系统剪贴板同步、脱敏识别与异常输入防御
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  encodeQrCodeMatrix,
  generateQrCodeSvgDataUri,
  fetchLanShareSnapshot,
  addRealFileToShareQueue,
  toggleLanShareServer,
  toggleFileShare,
  invokeNativeCapability as invokeLanShareCapability
} from '../dist/examples/lan-share/logic.js'

import {
  fetchNetworkAdapters,
  applyDnsPreset,
  flushSystemDnsCache,
  invokeNativeCapability as invokeNetworkAdapterCapability
} from '../dist/examples/network-adapter/logic.js'

import {
  fetchNetworkDiagnostics,
  executeNetworkRepair,
  batchExecuteNetworkRepairs
} from '../dist/examples/network-rescue/logic.js'

import {
  fetchContextMenuEntries,
  toggleContextMenuEntry,
  cleanOrphanedContextMenuEntries,
  switchWin11ClassicMenu
} from '../dist/examples/context-menu/logic.js'

import {
  fetchWeChatMultiSnapshot,
  launchNewWeChatInstance,
  terminateWechatInstance
} from '../dist/examples/wechat-multi/logic.js'

import {
  fetchFlowGuardSnapshot,
  terminateNetworkProcess,
  invokeNativeCapability as invokeFlowGuardCapability
} from '../dist/examples/flow-guard/logic.js'

import {
  executeWindowAction
} from '../dist/examples/window-management/window-actions.js'

import {
  SYSTEM_ACTIONS,
  executeSystemAction
} from '../dist/examples/system/system-actions.js'

import {
  fetchProcesses,
  fetchProcessDetail,
  terminateProcess,
  invokeNativeCapability as invokeProcessMonitorCapability
} from '../dist/examples/process-monitor/logic.js'

import {
  fetchHardwareTelemetrySnapshot,
  invokeNativeCapability as invokeHardwareInfoCapability
} from '../dist/examples/hardware-info/logic.js'

import {
  getClipboardHistory,
  syncCurrentSystemClipboard,
  toggleClipboardItemPin,
  deleteClipboardItem,
  clearUnpinnedClipboardHistory,
  maskSensitiveContent
} from '../dist/examples/clipboard-history/clipboard-store.js'

// 辅助：模拟真实 Electron 宿主 window.__ztoolsElectron 环境
async function withSimulatedRealElectronWindow(methodsMap, fn) {
  const prevWindow = globalThis.window
  globalThis.window = {
    __ztoolsElectron: {
      transport: {
        methods: Object.keys(methodsMap),
        call: async (method, payload) => {
          const handler = methodsMap[method]
          if (!handler) {
            throw new Error(`IPC method not registered: ${method}`)
          }
          return await handler(payload)
        }
      }
    }
  }
  try {
    return await fn()
  } finally {
    if (prevWindow === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = prevWindow
    }
  }
}

// ============================================================================
// P01: lan-share 二维码真实矩阵与局域网共享链路测试
// ============================================================================

test('P01 lan-share: encodeQrCodeMatrix 生成符合 ISO/IEC 18004 标准的 QR 矩阵 (Finder/Separator/Timing/DarkModule)', () => {
  const url = 'http://192.168.1.108:18580/dl/1/ZTools.zip'
  const matrix = encodeQrCodeMatrix(url)
  const size = matrix.length

  // Version 3 (29x29) 或更高版本，尺寸满足 17 + 4*V
  assert.ok(size >= 21 && (size - 17) % 4 === 0, `非法 QR 矩阵边长: ${size}`)

  // 校验左上、右上、左下三个 7x7 Finder Pattern 外框与中心 3x3 实心块
  const verifyFinder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6
        const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4
        const expected = isBorder || isCenter
        assert.equal(matrix[r0 + r][c0 + c], expected, `Finder (${r0 + r}, ${c0 + c}) 不匹配`)
      }
    }
  }
  verifyFinder(0, 0)
  verifyFinder(0, size - 7)
  verifyFinder(size - 7, 0)

  // 校验 Finder 外侧白边 Separator 必为 false
  for (let i = 0; i < 8; i++) {
    assert.equal(matrix[7][i], false)
    assert.equal(matrix[i][7], false)
  }

  // 校验第 6 行与第 6 列的 Timing Pattern 交替深浅模块
  assert.equal(matrix[6][8], true)
  assert.equal(matrix[6][9], false)
  assert.equal(matrix[6][10], true)
  assert.equal(matrix[8][6], true)
  assert.equal(matrix[9][6], false)

  // 校验 Dark Module (4*V + 9, 8) 必为 true
  const version = (size - 17) / 4
  assert.equal(matrix[4 * version + 9][8], true)

  // 校验生成的 SVG Data URI 格式合法且对不同输入产生不同矩阵
  const svgUri1 = generateQrCodeSvgDataUri('http://192.168.1.108:18580/a')
  const svgUri2 = generateQrCodeSvgDataUri('http://192.168.1.108:18580/b')
  assert.ok(svgUri1.startsWith('data:image/svg+xml;utf8,'))
  assert.notEqual(svgUri1, svgUri2)
})

test('P01 lan-share: 真实宿主 HTTP 共享同步与异常/敏感文件拦截测试', async () => {
  const calls = []
  const hostBridge = {
    dllplugin_call: async (payload) => {
      calls.push(payload)
      if (payload.func === 'getLanShareStatus') {
        return {
          ok: true,
          lanIp: '10.0.0.88',
          port: 19580,
          running: true,
          downloadCounts: { portal: 12, 'D:\\Share\\report.pdf': 5 },
          files: [
            {
              id: 'file-real-1',
              name: 'report.pdf',
              path: 'D:\\Share\\report.pdf',
              size: 1048576,
              downloadCount: 5,
              isShared: true
            }
          ]
        }
      }
      if (payload.func === 'syncShareFiles') {
        return { ok: true, lanIp: '10.0.0.88', port: 19580, sizeBytes: 4096, downloadCount: 0 }
      }
      if (payload.func === 'startShareServer') {
        return { ok: true, running: true, lanIp: '10.0.0.88', port: payload.params.port }
      }
      return { ok: false, error: '服务拒绝访问' }
    },
    clipboard_read_text: async () => 'Real Clipboard Content'
  }

  const snap = await fetchLanShareSnapshot(hostBridge)
  assert.equal(snap.lanIp, '10.0.0.88')
  assert.equal(snap.port, 19580)
  assert.equal(snap.serverRunning, true)
  const fileItem = snap.items.find((i) => i.category === 'files')
  assert.ok(fileItem)
  assert.equal(fileItem.title, 'report.pdf')
  assert.equal(fileItem.downloadCount, 5)
  // 严禁混入虚构的 ZTools_Setup_1.1.7_x64.exe
  assert.equal(snap.items.some((i) => i.title.includes('ZTools_Setup_1.1.7')), false)

  // 添加真实文件到共享队列
  const addRes = await addRealFileToShareQueue('D:\\Share\\notes.txt', hostBridge)
  assert.equal(addRes.ok, true)
  assert.equal(addRes.item?.title, 'notes.txt')

  // 异常场景 1：空文件路径拦截
  const emptyRes = await addRealFileToShareQueue('   ', hostBridge)
  assert.equal(emptyRes.ok, false)

  // 异常场景 2：系统敏感文件 (SAM / SSH 私钥) 安全拦截
  const samRes = await addRealFileToShareQueue('C:\\Windows\\System32\\config\\SAM', hostBridge)
  assert.equal(samRes.ok, false)
  assert.match(samRes.message, /严禁/)

  // 异常场景 3：切换共享状态时宿主报错，必须如实返回 ok: false
  const failToggle = await toggleFileShare('file-real-1', false, {
    dllplugin_call: async () => ({ ok: false, error: 'HTTP 端口未监听' }),
    lan_share_toggle: async () => ({ ok: false, error: 'HTTP 端口未监听' })
  })
  assert.equal(failToggle.ok, false)
  assert.match(failToggle.message, /HTTP 端口未监听/)
})

// ============================================================================
// P02: network-adapter 网卡探测、DNS 预设切换与权限失败断言
// ============================================================================

test('P02 network-adapter: 真实网卡列表聚合、DNS 预设切换与无管理员权限异常断言', async () => {
  const mockHost = {
    dllplugin_call: async ({ func, params }) => {
      if (func === 'getAdapters') {
        return {
          ok: true,
          adapters: [
            {
              id: 'nic-real-eth0',
              name: 'Ethernet 2',
              description: 'Intel I225-V',
              status: 'up',
              ipv4: '192.168.50.10',
              netmask: '255.255.255.0',
              gateway: '192.168.50.1',
              mac: 'AA-BB-CC-DD-EE-FF',
              dnsServers: ['192.168.50.1'],
              speedMbps: 2500
            }
          ]
        }
      }
      if (func === 'applyDnsPreset') {
        if (params.name === 'Restricted-NIC') {
          return { ok: false, error: '拒绝访问：需要管理员权限执行 netsh' }
        }
        return { ok: true, message: 'DNS 已更新' }
      }
      if (func === 'flushDns') {
        return { ok: true, message: '已成功刷新 DNS 解析缓存' }
      }
      return { ok: false, error: '未知方法' }
    }
  }

  const snap = await fetchNetworkAdapters(mockHost)
  assert.equal(snap.adapters.length, 1)
  assert.equal(snap.adapters[0].name, 'Ethernet 2')
  assert.equal(snap.primaryIpv4, '192.168.50.10')

  // 正常切换 DNS 预设
  const okDns = await applyDnsPreset('Ethernet 2', '223.5.5.5', '119.29.29.29', mockHost)
  assert.equal(okDns.ok, true)
  assert.deepEqual(okDns.dnsServers, ['223.5.5.5', '119.29.29.29'])

  // 异常场景 1：非法 DNS IPv4 格式拦截
  const badIp = await applyDnsPreset('Ethernet 2', '999.999.1.1', '', mockHost)
  assert.equal(badIp.ok, false)
  assert.match(badIp.message, /格式不合法/)

  // 异常场景 2：空网卡名称拦截
  const emptyNic = await applyDnsPreset('', '223.5.5.5', '', mockHost)
  assert.equal(emptyNic.ok, false)

  // 异常场景 3：无管理员权限时宿主返回失败，严禁伪造 ok: true
  const deniedDns = await applyDnsPreset('Restricted-NIC', '223.5.5.5', '1.1.1.1', mockHost)
  assert.equal(deniedDns.ok, false)
  assert.match(deniedDns.message, /管理员权限/)

  // 异常场景 4：flushSystemDnsCache 当宿主失败时返回 ok: false
  const failFlush = await flushSystemDnsCache({
    dllplugin_call: async () => ({ ok: false, error: 'DNS Client 服务未运行' }),
    shell_exec: async () => {
      throw new Error('DNS Client 服务未运行')
    }
  })
  assert.equal(failFlush.ok, false)
  assert.match(failFlush.message, /DNS Client 服务未运行/)
})

// ============================================================================
// P03: network-rescue 网络诊断与修复失败不伪造状态断言
// ============================================================================

test('P03 network-rescue: 真实诊断联动与修复失败时严禁伪造 ok:true 断言', async () => {
  const mockHost = {
    dllplugin_call: async ({ func, params }) => {
      if (func === 'diagnose') {
        return {
          ok: true,
          latencyMs: 22,
          items: [
            {
              id: 'clear-proxy',
              status: 'warning',
              statusText: '检测到系统代理 127.0.0.1:10809 但端口未监听',
              healthScore: 40
            },
            {
              id: 'check-hosts',
              status: 'healthy',
              statusText: 'Hosts 文件干净',
              healthScore: 100
            }
          ]
        }
      }
      if (func === 'repair') {
        if (params.checkId === 'reset-winsock') {
          return { ok: false, error: '请求的操作需要提升(管理员权限)' }
        }
        return { ok: true, message: `已修复 ${params.checkId}` }
      }
      return { ok: false, error: '未知调用' }
    }
  }

  const diag = await fetchNetworkDiagnostics(mockHost)
  assert.equal(diag.latencyMs, 22)
  assert.equal(diag.proxyInterceptDetected, true)
  const hostsItem = diag.items.find((i) => i.id === 'check-hosts')
  assert.equal(hostsItem?.status, 'healthy')

  // 正常修复无需提权的代理残留项
  const okRepair = await executeNetworkRepair('clear-proxy', mockHost)
  assert.equal(okRepair.ok, true)

  // 异常场景 1：不存在的修复项 ID
  const unknownRepair = await executeNetworkRepair('non-existent-id', mockHost)
  assert.equal(unknownRepair.ok, false)

  // 异常场景 2：需要管理员权限的 Winsock 重置失败时，严禁返回 ok: true
  const failRepair = await executeNetworkRepair('reset-winsock', {
    ...mockHost,
    shell_exec: async () => {
      throw new Error('需要管理员权限')
    }
  })
  assert.equal(failRepair.ok, false)
  assert.match(failRepair.message, /管理员权限/)

  // 异常场景 3：批量修复全部失败时返回 ok: false
  const batchFail = await batchExecuteNetworkRepairs(['reset-winsock'], {
    dllplugin_call: async () => ({ ok: false, error: '权限不足' }),
    shell_exec: async () => {
      throw new Error('权限不足')
    }
  })
  assert.equal(batchFail.ok, false)
  assert.equal(batchFail.repairedCount, 0)
})

// ============================================================================
// P04: context-menu 右键菜单真实扫描、切换与孤立项清理测试
// ============================================================================

test('P04 context-menu: 真实注册表扫描不混入假数据、切换启用状态与孤立项清理异常测试', async () => {
  const mockHost = {
    dllplugin_call: async ({ func, params }) => {
      if (func === 'scanEntries') {
        return {
          ok: true,
          win11ClassicEnabled: true,
          entries: [
            {
              id: 'ctx-real-code',
              title: 'Open with VS Code',
              publisher: 'Microsoft',
              scope: 'file',
              registryKey: 'HKCU\\Software\\Classes\\*\\shell\\VSCode',
              command: 'Code.exe "%1"',
              enabled: true
            }
          ]
        }
      }
      if (func === 'toggleEntry') {
        if (String(params.regPath).startsWith('HKCR\\')) {
          return { ok: false, error: '写入 HKCR 被拒绝：需要管理员权限' }
        }
        return { ok: true, enabled: params.enabled, message: '已更新注册表 LegacyDisable 键值' }
      }
      if (func === 'cleanOrphans') {
        return { ok: true, cleanedCount: params.regPaths.length, message: '清理完成' }
      }
      return { ok: false, error: '不支持的操作' }
    }
  }

  const snap = await fetchContextMenuEntries(mockHost)
  assert.equal(snap.entries.length, 1)
  assert.equal(snap.entries[0].id, 'ctx-real-code')
  // 严禁在真实扫描结果中混入虚构的百度网盘/WPS
  assert.equal(snap.entries.some((e) => e.id === 'ctx-baidupan'), false)

  // 成功禁用 HKCU 右键菜单项
  const toggleOk = await toggleContextMenuEntry(
    'ctx-real-code',
    false,
    mockHost,
    'HKCU\\Software\\Classes\\*\\shell\\VSCode'
  )
  assert.equal(toggleOk.ok, true)
  assert.equal(toggleOk.enabled, false)

  // 异常场景 1：修改 HKCR 无权限时必须返回 ok: false
  const toggleDenied = await toggleContextMenuEntry(
    'ctx-7zip',
    false,
    {
      ...mockHost,
      context_menu_toggle: async () => {
        throw new Error('写入 HKCR 被拒绝')
      }
    },
    'HKCR\\*\\shellex\\ContextMenuHandlers\\7-Zip'
  )
  assert.equal(toggleDenied.ok, false)
  assert.match(toggleDenied.message, /拒绝|失败/)

  // 异常场景 2：尝试篡改系统安全注册表分支 HKLM\SAM 被安全拦截
  const samIntercept = await cleanOrphanedContextMenuEntries(['HKLM\\SAM'], mockHost)
  assert.equal(samIntercept.ok, false)
  assert.match(samIntercept.message, /禁止/)
})

// ============================================================================
// P05: wechat-multi 微信真实进程检测、零假实例与启动失败断言
// ============================================================================

test('P05 wechat-multi: 无微信运行时零假进程断言与未安装微信时启动失败断言', async () => {
  // 场景 1：本机未运行任何微信进程时，绝不能注入 wxid_geek_primary (PID 18420) 等假进程
  const emptyHost = {
    dllplugin_call: async ({ func }) => {
      if (func === 'getStatus') {
        return {
          ok: true,
          installed: false,
          installPath: '',
          instances: []
        }
      }
      return { ok: false, error: '未安装微信' }
    }
  }

  const snap = await fetchWeChatMultiSnapshot(emptyHost)
  assert.equal(snap.mainInstanceCount, 0)
  assert.equal(snap.appletCount, 0)
  assert.equal(snap.items.some((i) => i.pid === 18420 || i.dataDir.includes('wxid_geek_primary')), false)

  // 场景 2：本机未安装微信时调用 launchNewWeChatInstance 必须返回 ok: false，绝不伪造成功或随机 PID
  const failLaunch = await launchNewWeChatInstance(1, {
    dllplugin_call: async () => ({ ok: false, error: '未检测到 WeChat.exe 或 Weixin.exe 安装路径' }),
    process_start: async () => {
      throw new Error('文件不存在')
    },
    shell_open_path: async () => {
      throw new Error('文件不存在')
    }
  })
  assert.equal(failLaunch.ok, false)
  assert.equal(failLaunch.launchedCount, 0)
  assert.match(failLaunch.message, /未检测到|文件不存在/)

  // 场景 3：无效 PID 终止进程拦截
  const badKill = await terminateWechatInstance(-10, emptyHost)
  assert.equal(badKill.ok, false)
})

// ============================================================================
// P06: flow-guard 网络五元组分组、内核进程保护与真实宿主禁用 simulated:true
// ============================================================================

test('P06 flow-guard: 真实端口五元组聚合、内核进程白名单拦截与真实宿主禁用 simulated:true', async () => {
  const snap = await fetchFlowGuardSnapshot({
    process_list_ports: async () => [
      {
        protocol: 'TCP',
        localAddress: '192.168.1.50',
        localPort: 52100,
        remoteAddress: '1.1.1.1',
        remotePort: 443,
        state: 'ESTABLISHED',
        pid: 4560,
        processName: 'curl.exe'
      }
    ],
    process_list: async () => [
      { pid: 4560, name: 'curl.exe', path: 'C:\\Windows\\System32\\curl.exe', cpuUsage: 1.5, memoryUsage: 12000000 }
    ]
  })
  assert.equal(snap.groups.length, 1)
  assert.equal(snap.groups[0].pid, 4560)
  assert.equal(snap.totalPublic, 1)

  // 异常场景 1：终止内核受保护进程 (csrss.exe / PID 4) 必须被拦截
  const sysKill = await terminateNetworkProcess(4, 'System', {})
  assert.equal(sysKill.ok, false)
  const csrssKill = await terminateNetworkProcess(612, 'csrss.exe', {})
  assert.equal(csrssKill.ok, false)

  // 异常场景 2：在真实 Electron 宿主中调用未实现能力，严禁返回 simulated: true
  await withSimulatedRealElectronWindow(
    {
      dllplugin_call: async () => {
        throw new Error('插件方法未实现')
      }
    },
    async () => {
      const res = await invokeFlowGuardCapability('GetNetworkFlowTable', { includeLoopback: false })
      assert.equal(res.ok, false)
      assert.equal(res.data?.simulated, undefined)
    }
  )
})

// ============================================================================
// P07: window-management 真实窗口句柄调度与失败断言
// ============================================================================

test('P07 window-management: executeWindowAction 真实 IPC 桥接与失败时返回 success:false', async () => {
  let invokedPayload = null
  const okRes = await executeWindowAction('left-half', {
    windowId: 'hwnd-1001',
    hostBridge: {
      window_manage_action: async (payload) => {
        invokedPayload = payload
        return { ok: true, rect: { x: 0, y: 0, width: 960, height: 1040 } }
      }
    }
  })
  assert.equal(okRes.success, true)
  assert.equal(invokedPayload?.action, 'left-half')
  assert.equal(okRes.rect?.width, 960)

  // 异常场景 1：空 actionId 校验失败
  const emptyRes = await executeWindowAction('', {})
  assert.equal(emptyRes.success, false)
  assert.ok(emptyRes.error)

  // 异常场景 2：宿主无活动外部窗口或拒绝移动时，必须返回 success: false
  const failRes = await executeWindowAction('maximize', {
    hostBridge: {
      window_manage_action: async () => {
        throw new Error('当前无可用前台窗口句柄')
      }
    }
  })
  assert.equal(failRes.success, false)
  assert.match(failRes.error || '', /无可用前台窗口句柄/)
})

// ============================================================================
// P08: system 系统动作真实执行与错误透传测试
// ============================================================================

test('P08 system: executeSystemAction 真实调用 system_execute_action 与失败时禁止静默成功', async () => {
  const lockItem = SYSTEM_ACTIONS.find((a) => a.id === 'lock-screen')
  assert.ok(lockItem)

  let calledKey = ''
  const okRes = await executeSystemAction(lockItem, {
    hostOverride: {
      system_execute_action: async (payload) => {
        calledKey = payload.actionKey
        return { ok: true, message: '已调用 LockWorkStation 锁屏' }
      }
    }
  })
  assert.equal(okRes.success, true)
  assert.equal(okRes.executed, true)
  assert.equal(calledKey, 'lockScreen')

  // 异常场景 1：传入未知指令字符串
  const invalidRes = await executeSystemAction('non-existent-system-cmd', {})
  assert.equal(invalidRes.success, false)
  assert.equal(invalidRes.executed, false)

  // 异常场景 2：宿主执行系统指令失败时，严禁落入假成功分支返回 success: true
  const failRes = await executeSystemAction('toggle-desktop-icons', {
    hostOverride: {
      system_execute_action: async () => ({ ok: false, error: 'Explorer 句柄未响应' }),
      dllplugin_call: async () => ({ ok: false, error: 'Explorer 句柄未响应' })
    }
  })
  assert.equal(failRes.success, false)
  assert.equal(failRes.executed, false)
  assert.match(failRes.message, /Explorer 句柄未响应/)
})

// ============================================================================
// P09 & P10: process-monitor 与 hardware-info 真实宿主去假测试
// ============================================================================

test('P09 & P10 process-monitor / hardware-info: 真实宿主下严禁返回 simulated:true 或假进程详情', async () => {
  await withSimulatedRealElectronWindow(
    {
      dllplugin_call: async () => {
        throw new Error('Native DLL 调用失败')
      },
      process_list: async () => [],
      process_info: async () => {
        throw new Error('PID 不存在')
      }
    },
    async () => {
      // P09: invokeNativeCapability 在真实宿主失败时返回 ok: false
      const pmCap = await invokeProcessMonitorCapability('GetProcessList', {})
      assert.equal(pmCap.ok, false)
      assert.equal(pmCap.data?.simulated, undefined)

      // P09: fetchProcessDetail 在真实宿主下当 PID 不存在时返回 null 而非假详情
      const detail = await fetchProcessDetail(99999)
      assert.equal(detail, null)

      // P10: hardware-info invokeNativeCapability 在真实宿主失败时返回 ok: false
      const hwCap = await invokeHardwareInfoCapability('GetHardwareSummary', {})
      assert.equal(hwCap.ok, false)
      assert.equal(hwCap.data?.simulated, undefined)
    }
  )

  // P09: 正常获取真实进程列表与终止系统进程拦截
  const procs = await fetchProcesses({
    process_list: async () => [
      { pid: 8848, name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe', cpuUsage: 3.5, memoryUsage: 104857600 }
    ]
  })
  assert.equal(procs.length, 1)
  assert.equal(procs[0].pid, 8848)

  const killSys = await terminateProcess(4, 'System')
  assert.equal(killSys.ok, false)

  // P10: 硬件遥测真实数据聚合
  const hwSnap = await fetchHardwareTelemetrySnapshot({
    system_get_hardware_summary: async () => ({
      cpuModel: 'AMD Ryzen 9 7950X',
      logicalCpuCount: 32,
      totalMemory: 64 * 1024 * 1024 * 1024,
      osVersion: '10.0.26100'
    }),
    get_system_info: async () => ({
      osName: 'Windows 11 Pro',
      osVersion: '24H2',
      osBuild: 26100,
      osArch: 'x64',
      platform: 'win32',
      appVersion: '2.0.0'
    }),
    system_get_cpu_usage: async () => ({ total: 18, perCore: [18] }),
    system_get_memory_usage: async () => ({
      total: 64 * 1024 * 1024 * 1024,
      used: 20 * 1024 * 1024 * 1024,
      available: 44 * 1024 * 1024 * 1024,
      percent: 31
    }),
    system_get_battery_status: async () => ({ percent: 100, isCharging: true, timeRemaining: 0 }),
    screen_get_all_displays: async () => [{ id: 1, label: '4K Primary', bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scaleFactor: 1.5, displayFrequency: 144 }],
    fs_stat: async () => ({ size: 0, isDirectory: true })
  })
  assert.equal(hwSnap.cpuModel, 'AMD Ryzen 9 7950X')
  assert.equal(hwSnap.logicalCpuCount, 32)
})

// ============================================================================
// P11: clipboard-history 剪贴板真实历史、实时同步与异常参数测试
// ============================================================================

test('P11 clipboard-history: 真实 SQLite 查询、系统剪贴板同步与空参数/敏感凭据防御测试', async () => {
  const mockHost = {
    clipboard_history_query: async () => ({
      items: [
        {
          id: 'sql-clip-101',
          content: 'SELECT * FROM clipboard_items WHERE is_pinned = 1;',
          format_type: 'text',
          created_at: Date.now() - 5000,
          is_pinned: 1
        }
      ]
    }),
    clipboard_read_text: async () => 'npm run test:real-layout1',
    clipboard_history_add: async () => ({ ok: true }),
    clipboard_history_toggle_pin: async ({ id }) => (id === 'sql-clip-101' ? true : { ok: false }),
    clipboard_history_delete: async ({ id }) => (id === 'sql-clip-101' ? true : { ok: false }),
    clipboard_history_clear_unpinned: async () => ({ clearedCount: 3 })
  }

  const history = await getClipboardHistory(mockHost)
  assert.equal(history.length, 1)
  assert.equal(history[0].id, 'sql-clip-101')
  assert.equal(history[0].pinned, true)
  // 严禁混入 SAMPLE_CLIPBOARD_ITEMS (clip-1 ~ clip-5)
  assert.equal(history.some((i) => i.id === 'clip-1'), false)

  // 同步当前系统剪贴板真实文本
  const synced = await syncCurrentSystemClipboard(history, mockHost)
  assert.equal(synced.added, true)
  assert.equal(synced.item?.content, 'npm run test:real-layout1')

  // 正常切换置顶、删除与清空非置顶
  assert.equal(await toggleClipboardItemPin('sql-clip-101', mockHost), true)
  assert.equal(await deleteClipboardItem('sql-clip-101', mockHost), true)
  assert.equal(await clearUnpinnedClipboardHistory(mockHost), 3)

  // 异常场景 1：空 ID 置顶或删除返回 false
  assert.equal(await toggleClipboardItemPin('', mockHost), false)
  assert.equal(await deleteClipboardItem('   ', mockHost), false)

  // 异常场景 2：空剪贴板同步不污染现有列表
  const emptySync = await syncCurrentSystemClipboard(history, {
    clipboard_read_text: async () => '   '
  })
  assert.equal(emptySync.added, false)
  assert.equal(emptySync.items.length, 1)

  // 异常场景 3：敏感 API Key 自动脱敏遮罩验证
  const maskRes = maskSensitiveContent('OPENAI_API_KEY=sk-proj1234567890abcdefghijklmnop9876')
  assert.equal(maskRes.isSensitive, true)
  assert.ok(maskRes.masked.includes('••••••••'))
})
