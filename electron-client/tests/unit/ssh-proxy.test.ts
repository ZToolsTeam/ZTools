import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateSshProxyRequest, type ProxyChange, type ProxyTool } from '../../src/contracts/ssh-proxy.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { NativePathAccessAdapter } from '../../src/main/platform/native-path-access.js'
import { ProxyConfigurationProvider, displayProxy, replaceNpmProxy, readProxyFile, findWindowsGit } from '../../src/main/services/proxy-configuration.js'
import { EnvironmentBackupStore } from '../../src/main/services/environment-backups.js'
import { SshProxyService } from '../../src/main/services/ssh-proxy-service.js'
import { SshTerminalLauncher, WindowsTerminalLauncher, shellArgument, sshArguments, proxyTerminalArguments, windowsProxyTerminalArguments, windowsProxyEnvironment, type TerminalOpen, type ConsoleStart } from '../../src/main/services/ssh-terminal.js'
import { runBoundedProcess } from '../../src/main/services/bounded-process.js'

const mac = process.platform === 'darwin', signal = () => new AbortController().signal
const helper = path.resolve(__dirname, '../../../out/native/darwin-universal/path-access/native/ZToolsPathAccessBroker')
const caller: CallerIdentity = { type: 'plugin', webContentsId: 613, pluginId: 'ssh-proxy-helper', pluginInstanceId: 'audit-ssh' }
interface Snapshot { sessionId: string; ssh: { status: string; hosts: Array<{ alias: string }>; error?: string }; proxies: Array<{ tool: ProxyTool; status: string; values?: Array<{ key: string; value: string }> }>; backups: Array<{ id: string; tool: string }>; backupError: string }
async function fixture(t: TestContext, open?: TerminalOpen) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-proxy-test-')))
  const system = path.join(root, 'system'), backupDirectory = path.join(root, 'backups')
  await fs.mkdir(path.join(root, '.ssh')); await fs.mkdir(system)
  await fs.writeFile(path.join(root, '.ssh/config'), 'Host fixture\n HostName 127.0.0.1\n Port 65534\n User example\n')
  const git = path.join(root, '.gitconfig'), npm = path.join(root, '.npmrc')
  await fs.writeFile(git, '# 保留 Git 注释\n[user]\n name = fixture-user\n email = fixture@example.invalid\n[http]\n proxy = http://old:8888\n')
  await fs.writeFile(npm, '# 保留 NPM 注释\nregistry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=FAKE_TOKEN_KEEP\nproxy=http://old:8888\n')
  const environment = { HOME: root, PATH: '/usr/bin:/bin' }
  const provider = new ProxyConfigurationProvider(() => new NativePathAccessAdapter(helper, 15000), root, environment)
  const backups = new EnvironmentBackupStore(backupDirectory), scripts: string[] = []
  const terminal = new SshTerminalLauncher(open ?? (async file => { scripts.push(await fs.readFile(file, 'utf8')); execFileSync('/bin/sh', ['-n', file]) }), root)
  const service = new SshProxyService(provider, backups, terminal, { home: root, systemDirectory: system, environment }, 'darwin')
  t.after(async () => { await service.stop(); await fs.rm(root, { recursive: true, force: true }) })
  const call = (request: unknown, who = caller, abort = signal()) => service.handle(request, who, abort)
  const scan = async () => await call({ action: 'scan' }) as Snapshot
  const prepare = async (tool: ProxyTool, change: ProxyChange, snapshot?: Snapshot) => await call({ action: 'prepare', sessionId: (snapshot ?? await scan()).sessionId, tool, change }) as { planId: string; summary: string }
  const apply = async (tool: ProxyTool, change: ProxyChange) => await call({ action: 'apply', planId: (await prepare(tool, change)).planId }) as { verified: boolean; backupId: string; recoveryPath?: string }
  return { root, git, npm, backupDirectory, provider, backups, terminal, service, scripts, call, scan, prepare, apply }
}

