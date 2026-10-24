import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry } from 'yauzl'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

const WEB_ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024
const WEB_EXPANDED_LIMIT = 4 * 1024 * 1024 * 1024
const ENTRY_EXPANDED_LIMIT = 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_VERSION_BYTES = 1024 * 1024
const POINTER_SCHEMA_VERSION = 1
const TRANSACTION_SCHEMA_VERSION = 1
const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

type TransactionState = 'prepared' | 'activated'

interface ActivePointer {
  schemaVersion: typeof POINTER_SCHEMA_VERSION
  operationId: string
  version: string
  directory: string
  /** 仅内置拷贝（operationId === 'bundled'）记录：拷贝时内置资源的内容指纹，用于发现同版本号的新构建 */
  bundledFingerprint?: string
}

interface BundledInfo {
  version: string
  fingerprint: string
}

const BUNDLED_OPERATION_ID = 'bundled'

interface WebTransaction {
  schemaVersion: typeof TRANSACTION_SCHEMA_VERSION
  operationId: string
  state: TransactionState
  staging: string
  directory: string
  previous: ActivePointer
  next: ActivePointer
}

export interface WebResourceServiceOptions {
  bundledRoot: string
  runtimePaths: Pick<RuntimePaths, 'businessDataRoot'>
}

export interface WebResourceUpdateResult {
  operationId: string
  version: string
  root: string
  previousVersion: string
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function normalizeVersion(value: string): string {
  if (!VERSION_PATTERN.test(value)) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Web 资源版本格式无效')
  }
  return value
}

function requireNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new ZToolsError(errorCodes.appStopping, 'Web 更新已取消')
}

function validateArchivePath(fileName: string): string[] {
  if (
    fileName.length === 0 ||
    fileName.length > 32 * 1024 ||
    fileName.includes('\0') ||
    fileName.includes('\\')
  ) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Web ZIP 包含无效路径')
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
    )
  ) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Web ZIP 包含不安全路径')
  }
  return segments
}

function isSymlink(entry: Entry): boolean {
  const hostSystem = entry.versionMadeBy >>> 8
  const unixMode = entry.externalFileAttributes >>> 16
  return hostSystem === 3 && (unixMode & 0o170000) === 0o120000
}

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  return fs.lstat(target).catch(() => undefined)
}

async function requireOrdinaryDirectory(target: string, message: string): Promise<void> {
  const stats = await lstatOrUndefined(target)
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new ZToolsError(errorCodes.storageError, message)
  }
}

async function requireOrdinaryFile(target: string, message: string): Promise<void> {
  const stats = await lstatOrUndefined(target)
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new ZToolsError(errorCodes.dataCorrupt, message)
  }
}

async function validateOrdinaryTree(root: string): Promise<void> {
  await requireOrdinaryDirectory(root, 'Web 资源根不是普通目录')
  const pending = [path.resolve(root)]
  while (pending.length > 0) {
    const current = pending.pop() as string
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new ZToolsError(errorCodes.dataCorrupt, 'Web 资源不能包含符号链接')
      }
      if (entry.isDirectory()) {
        pending.push(target)
      } else if (!entry.isFile()) {
        throw new ZToolsError(errorCodes.dataCorrupt, 'Web 资源包含不支持的文件类型')
      }
    }
  }
}

// Electron's ASAR filesystem supports file reads but not recursive fs.cp; copy
// the bundled tree through ordinary reads so first-run production startup works.
async function copyBundledTree(source: string, destination: string): Promise<void> {
  await requireOrdinaryDirectory(source, 'Web 资源根不是普通目录')
  await fs.mkdir(destination)
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      throw new ZToolsError(errorCodes.dataCorrupt, 'Web 资源不能包含符号链接')
    }
    if (entry.isDirectory()) {
      await copyBundledTree(sourcePath, destinationPath)
    } else if (entry.isFile()) {
      await fs.writeFile(destinationPath, await fs.readFile(sourcePath))
    } else {
      throw new ZToolsError(errorCodes.dataCorrupt, 'Web 资源包含不支持的文件类型')
    }
  }
}

