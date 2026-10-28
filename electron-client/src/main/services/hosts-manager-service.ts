import { ZToolsError, errorCodes } from '../../contracts/errors.js'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { validateHostsRequest, type HostsRequest, type HostsSnapshot } from '../../contracts/hosts-manager.js'
import type { HostsProvider } from './hosts-provider.js'
import { HostsBackups } from './hosts-backups.js'
interface Owned { owner: string; created: number; snapshot: HostsSnapshot }
interface Plan extends Owned { content: string }
const owner = (caller: CallerIdentity) => JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId])
const failure = (error: unknown) => error instanceof Error ? error.message : String(error)
export class HostsManagerService {
  #sessions = new Map<string, Owned>(); #plans = new Map<string, Plan>()
  #active: { owner: string; window: number; controller: AbortController; promise: Promise<unknown> } | undefined
  #stopped = false
  constructor(private readonly provider: HostsProvider, private readonly backups: HostsBackups, private readonly platform: NodeJS.Platform = process.platform) {}
  async stop() { this.#stopped = true; this.#active?.controller.abort(); await this.#active?.promise.catch(error => console.warn('Hosts 操作结束', failure(error))); this.#sessions.clear(); this.#plans.clear() }
  closeOwner(window: number) {
    if (this.#active?.window === window) this.#active.controller.abort()
    for (const map of [this.#sessions, this.#plans]) for (const [id, value] of map) if (JSON.parse(value.owner)[0] === window) map.delete(id)
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try { return await this.#handle(value, caller, signal) }
    catch (error) { throw new ZToolsError(errorCodes.nativeHostError, failure(error).slice(0, 2000)) }
  }
  async #handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    validateHostsRequest(value); signal.throwIfAborted()
    if (this.#stopped || this.platform !== 'darwin') throw new Error('Hosts 安全管理服务不可用')
    const key = owner(caller)
    if (value.action === 'cancel') {
      for (const [id, plan] of this.#plans) if (plan.owner === key) this.#plans.delete(id)
      const active = this.#active
      if (active?.owner === key) { active.controller.abort(); await active.promise.catch(error => console.warn('Hosts 取消后结束', failure(error))) }
      return { success: true }
    }
    if (this.#active) throw new Error('Hosts 操作正在进行，请稍候')
    for (const map of [this.#sessions, this.#plans]) for (const [id, value] of map) if (Date.now() - value.created > 300000) map.delete(id)
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(110000)])
    const promise = this.#execute(value, key, combined)
    this.#active = { owner: key, window: caller.webContentsId, controller, promise }
    try { return await promise } finally { this.#active = undefined }
  }
  async #read(key: string, signal: AbortSignal) {
    const snapshot = await this.provider.read(signal), backups = await this.backups.list()
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('Hosts 服务已停止')
    for (const [id, value] of this.#sessions) if (value.owner === key) this.#sessions.delete(id)
    if (this.#sessions.size >= 32) throw new Error('Hosts 会话过多')
    const sessionId = randomUUID(); this.#sessions.set(sessionId, { owner: key, created: Date.now(), snapshot })
    return { success: true, sessionId, ...snapshot, backups }
  }
  async #current(snapshot: HostsSnapshot, signal: AbortSignal) {
    const current = await this.provider.read(signal)
    if (current.identity !== snapshot.identity || current.revision !== snapshot.revision) throw new Error('系统 Hosts 已被其他程序修改，请重新读取')
  }
  async #execute(value: Exclude<HostsRequest, { action: 'cancel' }>, key: string, signal: AbortSignal): Promise<unknown> {
    if (value.action === 'read') return this.#read(key, signal)
    if (value.action === 'flush') { await this.provider.flush(signal); return { success: true, flushed: true } }
    if (value.action === 'prepare' || value.action === 'restore') {
      const session = this.#sessions.get(value.sessionId)
      if (!session || session.owner !== key) throw new Error('Hosts 读取结果过期，请重新读取')
      await this.#current(session.snapshot, signal)
      let content: string
      if (value.action === 'restore') {
        const backup = await this.backups.load(value.backupId)
        if (session.snapshot.content !== backup.after) throw new Error('系统内容已不再匹配此备份的写入结果，停止恢复以保留后续修改')
        content = backup.before
      } else content = value.content
      signal.throwIfAborted()
      if (this.#stopped) throw new Error('Hosts 服务已停止')
      if (content === session.snapshot.content) throw new Error('Hosts 内容没有变化')
      for (const [id, plan] of this.#plans) if (plan.owner === key) this.#plans.delete(id)
      if (this.#plans.size >= 32) throw new Error('Hosts 待确认操作过多')
      const planId = randomUUID(); this.#plans.set(planId, { ...session, created: Date.now(), content })
      return { success: true, planId, before: session.snapshot.content, content, path: session.snapshot.path }
    }
    if (value.action !== 'apply') throw new Error('Hosts 操作无效')
    const plan = this.#plans.get(value.planId)
    if (!plan || plan.owner !== key) throw new Error('Hosts 写入计划已过期，请重新预览')
    this.#plans.delete(value.planId)
    await this.#current(plan.snapshot, signal)
    const backup = await this.backups.save(plan.snapshot.content, plan.content)
    signal.throwIfAborted()
    try {
      const result = await this.provider.write(plan.snapshot, plan.content, signal)
      const verified = await this.provider.read(AbortSignal.timeout(10000))
      if (verified.content !== plan.content) throw new Error('系统 Hosts 写入后内容不一致，请重新读取')
      // 写入已提交，DNS 失败不能伪装成 hosts 未写入；取消后也不再开始新操作。
      let dnsError = ''
      if (signal.aborted) dnsError = '操作已取消，Hosts 已写入；未刷新 DNS'
      else { try { await this.provider.flush(signal) } catch (error) { dnsError = failure(error) } }
      return { success: true, written: true, dnsFlushed: !dnsError, dnsError, backupId: backup.id, recoveryPath: result.recoveryPath }
    } catch (error) { throw new Error(`${failure(error)}；原内容备份 ${backup.id} 已保留，请重新读取后核对`) }
    finally { for (const [id, session] of this.#sessions) if (session.owner === key) this.#sessions.delete(id) }
  }
}
