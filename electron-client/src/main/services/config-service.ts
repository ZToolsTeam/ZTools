import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { getByPath, JsonFileStore, parseStoredValue, setByPath, type JsonObject } from './json-file-store.js'

const USER_SETTINGS_FILE = 'user_settings.json'
const MY_PAGE_SETTINGS_FILE = 'my_page_settings.json'
const USER_ACCOUNT_FILE = 'user_account.json'
const APP_CONFIG_FILE = 'app_config.json'
const ALLOWED_CONFIG_FILES = new Set([USER_SETTINGS_FILE, MY_PAGE_SETTINGS_FILE])

function toStoredString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const encoded = JSON.stringify(value)
    if (encoded !== undefined) return encoded
  } catch {
    // Structured clone normally rejects this before IPC; keep a stable public error.
  }
  throw new ZToolsError(errorCodes.invalidRequest, '设置值必须可序列化')
}

function toResponseString(value: unknown, defaultValue: unknown): string {
  if (value === undefined) return toStoredString(defaultValue)
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

export interface FeatureFlags {
  unifiedKeymap: boolean
  commandPalette: boolean
  dashboardStage: boolean
  silentInstall: boolean
  extensionHost: boolean
  scriptCommands: boolean
  extensionTools: boolean
}

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  unifiedKeymap: false,
  commandPalette: false,
  dashboardStage: false,
  silentInstall: false,
  extensionHost: false,
  scriptCommands: false,
  extensionTools: false
})

export type FeatureFlagKey = keyof FeatureFlags

function normalizeSettingPath(key: string): string {
  if (key === 'hotkey') return 'hotkey.global'
  if (key === 'features' || key.startsWith('features.')) return key
  return key.includes('.') ? key : `system.${key}`
}

export class ConfigService {
  static readonly allowedStoreFiles: ReadonlySet<string> = new Set([
    USER_SETTINGS_FILE,
    MY_PAGE_SETTINGS_FILE,
    USER_ACCOUNT_FILE,
    APP_CONFIG_FILE
  ])

  constructor(private readonly store: JsonFileStore) {}

  async getFeatures(): Promise<FeatureFlags> {
    const result: FeatureFlags = { ...DEFAULT_FEATURE_FLAGS }
    try {
      const document = await this.store.read(USER_SETTINGS_FILE)
      const storedFeatures = document.features
      if (typeof storedFeatures === 'object' && storedFeatures !== null && !Array.isArray(storedFeatures)) {
        for (const key of Object.keys(DEFAULT_FEATURE_FLAGS) as FeatureFlagKey[]) {
          const val = (storedFeatures as Record<string, unknown>)[key]
          if (typeof val === 'boolean') {
            result[key] = val
          } else if (typeof val === 'string') {
            if (val === 'true') result[key] = true
            else if (val === 'false') result[key] = false
          }
        }
      }
    } catch {
      // 配置文件损坏或缺失字段时不崩溃，优雅回退默认
    }
    return result
  }

  async getFeature(key: FeatureFlagKey | string): Promise<boolean> {
    const features = await this.getFeatures()
    if (Object.prototype.hasOwnProperty.call(features, key)) {
      return features[key as FeatureFlagKey]
    }
    return false
  }

