import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { ZToolsError, errorCodes } from '../../contracts/errors.js'
import { validateSshProxyRequest, type SshProxyRequest, type ProxyTool } from '../../contracts/ssh-proxy.js'
import { readSshDocuments, type SshReadOptions } from './ssh-config-reader.js'
import { sshProfiles, type SshProfile } from './ssh-config-profiles.js'
import { ProxyConfigurationProvider } from './proxy-configuration.js'
import { EnvironmentBackupStore } from './environment-backups.js'
import { environmentRevision, type EnvironmentState } from './environment-provider.js'
import { createSshTerminal, sshArguments, proxyTerminalArguments, windowsProxyTerminalArguments, type SshTerminal } from './ssh-terminal.js'

interface Owned { owner: string; window: number; created: number }
interface Session extends Owned { states: Partial<Record<ProxyTool, EnvironmentState>>; sshRevision?: string; hosts: SshProfile[] }
interface Plan extends Owned { tool: ProxyTool; before: EnvironmentState; after: EnvironmentState; summary: string }
const owner = (c: CallerIdentity) => JSON.stringify([c.webContentsId, c.pluginId, c.pluginInstanceId, c.attributedPlugin?.sessionId])
const message = (error: unknown) => (error instanceof Error ? error.message : 'Operation failed').slice(0, 2000)
/** Windows 自带 OpenSSH 的系统配置位于 %ProgramData%\ssh\ssh_config，用户配置同为 ~/.ssh/config。 */
const defaultSshOptions = (): SshReadOptions => process.platform === 'win32'
  ? { home: os.homedir(), systemDirectory: path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh') } : { home: os.homedir() }
export class SshProxyService {
  #sessions = new Map<string, Session>(); #plans = new Map<string, Plan>(); #stopped = false
  #active: { owner: string; window: number; controller: AbortController; task: Promise<unknown> } | undefined
  constructor(private readonly provider: ProxyConfigurationProvider, private readonly backups: EnvironmentBackupStore,
    private readonly terminal: SshTerminal = createSshTerminal(), private readonly sshOptions: SshReadOptions = defaultSshOptions(), private readonly platform = process.platform) {}
  closeOwner(window: number) {
    if (this.#active?.window === window) this.#active.controller.abort()
    for (const map of [this.#sessions, this.#plans]) for (const [id, item] of map) if (item.window === window) map.delete(id)
  }
  async stop() {
    this.#stopped = true; this.#sessions.clear(); this.#plans.clear(); this.#active?.controller.abort()
    if (this.#active) await Promise.allSettled([this.#active.task])
    await this.terminal.stop()
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try {
      validateSshProxyRequest(value); signal.throwIfAborted()
      if (this.#stopped || (this.platform !== 'darwin' && this.platform !== 'win32')) throw new Error('Host and proxy service is unavailable on this platform')
      const who = { owner: owner(caller), window: caller.webContentsId, created: Date.now() }
      if (value.action === 'cancel') {
        const active = this.#active
        for (const [id, plan] of this.#plans) if (plan.owner === who.owner) this.#plans.delete(id)
        if (active?.owner === who.owner) { active.controller.abort(); await Promise.allSettled([active.task]) }
        return { success: true, cancelRequested: active?.owner === who.owner }
      }
      if (this.#active) throw new Error('Another host and proxy operation is already in progress')
      for (const map of [this.#sessions, this.#plans]) for (const [id, item] of map) if (Date.now() - item.created > 900000) map.delete(id)
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(60000)])
      const task = this.#execute(value, who, combined)
      this.#active = { owner: who.owner, window: who.window, controller, task }
      try { return await task } finally { this.#active = undefined }
    } catch (error) { if (error instanceof ZToolsError) throw error; throw new ZToolsError(errorCodes.nativeHostError, message(error)) }
  }
  async #scan(who: Owned, signal: AbortSignal) {
    for (const map of [this.#sessions, this.#plans]) for (const [id, item] of map) if (item.owner === who.owner) map.delete(id)
    if (this.#sessions.size >= 16) throw new Error('Too many plugin windows open; close some windows and retry')
    const session: Session = { ...who, states: {}, hosts: [] }
    let ssh: { status: 'ready' | 'error'; userConfigExists?: boolean; hosts: SshProfile[]; warnings: string[]; error?: string }
    try {
      const documents = await readSshDocuments(this.sshOptions, signal), profiles = sshProfiles(documents)
      session.sshRevision = documents.revision; session.hosts = profiles.hosts
      ssh = { status: 'ready', userConfigExists: documents.userConfigExists, ...profiles }
    } catch (error) { ssh = { status: 'error', hosts: [], warnings: [], error: message(error) } }
    const proxies = []
    for (const tool of ['git', 'npm'] as const) {
      signal.throwIfAborted()
      try {
        const state = await this.provider.read(tool, signal), configuration = await this.provider.inspect(tool, state, signal)
        session.states[tool] = state; proxies.push({ status: 'ready' as const, ...configuration })
      } catch (error) { proxies.push({ tool, status: 'error' as const, error: message(error) }) }
    }
    let backups: Array<{ id: string; createdAt: string; summary: string; tool: string | undefined }> = [], backupError = ''
    try {
      backups = (await this.backups.list()).filter(item => Object.values(session.states).some(state => state?.location === item.location)).map(({ id, createdAt, summary, location }) => ({ id, createdAt, summary, tool: Object.entries(session.states).find(([, state]) => state?.location === location)?.[0] }))
    } catch { backupError = 'Failed to read or verify backups; original backups were preserved and restore is temporarily unavailable' }
    signal.throwIfAborted(); if (this.#stopped) throw new Error('Service stopped')
    const sessionId = randomUUID(); this.#sessions.set(sessionId, session)
    return { success: true, sessionId, ssh, proxies, backups, backupError }
  }
  async #execute(request: Exclude<SshProxyRequest, { action: 'cancel' }>, who: Owned, signal: AbortSignal): Promise<unknown> {
    if (request.action === 'scan') return this.#scan(who, signal)
    if (request.action === 'terminal-proxy') return this.terminal.launch('proxy', this.platform === 'win32' ? windowsProxyTerminalArguments(request.port) : proxyTerminalArguments(request.port), signal)
    if (request.action === 'apply') return this.#apply(request.planId, who, signal)
    if (!('sessionId' in request)) throw new Error('Operation requires a session')
    const session = this.#sessions.get(request.sessionId)
    if (!session || session.owner !== who.owner) throw new Error('Scan session expired or does not belong to this plugin; please refresh')
    if (request.action === 'prepare') {
      const before = session.states[request.tool]
      if (!before || environmentRevision(await this.provider.read(request.tool, signal)) !== environmentRevision(before)) throw new Error('Configuration read failed or changed; please re-read')
      let after: EnvironmentState, summary: string
      if (request.change.kind === 'restore') {
        const backup = await this.backups.load(request.change.backupId).catch(() => { throw new Error('Backup read or verification failed; configuration not modified') })
        if (environmentRevision(backup.after) !== environmentRevision(before) || backup.before.location !== before.location) throw new Error('Current configuration no longer matches this backup; restore aborted to preserve later edits')
        after = backup.before; summary = `Restore ${request.tool.toUpperCase()} configuration from backup created at ${backup.createdAt}`
      } else {
        const proxy = request.change.kind === 'set' ? `http://127.0.0.1:${request.change.port}` : null
        after = await this.provider.change(request.tool, before, proxy, signal)
        summary = proxy ? `Set general ${request.tool.toUpperCase()} proxy in this file to ${proxy}` : `Clear general ${request.tool.toUpperCase()} proxy in this file`
      }
      if (environmentRevision(before) === environmentRevision(after)) throw new Error('Configuration unchanged; no write needed')
      const previous = await this.provider.inspect(request.tool, before, signal), next = await this.provider.inspect(request.tool, after, signal)
      signal.throwIfAborted()
      if (this.#plans.size >= 16) throw new Error('Too many pending proxy change plans; handle existing plans first')
      const planId = randomUUID(); this.#plans.set(planId, { ...who, tool: request.tool, before, after, summary })
      return { success: true, planId, summary, location: before.location, before: previous.values, after: next.values, notices: next.notices }
    }
    if (!session.sshRevision || !session.hosts.some(host => host.alias === request.alias)) throw new Error('Host was not read successfully or is not in the current list; please refresh')
    if ((await readSshDocuments(this.sshOptions, signal)).revision !== session.sshRevision) throw new Error('SSH configuration changed; refresh before connecting')
    signal.throwIfAborted()
    return this.terminal.launch('ssh', sshArguments(request.alias, request.action === 'tunnel' ? request.tunnel : undefined), signal)
  }
  async #apply(id: string, who: Owned, signal: AbortSignal) {
    const plan = this.#plans.get(id)
    if (!plan || plan.owner !== who.owner) throw new Error('Change plan expired or does not belong to this plugin; please preview again')
    this.#plans.delete(id)
    if (environmentRevision(await this.provider.read(plan.tool, signal)) !== environmentRevision(plan.before)) throw new Error('Configuration changed during confirmation; not written')
    const backup = await this.backups.save(plan.before, plan.after, plan.summary).catch(() => { throw new Error('Failed to write and verify original configuration backup; configuration not modified') })
    signal.throwIfAborted(); if (this.#stopped) throw new Error('Service stopped; not written')
    let recoveryPath: string | undefined
    try {
      recoveryPath = await this.provider.write(plan.tool, plan.before, plan.after, signal)
      const current = await this.provider.read(plan.tool, AbortSignal.timeout(15000))
      if (environmentRevision(current) !== environmentRevision(plan.after)) throw new Error('Post-write verification mismatch or file was modified externally')
      return { success: true, verified: true, summary: plan.summary, backupId: backup.id, recoveryPath }
    } catch (error) { throw new Error(`${recoveryPath ? `Post-write verification incomplete; original file retained at ${recoveryPath}; ` : ''}original backup ${backup.id} preserved, please refresh and inspect; ${message(error)}`) }
    finally { this.#sessions.clear(); this.#plans.clear() }
  }
}
