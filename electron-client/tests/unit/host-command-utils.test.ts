import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPowerShellArgs,
  codePageToTextDecoderLabel,
  createOemCodePageProbe,
  decodeCommandOutput,
  escapePsSingleQuoted,
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
  // 437/850 TextDecoder 不支持，按 Windows-1252：ASCII 不受影响，不抛错
  assert.equal(decodeCommandOutput(Buffer.from([0x4f, 0x4b, 0x82]), 437, 'zh-CN'), 'OK\u201a')
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
  const fail = await runCommand(process.execPath, ['-e', 'process.stderr.write("失败原因"); process.exit(3)'])
  assert.equal(fail.exitCode, 3)
  assert.match(fail.stderr, /失败原因/)
  const timeout = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200)
  assert.equal(timeout.exitCode, 124)
  assert.match(timeout.stderr, /超时/)
  const controller = new AbortController()
  const pending = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 5_000, controller.signal)
  controller.abort()
  assert.equal((await pending).exitCode, 130)
  const missing = await runCommand('ztools-command-that-does-not-exist', [])
  assert.notEqual(missing.exitCode, 0)
})

test('PowerShellError 区分超时、取消与普通失败；非 Windows 上 runPowerShell 不执行并返回空字符串', async () => {
  assert.match(new PowerShellError(124, '').message, /超时/)
  assert.match(new PowerShellError(130, '').message, /取消/)
  assert.match(new PowerShellError(1, '找不到命令').message, /退出码 1.*找不到命令/)
  if (process.platform !== 'win32') assert.equal(await runPowerShell('Write-Output 1'), '')
})
