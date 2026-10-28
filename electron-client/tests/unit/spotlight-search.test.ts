import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { batchMacosApplicationNames, collectSpotlightPaths } from '../../src/main/platform/macos/spotlight-search.js'
import * as spotlightSearch from '../../src/main/platform/macos/spotlight-search.js'
import { rankSearchFiles, scanLocalRecentFiles, searchFilesOnMacos, computePinyinMeta } from '../../src/main/platform/macos/file-indexer.js'
import type { FileRecord } from '../../src/main/services/sidecar-manager.js'

function fixture(script: string): { launch(): ChildProcessWithoutNullStreams; child(): ChildProcessWithoutNullStreams } {
  let process: ChildProcessWithoutNullStreams
  return {
    launch() { process = spawn(globalThis.process.execPath, ['-e', script], { stdio: 'pipe' }); return process },
    child() { return process }
  }
}

test('bounded streaming retains paths when total Spotlight output exceeds the former 4 MiB buffer', async () => {
  const source = fixture(`for (let i = 0; i < 100000; i++) process.stdout.write('/files/' + 'x'.repeat(80) + i + '.png\\0');`)
  const result = await collectSpotlightPaths('png', 12, source)
  assert.equal(result.paths.length, 12)
  assert.equal(result.degraded, false)
  assert.ok(result.paths.every(p => p.endsWith('.png')))
  assert.ok(source.child().exitCode !== null || source.child().signalCode !== null)
})

test('NUL parsing preserves Unicode, whitespace and embedded newlines; duplicates are ignored', async () => {
  const paths = ['/files/ 图片\n甲.png', '/files/ 图片\n甲.png', '/files/乙.png']
  const bytes = Buffer.from(paths.join('\0') + '\0').toString('base64')
  const source = fixture(`const b = Buffer.from('${bytes}', 'base64'); process.stdout.write(b.subarray(0, 10)); setTimeout(() => process.stdout.end(b.subarray(10)), 20);`)
  const result = await collectSpotlightPaths('图片', 12, source)
  assert.deepEqual(result, { paths: [paths[0], paths[2]], degraded: false })
})

