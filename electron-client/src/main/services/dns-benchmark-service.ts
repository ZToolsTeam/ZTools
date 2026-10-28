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
    this.#mutationTask?.controller.abort(new Error('DNS 服务已停止'))
    for (const task of this.#tasks.values()) task.controller.abort(new Error('DNS 操作已停止'))
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
    if (this.#stopped) throw new Error('DNS 服务已停止')
    if (this.platform !== 'darwin') throw new Error('此 DNS 配置通道目前仅支持 macOS')
    const key = owner(caller)
    if (value.action === 'cancel') {
      if (this.#mutationTask?.operationId === value.operationId) {
        if (this.#mutationTask.owner !== key) throw new Error('不能取消其他插件窗口的 DNS 操作')
        this.#mutationTask.controller.abort(new Error('DNS 操作已取消'))
        await this.#mutation
        return { success: true, cancelRequested: true }
      }
      const task = this.#tasks.get(value.operationId)
      if (task && task.owner !== key) throw new Error('不能取消其他插件窗口的 DNS 操作')
      task?.controller.abort(new Error('DNS 测速已取消'))
      if (task) await task.promise.catch(error => { if (!task.controller.signal.aborted) throw error })
      return { success: true, cancelled: Boolean(task) }
    }
    if ('service' in value || value.action === 'flush') {
      if (this.#mutation) throw new Error('正在修改或恢复 DNS，请稍候')
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
    if (this.#tasks.size >= 4 || [...this.#tasks.values()].some(task => task.owner === key) || this.#tasks.has(value.operationId)) throw new Error('DNS 查询正在进行，请先取消或等待完成')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(25000)])
    const operation = value.action === 'benchmark' ? benchmarkDnsServers(value.servers, combined).then(results => ({ success: true, domain: DNS_PROBE_DOMAIN, results })) :
      this.#list(combined).then(services => ({ success: true, services }))
    this.#tasks.set(value.operationId, { owner: key, controller, promise: operation })
    try { return await operation } finally { this.#tasks.delete(value.operationId) }
  }
  async #mutate(request: Mutation, signal: AbortSignal) {
    const before = (await this.provider.list(AbortSignal.any([signal, AbortSignal.timeout(15000)]))).find(v => v.name === request.service)
    if (!before) throw new Error('所选网络服务已断开或不存在，请重新读取')
    if (!same(before.servers, request.expectedServers)) throw new Error('DNS 配置已被其他程序修改，请刷新后再操作')
    let target = request.action === 'reset' ? [] : request.action === 'apply' ? request.servers! : []
    if (request.action === 'restore') {
      const backup = await this.backups.load(request.service, request.backupId)
      if (backup.device !== before.device) throw new Error('网络服务已指向其他设备，不能恢复旧配置')
      target = backup.servers
    }
    const backup = await this.backups.save(before.name, before.device, before.servers)
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('客户端已退出，未执行 DNS 写入')
    if (!same(await this.provider.read(before.name, AbortSignal.timeout(8000)), before.servers)) throw new Error('备份期间 DNS 配置已变化，未执行写入')
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('客户端已退出，未执行 DNS 写入')
    let error: unknown
    try {
      await this.provider.write(before.name, before.device, before.servers, target, AbortSignal.any([signal, AbortSignal.timeout(90000)]))
      const readback = await this.provider.read(before.name, AbortSignal.timeout(8000))
      if (!same(readback, target)) throw new Error('系统未保留请求的 DNS 配置，或已有其他程序修改配置')
      return { success: true, service: { ...before, servers: readback, backup: { id: backup.id, servers: backup.servers, createdAt: backup.createdAt } } }
    } catch (caught) { error = caught }
    if (error instanceof DnsWriteOutcomeUnknownError) throw new Error(`${failure(error)}；未继续覆盖配置，原配置备份 ${backup.id} 已保留，请重新读取系统配置后决定是否恢复`)
    let after: string[]
    try { after = await this.provider.read(before.name, AbortSignal.timeout(8000)) }
    catch (readError) { throw new Error(`${failure(error)}；无法读取当前状态，原配置备份 ${backup.id} 已保留：${failure(readError)}`) }
    if (same(after, before.servers)) throw new Error(`${failure(error)}；已确认原 DNS 配置未改变`)
    if (!same(after, target)) throw new Error(`${failure(error)}；检测到其他配置，为避免覆盖未继续写入，原配置备份 ${backup.id} 已保留`)
    try {
      await this.provider.write(before.name, before.device, target, before.servers, AbortSignal.timeout(90000))
      if (!same(await this.provider.read(before.name, AbortSignal.timeout(8000)), before.servers)) throw new Error('恢复后的配置核对失败')
    } catch (restoreError) { throw new Error(`${failure(error)}；自动恢复未确认，备份 ${backup.id} 已保留：${failure(restoreError)}`) }
    throw new Error(`${failure(error)}；已恢复并核对原 DNS 配置`)
  }
}