async function readWebVersion(root: string): Promise<string> {
  const versionFile = path.join(root, 'version.json')
  await requireOrdinaryFile(versionFile, 'Web 资源缺少 version.json')
  const stats = await fs.stat(versionFile)
  if (stats.size > MAX_VERSION_BYTES) {
    throw new ZToolsError(errorCodes.fileTooLarge, 'Web version.json 超过大小限制')
  }
  let value: unknown
  try {
    value = JSON.parse((await fs.readFile(versionFile, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Web version.json 不是有效 JSON')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    typeof value.version !== 'string'
  ) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Web version.json 缺少有效版本')
  }
  return normalizeVersion(value.version)
}

async function validateWebRoot(root: string, expectedVersion?: string): Promise<string> {
  await validateOrdinaryTree(root)
  await requireOrdinaryFile(path.join(root, 'index.html'), 'Web 资源缺少入口 index.html')
  const version = await readWebVersion(root)
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Web 资源版本与更新请求不一致')
  }
  return version
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    await fs.rm(target, { force: true })
    await fs.rename(temporary, target)
  }
}

async function readJson(target: string): Promise<unknown | undefined> {
  try {
    return JSON.parse((await fs.readFile(target, 'utf8')).replace(/^\uFEFF/, '')) as unknown
  } catch {
    return undefined
  }
}

function isPointer(value: unknown): value is ActivePointer {
  const fingerprint = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).bundledFingerprint
    : undefined
  return typeof value === 'object' && value !== null &&
    (value as Record<string, unknown>).schemaVersion === POINTER_SCHEMA_VERSION &&
    typeof (value as Record<string, unknown>).operationId === 'string' &&
    typeof (value as Record<string, unknown>).version === 'string' &&
    typeof (value as Record<string, unknown>).directory === 'string' &&
    (fingerprint === undefined || typeof fingerprint === 'string')
}

/**
 * 内置资源指纹：version.json + index.html。index.html 引用的产物文件名带内容哈希，
 * 任意一次前端重新构建都会改变指纹，即使 version.json 的版本号没变。
 */
async function readBundledFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(path.join(root, 'version.json')))
  hash.update('\0')
  hash.update(await fs.readFile(path.join(root, 'index.html')))
  return hash.digest('hex')
}

