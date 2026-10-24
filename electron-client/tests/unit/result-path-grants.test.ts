import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { WebContents } from 'electron'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import {
  authorizeIpcRequest,
  grantProcessPathsForCaller,
  grantResultsForCaller,
  grantSearchResultsForCaller,
  resolveFileSearchTarget,
  searchFilesForCaller
} from '../../src/main/ipc/router.js'
import {
  createBundledManifestReader,
  DeclarativePluginAttributionService
} from '../../src/main/services/declarative-plugin-attribution-service.js'
import { FileSearchService } from '../../src/main/services/file-search-service.js'
import {
  defaultProtectedTrashRoots,
  FileSystemService,
  resultGrantKey
} from '../../src/main/services/file-system-service.js'
import { PluginInstallService } from '../../src/main/services/plugin-install-service.js'
import { PluginStateService } from '../../src/main/services/plugin-state-service.js'
import { ShellService, type ShellAdapter } from '../../src/main/services/shell-service.js'
import { SidecarManager } from '../../src/main/services/sidecar-manager.js'
import { SystemService, type SystemAdapter } from '../../src/main/services/system-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class FakeWebContents extends EventEmitter {
  #destroyed = false
  readonly session = {}
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.#destroyed }
  getURL(): string { return 'ztools://web/index.html' }
  send(): void {}
  destroy(): void {
    this.#destroyed = true
    this.emit('destroyed')
  }
}

const CURRENT_TARGET = {
  id: 'current', platform: process.platform === 'darwin' ? 'macos' : 'windows', runtime: 'electron', arch: process.arch
}

function codeOf(code: string) {
  return (error: unknown) => error instanceof ZToolsError && error.code === code
}
const denied = codeOf(errorCodes.permissionDenied)

async function writePlugin(root: string, id: string, permissions: string[]): Promise<void> {
  const dir = path.join(root, id)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'dist', 'index.js'), 'exports.default = () => null\n')
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', entry: 'dist/index.js', targets: [CURRENT_TARGET], nativeComponents: [], permissions
  }))
}

interface Harness {
  root: string
  data: string
  protectedDir: string
  registry: WindowRegistry
  files: FileSystemService
  shell: ShellService
  shellCalls: Array<{ method: string; value?: string }>
  attribution: DeclarativePluginAttributionService
  main: FakeWebContents
  mainCaller: CallerIdentity
  clock: { now: number }
  window(id: number): { contents: FakeWebContents; caller: CallerIdentity }
  /** 走与 IpcRouter.#handleLegacy 相同的「解析信封 → 登记身份 → 会话归属 → 鉴权 → 参数校验」管线 */
  admit(sender: FakeWebContents, method: string, params: unknown, pluginSession?: string): CallerIdentity
  session(pluginId: string, caller?: CallerIdentity): Promise<string>
  dispose(): Promise<void>
}

let sequence = 0

