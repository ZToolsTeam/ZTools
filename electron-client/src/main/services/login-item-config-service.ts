import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { parseStoredValue } from './json-file-store.js'
import type { ConfigService } from './config-service.js'
import type { MacosLoginItemAdapter, MacosLoginItemState } from '../platform/macos/login-item.js'

type ConfigPort = Pick<ConfigService, 'get' | 'set' | 'getSetting' | 'setSetting'>

const USER_SETTINGS_FILE = 'user_settings.json'
const AUTOSTART_PATH = 'system.autostart'
const AUTOSTART_STATUS_PATH = 'system.autostartStatus'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSystemPath(pathValue: string): boolean {
  return pathValue === 'system' || pathValue.startsWith('system.')
}

function isReadonlyStatusPath(pathValue: string): boolean {
  return pathValue === AUTOSTART_STATUS_PATH || pathValue.startsWith(`${AUTOSTART_STATUS_PATH}.`)
}

function isAutostartDescendant(pathValue: string): boolean {
  return pathValue.startsWith(`${AUTOSTART_PATH}.`)
}

function parseAutostart(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  throw new ZToolsError(errorCodes.invalidRequest, 'system.autostart 必须是布尔值')
}

function serializeSetting(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const encoded = JSON.stringify(value)
    if (encoded !== undefined) return encoded
  } catch {
    // Keep the config API's stable validation error for non-serializable settings.
  }
  throw new ZToolsError(errorCodes.invalidRequest, '设置值必须可序列化')
}

function normalizeSettingPath(key: string): string {
  if (key === 'hotkey') return 'hotkey.global'
  return key.includes('.') ? key : `system.${key}`
}

function decodeSystemDocument(value: string): Record<string, unknown> {
  if (value.trim() === '') return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new ZToolsError(errorCodes.dataCorrupt, 'system 配置不是有效 JSON 对象')
  }
  if (!isRecord(decoded)) throw new ZToolsError(errorCodes.dataCorrupt, 'system 配置必须是对象')
  return decoded
}

function decodeSystemInput(value: string): Record<string, unknown> {
  const decoded = parseStoredValue(value)
  if (!isRecord(decoded)) throw new ZToolsError(errorCodes.invalidRequest, 'system 配置必须是对象')
  return { ...decoded }
}

/**
 * Bridges the existing config API to macOS login-item state without adding an IPC method.
 * With no packaged-macOS adapter, every operation remains a direct ConfigService pass-through.
 */
export class LoginItemConfigService {
  #systemWriteTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: ConfigPort,
    private readonly loginItems?: MacosLoginItemAdapter
  ) {}

  async get(fileName: string, pathValue: string, defaultValue: unknown): Promise<string> {
    if (!this.loginItems || fileName !== USER_SETTINGS_FILE || !isSystemPath(pathValue)) {
      return this.config.get(fileName, pathValue, defaultValue)
    }
    if (isAutostartDescendant(pathValue)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'system.autostart 不能包含子路径')
    }
    if (pathValue === AUTOSTART_PATH) return String(this.loginItems.get().openAtLogin)
    if (pathValue === AUTOSTART_STATUS_PATH) return this.loginItems.get().status
    if (isReadonlyStatusPath(pathValue)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'system.autostartStatus 只允许读取')
    }
    if (pathValue !== 'system') return this.config.get(fileName, pathValue, defaultValue)

    const [stored, state] = await Promise.all([
      this.config.get(fileName, pathValue, defaultValue),
      Promise.resolve().then(() => this.loginItems!.get())
    ])
    return JSON.stringify({
      ...decodeSystemDocument(stored),
      autostart: state.openAtLogin,
      autostartStatus: state.status
    })
  }

  async set(fileName: string, pathValue: string, value: string, syncEnabled: boolean): Promise<void> {
    if (!this.loginItems || fileName !== USER_SETTINGS_FILE || !isSystemPath(pathValue)) {
      return this.config.set(fileName, pathValue, value, syncEnabled)
    }
    if (isReadonlyStatusPath(pathValue)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'system.autostartStatus 只允许读取')
    }
    if (pathValue === AUTOSTART_PATH) {
      return this.#enqueueSystemWrite(() => this.#setAutostart(value, syncEnabled))
    }
    if (isAutostartDescendant(pathValue)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'system.autostart 不能包含子路径')
    }
    if (pathValue === 'system') {
      return this.#enqueueSystemWrite(() => this.#setSystemDocument(value, syncEnabled))
    }
    return this.#enqueueSystemWrite(() => this.config.set(fileName, pathValue, value, syncEnabled))
  }

  getSetting(key: string): Promise<string> {
    if (!this.loginItems) return this.config.getSetting(key)
    const pathValue = normalizeSettingPath(key)
    if (pathValue === AUTOSTART_PATH || pathValue === AUTOSTART_STATUS_PATH || isReadonlyStatusPath(pathValue) || isAutostartDescendant(pathValue)) {
      return this.get(USER_SETTINGS_FILE, pathValue, '')
    }
    return this.config.getSetting(key)
  }

  async setSetting(key: string, value: unknown): Promise<string> {
    if (!this.loginItems) return this.config.setSetting(key, value)
    const pathValue = normalizeSettingPath(key)
    if (
      pathValue !== AUTOSTART_PATH && pathValue !== AUTOSTART_STATUS_PATH &&
      !isReadonlyStatusPath(pathValue) && !isAutostartDescendant(pathValue)
    ) return this.config.setSetting(key, value)

    const stored = serializeSetting(value)
    await this.set(USER_SETTINGS_FILE, pathValue, stored, true)
    return stored
  }

  #enqueueSystemWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#systemWriteTail.then(operation)
    this.#systemWriteTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #setAutostart(value: string, syncEnabled: boolean): Promise<void> {
    const enabled = parseAutostart(parseStoredValue(value))
    await this.#changeLoginItem(enabled, (state) =>
      this.config.set(USER_SETTINGS_FILE, AUTOSTART_PATH, String(state.openAtLogin), syncEnabled)
    )
  }

  async #setSystemDocument(value: string, syncEnabled: boolean): Promise<void> {
    const document = decodeSystemInput(value)
    if (Object.hasOwn(document, 'autostartStatus')) {
      throw new ZToolsError(errorCodes.invalidRequest, 'system.autostartStatus 只允许读取')
    }
    const includesAutostart = Object.hasOwn(document, 'autostart')
    const enabled = includesAutostart ? parseAutostart(document.autostart) : undefined
    if (enabled === undefined) {
      const state = this.loginItems!.get()
      document.autostart = state.openAtLogin
      await this.config.set(USER_SETTINGS_FILE, 'system', JSON.stringify(document), syncEnabled)
      return
    }
    await this.#changeLoginItem(enabled, (state) => {
      document.autostart = state.openAtLogin
      return this.config.set(USER_SETTINGS_FILE, 'system', JSON.stringify(document), syncEnabled)
    })
  }

  async #changeLoginItem(
    enabled: boolean,
    persist: (state: MacosLoginItemState) => Promise<void>
  ): Promise<void> {
    const previous = this.loginItems!.get()
    try {
      const applied = this.loginItems!.setEnabled(enabled)
      await persist(applied)
    } catch (error) {
      try {
        this.loginItems!.setEnabled(previous.openAtLogin)
      } catch {
        throw new ZToolsError(
          errorCodes.fileWriteOutcomeUnknown,
          'macOS 登录项设置与 user_settings.json 状态不一致：配置写入失败且无法确认 OS 回滚'
        )
      }
      throw error
    }
  }
}
