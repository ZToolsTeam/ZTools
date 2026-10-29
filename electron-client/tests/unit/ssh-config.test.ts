import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readSshConfigurationFile, readSshDocuments, sshConfigTokens } from '../../src/main/services/ssh-config-reader.js'
import { sshProfiles, validSshAlias } from '../../src/main/services/ssh-config-profiles.js'

const signal = () => new AbortController().signal
async function fixture(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-ssh-read-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  if (process.platform === 'win32') {
    // 系统 OpenSSH 会检查 Include 文件 ACL；只收紧本用例新建目录，不更改用户 SSH 配置。
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-(?:\d+-)+\d+/)?.[0]
    if (!sid) throw new Error('无法读取测试目录所有者 SID')
    execFileSync('icacls.exe', [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true })
  }
  const systemDirectory = path.join(home, 'system'), config = path.join(home, '.ssh', 'config')
  await fs.mkdir(systemDirectory)
  const put = async (relative: string, content: string | Buffer) => {
    const file = path.join(home, relative)
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file
  }
  const options = { home, systemDirectory, environment: {}, username: 'fixture-user' }
  const read = () => readSshDocuments(options, signal())
  return { home, config, options, put, read }
}

test('拆词遵循 SSH 的等号、注释、引号和转义；不展开命令或环境变量', () => {
  for (const line of ['User alice', 'User=alice', 'User = alice', '\tUser\t=\talice #说明']) assert.deepEqual(sshConfigTokens(line), ['User', 'alice'])
  const pairs: [string, string][] = [
    ['User alice#x #说明', 'alice#x'], ['User "a#b"', 'a#b'], ['User "alice"rest', 'alicerest'],
    [String.raw`User "a\zb"`, String.raw`a\zb`], [String.raw`User "a\ b"`, String.raw`a\ b`],
    [String.raw`User a\ b`, 'a b'], [String.raw`User a\#b`, String.raw`a\#b`],
    [String.raw`User "a\"b"`, 'a"b'], [String.raw`User 'a\'b'`, "a'b"], ['User alice\\', 'alice\\'],
    ['User "$(touch marker) ${USER}"', '$(touch marker) ${USER}']
  ]
  for (const [line, expected] of pairs) assert.deepEqual(sshConfigTokens(line), ['User', expected])
  assert.deepEqual(sshConfigTokens(' # 注释'), [])
  for (const line of ['User "bad', 'User bad\0', 'User ' + 'a'.repeat(32768), '=x']) assert.throws(() => sshConfigTokens(line))
})

