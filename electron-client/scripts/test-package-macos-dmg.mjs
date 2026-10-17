import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMacDmg, main, parseDmgArguments } from './package-macos-dmg.mjs'

const IDENTITY = 'Developer ID Application: ZTools Team (ABCDE12345)'

function fixtureApp(root, { withPlist = true } = {}) {
  const app = path.join(root, 'ZTools.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  if (withPlist) fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>')
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'ZTools'), '#!/bin/sh\n')
  return app
}

// 模拟系统工具：记录调用顺序；hdiutil create 写出产物
function fakeExec({ signed = true, failOn } = {}) {
  const calls = []
  const exec = (cmd, args) => {
    const name = `${path.basename(cmd)} ${args[0]}`
    calls.push({ name, cmd, args })
    if (failOn && name === failOn) throw new Error(`模拟失败: ${failOn}`)
    if (name === 'codesign --verify' && args.includes('--deep') && !signed) throw new Error('code object is not signed at all')
    if (name === 'ditto ' + args[0]) fs.cpSync(args[0], args[1], { recursive: true })
    if (name === 'hdiutil create') fs.writeFileSync(args[args.length - 1], 'fake-dmg')
    return ''
  }
  return { exec, calls }
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-dmg-test-'))
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(tmp)
  return { root, tmp, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('参数校验：必须是绝对路径、正确扩展名，签名身份格式与互斥规则', () => {
  assert.throws(() => parseDmgArguments(['--app', 'ZTools.app', '--output', '/x/a.dmg']), /--app 必须是 .app 的绝对路径/)
  assert.throws(() => parseDmgArguments(['--app', '/x/ZTools', '--output', '/x/a.dmg']), /--app 必须是 .app/)
  assert.throws(() => parseDmgArguments(['--app', '/x/ZTools.app', '--output', '/x/a.zip']), /--output 必须是 .dmg/)
  assert.throws(() => parseDmgArguments(['--app', '/x/ZTools.app', '--app', '/y/ZTools.app', '--output', '/x/a.dmg']), /参数重复/)
  assert.throws(() => parseDmgArguments(['--app', '/x/ZTools.app', '--output', '/x/a.dmg', '--sign-identity', 'me']), /Developer ID Application/)
  assert.throws(() => parseDmgArguments(['--app', '/x/ZTools.app', '--output', '/x/a.dmg', '--sign-identity', IDENTITY, '--allow-unsigned']), /不能同时使用/)
  assert.throws(() => parseDmgArguments(['--app', '/x/ZTools.app', '--output', '/x/a.dmg', '--unknown']), /Unknown option/)
  assert.deepEqual(parseDmgArguments(['--app', '/x/ZTools.app', '--output', '/x/a.dmg', '--sign-identity', IDENTITY]), {
    help: false, app: '/x/ZTools.app', output: '/x/a.dmg', signIdentity: IDENTITY, allowUnsigned: false
  })
})

test('非 macOS 平台直接拒绝', () => {
  assert.throws(() => createMacDmg({ app: '/x/ZTools.app', output: '/x/a.dmg' }, { platform: 'win32' }), /只能在 macOS 上生成/)
})

test('[破坏性] .app 缺 Info.plist、是符号链接或不存在时拒绝', () => {
  const s = sandbox()
  try {
    const noPlist = fixtureApp(s.root, { withPlist: false })
    assert.throws(() => createMacDmg({ app: noPlist, output: path.join(s.root, 'a.dmg') }, { platform: 'darwin', exec: fakeExec().exec }), /缺少 Contents\/Info.plist/)
    const link = path.join(s.root, 'Link.app')
    fs.symlinkSync(noPlist, link)
    assert.throws(() => createMacDmg({ app: link, output: path.join(s.root, 'b.dmg') }, { platform: 'darwin', exec: fakeExec().exec }), /必须是真实目录/)
    assert.throws(() => createMacDmg({ app: path.join(s.root, 'Missing.app'), output: path.join(s.root, 'c.dmg') }, { platform: 'darwin' }), /找不到 .app/)
  } finally { s.cleanup() }
})

test('[破坏性] 未签名的 .app 默认拒绝，且不会调用 hdiutil', () => {
  const s = sandbox()
  try {
    const app = fixtureApp(s.root)
    const fake = fakeExec({ signed: false })
    assert.throws(() => createMacDmg({ app, output: path.join(s.root, 'a.dmg') }, { platform: 'darwin', exec: fake.exec, tmpdir: () => s.tmp, log: () => {} }), /MAC_APP_NOT_SIGNED/)
    assert.equal(fake.calls.some((c) => c.name.startsWith('hdiutil')), false)
    assert.equal(fs.existsSync(path.join(s.root, 'a.dmg')), false)
  } finally { s.cleanup() }
})

test('[破坏性] 输出文件已存在时拒绝覆盖', () => {
  const s = sandbox()
  try {
    const app = fixtureApp(s.root)
    const output = path.join(s.root, 'a.dmg')
    fs.writeFileSync(output, 'previous release')
    assert.throws(() => createMacDmg({ app, output }, { platform: 'darwin', exec: fakeExec().exec }), /输出文件已存在/)
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous release')
  } finally { s.cleanup() }
})

test('成功路径：ditto 复制 → Applications 快捷方式 → hdiutil 生成并校验，写出 SHA-256，清理暂存目录', () => {
  const s = sandbox()
  try {
    const app = fixtureApp(s.root)
    const output = path.join(s.root, 'ZTools.dmg')
    const fake = fakeExec()
    let stagedEntries
    const exec = (cmd, args) => {
      if (path.basename(cmd) === 'hdiutil' && args[0] === 'create') {
        const src = args[args.indexOf('-srcfolder') + 1]
        stagedEntries = fs.readdirSync(src).sort()
        assert.equal(fs.readlinkSync(path.join(src, 'Applications')), '/Applications')
      }
      return fake.exec(cmd, args)
    }
    const result = createMacDmg({ app, output }, { platform: 'darwin', exec, tmpdir: () => s.tmp, log: () => {} })
    assert.deepEqual(fake.calls.map((c) => c.name), ['codesign --verify', `ditto ${app}`, 'hdiutil create', 'hdiutil verify'])
    assert.deepEqual(stagedEntries, ['Applications', 'ZTools.app'])
    assert.equal(result.status, 'PASS')
    assert.equal(result.dmgSigned, false)
    assert.match(fs.readFileSync(`${output}.sha256`, 'utf8'), new RegExp(`^${result.sha256}  ZTools\\.dmg\\n$`))
    assert.deepEqual(fs.readdirSync(s.tmp), [], '暂存目录已清理')
  } finally { s.cleanup() }
})

test('传入签名身份时为 DMG 签名并校验', () => {
  const s = sandbox()
  try {
    const app = fixtureApp(s.root)
    const output = path.join(s.root, 'ZTools.dmg')
    const fake = fakeExec()
    const result = createMacDmg({ app, output, signIdentity: IDENTITY }, { platform: 'darwin', exec: fake.exec, tmpdir: () => s.tmp, log: () => {} })
    const sign = fake.calls.find((c) => c.name === 'codesign --sign')
    assert.deepEqual(sign.args, ['--sign', IDENTITY, '--timestamp', output])
    assert.equal(fake.calls.at(-1).name, 'codesign --verify')
    assert.equal(result.dmgSigned, true)
  } finally { s.cleanup() }
})

test('[破坏性] hdiutil 校验或签名失败时删除半成品 DMG 并清理暂存目录', () => {
  for (const failOn of ['hdiutil verify', 'codesign --sign']) {
    const s = sandbox()
    try {
      const app = fixtureApp(s.root)
      const output = path.join(s.root, 'ZTools.dmg')
      const fake = fakeExec({ failOn })
      assert.throws(() => createMacDmg({ app, output, signIdentity: IDENTITY }, { platform: 'darwin', exec: fake.exec, tmpdir: () => s.tmp, log: () => {} }), /模拟失败/)
      assert.equal(fs.existsSync(output), false, failOn)
      assert.equal(fs.existsSync(`${output}.sha256`), false, failOn)
      assert.deepEqual(fs.readdirSync(s.tmp), [], failOn)
    } finally { s.cleanup() }
  }
})

test('main 对非法参数返回非零退出码', () => {
  const errors = []
  const original = console.error
  console.error = (message) => errors.push(message)
  try {
    assert.equal(main(['--app', 'relative.app', '--output', '/x/a.dmg']), 1)
  } finally {
    console.error = original
  }
  assert.match(errors[0], /--app 必须是 .app 的绝对路径/)
})

// 真实工具链集成：只在 macOS 上运行，用系统 hdiutil 生成并挂载检查
test('[集成] 真实 hdiutil 生成可挂载的 DMG，内含 .app 与 Applications 快捷方式', { skip: process.platform === 'darwin' ? false : '需要 macOS hdiutil' }, () => {
  const s = sandbox()
  const mount = path.join(s.root, 'mnt')
  try {
    const app = fixtureApp(s.root)
    const output = path.join(s.root, 'ZTools-test.dmg')
    const result = createMacDmg({ app, output, allowUnsigned: true }, { platform: 'darwin', tmpdir: () => s.tmp, log: () => {} })
    assert.equal(result.appSigned, false)
    fs.mkdirSync(mount)
    execFileSync('/usr/bin/hdiutil', ['attach', output, '-nobrowse', '-readonly', '-mountpoint', mount], { stdio: 'pipe' })
    try {
      assert.deepEqual(fs.readdirSync(mount).filter((n) => !n.startsWith('.')).sort(), ['Applications', 'ZTools.app'])
      assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications')
      assert.equal(fs.existsSync(path.join(mount, 'ZTools.app', 'Contents', 'Info.plist')), true)
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { stdio: 'pipe' })
    }
  } finally { s.cleanup() }
})
