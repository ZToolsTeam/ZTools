import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { session, type Session } from 'electron'
import {
  COMPATIBILITY_MIGRATION_PAGE,
  installPluginZToolsProtocol
} from '../protocol/ztools-protocol.js'
import type { ReferenceFileResources } from '../protocol/reference-file-resources.js'
import type { ResourceRoot } from '../protocol/ztools-protocol.js'
import type { LegacyBrowserStorageMigrator } from '../runtime/legacy-browser-storage.js'
import type { FileSystemService } from '../services/file-system-service.js'
import { configureSessionSecurity } from './main-window.js'

export interface PluginSessionProvider {
  get(pluginId: string): Promise<Session>
  release?(pluginId: string): void
}

export interface PluginSessionManagerOptions {
  getReferenceResources?: () => ReferenceFileResources | undefined
  webRoot: ResourceRoot
  pluginRoot: string
  files: FileSystemService
  browserProfileRoot?: string
  legacyStorage?: LegacyBrowserStorageMigrator
  createSession?: (partition: string) => Session
}

export function pluginSessionPartition(pluginId: string): string {
  const scope = createHash('sha256').update(pluginId.toLowerCase(), 'utf8').digest('hex')
  return `persist:ztools-plugin-${scope}`
}

export class PluginSessionManager implements PluginSessionProvider {
  readonly #sessions = new Map<string, Promise<Session>>()
  readonly #createSession: (partition: string) => Session

  constructor(private readonly options: PluginSessionManagerOptions) {
    this.#createSession = options.createSession ?? ((partition) => session.fromPartition(partition))
  }

  get(pluginId: string): Promise<Session> {
    const key = pluginId.toLowerCase()
    const existing = this.#sessions.get(key)
    if (existing) return existing

    const pending = this.#prepare(pluginId).catch((error: unknown) => {
      this.#sessions.delete(key)
      throw error
    })
    this.#sessions.set(key, pending)
    return pending
  }

  release(pluginId: string): void {
    const key = pluginId.toLowerCase()
    this.#sessions.delete(key)
  }

  async #prepare(pluginId: string): Promise<Session> {
    if (this.options.browserProfileRoot) {
      await fs.mkdir(this.options.browserProfileRoot, { recursive: true })
    }
    const targetSession = this.#createSession(pluginSessionPartition(pluginId))
    const scopedRoots = await this.options.files.preparePluginProtocolRoots(pluginId)
    const references = this.options.getReferenceResources?.()
    configureSessionSecurity(this.options.files, references, targetSession)
    installPluginZToolsProtocol(
      {
        web: this.options.webRoot,
        plugin: path.join(this.options.pluginRoot, pluginId),
        ...(this.options.legacyStorage
          ? { migrationPage: COMPATIBILITY_MIGRATION_PAGE }
          : {}),
        ...scopedRoots
      },
      this.options.files,
      pluginId,
      targetSession.protocol
    )
    await this.options.legacyStorage?.migratePlugin(pluginId, targetSession)
    return targetSession
  }
}
