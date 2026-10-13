import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { AnalyticsReportParams } from '../../contracts/method-params.js'
import type { JsonFileStore } from './json-file-store.js'

const execFileAsync = promisify(execFile)
const DEFAULT_API_BASE = 'https://api.ztools.cn'

export interface AnalyticsMetadata {
  deviceCode: string
  source: string
}

export type RegistryMetadata = AnalyticsMetadata

export interface AnalyticsStorage {
  get(key: string): Promise<string | null | undefined>
  set(key: string, value: string): Promise<void>
}

export interface AnalyticsServiceOptions {
  appVersion: string
  webVersion?: string
  apiBase?: string
  fetchImpl?: typeof fetch
  resolveMetadata?: () => Promise<AnalyticsMetadata>
  readRegistryMetadata?: () => Promise<AnalyticsMetadata>
  now?: () => Date
  telemetryEnabled?: boolean
  store?: JsonFileStore
  storage?: AnalyticsStorage
  dataRoot?: string
  configPath?: string
  getUserId?: () => Promise<string | null | undefined>
}

function formatTimestamp(value: Date): string {
  const part = (item: number): string => String(item).padStart(2, '0')
  return `${value.getFullYear()}-${part(value.getMonth() + 1)}-${part(value.getDate())} ${part(value.getHours())}:${part(value.getMinutes())}:${part(value.getSeconds())}`
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readRegistryValue(key: string, name: string): Promise<string> {
  if (process.platform !== 'win32') return ''
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', name], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    })
    const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi')
    return pattern.exec(stdout)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

async function resolveRegistryMetadata(): Promise<AnalyticsMetadata> {
  const [deviceCode, source] = await Promise.all([
    readRegistryValue('HKCU\\Software\\csglobal', 'guid'),
    readRegistryValue('HKCU\\Software\\ZTools', 'source')
  ])
  return { deviceCode, source: source || 'none' }
}

function createStorageAdapter(options: AnalyticsServiceOptions): AnalyticsStorage {
  if (options.storage) return options.storage
  if (options.store) {
    const store = options.store
    return {
      async get(key: string): Promise<string | null | undefined> {
        try {
          const doc = await store.read('app_config.json')
          if (key === 'device_code') {
            return typeof doc.device_code === 'string' ? doc.device_code : null
          }
          if (key === 'source') {
            return typeof doc.analytics_source === 'string'
              ? doc.analytics_source
              : (typeof doc.source === 'string' ? doc.source : null)
          }
          const val = doc[key]
          return typeof val === 'string' ? val : null
        } catch {
          return null
        }
      },
      async set(key: string, value: string): Promise<void> {
        try {
          await store.update('app_config.json', (doc) => {
            if (key === 'source') {
              doc.analytics_source = value
            } else {
              doc[key] = value
            }
          })
        } catch (err) {
          console.warn('[analytics] 更新本地存储失败:', err)
        }
      }
    }
  }

  const filePath = options.configPath ?? (
    options.dataRoot
      ? path.join(options.dataRoot, 'app_config.json')
      : null
  )

  if (filePath) {
    return {
      async get(key: string): Promise<string | null | undefined> {
        try {
          const text = await fs.readFile(filePath, 'utf8')
          const doc = JSON.parse(text) as Record<string, unknown>
          if (key === 'device_code') {
            return typeof doc.device_code === 'string' ? doc.device_code : null
          }
          if (key === 'source') {
            return typeof doc.analytics_source === 'string'
              ? doc.analytics_source
              : (typeof doc.source === 'string' ? doc.source : null)
          }
          const val = doc[key]
          return typeof val === 'string' ? val : null
        } catch {
          return null
        }
      },
      async set(key: string, value: string): Promise<void> {
        try {
          let doc: Record<string, unknown> = {}
          try {
            const text = await fs.readFile(filePath, 'utf8')
            doc = JSON.parse(text) as Record<string, unknown>
          } catch {
            doc = {}
          }
          if (key === 'source') {
            doc.analytics_source = value
          } else {
            doc[key] = value
          }
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf8')
        } catch (err) {
          console.warn('[analytics] 写入本地配置失败:', err)
        }
      }
    }
  }

  const memory = new Map<string, string>()
  return {
    get: async (key: string) => memory.get(key) ?? null,
    set: async (key: string, value: string) => { memory.set(key, value) }
  }
}

export class AnalyticsService {
  readonly #stopController = new AbortController()
  readonly #fetch: typeof fetch
  readonly #readRegistryMetadata: () => Promise<AnalyticsMetadata>
  readonly #storage: AnalyticsStorage
  readonly #now: () => Date
  #metadataPromise: Promise<AnalyticsMetadata> | undefined
  #metadataValue: AnalyticsMetadata | undefined
  readonly #apiBase: string
  #telemetryEnabled: boolean

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.#fetch = options.fetchImpl ?? fetch
    this.#readRegistryMetadata = options.readRegistryMetadata ?? resolveRegistryMetadata
    this.#storage = createStorageAdapter(options)
    this.#now = options.now ?? (() => new Date())
    this.#apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    this.#telemetryEnabled = options.telemetryEnabled ?? true
  }

  isTelemetryEnabled(): boolean {
    return this.#telemetryEnabled
  }

  setTelemetryEnabled(enabled: boolean): void {
    this.#telemetryEnabled = Boolean(enabled)
  }

  report(params: AnalyticsReportParams, caller: CallerIdentity): void {
    if (!this.#telemetryEnabled) return
    const pluginId = caller.type === 'plugin' ? caller.pluginId ?? '' : params.plugin_id
    void this.#send(params, pluginId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '未知错误'
      console.warn(`[analytics] 上报失败: ${message}`)
    })
  }

  reportHost(
    event: string,
    pluginId: string,
    webVersion = this.options.webVersion ?? '',
    data?: unknown
  ): void {
    this.report({
      event,
      plugin_id: pluginId,
      web_version: webVersion,
      ...(data === undefined ? {} : { data })
    }, { type: 'main', webContentsId: 0 })
  }

  reportPluginRecord(
    record: 'active' | 'install' | 'uninstall',
    pluginId: string,
    accessToken = ''
  ): void {
    if (!this.#telemetryEnabled || !pluginId) return
    void this.#sendPluginRecord(record, pluginId, accessToken).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '未知错误'
      console.warn(`[analytics] 插件 ${record} 上报失败: ${message}`)
    })
  }

  async getRegistrySource(): Promise<string> {
    return (await this.#resolveMetadata()).source
  }

  async getDeviceCode(): Promise<string> {
    return (await this.#resolveMetadata()).deviceCode
  }

  async getMetadata(): Promise<AnalyticsMetadata> {
    return this.#resolveMetadata()
  }

  stop(): void {
    if (!this.#stopController.signal.aborted) this.#stopController.abort()
  }

  async #resolveMetadata(): Promise<AnalyticsMetadata> {
    if (this.#metadataValue) {
      return this.#metadataValue
    }
    if (this.#metadataPromise) {
      return this.#metadataPromise
    }

    this.#metadataPromise = (async () => {
      if (this.options.resolveMetadata) {
        this.#metadataValue = await this.options.resolveMetadata()
        return this.#metadataValue
      }

      let storedDeviceCode: string | undefined
      let storedSource: string | undefined

      try {
        const code = await this.#storage.get('device_code')
        if (typeof code === 'string' && code.trim().length > 0) {
          storedDeviceCode = code.trim()
        }
        const src = await this.#storage.get('source')
        if (typeof src === 'string' && src.trim().length > 0) {
          storedSource = src.trim()
        }
      } catch (error) {
        console.warn('[analytics] 读取持久化配置失败:', error)
      }

      if (storedDeviceCode) {
        if (!storedSource) {
          const regMeta = await this.#readRegistryMetadata().catch(() => ({ deviceCode: '', source: 'none' }))
          storedSource = regMeta.source || 'none'
          await this.#storage.set('source', storedSource).catch(() => {})
        }
        this.#metadataValue = {
          deviceCode: storedDeviceCode,
          source: storedSource || 'none'
        }
        return this.#metadataValue
      }

      // 注册表旧版兼容 fallback
      const registryMeta = await this.#readRegistryMetadata().catch(() => ({ deviceCode: '', source: 'none' }))
      let deviceCode = registryMeta.deviceCode?.trim() ?? ''
      let source = registryMeta.source?.trim() || 'none'

      if (deviceCode) {
        // 从注册表读取到旧版数据，迁移并保存到本地
        try {
          await this.#storage.set('device_code', deviceCode)
          await this.#storage.set('source', source)
        } catch (err) {
          console.warn('[analytics] 迁移注册表设备标识失败:', err)
        }
      } else {
        // 未检测到旧版标识，生成 36 位标准 UUID 并持久化
        deviceCode = randomUUID()
        source = source || 'none'
        try {
          await this.#storage.set('device_code', deviceCode)
          await this.#storage.set('source', source)
        } catch (err) {
          console.warn('[analytics] 保存生成的设备标识失败:', err)
        }
      }

      this.#metadataValue = { deviceCode, source }
      return this.#metadataValue
    })()

    return this.#metadataPromise
  }

  async #send(params: AnalyticsReportParams, pluginId: string): Promise<void> {
    if (!this.#telemetryEnabled || this.#apiBase === '' || this.#stopController.signal.aborted) return
    const metadata = await this.#resolveMetadata()
    if (metadata.deviceCode === '') throw new Error('设备标识为空')
    const body: Record<string, unknown> = {
      event: params.event,
      device_code: metadata.deviceCode,
      client: params.client || 'app',
      source: metadata.source,
      app_version: normalizeVersion(this.options.appVersion),
      web_version: normalizeVersion(params.web_version || (this.options.webVersion ?? '')),
      plugin_id: pluginId,
      timestamp: formatTimestamp(this.#now())
    }
    if (params.data !== undefined) body.data = JSON.stringify(params.data)

    const userId = params.user_id !== undefined && params.user_id !== null && params.user_id !== ''
      ? params.user_id
      : (await this.options.getUserId?.().catch(() => null))

    if (userId) {
      body.user_id = userId
    }

    const signal = AbortSignal.any([
      this.#stopController.signal,
      AbortSignal.timeout(5000)
    ])
    const response = await this.#fetch(`${this.#apiBase}/api/analytics/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }

  async #sendPluginRecord(
    record: 'active' | 'install' | 'uninstall',
    pluginId: string,
    accessToken: string
  ): Promise<void> {
    if (!this.#telemetryEnabled || this.#apiBase === '' || this.#stopController.signal.aborted) return
    const signal = AbortSignal.any([
      this.#stopController.signal,
      AbortSignal.timeout(5000)
    ])
    const response = await this.#fetch(
      `${this.#apiBase}/api/plugins/${encodeURIComponent(pluginId)}/${record}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        body: '{}',
        signal
      }
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }
}
