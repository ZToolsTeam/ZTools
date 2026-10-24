import { pinnedLibraryMetadataSource, resolvePinnedLibraryChecksum, type LibraryMetadataSource } from './library-integrity-pins.js'
import { verifyWindowsPluginNativeFiles } from './plugin-native-file-integrity.js'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry } from 'yauzl'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PluginInstallParams, PluginKeyParams } from '../../contracts/method-params.js'
import { selectSdkApiLane, validateSdkApiHostMaximum, type SdkApiLane } from '../../contracts/sdk-api-lane.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from '../../contracts/protocol-versions.js'
import {
  resolvePluginRuntimeTarget,
  type PluginRuntimeIdentity,
  type PluginNativeComponent,
  type MacNativeCatalogLookup,
  type ResolvedPluginRuntimeTarget
} from './plugin-runtime-target-resolver.js'
import {
  PluginDataRecoveryService,
  type PluginDataRecoveryResult,
  type PreservedPluginDataSnapshot
} from './plugin-data-recovery-service.js'
import { isCommonPluginRoot } from './common-plugin-registry.js'
import { PluginStateService } from './plugin-state-service.js'

const PLUGIN_ARCHIVE_LIMIT = 100 * 1024 * 1024
const LIBRARY_ARCHIVE_LIMIT = 500 * 1024 * 1024
const PLUGIN_EXPANDED_LIMIT = 512 * 1024 * 1024
const LIBRARY_EXPANDED_LIMIT = 2 * 1024 * 1024 * 1024
const ENTRY_EXPANDED_LIMIT = 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const METADATA_TIMEOUT_MS = 15_000
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

type InstallState = 'running' | 'stopping' | 'stopped'
type TransactionKind = 'plugin' | 'library'

interface EventPublisher {
  publishHostToMain(type: string, payload: unknown): { success: true; delivered: number }
}

interface TransactionJournal {
  version: 1
  kind: TransactionKind
  id: string
  backupName: string
}

export interface PluginManifest extends Record<string, unknown> {
  id: string
  name: string
  version: string
  entry: string
  dllloader: string
  requireAdmin: boolean
  commonLibs: string[]
}

export interface PluginManifestRuntimeMetadata {
  readonly sdkApiLane: SdkApiLane
  readonly macNativeComponents?: readonly PluginNativeComponent[]
}

interface LibraryMetadata {
  libId: string
  downloadUrl: string
  fileSize: number
  checksum: string
}

type VerifiedPluginInstallParams = Omit<PluginInstallParams, 'checksum'> & { checksum: string }

interface ActiveOperation {
  operationId: string
  controller: AbortController
  promise: Promise<void>
}

export interface PluginInstallServiceOptions {
  preparePluginReplace?: (manifest: PluginManifest, signal: AbortSignal) => Promise<() => void>
  fetchImpl?: typeof fetch
  /** 公共库元数据来源（由主进程版本提供）；不传时只用内置完整性锚点，不请求任何后台 */
  libraryMetadata?: LibraryMetadataSource
  renameImpl?: typeof fs.rename
  runtimeTarget?: PluginRuntimeIdentity
  hostMaximumSdkContractVersion?: number
  referenceRuntimeReady?: () => boolean
  macNativeCatalogLookup?: MacNativeCatalogLookup
  state?: PluginStateService
  analytics?: (event: 'plugin_install' | 'plugin_update' | 'plugin_uninstall', pluginId: string, data?: unknown) => void
}

export interface PluginDirectoryProvider {
  withPluginDirectory<T>(
    pluginId: string,
    action: (manifest: PluginManifest, pluginRoot: string) => Promise<T>
  ): Promise<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function validateIdentifier(value: string, label: string): void {
  if (
    !PLUGIN_ID_PATTERN.test(value) ||
    value.endsWith('.') ||
    WINDOWS_DEVICE_PATTERN.test(value)
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, `${label} 格式无效`)
  }
}

function normalizeChecksum(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ZToolsError(errorCodes.pluginIntegrity, '安装包缺少有效 SHA-256')
  }
  const match = SHA256_PATTERN.exec(value.trim())
  if (!match?.[1]) {
    throw new ZToolsError(errorCodes.pluginIntegrity, '安装包缺少有效 SHA-256')
  }
  return match[1].toLowerCase()
}

export async function verifyArchiveSha256(
  archivePath: string,
  expectedChecksum: string,
  signal?: AbortSignal
): Promise<string> {
  const normalizedExpected = normalizeChecksum(expectedChecksum)
  const hash = createHash('sha256')
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(archivePath, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    while (true) {
      if (signal) requireNotAborted(signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined)
    }
  }
  const digest = hash.digest('hex').toLowerCase()
  if (digest !== normalizedExpected) {
    await fs.rm(archivePath, { force: true }).catch(() => undefined)
    throw new ZToolsError(
      errorCodes.checksumMismatch,
      `CHECKSUM_MISMATCH: 安装包 SHA-256 校验失败 (预期: ${normalizedExpected}, 实际: ${digest})`
    )
  }
  return digest
}

function requireNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason === errorCodes.appStopping) {
    throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
  throw new ZToolsError(errorCodes.callerDestroyed, '插件操作已取消')
}

function operationError(error: unknown): { code: string; message: string } {
  if (error instanceof ZToolsError) return { code: error.code, message: error.message }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: errorCodes.callerDestroyed, message: '插件操作已取消' }
  }
  return { code: errorCodes.internalError, message: '插件操作失败' }
}

function filesystemErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function validateRemoteUrl(source: string): URL {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, '下载地址无效')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new ZToolsError(errorCodes.permissionDenied, '插件下载只允许 HTTPS 或本机测试地址')
  }
  return url
}

