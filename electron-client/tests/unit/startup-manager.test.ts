import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { build as buildPlist } from 'plist'
import { MacStartupReader, parseStartupOverrides, parseStartupPlist, readStartupBytes, readStartupLoaded, startupHash } from '../../src/main/services/startup-reader.js'
import { runStartupCommand, type StartupCommand } from '../../src/main/services/startup-command.js'
import { validateStartupRequest } from '../../src/contracts/startup-manager.js'
import { StartupBackupStore } from '../../src/main/services/startup-backups.js'
import { StartupTransactions } from '../../src/main/services/startup-transactions.js'
import { MacStartupWriter, type StartupWriter } from '../../src/main/services/startup-writer.js'
import { runStartupProcess } from '../../src/main/services/startup-command.js'
import { StartupManagerService } from '../../src/main/services/startup-manager-service.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
const macTest = process.platform === 'darwin' ? test : test.skip
const signal = () => AbortSignal.timeout(15000)
const absent = { code: 113, stdout: '', stderr: 'Could not find service "test" in domain for user gui: 501' }
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-')))
  const directory = path.join(home, 'Library/LaunchAgents')
  await fs.mkdir(directory, { recursive: true })
  const env = { home, uid: process.getuid!(), systemAgents: path.join(home, 'system-agents'), daemons: path.join(home, 'daemons') }
  const put = async (name: string, value: Parameters<typeof buildPlist>[0]) => {
    const file = path.join(directory, name)
    await fs.writeFile(file, buildPlist(value), { mode: 0o600 }); return file
  }
  const run: StartupCommand = async (args, abort, input) => input ? runStartupCommand(args, abort, input) :
    args[0] === 'print-disabled' ? { code: 0, stdout: 'disabled services = {\n "cn.test.disabled" => disabled\n "cn.test.enabled" => false\n}', stderr: '' } : absent
  return { home, env, put, reader: new MacStartupReader(env, run), close: () => fs.rm(home, { recursive: true, force: true }) }
}

