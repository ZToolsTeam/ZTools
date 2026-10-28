import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DockerCli, runDockerCommand, findDockerExecutable, type DockerCommand } from '../../src/main/services/docker-cli.js'
import { DockerManagerService, parseDockerContainers } from '../../src/main/services/docker-manager-service.js'
import { validateDockerRequest, type DockerSnapshot } from '../../src/contracts/docker-manager.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
const caller: CallerIdentity = { type: 'plugin', pluginId: 'docker-manager', pluginInstanceId: 'test', webContentsId: 7314 }
const id1 = 'a'.repeat(64), id2 = 'b'.repeat(64)
const signal = () => new AbortController().signal
const row = (id: string, state = 'exited') => ({ ID: id, Names: id === id1 ? 'alpha' : 'beta', Image: 'fixture:latest', State: state, Status: state, Ports: '127.0.0.1:8080->80/tcp', CreatedAt: '2026-01-01 00:00:00 +0000 UTC' })
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-docker-')), file = path.join(dir, 'state.json')
  const initial = { context: 'local', endpoint: 'unix:///test/docker.sock', daemon: 'fixture-daemon', rows: [row(id1), row(id2, 'running')] }
  await fs.writeFile(file, JSON.stringify(initial))
  const script = path.resolve(__dirname, '../../../tests/fixtures/docker-manager/cli.cjs')
  let after: ((args: readonly string[]) => void) | undefined
  const run: DockerCommand = async (_file, args, abort, env, timeout) => {
    const result = await runDockerCommand(process.execPath, [script, file, ...args], abort, env, timeout)
    after?.(args); return result
  }
  const cli = new DockerCli(run, async () => process.execPath, {}, 'darwin'), service = new DockerManagerService(cli)
  return { dir, file, cli, service, run, after(fn: typeof after) { after = fn },
    async patch(value: object) { await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...value })) },
    async calls(): Promise<string[][]> { return (await fs.readFile(file + '.calls', 'utf8')).trim().split('\n').map(v => JSON.parse(v)) },
    call(value: unknown, identity = caller, abort = signal()) { return service.handle(value, identity, abort) },
    async list() { return service.handle({ action: 'list' }, caller, signal()) as Promise<DockerSnapshot> },
    async close() { await service.stop(); await fs.rm(dir, { recursive: true, force: true }) }
  }
}
test('Docker IPC 强参数和权限契约，不接受注入、数组操作及批量空集', () => {
  validateMethodParams('docker_manager', { action: 'list' }); assert.equal(canCall('docker_manager', caller), true)
  const base = { action: 'control', sessionId: '12345678-1234-1234-1234-123456789012', id: id1, operation: 'start' }
  validateDockerRequest(base)
  for (const v of [null, {}, { action: 'list', command: 'rm' }, { ...base, operation: ['start'] }, { ...base, id: '--force' }, { ...base, endpoint: 'tcp://example.invalid' }, { action: 'remove', sessionId: base.sessionId, ids: [] }, { action: 'remove', sessionId: base.sessionId, ids: [id1, id1] }]) assert.throws(() => validateDockerRequest(v))
})
test('真实命令子进程返回双输出流；非零、超时、取消和过量输出均拒绝', async () => {
  const result = await runDockerCommand(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err")'], signal(), {})
  assert.deepEqual(result, { stdout: 'out', stderr: 'err' })
  await assert.rejects(runDockerCommand(process.execPath, ['-e', 'process.stderr.write("denied");process.exit(1)'], signal(), {}), /denied/)
  await assert.rejects(runDockerCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal(), {}, 40), /超时/)
  await assert.rejects(runDockerCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], AbortSignal.timeout(40), {}), /取消/)
  await assert.rejects(runDockerCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000000))'], signal(), {}), /4 MiB/)
  await assert.rejects(runDockerCommand('/not-present/docker', [], signal(), {}))
})
test('隔离 CLI 进程端到端读取、采样、启停、日志和清理，每次操作后验证真实读回', async () => {
  const f = await fixture()
  try {
    let list = await f.list(); assert.equal(list.containers.length, 2); assert.equal(list.containers[1]!.cpu, '0.00%')
    await f.call({ action: 'control', sessionId: list.sessionId, id: id1, operation: 'start' })
    await assert.rejects(f.call({ action: 'logs', sessionId: list.sessionId, id: id1 }), /过期/)
    list = await f.list(); assert.equal(list.containers[0]!.state, 'running')
    assert.deepEqual(await f.call({ action: 'logs', sessionId: list.sessionId, id: id1 }), { success: true, id: id1, stdout: 'actual stdout\n', stderr: 'actual stderr\n' })
    await f.call({ action: 'control', sessionId: list.sessionId, id: id1, operation: 'stop' }); list = await f.list()
    assert.deepEqual(await f.call({ action: 'remove', sessionId: list.sessionId, ids: [id1] }), { success: true, removed: [id1], failures: [] })
    assert.deepEqual((await f.list()).containers.map(c => c.id), [id2])
    assert.ok(!(await f.calls()).flat().some(v => ['--force', '--volumes', 'prune'].includes(v)))
  } finally { await f.close() }
})
test('缺环境、离线、畸形列表和资源失败均明确报告，不伪造空列表或资源数', async () => {
  const f = await fixture()
  try {
    await f.patch({ offline: true }); await assert.rejects(f.list(), /无法连接本机 Docker/)
    await f.patch({ offline: false, badList: true }); await assert.rejects(f.list(), /记录无效/)
    await f.patch({ badList: false, statsFail: true }); const list = await f.list()
    assert.match(list.statsError!, /资源采样失败/); assert.equal(list.containers[1]!.cpu, null)
    assert.throws(() => parseDockerContainers(JSON.stringify({ ...row(id1), CreatedAt: undefined })))
    const missing = new DockerManagerService(new DockerCli(undefined, async () => { throw new Error('未找到 Docker 命令行') }))
    await assert.rejects(missing.handle({ action: 'list' }, caller, signal()), /未找到 Docker/); await missing.stop()
  } finally { await f.close() }
})
test('拒绝远程上下文和跨会话操作，上下文或引擎漂移后不执行写入', async () => {
  const f = await fixture()
  try {
    const list = await f.list()
    await assert.rejects(f.call({ action: 'control', sessionId: list.sessionId, id: id1, operation: 'start' }, { ...caller, webContentsId: 9 }), /过期/)
    await f.patch({ endpoint: 'ssh://remote.invalid' }); await assert.rejects(f.list(), /不是本机连接/)
    await f.patch({ endpoint: 'unix:///test/docker.sock' }); const next = await f.list()
    await f.patch({ daemon: 'other-daemon' }); await assert.rejects(f.call({ action: 'control', sessionId: next.sessionId, id: id1, operation: 'start' }), /引擎已变化/)
    assert.ok(!(await f.calls()).some(c => c[3] === 'start'))
  } finally { await f.close() }
})
test('DOCKER_CONTEXT 优先于 DOCKER_HOST，固定连接清除环境覆盖，用户配置保持不变', async () => {
  const f = await fixture()
  try {
    const env = { DOCKER_HOST: 'tcp://remote.invalid', DOCKER_CONTEXT: 'local' }, calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const cli = new DockerCli(async (file, args, abort, passed, timeout) => { calls.push({ args, env: passed }); return f.run(file, args, abort, passed, timeout) }, async () => process.execPath, env, 'darwin')
    const connection = await cli.connect(signal()); await cli.run(connection, ['info', '--format', '{{json .ID}}'], signal())
    assert.equal(connection.endpoint, 'unix:///test/docker.sock'); assert.equal(calls.at(-1)!.env.DOCKER_CONTEXT, undefined); assert.equal(env.DOCKER_HOST, 'tcp://remote.invalid')
    const direct = new DockerCli(f.run, async () => process.execPath, { DOCKER_HOST: 'tcp://remote.invalid' }, 'darwin')
    await assert.rejects(direct.connect(signal()), /不是本机连接/)
  } finally { await f.close() }
})
test('状态漂移、命令未生效、日志读取失败均不能报成功', async () => {
  const f = await fixture()
  try {
    let list = await f.list(); await f.patch({ rows: [row(id1, 'running'), row(id2, 'running')] })
    await assert.rejects(f.call({ action: 'control', sessionId: list.sessionId, id: id1, operation: 'start' }), /状态已变化/)
    list = await f.list(); await f.patch({ noChange: true })
    await assert.rejects(f.call({ action: 'control', sessionId: list.sessionId, id: id1, operation: 'stop' }), /当前状态为 running/)
    list = await f.list(); await f.patch({ logsFail: true })
    await assert.rejects(f.call({ action: 'logs', sessionId: list.sessionId, id: id1 }), /logging driver/)
  } finally { await f.close() }
})
test('清理部分失败、并发启动和执行中取消均保留精确逐项结果', async () => {
  const f = await fixture()
  try {
    await f.patch({ rows: [row(id1), row(id2)], failIds: [id2] }); let list = await f.list()
    const partial = await f.call({ action: 'remove', sessionId: list.sessionId, ids: [id1, id2] }) as { removed: string[]; failures: unknown[] }
    assert.deepEqual(partial.removed, [id1]); assert.equal(partial.failures.length, 1)
    await f.patch({ rows: [row(id1), row(id2)], failIds: [] }); list = await f.list()
    await f.patch({ rows: [row(id1, 'running'), row(id2)] })
    const drift = await f.call({ action: 'remove', sessionId: list.sessionId, ids: [id1, id2] }) as { removed: string[]; failures: unknown[] }
    assert.deepEqual(drift.removed, [id2]); assert.equal(drift.failures.length, 1)
    await f.patch({ rows: [row(id1), row(id2)] }); list = await f.list(); const abort = new AbortController()
    f.after(args => { if (args.includes('--quiet')) abort.abort() })
    const cancelled = await f.call({ action: 'remove', sessionId: list.sessionId, ids: [id1, id2] }, caller, abort.signal) as { removed: string[]; failures: Array<{ id: string }> }
    assert.deepEqual(cancelled.removed, [id1]); assert.deepEqual(cancelled.failures.map(f => f.id), [id2])
  } finally { await f.close() }
})
test('请求并发拒绝，窗口关闭或服务停止取消真实进程并释放资源', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const cli = new DockerCli(async (_file, _args, abort, env) => { started(); return runDockerCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], abort, env) }, async () => process.execPath)
  const service = new DockerManagerService(cli)
  const pending = service.handle({ action: 'list' }, caller, signal()); const rejection = assert.rejects(pending, /取消/)
  await ready; await assert.rejects(service.handle({ action: 'list' }, caller, signal()), /正在进行/)
  service.closeOwner(caller.webContentsId); await rejection; await service.stop()
  await assert.rejects(service.handle({ action: 'list' }, caller, signal()), /已停止/)
})
test('命令发现仅选择存在的可执行文件，不接受 PATH 中的相对目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-locate-'))
  try {
    const executable = path.join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker')
    await fs.writeFile(executable, 'fixture'); await fs.chmod(executable, 0o700)
    assert.equal(await findDockerExecutable({ PATH: `.${path.delimiter}${dir}` }, process.platform, dir), executable)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
