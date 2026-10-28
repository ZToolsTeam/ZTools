import test from 'node:test'
import assert from 'node:assert/strict'
import { validateLanRequest, type LanInterface } from '../../src/contracts/lan-network.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import {
  createLanNetworkProvider, listLanInterfaces, MacLanNetworkProvider, parseWindowsArp, parseWindowsPing, probeWindowsPing, readWindowsNeighbors,
  runWindowsTool, scanLan, wakeLan, windowsSystemTool, WindowsLanNetworkProvider, type WindowsToolResult, type WindowsToolRunner
} from '../../src/main/services/lan-network-provider.js'
import { LanNetworkService } from '../../src/main/services/lan-network-service.js'

const caller: CallerIdentity = { type: 'plugin', pluginId: 'lan-scanner', pluginInstanceId: 'test', webContentsId: 917 }
const signal = () => new AbortController().signal
const mac = '02:11:22:33:44:55'
// 模拟中文系统 GBK 输出按 latin1 读取后的乱码：只保留 ASCII 数字、IP、TTL、ms 可解析
const gbk = (text: string) => Buffer.from(text, 'utf8').toString('latin1')
const entry = (address: string, netmask = '255.255.255.0', internal = false) => ({ address, netmask, family: 'IPv4' as const, mac, internal, cidr: null })

test('Windows 网卡名：允许空格/括号/中文，拒绝竖线、控制字符、超长；虚拟网卡与 169.254 排后；编号通过严格契约', () => {
  const long = 'a'.repeat(65)
  const source = {
    'vEthernet (WSL)': [entry('172.20.0.1', '255.255.240.0')],
    'Loopback Pseudo-Interface 1': [entry('127.0.0.1', '255.0.0.0', true)],
    '以太网 2': [entry('192.0.2.100'), { ...entry('fe80::1'), family: 'IPv6' as const, scopeid: 0 }],
    'Wi-Fi': [entry('169.254.10.20', '255.255.0.0'), entry('198.51.100.7')],
    'bad|name': [entry('203.0.113.5')], 'ctl\u0001': [entry('203.0.113.6')], [long]: [entry('203.0.113.7')]
  }
  const list = listLanInterfaces(source, 'win32')
  assert.deepEqual(list.map(v => `${v.name}|${v.ip}`), ['以太网 2|192.0.2.100', 'Wi-Fi|198.51.100.7', 'vEthernet (WSL)|172.20.0.1', 'Wi-Fi|169.254.10.20'])
  assert.equal(list[2]!.subnet, '172.20.0.0/20'); assert.equal(list[2]!.broadcast, '172.20.15.255')
  for (const v of list) {
    const request = { action: 'scan', operationId: 'op_1', interfaceId: v.id, scanAddress: v.ip }
    validateLanRequest(request); validateMethodParams('lan_network', request)
  }
  // Mac 规则不变：中文/空格名称与 utun 仍被排除
  assert.deepEqual(listLanInterfaces({ '以太网 2': [entry('192.0.2.100')], utun3: [entry('10.0.0.2')], en0: [entry('192.0.2.5')] }, 'darwin').map(v => v.name), ['en0'])
  for (const id of ['a|b|192.0.2.1|255.255.255.0', 'x\u0001|192.0.2.1|255.255.255.0', `${long}|192.0.2.1|255.255.255.0`, '以太网 2|192.0.2.1', '|192.0.2.1|255.255.255.0']) {
    assert.throws(() => validateLanRequest({ action: 'wake', operationId: 'op', interfaceId: id, mac }), /网卡编号/)
  }
})

