import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { SystemRegistryHostPluginHandler, type SystemRegistryHostDeps } from '../../src/main/services/host-plugins/system-registry-host.js'
import { PowerShellError, type HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

// 第四批：旧内置处理器不再接受 mock*/simulate* 参数伪造结果；真实分支用构造参数注入的替身测试。
type Result = { ok?: boolean; success: boolean; errorCode?: string; error?: string; [key: string]: unknown }
type CommandResult = { stdout: string; stderr: string; exitCode: number }
const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (exitCode: number, stderr = ''): CommandResult => ({ stdout: '', stderr, exitCode })
const ctx = { clipboard: null, processService: null, windowControl: null, authorizeExistingPath: async (p: string) => p, authorizeOutputPath: async (p: string) => p } as HostPluginContext

/** 按命令名返回预设结果（数组按调用顺序依次取用）并记录调用与 PowerShell 脚本；未预设的命令视为测试缺漏，直接失败 */
function fakeSystem(commands: Record<string, CommandResult | CommandResult[]>, powershell: Array<(script: string) => Promise<string>> = [], extra: Partial<SystemRegistryHostDeps> = {}) {
  const calls: string[] = []
  const scripts: string[] = []
  const deps: Partial<SystemRegistryHostDeps> = {
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '))
      const preset = commands[command]
      if (!preset) throw new Error(`未预设命令: ${command}`)
      return Array.isArray(preset) ? (preset.shift() ?? fail(1, '预设结果已用完')) : preset
    },
    runPowerShell: async (script) => {
      calls.push('powershell')
      scripts.push(script)
      const next = powershell.shift()
      if (!next) throw new Error('未预设 PowerShell')
      return next(script)
    },
    ...extra
  }
  return { calls, scripts, deps }
}
/** 预设 PowerShell 输出 / 失败 */
const psOut = (stdout: string) => async () => stdout
const psFail = (exitCode: number, stderr = '') => async (): Promise<string> => { throw new PowerShellError(exitCode, stderr) }
const asWindows = <T>(work: () => Promise<T>) => asPlatform('win32', work)
async function withTempFile<T>(name: string, work: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-legacy-system-'))
  try { const file = path.join(dir, name); await fs.writeFile(file, 'x'); return await work(file, dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('文件解锁：占用进程只来自 lsof 输出（非 Windows），调用方传入的模拟进程被忽略', async () => asPlatform('darwin', async () => {
  await withTempFile('locked.docx', async (file) => {
    const lsof = ['p501', 'cWINWORD', `n${file}`, 'p4', 'cSystem', `n${file}`, `p${process.pid}`, 'cztools', 'pabc', ''].join('\n')
    const sys = fakeSystem({ lsof: ok(lsof) })
    const result = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleFileUnlock('inspectLocks', { targetPath: file, mockProcesses: [{ pid: 999, name: 'fake.exe' }] }) as Result & { processes: Array<Record<string, unknown>> }
    assert.equal(result.success, true); assert.equal(result.isUnlocked, false)
    assert.deepEqual(result.processes.map(p => [p.pid, p.name, p.isProtected, p.serviceTypeLabel]), [[501, 'WINWORD', false, '普通进程'], [4, 'System', true, '系统内核']])
    assert.deepEqual(sys.calls, [`lsof -F pcn -- ${file}`])
    // lsof 没有输出：未被占用
    const free = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ lsof: fail(1) }).deps).handleFileUnlock('inspect', { targetPath: file, mockProcesses: [{ pid: 999, name: 'fake.exe' }] }) as Result
    assert.equal(free.isUnlocked, true)
  })
}))

test('文件解锁（Windows）：重启管理器检测超时、失败、输出畸形都如实报错，不能当成未被占用', async () => {
  await withTempFile('report.xlsx', async (file) => {
    await asWindows(async () => {
      const detected = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [async () => JSON.stringify({ processes: [{ pid: 6420, name: 'explorer.exe', executablePath: 'C:\\Windows\\explorer.exe', serviceType: '2' }, { pid: 12088, name: 'EXCEL.EXE', serviceType: '1' }] })]).deps)
        .handleFileUnlock('inspectLocks', { targetPath: file, mockProcesses: [] }) as Result & { processes: Array<Record<string, unknown>> }
      assert.equal(detected.success, true)
      assert.deepEqual(detected.processes.map(p => [p.pid, p.serviceTypeLabel, p.isProtected]), [[6420, '资源管理器', false], [12088, '普通进程', false]])
      for (const [broken, code] of [[async () => { throw new PowerShellError(124, '') }, 'DETECT_TIMEOUT'], [async () => { throw new PowerShellError(1, 'Add-Type 失败') }, 'DETECT_FAILED'], [async () => 'not json', 'DETECT_FAILED'], [async () => JSON.stringify({ processes: 'x' }), 'DETECT_FAILED']] as const) {
        const failed = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [broken]).deps).handleFileUnlock('inspectLocks', { targetPath: file }) as Result
        assert.equal(failed.success, false); assert.equal(failed.errorCode, code)
      }
    })
  })
})

test('文件解锁：权限不足来自真实结束进程的 EPERM，模拟拒绝参数无效；结束后确认退出才算成功', async () => asPlatform('darwin', async () => {
  await withTempFile('db.sqlite', async (file) => {
    const denied = fakeSystem({ ps: ok('/usr/bin/sqlservr\n') }, [], { killProcess: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) } })
    const deniedResult = await new SystemRegistryHostPluginHandler(ctx, denied.deps).handleFileUnlock('unlockPath', { pid: 8848, expectedName: 'sqlservr', targetPath: file }) as Result
    assert.equal(deniedResult.errorCode, 'PROCESS_ACCESS_DENIED'); assert.match(deniedResult.error!, /权限不足/)
    // 调用方传 simulateAccessDenied 不再拦截：真实结束成功且确认退出
    const killed: number[] = []
    const okSys = fakeSystem({ ps: [ok('/usr/bin/sqlservr\n'), fail(1)] }, [], { killProcess: (pid) => { killed.push(pid) } })
    const done = await new SystemRegistryHostPluginHandler(ctx, okSys.deps).handleFileUnlock('unlockPath', { pid: 8848, expectedName: 'sqlservr', targetPath: file, simulateAccessDenied: true }) as Result
    assert.equal(done.success, true); assert.deepEqual(killed, [8848])
    // 发送了结束请求但进程一直在：不能报告已解除占用
    const stuck = fakeSystem({ ps: ok('/usr/bin/sqlservr\n') }, [], { killProcess: () => undefined })
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, stuck.deps).handleFileUnlock('unlockPath', { pid: 8848, expectedName: 'sqlservr' }) as Result).errorCode, 'TERMINATE_UNCONFIRMED')
    // 进程名与预期不符：不结束
    const mismatch = fakeSystem({ ps: ok('/Applications/Chrome\n') }, [], { killProcess: () => { throw new Error('不应结束') } })
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, mismatch.deps).handleFileUnlock('unlockPath', { pid: 8848, expectedName: 'sqlservr' }) as Result).errorCode, 'PROCESS_IDENTITY_MISMATCH')
  })
}))

