import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  FileCacheParams,
  FileCombineParams,
  FileCopyParams,
  FileFindParams,
  FileReadChunkParams,
  FilePathParams,
  FileReadParams,
  FileWriteChunkParams,
  FileWriteParams,
  FileWriteStartParams
} from '../../contracts/method-params.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import { createPathSemanticsAdapter } from '../platform/path-semantics.js'
import type { PathSemanticsAdapter } from '../platform/path-semantics.js'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_FILE_CHUNK_BYTES = 2 * 1024 * 1024
const MAX_STREAM_FILE_BYTES = 4 * 1024 * 1024 * 1024
const STREAM_TTL_MS = 10 * 60 * 1000
const MAX_WRITE_SESSIONS_PER_CALLER = 16
const MAX_DIRECTORY_ENTRIES = 10_000
const GRANT_TTL_MS = 60 * 60 * 1000
const MAX_CAPABILITIES_PER_CALLER = 256
const RENAME_RETRY_DELAYS_MS = [25, 100, 250] as const

type Access = 'read' | 'write'

interface FileCapability {
  path: string
  webContentsId: number
  readable: boolean
  expiresAt: number
}

interface FileInfo {
  name: string
  size: number
  isDirectory: boolean
  lastModified: string
  attributes: number
}

interface WriteSession {
  handle: string
  webContentsId: number
  target: string
  temporary: string
  totalSize: number
  written: number
  file: import('node:fs/promises').FileHandle
  expiresAt: number
}

interface PathGrant {
  path: string
  recursive: boolean
  read: boolean
  write: boolean
  expiresAt: number
}

export function fileFailure(error: unknown): ZToolsError {
  if (error instanceof ZToolsError) return error
  if (errorCode(error) === 'EEXIST') return new ZToolsError(errorCodes.fileAlreadyExists, '输出已存在，未覆盖')
  if (errorCode(error) === 'ENOSPC') return new ZToolsError(errorCodes.diskFull, '磁盘空间不足')
  if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
    return new ZToolsError(errorCodes.permissionDenied, '文件操作权限不足')
  }
  return new ZToolsError(errorCodes.fileError, '文件操作失败')
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

type CaseSensitivity = 'sensitive' | 'insensitive' | 'unknown'

function normalizeForCompare(value: string): string {
  const normalized = path.normalize(value)
  return normalized === path.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, '')
}

function toggleAsciiCase(value: string): string | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x61 && code <= 0x7a) {
      return `${value.slice(0, index)}${String.fromCharCode(code - 0x20)}${value.slice(index + 1)}`
    }
    if (code >= 0x41 && code <= 0x5a) {
      return `${value.slice(0, index)}${String.fromCharCode(code + 0x20)}${value.slice(index + 1)}`
    }
  }
  return undefined
}

function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

async function detectCaseSensitivity(directory: string): Promise<CaseSensitivity> {
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch {
    return 'unknown'
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES) return 'unknown'

  const names = new Set(entries)
  for (const name of entries) {
    const alternateName = toggleAsciiCase(name)
    if (!alternateName || alternateName === name) continue
    if (names.has(alternateName)) return 'sensitive'

    try {
      const [original, alternate] = await Promise.all([
        fs.lstat(path.join(directory, name), { bigint: true }),
        fs.lstat(path.join(directory, alternateName), { bigint: true })
      ])
      return original.dev === alternate.dev && original.ino === alternate.ino
        ? 'insensitive'
        : 'sensitive'
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'sensitive'
      return 'unknown'
    }
  }
  return 'unknown'
}

function samePathRoot(left: string, right: string): boolean {
  if (left === right) return true
  return process.platform === 'win32' && /^[A-Za-z]:\\$/i.test(left) && /^[A-Za-z]:\\$/i.test(right) &&
    left[0]?.toLowerCase() === right[0]?.toLowerCase()
}

