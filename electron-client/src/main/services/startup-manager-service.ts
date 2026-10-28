import { validateStartupRequest, type StartupRequest } from '../../contracts/startup-manager.js'
import { ZToolsError, errorCodes } from '../../contracts/errors.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { MacStartupReader, type StartupSnapshot } from './startup-reader.js'
import { StartupBackupStore } from './startup-backups.js'
import { StartupTransactions } from './startup-transactions.js'
import type { StartupWriter } from './startup-writer.js'

const owner = (c: CallerIdentity) => JSON.stringify([c.webContentsId, c.pluginId, c.pluginInstanceId, c.attributedPlugin?.sessionId])
interface StartupJob { owner: string; window: number; operationId: string; controller: AbortController; done: Promise<unknown> }
export class StartupManagerService {
  #job: StartupJob | null = null
  #closed = false
  #scans = new Map<string, { window: number; entries: StartupSnapshot[] }>()
  readonly #transactions: StartupTransactions
  constructor(private readonly backups: StartupBackupStore, private readonly settings: () => Promise<void>, writer: StartupWriter,
    private readonly reader = new MacStartupReader(), private readonly platform = process.platform) {
    this.#transactions = new StartupTransactions(reader, backups, writer)
  }
  closeOwner(window: number) {
    if (this.#job?.window === window) this.#job.controller.abort()
    for (const [key, scan] of this.#scans) if (scan.window === window) this.#scans.delete(key)
  }
  async stop() { this.#closed = true; this.#scans.clear(); this.#job?.controller.abort(); await Promise.allSettled(this.#job ? [this.#job.done] : []) }
  async #execute(request: Exclude<StartupRequest, { action: 'cancel' }>, caller: CallerIdentity, signal: AbortSignal) {
    const key = owner(caller)
    if (request.action === 'scan') {
      this.#scans.delete(key)
      const { result, snapshots } = await this.reader.scan(signal)
      const backups = await this.backups.list().catch(error => { result.warnings.push(`恢复记录读取失败：${String(error).slice(0, 700)}`); return [] })
      signal.throwIfAborted()
      if (this.#scans.size >= 8) this.#scans.delete(this.#scans.keys().next().value!)
      this.#scans.set(key, { window: caller.webContentsId, entries: snapshots })
      return { ...result, backups }
    }
    if (request.action === 'settings') { signal.throwIfAborted(); await this.settings(); return { success: true, accepted: true } }
    if (request.action === 'backups') return { success: true, backups: await this.backups.list() }
    if (request.action === 'restore') {
      try { return await this.#transactions.restore(await this.backups.load(request.id), signal) }
      finally { this.#scans.clear() }
    }
    if (request.action === 'set-enabled' || request.action === 'remove') {
      const item = this.#scans.get(key)?.entries.find(entry => entry.item.id === request.id)
      if (!item) throw new Error('请先在当前窗口扫描，再选择启动项操作')
      try { return request.action === 'set-enabled' ? await this.#transactions.toggle(item, request.enabled, signal) : await this.#transactions.remove(item, signal) }
      finally { this.#scans.clear() }
    }
    throw new Error('启动管理操作无效')
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try {
      validateStartupRequest(value); signal.throwIfAborted()
      if (this.#closed || this.platform !== 'darwin') throw new Error('Mac 启动管理服务不可用')
      const key = owner(caller)
      if (value.action === 'cancel') {
        const job = this.#job, matched = job?.owner === key && job.operationId === value.operationId
        if (job && matched) { job.controller.abort(); await Promise.allSettled([job.done]) }
        return { success: true, cancelled: matched }
      }
      if (this.#job) throw new Error('另一项启动管理操作尚未结束，请稍后重试')
      const controller = new AbortController(), abort = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(value.action === 'scan' ? 20000 : 100000)])
      const done = this.#execute(value, caller, abort)
      this.#job = { owner: key, window: caller.webContentsId, operationId: value.operationId, controller, done }
      try { return await done } finally { this.#job = null }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, (error instanceof Error ? error.message : String(error)).slice(0, 2000))
    }
  }
}