async function createHarness(): Promise<Harness> {
  // macOS 的临时目录在 /var 下（指向 /private/var 的系统链接），按真实路径断言
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-result-grants-')))
  const data = path.join(root, 'data')
  const protectedDir = path.join(root, 'host-user-data')
  await fs.mkdir(data, { recursive: true })
  await fs.mkdir(protectedDir, { recursive: true })
  const webRoot = path.join(root, 'web')
  await fs.mkdir(path.join(webRoot, 'bundled-plugins'), { recursive: true })
  await writePlugin(path.join(root, 'Plugins'), 'cleaner', ['fs'])
  await writePlugin(path.join(root, 'Plugins'), 'other-cleaner', ['fs'])
  await writePlugin(path.join(root, 'Plugins'), 'viewer', ['clipboard'])
  const state = new PluginStateService(root)
  const plugins = new PluginInstallService(root, { publish() {} } as never, { state })
  const registry = new WindowRegistry()
  const quiet = { info() {}, warn() {}, error() {} }
  const attribution = new DeclarativePluginAttributionService(registry, {
    readBundled: createBundledManifestReader(webRoot),
    readInstalled: pluginId => plugins.withPluginManifest(pluginId, async manifest => manifest),
    isRevoked: pluginId => plugins.isRevoked(pluginId)
  }, { log: quiet })
  const clock = { now: Date.now() }
  const files = new FileSystemService(registry, path.join(root, 'cache'), () => clock.now, undefined, {
    protectedTrashRoots: [protectedDir]
  })
  const shellCalls: Array<{ method: string; value?: string }> = []
  const adapter: ShellAdapter = {
    async openPath(value) { shellCalls.push({ method: 'openPath', value }); return '' },
    async trashItem(value) { shellCalls.push({ method: 'trashItem', value }) },
    showItemInFolder(value) { shellCalls.push({ method: 'showItemInFolder', value }) },
    async openExternal(value) { shellCalls.push({ method: 'openExternal', value }) },
    beep() {}
  }
  const window = (id: number) => {
    const contents = new FakeWebContents(id)
    const caller = registry.registerMain(contents as unknown as WebContents)
    return { contents, caller }
  }
  const { contents: main, caller: mainCaller } = window(1)
  const harness: Harness = {
    root, data, protectedDir, registry, files, shell: new ShellService(files, adapter), shellCalls,
    attribution, main, mainCaller, clock, window,
    admit(sender, method, params, pluginSession) {
      sequence += 1
      const request = parseRequest({
        messageId: `grant-${sequence}`, method, params, ...(pluginSession ? { pluginSession } : {})
      })
      let caller = registry.get(sender.id)
      if (!caller) throw new ZToolsError(errorCodes.permissionDenied, '调用者未注册')
      caller = attribution.attributeCaller(caller, request)
      authorizeIpcRequest(caller, request, sender)
      validateMethodParams(request.method, request.params)
      return caller
    },
    async session(pluginId, caller = mainCaller) {
      return (await attribution.open(caller, { pluginId })).data.token
    },
    async dispose() {
      attribution.stop()
      await files.stop()
      await plugins.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  }
  return harness
}

async function touch(file: string, content = 'x'): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

function trashCalls(h: Harness): string[] {
  return h.shellCalls.filter(call => call.method === 'trashItem').map(call => call.value ?? '')
}

test('结果授权：精确命中只读、目录不递归、不能写入，别的窗口与插件窗口拿不到', async () => {
  const h = await createHarness()
  try {
    const folder = path.join(h.data, 'folder')
    const file = await touch(path.join(h.data, 'found.txt'), 'found')
    const child = await touch(path.join(folder, 'child.txt'))
    const sibling = await touch(path.join(h.data, 'sibling.txt'))
    const summary = await h.files.grantResultPaths(h.mainCaller, [
      { path: file, isDir: false },
      { path: folder, isDir: true }
    ], 'search')
    assert.deepEqual(summary, { granted: 2, skipped: 0 })

    assert.equal((await h.files.readFile({ path: file, encoding: 'utf8' }, h.mainCaller)).content, 'found')
    const listing = await h.files.getDirectoryContents({ path: folder }, h.mainCaller)
    assert.deepEqual(listing.files.map(item => item.name), ['child.txt'])
    await assert.rejects(h.files.readFile({ path: child, encoding: 'utf8' }, h.mainCaller), denied)
    await assert.rejects(h.files.readFile({ path: sibling, encoding: 'utf8' }, h.mainCaller), denied)
    await assert.rejects(h.files.writeFile({ path: file, content: 'overwrite', encoding: 'utf8' }, h.mainCaller), denied)
    await assert.rejects(h.files.deleteFile({ path: file }, h.mainCaller), denied)
    assert.equal(await fs.readFile(file, 'utf8'), 'found')

    const { caller: second } = h.window(2)
    await assert.rejects(h.files.readFile({ path: file, encoding: 'utf8' }, second), denied)

    // 插件窗口（以及冒充归属的插件窗口身份）既不能接收结果授权，也不能借主窗口的结果授权
    const forgedPlugin: CallerIdentity = {
      type: 'plugin', webContentsId: 1, pluginId: 'cleaner',
      attributedPlugin: { pluginId: 'cleaner', sessionId: 'ds_xxxxxxxxxxxxxxxx', permissions: new Set(['fs']), source: 'installed' }
    }
    await assert.rejects(h.files.grantResultPaths(forgedPlugin, [{ path: sibling, isDir: false }], 'search'), denied)
    await grantResultsForCaller(h.files, forgedPlugin, [{ path: sibling, isDir: false }], 'search')
    await assert.rejects(h.files.readFile({ path: sibling, encoding: 'utf8' }, h.mainCaller), denied)
  } finally {
    await h.dispose()
  }
})

test('符号链接结果不登记：链接目标不会因此可读；真实文件本身被扫出时照常授权，回收站不跟随链接', async () => {
  const h = await createHarness()
  try {
    const outside = await touch(path.join(h.root, 'outside', 'secret.txt'), 'secret')
    const link = path.join(h.data, 'link.txt')
    await fs.symlink(outside, link)
    const token = await h.session('cleaner')
    const cleaner = h.admit(h.main, 'shell_trash_item', { fullPath: link }, token)
    assert.equal(cleaner.attributedPlugin?.pluginId, 'cleaner')

    for (const source of ['dir-scan', 'search', 'screenshot'] as const) {
      assert.deepEqual(await h.files.grantResultPaths(cleaner, [{ path: link, isDir: false }], source), { granted: 0, skipped: 1 })
    }
    await assert.rejects(h.files.readFile({ path: link, encoding: 'utf8' }, cleaner), denied)
    await assert.rejects(h.files.readFile({ path: outside, encoding: 'utf8' }, cleaner), denied)
    await assert.rejects(h.shell.openPath({ fullPath: outside }, cleaner), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: link }, cleaner), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: outside }, cleaner), denied)

    // 真实文件本身被扫出时可以读和回收，但请求路径是链接时回收仍拒绝（否则移走的是链接目标）
    await h.files.grantResultPaths(cleaner, [{ path: outside, isDir: false }], 'dir-scan')
    assert.equal((await h.files.readFile({ path: outside, encoding: 'utf8' }, cleaner)).content, 'secret')
    await assert.rejects(h.shell.trashItem({ fullPath: link }, cleaner), denied)
    assert.deepEqual(await h.shell.trashItem({ fullPath: outside }, cleaner), { success: true })
    assert.deepEqual(trashCalls(h), [outside])
  } finally {
    await h.dispose()
  }
})

