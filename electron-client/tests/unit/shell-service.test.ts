import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import { ShellService, type ShellAdapter } from '../../src/main/services/shell-service.js'
import { searchFilesForCaller } from '../../src/main/ipc/router.js'
import { SidecarManager } from '../../src/main/services/sidecar-manager.js'
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
  return { root, calls, files, service: new ShellService(files, adapter),
    remove: (id: number) => { for (const listener of listeners) listener(id) } }
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

test('searched host paths open and reveal without granting sibling, child, write or other-window access', async () => {
  const context = await createContext()
  const denied = (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  try {
    const folder = path.join(context.root, 'results')
    await fs.mkdir(folder)
    const found = path.join(folder, 'found.txt')
    const sibling = path.join(folder, 'private.txt')
    await fs.writeFile(found, 'found')
    await fs.writeFile(sibling, 'private')
    await assert.rejects(context.service.openPath({ fullPath: found }, caller), denied)
    await Promise.all([found, folder].map(target => context.files.grantSearchResult(target, caller)))
    assert.deepEqual(await context.service.openPath({ fullPath: found }, caller), { success: true })
    assert.deepEqual(await context.service.showItemInFolder({ fullPath: found }, caller), { success: true })
    assert.deepEqual(await context.service.openPath({ fullPath: folder }, caller), { success: true })
    await assert.rejects(context.service.openPath({ fullPath: sibling }, caller), denied)
    await assert.rejects(context.service.trashItem({ fullPath: found }, caller), denied)
    await assert.rejects(context.service.openPath({ fullPath: found }, { type: 'main', webContentsId: 3 }), denied)
    await assert.rejects(context.files.grantSearchResult(found, otherCaller), denied)
    await fs.unlink(found)
    await assert.rejects(context.files.grantSearchResult(found, caller))
    await assert.rejects(context.service.openPath({ fullPath: found }, caller))
    assert.equal(context.calls.length, 3)
  } finally {
    await context.files.stop()
    await fs.rm(context.root, { recursive: true, force: true })
  }
})

function indexTestFiles(sidecars: SidecarManager, paths: string[]): void {
  sidecars.setFallbackFiles(paths.map(filePath => ({
    name: path.basename(filePath), path: filePath, is_dir: false,
    size: 1, mtime: 0, acronym: '', pinyin: ''
  })))
}

test('search handler integrates real index matching, caller grants and shell actions despite a stale result', async t => {
  const context = await createContext()
  const sidecars = new SidecarManager()
  const warn = t.mock.method(console, 'warn', () => {})
  const denied = (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  try {
    const found = path.join(context.root, '搜索 sample.txt')
    const missing = path.join(context.root, 'missing sample.txt')
    const privateFile = path.join(context.root, 'private.txt')
    await fs.writeFile(found, 'found')
    await fs.writeFile(privateFile, 'private')
    indexTestFiles(sidecars, [found, missing, privateFile])
    const pluginResult = await searchFilesForCaller({ query: 'sample' }, otherCaller, sidecars, context.files)
    assert.equal(pluginResult.count, 2)
    await assert.rejects(context.service.openPath({ fullPath: found }, otherCaller), denied)
    const result = await searchFilesForCaller({ query: 'sample' }, caller, sidecars, context.files)
    assert.equal(result.count, 2)
    assert.equal(warn.mock.callCount(), 1)
    assert.deepEqual(await context.service.openPath({ fullPath: found }, caller), { success: true })
    assert.deepEqual(await context.service.showItemInFolder({ fullPath: found }, caller), { success: true })
    await assert.rejects(context.service.openPath({ fullPath: privateFile }, caller), denied)
    const empty = await searchFilesForCaller({ query: 'not-indexed' }, caller, sidecars, context.files)
    assert.deepEqual(empty.files, [])
    const boundedCaller: CallerIdentity = { type: 'main', webContentsId: 3 }
    const limited = await searchFilesForCaller({ query: '', limit: 1 }, boundedCaller, sidecars, context.files)
    assert.equal(limited.count, 1)
    await assert.rejects(context.service.openPath({ fullPath: privateFile }, boundedCaller), denied)
    assert.equal(context.calls.length, 2)
  } finally {
    await sidecars.stop()
    await context.files.stop()
    await fs.rm(context.root, { recursive: true, force: true })
  }
})

test('concurrent searches preserve grants but an in-flight search cannot reauthorize a closed window', async t => {
  const context = await createContext()
  const sidecars = new SidecarManager()
  const warn = t.mock.method(console, 'warn', () => {})
  try {
    const paths = ['alpha.txt', 'beta.txt'].map(name => path.join(context.root, name))
    await Promise.all(paths.map(file => fs.writeFile(file, 'found')))
    indexTestFiles(sidecars, paths)
    await Promise.all(['alpha', 'beta'].map(query => searchFilesForCaller({ query }, caller, sidecars, context.files)))
    for (const fullPath of paths) {
      assert.deepEqual(await context.service.openPath({ fullPath }, caller), { success: true })
    }
    const pending = searchFilesForCaller({ query: 'alpha' }, caller, sidecars, context.files)
    context.remove(caller.webContentsId)
    await pending
    assert.equal(warn.mock.callCount(), 1)
    await assert.rejects(context.service.openPath({ fullPath: paths[0]! }, caller),
      (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
    assert.equal(context.calls.length, 2)
  } finally {
    await sidecars.stop()
    await context.files.stop()
    await fs.rm(context.root, { recursive: true, force: true })
  }
})