test('文件解锁：结束占用后移入回收站失败时保留原文件、报告 TRASH_FAILED 且注明占用已解除；预览不结束进程也不动文件', async () => asPlatform('darwin', async () => {
  await withTempFile('budget.docx', async (file) => {
    // 非 Windows 旧入口没有回收站实现：绝不退化为永久删除
    const killed: number[] = []
    const mac = fakeSystem({ ps: [ok('/Applications/Word\n'), fail(1)] }, [], { killProcess: (pid) => { killed.push(pid) } })
    const macRes = await new SystemRegistryHostPluginHandler(ctx, mac.deps).handleFileUnlock('unlockPath', { pid: 501, expectedName: 'Word', targetPath: file, trashAfterUnlock: true }) as Result
    assert.equal(macRes.success, false); assert.equal(macRes.errorCode, 'TRASH_FAILED'); assert.match(macRes.error!, /TRASH_UNSUPPORTED/)
    assert.equal(macRes.unlocked, true); assert.deepEqual(killed, [501])
    assert.equal(await fs.readFile(file, 'utf8'), 'x')

    await asWindows(async () => {
      const tasklistAlive = ok('"WINWORD.EXE","501","Console","1","88,000 K"')
      const tasklistGone = ok('信息: 没有运行的任务匹配指定标准。')
      // PowerShell 回收站调用失败：原文件保留
      const broken = fakeSystem({ tasklist: [tasklistAlive, tasklistGone] }, [async () => { throw new PowerShellError(1, '找不到程序集 Microsoft.VisualBasic') }], { killProcess: () => undefined })
      const failed = await new SystemRegistryHostPluginHandler(ctx, broken.deps).handleFileUnlock('unlockPath', { pid: 501, expectedName: 'WINWORD.EXE', targetPath: file, trashAfterUnlock: true }) as Result
      assert.equal(failed.errorCode, 'TRASH_FAILED'); assert.match(failed.error!, /Microsoft\.VisualBasic/); assert.equal(failed.unlocked, true)
      assert.equal(fsSync.existsSync(file), true)
      // PowerShell 报告成功但文件仍在：不能当成已移入回收站
      const unconfirmed = fakeSystem({ tasklist: [tasklistAlive, tasklistGone] }, [async () => 'TRASH_OK'], { killProcess: () => undefined })
      const stillThere = await new SystemRegistryHostPluginHandler(ctx, unconfirmed.deps).handleFileUnlock('unlockPath', { pid: 501, expectedName: 'WINWORD.EXE', targetPath: file, trashAfterUnlock: true }) as Result
      assert.equal(stillThere.errorCode, 'TRASH_FAILED'); assert.equal(fsSync.existsSync(file), true)
      // 预览：只查询进程，不结束进程、不移入回收站、不重命名
      const preview = fakeSystem({ tasklist: tasklistAlive }, [], { killProcess: () => { throw new Error('预览不应结束进程') } })
      const dry = await new SystemRegistryHostPluginHandler(ctx, preview.deps).handleFileUnlock('unlockPath', { pid: 501, expectedName: 'WINWORD.EXE', targetPath: file, trashAfterUnlock: true, renameTo: 'renamed.docx', dryRun: true }) as Result
      assert.equal(dry.success, true); assert.equal(dry.dryRun, true); assert.equal(dry.trashed, false); assert.equal(dry.renamedPath, undefined)
      assert.equal(fsSync.existsSync(file), true)
      assert.ok(preview.calls.every(c => c.startsWith('tasklist')))
      // 预览同样校验新文件名
      const badName = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ tasklist: tasklistAlive }).deps).handleFileUnlock('unlockPath', { pid: 501, expectedName: 'WINWORD.EXE', targetPath: file, renameTo: '../evil', dryRun: true }) as Result
      assert.equal(badName.errorCode, 'INVALID_RENAME_TARGET')
    })
  })
}))

test('启动项（Windows）：列表只来自注入的 PowerShell 扫描结果，过滤微软核心项并标记文件缺失；扫描失败如实报错', async () => {
  await withTempFile('Quark.exe', async (exe, dir) => {
    const missing = path.join(dir, 'Removed.exe')
    const items = [
      { id: 'reg:HKCU:Quark', name: 'Quark', command: `"${exe}" --autorun`, source: 'registry', scope: 'HKCU', enabled: true },
      { id: 'task:\\Ghost\\Update', name: 'GhostUpdate', taskPath: '\\Ghost\\Update', command: `"${missing}" /bg`, source: 'task', scope: 'System', enabled: false },
      { id: 'service:RpcSs', name: 'RPC', serviceName: 'RpcSs', publisher: 'Microsoft Corporation', command: 'C:\\Windows\\System32\\svchost.exe -k rpcss', source: 'service', enabled: true }
    ]
    await asWindows(async () => {
      const scan = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [async () => JSON.stringify({ items, warnings: ['计划任务：拒绝访问'] })]).deps)
        .handleStartupManager('listAll', { mockItems: [{ name: 'fake', command: 'C:\\fake.exe' }] }) as Result & { items: Array<Record<string, unknown>> }
      assert.equal(scan.success, true); assert.equal(scan.totalCount, 2); assert.equal(scan.brokenCount, 1); assert.equal(scan.partial, true)
      assert.deepEqual(scan.items.map(i => [i.name, i.exePath, i.fileMissing]), [['Quark', exe, false], ['GhostUpdate', missing, true]])
      for (const [broken, code] of [[async () => { throw new PowerShellError(124, '') }, 'SCAN_TIMEOUT'], [async () => '{', 'SCAN_FAILED'], [async () => JSON.stringify({ items: null }), 'SCAN_FAILED']] as const) {
        const failed = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [broken]).deps).handleStartupManager('scan', {}) as Result
        assert.equal(failed.success, false); assert.equal(failed.errorCode, code)
      }
    })
  })
})

test('启动项（Windows）：需要管理员权限由 sc.exe 退出码 5 / schtasks 拒绝访问判定，模拟参数无效', async () => {
  await asWindows(async () => {
    const service = { id: 'service:HeavySvc', name: 'Heavy', source: 'service', serviceName: 'HeavySvc', enabled: false, simulateAdminRequired: false }
    const denied = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ 'sc.exe': { stdout: '[SC] ChangeServiceConfig 失败 5:', stderr: '', exitCode: 5 } }).deps).handleStartupManager('setEnabled', service) as Result
    assert.equal(denied.errorCode, 'ADMIN_REQUIRED')
    const other = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ 'sc.exe': fail(1060, '[SC] OpenService 失败 1060') }).deps).handleStartupManager('setEnabled', service) as Result
    assert.equal(other.errorCode, 'SERVICE_UPDATE_FAILED')
    const sys = fakeSystem({ 'sc.exe': ok('[SC] ChangeServiceConfig 成功') })
    const done = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleStartupManager('setEnabled', { ...service, simulateAdminRequired: true }) as Result
    assert.equal(done.success, true); assert.deepEqual(sys.calls, ['sc.exe config HeavySvc start= demand'])
    const task = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ schtasks: fail(1, 'ERROR: Access is denied.') }).deps).handleStartupManager('setEnabled', { name: 'Upd', source: 'task', taskPath: '\\Ghost\\Upd', enabled: true }) as Result
    assert.equal(task.errorCode, 'ADMIN_REQUIRED')
  })
})

// 中文系统 reg.exe 的真实提示：值或键不存在时退出码 1
const REG_NOT_FOUND = fail(1, '错误: 系统找不到指定的注册表项或值。')
const regValue = (key: string, name: string, data: string, type = 'REG_SZ') => ok(`\r\n${key}\r\n    ${name}    ${type}    ${data}\r\n\r\n`)
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_DISABLED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'
const RUN_BASE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion'
// “值不存在”要与系统语言无关地确认：Run 键可读但没有同名值；RunDisabled 键本身不存在（父键子键列表里没有它）
const NOT_IN_RUN = [REG_NOT_FOUND, ok(`\r\n${RUN}\r\n    Other    REG_SZ    C:\\x.exe\r\n`)]
const NOT_IN_DISABLED = [REG_NOT_FOUND, REG_NOT_FOUND, ok(`\r\n${RUN_BASE}\r\n${RUN}\r\n${RUN_BASE}\\Explorer\r\n`)]
const DISABLED_ABSENT_CALLS = (name: string) => [`reg query ${RUN_DISABLED} /v ${name}`, `reg query ${RUN_DISABLED}`, `reg query ${RUN_BASE}`]

