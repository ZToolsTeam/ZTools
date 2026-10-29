import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApplicationListCache } from '../../src/main/platform/common/application-list-cache.js'
import { createMacosApplicationIconCache } from '../../src/main/platform/macos/application-icon.js'
import { buildMacosApplicationsCache, rankSearchFiles, searchFilesOnMacos } from '../../src/main/platform/macos/file-indexer.js'
import * as spotlightSearch from '../../src/main/platform/macos/spotlight-search.js'
import { scanStartMenuApplications, windowsStartMenuDirectories } from '../../src/main/platform/windows/start-menu-apps.js'
import { indexerMtimeToMs, SidecarManager, type FileRecord } from '../../src/main/services/sidecar-manager.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

function app(name: string, mtime = 0): FileRecord {
  return { kind: 'application', display_name: name, name: `${name}.app`, path: `/Applications/${name}.app`, is_dir: true, size: 0, mtime, acronym: '', pinyin: '' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('程序列表缓存：并发只扫一次；过期后先返回旧列表再后台重扫；重扫失败保留旧列表', async t => {
  t.mock.method(console, 'warn', () => {})
  let clock = 1000
  const builds: Array<ReturnType<typeof deferred<FileRecord[]>>> = []
  const cache = createApplicationListCache({
    build: () => {
      const next = deferred<FileRecord[]>()
      builds.push(next)
      return next.promise
    },
    ttlMs: 100,
    now: () => clock
  })
  t.after(() => cache.dispose())

  const first = cache.get()
  const concurrent = cache.get()
  assert.equal(builds.length, 1)
  builds[0]!.resolve([app('Alpha')])
  assert.deepEqual((await first).map(item => item.name), ['Alpha.app'])
  assert.equal(await concurrent, await first)

  clock += 50
  assert.deepEqual((await cache.get()).map(item => item.name), ['Alpha.app'])
  assert.equal(builds.length, 1, '未过期时不重扫')

  clock += 100
  assert.deepEqual((await cache.get()).map(item => item.name), ['Alpha.app'], '过期时不等扫描，直接给旧列表')
  assert.equal(builds.length, 2)
  builds[1]!.resolve([app('Alpha'), app('Beta')])
  await builds[1]!.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await cache.get()).map(item => item.name), ['Alpha.app', 'Beta.app'])

  clock += 200
  assert.equal((await cache.get()).length, 2)
  builds[2]!.reject(new Error('readdir EACCES'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await cache.get()).length, 2, '后台重扫失败时继续用旧列表')
})

test('程序列表缓存：扫描进行中发生的目录变化不会被这次扫描的结果盖掉，完成后会再扫一次', async t => {
  const builds: Array<ReturnType<typeof deferred<FileRecord[]>>> = []
  const cache = createApplicationListCache({
    build: () => {
      const next = deferred<FileRecord[]>()
      builds.push(next)
      return next.promise
    },
    ttlMs: 60_000,
    refreshDelayMs: 5
  })
  t.after(() => cache.dispose())

  const first = cache.get()
  // 扫描还没结束时装了新程序：这次扫描可能没读到它
  cache.invalidate()
  builds[0]!.resolve([app('Alpha')])
  assert.deepEqual((await first).map(item => item.name), ['Alpha.app'])
  const deadline = Date.now() + 2000
  while (builds.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(builds.length, 2, '扫描期间有变化时，完成后自动再扫一次')
  builds[1]!.resolve([app('Alpha'), app('Beta')])
  await builds[1]!.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await cache.get()).map(item => item.name), ['Alpha.app', 'Beta.app'])
  assert.equal(builds.length, 2, '第二次扫描期间没有新变化，结果按正常过期时间缓存')
})

