import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import { ShellService, type ShellAdapter } from '../../src/main/services/shell-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const caller: CallerIdentity = { type: 'main', webContentsId: 1 }
const otherCaller: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: 'other' }

async function createContext(openPathResult = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-shell-'))
  const listeners = new Set<(webContentsId: number) => void>()
  const registry = {
    onRemoved(listener: (webContentsId: number) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as WindowRegistry
  const calls: Array<{ method: string; value?: string }> = []
  const adapter: ShellAdapter = {
    async openPath(value) { calls.push({ method: 'openPath', value }); return openPathResult },
    async trashItem(value) { calls.push({ method: 'trashItem', value }) },
    showItemInFolder(value) { calls.push({ method: 'showItemInFolder', value }) },
    async openExternal(value) { calls.push({ method: 'openExternal', value }) },
    beep() { calls.push({ method: 'beep' }) }
  }
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  return { root, calls, files, service: new ShellService(files, adapter) }
}

test('shell paths require Main grants and capability URLs remain caller-bound', async () => {
  const context = await createContext()
  try {
    const folder = path.join(context.root, 'selected')
    const file = path.join(folder, 'document.txt')
    await fs.mkdir(folder)
    await fs.writeFile(file, 'content')

    await assert.rejects(
      context.service.openPath({ fullPath: file }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    const capability = await context.files.grantOpenPath(file, caller)
    assert.ok(capability)
    assert.deepEqual(await context.service.openPath({ fullPath: capability }, caller), { success: true })
    await assert.rejects(
      context.service.openPath({ fullPath: capability }, otherCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await context.service.showItemInFolder({ fullPath: file }, caller)
    await context.files.grantSavePath(file, caller)
    assert.deepEqual(await context.service.trashItem({ fullPath: file }, caller), { success: true })
    assert.deepEqual(context.calls.map((item) => item.method), ['openPath', 'showItemInFolder', 'trashItem'])

  } finally {
    context.files.stop()
    await fs.rm(context.root, { recursive: true, force: true })
  }
})

test('shell failures use stable messages instead of platform-provided path details', async () => {
  const context = await createContext('LaunchServices failed for /Users/alice/private/report.txt')
  try {
    const file = path.join(context.root, 'report.txt')
    await fs.writeFile(file, 'content')
    await context.files.grantOpenPath(file, caller)
    await assert.rejects(
      context.service.openPath({ fullPath: file }, caller),
      (error) => error instanceof ZToolsError &&
        error.code === errorCodes.shellError &&
        error.message === '打开失败' &&
        !error.message.includes('/Users/alice')
    )
  } finally {
    context.files.stop()
    await fs.rm(context.root, { recursive: true, force: true })
  }
})

test('shell external URLs are constrained and arbitrary command execution stays disabled', async () => {
  const context = await createContext()
  try {
    assert.deepEqual(await context.service.openExternal({ url: 'https://example.com/path' }), { success: true })
    assert.throws(
      () => context.service.exec(),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
    await assert.rejects(
      context.service.openExternal({ url: 'file:///C:/Windows/win.ini' }),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    assert.deepEqual(context.service.beep(), { success: true })
  } finally {
    context.files.stop()
    await fs.rm(context.root, { recursive: true, force: true })
  }
})