async function samePathComponent(parent: string, left: string, right: string): Promise<boolean> {
  if (left === right) return true

  let entries: string[]
  try {
    entries = await fs.readdir(parent)
  } catch {
    throw new ZToolsError(errorCodes.permissionDenied, '无法确认目标目录的大小写语义')
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new ZToolsError(errorCodes.permissionDenied, '目标目录过大，无法确认大小写语义')
  }
  if (entries.includes(left) && entries.includes(right)) return false

  try {
    const [leftStats, rightStats] = await Promise.all([
      fs.lstat(path.join(parent, left), { bigint: true }),
      fs.lstat(path.join(parent, right), { bigint: true })
    ])
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new ZToolsError(errorCodes.permissionDenied, '无法确认目标目录的大小写语义')
    }
    if (asciiCaseFold(left) !== asciiCaseFold(right)) return false
    const caseSensitivity = await detectCaseSensitivity(parent)
    if (caseSensitivity === 'unknown') {
      throw new ZToolsError(errorCodes.permissionDenied, '无法确认目标目录的大小写语义')
    }
    return caseSensitivity === 'insensitive'
  }
}

async function pathHasPrefixOnVolume(root: string, target: string): Promise<boolean> {
  const normalizedRoot = normalizeForCompare(root)
  const normalizedTarget = normalizeForCompare(target)
  const rootPathRoot = path.parse(normalizedRoot).root
  const targetPathRoot = path.parse(normalizedTarget).root
  if (!samePathRoot(rootPathRoot, targetPathRoot)) return false

  const rootParts = path.relative(rootPathRoot, normalizedRoot).split(path.sep).filter(Boolean)
  const targetParts = path.relative(targetPathRoot, normalizedTarget).split(path.sep).filter(Boolean)
  if (rootParts.length > targetParts.length) return false

  let parent = rootPathRoot
  for (let index = 0; index < rootParts.length; index += 1) {
    const rootPart = rootParts[index]
    const targetPart = targetParts[index]
    if (rootPart === undefined || targetPart === undefined) return false
    if (!await samePathComponent(parent, rootPart, targetPart)) return false
    parent = path.join(parent, rootPart)
  }
  return true
}

async function samePathOnVolume(left: string, right: string): Promise<boolean> {
  const normalizedLeft = normalizeForCompare(left)
  const normalizedRight = normalizeForCompare(right)
  if (normalizedLeft === normalizedRight) return true
  if (!samePathRoot(path.parse(normalizedLeft).root, path.parse(normalizedRight).root)) return false

  const leftParts = path.relative(path.parse(normalizedLeft).root, normalizedLeft).split(path.sep).filter(Boolean)
  const rightParts = path.relative(path.parse(normalizedRight).root, normalizedRight).split(path.sep).filter(Boolean)
  if (leftParts.length !== rightParts.length) return false
  return pathHasPrefixOnVolume(normalizedLeft, normalizedRight)
}