test('程序列表缓存：首次扫描失败如实抛错；程序目录变化后提前重扫；释放后不再监听', async t => {
  const dir = await tempDir(t, 'ztools-app-watch-')
  let names = ['Alpha.app']
  let builds = 0
  let fail = true
  const cache = createApplicationListCache({
    build: async () => {
      builds += 1
      if (fail) throw new Error('首次扫描失败')
      return names.map(name => app(name.replace(/\.app$/, '')))
    },
    ttlMs: 60_000,
    watchDirs: () => [dir, path.join(dir, 'missing')],
    refreshDelayMs: 20
  })
  t.after(() => cache.dispose())

  await assert.rejects(cache.get(), /首次扫描失败/)
  fail = false
  assert.deepEqual((await cache.get()).map(item => item.name), ['Alpha.app'])

  names = ['Alpha.app', 'Beta.app']
  await fs.mkdir(path.join(dir, 'Beta.app'))
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await cache.get()).length < 2) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.deepEqual((await cache.get()).map(item => item.name), ['Alpha.app', 'Beta.app'], '安装新程序后不必等过期就能搜到')

  cache.dispose()
  const before = builds
  await fs.mkdir(path.join(dir, 'Gamma.app'))
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(builds, before)
})

test('macOS 程序扫描：常规目录里的 .app 与安装目录里一层子文件夹中的 .app，跳过普通文件与隐藏文件夹', async t => {
  const root = await tempDir(t, 'ztools-mac-apps-')
  const applications = path.join(root, 'Applications')
  const system = path.join(root, 'System')
  for (const dir of [
    'Applications/Alpha.app',
    'Applications/Adobe Photoshop 2024/Adobe Photoshop 2024.app',
    'Applications/Adobe Photoshop 2024/Presets',
    'Applications/.hidden/Hidden.app',
    'Applications/Deep/Level/TooDeep.app',
    'System/Notes.app',
    'System/Folder/NotNested.app'
  ]) {
    await fs.mkdir(path.join(root, dir), { recursive: true })
  }
  await fs.writeFile(path.join(applications, 'Fake.app'), 'not a bundle')
  // 像 /Applications/Safari.app 指向系统目录那样：链接与真实位置是同一个程序，只列一次
  await fs.symlink(path.join(system, 'Notes.app'), path.join(applications, 'Notes.app'), process.platform === 'win32' ? 'junction' : 'dir')

  const apps = await buildMacosApplicationsCache([
    { dir: applications, nested: true },
    { dir: system, nested: false },
    { dir: path.join(root, 'missing'), nested: true }
  ])
  const names = apps.map(item => item.name).sort()
  if (process.platform === 'darwin') {
    assert.deepEqual(names, ['Adobe Photoshop 2024.app', 'Alpha.app', 'Notes.app'])
    assert.equal(apps.find(item => item.name === 'Notes.app')?.path, path.join(applications, 'Notes.app'), '保留先找到的路径')
    assert.ok(apps.every(item => item.kind === 'application' && item.is_dir))
  } else {
    assert.deepEqual(names, [], '只有 macOS 把 .app 文件夹当作程序')
  }
})

test('Windows 开始菜单扫描：当前用户优先、同名去重、卸载与帮助类快捷方式不算程序、目录过深截止', async t => {
  const root = await tempDir(t, 'ztools-start-menu-')
  const user = path.join(root, 'user')
  const common = path.join(root, 'common')
  const files = [
    'user/Google Chrome.lnk',
    'user/Tools/Visual Studio Code.lnk',
    'user/Tools/Uninstall Tool.lnk',
    'user/Tools/卸载微信.lnk',
    'user/Tools/readme.txt',
    'common/Google Chrome.lnk',
    'common/微信/微信.lnk',
    'common/微信/微信帮助.lnk',
    'common/a/b/c/d/Shallow Enough.lnk',
    'common/a/b/c/d/e/Too Deep.lnk'
  ]
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), 'shortcut')
  }
  const apps = await scanStartMenuApplications([user, common, path.join(root, 'missing')])
  assert.deepEqual(apps.map(item => item.display_name).sort(), ['Google Chrome', 'Shallow Enough', 'Visual Studio Code', '微信'])
  assert.equal(apps.find(item => item.display_name === 'Google Chrome')?.path, path.join(user, 'Google Chrome.lnk'))
  assert.ok(apps.every(item => item.kind === 'application' && !item.is_dir && item.name.endsWith('.lnk') && item.mtime > 1e12))
  assert.ok(!apps.some(item => /Too Deep|Uninstall|卸载|帮助/.test(item.display_name ?? '')))

  assert.deepEqual(windowsStartMenuDirectories({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming', ProgramData: 'D:\\ProgramData' }), [
    'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    'D:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
  ])
  assert.deepEqual(windowsStartMenuDirectories({}), ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'])
})

