import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readWifiProfiles, readWifiPassword, parseWlanProfileXml, parseWlanInterfaceSsids, windowsWifiSecurity, type WifiCommandRunner, type WindowsWifiDeps } from '../../src/main/services/wifi-service.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'

const ports = 'Hardware Port: Wi-Fi\nDevice: en7\nEthernet Address: test\n\n'

test('macOS 列表链路不读取密码，保留 SSID 空白，不伪造安全类型', async () => {
  const calls: string[][] = []
  const run: WifiCommandRunner = async (_command, args) => {
    calls.push(args)
    if (args[0] === '-listallhardwareports') return ports
    if (args[0] === '-getairportnetwork') return 'Current Wi-Fi Network:  wifi  \n'
    return 'Preferred networks on en7:\n\t wifi  \n\t中文\n'
  }
  const request = parseRequest({ messageId: 'wifi:list', method: 'wifi_get_profiles', params: {} })
  validateMethodParams('wifi_get_profiles', request.params)
  assert.equal(request.timeoutMs, 15_000)
  assert.deepEqual(await readWifiProfiles('darwin', run), [{ ssid: ' wifi  ', current: true }, { ssid: '中文', current: false }])
  assert.equal(calls.length, 3)
  assert.ok(calls.every(args => !args.includes('-w') && !args.includes('-g')))
})

test('当前连接查询失败保留已保存列表但不假称未连接', async () => {
  const result = await readWifiProfiles('darwin', async (_command, args) => {
    if (args[0] === '-listallhardwareports') return ports
    if (args[0] === '-getairportnetwork') throw new Error('权限不足')
    return 'Preferred networks on en7:\n\tsaved\n'
  })
  assert.deepEqual(result, [{ ssid: 'saved' }])
})

test('接口查询、列表查询失败或格式错误均不返回空列表', async () => {
  for (const failAt of ['-listallhardwareports', '-listpreferredwirelessnetworks']) {
    await assert.rejects(readWifiProfiles('darwin', async (_command, args) => {
      if (args[0] === failAt) throw new Error('失败')
      if (args[0] === '-listallhardwareports') return ports
      return ''
    }))
  }
  await assert.rejects(readWifiProfiles('darwin', async () => '没有接口'))
  await assert.rejects(readWifiProfiles('darwin', async (_command, args) => args[0] === '-listallhardwareports' ? ports : '错误输出'))
  assert.deepEqual(await readWifiProfiles('darwin', async (_command, args) => args[0] === '-listallhardwareports' ? ports : args[0] === '-getairportnetwork' ? '' : 'Preferred networks on en7:\n'), [])
})

test('macOS 密码请求保留完整 SSID 和密码内容，授权期限先于 IPC', async () => {
  const request = parseRequest({ messageId: 'wifi:password', method: 'wifi_get_password', params: { ssid: ' wifi ' } })
  validateMethodParams('wifi_get_password', request.params)
  const result = await readWifiPassword(' wifi ', 'darwin', async (command, args, timeout) => {
    assert.equal(command, '/usr/bin/security')
    assert.deepEqual(args.slice(-3), ['-a', ' wifi ', '-g'])
    assert.equal(timeout, 30_000)
    assert.ok(typeof request.timeoutMs === 'number' && request.timeoutMs > timeout)
    return 'password: " password "\n'
  })
  assert.deepEqual(result, { ssid: ' wifi ', password: ' password ' })
  assert.equal((await readWifiPassword('net', 'darwin', async () => 'password: 0x776974682D6E65776C696E650A  "with-newline\\012"\n')).password, 'with-newline\n')
  assert.equal(parseRequest({ ...request, timeoutMs: 500 }).timeoutMs, 500)
})