/** 数字段逐段比较（1.1.7.1 < 1.1.8）；预发布 / 构建后缀不参与比较 */
export function compareWebVersions(left: string, right: string): number {
  const parts = (value: string) => (value.split(/[-+]/)[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/**
 * 启动时是否应以内置资源替换当前激活资源：
 * - 当前是内置拷贝：指纹不同即刷新（覆盖安装同版本号的新构建、开发态重新构建）；
 * - 当前是热更新资源：仅当内置版本严格更高（安装包已越过热更新版本）才切回内置。
 */
export function shouldRefreshFromBundled(
  active: Pick<ActivePointer, 'operationId' | 'version' | 'bundledFingerprint'>,
  bundled: BundledInfo
): boolean {
  if (active.operationId === BUNDLED_OPERATION_ID) {
    return active.bundledFingerprint !== bundled.fingerprint
  }
  return compareWebVersions(bundled.version, active.version) > 0
}

function isTransaction(value: unknown): value is WebTransaction {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === TRANSACTION_SCHEMA_VERSION &&
    typeof record.operationId === 'string' &&
    (record.state === 'prepared' || record.state === 'activated') &&
    typeof record.staging === 'string' &&
    typeof record.directory === 'string' &&
    isPointer(record.previous) &&
    isPointer(record.next)
}

function isSafeDirectoryName(value: string): boolean {
  return value.length > 0 &&
    path.basename(value) === value &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0')
}

function isDirectChild(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  return path.dirname(normalizedCandidate) === normalizedRoot
}

export class WebResourceService {
  readonly #bundledRoot: string
  readonly #webRoot: string
  readonly #versionsRoot: string
  readonly #stagingRoot: string
  readonly #transactionRoot: string
  readonly #pointerPath: string
  #active: ActivePointer | undefined
  #initialized = false
  #pendingOperationId: string | undefined
  #mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: WebResourceServiceOptions) {
    this.#bundledRoot = path.resolve(options.bundledRoot)
    this.#webRoot = path.join(path.dirname(path.resolve(options.runtimePaths.businessDataRoot)), 'Web')
    this.#versionsRoot = path.join(this.#webRoot, 'versions')
    this.#stagingRoot = path.join(this.#webRoot, 'staging')
    this.#transactionRoot = path.join(this.#webRoot, 'transactions')
    this.#pointerPath = path.join(this.#webRoot, 'active.json')
  }

  get root(): string {
    if (!this.#active) throw new Error('Web 资源服务尚未初始化')
    return path.join(this.#versionsRoot, this.#active.directory)
  }

  get version(): string {
    if (!this.#active) throw new Error('Web 资源服务尚未初始化')
    return this.#active.version
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    await fs.mkdir(this.#webRoot, { recursive: true })
    await requireOrdinaryDirectory(this.#webRoot, 'Web 资源目录不是普通目录')
    await fs.mkdir(this.#versionsRoot, { recursive: true })
    await fs.mkdir(this.#stagingRoot, { recursive: true })
    await fs.mkdir(this.#transactionRoot, { recursive: true })
    await requireOrdinaryDirectory(this.#versionsRoot, 'Web 版本目录不是普通目录')
    await requireOrdinaryDirectory(this.#stagingRoot, 'Web 暂存目录不是普通目录')
    await requireOrdinaryDirectory(this.#transactionRoot, 'Web 事务目录不是普通目录')
    await this.#recoverTransactions()

    let active = await this.#readActivePointer()
    if (!active) {
      // 首次启动或指针损坏：内置资源必须可用，否则启动失败（保持原有行为）
      active = await this.#installBundled(await this.#inspectBundled())
    } else {
      active = await this.#refreshFromBundledIfNeeded(active)
    }
    this.#active = active
    this.#initialized = true
  }

  async #inspectBundled(): Promise<BundledInfo> {
    const version = await validateWebRoot(this.#bundledRoot)
    return { version, fingerprint: await readBundledFingerprint(this.#bundledRoot) }
  }

  async #installBundled(bundled: BundledInfo): Promise<ActivePointer> {
    const directory = `bundled-${bundled.version}-${randomUUID()}`
    const target = path.join(this.#versionsRoot, directory)
    try {
      await copyBundledTree(this.#bundledRoot, target)
      await validateWebRoot(target, bundled.version)
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const pointer: ActivePointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      operationId: BUNDLED_OPERATION_ID,
      version: bundled.version,
      directory,
      bundledFingerprint: bundled.fingerprint
    }
    await atomicWriteJson(this.#pointerPath, pointer)
    return pointer
  }

  /**
   * 已有激活资源时的刷新：任何失败都保留原资源继续启动，只记录日志。
   * 事务恢复已在此之前完成（事务日志全部处理并删除），不存在待确认的热更新，可安全切换。
   */
  async #refreshFromBundledIfNeeded(active: ActivePointer): Promise<ActivePointer> {
    let bundled: BundledInfo
    try {
      bundled = await this.#inspectBundled()
    } catch (error) {
      console.warn('Bundled web resources unavailable; keeping active resources', { error })
      return active
    }
    if (!shouldRefreshFromBundled(active, bundled)) return active
    let next: ActivePointer
    try {
      next = await this.#installBundled(bundled)
    } catch (error) {
      console.warn('Refreshing bundled web resources failed; keeping active resources', { error })
      return active
    }
    console.info('Web resources refreshed from bundled build', {
      previousVersion: active.version,
      previousOperationId: active.operationId,
      version: next.version
    })
    const previousRoot = path.join(this.#versionsRoot, active.directory)
    if (isSafeDirectoryName(active.directory) && isDirectChild(this.#versionsRoot, previousRoot) && active.directory !== next.directory) {
      await fs.rm(previousRoot, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn('Removing superseded web resources failed', { directory: active.directory, error })
      })
    }
    return next
  }

  async applyArchive(
    archivePath: string,
    requestedVersion: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<WebResourceUpdateResult> {
    const previous = this.#mutationQueue
    const task = previous.then(() => this.#applyArchive(archivePath, requestedVersion, signal))
    this.#mutationQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async confirm(operationId: string): Promise<void> {
    const previous = this.#mutationQueue
    const task = previous.then(() => this.#confirm(operationId))
    this.#mutationQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async rollback(operationId: string): Promise<void> {
    const previous = this.#mutationQueue
    const task = previous.then(() => this.#rollback(operationId))
    this.#mutationQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async #applyArchive(
    archivePath: string,
    requestedVersion: string,
    signal: AbortSignal
  ): Promise<WebResourceUpdateResult> {
    if (!this.#initialized || !this.#active) throw new Error('Web 资源服务尚未初始化')
    if (this.#pendingOperationId) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Web 资源已有待确认事务')
    }
    const version = normalizeVersion(requestedVersion)
    const archive = path.resolve(archivePath)
    if (path.extname(archive).toLowerCase() !== '.zip') {
      throw new ZToolsError(errorCodes.invalidRequest, 'Web 更新包必须是 ZIP')
    }
    const archiveStats = await lstatOrUndefined(archive)
    if (!archiveStats?.isFile() || archiveStats.isSymbolicLink()) {
      throw new ZToolsError(errorCodes.dataCorrupt, 'Web 更新包不是普通文件')
    }
    if (archiveStats.size > WEB_ARCHIVE_LIMIT) {
      throw new ZToolsError(errorCodes.fileTooLarge, 'Web 更新包超过大小限制')
    }
    requireNotAborted(signal)

    const operationId = randomUUID()
    const staging = path.join(this.#stagingRoot, operationId)
    const directory = `web-${version}-${operationId}`
    const destination = path.join(this.#versionsRoot, directory)
    const next: ActivePointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      operationId,
      version,
      directory
    }
    const transaction: WebTransaction = {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      operationId,
      state: 'prepared',
      staging,
      directory: destination,
      previous: this.#active,
      next
    }
    const transactionPath = path.join(this.#transactionRoot, `${operationId}.json`)
    let switched = false
    try {
      await fs.mkdir(staging, { recursive: false })
      await atomicWriteJson(transactionPath, transaction)
      await this.#extractArchive(archive, staging, signal)
      requireNotAborted(signal)
      await validateWebRoot(staging, version)
      await fs.rename(staging, destination)
      await atomicWriteJson(transactionPath, { ...transaction, state: 'activated' })
      await atomicWriteJson(this.#pointerPath, next)
      switched = true
      this.#active = next
      this.#pendingOperationId = operationId
      console.info('Web resource transaction activated', {
        operationId,
        version,
        previousVersion: transaction.previous.version
      })
      return {
        operationId,
        version,
        root: destination,
        previousVersion: transaction.previous.version
      }
    } catch (error) {
      if (switched) {
        try {
          await atomicWriteJson(this.#pointerPath, transaction.previous)
          this.#active = transaction.previous
        } catch (rollbackError) {
          console.error('Web resource pointer rollback failed', {
            operationId,
            error: rollbackError
          })
          throw new ZToolsError(errorCodes.storageError, 'Web 更新失败且旧资源指针恢复失败')
        }
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(transactionPath, { force: true }).catch(() => undefined)
      throw error instanceof ZToolsError
        ? error
        : new ZToolsError(errorCodes.dataCorrupt, 'Web 更新包解压或切换失败')
    }
  }

  async #confirm(operationId: string): Promise<void> {
    if (!this.#initialized) throw new Error('Web 资源服务尚未初始化')
    if (this.#pendingOperationId !== operationId) return
    const transactionPath = path.join(this.#transactionRoot, `${operationId}.json`)
    await fs.rm(transactionPath, { force: true })
    await fs.rm(path.join(this.#stagingRoot, operationId), { recursive: true, force: true })
    this.#pendingOperationId = undefined
  }

  async #rollback(operationId: string): Promise<void> {
    if (!this.#initialized || !this.#active) throw new Error('Web 资源服务尚未初始化')
    const transactionPath = path.join(this.#transactionRoot, `${operationId}.json`)
    const value = await readJson(transactionPath)
    if (!isTransaction(value)) return
    const nextRoot = path.join(this.#versionsRoot, value.next.directory)
    if (
      !isSafeDirectoryName(value.next.directory) ||
      !isSafeDirectoryName(value.previous.directory) ||
      !isDirectChild(this.#versionsRoot, nextRoot) ||
      path.resolve(value.directory) !== path.resolve(nextRoot) ||
      !isDirectChild(this.#stagingRoot, value.staging) ||
      path.basename(path.resolve(value.staging)) !== value.operationId
    ) {
      throw new ZToolsError(errorCodes.dataCorrupt, 'Web 事务日志路径无效')
    }
    if (this.#active.operationId === value.next.operationId) {
      await validateWebRoot(path.join(this.#versionsRoot, value.previous.directory), value.previous.version)
      await atomicWriteJson(this.#pointerPath, value.previous)
      this.#active = value.previous
    }
    await fs.rm(nextRoot, { recursive: true, force: true })
    await fs.rm(value.staging, { recursive: true, force: true })
    await fs.rm(transactionPath, { force: true })
    this.#pendingOperationId = undefined
    console.warn('Web resource transaction rolled back', {
      operationId,
      restoredVersion: value.previous.version
    })
  }

  async #recoverTransactions(): Promise<void> {
    const entries = await fs.readdir(this.#transactionRoot, { withFileTypes: true })
    let active = await this.#readActivePointer()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const transactionPath = path.join(this.#transactionRoot, entry.name)
      const value = await readJson(transactionPath)
      const transactionDirectory = isTransaction(value) ? path.resolve(value.directory) : ''
      const stagingDirectory = isTransaction(value) ? path.resolve(value.staging) : ''
      if (
        !isTransaction(value) ||
        !isSafeDirectoryName(value.next.directory) ||
        !isSafeDirectoryName(value.previous.directory) ||
        !isDirectChild(this.#versionsRoot, transactionDirectory) ||
        path.basename(transactionDirectory) !== value.next.directory ||
        !isDirectChild(this.#stagingRoot, stagingDirectory) ||
        path.basename(stagingDirectory) !== value.operationId
      ) {
        await fs.rm(transactionPath, { force: true })
        continue
      }
      const nextRoot = transactionDirectory
      const nextIsValid = await validateWebRoot(nextRoot, value.next.version)
        .then(() => true)
        .catch(() => false)
      if (
        value.state === 'activated' &&
        nextIsValid &&
        (!active || active.operationId === value.previous.operationId)
      ) {
        await atomicWriteJson(this.#pointerPath, value.next)
        active = value.next
      }
      if (active?.operationId !== value.next.operationId) {
        await fs.rm(nextRoot, { recursive: true, force: true })
        await fs.rm(value.staging, { recursive: true, force: true })
      }
      await fs.rm(transactionPath, { force: true })
    }
  }

  async #readActivePointer(): Promise<ActivePointer | undefined> {
    const value = await readJson(this.#pointerPath)
    if (!isPointer(value) || !isSafeDirectoryName(value.directory)) return undefined
    if (!isWithin(this.#versionsRoot, path.join(this.#versionsRoot, value.directory))) return undefined
    try {
      await validateWebRoot(path.join(this.#versionsRoot, value.directory), value.version)
      return value
    } catch {
      return undefined
    }
  }

  async #extractArchive(archive: string, destination: string, signal: AbortSignal): Promise<void> {
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
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > ENTRY_EXPANDED_LIMIT
        ) {
          throw new ZToolsError(errorCodes.fileTooLarge, 'Web ZIP 单个文件超过大小限制')
        }
        expanded += entry.uncompressedSize
        if (entries > MAX_ARCHIVE_ENTRIES || expanded > WEB_EXPANDED_LIMIT) {
          throw new ZToolsError(errorCodes.fileTooLarge, 'Web ZIP 解压规模超过上限')
        }
        if (entry.isEncrypted() || !entry.canDecodeFileData() || isSymlink(entry)) {
          throw new ZToolsError(errorCodes.dataCorrupt, 'Web ZIP 包含不支持或不安全的条目')
        }
        const segments = validateArchivePath(entry.fileName)
        const relative = segments.join(path.sep)
        const target = path.resolve(destination, relative)
        if (!isWithin(destination, target) || target === path.resolve(destination)) {
          throw new ZToolsError(errorCodes.dataCorrupt, 'Web ZIP 路径越界')
        }
        const key = relative.toLowerCase()
        if (names.has(key)) {
          throw new ZToolsError(errorCodes.dataCorrupt, 'Web ZIP 包含大小写冲突或重复路径')
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
        : new ZToolsError(errorCodes.dataCorrupt, 'Web ZIP 损坏或无法解压')
    } finally {
      zip.close()
    }
  }
}