test('真实文件与系统 SSH 对照：Include 排序、首值优先、负向 Host、带 # 的内容', async t => {
  const f = await fixture(t)
  // -F 不改变 OpenSSH 的用户家目录；对照夹具必须使用隔离目录的绝对 Include。
  await f.put('.ssh/config', `Include "${path.join(f.home, '.ssh/conf.d/*.conf').replaceAll('\\', '/')}"\nHost alpha beta\n Port = 2222\n IdentityFile "~/.ssh/key #1"\nHost * !beta\n ProxyJump bastion\nHost *\n User fallback\n Port 22\n`)
  await f.put('.ssh/conf.d/02.conf', 'Host alpha\n Port 2202\n HostName a.example\nHost beta\n HostName b.example\n')
  await f.put('.ssh/conf.d/01.conf', 'Host alpha beta\n User user#name\nHost alpha\n Port 2201\n')
  const before = await fs.readFile(f.config), result = sshProfiles(await f.read())
  assert.deepEqual(result.hosts.map(h => h.alias), ['alpha', 'beta'])
  for (const host of result.hosts) {
    // 仅此无 Match/ProxyCommand 的隔离夹具交给 ssh -G；从不对用户配置执行。
    const ssh = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh'
    const output = execFileSync(ssh, ['-G', '-F', f.config, host.alias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
    const get = (key: string) => output.split(/\r?\n/).find(line => line.startsWith(key + ' '))?.slice(key.length + 1)
    assert.equal(host.hostName, get('hostname')); assert.equal(host.user, get('user')); assert.equal(host.port, Number(get('port')))
    assert.equal(host.proxyJump, get('proxyjump')); assert.deepEqual(host.identityFiles, ['~/.ssh/key #1']); assert.equal(host.previewComplete, true)
  }
  assert.deepEqual(await fs.readFile(f.config), before)
})

test('Include 的作用域还原、相对路径基于 ~/.ssh、非活动 Include 不产生伪主机', async t => {
  const f = await fixture(t)
  await f.put('.ssh/config', 'Host alpha\n Include nested/entry\n Port 2300\nHost beta\n User beta-user\nHost blocked\n Include unreachable\n')
  await f.put('.ssh/nested/entry', 'Include sibling\nHost nobody\n Port 9999\n')
  await f.put('.ssh/sibling', 'User alice\n')
  await f.put('.ssh/unreachable', 'Host phantom\n User ghost\n')
  const result = sshProfiles(await f.read())
  assert.deepEqual(result.hosts.map(h => h.alias), ['alpha', 'beta', 'blocked'])
  assert.equal(result.hosts[0]!.user, 'alice'); assert.equal(result.hosts[0]!.port, 2300)
  assert.equal(result.hosts[1]!.user, 'beta-user'); assert.equal(result.hosts[1]!.port, undefined)
})

test('真实绝对路径与通配 Include 保留盘符根、按文件名排序且不修改配置', async t => {
  const f = await fixture(t)
  const pattern = path.join(f.home, '.ssh', 'parts', '*.conf').replaceAll('\\', '/')
  await f.put('.ssh/config', `Include "${pattern}"\nHost alpha\n Port 2222\n`)
  await f.put('.ssh/parts/02.conf', 'Host alpha\n User second\n')
  await f.put('.ssh/parts/01.conf', 'Host alpha\n User first\n')
  const before = await fs.readFile(f.config)
  const result = sshProfiles(await f.read())
  assert.equal(result.hosts[0]?.user, 'first')
  assert.equal(result.hosts[0]?.port, 2222)
  assert.deepEqual(await fs.readFile(f.config), before)
})

test('未知 Match 的 Include 保持未知，不执行 Match exec、ProxyCommand 或 LocalCommand', async t => {
  const f = await fixture(t), marker = path.join(f.home, 'must-not-exist')
  await f.put('.ssh/config', `Host alpha\nMatch exec "touch ${marker}"\n Include conditional\nHost *\n ProxyCommand touch ${marker}\n LocalCommand touch ${marker}\n`)
  await f.put('.ssh/conditional', 'Host alpha\n User secret-user\nMatch all\n HostName conditional.example\n Port 2222\n')
  const result = sshProfiles(await f.read()), host = result.hosts[0]!
  assert.equal(host.previewComplete, false); assert.equal(host.user, undefined); assert.equal(host.hostName, undefined); assert.equal(host.port, undefined)
  assert.ok(host.notices.some(text => text.includes('Match')))
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
})

test('重复动态 Include 与未设置环境变量都保留未知标记，不误扫替代路径', async t => {
  const f = await fixture(t)
  await f.put('.ssh/config', 'Host alpha\n Include %h/config\nHost beta\n Include %h/config\nHost gamma\n Include ${MISSING}/config\n')
  const documents = await f.read(), includes = documents.documents[0]!.directives.filter(item => item.key === 'include')
  assert.deepEqual(includes.map(item => item.unresolved), [true, true, true])
  for (const host of sshProfiles(documents).hosts) { assert.equal(host.previewComplete, false); assert.equal(host.hostName, undefined) }
})

test('环境与 %% 静态 Include，系统默认值、用户优先、缺失文件与真实空配置可区分', async t => {
  const f = await fixture(t), missing = await f.read()
  assert.equal(missing.userConfigExists, false); assert.deepEqual(sshProfiles(missing).hosts, [])
  await f.put('.ssh/config', 'Include ${SSH_FIXTURE}/%%file\nHost alpha beta\nHost alpha\n User local-user\n')
  await f.put('extra/%file', 'Host alpha\n Port 2222\n')
  await f.put('system/ssh_config', 'Host *\n User system-user\n Port 22\n')
  const docs = await readSshDocuments({ ...f.options, environment: { SSH_FIXTURE: path.join(f.home, 'extra') } }, signal())
  const hosts = sshProfiles(docs).hosts
  assert.equal(docs.userConfigExists, true); assert.equal(hosts[0]!.user, 'local-user'); assert.equal(hosts[0]!.port, 2222)
  assert.equal(hosts[1]!.user, 'system-user'); assert.equal(hosts[1]!.port, 22)
  await f.put('.ssh/config', '')
  const empty = await f.read(); assert.equal(empty.userConfigExists, true); assert.deepEqual(sshProfiles(empty).hosts, [])
})

test('配置损坏、断链、目录、循环与超限都显式失败，不返回没有主机', async t => {
  const f = await fixture(t)
  for (const content of ['Host alpha\n User "broken', 'Host\n', Buffer.from([0xff, 0xfe]), 'a'.repeat(256 * 1024 + 1)]) {
    await f.put('.ssh/config', content); await assert.rejects(f.read())
  }
  await f.put('.ssh/config', 'Include again\n'); await f.put('.ssh/again', 'Include config\n')
  await assert.rejects(f.read(), /循环/)
  if (process.platform !== 'win32') {
    await fs.unlink(f.config); await fs.symlink(path.join(f.home, 'missing-target'), f.config)
    await assert.rejects(f.read(), /链接或路径/)
  }
  await fs.unlink(f.config); await fs.mkdir(f.config)
  await assert.rejects(f.read(), /普通文件/)
})

test('FIFO 不阻塞、有界读取、取消可重试，文件句柄关闭后仍能读取新配置', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), fifo = path.join(f.home, 'pipe')
  execFileSync('/usr/bin/mkfifo', [fifo])
  const start = Date.now(); await assert.rejects(readSshConfigurationFile(fifo, signal()), /普通文件/); assert.ok(Date.now() - start < 2000)
  await f.put('.ssh/config', 'Host alpha\n Port 22\n')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readSshDocuments(f.options, controller.signal))
  const first = await f.read(); assert.equal(sshProfiles(first).hosts.length, 1)
  await f.put('.ssh/config', 'Host alpha\n Port 23\n')
  const changed = await f.read(); assert.notEqual(changed.revision, first.revision); assert.equal(sshProfiles(changed).hosts[0]!.port, 23)
})

