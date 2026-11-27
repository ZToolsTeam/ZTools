import crypto, { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type CommonLibCleanRequest,
  type CommonLibCleanResult,
  type CommonLibInventoryItem,
  type CommonLibListResult,
  type CommonLibToolStatus,
  type ToolPlatformArchKey,
  type ToolProvisionStage
} from '../../../contracts/tool-runtime/common.js'
import {
  normalizePlatformName,
  resolveRuntimeArchitecture
} from '../../platform/runtime-architecture.js'
import {
  assertCommonLibNoRollback,
  assertCommonLibNotRevoked,
  compareSemVer,
  isSafeCommonLibRelativePath,
  loadCommonLibsTrustBundle,
  verifyAndParseCommonLibsCatalog,
  type CommonLibCatalogToolEntry,
  type CommonLibPlatformPackage,
  type CommonLibsTrustBundle
} from './commonlibs-trust.js'
import { createToolRuntimeError, formatErrorMessage, isPlainObject } from './errors.js'
import type { GuardedProcessRunner } from './guarded-process.js'
import type { ToolTaskProgressPayload } from './task-manager.js'

/**
 * 第三方公共引擎工具池生命周期管理器（`<DataRoot>/CommonLibs/`）。
 * 核心安全与架构边界：
 * - 物理目录与既有 `<DataRoot>/Libraries/` 完全隔离，绝不读写或触碰后者；
 * - 仅在能力被调用或显式 ensure 时按需拉取，启动期零下载；
 * - 下载期流式校验 archiveSha256、禁止 ZIP symlink 与路径穿越、逐文件核验 size + sha256；
 * - 执行前 100% 离线验签（读取落盘元数据+签名基于内置公钥校验，不联网），并逐级防 symlink 替换；
 * - 双维度引用追踪（静态清单 + 动态租约）+ 30 天宽限期静默 GC + 用户手动安全清理。
 */

export const COMMONLIBS_DIR_NAME = 'CommonLibs'
export const COMMONLIB_TRUST_JSON_FILE = '.ztools-commonlib-trust.json'
export const COMMONLIB_TRUST_SIG_FILE = '.ztools-commonlib-trust.sig'
const COMMONLIBS_STATE_FILE = '.commonlibs-state.json'
const DEFAULT_CATALOG_BASE_URL = 'https://cdn.ztools.cn/commonlibs-v2'
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = Object.freeze(['https://cdn.ztools.cn'])
const DEFAULT_GRACE_PERIOD_MS = 30 * 24 * 3600 * 1000
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
const MAX_ZIP_ENTRIES = 4_096
const TOOL_ID_SEGMENT_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/
const DOWNLOAD_TIMEOUT_MS = 600_000
const CATALOG_TIMEOUT_MS = 20_000
const DEFAULT_MAX_DOWNLOAD_RETRIES = 2
const MAX_ALLOWED_DOWNLOAD_RETRIES = 5
const DEFAULT_RETRY_BASE_DELAY_MS = 400

export interface CommonLibDownloadProgress {
  readonly toolId: string
  readonly stage: ToolProvisionStage
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly percent?: number
  readonly attempt?: number
  readonly maxAttempts?: number
}

/** 将 CommonLibs 下载/验签/重试进度转换为统一的 ToolTaskProgressPayload */
export function toCommonLibProvisionProgressPayload(
  progress: CommonLibDownloadProgress
): ToolTaskProgressPayload {
  const clampedPercent =
    progress.percent !== undefined ? Math.min(99, Math.max(0, progress.percent)) : undefined
  const attemptSuffix =
    progress.stage === 'retrying' &&
    progress.attempt !== undefined &&
    progress.maxAttempts !== undefined
      ? `(${progress.attempt}/${progress.maxAttempts})`
      : ''
  return {
    phase: 'provisioning',
    stage: progress.stage,
    ...(clampedPercent !== undefined ? { percent: clampedPercent } : {}),
    ...(progress.transferredBytes !== undefined ? { transferredBytes: progress.transferredBytes } : {}),
    ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
    message: `${progress.toolId}:${progress.stage}${attemptSuffix}`
  }
}

export interface CommonLibsExecutableProvider {
  isToolReadyOffline(toolId: string, relativeExecPath?: string): Promise<boolean>
  ensureTool(
    toolId: string,
    signal?: AbortSignal,
    onProgress?: CommonLibDownloadProgressListener
  ): Promise<string>
  resolveExecutable(toolId: string, relativeExecPath: string): Promise<ResolvedCommonLibExecutable>
  invalidateToolCache?(toolId: string): void
}

/** 按需确保指定工具可执行文件已就绪并推送标准 provisioning 进度（兼容任意最小 CommonLibs 替身） */
export async function ensureCommonLibExecutable(
  commonLibs: CommonLibsExecutableProvider,
  toolId: string,
  relativeExecPath: string,
  signal?: AbortSignal,
  onProgress?: (payload: ToolTaskProgressPayload) => void
): Promise<{ readonly status: 'ready'; readonly provisioned: boolean }> {
  if (await commonLibs.isToolReadyOffline(toolId, relativeExecPath)) {
    return { status: 'ready', provisioned: false }
  }
  onProgress?.({ phase: 'provisioning', stage: 'fetching-catalog', percent: 0 })
  await commonLibs.ensureTool(toolId, signal, (progress) => {
    onProgress?.(toCommonLibProvisionProgressPayload(progress))
  })
  await commonLibs.resolveExecutable(toolId, relativeExecPath)
  return { status: 'ready', provisioned: true }
}

/**
 * 执行期二进制缺失/损坏受控单次自愈：
 * 仅当首次执行抛出 TOOL_BINARY_UNAVAILABLE、未取消且磁盘离线验签确实失效时，自动重装一次并重试执行，杜绝无限循环。
 */
export async function runWithCommonLibBinaryRecovery<T>(
  commonLibs: CommonLibsExecutableProvider,
  options: {
    readonly toolId: string
    readonly relativeExecPath: string
    readonly primitiveId: string
    readonly signal: AbortSignal
    readonly onProgress?: (payload: ToolTaskProgressPayload) => void
  },
  executor: (resolved: ResolvedCommonLibExecutable) => Promise<T>
): Promise<T> {
  let resolved = await commonLibs.resolveExecutable(options.toolId, options.relativeExecPath)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await executor(resolved)
    } catch (error) {
      const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
      if (
        attempt === 0 &&
        hostCode === TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable &&
        !options.signal.aborted
      ) {
        commonLibs.invalidateToolCache?.(options.toolId)
        const stillValid = await commonLibs.isToolReadyOffline(options.toolId, options.relativeExecPath)
        if (!stillValid) {
          await ensureCommonLibExecutable(
            commonLibs,
            options.toolId,
            options.relativeExecPath,
            options.signal,
            options.onProgress
          )
          resolved = await commonLibs.resolveExecutable(options.toolId, options.relativeExecPath)
          continue
        }
      }
      throw error
    }
  }
  throw createToolRuntimeError(
    TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable,
    `Engine executable "${options.relativeExecPath}" remained unavailable after recovery`,
    {
      primitiveId: options.primitiveId,
      stage: 'executing',
      retryable: true,
      userAction: 'reinstall_tool'
    }
  )
}

export type CommonLibDownloadProgressListener = (progress: CommonLibDownloadProgress) => void

export type CommonLibAnalyticsEventName =
  | 'commonlib_download_start'
  | 'commonlib_download_success'
  | 'commonlib_verify_failed'
  | 'commonlib_install_failed'

/** 埋点上报载荷严格脱敏，严禁包含任何本地路径或用户敏感信息 */
export interface CommonLibAnalyticsPayload {
  readonly toolId: string
  readonly version: string
  readonly platform: string
  readonly arch: string
  readonly errorCode?: string
  readonly durationMs?: number
}

export interface CommonLibStaticReferenceInfo {
  readonly capabilities: ReadonlySet<string>
  readonly plugins: ReadonlySet<string>
}

export type CommonLibStaticReferenceMap = ReadonlyMap<string, CommonLibStaticReferenceInfo>

export interface CommonLibsCatalogSource {
  fetchCatalog(signal?: AbortSignal): Promise<{ readonly rawBytes: Buffer; readonly signatureText: string }>
}

