import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import {
  // Shared IPC Bridge
  callHostTransport,
  probeRealDiskDrives,
  // 1. Disk Analyzer
  DiskAnalyzerCommand,
  fetchDiskAnalysisSnapshot,
  deleteDiskFileItem,
  FORBIDDEN_DISK_ANALYZER_REASON,
  // 2. WeChat Cleaner
  WechatCleanerCommand,
  fetchWechatCleanSnapshot,
  executeWechatCleanup,
  FORBIDDEN_WECHAT_CLEANER_PATTERN,
  // 3. QQ Cleaner
  QQCleanerCommand,
  fetchQQCleanSnapshot,
  executeQQCleanup,
  FORBIDDEN_QQ_CLEANER_PATTERN,
  // 4. Flow Guard
  FlowGuardCommand,
  fetchFlowGuardSnapshot,
  terminateNetworkProcess,
  FORBIDDEN_FLOW_GUARD_REASON,
  // 5. Hardware Info
  HardwareInfoCommand,
  fetchHardwareTelemetrySnapshot,
  // 6. Boost
  BoostCommand,
  fetchBoostSnapshot,
  terminateBoostProcess,
  FORBIDDEN_BOOST_REASON,
  // 7. Batch Rename
  BatchRenameCommand,
  applyRenameRule,
  fetchRealBatchRenameFiles,
  executeRealFileRename,
  FORBIDDEN_BATCH_RENAME_REASON,
  // 8. Batch Video
  BatchVideoCommand,
  fetchRealVideoWorkspace,
  // 9. Batch Audio
  BatchAudioCommand,
  fetchRealAudioWorkspace,
  // 10. PDF Workbench
  PdfCommand,
  fetchRealPdfWorkspace
} from '../packages/declarative-ui/dist/index.js'

import { invokeNativeCapability as invokeVideoNative } from '../packages/declarative-ui/dist/examples/batch-video/logic.js'
import { invokeNativeCapability as invokeAudioNative } from '../packages/declarative-ui/dist/examples/batch-audio/logic.js'
import { invokeNativeCapability as invokePdfNative } from '../packages/declarative-ui/dist/examples/pdf/logic.js'
import { invokeNativeCapability as invokeHwNative } from '../packages/declarative-ui/dist/examples/hardware-info/logic.js'

/**
 * 构造对接当前真实 Node OS / FS 环境的集成测试宿主桥接器
 */
function createRealNodeIntegrationBridge() {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = Math.max(0, totalMem - freeMem)
  const memPct = Math.round((usedMem / totalMem) * 100)
  const workspaceDir = process.cwd()

  return {
    transport: {
      async call(method, params = {}) {
        switch (method) {
          case 'system_get_disk_usage': {
            if (/^[CD]:[\\/]?$/i.test(String(params.drive || ''))) {
              return {
                total: 512 * 1024 * 1024 * 1024,
                used: 320 * 1024 * 1024 * 1024,
                available: 192 * 1024 * 1024 * 1024,
                percent: 62
              }
            }
            throw new Error(`Drive not mounted: ${params.drive}`)
          }
          case 'system_get_path': {
            return workspaceDir
          }
          case 'filesystem_get_directory_contents': {
            const target = params.path || workspaceDir
            if (!fs.existsSync(target)) return []
            const stat = fs.statSync(target)
            if (!stat.isDirectory()) return []
            return fs
              .readdirSync(target)
              .slice(0, 15)
              .map(name => path.join(target, name))
          }
          case 'filesystem_get_file_size': {
            const p = params.path
            if (!p || !fs.existsSync(p)) return 0
            const st = fs.statSync(p)
            return st.isFile() ? st.size : 0
          }
          case 'system_get_hardware_summary': {
            return {
              cpuModel: cpus[0]?.model || 'x64 CPU',
              logicalCpuCount: cpus.length,
              totalMemory: totalMem,
              osVersion: os.release()
            }
          }
          case 'get_system_info': {
            return {
              osName: `${os.type()} ${os.release()}`,
              osVersion: os.release(),
              osBuild: 26200,
              osArch: os.arch(),
              platform: os.platform(),
              appVersion: '2.0.0'
            }
          }
          case 'system_get_cpu_usage': {
            return { total: 18, perCore: cpus.map(() => 18) }
          }
          case 'system_get_memory_usage': {
            return {
              total: totalMem,
              used: usedMem,
              available: freeMem,
              percent: memPct
            }
          }
          case 'system_get_battery_status': {
            return { percent: 100, isCharging: true, timeRemaining: -1 }
          }
          case 'screen_get_all_displays': {
            return [
              {
                id: 1,
                label: 'Primary Monitor',
                bounds: { x: 0, y: 0, width: 2560, height: 1440 },
                workArea: { x: 0, y: 0, width: 2560, height: 1400 },
                scaleFactor: 1.25,
                displayFrequency: 144,
                colorDepth: 24
              }
            ]
          }
          case 'process_list': {
            return [
              {
                pid: process.pid,
                name: 'node.exe',
                path: process.execPath,
                cpuUsage: 4.5,
                memoryUsage: process.memoryUsage().rss
              },
              {
                pid: 4,
                name: 'System',
                path: 'C:\\Windows\\System32\\ntoskrnl.exe',
                cpuUsage: 0.2,
                memoryUsage: 128 * 1024 * 1024
              }
            ]
          }
          case 'process_list_ports': {
            return [
              {
                protocol: 'TCP',
                localAddress: '127.0.0.1',
                localPort: 9222,
                remoteAddress: '127.0.0.1',
                remotePort: 54321,
                state: 'ESTABLISHED',
                pid: process.pid,
                processName: 'node'
              },
              {
                protocol: 'UDP',
                localAddress: '0.0.0.0',
                localPort: 5353,
                remoteAddress: '*',
                remotePort: 0,
                state: '',
                pid: 4,
                processName: 'System'
              }
            ]
          }
          case 'shell_trash_item':
          case 'filesystem_move_file':
          case 'process_kill':
            return { success: true }
          default:
            return {}
        }
      }
    }
  }
}

