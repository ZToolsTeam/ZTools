import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import {
  createProcessWindowReader,
  ProcessService,
  type ProcessWindowReader
} from '../../src/main/services/process-service.js'
import { createPlatformProcessDiscoveryAdapter } from '../../src/main/platform/process-discovery.js'
import { MacosProcessDiscoveryAdapter } from '../../src/main/platform/macos/process-discovery.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

// 这些用例依赖 Windows 路径语义（C:\\ / E:\\）或 Windows 宿主能力（DLL、进程启动、更新安装链、本地 .exe 软件），
// 在其他平台上功能代码按设计会拒绝执行，因此只在 Windows 宿主运行；Windows CI 上照常覆盖。
const windowsOnly = { skip: process.platform === 'win32' ? false : '依赖 Windows 路径或宿主能力，仅在 Windows 上运行' }


const caller: CallerIdentity = { type: 'main', webContentsId: 1 }
const otherCaller: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: 'other' }
const trustedPowerShellCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 3,
  pluginId: 'quick-folders'
}

async function createContext(windowReader?: ProcessWindowReader) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-process-'))
  const listeners = new Set<(webContentsId: number) => void>()
  const registry = {
    onRemoved(listener: (webContentsId: number) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const service = new ProcessService(
    registry,
    files,
    Date.now,
    process.platform,
    createPlatformProcessDiscoveryAdapter(process.platform),
    undefined,
    windowReader
  )
  await files.grantOpenPath(process.execPath, caller)
  return {
    root,
    files,
    service,
    remove(webContentsId: number) {
      for (const listener of listeners) listener(webContentsId)
    }
  }
}

async function dispose(context: Awaited<ReturnType<typeof createContext>>): Promise<void> {
  context.service.stop()
  context.files.stop()
  await fs.rm(context.root, { recursive: true, force: true })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

test('process start preserves argument boundaries and wait returns the owned exit code', windowsOnly, async () => {
  const context = await createContext()
  try {
    const started = await context.service.start({
      path: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(7), 80)'],
      workingDir: '',
      show: false
    }, caller, signal())
    assert.equal((await context.service.exists({ nameOrPid: String(started.pid) }, caller, signal())).data.exists, true)
    assert.deepEqual(
      await context.service.wait({ pid: started.pid, timeout: 3_000 }, caller, signal()),
      { success: true, data: { exitCode: 7 } }
    )
    assert.equal((await context.service.exists({ nameOrPid: String(started.pid) }, caller, signal())).data.exists, false)
  } finally {
    await dispose(context)
  }
})

test('process ownership blocks arbitrary PID control and timeout does not lose the child record', windowsOnly, async () => {
  const context = await createContext()
  try {
    const started = await context.service.start({
      path: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      workingDir: '',
      show: false
    }, caller, signal())
    assert.throws(
      () => context.service.kill({ pid: started.pid, force: true }, otherCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await assert.rejects(
      context.service.wait({ pid: started.pid, timeout: 10 }, caller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.requestTimeout
    )
    assert.deepEqual(context.service.kill({ pid: started.pid, force: true }, caller), { success: true })
    const waited = await context.service.wait({ pid: started.pid, timeout: 3_000 }, caller, signal())
    assert.equal(typeof waited.data.exitCode, 'number')
  } finally {
    await dispose(context)
  }
})

test('renderer removal terminates and forgets its running children', windowsOnly, async () => {
  const context = await createContext()
  try {
    const started = await context.service.start({
      path: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      workingDir: '',
      show: false
    }, caller, signal())
    context.remove(caller.webContentsId)
    assert.throws(
      () => context.service.kill({ pid: started.pid, force: true }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  } finally {
    await dispose(context)
  }
})

test('only allowlisted plugins can launch the exact system PowerShell without a dialog path grant', { skip: process.platform !== 'win32' }, async () => {
  const context = await createContext()
  try {
    const powerShell = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    await assert.rejects(
      context.service.start({
        path: powerShell,
        args: ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
        workingDir: '',
        show: false
      }, otherCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    const started = await context.service.start({
      path: powerShell,
      args: ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
      workingDir: '',
      show: false
    }, trustedPowerShellCaller, signal())
    assert.equal(
      (await context.service.wait({ pid: started.pid, timeout: 3_000 }, trustedPowerShellCaller, signal())).data.exitCode,
      0
    )
  } finally {
    await dispose(context)
  }
})

test('an already-cancelled process start cannot create a child', windowsOnly, async () => {
  const context = await createContext()
  try {
    const controller = new AbortController()
    controller.abort(errorCodes.callerDestroyed)
    await assert.rejects(
      context.service.start({
        path: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        workingDir: '',
        show: false
      }, caller, controller.signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.callerDestroyed
    )
  } finally {
    await dispose(context)
  }
})

test('process discovery is bounded and name termination stays within caller-owned children', windowsOnly, async () => {
  const context = await createContext()
  try {
    const listed = await context.service.list(signal())
    assert.ok(listed.data.length > 0)
    assert.ok(listed.data.length <= 10_000)
    assert.ok(listed.data.some((item) => item.pid === process.pid))
    assert.ok(listed.data.every((item) =>
      item.fieldAvailability.path === false && item.fieldAvailability.cpuUsage === false
    ))
    const found = await context.service.find({ name: path.basename(process.execPath).slice(0, 4) }, signal())
    assert.ok(found.data.some((item) => item.pid === process.pid))

    const callerChild = await context.service.start({
      path: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      workingDir: '',
      show: false
    }, caller, signal())
    await context.files.grantOpenPath(process.execPath, otherCaller)
    const otherChild = await context.service.start({
      path: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      workingDir: '',
      show: false
    }, otherCaller, signal())
    assert.deepEqual(
      context.service.killByName({
        name: path.basename(process.execPath),
        force: true
      }, caller),
      { success: true, killedCount: 1 }
    )
    await context.service.wait({ pid: callerChild.pid, timeout: 3_000 }, caller, signal())
    assert.equal(
      (await context.service.exists({ nameOrPid: String(otherChild.pid) }, otherCaller, signal())).data.exists,
      true
    )
    assert.deepEqual(context.service.kill({ pid: otherChild.pid, force: true }, otherCaller), { success: true })
    await context.service.wait({ pid: otherChild.pid, timeout: 3_000 }, otherCaller, signal())

    assert.throws(
      () => context.service.runFFmpeg(),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
  } finally {
    await dispose(context)
  }
})

test('macOS process discovery returns provider data while launch remains explicitly unsupported', async () => {
  const context = await createContext()
  const macService = new ProcessService(
    { onRemoved: () => () => undefined } as unknown as WindowRegistry,
    context.files,
    Date.now,
    'darwin',
    new MacosProcessDiscoveryAdapter(async () => ' 42 4.0 128 ZTools')
  )
  try {
    const listed = await macService.list(signal())
    assert.equal(listed.data[0]?.pid, 42)
    assert.equal(listed.data[0]?.name, 'ZTools')
    assert.equal(listed.data[0]?.memoryUsage, 128 * 1024)
    assert.equal(listed.data[0]?.fieldAvailability.path, false)
    assert.equal(listed.data[0]?.fieldAvailability.cpuUsage, true)
    assert.equal(listed.data[0]?.fieldAvailability.memoryUsage, true)
    await assert.rejects(
      macService.start({ path: '/Applications/Example.app', args: [], workingDir: '', show: false }, caller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
  } finally {
    macService.stop()
    await dispose(context)
  }
})

test('process window lookup preserves the visible HWND contract and fixed query', async () => {
  const calls: Array<{ executable: string; args: string[] }> = []
  const reader = createProcessWindowReader({
    async run(executable, args) {
      calls.push({ executable, args: [...args] })
      return '123456'
    }
  }, 'win32')
  const context = await createContext(reader)
  try {
    assert.deepEqual(
      await context.service.getWindow({ pid: 123 }, signal()),
      { success: true, handle: 123456 }
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.executable.toLocaleLowerCase('en-US').endsWith('powershell.exe'), true)
    assert.equal(calls[0]?.args[0], '-NoLogo')
    assert.equal(calls[0]?.args.at(-1)?.includes('$targetPid = 123'), true)
  } finally {
    await dispose(context)
  }

  let called = false
  const unsupported = createProcessWindowReader({
    async run() { called = true; return '1' }
  }, 'linux')
  await assert.rejects(
    unsupported.read(123, signal()),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.equal(called, false)
})

test('handleProcessMonitorCall provides rich snapshot, detail, services, and critical process shield', windowsOnly, async () => {
  const context = await createContext()
  try {
    const statusRes = await context.service.handleProcessMonitorCall('GetStatus', {}, signal())
    assert.equal(statusRes.success, true)
    assert.equal((statusRes.data as { status: string }).status, 'ready')

    const sysInfoRes = await context.service.handleProcessMonitorCall('GetSystemInfo', {}, signal())
    assert.equal(sysInfoRes.success, true)
    const sysData = sysInfoRes.data as { totalMemoryBytes: number; memoryUsagePercent: number; processCount: number }
    assert.ok(sysData.totalMemoryBytes > 0)
    assert.ok(sysData.memoryUsagePercent >= 0 && sysData.memoryUsagePercent <= 100)
    assert.ok(sysData.processCount > 0)

    const listRes = await context.service.handleProcessMonitorCall('GetProcessList', { includeCommandLine: true }, signal())
    assert.equal(listRes.success, true)
    const processes = (listRes.data as { processes: Array<Record<string, unknown>> }).processes
    assert.ok(Array.isArray(processes) && processes.length > 0)
    const currentProc = processes.find((p) => p.pid === process.pid)
    assert.ok(currentProc, 'current Node process should appear in rich process snapshot')
    assert.ok(typeof currentProc.workingSetBytes === 'number' && currentProc.workingSetBytes > 0)
    assert.ok(typeof currentProc.threadCount === 'number' && currentProc.threadCount >= 1)

    const detailRes = await context.service.handleProcessMonitorCall('GetProcessDetail', { pid: process.pid }, signal())
    assert.equal(detailRes.success, true)
    const detail = detailRes.data as Record<string, unknown>
    assert.equal(detail.pid, process.pid)
    assert.ok(typeof detail.path === 'string' && detail.path.length > 0)

    // Fault injection & security boundary assertions
    const invalidDetail = await context.service.handleProcessMonitorCall('GetProcessDetail', { pid: -99 }, signal())
    assert.match(String((invalidDetail.data as { error?: string }).error), /INVALID_PID/)

    const criticalKill = await context.service.handleProcessMonitorCall(
      'TerminateProcessByPID',
      { pid: 4, name: 'System', mode: 'force' },
      signal()
    )
    assert.match(String((criticalKill.data as { error?: string }).error), /SECURITY_INTERCEPTED/)

    const csrssKill = await context.service.handleProcessMonitorCall(
      'TerminateProcessByPID',
      { pid: 612, name: 'csrss.exe', mode: 'tree' },
      signal()
    )
    assert.match(String((csrssKill.data as { error?: string }).error), /SECURITY_INTERCEPTED/)

    const invalidKill = await context.service.handleProcessMonitorCall(
      'TerminateProcessByPID',
      { pid: 0, name: 'Idle' },
      signal()
    )
    assert.match(String((invalidKill.data as { error?: string }).error), /INVALID_PID/)

    const unknownMethod = await context.service.handleProcessMonitorCall('UnknownMethodXYZ', {}, signal())
    assert.match(String((unknownMethod.data as { error?: string }).error), /UNSUPPORTED_PROCESS_MONITOR_METHOD/)

    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(
      () => context.service.handleProcessMonitorCall('GetStatus', {}, aborted.signal)
    )
  } finally {
    await dispose(context)
  }
})


test('macOS进程详情只使用真实快照：不伪造版本、时间、线程和峰值；不存在PID返回错误', async () => {
  const registry = { onRemoved: () => () => {} } as unknown as WindowRegistry
  const service = new ProcessService(registry, {} as FileSystemService, Date.now, 'darwin', {
    async list() { return [{ pid: 234, name: 'fixture', path: '/tmp/fixture', cpuUsage: 3, memoryUsage: 8192, parentPid: 100, fieldAvailability: { path: true, cpuUsage: true, memoryUsage: true } }] }
  })
  try {
    const result = (await service.handleProcessMonitorCall('GetProcessDetail', { pid: 234 }, signal())).data as Record<string, unknown>
    assert.equal(result.name, 'fixture')
    assert.equal(result.parentPid, 100)
    assert.equal(result.memoryBytes, 8192)
    for (const key of ['threadCount', 'handleCount', 'peakMemoryBytes', 'privateBytes']) assert.equal(result[key], null)
    assert.equal(result.fileVersion, '')
    assert.equal(result.startTime, '')
    const missing = (await service.handleProcessMonitorCall('GetProcessDetail', { pid: 999999 }, signal())).data as Record<string, unknown>
    assert.match(String(missing.error), /PROCESS_NOT_FOUND/)
  } finally { service.stop() }
})
test('macOS进程详情发现适配器失败时拒绝，不返回成功假进程', async () => {
  const registry = { onRemoved: () => () => {} } as unknown as WindowRegistry
  const service = new ProcessService(registry, {} as FileSystemService, Date.now, 'darwin', { async list() { throw new Error('ps timeout') } })
  try { await assert.rejects(service.handleProcessMonitorCall('GetProcessDetail', { pid: 234 }, signal()), /ps timeout/) } finally { service.stop() }
})
