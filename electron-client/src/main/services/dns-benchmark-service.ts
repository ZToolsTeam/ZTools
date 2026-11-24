import { validateDnsRequest, type DnsNetworkService, type DnsRequest } from '../../contracts/dns-benchmark.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { ZToolsError, errorCodes } from '../../contracts/errors.js'
import { DnsBackupStore } from './dns-backup-store.js'
import { MacDnsNetworkProvider, type DnsNetworkProvider } from './dns-network-provider.js'
import { benchmarkDnsServers, DNS_PROBE_DOMAIN } from './dns-resolver-probe.js'
import { DnsWriteOutcomeUnknownError } from './dns-write-command.js'

type Mutation = Extract<DnsRequest, { service: string }>
function same(a: string[], b: string[]) { return a.length === b.length && a.every((v, i) => v === b[i]) }
function owner(caller: CallerIdentity) { return JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId]) }
function failure(error: unknown) { return error instanceof Error ? error.message : String(error) }
export class DnsBenchmarkService {
  #tasks = new Map<string, { owner: string; controller: AbortController; promise: Promise<unknown> }>()
  #mutation: Promise<unknown> | undefined
  #mutationTask: { operationId: string; owner: string; controller: AbortController } | undefined
  #stopped = false
  constructor(private readonly backups: DnsBackupStore, private readonly provider: DnsNetworkProvider = new MacDnsNetworkProvider(), private readonly platform = process.platform) {}
  async stop() {
    this.#stopped = true
    this.#mutationTask?.controller.abort(new Error('DNS service has stopped'))
    for (const task of this.#tasks.values()) task.controller.abort(new Error('DNS operation stopped'))
    await Promise.allSettled([...this.#tasks.values()].map(v => v.promise))
    await this.#mutation
  }
  async #list(signal: AbortSignal): Promise<DnsNetworkService[]> {
    const services = await this.provider.list(signal)
    for (const service of services) {
      const backup = await this.backups.latest(service.name)
      if (backup && backup.device === service.device) service.backup = { id: backup.id, servers: backup.servers, createdAt: backup.createdAt }
    }
    return services
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try { return await this.#handle(value, caller, signal) }
    catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, failure(error).slice(0, 2000))
    }
  }
  async #handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    validateDnsRequest(value); signal.throwIfAborted()
    if (this.#stopped) throw new Error('DNS service has stopped')
    if (this.platform !== 'darwin') throw new Error('This DNS configuration channel is currently supported only on macOS')
    const key = owner(caller)
    if (value.action === 'cancel') {
      if (this.#mutationTask?.operationId === value.operationId) {
        if (this.#mutationTask.owner !== key) throw new Error('Cannot cancel a DNS operation started by another plugin window')
        this.#mutationTask.controller.abort(new Error('DNS operation cancelled'))
        await this.#mutation
        return { success: true, cancelRequested: true }
      }
      const task = this.#tasks.get(value.operationId)
      if (task && task.owner !== key) throw new Error('Cannot cancel a DNS operation started by another plugin window')
      task?.controller.abort(new Error('DNS benchmark cancelled'))
      if (task) await task.promise.catch(error => { if (!task.controller.signal.aborted) throw error })
      return { success: true, cancelled: Boolean(task) }
    }
    if ('service' in value || value.action === 'flush') {
      if (this.#mutation) throw new Error('DNS update or restore is in progress; please wait')
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
      this.#mutationTask = { operationId: value.operationId, owner: key, controller }
      // 授权与预提交可取消；原生组件进入提交后会完成事务，再返回实际结果。
      const operation = (async () => {
        if (value.action === 'flush') { await this.provider.flush(AbortSignal.any([combined, AbortSignal.timeout(90000)])); return { success: true } }
        return this.#mutate(value as Mutation, combined)
      })()
      this.#mutation = operation.catch(error => { console.warn('DNS 配置操作未成功', failure(error)) })
      try { return await operation } finally { this.#mutation = undefined; this.#mutationTask = undefined }
    }
    if (this.#tasks.size >= 4 || [...this.#tasks.values()].some(task => task.owner === key) || this.#tasks.has(value.operationId)) throw new Error('A DNS query is already in progress; cancel it or wait for it to finish')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(25000)])
    const operation = value.action === 'benchmark' ? benchmarkDnsServers(value.servers, combined).then(results => ({ success: true, domain: DNS_PROBE_DOMAIN, results })) :
      this.#list(combined).then(services => ({ success: true, services }))
    this.#tasks.set(value.operationId, { owner: key, controller, promise: operation })
    try { return await operation } finally { this.#tasks.delete(value.operationId) }
  }
  async #mutate(request: Mutation, signal: AbortSignal) {
    const before = (await this.provider.list(AbortSignal.any([signal, AbortSignal.timeout(15000)]))).find(v => v.name === request.service)
    if (!before) throw new Error('Selected network service is disconnected or does not exist; please refresh')
    if (!same(before.servers, request.expectedServers)) throw new Error('DNS configuration was modified by another application; please refresh and retry')
    let target = request.action === 'reset' ? [] : request.action === 'apply' ? request.servers! : []
    if (request.action === 'restore') {
      const backup = await this.backups.load(request.service, request.backupId)
      if (backup.device !== before.device) throw new Error('Network service now points to a different device; cannot restore the old configuration')
      target = backup.servers
    }
    const backup = await this.backups.save(before.name, before.device, before.servers)
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('Client is stopping; DNS write was not executed')
    if (!same(await this.provider.read(before.name, AbortSignal.timeout(8000)), before.servers)) throw new Error('DNS configuration changed during backup; write was not executed')
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('Client is stopping; DNS write was not executed')
    let error: unknown
    try {
      await this.provider.write(before.name, before.device, before.servers, target, AbortSignal.any([signal, AbortSignal.timeout(90000)]))
      const readback = await this.provider.read(before.name, AbortSignal.timeout(8000))
      if (!same(readback, target)) throw new Error('System did not retain the requested DNS configuration, or another application modified it')
      return { success: true, service: { ...before, servers: readback, backup: { id: backup.id, servers: backup.servers, createdAt: backup.createdAt } } }
    } catch (caught) { error = caught }
    if (error instanceof DnsWriteOutcomeUnknownError) throw new Error(`${failure(error)}; configuration overwrite aborted and original backup ${backup.id} was preserved; re-read system configuration before deciding whether to restore`)
    let after: string[]
    try { after = await this.provider.read(before.name, AbortSignal.timeout(8000)) }
    catch (readError) { throw new Error(`${failure(error)}; unable to read current state, original backup ${backup.id} was preserved: ${failure(readError)}`) }
    if (same(after, before.servers)) throw new Error(`${failure(error)}; confirmed original DNS configuration is unchanged`)
    if (!same(after, target)) throw new Error(`${failure(error)}; detected a different configuration and avoided overwriting it, original backup ${backup.id} was preserved`)
    try {
      await this.provider.write(before.name, before.device, target, before.servers, AbortSignal.timeout(90000))
      if (!same(await this.provider.read(before.name, AbortSignal.timeout(8000)), before.servers)) throw new Error('Post-restore configuration verification failed')
    } catch (restoreError) { throw new Error(`${failure(error)}; automatic restore could not be confirmed, backup ${backup.id} was preserved: ${failure(restoreError)}`) }
    throw new Error(`${failure(error)}; original DNS configuration was restored and verified`)
  }
}
