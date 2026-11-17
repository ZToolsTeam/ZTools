import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTempDirTracker, makeWritableSync, removeTempDirSync } from './helpers/temp-dir.mjs'

test('removeTempDirSync：可彻底删除含真实 Git 仓库只读对象与显式只读文件的临时目录', () => {
  const tracker = createTempDirTracker()
  const root = tracker.mkdtemp('ztools-temp-helper-git-')
  const init = spawnSync('git', ['-c', 'user.name=TempTest', '-c', 'user.email=temp@example.invalid', '-c', 'commit.gpgsign=false', 'init', '-q'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)

  const readOnlyFile = path.join(root, 'readonly.txt')
  fs.writeFileSync(readOnlyFile, 'locked\n')
  spawnSync('git', ['add', 'readonly.txt'], { cwd: root, encoding: 'utf8' })
  const commit = spawnSync('git', ['-c', 'user.name=TempTest', '-c', 'user.email=temp@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: root, encoding: 'utf8' })
  assert.equal(commit.status, 0, commit.stderr)
  fs.chmodSync(readOnlyFile, 0o444)

  removeTempDirSync(root)
  tracker.dirs.delete(root)
  assert.equal(fs.existsSync(root), false)
})

test('makeWritableSync 与 removeTempDirSync：遇到指向外部目录的符号链接时不越界修改外部文件权限，也不删除外部文件', (t) => {
  const tracker = createTempDirTracker()
  const outside = tracker.mkdtemp('ztools-temp-helper-out-')
  const inside = tracker.mkdtemp('ztools-temp-helper-in-')
  try {
    const extFile = path.join(outside, 'protected.txt')
    fs.writeFileSync(extFile, 'keep\n')
    fs.chmodSync(extFile, 0o444)
    try {
      fs.symlinkSync(outside, path.join(inside, 'linked-outside'), 'junction')
    } catch (err) {
      if (['EPERM', 'EACCES'].includes(err.code)) {
        t.skip('当前环境无符号链接创建权限')
        return
      }
      throw err
    }

    makeWritableSync(inside)
    removeTempDirSync(inside)
    tracker.dirs.delete(inside)

    assert.equal(fs.existsSync(inside), false)
    assert.equal(fs.existsSync(extFile), true, '外部目标文件必须完好保留')
    const mode = fs.statSync(extFile).mode & 0o222
    assert.equal(mode, 0, '外部只读文件的权限位不得被越界改写')
  } finally {
    tracker.cleanupAll()
  }
})

test('边界与容错：空参数安全返回，tracker.cleanupAll 在多目录批量回收时全部清空', () => {
  assert.doesNotThrow(() => removeTempDirSync(''))
  assert.doesNotThrow(() => removeTempDirSync(null))
  assert.doesNotThrow(() => removeTempDirSync(path.join(os.tmpdir(), `ztools-non-existent-${Date.now()}`)))

  const tracker = createTempDirTracker()
  const d1 = tracker.mkdtemp('ztools-temp-batch-1-')
  const d2 = tracker.mkdtemp('ztools-temp-batch-2-')
  fs.writeFileSync(path.join(d1, 'a.txt'), '1')
  fs.writeFileSync(path.join(d2, 'b.txt'), '2')
  fs.chmodSync(path.join(d1, 'a.txt'), 0o444)

  tracker.cleanupAll()
  assert.equal(tracker.dirs.size, 0)
  assert.equal(fs.existsSync(d1), false)
  assert.equal(fs.existsSync(d2), false)
})
