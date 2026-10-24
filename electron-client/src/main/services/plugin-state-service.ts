import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { JsonFileStore, type JsonObject } from './json-file-store.js'

export const PLUGIN_STATE_FILE = 'plugin_state.json'

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type PluginStateRecord = Record<string, unknown>

export interface PluginStateProvider {
  readAll(): Promise<JsonObject>
  isEnabled(pluginId: string, manifestDefault: boolean): Promise<boolean>
  toggleEnabled(pluginId: string, manifestDefault: boolean): Promise<boolean>
  markUsed(pluginId: string): Promise<void>
  setIconUrl(pluginId: string, iconUrl: string): Promise<void>
  isRevoked?(pluginId: string): Promise<{ revoked: boolean; reason?: string | undefined }>
  setRevoked?(pluginId: string, revoked: boolean, reason?: string | undefined): Promise<void>
  update(pluginId: string, mutate: (state: PluginStateRecord) => void): Promise<void>
}

function validatePluginId(pluginId: string): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new ZToolsError(errorCodes.invalidRequest, '插件 ID 无效')
  }
}

function isRecord(value: unknown): value is PluginStateRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stateKey(document: JsonObject, pluginId: string): string {
  if (Object.hasOwn(document, pluginId)) return pluginId
  return Object.keys(document).find((key) => key.toLowerCase() === pluginId.toLowerCase()) ?? pluginId
}

function currentState(document: JsonObject, pluginId: string): PluginStateRecord {
  const value = document[stateKey(document, pluginId)]
  return isRecord(value) ? value : {}
}

function timestamp(): string {
  return new Date().toISOString()
}

export class PluginStateService implements PluginStateProvider {
  readonly #store: JsonFileStore

  constructor(dataRoot: string) {
    this.#store = new JsonFileStore(dataRoot, new Set([PLUGIN_STATE_FILE]))
  }

  readAll(): Promise<JsonObject> {
    return this.#store.read(PLUGIN_STATE_FILE)
  }

  async isRevoked(pluginId: string): Promise<{ revoked: boolean; reason?: string | undefined }> {
    validatePluginId(pluginId)
    const state = currentState(await this.readAll(), pluginId)
    const revoked = state.revoked === true
    const reason = typeof state.revoked_reason === 'string'
      ? state.revoked_reason
      : (typeof state.revokedReason === 'string' ? state.revokedReason : undefined)
    return reason !== undefined ? { revoked, reason } : { revoked }
  }

  async setRevoked(pluginId: string, revoked: boolean, reason?: string | undefined): Promise<void> {
    validatePluginId(pluginId)
    await this.update(pluginId, (state) => {
      state.revoked = revoked
      if (revoked) {
        state.enabled = false
        state.revoked_reason = reason || '该插件已被官方下架禁用'
        state.revoked_at = timestamp()
      } else {
        delete state.revoked
        delete state.revoked_reason
        delete state.revoked_at
      }
    })
  }

  async isEnabled(pluginId: string, manifestDefault: boolean): Promise<boolean> {
    validatePluginId(pluginId)
    const state = currentState(await this.readAll(), pluginId)
    if (state.revoked === true) return false
    return typeof state.enabled === 'boolean' ? state.enabled : manifestDefault
  }

  async toggleEnabled(pluginId: string, manifestDefault: boolean): Promise<boolean> {
    let enabled = manifestDefault
    await this.update(pluginId, (state) => {
      enabled = typeof state.enabled === 'boolean' ? !state.enabled : !manifestDefault
      state.enabled = enabled
    })
    return enabled
  }

  async markUsed(pluginId: string): Promise<void> {
    await this.update(pluginId, (state) => {
      const useCount = Number.isSafeInteger(state.use_count) && (state.use_count as number) >= 0
        ? state.use_count as number
        : 0
      const now = timestamp()
      state.use_count = Math.min(useCount + 1, Number.MAX_SAFE_INTEGER)
      state.last_used_at = now
      state.updated_at = now
    })
  }

  setIconUrl(pluginId: string, iconUrl: string): Promise<void> {
    return this.update(pluginId, (state) => {
      state.icon_url = iconUrl
      state.updated_at = timestamp()
    })
  }

  async remove(pluginId: string): Promise<void> {
    validatePluginId(pluginId)
    await this.#store.update(PLUGIN_STATE_FILE, (document) => {
      const key = Object.keys(document).find((candidate) => candidate.toLowerCase() === pluginId.toLowerCase())
      if (key !== undefined) delete document[key]
    })
  }

  update(pluginId: string, mutate: (state: PluginStateRecord) => void): Promise<void> {
    validatePluginId(pluginId)
    return this.#store.update(PLUGIN_STATE_FILE, (document) => {
      const key = stateKey(document, pluginId)
      const next = { ...currentState(document, pluginId) }
      mutate(next)
      document[key] = next
    })
  }
}
