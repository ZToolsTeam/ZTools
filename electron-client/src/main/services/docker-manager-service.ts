import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { ZToolsError, errorCodes } from '../../contracts/errors.js'
import { dockerRecord, validContainerId, validateDockerRequest, stoppedDockerStates, type DockerContainer, type DockerRequest } from '../../contracts/docker-manager.js'
import { DockerCli, type DockerConnection } from './docker-cli.js'
interface Session { id: string; owner: string; connection: DockerConnection; daemon: string; containers: DockerContainer[]; created: number }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function owner(caller: CallerIdentity) { return JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId]) }
function jsonLines(text: string): unknown[] { return text.trim() ? text.trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown) : [] }
function required(row: Record<string, unknown>, key: string) {
  const value = row[key]
  if (typeof value !== 'string' || value.length > 10000) throw new Error(`Docker 返回的 ${key} 字段无效`)
  return value
}
export function parseDockerContainers(text: string): DockerContainer[] {
  const rows = jsonLines(text).map(raw => {
    if (!dockerRecord(raw) || !validContainerId(raw.ID) || !['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(String(raw.State))) throw new Error('Docker 返回的容器记录无效')
    return { id: raw.ID, name: required(raw, 'Names'), image: required(raw, 'Image'), state: String(raw.State), status: required(raw, 'Status'), ports: required(raw, 'Ports'), createdAt: required(raw, 'CreatedAt'), cpu: null, memory: null }
  })
  if (rows.length > 1000 || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Docker 容器列表过大或包含重复编号')
  return rows
}
export class DockerManagerService {
  #sessions = new Map<string, Session>()
  #active: { controller: AbortController; promise: Promise<unknown>; owner: string; window: number } | undefined
  #stopped = false
  constructor(private readonly cli = new DockerCli()) {}
  async stop() {
    this.#stopped = true; this.#sessions.clear(); this.#active?.controller.abort()
    await this.#active?.promise.catch(error => console.warn('Docker 服务结束请求', message(error)))
  }
  closeOwner(window: number) {
    if (this.#active?.window === window) this.#active.controller.abort()
    for (const [key, session] of this.#sessions) if (JSON.parse(session.owner)[0] === window) this.#sessions.delete(key)
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try {
      validateDockerRequest(value); signal.throwIfAborted()
      if (this.#stopped) throw new Error('Docker 服务已停止')
      if (value.action === 'cancel') {
        const active = this.#active
        if (active?.owner === owner(caller)) { active.controller.abort(); await active.promise.catch(error => console.warn('Docker 请求已停止', message(error))) }
        return { success: true, cancelRequested: active?.owner === owner(caller) }
      }
      if (this.#active) throw new Error('Docker 操作正在进行，请等待完成')
      const controller = new AbortController(), key = owner(caller)
      const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(180000)])
      const promise = this.#execute(value, key, combined)
      this.#active = { controller, promise, owner: key, window: caller.webContentsId }
      try { return await promise } finally { this.#active = undefined }
    } catch (error) { throw new ZToolsError(errorCodes.nativeHostError, message(error).slice(0, 2000)) }
  }
  async #daemon(connection: DockerConnection, signal: AbortSignal) {
    const result = await this.cli.run(connection, ['info', '--format', '{{json .ID}}'], signal)
    const value: unknown = JSON.parse(result.stdout)
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Docker 引擎未返回有效身份，请确认已启动')
    return value
  }
  async #list(key: string, signal: AbortSignal) {
    for (const [id, session] of this.#sessions) if (session.owner === key || Date.now() - session.created > 900000) this.#sessions.delete(id)
    const connection = await this.cli.connect(signal), daemon = await this.#daemon(connection, signal)
    const containers = parseDockerContainers((await this.cli.run(connection, ['container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}'], signal)).stdout)
    const running = containers.filter(c => c.state === 'running'), statsError = await this.#stats(connection, running, signal)
    signal.throwIfAborted()
    const id = randomUUID()
    if (this.#sessions.size >= 32) throw new Error('Docker 会话过多，请关闭其他插件窗口后重试')
    this.#sessions.set(id, { id, owner: key, connection, daemon, containers, created: Date.now() })
    return { success: true, sessionId: id, context: connection.context, containers, statsError }
  }
  async #stats(connection: DockerConnection, running: DockerContainer[], signal: AbortSignal): Promise<string | null> {
    if (!running.length) return null
    try {
      const output = await this.cli.run(connection, ['container', 'stats', '--no-stream', '--format', '{{json .}}', ...running.map(c => c.id)], signal)
      const seen = new Set<string>()
      for (const raw of jsonLines(output.stdout)) {
        if (!dockerRecord(raw) || typeof raw.Container !== 'string') throw new Error('资源采样返回无效记录')
        const row = running.find(c => c.id === raw.Container)
        if (!row || seen.has(row.id) || typeof raw.CPUPerc !== 'string' || !/^\d+(?:\.\d+)?%$/.test(raw.CPUPerc) || typeof raw.MemUsage !== 'string' || !raw.MemUsage.trim()) throw new Error('资源采样数据不完整')
        row.cpu = raw.CPUPerc; row.memory = raw.MemUsage; seen.add(row.id)
      }
      return seen.size === running.length ? null : '部分容器未返回资源采样，状态可能已变化'
    } catch (error) {
      signal.throwIfAborted()
      for (const row of running) { row.cpu = null; row.memory = null }
      return `资源采样失败：${message(error)}`
    }
  }
  async #session(id: string, key: string, signal: AbortSignal) {
    const session = this.#sessions.get(id)
    if (!session || session.owner !== key || Date.now() - session.created > 900000) throw new Error('容器列表已过期，请刷新后再操作')
    const current = await this.cli.connect(signal)
    if (current.endpoint !== session.connection.endpoint || current.context !== session.connection.context || current.executable !== session.connection.executable || await this.#daemon(session.connection, signal) !== session.daemon) {
      this.#sessions.delete(id); throw new Error('Docker 上下文或引擎已变化，请刷新后再操作')
    }
    return session
  }
  async #inspect(session: Session, id: string, signal: AbortSignal) {
    if (!session.containers.some(c => c.id === id)) throw new Error('此容器不在已读取的列表中')
    const raw: unknown = JSON.parse((await this.cli.run(session.connection, ['container', 'inspect', id], signal)).stdout)
    if (!Array.isArray(raw) || raw.length !== 1 || !dockerRecord(raw[0]) || raw[0].Id !== id || !dockerRecord(raw[0].State) || typeof raw[0].State.Status !== 'string' || typeof raw[0].State.Running !== 'boolean') throw new Error('Docker 未返回可核对的容器状态')
    return raw[0].State
  }
  async #execute(request: DockerRequest, key: string, signal: AbortSignal): Promise<unknown> {
    if (request.action === 'list') return this.#list(key, signal)
    if (request.action === 'cancel') throw new Error('取消请求不能进入容器操作')
    const session = await this.#session(request.sessionId, key, signal)
    if (request.action === 'logs') {
      await this.#inspect(session, request.id, signal)
      const output = await this.cli.run(session.connection, ['container', 'logs', '--tail', '100', '--timestamps', request.id], signal)
      return { success: true, id: request.id, stdout: output.stdout, stderr: output.stderr }
    }
    try {
      if (request.action === 'remove') return await this.#remove(session, request.ids, signal)
      const before = await this.#inspect(session, request.id, signal)
      const expected = session.containers.find(c => c.id === request.id)!.state
      if (before.Status !== expected) throw new Error('容器状态已变化，请刷新后再操作')
      if (request.operation === 'start' ? !stoppedDockerStates.has(String(before.Status)) : before.Status !== 'running') throw new Error('当前状态不支持此操作，请刷新容器列表')
      signal.throwIfAborted()
      await this.cli.run(session.connection, ['container', request.operation, request.id], signal, 60000)
      const after = await this.#inspect(session, request.id, signal)
      const verified = request.operation === 'stop' ? after.Running === false && stoppedDockerStates.has(String(after.Status)) : after.Running === true && after.Status === 'running'
      if (!verified) throw new Error(`命令已返回，但容器当前状态为 ${String(after.Status)}，请检查日志`)
      return { success: true, id: request.id, state: after.Status }
    } finally { this.#sessions.delete(session.id) }
  }
  async #remove(session: Session, ids: string[], signal: AbortSignal) {
    if (!ids.every(id => session.containers.some(c => c.id === id && stoppedDockerStates.has(c.state)))) throw new Error('清理清单包含未确认停止的容器，请刷新')
    const removed: string[] = [], failures: Array<{ id: string; error: string }> = []
    for (const id of ids) {
      if (signal.aborted) break
      try {
        const before = await this.#inspect(session, id, signal)
        if (before.Running || !stoppedDockerStates.has(String(before.Status))) throw new Error('容器已启动或状态改变，已跳过')
        // 不传 --force / --volumes：Docker 自身拒绝并发启动的容器，保留挂载的数据卷。
        await this.cli.run(session.connection, ['container', 'rm', id], signal)
        const remaining = (await this.cli.run(session.connection, ['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`], signal)).stdout.trim()
        if (remaining) throw new Error('删除后仍可查到容器，未确认清理成功')
        removed.push(id)
      } catch (error) { failures.push({ id, error: message(error) }); if (signal.aborted) break }
    }
    for (const id of ids) if (!removed.includes(id) && !failures.some(f => f.id === id)) failures.push({ id, error: '操作中断，未执行清理' })
    return { success: true, removed, failures }
  }
}
