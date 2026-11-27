import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolPathSlot
} from '../../../contracts/tool-runtime/common.js'
import type { PathGrantService } from '../../services/path-grant-service.js'
import { isHostCaller } from '../../ipc/plugin-principal.js'
import { isInternalPlugin } from '../../../contracts/capabilities.js'
import { createToolRuntimeError, isPlainObject } from './errors.js'

/**
 * 结构化路径槽位安全守卫（PathSlotGuard）：
 * - 统一校验 ToolPathSlot（grantId 授权句柄模式 或 受控显式 path 模式）；
 * - 严格拦截空字节 \0、.. 路径穿越、重解析点/符号链接逃逸；
 * - 先 realpath（目标不存在时对最近已存在祖先 realpath 再安全拼接）规范化后再匹配双端系统禁区；
 * - 参数化 platform，便于在 Windows 开发机直接单测 macOS 禁区规则；
 * - 强制拦截写入宿主自身受保护目录（DataRoot / CommonLibs / Libraries / Plugins 等）以及文件数量与体积上限。
 */

export const DEFAULT_MAX_FILES_PER_TASK = 64
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024 // 10 GiB
const MAX_PATH_LENGTH = 4096

export type PathSlotAccess = 'read' | 'write'
export type PathSlotExpectedKind = 'file' | 'directory' | 'any'

export interface PathSlotGrantAuthority {
  readonly reference: PathGrantService['reference']
  /** 可选：将已校验归属与权限的 grantId 解析为本地物理路径（仅在主进程受信任装配层提供） */
  readonly resolveGrantPath?: (owner: number, grantId: string) => Promise<string> | string
}

export interface PathSlotGuardOptions {
  readonly platform?: NodeJS.Platform
  /** 宿主自身受保护目录（禁止写入，如 DataRoot / CommonLibs / Libraries / Plugins / userData） */
  readonly protectedRoots?: readonly string[]
  /** 用户主目录覆盖（供跨平台单测 macOS ~/.ssh 等规则） */
  readonly homeDir?: string
  /** 单任务允许的最大路径槽位数（默认 64） */
  readonly maxFilesPerTask?: number
  /** 单文件最大读取字节数上限（默认 10 GiB） */
  readonly maxFileBytes?: number
  /** 可选对接 PathGrantService（或动态获取器，适配延迟挂载的 ReferenceRuntime） */
  readonly pathGrants?: PathSlotGrantAuthority | (() => PathSlotGrantAuthority | undefined)
  /** 可选对接 FileSystemService.resolveAuthorizedPath，为第三方插件显式 path 施加窗口路径授权检查 */
  readonly authorizeExplicitPath?: (
    rawPath: string,
    caller: CallerIdentity,
    access: PathSlotAccess,
    allowMissing: boolean
  ) => Promise<string>
  /** 可选：仅用于测试模拟平台路径校验，跳过真实磁盘 stat（默认为 false，生产严禁开启） */
  readonly skipDiskStatForSimulatedPlatform?: boolean
}

export interface ResolvePathSlotOptions {
  readonly access: PathSlotAccess
  readonly expectKind: PathSlotExpectedKind
  readonly allowMissing?: boolean
  readonly maxFileBytes?: number
}

export interface ResolvedPathSlot {
  readonly resolvedPath: string
  readonly displayName: string
  readonly viaGrant: boolean
  readonly sizeBytes?: number
}

function normalizeWindowsComparePath(raw: string): string {
  let normalized = raw.replace(/\//g, '\\')
  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4)
  }
  normalized = path.win32.normalize(normalized)
  while (normalized.length > 3 && normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized.toLowerCase()
}

function normalizePosixComparePath(raw: string): string {
  let normalized = path.posix.normalize(raw.replace(/\\/g, '/'))
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  // macOS 典型根符号链接规范化（即使目标不存在或跨平台单测时也能准确命中 /private/etc 与 /private/var）
  if (normalized === '/etc' || normalized.startsWith('/etc/')) {
    normalized = `/private${normalized}`
  } else if (normalized === '/var' || normalized.startsWith('/var/')) {
    normalized = `/private${normalized}`
  }
  return normalized
}