test('程序图标缓存：同一程序只读一次、并发共用、程序升级后重读、失败不缓存、无效路径拒绝', async () => {
  let runs = 0
  let mtime = 1
  let fail = false
  const gate = deferred<void>()
  const cache = createMacosApplicationIconCache({
    run: async (_executable, args) => {
      runs += 1
      await gate.promise
      if (fail) throw new Error('osascript timeout')
      assert.equal(args.at(-1), '/Applications/Alpha.app')
      return png
    },
    readMtime: async () => mtime
  })

  const first = cache.read('/Applications/Alpha.app')
  const second = cache.read('/Applications/Alpha.app')
  gate.resolve()
  assert.equal(await first, `data:image/png;base64,${png}`)
  assert.equal(await second, await first)
  assert.equal(runs, 1)
  await cache.read('/Applications/Alpha.app')
  assert.equal(runs, 1, '命中缓存不再起 osascript')

  mtime = 2
  await cache.read('/Applications/Alpha.app')
  assert.equal(runs, 2, '程序包修改时间变了要重读')

  fail = true
  mtime = 3
  await assert.rejects(cache.read('/Applications/Alpha.app'), /timeout/)
  fail = false
  await cache.read('/Applications/Alpha.app')
  assert.equal(runs, 4, '失败的读取不进缓存')

  for (const invalid of ['relative.app', '/Applications/file.png', '/bad\0.app']) {
    await assert.rejects(cache.read(invalid), /无效/)
  }
})

