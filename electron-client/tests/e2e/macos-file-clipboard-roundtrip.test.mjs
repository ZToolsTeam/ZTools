import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const exec = promisify(execFile)
// 此测试暂时修改系统剪贴板，必须显式开启；所有原始 item/type/data 在 finally 恢复并跨进程验证。
const enabled = process.platform === 'darwin' && process.env.ZTOOLS_TEST_CLIPBOARD === '1'
test('原生写入进程退出后，多文件及中文空格路径仍完整保存在系统剪贴板', { skip: !enabled }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-clipboard-roundtrip-'))
  await fs.chmod(directory, 0o700)
  const fixture = path.join(directory, 'snapshot')
  const backup = path.join(directory, 'original.json')
  const executable = fileURLToPath(new URL('../../out/mac-clipboard-native/native/ZToolsMacClipboard', import.meta.url))
  let saved = false, restored = false
  const request = value => new Promise((resolve, reject) => {
    const child = execFile(executable, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('原生剪贴板测试进程失败'))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('原生剪贴板响应无效')) }
    })
    child.stdin.on('error', () => { /* 进程启动失败由回调处理。 */ })
    child.stdin.end(JSON.stringify(value))
  })
  try {
    await exec('/usr/bin/swiftc', [fileURLToPath(new URL('./fixtures/macos-clipboard-snapshot.swift', import.meta.url)), '-o', fixture])
    const files = [path.join(directory, 'first.txt'), path.join(directory, '第二 份.txt')]
    await Promise.all(files.map(file => fs.writeFile(file, 'own clipboard regression fixture')))
    await exec(fixture, ['save', backup]); saved = true
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.deepEqual(await request({ version: 1, mode: 'write', paths: files }), { version: 1, success: true })
      // execFile 的 callback 保证 writer 已退出；独立 reader 必须仍看见完整两项。
      const read = await request({ version: 1, mode: 'read' })
      assert.equal(read.success, true)
      assert.deepEqual(read.paths, files)
    }
  } finally {
    if (saved) {
      await exec(fixture, ['restore', backup])
      await exec(fixture, ['verify', backup])
      restored = true
    }
    // 恢复失败时保留私有快照，不能删除唯一恢复源。
    if (!saved || restored) await fs.rm(directory, { recursive: true, force: true })
  }
})
