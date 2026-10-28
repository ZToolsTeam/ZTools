import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NetworkHostPluginHandler, type NetworkHostDeps } from '../../src/main/services/host-plugins/network-host.js'
import { PowerShellError, type HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

type Result = { ok?: boolean; success: boolean; errorCode?: string; error?: string; [key: string]: unknown }
const handler = () => new NetworkHostPluginHandler({} as HostPluginContext)
/** 旧处理器只在 Windows 走真实分支；在任意开发机上把 process.platform 临时视作 win32，确认真实分支不再触碰系统。 */
async function asWindows<T>(work: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
  try { return await work() } finally { Object.defineProperty(process, 'platform', original) }
}
const outdated = (result: Result, plugin: RegExp) => {
  assert.equal(result.success, false); assert.equal(result.ok, false); assert.equal(result.errorCode, 'UNSUPPORTED_ACTION'); assert.match(result.error!, plugin)
}

test('Wi-Fi 旧接口：真实列表与密码读取一律要求更新插件，不再批量返回明文或编造信号、频段', async () => {
  await asWindows(async () => {
    const h = handler()
    for (const fn of ['listSavedNetworks', 'listProfiles', 'getProfiles', 'list']) {
      for (const params of [{}, { skipSystemScan: true }]) outdated(await h.handleWifiPassword(fn, params) as Result, /请更新 Wi-Fi 密码查看插件/)
    }
    for (const fn of ['getPassword', 'revealPassword']) outdated(await h.handleWifiPassword(fn, { ssid: 'home' }) as Result, /请更新 Wi-Fi 密码查看插件/)
    const invalid = await h.handleWifiPassword('getPassword', { ssid: 'a\nb' }) as Result
    assert.equal(invalid.errorCode, 'INVALID_SSID')
    // 插件传入的模拟参数不能再让宿主返回编造的网络或密码
    outdated(await h.handleWifiPassword('list', { simulateNoAdapter: true }) as Result, /请更新 Wi-Fi 密码查看插件/)
    outdated(await h.handleWifiPassword('list', { mockProfiles: [{ ssid: 'mock', password: 'p' }] }) as Result, /请更新 Wi-Fi 密码查看插件/)
    outdated(await h.handleWifiPassword('getPassword', { ssid: 'mock', mockPassword: 'p' }) as Result, /请更新 Wi-Fi 密码查看插件/)
    assert.equal((await h.handleWifiPassword('other', {}) as Result).errorCode, 'UNSUPPORTED_ACTION')
  })
})

test('局域网扫描旧接口：网卡枚举、arp 扫描与真实唤醒要求更新插件；断网模拟参数无效，dryRun 保留', async () => {
  await asWindows(async () => {
    const h = handler()
    for (const fn of ['interfaces', 'detectActiveInterfaces', 'scan', 'scanSubnet']) outdated(await h.handleLanScanner(fn, {}) as Result, /请更新局域网扫描插件，通过新版接口扫描与唤醒/)
    outdated(await h.handleLanScanner('sendWakeOnLan', { mac: '00:11:22:33:44:55', broadcastIp: '192.168.1.255' }) as Result, /请更新局域网扫描插件/)
    assert.equal((await h.handleLanScanner('wol', { mac: 'zz' }) as Result).errorCode, 'INVALID_MAC_ADDRESS')
    const dry = await h.handleLanScanner('wol', { mac: '00-11-22-33-44-55', dryRun: true }) as Result
    assert.equal(dry.success, true); assert.equal(dry.byteLength, 102)
    for (const fn of ['interfaces', 'scan']) outdated(await h.handleLanScanner(fn, { simulateOffline: true }) as Result, /请更新局域网扫描插件/)
  })
})

test('主机与代理旧接口：读配置、查状态、设置与清除代理都要求更新插件，不再假装已启用或吞掉 Git 失败', async () => {
  await asWindows(async () => {
    const h = handler()
    for (const fn of ['readConfig', 'parseSshConfigFile']) outdated(await h.handleSshProxyHelper(fn, { customConfigPath: '/etc/passwd' }) as Result, /请更新主机与代理插件/)
    for (const fn of ['proxyStatus', 'getProxyStatus', 'setProxy', 'setDevToolsProxy', 'unsetProxy', 'unsetDevToolsProxy']) {
      // 带 mockListeningPorts 的旧模拟分支已删除：不能再假装代理已开启或端口在监听
      for (const params of [{}, { port: 7890 }, { skipPortProbe: true, skipSystemQuery: true }, { mockListeningPorts: [7890], applySystemGit: true, port: 7890 }, { mockListeningPorts: [7890, 0] }, { mockListeningPorts: [7890], port: 7890, requireListening: true }]) {
        outdated(await h.handleSshProxyHelper(fn, params) as Result, /请更新主机与代理插件/)
      }
    }
    assert.equal((await h.handleSshProxyHelper('other', {}) as Result).success, false)
  })
})

// ==================== 注入替身：模拟参数删除后，真实分支用构造参数注入的命令执行器测试 ====================
type CommandResult = { stdout: string; stderr: string; exitCode: number }
const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (exitCode: number, stderr = ''): CommandResult => ({ stdout: '', stderr, exitCode })
/** 按命令名返回预设结果并记录调用；未预设的命令视为测试缺漏，直接失败 */
function fakeSystem(commands: Record<string, CommandResult | CommandResult[]>, powershell?: () => Promise<string>) {
  const calls: string[] = []
  const scripts: string[] = []
  const deps: Partial<NetworkHostDeps> = {
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '))
      const preset = commands[command]
      if (!preset) throw new Error(`未预设命令: ${command}`)
      return Array.isArray(preset) ? (preset.shift() ?? fail(1, '预设结果已用完')) : preset
    },
    runPowerShell: async (script) => { calls.push('powershell'); scripts.push(script); if (!powershell) throw new Error('未预设 PowerShell'); return powershell() }
  }
  return { calls, scripts, deps }
}
const DNS_JSON = JSON.stringify({ adapters: [{ name: '以太网', description: 'Intel(R) Ethernet', ipv4: '10.0.0.8', isDhcp: false, currentDns: ['223.5.5.5', 'not-an-ip'] }] })

