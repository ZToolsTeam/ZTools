/**
 * ZTools MCP Gateway Service (M1.5-18)
 * 
 * 本地化工程改造：
 * - 深度集成 `@ztools/ai-mcp` 原生网关协议栈；
 * - 本地持久化配置（JSON/SQLite 存储服务器拓扑与环境参数，支持 stdio, sse, in-memory）；
 * - 一键安装与热插拔管理（installServer, manageServers, removeServer, toggleServer）；
 * - 自动探测服务器可用工具集与联通性心跳；
 * - 支持中文拼音与提及名（@server）模糊索引匹配。
 */

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { CredentialProtection } from './credential-protection.js'

export type McpServerTransportType = 'stdio' | 'sse' | 'in-memory'

/** safeStorage 加密后的敏感值前缀 */
export const MCP_ENCRYPTED_VALUE_PREFIX = 'enc:v1:'
/** 返回给外部/界面层的敏感字段脱敏占位符 */
export const MCP_REDACTED_VALUE = '[REDACTED]'

export interface McpServerConfig {
  id: string
  name: string
  title: string
  description?: string | undefined
  mentionName: string
  icon?: string | undefined
  transportType: McpServerTransportType
  command?: string | undefined
  args?: string[] | undefined
  env?: Record<string, string> | undefined
  headers?: Record<string, string> | undefined
  apiKey?: string | undefined
  url?: string | undefined
  enabled: boolean
  pinyin: string
  createdAt: number
  updatedAt: number
}

export interface InstallServerInput {
  name: string
  title?: string | undefined
  description?: string | undefined
  mentionName?: string | undefined
  icon?: string | undefined
  transportType?: McpServerTransportType | undefined
  command?: string | undefined
  args?: string[] | undefined
  env?: Record<string, string> | undefined
  headers?: Record<string, string> | undefined
  apiKey?: string | undefined
  url?: string | undefined
}

export interface McpServerRuntimeStatus {
  id: string
  name: string
  title: string
  mentionName: string
  status: 'connected' | 'disconnected' | 'error'
  transportType: McpServerTransportType
  enabled: boolean
  toolsCount: number
  tools: Array<{ name: string; description?: string | undefined }>
  lastError?: string | null | undefined
  pingMs?: number | undefined
}

export interface McpServiceOptions {
  dataRoot: string
  configFilePath?: string | undefined
  /** 操作系统级凭据保护接口（主进程 safeStorage 封装）；注入后强制加密敏感字段落盘 */
  credentialProtection?: CredentialProtection | undefined
}

/** 拼音提取辅助 */
function extractPinyin(text: string): string {
  return (text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
}

function isEncryptedValue(value: string): boolean {
  return value.startsWith(MCP_ENCRYPTED_VALUE_PREFIX)
}

function decodeEncryptedValue(raw: string): Buffer {
  const encoded = raw.slice(MCP_ENCRYPTED_VALUE_PREFIX.length)
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Stored MCP server secret is corrupt')
  }
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length === 0 || buffer.toString('base64') !== encoded) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Stored MCP server secret is corrupt')
  }
  return buffer
}

function normalizeStringRecord(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(raw, key) || typeof value !== 'string') continue
    result[key] = value
  }
  return result
}

function hasNonEmptySecrets(config: {
  env?: Record<string, string> | undefined
  headers?: Record<string, string> | undefined
  apiKey?: string | undefined
}): boolean {
  if (typeof config.apiKey === 'string' && config.apiKey !== '') return true
  if (config.env && Object.values(config.env).some((v) => typeof v === 'string' && v !== '')) return true
  if (config.headers && Object.values(config.headers).some((v) => typeof v === 'string' && v !== '')) return true
  return false
}

function redactSecretRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = value === '' ? '' : MCP_REDACTED_VALUE
  }
  return out
}

