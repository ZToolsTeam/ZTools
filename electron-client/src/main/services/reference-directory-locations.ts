import type { CallerIdentity } from '../../contracts/capabilities.js'
import { grantId, type PathGrantRef } from '../../contracts/path-reference.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PathGrantService, PathGrantOwnerLifecycle } from './path-grant-service.js'

const denied = () => new ZToolsError(errorCodes.permissionDenied, '目录引用无效或已撤销')

/** SDK current-directory state is an owner-bound directory reference, never the process cwd or a path. */
export class ReferenceDirectoryLocations {
  readonly #current = new Map<number, string>()
  readonly #setting = new Map<number, symbol>()
  readonly #removeListener: () => void
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'reference' | 'describe'>,
    private readonly owners: PathGrantOwnerLifecycle) {
    this.#removeListener = owners.onRemoved(owner => { this.#current.delete(owner); this.#setting.delete(owner) })
  }

  async setCurrentDirectory(value: unknown, caller: CallerIdentity, signal?: AbortSignal): Promise<{ success: true }> {
    this.#assertOwner(caller)
    const id = grantId(value)
    this.#directory(caller.webContentsId, id)
    if (signal?.aborted || this.#setting.has(caller.webContentsId) ||
        new Set([...this.#current.keys(), ...this.#setting.keys(), caller.webContentsId]).size > 256) throw denied()
    const token = Symbol('setting')
    this.#setting.set(caller.webContentsId, token)
    try {
      const metadata = await this.grants.describe(caller.webContentsId, id, signal)
      this.#assertOwner(caller)
      if (signal?.aborted || !metadata.isDirectory || this.#setting.get(caller.webContentsId) !== token) throw denied()
      this.#directory(caller.webContentsId, id)
      this.#current.set(caller.webContentsId, id)
      return { success: true }
    } finally { if (this.#setting.get(caller.webContentsId) === token) this.#setting.delete(caller.webContentsId) }
  }

  getCurrentDirectory(caller: CallerIdentity): { success: true; reference: PathGrantRef | null } {
    this.#assertOwner(caller)
    const id = this.#current.get(caller.webContentsId)
    if (!id) return { success: true, reference: null }
    try { return { success: true, reference: this.#directory(caller.webContentsId, id) } }
    catch (error) { this.#current.delete(caller.webContentsId); throw error }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true; this.#removeListener(); this.#current.clear(); this.#setting.clear()
  }
  #directory(owner: number, id: string): PathGrantRef {
    const ref = this.grants.reference(owner, id)
    if (ref.kind !== 'directory' || !ref.operations.includes('read') || !ref.operations.includes('list')) throw denied()
    return ref
  }
  #assertOwner(caller: CallerIdentity): void {
    if (this.#stopped || !['main', 'plugin'].includes(caller.type) || !Number.isSafeInteger(caller.webContentsId) ||
        caller.webContentsId <= 0 || !this.owners.isActive(caller.webContentsId)) throw denied()
  }
}
