import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ScreenshotsService, screenshotIdForPath } from '../../src/main/services/screenshots-service.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'

function fixtureDir(t: { after(fn: () => void): void }): { root: string; shots: string; outside: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-screenshots-')))
  const shots = path.join(root, 'Screenshots')
  const outside = path.join(root, 'Private')
  fs.mkdirSync(shots)
  fs.mkdirSync(outside)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, shots, outside }
}

function writeShot(dir: string, name: string, mtime: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `image ${name}`)
  fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

function hasCode(code: string) {
  return (error: { code?: string }) => error.code === code
}

test('扫描不存在或空目录可返回空列表，目录读取失败必须明确报错', (t) => {
  const { root, shots } = fixtureDir(t)
  const service = new ScreenshotsService({ searchDirectories: [shots, path.join(root, 'missing')] })
  assert.deepEqual(service.scanScreenshots(true), [])
  const invalid = path.join(root, 'not-a-directory')
  fs.writeFileSync(invalid, '不是目录')
  service.setSearchDirectories([invalid])
  assert.throws(() => service.scanScreenshots(true), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'FILE_ERROR')
    assert.match(error.message ?? '', /not-a-directory.*路径不是文件夹/)
    return true
  })
})

test('真实目录无权限时报告拒绝访问，恢复权限后可以重新扫描', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('该用例要求非 root 的 POSIX 目录权限')
    return
  }
  const { shots } = fixtureDir(t)
  const file = writeShot(shots, 'Screenshot retained.png', '2026-10-20T10:00:00Z')
  const service = new ScreenshotsService({ searchDirectories: [shots] })
  fs.chmodSync(shots, 0)
  try {
    assert.throws(() => service.scanScreenshots(true), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, 'PERMISSION_DENIED')
      assert.match(error.message ?? '', /Screenshots.*没有访问权限/)
      return true
    })
  } finally {
    fs.chmodSync(shots, 0o700)
  }
  assert.deepEqual(service.scanScreenshots(true).map((r) => r.path), [file])
  assert.equal(fs.readFileSync(file, 'utf8'), 'image Screenshot retained.png')
})

test('部分目录读取失败只跳过该目录：返回其余目录的截图并在 failedDirs 中说明原因，恢复后重扫完整', (t) => {
  const { root, shots, outside } = fixtureDir(t)
  const first = writeShot(shots, 'Screenshot first.png', '2026-10-20T10:00:00Z')
  const second = writeShot(outside, 'Screenshot second.png', '2026-10-21T10:00:00Z')
  const service = new ScreenshotsService({ searchDirectories: [shots, outside] })
  const previous = service.scanScreenshotsReport(true)
  assert.equal(previous.screenshots.length, 2)
  assert.deepEqual(previous.failedDirs, [])
  const retainedDirectory = path.join(root, 'retained-directory')
  fs.renameSync(outside, retainedDirectory)
  fs.writeFileSync(outside, '临时替代目录')
  const partial = service.scanScreenshotsReport(true)
  assert.deepEqual(partial.screenshots.map((r) => r.path), [first])
  assert.equal(partial.failedDirs.length, 1)
  assert.equal(partial.failedDirs[0]!.path, outside)
  assert.equal(partial.failedDirs[0]!.code, 'FILE_ERROR')
  assert.equal(partial.failedDirs[0]!.hostCode, 'ENOTDIR')
  assert.match(partial.failedDirs[0]!.message, /Private.*路径不是文件夹/)
  // 缓存期内读取同样带回失败目录（不会因命中缓存把原因丢掉）
  assert.deepEqual(service.scanScreenshotsReport().failedDirs, partial.failedDirs)
  // 返回值可 JSON 序列化（经 IPC 传给插件），插件按 data.screenshots 取列表
  const roundTrip = JSON.parse(JSON.stringify(partial)) as { screenshots: unknown[]; failedDirs: unknown[] }
  assert.equal(Array.isArray(roundTrip.screenshots) && roundTrip.screenshots.length, 1)
  fs.unlinkSync(outside)
  fs.renameSync(retainedDirectory, outside)
  const recovered = service.scanScreenshotsReport(true)
  assert.deepEqual(recovered.screenshots.map((r) => r.path).sort(), [first, second].sort())
  assert.deepEqual(recovered.failedDirs, [])
})