export interface CommonLibsManagerOptions {
  /** 业务数据根目录（CommonLibs 固定创建于 `<dataRoot>/CommonLibs`） */
  readonly dataRoot: string
  /** 包含 commonlibs-public-keys.json / commonlibs-revocations.json 的资源目录 */
  readonly resourcesDir?: string
  /** 可直接注入信任包（供测试自定义密钥与撤销表） */
  readonly trustBundle?: CommonLibsTrustBundle
  readonly platform?: NodeJS.Platform
  readonly processArch?: string
  readonly runningUnderARM64Translation?: boolean | null
  readonly processorArchitecture?: string | undefined
  readonly processorArchitew6432?: string | undefined
  /** 允许的下载源白名单（默认仅 https://cdn.ztools.cn） */
  readonly allowedOrigins?: readonly string[]
  /** 远端 catalog.json URL（缺省基于默认白名单源拼接） */
  readonly catalogUrl?: string
  /** 远端 catalog.sig URL（缺省为 `${catalogUrl}.sig` 或同目录 `catalog.sig`） */
  readonly catalogSigUrl?: string
  /** 备用镜像基址列表（须全部位于 allowedOrigins 白名单内，主源不可用时按序回退） */
  readonly fallbackCatalogBaseUrls?: readonly string[]
  /** 瞬时网络错误或 5xx 时的最大重试次数（默认 2，总计最多尝试 3 次） */
  readonly maxDownloadRetries?: number
  /** 指数退避初始延迟毫秒数（默认 400ms） */
  readonly retryBaseDelayMs?: number
  /** 可选自定义 catalog 来源（优先于 HTTP 拉取，适合离线测试与受控分发） */
  readonly catalogSource?: CommonLibsCatalogSource
  /** 可注入 fetch 实现 */
  readonly fetchImpl?: typeof fetch
  /** 用于在 macOS 下标记 Time Machine 排除的受控进程执行器 */
  readonly processRunner?: GuardedProcessRunner
  /** 可注入 macOS Time Machine 排除钩子（供测试断言调用） */
  readonly excludeFromBackupImpl?: (dirPath: string) => Promise<void>
  /** 埋点回调（载荷严禁含本地路径） */
  readonly onAnalyticsEvent?: (event: CommonLibAnalyticsEventName, payload: CommonLibAnalyticsPayload) => void
  readonly now?: () => number
}

export interface ResolvedCommonLibExecutable {
  readonly toolId: string
  readonly toolName: string
  readonly version: string
  readonly platformArch: ToolPlatformArchKey
  readonly toolDir: string
  readonly executablePath: string
  readonly relativeExecPath: string
}

export interface ResolvedCommonLibDirectory {
  readonly toolId: string
  readonly toolName: string
  readonly version: string
  readonly platformArch: ToolPlatformArchKey
  readonly toolDir: string
  readonly executables: readonly string[]
}

export interface CommonLibsGcOptions {
  readonly now?: number
  readonly gracePeriodMs?: number
  readonly forceRevoked?: boolean
}

interface PersistedToolStateEntry {
  toolName: string
  version: string
  platformArch: ToolPlatformArchKey
  sizeBytes: number
  installedAt: string
  unreferencedSince?: string
}

interface PersistedCommonLibsState {
  schemaVersion: 1
  highWaterVersions: Record<string, string>
  tools: Record<string, PersistedToolStateEntry>
}

interface CachedFileHash {
  readonly size: number
  readonly mtimeMs: number
  readonly ino: number
  readonly sha256: string
}

/** 根据原生操作系统架构解析本机目标平台架构键（妥善处理 Rosetta 2） */
export function resolveCommonLibPlatformArch(input: {
  readonly platform: NodeJS.Platform | string
  readonly processArch: string
  readonly runningUnderARM64Translation: boolean | null
  readonly processorArchitecture?: string | undefined
  readonly processorArchitew6432?: string | undefined
}): ToolPlatformArchKey | null {
  if (input.platform === 'win32') {
    return 'win32-x64'
  }
  if (input.platform === 'darwin') {
    const info = resolveRuntimeArchitecture({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderARM64Translation: input.runningUnderARM64Translation,
      processorArchitecture: input.processorArchitecture,
      processorArchitew6432: input.processorArchitew6432
    })
    if (info.nativeOsArch === 'arm64') return 'darwin-arm64'
    if (info.nativeOsArch === 'x64') return 'darwin-x64'
    return input.processArch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  return null
}

function isRetryableLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

function isZipEntrySymlink(entry: Entry): boolean {
  // Unix 文件类型位于 externalFileAttributes 高 16 位的 0o170000 掩码，0o120000 表示符号链接
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
  return unixMode === 0o120000
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function computeDirectorySize(dirPath: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dirPath, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      total += await computeDirectorySize(target)
    } else if (entry.isFile()) {
      try {
        const stat = await fs.lstat(target)
        total += stat.size
      } catch {
        // 忽略并发消失的文件
      }
    }
  }
  return total
}

function extractVersionFromToolId(toolId: string): string {
  const idx = toolId.lastIndexOf('-')
  return idx > 0 ? toolId.slice(idx + 1) : 'unknown'
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
  return hostCode === TOOL_RUNTIME_ERROR_CODES.taskCancelled
}