// 模拟俄语系统 CP866 输出按 latin1 读取：西里尔字母（含延迟单位“мс”）全部变成不可识别的字节，只剩 ASCII
const cp866 = (text: string) => text.replace(/[\u0400-\u04ff]/g, ch => String.fromCharCode(0xa0 + (ch.charCodeAt(0) % 0x50)))
test('Windows ping 解析：多语言回复、<1ms、网关代发不可达（退出码 0）、TTL 超时、其他主机回复、异常退出码与畸形输出', () => {
  const t = '192.0.2.8'
  assert.deepEqual(parseWindowsPing(`\r\nPinging ${t} from 192.0.2.100 with 32 bytes of data:\r\nReply from ${t}: bytes=32 time=12ms TTL=64\r\n\r\nPing statistics for ${t}:\r\n    Minimum = 12ms, Maximum = 12ms, Average = 12ms\r\n`, 0, t), { latencyMs: 12 })
  assert.deepEqual(parseWindowsPing(gbk(`正在 Ping ${t} 具有 32 字节的数据:\r\n来自 ${t} 的回复: 字节=32 时间<1ms TTL=128\r\n`), 0, t), { latencyMs: 1 })
  assert.deepEqual(parseWindowsPing(`Antwort von ${t}: Bytes=32 Zeit=3ms TTL=255`, 0, t), { latencyMs: 3 })
  assert.deepEqual(parseWindowsPing(gbk(`Réponse de ${t} : octets=32 temps=7 ms TTL=64`), 0, t), { latencyMs: 7 })
  // 日语系统（Shift-JIS 按 latin1 读取）：单位仍是 ASCII ms，延迟可解析
  assert.deepEqual(parseWindowsPing(gbk(`${t} からの応答: バイト数 =32 時間 =5ms TTL=64`), 0, t), { latencyMs: 5 })
  // 俄语系统：有含目标地址与 TTL 的回复行即在线，单位“мс”解析不到时延迟为 null，不抛错
  const russian = cp866(`Обмен пакетами с ${t} по с 32 байтами данных:\r\nОтвет от ${t}: число байт=32 время<1мс TTL=64\r\n`)
  assert.doesNotMatch(russian, /[\u0400-\u04ff]/)
  assert.deepEqual(parseWindowsPing(russian, 0, t), { latencyMs: null })
  assert.deepEqual(parseWindowsPing(cp866(`Ответ от ${t}: число байт=32 время=14мс TTL=128`), 0, t), { latencyMs: null })
  // 网关/本机代发“无法访问目标主机”时 Windows 退出码可能为 0，但没有 TTL=，不能算在线
  assert.equal(parseWindowsPing(`Reply from 192.0.2.100: Destination host unreachable.\r\n    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),`, 0, t), null)
  assert.equal(parseWindowsPing(gbk('来自 192.0.2.100 的回复: 无法访问目标主机。'), 0, t), null)
  assert.equal(parseWindowsPing('Reply from 192.0.2.1: TTL expired in transit.', 0, t), null)
  assert.equal(parseWindowsPing('Reply from 192.0.2.80: bytes=32 time=1ms TTL=64', 0, t), null)
  assert.equal(parseWindowsPing(`Request timed out.\r\nPing statistics for ${t}:`, 1, t), null)
  assert.equal(parseWindowsPing('', 0, t), null)
  assert.deepEqual(parseWindowsPing(`Reply from ${t}: bytes=32 TTL=64`, 0, t), { latencyMs: null })
  assert.throws(() => parseWindowsPing('', 2, t), /退出码 2/)
  assert.throws(() => parseWindowsPing('', null, t), /退出码 未知/)
  assert.throws(() => parseWindowsPing('', 0, '192.0.2.256'), /目标地址/)
})