test('macOS 拒绝访问桌面（EPERM）：跳过桌面继续扫描其它目录；全部目录都失败才整体失败且不覆盖上次缓存', (t) => {
  const { root, shots } = fixtureDir(t)
  const desktop = path.join(root, 'Desktop')
  fs.mkdirSync(desktop)
  writeShot(desktop, 'Screenshot desktop.png', '2026-10-19T10:00:00Z')
  const kept = writeShot(shots, 'Screenshot kept.png', '2026-10-20T10:00:00Z')
  const deniedDirs = new Set([desktop])
  const originalReaddir = fs.readdirSync
  t.mock.method(fs, 'readdirSync', ((...args: Parameters<typeof fs.readdirSync>) => {
    if (deniedDirs.has(String(args[0]))) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    return originalReaddir(...args)
  }) as typeof fs.readdirSync)

  const service = new ScreenshotsService({ searchDirectories: [desktop, shots] })
  const report = service.scanScreenshotsReport(true)
  assert.deepEqual(report.screenshots.map((r) => r.path), [kept])
  assert.deepEqual(report.failedDirs, [{
    path: desktop, code: 'PERMISSION_DENIED', hostCode: 'EPERM', message: '无法读取截图目录“Desktop”：没有访问权限'
  }])

  // 全部目录都被拒绝：整体失败，错误信息逐个列出目录与原因，上次缓存保留
  const previous = service.scanScreenshots()
  deniedDirs.add(shots)
  assert.throws(() => service.scanScreenshots(true), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'PERMISSION_DENIED')
    assert.match(error.message ?? '', /所有截图目录都无法读取：.*Desktop.*没有访问权限；.*Screenshots.*没有访问权限/)
    return true
  })
  assert.strictEqual(service.scanScreenshots(), previous, '整体失败不能覆盖已有缓存')
  assert.deepEqual(service.scanScreenshotsReport().failedDirs.map((f) => f.path), [desktop], '失败目录也沿用上次结果')
  // 只有一个目录且被拒绝：沿用原来的单目录错误文案
  const single = new ScreenshotsService({ searchDirectories: [desktop] })
  assert.throws(() => single.scanScreenshots(true), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'PERMISSION_DENIED')
    assert.equal(error.message, '无法读取截图目录“Desktop”：没有访问权限')
    return true
  })
})

test('截图文件读取错误不能被目录或 Spotlight 的异常处理吞掉：记入所在目录的 failedDirs', (t) => {
  const { shots } = fixtureDir(t)
  const file = writeShot(shots, 'Screenshot unreadable.png', '2026-10-20T10:00:00Z')
  const readable = writeShot(shots, 'Screenshot readable.png', '2026-10-21T10:00:00Z')
  const originalStat = fs.statSync
  t.mock.method(fs, 'statSync', ((...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === file) throw Object.assign(new Error('test read denied'), { code: 'EACCES' })
    return originalStat(...args)
  }) as typeof fs.statSync)
  const service = new ScreenshotsService({ searchDirectories: [shots] })
  const report = service.scanScreenshotsReport(true)
  assert.deepEqual(report.screenshots.map((r) => r.path), [readable])
  assert.deepEqual(report.failedDirs.map((f) => [f.path, f.code, f.hostCode]), [[shots, 'PERMISSION_DENIED', 'EACCES']])
  if (process.platform === 'darwin') {
    const indexed = new ScreenshotsService()
    t.mock.method(indexed, 'getDefaultLocations', () => [])
    t.mock.method(childProcess, 'execFileSync', ((command: string) => {
      assert.equal(command, '/usr/bin/mdfind')
      return file + '\n'
    }) as typeof childProcess.execFileSync)
    const indexedReport = indexed.scanScreenshotsReport(true)
    assert.deepEqual(indexedReport.screenshots, [])
    assert.deepEqual(indexedReport.failedDirs.map((f) => [f.path, f.code]), [[shots, 'PERMISSION_DENIED']])
  }
})

test('同一目录的多张截图 id 各不相同，且同一路径的 id 稳定', (t) => {
  const { shots } = fixtureDir(t)
  const names = ['Screenshot 2026-10-21 at 09.00.00.png', 'Screenshot 2026-10-21 at 09.10.00.png', '截屏b.png', 'a.png']
  names.forEach((name, i) => writeShot(shots, name, `2026-10-2${i}T10:00:00Z`))
  const service = new ScreenshotsService({ searchDirectories: [shots] })
  const records = service.scanScreenshots(true)
  assert.equal(records.length, 4)
  assert.equal(new Set(records.map((r) => r.id)).size, 4)
  for (const record of records) {
    assert.equal(record.id, screenshotIdForPath(record.path))
    assert.match(record.id, /^screenshot-[0-9a-f]{24}$/)
  }
  assert.deepEqual(service.scanScreenshots(true).map((r) => r.id), records.map((r) => r.id))
})

