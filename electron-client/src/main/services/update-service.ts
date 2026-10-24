import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { UpdateCheckParams, UpdatePackageParams } from '../../contracts/method-params.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'
import type { WebResourceService } from './web-resource-service.js'

const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const APP_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000
const DOWNLOAD_METADATA_SCHEMA_VERSION = 1
const PRODUCT_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/
const UAC_CANCELLED_EXIT_CODE = 1223
const UPDATE_CHECK_TIMEOUT_MS = 30_000

/** 一次更新检查的输入 */
export interface UpdateCheckRequest {
  readonly platform: 'windows' | 'macos'
  readonly arch: string
  readonly appVersion: string
  readonly webVersion: string
  readonly source: UpdateCheckParams['source']
  /** 超时时中止 */
  readonly signal: AbortSignal
}

/**
 * 更新来源（由主进程版本提供）。
 * 返回 `{ app, web }` 原始更新描述，校验、版本比较与下载安装都由 UpdateService 统一完成；
 * 网络或服务端失败时抛错。没有更新来源的版本传 null，检查更新直接返回没有更新且不发任何请求。
 */
export interface UpdateSource {
  fetchLatest(request: UpdateCheckRequest): Promise<unknown>
}

type DownloadState = 'downloading' | 'downloaded' | 'started'

export interface UpdateProgress {
  operationId: string
  type: 'app' | 'web'
  downloaded: number
  total: number
  percent: number
}

type UpdateProgressListener = (progress: UpdateProgress) => void

interface DownloadOperation {
  operationId: string
  type: 'app' | 'web'
  version: string
  downloadUrl: string
  checksum: string
  fileSize: number
  path: string
  metadataPath: string
  controller: AbortController
  state: DownloadState
  started: boolean
}

interface DownloadMetadata {
  schemaVersion: number
  state: DownloadState
  operationId: string
  type: 'app' | 'web'
  version: string
  downloadUrl: string
  checksum: string
  fileSize: number
  path: string
}

export interface UpdateInfo {
  version: string
  changelog: string
  force: boolean
  fileSize: number
  downloadUrl: string
  checksum: string
  minAppVersion?: string
  /** macOS 使用 DMG 手动替换，不进入 Windows 安装器。 */
  manualUpdate?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function networkError(error: unknown, message: string): ZToolsError {
  if (error instanceof ZToolsError) return error
  const detail = error instanceof Error ? error.message.slice(0, 256) : String(error)
  return new ZToolsError(errorCodes.networkError, message + ': ' + detail)
}

function normalizeChecksum(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '')
  if (normalized === '') return ''
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : ''
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => (value.split(/[+-]/, 1)[0] ?? '').split('.').map((item) => Number.parseInt(item, 10) || 0)
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length, 4); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function normalizeVersion(value: string, label: string): string {
  if (!PRODUCT_VERSION_PATTERN.test(value)) {
    throw new ZToolsError(errorCodes.dataCorrupt, label + '版本格式无效')
  }
  return value
}

function normalizeUpdate(value: unknown, label: string): UpdateInfo | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new ZToolsError(errorCodes.dataCorrupt, label + '更新响应无效')
  }
  const version = normalizeVersion(value.version, label)
  const downloadUrl = typeof value.downloadUrl === 'string'
    ? value.downloadUrl
    : typeof value.url === 'string'
      ? value.url
      : typeof value.download_url === 'string'
        ? value.download_url
        : ''
  if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) {
    throw new ZToolsError(errorCodes.dataCorrupt, label + '更新地址无效')
  }
  const rawFileSize = value.fileSize ?? value.file_size ?? 0
  const validFileSize = typeof rawFileSize === 'number' && Number.isSafeInteger(rawFileSize) &&
    rawFileSize >= 0 && rawFileSize <= MAX_UPDATE_BYTES
  if (!validFileSize && label !== 'App') {
    throw new ZToolsError(errorCodes.dataCorrupt, label + '更新大小无效')
  }
  const fileSize = validFileSize ? rawFileSize : 0
  const checksum = typeof value.checksum === 'string' ? value.checksum : ''
  const normalizedChecksum = normalizeChecksum(checksum)
  const rawMinAppVersion = value.minAppVersion ?? value.min_app_version
  const minAppVersion = label === 'App' || rawMinAppVersion === undefined
    ? undefined
    : typeof rawMinAppVersion === 'string'
      ? normalizeVersion(rawMinAppVersion, label + '最低宿主')
      : (() => { throw new ZToolsError(errorCodes.dataCorrupt, label + '最低宿主版本无效') })()
  return {
    version,
    changelog: typeof value.changelog === 'string' ? value.changelog : '',
    force: value.force === true,
    fileSize,
    downloadUrl,
    checksum: normalizedChecksum,
    ...(minAppVersion ? { minAppVersion } : {})
  }
}

