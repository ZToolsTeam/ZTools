import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  StartupManagerCommand,
  extractExePathFromCommand,
  filterStartupItems,
  removeBrokenStartupItems,
  resolveInitialStartupFilter,
  scanStartupItems,
  setStartupItemEnabled
} from '../packages/declarative-ui/dist/index.js'

import {
  BuiltinPluginHostService
} from '../electron-client/out/main/services/builtin-plugin-host-service.js'

function createBridgeForHostService(hostService) {
  return {
    async dllplugin_call({ plugin, func, params }) {
      const data = await hostService.handlePluginCall(plugin, func, params)
      return { success: true, data }
    }
  }
}

test('1. [Integration] 四大自启源聚合、命令行 exePath 拆解、featureCode 深链筛选与微软系统核心项过滤', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-int-'))
  try {
    const existingAppExe = path.join(tmpDir, 'QuarkCloudDrive.exe')
    const existingFolderLnk = path.join(tmpDir, 'FeishuStartup.lnk')
    const existingServiceExe = path.join(tmpDir, 'GameAntiCheatService.exe')
    const missingTaskExe = path.join(tmpDir, 'UninstalledHelper.exe')

    await fs.writeFile(existingAppExe, 'MZ')
    await fs.writeFile(existingFolderLnk, 'LNK')
    await fs.writeFile(existingServiceExe, 'MZ')
    // missingTaskExe 故意不创建，模拟卸载残留孤儿项

    const hostService = new BuiltinPluginHostService()
    assert.equal(hostService.isSupportedPlugin('startup-manager'), true)
    assert.equal(hostService.normalizePluginName('startup-manager'), 'StartupManagerPlugin')

    const bridge = createBridgeForHostService(hostService)

    const scanRes = await scanStartupItems(bridge, {
      mockItems: [
        {
          id: 'reg:HKCU:QuarkCloudDrive',
          name: 'QuarkCloudDrive',
          publisher: 'Alibaba',
          command: `"${existingAppExe}" --minimized --autorun`,
          source: 'registry',
          scope: 'HKCU',
          enabled: true
        },
        {
          id: `folder:${existingFolderLnk}`,
          name: 'FeishuStartup',
          publisher: 'ByteDance',
          command: existingFolderLnk,
          source: 'folder',
          scope: 'User',
          enabled: true
        },
        {
          id: 'service:GameAntiCheatSvc',
          name: 'Game Anti-Cheat Background Service',
          serviceName: 'GameAntiCheatSvc',
          publisher: 'Riot Games',
          command: `"${existingServiceExe}" --service`,
          source: 'service',
          scope: 'System',
          enabled: true
        },
        {
          id: 'task:\\ThirdPartyUpdater\\AutoCheck',
          name: 'ThirdPartyUpdaterAutoCheck',
          taskPath: '\\ThirdPartyUpdater\\AutoCheck',
          publisher: 'GhostSoft',
          command: `"${missingTaskExe}" /background`,
          source: 'task',
          scope: 'System',
          enabled: false
        },
        // 以下两项为微软官方系统核心服务与计划任务，必须被安全过滤剔除
        {
          id: 'service:RpcSs',
          name: 'Remote Procedure Call (RPC)',
          serviceName: 'RpcSs',
          publisher: 'Microsoft Corporation',
          command: 'C:\\Windows\\System32\\svchost.exe -k rpcss',
          source: 'service',
          enabled: true
        },
        {
          id: 'task:\\Microsoft\\Windows\\Defrag\\ScheduledDefrag',
          name: 'ScheduledDefrag',
          taskPath: '\\Microsoft\\Windows\\Defrag\\ScheduledDefrag',
          publisher: 'Microsoft Corporation',
          command: 'C:\\Windows\\System32\\defrag.exe -c',
          source: 'task',
          enabled: true
        }
      ]
    })

    assert.equal(scanRes.ok, true)
    assert.equal(scanRes.totalCount, 4, '应保留 4 个第三方自启项并自动剔除 2 个微软系统核心项')
    assert.equal(scanRes.enabledCount, 3)
    assert.equal(scanRes.serviceCount, 1)
    assert.equal(scanRes.taskCount, 1)
    assert.equal(scanRes.brokenCount, 1)

    const regItem = scanRes.items.find((i) => i.source === 'registry')
    assert.equal(regItem?.exePath, existingAppExe, '应从带双引号和参数的命令行中精确提取 exePath')
    assert.equal(regItem?.fileMissing, false)

    const brokenTask = scanRes.items.find((i) => i.source === 'task')
    assert.equal(brokenTask?.exePath, missingTaskExe)
    assert.equal(brokenTask?.fileMissing, true, '不存在的目标程序必须自动标记为 fileMissing=true')

    // 验证 featureCode 深链与分类筛选
    assert.equal(resolveInitialStartupFilter('startup-services'), 'service')
    assert.equal(resolveInitialStartupFilter('startup-tasks'), 'task')
    assert.equal(filterStartupItems(scanRes.items, 'app', '').length, 2)
    assert.equal(filterStartupItems(scanRes.items, 'service', '').length, 1)
    assert.equal(filterStartupItems(scanRes.items, 'task', '').length, 1)
    assert.equal(filterStartupItems(scanRes.items, 'broken', '').length, 1)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('2. [Integration] 启用/禁用可逆状态切换闭环（真实启动目录文件级切换与列表状态同步）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-toggle-'))
  try {
    const shortcutFile = path.join(tmpDir, 'MyGeekTool.lnk')
    await fs.writeFile(shortcutFile, 'Shortcut Content')

    const hostService = new BuiltinPluginHostService()
    const bridge = createBridgeForHostService(hostService)

    const initialItems = [
      {
        id: `folder:${shortcutFile}`,
        name: 'MyGeekTool',
        publisher: 'Geek Corp',
        command: shortcutFile,
        exePath: shortcutFile,
        source: 'folder',
        sourceLabel: '启动目录',
        scope: 'User',
        enabled: true,
        fileMissing: false
      }
    ]

    // 1) 禁用启动项 -> 文件应重命名为 MyGeekTool.lnk.disabled 且列表状态变为 enabled: false
    const disableRes = await setStartupItemEnabled(
      initialItems[0],
      false,
      initialItems,
      bridge
    )
    assert.equal(disableRes.ok, true)
    assert.equal(disableRes.enabled, false)
    assert.equal(disableRes.updatedItems?.[0]?.enabled, false)
    assert.equal(fsSync.existsSync(`${shortcutFile}.disabled`), true)

    // 2) 重新启用启动项 -> 文件应恢复为 MyGeekTool.lnk 且列表状态变为 enabled: true
    const disabledItem = {
      ...initialItems[0],
      command: `${shortcutFile}.disabled`,
      enabled: false
    }
    const enableRes = await setStartupItemEnabled(
      disabledItem,
      true,
      disableRes.updatedItems,
      bridge
    )
    assert.equal(enableRes.ok, true)
    assert.equal(enableRes.enabled, true)
    assert.equal(enableRes.updatedItems?.[0]?.enabled, true)
    assert.equal(fsSync.existsSync(shortcutFile), true)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('3. [Exception] 异常用例 1：修改系统级 HKLM 或后台服务遇权限不足时拦截回滚 (ADMIN_REQUIRED)', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createBridgeForHostService(hostService)

  const hklmServiceItem = {
    id: 'service:HeavyUpdaterSvc',
    name: 'Heavy Updater Service',
    serviceName: 'HeavyUpdaterSvc',
    publisher: 'ThirdParty Inc',
    command: 'D:\\Program Files\\Heavy\\UpdaterSvc.exe',
    exePath: 'D:\\Program Files\\Heavy\\UpdaterSvc.exe',
    source: 'service',
    sourceLabel: '后台服务',
    scope: 'System',
    enabled: true,
    fileMissing: false
  }

  const currentList = [hklmServiceItem]
  const toggleRes = await setStartupItemEnabled(
    hklmServiceItem,
    false,
    currentList,
    bridge,
    { simulateAdminRequired: true }
  )

  assert.equal(toggleRes.ok, false)
  assert.equal(toggleRes.errorCode, 'ADMIN_REQUIRED')
  assert.match(String(toggleRes.error), /管理员权限/)
  assert.equal(
    toggleRes.updatedItems?.[0]?.enabled,
    true,
    '当宿主返回 ADMIN_REQUIRED 失败时，严禁发生乐观假更新，原有启用状态必须保持不变'
  )
})

test('4. [Exception] 异常用例 2：孤儿残留识别清理与正常启动项防误删保护 (ITEM_NOT_BROKEN)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-broken-'))
  try {
    const validExe = path.join(tmpDir, 'ValidApp.exe')
    await fs.writeFile(validExe, 'MZ')
    const missingExe = path.join(tmpDir, 'RemovedApp.exe')

    const hostService = new BuiltinPluginHostService()
    const bridge = createBridgeForHostService(hostService)

    const validItem = {
      id: 'reg:HKCU:ValidApp',
      name: 'ValidApp',
      publisher: 'Valid Corp',
      command: `"${validExe}"`,
      exePath: validExe,
      source: 'registry',
      sourceLabel: '注册表',
      scope: 'HKCU',
      enabled: true,
      fileMissing: false
    }

    const brokenItem = {
      id: 'reg:HKCU:RemovedApp',
      name: 'RemovedApp',
      publisher: 'Old Corp',
      command: `"${missingExe}"`,
      exePath: missingExe,
      source: 'registry',
      sourceLabel: '注册表',
      scope: 'HKCU',
      enabled: false,
      fileMissing: true
    }

    // 1) 尝试对正常存在的条目调用 removeBrokenStartupItems 必须被拒绝
    const rejectNormalRes = await removeBrokenStartupItems(
      [validItem],
      [validItem, brokenItem],
      bridge,
      { dryRun: true }
    )
    assert.equal(rejectNormalRes.ok, false)
    assert.equal(rejectNormalRes.errorCode, 'ITEM_NOT_BROKEN')
    assert.equal(rejectNormalRes.remainingItems?.length, 2)

    // 即使绕过前端直接调宿主 removeBroken，宿主也必须校验物理文件是否存在并拦截删除正常项
    const hostRejectRes = await hostService.handlePluginCall('startup-manager', 'removeBroken', {
      item: {
        id: 'reg:HKCU:ValidApp',
        name: 'ValidApp',
        command: `"${validExe}"`,
        exePath: validExe,
        fileMissing: false
      },
      dryRun: true
    })
    assert.equal(hostRejectRes.ok, false)
    assert.equal(hostRejectRes.errorCode, 'ITEM_NOT_BROKEN')

    // 2) 清理真正丢失文件的孤儿残留项应成功移除
    const cleanBrokenRes = await removeBrokenStartupItems(
      [brokenItem],
      [validItem, brokenItem],
      bridge,
      { dryRun: true }
    )
    assert.equal(cleanBrokenRes.ok, true)
    assert.equal(cleanBrokenRes.removedCount, 1)
    assert.equal(cleanBrokenRes.remainingItems?.length, 1)
    assert.equal(cleanBrokenRes.remainingItems?.[0]?.id, 'reg:HKCU:ValidApp')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('5. [Exception] 异常用例 3：恶意命令注入防护与微软核心服务防篡改拦截', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createBridgeForHostService(hostService)

  const injectionPayloads = [
    'EvilApp; Remove-Item -Recurse C:\\',
    'BadSvc | calc.exe',
    'Inject$(whoami)',
    'NullByte\0App',
    'LineBreak\nApp'
  ]

  for (const payload of injectionPayloads) {
    const malItem = {
      id: `service:${payload}`,
      name: payload,
      serviceName: payload,
      publisher: 'Attacker',
      command: 'D:\\evil.exe',
      exePath: 'D:\\evil.exe',
      source: 'service',
      sourceLabel: '后台服务',
      scope: 'System',
      enabled: true,
      fileMissing: false
    }

    const clientRes = await setStartupItemEnabled(malItem, false, [malItem], bridge)
    assert.equal(clientRes.ok, false)
    assert.equal(clientRes.errorCode, 'INVALID_IDENTIFIER')

    const hostRes = await hostService.handlePluginCall('startup-manager', 'setEnabled', {
      id: malItem.id,
      name: malItem.name,
      serviceName: malItem.serviceName,
      source: 'service',
      enabled: false
    })
    assert.equal(hostRes.ok, false)
    assert.equal(hostRes.errorCode, 'INVALID_IDENTIFIER')
  }

  // 直接调用宿主尝试禁用微软核心服务 (RpcSs) 必须被 PROTECTED_SYSTEM_ITEM 拦截
  const msProtectedRes = await hostService.handlePluginCall('startup-manager', 'setEnabled', {
    id: 'service:RpcSs',
    name: 'RpcSs',
    serviceName: 'RpcSs',
    source: 'service',
    enabled: false
  })
  assert.equal(msProtectedRes.ok, false)
  assert.equal(msProtectedRes.errorCode, 'PROTECTED_SYSTEM_ITEM')
})
