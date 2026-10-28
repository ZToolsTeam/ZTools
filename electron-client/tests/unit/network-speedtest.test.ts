import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once, getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { validateSpeedtestRequest, parseProbeTarget, type NetworkBandwidth } from '../../src/contracts/network-speedtest.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { NetworkSpeedtestService } from '../../src/main/services/network-speedtest-service.js'
import { MacSpeedtestProvider, parseDefaultRoute, parseNetworkQuality, runNetworkCommand, measureTcpNode, type SpeedtestProvider } from '../../src/main/services/network-speedtest-provider.js'
const caller: CallerIdentity = { type: 'plugin', pluginId: 'speedtest', pluginInstanceId: 'test', webContentsId: 821 }
const signal = () => new AbortController().signal
const raw = { dl_throughput: 125_000_000, ul_throughput: 40_000_000, interface_name: 'utun6', base_rtt: 12.25, responsiveness: 500, dl_bytes_transferred: 128000, ul_bytes_transferred: 64000 }
const bandwidth = (): NetworkBandwidth => parseNetworkQuality(JSON.stringify(raw), 15000)

test('严格 IPC 接受 IPv4/IPv6/域名端口，拒绝命令、账号路径和测试注入字段', () => {
  for (const target of ['example.com:8443', '127.0.0.1', '[::1]:443', '::1', 'https://example.com/', 'localhost']) {
    validateMethodParams('network_speedtest', { action: 'diagnose', operationId: 'a', target }); assert.ok(parseProbeTarget(target).port > 0)
  }
  for (const target of ['', 'https://a:b@example.com', 'file:///etc/hosts', 'example.com/path', 'example.com?a=b', 'example.com#x', 'host:99999', 'host:0', 'a;rm -rf', 'a\\b', ['example.com']]) assert.throws(() => validateSpeedtestRequest({ action: 'diagnose', operationId: 'a', target }))
  for (const r of [null, [], { action: ['cancel'], operationId: 'x' }, { action: 'bandwidth', operationId: '' }, { action: 'bandwidth', operationId: 'x', mockBandwidth: raw }, { action: 'cancel', operationId: 'a', target: 'example.com' }]) assert.throws(() => validateSpeedtestRequest(r))
})
test('系统 JSON 按 bit/s 换算实际 Mbps，缺字段/错误/零值不补假带宽', () => {
  assert.equal(bandwidth().downloadMbps, 125); assert.equal(bandwidth().uploadMbps, 40)
  for (const patch of [{ dl_throughput: undefined }, { ul_throughput: 0 }, { base_rtt: '1' }, { dl_throughput: -1 }, { dl_throughput: null }, { interface_name: '' }, { error_code: -1009, error_domain: 'NSURLErrorDomain' }]) assert.throws(() => parseNetworkQuality(JSON.stringify({ ...raw, ...patch }), 100))
  assert.throws(() => parseNetworkQuality('bad', 100)); assert.throws(() => parseNetworkQuality('[]', 100))
  const optional = parseNetworkQuality(JSON.stringify({ dl_throughput: 1, ul_throughput: 1, interface_name: 'en0' }), 100)
  assert.equal(optional.baseRttMs, null); assert.equal(optional.downloadedBytes, null)
})
test('默认路由读取真实网卡与网关；VPN 没有网关时不猜 .1 地址', () => {
  const route = parseDefaultRoute('  interface: utun6\n', {}); assert.equal(route.interfaceName, 'utun6'); assert.equal(route.gateway, null); assert.match(route.warning!, /VPN/)
  const ordinary = parseDefaultRoute(' gateway: 192.0.2.7\n interface: en0\n', {}); assert.equal(ordinary.gateway, '192.0.2.7')
  assert.equal(parseDefaultRoute('gateway: link#9\ninterface: en1\n', {}).gateway, null)
})
test('真实 TCP 三次同址测量、失败与取消清理，无响应不冒充断网或零延迟', async () => {
  const server = net.createServer(socket => socket.destroy()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port, controller = new AbortController(), target = parseProbeTarget(`127.0.0.1:${port}`)
  try {
    const result = await measureTcpNode(target, controller.signal)
    assert.equal(result.samplesMs.length, 3); assert.equal(result.error, null); assert.ok(result.latencyMs! >= 0); assert.ok(result.jitterMs! >= 0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  const result = await measureTcpNode(target, controller.signal); assert.equal(result.latencyMs, null); assert.equal(result.jitterMs, null); assert.match(result.error!, /ECONNREFUSED/)
  controller.abort(); await assert.rejects(measureTcpNode(target, controller.signal)); assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('真实子进程有界退出：执行失败、预取消、进行中取消、超时、输出超限均不遗留进程', async () => {
  assert.equal((await runNetworkCommand(process.execPath, ['-e', 'console.log(42)'], signal())).trim(), '42')
  await assert.rejects(runNetworkCommand(process.execPath, ['-e', 'process.exit(2)'], signal()))
  await assert.rejects(runNetworkCommand('/ztools-does-not-exist', [], signal()))
  const controller = new AbortController(); controller.abort(); await assert.rejects(runNetworkCommand(process.execPath, [], controller.signal))
  const c = new AbortController(), running = runNetworkCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], c.signal); setTimeout(() => c.abort(), 80)
  await assert.rejects(running); assert.equal(getEventListeners(c.signal, 'abort').length, 0)
  await assert.rejects(runNetworkCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal(), 80))
  await assert.rejects(runNetworkCommand(process.execPath, ['-e', 'console.log("x".repeat(1100000))'], signal()))
})
test('真实协议→服务→系统路由与本地 TCP 集成，不调用 Windows DLL', { skip: process.platform !== 'darwin' }, async () => {
  const server = net.createServer(socket => socket.destroy()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port, service = new NetworkSpeedtestService(new MacSpeedtestProvider(), 'darwin')
  try {
    const request = { action: 'diagnose', operationId: 'actual', target: `127.0.0.1:${port}` }; validateMethodParams('network_speedtest', request)
    const result = await service.handle(request, caller, signal()) as { success: boolean; nodes: Array<{ samplesMs: number[] }> }
    assert.equal(result.success, true); assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0]!.samplesMs.length, 3)
  } finally { await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
test('操作互斥、调用者隔离、取消等待底层退出、关闭窗口/服务均可回收', async () => {
  let ended = 0
  const provider: SpeedtestProvider = { diagnose: async () => { throw new Error('检测失败') }, bandwidth: async s => { try { await delay(50000, undefined, { signal: s }); return bandwidth() } finally { ended++ } } }
  const service = new NetworkSpeedtestService(provider, 'darwin'), call = (r: unknown, who = caller) => service.handle(r, who, signal()), request = { action: 'bandwidth', operationId: 'first' }
  try {
    const pending = call(request), rejected = assert.rejects(pending)
    await assert.rejects(call({ ...request, operationId: 'second' }), /正在进行/)
    await assert.rejects(call({ action: 'cancel', operationId: 'first' }, { ...caller, pluginInstanceId: 'other' }), /其他窗口/)
    await call({ action: 'cancel', operationId: 'first' }); await rejected; assert.equal(ended, 1)
    const next = call(request), nextRejected = assert.rejects(next); service.closeOwner(caller.webContentsId); await nextRejected; assert.equal(ended, 2)
    await assert.rejects(call({ action: 'diagnose', operationId: 'failure' }), /检测失败/)
    provider.bandwidth = async () => bandwidth(); assert.equal((await call(request) as { success: boolean }).success, true)
    await service.stop(); await assert.rejects(call(request), /停止/)
  } finally { await service.stop() }
})