test('macOS 明确区分十六进制回执和恰好由十六进制字符组成的密码', async () => {
  const cases = [
    ['password: "61626364"\n', '61626364'],
    ['password: "a"quoted"password"\n', 'a"quoted"password'],
    ['password: 0xE4B8ADE69687 \n', '中文'],
    ['password: 0x205C74657374200D  " \\134test \\015"\n', ' \\test \r'],
    ['password: 0xEFBBBF616263  "\\357\\273\\277abc"\n', '\uFEFFabc']
  ]
  for (const [output, expected] of cases) {
    const request = parseRequest({ messageId: 'wifi:encoding', method: 'wifi_get_password', params: { ssid: '测试网络' } })
    validateMethodParams('wifi_get_password', request.params)
    assert.equal((await readWifiPassword('测试网络', 'darwin', async () => output!)).password, expected)
  }
})

test('macOS 密钥回执为空、截断、重复、无效编码时拒绝，错误不泄露内容', async () => {
  for (const output of ['password: \n', 'password: ""\n', 'password: "sensitive-data',
    'password: 0x123 \n', 'password: 0xFF \n', 'password: 0xZZ \n',
    'password: "sensitive-data"\npassword: "second"\n', 'warning\npassword: "sensitive-data"\n']) {
    await assert.rejects(readWifiPassword('net', 'darwin', async () => output), error =>
      error instanceof Error && !error.message.includes('sensitive-data') && !error.message.includes('0x'))
  }
})

test('取消、超时、缺密码和非法输入不会成功，也不回显系统错误中的机密', async () => {
  for (const message of ['denied sensitive-data', 'timeout sensitive-data']) {
    await assert.rejects(readWifiPassword('net', 'darwin', async () => { throw new Error(message) }), error => error instanceof Error && !error.message.includes('sensitive-data'))
  }
  await assert.rejects(readWifiPassword('net', 'darwin', async () => '\n'))
  for (const ssid of ['', '\0']) await assert.rejects(readWifiPassword(ssid, 'darwin', async () => 'bad'))
  await assert.rejects(readWifiProfiles('linux'))
  await assert.rejects(readWifiPassword('net', 'linux'))
})

const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function profileXml(name: string, options: { ssid?: string; auth?: string; encryption?: string; oneX?: boolean; key?: string; protectedKey?: boolean } = {}) {
  const ssid = options.ssid ?? name
  const shared = options.key === undefined ? '' : `<sharedKey><keyType>passPhrase</keyType><protected>${options.protectedKey ? 'true' : 'false'}</protected><keyMaterial>${xmlEscape(options.key)}</keyMaterial></sharedKey>`
  return `<?xml version="1.0"?>\r\n<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">\r\n\t<name>${xmlEscape(name)}</name>\r\n\t<SSIDConfig><SSID><hex>${Buffer.from(ssid).toString('hex').toUpperCase()}</hex><name>${xmlEscape(ssid)}</name></SSID></SSIDConfig>\r\n\t<connectionType>ESS</connectionType>\r\n\t<MSM><security><authEncryption><authentication>${options.auth ?? 'WPA2PSK'}</authentication><encryption>${options.encryption ?? 'AES'}</encryption><useOneX>${options.oneX ? 'true' : 'false'}</useOneX></authEncryption>${shared}</security></MSM>\r\n</WLANProfile>\r\n`
}
const interfacesZh = '\r\n系统上有 1 个接口:\r\n\r\n    名称                   : WLAN\r\n    描述                   : Intel(R) Wi-Fi 6 AX201 160MHz\r\n    GUID                   : 3f1a2b4c-1111-2222-3333-444455556666\r\n    物理地址               : a4:b1:c1:d1:e1:f1\r\n    状态                   : 已连接\r\n    SSID                   : 家里 5G\r\n    BSSID                  : 11:22:33:44:55:66\r\n    网络类型               : 结构\r\n    信号                   : 87%\r\n'
interface Exported { files?: Record<string, string | Buffer>; exitCode?: number; stdout?: string }
async function windowsFixture(t: import('node:test').TestContext, exportResult: (args: string[]) => Exported, interfaces: { stdout: string; exitCode: number } = { stdout: interfacesZh, exitCode: 0 }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-wifi-test-'))
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const calls: string[][] = []
  const deps: WindowsWifiDeps = {
    tempRoot,
    run: async (command, args) => {
      calls.push(args); assert.match(command, /netsh\.exe$/)
      if (args[1] === 'show') return { ...interfaces, stderr: '' }
      const folder = args.find(arg => arg.startsWith('folder='))!.slice(7)
      assert.ok(folder.startsWith(tempRoot))
      const result = exportResult(args)
      for (const [name, content] of Object.entries(result.files ?? {})) await fs.writeFile(path.join(folder, name), content)
      return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 }
    }
  }
  const leftovers = async () => fs.readdir(tempRoot)
  return { deps, calls, leftovers }
}

