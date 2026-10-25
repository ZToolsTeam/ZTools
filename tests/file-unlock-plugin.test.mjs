import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  Color,
  FileUnlockCommand,
  detectClipboardCandidatePath,
  filterLockingProcesses,
  inspectTargetLocks,
  isKernelProtectedProcess,
  listRemovableDrives,
  unlockAllProcesses,
  unlockAndTrashTarget,
  unlockSingleProcess,
  validateTargetPath
} from '../packages/declarative-ui/dist/index.js'

import {
  BuiltinPluginHostService
} from '../electron-client/out/main/services/builtin-plugin-host-service.js'

function createBridgeForHostService(hostService, extraHandlers = {}) {
  return {
    async dllplugin_call({ plugin, func, params }) {
      const data = await hostService.handlePluginCall(plugin, func, params)
      return { success: true, data }
    },
    ...extraHandlers
  }
}

test('1. [Integration] 真实子进程占用检测、PID 身份核验、强制解锁并移入回收站端到端闭环', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-file-unlock-int-'))
  let child = null
  try {
    const lockedFile = path.join(tmpDir, 'quarterly-budget-2026.docx')
    await fs.writeFile(lockedFile, 'Locked Office Document Content')

    // 启动一个真实的后台 Node 子进程打开并持有该文件
    child = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(lockedFile)}, 'r+'); setInterval(() => {}, 1000);`
      ],
      { stdio: 'ignore' }
    )
    assert.ok(child.pid && child.pid > 4, '应成功启动持有文件句柄的真实子进程')

    // 等待子进程完成启动
    await new Promise((r) => setTimeout(r, 250))

    const hostService = new BuiltinPluginHostService()
    assert.equal(hostService.isSupportedPlugin('file-unlock'), true)
    assert.equal(hostService.normalizePluginName('file-unlock'), 'FileUnlockPlugin')

    const bridge = createBridgeForHostService(hostService)

    // 1. 检测占用（传入真实子进程信息验证完整链路）
    const expectedProcName = process.platform === 'win32' ? 'node.exe' : path.basename(process.execPath)
    const inspectRes = await inspectTargetLocks(lockedFile, bridge, {
      mockProcesses: [
        {
          pid: child.pid,
          name: expectedProcName,
          executablePath: process.execPath,
          lockedPath: lockedFile
        }
      ]
    })

    assert.equal(inspectRes.ok, true)
    assert.equal(inspectRes.isUnlocked, false)
    assert.equal(inspectRes.processes.length, 1)
    assert.equal(inspectRes.processes[0].pid, child.pid)
    assert.equal(inspectRes.processes[0].isProtected, false)
    assert.equal(inspectRes.processes[0].serviceTypeLabel, '普通进程')

    // 2. 执行解锁并移入回收站（真实终止该子进程并删除被锁文件）
    const unlockTrashRes = await unlockAndTrashTarget(inspectRes.processes, lockedFile, bridge)
    assert.equal(unlockTrashRes.ok, true, `解锁并删除应成功: ${unlockTrashRes.error || ''}`)
    assert.equal(unlockTrashRes.unlockedCount, 1)
    assert.equal(unlockTrashRes.trashed, true)
    assert.equal(fsSync.existsSync(lockedFile), false, '解锁后目标文件应已被移入回收站或清理')
  } finally {
    if (child && child.pid) {
      try {
        process.kill(child.pid)
      } catch {
        // already killed by unlockAndTrashTarget
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('2. [Integration] 声明式 UI 渲染、剪贴板路径自动预填、U 盘列表与 Explorer 平滑重启闭环', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-file-unlock-ui-'))
  try {
    const sampleFile = path.join(tmpDir, 'locked-slides.pptx')
    await fs.writeFile(sampleFile, 'PPTX Data')

    const hostService = new BuiltinPluginHostService()
    const bridge = createBridgeForHostService(hostService, {
      async clipboard_read_text() {
        return { success: true, data: `"${sampleFile}"` }
      }
    })

    // 剪贴板自动识别合法绝对路径并剥离引号
    const clipPath = await detectClipboardCandidatePath(bridge)
    assert.equal(clipPath, sampleFile)

    // 扫描包含普通进程、Explorer 资源管理器、系统内核进程 3 类占用
    const inspectRes = await inspectTargetLocks(sampleFile, bridge, {
      mockProcesses: [
        {
          pid: 12088,
          name: 'POWERPNT.EXE',
          executablePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
          serviceTypeLabel: '普通进程'
        },
        {
          pid: 6420,
          name: 'explorer.exe',
          executablePath: 'C:\\Windows\\explorer.exe'
        },
        {
          pid: 4,
          name: 'System',
          executablePath: 'System'
        }
      ]
    })

    assert.equal(inspectRes.ok, true)
    assert.equal(inspectRes.processes.length, 3)

    const powerpnt = inspectRes.processes.find((p) => p.pid === 12088)
    const explorer = inspectRes.processes.find((p) => p.pid === 6420)
    const systemKernel = inspectRes.processes.find((p) => p.pid === 4)

    assert.equal(powerpnt?.isProtected, false)
    assert.equal(powerpnt?.serviceTypeLabel, '普通进程')

    assert.equal(explorer?.isProtected, false, 'explorer.exe 应允许平滑重启而非标为系统内核保护')
    assert.equal(explorer?.serviceTypeLabel, '资源管理器')

    assert.equal(systemKernel?.isProtected, true, 'System (PID 4) 必须标记为受保护内核进程')
    assert.equal(systemKernel?.serviceTypeLabel, '系统内核')

    // 验证筛选器逻辑
    const killableOnly = filterLockingProcesses(inspectRes.processes, 'killable', '')
    assert.equal(killableOnly.length, 2)
    const protectedOnly = filterLockingProcesses(inspectRes.processes, 'protected', '')
    assert.equal(protectedOnly.length, 1)
    assert.equal(protectedOnly[0].pid, 4)

    // 验证 Explorer 解锁时触发平滑重启标记 (dryRun 模式不实际重启宿主桌面)
    const explorerUnlockRes = await unlockSingleProcess(
      explorer,
      sampleFile,
      { extraParams: { dryRun: true, liveProcessName: 'explorer.exe' } },
      bridge
    )
    assert.equal(explorerUnlockRes.ok, true)
    assert.equal(explorerUnlockRes.explorerRestarted, true)

    // 验证声明式 UI 树符合布局一与 6 条红线
    const viewTree = FileUnlockCommand({
      initialPath: sampleFile,
      hostOverride: bridge
    })
    assert.equal(viewTree.type, 'List')
    assert.equal(viewTree.props.isShowingDetail, false)
    assert.equal(viewTree.props.metricGrid, undefined, '严禁在列表上方堆砌 MetricGrid')
    assert.equal(viewTree.props.distributionBar, undefined, '严禁在列表上方堆砌 DistributionBar')
    assert.equal(viewTree.props.filterBar.groups, undefined, '严禁同时使用 searchBarAccessory 与 filterBar.groups')
    assert.equal(viewTree.props.filterBar.actions.length, 2)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('3. [Exception] 异常测试 1：系统关键保护进程强杀拦截 (PROCESS_PROTECTED)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-file-unlock-prot-'))
  try {
    const targetFile = path.join(tmpDir, 'ntuser.dat')
    await fs.writeFile(targetFile, 'system hive')

    const hostService = new BuiltinPluginHostService()
    const bridge = createBridgeForHostService(hostService)

    const criticalCases = [
      { pid: 4, name: 'System' },
      { pid: 612, name: 'csrss.exe' },
      { pid: 880, name: 'lsass.exe' },
      { pid: 1024, name: 'svchost.exe' },
      { pid: 740, name: 'wininit.exe' },
      { pid: 1, name: 'launchd' }
    ]

    for (const c of criticalCases) {
      assert.equal(
        isKernelProtectedProcess(c.pid, c.name),
        true,
        `${c.name} (PID ${c.pid}) 必须被识别为系统核心保护进程`
      )

      // 即使调用方绕过前端直接调宿主 unlockPath，宿主也必须强行拦截并返回 PROCESS_PROTECTED
      const hostRes = await hostService.handlePluginCall('file-unlock', 'unlockPath', {
        pid: c.pid,
        expectedName: c.name,
        targetPath: targetFile
      })
      assert.equal(hostRes.ok, false)
      assert.equal(hostRes.errorCode, 'PROCESS_PROTECTED')
      assert.match(String(hostRes.error), /PROCESS_PROTECTED/)
    }

    // 当列表中仅有系统关键进程时，批量一键解锁也必须安全拦截并返回 PROCESS_PROTECTED
    const inspectRes = await inspectTargetLocks(targetFile, bridge, {
      mockProcesses: [
        { pid: 612, name: 'csrss.exe', executablePath: 'C:\\Windows\\System32\\csrss.exe' },
        { pid: 4, name: 'System', executablePath: 'System' }
      ]
    })
    assert.equal(inspectRes.processes.every((p) => p.isProtected), true)

    const batchRes = await unlockAllProcesses(inspectRes.processes, targetFile, {}, bridge)
    assert.equal(batchRes.ok, false)
    assert.equal(batchRes.errorCode, 'PROCESS_PROTECTED')
    assert.equal(batchRes.unlockedCount, 0)
    assert.equal(batchRes.skippedProtectedCount, 2)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('4. [Exception] 异常测试 2：目标路径不存在、空输入、空字节与 .. 路径穿越拦截', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createBridgeForHostService(hostService)

  // 1) 空路径与纯空白
  const emptyRes = await inspectTargetLocks('   ', bridge)
  assert.equal(emptyRes.ok, false)
  assert.equal(emptyRes.errorCode, 'INVALID_PATH')

  // 2) 空字节注入 (null byte)
  const nullByteRes = await inspectTargetLocks('C:\\Users\\Public\\report.docx\0.exe', bridge)
  assert.equal(nullByteRes.ok, false)
  assert.equal(nullByteRes.errorCode, 'INVALID_PATH')

  // 3) 相对路径与 .. 路径穿越
  const traversalRes = await inspectTargetLocks('C:\\Users\\Public\\..\\..\\Windows\\System32\\cmd.exe', bridge)
  assert.equal(traversalRes.ok, false)
  assert.equal(traversalRes.errorCode, 'INVALID_PATH')

  const relativeRes = validateTargetPath('relative/folder/file.txt')
  assert.equal(relativeRes.valid, false)
  assert.equal(relativeRes.errorCode, 'INVALID_PATH')

  // 4) 不存在的物理路径
  const nonExistentPath = path.join(os.tmpdir(), `ztools-non-existent-${Date.now()}`, 'ghost.docx')
  const missingRes = await inspectTargetLocks(nonExistentPath, bridge)
  assert.equal(missingRes.ok, false)
  assert.equal(missingRes.errorCode, 'TARGET_NOT_FOUND')
  assert.match(String(missingRes.error), /TARGET_NOT_FOUND/)
})

test('5. [Exception] 异常测试 3：PID 复用与进程身份不匹配防误杀校验 (PROCESS_IDENTITY_MISMATCH)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-file-unlock-pid-'))
  try {
    const targetFile = path.join(tmpDir, 'contract.pdf')
    await fs.writeFile(targetFile, 'PDF Contract')

    const hostService = new BuiltinPluginHostService()
    const bridge = createBridgeForHostService(hostService)

    // 扫描时 PID 9527 是 WINWORD.EXE，但在点击解锁前该进程已退出且 PID 9527 被 chrome.exe 复用
    const staleProc = {
      id: `9527-${targetFile}`,
      pid: 9527,
      name: 'WINWORD.EXE',
      executablePath: 'C:\\Program Files\\Microsoft Office\\WINWORD.EXE',
      lockedPath: targetFile,
      handleType: 'file',
      serviceTypeLabel: '普通进程',
      isProtected: false,
      user: 'Geek'
    }

    const res = await unlockSingleProcess(
      staleProc,
      targetFile,
      {
        extraParams: {
          liveProcessName: 'chrome.exe',
          dryRun: true
        }
      },
      bridge
    )

    assert.equal(res.ok, false, '当实时进程名与 expectedName 不一致时必须拒绝终止')
    assert.equal(res.errorCode, 'PROCESS_IDENTITY_MISMATCH')
    assert.match(String(res.error), /PROCESS_IDENTITY_MISMATCH/)
    assert.equal(res.unlockedCount, 0)

    // 缺少 expectedName 参数时宿主也必须直接拒绝
    const missingExpectedRes = await hostService.handlePluginCall('file-unlock', 'unlockPath', {
      pid: 9527,
      expectedName: '',
      targetPath: targetFile
    })
    assert.equal(missingExpectedRes.ok, false)
    assert.equal(missingExpectedRes.errorCode, 'MISSING_EXPECTED_NAME')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('6. [Exception] 异常测试 4：高权限进程拒绝访问 (PROCESS_ACCESS_DENIED) 与系统受保护路径防删', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-file-unlock-perm-'))
  try {
    const targetFile = path.join(tmpDir, 'service-locked.db')
    await fs.writeFile(targetFile, 'SQLite DB')

    const hostService = new BuiltinPluginHostService()
    const bridge = createBridgeForHostService(hostService)

    const elevatedProc = {
      id: `8848-${targetFile}`,
      pid: 8848,
      name: 'SqlServr.exe',
      executablePath: 'C:\\Program Files\\Microsoft SQL Server\\SqlServr.exe',
      lockedPath: targetFile,
      handleType: 'file',
      serviceTypeLabel: '后台服务',
      isProtected: false,
      user: 'SYSTEM'
    }

    // 模拟普通权限下终止高权限服务进程遭遇 EACCES / EPERM
    const deniedRes = await unlockSingleProcess(
      elevatedProc,
      targetFile,
      {
        extraParams: {
          liveProcessName: 'SqlServr.exe',
          simulateAccessDenied: true
        }
      },
      bridge
    )
    assert.equal(deniedRes.ok, false)
    assert.equal(deniedRes.errorCode, 'PROCESS_ACCESS_DENIED')
    assert.match(String(deniedRes.error), /管理员/)

    // 尝试对受保护的系统根目录执行 trashAfterUnlock 必须被安全拦截
    const sysPath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/System'
    const protectedPathRes = await hostService.handlePluginCall('file-unlock', 'unlockPath', {
      pid: 8848,
      expectedName: 'notepad.exe',
      liveProcessName: 'notepad.exe',
      dryRun: true,
      targetPath: sysPath,
      trashAfterUnlock: true
    })
    assert.equal(protectedPathRes.ok, false)
    assert.ok(
      protectedPathRes.errorCode === 'ACCESS_DENIED' || protectedPathRes.errorCode === 'PROTECTED_PATH',
      `系统核心目录必须拦截移入回收站，实际返回: ${JSON.stringify(protectedPathRes)}`
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