test('启动项（Windows）：清理残留先 reg query 再删除，不依赖本地化文本；部分成功返回 ok:true 并带回已清理与失败明细；全部失败带 failed', async () => {
  const gone = path.join(os.tmpdir(), `ztools-missing-${process.pid}`, 'Gone.exe')
  const reg = (name: string, extra: Record<string, unknown> = {}) => ({ id: `reg:HKCU:${name}`, name, source: 'registry', scope: 'HKCU', ...extra })
  await asWindows(async () => {
    // A：只在 Run 存在（RunDisabled 返回中文“找不到”）→ 只删 Run；B：删除被拒绝访问
    const sys = fakeSystem({ reg: [
      regValue(RUN, 'A', `"${gone}" --tray`), ...NOT_IN_DISABLED, ok('操作成功完成。'),
      regValue(RUN, 'B', `"${gone}"`), ...NOT_IN_DISABLED, fail(1, '错误: 拒绝访问。')
    ] })
    const partial = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleStartupManager('removeBroken', { items: [reg('A'), reg('B')] }) as Result & { removedIds: string[]; failed: Array<Record<string, unknown>> }
    assert.equal(partial.ok, true); assert.equal(partial.success, true); assert.equal(partial.partial, true)
    assert.equal(partial.errorCode, 'PARTIAL_FAILED'); assert.match(partial.error!, /^已清理 1 个，1 个未清理：reg:HKCU:B：.*拒绝访问/)
    assert.deepEqual(partial.removedIds, ['reg:HKCU:A']); assert.equal(partial.removedCount, 1)
    assert.deepEqual(partial.failed.map(f => [f.id, f.errorCode]), [['reg:HKCU:B', 'ADMIN_REQUIRED']])
    assert.deepEqual(sys.calls, [
      `reg query ${RUN} /v A`, ...DISABLED_ABSENT_CALLS('A'), `reg delete ${RUN} /v A /f`,
      `reg query ${RUN} /v B`, ...DISABLED_ABSENT_CALLS('B'), `reg delete ${RUN} /v B /f`
    ])

    // 只在 RunDisabled 存在：只删 RunDisabled
    const disabledOnly = fakeSystem({ reg: [...NOT_IN_RUN, regValue(RUN_DISABLED, 'D', gone, 'REG_EXPAND_SZ'), ok()] })
    const d = await new SystemRegistryHostPluginHandler(ctx, disabledOnly.deps).handleStartupManager('removeBroken', { item: reg('D') }) as Result
    assert.equal(d.success, true); assert.deepEqual(d.removedIds, ['reg:HKCU:D'])
    assert.equal(disabledOnly.calls.at(-1), `reg delete ${RUN_DISABLED} /v D /f`)

    // 全部失败：ok:false，同样带 failed，错误文本以错误码开头
    const denied = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ reg: [regValue(RUN, 'B', `"${gone}"`), ...NOT_IN_DISABLED, fail(1, '错误: 拒绝访问。')] }).deps).handleStartupManager('removeBroken', { item: reg('B') }) as Result & { failed: unknown[] }
    assert.equal(denied.ok, false); assert.equal(denied.errorCode, 'ADMIN_REQUIRED'); assert.match(denied.error!, /^ADMIN_REQUIRED: /); assert.equal(denied.removedCount, 0); assert.equal(denied.failed.length, 1)
    const other = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ reg: [regValue(RUN, 'C', `"${gone}"`), ...NOT_IN_DISABLED, fail(1, '错误: 无效的参数。')] }).deps).handleStartupManager('removeBroken', { item: reg('C') }) as Result
    assert.equal(other.errorCode, 'REGISTRY_DELETE_FAILED'); assert.match(other.error!, /^REGISTRY_DELETE_FAILED: /)

    // 查询本身失败（拒绝访问 / 其他退出码）不能当成“值不存在”，也不删除
    for (const [broken, code] of [[fail(1, '错误: 拒绝访问。'), 'ADMIN_REQUIRED'], [fail(124, ''), 'REGISTRY_QUERY_FAILED']] as const) {
      const q = fakeSystem({ reg: [broken] })
      const res = await new SystemRegistryHostPluginHandler(ctx, q.deps).handleStartupManager('removeBroken', { item: reg('Q') }) as Result
      assert.equal(res.errorCode, code); assert.deepEqual(q.calls, [`reg query ${RUN} /v Q`])
    }

    // 两处都不存在：已不在，不调用删除
    // 其他语言系统上的“拒绝访问”提示认不出来：再列出整个键与父键确认，键确实存在就不能当成“不存在”
    const foreign = fakeSystem({ reg: [fail(1, 'FEHLER: Zugriff verweigert'), fail(1, 'FEHLER: Zugriff verweigert'), ok(`\r\n${RUN_BASE}\r\n${RUN}\r\n`)] })
    const foreignRes = await new SystemRegistryHostPluginHandler(ctx, foreign.deps).handleStartupManager('removeBroken', { item: reg('F') }) as Result
    assert.equal(foreignRes.errorCode, 'REGISTRY_QUERY_FAILED'); assert.ok(foreign.calls.every(c => c.startsWith('reg query')), '无法确认时不能删除')
    // 键可读、同名值确实在列表里时同样不当成不存在
    const listed = fakeSystem({ reg: [fail(1, 'FEHLER'), ok(`\r\n${RUN}\r\n    F    REG_SZ    C:\\f.exe\r\n`)] })
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, listed.deps).handleStartupManager('removeBroken', { item: reg('F') }) as Result).errorCode, 'REGISTRY_QUERY_FAILED')

    const absent = fakeSystem({ reg: [...NOT_IN_RUN, ...NOT_IN_DISABLED] })
    const gone2 = await new SystemRegistryHostPluginHandler(ctx, absent.deps).handleStartupManager('removeBroken', { item: reg('E') }) as Result
    assert.equal(gone2.success, true); assert.deepEqual(gone2.alreadyGoneIds, ['reg:HKCU:E']); assert.ok(absent.calls.every(c => c.startsWith('reg query')))

    // 计划任务 / 服务：不删除，不调用任何命令
    const taskSys = fakeSystem({})
    const task = await new SystemRegistryHostPluginHandler(ctx, taskSys.deps).handleStartupManager('removeBroken', { item: { ...reg('T'), id: 'task:\\Ghost', source: 'task' } }) as Result
    assert.equal(task.errorCode, 'UNSUPPORTED_SOURCE'); assert.equal(task.removedCount, 0); assert.deepEqual(taskSys.calls, [])

    // 预览：只做只读核验（reg query），不删除，列出可清理项
    const dry = fakeSystem({ reg: [regValue(RUN, 'A', `"${gone}"`), ...NOT_IN_DISABLED] })
    const preview = await new SystemRegistryHostPluginHandler(ctx, dry.deps).handleStartupManager('removeBroken', { items: [reg('A')], dryRun: true }) as Result
    assert.equal(preview.success, true); assert.equal(preview.dryRun, true); assert.equal(preview.removedCount, 0); assert.deepEqual(preview.removableIds, ['reg:HKCU:A'])
    assert.ok(dry.calls.every(c => c.startsWith('reg query')))

    // 后面的条目标识非法：整批拒绝且一项都不删（先校验再动手）
    const bad = fakeSystem({})
    const rejected = await new SystemRegistryHostPluginHandler(ctx, bad.deps).handleStartupManager('removeBroken', { items: [reg('A'), reg('X;rm')] }) as Result
    assert.equal(rejected.errorCode, 'INVALID_IDENTIFIER'); assert.deepEqual(bad.calls, [])
  })
})