test('Windows ping 调用：系统目录 PING.EXE、绑定本机源地址；超时视为无回复，取消与启动失败抛错', async () => {
  const seen: Array<{ file: string; args: string[]; timeout: number }> = []
  let reply: WindowsToolResult | Error = { stdout: 'Reply from 192.0.2.8: bytes=32 time<1ms TTL=64', exitCode: 0, timedOut: false }
  const run: WindowsToolRunner = async (file, args, options) => { seen.push({ file, args, timeout: options.timeout }); if (reply instanceof Error) throw reply; return reply }
  assert.deepEqual(await probeWindowsPing('192.0.2.8', '192.0.2.100', signal(), run), { latencyMs: 1 })
  assert.match(seen[0]!.file, /\\System32\\PING\.EXE$/)
  assert.deepEqual(seen[0]!.args, ['-4', '-n', '1', '-w', '350', '-i', '1', '-S', '192.0.2.100', '192.0.2.8'])
  reply = { stdout: '', exitCode: null, timedOut: true }; assert.equal(await probeWindowsPing('192.0.2.8', '192.0.2.100', signal(), run), null)
  reply = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); await assert.rejects(probeWindowsPing('192.0.2.8', '192.0.2.100', signal(), run), /ENOENT/)
  const aborted = new AbortController(); aborted.abort(new Error('已取消')); await assert.rejects(probeWindowsPing('192.0.2.8', '192.0.2.100', aborted.signal, run), /已取消/)
  assert.equal(windowsSystemTool('ARP.EXE', 'D:\\Win'), 'D:\\Win\\System32\\ARP.EXE')
  assert.equal(windowsSystemTool('PING.EXE', 'relative\\evil'), 'C:\\Windows\\System32\\PING.EXE')
})

test('Windows ARP 解析：只取所选网卡段，跳过广播/组播/全零，冲突报错，中文表头与空表', () => {
  const local = '192.0.2.100'
  const english = `\r\nInterface: ${local} --- 0xb\r\n  Internet Address      Physical Address      Type\r\n  192.0.2.1             aa-bb-cc-dd-ee-f0     dynamic\r\n  192.0.2.8             02-11-22-33-44-55     dynamic\r\n  192.0.2.255           ff-ff-ff-ff-ff-ff     static\r\n  224.0.0.22            01-00-5e-00-00-16     static\r\n  192.0.2.9             00-00-00-00-00-00     invalid\r\n\r\nInterface: 198.51.100.7 --- 0x12\r\n  198.51.100.1          02-aa-aa-aa-aa-aa     dynamic\r\n`
  assert.deepEqual([...parseWindowsArp(english, local)], [['192.0.2.1', 'AA:BB:CC:DD:EE:F0'], ['192.0.2.8', mac.toUpperCase()]])
  const chinese = gbk(`\r\n接口: ${local} --- 0xb\r\n  Internet 地址         物理地址              类型\r\n  192.0.2.8             02-11-22-33-44-55     动态\r\n`)
  assert.deepEqual([...parseWindowsArp(chinese, local)], [['192.0.2.8', mac.toUpperCase()]])
  assert.deepEqual([...parseWindowsArp('No ARP Entries Found.\r\n', local)], [])
  assert.deepEqual([...parseWindowsArp(gbk('未找到 ARP 项。'), local)], [])
  assert.deepEqual([...parseWindowsArp(`Interface: 198.51.100.7 --- 0x12\r\n  198.51.100.1  02-aa-aa-aa-aa-aa  dynamic`, local)], [])
  assert.equal(parseWindowsArp(`Interface: ${local} --- 0xb\r\n  192.0.2.8  02-11-22-33-44-55  dynamic\r\n  192.0.2.8  02-11-22-33-44-55  static`, local).size, 1)
  assert.throws(() => parseWindowsArp(`Interface: ${local} --- 0xb\r\n  192.0.2.8  02-11-22-33-44-55  dynamic\r\n  192.0.2.8  02-11-22-33-44-56  dynamic`, local), /多个 MAC/)
  assert.throws(() => parseWindowsArp('  192.0.2.8  02-11-22-33-44-55  dynamic', local), /格式无法识别/)
  assert.equal(parseWindowsArp(`Interface: ${local} --- 0xb\r\n  999.0.2.8  02-11-22-33-44-55  dynamic`, local).size, 0)
})

