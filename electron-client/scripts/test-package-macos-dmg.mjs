import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

const NOTARY_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

// 公证模拟：submit 返回指定结果；staple 往 DMG 追加票据，验证 SHA-256 在公证之后计算
function notaryExec({ status = 'Accepted', submitThrows = false, garbage = false, failOn } = {}) {
  const fake = fakeExec({ failOn })
  const exec = (cmd, args) => {
    const name = `${path.basename(cmd)} ${args[0]}`
    if (name === 'xcrun notarytool' && args[1] === 'submit') {
      fake.calls.push({ name: 'notarytool submit', cmd, args })
      const body = garbage ? 'not json' : JSON.stringify({ id: NOTARY_ID, status, message: 'Processing complete' })
      if (submitThrows) {
        const err = new Error('Command failed')
        err.stdout = submitThrows === 'empty' ? '' : body
        throw err
      }
      return body
    }
    if (name === 'xcrun notarytool' && args[1] === 'log') {
      fake.calls.push({ name: 'notarytool log', cmd, args })
      return '{"issues":[{"path":"ZTools.app/Contents/MacOS/ZTools","message":"The signature does not include a secure timestamp."}]}'
    }
    if (name === 'xcrun stapler' && args[1] === 'staple') {
      fake.calls.push({ name: 'stapler staple', cmd, args })
      if (failOn === 'stapler staple') throw new Error('模拟失败: stapler staple')
      fs.appendFileSync(args[2], '+ticket')
      return ''
    }
    if (name === 'xcrun stapler') {
      fake.calls.push({ name: `stapler ${args[1]}`, cmd, args })
      return ''
    }
    if (name === 'spctl --assess') {
      fake.calls.push({ name, cmd, args })
      if (failOn === 'spctl --assess') throw new Error('模拟失败: spctl --assess')
      return ''
    }
    return fake.exec(cmd, args)
  }
  return { exec, calls: fake.calls }
}

test('参数校验：--notary-profile 必须和 --sign-identity 一起用，名称只允许安全字符', () => {
  const base = ['--app', '/x/ZTools.app', '--output', '/x/a.dmg']
  assert.throws(() => parseDmgArguments([...base, '--notary-profile', 'ztools-notary']), /必须与 --sign-identity 一起使用/)
  assert.throws(() => parseDmgArguments([...base, '--sign-identity', IDENTITY, '--notary-profile', 'a b;rm']), /只能包含/)
  assert.equal(parseDmgArguments([...base, '--sign-identity', IDENTITY, '--notary-profile', 'ztools-notary']).notaryProfile, 'ztools-notary')
})

test('公证成功：签名 → 提交公证 → staple → Gatekeeper 验证，SHA-256 按 staple 之后的文件计算', () => {
  const s = sandbox()
  try {
    const app = fixtureApp(s.root)
    const output = path.join(s.root, 'ZTools.dmg')
    const fake = notaryExec()
    const result = createMacDmg({ app, output, signIdentity: IDENTITY, notaryProfile: 'ztools-notary' }, { platform: 'darwin', exec: fake.exec, tmpdir: () => s.tmp, log: () => {} })
    assert.deepEqual(fake.calls.map((c) => c.name).slice(-6), ['codesign --sign', 'codesign --verify', 'notarytool submit', 'stapler staple', 'stapler validate', 'spctl --assess'])
    const submit = fake.calls.find((c) => c.name === 'notarytool submit')
    assert.deepEqual(submit.args, ['notarytool', 'submit', output, '--keychain-profile', 'ztools-notary', '--wait', '--output-format', 'json'])
    assert.equal(result.dmgNotarized, true)
    assert.equal(fs.readFileSync(output, 'utf8'), 'fake-dmg+ticket')
    assert.equal(result.sha256, createHash('sha256').update('fake-dmg+ticket').digest('hex'), '校验值必须对应 staple 后的最终文件')
    assert.match(fs.readFileSync(`${output}.sha256`, 'utf8'), new RegExp(`^${result.sha256}  ZTools\\.dmg\\n$`))
  } finally { s.cleanup() }
})

test('[破坏性] 公证未通过、notarytool 非 0 退出、返回畸形、staple 或 Gatekeeper 失败：删除半成品，不写校验文件', () => {
  const cases = [
    [{ status: 'Invalid' }, /NOTARY_NOT_ACCEPTED[\s\S]*Invalid[\s\S]*secure timestamp/],
    [{ status: 'Invalid', submitThrows: true }, /NOTARY_NOT_ACCEPTED[\s\S]*0f1e2d3c/],
    [{ submitThrows: 'empty' }, /NOTARY_SUBMIT_FAILED/],
    [{ garbage: true }, /NOTARY_RESPONSE_INVALID/],
    [{ failOn: 'stapler staple' }, /模拟失败: stapler staple/],
    [{ failOn: 'spctl --assess' }, /模拟失败: spctl --assess/]
  ]
  for (const [opts, expected] of cases) {
    const s = sandbox()
    try {
      const app = fixtureApp(s.root)
      const output = path.join(s.root, 'ZTools.dmg')
      const fake = notaryExec(opts)
      assert.throws(() => createMacDmg({ app, output, signIdentity: IDENTITY, notaryProfile: 'ztools-notary' }, { platform: 'darwin', exec: fake.exec, tmpdir: () => s.tmp, log: () => {} }), expected, JSON.stringify(opts))
      assert.equal(fs.existsSync(output), false, JSON.stringify(opts))
      assert.equal(fs.existsSync(`${output}.sha256`), false, JSON.stringify(opts))
      assert.deepEqual(fs.readdirSync(s.tmp), [])
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