function validateArchivePath(fileName: string, reservedName?: string): string[] {
  if (fileName.length === 0 || fileName.length > 32 * 1024 || fileName.includes('\0') || fileName.includes('\\')) {
    throw new ZToolsError(errorCodes.pluginPackageInvalid, 'ZIP 包含无效路径')
  }
  const normalized = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName
  const segments = normalized.split('/')
  if (
    normalized === '' ||
    path.posix.isAbsolute(normalized) ||
    segments.some((segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_DEVICE_PATTERN.test(segment)
    ) ||
    (reservedName !== undefined && normalized.toLowerCase() === reservedName.toLowerCase())
  ) {
    throw new ZToolsError(errorCodes.pluginPackageInvalid, 'ZIP 包含不安全路径')
  }
  return segments
}

function isSymlink(entry: Entry): boolean {
  const hostSystem = entry.versionMadeBy >>> 8
  const unixMode = entry.externalFileAttributes >>> 16
  return hostSystem === 3 && (unixMode & 0o170000) === 0o120000
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export class PluginInstallService implements PluginDirectoryProvider {
  readonly #pluginRoot: string
  readonly #pluginDataRoot: string
  readonly #libraryRoot: string
  readonly #workRoot: string
  readonly #dataRecovery: PluginDataRecoveryService
  readonly #fetch: typeof fetch
  readonly #libraryMetadata: LibraryMetadataSource
  readonly #rename: typeof fs.rename
  readonly #preparePluginReplace: PluginInstallServiceOptions['preparePluginReplace']
  readonly #runtimeTarget: PluginRuntimeIdentity
  readonly #hostMaximumSdkContractVersion: SdkApiLane
  readonly #referenceRuntimeReady: () => boolean
  readonly #macNativeCatalogLookup: MacNativeCatalogLookup | undefined
  readonly #pluginState: PluginStateService
  readonly #analytics: PluginInstallServiceOptions['analytics']
  readonly #operations = new Map<string, ActiveOperation>()
  readonly #pluginLocks = new Set<string>()
  readonly #pluginReaders = new Map<string, number>()
  readonly #maintenanceOperations = new Set<Promise<void>>()
  readonly #libraryOperations = new Map<string, Promise<void>>()
  readonly #ready: Promise<void>
  #state: InstallState = 'running'
  #stopPromise: Promise<void> | undefined

  constructor(
    dataRoot: string,
    private readonly events: EventPublisher,
    options: PluginInstallServiceOptions = {}
  ) {
    this.#pluginRoot = path.join(dataRoot, 'Plugins')
    this.#pluginDataRoot = path.join(dataRoot, 'PluginData')
    this.#libraryRoot = path.join(dataRoot, 'Libraries')
    this.#workRoot = path.join(dataRoot, '.electron-installer')
    this.#dataRecovery = new PluginDataRecoveryService(dataRoot)
    this.#fetch = options.fetchImpl ?? fetch
    this.#libraryMetadata = options.libraryMetadata ?? pinnedLibraryMetadataSource
    this.#rename = options.renameImpl ?? fs.rename
    this.#preparePluginReplace = options.preparePluginReplace
    this.#hostMaximumSdkContractVersion = validateSdkApiHostMaximum(
      options.hostMaximumSdkContractVersion ?? SDK_HOST_MAXIMUM_CONTRACT_VERSION
    )
    this.#referenceRuntimeReady = options.referenceRuntimeReady ?? (() => false)
    this.#macNativeCatalogLookup = options.macNativeCatalogLookup
    this.#runtimeTarget = options.runtimeTarget ?? {
      platform: process.platform,
      runtime: 'electron',
      arch: process.arch
    }
    this.#pluginState = options.state ?? new PluginStateService(dataRoot)
    this.#analytics = options.analytics
    this.#ready = this.#initialize()
    void this.#ready.catch(() => undefined)
  }

  async list(): Promise<{ success: true; data: Record<string, unknown>[] }> {
    await this.#ready
    this.#requireRunning()
    const data: Record<string, unknown>[] = []
    const stateDocument = await this.#pluginState.readAll()
    const entries = await fs.readdir(this.#pluginRoot, { withFileTypes: true })
    for (const entry of entries.slice(0, 1000)) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
      if (isCommonPluginRoot(entry.name)) continue
      try {
        const manifest = await this.#readManifest(path.join(this.#pluginRoot, entry.name), entry.name)
        const storedState = Object.keys(stateDocument)
          .find((key) => key.toLowerCase() === manifest.id.toLowerCase())
        const stateValue = storedState !== undefined && isRecord(stateDocument[storedState])
          ? stateDocument[storedState]
          : undefined
        const iconUrl = typeof stateValue?.icon_url === 'string' ? stateValue.icon_url : undefined
        const isRevoked = Boolean(stateValue?.revoked)
        const revokedReason = typeof stateValue?.revoked_reason === 'string'
          ? stateValue.revoked_reason
          : (typeof stateValue?.revokedReason === 'string' ? stateValue.revokedReason : undefined)
        data.push({
          ...manifest,
          id: manifest.id,
          pluginId: manifest.id,
          entry: manifest.entry,
          ...(iconUrl ? { icon: iconUrl, localIconUrl: iconUrl } : {}),
          revoked: isRevoked,
          ...(isRevoked && revokedReason ? { revoked_reason: revokedReason, revokedReason } : {}),
          enabled: isRevoked ? false : (typeof stateValue?.enabled === 'boolean'
            ? stateValue.enabled
            : manifest.enabled !== false)
        })
      } catch (error) {
        const failure = operationError(error)
        data.push({
          id: entry.name,
          pluginId: entry.name,
          name: entry.name,
          version: '',
          entry: '',
          enabled: false,
          available: false,
          errorCode: failure.code,
          error: failure.message
        })
        this.#publish('plugin_manifest_invalid', {
          pluginId: entry.name,
          errorCode: failure.code,
          error: failure.message
        })
      }
    }
    return { success: true, data }
  }

  async markRevoked(pluginId: string, revoked: boolean, reason?: string | undefined): Promise<void> {
    await this.#ready
    this.#requireRunning()
    validateIdentifier(pluginId, 'pluginId')
    if (this.#pluginState.setRevoked) {
      await this.#pluginState.setRevoked(pluginId, revoked, reason)
    }
    if (revoked) {
      this.#publish('plugin_revoked', {
        pluginId,
        reason: reason || '该插件已被官方下架禁用'
      })
    }
  }

  async isRevoked(pluginId: string): Promise<{ revoked: boolean; reason?: string | undefined }> {
    await this.#ready
    this.#requireRunning()
    validateIdentifier(pluginId, 'pluginId')
    return this.#pluginState.isRevoked ? this.#pluginState.isRevoked(pluginId) : { revoked: false }
  }

  async verifyArchiveChecksum(
    archivePath: string,
    expectedChecksum: string,
    signal?: AbortSignal
  ): Promise<string> {
    return verifyArchiveSha256(archivePath, expectedChecksum, signal)
  }

  async listPreservedData(
    pluginId: string
  ): Promise<{ success: true; data: PreservedPluginDataSnapshot[] }> {
    await this.#ready
    this.#requireRunning()
    return this.#dataRecovery.list(pluginId)
  }

  async restorePreservedData(
    pluginId: string,
    preservationId: string,
    assets: readonly string[]
  ): Promise<PluginDataRecoveryResult> {
    await this.#ready
    this.#requireRunning()
    const key = pluginId.toLowerCase()
    if (this.#pluginLocks.has(key) || this.#pluginReaders.has(key)) {
      throw new ZToolsError(errorCodes.pluginBusy, '插件正在执行其他操作')
    }
    this.#pluginLocks.add(key)
    try {
      const result = await this.#dataRecovery.restore(pluginId, preservationId, assets)
      this.#publish('plugin_data_restored', {
        pluginId,
        preservationId,
        restorationId: result.restorationId,
        files: result.files,
        bytes: result.bytes
      })
      return result
    } finally {
      this.#pluginLocks.delete(key)
    }
  }

  async withPluginManifest<T>(
    pluginId: string,
    action: (manifest: PluginManifest, runtimeMetadata?: PluginManifestRuntimeMetadata) => Promise<T>
  ): Promise<T> {
    return this.#withPluginDirectory(pluginId, async (manifest, _pluginRoot, runtimeMetadata) => {
      const rev = this.#pluginState.isRevoked ? await this.#pluginState.isRevoked(manifest.id) : { revoked: false }
      if (rev.revoked) {
        throw new ZToolsError(errorCodes.permissionDenied, `该插件已被官方下架禁用: ${rev.reason || '存在安全合规风险'}`)
      }
      if (!(await this.#pluginState.isEnabled(manifest.id, manifest.enabled !== false))) {
        throw new ZToolsError(errorCodes.pluginNotFound, '插件已禁用')
      }
      return action(manifest, runtimeMetadata)
    }, true)
  }

  async withPluginDirectory<T>(
    pluginId: string,
    action: (manifest: PluginManifest, pluginRoot: string) => Promise<T>
  ): Promise<T> {
    return this.#withPluginDirectory(pluginId, action, false)
  }

  async #withPluginDirectory<T>(
    pluginId: string,
    action: (
      manifest: PluginManifest,
      pluginRoot: string,
      runtimeMetadata: PluginManifestRuntimeMetadata
    ) => Promise<T>,
    shared: boolean
  ): Promise<T> {
    await this.#ready
    this.#requireRunning()
    validateIdentifier(pluginId, 'pluginId')
    const key = pluginId.toLowerCase()
    if (this.#pluginLocks.has(key) || (!shared && this.#pluginReaders.has(key))) {
      throw new ZToolsError(errorCodes.pluginBusy, '插件正在执行其他操作')
    }
    // Manifest consumers (window startup and DLL resolution) may overlap.
    // Keep the directory protected from maintenance until the last reader exits.
    if (shared) this.#pluginReaders.set(key, (this.#pluginReaders.get(key) ?? 0) + 1)
    else this.#pluginLocks.add(key)
    try {
      const target = this.#pluginPath(pluginId)
      if (!(await this.#isOrdinaryDirectory(target))) {
        throw new ZToolsError(errorCodes.pluginNotFound, '插件不存在')
      }
      const manifest = await this.#readManifest(target, pluginId)
      const resolvedTarget = await this.#assertRuntimeTarget(manifest, target)
      this.#requireRunning()
      const runtimeMetadata: PluginManifestRuntimeMetadata = {
        sdkApiLane: selectSdkApiLane(
          resolvedTarget.target?.minSdkContractVersion,
          this.#hostMaximumSdkContractVersion
        ),
        ...(this.#runtimeTarget.platform === 'darwin' ? { macNativeComponents: resolvedTarget.nativeComponents } : {})
      }
      return await action(manifest, target, runtimeMetadata)
    } finally {
      if (shared) {
        const remaining = (this.#pluginReaders.get(key) ?? 1) - 1
        if (remaining === 0) this.#pluginReaders.delete(key)
        else this.#pluginReaders.set(key, remaining)
      } else {
        this.#pluginLocks.delete(key)
      }
    }
  }

  async startInstall(
    params: PluginInstallParams,
    requestedUpdate: boolean
  ): Promise<{ success: true; operationId: string; isUpdate: boolean }> {
    await this.#ready
    this.#requireRunning()
    validateIdentifier(params.pluginId, 'pluginId')
    if (isCommonPluginRoot(params.pluginId)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'CommonPlugins 是客户端保留目录')
    }
    if ((params as unknown as Record<string, unknown>).revoked === true) {
      throw new ZToolsError(errorCodes.permissionDenied, '该插件已被官方下架，禁止安装')
    }
    const revokedCheck = this.#pluginState.isRevoked ? await this.#pluginState.isRevoked(params.pluginId) : { revoked: false }
    if (revokedCheck.revoked) {
      throw new ZToolsError(errorCodes.permissionDenied, `该插件已被官方下架，禁止安装: ${revokedCheck.reason || '安全合规原因'}`)
    }
    validateRemoteUrl(params.url)
    const installParams: VerifiedPluginInstallParams = {
      ...params,
      checksum: normalizeChecksum(params.checksum)
    }
    if (!VERSION_PATTERN.test(params.version)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'version 格式无效')
    }
    const key = params.pluginId.toLowerCase()
    if (this.#pluginLocks.has(key) || this.#pluginReaders.has(key)) {
      throw new ZToolsError(errorCodes.pluginBusy, '插件正在执行其他操作')
    }
    this.#pluginLocks.add(key)
    try {
      const target = this.#pluginPath(params.pluginId)
      const installed = await this.#isOrdinaryDirectory(target)
      this.#requireRunning()
      if (requestedUpdate && !installed) {
        throw new ZToolsError(errorCodes.pluginNotFound, '插件不存在')
      }
      const isUpdate = requestedUpdate || installed
      const controller = new AbortController()
      const operationId = randomUUID()
      const promise = Promise.resolve()
        .then(() => this.#install(installParams, operationId, controller.signal))
        .then((version) => {
          // #install has completed its cleanup before this terminal notification.
          if (this.#operations.get(key)?.operationId === operationId) this.#pluginLocks.delete(key)
          this.#publish('plugin_install_complete', {
            pluginId: params.pluginId, operationId, success: true, isUpdate, version
          })
          try {
            this.#analytics?.(isUpdate ? 'plugin_update' : 'plugin_install', params.pluginId, { version, operationId })
          } catch (error) {
            console.warn('插件安装统计记录失败:', error)
          }
        }, (error: unknown) => {
          if (this.#operations.get(key)?.operationId === operationId) this.#pluginLocks.delete(key)
          console.error(`插件 ${params.pluginId} ${isUpdate ? '更新' : '安装'}失败:`, error)
          const failure = operationError(error)
          this.#publish('plugin_install_complete', {
            pluginId: params.pluginId, operationId, success: false, isUpdate,
            errorCode: failure.code, error: failure.message
          })
        })
        .finally(() => {
          // A terminal listener may already have started a new operation or reader.
          if (this.#operations.get(key)?.operationId === operationId) this.#operations.delete(key)
        })
      this.#operations.set(key, { operationId, controller, promise })
      return { success: true, operationId, isUpdate }
    } catch (error) {
      this.#pluginLocks.delete(key)
      throw error
    }
  }

  async uninstall(params: PluginKeyParams): Promise<{ success: true }> {
    await this.#ready
    this.#requireRunning()
    validateIdentifier(params.pluginId, 'pluginId')
    if (isCommonPluginRoot(params.pluginId)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'CommonPlugins 是客户端保留目录')
    }
    const key = params.pluginId.toLowerCase()
    if (this.#pluginLocks.has(key) || this.#pluginReaders.has(key)) {
      throw new ZToolsError(errorCodes.pluginBusy, '插件正在执行其他操作')
    }
    this.#pluginLocks.add(key)
    const operation = this.#uninstall(params.pluginId)
    this.#maintenanceOperations.add(operation)
    try {
      await operation
      return { success: true }
    } catch (error) {
      throw error instanceof ZToolsError
        ? error
        : new ZToolsError(errorCodes.storageError, '插件卸载失败，文件可能被占用')
    } finally {
      this.#maintenanceOperations.delete(operation)
      this.#pluginLocks.delete(key)
    }
  }

  waitForIdle(): Promise<void> {
    return Promise.all([
      ...[...this.#operations.values()].map((item) => item.promise),
      ...this.#maintenanceOperations,
      ...this.#libraryOperations.values()
    ]).then(() => undefined)
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#state = 'stopping'
    for (const operation of this.#operations.values()) {
      operation.controller.abort(errorCodes.appStopping)
    }
    this.#stopPromise = Promise.allSettled([
      this.#ready,
      ...[...this.#operations.values()].map((item) => item.promise),
      ...this.#maintenanceOperations,
      ...this.#libraryOperations.values()
    ]).then(() => {
      this.#state = 'stopped'
    })
    return this.#stopPromise
  }

  async #initialize(): Promise<void> {
    await Promise.all([
      this.#ensureOrdinaryRoot(this.#pluginRoot),
      this.#ensureOrdinaryRoot(this.#pluginDataRoot),
      this.#ensureOrdinaryRoot(this.#libraryRoot),
      this.#ensureOrdinaryRoot(this.#workRoot)
    ])
    await this.#recoverTransactions()
  }

  async #uninstall(pluginId: string): Promise<void> {
    const target = this.#pluginPath(pluginId)
    if (!(await this.#isOrdinaryDirectory(target))) {
      throw new ZToolsError(errorCodes.pluginNotFound, '插件不存在')
    }
    await this.#preservePluginTree(target, pluginId, 'uninstall')
    await this.#pluginState.remove(pluginId)
    this.#publish('plugin_uninstalled', { pluginId })
    this.#analytics?.('plugin_uninstall', pluginId)
  }

  async #install(
    params: VerifiedPluginInstallParams,
    operationId: string,
    signal: AbortSignal
  ): Promise<string> {
    const transaction = await this.#createTransaction('plugin', params.pluginId, operationId)
    const archive = path.join(transaction.root, 'plugin.zip')
    const staging = path.join(transaction.root, 'staging')
    const target = this.#pluginPath(params.pluginId)
    const backup = path.join(this.#pluginRoot, transaction.backupName)
    let backupCreated = false
    let committed = false
    let releaseNative: (() => void) | undefined
    try {
      this.#progress(params.pluginId, 0, 'download')
      await this.#download({
        url: params.url,
        target: archive,
        checksum: params.checksum,
        expectedSize: params.fileSize,
        maxBytes: PLUGIN_ARCHIVE_LIMIT,
        signal,
        onProgress: (percent) => this.#progress(params.pluginId, Math.min(70, Math.floor(percent * 0.7)), 'download')
      })
      requireNotAborted(signal)
      this.#progress(params.pluginId, 72, 'extract')
      // 解压插件 zip 包前，使用 Node crypto 流式计算并比对 sha256，不匹配立即抛出 CHECKSUM_MISMATCH 并安全清理回滚
      await verifyArchiveSha256(archive, params.checksum, signal)
      await this.#extractArchive(archive, staging, PLUGIN_EXPANDED_LIMIT, signal)
      const { manifest, sha256: manifestSha256 } = await this.#readManifestSnapshot(staging, params.pluginId)
      await this.#assertRuntimeTarget(manifest, staging, signal, true)
      if (manifest.version !== params.version) {
        throw new ZToolsError(errorCodes.pluginPackageInvalid, '插件包版本与授权版本不一致')
      }
      this.#progress(params.pluginId, 80, 'validate')
      for (let index = 0; index < manifest.commonLibs.length; index += 1) {
        requireNotAborted(signal)
        const libId = manifest.commonLibs[index] as string
        this.#progress(params.pluginId, 82, 'library', index + 1, manifest.commonLibs.length)
        await this.#ensureLibrary(libId, signal, (percent) => {
          this.#progress(params.pluginId, percent, 'library', index + 1, manifest.commonLibs.length)
        })
      }
      requireNotAborted(signal)
      await this.#assertRuntimeTarget(manifest, staging, signal, true)
      requireNotAborted(signal)
      this.#progress(params.pluginId, 95, 'commit')
      if (await exists(target)) {
        if (!(await this.#isOrdinaryDirectory(target))) {
          throw new ZToolsError(errorCodes.permissionDenied, '插件目标目录不是普通目录')
        }
        if (this.#preparePluginReplace) {
          const installedManifest = await this.#readManifest(target, params.pluginId)
          releaseNative = await this.#preparePluginReplace(installedManifest, signal)
          requireNotAborted(signal)
        }
        await this.#renamePath(target, backup, signal)
        backupCreated = true
      }
      try {
        const finalManifest = await this.#readManifestSnapshot(staging, params.pluginId)
        if (finalManifest.sha256 !== manifestSha256) {
          throw new ZToolsError(errorCodes.pluginIntegrity, '安装期间 plugin.json 字节发生变化')
        }
        await this.#assertRuntimeTarget(finalManifest.manifest, staging, signal, true)
        if ((await this.#readManifestSnapshot(staging, params.pluginId)).sha256 !== manifestSha256) {
          throw new ZToolsError(errorCodes.pluginIntegrity, '安装文件校验期间 plugin.json 字节发生变化')
        }
        await this.#renamePath(staging, target, signal)
        committed = true
      } catch (error) {
        if (backupCreated) await this.#renamePath(backup, target)
        backupCreated = false
        throw error
      }
      if (backupCreated) {
        try {
          await this.#preservePluginTree(backup, params.pluginId, 'update')
          backupCreated = false
        } catch (error) {
          console.warn(`插件 ${params.pluginId} 旧版本数据暂无法转移，将在下次启动重试:`, error)
        }
      }
      this.#progress(params.pluginId, 100, 'complete')
      return manifest.version
    } finally {
      try {
        if (!committed && backupCreated && !(await exists(target)) && await exists(backup)) {
          await this.#renamePath(backup, target).catch((error: unknown) => {
            console.error(`插件 ${params.pluginId} 回滚失败:`, error)
          })
        }
        if (!(committed && backupCreated)) {
          await this.#removeTree(transaction.root, this.#workRoot).catch((error: unknown) => {
            console.warn('清理插件安装事务失败:', error)
          })
        }
      } finally { releaseNative?.() }
    }
  }

  async #ensureLibrary(
    libId: string,
    signal: AbortSignal,
    onProgress: (percent: number) => void
  ): Promise<void> {
    validateIdentifier(libId, 'libId')
    const key = libId.toLowerCase()
    const active = this.#libraryOperations.get(key)
    if (active) return active
    const promise = this.#installLibrary(libId, signal, onProgress)
      .finally(() => this.#libraryOperations.delete(key))
    this.#libraryOperations.set(key, promise)
    return promise
  }

  async #installLibrary(
    libId: string,
    signal: AbortSignal,
    onProgress: (percent: number) => void
  ): Promise<void> {
    const metadata = await this.#getLibraryMetadata(libId, signal)
    const checksum = normalizeChecksum(metadata.checksum)
    const target = this.#libraryPath(libId)
    const marker = path.join(target, '.ztools-library.json')
    if (await this.#isOrdinaryDirectory(target)) {
      try {
        const current = JSON.parse(await fs.readFile(marker, 'utf8')) as Record<string, unknown>
        if (current.libId === libId && current.checksum === checksum) {
          onProgress(100)
          return
        }
      } catch {
        // 无可信 marker 的旧目录重新安装。
      }
    }
    const transaction = await this.#createTransaction('library', libId)
    const archive = path.join(transaction.root, 'library.zip')
    const staging = path.join(transaction.root, 'staging')
    const backup = path.join(this.#libraryRoot, transaction.backupName)
    let backupCreated = false
    let committed = false
    try {
      await this.#download({
        url: metadata.downloadUrl,
        target: archive,
        checksum,
        expectedSize: metadata.fileSize,
        maxBytes: LIBRARY_ARCHIVE_LIMIT,
        signal,
        onProgress
      })
      await verifyArchiveSha256(archive, checksum, signal)
      await this.#extractArchive(archive, staging, LIBRARY_EXPANDED_LIMIT, signal, '.ztools-library.json')
      await fs.writeFile(
        path.join(staging, '.ztools-library.json'),
        `${JSON.stringify({ version: 1, libId, checksum })}\n`,
        { encoding: 'utf8', flag: 'wx' }
      )
      if (await exists(target)) {
        if (!(await this.#isOrdinaryDirectory(target))) {
          throw new ZToolsError(errorCodes.permissionDenied, '依赖库目标目录不是普通目录')
        }
        await this.#renamePath(target, backup, signal)
        backupCreated = true
      }
      try {
        await this.#renamePath(staging, target, signal)
        committed = true
      } catch (error) {
        if (backupCreated) await this.#renamePath(backup, target)
        backupCreated = false
        throw error
      }
      if (backupCreated) {
        try {
          await this.#removeTree(backup, this.#libraryRoot)
          backupCreated = false
        } catch (error) {
          console.warn(`依赖库 ${libId} 旧版本备份将在下次启动清理:`, error)
        }
      }
      onProgress(100)
    } finally {
      if (!committed && backupCreated && !(await exists(target)) && await exists(backup)) {
        await this.#renamePath(backup, target).catch((error: unknown) => {
          console.error(`依赖库 ${libId} 回滚失败:`, error)
        })
      }
      if (!(committed && backupCreated)) {
        await this.#removeTree(transaction.root, this.#workRoot).catch((error: unknown) => {
          console.warn('清理依赖库事务失败:', error)
        })
      }
    }
  }

  async #getLibraryMetadata(libId: string, signal: AbortSignal): Promise<LibraryMetadata> {
    // 元数据来源由主进程版本决定（开源版只用内置完整性锚点）；无论来源是谁，下面的校验都在这里统一执行
    const data: unknown = await this.#libraryMetadata.resolve(libId, {
      signal,
      fetchText: async (url) => {
        const response = await this.#fetchFollowingRedirects(url, signal, METADATA_TIMEOUT_MS)
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          return { ok: false, status: response.status, text: '' }
        }
        return { ok: true, status: response.status, text: await this.#readBoundedText(response, MAX_METADATA_BYTES, signal) }
      }
    })
    requireNotAborted(signal)
    if (!isRecord(data)) {
      throw new ZToolsError(errorCodes.dataCorrupt, '公共库完整性元数据无效')
    }
    if (
      data.libId !== libId ||
      typeof data.downloadUrl !== 'string' ||
      typeof data.checksum !== 'string' ||
      (data.fileSize !== null && data.fileSize !== undefined &&
        (!Number.isSafeInteger(data.fileSize) || (data.fileSize as number) < 0 || (data.fileSize as number) > LIBRARY_ARCHIVE_LIMIT))
    ) {
      throw new ZToolsError(errorCodes.dataCorrupt, '公共库完整性元数据无效')
    }
    validateRemoteUrl(data.downloadUrl)
    const checksum = resolvePinnedLibraryChecksum({
      libId, downloadUrl: data.downloadUrl,
      fileSize: data.fileSize as number | null | undefined, checksum: data.checksum
    })
    normalizeChecksum(checksum)
    return {
      libId,
      downloadUrl: data.downloadUrl,
      fileSize: typeof data.fileSize === 'number' ? data.fileSize : 0,
      checksum
    }
  }

  async #download(options: {
    url: string
    target: string
    checksum: string
    expectedSize: number
    maxBytes: number
    signal: AbortSignal
    onProgress: (percent: number) => void
  }): Promise<void> {
    const expectedChecksum = normalizeChecksum(options.checksum)
    const response = await this.#fetchFollowingRedirects(options.url, options.signal, DOWNLOAD_TIMEOUT_MS)
    if (!response.ok || !response.body) {
      throw new ZToolsError(errorCodes.networkError, '下载安装包失败')
    }
    const contentLengthValue = response.headers.get('content-length')
    const contentLength = contentLengthValue === null ? 0 : Number(contentLengthValue)
    if (
      contentLengthValue !== null &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > options.maxBytes)
    ) {
      throw new ZToolsError(errorCodes.fileTooLarge, '安装包超过下载大小上限')
    }
    const handle = await fs.open(options.target, 'wx', 0o600)
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let downloaded = 0
    let lastPercent = -1
    try {
      while (true) {
        requireNotAborted(options.signal)
        const chunk = await reader.read()
        if (chunk.done) break
        downloaded += chunk.value.byteLength
        if (downloaded > options.maxBytes) {
          throw new ZToolsError(errorCodes.fileTooLarge, '安装包超过下载大小上限')
        }
        hash.update(chunk.value)
        let offset = 0
        while (offset < chunk.value.byteLength) {
          const written = await handle.write(chunk.value, offset, chunk.value.byteLength - offset)
          offset += written.bytesWritten
        }
        const total = contentLength > 0 ? contentLength : options.expectedSize
        const percent = total > 0 ? Math.min(99, Math.floor(downloaded * 100 / total)) : 0
        if (percent !== lastPercent) {
          lastPercent = percent
          options.onProgress(percent)
        }
      }
      await handle.sync()
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
    if (options.expectedSize > 0 && downloaded !== options.expectedSize) {
      await fs.rm(options.target, { force: true })
      throw new ZToolsError(errorCodes.pluginIntegrity, '安装包大小与授权元数据不一致')
    }
    if (hash.digest('hex') !== expectedChecksum) {
      await fs.rm(options.target, { force: true })
      throw new ZToolsError(errorCodes.pluginIntegrity, '安装包 SHA-256 校验失败')
    }
    options.onProgress(100)
  }

  async #fetchFollowingRedirects(source: string, signal: AbortSignal, timeoutMs: number): Promise<Response> {
    let url = validateRemoteUrl(source)
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      requireNotAborted(signal)
      let response: Response
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: combined,
          headers: { 'User-Agent': 'ZTools-Electron' }
        })
      } catch (error) {
        requireNotAborted(signal)
        throw new ZToolsError(
          errorCodes.networkError,
          timeout.aborted ? '下载请求超时' : '下载请求失败'
        )
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      if (!location || redirect === 5) {
        await response.body?.cancel().catch(() => undefined)
        throw new ZToolsError(errorCodes.networkError, '下载重定向无效或次数过多')
      }
      await response.body?.cancel().catch(() => undefined)
      url = validateRemoteUrl(new URL(location, url).toString())
    }
    throw new ZToolsError(errorCodes.networkError, '下载重定向次数过多')
  }

  async #readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new ZToolsError(errorCodes.responseTooLarge, '公共库元数据超过大小上限')
    }
    if (!response.body) return ''
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        requireNotAborted(signal)
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maxBytes) {
          throw new ZToolsError(errorCodes.responseTooLarge, '公共库元数据超过大小上限')
        }
        chunks.push(Buffer.from(chunk.value))
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    }
    return Buffer.concat(chunks, size).toString('utf8')
  }

  async #extractArchive(
    archive: string,
    destination: string,
    expandedLimit: number,
    signal: AbortSignal,
    reservedName?: string
  ): Promise<void> {
    await fs.mkdir(destination, { recursive: false, mode: 0o700 })
    const zip = await yauzl.openPromise(archive, {
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    })
    const names = new Set<string>()
    let entries = 0
    let expanded = 0
    try {
      for await (const entry of zip.eachEntry()) {
        requireNotAborted(signal)
        entries += 1
        expanded += entry.uncompressedSize
        if (entries > MAX_ARCHIVE_ENTRIES || expanded > expandedLimit || entry.uncompressedSize > ENTRY_EXPANDED_LIMIT) {
          throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP 解压规模超过上限')
        }
        if (entry.isEncrypted() || !entry.canDecodeFileData() || isSymlink(entry)) {
          throw new ZToolsError(errorCodes.pluginPackageInvalid, 'ZIP 包含不支持或不安全的条目')
        }
        const segments = validateArchivePath(entry.fileName, reservedName)
        const relative = segments.join(path.sep)
        const target = path.resolve(destination, relative)
        if (!isWithin(destination, target) || target === destination) {
          throw new ZToolsError(errorCodes.pluginPackageInvalid, 'ZIP 路径越界')
        }
        const key = relative.toLowerCase()
        if (names.has(key)) {
          throw new ZToolsError(errorCodes.pluginPackageInvalid, 'ZIP 包含大小写冲突或重复路径')
        }
        names.add(key)
        if (entry.fileName.endsWith('/')) {
          await fs.mkdir(target, { recursive: true, mode: 0o700 })
          continue
        }
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        const input = await zip.openReadStreamPromise(entry)
        await pipeline(input, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal })
      }
    } catch (error) {
      requireNotAborted(signal)
      throw error instanceof ZToolsError
        ? error
        : new ZToolsError(errorCodes.pluginPackageInvalid, 'ZIP 包损坏或无法解压')
    } finally {
      zip.close()
    }
  }

  async #readManifest(root: string, expectedId: string): Promise<PluginManifest> {
    return (await this.#readManifestSnapshot(root, expectedId)).manifest
  }

  async #readManifestSnapshot(root: string, expectedId: string): Promise<{ manifest: PluginManifest; sha256: string }> {
    const manifestPath = path.join(root, 'plugin.json')
    const stat = await fs.lstat(manifestPath).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, '插件包缺少有效 plugin.json')
    }
    const handle = await fs.open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source: Buffer
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size ||
          opened.size > MAX_MANIFEST_BYTES) throw new ZToolsError(errorCodes.pluginIntegrity, 'plugin.json 文件对象发生变化')
      source = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < source.length) {
        this.#requireRunning()
        const { bytesRead } = await handle.read(source, offset, source.length - offset, offset)
        if (bytesRead === 0) throw new ZToolsError(errorCodes.pluginIntegrity, 'plugin.json 读取期间被截断')
        offset += bytesRead
      }
      const after = await handle.stat(), namedAfter = await fs.lstat(manifestPath)
      if (!namedAfter.isFile() || namedAfter.isSymbolicLink() || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino ||
          after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
          namedAfter.size !== opened.size || namedAfter.mtimeMs !== opened.mtimeMs || namedAfter.ctimeMs !== opened.ctimeMs) {
        throw new ZToolsError(errorCodes.pluginIntegrity, 'plugin.json 读取期间文件对象发生变化')
      }
    } finally { await handle.close() }
    let value: unknown
    try {
      value = JSON.parse(source.toString('utf8'))
    } catch {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, 'plugin.json 不是有效 JSON')
    }
    if (!isRecord(value)) {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, 'plugin.json 必须是对象')
    }
    const id = value.id
    const name = value.name
    const version = value.version
    const entry = value.entry ?? ''
    const dllloader = value.dllloader ?? ''
    const requireAdmin = value.requireAdmin ?? false
    const commonLibs = value.commonLibs ?? []
    if (
      typeof id !== 'string' || id !== expectedId ||
      typeof name !== 'string' || name.length < 1 || name.length > 256 ||
      typeof version !== 'string' || !VERSION_PATTERN.test(version) ||
      typeof entry !== 'string' || entry.length > 4096 ||
      typeof dllloader !== 'string' || dllloader.length > 4096 ||
      typeof requireAdmin !== 'boolean' ||
      (requireAdmin && dllloader === '') ||
      (entry === '' && dllloader === '') ||
      !Array.isArray(commonLibs) || commonLibs.length > 32
    ) {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, 'plugin.json 必填字段无效')
    }
    validateIdentifier(id, 'pluginId')
    const checkedLibraries = commonLibs.map((item) => {
      if (typeof item !== 'string') {
        throw new ZToolsError(errorCodes.pluginPackageInvalid, 'commonLibs 包含无效项')
      }
      validateIdentifier(item, 'libId')
      return item
    })
    if (new Set(checkedLibraries.map((item) => item.toLowerCase())).size !== checkedLibraries.length) {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, 'commonLibs 包含重复项')
    }
    for (const [label, relative] of [['entry', entry], ['dllloader', dllloader]] as const) {
      if (relative === '') continue
      const segments = validateArchivePath(relative.replaceAll('\\', '/'))
      const target = path.resolve(root, ...segments)
      if (!isWithin(root, target) || !(await fs.lstat(target).catch(() => undefined))?.isFile()) {
        throw new ZToolsError(errorCodes.pluginPackageInvalid, `${label} 文件不存在或路径无效`)
      }
    }
    return { sha256: createHash('sha256').update(source).digest('hex'), manifest: {
      ...value,
      id,
      name,
      version,
      entry,
      dllloader,
      requireAdmin,
      commonLibs: checkedLibraries
    } }
  }

  async #assertRuntimeTarget(manifest: PluginManifest, root: string, signal?: AbortSignal, verifyContents = false): Promise<ResolvedPluginRuntimeTarget> {
    if (signal) requireNotAborted(signal)
    const resolved = resolvePluginRuntimeTarget(manifest, this.#runtimeTarget, {
      sdkContractVersion: this.#hostMaximumSdkContractVersion,
      ...(this.#macNativeCatalogLookup ? { macNativeCatalogLookup: this.#macNativeCatalogLookup } : {})
    })
    if (resolved.target?.minSdkContractVersion === 2 && !this.#isReferenceRuntimeReady()) {
      throw new ZToolsError(errorCodes.notSupported, 'SDK 契约版本 2 要求引用文件运行时已就绪')
    }
    const realRoot = await fs.realpath(root)
    if (this.#runtimeTarget.platform === 'win32') {
      await verifyWindowsPluginNativeFiles(root, [
        ...resolved.nativeComponents.map(component => ({
          entry: component.entry,
          ...(/\.(?:dll|exe)$/i.test(component.entry) ? { format: 'pe' as const, arch: component.arch } : {}),
          ...(component.sha256 !== undefined ? { sha256: component.sha256 } : {})
        })),
        ...(resolved.payloadFiles ?? [])
      ], { maxBytes: PLUGIN_EXPANDED_LIMIT, verifyContents,
        exactLibrary: resolved.nativeComponents.some(component => Object.hasOwn(component, 'payloadFiles')), checkActive: () => {
        this.#requireRunning()
        if (signal) requireNotAborted(signal)
      } })
    }
    for (const component of resolved.nativeComponents) {
      if (signal) requireNotAborted(signal)
      const segments = validateArchivePath(component.entry.replaceAll('\\', '/'))
      const target = path.resolve(root, ...segments)
      if (!isWithin(root, target) || target === root) {
        throw new ZToolsError(errorCodes.pluginPackageInvalid, `nativeComponents.${component.id}.entry 路径越界`)
      }
      const stat = await fs.lstat(target).catch(() => undefined)
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new ZToolsError(
          errorCodes.pluginPackageInvalid,
          `当前平台目标 ${component.targetId} 的 native component 文件不存在或不是普通文件：${component.entry}`
        )
      }
      const realTarget = await fs.realpath(target)
      if (!isWithin(realRoot, realTarget)) {
        throw new ZToolsError(errorCodes.pluginPackageInvalid, `nativeComponents.${component.id}.entry 指向插件目录外`)
      }
      if (this.#runtimeTarget.platform === 'darwin') {
        const approved = this.#macNativeCatalogLookup?.(manifest.id, component.id)
        if (!approved || approved.relativePath !== component.entry) {
          throw new ZToolsError(errorCodes.notSupported, 'Mac 原生组件可信目录已不可用')
        }
        let directory = root
        for (const segment of segments.slice(0, -1)) {
          directory = path.join(directory, segment)
          const directoryStat = await fs.lstat(directory)
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            throw new ZToolsError(errorCodes.pluginPackageInvalid, 'Mac 原生组件目录不允许符号链接')
          }
        }
        const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
              opened.size !== stat.size || opened.size > PLUGIN_EXPANDED_LIMIT) {
            throw new ZToolsError(errorCodes.pluginIntegrity, 'Mac 原生组件对象已变化或超出上限')
          }
          const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
          let total = 0
          while (true) {
            this.#requireRunning()
            if (signal) requireNotAborted(signal)
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > opened.size) throw new ZToolsError(errorCodes.pluginIntegrity, 'Mac 原生组件读取期间已变化')
            hash.update(buffer.subarray(0, bytesRead))
          }
          const after = await handle.stat()
          if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
              after.ctimeMs !== opened.ctimeMs || hash.digest('hex') !== approved.sha256) {
            throw new ZToolsError(errorCodes.pluginIntegrity, 'Mac 原生组件未匹配当前 App 的可信 SHA-256')
          }
        } finally { await handle.close() }
      }
    }
    return resolved
  }

  #isReferenceRuntimeReady(): boolean {
    try { return this.#referenceRuntimeReady() === true }
    catch { return false }
  }

  async #createTransaction(
    kind: TransactionKind,
    id: string,
    transactionId: string = randomUUID()
  ): Promise<{ root: string; backupName: string }> {
    const root = path.join(this.#workRoot, `${kind}-${id}-${transactionId}`)
    const backupName = `.${id}.backup-${transactionId}`
    await fs.mkdir(root, { recursive: false, mode: 0o700 })
    const journal: TransactionJournal = { version: 1, kind, id, backupName }
    await fs.writeFile(path.join(root, 'journal.json'), `${JSON.stringify(journal)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    return { root, backupName }
  }

  async #recoverTransactions(): Promise<void> {
    const entries = await fs.readdir(this.#workRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const transaction = path.join(this.#workRoot, entry.name)
      try {
        const source = await fs.readFile(path.join(transaction, 'journal.json'), 'utf8')
        const journal = JSON.parse(source) as Partial<TransactionJournal>
        if (
          journal.version !== 1 ||
          (journal.kind !== 'plugin' && journal.kind !== 'library') ||
          typeof journal.id !== 'string' ||
          typeof journal.backupName !== 'string'
        ) {
          throw new Error('invalid journal')
        }
        validateIdentifier(journal.id, 'id')
        const root = journal.kind === 'plugin' ? this.#pluginRoot : this.#libraryRoot
        const expectedBackup = `.${journal.id}.backup-`
        if (!journal.backupName.startsWith(expectedBackup) || /[\\/]/.test(journal.backupName)) {
          throw new Error('invalid backup')
        }
        const target = path.join(root, journal.id)
        const backup = path.join(root, journal.backupName)
        if (await exists(backup)) {
          if (await exists(target)) {
            if (journal.kind === 'plugin') await this.#preservePluginTree(backup, journal.id, 'recovery')
            else await this.#removeTree(backup, root)
          }
          else await this.#renamePath(backup, target)
        }
        if (!(await exists(backup))) await this.#removeTree(transaction, this.#workRoot)
      } catch (error) {
        console.error(`安装事务恢复失败 ${entry.name}:`, error)
      }
    }
  }

  async #ensureOrdinaryRoot(root: string): Promise<void> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ZToolsError(errorCodes.permissionDenied, '安装数据根目录不是普通目录')
    }
  }

  async #preservePluginTree(
    source: string,
    pluginId: string,
    reason: 'update' | 'uninstall' | 'recovery'
  ): Promise<string> {
    validateIdentifier(pluginId, 'pluginId')
    if (!(await this.#isOrdinaryDirectory(source))) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件旧目录不是普通目录')
    }
    await this.#ensureOrdinaryRoot(this.#pluginDataRoot)
    const pluginData = path.join(this.#pluginDataRoot, pluginId)
    if (await exists(pluginData) && !(await this.#isOrdinaryDirectory(pluginData))) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件数据目录不是普通目录')
    }
    await fs.mkdir(pluginData, { recursive: true, mode: 0o700 })
    await this.#ensureOrdinaryRoot(pluginData)
    const legacyRoot = path.join(pluginData, 'legacy')
    if (await exists(legacyRoot) && !(await this.#isOrdinaryDirectory(legacyRoot))) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件历史数据目录不是普通目录')
    }
    await fs.mkdir(legacyRoot, { recursive: true, mode: 0o700 })
    await this.#ensureOrdinaryRoot(legacyRoot)
    const preservationId = `${Date.now()}-${randomUUID()}`
    const destination = path.join(legacyRoot, preservationId)
    await this.#renamePath(source, destination)
    this.#publish('plugin_data_preserved', { pluginId, reason, preservationId })
    return preservationId
  }

  async #isOrdinaryDirectory(target: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(target)
      return stat.isDirectory() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  }

  async #removeTree(target: string, root: string): Promise<void> {
    const resolvedRoot = path.resolve(root)
    const resolvedTarget = path.resolve(target)
    if (resolvedTarget === resolvedRoot || !isWithin(resolvedRoot, resolvedTarget)) {
      throw new ZToolsError(errorCodes.permissionDenied, '拒绝清理安装根目录之外的路径')
    }
    await fs.rm(resolvedTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  async #renamePath(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const retryDelays = [25, 75, 200]
    for (let attempt = 0; ; attempt += 1) {
      if (signal) requireNotAborted(signal)
      try {
        await this.#rename(source, destination)
        return
      } catch (error) {
        const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(filesystemErrorCode(error))
        const retryDelay = retryDelays[attempt]
        if (!retryable || retryDelay === undefined) throw error
        await delay(retryDelay)
      }
    }
  }

  #pluginPath(pluginId: string): string {
    if (isCommonPluginRoot(pluginId)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'CommonPlugins 是客户端保留目录')
    }
    const target = path.resolve(this.#pluginRoot, pluginId)
    if (!isWithin(this.#pluginRoot, target) || target === this.#pluginRoot) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件路径越界')
    }
    return target
  }

  #libraryPath(libId: string): string {
    const target = path.resolve(this.#libraryRoot, libId)
    if (!isWithin(this.#libraryRoot, target) || target === this.#libraryRoot) {
      throw new ZToolsError(errorCodes.permissionDenied, '依赖库路径越界')
    }
    return target
  }

  #progress(pluginId: string, percent: number, phase: string, libIndex = 0, libTotal = 0): void {
    this.#publish('plugin_download_progress', {
      pluginId,
      percent: Math.max(0, Math.min(100, Math.floor(percent))),
      phase,
      ...(libTotal > 0 ? { libIndex, libTotal } : {})
    })
  }

  #publish(type: string, payload: unknown): void {
    try {
      this.events.publishHostToMain(type, payload)
    } catch (error) {
      if (this.#state === 'running') console.warn(`发布 ${type} 事件失败:`, error)
    }
  }

  #requireRunning(): void {
    if (this.#state !== 'running') {
      throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    }
  }
}
