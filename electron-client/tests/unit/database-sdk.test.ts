import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

interface DatabaseSdk {
  setPluginId(id: string): Promise<void>
  allDocs(prefix?: string): Promise<unknown[]>
}

function createApi(reply: unknown): DatabaseSdk {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/db.js', 'utf8')
    .replace(/^export .+$/mg, '')
  const Api = vm.runInNewContext(source + '\nDatabaseAPI', { console }) as
    new (transport: unknown) => DatabaseSdk
  return new Api({ call: async () => reply })
}

test('database SDK preserves a confirmed empty query and maps existing documents', async () => {
  const empty = createApi({ success: true, data: [] })
  await empty.setPluginId('quick-folders')
  assert.equal((await empty.allDocs('favorite-folders')).length, 0)
  const api = createApi({ success: true, data: [{ key: 'favorite-folders', value: '{"items":[]}' }] })
  await api.setPluginId('quick-folders')
  assert.equal(JSON.stringify(await api.allDocs('favorite-folders')),
    '[{"items":[],"_id":"favorite-folders"}]')
})

test('database SDK never disguises failed or malformed queries as an empty document list', async () => {
  for (const reply of [undefined, null, false, {}, { success: false, error: '数据库不可读' },
    { success: true }, { success: true, data: null }, { success: true, data: {} },
    { success: true, data: '[]' }]) {
    const api = createApi(reply)
    await api.setPluginId('quick-folders')
    await assert.rejects(api.allDocs('favorite-folders'))
  }
})
