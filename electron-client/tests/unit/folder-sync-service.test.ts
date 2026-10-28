import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { NativePathAccessAdapter } from '../../src/main/platform/native-path-access.js'
import { FolderSyncService } from '../../src/main/services/folder-sync-service.js'
import { validateFolderSyncRequest, type SyncMode, type SyncDiff } from '../../src/contracts/folder-sync.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { PathAccessAdapter } from '../../src/main/platform/path-access.js'
const caller = { webContentsId: 870, pluginId: 'folder-sync' } as CallerIdentity
const signal = () => new AbortController().signal
const native = path.resolve('out/native/darwin-universal/path-access/native/ZToolsPathAccessBroker')
type Hook = (adapter: PathAccessAdapter, source: string, target: string) => PathAccessAdapter
async function fixture(hook: Hook = adapter => adapter) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-sync-test-')))
  const source = path.join(base, 'source'), target = path.join(base, 'target')
  await fs.mkdir(source); await fs.mkdir(target)
  const service = new FolderSyncService({ resolveAuthorizedPath: async (value, owner) => {
    assert.equal(owner.pluginId, caller.pluginId)
    if (![source, target].some(root => value === root || value.startsWith(root + path.sep))) throw new Error('DENIED')
    return value
  } }, () => hook(new NativePathAccessAdapter(native, 5000), source, target))
  const compare = async (mode: SyncMode = 'incremental') => {
    const reply = await service.execute({ action: 'compare', operationId: randomUUID(), sourceDir: source, targetDir: target, syncMode: mode, ignoreDevJunk: true }, caller, signal())
    assert.ok('planId' in reply)
    return reply as { planId: string; diffs: SyncDiff[] }
  }
  const apply = async (plan: { planId: string; diffs: SyncDiff[] }, select = plan.diffs.map(item => item.relPath), abort = signal()) => {
    const reply = await service.execute({ action: 'execute', operationId: randomUUID(), planId: plan.planId, selectedRelPaths: select }, caller, abort)
    assert.ok('syncedCount' in reply); return reply
  }
  return { base, source, target, service, compare, apply, close: async () => { await service.stop(); await fs.rm(base, { recursive: true, force: true }) } }
}
function macTest(name: string, fn: () => Promise<void>) { test(name, { skip: process.platform !== 'darwin' }, fn) }
const read = (file: string) => fs.readFile(file, 'utf8')
test('同步契约拒绝伪装、未知字段、越权请求形状与无选择执行', () => {
  const request = { action: 'execute', operationId: 'a', planId: randomUUID(), selectedRelPaths: ['a.txt'] }
  validateFolderSyncRequest(request)
  for (const patch of [{ planId: '../x' }, { sourceDir: '/tmp' }, { selectedRelPaths: [] }, { selectedRelPaths: ['x', 'x'] }, { selectedRelPaths: [null] }, { action: ['execute'] }]) assert.throws(() => validateFolderSyncRequest({ ...request, ...patch }))
})
macTest('真实原生链路：同尺寸同时间的内容差异、空文件、备份保留和计划只能执行一次', async () => {
  const f = await fixture()
  try {
    for (const [dir, text] of [[f.source, 'new'], [f.target, 'old']]) { await fs.writeFile(path.join(dir!, 'same.txt'), text!); await fs.utimes(path.join(dir!, 'same.txt'), 1700000000, 1700000000) }
    await fs.writeFile(path.join(f.source, 'empty.txt'), '')
    const plan = await f.compare(); assert.equal(plan.diffs.length, 2)
    const result = await f.apply(plan); assert.equal(result.ok, true); assert.equal(result.syncedCount, 2)
    assert.equal(await read(path.join(f.target, 'same.txt')), 'new')
    assert.equal(await read(path.join(result.recoveryPaths[0]!, 'backup/same.txt')), 'old')
    assert.equal(await read(path.join(f.source, 'same.txt')), 'new')
    assert.equal((await fs.stat(path.join(f.target, 'empty.txt'))).size, 0)
    await assert.rejects(f.apply(plan), /失效/)
    assert.equal((await f.compare()).diffs.length, 0)
  } finally { await f.close() }
})
macTest('双向冲突不猜方向；新文件可分别复制到两边', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.source, 'left'), 'l'); await fs.writeFile(path.join(f.target, 'right'), 'r')
    await fs.writeFile(path.join(f.source, 'conflict'), 'a'); await fs.writeFile(path.join(f.target, 'conflict'), 'b')
    const plan = await f.compare('two-way'); assert.equal(plan.diffs.find(item => item.relPath === 'conflict')?.direction, 'conflict')
    await assert.rejects(f.apply(plan), /冲突/)
    const result = await f.apply(plan, ['left', 'right']); assert.equal(result.syncedCount, 2)
    assert.equal(await read(path.join(f.source, 'right')), 'r'); assert.equal(await read(path.join(f.target, 'left')), 'l')
    assert.equal(await read(path.join(f.source, 'conflict')), 'a'); assert.equal(await read(path.join(f.target, 'conflict')), 'b')
  } finally { await f.close() }
})
macTest('镜像调用真实 Mac 文件引用回收，只移走测试文件且保留可恢复副本', async () => {
  const f = await fixture()
  try {
    const name = `ztools-audit-${randomUUID()}.txt`
    await fs.writeFile(path.join(f.target, name), 'disposable fixture')
    const result = await f.apply(await f.compare('mirror'))
    assert.equal(result.ok, true, result.error); assert.equal(result.deletedCount, 1)
    await assert.rejects(fs.stat(path.join(f.target, name)), { code: 'ENOENT' })
    assert.equal(await read(path.join(result.recoveryPaths[0]!, 'backup', name)), 'disposable fixture')
  } finally { await f.close() }
})
macTest('备份写入失败与备份读回校验失败均不改原文件', async () => {
  for (const failure of ['write', 'verify']) {
    const f = await fixture(adapter => {
      const stream = adapter.streamSave.bind(adapter), derive = adapter.deriveRead.bind(adapter), range = adapter.readRange.bind(adapter)
      const backups = new Set<string>()
      adapter.streamSave = async (...args) => { if (failure === 'write') throw new Error('ENOSPC'); return stream(...args) }
      adapter.deriveRead = async (...args) => { const file = await derive(...args); if (args[1].includes('backup')) backups.add(file.handle); return file }
      adapter.readRange = async (...args) => { const bytes = await range(...args); return failure === 'verify' && backups.has(args[0].handle) ? Buffer.alloc(bytes.length, 120) : bytes }
      return adapter
    })
    try {
      await fs.writeFile(path.join(f.source, 'a'), 'new'); await fs.writeFile(path.join(f.target, 'a'), 'old')
      const result = await f.apply(await f.compare()); assert.equal(result.ok, false); assert.equal(result.syncedCount, 0)
      assert.equal(await read(path.join(f.target, 'a')), 'old'); assert.equal(await read(path.join(f.source, 'a')), 'new')
    } finally { await f.close() }
  }
})
macTest('镜像扫描遇到链接或读取失败立即停止，不返回半份差异', async () => {
  for (const failure of ['link', 'read']) {
    const f = await fixture(adapter => {
      if (failure === 'read') adapter.readRange = async () => { throw new Error('EACCES') }
      return adapter
    })
    try {
      await fs.writeFile(path.join(f.source, 'input'), 'input'); await fs.writeFile(path.join(f.target, 'orphan'), 'keep')
      if (failure === 'link') await fs.symlink(path.join(f.source, 'input'), path.join(f.source, 'link'))
      await assert.rejects(f.compare('mirror')); assert.equal(await read(path.join(f.target, 'orphan')), 'keep')
    } finally { await f.close() }
  }
})
macTest('比对后内容改变即使时间和大小未变也必须重新比对', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.source, 'a'); await fs.writeFile(file, 'new'); await fs.writeFile(path.join(f.target, 'a'), 'old')
    await fs.utimes(file, 1700000000, 1700000000); const plan = await f.compare()
    await fs.writeFile(file, 'NEW'); await fs.utimes(file, 1700000000, 1700000000)
    const result = await f.apply(plan); assert.equal(result.ok, false); assert.match(result.error!, /变化/)
    assert.equal(await read(path.join(f.target, 'a')), 'old')
  } finally { await f.close() }
})
macTest('落盘失败恢复原文件；若同名文件并发出现则保留双方内容并报告备份位置', async () => {
  for (const collision of [false, true]) {
    const f = await fixture((adapter, _source, target) => {
      const move = adapter.move.bind(adapter)
      adapter.move = async (...args) => {
        if (args[1].includes('incoming')) { if (collision) await fs.writeFile(path.join(target, 'a'), 'concurrent'); throw new Error('WRITE_FAILED') }
        return move(...args)
      }; return adapter
    })
    try {
      await fs.writeFile(path.join(f.source, 'a'), 'new'); await fs.writeFile(path.join(f.target, 'a'), 'old')
      const result = await f.apply(await f.compare()); assert.equal(result.ok, false)
      assert.equal(await read(path.join(f.target, 'a')), collision ? 'concurrent' : 'old')
      assert.equal(await read(path.join(result.recoveryPaths[0]!, 'backup/a')), 'old')
      if (collision) { assert.equal(await read(path.join(result.recoveryPaths[0]!, 'original/a')), 'old'); assert.match(result.error!, /恢复未确认/) }
    } finally { await f.close() }
  }
})
macTest('[回归] 原文件已移入备份后原生组件失效（停止或超时），换新组件恢复原位，不只留在备份目录', async () => {
  const f = await fixture(adapter => {
    const move = adapter.move.bind(adapter)
    adapter.move = async (...args) => {
      // 模拟写入新文件时被停止：原生组件整代失效，原组件上的后续调用全部失败
      if (args[1].includes('incoming')) { await adapter.stop(); throw new Error('ABORTED') }
      return move(...args)
    }; return adapter
  })
  try {
    await fs.writeFile(path.join(f.source, 'a'), 'new'); await fs.writeFile(path.join(f.target, 'a'), 'old')
    const result = await f.apply(await f.compare()); assert.equal(result.ok, false)
    assert.equal(await read(path.join(f.target, 'a')), 'old')
    assert.doesNotMatch(result.error!, /恢复未确认/)
    await assert.rejects(fs.stat(path.join(result.recoveryPaths[0]!, 'original/a')), { code: 'ENOENT' })
    assert.equal(await read(path.join(result.recoveryPaths[0]!, 'backup/a')), 'old')
  } finally { await f.close() }
})
macTest('回收站失败回滚到原位，不冒充删除成功', async () => {
  const f = await fixture(adapter => { adapter.trash = async () => { throw new Error('TRASH_DENIED') }; return adapter })
  try {
    await fs.writeFile(path.join(f.target, 'orphan'), 'keep')
    const result = await f.apply(await f.compare('mirror')); assert.equal(result.ok, false); assert.equal(result.deletedCount, 0)
    assert.equal(await read(path.join(f.target, 'orphan')), 'keep')
    assert.equal(await read(path.join(result.recoveryPaths[0]!, 'backup/orphan')), 'keep')
  } finally { await f.close() }
})
macTest('外来窗口不能消费计划，关闭所属窗口释放计划', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.source, 'a'), 'new'); const plan = await f.compare()
    await assert.rejects(f.service.execute({ action: 'execute', operationId: 'foreign', planId: plan.planId, selectedRelPaths: ['a'] }, { ...caller, webContentsId: 871 }, signal()), /失效/)
    await f.service.closeOwner(caller.webContentsId); await assert.rejects(f.apply(plan), /失效/)
    await assert.rejects(fs.stat(path.join(f.target, 'a')), { code: 'ENOENT' })
  } finally { await f.close() }
})
macTest('备份期间取消不覆盖文件，错误结果保留恢复位置', async () => {
  const abort = new AbortController()
  const f = await fixture(adapter => {
    const stream = adapter.streamSave.bind(adapter)
    adapter.streamSave = async (...args) => { const result = await stream(...args); abort.abort(); return result }; return adapter
  })
  try {
    await fs.writeFile(path.join(f.source, 'a'), 'new'); await fs.writeFile(path.join(f.target, 'a'), 'old')
    const result = await f.apply(await f.compare(), ['a'], abort.signal); assert.equal(result.ok, false)
    assert.equal(await read(path.join(f.target, 'a')), 'old'); assert.equal(result.recoveryPaths.length, 1)
  } finally { await f.close() }
})
macTest('超过单文件上限停止扫描，不静默省略', async () => {
  const f = await fixture()
  try {
    const handle = await fs.open(path.join(f.source, 'large'), 'wx'); try { await handle.truncate(2 * 1024 ** 3 + 1) } finally { await handle.close() }
    await assert.rejects(f.compare(), /2 GiB/)
  } finally { await f.close() }
})
macTest('严格列表拒绝符号链接，普通列表仍保留原先跳过链接的行为', async () => {
  const f = await fixture(), adapter = new NativePathAccessAdapter(native, 5000)
  try {
    await fs.writeFile(path.join(f.source, 'file'), 'fixture'); await fs.symlink('file', path.join(f.source, 'link'))
    const directory = await adapter.pin(f.source, 'directory', ['read', 'list'], signal())
    assert.deepEqual((await adapter.list(directory, [], signal())).map(item => item.name), ['file'])
    await assert.rejects(adapter.list(directory, [], signal(), true))
  } finally { await adapter.stop(); await f.close() }
})
macTest('原生回收拒绝硬链接及固定后被替换的路径，不回收替换文件', async () => {
  const f = await fixture(), adapter = new NativePathAccessAdapter(native, 5000)
  try {
    const file = path.join(f.source, 'file'); await fs.writeFile(file, 'fixture')
    const pinned = await adapter.pin(file, 'file', ['read'], signal())
    await fs.link(file, path.join(f.source, 'hardlink'))
    await assert.rejects(adapter.trash(pinned, signal())); assert.equal(await read(file), 'fixture')
    await fs.rename(file, path.join(f.source, 'moved')); await fs.writeFile(file, 'replacement')
    await assert.rejects(adapter.trash(pinned, signal())); assert.equal(await read(file), 'replacement')
  } finally { await adapter.stop(); await f.close() }
})
