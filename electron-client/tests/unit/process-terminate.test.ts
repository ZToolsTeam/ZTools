import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { errorCodes, toPublicError, ZToolsError } from '../../src/contracts/errors.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { MacosProcessDiscoveryAdapter, parseMacosProcessList } from '../../src/main/platform/macos/process-discovery.js'
import { ProcessService } from '../../src/main/services/process-service.js'
import {
  normalizeProcessName,
  ProcessTerminator,
  type ProcessTreeEntry
} from '../../src/main/services/process-terminator.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

const execFileAsync = promisify(execFile)
const posix = process.platform !== 'win32'
const darwin = process.platform === 'darwin'

function signal(): AbortSignal {
  return new AbortController().signal
}

function codeOf(code: string, check?: (error: ZToolsError) => void) {
  return (error: unknown) => {
    assert.ok(error instanceof ZToolsError, String(error))
    assert.equal(error.code, code, error.message)
    check?.(error)
    return true
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const spawned = new Set<ChildProcess>()
function spawnOwned(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: 'ignore' })
  spawned.add(child)
  child.once('exit', () => spawned.delete(child))
  return child
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function childrenOf(pid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='])
  return stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(([child, parent]) => parent === pid && Number.isInteger(child)).map(([child]) => child as number)
}

test.after(() => {
  // 只清理本测试自己启动的进程
  for (const child of spawned) child.kill('SIGKILL')
})

function realService(protectedPids: () => Iterable<number> = () => []): ProcessService {
  return new ProcessService(
    new WindowRegistry(),
    {} as FileSystemService,
    Date.now,
    process.platform,
    darwin ? new MacosProcessDiscoveryAdapter() : undefined,
    undefined,
    undefined,
    { protectedPids }
  )
}

test('真实进程：graceful 结束 sleep；已退出的 pid 报 PROCESS_NOT_FOUND；expectedName 不符不发信号', { skip: !darwin }, async () => {
  const service = realService()
  try {
    const target = spawnOwned('sleep', ['60'])
    const pid = target.pid as number
    await assert.rejects(service.terminatePid({ pid, mode: 'force', expectedName: 'Safari' }, signal()),
      codeOf(errorCodes.processIdentityMismatch))
    assert.equal(alive(pid), true, 'pid 复用检查失败时不发信号')
    const result = await service.terminatePid({ pid, mode: 'graceful', expectedName: '/bin/SLEEP' }, signal())
    assert.deepEqual(result.data, { pid, mode: 'graceful', tree: false, terminated: [pid] })
    assert.equal(alive(pid), false)
    await assert.rejects(service.terminatePid({ pid, mode: 'force' }, signal()), codeOf(errorCodes.processNotFound))
  } finally {
    service.stop()
  }
})

test('真实进程：忽略 SIGTERM 时 graceful 超时不自动升级，调用方再 force 成功；graceful 等待中并发 force 两个都成功', { skip: !darwin }, async () => {
  const service = realService()
  try {
    const stubborn = spawnOwned(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"])
    const pid = stubborn.pid as number
    await new Promise(resolve => setTimeout(resolve, 300))
    await assert.rejects(service.terminatePid({ pid, mode: 'graceful', timeoutMs: 300 }, signal()),
      codeOf(errorCodes.processTerminateTimeout, error => {
        assert.deepEqual(toPublicError(error).details, { stillRunning: [pid] })
      }))
    assert.equal(alive(pid), true, '宿主不自动升级 force')

    const graceful = service.terminatePid({ pid, mode: 'graceful', timeoutMs: 5_000 }, signal())
    await new Promise(resolve => setTimeout(resolve, 100))
    const force = service.terminatePid({ pid, mode: 'force' }, signal())
    const [gracefulResult, forceResult] = await Promise.all([graceful, force])
    assert.deepEqual(gracefulResult.data.terminated, [pid])
    assert.deepEqual(forceResult.data.terminated, [pid])
    assert.equal(alive(pid), false)
  } finally {
    service.stop()
  }
})

test('真实进程：tree 结束连同子孙；受保护的子孙（注入的侧车 pid）连同子树跳过', { skip: !darwin }, async () => {
  let protectedChild = -1
  const service = realService(() => [protectedChild])
  try {
    const shell = spawnOwned('/bin/sh', ['-c', 'sleep 60 & sleep 60 & wait'])
    const pid = shell.pid as number
    await waitFor(async () => (await childrenOf(pid)).length === 2)
    const [first, second] = await childrenOf(pid) as [number, number]
    protectedChild = second
    const result = await service.terminatePid({ pid, mode: 'force', tree: true }, signal())
    assert.deepEqual([...result.data.terminated].sort(), [first, pid].sort())
    assert.equal(result.data.terminated.at(-1), pid, '先子后父')
    assert.equal(alive(first), false)
    assert.equal(alive(second), true, '受保护的子孙被跳过')
    // 受保护的进程不能被直接结束
    await assert.rejects(service.terminatePid({ pid: second, mode: 'force' }, signal()),
      codeOf(errorCodes.processProtected, error => assert.equal(toPublicError(error).details?.reason, 'host-child')))
    protectedChild = -1
    await service.terminatePid({ pid: second, mode: 'force' }, signal())
  } finally {
    service.stop()
  }
})

test('保护名单：宿主自身、宿主父进程、pid ≤ 1 与非法参数一律拒绝且不发信号', { skip: !posix }, async () => {
  const sent: Array<[number, unknown]> = []
  const terminator = new ProcessTerminator({
    platform: process.platform,
    snapshot: async () => [
      { pid: process.pid, ppid: process.ppid, name: 'node' },
      { pid: process.ppid, ppid: 1, name: 'node' },
      { pid: 777, ppid: 1, name: 'launchd' },
      { pid: 778, ppid: 1, name: '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow' }
    ],
    kill: (pid, sig) => { sent.push([pid, sig]); if (sig !== 0) throw new Error('must not signal') }
  })
  await assert.rejects(terminator.terminate({ pid: process.pid, mode: 'force' }, signal()),
    codeOf(errorCodes.processProtected, error => assert.equal(toPublicError(error).details?.reason, 'host-self')))
  await assert.rejects(terminator.terminate({ pid: process.ppid, mode: 'force' }, signal()),
    codeOf(errorCodes.processProtected, error => assert.equal(toPublicError(error).details?.reason, 'host-ancestor')))
  if (darwin) {
    for (const pid of [777, 778]) {
      await assert.rejects(terminator.terminate({ pid, mode: 'force' }, signal()),
        codeOf(errorCodes.processProtected, error => assert.equal(toPublicError(error).details?.reason, 'system')))
    }
  }
  assert.ok(sent.every(([, sig]) => sig === 0), '保护名单命中时只做存在性探测')
  for (const pid of [0, 1, -1, 1.5, '123', 2 ** 32, Number.NaN]) {
    assert.throws(() => validateMethodParams('process_terminate_pid', { pid, mode: 'force' }), codeOf(errorCodes.invalidRequest))
    await assert.rejects(terminator.terminate({ pid: pid as number, mode: 'force' }, signal()), codeOf(errorCodes.invalidRequest))
  }
  for (const params of [
    { pid: 100, mode: 'kill' },
    { pid: 100, mode: 'force', timeoutMs: 50 },
    { pid: 100, mode: 'force', timeoutMs: 10_001 },
    { pid: 100, mode: 'force', tree: 'yes' },
    { pid: 100, mode: 'force', expectedName: 'x'.repeat(261) },
    { pid: 100, mode: 'force', expectedName: 'a\0b' },
    { pid: 100, mode: 'force', signal: 'SIGKILL' }
  ]) {
    assert.throws(() => validateMethodParams('process_terminate_pid', params), codeOf(errorCodes.invalidRequest), JSON.stringify(params))
  }
  assert.doesNotThrow(() => validateMethodParams('process_terminate_pid', { pid: 2, mode: 'graceful', tree: true, timeoutMs: 100, expectedName: 'x' }))
})

test('EPERM、快照失败 / 乱码 / 截断、发送失败：都不会误杀，错误可区分', async () => {
  const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' })
  const sent: Array<[number, unknown]> = []
  const base = { platform: 'darwin' as NodeJS.Platform, hostPid: 10, hostPpid: 9 }
  const snapshot = async (): Promise<ProcessTreeEntry[]> => [{ pid: 500, ppid: 1, name: 'victim' }]
  const denied = new ProcessTerminator({ ...base, snapshot, kill: () => { throw eperm } })
  await assert.rejects(denied.terminate({ pid: 500, mode: 'force' }, signal()), codeOf(errorCodes.processAccessDenied))

  const sendDenied = new ProcessTerminator({
    ...base, snapshot, kill: (pid, sig) => { sent.push([pid, sig]); if (sig !== 0) throw eperm }
  })
  await assert.rejects(sendDenied.terminate({ pid: 500, mode: 'force' }, signal()), codeOf(errorCodes.processAccessDenied))

  const signals: unknown[] = []
  const recordKill = (_pid: number, sig: NodeJS.Signals | 0): void => { if (sig !== 0) signals.push(sig) }
  for (const broken of [
    async () => { throw new Error('ps timed out') },
    async () => 'garbage' as unknown as ProcessTreeEntry[],
    async () => [{ pid: 501, ppid: 1, name: 'other' }]
  ]) {
    const terminator = new ProcessTerminator({ ...base, snapshot: broken, kill: recordKill })
    await assert.rejects(terminator.terminate({ pid: 500, mode: 'force' }, signal()), codeOf(errorCodes.processError))
  }
  const providerFails = new ProcessTerminator({
    ...base, snapshot, kill: recordKill, protectedPids: () => { throw new Error('metrics unavailable') }
  })
  await assert.rejects(providerFails.terminate({ pid: 500, mode: 'force' }, signal()), codeOf(errorCodes.processError))
  assert.deepEqual(signals, [], '快照或保护名单不可用时绝不发信号')

  // 目标是僵尸：视为已退出
  const zombie = new ProcessTerminator({ ...base, snapshot: async () => [{ pid: 500, ppid: 1, name: 'victim', zombie: true }], kill: recordKill })
  await assert.rejects(zombie.terminate({ pid: 500, mode: 'force' }, signal()), codeOf(errorCodes.processNotFound))
  // SIGKILL 成功后进程变成僵尸（父进程未回收）：轮询复查快照，按已退出处理
  let killed = false
  const becomesZombie = new ProcessTerminator({
    ...base,
    snapshot: async () => [{ pid: 500, ppid: 1, name: 'victim', zombie: killed }],
    kill: (_pid, sig) => { if (sig !== 0) killed = true },
    sleep: async () => undefined
  })
  assert.deepEqual((await becomesZombie.terminate({ pid: 500, mode: 'force', timeoutMs: 1_000 }, signal())).data.terminated, [500])
})

test('取消与超时：等待期间中止返回 CANCELLED / REQUEST_TIMEOUT，信号已发出不撤销', async () => {
  const signals: unknown[] = []
  const terminator = new ProcessTerminator({
    platform: 'darwin', hostPid: 10, hostPpid: 9,
    snapshot: async () => [{ pid: 600, ppid: 1, name: 'stuck' }],
    kill: (_pid, sig) => { if (sig !== 0) signals.push(sig) }
  })
  const controller = new AbortController()
  const pending = terminator.terminate({ pid: 600, mode: 'graceful', timeoutMs: 5_000 }, controller.signal)
  setTimeout(() => controller.abort('cancel'), 120)
  await assert.rejects(pending, codeOf(errorCodes.cancelled))
  assert.deepEqual(signals, ['SIGTERM'])
  const timed = new AbortController()
  const timedPending = terminator.terminate({ pid: 600, mode: 'force', timeoutMs: 5_000 }, timed.signal)
  setTimeout(() => timed.abort(errorCodes.requestTimeout), 60)
  await assert.rejects(timedPending, codeOf(errorCodes.requestTimeout))
  const aborted = new AbortController()
  aborted.abort(errorCodes.appStopping)
  await assert.rejects(terminator.terminate({ pid: 600, mode: 'force' }, aborted.signal), codeOf(errorCodes.appStopping))
})

test('Windows 分支：逐个 /PID 不用 /T，跳过受保护子孙；graceful 被拒与 force 无权限可区分', async () => {
  const calls: string[][] = []
  const living = new Set([700, 701, 702, 703])
  const tree: ProcessTreeEntry[] = [
    { pid: 700, ppid: 50, name: 'App.EXE' },
    { pid: 701, ppid: 700, name: 'child.exe' },
    { pid: 702, ppid: 700, name: 'csrss.exe' },
    { pid: 703, ppid: 702, name: 'grandchild.exe' },
    { pid: 4, ppid: 0, name: 'System' }
  ]
  const kill = (pid: number): void => {
    if (!living.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
  }
  const terminator = new ProcessTerminator({
    platform: 'win32', hostPid: 10, hostPpid: 9, snapshot: async () => tree, kill,
    runTaskkill: async (args) => {
      calls.push([...args])
      for (let index = 0; index < args.length; index += 1) if (args[index] === '/PID') living.delete(Number(args[index + 1]))
      return { ok: true }
    },
    sleep: async () => undefined
  })
  const result = await terminator.terminate({ pid: 700, mode: 'force', tree: true, expectedName: 'app' }, signal())
  assert.deepEqual(calls, [['/F', '/PID', '701', '/PID', '700']], 'csrss 及其子树被跳过，且不使用 /T')
  assert.deepEqual(result.data.terminated, [701, 700])
  assert.equal(living.has(702) && living.has(703), true)
  await assert.rejects(terminator.terminate({ pid: 4, mode: 'force' }, signal()), codeOf(errorCodes.processProtected))
  living.add(702)
  await assert.rejects(terminator.terminate({ pid: 702, mode: 'force' }, signal()), codeOf(errorCodes.processProtected))

  const stubborn = new Set([800])
  const rejecting = (mode: 'graceful' | 'force') => new ProcessTerminator({
    platform: 'win32', hostPid: 10, hostPpid: 9,
    snapshot: async () => [{ pid: 800, ppid: 1, name: 'console.exe' }],
    kill: (pid) => { if (!stubborn.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) },
    runTaskkill: async (args) => { calls.push([...args]); return { ok: false } },
    sleep: async () => undefined
  }).terminate({ pid: 800, mode }, signal())
  await assert.rejects(rejecting('graceful'), codeOf(errorCodes.processTerminateTimeout, error => {
    assert.deepEqual(toPublicError(error).details, { reason: 'graceful-rejected', stillRunning: [800] })
  }))
  await assert.rejects(rejecting('force'), codeOf(errorCodes.processAccessDenied))
  assert.deepEqual(calls.at(-2), ['/PID', '800'])
  assert.deepEqual(calls.at(-1), ['/F', '/PID', '800'])
})

test('tree 子孙超过 256 个拒绝；进程名规范化与 macOS ps 扩展列解析', async () => {
  const snapshot: ProcessTreeEntry[] = [{ pid: 1000, ppid: 1, name: 'root' }]
  for (let index = 0; index < 300; index += 1) snapshot.push({ pid: 2000 + index, ppid: 1000, name: 'worker' })
  const signals: unknown[] = []
  const terminator = new ProcessTerminator({
    platform: 'darwin', hostPid: 10, hostPpid: 9, snapshot: async () => snapshot,
    kill: (_pid, sig) => { if (sig !== 0) signals.push(sig) }
  })
  await assert.rejects(terminator.terminate({ pid: 1000, mode: 'force', tree: true }, signal()), codeOf(errorCodes.invalidRequest))
  assert.deepEqual(signals, [])

  assert.equal(normalizeProcessName('C:\\Windows\\System32\\NOTEPAD.EXE', 'win32'), 'notepad')
  assert.equal(normalizeProcessName('/Applications/Safari.app/Contents/MacOS/Safari', 'darwin'), 'safari')
  assert.equal(normalizeProcessName('Google Chrome Helper (Renderer)', 'darwin'), 'google chrome helper (renderer)')

  const parsed = parseMacosProcessList([
    '  1     0 Ss     0.4  22480 /sbin/launchd',
    ' 42     1 S+     1.0   1024 /bin/sleep',
    ' 43    42 Z      0.0      0 (sleep)',
    ' 44     1 R      0.0     10 legacy name with spaces'
  ].join('\n'))
  assert.equal(parsed[0]?.parentPid, 0)
  assert.equal(parsed[1]?.parentPid, 1)
  assert.equal(parsed[1]?.name, 'sleep')
  assert.equal(parsed[2]?.zombie, true)
  assert.equal(parsed[1]?.zombie, undefined)
  assert.equal(parsed[3]?.name, 'legacy name with spaces')
})

test('旧 DLL 兜底 TerminateProcessByPID：保持旧返回形状，套用新保护名单，不再信任调用方传入的 name', { skip: !darwin }, async () => {
  const service = realService()
  try {
    const invalid = await service.handleProcessMonitorCall('TerminateProcessByPID', { pid: -3 }, signal())
    assert.match(String((invalid.data as { error: string }).error), /^INVALID_PID/)
    const self = await service.handleProcessMonitorCall('TerminateProcessByPID', { pid: process.pid, name: 'sleep' }, signal())
    assert.match(String((self.data as { error: string }).error), /^SECURITY_INTERCEPTED/)
    const parent = await service.handleProcessMonitorCall('TerminateProcessByPID', { pid: process.ppid, name: 'notepad.exe' }, signal())
    assert.match(String((parent.data as { error: string }).error), /^SECURITY_INTERCEPTED/, '良性 name 不能绕过保护')
    assert.equal(alive(process.ppid), true)

    const target = spawnOwned('sleep', ['60'])
    const pid = target.pid as number
    const ok = await service.handleProcessMonitorCall('TerminateProcessByPID', { pid, name: 'csrss.exe' }, signal())
    assert.deepEqual(ok.data, { terminated: true, pid, mode: 'force' })
    assert.equal(alive(pid), false)
    const gone = await service.handleProcessMonitorCall('TerminateProcessByPID', { pid, mode: 'graceful' }, signal())
    assert.match(String((gone.data as { error: string }).error), /^PROCESS_NOT_FOUND/)
  } finally {
    service.stop()
  }
})