test('IPC 只接受封闭参数；别名、隧道端口和配置计划不能被选项或任意路径替换', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  assert.equal(canCall('ssh_proxy', caller), true)
  validateMethodParams('ssh_proxy', { action: 'scan' })
  validateSshProxyRequest({ action: 'tunnel', sessionId, alias: 'fixture', tunnel: { localPort: 8080, remoteHost: '[::1]', remotePort: 80 } })
  for (const bad of [null, [], { action: ['scan'] }, { action: 'scan', path: '/etc/hosts' }, { action: 'connect', sessionId, alias: '-oProxyCommand=x' },
    { action: 'terminal-proxy', port: 0 }, { action: 'terminal-proxy', port: 65536 }, { action: 'apply', planId: 'bad' },
    { action: 'prepare', sessionId, tool: ['git'], change: { kind: 'clear' } }, { action: 'prepare', sessionId, tool: 'npm', change: { kind: 'set', port: 7890, path: '/tmp/x' } },
    { action: 'tunnel', sessionId, alias: 'fixture', tunnel: { localPort: 8080, remoteHost: 'host;touch bad', remotePort: 80 } }]) assert.throws(() => validateSshProxyRequest(bad))
})
test('NPM 仅修改顶层代理行，注释、认证、数组、转义键和其他节保持原样', () => {
  const remaining = '# keep\r\n//host/:_authToken=FAKE_KEEP\r\nregistry=https://example.invalid/\r\nca[]=first\r\nca[]=second\r\n[scope]\r\nproxy=section-value\r\n'
  const original = '"proxy"=http://old:8080\r\nhttps-proxy=http://old:8081\r\n' + remaining
  const next = replaceNpmProxy(original, 'http://127.0.0.1:7890')
  assert.equal(next, 'proxy=http://127.0.0.1:7890\r\nhttps-proxy=http://127.0.0.1:7890\r\n' + remaining)
  assert.equal(replaceNpmProxy(next, null), remaining)
  const displayed = displayProxy('proxy', 'http://fixture:SECRET@localhost:7890/path?token=MORE_SECRET')!
  assert.equal(displayed.hasCredentials, true); assert.equal(JSON.stringify(displayed).includes('SECRET'), false)
  assert.equal(displayProxy('proxy', '${PROXY}')!.dynamic, true)
  for (const value of [true, ['http://x'], 'bad', 'http://x\nsecret']) assert.throws(() => displayProxy('proxy', value))
})
test('扫描失败明确显示错误；SSH、Git 的失败不伪造空列表或阻断正常 NPM', { skip: !mac }, async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, '.ssh/config'), 'Host "broken')
  await fs.writeFile(f.git, '[bad\n')
  const result = await f.scan()
  assert.equal(result.ssh.status, 'error'); assert.ok(result.ssh.error)
  assert.equal(result.proxies.find(row => row.tool === 'git')!.status, 'error')
  assert.equal(result.proxies.find(row => row.tool === 'npm')!.status, 'ready')
  assert.equal(JSON.stringify(result).includes('FAKE_TOKEN_KEEP'), false)
  assert.equal((await f.apply('npm', { kind: 'set', port: 7890 })).verified, true)
  await assert.rejects(f.prepare('git', { kind: 'set', port: 7890 }), /读取失败/)
})
test('真实 Git、NPM 文件经原生安全组件写入、读回、重启读取与备份恢复', { skip: !mac }, async t => {
  const f = await fixture(t)
  for (const tool of ['git', 'npm'] as const) {
    const file = f[tool], original = await fs.readFile(file, 'utf8'), result = await f.apply(tool, { kind: 'set', port: 7890 })
    assert.equal(result.verified, true); assert.ok(result.recoveryPath)
    assert.equal(await fs.readFile(result.recoveryPath!, 'utf8'), original)
    const fresh = new ProxyConfigurationProvider(() => new NativePathAccessAdapter(helper), f.root, { HOME: f.root })
    const rows = await fresh.inspect(tool, await fresh.read(tool, signal()), signal())
    assert.ok(rows.values.every(value => value.value === 'http://127.0.0.1:7890'))
    if (tool === 'npm') assert.ok((await fs.readFile(file, 'utf8')).includes('//registry.example.invalid/:_authToken=FAKE_TOKEN_KEEP\n'))
    await f.apply(tool, { kind: 'restore', backupId: result.backupId })
    assert.equal(await fs.readFile(file, 'utf8'), original)
  }
})
test('清除只移除当前文件的通用代理，保留网址专用代理和其他来源', { skip: !mac }, async t => {
  const f = await fixture(t)
  await fs.appendFile(f.git, '[http "https://example.invalid"]\n proxy = http://scoped:8080\n[include]\n path = definitely-not-read\n')
  await f.apply('git', { kind: 'clear' })
  const raw = await fs.readFile(f.git, 'utf8')
  assert.ok(raw.includes('http://scoped:8080')); assert.ok(raw.includes('definitely-not-read'))
  const inspected = await f.provider.inspect('git', await f.provider.read('git', signal()), signal())
  assert.equal(inspected.values.length, 0); assert.ok(inspected.notices[0]!.includes('可能覆盖'))
})
test('没有原文件时安全新建，恢复后回到不存在并保留备份', { skip: !mac }, async t => {
  const f = await fixture(t); await fs.unlink(f.npm)
  const created = await f.apply('npm', { kind: 'set', port: 8080 })
  assert.equal(created.verified, true)
  await f.apply('npm', { kind: 'restore', backupId: created.backupId })
  await assert.rejects(fs.lstat(f.npm), { code: 'ENOENT' })
  assert.equal((await f.backups.load(created.backupId)).before.exists, false)
})
test('备份失败、备份损坏和并发编辑都不覆盖配置', { skip: !mac }, async t => {
  const f = await fixture(t), original = await fs.readFile(f.npm, 'utf8')
  const plan = await f.prepare('npm', { kind: 'set', port: 7890 })
  await fs.rename(f.backupDirectory, f.backupDirectory + '-saved'); await fs.writeFile(f.backupDirectory, 'block')
  await assert.rejects(f.call({ action: 'apply', planId: plan.planId }), /备份/)
  assert.equal(await fs.readFile(f.npm, 'utf8'), original)
  await fs.unlink(f.backupDirectory); await fs.rename(f.backupDirectory + '-saved', f.backupDirectory)
  const concurrent = await f.prepare('npm', { kind: 'set', port: 7890 }); await fs.appendFile(f.npm, '# user edit\n')
  await assert.rejects(f.call({ action: 'apply', planId: concurrent.planId }), /已变化/)
  assert.equal(await fs.readFile(f.npm, 'utf8'), original + '# user edit\n')
  const written = await f.apply('npm', { kind: 'set', port: 7890 }), beforeCorruption = await fs.readFile(f.npm, 'utf8')
  await fs.writeFile(path.join(f.backupDirectory, written.backupId + '.json'), 'broken FAKE_SECRET')
  const scan = await f.scan(); assert.ok(scan.backupError); assert.equal(scan.ssh.status, 'ready')
  await assert.rejects(f.prepare('npm', { kind: 'restore', backupId: written.backupId }, scan), /校验失败/)
  assert.equal(await fs.readFile(f.npm, 'utf8'), beforeCorruption)
})
test('恢复拒绝抹掉后续编辑；链接、硬链接和只读文件不能被写入', { skip: !mac }, async t => {
  const f = await fixture(t), written = await f.apply('npm', { kind: 'set', port: 7890 })
  await fs.appendFile(f.npm, '# later edit\n')
  await assert.rejects(f.prepare('npm', { kind: 'restore', backupId: written.backupId }), /保留后续修改/)
  await fs.chmod(f.npm, 0o400)
  await assert.rejects(f.apply('npm', { kind: 'set', port: 7891 }), /只读/)
  await fs.chmod(f.npm, 0o600)
  const link = path.join(f.root, 'link'), hard = path.join(f.root, 'hard')
  await fs.symlink(f.npm, link); await assert.rejects(readProxyFile(link, signal()))
  await fs.link(f.npm, hard); await assert.rejects(readProxyFile(f.npm, signal()), /普通文件/)
})
test('状态和计划绑定窗口；SSH 配置变动后需重新扫描，连接只返回打开请求', { skip: !mac }, async t => {
  const f = await fixture(t), scan = await f.scan(), other = { ...caller, webContentsId: 614 }
  await assert.rejects(f.call({ action: 'connect', sessionId: scan.sessionId, alias: 'fixture' }, other), /不属于/)
  const connected = await f.call({ action: 'connect', sessionId: scan.sessionId, alias: 'fixture' }) as { opened: boolean; connected?: boolean }
  assert.equal(connected.opened, true); assert.equal(connected.connected, undefined)
  assert.ok(f.scripts[0]!.includes("exec '/usr/bin/ssh' 'fixture'"))
  const plan = await f.prepare('git', { kind: 'set', port: 7890 }, scan)
  await assert.rejects(f.call({ action: 'apply', planId: plan.planId }, other), /不属于/)
  await fs.appendFile(path.join(f.root, '.ssh/config'), '# changed\n')
  await assert.rejects(f.call({ action: 'connect', sessionId: scan.sessionId, alias: 'fixture' }), /已变化/)
  f.service.closeOwner(caller.webContentsId)
  await assert.rejects(f.call({ action: 'apply', planId: plan.planId }), /过期/)
})
test('配置路径遵循显式环境与 XDG 选择，无法安全确定时失败', { skip: !mac }, async t => {
  const f = await fixture(t), custom = path.join(f.root, 'custom.npmrc')
  const explicit = new ProxyConfigurationProvider(() => new NativePathAccessAdapter(helper), f.root, { NPM_CONFIG_USERCONFIG: custom })
  assert.equal(await explicit.location('npm'), custom)
  await fs.unlink(f.git); await fs.mkdir(path.join(f.root, '.config/git'), { recursive: true }); await fs.writeFile(path.join(f.root, '.config/git/config'), '[user]\n name=test\n')
  assert.equal(await f.provider.location('git'), path.join(f.root, '.config/git/config'))
  const invalid = new ProxyConfigurationProvider(() => new NativePathAccessAdapter(helper), f.root, { GIT_CONFIG_GLOBAL: 'relative' })
  await assert.rejects(invalid.location('git'), /绝对路径/)
})
test('终端脚本转义执行为字面量并自行清理，隧道绑定回环地址', { skip: !mac }, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'must-not-run'), text = `中文 ' $(touch ${marker}) ; end`
  assert.equal(shellArgument("a'b"), "'a'\\''b'")
  assert.deepEqual(sshArguments('fixture', { localPort: 8080, remoteHost: 'db.internal', remotePort: 5432 }), ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:8080:db.internal:5432', 'fixture'])
  assert.ok(proxyTerminalArguments(7890).includes('https_proxy=http://127.0.0.1:7890'))
  let directory = ''
  const launcher = new SshTerminalLauncher(async file => {
    directory = path.dirname(file); assert.equal((await fs.stat(file)).mode & 0o777, 0o700)
    assert.equal(execFileSync('/bin/sh', [file], { encoding: 'utf8' }), text)
  }, f.root)
  try { await launcher.launch('proxy', ['/usr/bin/printf', '%s', text], signal()) }
  finally { await launcher.stop() }
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
})
test('进程取消、输出超限与后代占用管道均有界结束', { skip: !mac }, async t => {
  const f = await fixture(t), controller = new AbortController()
  const task = runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], controller.signal, { timeoutMs: 10000 })
  controller.abort(); await assert.rejects(task, /取消/)
  await assert.rejects(runBoundedProcess(process.execPath, ['-e', 'console.log("x".repeat(2000))'], signal(), { maxBytes: 100 }), /超过限制/)
  const pidfile = path.join(f.root, 'descendant.pid')
  const script = 'const {spawn}=require("node:child_process"); const fs=require("node:fs"); const c=spawn(process.execPath,["-e","setTimeout(()=>{},10000)"],{stdio:["ignore",1,2]}); fs.writeFileSync(process.argv[1],String(c.pid)); c.unref();'
  try {
    const start = Date.now(); await assert.rejects(runBoundedProcess(process.execPath, ['-e', script, pidfile], signal()), /管道/); assert.ok(Date.now() - start < 3000)
  } finally {
    const pid = Number(await fs.readFile(pidfile, 'utf8'))
    try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
})
test('安全组件退出失败仍保留写入结果未知与原文件恢复位置', { skip: !mac }, async t => {
  const f = await fixture(t), before = await f.provider.read('npm', signal()), after = await f.provider.change('npm', before, 'http://127.0.0.1:7890', signal())
  class StopFailureAdapter extends NativePathAccessAdapter { override async stop() { await super.stop(); throw new Error('fixture stop failed') } }
  const provider = new ProxyConfigurationProvider(() => new StopFailureAdapter(helper), f.root, { HOME: f.root })
  await assert.rejects(provider.write('npm', before, after, signal()), error => error instanceof Error && error.message.includes('fixture stop failed') && error.message.includes('/original'))
  const saved = (await fs.readdir(f.root)).find(name => name.startsWith('.ztools-env-recovery-'))
  assert.ok(saved); assert.equal(await fs.readFile(path.join(f.root, saved, 'original'), 'utf8'), before.raw)
  assert.equal(await fs.readFile(f.npm, 'utf8'), after.raw)
})
test('写入成功后读回失败或外部改动仍返回原对象恢复位置，不覆盖外部修改', { skip: !mac }, async t => {
  for (const mode of ['unreadable', 'changed'] as const) {
    const f = await fixture(t), original = await fs.readFile(f.npm, 'utf8')
    const plan = await f.prepare('npm', { kind: 'set', port: 7890 }), write = f.provider.write.bind(f.provider), read = f.provider.read.bind(f.provider)
    let retained: string | undefined, written = false
    t.mock.method(f.provider, 'write', async (...args: Parameters<typeof write>) => {
      retained = await write(...args); written = true
      if (mode === 'changed') await fs.appendFile(f.npm, '# external change\n')
      return retained
    })
    t.mock.method(f.provider, 'read', async (...args: Parameters<typeof read>) => {
      if (written && mode === 'unreadable') throw new Error('fixture readback failed')
      return read(...args)
    })
    await assert.rejects(f.call({ action: 'apply', planId: plan.planId }), error => error instanceof Error && !!retained && error.message.includes(retained) && error.message.includes('原配置备份'))
    assert.ok(retained); assert.equal(await fs.readFile(retained, 'utf8'), original)
    assert.equal((await f.backups.list()).length, 1)
    if (mode === 'changed') assert.ok((await fs.readFile(f.npm, 'utf8')).endsWith('# external change\n'))
  }
})
test('终端清理失败不遗漏其余目录，失败项可重试；停止会等待正在打开的请求', { skip: !mac }, async t => {
  const f = await fixture(t), launcher = new SshTerminalLauncher(async () => {}, f.root)
  await launcher.launch('ssh', sshArguments('fixture'), signal()); await launcher.launch('ssh', sshArguments('fixture'), signal())
  const dirs = (await fs.readdir(f.root)).filter(name => name.startsWith('ztools-ssh-')), failed = path.join(f.root, dirs[0]!), originalRm = fs.rm
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => { if (args[0] === failed) throw new Error('fixture cleanup failed'); return originalRm(...args) })
  try {
    await assert.rejects(launcher.stop(), /清理失败/)
    assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('ztools-ssh-')).length, 1)
  } finally { mocked.mock.restore(); await launcher.stop() }
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const pending = new SshTerminalLauncher(async () => { entered(); await gate }, f.root)
  const opening = pending.launch('ssh', sshArguments('fixture'), signal())
  await started; let stopped = false
  const closing = pending.stop().then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false)
  release(); await assert.rejects(opening, /退出/); await closing
  assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('ztools-ssh-')).length, 0)
})
test('运行中操作仅由其所属窗口取消，取消后可以重新读取', { skip: !mac }, async t => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const f = await fixture(t, async (_file, abort) => {
    entered()
    await new Promise<void>((_resolve, reject) => {
      if (abort.aborted) reject(new Error('cancelled'))
      else abort.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  })
  const scan = await f.scan(), connecting = f.call({ action: 'connect', sessionId: scan.sessionId, alias: 'fixture' })
  const rejected = assert.rejects(connecting, /cancelled/)
  await started
  const otherCancel = await f.call({ action: 'cancel' }, { ...caller, webContentsId: 999 }) as { cancelRequested: boolean }
  assert.equal(otherCancel.cancelRequested, false)
  await assert.rejects(f.call({ action: 'scan' }), /正在进行/)
  await f.call({ action: 'cancel' }); await rejected
  assert.equal((await f.scan()).ssh.status, 'ready')
  assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('ztools-ssh-')).length, 0)
})