test('Windows ARP 调用：-a -N 本机地址；空表的非零退出按空表，有数据行的非零退出与超时作为错误交给扫描提示', async () => {
  let reply: WindowsToolResult = { stdout: 'Interface: 192.0.2.100 --- 0xb\r\n  192.0.2.8  02-11-22-33-44-55  dynamic', exitCode: 0, timedOut: false }, args: string[] = []
  const run: WindowsToolRunner = async (file, a) => { assert.match(file, /\\System32\\ARP\.EXE$/); args = a; return reply }
  assert.equal((await readWindowsNeighbors('192.0.2.100', signal(), run)).get('192.0.2.8'), mac.toUpperCase())
  assert.deepEqual(args, ['-a', '-N', '192.0.2.100'])
  // 空表：英文、中文乱码、完全无输出都按空表返回，不抛错
  for (const stdout of ['No ARP Entries Found.\r\n', gbk('未找到 ARP 项。\r\n'), '', 'Interface: 192.0.2.100 --- 0xb\r\n  Internet Address      Physical Address      Type\r\n']) {
    reply = { stdout, exitCode: 1, timedOut: false }; assert.equal((await readWindowsNeighbors('192.0.2.100', signal(), run)).size, 0)
  }
  // 输出里有可解析的数据行却非零退出：结果可能不完整，仍报错
  reply = { stdout: 'Interface: 192.0.2.100 --- 0xb\r\n  192.0.2.8  02-11-22-33-44-55  dynamic', exitCode: 1, timedOut: false }; await assert.rejects(readWindowsNeighbors('192.0.2.100', signal(), run), /退出码 1/)
  reply = { stdout: '  192.0.2.8  02-11-22-33-44-55  dynamic', exitCode: 5, timedOut: false }; await assert.rejects(readWindowsNeighbors('192.0.2.100', signal(), run), /退出码 5/)
  reply = { stdout: '', exitCode: null, timedOut: true }; await assert.rejects(readWindowsNeighbors('192.0.2.100', signal(), run), /超时/)
})

test('真实子进程：runWindowsTool 区分正常、非零退出码、超时、找不到程序与取消', async () => {
  const node = process.execPath, options = (timeout = 5000, abort = signal()) => ({ signal: abort, timeout, maxBuffer: 65536 })
  assert.deepEqual(await runWindowsTool(node, ['-e', 'process.stdout.write("TTL=64")'], options()), { stdout: 'TTL=64', exitCode: 0, timedOut: false })
  assert.deepEqual(await runWindowsTool(node, ['-e', 'process.stdout.write("x");process.exit(3)'], options()), { stdout: 'x', exitCode: 3, timedOut: false })
  const slow = await runWindowsTool(node, ['-e', 'setTimeout(()=>{},10000)'], options(200)); assert.equal(slow.timedOut, true); assert.equal(slow.exitCode, null)
  await assert.rejects(runWindowsTool('/nonexistent/PING.EXE', [], options()), (e: NodeJS.ErrnoException) => e.code === 'ENOENT')
  await assert.rejects(runWindowsTool(node, ['-e', 'process.stdout.write("x".repeat(70000))'], options()), (e: NodeJS.ErrnoException) => /MAXBUFFER/.test(String(e.code)))
  const abort = new AbortController(), pending = runWindowsTool(node, ['-e', 'setTimeout(()=>{},10000)'], options(5000, abort.signal))
  abort.abort(new Error('扫描已取消')); await assert.rejects(pending, /扫描已取消/)
})

