import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { PathGrantRef } from '../../contracts/path-reference.js'
import { PATH_REFERENCE_CONTRACT_VERSION } from '../../contracts/path-reference.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import { IPC_EVENT_CHANNEL } from '../../contracts/ipc.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import type { PathGrantService } from './path-grant-service.js'

const maximumFiles = 100, maximumFileBytes = 512 * 1024 * 1024, maximumTotalBytes = 2 * 1024 ** 3
type DropRef = PathGrantRef & { fileUrl: string }
type DropError = { index: number; code: string; message: string }
type DropGrants = Pick<PathGrantService, 'create' | 'describe' | 'resourceUrl' | 'revoke'>
const failed = () => new ZToolsError(errorCodes.fileError, '拖放文件授权或交付未完成')

/** Only isolated preload's trusted native File event uses this private channel. Not a public path-grant API. */
export class ReferenceFileDropService {
  #requests = 0
  readonly #owners = new Map<number, number>()
  readonly #pending = new Set<{ owner: number; controller: AbortController; finished: Promise<unknown> }>()
  readonly #unlisten: () => void
  #stopped = false
  #cleanupFailed = false
  #stopping?: Promise<void>
  constructor(private readonly registry: Pick<WindowRegistry, 'get' | 'send'> & Partial<Pick<WindowRegistry, 'onRemoved'>>,
    private readonly grants: DropGrants, private readonly cleanupMs = 10_000) {
    if (!Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 30_000) throw failed()
    this.#unlisten = registry.onRemoved?.(owner => {
      for (const record of this.#pending) if (record.owner === owner) record.controller.abort()
    }) ?? (() => {})
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#stopped = true; this.#unlisten()
    const pending = [...this.#pending]
    for (const record of pending) record.controller.abort()
    this.#stopping = (async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([Promise.allSettled(pending.map(record => record.finished)), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failed()), this.cleanupMs)
        })])
        if (this.#cleanupFailed) throw failed()
      } finally { if (timer) clearTimeout(timer) }
    })()
    return this.#stopping
  }

  async accept(webContentsId: number, value: unknown, signal?: AbortSignal, validateIdentity?: () => void): Promise<{ success: true; accepted: number; rejected: number }> {
    const caller = this.#caller(webContentsId)
    const count = this.#owners.get(webContentsId) ?? 0
    if (this.#requests >= 8 || count >= 2 || signal?.aborted) throw failed()
    this.#requests++; this.#owners.set(webContentsId, count + 1)
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const finished = Promise.resolve().then(() => this.#accept(caller, value, combined, validateIdentity))
    const pending = { owner: webContentsId, controller, finished }; this.#pending.add(pending)
    try { return await finished }
    finally {
      this.#pending.delete(pending)
      this.#requests--
      const remaining = this.#owners.get(webContentsId)! - 1
      if (remaining) this.#owners.set(webContentsId, remaining); else this.#owners.delete(webContentsId)
    }
  }

  async #accept(caller: CallerIdentity, value: unknown, signal?: AbortSignal, validateIdentity?: () => void) {
    validateIdentity?.()
    if (signal?.aborted) throw failed()
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as Record<string, unknown>
      if (Object.keys(v).length !== 1 || !Number.isSafeInteger(v.overflowCount) || Number(v.overflowCount) <= maximumFiles || Number(v.overflowCount) > 1_000_000) {
        throw new ZToolsError(errorCodes.invalidRequest, '拖放文件数量无效')
      }
      return this.#publish(caller, [], [{ index: -1, code: errorCodes.fileTooLarge, message: '一次最多拖入100个文件' }], Number(v.overflowCount), validateIdentity)
    }
    if (!Array.isArray(value) || !value.length || value.length > maximumFiles) throw new ZToolsError(errorCodes.invalidRequest, '拖放文件数量须为1..100')
    const references: DropRef[] = [], errors: DropError[] = [], acquired = new Set<string>(), seen = new Set<string>()
    let totalBytes = 0
    try {
      for (let index = 0; index < value.length; index++) {
        let current: string | undefined
        try {
          this.#caller(caller.webContentsId, caller); validateIdentity?.()
          if (signal?.aborted) throw failed()
          const selected: unknown = value[index]
          if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0') || Buffer.byteLength(selected) > 4096) {
            throw new ZToolsError(errorCodes.invalidRequest, '拖放原生选择无效')
          }
          if (seen.has(selected)) continue
          const grant = await this.grants.create(caller.webContentsId, selected, 'file', ['read'], signal)
          current = grant.grantId; acquired.add(current)
          const metadata = await this.grants.describe(caller.webContentsId, current, signal)
          this.#caller(caller.webContentsId, caller); validateIdentity?.()
          if (signal?.aborted || grant.kind !== 'file' || !/^[A-Za-z0-9_-]{43}$/.test(current) || metadata.isDirectory) throw failed()
          if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maximumFileBytes || metadata.size > maximumTotalBytes - totalBytes) {
            throw new ZToolsError(errorCodes.fileTooLarge, '拖放文件超过大小上限')
          }
          const fileUrl = this.grants.resourceUrl(caller.webContentsId, current)
          references.push(Object.freeze({ grantId: current, displayName: grant.displayName, kind: 'file', operations: Object.freeze(['read'] as const), fileUrl }))
          seen.add(selected); totalBytes += metadata.size
        } catch (error) {
          if (current) {
            // Failed entries never retain an undisclosed active grant.
            try { await this.grants.revoke(caller.webContentsId, current); acquired.delete(current) }
            catch { this.#cleanupFailed = true; throw failed() }
          }
          errors.push({ index, ...toPublicError(error instanceof ZToolsError ? error : failed()) })
        }
      }
      this.#caller(caller.webContentsId, caller)
      if (signal?.aborted) throw failed()
      return this.#publish(caller, references, errors, errors.length, validateIdentity)
    } catch (error) {
      const cleanup = await Promise.allSettled([...acquired].map(id => this.grants.revoke(caller.webContentsId, id)))
      if (cleanup.some(result => result.status === 'rejected')) { this.#cleanupFailed = true; throw failed() }
      throw error
    }
  }

  #publish(caller: CallerIdentity, files: DropRef[], errors: DropError[], rejected: number, validateIdentity?: () => void) {
    validateIdentity?.()
    this.#caller(caller.webContentsId, caller)
    const delivered = this.registry.send(caller.webContentsId, IPC_EVENT_CHANNEL, { msgType: 'event_envelope', msgData: {
      envelope: { envelopeId: `host_${randomUUID()}`, version: 'v1', timestamp: Date.now(), type: 'plugin_files_dropped',
        scope: 'plugin', source: { kind: 'host' }, target: { pluginId: caller.pluginId }, payload: { contractVersion: PATH_REFERENCE_CONTRACT_VERSION, files, errors } }
    } })
    if (!delivered) throw failed()
    return { success: true as const, accepted: files.length, rejected }
  }

  #caller(owner: number, expected?: CallerIdentity): CallerIdentity {
    if (this.#stopped) throw failed()
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new ZToolsError(errorCodes.permissionDenied, '拖放窗口身份无效')
    const caller = this.registry.get(owner)
    if (!caller || caller.type !== 'plugin' || caller.webContentsId !== owner || !caller.pluginId || !caller.pluginInstanceId ||
        (expected && (caller.pluginId !== expected.pluginId || caller.pluginInstanceId !== expected.pluginInstanceId))) {
      throw new ZToolsError(errorCodes.permissionDenied, '拖放调用者不是当前注册插件实例')
    }
    return { ...caller }
  }
}
