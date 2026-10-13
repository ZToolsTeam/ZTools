import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlatformPortDiscoveryAdapter, parseMacosPorts, parseWindowsPorts } from '../../src/main/platform/port-discovery.js'
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
test('Mac runner uses fixed executable/fields without DNS, services, shell or elevation and treats clean exit1 as empty', async () => {
  let observed: unknown; const adapter = createPlatformPortDiscoveryAdapter('darwin', async (file, args, options) => { observed = { file, args, options }; return { stdout: lsof } }); const current = signal(), result = await adapter.list(current)
  assert.equal(result.source, 'darwin-lsof'); assert.equal(result.visibility, 'visible-processes'); assert.equal(result.data.length, 3); const invocation = observed as { file: string; args: string[]; options: { signal: AbortSignal; shell: boolean; timeout: number } }; assert.equal(invocation.file, '/usr/sbin/lsof'); assert.deepEqual(invocation.args, ['-nP', '-iTCP', '-iUDP', '-F0pcfnPtT', '-Ts']); assert.equal(invocation.options.signal, current); assert.equal(invocation.options.shell, false); assert.equal(invocation.options.timeout, 10000)
  const empty = createPlatformPortDiscoveryAdapter('darwin', async () => { throw { code: 1, stdout: '', stderr: '' } }); assert.deepEqual((await empty.list(signal())).data, [])
})
test('runner rejects diagnostic/partial failures and missing platforms, skips preabort and discards late output', async () => {
  assert.throws(() => createPlatformPortDiscoveryAdapter('linux'), { code: 'NOT_SUPPORTED' })
  for (const failure of [{ code: 1, stdout: lsof, stderr: 'warning' }, { code: 'ENOENT' }, { code: 1, stdout: '', stderr: 'denied' }]) await assert.rejects(createPlatformPortDiscoveryAdapter('darwin', async () => { throw failure }).list(signal()), { code: 'PROCESS_ERROR' })
  let called = 0; const c = new AbortController(); c.abort('cancel'); await assert.rejects(createPlatformPortDiscoveryAdapter('win32', async () => { called++; return { stdout: '' } }).list(c.signal)); assert.equal(called, 0)
  const late = new AbortController(); await assert.rejects(createPlatformPortDiscoveryAdapter('win32', async () => { late.abort('cancel'); return { stdout: '' } }).list(late.signal))
})
test('Main ports are bounded, stop aborts only owned reads and rejects their late snapshots', async () => {
  const registry = { onRemoved: () => () => {} } as unknown as WindowRegistry
  const pending: { resolve: (value: any) => void; signal: AbortSignal }[] = []
  const service = new ProcessService(registry, {} as FileSystemService, Date.now, 'darwin', undefined, { list: signal => new Promise(resolve => pending.push({ resolve, signal })) })
  const calls = Array.from({ length: 4 }, () => service.listPorts(signal())); await assert.rejects(service.listPorts(signal()), { code: 'PLUGIN_BUSY' }); service.stop(); assert.ok(pending.every(item => item.signal.aborted)); for (const item of pending) item.resolve({ data: [], source: 'darwin-lsof', visibility: 'visible-processes', queriedAt: new Date().toISOString() }); const results = await Promise.allSettled(calls); assert.ok(results.every(result => result.status === 'rejected')); await assert.rejects(service.listPorts(signal()), { code: 'APP_STOPPING' })
})
