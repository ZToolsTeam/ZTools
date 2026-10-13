import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { RuntimePaths } from './runtime-paths.js'

const execFileAsync = promisify(execFile)

interface RuntimeLockRecord {
  schemaVersion: 1
  pid: number
  ownerId: string
  businessDataRoot: string
  acquiredAt: string
}

export class RuntimeLock {
  readonly #path: string
  readonly #record: RuntimeLockRecord
  #handle: FileHandle | undefined

  private constructor(lockPath: string, record: RuntimeLockRecord, handle: FileHandle) {
    this.#path = lockPath
    this.#record = record
    this.#handle = handle
  }

  static async acquire(paths: RuntimePaths): Promise<RuntimeLock> {
    const lockPath = path.join(paths.transactionRoot, 'runtime.lock')
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    const record: RuntimeLockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      ownerId: paths.ownerId,
      businessDataRoot: paths.businessDataRoot,
      acquiredAt: new Date().toISOString()
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, 'wx')
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
          await handle.sync()
        } catch (error) {
          await handle.close()
          await fs.rm(lockPath, { force: true })
          throw error
        }
        return new RuntimeLock(lockPath, record, handle)
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw lockFailure(error)
        const existing = await readLockRecord(lockPath)
        if (existing && await isLockOwnerAlive(existing)) {
          throw new ZToolsError(
            errorCodes.databaseLocked,
            `ZTools 数据目录正在被进程 ${existing.pid} 使用`
          )
        }
        if (attempt === 1) {
          throw new ZToolsError(errorCodes.databaseLocked, 'ZTools 数据目录锁无法恢复')
        }
        const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
        try {
          await fs.rename(lockPath, stalePath)
        } catch (renameError) {
          throw lockFailure(renameError)
        }
      }
    }
    throw new ZToolsError(errorCodes.databaseLocked, 'ZTools 数据目录锁无法获取')
  }

  get lockPath(): string {
    return this.#path
  }

  get record(): RuntimeLockRecord {
    return this.#record
  }

  async release(): Promise<void> {
    const handle = this.#handle
    if (!handle) return
    this.#handle = undefined
    await handle.close()
    await fs.rm(this.#path, { force: true })
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function lockFailure(error: unknown): ZToolsError {
  const detail = error instanceof Error ? error.message.slice(0, 256) : '未知锁错误'
  return new ZToolsError(errorCodes.storageError, `创建 ZTools 数据锁失败: ${detail}`)
}

async function readLockRecord(lockPath: string): Promise<RuntimeLockRecord | undefined> {
  try {
    const source = await fs.readFile(lockPath, 'utf8')
    const value: unknown = JSON.parse(source)
    if (
      typeof value === 'object' && value !== null &&
      'pid' in value && typeof value.pid === 'number' &&
      'ownerId' in value && typeof value.ownerId === 'string' &&
      'businessDataRoot' in value && typeof value.businessDataRoot === 'string' &&
      'acquiredAt' in value && typeof value.acquiredAt === 'string'
    ) {
      return { schemaVersion: 1, pid: value.pid, ownerId: value.ownerId, businessDataRoot: value.businessDataRoot, acquiredAt: value.acquiredAt }
    }
  } catch {
    // A partial lock record is treated as stale and is quarantined by acquire().
  }
  return undefined
}

async function isLockOwnerAlive(record: RuntimeLockRecord): Promise<boolean> {
  const { pid } = record
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (errorCode(error) !== 'EPERM') return false
  }

  // A surviving PID can belong to a different process after a crash or reboot.
  // Older lock records already contain acquiredAt, so they can be recovered too.
  const acquiredAt = Date.parse(record.acquiredAt)
  if (process.platform !== 'win32' || !Number.isFinite(acquiredAt)) return true
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o')`
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const startedAt = Date.parse(stdout.trim())
    // Only reclaim when the current process provably started after this lock.
    return !Number.isFinite(startedAt) || startedAt <= acquiredAt
  } catch {
    // Access denied / unavailable helpers must not unlock a possibly live owner.
    return true
  }
}