  async setFeature(key: FeatureFlagKey | string, enabled: boolean): Promise<boolean> {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, key)) {
      throw new ZToolsError(errorCodes.invalidRequest, `未知的 feature flag: ${key}`)
    }
    await this.set(USER_SETTINGS_FILE, `features.${key}`, String(Boolean(enabled)), true)
    return Boolean(enabled)
  }

  async setFeatures(features: Partial<FeatureFlags>): Promise<FeatureFlags> {
    if (typeof features !== 'object' || features === null || Array.isArray(features)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'features 必须是对象')
    }
    for (const [key, value] of Object.entries(features)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, key) && typeof value === 'boolean') {
        await this.setFeature(key as FeatureFlagKey, value)
      }
    }
    return this.getFeatures()
  }

  async get(fileName: string, pathValue: string, defaultValue: unknown): Promise<string> {
    this.#requireConfigFile(fileName)
    try {
      const document = await this.store.read(fileName)
      const value = getByPath(document, pathValue)
      if (value === undefined && fileName === USER_SETTINGS_FILE) {
        if (pathValue === 'features') {
          return JSON.stringify(await this.getFeatures())
        }
        if (pathValue.startsWith('features.')) {
          const subKey = pathValue.slice('features.'.length) as FeatureFlagKey
          if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, subKey)) {
            return String(await this.getFeature(subKey))
          }
        }
      }
      return toResponseString(value, defaultValue)
    } catch (error) {
      if (fileName === USER_SETTINGS_FILE) {
        if (pathValue === 'features') {
          return JSON.stringify(await this.getFeatures())
        }
        if (pathValue.startsWith('features.')) {
          const subKey = pathValue.slice('features.'.length) as FeatureFlagKey
          if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, subKey)) {
            return String(await this.getFeature(subKey))
          }
        }
      }
      throw error
    }
  }

  async set(fileName: string, pathValue: string, value: string, syncEnabled: boolean): Promise<void> {
    this.#requireConfigFile(fileName)
    const [group, ...remaining] = pathValue.split('.')
    if (group === undefined) throw new ZToolsError(errorCodes.invalidRequest, '配置路径无效')
    await this.store.update(fileName, (document) => {
      if (remaining.length === 0) {
        const parsed = parseStoredValue(value)
        document[group] = typeof parsed === 'object' && parsed !== null
          ? parsed
          : { value: parsed }
      } else {
        const existing = document[group]
        const groupDocument: JsonObject =
          typeof existing === 'object' && existing !== null && !Array.isArray(existing)
            ? existing as JsonObject
            : {}
        document[group] = groupDocument
        setByPath(groupDocument, remaining.join('.'), parseStoredValue(value))
      }
      const sync = document._sync
      const syncDocument: JsonObject =
        typeof sync === 'object' && sync !== null && !Array.isArray(sync)
          ? sync as JsonObject
          : {}
      syncDocument[group] = syncEnabled
      document._sync = syncDocument
    })
  }

  async getSetting(key: string): Promise<string> {
    const normalized = normalizeSettingPath(key)
    if (normalized === 'features') {
      const flags = await this.getFeatures()
      return JSON.stringify(flags)
    }
    if (normalized.startsWith('features.')) {
      const subKey = normalized.slice('features.'.length) as FeatureFlagKey
      if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, subKey)) {
        const flagVal = await this.getFeature(subKey)
        return String(flagVal)
      }
    }
    return this.get(USER_SETTINGS_FILE, normalized, '')
  }

  async setSetting(key: string, value: unknown): Promise<string> {
    const stored = toStoredString(value)
    await this.set(USER_SETTINGS_FILE, normalizeSettingPath(key), stored, true)
    return stored
  }

  async getMainWindowSize(): Promise<{ width: number; height: number } | undefined> {
    try {
      const document = await this.store.read(APP_CONFIG_FILE)
      const width = getByPath(document, 'cef.windowWidth')
      const height = getByPath(document, 'cef.windowHeight')
      if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined
      if ((width as number) < 320 || (height as number) < 240 ||
          (width as number) > 8192 || (height as number) > 8192) return undefined
      return { width: width as number, height: height as number }
    } catch {
      return undefined
    }
  }

  setMainWindowSize(width: number, height: number): Promise<void> {
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 320 || height < 240 || width > 8192 || height > 8192) {
      throw new ZToolsError(errorCodes.invalidRequest, '主窗口尺寸无效')
    }
    return this.store.update(APP_CONFIG_FILE, (document) => {
      setByPath(document, 'cef.windowWidth', width)
      setByPath(document, 'cef.windowHeight', height)
    })
  }

  #requireConfigFile(fileName: string): void {
    if (!ALLOWED_CONFIG_FILES.has(fileName)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'config API 不允许访问该文件')
    }
  }
}
