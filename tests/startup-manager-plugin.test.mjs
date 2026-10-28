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
import { SystemRegistryHostPluginHandler } from '../electron-client/out/main/services/host-plugins/system-registry-host.js'

const handlerCtx = { clipboard: null, processService: null, windowControl: null, authorizeExistingPath: async (p) => p, authorizeOutputPath: async (p) => p }

/** 旧处理器只在 Windows 走真实分支：临时把 process.platform 视作 win32 */
async function asWindows(work) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
  try { return await work() } finally { Object.defineProperty(process, 'platform', original) }
}

/**
 * 宿主不再接受 mockItems / simulateAdminRequired 等模拟参数：Windows 扫描结果与命令输出
 * 改由构造参数注入（PowerShell 扫描 JSON、sc.exe 等命令结果），直接调用旧启动项处理器。
 */
function createInjectedBridge({ scanItems = [], commands = {}, commandCalls } = {}) {
  const handler = new SystemRegistryHostPluginHandler(handlerCtx, {
    runPowerShell: async () => JSON.stringify({ items: scanItems, warnings: [] }),
    runCommand: async (command, args) => {
      commandCalls?.push([command, args])
      const preset = commands[command]
      if (typeof preset === 'function') return preset(args)
      return preset ?? { stdout: '', stderr: `未预设命令: ${command}`, exitCode: 1 }
    }
  })
  return {
    async dllplugin_call({ func, params }) {
      const data = await asWindows(() => handler.handleStartupManager(func, params || {}))
      return { success: true, data }
    }
  }
}

/**
 * reg.exe 替身：按真实输出格式回应 query / delete。run 是 HKCU\...\Run 下的值（名称 → 命令行），
 * RunDisabled 键不存在（query 返回 1，父键列表里也没有它）；deleteResult 控制删除结果。
 */
