import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { BuiltinPluginHostService } from '../../src/main/services/builtin-plugin-host-service.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'

test('SQLite 查看器真实读取表结构、中文和带引号表名，仅读授权且数据库保持原样', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-sqlite-viewer-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'fixture.sqlite'), SQL = await initSqlJs(), db = new SQL.Database()
  let bytes: Uint8Array
  try {
    db.run('CREATE TABLE "测试""表" (id INTEGER PRIMARY KEY, value TEXT)')
    for (let i = 0; i < 60; i++) db.run('INSERT INTO "测试""表" VALUES (?, ?)', [i, `中文 ${i}`])
    bytes = db.export()
  } finally { db.close() }
  await fs.writeFile(file, bytes)
  const caller: CallerIdentity = { type: 'plugin', pluginId: 'sqlite-plugin', pluginInstanceId: 'test', webContentsId: 42 }
  let authorizationCount = 0
  const host = new BuiltinPluginHostService({ pathAuthority: {
    async resolveAuthorizedPath(requested, owner, access) {
      assert.equal(owner, caller)
      assert.equal(access, 'read')
      if (requested !== file) throw new Error('无文件读取授权')
      authorizationCount++
      return file
    }
  } })
  t.after(() => host.stop())
  const inspected = await host.handlePluginCall('SqlitePlugin', 'inspectWorkspace', { dbPath: file }, undefined, caller) as {
    ok: boolean; tables: Array<{ name: string; rowCount: number }>; rows: Array<{ id: number; value: string }>
  }
  assert.equal(inspected.ok, true)
  assert.equal(inspected.tables[0]?.name, '测试"表')
  assert.equal(inspected.tables[0]?.rowCount, 60)
  assert.equal(inspected.rows.length, 50)
  const queried = await host.handlePluginCall('SqlitePlugin', 'query', { dbPath: file, tableName: '测试"表', limit: 50 }, undefined, caller) as { rows: unknown[] }
  assert.deepEqual(queried.rows, inspected.rows)
  assert.equal(authorizationCount, 2)
  await assert.rejects(host.handlePluginCall('SqlitePlugin', 'inspectWorkspace', { dbPath: path.join(root, 'ungranted.sqlite') }, undefined, caller), /无文件读取授权/)
  await assert.rejects(host.handlePluginCall('SqlitePlugin', 'query', { dbPath: file, tableName: '不存在', limit: 50 }, undefined, caller), /no such table/)
  assert.deepEqual(await fs.readFile(file), Buffer.from(bytes))
  await fs.writeFile(file, 'not a sqlite database')
  await assert.rejects(host.handlePluginCall('SqlitePlugin', 'inspectWorkspace', { dbPath: file }, undefined, caller), /不是有效的 SQLite 数据库/)
})