test('启动项（Windows）：宿主自己核验目标程序是否缺失，忽略调用方的 fileMissing / exePath；目标仍在或无法确认都不删除', async () => {
  await withTempFile('Alive.exe', async (alive) => {
    const gone = path.join(os.tmpdir(), `ztools-missing-${process.pid}`, 'Gone.exe')
    await asWindows(async () => {
      // 调用方声称 fileMissing:true 且给了不存在的 exePath，但注册表值指向的程序仍存在：不删除
      const lying = fakeSystem({ reg: [regValue(RUN, 'Quark', `"${alive}" --autorun`), ...NOT_IN_DISABLED] })
      const res = await new SystemRegistryHostPluginHandler(ctx, lying.deps).handleStartupManager('removeBroken', { item: { id: 'reg:HKCU:Quark', name: 'Quark', source: 'registry', fileMissing: true, exePath: gone, command: `"${gone}"` } }) as Result & { failed: Array<Record<string, unknown>> }
      assert.equal(res.ok, false); assert.equal(res.errorCode, 'ITEM_NOT_BROKEN'); assert.match(res.error!, /目标程序仍存在，不是残留/)
      assert.ok(lying.calls.every(c => c.startsWith('reg query')), '目标仍在时不能调用 reg delete')

      // 调用方没传 fileMissing，但宿主确认目标缺失：照常清理
      const silent = fakeSystem({ reg: [regValue(RUN, 'Old', `"${gone}"`), ...NOT_IN_DISABLED, ok()] })
      const cleaned = await new SystemRegistryHostPluginHandler(ctx, silent.deps).handleStartupManager('removeBroken', { item: { id: 'reg:HKCU:Old', name: 'Old', source: 'registry', fileMissing: false } }) as Result
      assert.equal(cleaned.success, true); assert.deepEqual(cleaned.removedIds, ['reg:HKCU:Old'])

      // 命令里没有完整路径（依赖 PATH 查找）、网络位置、空值：无法确认，不删除
      for (const value of ['rundll32.exe shell32.dll,Control_RunDLL', '"\\\\nas\\share\\tool.exe"', '']) {
        const unsure = fakeSystem({ reg: [regValue(RUN, 'U', value), ...NOT_IN_DISABLED] })
        const r = await new SystemRegistryHostPluginHandler(ctx, unsure.deps).handleStartupManager('removeBroken', { item: { id: 'reg:HKCU:U', name: 'U', source: 'registry', fileMissing: true } }) as Result
        assert.equal(r.errorCode, 'CANNOT_VERIFY', `值 ${value} 应无法确认`); assert.ok(unsure.calls.every(c => c.startsWith('reg query')))
      }

      // 一处目标缺失、另一处（同名禁用项）目标仍在：整项不删
      const mixed = fakeSystem({ reg: [regValue(RUN, 'M', `"${gone}"`), regValue(RUN_DISABLED, 'M', `"${alive}"`)] })
      assert.equal((await new SystemRegistryHostPluginHandler(ctx, mixed.deps).handleStartupManager('removeBroken', { item: { id: 'reg:HKCU:M', name: 'M', source: 'registry' } }) as Result).errorCode, 'ITEM_NOT_BROKEN')
      assert.ok(mixed.calls.every(c => c.startsWith('reg query')))
    })
  })
})

test('启动项（Windows）：启动目录只清理目标缺失的快捷方式，目标由宿主解析；程序文件本身、目标仍在、解析失败都不删', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-'))
  const originalAppData = process.env.APPDATA
  try {
    process.env.APPDATA = dir
    const startup = path.join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    await fs.mkdir(startup, { recursive: true })
    const alive = path.join(dir, 'Alive.exe'); await fs.writeFile(alive, 'x')
    const gone = path.join(dir, 'Uninstalled', 'Gone.exe')
    const make = async (name: string) => { const file = path.join(startup, name); await fs.writeFile(file, 'lnk'); return file }
    const item = (file: string) => ({ id: `folder:${file}`, name: path.basename(file), source: 'folder', command: file, fileMissing: true })
    await asWindows(async () => {
      // 目标缺失的快捷方式：删除；文件名里的弯引号在脚本中成对转义
      const ghost = await make('Gh’ost.lnk')
      const sys = fakeSystem({}, [psOut(`TARGET:${gone}\r\n`)])
      const removed = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleStartupManager('removeBroken', { item: item(ghost) }) as Result
      assert.equal(removed.success, true); assert.equal(fsSync.existsSync(ghost), false)
      assert.ok(sys.scripts[0]!.includes('Gh’’ost.lnk'))

      // 目标仍在 / 目标为空 / 解析失败：不删
      for (const [out, code] of [[psOut(`TARGET:${alive}`), 'ITEM_NOT_BROKEN'], [psOut('TARGET:'), 'CANNOT_VERIFY'], [psFail(1, 'CreateShortcut 失败'), 'CANNOT_VERIFY']] as const) {
        const file = await make('Keep.lnk')
        const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [out]).deps).handleStartupManager('removeBroken', { item: item(file) }) as Result
        assert.equal(r.errorCode, code); assert.equal(fsSync.existsSync(file), true)
      }
      // 启动目录里的脚本本身存在：不是残留，不需要解析也不删
      const bat = await make('run.bat')
      const batSys = fakeSystem({})
      assert.equal((await new SystemRegistryHostPluginHandler(ctx, batSys.deps).handleStartupManager('removeBroken', { item: item(bat) }) as Result).errorCode, 'ITEM_NOT_BROKEN')
      assert.equal(fsSync.existsSync(bat), true); assert.deepEqual(batSys.calls, [])
      // 启动目录之外的文件：拒绝
      assert.equal((await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}).deps).handleStartupManager('removeBroken', { item: item(alive) }) as Result).errorCode, 'INVALID_PATH')
      assert.equal(fsSync.existsSync(alive), true)
    })
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('热键侦测（Windows）：占用状态只来自注入的注册探测，模拟探测、模拟进程与模拟占用参数全部无效', async () => {
  await asWindows(async () => {
    const sys = fakeSystem({ tasklist: ok('"WeChat.exe","1234","Console","1","88,000 K"\n"畸形行"') }, [async () => JSON.stringify({ results: [{ combo: 'ALT+A', status: 'occupied' }, { combo: 'CTRL+SHIFT+F12', status: 'free' }] })])
    const params = { combos: ['Alt+A', 'Ctrl+Shift+F12', 'Ctrl+Alt+Del'], mockProbed: [{ keyCombo: 'Alt+A', isOccupied: false }], mockProcesses: [{ name: 'fake.exe', pid: 1 }], mockOccupiedCombos: ['CTRL+SHIFT+F12'] }
    const result = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleHotkeyRadar('probeHotkeys', params) as Result & { results: Array<Record<string, unknown>> }
    assert.equal(result.success, true)
    assert.deepEqual(result.results.map(r => [r.keyCombo, r.probeStatus, r.isOccupied]), [['Alt+A', 'occupied', true], ['Ctrl+Shift+F12', 'free', false], ['Ctrl+Alt+Del', 'reserved', true]])
    assert.deepEqual(sys.calls, ['tasklist /FO CSV /NH', 'powershell'])
    for (const broken of [async () => { throw new PowerShellError(1, 'Add-Type 失败') }, async () => '[]']) {
      const failed = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({ tasklist: fail(1) }, [broken]).deps).handleHotkeyRadar('probe', params) as Result
      assert.equal(failed.success, false); assert.equal(failed.errorCode, 'PROBE_FAILED')
    }
  })
})

test('热键侦测（Windows）：组合键白名单校验，弯引号等非法字符不进入脚本并标为无法检测', async () => {
  await asWindows(async () => {
    const sys = fakeSystem({ tasklist: ok('') }, [psOut(JSON.stringify({ results: [{ combo: 'ALT+A', status: 'free' }] }))])
    const injected = 'Ctrl+’);Start-Process calc;(’'
    const result = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleHotkeyRadar('probe', { combos: ['Alt+A', injected, 'Ctrl+‘A‘', 'Ctrl+Alt+Del'] }) as Result & { results: Array<Record<string, unknown>> }
    assert.equal(result.success, true)
    assert.equal(sys.scripts.length, 1)
    const script = sys.scripts[0]!
    assert.match(script, /\$combos = @\('ALT\+A','CTRL\+ALT\+DEL'\)/)
    assert.doesNotMatch(script, /calc|[‘’]/)
    assert.deepEqual(result.results.map(r => [r.keyCombo, r.probeStatus, Boolean(r.probeNote)]), [['Alt+A', 'free', false], [injected, 'unsupported', true], ['Ctrl+‘A‘', 'unsupported', true], ['Ctrl+Alt+Del', 'reserved', false]])
    // 全部组合键都不合法：不调用 PowerShell
    const none = fakeSystem({ tasklist: ok('') })
    const allBad = await new SystemRegistryHostPluginHandler(ctx, none.deps).handleHotkeyRadar('probe', { combos: [injected] }) as Result & { results: Array<Record<string, unknown>> }
    assert.equal(allBad.success, true); assert.equal(allBad.results[0]!.probeStatus, 'unsupported'); assert.deepEqual(none.scripts, [])
  })
})

