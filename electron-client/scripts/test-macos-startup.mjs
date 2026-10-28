import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const supported = process.platform === 'darwin' && process.getuid() !== 0
let directory, helper
before(() => {
  if (!supported) return
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-startup-native-')))
  helper = path.join(directory, 'ZToolsMacStartupFixture')
  execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-framework', 'Foundation', '-DZTOOLS_STARTUP_FIXTURE', path.join(root, 'native/ZToolsMacStartup/main.mm'), '-o', helper], { timeout: 60000, stdio: 'pipe' })
})
after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }) })
function fixture({ scope = 'user-agent', program, label = 'cn.ztools.startup.fixture' } = {}) {
  const home = fs.mkdtempSync(path.join(directory, 'case-')), config = path.join(home, scope === 'user-agent' ? 'Library/LaunchAgents' : scope)
  fs.mkdirSync(config, { mode: 0o700, recursive: true })
  const requestDir = path.join(home, 'request'); fs.mkdirSync(requestDir, { mode: 0o700 })
  const file = path.join(config, 'fixture.plist'), programPath = program || path.join(home, 'missing-program')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>Program</key><string>${programPath}</string></dict></plist>`
  fs.writeFileSync(file, xml, { mode: 0o600 })
  const stat = fs.statSync(file), id = randomUUID()
  const body = { version: 1, action: 'toggle', scope, filename: path.basename(file), label, original: Buffer.from(xml).toString('base64'), identity: `${stat.dev}:${stat.ino}`, override: null, backupId: id, deadline: Date.now() + 60000, enabled: false }
  const invoke = patch => {
    fs.writeFileSync(path.join(requestDir, 'request.json'), JSON.stringify({ ...body, ...patch }), { mode: 0o600 })
    return JSON.parse(execFileSync(helper, ['--apply', path.join(requestDir, 'request.json'), String(process.getuid()), home], { encoding: 'utf8', timeout: 10000 }))
  }
  return { home, config, file, xml, body, invoke, requestDir, archive: path.join(config, '.ztools-startup-recovery', id) }
}
const options = { skip: !supported }
test('原生切换通过固定标签和域读回确认，配置字节不变', options, () => {
  const f = fixture(), first = f.invoke({})
  assert.equal(first.success, true); assert.equal(first.code, 'APPLIED'); assert.equal(fs.readFileSync(f.file, 'utf8'), f.xml)
  assert.equal(f.invoke({ enabled: true, override: true }).success, true)
  const values = JSON.parse(fs.readFileSync(path.join(f.home, 'overrides.json'), 'utf8'))
  assert.equal(values[`gui/${process.getuid()}/${f.body.label}`], false)
})
test('原生清理与恢复真实文件：先备份，保留 inode、权限与字节，不修改自启覆盖', options, () => {
  for (const scope of ['user-agent', 'system-agent', 'daemon']) {
    const f = fixture({ scope }), before = fs.statSync(f.file)
    assert.equal(f.invoke({ action: 'remove' }).success, true); assert.equal(fs.existsSync(f.file), false)
    assert.equal(fs.readFileSync(path.join(f.archive, 'original.copy'), 'utf8'), f.xml)
    assert.equal(fs.readFileSync(path.join(f.archive, 'original.plist'), 'utf8'), f.xml)
    assert.equal(f.invoke({ action: 'restore' }).success, true)
    const after = fs.statSync(f.file); assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid)
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.xml); assert.equal(fs.existsSync(path.join(f.home, 'overrides.json')), false)
  }
})
test('恢复绝不覆盖后续新文件，备份继续可用', options, () => {
  const f = fixture(); assert.equal(f.invoke({ action: 'remove' }).success, true)
  fs.writeFileSync(f.file, 'later configuration', { mode: 0o600 })
  const reply = f.invoke({ action: 'restore' }); assert.equal(reply.success, false); assert.match(reply.code, /TARGET_EXISTS/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'later configuration'); assert.equal(fs.readFileSync(path.join(f.archive, 'original.plist'), 'utf8'), f.xml)
})
test('路径穿越、Apple 系统标签、原配置变化与覆盖变化均拒绝', options, () => {
  const f = fixture()
  for (const patch of [{ filename: '../outside.plist' }, { label: 'com.apple.launchd' }, { original: Buffer.from('bad').toString('base64') }, { override: true }]) assert.equal(f.invoke(patch).success, false)
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.xml); assert.equal(fs.existsSync(path.join(f.home, 'overrides.json')), false)
})
test('正常程序不允许清理；取消及过期请求不能改变任何配置', options, () => {
  const f = fixture({ program: '/usr/bin/true' })
  const clean = f.invoke({ action: 'remove' }); assert.equal(clean.success, false); assert.equal(clean.code, 'PROGRAM_NOT_MISSING')
  assert.equal(f.invoke({ deadline: Date.now() - 1 }).code, 'CANCELLED_OR_EXPIRED')
  fs.writeFileSync(path.join(f.requestDir, 'cancel'), 'cancel')
  assert.equal(f.invoke({}).code, 'CANCELLED_OR_EXPIRED'); assert.equal(fs.readFileSync(f.file, 'utf8'), f.xml)
})
test('备份绑定原路径和状态；不能通过改名恢复成另一个配置', options, () => {
  const f = fixture(); assert.equal(f.invoke({ action: 'remove' }).success, true)
  assert.equal(f.invoke({ action: 'restore', filename: 'another.plist' }).code, 'RECOVERY_BINDING_CHANGED')
  assert.equal(fs.existsSync(path.join(f.config, 'another.plist')), false)
  assert.equal(f.invoke({ action: 'restore' }).success, true)
})
test('符号链接、硬链接及 FIFO 均不写入，不阻塞', options, () => {
  for (const kind of ['symlink', 'hardlink', 'fifo']) {
    const f = fixture(), other = path.join(f.home, 'other'); fs.renameSync(f.file, other)
    if (kind === 'symlink') fs.symlinkSync(other, f.file)
    else if (kind === 'hardlink') fs.linkSync(other, f.file)
    else execFileSync('/usr/bin/mkfifo', [f.file])
    assert.equal(f.invoke({}).success, false); assert.equal(fs.readFileSync(other, 'utf8'), f.xml)
  }
})
test('命令关闭输出但仍运行时有退出超时，结束后子进程已回收', options, () => {
  const file = path.join(directory, 'eof-child.pid'), started = Date.now()
  const result = JSON.parse(execFileSync(helper, ['--child-fixture', 'eof', file], { encoding: 'utf8', timeout: 9000 }))
  assert.equal(result.success, false); assert.equal(result.code, 'COMMAND_TIMEOUT'); assert.ok(Date.now() - started < 8000)
  const pid = Number(fs.readFileSync(file, 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
test('取消期间先结束并回收真实子进程，再返回取消结果', options, async () => {
  const file = path.join(directory, 'cancel-child.pid'), child = spawn(helper, ['--child-fixture', 'cancel', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', value => { output += value })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  try {
    for (let n = 0; n < 100 && !fs.existsSync(file); n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(fs.existsSync(file)); const pid = Number(fs.readFileSync(file, 'utf8'))
    child.kill('SIGTERM'); assert.deepEqual(await exited, { code: 0, signal: null })
    assert.equal(JSON.parse(output).code, 'CANCELLED_OR_EXPIRED'); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally { child.kill('SIGKILL'); await exited }
})