test('DNS 旧接口：网卡列表来自注入的 PowerShell 结果，模拟网卡参数无效；读取失败如实报错', async () => {
  await asWindows(async () => {
    const sys = fakeSystem({}, async () => DNS_JSON)
    const result = await new NetworkHostPluginHandler({} as HostPluginContext, sys.deps).handleDnsBenchmark('getAdapters', { mockAdapters: [{ name: 'fake' }] }) as Result & { adapters: Array<Record<string, unknown>> }
    assert.equal(result.success, true)
    assert.deepEqual(result.adapters, [{ name: '以太网', description: 'Intel(R) Ethernet', ipv4: '10.0.0.8', isDhcp: false, currentDns: ['223.5.5.5'] }])
    for (const broken of [async () => { throw new PowerShellError(124, '') }, async () => '{not json', async () => JSON.stringify({ adapters: 'x' })]) {
      const failed = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({}, broken).deps).handleDnsBenchmark('getAdapters', {}) as Result
      assert.equal(failed.success, false); assert.equal(failed.errorCode, 'ADAPTER_READ_FAILED')
    }
    const empty = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({}, async () => JSON.stringify({ adapters: [] })).deps).handleDnsBenchmark('getAdapters', {}) as Result
    assert.equal(empty.success, true); assert.match(String(empty.message), /未找到/)
  })
})