function isWithinNormalizedRoot(candidate: string, root: string, sep: '\\' | '/'): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate.startsWith(prefix)
}

/** 校验并拆解安全的相对子路径段（严禁 ..、绝对路径、盘符、空字节） */
function parseSafeRelativeSegments(relativePath: string, platform: NodeJS.Platform): string[] {
  if (typeof relativePath !== 'string' || relativePath.length > MAX_PATH_LENGTH || relativePath.includes('\0')) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Relative path is invalid or contains null byte'
    )
  }
  if (relativePath === '') return []
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:/.test(relativePath)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Relative path must not be absolute'
    )
  }
  if (platform === 'win32' && relativePath.includes('\\')) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Relative path must use forward slashes'
    )
  }
  const segments = relativePath.split('/')
  if (segments.length > 64) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Relative path exceeds maximum depth'
    )
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'Path traversal segment is forbidden'
      )
    }
    if (platform === 'win32' && /[:*?"<>|\u0000-\u001f]/.test(segment)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'Relative path contains illegal Windows characters'
      )
    }
  }
  return segments
}

/** 校验显式路径的基本静态合法性（禁止空字节、禁止 .. 穿越、禁止 UNC 路径、要求绝对路径） */
function assertStaticAbsolutePathSafe(rawPath: string, platform: NodeJS.Platform): void {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Path must be a non-empty string within length limit'
    )
  }
  if (rawPath.includes('\0') || /[\u0000-\u001f]/.test(rawPath)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Path contains illegal control or null bytes'
    )
  }
  // 禁止在任何段中出现 .. 穿越（包括 / 与 \ 混合）
  const segments = rawPath.split(/[\\/]+/)
  if (segments.some((seg) => seg === '..')) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.pathDenied,
      'Path traversal ("..") is forbidden in ToolPathSlot'
    )
  }
  if (platform === 'win32') {
    if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'UNC network paths are forbidden in ToolPathSlot'
      )
    }
    if (!/^[A-Za-z]:[\\/]/.test(rawPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'Windows path must be a fully qualified drive path'
      )
    }
  } else {
    if (!rawPath.startsWith('/')) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'POSIX path must be absolute'
      )
    }
  }
}

/** 校验 ToolPathSlot 结构体本身是否符合白名单字段 */
export function assertValidToolPathSlotStructure(slot: unknown, fieldName = 'slot'): asserts slot is ToolPathSlot {
  if (!isPlainObject(slot)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      `${fieldName} must be an object`,
      { fields: [fieldName] }
    )
  }
  const allowedKeys = new Set(['grantId', 'relativePath', 'path'])
  const unknownKeys = Object.keys(slot).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${fieldName} contains unknown fields: ${unknownKeys.join(', ')}`,
      { fields: unknownKeys }
    )
  }
  const hasGrantId = slot.grantId !== undefined
  const hasPath = slot.path !== undefined
  if (!hasGrantId && !hasPath) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      `${fieldName} must specify either grantId or path`,
      { fields: [fieldName] }
    )
  }
  if (hasGrantId && hasPath) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${fieldName} must not specify both grantId and path simultaneously`,
      { fields: [fieldName] }
    )
  }
  if (hasGrantId && (typeof slot.grantId !== 'string' || slot.grantId.length === 0 || slot.grantId.length > 256)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      `${fieldName}.grantId must be a valid non-empty string`,
      { fields: [`${fieldName}.grantId`] }
    )
  }
  if (slot.relativePath !== undefined && typeof slot.relativePath !== 'string') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      `${fieldName}.relativePath must be a string`,
      { fields: [`${fieldName}.relativePath`] }
    )
  }
  if (hasPath && (typeof slot.path !== 'string' || slot.path.length === 0 || slot.path.length > MAX_PATH_LENGTH)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      `${fieldName}.path must be a non-empty string`,
      { fields: [`${fieldName}.path`] }
    )
  }
}

