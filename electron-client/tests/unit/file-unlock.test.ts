import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { build as buildPlist } from 'plist'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { type FileLockSnapshot } from '../../src/contracts/file-unlock.js'
import { FileUnlockService } from '../../src/main/services/file-unlock-service.js'
import { MacFileLocks, parseLsofRecords, runLockCommand } from '../../src/main/services/mac-file-locks.js'
import { NativePathAccessAdapter } from '../../src/main/platform/native-path-access.js'
import { ProcessTerminator } from '../../src/main/services/process-terminator.js'
import { MacosProcessDiscoveryAdapter } from '../../src/main/platform/macos/process-discovery.js'

const mac = process.platform === 'darwin', signal = () => new AbortController().signal
const broker = path.resolve(__dirname, '../../../out/native/darwin-universal/path-access/native/ZToolsPathAccessBroker')
const caller: CallerIdentity = { type: 'plugin', webContentsId: 50, pluginId: 'file-unlock', pluginInstanceId: 'unlock-test' }
const discovery = new MacosProcessDiscoveryAdapter()
const terminator = new ProcessTerminator({ platform: 'darwin', snapshot: async s => (await discovery.list(s)).map(p => ({ pid: p.pid, ppid: p.parentPid, name: p.name, zombie: p.zombie })) })
const processes = { terminatePid: terminator.terminate.bind(terminator) }
async function fixture(t: { after: (fn: () => Promise<void>) => void }, locks = new MacFileLocks(), protect = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-unlock-test-')))
  const file = path.join(root, '占用 换行\nfile.txt'); await fs.writeFile(file, '独立测试原文件')
  const service = new FileUnlockService(async file => path.resolve(file), () => new NativePathAccessAdapter(broker, 10000), processes, locks, protect ? [root] : [])
  t.after(async () => { await service.stop(); await fs.rm(root, { recursive: true, force: true }) })
  const call = (request: unknown, who = caller, abort = signal()) => service.handle(request, who, abort)
  const inspect = async (targetPath = file) => await call({ action: 'inspect', targetPath }) as FileLockSnapshot
  return { root, file, service, call, inspect }
}
async function holder(t: { after: (fn: () => Promise<void>) => void }, file: string, ignoreTerm = false) {
  const child = spawn('/bin/sh', ['-c', `${ignoreTerm ? "trap '' TERM; " : ''}exec 3<"$1"; printf ready; read line`, '--', file], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  await once(child.stdout, 'data')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  return child
}
test('文件解锁 IPC 严格拒绝伪造状态、跨用途参数和畸形输入', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  validateMethodParams('file_unlock', { action: 'terminate', sessionId, pids: [50], mode: 'graceful' })
  for (const input of [null, { action: ['inspect'] }, { action: 'inspect', targetPath: '/tmp/a', mockProcesses: [] }, { action: 'inspect', targetPath: '/tmp/../x' },
    { action: 'rename', sessionId, name: '../x' }, { action: 'terminate', sessionId, pids: [0], mode: 'graceful' }, { action: 'terminate', sessionId, pids: [50, 50], mode: 'force' },
    { action: 'terminate', sessionId, pids: [50], mode: ['force'] }, { action: 'trash', sessionId, dryRun: true }]) assert.throws(() => validateMethodParams('file_unlock', input))
})
test('lsof NUL 记录解析不误拆文件名，并拒绝部分和重复进程记录', () => {
  assert.deepEqual(parseLsofRecords('p42\0c程序\0u501\0\nf3\0tREG\0n/a b\\nname\0\n'), [{ pid: 42, name: '程序', uid: 501, paths: ['/a b\\nname'] }])
  for (const value of ['p42\0c程序\0u501\0\nf3\0', 'p42\0c程序\0u501\0\nf3\0tREG\0n/a\0\np42\0', 'warning!', 'p0\0']) assert.throws(() => parseLsofRecords(value))
})
test('外接磁盘枚举保留 APFS 合成卷挂载点，空磁盘列表和工具失败分别报告', { skip: !mac }, async () => {
  const locks = new MacFileLocks(async (file, args) => {
    assert.equal(file, '/usr/sbin/diskutil'); assert.deepEqual(args, ['list', '-plist', 'external'])
    return { code: 0, stdout: buildPlist({ AllDisksAndPartitions: [{ Content: 'Apple_APFS_Container', DeviceIdentifier: 'disk-fixture', APFSVolumes: [{ MountPoint: '/Volumes/Fixture', VolumeName: 'APFS Fixture' }] }] }) }
  })
  assert.deepEqual(await locks.drives(signal()), [{ path: '/Volumes/Fixture', label: 'APFS Fixture' }])
  const empty = new MacFileLocks(async () => ({ code: 0, stdout: buildPlist({ AllDisksAndPartitions: [] }) }))
  assert.deepEqual(await empty.drives(signal()), [])
  const unavailable = new MacFileLocks(async () => { throw new Error('diskutil unavailable') })
  await assert.rejects(unavailable.drives(signal()), /unavailable/)
  const actual = await new MacFileLocks().drives(signal()); assert.ok(Array.isArray(actual))
})
test('真实文件占用、身份复核、正常结束、重新扫描和不覆盖改名完整链路', { skip: !mac }, async t => {
  const f = await fixture(t), child = await holder(t, f.file), before = await f.inspect()
  const row = before.processes.find(p => p.pid === child.pid)
  assert.ok(row); assert.equal(row.protected, false); assert.ok(row.paths.some(p => p.includes('\\nfile.txt')))
  assert.equal(before.processes.length, 1, '固定目标的自有 broker 不能冒充占用进程')
  await assert.rejects(f.call({ action: 'terminate', sessionId: before.sessionId, pids: [child.pid], mode: 'graceful' }, { ...caller, pluginInstanceId: 'another' }), /过期/)
  const ended = await f.call({ action: 'terminate', sessionId: before.sessionId, pids: [child.pid], mode: 'graceful' }) as { success: boolean; terminated: number[]; snapshot: FileLockSnapshot }
  assert.equal(ended.success, true); assert.deepEqual(ended.terminated, [child.pid]); assert.equal(ended.snapshot.processes.length, 0)
  assert.throws(() => process.kill(child.pid!, 0))
  const result = await f.call({ action: 'rename', sessionId: before.sessionId, name: '新名称.txt' }) as { status: string; targetPath: string }
  assert.equal(result.status, 'renamed'); assert.equal(await fs.readFile(result.targetPath, 'utf8'), '独立测试原文件'); await assert.rejects(fs.access(f.file))
})
test('文件夹递归检测真实子文件占用，目标已有同名目录时不覆盖内容', { skip: !mac }, async t => {
  const f = await fixture(t), directory = path.join(f.root, 'source'), destination = path.join(f.root, 'destination')
  await fs.mkdir(path.join(directory, 'nested'), { recursive: true }); await fs.mkdir(destination)
  const inside = path.join(directory, 'nested', 'held.txt'); await fs.writeFile(inside, 'source content'); await fs.writeFile(path.join(destination, 'keep'), 'existing')
  const child = await holder(t, inside), snapshot = await f.inspect(directory)
  assert.ok(snapshot.processes.some(p => p.pid === child.pid))
  await assert.rejects(f.call({ action: 'rename', sessionId: snapshot.sessionId, name: 'destination' }), /占用/)
  const exited = once(child, 'exit'); child.stdin.end(); await exited
  const fresh = await f.inspect(directory)
  await assert.rejects(f.call({ action: 'rename', sessionId: fresh.sessionId, name: 'destination' }))
  assert.equal(await fs.readFile(inside, 'utf8'), 'source content'); assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'existing')
  const retry = await f.inspect(directory)
  await f.call({ action: 'rename', sessionId: retry.sessionId, name: 'renamed' })
  assert.equal(await fs.readFile(path.join(f.root, 'renamed', 'nested', 'held.txt'), 'utf8'), 'source content')
})
test('正常结束超时不升级强制，用户另选强制结束后才退出', { skip: !mac }, async t => {
  const f = await fixture(t), child = await holder(t, f.file, true), snapshot = await f.inspect()
  const result = await f.call({ action: 'terminate', sessionId: snapshot.sessionId, pids: [child.pid], mode: 'graceful' }) as { success: boolean; terminated: number[]; failures: unknown[] }
  assert.equal(result.success, false); assert.equal(result.terminated.length, 0); assert.equal(result.failures.length, 1); process.kill(child.pid!, 0)
  const forced = await f.call({ action: 'terminate', sessionId: snapshot.sessionId, pids: [child.pid], mode: 'force' }) as { success: boolean }
  assert.equal(forced.success, true); assert.throws(() => process.kill(child.pid!, 0)); assert.equal(await fs.readFile(f.file, 'utf8'), '独立测试原文件')
})
test('同 PID 的启动身份变化时拒绝发信号，真实测试进程和文件仍保留', { skip: !mac }, async t => {
  const locks = new MacFileLocks(), f = await fixture(t, locks), child = await holder(t, f.file), snapshot = await f.inspect()
  const originalIdentity = locks.identity.bind(locks)
  locks.identity = async (pid, s) => { const identity = await originalIdentity(pid, s); return identity && pid === child.pid ? { ...identity, started: 'different start time' } : identity }
  const result = await f.call({ action: 'terminate', sessionId: snapshot.sessionId, pids: [child.pid], mode: 'force' }) as { success: boolean; failures: Array<{ message: string }> }
  assert.equal(result.success, false); assert.match(result.failures[0]!.message, /身份|占用/); process.kill(child.pid!, 0)
  assert.equal(await fs.readFile(f.file, 'utf8'), '独立测试原文件')
})
test('目标被替换或是链接时拒绝操作，新旧文件都保留', { skip: !mac }, async t => {
  const f = await fixture(t), snapshot = await f.inspect(), original = path.join(f.root, 'original')
  await fs.rename(f.file, original); await fs.writeFile(f.file, 'replacement')
  await assert.rejects(f.call({ action: 'trash', sessionId: snapshot.sessionId }), /替换/)
  assert.equal(await fs.readFile(original, 'utf8'), '独立测试原文件'); assert.equal(await fs.readFile(f.file, 'utf8'), 'replacement')
  const link = path.join(f.root, 'link'); await fs.symlink(f.file, link); await assert.rejects(f.inspect(link), /链接/)
  const hard = path.join(f.root, 'hard'); await fs.link(f.file, hard); await assert.rejects(f.inspect(hard), /链接/)
})
test('保护根目录允许检测，但拒绝改名或回收', { skip: !mac }, async t => {
  const f = await fixture(t, new MacFileLocks(), true), snapshot = await f.inspect()
  assert.match(snapshot.mutationBlockedReason, /数据目录/)
  await assert.rejects(f.call({ action: 'trash', sessionId: snapshot.sessionId }), /数据目录/)
  assert.equal(await fs.readFile(f.file, 'utf8'), '独立测试原文件')
})
test('扫描失败、超时、输出不完整绝不当成无占用；取消等待自有子进程结束', { skip: !mac }, async t => {
  let blocked = false
  const locks = new MacFileLocks(async (file, args, s, empty) => {
    if (file.endsWith('lsof')) { blocked = true; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('已取消测试扫描')), { once: true })) }
    return runLockCommand(file, args, s, empty)
  })
  const f = await fixture(t, locks), pending = f.inspect()
  const rejected = assert.rejects(pending, /取消/)
  while (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
  await assert.rejects(f.inspect(), /正在操作/)
  await f.call({ action: 'cancel' }); await rejected
  assert.equal(await fs.readFile(f.file, 'utf8'), '独立测试原文件')
  for (const mode of ['failure', 'malformed']) {
    const failing = await fixture(t, new MacFileLocks(async () => { if (mode === 'failure') throw new Error('权限拒绝'); return { code: 0, stdout: 'p123\0' } }))
    await assert.rejects(failing.inspect(), /权限|不完整/)
  }
})
test('实际发信号前守卫失败时不调用 kill；进程身份或占用变化可阻止结束', async () => {
  const sent: Array<string | number> = []
  const guard = new ProcessTerminator({ platform: 'darwin', hostPid: 900, hostPpid: 901, snapshot: async () => [{ pid: 55, name: 'test' }], kill: (_pid, value) => { sent.push(value) } })
  await assert.rejects(guard.terminate({ pid: 55, mode: 'force' }, signal(), async () => { throw new Error('身份已改变') }), /身份已改变/)
  assert.ok(sent.every(s => s === 0))
})
test('真实文件与非空文件夹移入系统回收站，原内容能从回收站恢复', { skip: !mac }, async t => {
  const f = await fixture(t)
  for (const directory of [false, true]) {
    const name = `ztools-unlock-fixture-${randomUUID()}${directory ? '' : '.txt'}`, target = path.join(f.root, name)
    if (directory) { await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'recoverable directory') }
    else await fs.writeFile(target, 'recoverable file')
    const snapshot = await f.inspect(target)
    const result = await f.call({ action: 'trash', sessionId: snapshot.sessionId }) as { status: string }
    assert.equal(result.status, 'trashed'); await assert.rejects(fs.lstat(target))
    const inTrash = path.join(os.homedir(), '.Trash', name)
    assert.equal(await fs.readFile(directory ? path.join(inTrash, 'keep.txt') : inTrash, 'utf8'), directory ? 'recoverable directory' : 'recoverable file')
    // 只恢复本测试生成的唯一名称，之后由 fixture 清理，不碰既有回收站内容。
    await fs.rename(inTrash, target)
    assert.equal(await fs.readFile(directory ? path.join(target, 'keep.txt') : target, 'utf8'), directory ? 'recoverable directory' : 'recoverable file')
  }
})
test('多个窗口清理时全部尝试退出，首次清理失败的 broker 保留供重试', { skip: !mac }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-unlock-cleanup-'))), file = path.join(root, 'fixture')
  await fs.writeFile(file, 'keep')
  const counts = [0, 0]; let index = 0
  const service = new FileUnlockService(async file => file, () => {
    const adapter = new NativePathAccessAdapter(broker), position = index++, stop = adapter.stop.bind(adapter)
    adapter.stop = async () => { counts[position] = counts[position]! + 1; if (position === 0 && counts[position] === 1) throw new Error('退出暂未确认'); await stop() }
    return adapter
  }, processes)
  t.after(async () => { await service.stop(); await fs.rm(root, { recursive: true, force: true }) })
  await service.handle({ action: 'inspect', targetPath: file }, caller, signal())
  await service.handle({ action: 'inspect', targetPath: file }, { ...caller, webContentsId: 51 }, signal())
  await assert.rejects(service.stop(), /退出未确认/)
  assert.deepEqual(counts, [1, 1]); await service.stop(); assert.deepEqual(counts, [2, 1])
})
