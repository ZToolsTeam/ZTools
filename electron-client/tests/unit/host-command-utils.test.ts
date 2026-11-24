import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import {
  buildPowerShellArgs,
  codePageToTextDecoderLabel,
  createOemCodePageProbe,
  decodeCommandOutput,
  escapePsSingleQuoted,
  isAccessDeniedCommandResult,
  isAccessDeniedError,
  isAccessDeniedText,
  parseOemCodePage,
  POWERSHELL_UTF8_OUTPUT_PREFIX,
  PowerShellError,
  runCommand,
  runPowerShell
} from '../../src/main/services/host-plugins/shared-utils.js'

// “所有用户配置文件” 的 GBK 字节（netsh wlan show profiles 的中文输出）
const GBK_PROFILES = Buffer.from([0xcb, 0xf9, 0xd3, 0xd0, 0xd3, 0xc3, 0xbb, 0xa7, 0xc5, 0xe4, 0xd6, 0xc3, 0xce, 0xc4, 0xbc, 0xfe])

test('命令输出解码：合法 UTF-8 一律优先；没有代码页时退回按界面语言（中文 GB18030，其余 Windows-1252）', () => {
  assert.equal(decodeCommandOutput(Buffer.from('配置文件 Wi-Fi', 'utf8'), undefined, 'zh-CN'), '配置文件 Wi-Fi')
  assert.equal(decodeCommandOutput(GBK_PROFILES, undefined, 'zh-CN'), '所有用户配置文件')
  assert.equal(decodeCommandOutput(Buffer.from([0x63, 0x61, 0x66, 0xe9]), undefined, 'en-US'), 'café')
  // UTF-8 优先：即使系统代码页是 GBK / Shift_JIS，合法 UTF-8（PowerShell 已固定 UTF-8 输出）也按 UTF-8 解码
  for (const cp of [936, 932, 1252, 866]) assert.equal(decodeCommandOutput(Buffer.from('日本語 네트워크 Сеть', 'utf8'), cp, 'en-US'), '日本語 네트워크 Сеть')
})

test('命令输出解码：按系统 OEM 代码页回退，与界面语言无关；未收录的代码页退回按界面语言', () => {
  // 英文界面、中文系统（OEM 936）：仍按 GB18030 解码
  assert.equal(decodeCommandOutput(GBK_PROFILES, 936, 'en-US'), '所有用户配置文件')
  // 中文界面、日文系统（OEM 932）：“ネットワーク” 的 Shift_JIS 字节
  assert.equal(decodeCommandOutput(Buffer.from([0x83, 0x6c, 0x83, 0x62, 0x83, 0x67, 0x83, 0x8f, 0x81, 0x5b, 0x83, 0x4e]), 932, 'zh-CN'), 'ネットワーク')
  // 繁体中文（950）“網路”的 Big5 字节
  assert.equal(decodeCommandOutput(Buffer.from([0xba, 0xf4, 0xb8, 0xf4]), 950, 'en-US'), '網路')
  // 韩文（949）“네트워크”的 EUC-KR 字节
  assert.equal(decodeCommandOutput(Buffer.from([0xb3, 0xd7, 0xc6, 0xae, 0xbf, 0xf6, 0xc5, 0xa9]), 949, 'zh-CN'), '네트워크')
  // 俄文系统 OEM 866：“Сеть” 的 CP866 字节；按界面语言规则会被解成 Windows-1252 乱码
  const cp866 = Buffer.from([0x91, 0xa5, 0xe2, 0xec])
  assert.equal(decodeCommandOutput(cp866, 866, 'en-US'), 'Сеть')
  assert.notEqual(decodeCommandOutput(cp866, undefined, 'en-US'), 'Сеть')
  // ANSI 1251（西里尔）“Сеть”
  assert.equal(decodeCommandOutput(Buffer.from([0xd1, 0xe5, 0xf2, 0xfc]), 1251, 'zh-CN'), 'Сеть')
  // 437/850 TextDecoder 不支持，按 Windows-1252（区别于界面语言 zh-CN 的 gb18030）：ASCII 不受影响，不抛错
  const cp437Sample = Buffer.from([0x4f, 0x4b, 0x82])
  assert.equal(decodeCommandOutput(cp437Sample, 437, 'zh-CN'), new TextDecoder('windows-1252').decode(cp437Sample))
  assert.equal(decodeCommandOutput(Buffer.from([0x4f, 0x4b, 0xe9]), 437, 'zh-CN'), 'OKé')
  // 未收录的代码页（如 720 阿拉伯 DOS）退回按界面语言
  assert.equal(decodeCommandOutput(GBK_PROFILES, 720, 'zh-CN'), '所有用户配置文件')
})