async function downloadResponseToFile(
  response: Response,
  temporary: string,
  signal: AbortSignal,
  expectedSize: number,
  maxBytes: number,
  onProgress: (downloaded: number, total: number) => void
): Promise<{ size: number; checksum: string }> {
  if (!response.body) throw new ZToolsError(errorCodes.networkError, '更新响应没有内容')
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ZToolsError(errorCodes.fileTooLarge, '更新包超过大小限制')
  }
  if (expectedSize > 0 && contentLength > 0 && contentLength !== expectedSize) {
    throw new ZToolsError(errorCodes.dataCorrupt, '更新包大小与声明不一致')
  }
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let total = 0
  let file: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    file = await fs.open(temporary, 'wx')
    const opened = file
    while (true) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new ZToolsError(errorCodes.appStopping, '更新下载已取消')
      }
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.length
      if (total > maxBytes || (expectedSize > 0 && total > expectedSize)) {
        throw new ZToolsError(errorCodes.fileTooLarge, '更新包超过大小限制')
      }
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const written = await opened.write(chunk, offset, chunk.length - offset)
        if (written.bytesWritten <= 0) throw new ZToolsError(errorCodes.networkError, '更新包写入失败')
        offset += written.bytesWritten
      }
      onProgress(total, expectedSize || contentLength || 0)
    }
    if (expectedSize > 0 && total !== expectedSize) {
      throw new ZToolsError(errorCodes.dataCorrupt, '更新包大小与声明不一致')
    }
    await opened.sync()
    return { size: total, checksum: hash.digest('hex') }
  } finally {
    reader.releaseLock()
    await file?.close()
  }
}

function updateType(params: UpdatePackageParams): 'app' | 'web' {
  return params.type === 'web' ? 'web' : 'app'
}

async function isUsableDownload(operation: DownloadOperation): Promise<boolean> {
  try {
    const stats = await fs.stat(operation.path)
    if (!stats.isFile()) return false
    if (operation.fileSize > 0 && stats.size !== operation.fileSize) return false
    if (operation.checksum) {
      const file = await fs.open(operation.path, 'r')
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      try {
        for (;;) {
          const read = await file.read(buffer, 0, buffer.length, null)
          if (read.bytesRead === 0) break
          hash.update(buffer.subarray(0, read.bytesRead))
        }
      } finally {
        await file.close()
      }
      const digest = hash.digest('hex')
      if (digest !== operation.checksum) return false
    }
    return true
  } catch {
    return false
  }
}

function metadataFor(operation: DownloadOperation, state: DownloadState): DownloadMetadata {
  return {
    schemaVersion: DOWNLOAD_METADATA_SCHEMA_VERSION,
    state,
    operationId: operation.operationId,
    type: operation.type,
    version: operation.version,
    downloadUrl: operation.downloadUrl,
    checksum: operation.checksum,
    fileSize: operation.fileSize,
    path: operation.path
  }
}

async function persistDownloadMetadata(operation: DownloadOperation, state: DownloadState): Promise<void> {
  const temporary = operation.metadataPath + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(metadataFor(operation, state)), { encoding: 'utf8' })
  await fs.rename(temporary, operation.metadataPath)
}

function createUpdaterEnvironment(): NodeJS.ProcessEnv {
  const inheritedEnvironment = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(process.env)) {
    inheritedEnvironment.set(name.toLowerCase(), value)
  }
  const environment: NodeJS.ProcessEnv = {}
  const allowedEnvironmentNames = [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'USERDOMAIN',
    'USERDNSDOMAIN',
    'COMPUTERNAME',
    'SESSIONNAME',
    'OS',
    'SystemDrive',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'NUMBER_OF_PROCESSORS'
  ]
  for (const name of allowedEnvironmentNames) {
    const value = inheritedEnvironment.get(name.toLowerCase())
    if (value !== undefined) environment[name] = value
  }
  const systemRoot = environment.SystemRoot ?? environment.WINDIR
  if (systemRoot) {
    environment.SystemRoot = systemRoot
    environment.WINDIR = systemRoot
    environment.PATH = [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter)
    environment.ComSpec = path.join(systemRoot, 'System32', 'cmd.exe')
  }
  return environment
}

