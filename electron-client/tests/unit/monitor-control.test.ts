import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { MonitorControlService, monitorTimeoutMs, type MonitorRunner } from '../../src/main/services/monitor-control-service.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { errorCodes, toPublicError } from '../../src/contracts/errors.js'

const id = 'mac:12345678-1234-1234-1234-123456789abc'
const topology = `${id}/1/0`
const display = { id, name: '测试显示器', isPrimary: true, builtIn: true, width: 3024, height: 1964, protocol: 'apple', canBrightness: true, canContrast: false, brightness: 45.458230376243591 }
const setRequest = { action: 'set', topology, changes: [{ id, control: 'brightness', expected: display.brightness, value: 46 }] }
const snapshot = { version: 1, success: true, topology, displays: [display] }
const ack = { version: 1, success: true, changed: [{ id, control: 'brightness', value: 46, maximum: 0 }] }
const signal = () => new AbortController().signal
const receipt = (value: unknown, exitCode = 0) => ({ stdout: JSON.stringify(value), exitCode })
const service = (runner: MonitorRunner) => new MonitorControlService(process.execPath, 'darwin', runner)
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
async function publicFailure(promise: Promise<unknown>) {
  try { await promise; assert.fail('应当失败') } catch (error) { return toPublicError(error) }
}