const RUN_BASE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion'
function regDouble(run = {}, deleteResult = { stdout: '操作成功完成。', stderr: '', exitCode: 0 }) {
  const missing = { stdout: '', stderr: '错误: 系统找不到指定的注册表项或值。', exitCode: 1 }
  return (args) => {
    const [verb, key, flag, name] = args
    if (verb === 'delete') return deleteResult
    if (verb !== 'query') return missing
    if (key === `${RUN_BASE}\\Run`) {
      if (flag === '/v') return Object.hasOwn(run, name) ? { stdout: `\r\n${key}\r\n    ${name}    REG_SZ    ${run[name]}\r\n`, stderr: '', exitCode: 0 } : missing
      return { stdout: `\r\n${key}\r\n${Object.entries(run).map(([n, v]) => `    ${n}    REG_SZ    ${v}`).join('\r\n')}\r\n`, stderr: '', exitCode: 0 }
    }
    if (key === RUN_BASE) return { stdout: `\r\n${RUN_BASE}\r\n${RUN_BASE}\\Run\r\n${RUN_BASE}\\Explorer\r\n`, stderr: '', exitCode: 0 }
    return missing
  }
}

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

    // Windows 启动项扫描结果（注入的 PowerShell 输出），宿主负责归一化、过滤微软核心项并检查目标文件是否存在
    const scanItems = [
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
    const scanRes = await scanStartupItems(createInjectedBridge({ scanItems }), { mockItems: [{ name: 'forged', command: 'C:\\forged.exe' }] })

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
  // 宿主只允许切换系统「启动」目录（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）下的文件，
  // 防止插件借启动项接口重命名任意文件：把 APPDATA 指向临时目录，在其中的启动目录放置真实快捷方式
  const originalAppData = process.env.APPDATA
  process.env.APPDATA = tmpDir
  try {
    const startupDir = path.join(tmpDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    await fs.mkdir(startupDir, { recursive: true })
    const shortcutFile = path.join(startupDir, 'MyGeekTool.lnk')
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
    assert.equal(disableRes.ok, true, `禁用应成功: ${disableRes.error || ''}`)
    assert.equal(disableRes.enabled, false)
    assert.equal(disableRes.updatedItems?.[0]?.enabled, false)
    assert.equal(fsSync.existsSync(`${shortcutFile}.disabled`), true)
    assert.equal(fsSync.existsSync(shortcutFile), false)

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
    assert.equal(enableRes.ok, true, `启用应成功: ${enableRes.error || ''}`)
    assert.equal(enableRes.enabled, true)
    assert.equal(enableRes.updatedItems?.[0]?.enabled, true)
    assert.equal(fsSync.existsSync(shortcutFile), true)
    assert.equal(fsSync.existsSync(`${shortcutFile}.disabled`), false)

    // 3) 启动目录之外的文件：拒绝切换（INVALID_PATH），文件不被重命名，列表状态不变
    const outsideFile = path.join(tmpDir, 'NotStartup.lnk')
    await fs.writeFile(outsideFile, 'Outside')
    const outsideItem = { ...initialItems[0], id: `folder:${outsideFile}`, command: outsideFile, exePath: outsideFile }
    const outsideRes = await setStartupItemEnabled(outsideItem, false, [outsideItem], bridge)
    assert.equal(outsideRes.ok, false)
    assert.equal(outsideRes.errorCode, 'INVALID_PATH')
    assert.equal(outsideRes.updatedItems?.[0]?.enabled, true)
    assert.equal(fsSync.existsSync(outsideFile), true)
    assert.equal(fsSync.existsSync(`${outsideFile}.disabled`), false)

    // 4) 启动目录内文件已被删除：如实报告 ITEM_NOT_FOUND，不能假装切换成功
    const goneFile = path.join(startupDir, 'Gone.lnk')
    const goneItem = { ...initialItems[0], id: `folder:${goneFile}`, command: goneFile, exePath: goneFile }
    const goneRes = await setStartupItemEnabled(goneItem, false, [goneItem], bridge)
    assert.equal(goneRes.ok, false)
    assert.equal(goneRes.errorCode, 'ITEM_NOT_FOUND')
    assert.equal(goneRes.updatedItems?.[0]?.enabled, true)
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('3. [Exception] 异常用例 1：修改系统级 HKLM 或后台服务遇权限不足时拦截回滚 (ADMIN_REQUIRED)', async () => {
  // 普通权限修改服务启动类型：sc.exe 以退出码 5（拒绝访问）失败，与系统行为一致，不再用 simulateAdminRequired 模拟
  const bridge = createInjectedBridge({ commands: { 'sc.exe': { stdout: '[SC] ChangeServiceConfig 失败 5:', stderr: '', exitCode: 5 } } })

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
    bridge
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

    // 宿主不信任调用方的 fileMissing，自己读注册表值解析目标程序：Run 下 ValidApp 指向存在的程序，RemovedApp 指向已删除的程序
    const runValues = { ValidApp: `"${validExe}"`, RemovedApp: `"${missingExe}"` }
    const bridge = createInjectedBridge({ commands: { reg: regDouble(runValues) } })

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
    const hostRejectRes = (await bridge.dllplugin_call({ func: 'removeBroken', params: {
      item: {
        id: 'reg:HKCU:ValidApp',
        name: 'ValidApp',
        command: `"${validExe}"`,
        exePath: validExe,
        fileMissing: false
      },
      dryRun: true
    } })).data
    assert.equal(hostRejectRes.ok, false)
    assert.equal(hostRejectRes.errorCode, 'ITEM_NOT_BROKEN')

    // 2) 预览（dryRun）只做校验、不删除：宿主只统计真正删除的条目，因此删除数为 0、列表不变
    const previewRes = await removeBrokenStartupItems(
      [brokenItem],
      [validItem, brokenItem],
      bridge,
      { dryRun: true }
    )
    assert.equal(previewRes.ok, true)
    assert.equal(previewRes.removedCount, 0)
    assert.equal(previewRes.remainingItems?.length, 2)

    // 3) 真实清理孤儿残留项（Windows 注册表删除由注入的 reg 命令结果表示）：宿主确认删除后才从列表移除
    const cleanBridge = createInjectedBridge({ commands: { reg: regDouble(runValues) } })
    const cleanBrokenRes = await removeBrokenStartupItems([brokenItem], [validItem, brokenItem], cleanBridge)
    assert.equal(cleanBrokenRes.ok, true, `清理应成功: ${cleanBrokenRes.error || ''}`)
    assert.equal(cleanBrokenRes.removedCount, 1)
    assert.equal(cleanBrokenRes.remainingItems?.length, 1)
    assert.equal(cleanBrokenRes.remainingItems?.[0]?.id, 'reg:HKCU:ValidApp')

    // 4) 注册表删除被拒绝：如实报告需要管理员权限，残留项保留在列表中
    const deniedBridge = createInjectedBridge({ commands: { reg: regDouble(runValues, { stdout: '', stderr: '错误: 拒绝访问。', exitCode: 1 }) } })
    const deniedRes = await removeBrokenStartupItems([brokenItem], [validItem, brokenItem], deniedBridge)
    assert.equal(deniedRes.ok, false)
    assert.equal(deniedRes.errorCode, 'ADMIN_REQUIRED')
    assert.equal(deniedRes.removedCount, 0)
    assert.equal(deniedRes.remainingItems?.length, 2)

    // 5) 后台服务 / 计划任务即使目标文件丢失也不删除（误删会破坏已安装软件），返回 UNSUPPORTED_SOURCE
    const brokenTask = { ...brokenItem, id: 'task:\\Ghost\\Update', name: 'GhostUpdate', source: 'task', taskPath: '\\Ghost\\Update' }
    const taskRes = await removeBrokenStartupItems([brokenTask], [validItem, brokenTask], createInjectedBridge())
    assert.equal(taskRes.ok, false)
    assert.equal(taskRes.errorCode, 'UNSUPPORTED_SOURCE')
    assert.equal(taskRes.remainingItems?.length, 2)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('4b. [Exception] 批量清理部分成功：注册表残留删除成功、计划任务拒绝删除，插件只移除已删条目并报告未清理原因', async () => {
  // 直接加载插件源码构建产物（plugins/startup-manager），与真实宿主旧处理器联调
  const { removeBrokenStartupItems: removeBrokenFromPlugin, describeCleanBrokenResult } = await import('../plugins/startup-manager/dist/startup-service.js')
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-partial-'))
  try {
    const validExe = path.join(tmpDir, 'ValidApp.exe')
    await fs.writeFile(validExe, 'MZ')
    const validItem = { id: 'reg:HKCU:ValidApp', name: 'ValidApp', command: `"${validExe}"`, exePath: validExe, source: 'registry', sourceLabel: '注册表', scope: 'HKCU', enabled: true, fileMissing: false }
    const brokenReg = { ...validItem, id: 'reg:HKCU:GoneApp', name: 'GoneApp', command: `"${path.join(tmpDir, 'GoneApp.exe')}"`, exePath: path.join(tmpDir, 'GoneApp.exe'), fileMissing: true }
    const brokenTask = { ...validItem, id: 'task:\\Gone\\Updater', name: 'GoneUpdater', command: `"${path.join(tmpDir, 'Updater.exe')}"`, exePath: path.join(tmpDir, 'Updater.exe'), source: 'task', sourceLabel: '计划任务', scope: 'System', taskPath: '\\Gone\\Updater', fileMissing: true }

    const commandCalls = []
    const bridge = createInjectedBridge({ commands: { reg: regDouble({ ValidApp: `"${validExe}"`, GoneApp: `"${path.join(tmpDir, 'GoneApp.exe')}"` }) }, commandCalls })
    const res = await removeBrokenFromPlugin([brokenReg, brokenTask], [validItem, brokenReg, brokenTask], bridge)
    assert.equal(res.ok, true, `部分成功应以 success:true 返回，否则传输层会丢弃 removedIds：${res.error || ''}`)
    assert.equal(res.partial, true)
    assert.equal(res.removedCount, 1)
    assert.deepEqual(res.removedIds, [brokenReg.id])
    assert.deepEqual(res.remainingItems.map((item) => item.id), [validItem.id, brokenTask.id])
    assert.equal(res.failed.length, 1)
    assert.equal(res.failed[0].id, brokenTask.id)
    assert.equal(res.failed[0].errorCode, 'UNSUPPORTED_SOURCE')
    assert.match(res.failed[0].error, /计划任务/)
    assert.equal(res.errorCode, 'PARTIAL_FAILED')
    // 计划任务从不执行删除命令；注册表删除只针对残留项本身
    assert.ok(commandCalls.length > 0)
    assert.ok(!commandCalls.some(([command, args]) => /schtasks/i.test(command) || (args || []).some((arg) => /Updater/.test(String(arg)))))
    const notice = describeCleanBrokenResult(res, [validItem, brokenReg, brokenTask])
    assert.equal(notice.title, '已清理 1 个，1 个未清理')
    assert.match(notice.message, /^GoneUpdater：.*计划任务/)

    // 宿主直接返回的结构：success:true + partial + failed，错误码 PARTIAL_FAILED
    const raw = await bridge.dllplugin_call({ func: 'removeBroken', params: { items: [brokenReg, brokenTask] } })
    assert.equal(raw.data.ok, true)
    assert.equal(raw.data.success, true)
    assert.equal(raw.data.partial, true)
    assert.equal(raw.data.errorCode, 'PARTIAL_FAILED')
    assert.deepEqual(raw.data.removedIds, [brokenReg.id])
    assert.equal(raw.data.failed[0].id, brokenTask.id)
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