test('右键菜单（Windows）：扫描用 -LiteralPath，扫描失败、超时、输出畸形如实报错，不能当成没有菜单项', async () => {
  await asWindows(async () => {
    const entry = { id: 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\MyTool', name: 'MyTool', keyName: 'MyTool', scope: 'file', regPath: 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\MyTool', enabled: true }
    const sys = fakeSystem({}, [psOut(JSON.stringify(entry))])
    const list = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleContextMenu('list', {}) as Result & { items: Array<Record<string, unknown>> }
    assert.equal(list.success, true); assert.deepEqual(list.items.map(i => i.keyPath), [entry.regPath])
    assert.doesNotMatch(sys.scripts[0]!, /-Path \$|Test-Path \$|Join-Path/); assert.match(sys.scripts[0]!, /Get-ChildItem -LiteralPath \$r\.Path/)
    for (const [broken, code] of [[psFail(1, '拒绝访问'), 'SCAN_FAILED'], [psFail(124), 'SCAN_TIMEOUT'], [psOut('{'), 'SCAN_FAILED']] as const) {
      const failed = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [broken]).deps).handleContextMenu('scan', {}) as Result
      assert.equal(failed.success, false); assert.equal(failed.errorCode, code); assert.equal(failed.items, undefined)
    }
  })
})

test('右键菜单（Windows）：启用 / 禁用先判断 LegacyDisable 再改并读回，拒绝访问报 ADMIN_REQUIRED；只允许 shell 下的菜单项且用 -LiteralPath', async () => {
  await asWindows(async () => {
    const key = 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\MyTool'
    const sys = fakeSystem({}, [psOut('OK\r\n')])
    const enabled = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleContextMenu('enable', { regPath: key }) as Result
    assert.equal(enabled.success, true); assert.equal(enabled.enabled, true)
    const script = sys.scripts[0]!
    assert.match(script, /\$wantDisabled = \$false/); assert.match(script, /Remove-ItemProperty -LiteralPath \$p -Name 'LegacyDisable' -ErrorAction Stop/)
    assert.doesNotMatch(script, /-Path '|SilentlyContinue; Write-Output 'OK'/)
    assert.ok(script.includes(`'Registry::${key}'`))
    for (const [out, code] of [[psOut('ACCESS_DENIED'), 'ADMIN_REQUIRED'], [psOut('KEY_NOT_FOUND'), 'ITEM_NOT_FOUND'], [psOut('VERIFY_FAILED'), 'VERIFY_FAILED'], [psOut(''), 'TOGGLE_FAILED'], [psFail(1, 'Set-ItemProperty 失败'), 'TOGGLE_FAILED'], [psFail(124), 'TOGGLE_TIMEOUT']] as const) {
      const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [out]).deps).handleContextMenu('disable', { regPath: key }) as Result
      assert.equal(r.success, false); assert.equal(r.errorCode, code)
    }
    // shell 之外的键（含 HKLM 根、文件类型本身、带通配的路径）一律拒绝，不调用 PowerShell
    for (const bad of ['HKEY_CURRENT_USER\\Software\\Classes\\*', 'HKEY_CURRENT_USER\\Software\\Classes\\txtfile\\shell\\open', 'HKEY_LOCAL_MACHINE\\SYSTEM\\Setup', `${key}\\command`]) {
      const none = fakeSystem({})
      assert.equal((await new SystemRegistryHostPluginHandler(ctx, none.deps).handleContextMenu('toggle', { regPath: bad, enabled: false }) as Result).errorCode, 'INVALID_REG_PATH')
      assert.deepEqual(none.calls, [])
    }
    // 扫描列出的系统级项允许尝试（需要管理员权限时由脚本报告）
    const hklm = fakeSystem({}, [psOut('ACCESS_DENIED')])
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, hklm.deps).handleContextMenu('disable', { regPath: 'HKLM:\\Software\\Classes\\Directory\\shell\\Git' }) as Result).errorCode, 'ADMIN_REQUIRED')
  })
})

test('右键菜单（Windows）：新增菜单键名白名单拒绝弯引号注入，显示名称与命令经转义拼接并读回确认', async () => {
  await asWindows(async () => {
    for (const keyName of ['Open’; Start-Process calc; ’', "It's", '..', 'a'.repeat(65), 'a\\b']) {
      const none = fakeSystem({})
      const r = await new SystemRegistryHostPluginHandler(ctx, none.deps).handleContextMenu('add', { keyName, command: 'C:\\Tools\\tool.exe' }) as Result
      assert.equal(r.errorCode, 'INVALID_KEY_NAME', keyName); assert.deepEqual(none.calls, [])
    }
    const sys = fakeSystem({}, [psOut('OK')])
    const added = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleContextMenu('add', { keyName: 'Open With Tool (2)', displayName: 'It’s 工具', command: '"C:\\Tools\\it’s\\tool.exe" --x', scope: '*' }) as Result
    assert.equal(added.success, true); assert.equal(added.regPath, 'HKCU:\\Software\\Classes\\*\\shell\\Open With Tool (2)')
    const script = sys.scripts[0]!
    assert.ok(script.includes("$display = 'It’’s 工具'")); assert.ok(script.includes(`$command = '"C:\\Tools\\it’’s\\tool.exe" "%1"'`))
    assert.match(script, /CreateSubKey\(\$sub\)/); assert.doesNotMatch(script, /New-Item|-Path '/)
    for (const [out, code] of [[psOut('ACCESS_DENIED'), 'ADMIN_REQUIRED'], [psOut('VERIFY_FAILED'), 'VERIFY_FAILED'], [psOut(''), 'WRITE_FAILED'], [psFail(1, 'CreateSubKey 失败'), 'WRITE_FAILED']] as const) {
      const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [out]).deps).handleContextMenu('add', { keyName: 'Tool', command: 'C:\\Tools\\tool.exe' }) as Result
      assert.equal(r.success, false); assert.equal(r.errorCode, code)
    }
  })
})

test('右键菜单（Windows）：删除只接受 HKCU 下 *、Directory、Directory\\Background、Drive 的 shell\\<项>，用 -LiteralPath 并确认已删除', async () => {
  await asWindows(async () => {
    for (const bad of [
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell',
      'HKEY_CURRENT_USER\\Software\\Classes\\*',
      'HKEY_CURRENT_USER\\Software\\Classes\\txtfile\\shell\\open',
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\MyTool\\command',
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\..',
      'HKEY_LOCAL_MACHINE\\Software\\Classes\\*\\shell\\MyTool',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    ]) {
      const none = fakeSystem({})
      assert.equal((await new SystemRegistryHostPluginHandler(ctx, none.deps).handleContextMenu('delete', { regPath: bad }) as Result).errorCode, 'INVALID_REG_PATH', bad)
      assert.deepEqual(none.calls, [])
    }
    const sys = fakeSystem({}, [psOut('OK')])
    const removed = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleContextMenu('delete', { regPath: 'HKCU:\\Software\\Classes\\*\\shell\\MyTool' }) as Result
    assert.equal(removed.success, true); assert.equal(removed.regPath, 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\MyTool')
    assert.match(sys.scripts[0]!, /Remove-Item -LiteralPath \$p -Recurse/); assert.doesNotMatch(sys.scripts[0]!, /-Path '/)
    // 大小写不敏感
    const lower = fakeSystem({}, [psOut('OK')])
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, lower.deps).handleContextMenu('delete', { regPath: 'hkey_current_user\\software\\classes\\directory\\background\\shell\\Term' }) as Result).success, true)
    for (const [out, code] of [[psOut('ACCESS_DENIED'), 'ADMIN_REQUIRED'], [psOut('KEY_NOT_FOUND'), 'ITEM_NOT_FOUND'], [psOut('VERIFY_FAILED'), 'VERIFY_FAILED'], [psFail(1, 'Remove-Item 失败'), 'DELETE_FAILED']] as const) {
      const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [out]).deps).handleContextMenu('delete', { regPath: 'HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\X' }) as Result
      assert.equal(r.success, false); assert.equal(r.errorCode, code)
    }
  })
})

