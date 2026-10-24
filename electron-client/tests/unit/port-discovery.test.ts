import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlatformPortDiscoveryAdapter, parseMacosNetstatPorts, parseMacosPorts, parseWindowsPorts } from '../../src/main/platform/port-discovery.js'
import { ProcessService } from '../../src/main/services/process-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
const signal = () => new AbortController().signal
const lsof = 'p123\0cBrowser\0\nf12\0tIPv4\0PTCP\0n127.0.0.1:3000\0TST=LISTEN\0\nf13\0tIPv6\0PUDP\0n[::1]:5353\0\np456\0cClient\0\nf14\0tIPv4\0PTCP\0n127.0.0.1:4000->127.0.0.1:3000\0TST=ESTABLISHED\0\n'
test('Mac NUL field parser keeps process/file sets, IPv4/IPv6, UDP and remote TCP endpoints', () => {
  const rows = parseMacosPorts(lsof); assert.equal(rows.length, 3); assert.deepEqual(rows.map(row => [row.pid, row.localPort, row.protocol]), [[123, 3000, 'TCP'], [456, 4000, 'TCP'], [123, 5353, 'UDP']]); assert.equal(rows[1]!.remotePort, 3000); assert.equal(rows[2]!.state, 'BOUND'); assert.equal(rows[0]!.processName, 'Browser'); assert.deepEqual(rows[0]!.fieldAvailability, { processName: true, processPath: false, startTime: false })
})
test('Windows parser handles numeric netstat endpoints, PID0 timewait and header localization', () => {
  const rows = parseWindowsPorts('本地化标题\r\n TCP 0.0.0.0:80 0.0.0.0:0 LISTENING 123\r\n TCP [::1]:443 [::1]:3000 FIN_WAIT_2 0\r\n UDP [fe80::1%12]:5353 *:* 456\r\n'); assert.equal(rows.length, 3); assert.equal(rows[0]!.remotePort, null); assert.equal(rows[1]!.pid, 0); assert.equal(rows[2]!.localAddress, 'fe80::1%12'); assert.equal(rows[2]!.fieldAvailability.processName, false); assert.deepEqual(parseWindowsPorts(''), [])
})
test('duplicate rows collapse and malformed fields, names, addresses, ports and oversized output reject', () => {
  assert.equal(parseMacosPorts(lsof + lsof).length, 3)
  for (const value of [lsof.replace('127.0.0.1:3000', 'example.org:3000'), lsof.replace('p123', 'p0'), lsof.replace('n127.0.0.1:3000', 'n127.0.0.1:99999'), lsof.replace('cBrowser', 'cBrowser\nBad'), 'p1\ncBad', 'xunknown\0']) assert.throws(() => parseMacosPorts(value), { code: 'PROCESS_ERROR' })
  for (const value of ['TCP bad *:* LISTENING 123', 'TCP 127.0.0.1:10 *:* LISTENING x']) assert.throws(() => parseWindowsPorts(value), { code: 'PROCESS_ERROR' })
  assert.deepEqual(parseWindowsPorts('UDP 127.0.0.1:0 *:* 123'), [])
  assert.deepEqual(parseMacosPorts('p123\0cUnbound\0\nf12\0tIPv4\0PTCP\0n*:*\0\n'), [])
  assert.throws(() => parseWindowsPorts('x'.repeat(4 * 1024 * 1024 + 1)))
})
// macOS 26 netstat -anv 样本：系统进程（mDNSResponder / netbiosd）、含空格且被截断的进程名、截断显示的 IPv6、TIME_WAIT 与 *.* 对端
const netstatHeader = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address                                 Foreign Address                               (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs\n'
const netstatTcp = netstatHeader + [
  'tcp4       0      0  127.0.0.1.19353        *.*                    LISTEN                 0            0  131072  131072         Electron:85666  00100 00000006 000000000052e083 00000000 00000800      1      0 000000',
  'tcp6       0      0  2400:d802:2b87:6.55505 2607:6bc0::10.443      ESTABLISHED        12870         7558  131072  132104          2.1.301:25900  00102 00000000 000000000053d50f 00000081 04000900      2      0 000000',
  'tcp4       0      0  192.0.2.77.55485     203.0.113.53.443      ESTABLISHED        10632         1841  131072  131600  Electron Helper:85629  00102 00000008 000000000053cf3d 00000080 04000900      2      0 000000',
  'tcp6       0      0  *.22                   *.*                    LISTEN                 0            0  131072  131072          launchd:1      00100 00000006 0000000000000a01 00000000 00000800      1      0 000000',
  'tcp6       0      0  2400:d802:2b87:6.58726 2403:300:a26:f00.443   TIME_WAIT           6059         2950  131072  131672     mobileassetd:75940  00000 00000000 0000000000000000 00000000 00000000      0      0 000000'
].join('\n') + '\n'
const netstatUdp = netstatHeader + [
  'udp6       0      0  *.5353                 *.*                                    47788154      2050960  786896    9216    mDNSResponder:137    00100 00050200 000000000000007a 10000000 00000800      1      0 000002',
  'udp4       0      0  *.137                  *.*                                        4836         1788  786896    9216         netbiosd:83895  00080 00000024 0000000000000029 00000003 04002800      1      0 000002',
  'udp4       0      0  *.137                  *.*                                        4836         1788  786896    9216         netbiosd:83895  00080 00000024 0000000000000029 00000003 04002800      1      0 000002',
  'udp46      0      0  *.5353                 *.*                                         596            0  786896    9216 Google Chrome He:2289   00100 00000204 000000000020feaa 00000000 00000800      1      0 000002',
  'udp4       0      0  *.*                    *.*                                           0            0  786896    9216         sharingd:1224   00100 00000204 00000000004e0626 00000000 00080800      1      0 000000'
].join('\n') + '\n'
test('Mac netstat parser sees system-service sockets, keeps spaced process names and truncated IPv6, and skips unbound sockets', () => {
  const tcp = parseMacosNetstatPorts(netstatTcp)
  assert.deepEqual(tcp.map(row => [row.localPort, row.state, row.pid, row.processName]), [
    [22, 'LISTEN', 1, 'launchd'], [19353, 'LISTEN', 85666, 'Electron'], [55485, 'ESTABLISHED', 85629, 'Electron Helper'], [55505, 'ESTABLISHED', 25900, '2.1.301'], [58726, 'TIME_WAIT', 75940, 'mobileassetd']
  ])
  const established = tcp.find(row => row.localPort === 55485)!
  assert.equal(established.localAddress, '192.0.2.77'); assert.equal(established.remoteAddress, '203.0.113.53'); assert.equal(established.remotePort, 443)
  assert.equal(tcp.find(row => row.localPort === 55505)!.localAddress, '2400:d802:2b87:6')
  assert.equal(tcp.find(row => row.localPort === 19353)!.remotePort, null)
  const udp = parseMacosNetstatPorts(netstatUdp)
  assert.deepEqual(udp.map(row => [row.protocol, row.localAddress, row.localPort, row.state, row.pid, row.processName]), [
    ['UDP', '*', 137, 'BOUND', 83895, 'netbiosd'], ['UDP', '*', 5353, 'BOUND', 137, 'mDNSResponder'], ['UDP', '*', 5353, 'BOUND', 2289, 'Google Chrome He']
  ])
  assert.deepEqual(udp[0]!.fieldAvailability, { processName: true, processPath: false, startTime: false })
})
test('Mac netstat parser locates columns from the header across macOS layouts and tolerates malformed rows', () => {
  // 旧版 macOS：(state) 后只有 rhiwat shiwat，进程列为纯数字 pid
  const legacy = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options\n' +
    'tcp4       0      0  *.8080                 *.*                    LISTEN      131072 131072    321      0 0x0100 0x00000006\n' +
    'udp4       0      0  *.5353                 *.*                                196724   9216    188      0 0x0100 0x00000000\n'
  assert.deepEqual(parseMacosNetstatPorts(legacy).map(row => [row.protocol, row.localPort, row.pid, row.processName, row.fieldAvailability.processName]), [['UDP', 5353, 188, '', false], ['TCP', 8080, 321, '', false]])
  const garbled = netstatTcp + 'tcp4 0 0 garbage\ntcp4       0      0  127.0.0.1.99999        *.*                    LISTEN  0 0 1 1 bad:1 00100\ntcp4       0      0  127.0.0.1.3000         *.*                    lis\u0007ten  0 0 1 1 x:1 00100\n\u0000\u0001 junk\n'
  assert.equal(parseMacosNetstatPorts(garbled).length, 5)
  assert.deepEqual(parseMacosNetstatPorts(''), [])
  assert.deepEqual(parseMacosNetstatPorts('Active Internet connections (including servers)\n'), [])
  for (const value of ['tcp4 0 0 127.0.0.1.80 *.* LISTEN 0 0 1 1 a:1 00100\n', 'Proto Recv-Q Send-Q Local Address Foreign Address rhiwat shiwat\ntcp4 0 0 *.80 *.* LISTEN 1 1\n', 'unexpected tool output\n']) assert.throws(() => parseMacosNetstatPorts(value), { code: 'PROCESS_ERROR' })
  assert.throws(() => parseMacosNetstatPorts('x'.repeat(4 * 1024 * 1024 + 1)), { code: 'PROCESS_ERROR' })
})
test('Mac runner queries fixed netstat TCP/UDP without shell or elevation and reports all-sockets visibility', async () => {
  const observed: Array<{ file: string; args: string[]; options: { signal: AbortSignal; shell: boolean; timeout: number } }> = []
  const adapter = createPlatformPortDiscoveryAdapter('darwin', async (file, args, options) => { observed.push({ file, args, options }); return { stdout: args.includes('udp') ? netstatUdp : netstatTcp } })
  const current = signal(), result = await adapter.list(current)
  assert.equal(result.source, 'darwin-netstat'); assert.equal(result.visibility, 'all-sockets'); assert.equal(result.data.length, 8)
  assert.ok(result.data.some(row => row.protocol === 'UDP' && row.localPort === 137 && row.processName === 'netbiosd'))
  assert.deepEqual(observed.map(call => [call.file, call.args]).sort(), [['/usr/sbin/netstat', ['-anv', '-p', 'tcp']], ['/usr/sbin/netstat', ['-anv', '-p', 'udp']]])
  for (const call of observed) { assert.equal(call.options.signal, current); assert.equal(call.options.shell, false); assert.equal(call.options.timeout, 10000) }
})
test('Mac netstat runner rejects crashes, diagnostics and timeouts instead of returning a partial list', async () => {
  for (const failure of [{ code: 1, stdout: netstatTcp, stderr: 'netstat: sysctl failed' }, { code: 'ENOENT' }, { killed: true, signal: 'SIGTERM', stdout: netstatTcp.slice(0, 300) }]) {
    await assert.rejects(createPlatformPortDiscoveryAdapter('darwin', async (_file, args) => { if (args.includes('udp')) throw failure; return { stdout: netstatTcp } }).list(signal()), { code: 'PROCESS_ERROR' })
  }
  await assert.rejects(createPlatformPortDiscoveryAdapter('darwin', async () => ({ stdout: netstatTcp, stderr: 'warning' })).list(signal()), { code: 'PROCESS_ERROR' })
  const late = new AbortController(); await assert.rejects(createPlatformPortDiscoveryAdapter('darwin', async () => { late.abort('cancel'); return { stdout: netstatTcp } }).list(late.signal))
})
test('Mac netstat parser handles the real local netstat output', { skip: process.platform !== 'darwin' }, async () => {
  const result = await createPlatformPortDiscoveryAdapter('darwin').list(signal())
  assert.equal(result.source, 'darwin-netstat')
  assert.ok(result.data.length > 0)
  assert.ok(result.data.every(row => row.localPort >= 1 && row.localPort <= 65535 && Number.isSafeInteger(row.pid)))
})
test('runner rejects diagnostic/partial failures and missing platforms, skips preabort and discards late output', async () => {
  assert.throws(() => createPlatformPortDiscoveryAdapter('linux'), { code: 'NOT_SUPPORTED' })
  for (const failure of [{ code: 1, stdout: netstatTcp, stderr: 'warning' }, { code: 'ENOENT' }, { code: 1, stdout: '', stderr: 'denied' }]) await assert.rejects(createPlatformPortDiscoveryAdapter('darwin', async () => { throw failure }).list(signal()), { code: 'PROCESS_ERROR' })
  let called = 0; const c = new AbortController(); c.abort('cancel'); await assert.rejects(createPlatformPortDiscoveryAdapter('win32', async () => { called++; return { stdout: '' } }).list(c.signal)); assert.equal(called, 0)
  const late = new AbortController(); await assert.rejects(createPlatformPortDiscoveryAdapter('win32', async () => { late.abort('cancel'); return { stdout: '' } }).list(late.signal))
})
test('Main ports are bounded, stop aborts only owned reads and rejects their late snapshots', async () => {
  const registry = { onRemoved: () => () => {} } as unknown as WindowRegistry
  const pending: { resolve: (value: any) => void; signal: AbortSignal }[] = []
  const service = new ProcessService(registry, {} as FileSystemService, Date.now, 'darwin', undefined, { list: signal => new Promise(resolve => pending.push({ resolve, signal })) })
  const calls = Array.from({ length: 4 }, () => service.listPorts(signal())); await assert.rejects(service.listPorts(signal()), { code: 'PLUGIN_BUSY' }); service.stop(); assert.ok(pending.every(item => item.signal.aborted)); for (const item of pending) item.resolve({ data: [], source: 'darwin-lsof', visibility: 'visible-processes', queriedAt: new Date().toISOString() }); const results = await Promise.allSettled(calls); assert.ok(results.every(result => result.status === 'rejected')); await assert.rejects(service.listPorts(signal()), { code: 'APP_STOPPING' })
})