const winIface = (over: Partial<LanInterface> = {}): LanInterface => ({ id: '以太网 2|192.0.2.100|255.255.255.0', name: '以太网 2', ip: '192.0.2.100', netmask: '255.255.255.0', subnet: '192.0.2.0/24', broadcast: '192.0.2.255', prefix: 24, ...over })
function windowsHost(options: { arp?: WindowsToolResult | Error; ping?: Record<string, WindowsToolResult> } = {}) {
  const calls: string[][] = []
  const run: WindowsToolRunner = async (file, args) => {
    calls.push([file.split('\\').at(-1)!, ...args])
    if (file.endsWith('ARP.EXE')) { const arp = options.arp ?? { stdout: 'Interface: 192.0.2.100 --- 0xb\r\n  192.0.2.8  02-11-22-33-44-55  dynamic\r\n  192.0.2.9  02-aa-bb-cc-dd-ee  dynamic', exitCode: 0, timedOut: false }; if (arp instanceof Error) throw arp; return arp }
    const target = args.at(-1)!
    return options.ping?.[target] ?? { stdout: 'Request timed out.', exitCode: 1, timedOut: false }
  }
  const tcp = async (ip: string, port: number) => ({ open: ip === '192.0.2.9' && port === 22, responded: ip === '192.0.2.9' && [22, 80].includes(port), ms: 4 })
  const provider = new WindowsLanNetworkProvider({ run, tcp, source: () => ({ '以太网 2': [entry('192.0.2.100')] }) })
  return { calls, provider, service: new LanNetworkService('win32', provider) }
}

test('Windows 集成：协议→服务→ping/TCP→ARP→结果；网关代发不可达不算在线，MAC 只补充已响应设备', async () => {
  const h = windowsHost({ ping: {
    '192.0.2.8': { stdout: 'Reply from 192.0.2.8: bytes=32 time=2ms TTL=64', exitCode: 0, timedOut: false },
    '192.0.2.100': { stdout: gbk('来自 192.0.2.100 的回复: 字节=32 时间<1ms TTL=128'), exitCode: 0, timedOut: false },
    '192.0.2.20': { stdout: 'Reply from 192.0.2.100: Destination host unreachable.', exitCode: 0, timedOut: false },
    '192.0.2.30': { stdout: '', exitCode: null, timedOut: true }
  } })
  try {
    const listed = await h.service.handle({ action: 'interfaces' }, caller, signal()) as { interfaces: LanInterface[] }
    assert.equal(listed.interfaces[0]!.id, '以太网 2|192.0.2.100|255.255.255.0')
    const request = { action: 'scan', operationId: 'scan_win', interfaceId: listed.interfaces[0]!.id, scanAddress: '192.0.2.100' }
    validateMethodParams('lan_network', request)
    const result = await h.service.handle(request, caller, signal()) as { scanned: number; range: string; warnings: string[]; devices: Array<{ ip: string; mac: string | null; response: string; latencyMs: number | null; openPorts: number[] }> }
    assert.equal(result.scanned, 254); assert.equal(result.range, '192.0.2.0/24'); assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.devices, [
      { ip: '192.0.2.8', mac: mac.toUpperCase(), openPorts: [], response: 'ICMP', latencyMs: 2 },
      { ip: '192.0.2.9', mac: '02:AA:BB:CC:DD:EE', openPorts: [22], response: 'TCP', latencyMs: 4 },
      { ip: '192.0.2.100', mac: null, openPorts: [], response: '本机', latencyMs: 1 }
    ])
    assert.equal(h.calls.filter(c => c[0] === 'PING.EXE').length, 254); assert.deepEqual(h.calls.filter(c => c[0] === 'ARP.EXE'), [['ARP.EXE', '-a', '-N', '192.0.2.100']])
    await assert.rejects(h.service.handle({ action: 'wake', operationId: 'w', interfaceId: '以太网 2|192.0.2.100|255.255.0.0', mac }, caller, signal()), /断开/)
  } finally { await h.service.stop() }
})

