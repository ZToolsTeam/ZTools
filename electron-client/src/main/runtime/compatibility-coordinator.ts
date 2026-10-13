import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { legacyCefProfileRoot, type RuntimePaths } from './runtime-paths.js'

export type MigrationPhase =
  | 'DISCOVER'
  | 'LOCKED'
  | 'INVENTORIED'
  | 'SNAPSHOTTED'
  | 'STAGED'
  | 'VERIFIED'
  | 'COMMITTED'
  | 'READY'
  | 'RECOVERABLE_FAILURE'

interface AssetSummary {
  relativePath: string
  kind: 'file' | 'directory'
  bytes: number
  files: number
  directories: number
  modifiedAt: string
}

export interface MigrationJournalRecord {
  schemaVersion: 1
  migrationId: string
  operation: 'preflight'
  sourceLayoutVersion: string
  targetLayoutVersion: string
  sourceClientVersion: string
  targetClientVersion: string
  createdAt: string
  ownerId: string
  canonicalRoots: {
    businessDataRoot: string
    browserProfileRoot: string
    cacheRoot: string
    transactionRoot: string
    backupRoot: string
  }
  phase: MigrationPhase
  sourceFingerprint: string
  assets: AssetSummary[]
  snapshot: {
    status: 'not-required'
    reason: string
  }
  legacyBrowserStorage?: {
    sourceRoot: string
    status: 'available' | 'absent' | 'invalid'
    importMode: 'lazy-localstorage'
    indexedDb: 'unsupported'
    cookies: 'unsupported'
  }
  errorCode?: string
}

export interface CompatibilityCoordinatorOptions {
  targetClientVersion: string
  sourceClientVersion?: string
  now?: () => Date
}

const JOURNAL_FILE = 'current-migration.json'

export class CompatibilityCoordinator {
  readonly #paths: RuntimePaths
  readonly #targetClientVersion: string
  readonly #sourceClientVersion: string
  readonly #now: () => Date

  constructor(paths: RuntimePaths, options: CompatibilityCoordinatorOptions) {
    this.#paths = paths
    this.#targetClientVersion = options.targetClientVersion
    this.#sourceClientVersion = options.sourceClientVersion ?? 'unknown'
    this.#now = options.now ?? (() => new Date())
  }

  async prepare(): Promise<MigrationJournalRecord> {
    const existing = await this.#readJournal()
    if (existing) {
      if (existing.phase !== 'READY') {
        await this.#quarantineJournal(existing.phase)
      }
    }

    const migrationId = randomUUID()
    const base = this.#baseRecord(migrationId)
    await this.#writeJournal(base)

    try {
      const assets = await inventoryRoot(this.#paths.businessDataRoot)
      const sourceFingerprint = fingerprint(this.#paths, assets)
      const legacyBrowserStorage = await inspectLegacyBrowserStorage(
        legacyCefProfileRoot(this.#paths)
      )
      const inventoried: MigrationJournalRecord = {
        ...base,
        phase: 'INVENTORIED',
        sourceFingerprint,
        assets,
        legacyBrowserStorage
      }
      await this.#writeJournal(inventoried)

      // No format conversion is performed until a verified legacy fixture exists.
      // Keeping this explicit prevents a successful startup from being mistaken for a migration.
      const ready: MigrationJournalRecord = {
        ...inventoried,
        phase: 'READY',
        snapshot: {
          status: 'not-required',
          reason: '业务数据复用原位 JSON/LevelDB；旧 CEF localStorage 由插件 session 按需从关闭副本导入，IndexedDB/cookies 暂不导入'
        }
      }
      await this.#writeJournal(ready)
      return ready
    } catch (error) {
      const failure: MigrationJournalRecord = {
        ...base,
        phase: 'RECOVERABLE_FAILURE',
        errorCode: error instanceof ZToolsError ? error.code : errorCode(error) ?? errorCodes.storageError
      }
      try { await this.#writeJournal(failure) } catch { /* retain the original failure */ }
      throw error
    }
  }

  async #readJournal(): Promise<MigrationJournalRecord | undefined> {
    const filePath = path.join(this.#paths.transactionRoot, JOURNAL_FILE)
    try {
      const source = await fs.readFile(filePath, 'utf8')
      const value: unknown = JSON.parse(source)
      if (!isJournalRecord(value)) throw new Error('invalid journal shape')
      return value
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw new ZToolsError(errorCodes.dataCorrupt, '兼容迁移 journal 损坏，未自动覆盖或清理')
    }
  }

  async #quarantineJournal(phase: string): Promise<void> {
    const filePath = path.join(this.#paths.transactionRoot, JOURNAL_FILE)
    const recoveredPath = `${filePath}.recovered-${process.pid}-${randomUUID()}`
    try {
      await fs.rename(filePath, recoveredPath)
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 256) : '未知文件错误'
      throw new ZToolsError(
        errorCodes.storageError,
        `兼容预检 journal 处于 ${phase} 阶段且无法留档：${detail}`
      )
    }
  }

  #baseRecord(migrationId: string): MigrationJournalRecord {
    return {
      schemaVersion: 1,
      migrationId,
      operation: 'preflight',
      sourceLayoutVersion: 'legacy-data-root-v1',
      targetLayoutVersion: 'electron-data-root-v1',
      sourceClientVersion: this.#sourceClientVersion,
      targetClientVersion: this.#targetClientVersion,
      createdAt: this.#now().toISOString(),
      ownerId: this.#paths.ownerId,
      canonicalRoots: {
        businessDataRoot: this.#paths.businessDataRoot,
        browserProfileRoot: this.#paths.browserProfileRoot,
        cacheRoot: this.#paths.cacheRoot,
        transactionRoot: this.#paths.transactionRoot,
        backupRoot: this.#paths.backupRoot
      },
      phase: 'DISCOVER',
      sourceFingerprint: '',
      assets: [],
      snapshot: {
        status: 'not-required',
        reason: '预检尚未完成'
      }
    }
  }

  async #writeJournal(record: MigrationJournalRecord): Promise<void> {
    await fs.mkdir(this.#paths.transactionRoot, { recursive: true })
    const filePath = path.join(this.#paths.transactionRoot, JOURNAL_FILE)
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      })
      const handle = await fs.open(temporaryPath, 'r')
      try {
        try {
          await handle.sync()
        } catch (error) {
          if (!['EPERM', 'EINVAL', 'ENOSYS'].includes(errorCode(error) ?? '')) throw error
        }
      } finally { await handle.close() }
      await fs.rename(temporaryPath, filePath)
      committed = true
      await syncDirectory(this.#paths.transactionRoot)
    } finally {
      if (!committed) {
        // Keep a failed temporary journal for diagnosis; it is never read as current state.
      }
    }
  }
}

function isJournalRecord(value: unknown): value is MigrationJournalRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<MigrationJournalRecord>
  return record.schemaVersion === 1 &&
    typeof record.migrationId === 'string' &&
    record.operation === 'preflight' &&
    typeof record.phase === 'string' &&
    typeof record.sourceFingerprint === 'string' &&
    Array.isArray(record.assets) &&
    typeof record.canonicalRoots === 'object' && record.canonicalRoots !== null
}