test('启动管理请求拒绝伪路径、数组、类型强制转换与额外字段', () => {
  assert.equal(canCall('startup_manager', { type: 'plugin', pluginId: 'startup-manager', webContentsId: 1 }), true)
  validateMethodParams('startup_manager', { action: 'scan', operationId: 'one' })
  validateStartupRequest({ action: 'set-enabled', id: 'a'.repeat(64), operationId: 'one', enabled: true })
  for (const value of [null, [], { action: 'scan', operationId: 'x', path: '/tmp' }, { action: 'set-enabled', id: 'a'.repeat(64), operationId: 'x', enabled: 'false' }, { action: ['scan'], operationId: 'x' }]) assert.throws(() => validateStartupRequest(value))
})
macTest('真实服务链路绑定扫描窗口，写入后清除旧记录，关闭和停止后禁止复用', async () => {
  const f = await transactionalFixture(), caller: CallerIdentity = { type: 'plugin', pluginId: 'startup-manager', webContentsId: 1 }
  const service = new StartupManagerService(f.store, async () => {}, f.writer, f.reader, 'darwin')
  try {
    const result = await service.handle({ action: 'scan', operationId: 'scan' }, caller, signal()) as { items: { id: string }[] }
    const id = result.items[0]!.id, toggle = { action: 'set-enabled', id, enabled: false, operationId: 'write' }
    await assert.rejects(service.handle(toggle, { ...caller, webContentsId: 2 }, signal()), /当前窗口/)
    assert.equal(f.state().writes, 0)
    await service.handle(toggle, caller, signal()); assert.equal(f.state().writes, 1)
    await assert.rejects(service.handle(toggle, caller, signal()), /当前窗口/)
    await service.handle({ action: 'scan', operationId: 'scan2' }, caller, signal())
    service.closeOwner(1)
    await assert.rejects(service.handle({ ...toggle, enabled: true }, caller, signal()), /当前窗口/)
    await service.stop(); await assert.rejects(service.handle({ action: 'scan', operationId: 'scan3' }, caller, signal()), /不可用/)
  } finally { await service.stop(); await f.close() }
})
test('Windows 没有 getuid 仍可构造路由依赖，Mac 操作才被平台检查拒绝', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
  let service: StartupManagerService | undefined
  try {
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
    service = new StartupManagerService(new StartupBackupStore('/unused'), async () => {}, { apply: async () => { throw new Error('不应调用') } }, undefined, 'win32')
    await assert.rejects(service.handle({ action: 'scan', operationId: 'windows' }, { type: 'main', webContentsId: 2 }, signal()), /不可用/)
  } finally {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor)
    else Reflect.deleteProperty(process, 'getuid')
    await service?.stop()
  }
})
macTest('真实 IPC 服务到原生安全组件：清理、恢复、状态变化和拒绝覆盖的完整链路', async () => {
  const f = await fixture(), helper = path.join(f.home, 'startup-fixture')
  execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-framework', 'Foundation', '-DZTOOLS_STARTUP_FIXTURE', path.resolve(__dirname, '../../../native/ZToolsMacStartup/main.mm'), '-o', helper], { timeout: 60000 })
  const original = await f.put('fixture.plist', { Label: 'cn.fixture.chain', Program: path.join(f.home, 'missing') })
  const before = await fs.readFile(original), store = new StartupBackupStore(path.join(f.home, 'backups'))
  const run: StartupCommand = async (args, abort, input) => {
    if (input) return runStartupCommand(args, abort, input)
    if (args[0] !== 'print-disabled') return absent
    const values = await fs.readFile(path.join(f.home, 'overrides.json'), 'utf8').then(value => JSON.parse(value) as Record<string, boolean>, error => { if (error.code === 'ENOENT') return {}; throw error })
    const rows = Object.entries(values).filter(([key]) => key.startsWith(args[1]! + '/')).map(([key, value]) => ` "${key.slice(args[1]!.length + 1)}" => ${value}`).join('\n')
    return { code: 0, stdout: `disabled services = {\n${rows}\n}`, stderr: '' }
  }
  const writer = new MacStartupWriter(helper, (file, args, abort) => {
    assert.equal(file, helper); assert.equal(args[0], '--apply')
    return runStartupProcess(file, [...args, f.home], abort)
  })
  const service = new StartupManagerService(store, async () => {}, writer, new MacStartupReader(f.env, run), 'darwin')
  const caller: CallerIdentity = { type: 'plugin', pluginId: 'startup-manager', webContentsId: 99 }
  const call = (action: string, params: Record<string, unknown> = {}) => service.handle({ action, operationId: 'native-chain', ...params }, caller, signal())
  try {
    let scan = await call('scan') as { items: { id: string; enabled: boolean }[] }
    const id = scan.items[0]!.id
    const toggle = await call('set-enabled', { id, enabled: false }) as { backupId: string }
    assert.equal((await store.load(toggle.backupId)).kind, 'toggle')
    scan = await call('scan') as typeof scan; assert.equal(scan.items[0]!.enabled, false)
    await call('restore', { id: toggle.backupId })
    scan = await call('scan') as typeof scan; assert.equal(scan.items[0]!.enabled, true)
    const removal = await call('remove', { id }) as { backupId: string; removed: boolean }
    assert.equal(removal.removed, true); await assert.rejects(fs.stat(original), { code: 'ENOENT' })
    assert.equal((await store.load(removal.backupId)).kind, 'remove')
    assert.equal((await call('scan') as typeof scan).items.length, 0)
    await call('restore', { id: removal.backupId }); assert.deepEqual(await fs.readFile(original), before)
    await call('scan')
    const next = await call('remove', { id }) as { backupId: string }
    await fs.writeFile(original, 'a newer file', { mode: 0o600 })
    await assert.rejects(call('restore', { id: next.backupId }))
    assert.equal(await fs.readFile(original, 'utf8'), 'a newer file')
  } finally { await service.stop(); await f.close() }
})
macTest('launchctl 两种覆盖格式；未知和重复状态必须失败', () => {
  const parsed = parseStartupOverrides('disabled services = {\n "a" => true\n "b" => false\n "c" => enabled\n "d" => disabled\n}')
  assert.deepEqual([...parsed], [['a', true], ['b', false], ['c', false], ['d', true]])
  for (const value of ['', '{}', 'disabled services = {\n "a" => maybe\n}', 'disabled services = {\n "a" => true\n "a" => false\n}']) assert.throws(() => parseStartupOverrides(value))
})
macTest('真实 XML/binary plist：程序和参数分离；禁止用文件名伪造 Label', async () => {
  const value = { Label: 'cn.test.valid', Program: '/bin/echo', ProgramArguments: ['echo', '中文 $&; 空格'], StartCalendarInterval: { Hour: 9 } }
  const xml = Buffer.from(buildPlist(value))
  const binary = execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '--', '-'], { input: xml })
  for (const bytes of [xml, binary]) {
    const parsed = await parseStartupPlist(bytes, signal(), runStartupCommand)
    assert.equal(parsed.program, '/bin/echo'); assert.equal(parsed.scheduled, true); assert.deepEqual(parsed.args, value.ProgramArguments)
  }
  for (const invalid of [{ Program: '/bin/echo' }, { Label: 'bad/label', Program: '/bin/echo' }, { Label: 'valid', Program: '/bin/echo', Disabled: 'false' }, { Label: 'valid', ProgramArguments: [1] }]) {
    await assert.rejects(parseStartupPlist(Buffer.from(buildPlist(invalid)), signal(), runStartupCommand))
  }
})
macTest('真实文件扫描：覆盖优先、缺失程序、计划任务与错误可见；不写原文件', async () => {
  const f = await fixture()
  try {
    const enabled = await f.put('one.plist', { Label: 'cn.test.enabled', Program: '/bin/echo', Disabled: true })
    const missing = await f.put('two.plist', { Label: 'cn.test.disabled', Program: path.join(f.home, 'gone'), StartInterval: 60 })
    await f.put('bad.plist', { Program: '/bin/echo' })
    const before = [startupHash(await fs.readFile(enabled)), startupHash(await fs.readFile(missing))]
    const { result } = await f.reader.scan(signal())
    assert.equal(result.items.length, 2); assert.equal(result.warnings.length, 1); assert.match(result.warnings[0]!, /Label/)
    assert.equal(result.items[0]!.enabled, true); assert.equal(result.items[0]!.loaded, false)
    assert.equal(result.items[1]!.enabled, false); assert.equal(result.items[1]!.programState, 'missing'); assert.equal(result.items[1]!.scheduled, true)
    assert.deepEqual(before, [startupHash(await fs.readFile(enabled)), startupHash(await fs.readFile(missing))])
  } finally { await f.close() }
})
macTest('空的 plist（<dict/>，常见于屏蔽更新代理）不算启动项也不算读取失败；警告不带 Error: 前缀', async () => {
  const f = await fixture()
  try {
    await f.put('com.google.keystone.agent.plist', {})
    await f.put('one.plist', { Label: 'cn.test.enabled', Program: '/bin/echo' })
    await f.put('bad.plist', { Program: '/bin/echo' })
    const { result } = await f.reader.scan(signal())
    assert.equal(result.items.length, 1)
    assert.deepEqual(result.warnings, ['bad.plist：启动配置缺少有效 Label'])
    await assert.rejects(parseStartupPlist(Buffer.from(buildPlist({})), signal(), runStartupCommand), /空的启动配置/)
    const onlyEmpty = await fixture()
    try {
      await onlyEmpty.put('com.google.keystone.xpcservice.plist', {})
      const empty = await onlyEmpty.reader.scan(signal())
      assert.equal(empty.result.items.length, 0); assert.deepEqual(empty.result.warnings, [])
    } finally { await onlyEmpty.close() }
  } finally { await f.close() }
})
macTest('缺系统权限不能显示为没有启动项；只有指定的未加载错误可视为未加载', async () => {
  const run: StartupCommand = async () => ({ code: 1, stdout: '', stderr: 'Operation not permitted' })
  await assert.rejects(new MacStartupReader(undefined, run).scan(signal()), /无法读取系统启动状态/)
  await assert.rejects(readStartupLoaded('system', 'cn.test', signal(), run), /Operation not permitted/)
  await assert.rejects(readStartupLoaded('system', 'cn.test', signal(), async () => ({ code: 0, stdout: 'unknown', stderr: '' })), /无法确认/)
})
macTest('相同 Label、Apple 保护项、旧改名文件、加载路径不一致禁止写入', async () => {
  const f = await fixture()
  try {
    await f.put('one.plist', { Label: 'cn.same', Program: '/bin/echo' })
    await f.put('two.plist', { Label: 'cn.same', Program: '/bin/echo' })
    await f.put('apple.plist', { Label: 'com.apple.test', Program: '/bin/echo' })
    await f.put('old.plist.disabled', { Label: 'cn.old', Program: '/bin/echo' })
    const { result } = await f.reader.scan(signal())
    assert.ok(result.items.every(v => v.blockedReason))
    const old = result.items.find(v => v.label === 'cn.old')!; assert.equal(old.enabled, false)
    const loaded: StartupCommand = async (args, abort, input) => input ? runStartupCommand(args, abort, input) : { code: 0, stdout: 'state = running\npid = 123\npath = /other.plist\n', stderr: '' }
    const snapshot = await new MacStartupReader(f.env, loaded).read(old.file, 'user-agent', new Map(), signal())
    assert.equal(snapshot.item.running, true); assert.equal(snapshot.item.pid, 123); assert.ok(snapshot.item.blockedReason)
  } finally { await f.close() }
})
macTest('异常输入：FIFO、符号链接、硬链接、巨型文件不会阻塞或被当成配置', async () => {
  const f = await fixture()
  try {
    const file = await f.put('good.plist', { Label: 'cn.test', Program: '/bin/echo' })
    const link = path.join(f.home, 'symlink'), fifo = path.join(f.home, 'pipe'), huge = path.join(f.home, 'huge')
    await fs.symlink(file, link); await assert.rejects(readStartupBytes(link))
    execFileSync('/usr/bin/mkfifo', [fifo]); await assert.rejects(readStartupBytes(fifo), /普通单链接文件/)
    await fs.writeFile(huge, Buffer.alloc(1024 * 1024 + 1)); await assert.rejects(readStartupBytes(huge), /超过/)
    await fs.link(file, path.join(f.home, 'hard')); await assert.rejects(readStartupBytes(file), /单链接/)
  } finally { await f.close() }
})
macTest('取消扫描停止，不返回空列表冒充成功', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort()
  try { await assert.rejects(f.reader.scan(controller.signal), /abort/i) } finally { await f.close() }
})

