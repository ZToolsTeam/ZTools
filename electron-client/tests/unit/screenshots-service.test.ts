import assert from 'node:assert/strict'
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
  const remaining = service.scanScreenshots(true).map((r) => r.path).sort()
  assert.deepEqual(remaining, [files[0], files[1], files[3]].sort())
})

test('[安全] 只能操作宿主扫描到的截图：任意文件、../ 穿越、符号链接、相对路径都被拒绝且文件不受影响', async (t) => {
  const { shots, outside } = fixtureDir(t)
  const shot = writeShot(shots, 'Screenshot keep.png', '2026-10-20T10:00:00Z')
  const secret = path.join(outside, 'family.png')
  fs.writeFileSync(secret, 'private photo')
  const link = path.join(shots, 'Screenshot link.png')
  fs.symlinkSync(secret, link)
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