async function inventoryRoot(root: string): Promise<AssetSummary[]> {
  try {
    const stats = await fs.lstat(root)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ZToolsError(errorCodes.storageError, '业务数据根不是普通目录')
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }

  const entries = await fs.readdir(root, { withFileTypes: true })
  return Promise.all(entries.map(async (entry) => {
    const relativePath = entry.name
    const target = path.join(root, entry.name)
    const summary = await summarizeEntry(target, entry.isDirectory())
    return { relativePath, ...summary }
  }))
}

async function summarizeEntry(
  target: string,
  directoryHint: boolean
): Promise<Omit<AssetSummary, 'relativePath'>> {
  const stats = await fs.lstat(target)
  if (stats.isSymbolicLink()) throw new ZToolsError(errorCodes.storageError, `资产包含重解析点: ${target}`)
  if (!directoryHint && stats.isFile()) {
    return {
      kind: 'file',
      bytes: stats.size,
      files: 1,
      directories: 0,
      modifiedAt: stats.mtime.toISOString()
    }
  }
  if (!stats.isDirectory()) throw new ZToolsError(errorCodes.storageError, `无法识别资产类型: ${target}`)
  const entries = await fs.readdir(target, { withFileTypes: true })
  let bytes = 0
  let files = 0
  let directories = 1
  for (const entry of entries) {
    const child = await summarizeEntry(path.join(target, entry.name), entry.isDirectory())
    bytes += child.bytes
    files += child.files
    directories += child.directories
  }
  return {
    kind: 'directory',
    bytes,
    files,
    directories,
    modifiedAt: stats.mtime.toISOString()
  }
}

function fingerprint(paths: RuntimePaths, assets: AssetSummary[]): string {
  return createHash('sha256').update(JSON.stringify({
    ownerId: paths.ownerId,
    businessDataRoot: paths.businessDataRoot,
    assets: [...assets].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  })).digest('hex')
}

async function inspectLegacyBrowserStorage(
  sourceRoot: string
): Promise<NonNullable<MigrationJournalRecord['legacyBrowserStorage']>> {
  try {
    const stats = await fs.lstat(sourceRoot)
    return {
      sourceRoot,
      status: stats.isDirectory() && !stats.isSymbolicLink() ? 'available' : 'invalid',
      importMode: 'lazy-localstorage',
      indexedDb: 'unsupported',
      cookies: 'unsupported'
    }
  } catch (error) {
    return {
      sourceRoot,
      status: errorCode(error) === 'ENOENT' ? 'absent' : 'invalid',
      importMode: 'lazy-localstorage',
      indexedDb: 'unsupported',
      cookies: 'unsupported'
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Windows does not support opening directories as file handles on every filesystem.
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
