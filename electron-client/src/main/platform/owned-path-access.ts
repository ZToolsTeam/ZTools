import type { PathAccessAdapter, PathAccessProvider } from './path-access.js'
import { NativePathAccessAdapter } from './native-path-access.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PathWriteJournal } from './path-write-journal.js'

/** Each trusted WebContents gets its own native generation; cancelling it cannot kill another owner. */
export class OwnedPathAccessProvider implements PathAccessProvider {
  readonly #adapters = new Map<number, PathAccessAdapter>()
  readonly #closing = new Map<number, Promise<void>>()
  #stopping?: Promise<void>
  constructor(readonly platform: 'win32' | 'darwin', private readonly create: () => PathAccessAdapter) {
    if (!['win32', 'darwin'].includes(platform)) throw new ZToolsError(errorCodes.notSupported, 'Unsupported platform for native file access')
  }
  forOwner(owner: number): PathAccessAdapter {
    if (!Number.isSafeInteger(owner) || owner <= 0 || this.#stopping || this.#closing.has(owner)) throw new ZToolsError(errorCodes.permissionDenied, 'File authorization owner is closed')
    const existing = this.#adapters.get(owner)
    if (existing) return existing
    if (this.#adapters.size >= 32) throw new ZToolsError(errorCodes.fileError, 'Native file owner concurrency limit reached')
    const adapter = this.create()
    this.#adapters.set(owner, adapter)
    if (adapter.platform !== this.platform) {
      void this.closeOwner(owner).catch(() => {})
      throw new ZToolsError(errorCodes.fileError, 'Native file platform mismatch')
    }
    return adapter
  }
  closeOwner(owner: number): Promise<void> {
    const closing = this.#closing.get(owner)
    if (closing) return closing
    const adapter = this.#adapters.get(owner)
    const operation = Promise.resolve().then(() => adapter?.stop()).then(() => { this.#adapters.delete(owner) })
    this.#closing.set(owner, operation)
    return operation
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#stopping = (async () => {
      const results = await Promise.allSettled([...this.#adapters.keys()].map(owner => this.closeOwner(owner)).concat([...this.#closing.values()]))
      if (results.some(result => result.status === 'rejected')) throw new ZToolsError(errorCodes.fileError, 'Native file owner shutdown was not confirmed')
    })()
    return this.#stopping
  }
}

/** executable is resolved by trusted main from the built/packaged native directory only. */
export function createOwnedPathAccessProvider(executable: string, platform: 'win32' | 'darwin', timeoutMs = 5000,
  writeJournal?: PathWriteJournal): OwnedPathAccessProvider {
  return new OwnedPathAccessProvider(platform, () => new NativePathAccessAdapter(executable, timeoutMs, writeJournal ? { writeJournal } : {}))
}