test('WLANProfile XML 解析不依赖系统语言：保留名称空白、十六进制 SSID、实体与密钥状态', () => {
  const parsed = parseWlanProfileXml(Buffer.from(profileXml(' 家里 & 5G ', { ssid: '家里 5G', key: ' a<b>&c ' })))
  assert.deepEqual(parsed, { name: ' 家里 & 5G ', ssid: '家里 5G', authentication: 'WPA2PSK', encryption: 'AES', useOneX: false, keyProtected: false, keyMaterial: ' a<b>&c ' })
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(profileXml('net'), 'utf16le')])
  assert.equal(parseWlanProfileXml(utf16).name, 'net')
  assert.equal(windowsWifiSecurity(parsed), 'WPA2-Personal')
  const cases: Array<[Parameters<typeof profileXml>[1], string | undefined]> = [
    [{ auth: 'open', encryption: 'none' }, 'Open'], [{ auth: 'open', encryption: 'WEP' }, 'WEP'], [{ auth: 'WPA3SAE' }, 'WPA3-Personal'],
    [{ auth: 'WPAPSK', encryption: 'TKIP' }, 'WPA-Personal'], [{ auth: 'WPA2', oneX: true }, 'WPA2-Enterprise'], [{ auth: 'WPA3ENT192', encryption: 'GCMP256', oneX: true }, 'WPA3-Enterprise'],
    [{ auth: 'open', encryption: 'none', oneX: true }, undefined], [{ auth: 'FutureAuth' }, undefined]
  ]
  for (const [options, expected] of cases) assert.equal(windowsWifiSecurity(parseWlanProfileXml(profileXml('n', options))), expected)
  for (const bad of ['', 'not xml', '<WLANProfile><SSIDConfig/></WLANProfile>', '<WLANProfile><name></name></WLANProfile>', '<WLANProfile><name>a&bogus;</name></WLANProfile>',
    '<WLANProfile><name>a&#xD800;</name></WLANProfile>', '<WLANProfile><name>x</name>', Buffer.from([0xc3, 0x28])]) assert.throws(() => parseWlanProfileXml(bad))
})

test('netsh show interfaces 只按 SSID 键与 GUID/MAC 值解析；结构无法确认时返回未知', () => {
  assert.deepEqual([...parseWlanInterfaceSsids(interfacesZh)!], ['家里 5G'])
  const disconnected = '    Name                   : Wi-Fi\r\n    GUID                   : 3f1a2b4c-1111-2222-3333-444455556666\r\n    Physical address       : a4:b1:c1:d1:e1:f1\r\n    State                  : disconnected\r\n'
  assert.deepEqual([...parseWlanInterfaceSsids(disconnected)!], [])
  assert.equal(parseWlanInterfaceSsids('There is no wireless interface on the system.'), undefined)
  assert.equal(parseWlanInterfaceSsids(''), undefined)
  // BSSID 存在而 SSID 标签被翻译：不能当作未连接
  assert.equal(parseWlanInterfaceSsids(interfacesZh.replace('    SSID  ', '    Netz  ')), undefined)
})