test('置顶与删除只命中一张截图', async (t) => {
  const { shots } = fixtureDir(t)
  const files = [1, 2, 3, 4].map((n) => writeShot(shots, `Screenshot ${n}.png`, `2026-10-1${n}T10:00:00Z`))
  const service = new ScreenshotsService({ searchDirectories: [shots] })
  service.scanScreenshots(true)

  const target = await service.resolveScannedScreenshot(files[1])
  assert.equal(service.togglePin(target.path), true)
  assert.deepEqual(service.scanScreenshots().filter((r) => r.pinned).map((r) => r.path), [files[1]])

  const victim = await service.resolveScannedScreenshot(files[2])
  assert.equal(await service.deleteScreenshot(victim.path), true)
  await assert.rejects(service.deleteScreenshot(victim.path), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'FILE_ERROR')
    assert.match(error.message ?? '', /截图文件不存在：Screenshot 3\.png/)
    return true
  })
  const remaining = service.scanScreenshots(true).map((r) => r.path).sort()
  assert.deepEqual(remaining, [files[0], files[1], files[3]].sort())
})

test('[安全] 只能操作宿主扫描到的截图：任意文件、../ 穿越、符号链接、相对路径都被拒绝且文件不受影响', async (t) => {
  const { shots, outside } = fixtureDir(t)
  const shot = writeShot(shots, 'Screenshot keep.png', '2026-10-20T10:00:00Z')
  const secret = path.join(outside, 'family.png')
  fs.writeFileSync(secret, 'private photo')
  const link = path.join(shots, 'Screenshot link.png')
  // Windows 普通权限使用真实目录重解析点，仍验证扫描不跟随链接泄露外部照片。
  fs.symlinkSync(process.platform === 'win32' ? outside : secret, link, process.platform === 'win32' ? 'junction' : 'file')
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
  const service = new ScreenshotsService({ searchDirectories: [shots] })
  assert.deepEqual(service.scanScreenshots(true).map((r) => r.path), [shot])

  await assert.rejects(service.resolveScannedScreenshot(secret), hasCode('PERMISSION_DENIED'))
  await assert.rejects(service.resolveScannedScreenshot(path.join(shots, '..', 'Private', 'family.png')), hasCode('PERMISSION_DENIED'))
  await assert.rejects(service.resolveScannedScreenshot(link), hasCode('PERMISSION_DENIED'))
  await assert.rejects(service.resolveScannedScreenshot('/etc/hosts'), hasCode('PERMISSION_DENIED'))
  await assert.rejects(service.resolveScannedScreenshot(shots), hasCode('PERMISSION_DENIED'))
  await assert.rejects(service.resolveScannedScreenshot('Screenshot keep.png'), hasCode('INVALID_REQUEST'))
  await assert.rejects(service.resolveScannedScreenshot(`${shot}\0.txt`), hasCode('INVALID_REQUEST'))
  await assert.rejects(service.resolveScannedScreenshot(undefined), hasCode('INVALID_REQUEST'))
  assert.equal(fs.readFileSync(secret, 'utf8'), 'private photo')

  // 规范化后指向扫描内文件的写法可以通过
  const viaDotDot = await service.resolveScannedScreenshot(path.join(shots, '..', 'Screenshots', 'Screenshot keep.png'))
  assert.equal(viaDotDot.path, shot)
})

test('[边界] 缓存之后新出现的截图会重扫命中；扫描后被外部删除的截图返回文件不存在', async (t) => {
  const { shots } = fixtureDir(t)
  const first = writeShot(shots, 'Screenshot 1.png', '2026-10-20T10:00:00Z')
  const service = new ScreenshotsService({ searchDirectories: [shots] })
  service.scanScreenshots(true)
  const late = writeShot(shots, 'Screenshot 2.png', '2026-10-21T10:00:00Z')
  assert.equal((await service.resolveScannedScreenshot(late)).path, late)

  fs.rmSync(first)
  await assert.rejects(service.resolveScannedScreenshot(first), (error: { code?: string }) => error.code === 'FILE_ERROR' || error.code === 'PERMISSION_DENIED')
})