test('清空回收站（Windows）：只有本来为空或清空后确认为空才算成功，其他错误如实返回', async () => {
  await asWindows(async () => {
    const sys = fakeSystem({}, [psOut('OK')])
    const done = await new SystemRegistryHostPluginHandler(ctx, sys.deps).handleSystemActions('emptyRecycleBin', {}) as Result
    assert.equal(done.success, true)
    assert.match(sys.scripts[0]!, /Clear-RecycleBin -Force -ErrorAction Stop/); assert.doesNotMatch(sys.scripts[0]!, /SilentlyContinue/)
    const empty = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psOut('ALREADY_EMPTY')]).deps).handleSystemActions('execute', { action: 'emptyTrash' }) as Result
    assert.equal(empty.success, true); assert.equal(empty.alreadyEmpty, true)
    for (const [out, code, pattern] of [
      [psOut('CLEAR_FAILED:另一个程序正在使用此文件'), 'EMPTY_TRASH_FAILED', /另一个程序正在使用此文件/],
      [psOut('REMAINING:3'), 'EMPTY_TRASH_INCOMPLETE', /3 个项目/],
      [psOut(''), 'EMPTY_TRASH_FAILED', /未得到确认|输出/],
      [psFail(1, '无法创建 Shell.Application'), 'EMPTY_TRASH_FAILED', /Shell\.Application/],
      [psFail(124), 'EMPTY_TRASH_TIMEOUT', /超时/]
    ] as const) {
      const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [out]).deps).handleSystemActions('emptyTrash', {}) as Result
      assert.equal(r.success, false); assert.equal(r.errorCode, code); assert.match(r.error!, pattern)
    }
  })
})

test('移入回收站（Windows）：没有回收站的位置、回收站关闭或超过容量时拒绝并保留原文件，绝不静默永久删除', async () => {
  await withTempFile('report.docx', async (file, dir) => {
    await asWindows(async () => {
      const tasklistAlive = ok('"WINWORD.EXE","501","Console","1","88,000 K"')
      const tasklistGone = ok('信息: 没有运行的任务匹配指定标准。')
      const unlock = (target: string, ps: Array<(script: string) => Promise<string>>) => {
        const sys = fakeSystem({ tasklist: [tasklistAlive, tasklistGone] }, ps, { killProcess: () => undefined })
        return { sys, run: () => new SystemRegistryHostPluginHandler(ctx, sys.deps).handleFileUnlock('unlockPath', { pid: 501, expectedName: 'WINWORD.EXE', targetPath: target, trashAfterUnlock: true }) as Promise<Result> }
      }
      // 脚本先确认本地固定卷、回收站策略与容量，再移入回收站
      const okRun = unlock(file, [async () => { await fs.rm(file); return 'TRASH_OK' }])
      assert.equal((await okRun.run()).trashed, true)
      const script = okRun.sys.scripts[0]!
      assert.match(script, /DriveType -ne \[System\.IO\.DriveType\]::Fixed/); assert.match(script, /NukeOnDelete/); assert.match(script, /NoRecycleFiles/); assert.match(script, /MaxCapacity/)
      assert.ok(script.indexOf('TRASH_TOO_LARGE') < script.indexOf('SendToRecycleBin'), '容量检查必须在删除之前')
      // 路径经过目录联接 / 挂载的卷 / 符号链接时，按盘符做的检查不成立：先于删除拒绝
      assert.match(script, /LinkType/); assert.ok(script.indexOf('TRASH_UNSUPPORTED:REPARSE') < script.indexOf('SendToRecycleBin'))
      await fs.writeFile(file, 'x')

      for (const [out, trashCode, pattern] of [
        ['TRASH_UNSUPPORTED:Removable', 'TRASH_UNSUPPORTED', /可移动磁盘/],
        ['TRASH_UNSUPPORTED:Network', 'TRASH_UNSUPPORTED', /网络驱动器/],
        ['TRASH_UNSUPPORTED:NUKE_ON_DELETE', 'TRASH_UNSUPPORTED', /不将文件移到回收站/],
        ['TRASH_UNSUPPORTED:POLICY', 'TRASH_UNSUPPORTED', /组策略/],
        ['TRASH_UNSUPPORTED:REPARSE', 'TRASH_UNSUPPORTED', /目录联接、挂载的卷或符号链接/],
        ['TRASH_TOO_LARGE:1073741824:52428800', 'TRASH_TOO_LARGE', /超过该磁盘回收站上限/]
      ] as const) {
        const r = await unlock(file, [psOut(out)]).run()
        assert.equal(r.errorCode, 'TRASH_FAILED'); assert.equal(r.trashErrorCode, trashCode); assert.match(r.error!, pattern); assert.match(r.error!, /原文件保留/)
        assert.equal(r.unlocked, true); assert.equal(fsSync.existsSync(file), true)
      }

      // UNC 路径：不调用 PowerShell 直接拒绝
      const unc = unlock('\\\\nas\\share\\report.docx', [])
      const uncRes = await unc.run()
      assert.equal(uncRes.trashErrorCode, 'TRASH_UNSUPPORTED'); assert.ok(!unc.sys.calls.includes('powershell'))

      // 软件管理移除残余目录同样走这里，错误码透传
      const appDir = path.join(dir, 'LeftoverApp'); await fs.mkdir(appDir)
      const sm = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psOut('TRASH_UNSUPPORTED:Removable')]).deps).handleSoftwareManager('uninstall', { installLocation: appDir }) as Result
      assert.equal(sm.success, false); assert.equal(sm.errorCode, 'TRASH_UNSUPPORTED'); assert.equal(fsSync.existsSync(appDir), true)
      const smUnconfirmed = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psOut('TRASH_OK')]).deps).handleSoftwareManager('uninstall', { installLocation: appDir }) as Result
      assert.equal(smUnconfirmed.errorCode, 'TRASH_FAILED'); assert.equal(fsSync.existsSync(appDir), true)
    })
  })
})