test('代码页映射到 TextDecoder 标签，每个标签都能实际构造解码器', () => {
  const expected: Array<[number, string | undefined]> = [
    [936, 'gb18030'], [54936, 'gb18030'], [950, 'big5'], [932, 'shift_jis'], [949, 'euc-kr'], [866, 'ibm866'],
    [1250, 'windows-1250'], [1251, 'windows-1251'], [1252, 'windows-1252'], [1258, 'windows-1258'], [874, 'windows-874'],
    [437, 'windows-1252'], [850, 'windows-1252'], [852, 'windows-1252'], [65001, 'utf-8'], [20866, 'koi8-r'],
    [28591, 'windows-1252'], [28592, 'iso-8859-2'], [28605, 'iso-8859-15'],
    [720, undefined], [28602, undefined], [0, undefined], [-1, undefined], [Number.NaN, undefined], [1.5, undefined]
  ]
  for (const [cp, label] of expected) {
    assert.equal(codePageToTextDecoderLabel(cp), label, `代码页 ${cp}`)
    if (label) assert.doesNotThrow(() => new TextDecoder(label), `${label} 必须被 TextDecoder 支持`)
  }
})

test('OEM 代码页探测：解析 reg 输出；只查询一次并缓存，失败、非零退出、无法解析、查询抛错都得到 undefined', async () => {
  const regOutput = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    936\r\n\r\n'
  assert.equal(parseOemCodePage(regOutput), 936)
  assert.equal(parseOemCodePage('    ACP    REG_SZ    1252'), undefined)
  assert.equal(parseOemCodePage('    OEMCP    REG_SZ    abc'), undefined)
  assert.equal(parseOemCodePage(''), undefined)

  let calls = 0
  const probe = createOemCodePageProbe(async () => { calls++; return { stdout: regOutput, exitCode: 0 } })
  assert.deepEqual(await Promise.all([probe(), probe()]), [936, 936])
  assert.equal(await probe(), 936)
  assert.equal(calls, 1, '并发与重复调用只查询一次')

  for (const query of [
    async () => ({ stdout: regOutput, exitCode: 1 }),
    async () => ({ stdout: '', exitCode: 124 }),
    async () => ({ stdout: '错误: 系统找不到指定的注册表项或值。', exitCode: 0 }),
    async () => { throw new Error('reg 无法启动') }
  ]) {
    let n = 0
    const failing = createOemCodePageProbe(async () => { n++; return query() })
    assert.equal(await failing(), undefined)
    assert.equal(await failing(), undefined)
    assert.equal(n, 1, '失败结果同样缓存，不反复启动 reg')
  }
})