test('1. [DiskAnalyzer] 真实分区探测、热点文件扫描与系统核心目录防误删拦截', async () => {
  const bridge = createRealNodeIntegrationBridge()
  const snap = await fetchDiskAnalysisSnapshot(bridge)

  assert.equal(snap.drives.length, 2, '应探测到 C: 与 D: 两个已挂载分区')
  assert.ok(snap.totalCapacityBytes > 0, '总容量应大于 0')
  assert.ok(snap.files.length > 0, '应扫描出当前工作目录下的真实文件')
  assert.ok(snap.extStats.length > 0, '应生成扩展名空间统计')

  // 异常与安全边界：拦截删除 C:\Windows 与 C:\System Volume Information
  const blockWin = await deleteDiskFileItem('C:\\Windows\\System32\\kernel32.dll', bridge)
  assert.equal(blockWin.ok, false)
  assert.equal(blockWin.error, FORBIDDEN_DISK_ANALYZER_REASON)

  const blockSvi = await deleteDiskFileItem('C:\\System Volume Information\\restore.dat', bridge)
  assert.equal(blockSvi.ok, false)

  const emptyPath = await deleteDiskFileItem('', bridge)
  assert.equal(emptyPath.ok, false)

  // UI 描述符结构校验
  const view = DiskAnalyzerCommand()
  assert.equal(view.type, 'List')
  assert.ok(view.props.metricGrid, '必须包含顶栏 MetricGrid')
  assert.ok(view.props.segmentedControl, '必须包含顶栏 SegmentedControl')
})