test('dir: 扫描经由目录里的符号链接（文件链接 / 目录链接）不会让扫描根之外的真实目标可读或可打开', async t => {
  const h = await createHarness()
  const sidecars = new SidecarManager()
  t.mock.method(console, 'warn', () => {})
  try {
    const secretFile = await touch(path.join(h.root, 'private', 'id_rsa'), 'PRIVATE KEY')
    const secretDir = path.join(h.root, 'private-dir')
    const secretChild = await touch(path.join(secretDir, 'notes.txt'), 'hidden')
    const scanRoot = path.join(h.data, 'linkdir')
    const plain = await touch(path.join(scanRoot, 'plain.txt'), 'plain')
    await fs.symlink(secretFile, path.join(scanRoot, 'key-link'))
    await fs.symlink(secretDir, path.join(scanRoot, 'dir-link'))
    const viaDirLink = path.join(scanRoot, 'dir-link', 'notes.txt')
    // 扫描根本身经由链接（类似 macOS 的 /tmp → /private/tmp）时，根之内的真实文件照常授权
    const rootLink = path.join(h.root, 'root-link')
    await fs.symlink(scanRoot, rootLink)

    for (const query of [`dir:${scanRoot}`, `dir:${rootLink}`]) {
      const token = await h.session('cleaner')
      const cleaner = h.admit(h.main, 'system_search_files', { query, limit: 200 }, token)
      const result = await searchFilesForCaller({ query, limit: 200 }, cleaner, sidecars, h.files)
      // 扫描本身仍会列出链接与经由目录链接看到的文件（展示行为不变）
      const listed = result.files.map(file => file.path)
      assert.ok(listed.some(item => item.endsWith('notes.txt')), `扫描结果应包含经由目录链接的文件: ${listed.join(',')}`)

      assert.equal((await h.files.readFile({ path: query === `dir:${scanRoot}` ? plain : path.join(rootLink, 'plain.txt'), encoding: 'utf8' }, cleaner)).content, 'plain')
      for (const target of [secretFile, path.join(scanRoot, 'key-link'), secretDir, path.join(scanRoot, 'dir-link'), secretChild, viaDirLink]) {
        await assert.rejects(h.files.readFile({ path: target, encoding: 'utf8' }, cleaner), denied, target)
        await assert.rejects(h.shell.openPath({ fullPath: target }, cleaner), denied, target)
        await assert.rejects(h.shell.trashItem({ fullPath: target }, cleaner), denied, target)
      }
    }
    // 扫描根已不存在：任何结果都不登记
    assert.deepEqual(
      await h.files.grantResultPaths(h.mainCaller, [{ path: plain, isDir: false }], 'dir-scan', { scanRoot: path.join(h.root, 'gone') }),
      { granted: 0, skipped: 1 }
    )
    assert.deepEqual(
      await h.files.grantResultPaths(h.mainCaller, [{ path: plain, isDir: false }], 'dir-scan', { scanRoot: 'relative/root' }),
      { granted: 0, skipped: 1 }
    )
    assert.deepEqual(trashCalls(h), [])
  } finally {
    await sidecars.stop()
    await h.dispose()
  }
})

test('结果授权归属产生结果的插件：别的插件（带自己的令牌或不带令牌）读不到；宿主自身的结果同窗口都能读', async t => {
  const h = await createHarness()
  const sidecars = new SidecarManager()
  t.mock.method(console, 'warn', () => {})
  try {
    const scanRoot = path.join(h.data, 'owned')
    const owned = await touch(path.join(scanRoot, 'movie.mp4'), 'movie')
    const hostFound = await touch(path.join(h.data, 'host-found.txt'), 'host')
    const cleaner = h.admit(h.main, 'system_search_files', { query: `dir:${scanRoot}` }, await h.session('cleaner'))
    const readParams = { path: owned, encoding: 'utf8' }
    const viewer = h.admit(h.main, 'filesystem_read_file', readParams, await h.session('viewer'))
    const unattributed = h.admit(h.main, 'filesystem_read_file', readParams)
    const forged = h.admit(h.main, 'filesystem_read_file', readParams, randomBytes(32).toString('base64url'))
    assert.equal(viewer.attributedPlugin?.pluginId, 'viewer')
    assert.equal(forged.attributedPlugin, undefined)

    await searchFilesForCaller({ query: `dir:${scanRoot}` }, cleaner, sidecars, h.files)
    assert.equal((await h.files.readFile({ path: owned, encoding: 'utf8' }, cleaner)).content, 'movie')
    for (const caller of [viewer, unattributed, forged]) {
      await assert.rejects(h.files.readFile({ path: owned, encoding: 'utf8' }, caller), denied)
      await assert.rejects(h.shell.openPath({ fullPath: owned }, caller), denied)
      await assert.rejects(h.shell.showItemInFolder({ fullPath: owned }, caller), denied)
      await assert.rejects(resolveFileSearchTarget(h.files, { path: owned }, caller), denied)
    }
    // 同一插件的新会话照常可用（按插件而不是会话绑定）
    const reopened = h.admit(h.main, 'filesystem_read_file', readParams, await h.session('cleaner'))
    assert.equal((await h.files.readFile({ path: owned, encoding: 'utf8' }, reopened)).content, 'movie')

    // 宿主界面（未归属）产生的结果：同窗口里宿主与任何插件都能读（与 42d5de0 一致），但不能回收
    await h.files.grantResultPaths(unattributed, [{ path: hostFound, isDir: false }], 'search')
    for (const caller of [unattributed, viewer, cleaner]) {
      assert.equal((await h.files.readFile({ path: hostFound, encoding: 'utf8' }, caller)).content, 'host')
    }
    await assert.rejects(h.shell.trashItem({ fullPath: hostFound }, cleaner), denied)

    // 两个插件扫描同一路径各自持有：一方重新扫描不影响另一方
    const other = h.admit(h.main, 'system_search_files', { query: `dir:${scanRoot}` }, await h.session('other-cleaner'))
    await searchFilesForCaller({ query: `dir:${scanRoot}` }, other, sidecars, h.files)
    assert.deepEqual(await h.shell.trashItem({ fullPath: owned }, cleaner), { success: true })
    assert.deepEqual(await h.shell.trashItem({ fullPath: owned }, other), { success: true })
    // 宿主重新扫描同一路径（不属于任何插件）也不会把插件的回收站权限转给宿主
    await searchFilesForCaller({ query: `dir:${scanRoot}` }, unattributed, sidecars, h.files)
    await assert.rejects(h.shell.trashItem({ fullPath: owned }, unattributed), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: owned }, viewer), denied)
  } finally {
    await sidecars.stop()
    await h.dispose()
  }
})