test('DNS 旧接口：修改 DNS 的结果只取决于 netsh 退出码（中英文拒绝访问、超时），模拟权限参数无效', async () => {
  await asWindows(async () => {
    const params = { adapterName: '以太网', primary: '223.5.5.5', secondary: '119.29.29.29', executeSystemModify: true, simulatePermissionDenied: true }
    for (const [res, code] of [[fail(1, '请求的操作需要提升。'), 'ADMIN_PRIVILEGE_REQUIRED'], [fail(1, 'Access is denied.'), 'ADMIN_PRIVILEGE_REQUIRED'], [fail(124, '命令执行超时'), 'TIMEOUT'], [fail(1, ''), 'NETSH_FAILED']] as const) {
      const result = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({ netsh: res }).deps).handleDnsBenchmark('applyDns', params) as Result
      assert.equal(result.success, false); assert.equal(result.errorCode, code)
    }
    // 主 DNS 成功、备用 DNS 失败：报告部分完成，不能当成功
    const partial = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({ netsh: [ok(), fail(1, 'x')] }).deps).handleDnsBenchmark('applyDns', params) as Result
    assert.equal(partial.errorCode, 'SECONDARY_DNS_FAILED'); assert.match(partial.error!, /主 DNS 已改为 223\.5\.5\.5/)
    // 成功后以系统读回的 DNS 为准，刷新缓存失败单独报告
    const sys = fakeSystem({ netsh: [ok(), ok()], ipconfig: fail(1, 'x') }, async () => DNS_JSON)
    const done = await new NetworkHostPluginHandler({} as HostPluginContext, sys.deps).handleDnsBenchmark('applyDns', params) as Result
    assert.equal(done.success, true); assert.deepEqual(done.currentDns, ['223.5.5.5']); assert.equal(done.flushed, false); assert.match(String(done.flushError), /刷新 DNS 缓存失败/)
    assert.deepEqual(sys.calls, ['netsh interface ip set dns name=以太网 static 223.5.5.5 validate=no', 'netsh interface ip add dns name=以太网 119.29.29.29 index=2 validate=no', 'ipconfig /flushdns', 'powershell'])
    const reset = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({ netsh: fail(1, '拒绝访问。') }).deps).handleDnsBenchmark('resetDhcp', { adapterName: '以太网', executeSystemModify: true, simulatePermissionDenied: true }) as Result
    assert.equal(reset.errorCode, 'ADMIN_PRIVILEGE_REQUIRED')
    // 未显式开启执行时不调用任何命令
    const idle = fakeSystem({})
    assert.equal((await new NetworkHostPluginHandler({} as HostPluginContext, idle.deps).handleDnsBenchmark('applyDns', { ...params, executeSystemModify: false }) as Result).errorCode, 'NOT_EXECUTED')
    assert.deepEqual(idle.calls, [])
  })
})

test('DNS 测速：延迟来自注入的 TCP 探测，模拟断网、模拟结果与模拟延迟参数全部无效', async () => {
  const probed: string[] = []
  const probeTcp: NetworkHostDeps['probeTcp'] = async (host, port) => { probed.push(`${host}:${port}`); return host === '223.5.5.5' ? { ok: true, latencyMs: 20 } : host === '119.29.29.29' ? { ok: true, latencyMs: 40 } : { ok: false, latencyMs: 999 } }
  const h = new NetworkHostPluginHandler({} as HostPluginContext, { probeTcp })
  const bench = await h.handleDnsBenchmark('benchmarkDns', { simulateOffline: true, mockResults: [{ id: 'fake', avgMs: 1 }], timeoutMs: 800, servers: [{ id: 'ali', primary: '223.5.5.5', secondary: '119.29.29.29' }, { id: 'down', primary: '10.255.255.1' }, { id: 'bad', primary: '1.2.3' }] }) as Result & { results: Array<Record<string, unknown>> }
  assert.equal(bench.offline, undefined)
  assert.deepEqual(bench.results.map(r => [r.id, r.avgMs, r.timeout]), [['ali', 30, false], ['down', 800, true], ['bad', 800, true]])
  assert.equal(bench.results[2]!.errorCode, 'INVALID_DNS_IP')
  assert.ok(!probed.includes('1.2.3:53'), '非法 DNS 地址不能去探测')
})

