import { describe, it } from 'node:test'
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
    entry: 'dist/index.js',
    icon: 'icon.svg',
    permissions: [],
    targets: [{ id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }],
    nativeComponents: [],
    ...extra
  }
}

function makePluginDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-shot-'))
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

  it('超过 5 张、类型错误、重复路径、未知字段、过长标题都拒绝', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ path: `screenshots/0${i}.png` }))
    assert.ok(validatePluginManifest(basePlugin({ screenshots: six })).errors.some((e) => e.includes('最多 5 张')))
    assert.ok(validatePluginManifest(basePlugin({ screenshots: 'screenshots/01.png' })).errors.some((e) => e.includes('必须为数组')))
    assert.ok(validatePluginManifest(basePlugin({ screenshots: ['screenshots/01.png'] })).errors.some((e) => e.includes('必须为对象')))
    const dup = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png' }, { path: 'screenshots/01.png' }] }))
    assert.ok(dup.errors.some((e) => e.includes('重复')))
    const unknown = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png', url: 'https://x' }] }))
    assert.ok(unknown.errors.some((e) => e.includes('未知字段: url')))
    const longTitle = validatePluginManifest(basePlugin({ screenshots: [{ path: 'screenshots/01.png', title: '长'.repeat(61) }] }))
    assert.ok(longTitle.errors.some((e) => e.includes('title')))
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
      assert.ok(result.errors.some((e) => e.includes('.path 不合法')), `应拒绝 ${JSON.stringify(p)}`)
    }
  })

  it('缺文件、伪装扩展名、超大、尺寸越界、目录与软链接都拒绝', (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-shot-outside-'))
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
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    })
    const cases = [
      ['screenshots/missing.png', '不存在'],
      ['screenshots/fake.png', '不是有效的 PNG'],
      ['screenshots/big.png', '超过 1024 KB'],
      ['screenshots/tiny.png', '320×200'],
      ['screenshots/huge.png', '4000×800'],
      ['screenshots/truncated.png', '不是有效的 PNG'],
      ['screenshots/dir.png', '不是普通文件'],
      ['screenshots/link.png', '软链接'],
      ['screenshots/outer/leak.png', '越界']
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
