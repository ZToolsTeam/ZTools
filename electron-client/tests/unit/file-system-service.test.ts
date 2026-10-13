import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { fileCapabilityResponse } from '../../src/main/protocol/file-capability.js'
import { fileFailure, FileSystemService } from '../../src/main/services/file-system-service.js'
import { FileDropService } from '../../src/main/services/file-drop-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

interface TestContext {
  service: FileSystemService
  root: string
  remove(webContentsId: number): void
}

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: '../plugin-a' }

test('unknown file failures keep a stable code without exposing native error details', () => {
  const error = fileFailure(new Error('EACCES: open /Users/alice/private/report.txt'))
  assert.equal(error.code, errorCodes.fileError)
  assert.equal(error.message, '文件操作失败')
  assert.equal(error.message.includes('/Users/alice'), false)
})

async function createContext(now: () => number = Date.now): Promise<TestContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-files-'))
  let removed: ((webContentsId: number) => void) | undefined
  const callers = new Map<number, CallerIdentity>([
    [mainCaller.webContentsId, mainCaller],
    [pluginCaller.webContentsId, pluginCaller]
  ])
  const registry = {
    onRemoved(listener: (webContentsId: number) => void) {
      removed = listener
      return () => { removed = undefined }
    },
    get(webContentsId: number) {
      return callers.get(webContentsId)
    }
  } as unknown as WindowRegistry
  const service = new FileSystemService(registry, path.join(root, 'cache'), now)
  return {
    service,
    root,
    remove(webContentsId) {
      callers.delete(webContentsId)
      removed?.(webContentsId)
    }
  }
}

async function dispose(context: TestContext): Promise<void> {
  await context.service.stop()
  await fs.rm(context.root, { recursive: true, force: true })
}

