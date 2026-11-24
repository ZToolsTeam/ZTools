import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { validateFileUnlockRequest, type FileUnlockRequest, type FileLockSnapshot } from '../../contracts/file-unlock.js'
import type { AnchoredPathObject, PathAccessAdapter } from '../platform/path-access.js'
import type { ProcessService } from './process-service.js'
import { isProtectedSystemPath } from './host-plugins/shared-utils.js'
import { MacFileLocks, sameMacProcess, type InspectedLock } from './mac-file-locks.js'

interface Session {
  id: string; key: string; window: number; path: string; identity: string; directory: boolean
  adapter: PathAccessAdapter; object: AnchoredPathObject; processes: InspectedLock[]; blocked: string
  expires: number; timer?: ReturnType<typeof setTimeout>
}
const keyOf = (caller: CallerIdentity) => JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId])
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const notice = 'Only locks visible under current permissions are shown; folder scans do not follow symlinks or cross nested mount volumes. No locks found does not guarantee a volume can be safely ejected; eject volumes in Finder.'
async function targetIdentity(file: string) {
  const stat = await fs.lstat(file)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('Only regular files or directories can be inspected; symbolic links, hard links, and special files are not supported')
  return { identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.isDirectory()}`, directory: stat.isDirectory(), dev: stat.dev }
}
export class FileUnlockService {
  #sessions = new Map<string, Session>()
  #ownedAdapters = new Map<PathAccessAdapter, number>()
  #active: { key: string; window: number; controller: AbortController; promise: Promise<unknown> } | undefined
  #stopped = false
  constructor(private readonly authorize: (file: string, caller: CallerIdentity, access: 'read' | 'write') => Promise<string>,
    private readonly makeAdapter: () => PathAccessAdapter, private readonly processes: Pick<ProcessService, 'terminatePid'>,
    private readonly locks = new MacFileLocks(), private readonly protectedRoots: readonly string[] = [],
    private readonly platform: NodeJS.Platform = process.platform) {}
  async stop() {
    this.#stopped = true; this.#active?.controller.abort()
    await this.#active?.promise.catch(error => console.warn('文件解锁停止', message(error)))
    await this.#releaseAll()
  }
  async closeOwner(window: number) {
    const active = this.#active
    if (active?.window === window) { active.controller.abort(); await active.promise.catch(error => console.warn('文件解锁窗口关闭', message(error))) }
    await this.#releaseAll(window)
  }
  async #releaseAdapter(adapter: PathAccessAdapter) {
    await adapter.stop()
    this.#ownedAdapters.delete(adapter)
    for (const session of [...this.#sessions.values()]) if (session.adapter === adapter) {
      clearTimeout(session.timer); this.#sessions.delete(session.id)
    }
  }
  async #releaseAll(window?: number) {
    const adapters = [...this.#ownedAdapters].filter(([, owner]) => window === undefined || owner === window).map(([adapter]) => adapter)
    for (const session of this.#sessions.values()) if (adapters.includes(session.adapter)) { session.expires = 0; clearTimeout(session.timer) }
    const results = await Promise.allSettled(adapters.map(adapter => this.#releaseAdapter(adapter)))
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    if (errors.length) throw new AggregateError(errors, 'Some file access helper exits were not confirmed; records were retained for retry cleanup')
  }
  async #discard(session: Session) {
    session.expires = 0; clearTimeout(session.timer); await this.#releaseAdapter(session.adapter)
  }
  #expiry(session: Session) {
    session.timer = setTimeout(() => {
      if (this.#active?.key === session.key) { this.#expiry(session); return }
      void this.#discard(session).catch(error => console.error('Failed to clean up file unlock session', error))
    }, Math.max(1000, session.expires - Date.now()))
    session.timer.unref()
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    validateFileUnlockRequest(value); signal.throwIfAborted()
    if (this.#stopped) throw new Error('File unlock service is stopped')
    if (value.action === 'info') return { success: true, platform: this.platform }
    if (this.platform !== 'darwin') throw new Error('This file lock inspection endpoint is only available on macOS')
    const key = keyOf(caller)
    if (value.action === 'cancel' || value.action === 'close') {
      const active = this.#active
      if (active?.key === key) { active.controller.abort(); await active.promise.catch(error => console.warn('File unlock operation ended after cancel', message(error))) }
      if (value.action === 'close') for (const session of [...this.#sessions.values()]) if (session.key === key) await this.#discard(session)
      return { success: true, cancelRequested: active?.key === key }
    }
    if (this.#active) throw new Error('A file unlock operation is already in progress; try again shortly')
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(90000)])
    const promise = this.#execute(value, caller, key, combined)
    this.#active = { key, window: caller.webContentsId, controller, promise }
    try { return await promise } finally { this.#active = undefined }
  }
  async #blocked(file: string, dev: number) {
    const normalized = file.normalize('NFC').toLowerCase(), home = (await fs.realpath(os.homedir())).normalize('NFC').toLowerCase()
    const within = (root: string) => normalized === root || normalized.startsWith(root + path.sep)
    if (isProtectedSystemPath(file) || ['/', '/volumes', '/users', '/applications', '/library', '/private', '/dev'].includes(normalized) ||
        ['/system', '/usr', '/bin', '/sbin', '/private/etc', '/private/var/db', '/library', '/dev', home + '/library'].some(within) ||
        normalized === home || home.startsWith(normalized + '/')) return 'System critical directories, user home directory, and Library cannot be renamed or trashed here'
    for (const root of this.protectedRoots) {
      let resolved: string
      try { resolved = await fs.realpath(root) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; resolved = path.resolve(root) }
      const canonical = resolved.normalize('NFC').toLowerCase()
      if (within(canonical) || canonical.startsWith(normalized + '/')) return 'Client installation and data directories cannot be renamed or trashed here'
    }
    if ((await fs.stat(path.dirname(file))).dev !== dev || /^\/Volumes\/[^/]+\/?$/i.test(file)) return 'Volume root directories cannot be renamed or trashed; eject the disk in Finder'
    return ''
  }
  async #assertTarget(session: Session, caller: CallerIdentity, access: 'read' | 'write', signal: AbortSignal) {
    signal.throwIfAborted()
    if (await this.authorize(session.path, caller, access) !== session.path || (await targetIdentity(session.path)).identity !== session.identity) throw new Error('Target file was replaced or authorization changed; inspect again')
    await session.adapter.describe(session.object, signal)
  }
  #snapshot(session: Session): FileLockSnapshot {
    return { success: true, sessionId: session.id, targetPath: session.path, isDirectory: session.directory,
      processes: session.processes.map(({ identity: _identity, ...row }) => row), notice, mutationBlockedReason: session.blocked }
  }
  async #refresh(session: Session, caller: CallerIdentity, signal: AbortSignal) {
    await this.#assertTarget(session, caller, 'read', signal)
    const rows = await this.locks.scan(session.path, session.directory, signal, session.adapter.ownedProcessId)
    await this.#assertTarget(session, caller, 'read', signal)
    session.processes = rows
    return this.#snapshot(session)
  }
  async #inspect(file: string, caller: CallerIdentity, key: string, signal: AbortSignal) {
    for (const session of [...this.#sessions.values()]) if (session.key === key) await this.#discard(session)
    if (this.#sessions.size >= 8) throw new Error('Too many active file unlock inspection windows; close another window first')
    // 允许 /tmp 等系统别名，但选中的末级不能是符号链接。
    await targetIdentity(file)
    const canonical = await fs.realpath(await this.authorize(file, caller, 'read')), before = await targetIdentity(canonical)
    const adapter = this.makeAdapter()
    this.#ownedAdapters.set(adapter, caller.webContentsId)
    try {
      const object = await adapter.pin(canonical, before.directory ? 'directory' : 'file', ['read'], signal)
      const session: Session = { id: randomUUID(), key, window: caller.webContentsId, path: canonical, identity: before.identity,
        directory: before.directory, object, adapter, processes: [], blocked: await this.#blocked(canonical, before.dev), expires: Date.now() + 300000 }
      const snapshot = await this.#refresh(session, caller, signal)
      signal.throwIfAborted(); this.#sessions.set(session.id, session); this.#expiry(session)
      return snapshot
    } catch (error) {
      try { await this.#releaseAdapter(adapter) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Inspection failed and file access helper exit was not confirmed; cleanup record retained') }
      throw error
    }
  }
  async #terminate(session: Session, request: Extract<FileUnlockRequest, { action: 'terminate' }>, caller: CallerIdentity, signal: AbortSignal) {
    const selected = request.pids.map(pid => session.processes.find(row => row.pid === pid))
    if (selected.some(row => !row || row.protected || !row.identity)) throw new Error('Selection contains non-existent or protected processes; scan again')
    const terminated: number[] = [], failures: Array<{ pid: number; message: string }> = []
    for (const row of selected as InspectedLock[]) {
      try {
        await this.processes.terminatePid({ pid: row.pid, mode: request.mode, tree: false, expectedName: row.name, timeoutMs: 3000 }, signal, async pid => {
          if (pid !== row.pid) throw new Error('Target process to terminate changed')
          await this.#assertTarget(session, caller, 'read', signal)
          const holders = await this.locks.scan(session.path, session.directory, signal, session.adapter.ownedProcessId, pid)
          const current = holders.find(item => item.pid === pid)
          if (!current?.identity || current.protected || !sameMacProcess(row.identity!, current.identity)) throw new Error('Process identity or file lock changed; termination signal was not sent; refresh and retry')
          const last = await this.locks.identity(pid, signal)
          if (!last || !sameMacProcess(row.identity!, last)) throw new Error('Process identity changed; termination signal was not sent')
        })
        terminated.push(row.pid)
      } catch (error) { failures.push({ pid: row.pid, message: message(error) }); break }
    }
    try { return { success: failures.length === 0, terminated, failures, snapshot: await this.#refresh(session, caller, AbortSignal.timeout(25000)), refreshError: '' } }
    catch (error) { await this.#discard(session); return { success: false, terminated, failures, refreshError: message(error) } }
  }
  async #execute(request: FileUnlockRequest, caller: CallerIdentity, key: string, signal: AbortSignal): Promise<unknown> {
    if (request.action === 'drives') return { success: true, drives: await this.locks.drives(signal) }
    if (request.action === 'inspect') return this.#inspect(request.targetPath, caller, key, signal)
    if (!('sessionId' in request)) throw new Error('Invalid file unlock action')
    const session = this.#sessions.get(request.sessionId)
    if (!session || session.key !== key || session.expires < Date.now()) throw new Error('Inspection result has expired; scan again')
    if (request.action === 'terminate') return this.#terminate(session, request, caller, signal)
    if (session.blocked) throw new Error(session.blocked)
    await this.#refresh(session, caller, signal)
    if (session.processes.length) throw new Error('File is still locked; original file preserved. Terminate locking processes or close related apps first')
    await this.#assertTarget(session, caller, 'write', signal)
    const blocked = await this.#blocked(session.path, (await fs.lstat(session.path)).dev)
    if (blocked) throw new Error(blocked)
    signal.throwIfAborted()
    // 一旦进入系统文件操作，不将取消当作撤销；留出独立时间完成与核验。
    try {
      const commitSignal = AbortSignal.timeout(30000)
      if (request.action === 'trash') {
        if (!session.adapter.trash) throw new Error('Safe trash helper is unavailable')
        await session.adapter.trash(session.object, commitSignal)
        return { success: true, status: 'trashed', targetPath: session.path }
      }
      if (!session.adapter.rename) throw new Error('Safe rename helper is unavailable')
      await session.adapter.rename(session.object, request.name, commitSignal)
      const renamedPath = path.join(path.dirname(session.path), request.name)
      if ((await targetIdentity(renamedPath)).identity !== session.identity) throw new Error('Rename result could not be confirmed; check original and new file names')
      return { success: true, status: 'renamed', targetPath: renamedPath }
    } finally { await this.#discard(session) }
  }
}