test('网络测速旧接口：带宽、网关与节点探测一律要求更新插件，不再推算带宽、猜网关或把超时当延迟', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    try {
      const probed: string[] = []
      const fetched: string[] = []
      const realFetch = globalThis.fetch
      // 故障注入：探测与网络请求都“成功”，旧实现会据此报出带宽；现在必须一个都不调用
      globalThis.fetch = (async (input: string | URL | Request) => { fetched.push(String(input)); return new Response(new Uint8Array(1_500_000)) }) as typeof fetch
      try {
        const h = new NetworkHostPluginHandler({} as HostPluginContext, { probeTcp: async (host, port) => { probed.push(`${host}:${port}`); return { ok: true, latencyMs: 20 } } })
        for (const fn of ['runBandwidthTest', 'speedtest', 'measureBandwidth', 'probeNodes', 'pingNodes', 'probe']) {
          for (const params of [{}, { mockBandwidth: { downloadMbps: 900 } }, { nodes: [{ id: 'a', host: '223.5.5.5', port: 53 }] }]) {
            const result = await h.handleSpeedtest(fn, params) as Result
            outdated(result, /请更新网络测速插件/)
            for (const field of ['downloadMbps', 'uploadMbps', 'jitterMs', 'localIp', 'gatewayIp', 'probes']) assert.equal(result[field], undefined, `${fn} 不能返回 ${field}`)
          }
        }
        // 已中止的请求同样不执行任何探测
        const aborted = new AbortController(); aborted.abort()
        outdated(await h.handleSpeedtest('runBandwidthTest', {}, aborted.signal) as Result, /请更新网络测速插件/)
        assert.deepEqual(probed, []); assert.deepEqual(fetched, [])
        const unknown = await h.handleSpeedtest('other', {}) as Result
        assert.equal(unknown.errorCode, 'UNSUPPORTED_ACTION'); assert.match(unknown.error!, /Unsupported SpeedtestPlugin function: other/)
      } finally { globalThis.fetch = realFetch }
    } finally { Object.defineProperty(process, 'platform', original) }
  }
})