test('Windows 故障注入：ARP 失败/空表转提示（含空表非零退出），ping 异常退出码使扫描失败，ping 全部无回复时给出提示', async () => {
  type ScanResult = { warnings: string[]; devices: Array<{ ip: string; mac: string | null; response: string; latencyMs: number | null }> }
  const reply8 = { '192.0.2.8': { stdout: 'Reply from 192.0.2.8: bytes=32 time=2ms TTL=64', exitCode: 0, timedOut: false } }
  const arpFail = windowsHost({ arp: { stdout: 'Interface: 192.0.2.100 --- 0xb\r\n  192.0.2.8  02-11-22-33-44-55  dynamic', exitCode: 5, timedOut: false }, ping: reply8 })
  const request = { action: 'scan', operationId: 'scan_win', interfaceId: winIface().id, scanAddress: '192.0.2.100' }
  try {
    const result = await arpFail.service.handle(request, caller, signal()) as ScanResult
    assert.deepEqual(result.warnings, ['MAC 地址读取失败：系统 ARP 表读取失败（退出码 5）']); assert.ok(result.devices.every(d => d.mac === null))
  } finally { await arpFail.service.stop() }
  // 空 ARP 表：退出码 0 与非零退出（无数据行）都按空表提示，不再报“读取失败”
  for (const arp of [{ stdout: 'No ARP Entries Found.', exitCode: 0, timedOut: false }, { stdout: gbk('未找到 ARP 项。'), exitCode: 1, timedOut: false }]) {
    const empty = windowsHost({ arp, ping: reply8 })
    try { assert.deepEqual((await empty.service.handle(request, caller, signal()) as ScanResult).warnings, ['系统未提供邻居 MAC 地址；仍可查看响应设备和端口，远程唤醒请手动输入设备 MAC']) } finally { await empty.service.stop() }
  }
  const broken = windowsHost({ ping: { '192.0.2.50': { stdout: '', exitCode: 2, timedOut: false } } })
  try { await assert.rejects(broken.service.handle(request, caller, signal()), /ping 异常退出（退出码 2）/) } finally { await broken.service.stop() }
  // 系统 ping 全部失败（如源地址失效、General failure，退出码 1 与无回复无法区分）但有 TCP 响应：提示结果只含 TCP 设备
  const noIcmp = windowsHost()
  try {
    const result = await noIcmp.service.handle(request, caller, signal()) as ScanResult
    assert.deepEqual(result.devices.map(d => `${d.ip}|${d.response}`), ['192.0.2.9|TCP', '192.0.2.100|本机'])
    assert.equal(result.warnings.length, 1); assert.match(result.warnings[0]!, /未收到任何 ping 回复：可能被防火墙拦截或系统 ping 失败，结果只包含 TCP 端口有响应的设备/)
  } finally { await noIcmp.service.stop() }
  // 俄语系统：在线但延迟解析不到，扫描成功、latencyMs 为 null、不产生 ping 提示
  const russian = windowsHost({ ping: { '192.0.2.8': { stdout: cp866('Ответ от 192.0.2.8: число байт=32 время<1мс TTL=64'), exitCode: 0, timedOut: false } } })
  try {
    const result = await russian.service.handle(request, caller, signal()) as ScanResult
    assert.deepEqual(result.devices.find(d => d.ip === '192.0.2.8'), { ip: '192.0.2.8', mac: mac.toUpperCase(), openPorts: [], response: 'ICMP', latencyMs: null }); assert.deepEqual(result.warnings, [])
  } finally { await russian.service.stop() }
  // 共用流程：ICMP 与 TCP 都为空时给出提示，不静默返回空列表；仍读取邻居表给本机补 MAC，空表不提示
  let neighborCalls = 0
  const alone = await scanLan(winIface(), ['192.0.2.100', '192.0.2.101'], signal(), async ip => ip === '192.0.2.100' ? { latencyMs: 1 } : null, async () => { neighborCalls++; return new Map() },
    { tcp: async () => ({ open: false, responded: false, ms: 0 }) })
  assert.equal(neighborCalls, 1); assert.deepEqual(alone.devices.map(d => d.response), ['本机'])
  assert.deepEqual(alone.warnings, ['除本机外未收到任何 ping 回复，也没有设备的 TCP 端口响应：可能网段内没有其他在线设备、被防火墙拦截或系统 ping 失败'])
  const nothing = await scanLan(winIface(), ['192.0.2.101', '192.0.2.102'], signal(), async () => null, async () => new Map(), { tcp: async () => ({ open: false, responded: false, ms: 0 }) })
  assert.deepEqual(nothing.devices, []); assert.equal(nothing.warnings.length, 1); assert.match(nothing.warnings[0]!, /TCP 端口响应/)
  // 只扫描本机地址（/32）时不提示
  const self = await scanLan(winIface(), ['192.0.2.100'], signal(), async () => ({ latencyMs: 1 }), async () => new Map(), { tcp: async () => ({ open: false, responded: false, ms: 0 }) })
  assert.deepEqual(self.warnings, [])
})