test('2. [WechatCleaner & QQCleaner] 真实目录扫描与核心聊天数据库 (MSG.db / Msg3.0.db) 保护防线', async () => {
  const bridge = createRealNodeIntegrationBridge()
  const wxSnap = await fetchWechatCleanSnapshot(bridge)
  assert.equal(wxSnap.categories.length, 5)
  assert.ok(wxSnap.systemDiskTotalBytes > 0)

  // 注入受保护聊天数据库文件与正常缓存文件混合样本，验证清理时严格跳过聊天数据库
  const mockWxCategories = [
    {
      id: 'wx-test',
      name: '测试分类',
      category: 'media',
      riskLevel: 'safe',
      targetDir: 'C:\\Users\\Test\\Documents\\WeChat Files',
      existsOnDisk: true,
      fileCount: 3,
      totalSizeBytes: 3000,
      checked: true,
      description: 'test',
      sampleFiles: [
        { path: 'C:\\Users\\Test\\Documents\\WeChat Files\\wxid_1\\Msg\\MSG0.db', sizeBytes: 1000 },
        { path: 'C:\\Users\\Test\\Documents\\WeChat Files\\wxid_1\\Msg\\MicroMsg.db', sizeBytes: 1000 },
        { path: 'C:\\Users\\Test\\Documents\\WeChat Files\\wxid_1\\FileStorage\\Cache\\thumb.jpg', sizeBytes: 1000 }
      ]
    }
  ]

  assert.equal(FORBIDDEN_WECHAT_CLEANER_PATTERN.test('C:\\WeChat\\MSG0.db'), true)
  const wxCleanRes = await executeWechatCleanup(mockWxCategories, bridge)
  assert.equal(wxCleanRes.ok, true)
  assert.equal(wxCleanRes.skippedProtected, 2, '必须严格跳过 MSG0.db 与 MicroMsg.db')
  assert.equal(wxCleanRes.deletedCount, 1, '仅清理非数据库的普通缩略图缓存')

  // QQ Cleaner 验证
  const qqSnap = await fetchQQCleanSnapshot(bridge)
  assert.equal(qqSnap.categories.length, 5)
  assert.equal(FORBIDDEN_QQ_CLEANER_PATTERN.test('C:\\Tencent Files\\12345\\Msg3.0.db'), true)
  assert.equal(FORBIDDEN_QQ_CLEANER_PATTERN.test('C:\\Tencent Files\\12345\\nt_msg.db'), true)

  const qqCleanRes = await executeQQCleanup(
    [
      {
        id: 'qq-test',
        name: 'QQ测试',
        category: 'cache',
        riskLevel: 'safe',
        targetDir: 'C:\\Tencent Files',
        existsOnDisk: true,
        fileCount: 2,
        totalSizeBytes: 2000,
        checked: true,
        description: 'test',
        sampleFiles: [
          { path: 'C:\\Tencent Files\\10001\\nt_qq\\nt_db\\nt_msg.db', sizeBytes: 1500 },
          { path: 'C:\\Tencent Files\\10001\\Image\\Group2\\cache.png', sizeBytes: 500 }
        ]
      }
    ],
    bridge
  )
  assert.equal(qqCleanRes.skippedProtected, 1, '必须严格跳过 nt_msg.db')
  assert.equal(qqCleanRes.deletedCount, 1)

  assert.equal(WechatCleanerCommand().type, 'List')
  assert.equal(QQCleanerCommand().type, 'List')
})

test('3. [FlowGuard] 真实端口与进程聚合审计及核心网络服务断网拦截保护', async () => {
  const bridge = createRealNodeIntegrationBridge()
  const snap = await fetchFlowGuardSnapshot(bridge)

  assert.equal(snap.totalEndpoints, 2)
  assert.equal(snap.totalEstablished, 1)
  assert.equal(snap.totalUdp, 1)
  assert.equal(snap.groups.length, 2)

  // 安全防线：禁止阻断 System (PID 4)、svchost.exe、lsass.exe、dns.exe
  const blockSys = await terminateNetworkProcess(4, 'System', bridge)
  assert.equal(blockSys.ok, false)
  assert.equal(blockSys.error, FORBIDDEN_FLOW_GUARD_REASON)

  const blockSvchost = await terminateNetworkProcess(1088, 'svchost.exe', bridge)
  assert.equal(blockSvchost.ok, false)

  // 普通用户态联网进程允许正常终止
  const allowUserProc = await terminateNetworkProcess(29999, 'p2p_client.exe', bridge)
  assert.equal(allowUserProc.ok, true)

  const view = FlowGuardCommand()
  assert.equal(view.type, 'List')
  assert.ok(view.props.metricGrid)
})

