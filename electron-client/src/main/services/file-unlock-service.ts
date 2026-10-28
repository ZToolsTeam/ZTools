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
const notice = '仅显示当前权限可见的占用；文件夹不跟随符号链接或跨越嵌套挂载卷。未发现占用不等于磁盘可安全弹出，请用 Finder 弹出。'
async function targetIdentity(file: string) {
  const stat = await fs.lstat(file)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('只能检测普通文件或文件夹，不能操作符号链接、硬链接或特殊文件')
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
    if (errors.length) throw new AggregateError(errors, '部分文件访问组件退出未确认，已保留记录以便重试清理')
  }
  async #discard(session: Session) {
    session.expires = 0; clearTimeout(session.timer); await this.#releaseAdapter(session.adapter)
  }
  #expiry(session: Session) {
    session.timer = setTimeout(() => {
      if (this.#active?.key === session.key) { this.#expiry(session); return }
      void this.#discard(session).catch(error => console.error('文件解锁会话清理失败', error))
    }, Math.max(1000, session.expires - Date.now()))
    session.timer.unref()
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    validateFileUnlockRequest(value); signal.throwIfAborted()
    if (this.#stopped) throw new Error('文件解锁服务已停止')
    if (value.action === 'info') return { success: true, platform: this.platform }
    if (this.platform !== 'darwin') throw new Error('此占用检测入口仅用于 macOS')
    const key = keyOf(caller)
    if (value.action === 'cancel' || value.action === 'close') {
      const active = this.#active
      if (active?.key === key) { active.controller.abort(); await active.promise.catch(error => console.warn('文件解锁取消后结束', message(error))) }
      if (value.action === 'close') for (const session of [...this.#sessions.values()]) if (session.key === key) await this.#discard(session)
      return { success: true, cancelRequested: active?.key === key }
    }
    if (this.#active) throw new Error('文件解锁正在操作，请稍候')
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
        normalized === home || home.startsWith(normalized + '/')) return '系统关键目录、用户主目录和资源库不能在此改名或回收'
    for (const root of this.protectedRoots) {
      let resolved: string
      try { resolved = await fs.realpath(root) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; resolved = path.resolve(root) }
      const canonical = resolved.normalize('NFC').toLowerCase()
      if (within(canonical) || canonical.startsWith(normalized + '/')) return '客户端安装目录和数据目录不能在此改名或回收'
    }
    if ((await fs.stat(path.dirname(file))).dev !== dev || /^\/Volumes\/[^/]+\/?$/i.test(file)) return '磁盘根目录不能改名或回收，请在 Finder 中弹出磁盘'
    return ''
  }
  async #assertTarget(session: Session, caller: CallerIdentity, access: 'read' | 'write', signal: AbortSignal) {
    signal.throwIfAborted()
    if (await this.authorize(session.path, caller, access) !== session.path || (await targetIdentity(session.path)).identity !== session.identity) throw new Error('目标文件已被替换或授权发生变化，请重新检测')
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
    if (this.#sessions.size >= 8) throw new Error('检测窗口过多，请关闭其他文件解锁窗口')
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
      catch (cleanupError) { throw new AggregateError([error, cleanupError], '检测失败且文件访问组件退出未确认，已保留清理记录') }
      throw error
    }
  }
  async #terminate(session: Session, request: Extract<FileUnlockRequest, { action: 'terminate' }>, caller: CallerIdentity, signal: AbortSignal) {
    const selected = request.pids.map(pid => session.processes.find(row => row.pid === pid))
    if (selected.some(row => !row || row.protected || !row.identity)) throw new Error('清单包含不存在或受保护的进程，请重新扫描')
    const terminated: number[] = [], failures: Array<{ pid: number; message: string }> = []
    for (const row of selected as InspectedLock[]) {
      try {
        await this.processes.terminatePid({ pid: row.pid, mode: request.mode, tree: false, expectedName: row.name, timeoutMs: 3000 }, signal, async pid => {
          if (pid !== row.pid) throw new Error('待结束进程发生变化')
          await this.#assertTarget(session, caller, 'read', signal)
          const holders = await this.locks.scan(session.path, session.directory, signal, session.adapter.ownedProcessId, pid)
          const current = holders.find(item => item.pid === pid)
          if (!current?.identity || current.protected || !sameMacProcess(row.identity!, current.identity)) throw new Error('进程身份或文件占用已变化，未发送结束信号，请刷新')
          const last = await this.locks.identity(pid, signal)
          if (!last || !sameMacProcess(row.identity!, last)) throw new Error('进程身份已变化，未发送结束信号')
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
    if (!('sessionId' in request)) throw new Error('文件解锁操作无效')
    const session = this.#sessions.get(request.sessionId)
    if (!session || session.key !== key || session.expires < Date.now()) throw new Error('检测结果已过期，请重新扫描')
    if (request.action === 'terminate') return this.#terminate(session, request, caller, signal)
    if (session.blocked) throw new Error(session.blocked)
    await this.#refresh(session, caller, signal)
    if (session.processes.length) throw new Error('仍检测到占用，保留原文件；请先结束占用或关闭相关程序')
    await this.#assertTarget(session, caller, 'write', signal)
    const blocked = await this.#blocked(session.path, (await fs.lstat(session.path)).dev)
    if (blocked) throw new Error(blocked)
    signal.throwIfAborted()
    // 一旦进入系统文件操作，不将取消当作撤销；留出独立时间完成与核验。
    try {
      const commitSignal = AbortSignal.timeout(30000)
      if (request.action === 'trash') {
        if (!session.adapter.trash) throw new Error('安全回收组件不可用')
        await session.adapter.trash(session.object, commitSignal)
        return { success: true, status: 'trashed', targetPath: session.path }
      }
      if (!session.adapter.rename) throw new Error('安全改名组件不可用')
      await session.adapter.rename(session.object, request.name, commitSignal)
      const renamedPath = path.join(path.dirname(session.path), request.name)
      if ((await targetIdentity(renamedPath)).identity !== session.identity) throw new Error('改名结果未确认，请检查原文件名与新文件名')
      return { success: true, status: 'renamed', targetPath: renamedPath }
    } finally { await this.#discard(session) }
  }
}