test('结果授权的回收站放行：五个条件逐一缺失都拒绝，普通 write 授权的回收行为不变', async () => {
  const h = await createHarness()
  try {
    const cleanerToken = await h.session('cleaner')
    const cleaner = h.admit(h.main, 'shell_trash_item', { fullPath: '/x' }, cleanerToken)
    const viewer = h.admit(h.main, 'shell_trash_item', { fullPath: '/x' }, await h.session('viewer'))
    const other = h.admit(h.main, 'shell_trash_item', { fullPath: '/x' }, await h.session('other-cleaner'))
    const unattributed = h.admit(h.main, 'shell_trash_item', { fullPath: '/x' })
    assert.equal(unattributed.attributedPlugin, undefined)

    // 1. 来源不是搜索 / dir: 扫描
    const fromProcess = await touch(path.join(h.data, 'process.bin'))
    await h.files.grantResultPaths(cleaner, [{ path: fromProcess, isDir: false }], 'process')
    await assert.rejects(h.shell.trashItem({ fullPath: fromProcess }, cleaner), denied)
    // 2. 结果标成目录 / 实际是目录（结果里谎报 is_dir:false 也会被 lstat 拦下）
    const markedDir = await touch(path.join(h.data, 'marked-dir.txt'))
    const realDir = path.join(h.data, 'real-dir')
    await fs.mkdir(realDir)
    await h.files.grantResultPaths(cleaner, [{ path: markedDir, isDir: true }, { path: realDir, isDir: false }], 'dir-scan')
    await assert.rejects(h.shell.trashItem({ fullPath: markedDir }, cleaner), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: realDir }, cleaner), denied)
    // 3. 产生结果时未归属 / 归属插件没有 fs；回收时换成别的插件 / 宿主身份
    const byHost = await touch(path.join(h.data, 'by-host.txt'))
    const byViewer = await touch(path.join(h.data, 'by-viewer.txt'))
    const byCleaner = await touch(path.join(h.data, 'by-cleaner.txt'))
    await h.files.grantResultPaths(unattributed, [{ path: byHost, isDir: false }], 'search')
    await h.files.grantResultPaths(viewer, [{ path: byViewer, isDir: false }], 'search')
    await h.files.grantResultPaths(cleaner, [{ path: byCleaner, isDir: false }], 'search')
    await assert.rejects(h.shell.trashItem({ fullPath: byHost }, cleaner), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: byViewer }, viewer), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: byCleaner }, other), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: byCleaner }, unattributed), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: byCleaner }, viewer), denied)
    // 4. 系统 / 宿主数据目录
    const inProtected = await touch(path.join(h.protectedDir, 'config.json'))
    await h.files.grantResultPaths(cleaner, [{ path: inProtected, isDir: false }], 'dir-scan')
    await assert.rejects(h.shell.trashItem({ fullPath: inProtected }, cleaner), denied)
    // 只读能力不受影响
    assert.equal((await h.files.readFile({ path: inProtected, encoding: 'utf8' }, cleaner)).content, 'x')
    // 5. 授权后文件被换成目录（执行时重新核对）
    const swapped = await touch(path.join(h.data, 'swapped.txt'))
    await h.files.grantResultPaths(cleaner, [{ path: swapped, isDir: false }], 'dir-scan')
    await fs.rm(swapped)
    await fs.mkdir(swapped)
    await assert.rejects(h.shell.trashItem({ fullPath: swapped }, cleaner), denied)
    assert.deepEqual(trashCalls(h), [])

    // 满足全部条件：同一插件的新会话也可以（按插件而不是会话绑定）
    assert.deepEqual(await h.shell.trashItem({ fullPath: byCleaner }, cleaner), { success: true })
    const reopened = h.admit(h.main, 'shell_trash_item', { fullPath: '/x' }, await h.session('cleaner'))
    const second = await touch(path.join(h.data, 'second.txt'))
    await h.files.grantResultPaths(cleaner, [{ path: second, isDir: false }], 'search')
    assert.deepEqual(await h.shell.trashItem({ fullPath: second }, reopened), { success: true })
    // 普通 write 授权（保存对话框）仍可回收，且不需要归属
    const saved = await touch(path.join(h.data, 'saved.txt'))
    await h.files.grantSavePath(saved, unattributed)
    assert.deepEqual(await h.shell.trashItem({ fullPath: saved }, unattributed), { success: true })
    assert.deepEqual(trashCalls(h), [byCleaner, second, saved])
  } finally {
    await h.dispose()
  }
})