test('cache I/O is isolated by the caller identity and rejects traversal', async () => {
  const context = await createContext()
  try {
    await context.service.writeCache({ relativePath: 'state/data.txt', encoding: 'utf8', content: 'main' }, mainCaller)
    await context.service.writeCache({ relativePath: 'state/data.txt', encoding: 'utf8', content: 'plugin' }, pluginCaller)

    assert.equal((await context.service.readCache({ relativePath: 'state/data.txt', encoding: 'utf8' }, mainCaller)).content, 'main')
    assert.equal((await context.service.readCache({ relativePath: 'state/data.txt', encoding: 'utf8' }, pluginCaller)).content, 'plugin')
    await assert.rejects(
      context.service.readCache({ relativePath: '../outside.txt', encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  } finally {
    await dispose(context)
  }
})

test('arbitrary paths require a matching read or write grant', async () => {
  const context = await createContext()
  try {
    const folder = path.join(context.root, 'selected')
    const source = path.join(folder, 'source.txt')
    await fs.mkdir(folder)
    await fs.writeFile(source, 'source')

    await assert.rejects(
      context.service.readFile({ path: source, encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await context.service.grantOpenPath(source, mainCaller)
    assert.equal((await context.service.readFile({ path: source, encoding: 'utf8' }, mainCaller)).content, 'source')
    await assert.rejects(
      context.service.readFile({ path: source, encoding: 'utf8' }, pluginCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await assert.rejects(
      context.service.writeFile({ path: source, encoding: 'utf8', content: 'changed' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await context.service.grantFolder(folder, mainCaller)
    const nested = path.join(folder, 'nested', 'target.txt')
    await context.service.writeFile({ path: nested, encoding: 'utf8', content: 'target' }, mainCaller)
    assert.equal(await fs.readFile(nested, 'utf8'), 'target')
    assert.deepEqual(
      (await context.service.find({ path: path.dirname(nested), pattern: '*.txt' }, mainCaller, false)).files.map((item) => item.name),
      [nested]
    )
  } finally {
    await dispose(context)
  }
})

test('save grants are write-only for an existing file and expire or disappear with their renderer', async () => {
  let clock = 1_000
  const context = await createContext(() => clock)
  try {
    const selected = path.join(context.root, 'save.txt')
    const sibling = path.join(context.root, 'sibling.txt')
    await fs.writeFile(selected, 'pre-existing secret')
    const saveUrl = await context.service.grantSavePath(selected, mainCaller)
    assert.equal(context.service.canLoadFileCapability(saveUrl, mainCaller.webContentsId), false)
    assert.equal(context.service.canLoadFileCapability(saveUrl, pluginCaller.webContentsId), false)
    await assert.rejects(
      context.service.readFile({ path: selected, encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    assert.equal(context.service.canLoadFileCapability(saveUrl, mainCaller.webContentsId), false)
    await assert.rejects(
      context.service.resolveFileCapability(saveUrl),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await context.service.writeFile({ path: selected, encoding: 'utf8', content: 'saved' }, mainCaller)
    assert.equal(await fs.readFile(selected, 'utf8'), 'saved')
    await assert.rejects(
      context.service.readFile({ path: selected, encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await assert.rejects(
      context.service.resolveFileCapability(saveUrl),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    let fileReads = 0
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await fileCapabilityResponse(
        { method, url: saveUrl },
        context.service,
        async () => {
          fileReads += 1
          return new Response('unexpected file read')
        }
      )
      assert.equal(response.status, 404)
    }
    assert.equal(fileReads, 0)
    await assert.rejects(
      context.service.writeFile({ path: sibling, encoding: 'utf8', content: 'denied' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )

    clock += 60 * 60 * 1000 + 1
    assert.equal(context.service.canLoadFileCapability(saveUrl, mainCaller.webContentsId), false)
    await assert.rejects(
      context.service.readFile({ path: selected, encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )

    clock = 2_000
    const openUrl = await context.service.grantOpenPath(selected, mainCaller)
    assert.ok(openUrl)
    assert.equal(context.service.claimsFileCapabilityUrl(openUrl), true)
    assert.equal(context.service.claimsFileCapabilityUrl('ztools://file/' + 'X'.repeat(43) + '/unknown'), false)
    assert.equal(context.service.canLoadFileCapability(openUrl, mainCaller.webContentsId), true)
    assert.equal(await context.service.resolveFileCapability(openUrl), selected)
    context.remove(mainCaller.webContentsId)
    assert.equal(context.service.claimsFileCapabilityUrl(openUrl), false)
    assert.equal(context.service.canLoadFileCapability(openUrl, mainCaller.webContentsId), false)
    await assert.rejects(
      context.service.readFile({ path: selected, encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await assert.rejects(
      context.service.readFile({ path: selected, encoding: 'utf8' }, pluginCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  } finally {
    await dispose(context)
  }
})

test('an expired read grant cannot bleed into a later write-only save grant', async () => {
  let clock = 1_000
  const context = await createContext(() => clock)
  try {
    const selected = path.join(context.root, 'expired-read.txt')
    await fs.writeFile(selected, 'secret')
    const openUrl = await context.service.grantOpenPath(selected, mainCaller)
    assert.ok(openUrl)
    assert.equal((await context.service.readFile({ path: selected, encoding: 'utf8' }, mainCaller)).content, 'secret')

    clock += 60 * 60 * 1000 + 1
    const saveUrl = await context.service.grantSavePath(selected, mainCaller)
    assert.equal(context.service.canLoadFileCapability(saveUrl, mainCaller.webContentsId), false)
    await assert.rejects(
      context.service.readFile({ path: selected, encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await assert.rejects(
      context.service.resolveFileCapability(openUrl),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  } finally {
    await dispose(context)
  }
})

test('single-file grants distinguish case-only siblings using the actual directory semantics', async () => {
  const context = await createContext()
  try {
    const directory = path.join(context.root, 'case-grant')
    const selected = path.join(directory, 'Report.txt')
    const sibling = path.join(directory, 'report.txt')
    await fs.mkdir(directory)
    await fs.writeFile(selected, 'selected')
    let caseSensitive = false
    try {
      await fs.writeFile(sibling, 'sibling', { flag: 'wx' })
      caseSensitive = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    await context.service.grantOpenPath(selected, mainCaller)
    if (caseSensitive) {
      await assert.rejects(
        context.service.readFile({ path: sibling, encoding: 'utf8' }, mainCaller),
        (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
      )
    } else {
      assert.equal((await context.service.readFile({ path: sibling, encoding: 'utf8' }, mainCaller)).content, 'selected')
    }

    const directoryAlias = path.join(context.root, 'CASE-GRANT')
    let directoryAliasResolves = true
    try {
      await fs.stat(directoryAlias)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      directoryAliasResolves = false
    }
    const aliasedPath = path.join(directoryAlias, 'Report.txt')
    if (directoryAliasResolves) {
      assert.equal((await context.service.readFile({ path: aliasedPath, encoding: 'utf8' }, mainCaller)).content, 'selected')
    } else {
      await assert.rejects(context.service.readFile({ path: aliasedPath, encoding: 'utf8' }, mainCaller))
    }
  } finally {
    await dispose(context)
  }
})

test('find wildcard matching follows the searched directory case semantics', async () => {
  const context = await createContext()
  try {
    const directory = path.join(context.root, 'case-glob')
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'Report.txt'), 'upper')
    let caseSensitive = false
    try {
      await fs.writeFile(path.join(directory, 'report.txt'), 'lower', { flag: 'wx' })
      caseSensitive = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await context.service.grantFolder(directory, mainCaller)

    const found = await context.service.find({ path: directory, pattern: 'report*' }, mainCaller, false)
    assert.deepEqual(
      found.files.map((item) => path.basename(item.name)).sort(),
      caseSensitive ? ['report.txt'] : ['Report.txt']
    )
  } finally {
    await dispose(context)
  }
})

test('case-only path variants fail closed when an empty parent prevents semantic probing', async () => {
  const context = await createContext()
  try {
    const directory = path.join(context.root, 'empty-case-parent')
    const selected = path.join(directory, 'Target.txt')
    await fs.mkdir(directory)
    await context.service.grantSavePath(selected, mainCaller)
    await assert.rejects(
      context.service.writeFile({ path: path.join(directory, 'target.txt'), encoding: 'utf8', content: 'variant' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await context.service.writeFile({ path: selected, encoding: 'utf8', content: 'exact' }, mainCaller)
    assert.equal(await fs.readFile(selected, 'utf8'), 'exact')
  } finally {
    await dispose(context)
  }
})

test('binary data round-trips and oversized writes fail before touching the target', async () => {
  const context = await createContext()
  try {
    const selected = path.join(context.root, 'binary.dat')
    await context.service.grantSavePath(selected, mainCaller)
    const content = Buffer.from([0, 1, 2, 254, 255]).toString('base64')
    await context.service.writeFile({ path: selected, encoding: 'base64', content }, mainCaller)
    assert.equal((await fs.readFile(selected)).toString('base64'), content)
    await context.service.writeFile({ path: selected, encoding: 'utf8', content: 'replaced' }, mainCaller)
    assert.equal(await fs.readFile(selected, 'utf8'), 'replaced')

    await assert.rejects(
      context.service.writeFile({ path: selected, encoding: 'utf8', content: 'x'.repeat(16 * 1024 * 1024 + 1) }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.fileTooLarge
    )
    assert.equal(await fs.readFile(selected, 'utf8'), 'replaced')
  } finally {
    await dispose(context)
  }
})

test('cache-root file and directory methods preserve the Delphi response contract', async () => {
  const context = await createContext()
  try {
    const current = (await context.service.getCurrentDirectory(mainCaller)).path
    const workspace = path.join(current, 'workspace')
    await context.service.createDirectory({ path: workspace }, mainCaller)
    await context.service.setCurrentDirectory({ path: workspace }, mainCaller)
    await context.service.writeFile({ path: 'source.txt', encoding: 'utf8', content: 'source' }, mainCaller)

    assert.deepEqual(await context.service.fileExists({ path: 'source.txt' }, mainCaller), { success: true, exists: true })
    assert.deepEqual(await context.service.getFileSize({ path: 'source.txt' }, mainCaller), { success: true, size: 6 })
    await context.service.copyFile({ sourcePath: 'source.txt', destPath: 'copy.txt' }, mainCaller)
    await context.service.moveFile({ sourcePath: 'copy.txt', destPath: 'moved.txt' }, mainCaller)
    assert.deepEqual(
      (await context.service.find({ path: '.', pattern: '*.txt' }, mainCaller, false)).files.map((item) => path.basename(item.name)).sort(),
      ['moved.txt', 'source.txt']
    )
    assert.equal((await context.service.getDirectoryContents({ path: '.' }, mainCaller)).files.length, 2)
    assert.equal(context.service.getFileName({ path: 'folder/file.txt' }).name, 'file.txt')
    assert.equal(context.service.getExtension({ path: 'folder/file.txt' }).extension, '.txt')
    assert.equal(context.service.getParentDirectory({ path: 'folder/file.txt' }).path, 'folder')
    assert.equal(context.service.combinePath({ path1: 'folder', path2: 'file.txt' }).path, path.join('folder', 'file.txt'))

    await context.service.deleteFile({ path: 'moved.txt' }, mainCaller)
    await context.service.deleteFile({ path: 'source.txt' }, mainCaller)
    await context.service.setCurrentDirectory({ path: current }, mainCaller)
    await context.service.deleteDirectory({ path: workspace }, mainCaller)
    assert.deepEqual(await context.service.directoryExists({ path: workspace }, mainCaller), { success: true, exists: false })
  } finally {
    await dispose(context)
  }
})

test('directory symlink escapes are rejected', async () => {
  const context = await createContext()
  try {
    const selected = path.join(context.root, 'selected')
    const outside = path.join(context.root, 'outside')
    await fs.mkdir(selected)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await context.service.grantFolder(selected, mainCaller)
    await fs.symlink(
      outside,
      path.join(selected, 'escape'),
      process.platform === 'win32' ? 'junction' : undefined
    )

    await assert.rejects(
      context.service.readFile({ path: path.join(selected, 'escape', 'secret.txt'), encoding: 'utf8' }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  } finally {
    await dispose(context)
  }
})

test('Windows file-system service rejects device namespace and ADS paths', { skip: process.platform !== 'win32' }, async () => {
  const context = await createContext()
  try {
    for (const unsafe of ['\\\\?\\C:\\Windows\\win.ini', 'C:\\safe.txt:stream']) {
      await assert.rejects(
        context.service.getFullPath({ path: unsafe }, mainCaller),
        (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
      )
    }
  } finally {
    await dispose(context)
  }
})

test('generated cache files use the caller scope, atomic write and size boundary', async () => {
  const context = await createContext()
  try {
    const generated = await context.service.writeGeneratedCacheFile(
      'screenshots/generated.png',
      Buffer.from([1, 2, 3]),
      mainCaller
    )
    assert.deepEqual(await fs.readFile(generated.path), Buffer.from([1, 2, 3]))
    await assert.rejects(
      context.service.writeGeneratedCacheFile('../escape.png', Buffer.from('x'), mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    await assert.rejects(
      context.service.writeGeneratedCacheFile('screenshots/large.png', Buffer.alloc(16 * 1024 * 1024 + 1), mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.fileTooLarge
    )
  } finally {
    await dispose(context)
  }
})

test('exclusive writes keep existing outputs and publish only one concurrent winner', async () => {
  const context = await createContext()
  try {
    const folder = path.join(context.root, 'exclusive')
    await fs.mkdir(folder)
    await context.service.grantFolder(folder, mainCaller)
    const existing = path.join(folder, 'keep.txt')
    await fs.writeFile(existing, 'original')
    await assert.rejects(context.service.writeFile({ path: existing, encoding: 'utf8', content: 'replacement', overwrite: false }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.fileAlreadyExists)
    assert.equal(await fs.readFile(existing, 'utf8'), 'original')
    const output = path.join(folder, 'race.txt')
    const results = await Promise.allSettled(['first', 'second'].map(content => context.service.writeFile({ path: output, encoding: 'utf8', content, overwrite: false }, mainCaller)))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.code, errorCodes.fileAlreadyExists)
    assert.ok(['first', 'second'].includes(await fs.readFile(output, 'utf8')))
    assert.deepEqual((await fs.readdir(folder)).sort(), ['keep.txt', 'race.txt'])
  } finally { await dispose(context) }
})

test('closed owners cannot regain grants through an asynchronous grant request', async () => {
  const context = await createContext()
  try {
    const source = path.join(context.root, 'selected.txt')
    await fs.writeFile(source, 'source')
    const granting = context.service.grantOpenPath(source, mainCaller)
    context.remove(mainCaller.webContentsId)
    await assert.rejects(granting, (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
    await assert.rejects(context.service.readFile({ path: source, encoding: 'utf8' }, mainCaller), (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
    assert.equal(await fs.readFile(source, 'utf8'), 'source')
  } finally { await dispose(context) }
})

test('concurrent open grants for one owner retain every selected file', async () => {
  const context = await createContext()
  const directory = path.join(context.root, 'multi-select')
  const selected = ['first.wav', 'second.wav', 'third.wav', 'fourth.wav']
    .map((name) => path.join(directory, name))
  await fs.mkdir(directory)
  await Promise.all(selected.map((filePath) => fs.writeFile(filePath, path.basename(filePath))))

  try {
    await context.service.grantOpenPath(selected[0]!, mainCaller)

    const fileSystem = fs as unknown as {
      stat: (target: string) => ReturnType<typeof fs.stat>
      readdir: (target: string) => Promise<string[]>
    }
    const originalStat = fileSystem.stat.bind(fs)
    const originalReaddir = fileSystem.readdir.bind(fs)
    let releasePathComparison!: () => void
    const pathComparisonGate = new Promise<void>((resolve) => { releasePathComparison = resolve })
    let signalPathComparison!: () => void
    const pathComparisonStarted = new Promise<void>((resolve) => { signalPathComparison = resolve })
    let signalRemainingStats!: () => void
    const remainingStats = new Promise<void>((resolve) => { signalRemainingStats = resolve })
    let pathComparisons = 0
    const pendingStatTargets = new Set(selected.slice(2).map((filePath) => path.resolve(filePath)))
    const completedStatTargets = new Set<string>()

    fileSystem.readdir = async (target) => {
      if (path.resolve(target) === path.resolve(directory)) {
        pathComparisons += 1
        if (pathComparisons === 1) signalPathComparison()
        await pathComparisonGate
      }
      return await originalReaddir(target)
    }
    fileSystem.stat = async (target) => {
      const stats = await originalStat(target)
      const normalizedTarget = path.resolve(target)
      if (pendingStatTargets.has(normalizedTarget)) {
        completedStatTargets.add(normalizedTarget)
        if (completedStatTargets.size === pendingStatTargets.size) signalRemainingStats()
      }
      return stats
    }

    const grants: Array<Promise<string | undefined>> = []
    try {
      grants.push(context.service.grantOpenPath(selected[1]!, mainCaller))
      await pathComparisonStarted
      grants.push(...selected.slice(2).map((filePath) => context.service.grantOpenPath(filePath, mainCaller)))
      await remainingStats
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(pathComparisons, 1, 'same-owner grant comparisons must run serially')
    } finally {
      releasePathComparison()
      fileSystem.stat = originalStat
      fileSystem.readdir = originalReaddir
      await Promise.allSettled(grants)
    }

    for (const filePath of selected) {
      const result = await context.service.readFile({ path: filePath, encoding: 'utf8' }, mainCaller)
      assert.equal(result.content, path.basename(filePath))
    }
  } finally {
    await dispose(context)
  }
})

test('space and OS permission failures retain public actionable codes without private paths', () => {
  for (const [code, expected] of [['ENOSPC', errorCodes.diskFull], ['EACCES', errorCodes.permissionDenied], ['EPERM', errorCodes.permissionDenied]]) {
    const error = fileFailure(Object.assign(new Error('private/source/name'), { code }))
    assert.equal(error.code, expected)
    assert.equal(error.message.includes('private'), false)
  }
})

test('native drop grants only its sender, deduplicates files and reports invalid items', async () => {
  const context = await createContext()
  try {
    const source = path.join(context.root, 'dropped.txt')
    await fs.writeFile(source, 'native-drop')
    const sender: CallerIdentity = { type: 'plugin', pluginId: 'drop-plugin', pluginInstanceId: 'a', webContentsId: 7 }
    const other: CallerIdentity = { ...sender, pluginInstanceId: 'b', webContentsId: 8 }
    const identities = new Map([[7, sender], [8, other]])
    const sent: Array<{ id: number; payload: unknown }> = []
    const drop = new FileDropService({ get: id => identities.get(id), send: (id, _channel, payload) => { sent.push({ id, payload }); return true } }, context.service)
    const result = await drop.accept(7, [source, source, context.root, 42])
    assert.deepEqual(result, { success: true, accepted: 1, rejected: 2 })
    assert.deepEqual(sent.map(item => item.id), [7])
    const envelope = (sent[0]!.payload as { msgData: { envelope: { payload: { files: string[]; errors: unknown[] } } } }).msgData.envelope
    assert.deepEqual(envelope.payload.files, [await fs.realpath(source)])
    assert.equal(envelope.payload.errors.length, 2)
    assert.equal((await context.service.readFile({ path: source, encoding: 'utf8' }, sender)).content, 'native-drop')
    await assert.rejects(context.service.readFile({ path: source, encoding: 'utf8' }, other), (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
    const overflow = await drop.accept(7, { overflowCount: 150 })
    assert.deepEqual(overflow, { success: true, accepted: 0, rejected: 150 })
    await assert.rejects(drop.accept(99, [source]), (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
  } finally { await dispose(context) }
})

test('drop rejects a closed sender after asynchronous granting and does not emit to another instance', async () => {
  const context = await createContext()
  try {
    const source = path.join(context.root, 'closing.txt')
    await fs.writeFile(source, 'unchanged')
    const sender: CallerIdentity = { type: 'plugin', pluginId: 'drop-plugin', pluginInstanceId: 'a', webContentsId: 7 }
    let current: CallerIdentity | undefined = sender
    let sends = 0
    const drop = new FileDropService({ get: () => current, send: () => { sends += 1; return true } }, {
      async grantOpenPath(value, caller) {
        await context.service.grantOpenPath(value, caller)
        current = undefined
        context.remove(caller.webContentsId)
        return undefined
      }
    })
    await assert.rejects(drop.accept(7, [source]), (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied)
    assert.equal(sends, 0)
    assert.equal(await fs.readFile(source, 'utf8'), 'unchanged')
  } finally { await dispose(context) }
})

test('reads large files in bounded chunks', async () => {
  const context = await createContext()
  try {
    const selected = path.join(context.root, 'large.bin')
    const source = Buffer.alloc(2 * 1024 * 1024 + 37)
    for (let index = 0; index < source.length; index += 1) source[index] = index % 251
    await fs.writeFile(selected, source)
    await context.service.grantOpenPath(selected, mainCaller)

    const first = await context.service.readFileChunk(
      { path: selected, offset: 0, length: 4 * 1024 * 1024 },
      mainCaller
    )
    assert.equal(first.size, 2 * 1024 * 1024)
    assert.equal(first.totalSize, source.length)
    const second = await context.service.readFileChunk(
      { path: selected, offset: first.size, length: 2 * 1024 * 1024 },
      mainCaller
    )
    assert.equal(second.size, 37)
    assert.deepEqual(
      Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(second.content, 'base64')]),
      source
    )
  } finally {
    await dispose(context)
  }
})

test('writes chunks sequentially and commits only after the complete stream', async () => {
  const context = await createContext()
  try {
    const selected = path.join(context.root, 'stream.txt')
    await fs.writeFile(selected, 'old')
    await context.service.grantSavePath(selected, mainCaller)
    const started = await context.service.startWrite({ path: selected, totalSize: 11 }, mainCaller)
    const temporary = (await fs.readdir(context.root)).find((name) => name.endsWith('.tmp'))
    assert.ok(temporary)
    await context.service.writeChunk({
      handle: started.handle,
      offset: 0,
      content: Buffer.from('hello ').toString('base64')
    }, mainCaller)
    assert.equal(await fs.readFile(selected, 'utf8'), 'old')
    await assert.rejects(
      context.service.writeChunk({
        handle: started.handle,
        offset: 1,
        content: Buffer.from('world').toString('base64')
      }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    await assert.rejects(
      context.service.finishWrite(started.handle, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
    await context.service.writeChunk({
      handle: started.handle,
      offset: 6,
      content: Buffer.from('world').toString('base64')
    }, mainCaller)
    assert.deepEqual(await context.service.finishWrite(started.handle, mainCaller), { success: true, size: 11 })
    assert.equal(await fs.readFile(selected, 'utf8'), 'hello world')
    assert.equal(await fs.access(path.join(context.root, temporary as string)).then(() => true, () => false), false)
  } finally {
    await dispose(context)
  }
})

test('cleans cancelled, expired, zero-byte and renderer-destroyed write sessions', async () => {
  let clock = 1_000
  const context = await createContext(() => clock)
  try {
    const cancelled = path.join(context.root, 'cancelled.bin')
    await context.service.grantSavePath(cancelled, mainCaller)
    const cancelledHandle = await context.service.startWrite({ path: cancelled, totalSize: 1 }, mainCaller)
    await context.service.cancelWrite(cancelledHandle.handle, mainCaller)
    assert.equal((await fs.readdir(context.root)).some((name) => name.endsWith('.tmp')), false)

    const zero = path.join(context.root, 'zero.bin')
    await context.service.grantSavePath(zero, mainCaller)
    const zeroHandle = await context.service.startWrite({ path: zero, totalSize: 0 }, mainCaller)
    assert.deepEqual(await context.service.finishWrite(zeroHandle.handle, mainCaller), { success: true, size: 0 })
    assert.equal((await fs.stat(zero)).size, 0)

    const expired = path.join(context.root, 'expired.bin')
    await context.service.grantSavePath(expired, mainCaller)
    const expiredHandle = await context.service.startWrite({ path: expired, totalSize: 1 }, mainCaller)
    clock += 10 * 60 * 1000
    await assert.rejects(
      context.service.writeChunk({
        handle: expiredHandle.handle,
        offset: 0,
        content: 'eA=='
      }, mainCaller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.requestTimeout
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    const destroyed = path.join(context.root, 'destroyed.bin')
    await context.service.grantSavePath(destroyed, mainCaller)
    await context.service.startWrite({ path: destroyed, totalSize: 1 }, mainCaller)
    context.remove(mainCaller.webContentsId)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    assert.equal((await fs.readdir(context.root)).some((name) => name.endsWith('.tmp')), false)
  } finally {
    await dispose(context)
  }
})