test('PowerShell 参数：脚本前加 UTF-8 输出前缀并按 UTF-16LE 编码；以 param()/using 开头的脚本直接拒绝', () => {
  const script = "\n  $ErrorActionPreference = 'Stop'\n  Write-Output '网卡'\n"
  const args = buildPowerShellArgs(script)
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  const decoded = Buffer.from(args[5]!, 'base64').toString('utf16le')
  assert.equal(decoded, POWERSHELL_UTF8_OUTPUT_PREFIX + script)
  assert.match(decoded, /^\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding \$false; \$OutputEncoding = \[Console\]::OutputEncoding\n/)
  // 前缀只是赋值语句，不改变脚本最后一条语句（退出码仍取用户脚本最后一条语句的 $?）
  assert.ok(decoded.endsWith(script))
  for (const bad of ['param([string]$w) Write-Output $w', '\n  # 注释\n  PARAM ( $x )', '<# 说明 #>\n[CmdletBinding()]\nparam()', 'using namespace System.Text\nWrite-Output 1']) {
    assert.throws(() => buildPowerShellArgs(bad), /param\(\)、\[CmdletBinding\(\)\] 或 using 开头/)
  }
  // 中间出现的 param 关键字或调用（如 ForEach 里的 Get-Param）不受影响
  assert.doesNotThrow(() => buildPowerShellArgs("$p = 'param(x)'\nfunction f { param($a) $a }"))
})

test('runCommand：合法 UTF-8 输出原样解码，非 UTF-8 字节按回退规则解码而不是抛错或丢弃', async () => {
  const utf8 = await runCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.from("日本語 Сеть", "utf8"))'])
  assert.equal(utf8.exitCode, 0); assert.equal(utf8.stdout, '日本語 Сеть')
  const invalid = await runCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0x4f, 0x4b, 0xff]))'])
  assert.equal(invalid.exitCode, 0); assert.ok(invalid.stdout.startsWith('OK')); assert.equal(invalid.stdout.length, 3)
})

test('[注入] PowerShell 单引号转义同时处理 ASCII 单引号与四种弯引号，转义后无法提前结束字符串', () => {
  assert.equal(escapePsSingleQuoted("a'b"), "a''b")
  for (const quote of ['\u2018', '\u2019', '\u201A', '\u201B']) {
    const escaped = escapePsSingleQuoted(`x${quote}; Remove-Item C:\\ -Recurse; ${quote}`)
    assert.equal(escaped.split(quote).length - 1, 4, `${quote} 必须成对出现`)
  }
  assert.equal(escapePsSingleQuoted('普通文件名.txt'), '普通文件名.txt')
})

test('runCommand 如实返回退出码与错误输出；超时返回 124、取消返回 130、命令不存在返回非零', async () => {
  const completed = new AbortController()
  const fail = await runCommand(process.execPath, ['-e', 'process.stderr.write("失败原因"); process.exit(3)'], 5_000, completed.signal)
  assert.equal(fail.exitCode, 3)
  assert.match(fail.stderr, /失败原因/)
  assert.equal(getEventListeners(completed.signal, 'abort').length, 0)
  const expired = new AbortController()
  const timeout = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200, expired.signal)
  assert.equal(timeout.exitCode, 124)
  assert.match(timeout.stderr, /超时/)
  assert.equal(getEventListeners(expired.signal, 'abort').length, 0)
  const controller = new AbortController()
  const pending = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 5_000, controller.signal)
  controller.abort()
  assert.equal((await pending).exitCode, 130)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const unavailable = new AbortController()
  const missing = await runCommand('ztools-command-that-does-not-exist', [], 5_000, unavailable.signal)
  assert.notEqual(missing.exitCode, 0)
  assert.equal(getEventListeners(unavailable.signal, 'abort').length, 0)
})

test('已取消的信号不启动命令、PowerShell 或 Windows 代码页探测', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const controller = new AbortController()
  controller.abort()
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('不应启动子进程') })
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    assert.equal((await runCommand(process.execPath, [], 5_000, controller.signal)).exitCode, 130)
    await assert.rejects(runPowerShell('param($x)', 5_000, controller.signal),
      error => error instanceof PowerShellError && error.exitCode === 130)
    assert.equal(spawn.mock.callCount(), 0)
  } finally { Object.defineProperty(process, 'platform', platform) }
})