test('方法契约拒绝注入、范围越界、重复目标和缺少扫描状态', () => {
  validateMethodParams('monitor_control', setRequest)
  validateMethodParams('monitor_control', { action: 'list' })
  for (const bad of [null, { action: 'sleep', executable: '/tmp/x' }, { ...setRequest, topology: '$(anything)' }, { ...setRequest, changes: [] }, { ...setRequest, changes: [setRequest.changes[0], setRequest.changes[0]] }, ...[-1, 101, NaN, Infinity, '50'].map(value => ({ ...setRequest, changes: [{ ...setRequest.changes[0], value }] })), { ...setRequest, changes: [{ ...setRequest.changes[0], expected: undefined }] }]) assert.throws(() => validateMethodParams('monitor_control', bad))
})
test('真实读取值保留小数精度；请求不经 shell 且使用协议版本', async () => {
  const s = service(async (executable, args, input) => {
    assert.equal(executable, process.execPath); assert.deepEqual(args, []); assert.deepEqual(JSON.parse(input!), { version: 1, action: 'list' }); return receipt(snapshot)
  })
  const result = await s.execute({ action: 'list' }, signal())
  assert.ok('displays' in result); assert.equal(result.displays[0]!.brightness, display.brightness); assert.equal(result.displays[0]!.canContrast, false)
})
test('停止发生在文件检查期间时禁止启动硬件写入', async t => {
  const stat = await fs.lstat(process.execPath), pendingStat = deferred<typeof stat>(); let calls = 0
  const mocked = t.mock.method(fs, 'lstat', () => pendingStat.promise)
  const s = service(async () => { calls++; return receipt(ack) })
  const pending = s.execute(setRequest, signal()), result = publicFailure(pending), stopped = s.stop()
  pendingStat.resolve(stat)
  assert.equal((await result).code, errorCodes.appStopping); await stopped; assert.equal(calls, 0); mocked.mock.restore()
})
test('取消发生在文件检查期间时禁止启动硬件写入', async t => {
  const stat = await fs.lstat(process.execPath), pendingStat = deferred<typeof stat>(), controller = new AbortController(); let calls = 0
  const mocked = t.mock.method(fs, 'lstat', () => pendingStat.promise)
  const s = service(async () => { calls++; return receipt(ack) })
  const pending = s.execute(setRequest, controller.signal), rejected = assert.rejects(pending)
  controller.abort(); pendingStat.resolve(stat); await rejected; assert.equal(calls, 0); mocked.mock.restore()
})
test('写入启动后关闭页面与停止服务都等待原生回读完成，不中断恢复', async () => {
  const started = deferred<void>(), response = deferred<ReturnType<typeof receipt>>(), controller = new AbortController()
  const s = service(async () => { started.resolve(); return response.promise })
  const pending = s.execute(setRequest, controller.signal); await started.promise
  await assert.rejects(s.execute({ action: 'list' }, signal()), /正在执行/)
  controller.abort(); let stopped = false; const stop = s.stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  response.resolve(receipt(ack)); assert.deepEqual(await pending, { success: true, changed: ack.changed }); await stop
  assert.equal(stopped, true); assert.equal((await publicFailure(s.execute({ action: 'list' }, signal()))).code, errorCodes.appStopping)
})
test('已取消的读取不返回迟到列表，随后可重新请求', async () => {
  const started = deferred<void>(), response = deferred<ReturnType<typeof receipt>>(), controller = new AbortController()
  const s = service(async () => { started.resolve(); return response.promise })
  const pending = s.execute({ action: 'list' }, controller.signal), rejected = assert.rejects(pending); await started.promise
  controller.abort(); response.resolve(receipt(snapshot)); await rejected
  assert.ok('displays' in await s.execute({ action: 'list' }, signal()))
})
for (const [code, text] of [['DISPLAY_WRITE_FAILED_RESTORED', '已核验恢复原值'], ['DISPLAY_WRITE_OUTCOME_UNKNOWN', '无法恢复'], ['DISPLAY_STATE_CHANGED', '已变化']]) test(`原生失败 ${code} 经真实 IPC 错误转换仍保留含义`, async () => {
  const s = service(async () => receipt({ version: 1, success: false, code }, 1))
  const result = await publicFailure(s.execute(setRequest, signal())); assert.equal(result.code, errorCodes.screenError); assert.ok(result.message.includes(text!)); assert.notEqual(result.message, '宿主内部错误')
})
test('进程异常与无效 JSON 不泄露内部信息，也不声称已恢复', async () => {
  for (const runner of [async () => { throw new Error('private executable path and output') }, async () => ({ stdout: 'private non-json', exitCode: 1 })]) {
    const result = await publicFailure(service(runner).execute(setRequest, signal()))
    assert.equal(result.code, errorCodes.screenError); assert.doesNotMatch(result.message, /private|已核验恢复/); assert.match(result.message, /重新扫描确认/)
  }
})
test('列表畸形、虚构控制能力、重复身份及失效响应拒绝显示成功', async () => {
  for (const value of [{ ...snapshot, version: 2 }, { ...snapshot, displays: [{ ...display, brightness: undefined }] }, { ...snapshot, displays: [{ ...display, brightness: 101 }] }, { ...snapshot, displays: [display, display] }, { ...snapshot, displays: [{ ...display, canContrast: true }] }]) {
    const result = await publicFailure(service(async () => receipt(value)).execute({ action: 'list' }, signal())); assert.equal(result.code, errorCodes.screenError)
  }
})
test('不完整、重复、错误目标和错误读回值不能作为成功回执', async () => {
  for (const value of [{ ...ack, changed: [] }, { ...ack, changed: [null] }, { ...ack, changed: [{ ...ack.changed[0], id: 'other' }] }, { ...ack, changed: [{ ...ack.changed[0], value: 75 }] }, { ...ack, changed: [ack.changed[0], ack.changed[0]] }]) {
    const result = await publicFailure(service(async () => receipt(value)).execute(setRequest, signal())); assert.equal(result.code, errorCodes.screenError); assert.match(result.message, /重新扫描确认/)
  }
  assert.equal((await publicFailure(service(async () => receipt(ack, 1)).execute(setRequest, signal()))).code, errorCodes.screenError)
})
test('熄屏只发送固定系统请求，不声称已锁屏或已实测屏幕状态', async () => {
  const s = service(async (executable, args, input) => { assert.equal(executable, '/usr/bin/pmset'); assert.deepEqual(args, ['displaysleepnow']); assert.equal(input, undefined); return { stdout: '', exitCode: 0 } })
  assert.deepEqual(await s.execute({ action: 'sleep' }, signal()), { success: true, requested: true })
  assert.equal((await publicFailure(service(async () => ({ stdout: '', exitCode: 1 })).execute({ action: 'sleep' }, signal()))).code, errorCodes.screenError)
})
test('组件缺失与平台不支持时不回退到旧实现', async () => {
  let calls = 0; const runner: MonitorRunner = async () => { calls++; return receipt(snapshot) }
  assert.equal((await publicFailure(new MonitorControlService('/missing/ZToolsMacDisplay', 'darwin', runner).execute({ action: 'list' }, signal()))).code, errorCodes.screenError)
  assert.equal((await publicFailure(new MonitorControlService(process.execPath, 'linux', runner).execute({ action: 'list' }, signal()))).code, errorCodes.notSupported)
  assert.equal(calls, 0)
})

