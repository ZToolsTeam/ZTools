import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { getByPath, JsonFileStore, parseStoredValue, setByPath, type JsonObject } from './json-file-store.js'

const USER_SETTINGS_FILE = 'user_settings.json'
const MY_PAGE_SETTINGS_FILE = 'my_page_settings.json'
const CATALOG_SNAPSHOT_FILE = 'catalog_snapshot.json'
const APP_CONFIG_FILE = 'app_config.json'
const ALLOWED_CONFIG_FILES = new Set([USER_SETTINGS_FILE, MY_PAGE_SETTINGS_FILE, CATALOG_SNAPSHOT_FILE])

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
  throw new ZToolsError(errorCodes.invalidRequest, 'Setting value must be serializable')
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
    CATALOG_SNAPSHOT_FILE,
    APP_CONFIG_FILE
  ])

  #cachedWakePreference: 'dashboard' | 'launcher' = 'launcher'
  readonly #localeChangeListeners = new Set<(rawLocale: unknown) => void>()

  constructor(private readonly store: JsonFileStore) {}

  /**
   * 订阅 user_settings.json 中 ui.locale（含 config_set、settings_set 与整组写 ui）落盘后的变更通知。
   */
  onLocaleSettingChanged(listener: (rawLocale: unknown) => void): () => void {
    this.#localeChangeListeners.add(listener)
    return () => {
      this.#localeChangeListeners.delete(listener)
    }
  }

  getCachedWakePreference(): 'dashboard' | 'launcher' {
    return this.#cachedWakePreference
  }

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
      throw new ZToolsError(errorCodes.invalidRequest, `Unknown feature flag: ${key}`)
    }
    await this.set(USER_SETTINGS_FILE, `features.${key}`, String(Boolean(enabled)), true)
    return Boolean(enabled)
  }

  async setFeatures(features: Partial<FeatureFlags>): Promise<FeatureFlags> {
    if (typeof features !== 'object' || features === null || Array.isArray(features)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'features must be an object')
    }
    const updates: Array<[FeatureFlagKey, boolean]> = []
    for (const [key, value] of Object.entries(features)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, key) && typeof value === 'boolean') {
        updates.push([key as FeatureFlagKey, value])
      }
    }
    if (updates.length > 0) {
      await this.store.update(USER_SETTINGS_FILE, (document) => {
        const existing = document.features
        const featureDocument: JsonObject =
          typeof existing === 'object' && existing !== null && !Array.isArray(existing)
            ? existing as JsonObject
            : {}
        document.features = featureDocument
        for (const [key, value] of updates) {
          featureDocument[key] = value
        }
        const sync = document._sync
        const syncDocument: JsonObject =
          typeof sync === 'object' && sync !== null && !Array.isArray(sync)
            ? sync as JsonObject
            : {}
        syncDocument.features = true
        document._sync = syncDocument
      })
    }
    return this.getFeatures()
  }

  /** 检查指定配置文件中是否真实存在某个键（用于区分键缺失与显式保存的默认值，如 ui.locale='system'） */
  async has(fileName: string, pathValue: string): Promise<boolean> {
    this.#requireConfigFile(fileName)
    const document = await this.store.read(fileName)
    return getByPath(document, pathValue) !== undefined
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
      const response = toResponseString(value, defaultValue)
      if (fileName === USER_SETTINGS_FILE && pathValue === 'ui.wake_preference') {
        this.#cachedWakePreference = response === 'dashboard' ? 'dashboard' : 'launcher'
      }
      return response
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
    if (group === undefined) throw new ZToolsError(errorCodes.invalidRequest, 'Invalid config path')
    if (fileName === USER_SETTINGS_FILE && pathValue === 'ui.wake_preference') {
      const normalized = String(parseStoredValue(value)).trim()
      this.#cachedWakePreference = normalized === 'dashboard' ? 'dashboard' : 'launcher'
    }
    let nextLocaleUpdate: { changed: true; value: unknown } | undefined
    await this.store.update(fileName, (document) => {
      const parsed = parseStoredValue(value)
      if (remaining.length === 0) {
        const previousGroup = document[group]
        const previousLocale =
          fileName === USER_SETTINGS_FILE &&
          group === 'ui' &&
          typeof previousGroup === 'object' &&
          previousGroup !== null &&
          !Array.isArray(previousGroup) &&
          Object.prototype.hasOwnProperty.call(previousGroup, 'locale')
            ? (previousGroup as Record<string, unknown>).locale
            : undefined
        document[group] = typeof parsed === 'object' && parsed !== null
          ? parsed
          : { value: parsed }
        if (fileName === USER_SETTINGS_FILE && group === 'ui') {
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            Object.prototype.hasOwnProperty.call(parsed, 'locale')
          ) {
            nextLocaleUpdate = { changed: true, value: (parsed as Record<string, unknown>).locale }
          } else if (
            previousLocale !== undefined &&
            previousLocale !== null &&
            String(previousLocale).trim().toLowerCase() !== '' &&
            String(previousLocale).trim().toLowerCase() !== 'system'
          ) {
            // 原先存在非 system 的显式 ui.locale，清空或整体覆盖 ui 后不再包含该键时，复位为跟随系统语言
            nextLocaleUpdate = { changed: true, value: 'system' }
          }
        }
      } else {
        const existing = document[group]
        const groupDocument: JsonObject =
          typeof existing === 'object' && existing !== null && !Array.isArray(existing)
            ? existing as JsonObject
            : {}
        document[group] = groupDocument
        setByPath(groupDocument, remaining.join('.'), parsed)
        if (fileName === USER_SETTINGS_FILE && pathValue === 'ui.locale') {
          nextLocaleUpdate = { changed: true, value: parsed }
        }
      }
      const sync = document._sync
      const syncDocument: JsonObject =
        typeof sync === 'object' && sync !== null && !Array.isArray(sync)
          ? sync as JsonObject
          : {}
      syncDocument[group] = syncEnabled
      document._sync = syncDocument
    })
    if (nextLocaleUpdate) {
      for (const listener of [...this.#localeChangeListeners]) {
        try {
          listener(nextLocaleUpdate.value)
        } catch (error) {
          console.warn('处理 ui.locale 变更钩子失败:', error)
        }
      }
    }
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
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid main window size')
    }
    return this.#persistMainWindowSize(width, height)
  }

  async #persistMainWindowSize(width: number, height: number): Promise<void> {
    const current = await this.getMainWindowSize()
    if (current && current.width === width && current.height === height) {
      return
    }
    await this.store.update(APP_CONFIG_FILE, (document) => {
      setByPath(document, 'cef.windowWidth', width)
      setByPath(document, 'cef.windowHeight', height)
    })
  }

  #requireConfigFile(fileName: string): void {
    if (!ALLOWED_CONFIG_FILES.has(fileName)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'File is not accessible via config API')
    }
  }
}
