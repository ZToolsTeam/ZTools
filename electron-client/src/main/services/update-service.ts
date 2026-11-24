import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { UpdateCheckParams, UpdatePackageParams } from '../../contracts/method-params.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'
import type { WebResourceService } from './web-resource-service.js'
import { getResolvedLocale, t } from '../i18n/index.js'

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
  changelogI18n?: Record<string, string>
  force: boolean
  fileSize: number
  downloadUrl: string
  checksum: string
  minAppVersion?: string
}

function normalizeChangelogI18n(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawKey, rawVal] of Object.entries(value)) {
    if (!Object.hasOwn(value, rawKey)) continue
    const key = rawKey.trim()
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (typeof rawVal !== 'string') continue
    out[key] = rawVal
    count += 1
  }
  return count > 0 ? out : undefined
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
    throw new ZToolsError(errorCodes.dataCorrupt, t('update.invalidVersionFormat', { target: label }), {
      i18nKey: 'update.invalidVersionFormat',
      i18nParams: { target: label }
    })
  }
  return value
}

function normalizeUpdate(value: unknown, label: string): UpdateInfo | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new ZToolsError(errorCodes.dataCorrupt, t('update.invalidTargetResponse', { target: label }), {
      i18nKey: 'update.invalidTargetResponse',
      i18nParams: { target: label }
    })
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
    throw new ZToolsError(errorCodes.dataCorrupt, t('update.invalidTargetUrl', { target: label }), {
      i18nKey: 'update.invalidTargetUrl',
      i18nParams: { target: label }
    })
  }
  const rawFileSize = value.fileSize ?? value.file_size ?? 0
  const validFileSize = typeof rawFileSize === 'number' && Number.isSafeInteger(rawFileSize) &&
    rawFileSize >= 0 && rawFileSize <= MAX_UPDATE_BYTES
  if (!validFileSize && label !== 'App') {
    throw new ZToolsError(errorCodes.dataCorrupt, t('update.invalidTargetSize', { target: label }), {
      i18nKey: 'update.invalidTargetSize',
      i18nParams: { target: label }
    })
  }
  const fileSize = validFileSize ? rawFileSize : 0
  const checksum = typeof value.checksum === 'string' ? value.checksum : ''
  const normalizedChecksum = normalizeChecksum(checksum)
  const rawMinAppVersion = value.minAppVersion ?? value.min_app_version
  const minAppVersion = label === 'App' || rawMinAppVersion === undefined
    ? undefined
    : typeof rawMinAppVersion === 'string'
      ? normalizeVersion(rawMinAppVersion, t('update.target.minHost', { target: label }))
      : (() => {
        throw new ZToolsError(errorCodes.dataCorrupt, t('update.invalidMinHostVersion', { target: label }), {
          i18nKey: 'update.invalidMinHostVersion',
          i18nParams: { target: label }
        })
      })()
  const changelogI18n = normalizeChangelogI18n(value.changelogI18n ?? value.changelog_i18n)
  return {
    version,
    changelog: typeof value.changelog === 'string' ? value.changelog : '',
    ...(changelogI18n ? { changelogI18n } : {}),
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
  if (!response.body) throw new ZToolsError(errorCodes.networkError, t('update.responseEmpty'))
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ZToolsError(errorCodes.fileTooLarge, t('update.packageTooLarge'))
  }
  if (expectedSize > 0 && contentLength > 0 && contentLength !== expectedSize) {
    throw new ZToolsError(errorCodes.dataCorrupt, t('update.packageSizeMismatch'))
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
          : new ZToolsError(errorCodes.appStopping, t('update.downloadCancelled'))
      }
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.length
      if (total > maxBytes || (expectedSize > 0 && total > expectedSize)) {
        throw new ZToolsError(errorCodes.fileTooLarge, t('update.packageTooLarge'))
      }
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const written = await opened.write(chunk, offset, chunk.length - offset)
        if (written.bytesWritten <= 0) throw new ZToolsError(errorCodes.networkError, t('update.packageWriteFailed'))
        offset += written.bytesWritten
      }
      onProgress(total, expectedSize || contentLength || 0)
    }
    if (expectedSize > 0 && total !== expectedSize) {
      throw new ZToolsError(errorCodes.dataCorrupt, t('update.packageSizeMismatch'))
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
  environment.ZTOOLS_LOCALE = getResolvedLocale()
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
        reject(new Error(signal
          ? t('update.updaterNoExitCodeWithSignal', { signal })
          : t('update.updaterNoExitCode')))
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

const CLEANUP_RETRY_DELAYS_MS = [350, 800, 1600, 3000] as const

function isTransientCleanupLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

async function removePathWithRetry(
  targetPath: string,
  options: { recursive?: boolean | undefined; retryDelaysMs?: readonly number[] | undefined } = {}
): Promise<boolean> {
  const delays = options.retryDelaysMs ?? CLEANUP_RETRY_DELAYS_MS
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fs.rm(targetPath, {
        force: true,
        recursive: options.recursive === true
      })
      return true
    } catch (error) {
      if (!isTransientCleanupLockError(error) || attempt === delays.length) {
        return false
      }
      const delayMs = delays[attempt] ?? 500
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        timer.unref?.()
      })
    }
  }
  return false
}

