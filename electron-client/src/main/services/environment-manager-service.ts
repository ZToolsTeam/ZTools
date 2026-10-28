import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { ZToolsError, errorCodes } from '../../contracts/errors.js'
import { validateEnvironmentRequest, type EnvironmentRequest, type EnvironmentSnapshot, type EnvironmentPathEntry, type EnvironmentChange } from '../../contracts/environment-manager.js'
import { environmentFailure, environmentRevision, type EnvironmentProvider, type EnvironmentState } from './environment-provider.js'
import { EnvironmentBackupStore } from './environment-backups.js'

interface Session { owner: string; created: number; states: EnvironmentState[] }
interface Plan { owner: string; created: number; before: EnvironmentState; after: EnvironmentState; summary: string }
function owner(caller: CallerIdentity) { return JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId]) }
export async function inspectEnvironmentPath(value: string, platform: string): Promise<Pick<EnvironmentPathEntry, 'status' | 'reason'>> {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!value || !paths.isAbsolute(value) || (platform === 'win32' && (/%[^%]+%/.test(value) || /^[\\/]{2}/.test(value))) || (platform === 'darwin' && value.startsWith('/Volumes/'))) return { status: 'unknown', reason: '相对路径、变量引用或外部卷不能判定为失效' }
  try {
    if (!(await fs.stat(paths.parse(value).root)).isDirectory()) return { status: 'unknown', reason: '所在磁盘暂不可访问' }
  } catch { return { status: 'unknown', reason: '所在磁盘暂不可访问' } }
  try { return (await fs.stat(value)).isDirectory() ? { status: 'directory', reason: '目录存在' } : { status: 'unknown', reason: '该路径不是目录，请人工检查' } }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing', reason: '确认目录不存在' } : { status: 'unknown', reason: '无法确认目录状态，保留此项' }
  }
}
export class EnvironmentManagerService {
  #sessions = new Map<string, Session>(); #plans = new Map<string, Plan>()
  #active: { owner: string; window: number; controller: AbortController; promise: Promise<unknown> } | undefined
  #stopped = false
  constructor(private readonly provider: EnvironmentProvider, private readonly backups: EnvironmentBackupStore) {}
  async stop() {
    this.#stopped = true; this.#sessions.clear(); this.#plans.clear(); this.#active?.controller.abort()
    await this.#active?.promise.catch(error => console.warn('环境变量操作结束', environmentFailure(error)))
  }
  closeOwner(window: number) {
    if (this.#active?.window === window) this.#active.controller.abort()
    for (const map of [this.#sessions, this.#plans]) for (const [id, item] of map) if (JSON.parse(item.owner)[0] === window) map.delete(id)
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try {
      validateEnvironmentRequest(value); signal.throwIfAborted()
      if (this.#stopped) throw new Error('环境变量服务已停止')
      const key = owner(caller)
      if (value.action === 'cancel') {
        const active = this.#active
        for (const [id, plan] of this.#plans) if (plan.owner === key) this.#plans.delete(id)
        if (active?.owner === key) { active.controller.abort(); await active.promise.catch(error => console.warn('环境变量取消后已结束', environmentFailure(error))) }
        return { success: true, cancelRequested: active?.owner === key }
      }
      if (this.#active) throw new Error('环境变量操作正在进行，请稍候')
      for (const map of [this.#sessions, this.#plans]) for (const [id, item] of map) if (Date.now() - item.created > 900000) map.delete(id)
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(60000)])
      const promise = this.#execute(value, key, combined)
      this.#active = { owner: key, window: caller.webContentsId, controller, promise }
      try { return await promise } finally { this.#active = undefined }
    } catch (error) { throw new ZToolsError(errorCodes.nativeHostError, environmentFailure(error).slice(0, 2000)) }
  }
  async #paths(values: Map<string, string>, scope: EnvironmentPathEntry['scope'], signal: AbortSignal) {
    const entry = [...values].find(([key]) => this.provider.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')
    if (!entry) return []
    const parts = entry[1].split(this.provider.platform === 'win32' ? ';' : ':')
    if (parts.length > 1024) throw new Error('PATH 条目超过 1024，停止检查')
    const results: EnvironmentPathEntry[] = []
    for (const [index, value] of parts.entries()) { signal.throwIfAborted(); results.push({ scope, index, value, ...await inspectEnvironmentPath(value, this.provider.platform) }) }
    return results
  }
  async #list(key: string, signal: AbortSignal) {
    const sources = this.provider.sources(), states: EnvironmentState[] = []
    for (const source of sources) states.push(await this.provider.read(source.id, signal))
    const inherited = new Map(Object.entries(this.provider.processEnvironment).filter((v): v is [string, string] => typeof v[1] === 'string'))
    if (inherited.size > 4096 || [...inherited].some(([name, value]) => name.length > 1024 || value.length > 32767)) throw new Error('当前进程的环境变量超过可读取范围')
    const variables = [...inherited].map(([key, value]) => ({ key, value, scope: 'process' as const })) as EnvironmentSnapshot['variables']
    const paths = await this.#paths(inherited, 'process', signal)
    for (const state of states) {
      const values = this.provider.values(state)
      variables.push(...[...values].map(([key, value]) => ({ key, value, scope: state.source })))
      paths.push(...await this.#paths(values, state.source, signal))
    }
    const backups = (await this.backups.list()).filter(b => sources.some(s => s.id === b.source && s.label === b.location)).map(({ id, source, createdAt, summary }) => ({ id, source, createdAt, summary }))
    signal.throwIfAborted()
    for (const [id, session] of this.#sessions) if (session.owner === key) this.#sessions.delete(id)
    for (const [id, plan] of this.#plans) if (plan.owner === key) this.#plans.delete(id)
    if (this.#sessions.size >= 32) throw new Error('环境变量会话过多，请关闭其他插件窗口')
    const sessionId = randomUUID(); this.#sessions.set(sessionId, { owner: key, created: Date.now(), states })
    return { success: true, sessionId, platform: this.provider.platform, notice: this.provider.notice, sources, variables, paths, backups }
  }
  async #prepare(sessionId: string, change: EnvironmentChange, key: string, signal: AbortSignal) {
    const session = this.#sessions.get(sessionId)
    if (!session || session.owner !== key) throw new Error('读取结果已过期，请刷新')
    const before = session.states.find(state => state.source === change.source)
    if (!before || environmentRevision(await this.provider.read(change.source, signal)) !== environmentRevision(before)) throw new Error('原配置已变化，请重新读取后操作')
    let after = before, summary = '', removed: string[] = []
    if (change.kind === 'restore') {
      const backup = await this.backups.load(change.backupId)
      if (backup.source !== change.source || environmentRevision(backup.after) !== environmentRevision(before)) throw new Error('当前配置已不是此备份对应的版本，停止恢复以保留后续修改')
      after = backup.before; summary = `恢复 ${backup.createdAt} 的原配置`
    } else if (change.kind === 'clean') {
      const values = this.provider.values(before), paths = await this.#paths(values, change.source, signal)
      const invalid = new Set(paths.filter(p => p.status === 'missing').map(p => p.index))
      if (!invalid.size) throw new Error('没有确认失效的 PATH 项，无需修改')
      const kept = paths.filter(p => !invalid.has(p.index)).map(p => p.value)
      if (!kept.length) throw new Error('清理后 PATH 将为空，已停止；请先手动修正 PATH')
      removed = paths.filter(p => invalid.has(p.index)).map(p => p.value)
      const pathKey = [...values.keys()].find(name => this.provider.platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH')!
      after = this.provider.change(before, pathKey, kept.join(this.provider.platform === 'win32' ? ';' : ':')); summary = `清理 ${removed.length} 个确认失效的 PATH 项`
    } else {
      if (change.kind === 'delete' && !this.provider.values(before).has(change.key)) throw new Error('变量已不存在，请刷新')
      after = this.provider.change(before, change.key, change.kind === 'delete' ? null : change.value)
      summary = `${change.kind === 'delete' ? '移除配置中的' : '保存'}变量 ${change.key}`
    }
    if (environmentRevision(before) === environmentRevision(after)) throw new Error('配置没有变化，无需写入')
    await this.provider.validate(after, signal)
    signal.throwIfAborted()
    if (this.#plans.size >= 32) throw new Error('待确认计划过多，请稍后重试')
    const planId = randomUUID(); this.#plans.set(planId, { owner: key, created: Date.now(), before, after, summary })
    return { success: true, planId, summary, location: before.location, removed, notice: this.provider.notice }
  }
  async #execute(request: Exclude<EnvironmentRequest, { action: 'cancel' }>, key: string, signal: AbortSignal): Promise<unknown> {
    if (request.action === 'list') return this.#list(key, signal)
    if (request.action === 'prepare') return this.#prepare(request.sessionId, request.change, key, signal)
    if (request.action !== 'apply') throw new Error('环境变量操作无效')
    const plan = this.#plans.get(request.planId)
    if (!plan || plan.owner !== key) throw new Error('修改计划不存在或已过期，请重新预览')
    this.#plans.delete(request.planId)
    if (environmentRevision(await this.provider.read(plan.before.source, signal)) !== environmentRevision(plan.before)) throw new Error('确认期间配置已变化，未执行写入')
    const backup = await this.backups.save(plan.before, plan.after, plan.summary)
    signal.throwIfAborted()
    if (this.#stopped) throw new Error('客户端已退出，未执行写入')
    try {
      const recoveryPath = await this.provider.write(plan.before, plan.after, signal)
      const current = await this.provider.read(plan.before.source, AbortSignal.timeout(15000))
      if (environmentRevision(current) !== environmentRevision(plan.after)) throw new Error('写入后读回不一致，或配置又被其他程序修改')
      return { success: true, backupId: backup.id, summary: plan.summary, verified: true, recoveryPath }
    } catch (error) { throw new Error(`${environmentFailure(error)}；原配置备份 ${backup.id} 已保留，请刷新后决定是否恢复`) }
    finally { for (const [id, session] of this.#sessions) if (session.owner === key) this.#sessions.delete(id) }
  }
}