test('Windows 列表：导出不带明文密钥，按配置去重、真实认证方式与当前连接，临时文件全部删除', async t => {
  const f = await windowsFixture(t, () => ({ files: {
    'WLAN-home.xml': profileXml(' home ', { ssid: '家里 5G', key: 'ENCRYPTED01', protectedKey: true }),
    'WLAN 2-home.xml': profileXml(' home ', { ssid: '家里 5G', key: 'ENCRYPTED02', protectedKey: true }),
    'WLAN-cafe.xml': profileXml('cafe', { auth: 'open', encryption: 'none' }),
    'WLAN-corp.xml': profileXml('corp', { auth: 'WPA2', oneX: true }),
    'notes.txt': 'ignored'
  } }))
  const profiles = await readWifiProfiles('win32', undefined, f.deps)
  assert.deepEqual(profiles.sort((a, b) => a.ssid.localeCompare(b.ssid, 'en')), [
    { ssid: ' home ', current: true, security: 'WPA2-Personal' }, { ssid: 'cafe', current: false, security: 'Open' }, { ssid: 'corp', current: false, security: 'WPA2-Enterprise' }])
  assert.ok(f.calls[0]!.every(arg => arg !== 'key=clear'))
  assert.equal(JSON.stringify(profiles).includes('ENCRYPTED'), false)
  assert.deepEqual(await f.leftovers(), [])
})

test('Windows 列表：当前连接读取失败或无法解析时保持未知；导出失败、超时、畸形文件均报错且清理', async t => {
  const one = { files: { 'WLAN-a.xml': profileXml('a') } }
  for (const interfaces of [{ stdout: '', exitCode: 1 }, { stdout: 'garbled', exitCode: 0 }]) {
    const f = await windowsFixture(t, () => one, interfaces)
    assert.deepEqual(await readWifiProfiles('win32', undefined, f.deps), [{ ssid: 'a', security: 'WPA2-Personal' }])
  }
  const failures: Array<[Exported, RegExp]> = [
    [{ exitCode: 1, stdout: 'The Wireless AutoConfig Service (wlansvc) is not running.' }, /退出码 1.*wlansvc/],
    [{ exitCode: 124 }, /超时/], [{ exitCode: 130 }, /已取消/],
    [{ files: { 'WLAN-bad.xml': '<WLANProfile>broken' } }, /格式无法识别/],
    [{ files: { 'WLAN-big.xml': Buffer.alloc(300 * 1024, 0x20) } }, /过大/]
  ]
  for (const [result, pattern] of failures) {
    const f = await windowsFixture(t, () => result)
    await assert.rejects(readWifiProfiles('win32', undefined, f.deps), pattern)
    assert.deepEqual(await f.leftovers(), [])
  }
  const empty = await windowsFixture(t, () => ({}))
  assert.deepEqual(await readWifiProfiles('win32', undefined, empty.deps), [])
})