test('结果授权表：每窗口 20,000 条淘汰最旧、30 分钟过期、窗口销毁清空，查表不随条目数线性变慢', { timeout: 120_000 }, async () => {
  const h = await createHarness()
  try {
    const bulk = path.join(h.data, 'bulk')
    await fs.mkdir(bulk)
    const paths = Array.from({ length: 20_001 }, (_, index) => path.join(bulk, `f${index}.txt`))
    for (let index = 0; index < paths.length; index += 500) {
      await Promise.all(paths.slice(index, index + 500).map(file => fs.writeFile(file, '')))
    }
    // 单次调用超过上限：只按结果顺序登记前 20,000 条
    const { caller: overflow } = h.window(8)
    const once = await h.files.grantResultPaths(overflow, paths.map(p => ({ path: p, isDir: false })), 'search')
    assert.deepEqual(once, { granted: 20_000, skipped: 1 })
    await assert.rejects(h.files.getFileSize({ path: paths[20_000]! }, overflow), denied)
    await h.files.getFileSize({ path: paths[19_999]! }, overflow)
    // 先登记第 0 条，再登记 20,000 条：表满后最旧的第 0 条被淘汰
    await h.files.grantResultPaths(h.mainCaller, [{ path: paths[0]!, isDir: false }], 'search')
    await h.files.grantResultPaths(h.mainCaller, paths.slice(1).map(p => ({ path: p, isDir: false })), 'search')
    await assert.rejects(h.files.getFileSize({ path: paths[0]! }, h.mainCaller), denied)
    await h.files.getFileSize({ path: paths[1]! }, h.mainCaller)
    await h.files.getFileSize({ path: paths[20_000]! }, h.mainCaller)
    // 重复登记把条目移到最近位置：再登记第 1 条后加入新条目，被淘汰的是第 2 条而不是第 1 条
    await h.files.grantResultPaths(h.mainCaller, [{ path: paths[1]!, isDir: false }], 'search')
    await h.files.grantResultPaths(h.mainCaller, [{ path: paths[0]!, isDir: false }], 'search')
    await h.files.getFileSize({ path: paths[1]! }, h.mainCaller)
    await assert.rejects(h.files.getFileSize({ path: paths[2]! }, h.mainCaller), denied)

    // 性能：满表时 1,000 次校验与只有少量授权时同一量级（线性逐条异步比较会慢上千倍）
    const sample = paths.slice(10_000, 11_000)
    const time = async (caller: CallerIdentity) => {
      const started = performance.now()
      for (const target of sample) await h.files.resolveAuthorizedPath(target, caller, 'read', false)
      return performance.now() - started
    }
    const { caller: small } = h.window(9)
    await h.files.grantResultPaths(small, sample.map(p => ({ path: p, isDir: false })), 'search')
    await time(small)
    const baseline = await time(small)
    const full = await time(h.mainCaller)
    assert.ok(full < baseline * 3 + 100, `满表 ${full.toFixed(1)}ms，基线 ${baseline.toFixed(1)}ms`)

    // TTL
    const ttlFile = await touch(path.join(h.data, 'ttl.txt'))
    await h.files.grantResultPaths(h.mainCaller, [{ path: ttlFile, isDir: false }], 'search')
    h.clock.now += 30 * 60 * 1000 - 1
    await h.files.getFileSize({ path: ttlFile }, h.mainCaller)
    h.clock.now += 2
    await assert.rejects(h.files.getFileSize({ path: ttlFile }, h.mainCaller), denied)

    // 窗口销毁：已有授权失效，登记中的授权失败
    await h.files.grantResultPaths(h.mainCaller, [{ path: ttlFile, isDir: false }], 'search')
    const pending = h.files.grantResultPaths(h.mainCaller, paths.slice(0, 200).map(p => ({ path: p, isDir: false })), 'search')
    h.main.destroy()
    await assert.rejects(pending, denied)
    await assert.rejects(h.files.getFileSize({ path: ttlFile }, h.mainCaller), denied)
    await assert.rejects(h.files.grantResultPaths(h.mainCaller, [{ path: ttlFile, isDir: false }], 'search'), denied)
  } finally {
    await h.dispose()
  }
})

