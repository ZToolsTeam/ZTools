import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PathGrantRef } from '../../contracts/path-reference.js'
import type { PathGrantService, PathGrantOwnerLifecycle } from '../services/path-grant-service.js'

type Grants = Pick<PathGrantService, 'create' | 'createDirectory' | 'deriveDirectory' | 'reference' | 'revoke'>
interface Root { caller: CallerIdentity; parentId: string; reference: PathGrantRef }
interface Pending { caller: CallerIdentity; controller: AbortController; work: Promise<PathGrantRef> }
const denied = () => new ZToolsError(errorCodes.permissionDenied, '缓存目录身份无效')
const failed = () => new ZToolsError(errorCodes.fileError, '缓存目录授权清理未确认')

/** Trusted Main composition only. The data root and intermediate grants are never projected to Renderer. */
export class ReferenceCacheRoots {
  readonly #roots = new Map<number, Root>()
  readonly #pending = new Map<number, Pending>()
  readonly #unlisten: () => void
  #stopped = false
  #cleanupFailed = false
  #stopping?: Promise<void>
  constructor(private readonly dataRoot: string, platform: 'win32' | 'darwin', private readonly grants: Grants,
    private readonly owners: PathGrantOwnerLifecycle & { get(owner: number): CallerIdentity | undefined }, private readonly cleanupMs = 10_000) {
    const paths = platform === 'win32' ? path.win32 : path.posix
    if (!['win32', 'darwin'].includes(platform) || !paths.isAbsolute(dataRoot) || dataRoot.includes('\0') ||
        Buffer.byteLength(dataRoot) > 4096 || !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 30_000) throw denied()
    this.#unlisten = owners.onRemoved(owner => {
      this.#pending.get(owner)?.controller.abort(); this.#roots.delete(owner)
      // PathGrantService uses this same owner lifecycle and closes every owned ancestor/child grant.
    })
  }

  async rootForCaller(caller: CallerIdentity, signal?: AbortSignal): Promise<PathGrantRef> {
    this.#assert(caller)
    if (signal?.aborted) throw denied()
    const known = this.#roots.get(caller.webContentsId)
    if (known) {
      this.#same(known.caller, caller)
      return this.grants.reference(caller.webContentsId, known.reference.grantId)
    }
    let pending = this.#pending.get(caller.webContentsId)
    if (pending) this.#same(pending.caller, caller)
    else {
      if (new Set([...this.#roots.keys(), ...this.#pending.keys()]).size >= 32) throw denied()
      const controller = new AbortController(), snapshot = Object.freeze({ ...caller })
      const work = this.#create(snapshot, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      pending = { caller: snapshot, controller, work }; this.#pending.set(caller.webContentsId, pending)
      const record = pending
      void work.then(() => { if (this.#pending.get(caller.webContentsId) === record) this.#pending.delete(caller.webContentsId) },
        () => { if (this.#pending.get(caller.webContentsId) === record) this.#pending.delete(caller.webContentsId) })
    }
    const root = await pending.work
    this.#assert(caller)
    if (signal?.aborted) throw denied()
    return root
  }

  async #create(caller: CallerIdentity, signal: AbortSignal): Promise<PathGrantRef> {
    let parent: PathGrantRef | undefined
    try {
      parent = await this.grants.create(caller.webContentsId, this.dataRoot, 'directory', ['read', 'write', 'list'], signal)
      let directory = parent
      const segments = caller.type === 'main' ? ['ReferenceCache', 'main'] : ['ReferenceCache', 'plugins', caller.pluginId!]
      for (const segment of segments) {
        this.#assert(caller)
        await this.grants.createDirectory(caller.webContentsId, directory.grantId, segment, signal)
        directory = await this.grants.deriveDirectory(caller.webContentsId, directory.grantId, segment, signal)
      }
      this.#assert(caller)
      if (signal.aborted) throw denied()
      this.#roots.set(caller.webContentsId, { caller, parentId: parent.grantId, reference: directory })
      return directory
    } catch (error) {
      // Owner teardown already closes all of its grants; otherwise close only this factory's private parent chain.
      if (parent && this.owners.isActive(caller.webContentsId)) {
        try { await this.grants.revoke(caller.webContentsId, parent.grantId) }
        catch { this.#cleanupFailed = true; throw failed() }
      }
      throw error
    }
  }
  #same(expected: CallerIdentity, actual: CallerIdentity): void {
    if (expected.webContentsId !== actual.webContentsId || expected.type !== actual.type ||
        expected.pluginId !== actual.pluginId || expected.pluginInstanceId !== actual.pluginInstanceId) throw denied()
  }
  #assert(caller: CallerIdentity): void {
    if (this.#stopped || !Number.isSafeInteger(caller.webContentsId) || caller.webContentsId <= 0 || !this.owners.isActive(caller.webContentsId)) throw denied()
    const current = this.owners.get(caller.webContentsId)
    if (!current) throw denied()
    this.#same(current, caller)
    if (caller.type === 'plugin') {
      if (!caller.pluginId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(caller.pluginId) || !caller.pluginInstanceId) throw denied()
    } else if (caller.type !== 'main') throw denied()
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#stopped = true; this.#unlisten()
    const pending = [...this.#pending.values()]
    for (const item of pending) item.controller.abort()
    this.#stopping = (async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        const drain = (async () => {
          await Promise.allSettled(pending.map(item => item.work))
          const roots = [...this.#roots.values()]; this.#roots.clear()
          const cleanup = await Promise.allSettled(roots.filter(root => this.owners.isActive(root.caller.webContentsId))
            .map(root => this.grants.revoke(root.caller.webContentsId, root.parentId)))
          if (this.#cleanupFailed || cleanup.some(result => result.status === 'rejected')) throw failed()
        })()
        await Promise.race([drain, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failed()), this.cleanupMs)
        })])
      } finally { if (timer) clearTimeout(timer) }
    })()
    return this.#stopping
  }
}
