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
const RESULT_GRANT_TTL_MS = 30 * 60 * 1000
const MAX_RESULT_GRANTS_PER_CALLER = 20_000
const RESULT_GRANT_CONCURRENCY = 16

/**
 * 访问级别。trash 只给 shell_trash_item 使用：普通 write 授权，或满足条件的扫描 / 搜索结果授权（见 #allowsResultTrash）。
 */
type Access = 'read' | 'write' | 'trash'

/** 宿主自己产生并返回给调用窗口的路径来源（结果授权） */
export type ResultGrantSource =
  | 'search'
  | 'dir-scan'
  | 'process'
  | 'screenshot'
  | 'common-folder'
  | 'system-path'
  | 'handoff'

export interface ResultGrantEntry {
  path: string
  isDir: boolean
}

export interface ResultGrantSummary {
  granted: number
  skipped: number
}

/**
 * 结果授权：只读、精确路径、不递归；只有文件搜索 / dir: 扫描出的普通文件才可能带回收站权限。
 * 这不是保密边界（任何调用者都能 dir: 扫描任意目录拿到只读授权），防的是插件自己拼出来 / 从外部拿到的路径被直接打开或删除。
 */
interface ResultGrant {
  read: true
  trash: boolean
  ownerPluginId?: string
  source: ResultGrantSource
  expiresAt: number
}

const TRASH_RESULT_SOURCES: ReadonlySet<ResultGrantSource> = new Set(['search', 'dir-scan'])
/**
 * 结果来自目录内容（用户或别的程序可以在里面放符号链接）的来源：结果本身是符号链接时不登记，
 * 否则一个指向 ~/.ssh、/etc 等处的链接就能让真实目标变得可读。
 */
const LINK_CHECKED_SOURCES: ReadonlySet<ResultGrantSource> = new Set(['search', 'dir-scan', 'screenshot'])