test('非法与超大输入只跳过不报错，并发登记互不覆盖', { timeout: 60_000 }, async () => {
  const h = await createHarness()
  try {
    const good = await touch(path.join(h.data, 'good.txt'))
    const summary = await h.files.grantResultPaths(h.mainCaller, [
      { path: '', isDir: false },
      { path: 'relative/file.txt', isDir: false },
      { path: `${h.data}/nul\u0000.txt`, isDir: false },
      { path: 42 as unknown as string, isDir: false },
      null as unknown as { path: string; isDir: boolean },
      { path: path.join(h.data, 'missing.txt'), isDir: false },
      { path: good, isDir: false },
      { path: good, isDir: false }
    ], 'search')
    assert.deepEqual(summary, { granted: 1, skipped: 6 })
    await h.files.getFileSize({ path: good }, h.mainCaller)

    // 25,000 条不存在的路径：有界时间内全部跳过
    const started = performance.now()
    const huge = await h.files.grantResultPaths(h.mainCaller,
      Array.from({ length: 25_000 }, (_, index) => ({ path: path.join(h.data, 'gone', `${index}.txt`), isDir: false })), 'search')
    assert.deepEqual(huge, { granted: 0, skipped: 25_000 })
    assert.ok(performance.now() - started < 30_000)

    // 并发登记两批，交替完成后两批都可用
    const batchA = await Promise.all(Array.from({ length: 40 }, (_, i) => touch(path.join(h.data, 'a', `${i}.txt`))))
    const batchB = await Promise.all(Array.from({ length: 40 }, (_, i) => touch(path.join(h.data, 'b', `${i}.txt`))))
    await Promise.all([
      h.files.grantResultPaths(h.mainCaller, batchA.map(p => ({ path: p, isDir: false })), 'search'),
      h.files.grantResultPaths(h.mainCaller, batchB.map(p => ({ path: p, isDir: false })), 'dir-scan'),
      h.files.grantResultPaths(h.mainCaller, batchA.slice(0, 10).map(p => ({ path: p, isDir: false })), 'process')
    ])
    for (const target of [...batchA, ...batchB]) await h.files.getFileSize({ path: target }, h.mainCaller)
  } finally {
    await h.dispose()
  }
})

test('dir: 扫描集成：真实目录扫描 → 文件可打开 / 定位 / 由扫描它的插件移入回收站，子目录可列不可回收', async t => {
  const h = await createHarness()
  const sidecars = new SidecarManager()
  const warn = t.mock.method(console, 'warn', () => {})
  try {
    const scanRoot = path.join(h.data, 'scan')
    const top = await touch(path.join(scanRoot, 'big.log'), 'a'.repeat(64))
    const nested = await touch(path.join(scanRoot, 'sub', 'nested.tmp'), 'b'.repeat(32))
    const outsideScan = await touch(path.join(h.data, 'not-scanned.txt'))
    const token = await h.session('cleaner')
    const cleaner = h.admit(h.main, 'system_search_files', { query: `dir:${scanRoot}`, limit: 200 }, token)

    const result = await searchFilesForCaller({ query: `dir:${scanRoot}`, limit: 200 }, cleaner, sidecars, h.files)
    assert.deepEqual(result.files.map(file => file.path).sort(), [top, nested].sort())
    assert.deepEqual(result.subdirs?.map(dir => dir.path), [path.join(scanRoot, 'sub')])
    assert.equal(warn.mock.callCount(), 0)

    assert.deepEqual(await h.shell.openPath({ fullPath: top }, cleaner), { success: true })
    assert.deepEqual(await h.shell.showItemInFolder({ fullPath: nested }, cleaner), { success: true })
    assert.deepEqual(await h.shell.openPath({ fullPath: path.join(scanRoot, 'sub') }, cleaner), { success: true })
    await assert.rejects(h.shell.trashItem({ fullPath: path.join(scanRoot, 'sub') }, cleaner), denied)
    await assert.rejects(h.shell.openPath({ fullPath: outsideScan }, cleaner), denied)
    assert.deepEqual(await h.shell.trashItem({ fullPath: nested }, cleaner), { success: true })
    assert.deepEqual(await h.shell.trashItem({ fullPath: top }, cleaner), { success: true })

    // 不带令牌（宿主身份）或伪造令牌的同一窗口：只读，不能回收
    const host = h.admit(h.main, 'system_search_files', { query: `dir:${scanRoot}` })
    const forged = h.admit(h.main, 'system_search_files', { query: `dir:${scanRoot}` }, randomBytes(32).toString('base64url'))
    assert.equal(forged.attributedPlugin, undefined)
    await searchFilesForCaller({ query: `dir:${scanRoot}` }, host, sidecars, h.files)
    await assert.rejects(h.shell.trashItem({ fullPath: top }, host), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: top }, forged), denied)
    // 宿主身份的再次扫描（不属于任何插件）不收回插件扫描得到的回收站权限，也不转给宿主
    assert.deepEqual(await h.shell.trashItem({ fullPath: top }, cleaner), { success: true })
    // 另一个有 fs 的插件重新扫描：各自持有自己的结果授权，两个插件都能回收
    const otherToken = await h.session('other-cleaner')
    const other = h.admit(h.main, 'system_search_files', { query: `dir:${scanRoot}` }, otherToken)
    await searchFilesForCaller({ query: `dir:${scanRoot}` }, other, sidecars, h.files)
    assert.deepEqual(await h.shell.trashItem({ fullPath: top }, cleaner), { success: true })
    assert.deepEqual(await h.shell.trashItem({ fullPath: top }, other), { success: true })
    // 文件变成符号链接后重新扫描：链接结果不登记，链接与其目标都不能回收
    const outside = await touch(path.join(h.data, 'outside-scan.txt'))
    await fs.rm(top)
    await fs.symlink(outside, top)
    await searchFilesForCaller({ query: `dir:${scanRoot}` }, other, sidecars, h.files)
    await assert.rejects(h.shell.trashItem({ fullPath: top }, other), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: outside }, other), denied)
    await assert.rejects(h.files.readFile({ path: outside, encoding: 'utf8' }, other), denied)
    assert.deepEqual(trashCalls(h), [nested, top, top, top, top])

    // 链接结果被跳过时记过一次 warn
    assert.equal(warn.mock.callCount(), 1)
    // 扫描与登记之间文件被删：跳过并只 warn 一次，其他结果照常授权
    const racing = await touch(path.join(h.data, 'race', 'vanish.txt'))
    const stays = await touch(path.join(h.data, 'race', 'stays.txt'))
    const deletingSidecar = {
      async searchFiles(query: string, limit: number) {
        const scanned = await sidecars.searchFiles(query, limit)
        await fs.rm(racing)
        return scanned
      }
    } as unknown as SidecarManager
    const raced = await searchFilesForCaller({ query: `dir:${path.dirname(racing)}` }, cleaner, deletingSidecar, h.files)
    assert.equal(raced.files.length, 2)
    assert.equal(warn.mock.callCount(), 2)
    assert.deepEqual(await h.shell.trashItem({ fullPath: stays }, cleaner), { success: true })
  } finally {
    await sidecars.stop()
    await h.dispose()
  }
})