test('DDC 固定档位按实际范围量化，内屏细微调节无效不能假成功', async () => {
  for (const maximum of [1, 10, 100, 65535]) {
    const value = Math.round(46 * maximum / 100) * 100 / maximum
    const result = await service(async () => receipt({ ...ack, changed: [{ ...ack.changed[0], maximum, value }] })).execute(setRequest, signal())
    assert.ok('changed' in result)
  }
  const result = await publicFailure(service(async () => receipt({ ...ack, changed: [{ ...ack.changed[0], value: display.brightness }] })).execute(setRequest, signal()))
  assert.equal(result.code, errorCodes.screenError)
})
test('Windows：经系统 PowerShell 运行组件，源码走标准输入；WMI/DDC 结果按同一契约校验，熄屏需系统确认', async () => {
  const { monitorHelperPath } = await import('../../src/main/services/monitor-control-service.js')
  const ps = monitorHelperPath(false, '/unused', 'win32')
  assert.match(ps, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
  const winId = 'win:0123abcd-0123-4567-89ab-0123456789ab', winTopology = 'a'.repeat(64)
  const panel = { id: winId, name: '内置屏', isPrimary: true, builtIn: true, width: 1920, height: 1200, protocol: 'wmi', canBrightness: true, canContrast: false, brightness: 60 }
  let seen: { args: string[]; input: Record<string, unknown> } | undefined
  const win = (reply: (input: Record<string, unknown>) => { stdout: string; exitCode: number }) => new MonitorControlService(process.execPath, 'win32', async (_executable, args, input) => {
    seen = { args, input: JSON.parse(input!) }; return reply(seen.input)
  })
  const listed = await win(() => receipt({ version: 1, success: true, topology: winTopology, displays: [panel] })).execute({ action: 'list' }, signal()) as { displays: unknown[] }
  assert.deepEqual(listed.displays, [panel])
  // 命令行只带短引导脚本（Base64 编码），C# 源码与请求经标准输入传入，不拼接进命令行
  assert.deepEqual(seen!.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  const bootstrap = Buffer.from(seen!.args[5]!, 'base64').toString('utf16le')
  assert.match(bootstrap, /Add-Type -TypeDefinition/); assert.ok(seen!.args.join(' ').length < 4096)
  assert.deepEqual(seen!.input.request, { version: 1, action: 'list' }); assert.match(String(seen!.input.source), /namespace ZToolsWinDisplay/)
  // PowerShell 5.1 只支持 C# 5，且不引用 System.Core
  assert.doesNotMatch(String(seen!.input.source), /\?\.|\$"|out var |=>|HashSet|SortedSet|System\.Linq/)
  const setReq = { action: 'set', topology: winTopology, changes: [{ id: winId, control: 'brightness', value: 75, expected: 60 }] }
  validateMethodParams('monitor_control', setReq)
  await win(() => receipt({ version: 1, success: true, changed: [{ id: winId, control: 'brightness', value: 75, maximum: 100 }] })).execute(setReq, signal())
  // 档位为 10 的背光：75% 量化为 80%，读回 80 视为一致；读回 70 必须失败
  await win(() => receipt({ version: 1, success: true, changed: [{ id: winId, control: 'brightness', value: 80, maximum: 10 }] })).execute(setReq, signal())
  assert.equal((await publicFailure(win(() => receipt({ version: 1, success: true, changed: [{ id: winId, control: 'brightness', value: 70, maximum: 10 }] })).execute(setReq, signal()))).message, '调节回读与硬件档位不一致，请重新扫描确认')
  for (const bad of [{ ...panel, id: 'win:1' }, { ...panel, protocol: 'hdmi' }, { ...panel, brightness: undefined }]) {
    await assert.rejects(win(() => receipt({ version: 1, success: true, topology: winTopology, displays: [bad] })).execute({ action: 'list' }, signal()))
  }
  assert.deepEqual(await win(() => receipt({ version: 1, success: true, requested: true })).execute({ action: 'sleep' }, signal()), { success: true, requested: true })
  assert.deepEqual(seen!.input.request, { version: 1, action: 'sleep' })
  assert.equal((await publicFailure(win(() => receipt({ version: 1, success: true })).execute({ action: 'sleep' }, signal()))).message, '系统没有接受熄屏请求')
  assert.equal((await publicFailure(win(() => receipt({ version: 1, success: false, code: 'DISPLAY_SLEEP_REJECTED' }, 1)).execute({ action: 'sleep' }, signal()))).message, '系统没有接受熄屏请求')
  assert.equal((await publicFailure(win(() => receipt({ version: 1, success: false, code: 'DISPLAY_HELPER_FAILED' }, 1)).execute({ action: 'list' }, signal()))).message, '显示器组件运行失败，请重新扫描；持续失败请反馈')
  await assert.rejects(new MonitorControlService(process.execPath, 'linux', async () => receipt(snapshot)).execute({ action: 'list' }, signal()), /不支持/)
})

test('组件超时按请求计算：Windows 列表/熄屏 25 秒，调节 20 秒 + 每项 6 秒（上限 120 秒）；macOS 保持 15 秒', async () => {
  const winId = (n: number) => `win:0123abcd-0123-4567-89ab-${n.toString(16).padStart(12, '0')}`
  const changes = (count: number) => Array.from({ length: count }, (_, n) => ({ id: winId(Math.floor(n / 2)), control: n % 2 ? 'contrast' as const : 'brightness' as const, value: 50, expected: 40 }))
  const setReq = (count: number) => ({ action: 'set' as const, topology: 'a'.repeat(64), changes: changes(count) })
  const timeouts: number[] = []
  // 回执故意设为“调节已恢复原值”的失败：超时值与回执结果无关，失败也必须按请求传入超时
  const win = new MonitorControlService(process.execPath, 'win32', async (_e, _a, input, timeoutMs) => {
    timeouts.push(timeoutMs); const request = (JSON.parse(input!) as { request: { action: string } }).request
    return request.action === 'list' ? receipt({ version: 1, success: true, topology: 'a'.repeat(64), displays: [] }) : request.action === 'sleep' ? receipt({ version: 1, success: true, requested: true }) : receipt({ version: 1, success: false, code: 'DISPLAY_WRITE_FAILED_RESTORED' }, 1)
  })
  await win.execute({ action: 'list' }, signal()); await win.execute({ action: 'sleep' }, signal())
  for (const count of [1, 4, 16]) {
    validateMethodParams('monitor_control', setReq(count))
    assert.match((await publicFailure(win.execute(setReq(count), signal()))).message, /已核验恢复原值/)
  }
  assert.deepEqual(timeouts, [25000, 25000, 26000, 44000, 116000])
  assert.equal(monitorTimeoutMs(setReq(16), 'win32'), 116000)
  // 上限：即使将来放宽单次变更数，也不超过 120 秒
  assert.equal(monitorTimeoutMs({ ...setReq(1), changes: changes(1).concat(...Array.from({ length: 30 }, () => changes(1))) }, 'win32'), 120000)
  // macOS：原生组件与 pmset 均保持 15 秒
  const macTimeouts: number[] = []
  const mac = service(async (executable, _a, _i, timeoutMs) => { macTimeouts.push(timeoutMs); return executable === '/usr/bin/pmset' ? { stdout: '', exitCode: 0 } : receipt(ack) })
  await mac.execute(setRequest, signal()); await mac.execute({ action: 'sleep' }, signal())
  assert.deepEqual(macTimeouts, [15000, 15000])
  // 进程被超时强制结束（runner 抛错）时不声称成功，也不泄露内部信息
  const killed = new MonitorControlService(process.execPath, 'win32', async () => { throw Object.assign(new Error('Command failed: killed SIGKILL'), { killed: true }) })
  const failure = await publicFailure(killed.execute(setReq(4), signal()))
  assert.equal(failure.code, errorCodes.screenError); assert.match(failure.message, /结果可能已部分生效/); assert.doesNotMatch(failure.message, /SIGKILL/)
})
