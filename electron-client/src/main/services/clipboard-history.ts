import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ClassicLevel, BatchOperation } from 'classic-level'

export type ClipboardHistoryEntry =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }
  | { type: 'files'; files: string[] }

const PREFIX = 'clip:v2:!'
type Store = ClassicLevel<string, Buffer>
interface ClipDoc {
  id: string
  type: string
  data: string
  createTime: number
  updateTime: number
  collect?: boolean
}

// Runs in the host's existing database connection, never opens a second LevelDB lock.
export async function saveClipboardHistory(store: Store, entry: ClipboardHistoryEntry, now = Date.now()): Promise<void> {
  const source = entry.type === 'text' ? entry.text : entry.type === 'image' ? entry.image
    : JSON.stringify(entry.files.map((file) => ({ name: path.win32.basename(file), path: file })))
  if (!source || (entry.type === 'files' && entry.files.length === 0)) return
  const id = createHash('md5').update(source).digest('hex')
  let maxsize = 800
  let maxage = 14
  const settings = await store.get('settings')
  if (settings) {
    try {
      const database = JSON.parse(settings.toString('utf8')).database
      if (Number.isFinite(database?.maxsize) && database.maxsize > 0) maxsize = Math.floor(database.maxsize)
      if (Number.isFinite(database?.maxage) && database.maxage >= 0) maxage = database.maxage
    } catch { /* Keep defaults for malformed legacy settings. */ }
  }
  const operations: Array<BatchOperation<Store, string, Buffer>> = []
  let existing: ClipDoc | undefined
  const rows: Array<{ key: string; doc: ClipDoc }> = []
  for await (const [key, value] of store.iterator({ gte: PREFIX, lt: `${PREFIX}\uffff`, fillCache: false })) {
    let doc: ClipDoc
    try { doc = JSON.parse(value.toString('utf8')) as ClipDoc } catch { continue }
    if (!doc || typeof doc.id !== 'string' || typeof doc.data !== 'string') continue
    if (doc.id === id) {
      existing = existing?.collect ? existing : doc
      operations.push({ type: 'del', key })
      continue
    }
    // Retention only needs metadata; do not accumulate all clipboard text in memory.
    if (doc.type !== 'image') doc.data = ''
    rows.push({ key, doc })
  }
  let retained = 1 + rows.filter(({ doc }) => doc.collect).length
  for (const { key, doc } of rows) {
    if (doc.collect) continue
    if (now - doc.updateTime <= maxage * 86_400_000 && retained < maxsize) {
      retained += 1
      continue
    }
    operations.push({ type: 'del', key })
    if (doc.type === 'image' && doc.data === `ztools-clip-image:${doc.id}`) {
      for (const prefix of ['clip-image:', 'attachment:clip-image:', 'attachment_type:clip-image:']) {
        operations.push({ type: 'del', key: `${prefix}${doc.id}` })
      }
    }
  }
  const storeKey = `${PREFIX}${String(Number.MAX_SAFE_INTEGER - now).padStart(16, '0')}:${id}`
  const doc = {
    _id: storeKey, storeKey, id,
    type: entry.type === 'files' ? 'file' : entry.type,
    data: entry.type === 'image' ? `ztools-clip-image:${id}` : source,
    createTime: existing?.createTime ?? now, updateTime: now, collect: existing?.collect ?? false
  }
  const put = (key: string, value: unknown) => operations.push({ type: 'put', key, value: Buffer.from(JSON.stringify(value)) })
  if (entry.type === 'image') {
    // Same attachment documents as the plugin SDK; history queries never load image bytes.
    put(`attachment:clip-image:${id}`, { _id: `attachment:clip-image:${id}`, data: source.slice(source.indexOf(',') + 1) })
    put(`attachment_type:clip-image:${id}`, { _id: `attachment_type:clip-image:${id}`, type: 'image/png' })
  }
  put(storeKey, doc)
  put('meta:clipboard-indexed-history:v2', { ready: true, updateTime: now })
  await store.batch(operations, { sync: true })
}