test('微信多开、软件列表、内存加速、窗口与音量旧接口（Windows）：允许静默失败的命令不再让脚本整体报错，真正的失败如实返回', async () => {
  await asWindows(async () => {
    // 微信：安装路径键不存在时脚本显式 exit 0；进程列表存变量后单独输出
    const wx = fakeSystem({}, [psOut(''), psOut('[{"pid":100,"name":"WeChat","memoryMB":12.5}]')])
    const status = await new SystemRegistryHostPluginHandler(ctx, wx.deps).handleWeChatMulti('getStatus', {}) as Result & { instances: unknown[] }
    assert.equal(status.success, true); assert.equal(status.runningCount, 1); assert.equal(status.installed, false); assert.equal(status.partial, undefined)
    assert.match(wx.scripts[0]!, /exit 0/); assert.match(wx.scripts[0]!, /-LiteralPath 'HKCU:\\Software\\Tencent\\WeChat'/)
    assert.match(wx.scripts[1]!, /\$procs = @\(Get-Process -Name 'WeChat','Weixin' -ErrorAction SilentlyContinue\)/); assert.match(wx.scripts[1]!, /ConvertTo-Json -InputObject \$list/)
    // 读取安装路径失败：不当成“未安装”，带说明
    const regBroken = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psFail(124), psOut('[]')]).deps).handleWeChatMulti('getStatus', {}) as Result
    assert.equal(regBroken.success, true); assert.equal(regBroken.partial, true); assert.match(String(regBroken.warning), /读取微信安装路径失败/)
    const launch = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psFail(1, '注册表读取失败')]).deps).handleWeChatMulti('launch', {}) as Result
    assert.equal(launch.errorCode, 'WECHAT_NOT_FOUND'); assert.match(launch.error!, /注册表读取失败/)
    for (const [broken, code] of [[psFail(1, 'Get-Process 异常'), 'DETECT_FAILED'], [psFail(124), 'DETECT_TIMEOUT'], [psOut('not json'), 'DETECT_FAILED']] as const) {
      const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psOut(''), broken]).deps).handleWeChatMulti('getStatus', {}) as Result
      assert.equal(r.success, false); assert.equal(r.errorCode, code); assert.equal(r.runningCount, undefined)
    }

    // 软件列表：损坏的卸载项不再让整个列表失败；真正失败如实报错，不退回桌面快捷方式
    const sw = fakeSystem({}, [psOut(JSON.stringify([{ DisplayName: '7-Zip', DisplayVersion: '23.01', UninstallString: 'C:\\7z\\uninst.exe', PSChildName: '7-Zip' }]))])
    const apps = await new SystemRegistryHostPluginHandler(ctx, sw.deps).handleSoftwareManager('list', {}) as Result & { apps: Array<Record<string, unknown>> }
    assert.equal(apps.success, true); assert.deepEqual(apps.apps.map(a => a.name), ['7-Zip'])
    assert.match(sw.scripts[0]!, /\$list = @\(Get-ItemProperty -Path \$paths/); assert.match(sw.scripts[0]!, /ConvertTo-Json -InputObject \$list -Compress/)
    for (const [broken, code] of [[psFail(1, '读取失败'), 'SCAN_FAILED'], [psFail(124), 'SCAN_TIMEOUT'], [psOut('{'), 'SCAN_FAILED']] as const) {
      const r = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [broken]).deps).handleSoftwareManager('getInstalledApps', {}) as Result
      assert.equal(r.success, false); assert.equal(r.errorCode, code); assert.equal(r.apps, undefined)
    }

    // 内存加速：进程排行读取失败时内存数字照常返回，但标记 partial 并说明
    const boost = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psFail(1, 'Get-Process 异常')]).deps).handleBoost('getStatus', {}) as Result & { topProcesses: unknown[] }
    assert.equal(boost.success, true); assert.equal(boost.partial, true); assert.match(String(boost.warning), /进程内存排行/); assert.deepEqual(boost.topProcesses, [])

    // 窗口列表与窗口操作、音量键：失败如实返回，不再固定输出 OK
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psFail(1, '异常')]).deps).handleWindowManagement('listWindows', {}) as Result).errorCode, 'LIST_FAILED')
    const noWindow = await new SystemRegistryHostPluginHandler(ctx, fakeSystem({}, [psOut('ERR_NO_WINDOW')]).deps).handleWindowManagement('maximize', {}) as Result
    assert.equal(noWindow.errorCode, 'NO_WINDOW')
    const actionSys = fakeSystem({}, [psFail(1, 'Add-Type 失败')])
    assert.equal((await new SystemRegistryHostPluginHandler(ctx, actionSys.deps).handleWindowManagement('minimize', {}) as Result).errorCode, 'WINDOW_ACTION_FAILED')
    assert.match(actionSys.scripts[0]!, /\$ErrorActionPreference = 'Stop'/)
    const volSys = fakeSystem({}, [psFail(1, 'SendKeys 失败')])
    const vol = await new SystemRegistryHostPluginHandler(ctx, volSys.deps).handleSystemActions('toggleMute', {}) as Result
    assert.equal(vol.success, false); assert.equal(vol.errorCode, 'ACTION_FAILED'); assert.match(volSys.scripts[0]!, /\$ErrorActionPreference = 'Stop'/)
  })
})

test('显示器、防休眠与环境变量旧接口：模拟参数不能再伪造显示器列表、失败或管理员拦截', async () => {
  await asWindows(async () => {
    const h = new SystemRegistryHostPluginHandler(ctx, fakeSystem({}).deps)
    const list = await h.handleMonitorControl('listDisplays', { mockDisplays: [{ id: 'fake', brightness: 70 }] }) as Result
    assert.equal(list.errorCode, 'UNSUPPORTED_ACTION'); assert.equal(list.displays, undefined)
    // 预览只校验参数，simulateUnsupported 不再触发失败；真实调节要求新版接口
    assert.equal((await h.handleMonitorControl('setBrightness', { id: 'd1', brightness: 140, dryRun: true, simulateUnsupported: true }) as Result).brightness, 100)
    assert.equal((await h.handleMonitorControl('setBrightness', { id: 'd1', protocol: 'unsupported', brightness: 50, dryRun: true }) as Result).errorCode, 'DDC_UNSUPPORTED')
    assert.equal((await h.handleMonitorControl('setBrightness', { id: 'd1', brightness: 50 }) as Result).errorCode, 'UNSUPPORTED_ACTION')
    const caffeine = await h.handleCaffeine('start', { durationMinutes: 5, dryRun: true, simulateFailure: true }) as Result
    assert.equal(caffeine.success, true); assert.equal(caffeine.active, true)
    await h.stop()
    // 旧接口写系统级变量从不落盘：一律要求新版接口，不再依赖 simulateNoAdmin
    for (const params of [{ key: 'A', value: '1', scope: 'system' }, { key: 'A', value: '1', scope: 'system', simulateNoAdmin: false }]) {
      assert.equal((await h.handleEnvManager('write', params) as Result).errorCode, 'UNSUPPORTED_ACTION')
    }
    assert.equal((await h.handleEnvManager('write', { key: 'A', value: '1', scope: 'system', dryRun: true }) as Result).success, true)
  })
})

test('环境变量旧接口：读取、清理、写入的真实分支一律要求新版接口，调用方的 customEnv / rawPath / persistRegistry 不再被采用', async () => {
  for (const run of [asWindows, async <T>(work: () => Promise<T>) => work()]) {
    await run(async () => {
      const sys = fakeSystem({ reg: ok('操作成功完成。') })
      const h = new SystemRegistryHostPluginHandler(ctx, sys.deps)
      const customEnv = { PATH: 'C:\\Fake\\bin;C:\\Dead\\bin', FAKE_VAR: 'x' }
      for (const [fn, params] of [
        ['load', { customEnv }],
        ['loadAllEnvVariables', {}],
        ['cleanInvalid', { rawPath: 'C:\\Dead\\bin', customEnv }],
        ['cleanInvalidPathEntries', {}],
        ['write', { key: 'B', value: '2', scope: 'user' }],
        ['write', { key: 'B', value: '2', scope: 'user', persistRegistry: false }],
        ['writeEnvVariable', { key: 'B', value: '2', scope: 'user', customEnv }]
      ] as const) {
        const result = await h.handleEnvManager(fn, params) as Result
        assert.equal(result.success, false, `${fn} 不能报告成功`); assert.equal(result.errorCode, 'UNSUPPORTED_ACTION')
        assert.match(result.error!, /请更新环境变量插件/)
        // 不能再回传调用方伪造的数据或“已清理”数量
        assert.equal(result.items, undefined); assert.equal(result.removedCount, undefined); assert.equal(result.cleanedPath, undefined)
      }
      // 真实分支不再写注册表（之前 persistRegistry:false 时不写却报成功）
      assert.deepEqual(sys.calls, [])
      // 预览只校验参数，并明确标记为预览
      const preview = await h.handleEnvManager('write', { key: 'B', value: '2', dryRun: true }) as Result
      assert.equal(preview.success, true); assert.equal(preview.dryRun, true)
      assert.equal((await h.handleEnvManager('write', { key: ' ', value: '2', dryRun: true }) as Result).errorCode, 'INVALID_ENV_KEY')
      assert.equal((await h.handleEnvManager('write', { key: 'PATH', value: 'x'.repeat(2049), dryRun: true }) as Result).errorCode, 'PATH_TOO_LONG')
      assert.equal((await h.handleEnvManager('exportAll', {}) as Result).errorCode, 'UNSUPPORTED_ACTION')
    })
  }
})

test('最近项目旧接口：扫描与打开一律要求新版接口，调用方传入的项目列表不再原样返回', async () => {
  await withTempFile('README.md', async (_file, dir) => {
    for (const run of [asWindows, async <T>(work: () => Promise<T>) => work()]) {
      await run(async () => {
        const h = new SystemRegistryHostPluginHandler(ctx, fakeSystem({}).deps)
        for (const [fn, params] of [
          ['scan', { rawEntries: [{ name: 'fake', path: dir, editorType: 'vscode' }] }],
          ['scanAllRecentProjects', {}],
          ['launch', { path: dir, editorType: 'vscode' }],
          ['launchProject', { path: dir }]
        ] as const) {
          const result = await h.handleVscodeProjects(fn, params) as Result
          assert.equal(result.success, false); assert.equal(result.errorCode, 'UNSUPPORTED_ACTION')
          assert.match(result.error!, /请更新最近项目插件/)
          assert.equal(result.projects, undefined)
        }
        assert.equal((await h.handleVscodeProjects('other', {}) as Result).errorCode, 'UNSUPPORTED_ACTION')
      })
    }
  })
})