test('4. [HardwareInfo & Boost] 真实硬件传感器遥测、内存优化快照与危险指令拦截', async () => {
  const bridge = createRealNodeIntegrationBridge()
  const hwSnap = await fetchHardwareTelemetrySnapshot(bridge)

  assert.ok(hwSnap.logicalCpuCount > 0)
  assert.ok(hwSnap.totalMemoryBytes > 0)
  assert.equal(hwSnap.driveCount, 2)
  assert.equal(hwSnap.displayCount, 1)
  assert.ok(hwSnap.entries.length >= 5)

  // 硬件危险 MSR 写指令拦截
  await assert.rejects(
    () => invokeHwNative('GetHardwareInfo', { action: 'RAW_MSR_WRITE' }),
    /SECURITY_INTERCEPTED/
  )

  // Boost 快照与核心进程保护测试
  const boostSnap = await fetchBoostSnapshot(bridge)
  assert.ok(boostSnap.totalMemoryBytes > 0)
  assert.ok(boostSnap.candidates.length > 0)

  const blockLsass = await terminateBoostProcess(680, 'lsass.exe', bridge)
  assert.equal(blockLsass.ok, false)
  assert.equal(blockLsass.error, FORBIDDEN_BOOST_REASON)

  const blockDefender = await terminateBoostProcess(3120, 'Windows Defender', bridge)
  assert.equal(blockDefender.ok, false)

  assert.equal(HardwareInfoCommand().type, 'List')
  assert.equal(BoostCommand().type, 'List')
})

test('5. [BatchRename / BatchVideo / BatchAudio / PDF] 真实文件工作台、重命名规则引擎与路径穿越/损坏响应异常测试', async () => {
  const bridge = createRealNodeIntegrationBridge()

  // BatchRename 规则引擎测试
  assert.equal(
    applyRenameRule('photo.JPG', { type: 'number', startNumber: 1, padDigits: 3 }, 4),
    'photo_005.JPG'
  )
  assert.equal(
    applyRenameRule('DemoFile.TXT', { type: 'case', caseMode: 'lower' }, 0),
    'demofile.txt'
  )

  const renameFiles = await fetchRealBatchRenameFiles('downloads', bridge)
  assert.ok(renameFiles.files.length > 0, '应从真实工作目录加载待重命名文件')

  // 拦截 System32 与路径穿越重命名
  const blockRenameSys = await executeRealFileRename(
    'C:\\Windows\\System32\\cmd.exe',
    'hacked.exe',
    bridge
  )
  assert.equal(blockRenameSys.ok, false)
  assert.equal(blockRenameSys.error, FORBIDDEN_BATCH_RENAME_REASON)

  const blockTraversal = await executeRealFileRename(
    'C:\\Users\\Test\\Downloads\\a.txt',
    '..\\..\\Windows\\a.txt',
    bridge
  )
  assert.equal(blockTraversal.ok, false)

  // BatchVideo / BatchAudio / PDF 真实工作区扫描与异常注入测试
  const [videoWs, audioWs, pdfWs] = await Promise.all([
    fetchRealVideoWorkspace(bridge),
    fetchRealAudioWorkspace(bridge),
    fetchRealPdfWorkspace(bridge)
  ])
  assert.ok(videoWs.files.length > 0 && videoWs.presets.length === 5)
  assert.ok(audioWs.files.length > 0 && audioWs.presets.length === 6)
  assert.ok(pdfWs.files.length > 0 && pdfWs.presets.length === 5)

  // 路径穿越拦截测试
  await assert.rejects(
    () => invokeVideoNative('BatchConvertFormat', { outputPath: '..\\..\\Windows\\System32\\evil.mp4' }),
    /SECURITY_INTERCEPTED/
  )
  await assert.rejects(
    () => invokeAudioNative('BatchConvertFormat', { outputPath: 'C:\\Windows\\System32\\evil.mp3' }),
    /SECURITY_INTERCEPTED/
  )
  await assert.rejects(
    () => invokePdfNative('PdfToWord', { outputPath: '../etc/passwd' }),
    /SECURITY_INTERCEPTED/
  )

  // 损坏 JSON 响应异常断言
  const brokenHost = {
    dllplugin: {
      async call() {
        return '{corrupted_json_payload'
      }
    }
  }
  await assert.rejects(
    () => invokePdfNative('MergePdf', { keepBookmarks: true }, brokenHost),
    /MALFORMED_DLL_RESPONSE/
  )

  assert.equal(BatchRenameCommand().type, 'List')
  assert.equal(BatchVideoCommand().type, 'List')
  assert.equal(BatchAudioCommand().type, 'List')
  assert.equal(PdfCommand().type, 'List')
})