test('Windows 终端：SSH 使用系统 OpenSSH 并原样传递隧道参数；缺少客户端、启动失败、取消与停止均不报成功', async () => {
  const started: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const start: ConsoleStart = async (file, args, env) => { started.push({ file, args, env }) }
  const environment = { SystemRoot: 'D:\\Win', PATH: 'C:\\bin', http_proxy: 'http://old:1', Https_Proxy: 'http://old:2', NO_PROXY: 'corp.local' }
  const files = new Set(['D:\\Win\\System32\\OpenSSH\\ssh.exe'])
  const launcher = new WindowsTerminalLauncher(start, environment, async file => files.has(file))
  const opened = await launcher.launch('ssh', sshArguments('fixture', { localPort: 15432, remoteHost: 'db.internal', remotePort: 5432 }), signal())
  assert.equal(opened.opened, true); assert.match(opened.notice, /控制台/)
  assert.equal(started[0]!.file, 'D:\\Win\\System32\\OpenSSH\\ssh.exe')
  assert.deepEqual(started[0]!.args, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:15432:db.internal:5432', 'fixture'])
  await launcher.launch('proxy', windowsProxyTerminalArguments(7890), signal())
  assert.equal(started[1]!.file, 'D:\\Win\\System32\\cmd.exe'); assert.deepEqual(started[1]!.args, ['/d', '/k', 'set', 'HTTP'])
  const env = started[1]!.env
  assert.deepEqual(Object.keys(env).filter(key => /_proxy$/i.test(key)).sort(), ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'])
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890'); assert.equal(env.NO_PROXY, 'corp.local'); assert.equal(env.PATH, 'C:\\bin')
  files.clear()
  await assert.rejects(launcher.launch('ssh', ['fixture'], signal()), /OpenSSH 客户端/)
  const failing = new WindowsTerminalLauncher(async () => { throw new Error('系统未能打开新的控制台窗口') }, environment, async () => true)
  await assert.rejects(failing.launch('ssh', ['fixture'], signal()), /未能打开/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(launcher.launch('proxy', windowsProxyTerminalArguments(1), aborted.signal))
  await launcher.stop(); const before = started.length
  await assert.rejects(launcher.launch('proxy', windowsProxyTerminalArguments(1), signal()), /已停止/)
  assert.equal(started.length, before)
  for (const bad of [['HTTP_PROXY=http://evil:1'], ['PATH=C:\\evil'], ['HTTP_PROXY=http://127.0.0.1:1 & calc']]) assert.throws(() => windowsProxyEnvironment({}, bad))
  assert.throws(() => windowsProxyTerminalArguments(0))
})

test('Windows Git 查找：按 PATH 顺序取绝对目录，忽略相对路径与当前目录，再查默认安装目录，找不到明确失败', async () => {
  const found = (files: string[]) => async (file: string) => files.includes(file)
  assert.equal(await findWindowsGit({ PATH: 'bin;"C:\\Program Files\\Git\\cmd";C:\\other' }, found(['bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\other\\git.exe'])), 'C:\\Program Files\\Git\\cmd\\git.exe')
  assert.equal(await findWindowsGit({ Path: 'C:\\none', ProgramFiles: 'C:\\PF' }, found(['C:\\PF\\Git\\cmd\\git.exe'])), 'C:\\PF\\Git\\cmd\\git.exe')
  assert.equal(await findWindowsGit({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, found(['C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'])), 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe')
  await assert.rejects(findWindowsGit({ PATH: '.;relative' }, found(['.\\git.exe', 'relative\\git.exe'])), /未找到 Git/)
})

async function windowsService(t: TestContext, locateGit: () => Promise<string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-proxy-win-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, '.ssh')); await fs.mkdir(path.join(root, 'system'))
  await fs.writeFile(path.join(root, '.ssh/config'), 'Host fixture\r\n HostName 10.0.0.8\r\n')
  await fs.writeFile(path.join(root, '.gitconfig'), '[http]\n proxy = http://old:8888\n')
  await fs.writeFile(path.join(root, '.npmrc'), 'registry=https://registry.example.invalid/\r\nproxy=http://old:8888\r\n')
  const launched: Array<{ kind: string; args: string[] }> = []
  const terminal = { async launch(kind: 'ssh' | 'proxy', args: string[]) { launched.push({ kind, args }); return { success: true, opened: true, notice: '已请求打开新的控制台窗口' } }, async stop() {} }
  const environment = { HOME: root, SystemRoot: 'C:\\Windows' }
  const provider = new ProxyConfigurationProvider(() => { throw new Error('测试不应写入') }, root, environment, 'win32', locateGit)
  const service = new SshProxyService(provider, new EnvironmentBackupStore(path.join(root, 'backups')), terminal, { home: root, systemDirectory: path.join(root, 'system'), environment }, 'win32')
  t.after(() => service.stop())
  return { root, launched, service, call: (request: unknown) => service.handle(request, caller, signal()) }
}

test('Windows 平台的主机与代理服务：读取真实 Git/NPM 初始状态，终端请求走 Windows 启动器参数', { skip: !mac }, async t => {
  const f = await windowsService(t, async () => '/usr/bin/git')
  const snapshot = await f.call({ action: 'scan' }) as Snapshot
  assert.deepEqual(snapshot.ssh.hosts.map(host => host.alias), ['fixture'])
  for (const tool of ['git', 'npm'] as const) {
    const row = snapshot.proxies.find(item => item.tool === tool)!
    assert.equal(row.status, 'ready'); assert.deepEqual(row.values!.map(value => value.value), ['http://old:8888'])
  }
  const plan = await f.call({ action: 'prepare', sessionId: snapshot.sessionId, tool: 'git', change: { kind: 'set', port: 7890 } }) as { planId: string; after: Array<{ value: string }> }
  assert.deepEqual(plan.after.map(value => value.value), ['http://127.0.0.1:7890'])
  await f.call({ action: 'terminal-proxy', port: 10809 })
  assert.deepEqual(f.launched[0], { kind: 'proxy', args: ['HTTP_PROXY=http://127.0.0.1:10809', 'HTTPS_PROXY=http://127.0.0.1:10809', 'ALL_PROXY=http://127.0.0.1:10809'] })
  await f.call({ action: 'connect', sessionId: snapshot.sessionId, alias: 'fixture' })
  assert.deepEqual(f.launched[1], { kind: 'ssh', args: ['fixture'] })
})

test('Windows 未安装 Git：Git 行如实报错且不能预览修改，NPM 照常读取；其他平台仍拒绝', async t => {
  const f = await windowsService(t, async () => { throw new Error('未找到 Git（git.exe），请安装 Git for Windows 后刷新；NPM 代理不受影响') })
  const snapshot = await f.call({ action: 'scan' }) as Snapshot
  const git = snapshot.proxies.find(item => item.tool === 'git')!, npm = snapshot.proxies.find(item => item.tool === 'npm')!
  assert.equal(git.status, 'error'); assert.match(JSON.stringify(git), /git\.exe/)
  assert.equal(npm.status, 'ready'); assert.deepEqual(npm.values!.map(value => value.value), ['http://old:8888'])
  await assert.rejects(f.call({ action: 'prepare', sessionId: snapshot.sessionId, tool: 'git', change: { kind: 'clear' } }), /读取失败/)
  const linux = new SshProxyService(new ProxyConfigurationProvider(() => { throw new Error('x') }, f.root, {}, 'linux'), new EnvironmentBackupStore(path.join(f.root, 'b2')), { async launch() { return { success: true, opened: true, notice: '' } }, async stop() {} }, { home: f.root }, 'linux')
  await assert.rejects(linux.handle({ action: 'scan' }, caller, signal()), /不可用/)
})
