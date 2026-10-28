import { toPublicError, errorCodes } from '../../src/contracts/errors.js'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateHostsRequest, type HostsSnapshot } from '../../src/contracts/hosts-manager.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { MacHostsProvider, readHostsFile, type HostsProvider } from '../../src/main/services/hosts-provider.js'
import { HostsBackups } from '../../src/main/services/hosts-backups.js'
import { HostsManagerService } from '../../src/main/services/hosts-manager-service.js'
const exec = promisify(execFile), signal = () => AbortSignal.timeout(20000)
const caller = { type: 'plugin', webContentsId: 99, pluginId: 'hosts-switcher' } as CallerIdentity
const original = '# 保留用户原注释\n127.0.0.1 localhost local-alias\n::1 localhost\n255.255.255.255 broadcasthost\n'
let root: string, binary: string
before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-hosts-test-'))); binary = path.join(root, 'hosts-fixture')
  if (process.platform === 'darwin') await exec('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-DZTOOLS_HOSTS_FIXTURE', '-framework', 'Foundation', path.resolve('native/ZToolsMacHosts/main.mm'), '-o', binary])
})
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const dir = await fs.mkdtemp(path.join(root, 'isolated-')), file = path.join(dir, 'hosts')
  await fs.writeFile(file, original, { mode: 0o644 }); return { dir, file }
}
async function native(dir: string, before: HostsSnapshot, content: string, extra: { cancel?: boolean; expired?: boolean; badIdentity?: boolean; pause?: string; stage?: () => Promise<void> } = {}) {
  const requestDir = await fs.mkdtemp(path.join(root, 'request-')), request = path.join(requestDir, 'request.json')
  await fs.writeFile(request, JSON.stringify({ version: 1, expected: before.content, content, identity: extra.badIdentity ? '0:0' : before.identity, deadline: Date.now() + (extra.expired ? -1000 : 80000) }), { mode: 0o600 })
  if (extra.cancel) await fs.writeFile(path.join(requestDir, 'cancel'), 'cancel')
  const running = exec(binary, ['--apply', request, String(process.getuid!()), dir], { env: { ...process.env, ZTOOLS_HOSTS_FIXTURE_PAUSE: extra.pause || '' } });
  if (extra.stage) await extra.stage()
  const { stdout } = await running; return JSON.parse(stdout)
}
const mac = { skip: process.platform !== 'darwin' }
test('真实原子写入保留双栈、本地别名、元数据与原对象，反向写回可恢复', mac, async () => {
  const { dir, file } = await fixture(), before = await readHostsFile(file, signal()), stat = await fs.stat(file)
  const content = original + '\n127.0.0.2 fixture.test\n'
  const result = await native(dir, before, content)
  assert.equal(result.success, true); assert.equal(result.code, 'APPLIED'); assert.equal(await fs.readFile(file, 'utf8'), content)
  const retained = path.join(result.recoveryPath, 'previous'); assert.equal((await fs.stat(retained)).ino, stat.ino); assert.equal(await fs.readFile(retained, 'utf8'), original)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644)
  assert.equal(await fs.readFile(path.join(result.recoveryPath, 'original.before'), 'utf8'), original)
  const restored = await native(dir, await readHostsFile(file, signal()), original); assert.equal(restored.success, true); assert.equal(await fs.readFile(file, 'utf8'), original)
})
test('读取后内容或身份变化、取消、过期均不写入', mac, async () => {
  for (const mode of ['content', 'identity', 'cancel', 'expired']) {
    const { dir, file } = await fixture(), before = await readHostsFile(file, signal())
    if (mode === 'content') await fs.appendFile(file, '# 外部编辑\n')
    const expected = await fs.readFile(file, 'utf8')
    const result = await native(dir, before, original + '# next\n', { badIdentity: mode === 'identity', cancel: mode === 'cancel', expired: mode === 'expired' })
    assert.equal(result.success, false, mode); assert.equal(await fs.readFile(file, 'utf8'), expected, mode)
  }
})
test('符号链接、硬链接、非普通文件、备份不可写与不安全权限拒绝修改', mac, async () => {
  for (const mode of ['symlink', 'hardlink', 'permissions', 'backup']) {
    const { dir, file } = await fixture(), before = await readHostsFile(file, signal())
    if (mode === 'symlink') { await fs.rename(file, file + '.retained'); await fs.symlink(file + '.retained', file) }
    if (mode === 'hardlink') await fs.link(file, file + '.retained')
    if (mode === 'permissions') await fs.chmod(file, 0o666)
    if (mode === 'backup') await fs.chmod(dir, 0o500)
    try { const result = await native(dir, before, '# next\n'); assert.equal(result.success, false, mode); assert.equal(await fs.readFile(file, 'utf8'), original) }
    finally { await fs.chmod(dir, 0o700) }
  }
  const { file } = await fixture(); await fs.rm(file); await fs.mkdir(file); await assert.rejects(readHostsFile(file, signal()), /普通/)
})
test('宿主真实请求文件、shell 转义和原生回执链路；授权失败明确抛错', mac, async () => {
  const { dir, file } = await fixture(), helperWithQuote = path.join(root, "helper with ' quote")
  await fs.copyFile(binary, helperWithQuote); await fs.chmod(helperWithQuote, 0o755)
  const provider = new MacHostsProvider(helperWithQuote, async (command, args) => {
    assert.equal(command, '/usr/bin/osascript'); const match = /^do shell script (.+) with administrator privileges$/.exec(args[1]!)!
    const shell = JSON.parse(match[1]!); const result = await exec('/bin/sh', ['-c', shell + " '" + dir + "'"]); return result.stdout
  }, file)
  const before = await provider.read(signal()), content = original + '# via-provider\n'
  assert.ok((await provider.write(before, content, signal())).recoveryPath); assert.equal((await provider.read(signal())).content, content)
  const denied = new MacHostsProvider(binary, async () => { throw new Error('用户取消授权') }, file)
  await assert.rejects(denied.write(await denied.read(signal()), original, signal()), /授权或写入未确认/)
  assert.equal(await fs.readFile(file, 'utf8'), content)
})
test('取消标记写入失败时撤销请求，迟到的原生写入不能修改文件', mac, async t => {
  const { dir, file } = await fixture(), controller = new AbortController()
  const writeFileSync = fsSync.writeFileSync
  let failedMarkers = 0
  t.mock.method(fsSync, 'writeFileSync', (target: fsSync.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fsSync.WriteFileOptions) => {
    if (typeof target === 'string' && path.basename(target) === 'cancel') {
      failedMarkers++
      throw Object.assign(new Error('取消标记无法写入'), { code: 'ENOSPC' })
    }
    return writeFileSync(target, data, options)
  })
  const provider = new MacHostsProvider(binary, async (_command, args) => {
    const script = /^do shell script (.+) with administrator privileges$/.exec(args[1]!)!
    const shell = JSON.parse(script[1]!) as string
    const request = /'--apply' '([^']+)'/.exec(shell)![1]!
    controller.abort()
    await assert.rejects(fs.access(request), { code: 'ENOENT' })
    const result = await exec('/bin/sh', ['-c', shell + " '" + dir + "'"])
    return result.stdout
  }, file)
  await assert.rejects(provider.write(await provider.read(signal()), original + '# cancelled\n', controller.signal), /Hosts 未确认写入.*取消标记写入失败/)
  assert.equal(failedMarkers, 1)
  assert.equal(await fs.readFile(file, 'utf8'), original)
})
test('备份损坏、路径穿越、陌生字段与超长内容失败关闭', mac, async () => {
  for (const request of [{ action: 'read', customHostsPath: '/tmp/no' }, { action: 'prepare', sessionId: 'bad', content: '' }, { action: 'prepare', sessionId: 'a'.repeat(36), content: '\0' }, { action: 'prepare', sessionId: 'a'.repeat(36), content: 'x'.repeat(1048577) }]) assert.throws(() => validateHostsRequest(request))
  const dir = path.join(root, 'backup-store'), backups = new HostsBackups(dir), saved = await backups.save(original, original + '# next\n')
  assert.equal((await backups.load(saved.id)).before, original); assert.equal((await backups.list()).length, 1)
  await fs.writeFile(path.join(dir, saved.id + '.json'), '{}'); await assert.rejects(backups.load(saved.id), /校验失败/)
  await assert.rejects(backups.load('../etc/hosts'), /编号无效/)
})
async function serviceFixture(flushError = '') {
  const { dir, file } = await fixture(); let writes = 0
  const provider: HostsProvider = {
    read: s => readHostsFile(file, s),
    async write(before, content) { writes++; const result = await native(dir, before, content); if (!result.success) throw new Error(result.code); return result },
    async flush() { if (flushError) throw new Error(flushError) }
  }
  const service = new HostsManagerService(provider, new HostsBackups(path.join(dir, 'backups')), 'darwin')
  const call = (request: unknown, identity = caller) => service.handle(request, identity, signal()) as Promise<Record<string, unknown>>
  return { dir, file, call, service, writes: () => writes }
}
test('真实服务读→预览→写→校验→备份恢复；DNS失败不谎报未写入', mac, async () => {
  const { call, service, file } = await serviceFixture('DNS 授权被拒')
  try {
    const snapshot = await call({ action: 'read' }), content = original + '# selected\n'
    const plan = await call({ action: 'prepare', sessionId: snapshot.sessionId, content })
    assert.equal(await fs.readFile(file, 'utf8'), original)
    const result = await call({ action: 'apply', planId: plan.planId })
    assert.equal(result.written, true); assert.equal(result.dnsFlushed, false); assert.match(String(result.dnsError), /被拒/)
    const current = await call({ action: 'read' }), restore = await call({ action: 'restore', sessionId: current.sessionId, backupId: result.backupId })
    await call({ action: 'apply', planId: restore.planId }); assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally { await service.stop() }
})
test('其他窗口、读后外部修改、确认后修改、取消计划均不能写', mac, async () => {
  const { call, service, file, writes } = await serviceFixture()
  try {
    const snapshot = await call({ action: 'read' })
    await assert.rejects(call({ action: 'prepare', sessionId: snapshot.sessionId, content: 'next' }, { ...caller, webContentsId: 100 }), /过期/)
    const plan = await call({ action: 'prepare', sessionId: snapshot.sessionId, content: original + '# next\n' })
    await assert.rejects(call({ action: 'apply', planId: plan.planId }, { ...caller, webContentsId: 100 }), /过期/)
    await fs.appendFile(file, '# outside\n')
    await assert.rejects(call({ action: 'apply', planId: plan.planId }), /其他程序修改/)
    await assert.rejects(call({ action: 'prepare', sessionId: snapshot.sessionId, content: 'next' }), /其他程序修改/)
    const fresh = await call({ action: 'read' }), pending = await call({ action: 'prepare', sessionId: fresh.sessionId, content: original })
    await call({ action: 'cancel' }); await assert.rejects(call({ action: 'apply', planId: pending.planId }), /过期/); assert.equal(writes(), 0)
  } finally { await service.stop() }
})
test('备份写入失败时服务不调用系统写入，DNS刷新必须取得真实成功', mac, async () => {
  const { dir, call, service, writes, file } = await serviceFixture('dns failed')
  try {
    const snap = await call({ action: 'read' }), plan = await call({ action: 'prepare', sessionId: snap.sessionId, content: '# next\n' })
    await fs.chmod(path.join(dir, 'backups'), 0o500)
    await assert.rejects(call({ action: 'apply', planId: plan.planId })); assert.equal(writes(), 0); assert.equal(await fs.readFile(file, 'utf8'), original)
    await assert.rejects(call({ action: 'flush' }), /dns failed/)
  } finally { await fs.chmod(path.join(dir, 'backups'), 0o700); await service.stop() }
})
async function marker(file: string) {
  for (let i = 0; i < 100; i++) { try { await fs.access(file); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('fixture stage missing')
}
test('交换时并发修改保留实际原文件，回滚读回失败只能报未知', mac, async () => {
  for (const invalidateRollback of [false, true]) {
    const { dir, file } = await fixture(), before = await readHostsFile(file, signal()), external = original + '# concurrent\n'
    const result = await native(dir, before, original + '# new\n', {
      pause: invalidateRollback ? 'before-verify,before-rollback-verify' : 'before-verify',
      stage: async () => {
        await marker(path.join(dir, 'before-verify.ready'))
        const recovery = (await fs.readdir(dir)).find(v => v.startsWith('.ztools-hosts-'))!
        await fs.writeFile(path.join(dir, recovery, 'previous'), external)
        await fs.writeFile(path.join(dir, 'before-verify.continue'), '')
        if (invalidateRollback) {
          await marker(path.join(dir, 'before-rollback-verify.ready'))
          await fs.appendFile(file, '# later\n'); await fs.writeFile(path.join(dir, 'before-rollback-verify.continue'), '')
        }
      }
    })
    assert.equal(result.success, false); assert.equal(result.code, invalidateRollback ? 'ROLLBACK_VERIFY_UNKNOWN' : 'CONCURRENT_CHANGE_RESTORED')
    assert.equal(await fs.readFile(file, 'utf8'), external + (invalidateRollback ? '# later\n' : ''))
    assert.equal(await fs.readFile(path.join(result.recoveryPath, 'original.before'), 'utf8'), original)
  }
})
test('取消与关闭发生在备份读取期间，迟到任务不能重新登记会话或写入计划', mac, async () => {
  const { dir, file } = await fixture(); let complete: (() => void) | undefined
  class DelayedBackups extends HostsBackups {
    override async list() { await new Promise<void>(resolve => { complete = resolve }); return [] }
  }
  const provider: HostsProvider = { read: s => readHostsFile(file, s), write: async () => { throw new Error('must not write') }, flush: async () => {} }
  const service = new HostsManagerService(provider, new DelayedBackups(path.join(dir, 'backups')), 'darwin')
  const reading = service.handle({ action: 'read' }, caller, signal()); const rejected = assert.rejects(reading, /abort/i)
  while (!complete) await new Promise(r => setTimeout(r, 1))
  service.closeOwner(caller.webContentsId); complete(); await rejected
  await service.stop()
})

test('真实 IPC 错误序列化保留失败原因、恢复目录和备份提示，并限制长度', mac, async () => {
  const { dir, file } = await fixture()
  const provider: HostsProvider = {
    read: s => readHostsFile(file, s),
    async write() { throw new Error('WRITE_OUTCOME_UNKNOWN；原文件恢复目录 /private/etc/.ztools-hosts-test') },
    async flush() { throw new Error('授权被取消') }
  }
  const service = new HostsManagerService(provider, new HostsBackups(path.join(dir, 'backups')), 'darwin')
  try {
    const state = await service.handle({ action: 'read' }, caller, signal()) as Record<string, unknown>
    const plan = await service.handle({ action: 'prepare', sessionId: state.sessionId, content: original + '# next' }, caller, signal()) as Record<string, unknown>
    await assert.rejects(service.handle({ action: 'apply', planId: plan.planId }, caller, signal()), error => {
      const reply = toPublicError(error)
      assert.equal(reply.code, errorCodes.nativeHostError); assert.match(reply.message, /WRITE_OUTCOME_UNKNOWN/); assert.match(reply.message, /恢复目录/); assert.match(reply.message, /原内容备份/)
      assert.ok(reply.message.length <= 2000); return true
    })
    await assert.rejects(service.handle({ action: 'flush' }, caller, signal()), error => { assert.match(toPublicError(error).message, /授权被取消/); return true })
  } finally { await service.stop() }
})