test('filesearch_open / reveal / sha256 / quick_look 与 shell_* 一致：只接受已授权路径', async t => {
  const h = await createHarness()
  const sidecars = new SidecarManager()
  t.mock.method(console, 'warn', () => {})
  try {
    const found = await touch(path.join(h.data, 'needle-report.bin'), 'hash me')
    const secret = await touch(path.join(h.data, 'secret.key'), 'private')
    sidecars.setFallbackFiles([found, secret].map(file => ({
      name: path.basename(file), path: file, is_dir: false, size: 1, mtime: 0, acronym: '', pinyin: ''
    })))
    const fileSearch = new FileSearchService({ sidecarManager: sidecars })
    const caller = h.admit(h.main, 'filesearch_sha256', { path: secret })

    // 修复前：任意调用者传任意路径都能读哈希
    await assert.rejects(resolveFileSearchTarget(h.files, { path: secret }, caller), denied)
    await assert.rejects(resolveFileSearchTarget(h.files, { fullPath: found }, caller), denied)

    // 与 filesearch_query handler 相同：查询结果登记给调用窗口
    const result = await fileSearch.search('needle', 10)
    await grantSearchResultsForCaller('needle', result, caller, h.files)
    assert.deepEqual(result.files.map(file => file.path), [found])
    const target = await resolveFileSearchTarget(h.files, { path: found }, caller)
    const sha = await fileSearch.calculateSha256(target)
    assert.equal(sha.success, true)
    assert.equal(sha.sha256, createHash('sha256').update('hash me').digest('hex'))
    assert.equal(await resolveFileSearchTarget(h.files, { fullPath: found }, caller), target)
    await assert.rejects(resolveFileSearchTarget(h.files, { path: secret }, caller), denied)
    // 相对路径按调用窗口的缓存根解析，不会落到已授权文件
    await assert.rejects(resolveFileSearchTarget(h.files, { path: '../secret.key' }, caller),
      (error: unknown) => denied(error) || codeOf(errorCodes.fileError)(error))
    const { caller: other } = h.window(5)
    await assert.rejects(resolveFileSearchTarget(h.files, { path: found }, other), denied)

    // 参数层：未知字段、空路径、超长路径
    assert.throws(() => validateMethodParams('filesearch_open', { path: found, extra: 1 }), codeOf(errorCodes.invalidRequest))
    assert.throws(() => validateMethodParams('filesearch_reveal', { path: '' }), codeOf(errorCodes.invalidRequest))
    assert.throws(() => validateMethodParams('filesearch_sha256', { path: 'a'.repeat(4097) }), codeOf(errorCodes.invalidRequest))
  } finally {
    await sidecars.stop()
    await h.dispose()
  }
})

test('进程路径与截图结果只读授权：可定位 / 打开，不能回收；畸形行被忽略', async t => {
  const h = await createHarness()
  t.mock.method(console, 'warn', () => {})
  try {
    const cleaner = h.admit(h.main, 'process_list', {}, await h.session('cleaner'))
    const exe = await touch(path.join(h.data, 'bin', 'sleepy'))
    await grantProcessPathsForCaller([
      { pid: 10, name: 'sleepy', path: exe },
      { pid: 11, name: 'empty', path: '' },
      { pid: 12, name: 'relative', path: 'bin/sleepy' },
      { pid: 13, name: 'number', path: 5 },
      null,
      'garbage'
    ], cleaner, h.files)
    await grantProcessPathsForCaller({ not: 'an array' }, cleaner, h.files)
    assert.deepEqual(await h.shell.showItemInFolder({ fullPath: exe }, cleaner), { success: true })
    await assert.rejects(h.shell.trashItem({ fullPath: exe }, cleaner), denied)

    const shot = await touch(path.join(h.data, 'Screenshots', 'shot.png'))
    await grantResultsForCaller(h.files, cleaner, [{ path: shot, isDir: false }], 'screenshot')
    assert.deepEqual(await h.shell.openPath({ fullPath: shot }, cleaner), { success: true })
    await assert.rejects(h.shell.trashItem({ fullPath: shot }, cleaner), denied)
    assert.deepEqual(trashCalls(h), [])
  } finally {
    await h.dispose()
  }
})