export class PathSlotGuard {
  readonly #platform: NodeJS.Platform
  readonly #protectedRoots: readonly string[]
  readonly #homeDir: string
  readonly #maxFilesPerTask: number
  readonly #maxFileBytes: number
  readonly #pathGrantsOption?: PathSlotGrantAuthority | (() => PathSlotGrantAuthority | undefined)
  readonly #authorizeExplicitPath?: PathSlotGuardOptions['authorizeExplicitPath']
  readonly #skipDiskStatForSimulatedPlatform: boolean

  constructor(options: PathSlotGuardOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#protectedRoots = Object.freeze([...(options.protectedRoots ?? [])])
    this.#homeDir = options.homeDir ?? os.homedir()
    this.#maxFilesPerTask = Math.max(1, options.maxFilesPerTask ?? DEFAULT_MAX_FILES_PER_TASK)
    this.#maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    if (options.pathGrants !== undefined) {
      this.#pathGrantsOption = options.pathGrants
    }
    if (options.authorizeExplicitPath) {
      this.#authorizeExplicitPath = options.authorizeExplicitPath
    }
    this.#skipDiskStatForSimulatedPlatform = options.skipDiskStatForSimulatedPlatform ?? false
  }

  get platform(): NodeJS.Platform {
    return this.#platform
  }

  get maxFilesPerTask(): number {
    return this.#maxFilesPerTask
  }

  /** 批量校验并解析路径槽位（强制约束单任务最大文件数上限） */
  async resolveSlots(
    slots: readonly ToolPathSlot[],
    caller: CallerIdentity,
    options: ResolvePathSlotOptions
  ): Promise<readonly ResolvedPathSlot[]> {
    if (!Array.isArray(slots) || slots.length === 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'At least one path slot is required'
      )
    }
    if (slots.length > this.#maxFilesPerTask) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Too many files in a single task (max ${this.#maxFilesPerTask})`
      )
    }
    const resolved: ResolvedPathSlot[] = []
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]
      assertValidToolPathSlotStructure(slot, `inputs[${i}]`)
      resolved.push(await this.resolveSlot(slot, caller, options))
    }
    return resolved
  }

  /** 校验单个 ToolPathSlot，返回规范化后的安全本地绝对路径 */
  async resolveSlot(
    slot: ToolPathSlot,
    caller: CallerIdentity,
    options: ResolvePathSlotOptions
  ): Promise<ResolvedPathSlot> {
    assertValidToolPathSlotStructure(slot)

    let candidatePath: string
    let viaGrant = false

    if (slot.grantId !== undefined) {
      viaGrant = true
      const authority = this.#resolvePathGrantAuthority()
      if (!authority) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Path grant service is unavailable'
        )
      }
      let ref: ReturnType<PathGrantService['reference']>
      try {
        ref = authority.reference(caller.webContentsId, slot.grantId)
      } catch {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Path grant is invalid, expired, or does not belong to caller'
        )
      }
      // 核对句柄权限
      if (options.access === 'read' && !ref.operations.includes('read')) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Path grant does not permit read access'
        )
      }
      if (options.access === 'write' && !ref.operations.includes('write')) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Path grant does not permit write access'
        )
      }
      const relativeSegments = parseSafeRelativeSegments(slot.relativePath ?? '', this.#platform)
      if (relativeSegments.length > 0 && ref.kind !== 'directory') {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'relativePath is only allowed for directory grants'
        )
      }
      if (!authority.resolveGrantPath) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Physical path resolution for opaque grant is not enabled'
        )
      }
      const basePath = await authority.resolveGrantPath(caller.webContentsId, slot.grantId)
      assertStaticAbsolutePathSafe(basePath, this.#platform)
      const pathMod = this.#platform === 'win32' ? path.win32 : path.posix
      candidatePath = relativeSegments.length > 0
        ? pathMod.join(basePath, ...relativeSegments)
        : basePath
    } else {
      const rawPath = slot.path!
      assertStaticAbsolutePathSafe(rawPath, this.#platform)
      if (slot.relativePath !== undefined && slot.relativePath !== '') {
        const relativeSegments = parseSafeRelativeSegments(slot.relativePath, this.#platform)
        const pathMod = this.#platform === 'win32' ? path.win32 : path.posix
        candidatePath = pathMod.join(rawPath, ...relativeSegments)
      } else {
        candidatePath = rawPath
      }

      // 第三方插件传入显式路径时，通过宿主路径授权服务复核（宿主自身与 internal-* 免复核但仍受下方禁区约束）
      const isTrustedHost =
        isHostCaller(caller) || (caller.type === 'plugin' && isInternalPlugin(caller.pluginId))
      if (!isTrustedHost && this.#authorizeExplicitPath) {
        candidatePath = await this.#authorizeExplicitPath(
          candidatePath,
          caller,
          options.access,
          options.allowMissing === true
        )
      }
    }

    // 1. 先执行 realpath 规范化（目标不存在则回溯至最近已存在祖先目录再安全拼接），阻断符号链接/重解析点绕过
    const canonicalPath = await this.#canonicalizeWithRealpath(candidatePath)

    // 2. 在规范化路径上匹配双端系统禁区
    this.#assertNotInSystemForbiddenZone(canonicalPath)

    // 3. 双端宿主自保护：禁止写入 ZTools 自身受保护目录（DataRoot / CommonLibs / Libraries / Plugins 等）
    if (options.access === 'write') {
      await this.#assertNotInProtectedRoots(canonicalPath)
    }

    // 4. 在真实宿主机平台一致时执行磁盘存在性、类型与体积校验
    const sizeLimit = options.maxFileBytes ?? this.#maxFileBytes
    let sizeBytes: number | undefined
    const isSameOsAsGuard = this.#platform === process.platform
    if (isSameOsAsGuard && !this.#skipDiskStatForSimulatedPlatform) {
      const stat = await fs.lstat(canonicalPath).catch(() => null)
      if (stat && stat.isSymbolicLink()) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Symbolic link target is forbidden'
        )
      }
      if (!stat) {
        if (!options.allowMissing) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.pathDenied,
            'Target path does not exist'
          )
        }
      } else {
        if (options.expectKind === 'file' && !stat.isFile()) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.pathDenied,
            'Target path must be a regular file'
          )
        }
        if (options.expectKind === 'directory' && !stat.isDirectory()) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.pathDenied,
            'Target path must be a directory'
          )
        }
        if (stat.isFile()) {
          if (stat.size > sizeLimit) {
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.policyViolation,
              `File size exceeds maximum limit (${sizeLimit} bytes)`
            )
          }
          sizeBytes = stat.size
        }
      }
    }

    const pathMod = this.#platform === 'win32' ? path.win32 : path.posix
    return {
      resolvedPath: canonicalPath,
      displayName: pathMod.basename(canonicalPath),
      viaGrant,
      ...(sizeBytes !== undefined ? { sizeBytes } : {})
    }
  }

  /** 对外暴露双端系统禁区纯函数检查（便于直接复用与单测） */
  isSystemForbiddenPath(canonicalPath: string): boolean {
    if (this.#platform === 'win32') {
      return this.#isWindowsForbiddenPath(canonicalPath)
    }
    if (this.#platform === 'darwin') {
      return this.#isMacosForbiddenPath(canonicalPath)
    }
    return false
  }

  #resolvePathGrantAuthority(): PathSlotGrantAuthority | undefined {
    if (!this.#pathGrantsOption) return undefined
    return typeof this.#pathGrantsOption === 'function'
      ? this.#pathGrantsOption()
      : this.#pathGrantsOption
  }

  async #canonicalizeWithRealpath(targetPath: string): Promise<string> {
    if (this.#platform !== process.platform || this.#skipDiskStatForSimulatedPlatform) {
      return this.#platform === 'win32'
        ? path.win32.normalize(targetPath)
        : normalizePosixComparePath(targetPath)
    }

    // 目标存在时直接 realpath
    try {
      return await fs.realpath(targetPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Unable to resolve target path safely'
        )
      }
    }

    // 目标尚不存在：向上查找最近的已存在祖先目录做 realpath，再逐段安全拼接
    const pendingSegments: string[] = []
    let cursor = path.resolve(targetPath)
    while (true) {
      const parent = path.dirname(cursor)
      const base = path.basename(cursor)
      if (parent === cursor) {
        return path.resolve(targetPath)
      }
      pendingSegments.unshift(base)
      cursor = parent
      try {
        const realAncestor = await fs.realpath(cursor)
        return path.join(realAncestor, ...pendingSegments)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.pathDenied,
            'Unable to resolve parent directory safely'
          )
        }
      }
    }
  }

  #assertNotInSystemForbiddenZone(canonicalPath: string): void {
    if (this.isSystemForbiddenPath(canonicalPath)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.pathDenied,
        'Access to protected system directory is forbidden'
      )
    }
  }

  #isWindowsForbiddenPath(canonicalPath: string): boolean {
    const normalized = normalizeWindowsComparePath(canonicalPath)
    const driveMatch = /^([a-z]:)(.*)$/.exec(normalized)
    if (!driveMatch) return true
    const rest = driveMatch[2] ?? ''

    // 系统盘关键目录（C:\Windows、C:\Program Files、C:\Program Files (x86)、C:\ProgramData）及任意卷回收站/卷信息
    const driveRootPrefixes = [
      '\\windows',
      '\\program files',
      '\\program files (x86)',
      '\\programdata',
      '\\system volume information',
      '\\$recycle.bin'
    ]
    for (const prefix of driveRootPrefixes) {
      if (rest === prefix || rest.startsWith(`${prefix}\\`)) {
        return true
      }
    }
    // 用户敏感凭据目录（与 macOS ~/.ssh 保护对等收口）
    if (this.#homeDir) {
      const normalizedHome = normalizeWindowsComparePath(this.#homeDir)
      if (/^[a-z]:\\/.test(normalizedHome)) {
        const sshDir = `${normalizedHome}\\.ssh`
        if (isWithinNormalizedRoot(normalized, sshDir, '\\')) {
          return true
        }
      }
    }
    return false
  }

  #isMacosForbiddenPath(canonicalPath: string): boolean {
    const normalized = normalizePosixComparePath(canonicalPath)
    const lower = normalized.toLowerCase()

    // 系统核心根目录
    const macForbiddenRoots = [
      '/system',
      '/library',
      '/applications',
      '/usr',
      '/bin',
      '/sbin',
      '/private/etc',
      '/private/var'
    ]
    for (const root of macForbiddenRoots) {
      if (isWithinNormalizedRoot(lower, root, '/')) {
        return true
      }
    }
    // 禁止直接操作 /Volumes 根目录本身（允许 /Volumes/<DiskName>/... 子卷）
    if (lower === '/volumes') {
      return true
    }

    // 禁止敏感用户目录：~/.ssh、~/Library/Keychains、~/Library/LaunchAgents
    const normalizedHome = normalizePosixComparePath(this.#homeDir).toLowerCase()
    if (normalizedHome && normalizedHome !== '/') {
      const homeForbidden = [
        `${normalizedHome}/.ssh`,
        `${normalizedHome}/library/keychains`,
        `${normalizedHome}/library/launchagents`
      ]
      for (const secretRoot of homeForbidden) {
        if (isWithinNormalizedRoot(lower, secretRoot, '/')) {
          return true
        }
      }
    }
    return false
  }

  async #assertNotInProtectedRoots(canonicalPath: string): Promise<void> {
    if (this.#protectedRoots.length === 0) return
    const isWin = this.#platform === 'win32'
    const normalizedTarget = isWin
      ? normalizeWindowsComparePath(canonicalPath)
      : normalizePosixComparePath(canonicalPath).toLowerCase()

    for (const rawRoot of this.#protectedRoots) {
      if (!rawRoot) continue
      let resolvedRoot = rawRoot
      if (this.#platform === process.platform && !this.#skipDiskStatForSimulatedPlatform) {
        resolvedRoot = await fs.realpath(rawRoot).catch(() => path.resolve(rawRoot))
      }
      const normalizedRoot = isWin
        ? normalizeWindowsComparePath(resolvedRoot)
        : normalizePosixComparePath(resolvedRoot).toLowerCase()
      if (isWithinNormalizedRoot(normalizedTarget, normalizedRoot, isWin ? '\\' : '/')) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.pathDenied,
          'Writing to ZTools protected runtime directory is forbidden'
        )
      }
    }
  }
}