macTest('所有文件损坏时整体失败；真正空目录才能返回空列表', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.reader.scan(signal())).result.items.length, 0)
    await f.put('bad.plist', { Program: '/bin/echo' })
    await assert.rejects(f.reader.scan(signal()), /无法读取启动配置/)
  } finally { await f.close() }
})

async function transactionalFixture() {
  const f = await fixture(), label = 'cn.test.enabled'
  const file = await f.put('enabled.plist', { Label: label, Program: '/bin/echo', ProgramArguments: ['echo', 'test'] })
  let disabled: boolean | null = false, writes = 0, acknowledge = true
  const run: StartupCommand = async (args, abort, input) => {
    abort.throwIfAborted()
    if (input) return runStartupCommand(args, abort, input)
    if (args[0] === 'print-disabled') return { code: 0, stdout: `disabled services = {\n${disabled === null ? '' : ` "${label}" => ${disabled}\n`}}`, stderr: '' }
    if (args[0] === 'print') return absent
    assert.ok(['enable', 'disable'].includes(args[0]!)); assert.equal(args[1], `gui/${f.env.uid}/${label}`)
    writes++; if (acknowledge) disabled = args[0] === 'disable'
    return { code: 0, stdout: '', stderr: '' }
  }
  const reader = new MacStartupReader(f.env, run), store = new StartupBackupStore(path.join(f.home, 'backups'))
  const writer: StartupWriter = { async apply(input, abort) {
    assert.equal(input.action, 'toggle')
    await run([input.enabled ? 'enable' : 'disable', `gui/${f.env.uid}/${label}`], abort)
    return { recoveryPath: '' }
  } }
  return { ...f, reader, file, store, writer, transactions: new StartupTransactions(reader, store, writer),
    snapshot: async () => (await reader.scan(signal())).snapshots[0]!,
    state: () => ({ disabled, writes }), denyWrite: () => { acknowledge = false }, clearOverride: () => { disabled = null } }
}
macTest('真实备份与恢复链路：先写盘校验，状态回读确认，原 plist 内容始终不变', async () => {
  const f = await transactionalFixture(), original = await fs.readFile(f.file)
  try {
    const result = await f.transactions.toggle(await f.snapshot(), false, signal())
    assert.equal(result.enabled, false); assert.equal(f.state().disabled, true)
    const backup = await f.store.load(result.backupId)
    assert.equal(backup.original, original.toString('base64')); assert.equal(backup.beforeEnabled, true)
    assert.equal((await f.store.list()).length, 1)
    const restored = await f.transactions.restore(backup, signal())
    assert.ok('enabled' in restored); assert.equal(restored.enabled, true); assert.equal(f.state().disabled, false); assert.equal(f.state().writes, 2)
    assert.deepEqual(await fs.readFile(f.file), original)
    assert.equal((await f.store.list()).length, 2)
  } finally { await f.close() }
})
macTest('备份不可写/不安全时零系统修改；损坏备份不能用于恢复', async () => {
  const f = await transactionalFixture()
  try {
    await fs.mkdir(f.store.directory, { mode: 0o700 }); await fs.chmod(f.store.directory, 0o777)
    await assert.rejects(f.transactions.toggle(await f.snapshot(), false, signal()), /备份目录权限/)
    assert.equal(f.state().writes, 0)
    await fs.chmod(f.store.directory, 0o700)
    const result = await f.transactions.toggle(await f.snapshot(), false, signal())
    const backupFile = path.join(f.store.directory, result.backupId + '.json')
    const backup = JSON.parse(await fs.readFile(backupFile, 'utf8')); backup.beforeEnabled = false
    await fs.writeFile(backupFile, JSON.stringify(backup))
    await assert.rejects(f.store.load(result.backupId), /损坏/)
    assert.equal(f.state().writes, 1)
  } finally { await f.close() }
})
macTest('备份期间配置变化和恢复前后续修改均阻断，不覆盖新配置', async () => {
  const f = await transactionalFixture()
  try {
    class ChangingStore extends StartupBackupStore {
      override async save(snapshot: Parameters<StartupBackupStore['save']>[0], enabled: boolean) {
        const saved = await super.save(snapshot, enabled)
        await fs.appendFile(f.file, '\n')
        return saved
      }
    }
    const changing = new StartupTransactions(f.reader, new ChangingStore(f.store.directory), f.writer)
    await assert.rejects(changing.toggle(await f.snapshot(), false, signal()), /已变化/)
    assert.equal(f.state().writes, 0)
    // 写入前核对失败，没有发出写入：本次恢复记录无效，已被删除
    assert.equal((await f.store.list()).length, 0)
    const result = await f.transactions.toggle(await f.snapshot(), false, signal())
    const backup = await f.store.load(result.backupId)
    await fs.appendFile(f.file, '\n')
    await assert.rejects(f.transactions.restore(backup, signal()), /保留后续改动/)
    assert.equal(f.state().writes, 1)
  } finally { await f.close() }
})
macTest('命令返回 0 但系统状态不变时必须失败，且复查确认未修改后删除无效恢复记录', async () => {
  const f = await transactionalFixture()
  try {
    f.denyWrite()
    await assert.rejects(f.transactions.toggle(await f.snapshot(), false, signal()), /自启状态未修改.*与请求不一致/)
    assert.equal(f.state().disabled, false); assert.equal((await f.store.list()).length, 0)
  } finally { await f.close() }
})
macTest('用户取消管理员授权（写入未执行）时删除恢复记录，并透出原错误', async () => {
  const f = await transactionalFixture()
  try {
    const cancelled: StartupWriter = { async apply() { throw new Error('系统未确认修改：CANCELLED_OR_EXPIRED') } }
    const transactions = new StartupTransactions(f.reader, f.store, cancelled)
    await assert.rejects(transactions.toggle(await f.snapshot(), false, signal()), /自启状态未修改.*CANCELLED_OR_EXPIRED/)
    assert.equal(f.state().writes, 0); assert.equal((await f.store.list()).length, 0)
  } finally { await f.close() }
})
macTest('写入已改动系统状态后才报错时保留恢复记录', async () => {
  const f = await transactionalFixture()
  try {
    const partial: StartupWriter = { async apply(input, abort) {
      await f.writer.apply(input, abort)
      throw new Error('系统写入结果无法验证')
    } }
    const transactions = new StartupTransactions(f.reader, f.store, partial)
    await assert.rejects(transactions.toggle(await f.snapshot(), false, signal()), /恢复记录 .* 已保留.*无法验证/)
    assert.equal(f.state().disabled, true); assert.equal((await f.store.list()).length, 1)
  } finally { await f.close() }
})
macTest('写入失败后复查读不到系统状态时保留恢复记录，不当作未修改', async () => {
  const f = await transactionalFixture()
  try {
    let failRecheck = false
    const reader = new MacStartupReader(f.env, async (args, abort, input) => {
      if (failRecheck && args[0] === 'print-disabled') throw new Error('launchctl 不可用')
      return f.reader.run(args, abort, input)
    })
    const failing: StartupWriter = { async apply() { failRecheck = true; throw new Error('osascript 退出码 1') } }
    const transactions = new StartupTransactions(reader, f.store, failing)
    await assert.rejects(transactions.toggle((await reader.scan(signal())).snapshots[0]!, false, signal()), /已保留.*osascript/)
    assert.equal((await f.store.list()).length, 1)
  } finally { await f.close() }
})
macTest('未修改但删除恢复记录失败时报告删除失败，同时保留原错误', async () => {
  const f = await transactionalFixture()
  try {
    class UndeletableStore extends StartupBackupStore {
      override async discard(): Promise<void> { throw new Error('EPERM 删除被拒绝') }
    }
    const cancelled: StartupWriter = { async apply() { throw new Error('用户取消了授权') } }
    const transactions = new StartupTransactions(f.reader, new UndeletableStore(f.store.directory), cancelled)
    await assert.rejects(transactions.toggle(await f.snapshot(), false, signal()), /删除失败.*用户取消了授权/)
    assert.equal((await f.store.list()).length, 1)
  } finally { await f.close() }
})
macTest('外部移除 override 即使有效状态相同也不能覆盖；临时记录不当作可恢复备份', async () => {
  const f = await transactionalFixture()
  try {
    await f.transactions.toggle(await f.snapshot(), false, signal())
    const result = await f.transactions.toggle(await f.snapshot(), true, signal())
    const backup = await f.store.load(result.backupId)
    f.clearOverride()
    assert.equal((await f.snapshot()).item.enabled, true)
    await assert.rejects(f.transactions.restore(backup, signal()), /保留后续改动/)
    assert.equal(f.state().writes, 2)
    await fs.writeFile(path.join(f.store.directory, 'incomplete.tmp'), '{')
    assert.equal((await f.store.list()).length, 2)
  } finally { await f.close() }
})