test('Hosts 旧接口：Windows 上写入一律拒绝（UNSUPPORTED_ACTION），系统 hosts 不改动、不备份、不刷新 DNS；读取保留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-legacy-hosts-'))
  try {
    const hostsPath = path.join(dir, 'hosts')
    const original = '127.0.0.1 localhost\n# 用户自己的规则\n10.1.1.1 keep.local\n'
    await fs.writeFile(hostsPath, original)
    await asWindows(async () => {
      const sys = fakeSystem({ ipconfig: ok('已成功刷新 DNS 解析缓存。') })
      const h = new NetworkHostPluginHandler({} as HostPluginContext, { ...sys.deps, hostsPath })
      // 已安装的旧版 1.0.2 会带完整内容整体覆盖；模拟参数、跳过刷新、指定其他路径都不能绕过拒绝
      for (const fn of ['apply', 'applyCombinedHosts', ' APPLY ']) {
        for (const params of [{ content: '10.0.0.1 a.local\n' }, { content: '', skipFlushDns: true }, { content: 'x', simulateAccessDenied: true }, { content: 'x', customHostsPath: path.join(dir, 'other-hosts') }]) {
          const result = await h.handleHostsSwitcher(fn, params) as Result
          assert.equal(result.success, false); assert.equal(result.ok, false); assert.equal(result.errorCode, 'UNSUPPORTED_ACTION')
          assert.equal(result.error, 'Windows 版域名映射正在重做，暂不支持写入系统 hosts')
        }
      }
      assert.equal(await fs.readFile(hostsPath, 'utf8'), original, '系统 hosts 不能被改动')
      assert.deepEqual((await fs.readdir(dir)).sort(), ['hosts'], '不能产生备份文件或写到调用方指定的路径')
      assert.deepEqual(sys.calls, [], '拒绝写入时不刷新 DNS')
      // 读取保留：只读注入的系统 hosts 路径
      const read = await h.handleHostsSwitcher('readSystemHosts', { customHostsPath: '/etc/passwd' }) as Result
      assert.equal(read.success, true); assert.equal(read.content, original); assert.equal(read.hostsPath, hostsPath)
      // 故障注入：系统 hosts 读不到时如实报 READ_FAILED
      const missing = await new NetworkHostPluginHandler({} as HostPluginContext, { ...fakeSystem({}).deps, hostsPath: path.join(dir, 'missing') }).handleHostsSwitcher('read', {}) as Result
      assert.equal(missing.success, false); assert.equal(missing.errorCode, 'READ_FAILED')
    })
    // 其他非 macOS 平台同样不再写入（macOS 在入口处已要求更新插件）
    const original0 = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original0, value: 'linux' })
    try {
      const linux = await new NetworkHostPluginHandler({} as HostPluginContext, { ...fakeSystem({}).deps, hostsPath }).handleHostsSwitcher('apply', { content: 'x' }) as Result
      assert.equal(linux.errorCode, 'UNSUPPORTED_ACTION')
    } finally { Object.defineProperty(process, 'platform', original0) }
    assert.equal(await fs.readFile(hostsPath, 'utf8'), original)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('Hosts 旧接口：刷新 DNS 的超时、失败如实报错，预览不执行命令；非 Windows 不刷新', async () => {
  await asWindows(async () => {
    const sys = fakeSystem({ ipconfig: [fail(124, '命令执行超时'), fail(1, ''), ok('Windows IP 配置 已成功刷新 DNS 解析缓存。')] })
    const h = new NetworkHostPluginHandler({} as HostPluginContext, sys.deps)
    const timeout = await h.handleHostsSwitcher('flushDns', { simulateTimeout: false }) as Result
    assert.equal(timeout.success, false); assert.equal(timeout.errorCode, 'TIMEOUT')
    const failed = await h.handleHostsSwitcher('flushDns', {}) as Result
    assert.equal(failed.success, false); assert.match(failed.error!, /退出码 1/)
    assert.equal((await h.handleHostsSwitcher('flushDns', {}) as Result).success, true)
    const preview = await h.handleHostsSwitcher('flushDns', { dryRun: true }) as Result
    assert.equal(preview.dryRun, true); assert.equal(sys.calls.length, 3, '预览不执行命令')
  })
  if (process.platform !== 'win32') {
    const notWindows = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({}).deps).handleHostsSwitcher('flushDns', {}) as Result
    assert.equal(notWindows.success, false)
  }
})

test('网卡旧接口：结果存变量后单独输出，禁用网卡的非终止错误不让整次读取失败；PowerShell 失败如实报错', async () => {
  await asWindows(async () => {
    let script = ''
    const adapters = JSON.stringify([{ id: '以太网', name: '以太网', status: 'Up', linkSpeed: '1 Gbps', ipv4: '10.0.0.8', dnsServers: ['223.5.5.5'] }, { id: 'WLAN', name: 'WLAN', status: 'Disabled', linkSpeed: '0 bps', ipv4: '', dnsServers: [] }, { id: '蓝牙', name: '蓝牙', status: 'Up', linkSpeed: '3 Kbps', ipv4: '', dnsServers: [] }])
    const deps: Partial<NetworkHostDeps> = { runPowerShell: async (s) => { script = s; return adapters } }
    const result = await new NetworkHostPluginHandler({} as HostPluginContext, deps).handleNetworkAdapter('getAdapters', {}) as Result & { adapters: Array<Record<string, unknown>> }
    assert.match(script, /ConvertTo-Json -InputObject \$list -Compress -Depth 4\s*$/, '最后一条语句必须是单独的 ConvertTo-Json')
    assert.equal(result.success, true)
    // 已禁用网卡的 “0 bps” 记为 0，不足 1 Mbps 的正速率记为 1
    assert.deepEqual(result.adapters.map(a => [a.name, a.speedMbps, a.dns]), [['以太网', 1000, '223.5.5.5'], ['WLAN', 0, ''], ['蓝牙', 1, '']])
    // 故障注入：超时等真正的失败不能被当成“没有网卡”
    const broken: Partial<NetworkHostDeps> = { runPowerShell: async () => { throw new PowerShellError(124, '') } }
    const failed = await new NetworkHostPluginHandler({} as HostPluginContext, broken).handleNetworkAdapter('getAdapters', {}) as Result
    assert.equal(failed.success, false); assert.equal(failed.errorCode, 'ADAPTER_LIST_FAILED')
  })
})

