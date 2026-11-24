import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  validatePluginManifest,
  validateCatalogPluginItem,
  inspectScreenshotFile,
  readPngSize,
  SCREENSHOT_LIMITS
} from '../src/validator.js'

const tmpDirs = new Set()

function createTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.add(dir)
  return dir
}

function removeTempDir(dir) {
  if (!dir) return
  tmpDirs.delete(dir)
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 单个临时目录删除异常不中断其余清理
  }
}

function cleanupAllTempDirs() {
  for (const dir of [...tmpDirs]) {
    removeTempDir(dir)
  }
}

after(() => {
  cleanupAllTempDirs()
})
process.once('exit', cleanupAllTempDirs)

/** 生成真实可解码的灰度 PNG（签名 + IHDR + IDAT + IEND） */
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 0 // 灰度
  const raw = Buffer.alloc(height * (width + 1))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function basePlugin(extra = {}) {
  return {
    id: 'shot-demo',
    name: '截图示例',
    version: '1.0.0',
    description: '截图校验',
    author: 'octocat',
    category: ['图像媒体'],
    entry: 'dist/index.js',
    icon: 'icon.svg',
    permissions: [],
    targets: [{ id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }],
    nativeComponents: [],
    ...extra
  }
}

function makePluginDir(files = {}) {
  const dir = createTempDir('ztools-shot-')
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist/index.js'), 'export default 1\n')
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), data)
  }
  return dir
}