test('timeout retains completed paths and terminates an unresponsive child', async () => {
  const source = fixture(`process.on('SIGTERM', () => {}); process.stdout.write('/files/ready.png\\0'); setInterval(() => {}, 1000);`)
  const result = await collectSpotlightPaths('png', 12, { ...source, timeoutMs: 300 })
  assert.deepEqual(result, { paths: ['/files/ready.png'], degraded: true })
  assert.equal(source.child().signalCode, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL')
})

test('a failed process keeps usable output and marks incomplete results', async () => {
  const source = fixture(`process.stdout.write('/files/ready.png\\0', () => process.exit(1));`)
  assert.deepEqual(await collectSpotlightPaths('png', 12, source), { paths: ['/files/ready.png'], degraded: true })
})

test('missing binary and successful empty results are distinguishable', async t => {
  const warning = t.mock.method(console, 'warn', () => {})
  const missing = await collectSpotlightPaths('png', 12, {
    launch: () => spawn('/ztools-test-missing-spotlight-binary', [], { stdio: 'pipe' })
  })
  assert.deepEqual(missing, { paths: [], degraded: true })
  assert.equal(warning.mock.calls.length, 1)
  assert.deepEqual(await collectSpotlightPaths('none', 12, fixture('process.exit(0)')), { paths: [], degraded: false })
})

test('AbortSignal cancels in-flight Spotlight search immediately and marks results degraded', async () => {
  const controller = new AbortController()
  const source = fixture(`process.stdout.write('/Users/demo/partial.txt\\0'); setInterval(() => {}, 1000);`)
  setTimeout(() => controller.abort(), 120)
  const res = await collectSpotlightPaths('partial', 50, { ...source, timeoutMs: 5000, signal: controller.signal })
  assert.equal(res.degraded, true)
  assert.deepEqual(res.paths, ['/Users/demo/partial.txt'])
})

test('Chinese Pinyin initials and full Pinyin match and rank macOS apps and local files', async t => {
  const metaWx = computePinyinMeta('微信.app')
  assert.equal(metaWx.acronym, 'wx')
  assert.equal(metaWx.pinyin, 'weixin')

  const metaJsq = computePinyinMeta('计算器.app')
  assert.equal(metaJsq.acronym, 'jsq')
  assert.equal(metaJsq.pinyin, 'jisuanqi')

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-pinyin-search-'))
  t.mock.method(os, 'homedir', () => root)
  try {
    const downloads = path.join(root, 'Downloads')
    await fs.mkdir(downloads, { recursive: true })
    const fileWx = path.join(downloads, '微信备份记录.txt')
    await fs.writeFile(fileWx, 'backup')

    const byAcronym = await scanLocalRecentFiles('wxbf', 10)
    assert.equal(byAcronym.files.length, 1)
    assert.equal(byAcronym.files[0]?.path, fileWx)

    const ranked = rankSearchFiles(byAcronym.files, 'wxbf')
    assert.equal(ranked[0]?.path, fileWx)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('unterminated malformed output is bounded and marked incomplete', async () => {
  const source = fixture(`process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000);`)
  assert.deepEqual(await collectSpotlightPaths('png', 12, source), { paths: [], degraded: true })
})

test('localized exact matches rank ahead of substring matches without changing the file path', () => {
  const app = (name: string, display_name: string): FileRecord => ({
    name, display_name, path: `/Applications/${name}`, kind: 'application', is_dir: true,
    size: 0, mtime: 0, acronym: '', pinyin: ''
  })
  const voice = app('VoiceMemos.app', '语音备忘录')
  const notes = app('Notes.app', '备忘录')
  assert.deepEqual(rankSearchFiles([voice, notes], '备忘录'), [notes, voice])
  assert.equal(rankSearchFiles([voice, notes], 'notes')[0]?.path, '/Applications/Notes.app')
  assert.deepEqual(rankSearchFiles([], ''), [])
})

test('local fallback preserves macOS application semantics without labelling ordinary folders or files as apps', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-app-search-'))
  t.mock.method(os, 'homedir', () => root)
  t.mock.method(process, 'cwd', () => root)
  t.mock.method(console, 'warn', () => {})
  try {
    const downloads = path.join(root, 'Downloads')
    const appPath = path.join(downloads, 'Fallback Test.app')
    await fs.mkdir(appPath, { recursive: true })
    await fs.mkdir(path.join(downloads, 'Ordinary Test'))
    await fs.writeFile(path.join(downloads, 'File Test.app'), 'ordinary file')
    const result = await scanLocalRecentFiles('Test', 20)
    const app = result.files.find(file => file.path === appPath)!
    assert.equal(app.kind, process.platform === 'darwin' ? 'application' : undefined)
    assert.equal(app.display_name, process.platform === 'darwin' ? 'Fallback Test' : undefined)
    assert.ok(result.files.filter(file => file.path !== appPath).every(file => file.kind === undefined))
    const cached = await searchFilesOnMacos('Fallback Test', 1, [app])
    assert.equal(cached.files[0]?.kind, app.kind)
    assert.equal(cached.files[0]?.path, appPath)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('batchMacosApplicationNames resolves localized Chinese app names from InfoPlist.strings and CamelCase acronyms', async () => {
  const metaWeChat = computePinyinMeta('WeChat.app')
  assert.equal(metaWeChat.acronym, 'wc')
  assert.equal(metaWeChat.pinyin, 'wechat')

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-app-lproj-'))
  try {
    const wechatApp = path.join(root, 'WeChat.app')
    const lprojDir = path.join(wechatApp, 'Contents', 'Resources', 'zh-Hans.lproj')
    await fs.mkdir(lprojDir, { recursive: true })
    await fs.writeFile(
      path.join(lprojDir, 'InfoPlist.strings'),
      '"CFBundleDisplayName" = "微信";\n"CFBundleName" = "微信";\n',
      'utf8'
    )
    const antigravityApp = path.join(root, 'Antigravity.app')
    await fs.mkdir(path.join(antigravityApp, 'Contents'), { recursive: true })

    const names = await batchMacosApplicationNames([wechatApp, antigravityApp])
    assert.equal(names.get(wechatApp), '微信')
    assert.equal(names.get(antigravityApp), 'Antigravity')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('损坏的 UTF-16 应用名称不能阻断同批健康应用的解析', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-malformed-app-name-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(console, 'warn', () => {})
  const brokenApp = path.join(root, 'Broken.app')
  const healthyApp = path.join(root, 'Healthy.app')
  for (const app of [brokenApp, healthyApp]) {
    await fs.mkdir(path.join(app, 'Contents/Resources/zh-Hans.lproj'), { recursive: true })
  }
  await fs.writeFile(path.join(brokenApp, 'Contents/Resources/zh-Hans.lproj/InfoPlist.strings'), Buffer.from([0xfe, 0xff, 0x00]))
  await fs.writeFile(path.join(healthyApp, 'Contents/Resources/zh-Hans.lproj/InfoPlist.strings'), '"CFBundleDisplayName" = "健康应用";')
  const names = await batchMacosApplicationNames([brokenApp, healthyApp])
  assert.equal(names.get(brokenApp), 'Broken')
  assert.equal(names.get(healthyApp), '健康应用')
})

test('单字查询已有浅层命中时仍补充 Spotlight 深层结果，并保留部分失败状态', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-search-coverage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(os, 'homedir', () => root)
  t.mock.method(process, 'cwd', () => root)
  const shallow = path.join(root, 'Downloads/缁浅层.txt')
  const deep = path.join(root, 'Documents/nested/deeper/缁深层.txt')
  for (const file of [shallow, deep]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'search fixture')
  }
  const collect = t.mock.method(spotlightSearch, 'collectSpotlightPaths', async () => ({ paths: [deep], degraded: true }))
  const result = await searchFilesOnMacos('缁', 10)
  assert.equal(collect.mock.calls[0]?.arguments[0], '缁')
  assert.deepEqual(new Set(result.files.map(file => file.path)), new Set([shallow, deep]))
  assert.equal(result.degraded, true)
  assert.equal(result.source, 'macos-spotlight')
})
