import type { AnchoredPathObject, PathAccessAdapter } from './path-access.js'
import type { SealedJournalStore } from './path-write-journal.js'

/** Separate main-owned adapter and private root; never share Renderer grants or enable journaling recursively. */
export class AnchoredJournalStore implements SealedJournalStore {
  constructor(private readonly adapter: PathAccessAdapter, private readonly root: AnchoredPathObject) {
    if (root.kind !== 'directory') throw new Error('PATH_WRITE_JOURNAL_ROOT_INVALID')
  }
  async read(): Promise<Buffer | undefined> {
    const signal = new AbortController().signal
    const entry = (await this.adapter.list(this.root, [], signal)).find(item => item.name === 'file-write-journal.bin')
    if (!entry) return undefined
    if (entry.isDirectory || entry.size > 4 * 1024 * 1024) throw new Error('PATH_WRITE_JOURNAL_INVALID')
    const file = await this.adapter.deriveRead(this.root, ['file-write-journal.bin'], signal)
    try { return await this.adapter.read(file, [], 4 * 1024 * 1024, signal) }
    finally { await this.adapter.release(file) }
  }
  async replace(bytes: Buffer): Promise<void> {
    const signal = new AbortController().signal
    const destination = await this.adapter.deriveSave(this.root, ['file-write-journal.bin'], signal)
    try { await this.adapter.save(destination, bytes, true, signal) }
    finally { await this.adapter.release(destination) }
  }
}