test('Windows 列表：netsh 代码页把 SSID 变成问号、与所有配置都对不上时当前连接为未知，不报未连接', async t => {
  const files = { 'WLAN-cafe.xml': profileXml('cafe'), 'WLAN-emoji.xml': profileXml('咖啡\u{1F375}', { ssid: '咖啡\u{1F375}' }) }
  // 代码页外字符被替换成 "?"，解析出了已连接 SSID，但与任何配置都对不上
  const garbled = await windowsFixture(t, () => ({ files }), { stdout: interfacesZh.replace('家里 5G', '咖啡??'), exitCode: 0 })
  const unknown = await readWifiProfiles('win32', undefined, garbled.deps)
  assert.deepEqual(unknown.sort((a, b) => a.ssid.localeCompare(b.ssid, 'en')), [{ ssid: 'cafe', security: 'WPA2-Personal' }, { ssid: '咖啡\u{1F375}', security: 'WPA2-Personal' }])
  assert.ok(unknown.every(profile => !('current' in profile)), '对不上时不能出现 current: false')
  // 双网卡：一个 SSID 对得上、另一个被替换成问号；对上的仍是已连接，其余未知
  const dual = interfacesZh + interfacesZh.replace('3f1a2b4c-1111', '3f1a2b4c-9999').replace('家里 5G', '??').replace('a4:b1:c1:d1:e1:f1', 'a4:b1:c1:d1:e1:f2')
  const partial = await windowsFixture(t, () => ({ files: { ...files, 'WLAN-home.xml': profileXml('home', { ssid: '家里 5G' }) } }), { stdout: dual, exitCode: 0 })
  assert.deepEqual((await readWifiProfiles('win32', undefined, partial.deps)).sort((a, b) => a.ssid.localeCompare(b.ssid, 'en')), [
    { ssid: 'cafe', security: 'WPA2-Personal' }, { ssid: 'home', current: true, security: 'WPA2-Personal' }, { ssid: '咖啡\u{1F375}', security: 'WPA2-Personal' }])
  // 对照：已连接 SSID 能对上配置时，其余配置照常报未连接；确实没连接（无 SSID 行）时也照常报未连接
  const matched = await windowsFixture(t, () => ({ files: { ...files, 'WLAN-home.xml': profileXml('home', { ssid: '家里 5G' }) } }))
  assert.deepEqual((await readWifiProfiles('win32', undefined, matched.deps)).find(profile => profile.ssid === 'cafe'), { ssid: 'cafe', current: false, security: 'WPA2-Personal' })
  const idle = interfacesZh.replace(/    SSID .*\r\n    BSSID .*\r\n/, '').replace('已连接', '已断开连接')
  const disconnected = await windowsFixture(t, () => ({ files }), { stdout: idle, exitCode: 0 })
  assert.ok((await readWifiProfiles('win32', undefined, disconnected.deps)).every(profile => profile.current === false))
})

test('Windows 密码：仅按名称单独导出并读取 keyMaterial，保留空格，读取后删除含明文的导出文件', async t => {
  const f = await windowsFixture(t, args => ({ files: { 'WLAN- wifi .xml': profileXml(args.find(arg => arg.startsWith('name='))!.slice(5), { key: ' pass word ' }) } }))
  assert.deepEqual(await readWifiPassword(' wifi ', 'win32', undefined, f.deps), { ssid: ' wifi ', password: ' pass word ' })
  assert.deepEqual(f.calls[0]!.slice(0, 5), ['wlan', 'export', 'profile', 'name= wifi ', 'key=clear'])
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await f.leftovers(), [])
})

test('Windows 密码：配置不存在、密钥受保护、开放/企业网络、导出不符或畸形均明确失败，错误不含密钥', async t => {
  const cases: Array<[Exported, RegExp]> = [
    [{ exitCode: 1, stdout: 'Profile "net" is not found on the system.' }, /退出码 1/],
    [{ files: { 'a.xml': profileXml('net', { key: '01000000D08C9DDF', protectedKey: true }) } }, /管理员/],
    [{ files: { 'a.xml': profileXml('net', { auth: 'open', encryption: 'none' }) } }, /没有预共享密码/],
    [{ files: { 'a.xml': profileXml('net', { auth: 'WPA2', oneX: true }) } }, /没有预共享密码/],
    [{ files: { 'a.xml': profileXml('other', { key: 'secret-other' }) } }, /没有导出所选网络/],
    [{ files: { 'a.xml': '<WLANProfile><name>net</name>' } }, /格式无法识别/],
    [{ exitCode: 124 }, /超时/]
  ]
  for (const [result, pattern] of cases) {
    const f = await windowsFixture(t, () => result)
    await assert.rejects(readWifiPassword('net', 'win32', undefined, f.deps), error => error instanceof Error && pattern.test(error.message) && !/01000000D08C9DDF|secret-other/.test(error.message))
    assert.deepEqual(await f.leftovers(), [])
  }
  const f = await windowsFixture(t, () => ({}))
  await assert.rejects(readWifiPassword('', 'win32', undefined, f.deps), /SSID 无效/)
  assert.equal(f.calls.length, 0)
})
