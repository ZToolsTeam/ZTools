import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ClassicLevel } from 'classic-level'
import { saveClipboardHistory } from '../../src/main/services/clipboard-history.js'

test('history reindexes duplicates, preserves collections, and prunes expired records and image attachments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-history-'))
  const store = new ClassicLevel<string, Buffer>(root, { valueEncoding: 'buffer' })
  const rows = async () => (await store.iterator({ gte: 'clip:v2:!', lt: 'clip:v2:!\uffff' }).all())
    .map(([key, value]) => ({ key, doc: JSON.parse(value.toString()) }))
  try {
    await store.open()
    await store.put('settings', Buffer.from(JSON.stringify({ database: { maxsize: 2, maxage: 14 } })))
    await saveClipboardHistory(store, { type: 'text', text: 'favorite' }, 100)
    const favorite = (await rows())[0]!
    await store.put(favorite.key, Buffer.from(JSON.stringify({ ...favorite.doc, collect: true })))
    await saveClipboardHistory(store, { type: 'image', image: 'data:image/png;base64,cG5n' }, 200)
    const image = (await rows())[0]!
    await saveClipboardHistory(store, { type: 'text', text: 'latest' }, 300)
    assert.equal(await store.get(`attachment:clip-image:${image.doc.id}`), undefined)
    assert.equal((await rows()).length, 2)
    await saveClipboardHistory(store, { type: 'text', text: 'favorite' }, 400)
    const updated = (await rows())[0]!
    assert.equal(updated.doc.data, 'favorite')
    assert.equal(updated.doc.collect, true)
    assert.equal(updated.doc.createTime, 100)
    assert.equal(updated.doc.updateTime, 400)
    assert.equal(await store.get(favorite.key), undefined)
    await saveClipboardHistory(store, { type: 'text', text: 'after expiry' }, 20 * 86_400_000)
    assert.deepEqual((await rows()).map(({ doc }) => doc.data), ['after expiry', 'favorite'])
    assert.equal(JSON.parse((await store.get('meta:clipboard-indexed-history:v2'))!.toString()).ready, true)
  } finally {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