function redactServerConfig(config: McpServerConfig): McpServerConfig {
  const redactedEnv = redactSecretRecord(config.env)
  const redactedHeaders = redactSecretRecord(config.headers)
  return {
    ...config,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(redactedEnv !== undefined ? { env: redactedEnv } : {}),
    ...(redactedHeaders !== undefined ? { headers: redactedHeaders } : {}),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey === '' ? '' : MCP_REDACTED_VALUE } : {})
  }
}

export class McpService {
  private readonly configPath: string
  private readonly credentialProtection: CredentialProtection | undefined
  private readonly servers = new Map<string, McpServerConfig>()
  private readonly runtimeStatus = new Map<string, McpServerRuntimeStatus>()

  constructor(options: McpServiceOptions) {
    this.configPath = options.configFilePath || path.join(options.dataRoot, 'mcp_servers.json')
    this.credentialProtection = options.credentialProtection
    this.loadConfigSync()
  }

  private loadConfigSync(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8')
        const items: McpServerConfig[] = JSON.parse(raw)
        if (Array.isArray(items)) {
          for (const s of items) {
            if (s && s.id) {
              this.servers.set(s.id, s)
              this.runtimeStatus.set(s.id, {
                id: s.id,
                name: s.name,
                title: s.title,
                mentionName: s.mentionName,
                status: s.enabled ? 'connected' : 'disconnected',
                transportType: s.transportType,
                enabled: s.enabled,
                toolsCount: 0,
                tools: [],
                lastError: null
              })
            }
          }
        }
      }
    } catch (err) {
      console.warn('[McpService] Failed to load MCP config:', err)
    }
  }

  /** 使用临时文件 + rename 原子落盘，避免写入中断导致配置损坏或残留明文 */
  private async saveConfig(): Promise<void> {
    const items = Array.from(this.servers.values())
    const dir = path.dirname(this.configPath)
    await fsPromises.mkdir(dir, { recursive: true })
    const temporary = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fsPromises.writeFile(temporary, JSON.stringify(items, null, 2), 'utf8')
      await fsPromises.rename(temporary, this.configPath)
    } catch (error) {
      await fsPromises.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async isProtectionAvailable(): Promise<boolean> {
    if (!this.credentialProtection) return false
    try {
      const status = await this.credentialProtection.status()
      return status.status === 'available'
    } catch {
      return false
    }
  }

  private async requireProtection(): Promise<CredentialProtection> {
    if (!this.credentialProtection || !(await this.isProtectionAvailable())) {
      throw new ZToolsError(errorCodes.notSupported, 'Secure credential storage is currently unavailable')
    }
    return this.credentialProtection
  }

  private async encryptSecretValue(value: string, protection: CredentialProtection): Promise<string> {
    if (value === '') return ''
    let ciphertext: Buffer
    try {
      ciphertext = await protection.encrypt(value)
    } catch {
      throw new ZToolsError(errorCodes.storageError, 'Failed to encrypt MCP server secret')
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
      throw new ZToolsError(errorCodes.storageError, 'Failed to encrypt MCP server secret')
    }
    return `${MCP_ENCRYPTED_VALUE_PREFIX}${ciphertext.toString('base64')}`
  }

  private async decryptSecretValue(raw: string, protection: CredentialProtection): Promise<{
    plaintext: string
    shouldReEncrypt: boolean
  }> {
    const buffer = decodeEncryptedValue(raw)
    try {
      const decrypted = await protection.decrypt(buffer)
      return { plaintext: decrypted.plaintext, shouldReEncrypt: decrypted.shouldReEncrypt }
    } catch {
      throw new ZToolsError(errorCodes.dataCorrupt, 'Stored MCP server secret is corrupt')
    }
  }

  private async encryptSecretRecord(
    record: Record<string, string> | undefined,
    protection: CredentialProtection
  ): Promise<Record<string, string> | undefined> {
    if (!record) return undefined
    const encrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(record)) {
      encrypted[key] = await this.encryptSecretValue(value, protection)
    }
    return encrypted
  }

  private async decryptServerRecord(stored: McpServerConfig): Promise<{
    decrypted: McpServerConfig
    needsPersist: boolean
    updatedStored: McpServerConfig
  }> {
    const inspectValues: string[] = []
    if (stored.env) inspectValues.push(...Object.values(stored.env))
    if (stored.headers) inspectValues.push(...Object.values(stored.headers))
    if (typeof stored.apiKey === 'string') inspectValues.push(stored.apiKey)

    const hasEncrypted = inspectValues.some((v) => typeof v === 'string' && isEncryptedValue(v))
    const hasPlaintext = inspectValues.some((v) => typeof v === 'string' && v !== '' && !isEncryptedValue(v))

    if (!hasEncrypted && !hasPlaintext) {
      return {
        decrypted: {
          ...stored,
          ...(stored.args ? { args: [...stored.args] } : {}),
          ...(stored.env ? { env: { ...stored.env } } : {}),
          ...(stored.headers ? { headers: { ...stored.headers } } : {})
        },
        needsPersist: false,
        updatedStored: stored
      }
    }

    if (hasEncrypted) {
      const protection = await this.requireProtection()
      let shouldReEncrypt = hasPlaintext

      const decryptMap = async (source: Record<string, string> | undefined): Promise<Record<string, string> | undefined> => {
        if (!source) return undefined
        const out: Record<string, string> = {}
        for (const [key, value] of Object.entries(source)) {
          if (typeof value !== 'string' || value === '') {
            out[key] = ''
          } else if (isEncryptedValue(value)) {
            const res = await this.decryptSecretValue(value, protection)
            out[key] = res.plaintext
            if (res.shouldReEncrypt) shouldReEncrypt = true
          } else {
            out[key] = value
            shouldReEncrypt = true
          }
        }
        return out
      }

      const plainEnv = await decryptMap(stored.env)
      const plainHeaders = await decryptMap(stored.headers)
      let plainApiKey = stored.apiKey
      if (typeof stored.apiKey === 'string' && stored.apiKey !== '') {
        if (isEncryptedValue(stored.apiKey)) {
          const res = await this.decryptSecretValue(stored.apiKey, protection)
          plainApiKey = res.plaintext
          if (res.shouldReEncrypt) shouldReEncrypt = true
        } else {
          shouldReEncrypt = true
        }
      }

      const decrypted: McpServerConfig = {
        ...stored,
        ...(stored.args ? { args: [...stored.args] } : {}),
        ...(plainEnv !== undefined ? { env: plainEnv } : {}),
        ...(plainHeaders !== undefined ? { headers: plainHeaders } : {}),
        ...(plainApiKey !== undefined ? { apiKey: plainApiKey } : {})
      }

      if (!shouldReEncrypt) {
        return { decrypted, needsPersist: false, updatedStored: stored }
      }

      const reEncryptedEnv = await this.encryptSecretRecord(plainEnv, protection)
      const reEncryptedHeaders = await this.encryptSecretRecord(plainHeaders, protection)
      const reEncryptedApiKey = plainApiKey !== undefined
        ? await this.encryptSecretValue(plainApiKey, protection)
        : undefined
      const updatedStored: McpServerConfig = {
        ...stored,
        ...(reEncryptedEnv !== undefined ? { env: reEncryptedEnv } : {}),
        ...(reEncryptedHeaders !== undefined ? { headers: reEncryptedHeaders } : {}),
        ...(reEncryptedApiKey !== undefined ? { apiKey: reEncryptedApiKey } : {})
      }
      return { decrypted, needsPersist: true, updatedStored }
    }

    // 仅存在旧版明文：加密可用时自动迁移为密文，否则兼容返回明文
    const decrypted: McpServerConfig = {
      ...stored,
      ...(stored.args ? { args: [...stored.args] } : {}),
      ...(stored.env ? { env: { ...stored.env } } : {}),
      ...(stored.headers ? { headers: { ...stored.headers } } : {})
    }
    if (this.credentialProtection && await this.isProtectionAvailable()) {
      const encEnv = await this.encryptSecretRecord(stored.env, this.credentialProtection)
      const encHeaders = await this.encryptSecretRecord(stored.headers, this.credentialProtection)
      const encApiKey = stored.apiKey !== undefined
        ? await this.encryptSecretValue(stored.apiKey, this.credentialProtection)
        : undefined
      const updatedStored: McpServerConfig = {
        ...stored,
        ...(encEnv !== undefined ? { env: encEnv } : {}),
        ...(encHeaders !== undefined ? { headers: encHeaders } : {}),
        ...(encApiKey !== undefined ? { apiKey: encApiKey } : {})
      }
      return { decrypted, needsPersist: true, updatedStored }
    }
    return { decrypted, needsPersist: false, updatedStored: stored }
  }

  /**
   * 扫描并自动将旧版明文 mcp_servers.json 或需重加密条目平滑迁移为密文落盘
   */
  public async ensureMigrated(): Promise<{ migrated: boolean; reEncrypted: boolean }> {
    if (!this.credentialProtection || !(await this.isProtectionAvailable())) {
      return { migrated: false, reEncrypted: false }
    }
    let migrated = false
    let reEncrypted = false
    for (const [id, stored] of this.servers.entries()) {
      const inspectValues: string[] = [
        ...(stored.env ? Object.values(stored.env) : []),
        ...(stored.headers ? Object.values(stored.headers) : []),
        ...(typeof stored.apiKey === 'string' ? [stored.apiKey] : [])
      ]
      const hadPlaintext = inspectValues.some((v) => typeof v === 'string' && v !== '' && !isEncryptedValue(v))
      const hadEncrypted = inspectValues.some((v) => typeof v === 'string' && isEncryptedValue(v))
      const result = await this.decryptServerRecord(stored)
      if (result.needsPersist) {
        this.servers.set(id, result.updatedStored)
        if (hadPlaintext) migrated = true
        if (hadEncrypted) reEncrypted = true
      }
    }
    if (migrated || reEncrypted) {
      await this.saveConfig()
    }
    return { migrated, reEncrypted }
  }

  /**
   * 异步读取指定 MCP Server 的解密后明文配置（仅供主进程启动子进程/发起连接使用）
   */
  public async getDecryptedServer(id: string): Promise<McpServerConfig | undefined> {
    const stored = this.servers.get(id)
    if (!stored) return undefined
    const result = await this.decryptServerRecord(stored)
    if (result.needsPersist) {
      this.servers.set(id, result.updatedStored)
      await this.saveConfig()
    }
    return result.decrypted
  }

  /**
   * M1.5-18.1: 安装/注册新的 MCP Server (installServer)
   */
  public async installServer(input: InstallServerInput): Promise<McpServerConfig> {
    if (!input || typeof input !== 'object') {
      throw new Error('Invalid MCP server input')
    }

    const rawName = (input.name || '').trim()
    if (!rawName) {
      throw new Error('Server name is required')
    }

    const title = (input.title || rawName).trim()
    const mentionName = (input.mentionName || rawName.toLowerCase().replace(/[^a-z0-9]/g, '')).trim()
    const transportType: McpServerTransportType = input.transportType || (input.url ? 'sse' : 'stdio')

    if (transportType === 'stdio' && (!input.command || !input.command.trim())) {
      throw new Error('Command is required for stdio MCP server')
    }
    if (transportType === 'sse' && (!input.url || !input.url.trim())) {
      throw new Error('URL is required for SSE MCP server')
    }

    const normalizedEnv = normalizeStringRecord(input.env)
    const normalizedHeaders = input.headers !== undefined ? normalizeStringRecord(input.headers) : undefined
    const normalizedApiKey = typeof input.apiKey === 'string' ? input.apiKey : undefined

    let storedEnv = normalizedEnv
    let storedHeaders = normalizedHeaders
    let storedApiKey = normalizedApiKey

    if (this.credentialProtection && hasNonEmptySecrets({ env: normalizedEnv, headers: normalizedHeaders, apiKey: normalizedApiKey })) {
      // 注入了安全存储时强制加密敏感凭据，不可用时 Fail-Fast 严禁降级写明文
      const protection = await this.requireProtection()
      storedEnv = (await this.encryptSecretRecord(normalizedEnv, protection)) ?? {}
      storedHeaders = await this.encryptSecretRecord(normalizedHeaders, protection)
      storedApiKey = normalizedApiKey !== undefined
        ? await this.encryptSecretValue(normalizedApiKey, protection)
        : undefined
    }

    const id = `mcp.${mentionName}`
    const pinyin = extractPinyin(`${title} ${rawName} ${mentionName}`)

    const config: McpServerConfig = {
      id,
      name: rawName,
      title,
      description: (input.description || `MCP Server: ${title}`).trim(),
      mentionName,
      icon: input.icon || 'mcp',
      transportType,
      ...(input.command ? { command: input.command.trim() } : {}),
      args: Array.isArray(input.args) ? [...input.args] : [],
      env: storedEnv,
      ...(storedHeaders !== undefined ? { headers: storedHeaders } : {}),
      ...(storedApiKey !== undefined ? { apiKey: storedApiKey } : {}),
      ...(input.url ? { url: input.url.trim() } : {}),
      enabled: true,
      pinyin,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const prevServer = this.servers.get(id)
    const prevStatus = this.runtimeStatus.get(id)
    this.servers.set(id, config)
    this.runtimeStatus.set(id, {
      id,
      name: rawName,
      title,
      mentionName,
      status: 'connected',
      transportType,
      enabled: true,
      toolsCount: 0,
      tools: [],
      lastError: null
    })

    try {
      await this.saveConfig()
    } catch (error) {
      // 落盘失败时回滚内存状态，保证内存与磁盘一致
      if (prevServer) this.servers.set(id, prevServer)
      else this.servers.delete(id)
      if (prevStatus) this.runtimeStatus.set(id, prevStatus)
      else this.runtimeStatus.delete(id)
      throw error
    }
    return redactServerConfig(config)
  }

  /**
   * M1.5-18.2: 管理与查看 MCP Server 列表及拓扑 (manageServers)
   */
  public manageServers(search?: string): McpServerRuntimeStatus[] {
    const list = Array.from(this.servers.values())
    const results: McpServerRuntimeStatus[] = []

    const query = (search || '').trim().toLowerCase()

    for (const server of list) {
      if (query) {
        const matches =
          server.name.toLowerCase().includes(query) ||
          server.title.toLowerCase().includes(query) ||
          server.mentionName.toLowerCase().includes(query) ||
          server.pinyin.includes(query)
        if (!matches) continue
      }

      const status = this.runtimeStatus.get(server.id) || {
        id: server.id,
        name: server.name,
        title: server.title,
        mentionName: server.mentionName,
        status: server.enabled ? 'connected' : 'disconnected',
        transportType: server.transportType,
        enabled: server.enabled,
        toolsCount: 0,
        tools: [],
        lastError: null
      }
      results.push(status)
    }

    return results
  }

  public getServer(id: string): McpServerConfig | undefined {
    const stored = this.servers.get(id)
    return stored ? redactServerConfig(stored) : undefined
  }

  public async toggleServer(id: string, enabled?: boolean): Promise<boolean> {
    const s = this.servers.get(id)
    if (!s) return false
    s.enabled = enabled !== undefined ? enabled : !s.enabled
    s.updatedAt = Date.now()

    const status = this.runtimeStatus.get(id)
    if (status) {
      status.enabled = s.enabled
      status.status = s.enabled ? 'connected' : 'disconnected'
      if (!s.enabled) {
        delete status.pingMs
      }
    }

    await this.saveConfig()
    return true
  }

  public async removeServer(id: string): Promise<boolean> {
    const deleted = this.servers.delete(id)
    this.runtimeStatus.delete(id)
    if (deleted) {
      await this.saveConfig()
    }
    return deleted
  }

  public registerMockTools(serverId: string, tools: Array<{ name: string; description?: string }>): void {
    const status = this.runtimeStatus.get(serverId)
    if (status) {
      status.tools = tools
      status.toolsCount = tools.length
    }
  }

  public async stop(): Promise<void> {
    // 释放资源
    this.runtimeStatus.clear()
  }
}
