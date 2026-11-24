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
  if (typeof value !== 'string' || value.length > 10000) throw new Error(`Invalid ${key} field returned by Docker`)
  return value
}
export function parseDockerContainers(text: string): DockerContainer[] {
  const rows = jsonLines(text).map(raw => {
    if (!dockerRecord(raw) || !validContainerId(raw.ID) || !['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(String(raw.State))) throw new Error('Invalid container record returned by Docker')
    return { id: raw.ID, name: required(raw, 'Names'), image: required(raw, 'Image'), state: String(raw.State), status: required(raw, 'Status'), ports: required(raw, 'Ports'), createdAt: required(raw, 'CreatedAt'), cpu: null, memory: null }
  })
  if (rows.length > 1000 || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Docker container list is too large or contains duplicate IDs')
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
      if (this.#stopped) throw new Error('Docker service has stopped')
      if (value.action === 'cancel') {
        const active = this.#active
        if (active?.owner === owner(caller)) { active.controller.abort(); await active.promise.catch(error => console.warn('Docker 请求已停止', message(error))) }
        return { success: true, cancelRequested: active?.owner === owner(caller) }
      }
      if (this.#active) throw new Error('A Docker operation is already in progress; please wait for it to finish')
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
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Docker engine did not return a valid identity; please verify it is running')
    return value
  }
  async #list(key: string, signal: AbortSignal) {
    for (const [id, session] of this.#sessions) if (session.owner === key || Date.now() - session.created > 900000) this.#sessions.delete(id)
    const connection = await this.cli.connect(signal), daemon = await this.#daemon(connection, signal)
    const containers = parseDockerContainers((await this.cli.run(connection, ['container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}'], signal)).stdout)
    const running = containers.filter(c => c.state === 'running'), statsError = await this.#stats(connection, running, signal)
    signal.throwIfAborted()
    const id = randomUUID()
    if (this.#sessions.size >= 32) throw new Error('Too many Docker sessions; please close other plugin windows and retry')
    this.#sessions.set(id, { id, owner: key, connection, daemon, containers, created: Date.now() })
    return { success: true, sessionId: id, context: connection.context, containers, statsError }
  }
  async #stats(connection: DockerConnection, running: DockerContainer[], signal: AbortSignal): Promise<string | null> {
    if (!running.length) return null
    try {
      const output = await this.cli.run(connection, ['container', 'stats', '--no-stream', '--format', '{{json .}}', ...running.map(c => c.id)], signal)
      const seen = new Set<string>()
      for (const raw of jsonLines(output.stdout)) {
        if (!dockerRecord(raw) || typeof raw.Container !== 'string') throw new Error('Resource stats sampling returned an invalid record')
        const row = running.find(c => c.id === raw.Container)
        if (!row || seen.has(row.id) || typeof raw.CPUPerc !== 'string' || !/^\d+(?:\.\d+)?%$/.test(raw.CPUPerc) || typeof raw.MemUsage !== 'string' || !raw.MemUsage.trim()) throw new Error('Resource stats sampling data is incomplete')
        row.cpu = raw.CPUPerc; row.memory = raw.MemUsage; seen.add(row.id)
      }
      return seen.size === running.length ? null : 'Some containers did not return resource stats; their state may have changed'
    } catch (error) {
      signal.throwIfAborted()
      for (const row of running) { row.cpu = null; row.memory = null }
      return `Resource stats sampling failed: ${message(error)}`
    }
  }
  async #session(id: string, key: string, signal: AbortSignal) {
    const session = this.#sessions.get(id)
    if (!session || session.owner !== key || Date.now() - session.created > 900000) throw new Error('Container list has expired; please refresh and retry')
    const current = await this.cli.connect(signal)
    if (current.endpoint !== session.connection.endpoint || current.context !== session.connection.context || current.executable !== session.connection.executable || await this.#daemon(session.connection, signal) !== session.daemon) {
      this.#sessions.delete(id); throw new Error('Docker context or engine has changed; please refresh and retry')
    }
    return session
  }
  async #inspect(session: Session, id: string, signal: AbortSignal) {
    if (!session.containers.some(c => c.id === id)) throw new Error('This container is not in the loaded list')
    const raw: unknown = JSON.parse((await this.cli.run(session.connection, ['container', 'inspect', id], signal)).stdout)
    if (!Array.isArray(raw) || raw.length !== 1 || !dockerRecord(raw[0]) || raw[0].Id !== id || !dockerRecord(raw[0].State) || typeof raw[0].State.Status !== 'string' || typeof raw[0].State.Running !== 'boolean') throw new Error('Docker did not return a verifiable container state')
    return raw[0].State
  }
  async #execute(request: DockerRequest, key: string, signal: AbortSignal): Promise<unknown> {
    if (request.action === 'list') return this.#list(key, signal)
    if (request.action === 'cancel') throw new Error('Cancel request cannot enter container execution')
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
      if (before.Status !== expected) throw new Error('Container state has changed; please refresh and retry')
      if (request.operation === 'start' ? !stoppedDockerStates.has(String(before.Status)) : before.Status !== 'running') throw new Error('Current container state does not support this operation; please refresh the container list')
      signal.throwIfAborted()
      await this.cli.run(session.connection, ['container', request.operation, request.id], signal, 60000)
      const after = await this.#inspect(session, request.id, signal)
      const verified = request.operation === 'stop' ? after.Running === false && stoppedDockerStates.has(String(after.Status)) : after.Running === true && after.Status === 'running'
      if (!verified) throw new Error(`Command returned, but container state is ${String(after.Status)}; please check the logs`)
      return { success: true, id: request.id, state: after.Status }
    } finally { this.#sessions.delete(session.id) }
  }
  async #remove(session: Session, ids: string[], signal: AbortSignal) {
    if (!ids.every(id => session.containers.some(c => c.id === id && stoppedDockerStates.has(c.state)))) throw new Error('Removal list contains containers that are not confirmed stopped; please refresh')
    const removed: string[] = [], failures: Array<{ id: string; error: string }> = []
    for (const id of ids) {
      if (signal.aborted) break
      try {
        const before = await this.#inspect(session, id, signal)
        if (before.Running || !stoppedDockerStates.has(String(before.Status))) throw new Error('Container has started or changed state; skipped')
        // 不传 --force / --volumes：Docker 自身拒绝并发启动的容器，保留挂载的数据卷。
        await this.cli.run(session.connection, ['container', 'rm', id], signal)
        const remaining = (await this.cli.run(session.connection, ['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`], signal)).stdout.trim()
        if (remaining) throw new Error('Container is still present after removal; cleanup could not be confirmed')
        removed.push(id)
      } catch (error) { failures.push({ id, error: message(error) }); if (signal.aborted) break }
    }
    for (const id of ids) if (!removed.includes(id) && !failures.some(f => f.id === id)) failures.push({ id, error: 'Operation interrupted; cleanup was not executed' })
    return { success: true, removed, failures }
  }
}