export interface MacUpdateInstaller {
  assertSupported(): void
  prepare(dmgPath: string, version: string, signal: AbortSignal): Promise<void>
  requestRestart(): void
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
  readonly #macUpdater: MacUpdateInstaller | undefined
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
  readonly #stopping = new AbortController()

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
    macUpdater?: MacUpdateInstaller
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
    this.#macUpdater = options.macUpdater
  }

  #assertUpdateSupported(params: UpdatePackageParams): void {
    if (this.#platform === 'win32') return
    if (this.#platform === 'darwin' && this.#macUpdater && updateType(params) === 'app') {
      this.#macUpdater.assertSupported()
      return
    }
    throw new ZToolsError(errorCodes.notSupported, t('update.unsupportedEnvironment'))
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
      throw new ZToolsError(errorCodes.notSupported, t('update.unsupportedPlatform'))
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
      if (!isRecord(envelope)) throw new ZToolsError(errorCodes.dataCorrupt, t('update.invalidServerResponse'))
      const app = normalizeUpdate(envelope.app, 'App')
      const web = normalizeUpdate(envelope.web, 'Web')
      if (this.#platform === 'darwin' && web) {
        throw new ZToolsError(errorCodes.dataCorrupt, t('update.macosFullInstallerRequired'))
      }
      return {
        success: true,
        source: params.source,
        app: app && compareVersions(app.version, this.#appVersion) > 0 ? app : null,
        web: web && compareVersions(web.version, this.#webVersion) > 0 ? web : null
      }
    } catch (error) {
      throw networkError(error, t('update.checkFailed'))
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  async download(params: UpdatePackageParams, signal: AbortSignal = new AbortController().signal): Promise<{
    success: true
    operationId: string
    status: 'downloaded'
    type: 'app' | 'web'
    version: string
    path: string
  }> {
    this.#assertUpdateSupported(params)
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
    const task = this.#download(params, signal)
    this.#downloadPromises.set(requestKey, task)
    this.#activeDownloads.add(task)
    try {
      return await task
    } finally {
      this.#activeDownloads.delete(task)
      if (this.#downloadPromises.get(requestKey) === task) this.#downloadPromises.delete(requestKey)
    }
  }

  async #download(params: UpdatePackageParams, requestSignal: AbortSignal): Promise<{
    success: true
    operationId: string
    status: 'downloaded'
    type: 'app' | 'web'
    version: string
    path: string
  }> {
    requestSignal.throwIfAborted()
    const type = updateType(params)
    const version = normalizeVersion(params.version, t('update.target.generic'))
    const currentVersion = type === 'web' ? this.#webVersion : this.#appVersion
    const targetLabel = type === 'web' ? 'Web' : 'App'
    if (compareVersions(version, currentVersion) <= 0) {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.versionNotNewer', { target: targetLabel }))
    }
    const timeoutMs = type === 'app' ? APP_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS
    const expectedChecksum = normalizeChecksum(params.checksum)
    if (!expectedChecksum) {
      throw new ZToolsError(errorCodes.dataCorrupt, t('update.missingChecksum', { target: targetLabel }))
    }
    const validFileSize = Number.isSafeInteger(params.fileSize) && params.fileSize >= 0 && params.fileSize <= MAX_UPDATE_BYTES
    if (type === 'web' && !validFileSize) {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.invalidSize'))
    }
    const fileSize = validFileSize ? params.fileSize : 0
    let downloadUrl: URL
    try {
      downloadUrl = new URL(params.downloadUrl)
    } catch {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.invalidUrl'))
    }
    const loopback = downloadUrl.hostname === '127.0.0.1' || downloadUrl.hostname === 'localhost' || downloadUrl.hostname === '::1'
    if (
      (downloadUrl.protocol !== 'https:' && !(downloadUrl.protocol === 'http:' && loopback)) ||
      downloadUrl.username !== '' ||
      downloadUrl.password !== ''
    ) {
      throw new ZToolsError(errorCodes.permissionDenied, t('update.httpsOnly'))
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
    const extension = this.#platform === 'darwin' ? '.dmg' : downloadUrl.pathname.toLowerCase().endsWith('.zip') ? '.zip' : '.exe'
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
    const timeoutController = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await fs.mkdir(downloadRoot, { recursive: true })
      await persistDownloadMetadata(operation, 'downloading')
      timeout = setTimeout(() => {
        timeoutController.abort(new ZToolsError(errorCodes.networkError, t('update.downloadTimeout')))
      }, timeoutMs)
      const signal = AbortSignal.any([controller.signal, timeoutController.signal, requestSignal, this.#stopping.signal])
      const response = await this.#fetch(params.downloadUrl, { signal })
      if (!response.ok) throw new ZToolsError(errorCodes.networkError, t('update.downloadHttpFailed', { status: response.status }))
      const downloaded = await downloadResponseToFile(
        response,
        temporary,
        signal,
        type === 'web' || this.#platform === 'darwin' ? fileSize : 0,
        type === 'web' || this.#platform === 'darwin' ? MAX_UPDATE_BYTES : Number.MAX_SAFE_INTEGER,
        (downloadedBytes, totalBytes) => {
          this.#publishProgress({
            operationId,
            type,
            downloaded: downloadedBytes,
            total: totalBytes,
            percent: totalBytes > 0 ? Math.min(99, Math.floor(downloadedBytes * 100 / totalBytes)) : 0
          })
        }
      )
      if (expectedChecksum && downloaded.checksum !== expectedChecksum) {
        throw new ZToolsError(errorCodes.dataCorrupt, t('update.checksumFailed'))
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
      throw networkError(error, t('update.downloadFailed'))
    } finally {
      clearTimeout(timeout)
      // 同一 signal 覆盖响应头和正文；提前拒绝响应时也关闭底层连接。
      timeoutController.abort()
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
    this.#assertUpdateSupported(params)
    const previous = this.#installQueue
    const task = previous.then(() => this.#install(params, AbortSignal.any([signal, this.#stopping.signal])))
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
    return this.#installApp(params, signal)
  }

  async #resolveDownload(
    params: UpdatePackageParams,
    type: 'app' | 'web',
    version: string,
    checksum: string,
    signal: AbortSignal
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
      const result = await this.download(params, signal)
      download = this.#operations.get(result.operationId)
    }
    return download
  }

  async #installApp(params: UpdatePackageParams, signal: AbortSignal): Promise<{
    success: true
    operationId: string
    state: 'started'
    restartRequired: true
  }> {
    signal.throwIfAborted()
    if (this.#appHandoffStarted) throw new ZToolsError(errorCodes.invalidRequest, t('update.appHandoffInProgress'))
    const version = normalizeVersion(params.version, t('update.target.generic'))
    if (compareVersions(version, this.#appVersion) <= 0) {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.installVersionNotNewer'))
    }
    const requestedChecksum = params.checksum ? normalizeChecksum(params.checksum) : ''
    const download = await this.#resolveDownload(params, 'app', version, requestedChecksum, signal)
    if (!download) throw new ZToolsError(errorCodes.invalidRequest, t('update.noAppPackage'))
    if (!download.checksum || !(await isUsableDownload(download))) {
      await fs.rm(download.path, { force: true }).catch(() => undefined)
      await fs.rm(download.metadataPath, { force: true }).catch(() => undefined)
      this.#operations.delete(download.operationId)
      throw new ZToolsError(errorCodes.dataCorrupt, t('update.appPackageUnavailable'))
    }
    signal.throwIfAborted()
    if (this.#installing.has(download.operationId)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.appPackageInProgress'))
    }
    this.#installing.add(download.operationId)
    const maintenanceRoot = path.join(this.#runtimePaths.transactionRoot, 'Maintenance', randomUUID())
    const appHandoffWasStarted = this.#appHandoffStarted
    try {
      if (this.#platform === 'darwin' && this.#macUpdater) {
        await this.#macUpdater.prepare(download.path, version, signal)
        download.started = true
        download.state = 'started'
        this.#appHandoffStarted = true
        await persistDownloadMetadata(download, 'started').catch(error => console.warn('记录 macOS 更新交接状态失败', error))
        this.#macUpdater.requestRestart()
        return { success: true, operationId: download.operationId, state: 'started', restartRequired: true }
      }
      const canFallbackToDirectInstaller = path.extname(download.path).toLowerCase() === '.exe'
      const updaterPath = path.join(maintenanceRoot, 'ZToolsUpdater.exe')
      let useDirectInstallerFallback = false
      try {
        await fs.mkdir(maintenanceRoot, { recursive: true })
        await fs.copyFile(path.join(this.#runtimePaths.installRoot, 'ZToolsUpdater.exe'), updaterPath)
      } catch (stageError) {
        if (!canFallbackToDirectInstaller) throw stageError
        useDirectInstallerFallback = true
        console.warn('准备临时 ZToolsUpdater.exe 失败，回退为直接静默运行已校验安装包', stageError)
      }
      download.started = true
      download.state = 'started'
      this.#appHandoffStarted = true
      await persistDownloadMetadata(download, 'started').catch(() => undefined)
      const updaterLocaleArg = `--lang=${getResolvedLocale()}`
      const runDirectInstaller = () => this.#runUpdater(
        download.path,
        ['/S', `/D=${this.#runtimePaths.installRoot}`, '--updated', '--need-cleanup', updaterLocaleArg],
        path.dirname(download.path)
      )
      // Let the native updater resolve scope through the Unicode Win32 registry API.
      let exitCode: number
      if (useDirectInstallerFallback) {
        exitCode = await runDirectInstaller()
      } else {
        try {
          exitCode = await this.#runUpdater(updaterPath, [
            '--source=' + download.path,
            '--target=' + this.#runtimePaths.installRoot,
            '--updated',
            '--need-cleanup',
            updaterLocaleArg
          ], maintenanceRoot)
        } catch (launchError) {
          const errnoCode =
            launchError && typeof launchError === 'object' && 'code' in launchError
              ? (launchError as { code?: unknown }).code
              : undefined
          const blockedBySystemPolicy = errnoCode === 'EACCES' || errnoCode === 'EPERM'
          if (!canFallbackToDirectInstaller || !blockedBySystemPolicy) throw launchError
          console.warn('临时 ZToolsUpdater.exe 被系统执行策略拦截，回退为直接静默运行已校验安装包', launchError)
          exitCode = await runDirectInstaller()
        }
      }
      if (exitCode === UAC_CANCELLED_EXIT_CODE) {
        throw new ZToolsError(errorCodes.cancelled, t('update.uacCancelled'))
      }
      if (exitCode !== 0) {
        throw new ZToolsError(errorCodes.processError, t('update.updaterFailed', { exitCode }))
      }
    } catch (error) {
      download.started = false
      download.state = 'downloaded'
      this.#appHandoffStarted = appHandoffWasStarted
      await persistDownloadMetadata(download, 'downloaded').catch(() => undefined)
      if (error instanceof ZToolsError) throw error
      const detail = error instanceof Error ? error.message.slice(0, 256) : String(error)
      throw new ZToolsError(errorCodes.processError, t('update.prepareFailed', { detail }))
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
      throw new ZToolsError(errorCodes.notSupported, t('update.webResourceDisabled'))
    }
    if (this.#appHandoffStarted) {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.webBlockedByAppHandoff'))
    }
    const version = normalizeVersion(params.version, t('update.target.generic'))
    const requestedChecksum = normalizeChecksum(params.checksum)
    if (!requestedChecksum) {
      throw new ZToolsError(errorCodes.dataCorrupt, t('update.webMissingChecksum'))
    }
    if (params.minAppVersion !== undefined) {
      const minimum = normalizeVersion(params.minAppVersion, t('update.target.minHost', { target: t('update.target.web') }))
      if (compareVersions(this.#appVersion, minimum) < 0) {
        throw new ZToolsError(errorCodes.notSupported, t('update.appVersionTooLow'))
      }
    }
    const download = await this.#resolveDownload(params, 'web', version, requestedChecksum, signal)
    if (!download) throw new ZToolsError(errorCodes.invalidRequest, t('update.noWebPackage'))
    if (!download.checksum || !(await isUsableDownload(download))) {
      await fs.rm(download.path, { force: true }).catch(() => undefined)
      await fs.rm(download.metadataPath, { force: true }).catch(() => undefined)
      this.#operations.delete(download.operationId)
      throw new ZToolsError(errorCodes.dataCorrupt, t('update.webPackageCorrupt'))
    }
    signal.throwIfAborted()
    if (this.#installing.has(download.operationId)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('update.webPackageInProgress'))
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

  cancel(): { success: true; cancelled: string[]; installing: boolean } {
    const cancelled: string[] = []
    for (const [operationId, operation] of this.#operations) {
      if (operation.started || this.#installing.has(operationId)) continue
      operation.controller.abort(errorCodes.appStopping)
      void fs.rm(operation.path, { force: true })
      void fs.rm(operation.metadataPath, { force: true })
      this.#operations.delete(operationId)
      cancelled.push(operationId)
    }
    return { success: true, cancelled, installing: this.#installing.size > 0 || this.#appHandoffStarted }
  }

  async stop(): Promise<void> {
    this.#stopping.abort()
    this.cancel()
    await Promise.allSettled([...this.#activeDownloads])
    await this.#installQueue
  }

  /**
   * 清理已消费（state === 'started'）或版本不高于当前运行版本的更新安装包及残留临时目录。
   * 必须在主程序完成部署就绪握手（signalDeploymentReady）之后调用，遇到安装器进程尚未退出的文件锁时自动退避重试。
   */
  async cleanupConsumedDownloads(options: {
    needCleanup?: boolean | undefined
    retryDelaysMs?: readonly number[] | undefined
  } = {}): Promise<void> {
    if (this.#platform !== 'win32' && this.#platform !== 'darwin') return
    try {
      const downloadRoot = path.join(this.#runtimePaths.transactionRoot, 'Downloads')
      const entries = await fs.readdir(downloadRoot, { withFileTypes: true }).catch(() => undefined)
      const activePaths = new Set<string>()
      for (const operation of this.#operations.values()) {
        if (operation.state === 'downloading' || this.#installing.has(operation.operationId)) {
          activePaths.add(path.resolve(operation.path))
          activePaths.add(path.resolve(operation.metadataPath))
        }
      }

      const retainedPackagePaths = new Set<string>()
      if (entries) {
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          const metadataPath = path.resolve(downloadRoot, entry.name)
          if (activePaths.has(metadataPath)) continue

          let metadata: Partial<DownloadMetadata> | undefined
          try {
            metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Partial<DownloadMetadata>
          } catch {
            await removePathWithRetry(metadataPath, { retryDelaysMs: options.retryDelaysMs })
            continue
          }

          const rawTargetPath = typeof metadata.path === 'string' && isDirectDownloadPath(downloadRoot, metadata.path)
            ? path.resolve(metadata.path)
            : path.resolve(downloadRoot, entry.name.slice(0, -'.json'.length))

          const currentBaseline = metadata.type === 'web' ? this.#webVersion : this.#appVersion
          const versionOutdated = typeof metadata.version === 'string' &&
            PRODUCT_VERSION_PATTERN.test(metadata.version) &&
            compareVersions(metadata.version, currentBaseline) <= 0
          const consumedOrStale =
            metadata.state === 'started' ||
            versionOutdated ||
            (options.needCleanup === true && metadata.state === 'downloading')

          if (!consumedOrStale) {
            retainedPackagePaths.add(rawTargetPath)
            continue
          }

          if (typeof metadata.operationId === 'string' && !this.#installing.has(metadata.operationId)) {
            this.#operations.delete(metadata.operationId)
          }
          if (!activePaths.has(rawTargetPath)) {
            await removePathWithRetry(rawTargetPath, { retryDelaysMs: options.retryDelaysMs })
            await removePathWithRetry(rawTargetPath + '.tmp', { retryDelaysMs: options.retryDelaysMs })
          }
          await removePathWithRetry(metadataPath, { retryDelaysMs: options.retryDelaysMs })
          await removePathWithRetry(metadataPath + '.tmp', { retryDelaysMs: options.retryDelaysMs })
        }

        if (options.needCleanup === true) {
          const remaining = await fs.readdir(downloadRoot, { withFileTypes: true }).catch(() => undefined)
          if (remaining) {
            for (const entry of remaining) {
              if (!entry.isFile() || entry.name.endsWith('.json')) continue
              const candidatePath = path.resolve(downloadRoot, entry.name)
              if (activePaths.has(candidatePath) || retainedPackagePaths.has(candidatePath)) continue
              const lowerName = entry.name.toLowerCase()
              if (
                lowerName.endsWith('.tmp') ||
                lowerName.endsWith('.part') ||
                (lowerName.startsWith('app-') && (lowerName.endsWith('.exe') || lowerName.endsWith('.dmg'))) ||
                ((lowerName.startsWith('app-') || lowerName.startsWith('web-')) && lowerName.endsWith('.zip'))
              ) {
                await removePathWithRetry(candidatePath, { retryDelaysMs: options.retryDelaysMs })
              }
            }
          }
        }
      }

      if (this.#installing.size === 0 && !this.#appHandoffStarted) {
        const maintenanceRoot = path.join(this.#runtimePaths.transactionRoot, 'Maintenance')
        const maintenanceEntries = await fs.readdir(maintenanceRoot, { withFileTypes: true }).catch(() => undefined)
        if (maintenanceEntries) {
          for (const entry of maintenanceEntries) {
            const entryPath = path.join(maintenanceRoot, entry.name)
            await removePathWithRetry(entryPath, {
              recursive: entry.isDirectory(),
              retryDelaysMs: options.retryDelaysMs
            })
          }
        }
      }
    } catch (error) {
      console.warn('清理已消费更新安装包失败:', error)
    }
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
