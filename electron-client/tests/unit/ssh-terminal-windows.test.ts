import test from 'node:test'
import assert from 'node:assert/strict'
import { WindowsTerminalLauncher, createSshTerminal, sshArguments, windowsProxyEnvironment, windowsProxyTerminalArguments, type ConsoleStart } from '../../src/main/services/ssh-terminal.js'

const signal = () => new AbortController().signal
function recorder() {
  const started: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const start: ConsoleStart = async (file, args, env) => { started.push({ file, args, env }) }
  return { started, start }
}

test('Windows 代理环境：去掉所有大小写变体的旧代理变量，保留 NO_PROXY/no_proxy 与其他变量，不修改原环境', () => {
  const base = { Path: 'C:\\bin', http_proxy: 'http://old:1', HTTP_Proxy: 'http://old:2', hTtPs_PrOxY: 'http://old:3', all_proxy: 'socks5://old:4', ALL_PROXY: 'socks5://old:5', NO_PROXY: 'corp.local', no_proxy: 'localhost', SystemRoot: 'C:\\Windows' }
  const snapshot = { ...base }
  const env = windowsProxyEnvironment(base, windowsProxyTerminalArguments(7890))
  assert.deepEqual(env, { Path: 'C:\\bin', NO_PROXY: 'corp.local', no_proxy: 'localhost', SystemRoot: 'C:\\Windows', HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890' })
  assert.deepEqual(base, snapshot)
  assert.deepEqual(windowsProxyTerminalArguments(65535), ['HTTP_PROXY=http://127.0.0.1:65535', 'HTTPS_PROXY=http://127.0.0.1:65535', 'ALL_PROXY=http://127.0.0.1:65535'])
  // 只接受固定三个变量指向本机：小写变量名、外部主机、其他变量、带命令拼接的值都拒绝
  for (const bad of [['http_proxy=http://127.0.0.1:1'], ['HTTP_PROXY=https://127.0.0.1:1'], ['HTTP_PROXY=http://127.0.0.2:1'], ['NO_PROXY=http://127.0.0.1:1'], ['HTTP_PROXY=http://127.0.0.1:1\r\nPATH=x'], ['HTTP_PROXY=http://127.0.0.1:123456']]) {
    assert.throws(() => windowsProxyEnvironment({}, bad), /代理终端参数无效/)
  }
  for (const port of [0, 65536, 1.5, NaN]) assert.throws(() => windowsProxyTerminalArguments(port), /1 到 65535/)
})

test('Windows SSH 终端：参数原样交给系统 OpenSSH，环境为副本；SystemRoot 缺失时用 C:\\Windows', async () => {
  const r = recorder(), environment = { SystemRoot: 'E:\\WINDOWS', USERPROFILE: 'C:\\Users\\u' }
  const checked: string[] = []
  const launcher = new WindowsTerminalLauncher(r.start, environment, async file => { checked.push(file); return true })
  const args = sshArguments('dev-box', { localPort: 8080, remoteHost: '10.0.0.5', remotePort: 80 })
  const result = await launcher.launch('ssh', args, signal())
  assert.deepEqual(result, { success: true, opened: true, notice: '已请求打开新的控制台窗口；连接、认证和隧道状态以窗口输出为准，Ctrl+C 可停止' })
  assert.deepEqual(checked, ['E:\\WINDOWS\\System32\\OpenSSH\\ssh.exe'])
  assert.deepEqual(r.started[0], { file: 'E:\\WINDOWS\\System32\\OpenSSH\\ssh.exe', args: ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:8080:10.0.0.5:80', 'dev-box'], env: environment })
  assert.notEqual(r.started[0]!.env, environment)
  const fallback = recorder()
  await new WindowsTerminalLauncher(fallback.start, {}, async () => true).launch('proxy', windowsProxyTerminalArguments(1080), signal())
  assert.equal(fallback.started[0]!.file, 'C:\\Windows\\System32\\cmd.exe'); assert.deepEqual(fallback.started[0]!.args, ['/d', '/k', 'set', 'HTTP'])
  assert.ok(createSshTerminal('win32') instanceof WindowsTerminalLauncher)
})

test('Windows 终端故障注入：找不到 ssh.exe（替身与真实文件检查）、代理参数无效、真实启动失败均如实报错且不启动', async () => {
  const r = recorder()
  await assert.rejects(new WindowsTerminalLauncher(r.start, { SystemRoot: 'C:\\Windows' }, async () => false).launch('ssh', ['host'], signal()), /未找到 Windows 自带的 OpenSSH 客户端/)
  // 默认文件检查：路径不存在（stat 抛错）按不存在处理
  await assert.rejects(new WindowsTerminalLauncher(r.start, { SystemRoot: 'C:\\ztools-不存在的系统目录-7f3a' }).launch('ssh', ['host'], signal()), /OpenSSH 客户端/)
  await assert.rejects(new WindowsTerminalLauncher(r.start, {}).launch('proxy', ['PATH=C:\\evil'], signal()), /代理终端参数无效/)
  assert.equal(r.started.length, 0)
  // 默认启动器走真实 spawn：程序不存在时报“未能打开”，不声称已打开
  await assert.rejects(new WindowsTerminalLauncher(undefined, { SystemRoot: 'C:\\ztools-nonexistent-root-7f3a' }).launch('proxy', windowsProxyTerminalArguments(1), signal()), /系统未能打开新的控制台窗口/)
  // 文件检查期间被取消或服务停止：不启动
  const abort = new AbortController(), cancelled = new WindowsTerminalLauncher(r.start, {}, async () => { abort.abort(new Error('已取消')); return true })
  await assert.rejects(cancelled.launch('ssh', ['host'], abort.signal), /已取消/)
  let launcher: WindowsTerminalLauncher | undefined
  launcher = new WindowsTerminalLauncher(r.start, {}, async () => { await launcher!.stop(); return true })
  await assert.rejects(launcher.launch('ssh', ['host'], signal()), /终端服务已停止/)
  assert.equal(r.started.length, 0)
})