test('进程启动后、abort监听注册前取消仍终止进程，并清理监听', async t => {
  const controller = new AbortController()
  const addListener = controller.signal.addEventListener.bind(controller.signal)
  t.mock.method(controller.signal, 'addEventListener', (...args: Parameters<AbortSignal['addEventListener']>) => {
    controller.abort()
    addListener(...args)
  })
  let killed = 0
  t.mock.method(childProcess, 'spawn', (command: string) => {
    const child = new EventEmitter() as childProcess.ChildProcess
    child.kill = () => { killed++; child.emit('close', 0); return true }
    if (command === 'reg') queueMicrotask(() => child.emit('close', 0))
    return child
  })
  assert.equal((await runCommand(process.execPath, [], 5_000, controller.signal)).exitCode, 130)
  assert.equal(killed, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('PowerShellError 区分超时、取消与普通失败；非 Windows 上 runPowerShell 不执行并返回空字符串', async () => {
  assert.match(new PowerShellError(124, '').message, /超时/)
  assert.match(new PowerShellError(130, '').message, /取消/)
  assert.match(new PowerShellError(1, '找不到命令').message, /退出码 1.*找不到命令/)
  if (process.platform !== 'win32') assert.equal(await runPowerShell('Write-Output 1'), '')
})

test('结构化权限拒绝判定优先依赖 error.code / exitCode / HRESULT 与英文关键字，同时兼容中文 Windows 原生 CLI 固定输出', () => {
  // 退出码与 Win32/HRESULT 数值码
  assert.equal(isAccessDeniedCommandResult({ exitCode: 5, stdout: '', stderr: '' }), true)
  assert.equal(isAccessDeniedCommandResult({ exitCode: 740, stdout: '', stderr: '' }), true)
  assert.equal(isAccessDeniedCommandResult({ exitCode: 0x80070005, stdout: '', stderr: '' }), true)
  assert.equal(isAccessDeniedCommandResult({ exitCode: -2147024891, stdout: '', stderr: '' }), true)
  assert.equal(isAccessDeniedCommandResult({ code: 'EACCES', exitCode: 1 }), true)
  assert.equal(isAccessDeniedCommandResult({ code: 'EPERM', exitCode: 1 }), true)

  // 英文通用关键字、文本内错误码及简体/繁体中文 Windows CLI 输出（reg/netsh/schtasks 退出码为 1）
  for (const text of [
    'ERROR: Access is denied.',
    'Permission denied',
    'Operation not permitted',
    'The requested operation requires elevation.',
    '[SC] ChangeServiceConfig FAILED 5:',
    'HRESULT 0x80070005',
    'ERROR_ACCESS_DENIED',
    '错误: 拒绝访问。',
    '请求的操作需要提升(作为管理员运行)。',
    '錯誤: 存取被拒。',
    '要求的操作需要提高權限。'
  ]) {
    assert.equal(isAccessDeniedText(text), true, `expected denied for: ${text}`)
    assert.equal(isAccessDeniedCommandResult({ exitCode: 1, stderr: text }), true)
  }

  // Error 对象按 code / hresult / message 判断
  assert.equal(isAccessDeniedError(Object.assign(new Error('fail'), { code: 'EACCES' })), true)
  assert.equal(isAccessDeniedError(Object.assign(new Error('fail'), { code: 'EPERM' })), true)
  assert.equal(isAccessDeniedError({ hresult: 0x80070005 }), true)
  assert.equal(isAccessDeniedError(new Error('Access is denied')), true)

  // 负向边界：不误判正常结果、普通英文错误或非权限相关的中文错误
  assert.equal(isAccessDeniedCommandResult({ exitCode: 0, stdout: 'OK', stderr: '' }), false)
  assert.equal(isAccessDeniedCommandResult({ exitCode: 1, stdout: '', stderr: 'Invalid parameter' }), false)
  assert.equal(isAccessDeniedCommandResult({ exitCode: 1, stdout: '', stderr: '错误: 系统找不到指定的注册表项或值。' }), false)
  assert.equal(isAccessDeniedError(null), false)
  assert.equal(isAccessDeniedError(undefined), false)
  assert.equal(isAccessDeniedError({ code: 'ENOENT', message: 'not found' }), false)
})