test('Docker 旧接口：容器列表与日志只来自 docker 命令输出，调用方传入的容器与日志不再被原样返回', async () => {
  const offline = new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({ docker: fail(1, 'Cannot connect to the Docker daemon') }).deps)
  const list = await offline.handleDockerManager('listContainers', { rawContainers: [{ Id: 'fake' }], simulateDaemonOffline: false }) as Result
  assert.equal(list.success, false); assert.equal(list.errorCode, 'DAEMON_OFFLINE')
  const sys = fakeSystem({ docker: [ok('{"ID":"a1","Names":"web"}\nnot json\n{"ID":"b2","Names":"db"}'), ok('\u001b[32mready\u001b[0m')] })
  const h = new NetworkHostPluginHandler({} as HostPluginContext, sys.deps)
  const containers = await h.handleDockerManager('listContainers', { rawContainers: [{ Id: 'fake' }] }) as Result & { containers: Array<Record<string, unknown>> }
  assert.deepEqual(containers.containers.map(c => c.ID), ['a1', 'b2'])
  const logs = await h.handleDockerManager('getContainerTailLogs', { id: 'a1', lines: 20, rawLogs: 'forged' }) as Result
  assert.equal(logs.logs, 'ready')
  assert.deepEqual(sys.calls, ['docker ps -a --format {{json .}}', 'docker logs --tail 20 a1'])
  assert.equal((await h.handleDockerManager('getContainerTailLogs', { id: 'a;b', rawLogs: 'forged' }) as Result).errorCode, 'INVALID_CONTAINER_ID')
})

test('网卡列表（Windows）：以 Get-NetAdapter 结果为准；读取失败或输出畸形如实报错，不退回 os.networkInterfaces 填充状态与 MAC', async () => {
  await asWindows(async () => {
    const one = JSON.stringify([{ id: '以太网', name: '以太网', status: 'Up', mac: 'AA-BB-CC-DD-EE-FF', linkSpeed: '1 Gbps', ipv4: '10.0.0.8', dnsServers: ['223.5.5.5'] }])
    const sys = fakeSystem({}, async () => one)
    const ok = await new NetworkHostPluginHandler({} as HostPluginContext, sys.deps).handleNetworkAdapter('getAdapters', {}) as Result & { adapters: Array<Record<string, unknown>> }
    assert.equal(ok.success, true); assert.equal(ok.adapters.length, 1); assert.equal(ok.adapters[0]!.name, '以太网'); assert.equal(ok.adapters[0]!.speedMbps, 1000)
    // 脚本：Get-NetAdapter 失败为终止错误；结果存变量后单独输出（不以带非终止错误的管道结尾）
    const script = sys.scripts[0]!
    assert.match(script, /Get-NetAdapter -ErrorAction Stop/); assert.match(script, /ConvertTo-Json -InputObject \$list/); assert.doesNotMatch(script, /exit 0/)
    for (const broken of [async () => { throw new PowerShellError(1, 'Get-NetAdapter : 无效的类') }, async () => '{not json']) {
      const failed = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({}, broken).deps).handleNetworkAdapter('getAdapters', {}) as Result & { adapters?: unknown[] }
      assert.equal(failed.success, false); assert.equal(failed.errorCode, 'ADAPTER_LIST_FAILED'); assert.equal(failed.adapters, undefined)
    }
    // 确实没有网卡：空列表，不用 os.networkInterfaces() 编造
    const empty = await new NetworkHostPluginHandler({} as HostPluginContext, fakeSystem({}, async () => '[]').deps).handleNetworkAdapter('getAdapters', {}) as Result & { adapters: unknown[] }
    assert.equal(empty.success, true); assert.deepEqual(empty.adapters, [])
  })
})