test('程序图标预取：一次进程处理一批，单个失败不影响同批，整批失败与无效路径不阻断后续读取', async t => {
  t.mock.method(console, 'warn', () => {})
  const batches: string[][] = []
  let singleRuns = 0
  let failBatch = false
  const cache = createMacosApplicationIconCache({
    prefetchDelayMs: 0,
    readMtime: async () => 1,
    run: async () => { singleRuns += 1; return png },
    runBatch: async (_executable, args) => {
      const paths = args.slice(4)
      batches.push(paths)
      if (failBatch) throw new Error('batch crashed')
      return JSON.stringify(paths.map(item => item.includes('Broken') ? '' : png))
    }
  })
  const apps = Array.from({ length: 20 }, (_, index) => `/Applications/App${index}.app`)
  cache.prefetch([...apps, '/Applications/Broken.app', 'not-absolute.app', apps[0]!])
  const deadline = Date.now() + 2000
  while (batches.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(batches.map(batch => batch.length), [16, 5], '每批最多 16 个，重复与无效路径不入队')

  for (const appPath of apps) await cache.read(appPath)
  assert.equal(singleRuns, 0, '预取过的图标直接从缓存返回')
  await cache.read('/Applications/Broken.app')
  assert.equal(singleRuns, 1, '批量里没取到的，界面需要时再单独读')

  failBatch = true
  cache.prefetch(['/Applications/Later.app'])
  while (batches.length < 3 && Date.now() < deadline + 2000) await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(await cache.read('/Applications/Later.app'), `data:image/png;base64,${png}`)
})

test('只搜文件：不合并缓存里的程序；被新检索取代的旧检索跳过后续读取，带部分结果返回', { skip: process.platform !== 'darwin' }, async t => {
  const root = await tempDir(t, 'ztools-files-scope-')
  t.mock.method(os, 'homedir', () => root)
  const doc = path.join(root, 'Documents', 'Chrome 使用手册.pdf')
  await fs.mkdir(path.dirname(doc), { recursive: true })
  await fs.writeFile(doc, 'manual')

  const collect = t.mock.method(spotlightSearch, 'collectSpotlightPaths', async () => ({ paths: [doc], degraded: false }))
  const filesOnly = await searchFilesOnMacos('Chrome', 12, [], { excludeApplications: true })
  assert.equal(filesOnly.scope, 'files')
  assert.ok(filesOnly.files.every(file => file.kind !== 'application'), '程序已在界面本地匹配，这里只返回文件')
  assert.ok(filesOnly.files.some(file => file.path === doc))

  // 第一次检索卡在 Spotlight 时第二次开始：第一次回来后不再读文件信息与扫描目录
  const gate = deferred<{ paths: string[]; degraded: boolean }>()
  collect.mock.mockImplementation(async () => gate.promise)
  const stale = searchFilesOnMacos('Chrome', 12, [], { excludeApplications: true })
  await new Promise(resolve => setImmediate(resolve))
  collect.mock.mockImplementation(async () => ({ paths: [], degraded: false }))
  const fresh = await searchFilesOnMacos('Manual', 12, [], { excludeApplications: true })
  assert.notEqual(fresh.partial, true)
  gate.resolve({ paths: [doc], degraded: true })
  const superseded = await stale
  assert.equal(superseded.partial, true)
  assert.deepEqual(superseded.files, [], '被取代后跳过读取，不返回过时的半成品')

  // 插件、文件秒搜等其它调用方的检索不会把悬浮条的检索判成过期，反过来也一样
  const gate2 = deferred<{ paths: string[]; degraded: boolean }>()
  collect.mock.mockImplementation(async () => gate2.promise)
  const launcher = searchFilesOnMacos('Chrome', 12, [], { excludeApplications: true })
  await new Promise(resolve => setImmediate(resolve))
  collect.mock.mockImplementation(async () => ({ paths: [], degraded: false }))
  const plugin = await searchFilesOnMacos('Other', 12)
  assert.notEqual(plugin.partial, true)
  gate2.resolve({ paths: [doc], degraded: false })
  const launcherResult = await launcher
  assert.notEqual(launcherResult.partial, true)
  assert.ok(launcherResult.files.some(file => file.path === doc))
})

test('文件排序：同分时最近修改、路径浅的在前；Windows 索引的修改时间换成毫秒', () => {
  const file = (name: string, dir: string, mtime: number): FileRecord => ({
    name, path: `${dir}/${name}`, is_dir: false, size: 1, mtime, acronym: '', pinyin: ''
  })
  const oldShallow = file('report.pdf', '/Users/a', 1000)
  const newDeep = file('report.docx', '/Users/a/b/c/d', 5000)
  const newShallow = file('report.txt', '/Users/a', 5000)
  assert.deepEqual(rankSearchFiles([oldShallow, newDeep, newShallow], 'report').map(item => item.path), [
    newShallow.path, newDeep.path, oldShallow.path
  ])

  // 2026-01-01T00:00:00Z 的 FILETIME
  const filetime = (Date.UTC(2026, 0, 1) + 11_644_473_600_000) * 10_000
  assert.equal(indexerMtimeToMs(filetime), Date.UTC(2026, 0, 1))
  assert.equal(indexerMtimeToMs(Date.UTC(2026, 0, 1)), Date.UTC(2026, 0, 1), '已经是毫秒的原样返回')
  for (const invalid of [0, -1, Number.NaN, 'abc', null, undefined]) assert.equal(indexerMtimeToMs(invalid), 0)
})

test('检索服务按范围分流：程序列表回显范围且只含程序，只搜文件回显范围', async t => {
  t.mock.method(spotlightSearch, 'collectSpotlightPaths', async () => ({ paths: [], degraded: false }))
  const sidecars = new SidecarManager()
  const listed = await sidecars.searchFiles('ignored', 5, { scope: 'applications' })
  assert.equal(listed.scope, 'applications')
  assert.ok(listed.files.every(file => file.kind === 'application'))
  if (process.platform !== 'darwin' && process.platform !== 'win32') assert.deepEqual(listed.files, [])

  if (process.platform === 'darwin') {
    const files = await sidecars.searchFiles('zz-no-such-file', 5, { scope: 'files' })
    assert.equal(files.scope, 'files')
    const legacy = await sidecars.searchFiles('zz-no-such-file', 5)
    assert.equal(legacy.scope, undefined, '不带范围的旧调用方结果不变')
  }
})