test('回贴最新截图：没有回调时如实返回不支持；只复制未粘贴时提示手动粘贴；复制失败返回失败', async (t) => {
  const { shots } = fixtureDir(t)
  writeShot(shots, 'Screenshot old.png', '2026-10-19T10:00:00Z')
  const latest = writeShot(shots, 'Screenshot new.png', '2026-10-21T10:00:00Z')
  const service = new ScreenshotsService({ searchDirectories: [shots] })

  const noCallback = await service.pasteLatestScreenshot()
  assert.equal(noCallback.success, false)
  assert.equal(noCallback.code, 'NOT_SUPPORTED')

  const received: string[] = []
  const copiedOnly = await service.pasteLatestScreenshot(async (file) => {
    received.push(file)
    return { pasted: false }
  })
  assert.deepEqual(received, [latest])
  assert.equal(copiedOnly.success, true)
  assert.equal(copiedOnly.copied, true)
  assert.equal(copiedOnly.pasted, false)
  assert.match(copiedOnly.message ?? '', /已复制最新截图: Screenshot new\.png，请按 .+V 粘贴/)

  const pasted = await service.pasteLatestScreenshot(() => ({ pasted: true }))
  assert.equal(pasted.pasted, true)
  assert.match(pasted.message ?? '', /已粘贴最新截图/)

  const failed = await service.pasteLatestScreenshot(async () => {
    throw new Error('剪贴板被占用')
  })
  assert.equal(failed.success, false)
  assert.equal(failed.copied, false)
  assert.match(failed.message ?? '', /剪贴板被占用/)

  const empty = new ScreenshotsService({ searchDirectories: [path.join(shots, 'missing')] })
  const none = await empty.pasteLatestScreenshot(() => ({ pasted: true }))
  assert.equal(none.success, false)
  assert.equal(none.code, 'NO_SCREENSHOTS')
})

test('[契约] screenshots_delete / toggle_pin 参数校验', () => {
  validateMethodParams('screenshots_delete', { filePath: '/Users/a/Desktop/Screenshot.png' })
  validateMethodParams('screenshots_toggle_pin', { filePath: '/Users/a/Desktop/Screenshot.png' })
  assert.throws(() => validateMethodParams('screenshots_delete', { filePath: '' }))
  assert.throws(() => validateMethodParams('screenshots_delete', { filePath: 'a'.repeat(4097) }))
  assert.throws(() => validateMethodParams('screenshots_delete', { filePath: '/a\0b' }))
  assert.throws(() => validateMethodParams('screenshots_toggle_pin', { filePath: 1 }))
  assert.throws(() => validateMethodParams('screenshots_toggle_pin', { filePath: '/a', extra: true }))
})

test('删除截图失败时带上中文原因（权限、占用、其它错误），失败不从列表移除', async (t) => {
  const { shots } = fixtureDir(t)
  const file = writeShot(shots, 'Screenshot busy.png', '2026-10-20T10:00:00Z')
  const trashName = process.platform === 'darwin' ? '废纸篓' : '回收站'
  const failures: Array<[unknown, string, RegExp]> = [
    [Object.assign(new Error('denied'), { code: 'EPERM' }), 'PERMISSION_DENIED', new RegExp(`无法将截图“Screenshot busy\\.png”移到${trashName}：没有访问权限`)],
    [Object.assign(new Error('busy'), { code: 'EBUSY' }), 'FILE_ERROR', /文件正被其它程序占用/],
    [new Error('Failed to move item to trash'), 'FILE_ERROR', /移到.*：Failed to move item to trash/]
  ]
  for (const [failure, code, pattern] of failures) {
    const service = new ScreenshotsService({ searchDirectories: [shots], trashItem: async () => { throw failure } })
    service.scanScreenshots(true)
    await assert.rejects(service.deleteScreenshot(file), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, code)
      assert.match(error.message ?? '', pattern)
      return true
    })
    assert.deepEqual(service.scanScreenshots().map((r) => r.path), [file], '删除失败不能从缓存里移除')
    assert.equal(fs.existsSync(file), true)
  }
  const trashed: string[] = []
  const service = new ScreenshotsService({ searchDirectories: [shots], trashItem: async (target) => { trashed.push(target); fs.unlinkSync(target) } })
  service.scanScreenshots(true)
  assert.equal(await service.deleteScreenshot(file), true)
  assert.deepEqual(trashed, [file])
  assert.deepEqual(service.scanScreenshots(), [])
})
