import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import { once, getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { lanScanRange, normalizeLanMac, validateLanRequest, type LanInterface } from '../../src/contracts/lan-network.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { listLanInterfaces, probeLanPing, probeLanTcp, sendLanWake, wolPacket, MacLanNetworkProvider, type LanNetworkProvider } from '../../src/main/services/lan-network-provider.js'
import { parseLanNeighbors, macNetworkHelperPath } from '../../src/main/services/lan-neighbor-reader.js'
import { LanNetworkService } from '../../src/main/services/lan-network-service.js'
import { NetworkHostPluginHandler } from '../../src/main/services/host-plugins/network-host.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'
const iface: LanInterface = { id: 'en0|192.0.2.100|255.255.255.0', name: 'en0', ip: '192.0.2.100', netmask: '255.255.255.0', subnet: '192.0.2.0/24', broadcast: '192.0.2.255', prefix: 24 }
const caller: CallerIdentity = { type: 'plugin', pluginId: 'lan-scanner', pluginInstanceId: 'test', webContentsId: 813 }
const request = { action: 'scan', operationId: 'scan_test', interfaceId: iface.id, scanAddress: iface.ip }
const signal = () => new AbortController().signal
const mac = '02:11:22:33:44:55'
function fixture() {
  const provider: LanNetworkProvider = { interfaces: () => [iface], scan: async () => ({ devices: [], warnings: [] }), wake: async () => 102 }
  const service = new LanNetworkService('darwin', provider)
  return { provider, service, call: (v: unknown, who = caller, abort = signal()) => service.handle(v, who, abort) }
}
test('LAN 严格 IPC：参数注入、非法 IP/MAC、额外测试字段均在网络操作前拒绝', () => {
  validateMethodParams('lan_network', request); assert.equal(canCall('lan_network', caller), true)
  for (const r of [null, [], {}, { ...request, action: '__proto__' }, { ...request, scanAddress: '256.1.1.1' }, { ...request, scanAddress: '1.1.1.01' }, { ...request, operationId: '' }, { ...request, interfaceId: '-a' }, { ...request, simulateOffline: true }, { ...request, extra: 'x' }]) assert.throws(() => validateLanRequest(r))
  for (const v of ['', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:11:22:33:44:55', '02-11:22-33:44-55', '1234567890123']) assert.throws(() => normalizeLanMac(v))
  assert.equal(normalizeLanMac('021122334455'), mac)
})
test('真实网卡掩码：/23 分段、/25、/31/32，边界地址不越界，不伪造 /24', () => {
  const entry = { address: iface.ip, netmask: '255.255.254.0', family: 'IPv4' as const, mac, internal: false, cidr: null }
  const interfaces = listLanInterfaces({ en0: [entry], utun0: [entry], lo0: [{ ...entry, internal: true }] })
  assert.equal(interfaces.length, 1); assert.equal(interfaces[0]!.subnet, '192.0.2.0/23'); assert.equal(interfaces[0]!.broadcast, '192.0.3.255')
  const first = lanScanRange(interfaces[0]!, '192.0.2.44'), second = lanScanRange(interfaces[0]!, '192.0.3.44')
  assert.equal(first.hosts.length, 255); assert.ok(first.hosts.includes('192.0.2.255')); assert.ok(second.hosts.includes('192.0.3.0')); assert.equal(second.hosts.length, 255)
  assert.throws(() => lanScanRange(iface, '198.51.100.1'), /网段/)
  for (const [mask, count, prefix] of [['255.255.255.128', 126, 25], ['255.255.255.254', 2, 31], ['255.255.255.255', 1, 32]] as const) {
    const range = lanScanRange({ ...iface, netmask: mask }, iface.ip); assert.equal(range.hosts.length, count); assert.match(range.cidr, new RegExp(`/${prefix}$`))
  }
  assert.throws(() => listLanInterfaces({ en0: [{ ...entry, netmask: '255.0.255.0' }] }), /掩码/)
})
test('原生邻居回执拒绝脱敏、重复冲突、畸形地址与缺权限，不冒充在线结果', () => {
  const encode = (entries: unknown) => JSON.stringify({ version: 1, success: true, entries })
  assert.deepEqual([...parseLanNeighbors(encode([{ ip: '192.0.2.4', mac }]))], [['192.0.2.4', mac]])
  assert.deepEqual([...parseLanNeighbors(encode([]))], [])
  for (const entries of [null, [{ ip: 'bad', mac }], [{ ip: '192.0.2.4', mac: '02:00:00:00:00:00' }],
    [{ ip: '192.0.2.4', mac: 'ff:ff:ff:ff:ff:ff' }], [{ ip: '192.0.2.4', mac }, { ip: '192.0.2.4', mac: '02:11:22:33:44:56' }]]) assert.throws(() => parseLanNeighbors(encode(entries)))
  for (const value of ['{}', 'null', '[]', '{', '{"version":2,"success":true,"entries":[]}']) assert.throws(() => parseLanNeighbors(value))
  assert.throws(() => parseLanNeighbors('{"version":1,"success":false,"code":"TOPOLOGY_PERMISSION_REQUIRED"}'), /网络拓扑权限/)
  assert.match(macNetworkHelperPath(true, '/example/ZTools.app/Contents/Resources'), /Contents\/Helpers\/ZToolsMacNetwork.app\/Contents\/MacOS\/ZToolsMacNetwork$/)
  assert.match(macNetworkHelperPath(false, '/ignored'), /mac-network-native\/ZToolsMacNetwork.app/)
})
test('真实 TCP 套接字：开放、拒绝、取消与重复探测均释放 abort 监听', async () => {
  const server = net.createServer(socket => socket.destroy()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port, abort = new AbortController()
  assert.deepEqual((await probeLanTcp('127.0.0.1', port, '127.0.0.1', abort.signal)).open, true)
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.deepEqual((await probeLanTcp('127.0.0.1', port, '127.0.0.1', abort.signal)).responded, true)
  for (let n = 0; n < 20; n++) await probeLanTcp('127.0.0.1', port, '127.0.0.1', abort.signal)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  const cancelled = probeLanTcp('127.0.0.1', port, '127.0.0.1', abort.signal); abort.abort(); await assert.rejects(cancelled, /取消/)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})
test('真实 UDP 捕获 WOL 102 字节；无效源地址、预取消不会误报成功', async () => {
  const receiver = dgram.createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening')
  try {
    const received = once(receiver, 'message'), port = receiver.address().port
    assert.equal(await sendLanWake(mac, '127.0.0.1', '127.0.0.1', signal(), port), 102)
    const [bytes] = await received; assert.deepEqual(bytes, wolPacket(mac)); assert.equal(bytes.length, 102)
    assert.deepEqual([...bytes.subarray(0, 6)], [255,255,255,255,255,255])
    for (let n = 0; n < 16; n++) assert.equal(bytes.subarray(6 + n * 6, 12 + n * 6).toString('hex'), '021122334455')
    await assert.rejects(sendLanWake(mac, '192.0.2.254', '127.0.0.1', signal(), port))
    const duringBind = new AbortController(), pending = sendLanWake(mac, '127.0.0.1', '127.0.0.1', duringBind.signal, port)
    duringBind.abort(); await assert.rejects(pending, /取消/); assert.equal(getEventListeners(duringBind.signal, 'abort').length, 0)
    const abort = new AbortController(); abort.abort(); assert.throws(() => sendLanWake(mac, '127.0.0.1', '127.0.0.1', abort.signal, port))
  } finally { receiver.close() }
})
test('Mac 真实集成：协议→服务→ICMP/TCP→结果，不读取缓存冒充在线', { skip: process.platform !== 'darwin' }, async () => {
  const local = { ...iface, id: 'lo0|127.0.0.1|255.255.255.255', name: 'lo0', ip: '127.0.0.1', netmask: '255.255.255.255', prefix: 32, broadcast: null }
  const provider = new MacLanNetworkProvider(); provider.interfaces = () => [local]
  const service = new LanNetworkService('darwin', provider), r = { ...request, interfaceId: local.id, scanAddress: local.ip }
  try {
    validateMethodParams('lan_network', r)
    const result = await service.handle(r, caller, signal()) as { scanned: number; devices: Array<{ ip: string; latencyMs: number | null }> }
    assert.equal(result.scanned, 1); assert.equal(result.devices.length, 1); assert.equal(result.devices[0]!.ip, local.ip); assert.ok(typeof result.devices[0]!.latencyMs === 'number')
    assert.ok((await probeLanPing('127.0.0.1', '127.0.0.1', signal()))! >= 0)
    await assert.rejects(probeLanPing('127.0.0.1', '192.0.2.254', signal()))
  } finally { await service.stop() }
})
test('空网卡、断网、异常扫描与不完整发送回执均明确失败；清理后可重试', async () => {
  const f = fixture()
  try {
    f.provider.interfaces = () => []; assert.deepEqual(await f.call({ action: 'interfaces' }), { success: true, interfaces: [] }); await assert.rejects(f.call(request), /断开/)
    f.provider.interfaces = () => [iface]; f.provider.scan = async () => { throw new Error('permission denied') }; await assert.rejects(f.call(request), /permission denied/)
    f.provider.scan = async () => { f.provider.interfaces = () => []; return { devices: [], warnings: [] } }; await assert.rejects(f.call(request), /扫描期间/)
    f.provider.interfaces = () => [iface]; f.provider.wake = async () => 0; await assert.rejects(f.call({ action: 'wake', operationId: 'wake', interfaceId: iface.id, mac }), /完整发送/)
    f.provider.scan = async () => ({ devices: [], warnings: [] }); assert.equal((await f.call(request)).success, true)
  } finally { await f.service.stop() }
})
test('互斥、跨窗口取消隔离、退出取消与服务停止，不留下进行中状态', async () => {
  const f = fixture(); let released = 0
  f.provider.scan = async (_iface, _hosts, abort) => { try { await delay(60000, undefined, { signal: abort }); return { devices: [], warnings: [] } } finally { released++ } }
  const running = f.call(request); const rejected = assert.rejects(running)
  await assert.rejects(f.call({ ...request, operationId: 'other' }), /正在进行/)
  await assert.rejects(f.call({ action: 'cancel', operationId: request.operationId }, { ...caller, pluginInstanceId: 'other' }), /其他插件/)
  await f.call({ action: 'cancel', operationId: request.operationId }); await rejected; assert.equal(released, 1)
  const running2 = f.call(request); const rejected2 = assert.rejects(running2); f.service.closeOwner(caller.webContentsId); await rejected2
  const running3 = f.call(request); const rejected3 = assert.rejects(running3); await f.service.stop(); await rejected3; assert.equal(released, 3)
  await assert.rejects(f.call(request), /已停止/)
})
test('Mac 旧 DLL 入口拒绝模拟扫描和模拟唤醒', { skip: process.platform !== 'darwin' }, async () => {
  const handler = new NetworkHostPluginHandler({} as HostPluginContext)
  for (const fn of ['detectActiveInterfaces', 'scanSubnet', 'sendWakeOnLan']) {
    const result = await handler.handleLanScanner(fn, { dryRun: true, simulateOffline: true }) as { success: boolean; error: string }
    assert.equal(result.success, false); assert.match(result.error, /旧接口不支持/)
  }
})