test('system_list_common_folders：主进程计算各平台常用目录，存在的目录只读不递归授权', async t => {
  const h = await createHarness()
  t.mock.method(console, 'warn', () => {})
  try {
    const home = path.join(h.data, 'home')
    for (const name of ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Movies', 'Library/Caches']) {
      await fs.mkdir(path.join(home, name), { recursive: true })
    }
    const privateFile = await touch(path.join(home, 'Downloads', 'private.txt'))
    const registry = { onRemoved() { return () => {} } } as unknown as WindowRegistry
    const adapter = {
      paths: {
        app: h.root, userData: h.protectedDir, home,
        desktop: path.join(home, 'Desktop'), downloads: path.join(home, 'Downloads'), documents: path.join(home, 'Documents'),
        pictures: path.join(home, 'Pictures'), videos: path.join(home, 'Movies'), music: path.join(home, 'Music'),
        appData: path.join(home, 'Library', 'Application Support')
      }
    } as unknown as SystemAdapter
    const mac = await new SystemService(h.files, registry, adapter, 'darwin').listCommonFolders()
    assert.deepEqual(mac.data.folders.map(folder => folder.id), [
      'home', 'desktop', 'downloads', 'documents', 'pictures', 'videos', 'music', 'appData',
      'applications', 'library', 'libraryCaches', 'temp'
    ])
    const byId = new Map(mac.data.folders.map(folder => [folder.id, folder]))
    assert.equal(byId.get('music')?.exists, false)
    assert.equal(byId.get('libraryCaches')?.path, path.join(home, 'Library', 'Caches'))
    assert.equal(byId.get('temp')?.path, os.tmpdir())
    assert.equal('category' in (byId.get('home') ?? {}), false)

    const win = await new SystemService(h.files, registry, adapter, 'win32')
      .listCommonFolders({ SystemDrive: 'd:', LOCALAPPDATA: 'D:\\Users\\a\\AppData\\Local', TEMP: 'D:\\Temp' })
    assert.deepEqual(win.data.folders.slice(-3).map(folder => [folder.id, folder.path]), [
      ['localAppData', 'D:\\Users\\a\\AppData\\Local'], ['systemDrive', 'D:\\'], ['temp', 'D:\\Temp']
    ])
    const injected = await new SystemService(h.files, registry, adapter, 'win32').listCommonFolders({ SystemDrive: 'C:\\..\\x' })
    assert.equal(injected.data.folders.find(folder => folder.id === 'systemDrive')?.path, 'C:\\')
    const linux = await new SystemService(h.files, registry, adapter, 'linux').listCommonFolders()
    assert.equal(linux.data.folders.at(-1)?.id, 'temp')

    // 与 system_list_common_folders handler 相同：存在的目录登记给调用窗口
    const caller = h.admit(h.main, 'system_list_common_folders', {})
    await grantResultsForCaller(h.files, caller,
      mac.data.folders.filter(folder => folder.exists).map(folder => ({ path: folder.path, isDir: true })), 'common-folder')
    assert.deepEqual(await h.shell.openPath({ fullPath: path.join(home, 'Downloads') }, caller), { success: true })
    assert.deepEqual(await h.shell.openPath({ fullPath: path.join(home, 'Library', 'Caches') }, caller), { success: true })
    await assert.rejects(h.shell.openPath({ fullPath: privateFile }, caller), denied)
    await assert.rejects(h.shell.trashItem({ fullPath: path.join(home, 'Downloads') }, caller), denied)

    // 契约：无参数、主窗口与插件窗口都可调用
    validateMethodParams('system_list_common_folders', {})
    assert.throws(() => validateMethodParams('system_list_common_folders', { path: '/' }), codeOf(errorCodes.invalidRequest))
    assert.equal(canCall('system_list_common_folders', h.mainCaller), true)
    assert.equal(canCall('system_list_common_folders', { type: 'plugin', webContentsId: 3, pluginId: 'quick-folders' }), true)
  } finally {
    await h.dispose()
  }
})

test('结果授权键与系统保护目录按平台规则生成', () => {
  assert.equal(resultGrantKey('C:\\Users\\Alice\\Report.TXT', 'win32'), 'c:\\users\\alice\\report.txt')
  assert.equal(resultGrantKey('/Users/Alice/Report.TXT', 'darwin'), '/Users/Alice/Report.TXT')
  assert.equal(resultGrantKey('/Users/Alice/dir/', 'darwin'), '/Users/Alice/dir')
  assert.deepEqual(defaultProtectedTrashRoots('darwin'), ['/System', '/usr', '/bin', '/sbin'])
  assert.equal(defaultProtectedTrashRoots('darwin').some(root => root === '/private' || root.startsWith('/private/')), false)
  assert.deepEqual(defaultProtectedTrashRoots('win32', {
    SystemRoot: 'D:\\Windows', ProgramFiles: 'D:\\Program Files', 'ProgramFiles(x86)': 'D:\\Program Files (x86)', ProgramData: 'D:\\ProgramData'
  }), ['D:\\Windows', 'D:\\Program Files', 'D:\\Program Files (x86)', 'D:\\ProgramData'])
  assert.deepEqual(defaultProtectedTrashRoots('win32', {}), ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'])
})