describe('插件截图清单校验', () => {
  it('合法截图：1280×800 PNG 通过，并读出尺寸', () => {
    const dir = makePluginDir({ 'screenshots/01.png': makePng(1280, 800), 'screenshots/02.png': makePng(640, 400) })
    const result = validatePluginManifest(
      basePlugin({ screenshots: [{ path: 'screenshots/01.png', title: '主界面' }, { path: 'screenshots/02.png' }] }),
      { baseDir: dir }
    )
    assert.deepEqual(result.errors, [])
    const info = inspectScreenshotFile(dir, 'screenshots/01.png')
    assert.equal(info.ok, true)
    assert.equal(info.width, 1280)
    assert.equal(info.height, 800)
  })

  it('不写 screenshots 仍然合法（可选字段）', () => {
    assert.equal(validatePluginManifest(basePlugin()).valid, true)
  })

  it('超过 5 张、类型错误、重复路径、未知字段、空/空白/过长标题都拒绝', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ path: `screenshots/0${i}.png` }))
    assert.ok(validatePluginManifest(basePlugin({ screenshots: six })).errors.some((e) => e.includes('at most 5 items')))
    assert.ok(validatePluginManifest(basePlugin({ screenshots: 'screenshots/01.png' })).errors.some((e) => e.includes('must be an array')))
    assert.ok(validatePluginManifest(basePlugin({ screenshots: ['screenshots/01.png'] })).errors.some((e) => e.includes('must be an object')))
    const dup = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png' }, { path: 'screenshots/01.png' }] }))
    assert.ok(dup.errors.some((e) => e.includes('duplicated')))
    const unknown = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png', url: 'https://x' }] }))
    assert.ok(unknown.errors.some((e) => e.includes('unknown fields: url')))
    const longTitle = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png', title: '长'.repeat(61) }] }))
    assert.ok(longTitle.errors.some((e) => e.includes('title')))
    // 顶层 screenshots[].title 与 i18n.screenshots[].title 口径完全一致：存在时必须为非空字符串
    for (const badTitle of ['', '   ', '\t\n', 123, null]) {
      const topRes = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png', title: badTitle }] }))
      assert.equal(topRes.valid, false, `顶层 title=${JSON.stringify(badTitle)} 应被拒绝`)
      assert.ok(topRes.errors.some((e) => e.includes('screenshots[0].title must be a non-empty string of 1-60 characters')))
      const i18nRes = validatePluginManifest(basePlugin({
        i18n: { 'en-US': { screenshots: [{ file: 'screenshots/en-US/01.png', title: badTitle }] } }
      }))
      assert.equal(i18nRes.valid, false, `i18n title=${JSON.stringify(badTitle)} 应被拒绝`)
      assert.ok(i18nRes.errors.some((e) => e.includes('i18n["en-US"].screenshots[0].title must be a non-empty string of 1-60 characters')))
    }
  })

  it('路径穿越、绝对路径、反斜杠、非 screenshots/ 目录、非 PNG 扩展名都拒绝', () => {
    const bad = [
      '../screenshots/01.png',
      'screenshots/../../etc/passwd.png',
      '/screenshots/01.png',
      'C:/screenshots/01.png',
      'screenshots\\01.png',
      'docs/01.png',
      'screenshots/01.jpg',
      'screenshots/01.PNG',
      'screenshots/01.png\0',
      'screenshots/.hidden.png',
      'screenshots/a b.png',
      ''
    ]
    for (const p of bad) {
      const result = validatePluginManifest(basePlugin({ screenshots: [{ path: p }] }))
      assert.ok(result.errors.some((e) => e.includes('.path is invalid')), `应拒绝 ${JSON.stringify(p)}`)
    }
  })

  it('缺文件、伪装扩展名、超大、尺寸越界、目录与软链接都拒绝', (t) => {
    const outside = createTempDir('ztools-shot-outside-')
    fs.writeFileSync(path.join(outside, 'leak.png'), makePng(1280, 800))
    const big = Buffer.concat([makePng(1280, 800), Buffer.alloc(SCREENSHOT_LIMITS.maxBytes)])
    const dir = makePluginDir({
      'screenshots/fake.png': Buffer.from('\xff\xd8\xff\xe0 JFIF 其实是 JPEG', 'latin1'),
      'screenshots/big.png': big,
      'screenshots/tiny.png': makePng(320, 200),
      'screenshots/huge.png': makePng(4000, 800),
      'screenshots/truncated.png': makePng(1280, 800).subarray(0, 16),
      'screenshots/dir.png/keep': 'x'
    })
    fs.symlinkSync(path.join(outside, 'leak.png'), path.join(dir, 'screenshots/link.png'))
    // 上级目录是软链接：路径看着在插件目录内，实际指向外面
    fs.symlinkSync(outside, path.join(dir, 'screenshots/outer'))
    t.after(() => {
      removeTempDir(dir)
      removeTempDir(outside)
    })
    const cases = [
      ['screenshots/missing.png', 'does not exist'],
      ['screenshots/fake.png', 'not a valid PNG'],
      ['screenshots/big.png', 'exceeding the 1024 KB limit'],
      ['screenshots/tiny.png', '320x200'],
      ['screenshots/huge.png', '4000x800'],
      ['screenshots/truncated.png', 'not a valid PNG'],
      ['screenshots/dir.png', 'must be a regular file'],
      ['screenshots/link.png', 'must not be a symbolic link'],
      ['screenshots/outer/leak.png', 'escapes plugin root']
    ]
    for (const [p, expected] of cases) {
      const result = validatePluginManifest(basePlugin({ screenshots: [{ path: p }] }), { baseDir: dir })
      assert.equal(result.valid, false, p)
      assert.ok(result.errors.some((e) => e.includes(expected)), `${p}: ${result.errors.join(' | ')}`)
    }
  })

  it('readPngSize 只认真正的 PNG 文件头', () => {
    assert.deepEqual(readPngSize(makePng(700, 500)), { width: 700, height: 500 })
    assert.equal(readPngSize(Buffer.from('not a png at all, not a png')), null)
    assert.equal(readPngSize(null), null)
    const noIhdr = makePng(700, 500)
    noIhdr.write('IDAT', 12, 'latin1')
    assert.equal(readPngSize(noIhdr), null)
  })
})

describe('插件目录条目里的截图', () => {
  const item = (screenshots) => ({ id: 'shot-demo', name: '截图示例', version: '1.0.0', screenshots })
  it('合法：https 地址 + 宽高', () => {
    const result = validateCatalogPluginItem(item([{ url: 'https://cdn.ztools.cn/plugins-v2/a/b/screenshots/1.0.0/01-abcd1234.png', title: '主界面', width: 1280, height: 800 }]))
    assert.deepEqual(result.errors, [])
  })
  it('非 https、缺宽高、超数量都不能进目录', () => {
    for (const shots of [
      [{ url: 'http://cdn.ztools.cn/a.png', width: 1, height: 1 }],
      [{ url: 'javascript:alert(1)', width: 1, height: 1 }],
      [{ url: 'https://cdn.ztools.cn/a.png' }],
      [{ url: 'https://cdn.ztools.cn/a".png', width: 1, height: 1 }],
      Array.from({ length: 6 }, () => ({ url: 'https://cdn.ztools.cn/a.png', width: 1, height: 1 })),
      'https://cdn.ztools.cn/a.png'
    ]) {
      assert.equal(validateCatalogPluginItem(item(shots)).valid, false, JSON.stringify(shots).slice(0, 80))
    }
  })
})