/** 结果授权表的键：规范化后的真实路径；Windows（NTFS 默认不区分大小写）转小写，其余平台保持原样，查不中按未授权处理 */
export function resultGrantKey(canonicalPath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = normalizeForCompare(canonicalPath)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 结果授权按「产生结果的插件」分开存放：插件 A 扫出的路径只给 A 用（别的插件带自己的令牌或不带令牌都用不了）；
 * 宿主自身（未归属调用）产生的结果不属于任何插件，同一窗口里都能读（与 42d5de0 一致）。
 */
function resultTableKey(ownerPluginId: string | undefined, pathKey: string): string {
  return `${(ownerPluginId ?? '').toLowerCase()}\u0000${pathKey}`
}

/** key 等于 root 或位于 root 之下（两者都是 resultGrantKey 的结果） */
function resultKeyWithin(key: string, rootKey: string): boolean {
  const prefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`
  return key === rootKey || key.startsWith(prefix)
}

/** 调用者用来查结果授权的插件身份：只有主窗口的会话归属算数 */
function resultOwnerOf(caller: CallerIdentity): string | undefined {
  return caller.type === 'main' ? caller.attributedPlugin?.pluginId : undefined
}

export interface ResultGrantOptions {
  /** dir: 扫描的根目录：结果的真实路径必须在根目录的真实路径之内（防止经由子目录里的符号链接跳出扫描范围） */
  scanRoot?: string
}

/** 结果授权不放行回收站的系统目录（宿主数据目录由构造参数追加） */
export function defaultProtectedTrashRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === 'win32') {
    return [
      env.SystemRoot || env.WINDIR || 'C:\\Windows',
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      env.ProgramData || 'C:\\ProgramData'
    ]
  }
  // 不整体列入 /private：macOS 的 TMPDIR 在 /private/var/folders，清理临时文件会被误拦
  return ['/System', '/usr', '/bin', '/sbin']
}

/** transferGrants 的结果：转交 / 跳过的路径数，以及撤销本次转交的函数（新窗口加载失败时用） */
export interface GrantTransfer {
  transferred: number
  dropped: number
  revoke(): void
}

const MAX_TRANSFER_PATHS = 2000

export interface FileSystemServiceOptions {
  /** 追加的回收站保护根（如宿主 userData / 业务数据目录） */
  protectedTrashRoots?: readonly string[]
}

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
  // Map 的插入顺序即最近授权顺序（重复授权先删后插），超出上限从头淘汰
  readonly #resultGrants = new Map<number, Map<string, ResultGrant>>()
  readonly #protectedTrashRoots: readonly string[]
  #protectedTrashKeys: Promise<string[]> | undefined
  readonly #capabilities = new Map<string, FileCapability>()
  readonly #currentDirectories = new Map<number, string>()
  readonly #writeSessions = new Map<string, WriteSession>()
  readonly #removeListener: () => void

  constructor(
    private readonly registry: WindowRegistry,
    private readonly cacheRoot: string,
    private readonly now: () => number = Date.now,
    pathSemantics: PathSemanticsAdapter = createPathSemanticsAdapter(process.platform),
    options: FileSystemServiceOptions = {}
  ) {
    this.#pathSemantics = pathSemantics
    this.#protectedTrashRoots = [...defaultProtectedTrashRoots(), ...(options.protectedTrashRoots ?? [])]
    this.#removeListener = registry.onRemoved((webContentsId) => {
      this.#closedCallers.add(webContentsId)
      this.#grants.delete(webContentsId)
      this.#resultGrants.delete(webContentsId)
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
    this.#resultGrants.clear()
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

  /** Search results belong only to the requesting host window, without directory recursion or write access. */
  async grantSearchResult(value: string, caller: CallerIdentity): Promise<void> {
    if (caller.type !== 'main') {
      throw new ZToolsError(errorCodes.permissionDenied, '仅宿主窗口可以接收搜索结果授权')
    }
    this.#assertCallerAvailable(caller)
    const target = await this.#canonical(value, false)
    this.#assertCallerAvailable(caller)
    this.#storeResultGrants(caller, [{ key: resultGrantKey(target), trash: false }], 'search', false)
  }

  /**
   * 把宿主自己产生、即将返回给调用窗口的路径登记为结果授权（只读、精确路径、不递归）。
   * - 只给 type:'main' 调用者（与 42d5de0 一致；插件窗口暂不授权）；
   * - 已消失 / 非法 / 非绝对路径跳过并计入 skipped，不报错；
   * - 目录内容类来源（search / dir-scan / screenshot）的结果本身是符号链接时跳过；dir-scan 的结果真实路径必须在扫描根之内；
   * - 授权归属产生结果的插件（会话归属），别的插件用不了；
   * - 回收站权限只给：search / dir-scan 来源 + 归属插件声明了 fs + 原始路径 lstat 是普通文件且不是符号链接 + 不在系统 / 宿主数据目录；
   * - 登记期间窗口关闭则整体失败，不会给已关闭的窗口留授权。
   */
  async grantResultPaths(
    caller: CallerIdentity,
    entries: readonly ResultGrantEntry[],
    source: ResultGrantSource,
    options: ResultGrantOptions = {}
  ): Promise<ResultGrantSummary> {
    if (caller.type !== 'main') {
      throw new ZToolsError(errorCodes.permissionDenied, '仅宿主窗口可以接收结果路径授权')
    }
    this.#assertCallerAvailable(caller)
    const owner = caller.attributedPlugin
    const trashCapable = TRASH_RESULT_SOURCES.has(source) && owner?.permissions.has('fs') === true
    const checkLinks = LINK_CHECKED_SOURCES.has(source)
    // 扫描根的真实路径；解析失败（根目录已不存在等）时任何结果都不在范围内
    let rootKey: string | null | undefined
    if (options.scanRoot !== undefined) {
      try {
        if (!path.isAbsolute(options.scanRoot)) throw new Error('scanRoot 必须是绝对路径')
        rootKey = resultGrantKey(await fs.realpath(path.resolve(options.scanRoot)))
      } catch {
        rootKey = null
      }
    }
    let skipped = 0
    const unique = new Map<string, boolean>()
    for (const entry of entries) {
      const value = typeof entry?.path === 'string' ? entry.path : ''
      if (!value || !path.isAbsolute(value)) {
        skipped += 1
        continue
      }
      // 同一路径被不同条目标成文件 / 目录时按目录处理（不给回收站）
      unique.set(value, unique.get(value) === true || entry.isDir !== false)
    }
    const candidates = [...unique].slice(0, MAX_RESULT_GRANTS_PER_CALLER)
    skipped += unique.size - candidates.length

    const table = this.#resultGrants.get(caller.webContentsId)
    const now = this.now()
    // 按结果顺序落表（并发完成顺序不确定），保证淘汰顺序可预期
    const resolved: Array<{ key: string; trash: boolean } | undefined> = new Array(candidates.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const index = cursor++
        const [value, isDir] = candidates[index]!
        // 只读刷新的快速路径：原始路径本身已是有效键，说明它就是真实路径，只续期不新增访问
        if (!(trashCapable && !isDir)) {
          const fastKey = resultGrantKey(value)
          const existing = table?.get(resultTableKey(owner?.pluginId, fastKey))
          if (existing && existing.expiresAt > now) {
            resolved[index] = { key: fastKey, trash: false }
            continue
          }
        }
        try {
          this.#pathSemantics.validatePathInput(value)
          const key = resultGrantKey(await this.#canonical(value, false))
          // 结果本身是符号链接：真实目标可能在任何地方，不登记
          if (checkLinks && (await fs.lstat(value)).isSymbolicLink()) {
            skipped += 1
            continue
          }
          // 经由扫描目录里的目录链接跳到扫描根之外的结果：不登记
          if (rootKey !== undefined && (rootKey === null || !resultKeyWithin(key, rootKey))) {
            skipped += 1
            continue
          }
          resolved[index] = { key, trash: trashCapable && !isDir && await this.#isTrashableResultFile(value, key) }
        } catch {
          // 扫描与登记之间文件被删、无权限、非法路径：跳过
          skipped += 1
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(RESULT_GRANT_CONCURRENCY, candidates.length) }, worker))
    this.#assertCallerAvailable(caller)
    const granted = resolved.filter((item): item is { key: string; trash: boolean } => item !== undefined)
    this.#storeResultGrants(caller, granted, source, trashCapable)
    return { granted: granted.length, skipped }
  }

  /**
   * 弹出独立窗口时把源窗口对 paths 已有的授权转交给新窗口（只由 WindowService 在 window_open 带 handoff 时调用）。
   * - 目标得到的授权不超过源窗口：精确路径、读 / 写标志与过期时间沿用源授权；源授权是递归的且该路径是目录时，
   *   目标以该路径为根递归（子树 ⊆ 源授权范围）；结果授权原样复制 trash 与 ownerPluginId；
   * - 源窗口没有授权、已消失、非法的路径计入 dropped；目标已有的授权不改动（回收站权限只升级不降级）；
   * - 结果授权只转交归属 ownerPluginId（弹出的那个插件）的与不属于任何插件的，别的插件扫出的结果不跟着走；
   * - 只接受 type:'main' 的源与目标，且两者不能是同一窗口；任一窗口在转交中关闭则撤销已转交的部分并报错。
   */
  async transferGrants(
    source: CallerIdentity,
    targetWebContentsId: number,
    paths: readonly string[],
    ownerPluginId?: string
  ): Promise<GrantTransfer> {
    if (source.type !== 'main') {
      throw new ZToolsError(errorCodes.permissionDenied, '仅宿主窗口可以转交路径授权')
    }
    this.#assertCallerAvailable(source)
    const target = this.registry.get(targetWebContentsId)
    if (!target || target.type !== 'main' || target.webContentsId === source.webContentsId) {
      throw new ZToolsError(errorCodes.permissionDenied, '路径授权只能转交给另一个宿主窗口')
    }
    this.#assertCallerAvailable(target)

    let dropped = 0
    const unique: string[] = []
    const seen = new Set<string>()
    for (const value of Array.isArray(paths) ? paths : []) {
      if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
        dropped += 1
        continue
      }
      if (seen.has(value)) continue
      seen.add(value)
      unique.push(value)
    }
    dropped += Math.max(0, unique.length - MAX_TRANSFER_PATHS)
    const candidates = unique.slice(0, MAX_TRANSFER_PATHS)

    const now = this.now()
    const sourceGrants = (this.#grants.get(source.webContentsId) ?? []).filter((grant) => grant.expiresAt > now)
    const resultCopies: Array<{ key: string; grant: ResultGrant }> = []
    const grantCopies: PathGrant[] = []
    let transferred = 0
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const value = candidates[cursor++]!
        try {
          this.#pathSemantics.validatePathInput(value)
          const canonical = await this.#canonical(value, false)
          let covered = false
          const owners = ownerPluginId ? [ownerPluginId, undefined] : [undefined]
          for (const owner of owners) {
            const resultGrant = this.#lookupResultGrant(source.webContentsId, canonical, owner)
            if (!resultGrant) continue
            resultCopies.push({
              key: resultTableKey(owner, resultGrantKey(canonical)),
              grant: { ...resultGrant, source: 'handoff' }
            })
            covered = true
          }
          let isDirectory: boolean | undefined
          for (const grant of sourceGrants) {
            const exact = await samePathOnVolume(grant.path, canonical)
            if (!exact && !(grant.recursive && await pathHasPrefixOnVolume(grant.path, canonical))) continue
            let recursive = false
            if (grant.recursive) {
              isDirectory ??= (await fs.stat(canonical)).isDirectory()
              recursive = isDirectory
            }
            grantCopies.push({ path: canonical, recursive, read: grant.read, write: grant.write, expiresAt: grant.expiresAt })
            covered = true
          }
          if (covered) transferred += 1
          else dropped += 1
        } catch {
          dropped += 1
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(RESULT_GRANT_CONCURRENCY, candidates.length) }, worker))

    const addedResults: Array<{ key: string; inserted: ResultGrant; previous?: ResultGrant }> = []
    const addedGrants: PathGrant[] = []
    const revoke = (): void => {
      const table = this.#resultGrants.get(targetWebContentsId)
      for (const { key, inserted, previous } of addedResults) {
        if (table?.get(key) !== inserted) continue
        if (previous) table.set(key, previous)
        else table.delete(key)
      }
      const grants = this.#grants.get(targetWebContentsId)
      if (grants && addedGrants.length > 0) {
        this.#grants.set(targetWebContentsId, grants.filter((grant) => !addedGrants.includes(grant)))
      }
      addedResults.length = 0
      addedGrants.length = 0
    }

    try {
      this.#assertCallerAvailable(source)
      this.#assertCallerAvailable(target)
      if (resultCopies.length > 0) {
        const table = this.#resultGrants.get(targetWebContentsId) ?? new Map<string, ResultGrant>()
        for (const { key, grant } of resultCopies) {
          const previous = table.get(key)
          const previousValid = previous && previous.expiresAt > now ? previous : undefined
          // 目标已有有效授权时不改动，只有源带回收站而目标没有时升级
          if (previousValid && (previousValid.trash || !grant.trash)) continue
          table.delete(key)
          table.set(key, grant)
          addedResults.push({ key, inserted: grant, ...(previousValid ? { previous: previousValid } : {}) })
        }
        this.#trimResultTable(table, now)
        this.#resultGrants.set(targetWebContentsId, table)
      }
      for (const copy of grantCopies) {
        const added = await this.#grant(target, copy.path, copy.recursive, copy.read, copy.write, copy.expiresAt)
        if (added) addedGrants.push(added)
      }
      this.#assertCallerAvailable(source)
    } catch (error) {
      revoke()
      throw error
    }
    return { transferred, dropped, revoke }
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
    const requested = path.resolve(base, value)
    const target = await this.#canonical(requested, allowMissing)
    const cache = await this.#cacheRoot(caller)
    this.#assertCallerAvailable(caller)
    if (await pathHasPrefixOnVolume(cache, target)) return target

    // 结果授权：O(1) 精确查表；只放行读取与满足条件的回收站，写入一律回落到下面的普通授权
    if (access !== 'write') {
      // 先查调用插件自己的结果，再查不属于任何插件的（宿主自身产生的）结果
      const owner = resultOwnerOf(caller)
      const resultGrant = (owner ? this.#lookupResultGrant(caller.webContentsId, target, owner) : undefined) ??
        this.#lookupResultGrant(caller.webContentsId, target, undefined)
      if (resultGrant) {
        if (access === 'read') return target
        if (await this.#allowsResultTrash(resultGrant, caller, requested, target)) {
          this.#assertCallerAvailable(caller)
          return target
        }
      }
    }

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

  #storeResultGrants(
    caller: CallerIdentity,
    resolved: ReadonlyArray<{ key: string; trash: boolean }>,
    source: ResultGrantSource,
    trashCapable: boolean
  ): void {
    if (resolved.length === 0) return
    const now = this.now()
    const ownerPluginId = resultOwnerOf(caller)
    const table = this.#resultGrants.get(caller.webContentsId) ?? new Map<string, ResultGrant>()
    for (const { key: pathKey, trash } of resolved) {
      const key = resultTableKey(ownerPluginId, pathKey)
      const previous = table.get(key)
      // 重复授权先删后插（移到最近位置）。同一插件不能给回收站的登记（进程列表等）不收回它扫描得到的回收站权限；
      // 能给回收站的登记（有 fs 的插件重新扫描）以最新一次核对结果为准
      const keep = !trashCapable && previous?.trash === true && previous.expiresAt > now ? previous : undefined
      table.delete(key)
      table.set(key, {
        read: true,
        trash: keep ? true : trash,
        ...(ownerPluginId ? { ownerPluginId } : {}),
        source: keep ? keep.source : source,
        expiresAt: now + RESULT_GRANT_TTL_MS
      })
    }
    this.#trimResultTable(table, now)
    this.#resultGrants.set(caller.webContentsId, table)
  }

  /** 插入顺序即最近顺序：从头清掉过期项，再按上限淘汰最旧（转交来的授权过期时间不晚于源授权，也按此处理） */
  #trimResultTable(table: Map<string, ResultGrant>, now: number): void {
    for (const [key, grant] of table) {
      if (grant.expiresAt > now && table.size <= MAX_RESULT_GRANTS_PER_CALLER) break
      table.delete(key)
    }
  }

  #lookupResultGrant(webContentsId: number, target: string, ownerPluginId: string | undefined): ResultGrant | undefined {
    const table = this.#resultGrants.get(webContentsId)
    if (!table) return undefined
    const key = resultTableKey(ownerPluginId, resultGrantKey(target))
    const grant = table.get(key)
    if (!grant) return undefined
    if (grant.expiresAt <= this.now()) {
      table.delete(key)
      return undefined
    }
    return grant
  }

  /** 结果授权的回收站放行：执行时重新核对，任何一项不满足都回落到普通 write 授权 */
  async #allowsResultTrash(
    grant: ResultGrant,
    caller: CallerIdentity,
    requested: string,
    target: string
  ): Promise<boolean> {
    if (!grant.trash || !grant.ownerPluginId) return false
    const owner = caller.type === 'main' ? caller.attributedPlugin : undefined
    if (!owner || owner.pluginId !== grant.ownerPluginId || !owner.permissions.has('fs')) return false
    try {
      // 请求路径本身是符号链接时不放行（否则会把链接目标移入回收站）；目标必须仍是普通文件
      const [requestedStats, targetStats] = await Promise.all([fs.lstat(requested), fs.lstat(target)])
      if (requestedStats.isSymbolicLink() || !targetStats.isFile()) return false
    } catch {
      return false
    }
    return !await this.#isProtectedTrashKey(resultGrantKey(target))
  }

  async #isTrashableResultFile(value: string, key: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(value)
      if (!stats.isFile() || stats.isSymbolicLink()) return false
    } catch {
      return false
    }
    return !await this.#isProtectedTrashKey(key)
  }

  async #isProtectedTrashKey(key: string): Promise<boolean> {
    this.#protectedTrashKeys ??= Promise.all(this.#protectedTrashRoots
      .filter((root) => typeof root === 'string' && path.isAbsolute(root))
      .map(async (root) => {
        const absolute = path.resolve(root)
        const real = await fs.realpath(absolute).catch(() => absolute)
        return [resultGrantKey(absolute), resultGrantKey(real)]
      })).then((keys) => [...new Set(keys.flat())])
    const roots = await this.#protectedTrashKeys
    return roots.some((root) => resultKeyWithin(key, root))
  }

  /**
   * 登记普通授权（按窗口串行）。transferredExpiresAt 只给 transferGrants 用：沿用源授权的过期时间，
   * 目标已有相同授权时不改动，返回新增的授权对象以便撤销；普通登记照旧续期，返回值可忽略。
   */
  async #grant(
    caller: CallerIdentity,
    target: string,
    recursive: boolean,
    read: boolean,
    write: boolean,
    transferredExpiresAt?: number
  ): Promise<PathGrant | undefined> {
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
      let added: PathGrant | undefined
      if (transferredExpiresAt !== undefined) {
        if (!existing) {
          added = { path: target, recursive, read, write, expiresAt: transferredExpiresAt }
          grants.push(added)
        }
      } else if (existing) {
        existing.expiresAt = now + GRANT_TTL_MS
      } else {
        grants.push({ path: target, recursive, read, write, expiresAt: now + GRANT_TTL_MS })
      }
      this.#grants.set(ownerId, grants)
      return added
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