export async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || delay === undefined) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function wildcardRegex(pattern: string, caseSensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`, caseSensitive ? '' : 'i')
}

function capabilityToken(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'ztools:' ||
      url.hostname !== 'file' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    ) return undefined
    const token = url.pathname.split('/').filter(Boolean)[0]
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

function rawFileUrlPath(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'ztools:' ||
      url.hostname !== 'file' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      capabilityToken(value)
    ) return undefined
    let decoded = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:[\\/]/.test(decoded)) decoded = decoded.slice(1)
    return decoded || undefined
  } catch {
    return undefined
  }
}

export class FileSystemService {
  readonly #pathSemantics: PathSemanticsAdapter
  readonly #closedCallers = new Set<number>()
  #stopped = false
  readonly #grants = new Map<number, PathGrant[]>()
  // Path comparison is asynchronous, so serialize grant updates by WebContents owner.
  readonly #grantTails = new Map<number, Promise<void>>()
  readonly #capabilities = new Map<string, FileCapability>()
  readonly #currentDirectories = new Map<number, string>()
  readonly #writeSessions = new Map<string, WriteSession>()
  readonly #removeListener: () => void

  constructor(
    private readonly registry: WindowRegistry,
    private readonly cacheRoot: string,
    private readonly now: () => number = Date.now,
    pathSemantics: PathSemanticsAdapter = createPathSemanticsAdapter(process.platform)
  ) {
    this.#pathSemantics = pathSemantics
    this.#removeListener = registry.onRemoved((webContentsId) => {
      this.#closedCallers.add(webContentsId)
      this.#grants.delete(webContentsId)
      this.#currentDirectories.delete(webContentsId)
      for (const session of [...this.#writeSessions.values()]) {
        if (session.webContentsId === webContentsId) void this.#cleanupWriteSession(session)
      }
      for (const [token, capability] of this.#capabilities) {
        if (capability.webContentsId === webContentsId) this.#capabilities.delete(token)
      }
    })
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#removeListener()
    this.#grants.clear()
    this.#grantTails.clear()
    this.#currentDirectories.clear()
    this.#capabilities.clear()
    await Promise.all([...this.#writeSessions.values()].map((session) => this.#cleanupWriteSession(session)))
  }

  async grantOpenPath(value: string, caller: CallerIdentity): Promise<string | undefined> {
    const target = await this.#canonical(value, false)
    const stats = await fs.stat(target)
    await this.#grant(caller, target, stats.isDirectory(), true, false)
    return stats.isFile() ? this.#issueFileCapability(target, caller, true) : undefined
  }

  async grantSavePath(value: string, caller: CallerIdentity): Promise<string> {
    const target = await this.#canonical(value, true)
    await this.#grant(caller, target, false, false, true)
    return this.#issueFileCapability(target, caller, false)
  }

  async grantFolder(value: string, caller: CallerIdentity): Promise<void> {
    const target = await this.#canonical(value, false)
    const stats = await fs.stat(target)
    if (!stats.isDirectory()) throw new ZToolsError(errorCodes.invalidRequest, '授权目标不是目录')
    await this.#grant(caller, target, true, true, true)
  }

  async readFile(params: FileReadParams, caller: CallerIdentity): Promise<{ success: true; content: string; size: number }> {
    try {
      const target = await this.resolveAuthorizedPath(params.path, caller, 'read', false)
      const handle = await fs.open(target, 'r')
      try {
        const stats = await handle.stat()
        if (!stats.isFile()) throw new ZToolsError(errorCodes.fileError, '目标不是文件')
        if (stats.size > MAX_FILE_BYTES) {
          throw new ZToolsError(errorCodes.fileTooLarge, '文件超过 16 MiB IPC 上限')
        }
        const data = await handle.readFile()
        const content = params.encoding === 'base64'
          ? data.toString('base64')
          : new TextDecoder('utf-8', { fatal: true }).decode(data)
        return { success: true, content, size: data.byteLength }
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async writeFile(params: FileWriteParams, caller: CallerIdentity): Promise<{ success: true; size: number }> {
    try {
      const data = params.encoding === 'base64'
        ? Buffer.from(params.content, 'base64')
        : Buffer.from(params.content, 'utf8')
      if (data.byteLength > MAX_FILE_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, '文件超过 16 MiB IPC 上限')
      }
      const target = await this.resolveAuthorizedPath(params.path, caller, 'write', true)
      await this.#writeData(target, data, params.overwrite !== false)
      return { success: true, size: data.byteLength }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async readCache(params: FileCacheParams, caller: CallerIdentity): Promise<{ success: true; content: string; size: number }> {
    return this.readFile({ path: await this.#cachePath(params.relativePath, caller), encoding: params.encoding }, caller)
  }

  async writeCache(params: FileCacheParams, caller: CallerIdentity): Promise<{ success: true; size: number }> {
    if (params.content === undefined) throw new ZToolsError(errorCodes.invalidRequest, 'content 字段缺失')
    return this.writeFile({
      path: await this.#cachePath(params.relativePath, caller),
      encoding: params.encoding,
      content: params.content
    }, caller)
  }

  async writeGeneratedCacheFile(
    relativePath: string,
    data: Buffer,
    caller: CallerIdentity
  ): Promise<{ path: string; size: number }> {
    if (data.byteLength > MAX_FILE_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, '生成文件超过 16 MiB 缓存上限')
    }
    try {
      const target = await this.#cachePath(relativePath, caller)
      await this.#writeData(target, data)
      return { path: target, size: data.byteLength }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async deleteFile(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'write', false)
    try {
      await fs.unlink(target)
      return { success: true }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async copyFile(params: FileCopyParams, caller: CallerIdentity): Promise<{ success: true }> {
    const source = await this.resolveAuthorizedPath(params.sourcePath, caller, 'read', false)
    const target = await this.resolveAuthorizedPath(params.destPath, caller, 'write', true)
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(source, target)
      return { success: true }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async moveFile(params: FileCopyParams, caller: CallerIdentity): Promise<{ success: true }> {
    const source = await this.resolveAuthorizedPath(params.sourcePath, caller, 'write', false)
    const target = await this.resolveAuthorizedPath(params.destPath, caller, 'write', true)
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(source, target)
      return { success: true }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async fileExists(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true; exists: boolean }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'read', true)
    try {
      return { success: true, exists: (await fs.stat(target)).isFile() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { success: true, exists: false }
      throw fileFailure(error)
    }
  }

  async getFileSize(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true; size: number }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'read', false)
    try {
      const stats = await fs.stat(target)
      return { success: true, size: stats.isFile() ? stats.size : -1 }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async createDirectory(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'write', true)
    try {
      await fs.mkdir(target, { recursive: true })
      return { success: true }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async deleteDirectory(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'write', false)
    try {
      await fs.rm(target, { recursive: true })
      return { success: true }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async directoryExists(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true; exists: boolean }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'read', true)
    try {
      return { success: true, exists: (await fs.stat(target)).isDirectory() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { success: true, exists: false }
      throw fileFailure(error)
    }
  }

  async getDirectoryContents(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true; files: FileInfo[] }> {
    return { success: true, files: await this.#list(params.path, caller) }
  }

  async getCurrentDirectory(caller: CallerIdentity): Promise<{ success: true; path: string }> {
    return { success: true, path: await this.#currentDirectory(caller) }
  }

  async setCurrentDirectory(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.resolveAuthorizedPath(params.path, caller, 'read', false)
    try {
      if (!(await fs.stat(target)).isDirectory()) throw new ZToolsError(errorCodes.fileError, '目标不是目录')
      this.#currentDirectories.set(caller.webContentsId, target)
      return { success: true }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async find(params: FileFindParams, caller: CallerIdentity, directories: boolean): Promise<{ success: true; files: FileInfo[] }> {
    const files = await this.#list(params.path, caller, true)
    if (files.length === 0) return { success: true, files: [] }
    const target = await this.resolveAuthorizedPath(params.path, caller, 'read', false)
    const caseSensitivity = await detectCaseSensitivity(target)
    if (caseSensitivity === 'unknown') {
      throw new ZToolsError(errorCodes.permissionDenied, '无法确认目标目录的大小写语义')
    }
    const matcher = wildcardRegex(params.pattern, caseSensitivity === 'sensitive')
    return {
      success: true,
      files: files.filter((item) => item.isDirectory === directories && matcher.test(path.basename(item.name)))
    }
  }

  async getFullPath(params: FilePathParams, caller: CallerIdentity): Promise<{ success: true; path: string }> {
    this.#pathSemantics.validatePathInput(params.path)
    const base = await this.#currentDirectory(caller)
    return { success: true, path: path.resolve(base, params.path) }
  }

  combinePath(params: FileCombineParams): { success: true; path: string } {
    this.#pathSemantics.validatePathInput(params.path1)
    this.#pathSemantics.validatePathInput(params.path2)
    return { success: true, path: path.join(params.path1, params.path2) }
  }

  getFileName(params: FilePathParams): { success: true; name: string } {
    this.#pathSemantics.validatePathInput(params.path)
    return { success: true, name: path.basename(params.path) }
  }

  getExtension(params: FilePathParams): { success: true; extension: string } {
    this.#pathSemantics.validatePathInput(params.path)
    return { success: true, extension: path.extname(params.path) }
  }

  getParentDirectory(params: FilePathParams): { success: true; path: string } {
    this.#pathSemantics.validatePathInput(params.path)
    return { success: true, path: path.dirname(params.path) }
  }

  async getScopedCachePath(caller: CallerIdentity): Promise<string> {
    return this.#cacheRoot(caller)
  }

  async getScopedTempPath(caller: CallerIdentity): Promise<string> {
    const target = path.join(await this.#cacheRoot(caller), 'Temp')
    await fs.mkdir(target, { recursive: true })
    return this.#canonical(target, false)
  }

  async prepareMainProtocolRoots(): Promise<{ cache: string; temp: string }> {
    const cache = path.join(this.cacheRoot, 'main')
    const temp = path.join(cache, 'Temp')
    await fs.mkdir(temp, { recursive: true })
    return {
      cache: await this.#canonical(cache, false),
      temp: await this.#canonical(temp, false)
    }
  }

  async readFileChunk(
    params: FileReadChunkParams,
    caller: CallerIdentity
  ): Promise<{ success: true; content: string; offset: number; size: number; totalSize: number }> {
    try {
      const target = await this.resolveAuthorizedPath(params.path, caller, 'read', false)
      const file = await fs.open(target, 'r')
      try {
        const stats = await file.stat()
        if (!stats.isFile()) throw new ZToolsError(errorCodes.fileError, '目标不是文件')
        if (stats.size > MAX_STREAM_FILE_BYTES) {
          throw new ZToolsError(errorCodes.fileTooLarge, '文件超过分块读取上限')
        }
        if (params.offset >= stats.size) {
          return { success: true, content: '', offset: params.offset, size: 0, totalSize: stats.size }
        }
        const length = Math.min(params.length, stats.size - params.offset, MAX_FILE_CHUNK_BYTES)
        const buffer = Buffer.allocUnsafe(length)
        const result = await file.read(buffer, 0, length, params.offset)
        return {
          success: true,
          content: buffer.subarray(0, result.bytesRead).toString('base64'),
          offset: params.offset,
          size: result.bytesRead,
          totalSize: stats.size
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async readCacheChunk(
    relativePath: string,
    offset: number,
    length: number,
    caller: CallerIdentity
  ): Promise<{ success: true; content: string; offset: number; size: number; totalSize: number }> {
    return this.readFileChunk({
      path: await this.#cachePath(relativePath, caller),
      offset,
      length
    }, caller)
  }

  async startWrite(
    params: FileWriteStartParams,
    caller: CallerIdentity
  ): Promise<{ success: true; handle: string; totalSize: number }> {
    if (!Number.isSafeInteger(params.totalSize) || params.totalSize < 0 || params.totalSize > MAX_STREAM_FILE_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, '文件超过分块写入上限')
    }
    const active = [...this.#writeSessions.values()]
      .filter((session) => session.webContentsId === caller.webContentsId)
    if (active.length >= MAX_WRITE_SESSIONS_PER_CALLER) {
      throw new ZToolsError(errorCodes.fileError, '当前窗口的写入句柄数量超过上限')
    }
    try {
      const target = await this.resolveAuthorizedPath(params.path, caller, 'write', true)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const handle = randomBytes(24).toString('base64url')
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${handle}.tmp`)
      const file = await fs.open(temporary, 'wx')
      const session: WriteSession = {
        handle,
        webContentsId: caller.webContentsId,
        target,
        temporary,
        totalSize: params.totalSize,
        written: 0,
        file,
        expiresAt: this.now() + STREAM_TTL_MS
      }
      this.#writeSessions.set(handle, session)
      return { success: true, handle, totalSize: params.totalSize }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async startCacheWrite(
    relativePath: string,
    totalSize: number,
    caller: CallerIdentity
  ): Promise<{ success: true; handle: string; totalSize: number }> {
    return this.startWrite({
      path: await this.#cachePath(relativePath, caller),
      totalSize
    }, caller)
  }

  async writeChunk(
    params: FileWriteChunkParams,
    caller: CallerIdentity
  ): Promise<{ success: true; written: number; totalSize: number }> {
    const session = await this.#getWriteSession(params.handle, caller)
    try {
      const data = Buffer.from(params.content, 'base64')
      if (data.byteLength === 0 || data.byteLength > MAX_FILE_CHUNK_BYTES) {
        throw new ZToolsError(errorCodes.invalidRequest, '写入分块为空或过大')
      }
      if (params.offset !== session.written || params.offset + data.byteLength > session.totalSize) {
        throw new ZToolsError(errorCodes.invalidRequest, '写入分块偏移不连续')
      }
      const result = await session.file.write(data, 0, data.byteLength, params.offset)
      if (result.bytesWritten !== data.byteLength) {
        throw new ZToolsError(errorCodes.fileError, '写入分块未完成')
      }
      session.written += data.byteLength
      session.expiresAt = this.now() + STREAM_TTL_MS
      return { success: true, written: session.written, totalSize: session.totalSize }
    } catch (error) {
      throw fileFailure(error)
    }
  }

  async finishWrite(
    handle: string,
    caller: CallerIdentity
  ): Promise<{ success: true; size: number }> {
    const session = await this.#getWriteSession(handle, caller)
    if (session.written !== session.totalSize) {
      throw new ZToolsError(errorCodes.invalidRequest, '写入内容尚未完成')
    }
    this.#writeSessions.delete(handle)
    try {
      await session.file.close()
      await replaceFile(session.temporary, session.target)
      return { success: true, size: session.totalSize }
    } catch (error) {
      await fs.rm(session.temporary, { force: true }).catch(() => undefined)
      throw fileFailure(error)
    }
  }

  async cancelWrite(handle: string, caller: CallerIdentity): Promise<{ success: true }> {
    const session = await this.#getWriteSession(handle, caller)
    await this.#cleanupWriteSession(session)
    return { success: true }
  }

  async preparePluginProtocolRoots(pluginId: string): Promise<{ cache: string; temp: string }> {
    const caller: CallerIdentity = {
      type: 'plugin',
      webContentsId: 0,
      pluginId
    }
    const cache = await this.#cacheRoot(caller)
    const temp = path.join(cache, 'Temp')
    await fs.mkdir(temp, { recursive: true })
    return {
      cache,
      temp: await this.#canonical(temp, false)
    }
  }

  async resolveAuthorizedPath(
    value: string,
    caller: CallerIdentity,
    access: Access,
    allowMissing: boolean
  ): Promise<string> {
    this.#assertCallerAvailable(caller)
    this.#pathSemantics.validatePathInput(value)
    const base = await this.#currentDirectory(caller)
    const target = await this.#canonical(path.resolve(base, value), allowMissing)
    const cache = await this.#cacheRoot(caller)
    this.#assertCallerAvailable(caller)
    if (await pathHasPrefixOnVolume(cache, target)) return target

    const now = this.now()
    const grants = (this.#grants.get(caller.webContentsId) ?? []).filter((grant) => grant.expiresAt > now)
    this.#grants.set(caller.webContentsId, grants)
    let allowed = false
    for (const grant of grants) {
      if (access === 'read' ? !grant.read : !grant.write) continue
      if (grant.recursive ? await pathHasPrefixOnVolume(grant.path, target) : await samePathOnVolume(grant.path, target)) {
        allowed = true
        break
      }
    }
    if (!allowed) throw new ZToolsError(errorCodes.permissionDenied, '路径未由当前窗口授权')
    return target
  }

  /** Main-only route provenance; this does not authorize a reader or perform filesystem I/O. */
  claimsFileCapabilityUrl(value: string): boolean {
    if (this.#stopped) return false
    const token = capabilityToken(value)
    return !!token && this.#capabilities.has(token)
  }

  canLoadFileCapability(value: string, webContentsId: number): boolean {
    const token = capabilityToken(value)
    if (!token) return false
    const capability = this.#capabilities.get(token)
    if (!capability || capability.expiresAt <= this.now()) {
      if (capability) this.#capabilities.delete(token)
      return false
    }
    return capability.webContentsId === webContentsId && capability.readable
  }

  async resolveFileCapability(value: string, webContentsId?: number): Promise<string> {
    const token = capabilityToken(value)
    if (!token) throw new ZToolsError(errorCodes.permissionDenied, '文件 capability URL 无效')
    const capability = this.#capabilities.get(token)
    if (!capability || capability.expiresAt <= this.now()) {
      if (capability) this.#capabilities.delete(token)
      throw new ZToolsError(errorCodes.permissionDenied, '文件 capability 已过期')
    }
    if (!capability.readable) {
      throw new ZToolsError(errorCodes.permissionDenied, '文件 capability 不允许读取')
    }
    if (webContentsId !== undefined && capability.webContentsId !== webContentsId) {
      throw new ZToolsError(errorCodes.permissionDenied, '文件 capability 不属于当前窗口')
    }
    const target = await this.#canonical(capability.path, false)
    if (!await samePathOnVolume(target, capability.path)) {
      throw new ZToolsError(errorCodes.permissionDenied, '文件 capability 目标已变化')
    }
    if (!(await fs.stat(target)).isFile()) throw new ZToolsError(errorCodes.fileError, '目标不是文件')
    return target
  }

  async #grant(caller: CallerIdentity, target: string, recursive: boolean, read: boolean, write: boolean): Promise<void> {
    this.#assertCallerAvailable(caller)
    const ownerId = caller.webContentsId
    const previous = this.#grantTails.get(ownerId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.#grantTails.set(ownerId, tail)

    try {
      await previous
      this.#assertCallerAvailable(caller)
      const now = this.now()
      const grants = (this.#grants.get(ownerId) ?? []).filter((grant) => grant.expiresAt > now)
      let existing: PathGrant | undefined
      for (const grant of grants) {
        if (grant.recursive !== recursive || grant.read !== read || grant.write !== write) continue
        if (await samePathOnVolume(grant.path, target)) {
          existing = grant
          break
        }
      }
      this.#assertCallerAvailable(caller)
      if (existing) existing.expiresAt = now + GRANT_TTL_MS
      else grants.push({ path: target, recursive, read, write, expiresAt: now + GRANT_TTL_MS })
      this.#grants.set(ownerId, grants)
    } finally {
      release()
      if (this.#grantTails.get(ownerId) === tail) this.#grantTails.delete(ownerId)
    }
  }

  canLoadFileUrl(value: string, webContentsId: number): boolean {
    void value
    if (this.canLoadFileCapability(value, webContentsId)) return true
    return false
  }

  authorizeFileUrl(value: string, webContentsId: number): string | undefined {
    void value
    if (this.canLoadFileCapability(value, webContentsId)) return value
    return undefined
  }

  async resolveFileUrl(value: string, webContentsId?: number): Promise<string> {
    if (capabilityToken(value)) return this.resolveFileCapability(value, webContentsId)
    if (webContentsId === undefined) {
      throw new ZToolsError(errorCodes.permissionDenied, '文件 URL 缺少调用者身份')
    }
    const caller = this.registry.get(webContentsId)
    const target = rawFileUrlPath(value)
    if (!caller || !target) throw new ZToolsError(errorCodes.permissionDenied, '文件 URL 无效')
    return this.resolveAuthorizedPath(target, caller, 'read', false)
  }

  async #writeData(target: string, data: Buffer, overwrite = true): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, data, { flag: 'wx' })
      if (overwrite) await replaceFile(temporary, target)
      else await fs.link(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  #assertCallerAvailable(caller: CallerIdentity): void {
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '文件服务已停止')
    if (this.#closedCallers.has(caller.webContentsId)) {
      throw new ZToolsError(errorCodes.permissionDenied, '文件授权窗口已关闭')
    }
  }

  #issueFileCapability(target: string, caller: CallerIdentity, readable: boolean): string {
    this.#assertCallerAvailable(caller)
    const now = this.now()
    for (const [token, capability] of this.#capabilities) {
      if (capability.expiresAt <= now) this.#capabilities.delete(token)
    }
    const callerCapabilityCount = [...this.#capabilities.values()]
      .filter((capability) => capability.webContentsId === caller.webContentsId).length
    if (callerCapabilityCount >= MAX_CAPABILITIES_PER_CALLER) {
      throw new ZToolsError(errorCodes.fileError, '当前窗口的文件 capability 数量超过上限')
    }
    const token = randomBytes(32).toString('base64url')
    this.#capabilities.set(token, {
      path: target,
      webContentsId: caller.webContentsId,
      readable,
      expiresAt: now + GRANT_TTL_MS
    })
    return `ztools://file/${token}/${encodeURIComponent(path.basename(target))}`
  }

  async #cacheRoot(caller: CallerIdentity): Promise<string> {
    const target = this.#cacheRootPath(caller)
    await fs.mkdir(target, { recursive: true })
    return this.#canonical(target, false)
  }

  #cacheRootPath(caller: CallerIdentity): string {
    const pluginScope = Buffer.from(caller.pluginId ?? 'unregistered', 'utf8').toString('base64url')
    const scope = caller.type === 'plugin' ? `plugin-${pluginScope}` : 'main'
    return path.join(this.cacheRoot, scope)
  }

  async #cachePath(relativePath: string, caller: CallerIdentity): Promise<string> {
    const root = await this.#cacheRoot(caller)
    const target = path.resolve(root, relativePath)
    if (!isWithin(root, target)) throw new ZToolsError(errorCodes.invalidRequest, '缓存路径越界')
    return target
  }

  async #currentDirectory(caller: CallerIdentity): Promise<string> {
    return this.#currentDirectories.get(caller.webContentsId) ?? this.#cacheRoot(caller)
  }

  async #getWriteSession(handle: string, caller: CallerIdentity): Promise<WriteSession> {
    const session = this.#writeSessions.get(handle)
    if (!session || session.webContentsId !== caller.webContentsId) {
      throw new ZToolsError(errorCodes.permissionDenied, '写入句柄未授权')
    }
    if (session.expiresAt <= this.now()) {
      await this.#cleanupWriteSession(session)
      throw new ZToolsError(errorCodes.requestTimeout, '写入句柄已过期')
    }
    return session
  }

  async #cleanupWriteSession(session: WriteSession): Promise<void> {
    if (this.#writeSessions.get(session.handle) === session) this.#writeSessions.delete(session.handle)
    await session.file.close().catch(() => undefined)
    await fs.rm(session.temporary, { force: true }).catch(() => undefined)
  }

  async #canonical(value: string, allowMissing: boolean): Promise<string> {
    this.#pathSemantics.validatePathInput(value)
    const absolute = path.resolve(value)
    try {
      return await fs.realpath(absolute)
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileFailure(error)
    }

    const missing: string[] = []
    let cursor = absolute
    while (true) {
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new ZToolsError(errorCodes.fileError, '无法解析路径祖先')
      missing.unshift(path.basename(cursor))
      cursor = parent
      try {
        const realParent = await fs.realpath(cursor)
        return path.join(realParent, ...missing)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileFailure(error)
      }
    }
  }

  async #list(value: string, caller: CallerIdentity, fullPath = false): Promise<FileInfo[]> {
    const target = await this.resolveAuthorizedPath(value, caller, 'read', false)
    try {
      const entries = await fs.readdir(target, { withFileTypes: true })
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw new ZToolsError(errorCodes.fileError, '目录条目超过 10000 上限')
      }
      return await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(target, entry.name)
        const stats = await fs.lstat(entryPath)
        const isDirectory = entry.isDirectory()
        return {
          name: fullPath ? entryPath : entry.name,
          size: isDirectory ? 0 : stats.size,
          isDirectory,
          lastModified: stats.mtime.toLocaleString(),
          attributes: isDirectory ? 16 : 32
        }
      }))
    } catch (error) {
      throw fileFailure(error)
    }
  }
}
