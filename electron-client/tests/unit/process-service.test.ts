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

test('process start preserves argument boundaries and wait returns the owned exit code', async () => {
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

test('process ownership blocks arbitrary PID control and timeout does not lose the child record', async () => {
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

test('renderer removal terminates and forgets its running children', async () => {
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

test('an already-cancelled process start cannot create a child', async () => {
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

test('process discovery is bounded and name termination stays within caller-owned children', async () => {
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
