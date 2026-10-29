import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EnvironmentBackupStore } from '../../src/main/services/environment-backups.js'
import { SystemEnvironmentProvider, runEnvironmentCommand, type EnvironmentState } from '../../src/main/services/environment-provider.js'

const windows = { skip: process.platform !== 'win32' }
const signal = () => AbortSignal.timeout(15000)
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-private-backups-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // 模拟安装在共享数据盘，父目录允许其他普通用户读取/修改。
  execFileSync('icacls.exe', [root, '/grant', '*S-1-5-11:(OI)(CI)M'], { windowsHide: true, stdio: 'pipe' })
  return root
}
const before: EnvironmentState = { source: 'user', location: 'isolated-test', exists: true, raw: 'before' }
const after: EnvironmentState = { ...before, raw: 'after' }

test('Windows：真实读取用户与系统环境，不被首次模块进度或 PowerShell 7 模块路径阻断', windows, async () => {
  const provider = new SystemEnvironmentProvider(() => { throw new Error('Windows 不应访问 POSIX 适配器') })
  for (const source of ['user', 'system'] as const) {
    const state = await provider.read(source, signal())
    assert.equal(state.source, source)
    assert.ok(provider.values(state) instanceof Map)
  }
})

test('Windows：执行错误及 stderr 仍失败，未忽略真实错误', windows, async () => {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  for (const script of ["throw 'test failure'", "[Console]::Error.Write('test stderr')"]) {
    await assert.rejects(runEnvironmentCommand(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], undefined, signal()), /系统环境组件执行失败/)
  }
})

test('Windows：新目录和旧空目录建立私有 ACL，真实备份可并发保存、重启读取及校验损坏', windows, async t => {
  const root = await fixture(t)
  for (const existing of [false, true]) {
    const directory = path.join(root, String(existing))
    if (existing) {
      await fs.mkdir(directory)
      // 目录所有者可修改 DACL，但未获 WRITE_OWNER；初始化不能重复写所有者。
      execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*S-1-5-11:(OI)(CI)M'], { windowsHide: true, stdio: 'pipe' })
    }
    const store = new EnvironmentBackupStore(directory)
    assert.deepEqual(await store.list(), [])
    const records = await Promise.all([store.save(before, after, '第一份'), store.save(before, after, '第二份')])
    const reopened = new EnvironmentBackupStore(directory)
    assert.equal((await reopened.list()).length, 2)
    assert.deepEqual(await reopened.load(records[0].id), records[0])
    const file = path.join(directory, `${records[0].id}.json`)
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    record.before.raw = 'tampered'
    await fs.writeFile(file, JSON.stringify(record))
    await assert.rejects(reopened.load(records[0].id), /校验失败/)
  }
})

test('Windows：已有非空宽权限目录和目录链接拒绝访问，保留原数据', windows, async t => {
  const root = await fixture(t), directory = path.join(root, 'unsafe')
  await fs.mkdir(directory)
  const original = path.join(directory, 'keep.txt')
  await fs.writeFile(original, 'must remain')
  await assert.rejects(new EnvironmentBackupStore(directory).list(), /系统环境组件执行失败/)
  assert.equal(await fs.readFile(original, 'utf8'), 'must remain')
  const linked = path.join(root, 'junction')
  await fs.symlink(directory, linked, 'junction')
  await assert.rejects(new EnvironmentBackupStore(linked).list(), /系统环境组件执行失败/)
  assert.equal(await fs.readFile(original, 'utf8'), 'must remain')
})