test('别名拒绝选项、命令注入与控制字符；端口错误显式失败', async t => {
  for (const alias of ['alpha', '主机', 'server.example', 'server:2222', '_dev']) assert.equal(validSshAlias(alias), true)
  for (const alias of ['', '-oProxyCommand=bad', 'a\nb', 'a b', 'a;touch', '$(bad)', 'user@host', 'a'.repeat(256), null]) assert.equal(validSshAlias(alias), false)
  const f = await fixture(t)
  for (const port of ['0', '-1', '65536', 'oops']) {
    await f.put('.ssh/config', `Host alpha\n Port ${port}\n`)
    const documents = await f.read(); assert.throws(() => sshProfiles(documents), /端口/)
  }
})

test('病态通配符无指数回溯，模式长度与全扫描工作量有界', async t => {
  const f = await fixture(t), alias = 'a'.repeat(100)
  await f.put('.ssh/config', `Host ${alias}\n User good\nHost ${'*a'.repeat(100)}b\n User wrong\n`)
  const documents = await f.read(), start = Date.now(), result = sshProfiles(documents)
  assert.equal(result.hosts[0]!.user, 'good'); assert.ok(Date.now() - start < 1000)
  await f.put('.ssh/config', `Host alpha\nHost ${'*'.repeat(1025)}\n`)
  const long = await f.read(); assert.throws(() => sshProfiles(long), /1024/)
  const aliases = Array.from({ length: 1000 }, (_v, i) => `host${i}`)
  await f.put('.ssh/config', aliases.map(name => `Host ${name}\n User test\n`).join(''))
  const many = await f.read(); assert.throws(() => sshProfiles(many), /工作量/)
})

test('累积身份与转发配置逐项追加且有数量上限', async t => {
  const f = await fixture(t)
  for (const directive of ['IdentityFile key', 'LocalForward 8080 localhost:80']) {
    await f.put('.ssh/config', 'Host alpha\n' + (directive + '\n').repeat(256))
    const allowed = sshProfiles(await f.read()).hosts[0]!
    assert.equal(Math.max(allowed.identityFiles.length, allowed.localForwards.length), 256)
    await f.put('.ssh/config', 'Host alpha\n' + (directive + '\n').repeat(257))
    const documents = await f.read(); assert.throws(() => sshProfiles(documents), /累积配置条目/)
  }
})

test('共享长字段与主机名展开有整轮容量上限，不生成巨型 IPC 结果', async t => {
  const f = await fixture(t)
  const aliases = Array.from({ length: 400 }, (_v, i) => `host${i}`).join(' ')
  await f.put('.ssh/config', `Host ${aliases}\n` + `IdentityFile ${'a'.repeat(900)}\n`.repeat(256))
  const shared = await f.read()
  assert.throws(() => sshProfiles(shared), /预览容量/)
  await f.put('.ssh/config', `Host ${'a'.repeat(255)}\n HostName ${'%h'.repeat(16000)}\n`)
  const expanded = await f.read()
  assert.throws(() => sshProfiles(expanded), /预览容量/)
  await f.put('.ssh/config', 'Host alpha beta\n IdentityFile ~/.ssh/key\n HostName %h.example\n')
  const small = sshProfiles(await f.read())
  assert.deepEqual(small.hosts.map(h => h.hostName), ['alpha.example', 'beta.example'])
})