/** 可控的保持进程替身：测试决定何时创建成功、报错、输出就绪或退出 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  unrefed = false
  kill(): boolean { this.killed = true; queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); return true }
  unref(): void { this.unrefed = true }
}
function fakeSpawn(onSpawn: (child: FakeChild) => void) {
  const spawned: Array<{ command: string; args: string[]; child: FakeChild }> = []
  const spawnProcess = ((command: string, args: string[]) => {
    const child = new FakeChild()
    spawned.push({ command, args, child })
    queueMicrotask(() => onSpawn(child))
    return child
  }) as unknown as SystemRegistryHostDeps['spawnProcess']
  const at = (i: number) => { const entry = spawned[i]; if (!entry) throw new Error(`第 ${i + 1} 个进程未启动`); return entry }
  return { spawned, spawnProcess, at }
}
async function asPlatform<T>(platform: NodeJS.Platform, work: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try { return await work() } finally { Object.defineProperty(process, 'platform', original) }
}

test('防休眠：保持进程无法创建、就绪前退出或同步抛错都如实失败，不能报告已激活', async () => {
  await asPlatform('darwin', async () => {
    const missing = fakeSpawn((c) => c.emit('error', Object.assign(new Error('spawn caffeinate ENOENT'), { code: 'ENOENT' })))
    const h = new SystemRegistryHostPluginHandler(ctx, { ...fakeSystem({}).deps, spawnProcess: missing.spawnProcess })
    const failed = await h.handleCaffeine('start', { durationMinutes: 30 }) as Result
    assert.equal(failed.success, false); assert.equal(failed.errorCode, 'KEEP_AWAKE_START_FAILED'); assert.match(failed.error!, /ENOENT/)
    assert.equal((await h.handleCaffeine('getStatus', {}) as Result).active, false)
    // toggle 同样不能把失败当成已开启
    assert.equal((await h.handleCaffeine('toggle', {}) as Result).errorCode, 'KEEP_AWAKE_START_FAILED')
    assert.equal((await h.handleCaffeine('status', {}) as Result).active, false)

    const throwing = new SystemRegistryHostPluginHandler(ctx, { spawnProcess: (() => { throw new Error('EMFILE: too many open files') }) as unknown as SystemRegistryHostDeps['spawnProcess'] })
    const thrown = await throwing.handleCaffeine('start', {}) as Result
    assert.equal(thrown.errorCode, 'KEEP_AWAKE_START_FAILED'); assert.match(thrown.error!, /EMFILE/)
    assert.equal((await throwing.handleCaffeine('getStatus', {}) as Result).active, false)
  })
  await asPlatform('win32', async () => {
    // PowerShell 在就绪前报错退出（例如 Add-Type 被策略拦截）
    const broken = fakeSpawn((c) => { c.emit('spawn'); c.stderr.emit('data', Buffer.from('Add-Type : 无法编译类型')); c.emit('exit', 1, null) })
    const h = new SystemRegistryHostPluginHandler(ctx, { ...fakeSystem({}).deps, spawnProcess: broken.spawnProcess })
    const failed = await h.handleCaffeine('start', { mode: 'system' }) as Result
    assert.equal(failed.errorCode, 'KEEP_AWAKE_START_FAILED'); assert.match(failed.error!, /无法编译类型/)
    assert.equal((await h.handleCaffeine('getStatus', {}) as Result).active, false)
  })
  // 无保持进程实现的平台不再假装激活
  await asPlatform('linux', async () => {
    const never = fakeSpawn(() => { throw new Error('不应启动进程') })
    const result = await new SystemRegistryHostPluginHandler(ctx, { spawnProcess: never.spawnProcess }).handleCaffeine('start', {}) as Result
    assert.equal(result.errorCode, 'UNSUPPORTED_PLATFORM'); assert.equal(never.spawned.length, 0)
  })
})

test('防休眠：确认保持进程生效后才激活，进程意外退出后状态如实变为未激活；停止时结束进程', async () => {
  await asPlatform('win32', async () => {
    const ready = fakeSpawn((c) => { c.emit('spawn'); c.stdout.emit('data', Buffer.from('ZTOOLS_KEEP_AWAKE_READY\r\n')) })
    const sys = fakeSystem({})
    const h = new SystemRegistryHostPluginHandler(ctx, { ...sys.deps, spawnProcess: ready.spawnProcess })
    const started = await h.handleCaffeine('start', { durationMinutes: 0, mode: 'display' }) as Result
    assert.equal(started.success, true); assert.equal(started.active, true); assert.equal(started.mode, 'display')
    assert.equal(ready.at(0).command, 'powershell.exe'); assert.ok(ready.at(0).args.includes('-EncodedCommand'))
    const script = Buffer.from(ready.at(0).args.at(-1)!, 'base64').toString('utf16le')
    assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483651\)/); assert.doesNotMatch(script, /0x8000000/); assert.match(script, /\$ErrorActionPreference = 'Stop'/)
    assert.equal(ready.at(0).child.unrefed, true)
    // 保持进程被外部结束：会话失效
    ready.at(0).child.emit('exit', 1, null)
    assert.equal((await h.handleCaffeine('getStatus', {}) as Result).active, false)
    // 再次启动后停止：结束保持进程
    await h.handleCaffeine('start', { mode: 'system' })
    const stopped = await h.handleCaffeine('stop', {}) as Result
    assert.equal(stopped.active, false); assert.equal(ready.at(1).child.killed, true)
    // 停止只结束保持进程，不再另起 PowerShell（那次调用对保持进程无效，失败还会让停止整体抛错）
    assert.deepEqual(sys.calls, [])
  })
  await asPlatform('darwin', async () => {
    const ok = fakeSpawn((c) => c.emit('spawn'))
    const h = new SystemRegistryHostPluginHandler(ctx, { spawnProcess: ok.spawnProcess })
    const started = await h.handleCaffeine('start', { durationMinutes: 15, mode: 'system' }) as Result
    assert.equal(started.active, true); assert.deepEqual([ok.at(0).command, ok.at(0).args], ['caffeinate', ['-i']])
    assert.ok(typeof started.expiresAtMs === 'number')
    await h.stop()
    assert.equal(ok.at(0).child.killed, true)
  })
})

test('防休眠：等待保持进程就绪期间被取消或被停止，结束本次进程且不覆盖会话', async () => {
  await asPlatform('darwin', async () => {
    // 取消信号：未创建成功前中止
    const pending = fakeSpawn(() => undefined)
    const h = new SystemRegistryHostPluginHandler(ctx, { spawnProcess: pending.spawnProcess })
    const controller = new AbortController()
    const starting = h.handleCaffeine('start', {}, controller.signal)
    controller.abort()
    const cancelled = await starting as Result
    assert.equal(cancelled.errorCode, 'CANCELLED'); assert.equal(pending.at(0).child.killed, true)
    assert.equal((await h.handleCaffeine('getStatus', {}) as Result).active, false)

    // 启动等待期间用户点了停止：进程晚到的成功不能把会话重新激活
    let release: (() => void) | undefined
    const late = fakeSpawn((c) => { release = () => c.emit('spawn') })
    const h2 = new SystemRegistryHostPluginHandler(ctx, { spawnProcess: late.spawnProcess })
    const start = h2.handleCaffeine('start', {})
    await new Promise((r) => setImmediate(r))
    await h2.handleCaffeine('stop', {})
    release!()
    const superseded = await start as Result
    assert.equal(superseded.errorCode, 'KEEP_AWAKE_SUPERSEDED'); assert.equal(late.at(0).child.killed, true)
    assert.equal((await h2.handleCaffeine('getStatus', {}) as Result).active, false)
  })
})