test('macOS 回归：始终读取邻居表，本机行也填上邻居表里的本机 MAC；邻居表读取失败转提示', async () => {
  const neighbors = new Map([['192.0.2.100', '02:AA:AA:AA:AA:01'], ['192.0.2.8', mac.toUpperCase()]])
  let calls = 0
  const onlySelf = await scanLan(winIface(), ['192.0.2.100', '192.0.2.8'], signal(), async ip => ip === '192.0.2.100' ? { latencyMs: 0.05 } : null,
    async () => { calls++; return neighbors }, { tcp: async () => ({ open: false, responded: false, ms: 0 }) })
  assert.equal(calls, 1); assert.deepEqual(onlySelf.devices, [{ ip: '192.0.2.100', mac: '02:AA:AA:AA:AA:01', openPorts: [], response: '本机', latencyMs: 0.05 }])
  const withPeer = await scanLan(winIface(), ['192.0.2.100', '192.0.2.8'], signal(), async () => ({ latencyMs: 2 }), async () => neighbors, { tcp: async () => ({ open: false, responded: false, ms: 0 }) })
  assert.deepEqual(withPeer.devices.map(d => `${d.ip}|${d.mac}|${d.response}`), [`192.0.2.8|${mac.toUpperCase()}|ICMP`, '192.0.2.100|02:AA:AA:AA:AA:01|本机']); assert.deepEqual(withPeer.warnings, [])
  const failed = await scanLan(winIface(), ['192.0.2.100', '192.0.2.8'], signal(), async () => ({ latencyMs: 2 }), async () => { throw new Error('网络拓扑权限不足') }, { tcp: async () => ({ open: false, responded: false, ms: 0 }) })
  assert.deepEqual(failed.warnings, ['MAC 地址读取失败：网络拓扑权限不足']); assert.ok(failed.devices.every(d => d.mac === null))
  // 取消时不把取消误报成邻居表读取失败
  const abort = new AbortController()
  await assert.rejects(scanLan(winIface(), ['192.0.2.100'], abort.signal, async () => ({ latencyMs: 1 }), async () => { abort.abort(new Error('扫描已取消')); throw new Error('helper killed') }, { tcp: async () => ({ open: false, responded: false, ms: 0 }) }), /扫描已取消/)
})

test('平台装配与唤醒：win32/darwin 选择对应实现，其他平台明确拒绝；点对点网段拒绝广播', async () => {
  assert.ok(createLanNetworkProvider('win32') instanceof WindowsLanNetworkProvider)
  assert.ok(createLanNetworkProvider('darwin') instanceof MacLanNetworkProvider)
  assert.throws(() => createLanNetworkProvider('linux').interfaces(), /macOS 和 Windows/)
  const linux = new LanNetworkService('linux')
  await assert.rejects(linux.handle({ action: 'interfaces' }, caller, signal()), /仅支持 macOS 和 Windows/)
  assert.throws(() => wakeLan(mac, winIface({ prefix: 31, netmask: '255.255.255.254', broadcast: null }), signal()), /点对点/)
  const p2p = winIface({ id: 'PPP|192.0.2.100|255.255.255.254', name: 'PPP', netmask: '255.255.255.254', prefix: 31, broadcast: null })
  const service = new LanNetworkService('win32', { interfaces: () => [p2p], scan: async () => ({ devices: [], warnings: [] }), wake: (m, i, s) => wakeLan(m, i, s) })
  try { await assert.rejects(service.handle({ action: 'wake', operationId: 'w', interfaceId: p2p.id, mac }, caller, signal()), /点对点/) } finally { await service.stop() }
})