function runUpdaterAndWait(
  executable: string,
  argumentsList: string[],
  cwd: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      detached: true,
      env: createUpdaterEnvironment(),
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === null) {
        reject(new Error(`更新器进程未返回退出码${signal ? `（${signal}）` : ''}`))
        return
      }
      resolve(code)
    })
    child.unref()
  })
}

function isDirectDownloadPath(downloadRoot: string, candidate: string): boolean {
  const root = path.resolve(downloadRoot)
  const normalized = path.resolve(candidate)
  return path.dirname(normalized) === root
}

export class UpdateService {
  readonly #platform: NodeJS.Platform
  readonly #arch: string
  readonly #runtimePaths: RuntimePaths
  readonly #appVersion: string
  #webVersion: string
  readonly #updateSource: UpdateSource | null
  readonly #fetch: typeof fetch
  readonly #webResources: WebResourceService | undefined
  readonly #runUpdater: typeof runUpdaterAndWait
  readonly #operations = new Map<string, DownloadOperation>()
  readonly #downloadPromises = new Map<string, Promise<{
    success: true
    operationId: string
    status: 'downloaded'
    type: 'app' | 'web'
    version: string
    path: string
  }>>()
  readonly #progressListeners = new Set<UpdateProgressListener>()
  readonly #installing = new Set<string>()
  readonly #activeDownloads = new Set<Promise<unknown>>()
  #installQueue: Promise<void> = Promise.resolve()
  #appHandoffStarted = false

  constructor(options: {
    platform?: NodeJS.Platform
    arch?: string
    runtimePaths: RuntimePaths
    appVersion: string
    webVersion: string
    /** 更新来源；不传或为 null 表示没有更新来源 */
    updateSource?: UpdateSource | null
    fetchImpl?: typeof fetch
    webResources?: WebResourceService
    runUpdaterImpl?: typeof runUpdaterAndWait
  }) {
    this.#platform = options.platform ?? process.platform
    this.#arch = options.arch ?? process.arch
    this.#runtimePaths = options.runtimePaths
    this.#appVersion = options.appVersion
    this.#webVersion = options.webVersion
    // 没有更新来源（开源版、未配置后台的构建）时检查更新不发任何请求
    this.#updateSource = options.updateSource ?? null
    this.#fetch = options.fetchImpl ?? fetch
    this.#webResources = options.webResources
    this.#runUpdater = options.runUpdaterImpl ?? runUpdaterAndWait
  }

  #assertWindowsUpdate(): void {
    if (this.#platform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, '应用内下载安装仅支持 Windows；macOS 请下载 DMG 手动替换')
    }
  }

  onProgress(listener: UpdateProgressListener): () => void {
    this.#progressListeners.add(listener)
    return () => this.#progressListeners.delete(listener)
  }

  async #findPersistedDownload(
    downloadRoot: string,
    type: 'app' | 'web',
    version: string,
    downloadUrl: string,
    checksum: string,
    fileSize: number
  ): Promise<DownloadOperation | undefined> {
    const entries = await fs.readdir(downloadRoot, { withFileTypes: true }).catch(() => undefined)
    if (!entries) return undefined
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const metadataPath = path.join(downloadRoot, entry.name)
      let metadata: Partial<DownloadMetadata>
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Partial<DownloadMetadata>
      } catch {
        await fs.rm(metadataPath, { force: true }).catch(() => undefined)
        continue
      }
      if (metadata.state === 'downloading' || metadata.state === 'started') continue
      if (
        metadata.schemaVersion !== DOWNLOAD_METADATA_SCHEMA_VERSION ||
        (metadata.state !== 'downloaded' && metadata.state !== 'started') ||
        typeof metadata.operationId !== 'string' ||
        metadata.type !== type ||
        metadata.version !== version ||
        metadata.downloadUrl !== downloadUrl ||
        metadata.checksum !== checksum ||
        metadata.fileSize !== fileSize ||
        typeof metadata.path !== 'string' ||
        !isDirectDownloadPath(downloadRoot, metadata.path)
      ) {
        continue
      }
      const operation: DownloadOperation = {
        operationId: metadata.operationId,
        type,
        version,
        downloadUrl,
        checksum,
        fileSize,
        path: path.resolve(metadata.path),
        metadataPath,
        controller: new AbortController(),
        state: metadata.state,
        started: false
      }
      if (await isUsableDownload(operation)) {
        this.#operations.set(operation.operationId, operation)
        return operation
      }
      await fs.rm(operation.path, { force: true }).catch(() => undefined)
      await fs.rm(metadataPath, { force: true }).catch(() => undefined)
    }
    return undefined
  }

  async check(params: UpdateCheckParams): Promise<{
    success: true
    source: UpdateCheckParams['source']
    app: UpdateInfo | null
    web: UpdateInfo | null
  }> {
    if (this.#platform !== 'win32' && this.#platform !== 'darwin') {
      throw new ZToolsError(errorCodes.notSupported, '当前平台不支持更新检查')
    }
    const updateSource = this.#updateSource
    if (updateSource === null) return { success: true, source: params.source, app: null, web: null }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
    try {
      const envelope = await updateSource.fetchLatest({
        platform: this.#platform === 'darwin' ? 'macos' : 'windows',
        arch: this.#arch,
        appVersion: this.#appVersion,
        webVersion: this.#webVersion,
        source: params.source,
        signal: controller.signal
      })
      if (!isRecord(envelope)) throw new ZToolsError(errorCodes.dataCorrupt, '更新服务器响应结构无效')
      const app = normalizeUpdate(envelope.app, 'App')
      const web = normalizeUpdate(envelope.web, 'Web')
      if (this.#platform === 'darwin' && web) {
        throw new ZToolsError(errorCodes.dataCorrupt, 'macOS 更新必须使用完整安装包')
      }
      if (app && this.#platform === 'darwin') app.manualUpdate = true
      return {
        success: true,
        source: params.source,
        app: app && compareVersions(app.version, this.#appVersion) > 0 ? app : null,
        web: web && compareVersions(web.version, this.#webVersion) > 0 ? web : null
      }
    } catch (error) {
      throw networkError(error, '检查更新失败')
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  async download(params: UpdatePackageParams): Promise<{
    success: true
    operationId: string
    status: 'downloaded'
    type: 'app' | 'web'
    version: string
    path: string
  }> {
    this.#assertWindowsUpdate()
    const requestKey = JSON.stringify([
      params.type ?? 'app',
      params.version,
      params.downloadUrl,
      params.checksum,
      params.fileSize,
      params.minAppVersion
    ])
    const inFlight = this.#downloadPromises.get(requestKey)
    if (inFlight) return inFlight
    const task = this.#download(params)
    this.#downloadPromises.set(requestKey, task)
    this.#activeDownloads.add(task)
    try {
      return await task
    } finally {
      this.#activeDownloads.delete(task)
      if (this.#downloadPromises.get(requestKey) === task) this.#downloadPromises.delete(requestKey)
    }
  }

  async #download(params: UpdatePackageParams): Promise<{
    success: true
    operationId: string
    status: 'downloaded'
    type: 'app' | 'web'
    version: string
    path: string
  }> {
    const type = updateType(params)
    const version = normalizeVersion(params.version, '更新')
    const currentVersion = type === 'web' ? this.#webVersion : this.#appVersion
    if (compareVersions(version, currentVersion) <= 0) {
      throw new ZToolsError(errorCodes.invalidRequest, `不允许下载低于或等于当前版本的${type === 'web' ? 'Web' : 'App'}更新包`)
    }
    const timeoutMs = type === 'app' ? APP_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS
    const expectedChecksum = normalizeChecksum(params.checksum)
    if (!expectedChecksum) {
      throw new ZToolsError(errorCodes.dataCorrupt, `${type === 'web' ? 'Web' : 'App'} 更新包缺少 SHA-256 校验值`)
    }
    const validFileSize = Number.isSafeInteger(params.fileSize) && params.fileSize >= 0 && params.fileSize <= MAX_UPDATE_BYTES
    if (type === 'web' && !validFileSize) {
      throw new ZToolsError(errorCodes.invalidRequest, '更新大小无效')
    }
    const fileSize = validFileSize ? params.fileSize : 0
    let downloadUrl: URL
    try {
      downloadUrl = new URL(params.downloadUrl)
    } catch {
      throw new ZToolsError(errorCodes.invalidRequest, '更新地址无效')
    }
    const loopback = downloadUrl.hostname === '127.0.0.1' || downloadUrl.hostname === 'localhost' || downloadUrl.hostname === '::1'
    if (
      (downloadUrl.protocol !== 'https:' && !(downloadUrl.protocol === 'http:' && loopback)) ||
      downloadUrl.username !== '' ||
      downloadUrl.password !== ''
    ) {
      throw new ZToolsError(errorCodes.permissionDenied, '更新下载只允许 HTTPS 或本机测试地址')
    }
    const downloadRoot = path.join(this.#runtimePaths.transactionRoot, 'Downloads')
    let existing: DownloadOperation | undefined
    for (const operation of this.#operations.values()) {
      if (operation.started || operation.state !== 'downloaded' || operation.type !== type || operation.version !== version ||
          operation.downloadUrl !== params.downloadUrl || operation.checksum !== expectedChecksum ||
          (fileSize > 0 && operation.fileSize !== fileSize)) continue
      if (await isUsableDownload(operation)) {
        existing = operation
        break
      }
      this.#operations.delete(operation.operationId)
    }
    if (existing) {
      return { success: true, operationId: existing.operationId, status: 'downloaded', type, version: existing.version, path: existing.path }
    }
    const persisted = await this.#findPersistedDownload(
      downloadRoot,
      type,
      version,
      params.downloadUrl,
      expectedChecksum,
      fileSize
    )
    if (persisted) {
      return {
        success: true,
        operationId: persisted.operationId,
        status: 'downloaded',
        type,
        version,
        path: persisted.path
      }
    }
    const operationId = randomUUID()
    const controller = new AbortController()
    const safeVersion = params.version.replace(/[^0-9A-Za-z.-]/g, '_')
    const extension = downloadUrl.pathname.toLowerCase().endsWith('.zip') ? '.zip' : '.exe'
    const target = path.join(downloadRoot, type + '-' + safeVersion + '-' + operationId + extension)
    const temporary = target + '.tmp'
    const operation: DownloadOperation = {
      operationId,
      type,
      version,
      downloadUrl: params.downloadUrl,
      checksum: expectedChecksum,
      fileSize,
      path: target,
      metadataPath: target + '.json',
      controller,
      state: 'downloading',
      started: false
    }
    this.#operations.set(operationId, operation)
    try {
      await fs.mkdir(downloadRoot, { recursive: true })
      await persistDownloadMetadata(operation, 'downloading')
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new ZToolsError(errorCodes.networkError, '下载安装包超时'))
      }, timeoutMs)
      const signal = AbortSignal.any([controller.signal, timeoutController.signal])
      let response: Response
      try {
        response = await this.#fetch(params.downloadUrl, { signal })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) throw new ZToolsError(errorCodes.networkError, '下载安装包失败: HTTP ' + response.status)
      const downloadTimeoutController = new AbortController()
      const downloadTimeout = setTimeout(() => {
        downloadTimeoutController.abort(new ZToolsError(errorCodes.networkError, '下载安装包超时'))
      }, timeoutMs)
      const downloadSignal = AbortSignal.any([controller.signal, downloadTimeoutController.signal])
      const downloaded = await downloadResponseToFile(
        response,
        temporary,
        downloadSignal,
        type === 'web' ? fileSize : 0,
        type === 'web' ? MAX_UPDATE_BYTES : Number.MAX_SAFE_INTEGER,
        (downloadedBytes, totalBytes) => {
          this.#publishProgress({
            operationId,
            type,
            downloaded: downloadedBytes,
            total: totalBytes,
            percent: totalBytes > 0 ? Math.min(99, Math.floor(downloadedBytes * 100 / totalBytes)) : 0
          })
        }
      ).finally(() => clearTimeout(downloadTimeout))
      if (expectedChecksum && downloaded.checksum !== expectedChecksum) {
        throw new ZToolsError(errorCodes.dataCorrupt, '更新包 SHA-256 校验失败')
      }
      await fs.rename(temporary, target)
      operation.state = 'downloaded'
      await persistDownloadMetadata(operation, 'downloaded')
      this.#publishProgress({
        operationId,
        type,
        downloaded: downloaded.size,
        total: downloaded.size,
        percent: 100
      })
      return { success: true, operationId, status: 'downloaded', type, version: params.version, path: target }
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      await fs.rm(operation.path, { force: true }).catch(() => undefined)
      await fs.rm(operation.metadataPath, { force: true }).catch(() => undefined)
      this.#operations.delete(operationId)
      if (error instanceof ZToolsError) throw error
      throw networkError(error, '下载安装包失败')
    }
  }

  async install(
    params: UpdatePackageParams,
    signal: AbortSignal = new AbortController().signal
  ): Promise<{
    success: true
    operationId: string
    state: 'started' | 'completed'
    restartRequired: boolean
    reloadRequired?: boolean
    version?: string
  }> {
    this.#assertWindowsUpdate()
    const previous = this.#installQueue
    const task = previous.then(() => this.#install(params, signal))
    this.#installQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async #install(
    params: UpdatePackageParams,
    signal: AbortSignal
  ): Promise<{
    success: true
    operationId: string
    state: 'started' | 'completed'
    restartRequired: boolean
    reloadRequired?: boolean
    version?: string
  }> {
    if (updateType(params) === 'web') return this.#installWeb(params, signal)
    return this.#installApp(params)
  }

  async #resolveDownload(
    params: UpdatePackageParams,
    type: 'app' | 'web',
    version: string,
    checksum: string
  ): Promise<DownloadOperation | undefined> {
    let download = [...this.#operations.values()].find((operation) =>
      !operation.started &&
      operation.state === 'downloaded' &&
      operation.type === type &&
      operation.version === version &&
      (!params.downloadUrl || operation.downloadUrl === params.downloadUrl) &&
      (!checksum || operation.checksum === checksum) &&
      (!params.fileSize || operation.fileSize === params.fileSize)
    )
    if (!download && params.downloadUrl) {
      const result = await this.download(params)
      download = this.#operations.get(result.operationId)
    }
    return download
  }

  async #installApp(params: UpdatePackageParams): Promise<{
    success: true
    operationId: string
    state: 'started'
    restartRequired: true
  }> {
    const version = normalizeVersion(params.version, '更新')
    if (compareVersions(version, this.#appVersion) <= 0) {
      throw new ZToolsError(errorCodes.invalidRequest, '不允许安装低于或等于当前版本的 App 更新包')
    }
    const requestedChecksum = params.checksum ? normalizeChecksum(params.checksum) : ''
    const download = await this.#resolveDownload(params, 'app', version, requestedChecksum)
    if (!download) throw new ZToolsError(errorCodes.invalidRequest, '没有可安装的 App 更新包')
    if (!download.checksum || !(await isUsableDownload(download))) {
      await fs.rm(download.path, { force: true }).catch(() => undefined)
      await fs.rm(download.metadataPath, { force: true }).catch(() => undefined)
      this.#operations.delete(download.operationId)
      throw new ZToolsError(errorCodes.dataCorrupt, 'App 更新包文件不可用')
    }
    if (this.#installing.has(download.operationId)) {
      throw new ZToolsError(errorCodes.invalidRequest, '该 App 更新已在交接中')
    }
    this.#installing.add(download.operationId)
    const maintenanceRoot = path.join(this.#runtimePaths.transactionRoot, 'Maintenance', randomUUID())
    const appHandoffWasStarted = this.#appHandoffStarted
    try {
      await fs.mkdir(maintenanceRoot, { recursive: true })
      const updaterPath = path.join(maintenanceRoot, 'ZToolsUpdater.exe')
      await fs.copyFile(path.join(this.#runtimePaths.installRoot, 'ZToolsUpdater.exe'), updaterPath)
      download.started = true
      download.state = 'started'
      this.#appHandoffStarted = true
      await persistDownloadMetadata(download, 'started').catch(() => undefined)
      // Let the native updater resolve scope through the Unicode Win32 registry API.
      const exitCode = await this.#runUpdater(updaterPath, [
        '--source=' + download.path,
        '--target=' + this.#runtimePaths.installRoot,
        '--updated',
        '--need-cleanup'
      ], maintenanceRoot)
      if (exitCode === UAC_CANCELLED_EXIT_CODE) {
        throw new ZToolsError(errorCodes.cancelled, '用户取消了 UAC 授权，更新未安装')
      }
      if (exitCode !== 0) {
        throw new ZToolsError(errorCodes.processError, `自提权更新器执行失败（退出代码 ${exitCode}）`)
      }
    } catch (error) {
      download.started = false
      download.state = 'downloaded'
      this.#appHandoffStarted = appHandoffWasStarted
      await persistDownloadMetadata(download, 'downloaded').catch(() => undefined)
      if (error instanceof ZToolsError) throw error
      const detail = error instanceof Error ? error.message.slice(0, 256) : String(error)
      throw new ZToolsError(errorCodes.processError, '启动自提权更新器失败: ' + detail)
    } finally {
      await fs.rm(maintenanceRoot, { recursive: true, force: true }).catch(() => undefined)
      this.#installing.delete(download.operationId)
    }
    return { success: true, operationId: download.operationId, state: 'started', restartRequired: true }
  }

  async #installWeb(
    params: UpdatePackageParams,
    signal: AbortSignal
  ): Promise<{
    success: true
    operationId: string
    state: 'completed'
    restartRequired: false
    reloadRequired: true
    version: string
  }> {
    if (!this.#webResources) {
      throw new ZToolsError(errorCodes.notSupported, 'Web 更新资源服务尚未启用')
    }
    if (this.#appHandoffStarted) {
      throw new ZToolsError(errorCodes.invalidRequest, 'App 更新已交接，本次运行不再切换 Web 资源')
    }
    const version = normalizeVersion(params.version, '更新')
    const requestedChecksum = normalizeChecksum(params.checksum)
    if (!requestedChecksum) {
      throw new ZToolsError(errorCodes.dataCorrupt, 'Web 更新包缺少 SHA-256 校验值')
    }
    if (params.minAppVersion !== undefined) {
      const minimum = normalizeVersion(params.minAppVersion, 'Web 最低宿主')
      if (compareVersions(this.#appVersion, minimum) < 0) {
        throw new ZToolsError(errorCodes.notSupported, '当前 App 版本低于 Web 更新要求')
      }
    }
    const download = await this.#resolveDownload(params, 'web', version, requestedChecksum)
    if (!download) throw new ZToolsError(errorCodes.invalidRequest, '没有可安装的已校验 Web 更新包')
    if (!download.checksum || !(await isUsableDownload(download))) {
      await fs.rm(download.path, { force: true }).catch(() => undefined)
      await fs.rm(download.metadataPath, { force: true }).catch(() => undefined)
      this.#operations.delete(download.operationId)
      throw new ZToolsError(errorCodes.dataCorrupt, 'Web 更新包已损坏或已被替换')
    }
    if (this.#installing.has(download.operationId)) {
      throw new ZToolsError(errorCodes.invalidRequest, '该 Web 更新已在切换中')
    }
    this.#installing.add(download.operationId)
    try {
      const result = await this.#webResources.applyArchive(download.path, version, signal)
      this.#webVersion = result.version
      return {
        success: true,
        operationId: result.operationId,
        state: 'completed',
        restartRequired: false,
        reloadRequired: true,
        version: result.version
      }
    } finally {
      this.#installing.delete(download.operationId)
    }
  }

  refreshWebVersion(): void {
    if (this.#webResources) this.#webVersion = this.#webResources.version
  }

  cancel(): { success: true; cancelled: string[] } {
    const cancelled: string[] = []
    for (const [operationId, operation] of this.#operations) {
      if (operation.started || this.#installing.has(operationId)) continue
      operation.controller.abort(errorCodes.appStopping)
      void fs.rm(operation.path, { force: true })
      void fs.rm(operation.metadataPath, { force: true })
      this.#operations.delete(operationId)
      cancelled.push(operationId)
    }
    return { success: true, cancelled }
  }

  async stop(): Promise<void> {
    this.cancel()
    await Promise.allSettled([...this.#activeDownloads])
    await this.#installQueue
  }

  #publishProgress(progress: UpdateProgress): void {
    for (const listener of this.#progressListeners) {
      try {
        listener(progress)
      } catch (error) {
        console.warn('更新进度监听器失败:', error)
      }
    }
  }
}