function isRetryableProvisionError(error: unknown, signal?: AbortSignal): boolean {
  if (isAbortLikeError(error, signal)) return false
  const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
  if (hostCode) {
    if (hostCode !== TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed) {
      return false
    }
    const retryable = (error as { details?: { public?: { retryable?: unknown } } } | null)?.details?.public
      ?.retryable
    return retryable !== false
  }
  return true
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.taskCancelled, 'CommonLibs download was cancelled')
    )
  }
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(
        createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.taskCancelled, 'CommonLibs download was cancelled')
      )
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class CommonLibsManager {
  readonly #commonLibsRoot: string
  readonly #platform: NodeJS.Platform
  readonly #processArch: string
  readonly #platformArch: ToolPlatformArchKey | null
  readonly #trustBundle: CommonLibsTrustBundle
  readonly #allowedOrigins: readonly string[]
  readonly #catalogUrl: string
  readonly #catalogSigUrl: string
  readonly #fallbackCatalogBaseUrls: readonly string[]
  readonly #maxDownloadRetries: number
  readonly #retryBaseDelayMs: number
  readonly #catalogSource?: CommonLibsCatalogSource
  readonly #fetchImpl: typeof fetch
  readonly #processRunner?: GuardedProcessRunner
  readonly #excludeFromBackupImpl?: (dirPath: string) => Promise<void>
  readonly #onAnalyticsEvent?: (event: CommonLibAnalyticsEventName, payload: CommonLibAnalyticsPayload) => void
  readonly #now: () => number

  readonly #inFlightInstalls = new Map<
    string,
    { readonly promise: Promise<string>; readonly controller: AbortController; waiters: number }
  >()
  readonly #inFlightProgressListeners = new Map<string, Set<CommonLibDownloadProgressListener>>()
  readonly #hashCache = new Map<string, CachedFileHash>()
  readonly #dynamicLeases = new Map<string, Set<string>>()
  readonly #activeProcessCounts = new Map<string, number>()
  #backupExclusionApplied = false

  constructor(options: CommonLibsManagerOptions) {
    // 严格落盘至 <DataRoot>/CommonLibs，绝不接触 <DataRoot>/Libraries
    this.#commonLibsRoot = path.resolve(options.dataRoot, COMMONLIBS_DIR_NAME)
    this.#platform = options.platform ?? process.platform
    this.#processArch = options.processArch ?? process.arch
    this.#platformArch = resolveCommonLibPlatformArch({
      platform: this.#platform,
      processArch: this.#processArch,
      runningUnderARM64Translation: options.runningUnderARM64Translation ?? null,
      processorArchitecture: options.processorArchitecture,
      processorArchitew6432: options.processorArchitew6432
    })
    this.#trustBundle = options.trustBundle ?? loadCommonLibsTrustBundle(options.resourcesDir)
    this.#allowedOrigins = Object.freeze(
      (options.allowedOrigins && options.allowedOrigins.length > 0
        ? options.allowedOrigins
        : DEFAULT_ALLOWED_ORIGINS
      ).map((origin) => this.#normalizeOrigin(origin))
    )
    this.#catalogUrl = options.catalogUrl ?? `${DEFAULT_CATALOG_BASE_URL}/catalog.json`
    this.#catalogSigUrl = options.catalogSigUrl ?? `${DEFAULT_CATALOG_BASE_URL}/catalog.sig`
    this.#fallbackCatalogBaseUrls = Object.freeze(
      (options.fallbackCatalogBaseUrls ?? [])
        .map((item) => item.trim().replace(/\/+$/, ''))
        .filter((item) => item.length > 0)
    )
    const rawRetries = options.maxDownloadRetries ?? DEFAULT_MAX_DOWNLOAD_RETRIES
    this.#maxDownloadRetries = Number.isInteger(rawRetries)
      ? Math.max(0, Math.min(MAX_ALLOWED_DOWNLOAD_RETRIES, rawRetries))
      : DEFAULT_MAX_DOWNLOAD_RETRIES
    const rawBaseDelay = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    this.#retryBaseDelayMs = Number.isFinite(rawBaseDelay) && rawBaseDelay >= 0
      ? Math.min(30_000, rawBaseDelay)
      : DEFAULT_RETRY_BASE_DELAY_MS
    if (options.catalogSource) this.#catalogSource = options.catalogSource
    this.#fetchImpl = options.fetchImpl ?? fetch
    if (options.processRunner) this.#processRunner = options.processRunner
    if (options.excludeFromBackupImpl) this.#excludeFromBackupImpl = options.excludeFromBackupImpl
    if (options.onAnalyticsEvent) this.#onAnalyticsEvent = options.onAnalyticsEvent
    this.#now = options.now ?? Date.now
  }

  get rootDir(): string {
    return this.#commonLibsRoot
  }

  get platformArch(): ToolPlatformArchKey | null {
    return this.#platformArch
  }

  get trustBundle(): CommonLibsTrustBundle {
    return this.#trustBundle
  }

  /** 记录插件对指定工具的动态运行租约 */
  recordLease(toolId: string, pluginId: string): void {
    if (!TOOL_ID_SEGMENT_REGEX.test(toolId) || !pluginId) return
    const normalizedPlugin = pluginId.trim()
    if (!normalizedPlugin) return
    const set = this.#dynamicLeases.get(toolId) ?? new Set<string>()
    set.add(normalizedPlugin)
    this.#dynamicLeases.set(toolId, set)
  }

  /** 卸载或停用插件时清理其持有的全部动态工具租约 */
  clearPluginLeases(pluginId: string): void {
    const target = pluginId.trim()
    if (!target) return
    for (const [toolId, plugins] of this.#dynamicLeases.entries()) {
      plugins.delete(target)
      if (plugins.size === 0) {
        this.#dynamicLeases.delete(toolId)
      }
    }
  }

  /** 标记工具正在被子进程使用（执行期间禁止 GC 或手动清理误删） */
  acquireActiveProcess(toolId: string): () => void {
    this.#activeProcessCounts.set(toolId, (this.#activeProcessCounts.get(toolId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = (this.#activeProcessCounts.get(toolId) ?? 1) - 1
      if (next > 0) this.#activeProcessCounts.set(toolId, next)
      else this.#activeProcessCounts.delete(toolId)
    }
  }

  /** 主动失效指定工具的内存哈希缓存（用于执行期异常后强制重做完整磁盘校验） */
  invalidateToolCache(toolId: string): void {
    if (!TOOL_ID_SEGMENT_REGEX.test(toolId)) return
    this.#invalidateHashCacheForPrefix(path.join(this.#commonLibsRoot, toolId))
  }

  /** 判断某工具在本地是否已安装且通过完全离线校验 */
  async isToolReadyOffline(toolId: string, relativeExecPath?: string): Promise<boolean> {
    if (!this.#platformArch || !TOOL_ID_SEGMENT_REGEX.test(toolId)) return false
    try {
      const inspected = await this.#verifyInstalledToolOffline(toolId)
      if (relativeExecPath && !inspected.pkg.executables.includes(relativeExecPath)) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 懒加载按需拉取工具包：
   * - 若本地已存在且离线验签完整未撤销，直接返回工具目录（零网络请求）；
   * - 否则下载受签 catalog -> 验签 -> 防回滚/撤销检查 -> 白名单源下载 ZIP -> 校验 archiveSha256 -> 安全解压 -> 逐文件校验 -> POSIX chmod -> 落盘信任元数据+签名 -> 原子重命名。
   */
  async ensureTool(
    toolId: string,
    signal?: AbortSignal,
    onProgress?: CommonLibDownloadProgressListener
  ): Promise<string> {
    if (!TOOL_ID_SEGMENT_REGEX.test(toolId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        `Invalid CommonLibs toolId: ${toolId}`
      )
    }
    if (!this.#platformArch) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
        `CommonLibs is not supported on platform ${this.#platform}`
      )
    }
    assertCommonLibNotRevoked({ toolId }, this.#trustBundle.revocations)

    if (await this.isToolReadyOffline(toolId)) {
      return path.join(this.#commonLibsRoot, toolId)
    }

    if (signal?.aborted) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskCancelled,
        'CommonLibs tool installation was cancelled'
      )
    }

    let listeners = this.#inFlightProgressListeners.get(toolId)
    if (!listeners) {
      listeners = new Set<CommonLibDownloadProgressListener>()
      this.#inFlightProgressListeners.set(toolId, listeners)
    }
    if (onProgress) {
      listeners.add(onProgress)
    }

    let flight = this.#inFlightInstalls.get(toolId)
    if (!flight) {
      const controller = new AbortController()
      const promise = this.#downloadAndInstallTool(toolId, controller.signal).finally(() => {
        if (this.#inFlightInstalls.get(toolId)?.promise === promise) {
          this.#inFlightInstalls.delete(toolId)
          this.#inFlightProgressListeners.delete(toolId)
        }
      })
      flight = { promise, controller, waiters: 0 }
      this.#inFlightInstalls.set(toolId, flight)
    }

    flight.waiters += 1
    let released = false
    const releaseWaiter = (abortedByCaller: boolean): void => {
      if (released) return
      released = true
      if (onProgress) {
        listeners?.delete(onProgress)
      }
      flight!.waiters = Math.max(0, flight!.waiters - 1)
      // 仅当全部并发等待者均取消时才中止底层共享下载，防止单个调用方取消误杀其他正常等待任务
      if (abortedByCaller && flight!.waiters === 0) {
        flight!.controller.abort(TOOL_RUNTIME_ERROR_CODES.taskCancelled)
      }
    }

    if (!signal) {
      try {
        return await flight.promise
      } finally {
        releaseWaiter(false)
      }
    }

    return await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        releaseWaiter(true)
        reject(
          createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.taskCancelled,
            'CommonLibs tool installation was cancelled'
          )
        )
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      flight!.promise.then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          releaseWaiter(false)
          resolve(result)
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          releaseWaiter(false)
          reject(err)
        }
      )
    })
  }

  /**
   * 离线执行前安全校验：
   * - 严禁联网；
   * - 校验撤销表 -> 逐级防 symlink / reparse point -> 读取本地落盘元数据+签名基于内置公钥执行离线验签 -> 逐文件校验 size + sha256（会话内按 size+mtimeMs+ino 缓存）。
   */
  async resolveExecutable(toolId: string, relativeExecPath: string): Promise<ResolvedCommonLibExecutable> {
    if (!TOOL_ID_SEGMENT_REGEX.test(toolId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        `Invalid CommonLibs toolId: ${toolId}`
      )
    }
    if (!isSafeCommonLibRelativePath(relativeExecPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        `Unsafe relative executable path: ${relativeExecPath}`
      )
    }
    if (!this.#platformArch) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
        `CommonLibs is not supported on platform ${this.#platform}`
      )
    }

    const verified = await this.#verifyInstalledToolOffline(toolId)
    if (!verified.pkg.executables.includes(relativeExecPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Executable "${relativeExecPath}" is not declared in signed CommonLibs trust metadata for ${toolId}`
      )
    }
    const executablePath = await this.#assertNoSymlinkChain(verified.toolDir, relativeExecPath)
    return {
      toolId: verified.entry.toolId,
      toolName: verified.entry.toolName,
      version: verified.entry.version,
      platformArch: verified.platformArch,
      toolDir: verified.toolDir,
      executablePath,
      relativeExecPath
    }
  }

  /**
   * 面向普通权限官方已签名原生插件的按需拉取与离线验签目录解析：
   * - 按需下载落盘（本地就绪时零联网）后强制执行离线签名、撤销与防 symlink 链校验；
   * - 返回只读工具根目录及已签 executables 列表，供宿主注入给普通权限官方签名 DLL（特权插件严禁使用）。
   */
  async ensureAndVerifyToolDir(
    toolId: string,
    signal?: AbortSignal,
    onProgress?: CommonLibDownloadProgressListener
  ): Promise<ResolvedCommonLibDirectory> {
    await this.ensureTool(toolId, signal, onProgress)
    const verified = await this.#verifyInstalledToolOffline(toolId)
    return {
      toolId: verified.entry.toolId,
      toolName: verified.entry.toolName,
      version: verified.entry.version,
      platformArch: verified.platformArch,
      toolDir: verified.toolDir,
      executables: [...verified.pkg.executables]
    }
  }

  /** 枚举本地 CommonLibs 资产清单及引用关系 */
  async listInventory(staticReferences: CommonLibStaticReferenceMap): Promise<CommonLibListResult> {
    const state = await this.#readState()
    const installedDirNames = await this.#scanInstalledToolDirs()
    const items: CommonLibInventoryItem[] = []
    let totalSizeBytes = 0

    for (const toolId of installedDirNames) {
      const toolDir = path.join(this.#commonLibsRoot, toolId)
      const persisted = state.tools[toolId]
      const staticRef = staticReferences.get(toolId)
      const dynamicPlugins = this.#dynamicLeases.get(toolId)
      const referencedByCapabilities = Array.from(staticRef?.capabilities ?? []).sort()
      const referencedByPlugins = Array.from(
        new Set([...(staticRef?.plugins ?? []), ...(dynamicPlugins ?? [])])
      ).sort()
      const activeProcesses = this.#activeProcessCounts.get(toolId) ?? 0
      const isReferenced = referencedByPlugins.length > 0 || referencedByCapabilities.length > 0

      let status: CommonLibToolStatus = 'ready'
      let revokedReason: string | undefined
      let toolName = persisted?.toolName ?? toolId.slice(0, Math.max(0, toolId.lastIndexOf('-')))
      let version = persisted?.version ?? extractVersionFromToolId(toolId)
      let platformArch: ToolPlatformArchKey =
        persisted?.platformArch ?? this.#platformArch ?? 'win32-x64'

      if (this.#trustBundle.revocations.revokedToolIds.includes(toolId)) {
        status = 'revoked'
        revokedReason = 'Tool ID is listed in the official revocation list'
      } else {
        try {
          const verified = await this.#verifyInstalledToolOffline(toolId)
          toolName = verified.entry.toolName
          version = verified.entry.version
          platformArch = verified.platformArch
          status = isReferenced ? 'ready' : 'unreferenced'
        } catch (error) {
          const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
          if (hostCode === TOOL_RUNTIME_ERROR_CODES.toolRevoked) {
            status = 'revoked'
            revokedReason = formatErrorMessage(error)
          } else {
            status = 'corrupted'
          }
        }
      }

      const sizeBytes = persisted?.sizeBytes ?? (await computeDirectorySize(toolDir))
      totalSizeBytes += sizeBytes
      const canManualClean =
        activeProcesses === 0 && (status === 'revoked' || status === 'corrupted' || !isReferenced)

      items.push({
        toolId,
        toolName: toolName || toolId,
        version,
        platformArch,
        sizeBytes,
        installedAt: persisted?.installedAt ?? new Date(0).toISOString(),
        status,
        referencedByCapabilities,
        referencedByPlugins,
        ...(persisted?.unreferencedSince ? { unreferencedSince: persisted.unreferencedSince } : {}),
        canManualClean,
        ...(revokedReason ? { revokedReason } : {})
      })
    }

    items.sort((a, b) => a.toolId.localeCompare(b.toolId))
    return { items, totalSizeBytes }
  }

  /**
   * 执行后台静默 GC：
   * - 命中撤销且 forceRevoked === true 时，若无活跃进程则跳过 30 天宽限期直接回收；
   * - 满足「无静态引用 + 无动态租约 + 无活跃进程」时标记 unreferencedSince，满 gracePeriodMs 后回收；
   * - 恢复被引用时自动清除 unreferencedSince；
   * - 删除动作先原子移入 .trash-<uuid> 再删，遇占锁静默跳过下次重试。
   */
  async runGc(
    staticReferences: CommonLibStaticReferenceMap,
    options: CommonLibsGcOptions = {}
  ): Promise<CommonLibCleanResult> {
    const nowMs = options.now ?? this.#now()
    const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
    const forceRevoked = options.forceRevoked ?? true

    await this.#sweepLeftoverTempDirs(nowMs)

    const state = await this.#readState()
    const installedDirNames = await this.#scanInstalledToolDirs()
    const removedToolIds: string[] = []
    const skippedToolIds: string[] = []
    let reclaimedBytes = 0
    let stateMutated = false

    for (const toolId of installedDirNames) {
      const toolDir = path.join(this.#commonLibsRoot, toolId)
      const activeProcesses = this.#activeProcessCounts.get(toolId) ?? 0
      const staticRef = staticReferences.get(toolId)
      const dynamicPlugins = this.#dynamicLeases.get(toolId)
      const hasStatic = Boolean(
        staticRef && (staticRef.capabilities.size > 0 || staticRef.plugins.size > 0)
      )
      const hasDynamic = Boolean(dynamicPlugins && dynamicPlugins.size > 0)
      const isRevoked = await this.#isToolRevokedOffline(toolId)

      if (isRevoked && forceRevoked) {
        if (activeProcesses > 0) {
          skippedToolIds.push(toolId)
          continue
        }
        const bytes = await this.#safeTrashAndDelete(toolDir, toolId)
        if (bytes !== null) {
          removedToolIds.push(toolId)
          reclaimedBytes += bytes
          delete state.tools[toolId]
          this.#invalidateHashCacheForPrefix(toolDir)
          stateMutated = true
        } else {
          skippedToolIds.push(toolId)
        }
        continue
      }

      if (hasStatic || hasDynamic || activeProcesses > 0) {
        const entry = state.tools[toolId]
        if (entry?.unreferencedSince) {
          delete entry.unreferencedSince
          stateMutated = true
        }
        continue
      }

      // 满足「无静态引用 + 无动态租约 + 无活跃进程」
      let entry = state.tools[toolId]
      if (!entry) {
        entry = {
          toolName: toolId.slice(0, Math.max(0, toolId.lastIndexOf('-'))) || toolId,
          version: extractVersionFromToolId(toolId),
          platformArch: this.#platformArch ?? 'win32-x64',
          sizeBytes: await computeDirectorySize(toolDir),
          installedAt: new Date(nowMs).toISOString()
        }
        state.tools[toolId] = entry
        stateMutated = true
      }

      if (!entry.unreferencedSince) {
        entry.unreferencedSince = new Date(nowMs).toISOString()
        stateMutated = true
        continue
      }

      const markedMs = Date.parse(entry.unreferencedSince)
      if (!Number.isFinite(markedMs) || nowMs - markedMs >= gracePeriodMs) {
        const bytes = await this.#safeTrashAndDelete(toolDir, toolId)
        if (bytes !== null) {
          removedToolIds.push(toolId)
          reclaimedBytes += bytes
          delete state.tools[toolId]
          this.#invalidateHashCacheForPrefix(toolDir)
          stateMutated = true
        } else {
          skippedToolIds.push(toolId)
        }
      }
    }

    if (stateMutated) {
      await this.#writeState(state)
    }

    return {
      removedToolIds,
      skippedToolIds,
      reclaimedBytes
    }
  }

  /**
   * 用户手动立即清理：
   * - 仅允许删除「无插件引用且无活跃进程」「已撤销且无活跃进程」或「已损坏且无活跃进程」的工具；
   * - 仍在被正常引用的版本放入 skippedToolIds 绝不误删。
   */
  async cleanManual(
    request: CommonLibCleanRequest,
    staticReferences: CommonLibStaticReferenceMap
  ): Promise<CommonLibCleanResult> {
    if (request.runGc === true && !request.toolId) {
      return this.runGc(staticReferences)
    }

    const inventory = await this.listInventory(staticReferences)
    const state = await this.#readState()
    const targets = request.toolId
      ? inventory.items.filter((item) => item.toolId === request.toolId)
      : inventory.items

    const removedToolIds: string[] = []
    const skippedToolIds: string[] = []
    let reclaimedBytes = 0
    let stateMutated = false

    for (const item of targets) {
      if (!item.canManualClean) {
        skippedToolIds.push(item.toolId)
        continue
      }
      const toolDir = path.join(this.#commonLibsRoot, item.toolId)
      const bytes = await this.#safeTrashAndDelete(toolDir, item.toolId)
      if (bytes !== null) {
        removedToolIds.push(item.toolId)
        reclaimedBytes += bytes
        delete state.tools[item.toolId]
        this.#invalidateHashCacheForPrefix(toolDir)
        stateMutated = true
      } else {
        skippedToolIds.push(item.toolId)
      }
    }

    if (stateMutated) {
      await this.#writeState(state)
    }

    return {
      removedToolIds,
      skippedToolIds,
      reclaimedBytes
    }
  }

  async #downloadAndInstallTool(toolId: string, signal?: AbortSignal): Promise<string> {
    const startMs = this.#now()
    const platformArch = this.#platformArch!
    const analyticsPlatform = normalizePlatformName(this.#platform)
    const analyticsArch = platformArch.endsWith('arm64') ? 'arm64' : 'x64'
    let versionForAnalytics = extractVersionFromToolId(toolId)

    this.#emitAnalytics('commonlib_download_start', {
      toolId,
      version: versionForAnalytics,
      platform: analyticsPlatform,
      arch: analyticsArch
    })

    await this.#ensureRootDirectory()
    const stagingDir = path.join(this.#commonLibsRoot, `.staging-${toolId}-${randomUUID()}`)
    let stage: 'verify' | 'install' = 'verify'

    try {
      this.#emitInstallProgress({ toolId, stage: 'fetching-catalog', percent: 0 })
      const { rawBytes, signatureText } = await this.#fetchCatalogBytes(signal, toolId)
      const { catalog } = verifyAndParseCommonLibsCatalog(rawBytes, signatureText, this.#trustBundle)
      const toolEntry = catalog.tools.find((item) => item.toolId === toolId)
      if (!toolEntry) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
          `Tool "${toolId}" is not found in signed CommonLibs catalog`,
          { stage: 'provisioning', retryable: false, userAction: 'update_client' }
        )
      }
      versionForAnalytics = toolEntry.version
      const pkg = toolEntry.packages[platformArch]
      if (!pkg) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
          `Tool "${toolId}" has no signed package for platform "${platformArch}"`
        )
      }

      const effectiveRevocations = catalog.revocations
        ? {
            schemaVersion: 1 as const,
            revokedKeyIds: Array.from(new Set([...this.#trustBundle.revocations.revokedKeyIds, ...catalog.revocations.revokedKeyIds])),
            revokedToolIds: Array.from(new Set([...this.#trustBundle.revocations.revokedToolIds, ...catalog.revocations.revokedToolIds])),
            revokedArchiveSha256: Array.from(new Set([...this.#trustBundle.revocations.revokedArchiveSha256, ...catalog.revocations.revokedArchiveSha256])),
            revokedFileSha256: Array.from(new Set([...this.#trustBundle.revocations.revokedFileSha256, ...catalog.revocations.revokedFileSha256])),
            minToolVersions: { ...this.#trustBundle.revocations.minToolVersions, ...catalog.revocations.minToolVersions }
          }
        : this.#trustBundle.revocations

      const state = await this.#readState()
      assertCommonLibNotRevoked(
        {
          keyId: catalog.keyId,
          toolId: toolEntry.toolId,
          archiveSha256: pkg.archiveSha256,
          fileSha256s: pkg.files.map((item) => item.sha256)
        },
        effectiveRevocations
      )
      assertCommonLibNoRollback(
        toolEntry.toolName,
        toolEntry.version,
        state.highWaterVersions[toolEntry.toolName],
        effectiveRevocations
      )

      this.#assertAllowedDownloadUrl(pkg.url)
      const archiveCandidateUrls = this.#buildArchiveCandidateUrls(pkg.url)

      stage = 'install'
      await fs.mkdir(stagingDir, { recursive: true })
      const archivePath = path.join(stagingDir, '.archive.zip')
      const extractDir = path.join(stagingDir, 'payload')
      await fs.mkdir(extractDir, { recursive: true })

      const downloaded = await this.#downloadArchiveWithRetryAndFallback(
        toolId,
        archiveCandidateUrls,
        archivePath,
        pkg.size,
        signal,
        (transferredBytes, totalBytes) => {
          const percent = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : undefined
          this.#emitInstallProgress({
            toolId,
            stage: 'downloading',
            transferredBytes,
            totalBytes,
            ...(percent !== undefined ? { percent } : {})
          })
        }
      )
      if (downloaded.size !== pkg.size || downloaded.sha256 !== pkg.archiveSha256) {
        stage = 'verify'
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Archive integrity mismatch for ${toolId}`
        )
      }

      this.#emitInstallProgress({ toolId, stage: 'extracting', transferredBytes: pkg.size, totalBytes: pkg.size, percent: 99 })
      await this.#extractZipSafely(archivePath, extractDir, signal)
      await fs.unlink(archivePath).catch(() => undefined)

      stage = 'verify'
      this.#emitInstallProgress({ toolId, stage: 'verifying', transferredBytes: pkg.size, totalBytes: pkg.size, percent: 99 })
      let installedBytes = 0
      for (const fileSpec of pkg.files) {
        const targetPath = await this.#assertNoSymlinkChain(extractDir, fileSpec.path)
        const stat = await fs.lstat(targetPath)
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            `Expected regular file in extracted tool package: ${fileSpec.path}`
          )
        }
        if (stat.size !== fileSpec.size) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            `File size mismatch in tool ${toolId}: ${fileSpec.path}`
          )
        }
        const actualSha256 = await computeFileSha256(targetPath)
        if (actualSha256 !== fileSpec.sha256) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
            `File SHA-256 mismatch in tool ${toolId}: ${fileSpec.path}`
          )
        }
        installedBytes += stat.size
      }

      stage = 'install'
      if (this.#platform !== 'win32') {
        for (const relExec of pkg.executables) {
          const execAbsPath = path.join(extractDir, ...relExec.split('/'))
          await fs.chmod(execAbsPath, 0o755)
        }
      }

      // 将验签后的原始受签目录字节与签名文本一并落盘，供后续 100% 离线密码学验签
      await fs.writeFile(path.join(extractDir, COMMONLIB_TRUST_JSON_FILE), rawBytes)
      await fs.writeFile(path.join(extractDir, COMMONLIB_TRUST_SIG_FILE), signatureText, 'utf8')

      const finalDir = path.join(this.#commonLibsRoot, toolId)
      const existingFinal = await this.#pathExists(finalDir)
      if (existingFinal) {
        await this.#safeTrashAndDelete(finalDir, `${toolId}-replace`)
      }
      await fs.rename(extractDir, finalDir)
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)

      const existingHighWater = state.highWaterVersions[toolEntry.toolName]
      if (!existingHighWater || compareSemVer(toolEntry.version, existingHighWater) > 0) {
        state.highWaterVersions[toolEntry.toolName] = toolEntry.version
      }
      state.tools[toolId] = {
        toolName: toolEntry.toolName,
        version: toolEntry.version,
        platformArch,
        sizeBytes: installedBytes,
        installedAt: new Date(this.#now()).toISOString()
      }
      await this.#writeState(state)
      this.#invalidateHashCacheForPrefix(finalDir)

      this.#emitAnalytics('commonlib_download_success', {
        toolId,
        version: versionForAnalytics,
        platform: analyticsPlatform,
        arch: analyticsArch,
        durationMs: Math.max(0, this.#now() - startMs)
      })
      return finalDir
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      const hostCode =
        (error as { details?: { hostCode?: string } } | null)?.details?.hostCode ??
        TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed
      const isVerifyError =
        stage === 'verify' ||
        hostCode === TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed ||
        hostCode === TOOL_RUNTIME_ERROR_CODES.toolRevoked ||
        hostCode === TOOL_RUNTIME_ERROR_CODES.toolRollbackBlocked
      this.#emitAnalytics(isVerifyError ? 'commonlib_verify_failed' : 'commonlib_install_failed', {
        toolId,
        version: versionForAnalytics,
        platform: analyticsPlatform,
        arch: analyticsArch,
        errorCode: hostCode,
        durationMs: Math.max(0, this.#now() - startMs)
      })
      throw error
    }
  }

  async #verifyInstalledToolOffline(toolId: string): Promise<{
    readonly toolDir: string
    readonly entry: CommonLibCatalogToolEntry
    readonly pkg: CommonLibPlatformPackage
    readonly platformArch: ToolPlatformArchKey
  }> {
    const platformArch = this.#platformArch
    if (!platformArch) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
        `CommonLibs is not supported on platform ${this.#platform}`
      )
    }
    assertCommonLibNotRevoked({ toolId }, this.#trustBundle.revocations)

    const toolDir = await this.#assertToolDirNoSymlink(toolId)
    const trustJsonPath = await this.#assertNoSymlinkChain(toolDir, COMMONLIB_TRUST_JSON_FILE)
    const trustSigPath = await this.#assertNoSymlinkChain(toolDir, COMMONLIB_TRUST_SIG_FILE)

    let rawBytes: Buffer
    let signatureText: string
    try {
      rawBytes = await fs.readFile(trustJsonPath)
      signatureText = await fs.readFile(trustSigPath, 'utf8')
    } catch {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Missing offline trust metadata or signature for CommonLibs tool "${toolId}"`
      )
    }

    const { catalog } = verifyAndParseCommonLibsCatalog(rawBytes, signatureText, this.#trustBundle)
    const entry = catalog.tools.find((item) => item.toolId === toolId)
    if (!entry) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Signed offline trust metadata does not contain tool "${toolId}"`
      )
    }
    const pkg = entry.packages[platformArch]
    if (!pkg) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `Signed offline trust metadata has no package for "${toolId}" on "${platformArch}"`
      )
    }

    const state = await this.#readState()
    assertCommonLibNotRevoked(
      {
        keyId: catalog.keyId,
        toolId: entry.toolId,
        archiveSha256: pkg.archiveSha256,
        fileSha256s: pkg.files.map((item) => item.sha256)
      },
      this.#trustBundle.revocations
    )
    assertCommonLibNoRollback(
      entry.toolName,
      entry.version,
      state.highWaterVersions[entry.toolName],
      this.#trustBundle.revocations
    )

    // 校验全部目标文件及伴生文件的完整性（会话内使用 size + mtimeMs + ino 缓存防高频重复哈希）
    for (const fileSpec of pkg.files) {
      const absPath = await this.#assertNoSymlinkChain(toolDir, fileSpec.path)
      const stat = await fs.lstat(absPath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `CommonLibs file is not a regular file: ${fileSpec.path}`
        )
      }
      if (stat.size !== fileSpec.size) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `CommonLibs file size tampered: ${fileSpec.path}`
        )
      }
      const actualSha256 = await this.#getCachedOrComputeSha256(absPath, stat)
      if (actualSha256 !== fileSpec.sha256) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `CommonLibs file digest tampered: ${fileSpec.path}`
        )
      }
    }

    return { toolDir, entry, pkg, platformArch }
  }

  async #isToolRevokedOffline(toolId: string): Promise<boolean> {
    if (this.#trustBundle.revocations.revokedToolIds.includes(toolId)) return true
    try {
      await this.#verifyInstalledToolOffline(toolId)
      return false
    } catch (error) {
      const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
      return hostCode === TOOL_RUNTIME_ERROR_CODES.toolRevoked
    }
  }

  async #getCachedOrComputeSha256(absPath: string, stat: { size: number; mtimeMs: number; ino: number }): Promise<string> {
    const cached = this.#hashCache.get(absPath)
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ino === stat.ino
    ) {
      return cached.sha256
    }
    const sha256 = await computeFileSha256(absPath)
    this.#hashCache.set(absPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      sha256
    })
    return sha256
  }

  #invalidateHashCacheForPrefix(dirPath: string): void {
    const normalized = path.resolve(dirPath)
    const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`
    for (const key of this.#hashCache.keys()) {
      if (key === normalized || key.startsWith(prefix)) {
        this.#hashCache.delete(key)
      }
    }
  }

  async #assertToolDirNoSymlink(toolId: string): Promise<string> {
    const rootStat = await fs.lstat(this.#commonLibsRoot).catch(() => null)
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        'CommonLibs root directory is missing or is a symbolic link'
      )
    }
    const toolDir = path.join(this.#commonLibsRoot, toolId)
    const toolStat = await fs.lstat(toolDir).catch(() => null)
    if (!toolStat || !toolStat.isDirectory() || toolStat.isSymbolicLink()) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
        `CommonLibs tool directory "${toolId}" is missing or is a symbolic link`
      )
    }
    const realRoot = await fs.realpath(this.#commonLibsRoot)
    const realTool = await fs.realpath(toolDir)
    const expectedPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`
    if (!realTool.startsWith(expectedPrefix)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        `CommonLibs tool directory "${toolId}" escapes CommonLibs root`
      )
    }
    return realTool
  }

  async #assertNoSymlinkChain(baseDir: string, relativePosixPath: string): Promise<string> {
    const segments = relativePosixPath.split('/')
    let current = baseDir
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..') {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          `Illegal path segment in CommonLibs path: ${relativePosixPath}`
        )
      }
      current = path.join(current, segment)
      const stat = await fs.lstat(current).catch(() => null)
      if (!stat) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
          `Expected CommonLibs file is missing: ${relativePosixPath}`
        )
      }
      if (stat.isSymbolicLink()) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          `Symbolic link is forbidden inside CommonLibs: ${relativePosixPath}`
        )
      }
    }
    const realBase = await fs.realpath(baseDir)
    const realTarget = await fs.realpath(current)
    const prefix = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`
    if (!realTarget.startsWith(prefix)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        `CommonLibs file escapes tool root via reparse point: ${relativePosixPath}`
      )
    }
    return realTarget
  }

  #buildArchiveCandidateUrls(primaryUrl: string): readonly string[] {
    const candidates: string[] = [primaryUrl]
    if (this.#fallbackCatalogBaseUrls.length === 0) return candidates
    let parsedPrimary: URL
    try {
      parsedPrimary = new URL(primaryUrl)
    } catch {
      return candidates
    }
    const primaryCatalogBase = this.#catalogUrl.replace(/\/catalog\.json(?:\?.*)?$/i, '').replace(/\/+$/, '')
    let relativeSuffix = parsedPrimary.pathname
    try {
      const parsedBase = new URL(primaryCatalogBase)
      const basePath = parsedBase.pathname.replace(/\/+$/, '')
      if (basePath && parsedPrimary.pathname.startsWith(`${basePath}/`)) {
        relativeSuffix = parsedPrimary.pathname.slice(basePath.length)
      }
    } catch {
      // 保留完整路径
    }
    const normalizedSuffix = relativeSuffix.startsWith('/') ? relativeSuffix : `/${relativeSuffix}`
    for (const fallbackBase of this.#fallbackCatalogBaseUrls) {
      const candidate = `${fallbackBase}${normalizedSuffix}${parsedPrimary.search}`
      try {
        this.#assertAllowedDownloadUrl(candidate)
        if (!candidates.includes(candidate)) {
          candidates.push(candidate)
        }
      } catch {
        // 忽略不在白名单内的备用源，严格坚守安全边界
      }
    }
    return candidates
  }

  async #fetchCatalogBytes(
    signal?: AbortSignal,
    toolId?: string
  ): Promise<{ readonly rawBytes: Buffer; readonly signatureText: string }> {
    if (this.#catalogSource) {
      return this.#catalogSource.fetchCatalog(signal)
    }
    const endpoints: Array<{ readonly catalogUrl: string; readonly catalogSigUrl: string }> = [
      { catalogUrl: this.#catalogUrl, catalogSigUrl: this.#catalogSigUrl }
    ]
    for (const base of this.#fallbackCatalogBaseUrls) {
      endpoints.push({
        catalogUrl: `${base}/catalog.json`,
        catalogSigUrl: `${base}/catalog.sig`
      })
    }
    for (const endpoint of endpoints) {
      this.#assertAllowedDownloadUrl(endpoint.catalogUrl)
      this.#assertAllowedDownloadUrl(endpoint.catalogSigUrl)
    }

    const attemptsPerEndpoint = this.#maxDownloadRetries + 1
    const maxTotalAttempts = endpoints.length * attemptsPerEndpoint
    let totalAttempts = 0
    let lastError: unknown

    for (const endpoint of endpoints) {
      for (let attempt = 1; attempt <= attemptsPerEndpoint; attempt += 1) {
        totalAttempts += 1
        if (signal?.aborted) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.taskCancelled,
            'CommonLibs catalog fetch was cancelled'
          )
        }
        try {
          return await this.#fetchCatalogBytesOnce(endpoint.catalogUrl, endpoint.catalogSigUrl, signal)
        } catch (error) {
          lastError = error
          if (isAbortLikeError(error, signal)) {
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.taskCancelled,
              'CommonLibs catalog fetch was cancelled'
            )
          }
          const retryable = isRetryableProvisionError(error, signal)
          const hasMoreInEndpoint = retryable && attempt < attemptsPerEndpoint
          const hasNextEndpoint = totalAttempts < maxTotalAttempts && endpoints.length > 1
          if (hasMoreInEndpoint) {
            if (toolId) {
              this.#emitInstallProgress({
                toolId,
                stage: 'retrying',
                percent: 0,
                attempt: totalAttempts + 1,
                maxAttempts: maxTotalAttempts
              })
            }
            const delayMs = this.#retryBaseDelayMs * Math.pow(2, attempt - 1)
            await sleepAbortable(delayMs, signal)
            continue
          }
          if (hasNextEndpoint) {
            if (toolId) {
              this.#emitInstallProgress({
                toolId,
                stage: 'retrying',
                percent: 0,
                attempt: totalAttempts + 1,
                maxAttempts: maxTotalAttempts
              })
            }
            break
          }
          break
        }
      }
    }

    if (lastError instanceof Error && 'code' in lastError) {
      throw lastError
    }
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
      `Failed to download CommonLibs catalog after ${totalAttempts} attempt(s): ${formatErrorMessage(lastError)}`,
      { stage: 'provisioning', retryable: true, userAction: 'check_network', attempts: totalAttempts }
    )
  }

  async #fetchCatalogBytesOnce(
    catalogUrl: string,
    catalogSigUrl: string,
    signal?: AbortSignal
  ): Promise<{ readonly rawBytes: Buffer; readonly signatureText: string }> {
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), CATALOG_TIMEOUT_MS)
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    try {
      const [catalogRes, sigRes] = await Promise.all([
        this.#fetchImpl(catalogUrl, { signal: combinedSignal, cache: 'no-store' }),
        this.#fetchImpl(catalogSigUrl, { signal: combinedSignal, cache: 'no-store' })
      ])
      if (!catalogRes.ok || !sigRes.ok) {
        const retryable =
          (!catalogRes.ok && isRetryableHttpStatus(catalogRes.status)) ||
          (!sigRes.ok && isRetryableHttpStatus(sigRes.status))
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
          `Failed to fetch CommonLibs catalog (status ${catalogRes.status}/${sigRes.status})`,
          {
            stage: 'provisioning',
            retryable,
            userAction: retryable ? 'check_network' : 'update_client',
            detail: `HTTP ${catalogRes.status}/${sigRes.status}`
          }
        )
      }
      const rawBytes = Buffer.from(await catalogRes.arrayBuffer())
      const signatureText = await sigRes.text()
      return { rawBytes, signatureText }
    } catch (error) {
      if (signal?.aborted) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.taskCancelled,
          'CommonLibs catalog fetch was cancelled'
        )
      }
      if (timeoutController.signal.aborted) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
          'CommonLibs catalog fetch timed out',
          { stage: 'provisioning', retryable: true, timedOut: true, userAction: 'check_network' }
        )
      }
      if (error instanceof Error && 'code' in error) throw error
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
        `Failed to download CommonLibs catalog: ${formatErrorMessage(error)}`,
        {
          stage: 'provisioning',
          retryable: true,
          userAction: 'check_network',
          detail: formatErrorMessage(error)
        }
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async #downloadArchiveWithRetryAndFallback(
    toolId: string,
    candidateUrls: readonly string[],
    destinationPath: string,
    expectedSize: number,
    signal?: AbortSignal,
    onBytesProgress?: (transferredBytes: number, totalBytes: number) => void
  ): Promise<{ readonly size: number; readonly sha256: string }> {
    const attemptsPerUrl = this.#maxDownloadRetries + 1
    const maxTotalAttempts = candidateUrls.length * attemptsPerUrl
    let totalAttempts = 0
    let lastError: unknown

    for (const candidateUrl of candidateUrls) {
      for (let attempt = 1; attempt <= attemptsPerUrl; attempt += 1) {
        totalAttempts += 1
        if (signal?.aborted) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.taskCancelled,
            'CommonLibs archive download was cancelled'
          )
        }
        await fs.unlink(destinationPath).catch(() => undefined)
        try {
          return await this.#downloadArchiveWithHash(
            candidateUrl,
            destinationPath,
            expectedSize,
            signal,
            onBytesProgress
          )
        } catch (error) {
          lastError = error
          await fs.unlink(destinationPath).catch(() => undefined)
          if (isAbortLikeError(error, signal)) {
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.taskCancelled,
              'CommonLibs archive download was cancelled'
            )
          }
          const retryable = isRetryableProvisionError(error, signal)
          const hasMoreInUrl = retryable && attempt < attemptsPerUrl
          const hasNextUrl = candidateUrls.length > 1 && totalAttempts < maxTotalAttempts
          if (hasMoreInUrl) {
            this.#emitInstallProgress({
              toolId,
              stage: 'retrying',
              percent: 0,
              attempt: totalAttempts + 1,
              maxAttempts: maxTotalAttempts
            })
            const delayMs = this.#retryBaseDelayMs * Math.pow(2, attempt - 1)
            await sleepAbortable(delayMs, signal)
            continue
          }
          if (hasNextUrl && (retryable || (error as { details?: { hostCode?: string } } | null)?.details?.hostCode === TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed)) {
            this.#emitInstallProgress({
              toolId,
              stage: 'retrying',
              percent: 0,
              attempt: totalAttempts + 1,
              maxAttempts: maxTotalAttempts
            })
            break
          }
          throw error
        }
      }
    }

    if (lastError instanceof Error && 'code' in lastError) {
      throw lastError
    }
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
      `CommonLibs archive download failed after ${totalAttempts} attempt(s): ${formatErrorMessage(lastError)}`,
      { stage: 'provisioning', retryable: true, userAction: 'check_network', attempts: totalAttempts }
    )
  }

  #normalizeOrigin(origin: string): string {
    const parsed = new URL(origin)
    return parsed.origin.toLowerCase()
  }

  #assertAllowedDownloadUrl(rawUrl: string): void {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Invalid CommonLibs download URL: ${rawUrl}`
      )
    }
    if (parsed.username || parsed.password) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'CommonLibs download URL must not contain credentials'
      )
    }
    const normalizedOrigin = parsed.origin.toLowerCase()
    if (!this.#allowedOrigins.includes(normalizedOrigin)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `CommonLibs download origin "${normalizedOrigin}" is not in allowed whitelist`
      )
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Unsupported CommonLibs download protocol: ${parsed.protocol}`
      )
    }
  }

  async #downloadArchiveWithHash(
    url: string,
    destinationPath: string,
    expectedSize: number,
    signal?: AbortSignal,
    onBytesProgress?: (transferredBytes: number, totalBytes: number) => void
  ): Promise<{ readonly size: number; readonly sha256: string }> {
    if (expectedSize <= 0 || expectedSize > MAX_ARCHIVE_BYTES) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `CommonLibs archive size ${expectedSize} exceeds allowed limit`
      )
    }
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), DOWNLOAD_TIMEOUT_MS)
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    try {
      const response = await this.#fetchImpl(url, { signal: combinedSignal, cache: 'no-store' })
      if (!response.ok || !response.body) {
        const retryable = isRetryableHttpStatus(response.status)
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
          `CommonLibs archive download failed with status ${response.status}`,
          {
            stage: 'provisioning',
            retryable,
            userAction: retryable ? 'check_network' : 'update_client',
            detail: `HTTP ${response.status}`
          }
        )
      }
      const hash = crypto.createHash('sha256')
      let downloadedBytes = 0
      let lastReportedPct = -1
      let lastReportTimeMs = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloadedBytes += chunk.byteLength
          if (downloadedBytes > Math.min(expectedSize, MAX_ARCHIVE_BYTES)) {
            callback(
              createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
                'CommonLibs archive stream exceeded expected size'
              )
            )
            return
          }
          hash.update(chunk)
          if (onBytesProgress) {
            const pct = expectedSize > 0 ? Math.floor((downloadedBytes / expectedSize) * 100) : 0
            const nowMs = Date.now()
            if (pct > lastReportedPct || nowMs - lastReportTimeMs >= 250 || downloadedBytes === expectedSize) {
              lastReportedPct = pct
              lastReportTimeMs = nowMs
              onBytesProgress(downloadedBytes, expectedSize)
            }
          }
          callback(null, chunk)
        }
      })
      const writer = createWriteStream(destinationPath)
      const reader = response.body.getReader()
      const nodeReadable = new (await import('node:stream')).Readable({
        async read() {
          try {
            const { done, value } = await reader.read()
            if (done) {
              this.push(null)
            } else {
              this.push(Buffer.from(value))
            }
          } catch (err) {
            this.destroy(err instanceof Error ? err : new Error(String(err)))
          }
        },
        destroy(err, callback) {
          void reader
            .cancel()
            .catch(() => undefined)
            .finally(() => {
              try {
                reader.releaseLock()
              } catch {
                // 忽略已释放锁
              }
              callback(err)
            })
        }
      })
      try {
        await pipeline(nodeReadable, meter, writer)
      } finally {
        await reader.cancel().catch(() => undefined)
        try {
          reader.releaseLock()
        } catch {
          // 忽略已释放锁
        }
      }
      return { size: downloadedBytes, sha256: hash.digest('hex') }
    } catch (error) {
      if (signal?.aborted) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.taskCancelled,
          'CommonLibs archive download was cancelled'
        )
      }
      if (timeoutController.signal.aborted) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
          'CommonLibs archive download timed out',
          { stage: 'provisioning', retryable: true, timedOut: true, userAction: 'check_network' }
        )
      }
      if (error instanceof Error && 'code' in error) throw error
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed,
        `CommonLibs archive download error: ${formatErrorMessage(error)}`,
        {
          stage: 'provisioning',
          retryable: true,
          userAction: 'check_network',
          detail: formatErrorMessage(error)
        }
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async #extractZipSafely(zipPath: string, destinationDir: string, signal?: AbortSignal): Promise<void> {
    const zipFile = await new Promise<ZipFile>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, opened) => {
        if (err || !opened) {
          reject(
            createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
              `Failed to open CommonLibs zip archive: ${err?.message ?? 'unknown'}`
            )
          )
          return
        }
        resolve(opened)
      })
    })

    let entryCount = 0
    let totalExtracted = 0
    const realDest = await fs.realpath(destinationDir)
    const destPrefix = realDest.endsWith(path.sep) ? realDest : `${realDest}${path.sep}`

    try {
      await new Promise<void>((resolve, reject) => {
        let finished = false
        const fail = (error: Error): void => {
          if (finished) return
          finished = true
          reject(error)
        }

        zipFile.on('error', (err) => {
          fail(
            createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
              `Corrupt CommonLibs zip archive: ${err.message}`
            )
          )
        })

        zipFile.on('end', () => {
          if (!finished) {
            finished = true
            resolve()
          }
        })

        zipFile.on('entry', (entry: Entry) => {
          void (async () => {
            if (signal?.aborted) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.taskCancelled,
                'CommonLibs extraction was cancelled'
              )
            }
            entryCount += 1
            if (entryCount > MAX_ZIP_ENTRIES) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
                'CommonLibs archive exceeds maximum entry count'
              )
            }
            if (isZipEntrySymlink(entry)) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.pathDenied,
                `Symlink entries are forbidden in CommonLibs archive: ${entry.fileName}`
              )
            }
            const rawName = entry.fileName
            const isDir = rawName.endsWith('/')
            const trimmed = isDir ? rawName.slice(0, -1) : rawName
            if (!trimmed) {
              zipFile.readEntry()
              return
            }
            if (!isSafeCommonLibRelativePath(trimmed)) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.pathDenied,
                `Unsafe path in CommonLibs zip archive: ${rawName}`
              )
            }
            const targetPath = path.resolve(realDest, ...trimmed.split('/'))
            if (!targetPath.startsWith(destPrefix)) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.pathDenied,
                `Zip entry escapes extraction root: ${rawName}`
              )
            }
            if (isDir) {
              await fs.mkdir(targetPath, { recursive: true })
              zipFile.readEntry()
              return
            }
            await fs.mkdir(path.dirname(targetPath), { recursive: true })
            const readStream = await new Promise<import('node:stream').Readable>((res, rej) => {
              zipFile.openReadStream(entry, (openErr, stream) => {
                if (openErr || !stream) {
                  rej(
                    createToolRuntimeError(
                      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
                      `Failed to read zip entry ${rawName}: ${openErr?.message ?? 'unknown'}`
                    )
                  )
                  return
                }
                res(stream)
              })
            })
            const meter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                totalExtracted += chunk.byteLength
                if (totalExtracted > MAX_EXTRACTED_BYTES) {
                  callback(
                    createToolRuntimeError(
                      TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed,
                      'CommonLibs archive expanded size exceeds maximum limit'
                    )
                  )
                  return
                }
                callback(null, chunk)
              }
            })
            await pipeline(readStream, meter, createWriteStream(targetPath))
            zipFile.readEntry()
          })().catch((err: unknown) => {
            fail(err instanceof Error ? err : new Error(String(err)))
          })
        })

        zipFile.readEntry()
      })
    } finally {
      try {
        zipFile.close()
      } catch {
        // 忽略关闭异常
      }
    }
  }

  async #ensureRootDirectory(): Promise<void> {
    await fs.mkdir(this.#commonLibsRoot, { recursive: true })
    if (this.#platform === 'darwin' && !this.#backupExclusionApplied) {
      this.#backupExclusionApplied = true
      await this.#applyMacosBackupExclusion(this.#commonLibsRoot)
    }
  }

  async #applyMacosBackupExclusion(dirPath: string): Promise<void> {
    try {
      if (this.#excludeFromBackupImpl) {
        await this.#excludeFromBackupImpl(dirPath)
        return
      }
      if (this.#processRunner) {
        // 使用 Apple 官方 Time Machine 扩展属性标记排除备份（失败不阻塞离线功能）
        const result = await this.#processRunner.run({
          exePath: '/usr/bin/xattr',
          argv: [
            '-w',
            'com.apple.metadata:com_apple_backup_excludeItem',
            'com.apple.backupd',
            dirPath
          ],
          timeoutMs: 5_000,
          tag: 'macos-tm-exclude'
        })
        if (result.exitCode !== 0) {
          console.warn('设置 macOS CommonLibs Time Machine 排除属性未成功', {
            exitCode: result.exitCode
          })
        }
      }
    } catch (error) {
      console.warn('设置 macOS CommonLibs Time Machine 排除属性失败（不影响离线功能）', error)
    }
  }

  async #scanInstalledToolDirs(): Promise<string[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.#commonLibsRoot, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return []
      throw error
    }
    const result: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!TOOL_ID_SEGMENT_REGEX.test(entry.name)) continue
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        result.push(entry.name)
      }
    }
    return result
  }

  async #safeTrashAndDelete(targetDir: string, label: string): Promise<number | null> {
    const sizeBytes = await computeDirectorySize(targetDir)
    const trashDir = path.join(this.#commonLibsRoot, `.trash-${label}-${randomUUID()}`)
    try {
      await fs.rename(targetDir, trashDir)
    } catch (error) {
      if (isRetryableLockError(error)) {
        return null
      }
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return 0
      throw error
    }
    try {
      await fs.rm(trashDir, { recursive: true, force: true })
    } catch (error) {
      if (!isRetryableLockError(error)) {
        console.warn('清理 CommonLibs 待删目录失败，将在下次 GC 重试', error)
      }
    }
    return sizeBytes
  }

  async #sweepLeftoverTempDirs(nowMs: number): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.#commonLibsRoot, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.trash-') && !entry.name.startsWith('.staging-')) continue
      const target = path.join(this.#commonLibsRoot, entry.name)
      try {
        if (entry.name.startsWith('.staging-')) {
          const stat = await fs.lstat(target)
          // 仅清理超过 1 小时的陈旧 staging 目录，避免误删并发安装事务
          if (nowMs - stat.mtimeMs < 3600_000) continue
        }
        await fs.rm(target, { recursive: true, force: true })
      } catch {
        // 占锁或并发删除时静默留待下次重试
      }
    }
  }

  async #readState(): Promise<PersistedCommonLibsState> {
    const file = path.join(this.#commonLibsRoot, COMMONLIBS_STATE_FILE)
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
        return { schemaVersion: 1, highWaterVersions: {}, tools: {} }
      }
      const highWaterVersions: Record<string, string> = {}
      if (isPlainObject(parsed.highWaterVersions)) {
        for (const [k, v] of Object.entries(parsed.highWaterVersions)) {
          if (typeof v === 'string') highWaterVersions[k] = v
        }
      }
      const tools: Record<string, PersistedToolStateEntry> = {}
      if (isPlainObject(parsed.tools)) {
        for (const [k, v] of Object.entries(parsed.tools)) {
          if (!isPlainObject(v)) continue
          if (
            typeof v.toolName === 'string' &&
            typeof v.version === 'string' &&
            typeof v.platformArch === 'string' &&
            typeof v.sizeBytes === 'number' &&
            typeof v.installedAt === 'string'
          ) {
            tools[k] = {
              toolName: v.toolName,
              version: v.version,
              platformArch: v.platformArch as ToolPlatformArchKey,
              sizeBytes: v.sizeBytes,
              installedAt: v.installedAt,
              ...(typeof v.unreferencedSince === 'string' ? { unreferencedSince: v.unreferencedSince } : {})
            }
          }
        }
      }
      return { schemaVersion: 1, highWaterVersions, tools }
    } catch {
      return { schemaVersion: 1, highWaterVersions: {}, tools: {} }
    }
  }

  async #writeState(state: PersistedCommonLibsState): Promise<void> {
    await this.#ensureRootDirectory()
    const file = path.join(this.#commonLibsRoot, COMMONLIBS_STATE_FILE)
    const tmp = `${file}.tmp.${randomUUID()}`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }

  async #pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath)
      return true
    } catch {
      return false
    }
  }

  #emitInstallProgress(progress: CommonLibDownloadProgress): void {
    const listeners = this.#inFlightProgressListeners.get(progress.toolId)
    if (!listeners || listeners.size === 0) return
    for (const listener of listeners) {
      try {
        listener(progress)
      } catch (error) {
        console.warn('推送 CommonLibs 下载进度回调失败', error)
      }
    }
  }

  #emitAnalytics(event: CommonLibAnalyticsEventName, payload: CommonLibAnalyticsPayload): void {
    if (!this.#onAnalyticsEvent) return
    try {
      this.#onAnalyticsEvent(event, payload)
    } catch (error) {
      console.warn('上报 CommonLibs 统计事件失败', error)
    }
  }
}
