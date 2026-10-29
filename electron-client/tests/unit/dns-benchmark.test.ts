import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { validateDnsRequest, type DnsNetworkService } from '../../src/contracts/dns-benchmark.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { toPublicError } from '../../src/contracts/errors.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { DnsBackupStore } from '../../src/main/services/dns-backup-store.js'
import { DnsBenchmarkService } from '../../src/main/services/dns-benchmark-service.js'
import { MacDnsNetworkProvider, parseMacDnsServers, parseMacNetworkServices, runDnsCommand, type DnsNetworkProvider } from '../../src/main/services/dns-network-provider.js'
import { probeDnsServer, benchmarkDnsServers } from '../../src/main/services/dns-resolver-probe.js'
import { DnsWriteOutcomeUnknownError, runDnsWriteCommand } from '../../src/main/services/dns-write-command.js'
const caller: CallerIdentity = { type: 'plugin', pluginId: 'dns-benchmark', pluginInstanceId: 'one', webContentsId: 7134 }
const signal = () => new AbortController().signal
const before = ['192.0.2.1'], target = ['192.0.2.2']
const apply = { action: 'apply', operationId: 'apply_1', service: 'Wi-Fi', expectedServers: before, servers: target }
const mapping = 'An asterisk (*) denotes that a network service is disabled.\n(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n(*) Disabled\n(Hardware Port: USB, Device: en1)\n(3) VPN\n(Hardware Port: VPN, Device: )\n'
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-dns-'))
  let current = [...before]
  const writes: string[][] = []
  const network: DnsNetworkProvider = {
    async list() { return [{ name: 'Wi-Fi', device: 'en0', addresses: ['192.0.2.100'], servers: [...current], backup: null }] },
    async read() { return [...current] },
    async write(_name, _device, expected, servers) {
      assert.deepEqual(expected, current, '原生写入契约要求在同一配置锁中比较当前值')
      writes.push([...servers]); current = [...servers]
    },
    async flush() {}
  }
  const backups = new DnsBackupStore(root), service = new DnsBenchmarkService(backups, network, 'darwin')
  return { root, network, backups, service, writes, set(servers: string[]) { current = [...servers] }, get() { return current },
    call(request: unknown, identity = caller, abort = signal()) { return service.handle(request, identity, abort) },
    async close() { await service.stop(); await fs.rm(root, { recursive: true, force: true }) } }
}
test('DNS IPC 校验拒绝空值、额外参数、选项注入和无效地址', () => {
  validateMethodParams('dns_benchmark', apply); assert.equal(canCall('dns_benchmark', caller), true)
  for (const value of [null, {}, [], { ...apply, service: '-setdnsservers' }, { ...apply, service: 'Wi-Fi\n' }, { ...apply, expectedServers: ['invalid'] }, { ...apply, servers: [] }, { ...apply, servers: [target[0], target[0]] }, { ...apply, script: 'test' }, { ...apply, action: ['apply'] }]) assert.throws(() => validateDnsRequest(value))
})
test('网络服务按系统服务名映射到设备，禁用与无设备项不伪造', () => {
  assert.deepEqual(parseMacNetworkServices(mapping), [{ name: 'Wi-Fi', device: 'en0' }])
  for (const output of ['garbled', '(1) Wi-Fi', mapping + '(4) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)']) assert.throws(() => parseMacNetworkServices(output))
  assert.deepEqual(parseMacDnsServers("There aren't any DNS Servers set on Wi-Fi.\n", 'Wi-Fi'), [])
  assert.deepEqual(parseMacDnsServers('192.0.2.1\n2001:db8::1', 'Wi-Fi'), ['192.0.2.1', '2001:db8::1'])
  for (const output of ['', 'Error: failed', "There aren't any DNS Servers set on other."]) assert.throws(() => parseMacDnsServers(output, 'Wi-Fi'))
})
test('真实命令子进程：非零退出、错误输出、stderr、取消均不会变成空列表', async () => {
  assert.equal(await runDnsCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], signal()), 'ok')
  for (const code of ['process.exit(1)', 'process.stdout.write("Error: denied")', 'process.stderr.write("denied")']) await assert.rejects(runDnsCommand(process.execPath, ['-e', code], signal()))
  await assert.rejects(runDnsCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], AbortSignal.timeout(100)))
})
test('provider 只列活动接口、读取真实配置，写入参数保持独立 argv', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dns-helper-')), helper = path.join(root, 'helper')
  await fs.writeFile(helper, '')
  try {
    const calls: unknown[] = []
    const provider = new MacDnsNetworkProvider(async (_file, args) => args[0] === '-listnetworkserviceorder' ? mapping : before.join('\n'),
      () => ({ en0: [{ address: '192.0.2.100', family: 'IPv4', netmask: '255.255.255.0', mac: '00:00:00:00:00:00', internal: false, cidr: '192.0.2.100/24' }] }), helper,
      async (file, args) => { calls.push({ file, args }); return '{"version":1,"success":true,"code":"APPLIED"}' })
    assert.deepEqual((await provider.list(signal())).map(v => [v.name, v.device, v.servers]), [['Wi-Fi', 'en0', before]])
    await provider.write('Wi-Fi', 'en0', before, target, signal())
    assert.deepEqual(calls, [{ file: helper, args: ['--apply', 'Wi-Fi', 'en0', JSON.stringify(before), JSON.stringify(target), '--authorize'] }])
    const invalid = new MacDnsNetworkProvider(undefined, undefined, helper, async () => '{"version":1,"success":false,"code":"ADMIN_PERMISSION_REQUIRED"}')
    await assert.rejects(invalid.write('Wi-Fi', 'en0', before, target, signal()), /未获得系统授权/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('备份落盘、自动配置空数组、跨服务恢复与损坏记录', async () => {
  const f = await fixture()
  try {
    const first = await f.backups.save('Wi-Fi', 'en0', before), second = await f.backups.save('Wi-Fi', 'en0', [])
    assert.deepEqual((await f.backups.load('Wi-Fi', first.id)).servers, before)
    assert.deepEqual((await f.backups.latest('Wi-Fi'))?.servers, [])
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.root, second.id + '.json'))).mode & 0o777, 0o600)
    await assert.rejects(f.backups.load('Other', first.id), /不属于/)
    await fs.writeFile(path.join(f.root, second.id + '.json'), '{}')
    await assert.rejects(f.backups.latest('Wi-Fi'), /损坏/)
    if (process.platform !== 'win32') {
      const pointer = path.join(f.root, createHash('sha256').update('Wi-Fi').digest('hex') + '.latest')
      await fs.rm(pointer); await fs.symlink(path.join(f.root, first.id + '.json'), pointer)
      await assert.rejects(f.backups.latest('Wi-Fi'))
    }
  } finally { await f.close() }
})
test('切换、恢复最近备份和恢复自动 DNS 都校验实际系统读回', async () => {
  const f = await fixture()
  try {
    const result = await f.call(apply) as { service: DnsNetworkService }
    assert.deepEqual(f.get(), target); assert.deepEqual(result.service.servers, target)
    assert.deepEqual((await f.backups.latest('Wi-Fi'))?.servers, before)
    await f.call({ action: 'restore', operationId: 'restore', service: 'Wi-Fi', expectedServers: target, backupId: result.service.backup!.id })
    assert.deepEqual(f.get(), before)
    await f.call({ action: 'reset', operationId: 'reset', service: 'Wi-Fi', expectedServers: before })
    assert.deepEqual(f.get(), []); assert.equal(f.writes.length, 3)
  } finally { await f.close() }
})
test('扫描失败、配置冲突和备份失败均阻止写入', async () => {
  for (const mode of ['scan', 'changed', 'backup']) {
    const f = await fixture()
    try {
      if (mode === 'scan') f.network.list = async () => { throw new Error('scan failed') }
      if (mode === 'changed') f.set(target)
      if (mode === 'backup') { await fs.rm(f.root, { recursive: true }); await fs.writeFile(f.root, 'blocked') }
      await assert.rejects(f.call(apply)); assert.equal(f.writes.length, 0)
    } finally { await f.service.stop(); await fs.rm(f.root, { recursive: true, force: true }) }
  }
})
test('写入失败后区分未改变、需要恢复、外部漂移和无法确认状态', async () => {
  for (const mode of ['unchanged', 'restore', 'drift', 'unreadable', 'restore-failed']) {
    const f = await fixture(); let attempts = 0
    try {
      const write = f.network.write, read = f.network.read
      f.network.write = async (...args) => {
        attempts++
        if (attempts === 2) { if (mode === 'restore-failed') throw new Error('restore denied'); return write(...args) }
        if (mode !== 'unchanged') f.set(mode === 'drift' ? ['192.0.2.3'] : target)
        if (mode === 'unreadable') f.network.read = async () => { throw new Error('read denied') }
        throw new Error('apply failed')
      }
      await assert.rejects(f.call(apply), mode === 'restore' ? /已恢复并核对/ : mode === 'unchanged' ? /未改变/ : mode === 'drift' ? /其他配置/ : mode === 'unreadable' ? /无法读取当前状态/ : /自动恢复未确认/)
      assert.equal(attempts, ['restore', 'restore-failed'].includes(mode) ? 2 : 1)
      if (mode === 'restore') assert.deepEqual(f.get(), before)
      assert.deepEqual((await f.backups.latest('Wi-Fi'))?.servers, before)
      f.network.read = read
    } finally { await f.close() }
  }
})
test('授权等待可取消，取消归属隔离，停止不允许迟到写入', async () => {
  const f = await fixture(); let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  f.network.write = async (_service, _device, _before, _target, abort) => {
    entered(); await delay(10000, undefined, { signal: abort }); f.set(target)
  }
  try {
    const operation = assert.rejects(f.call(apply), /未改变/); await waiting
    await assert.rejects(f.call({ action: 'cancel', operationId: apply.operationId }, { ...caller, webContentsId: 99 }), /其他插件/)
    await f.service.stop(); await operation; assert.deepEqual(f.get(), before)
    await assert.rejects(f.call(apply), /已停止/)
  } finally { await f.close() }
})
test('停止发生在预读取期间时不会进入写入', async () => {
  const f = await fixture(); let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const list = f.network.list
  f.network.list = async abort => { await waiting; return list(abort) }
  const result = assert.rejects(f.call(apply)); const stopped = f.service.stop(); release()
  await result; await stopped; assert.equal(f.writes.length, 0); await f.close()
})
test('真实写入子进程：授权中取消即退出，已进入事务则等最终结果', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dns-write-')), helper = path.join(root, 'helper'), ready = path.join(root, 'ready')
  try {
    for (const commit of [false, true]) {
      await fs.writeFile(helper, `#!${process.execPath}\nconst fs=require('node:fs'); ${commit ? "process.on('SIGTERM',()=>{})" : "process.on('SIGTERM',()=>process.exit(3))"}; fs.writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>{process.stdout.write('{"version":1,"success":true,"code":"APPLIED"}');process.exit(0)},350)`, { mode: 0o755 })
      await fs.rm(ready, { force: true }); const controller = new AbortController()
      const operation = runDnsWriteCommand(helper, [], controller.signal)
      const expected = commit ? operation : assert.rejects(operation, /取消/)
      // 新建的可执行脚本首次启动会被 macOS 安全检查拖慢（实测约 0.8 秒），给足 5 秒等待子进程就绪
      for (let i = 0; i < 1000; i++) { try { await fs.stat(ready); break } catch { await delay(5) } }
      await fs.stat(ready); const start = performance.now(); controller.abort()
      const result = await expected
      if (commit) { assert.match(String(result), /APPLIED/); assert.ok(performance.now() - start >= 200) }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
async function dnsFixture(mode: 'answer' | 'nxdomain' | 'timeout', latency = 0) {
  const server = dgram.createSocket('udp4'); let queries = 0, active = 0, maximum = 0
  server.on('message', (query, peer) => {
    queries++; active++; maximum = Math.max(maximum, active)
    assert.equal(query.readUInt16BE(4), 1); assert.equal(query.readUInt16BE(query.length - 4), 1)
    if (mode === 'timeout') { active--; return }
    const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(mode === 'answer' ? 0x8180 : 0x8183, 2); header.writeUInt16BE(mode === 'answer' ? 1 : 0, 6)
    const answer = mode === 'answer' ? Buffer.from([0xc0,12,0,1,0,1,0,0,0,60,0,4,192,0,2,9]) : Buffer.alloc(0)
    const response = Buffer.concat([header, query.subarray(12), answer])
    setTimeout(() => { active--; server.send(response, peer.port, peer.address) }, latency)
  })
  server.bind(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); const endpoint = `127.0.0.1:${address.port}`
  return { endpoint, queries: () => queries, maximum: () => maximum, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
test('真实 UDP DNS：解析答案和延迟来自响应，NXDOMAIN 与超时没有伪造数值', async () => {
  for (const mode of ['answer', 'nxdomain', 'timeout'] as const) {
    const f = await dnsFixture(mode, 40)
    try {
      const result = await probeDnsServer(f.endpoint, signal())
      assert.ok(f.queries() >= 1)
      if (mode === 'answer') { assert.deepEqual(result.answers, ['192.0.2.9']); assert.ok(result.milliseconds! >= 30); assert.equal(result.error, null) }
      else { assert.equal(result.milliseconds, null); assert.deepEqual(result.answers, []); assert.ok(result.error) }
    } finally { await f.close() }
  }
})
test('真实 DNS 测速最多四个并发，取消会停止解析任务', async () => {
  const f = await dnsFixture('answer', 40)
  try { const results = await benchmarkDnsServers(Array(9).fill(f.endpoint), signal()); assert.equal(results.length, 9); assert.equal(f.maximum(), 4) }
  finally { await f.close() }
  const hanging = await dnsFixture('timeout')
  try { await assert.rejects(benchmarkDnsServers([hanging.endpoint], AbortSignal.timeout(100))); assert.equal(hanging.queries(), 1) }
  finally { await hanging.close() }
})

test('异常终止或强制超时返回状态未确认，绝不据此覆盖系统配置', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dns-unknown-')), helper = path.join(root, 'helper')
  try {
    for (const source of ["process.kill(process.pid,'SIGKILL')", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]) {
      await fs.writeFile(helper, `#!${process.execPath}\n${source}`, { mode: 0o755 })
      await assert.rejects(runDnsWriteCommand(helper, [], signal(), 100, 100), DnsWriteOutcomeUnknownError)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
  const f = await fixture(); let reads = 0
  f.network.read = async () => { reads++; return [...before] }
  f.network.write = async () => { throw new DnsWriteOutcomeUnknownError() }
  try { await assert.rejects(f.call(apply), /状态未确认.*备份/); assert.equal(reads, 1); assert.deepEqual((await f.backups.latest('Wi-Fi'))?.servers, before) }
  finally { await f.close() }
})

test('真实 IPC 错误转换保留取消和恢复提示，不丢成宿主内部错误', async () => {
  const f = await fixture()
  try {
    f.network.list = async () => { throw new Error('网络服务读取失败，请重新连接') }
    const error = await f.call(apply).catch(error => error)
    assert.equal(toPublicError(error).message, '网络服务读取失败，请重新连接')
  } finally { await f.close() }
})
