import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ASSETS_PER_RECOVERY = 256
const MAX_RECOVERY_FILES = 100_000
const MAX_RECOVERY_BYTES = 2 * 1024 * 1024 * 1024

export interface PreservedPluginDataSnapshot {
  preservationId: string
  createdAt: string
  files: number
  directories: number
  bytes: number
  state: 'available' | 'invalid'
}

export interface PluginDataRecoveryResult {
  success: true
  pluginId: string
  preservationId: string
  restorationId: string
  assets: string[]
  files: number
  bytes: number
  relativeRoot: string
}

interface TreeSummary {
  files: number
  directories: number
  bytes: number
}

function validatePluginId(pluginId: string): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(pluginId)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'pluginId 格式无效')
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function isSafeDirectoryName(value: string): boolean {
  return value.length > 0 &&
    value.length <= 256 &&
    path.basename(value) === value &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0')
}

function normalizeAssetPath(value: string): string {
  if (value.length === 0 || value.length > 4096 || value.includes('\0')) {
    throw new ZToolsError(errorCodes.invalidRequest, '恢复资产路径无效')
  }
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, '恢复资产路径越界')
  }
  return segments.join(path.sep)
}

async function ordinaryDirectory(target: string): Promise<boolean> {
  const stats = await fs.lstat(target).catch(() => undefined)
  return Boolean(stats?.isDirectory() && !stats.isSymbolicLink())
}

async function summarizeTree(root: string): Promise<TreeSummary> {
  const summary: TreeSummary = { files: 0, directories: 0, bytes: 0 }
  const pending = [path.resolve(root)]
  while (pending.length > 0) {
    const current = pending.pop() as string
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据包含符号链接')
      if (entry.isDirectory()) {
        summary.directories += 1
        pending.push(target)
        continue
      }
      if (!entry.isFile()) throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据包含不支持的文件类型')
      const stats = await fs.stat(target)
      summary.files += 1
      summary.bytes += stats.size
      if (summary.files > MAX_RECOVERY_FILES || summary.bytes > MAX_RECOVERY_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, '插件历史数据超过恢复预算')
      }
    }
  }
  return summary
}

async function copyOrdinaryTree(
  source: string,
  destination: string,
  summary: TreeSummary
): Promise<void> {
  const stats = await fs.lstat(source)
  if (stats.isSymbolicLink()) throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据包含符号链接')
  if (stats.isDirectory()) {
    summary.directories += 1
    await fs.mkdir(destination, { recursive: false, mode: 0o700 })
    const entries = await fs.readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      await copyOrdinaryTree(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        summary
      )
    }
    return
  }
  if (!stats.isFile()) throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据包含不支持的文件类型')
  summary.files += 1
  summary.bytes += stats.size
  if (summary.files > MAX_RECOVERY_FILES || summary.bytes > MAX_RECOVERY_BYTES) {
    throw new ZToolsError(errorCodes.fileTooLarge, '插件历史数据超过恢复预算')
  }
  await fs.copyFile(source, destination)
}

function recoveryId(preservationId: string, assets: readonly string[]): string {
  const digest = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16)
  return `${preservationId}-${digest}`
}

export class PluginDataRecoveryService {
  readonly #dataRoot: string
  readonly #pluginDataRoot: string

  constructor(dataRoot: string) {
    this.#dataRoot = path.resolve(dataRoot)
    this.#pluginDataRoot = path.join(this.#dataRoot, 'PluginData')
  }

  async list(pluginId: string): Promise<{ success: true; data: PreservedPluginDataSnapshot[] }> {
    validatePluginId(pluginId)
    const legacyRoot = await this.#legacyRoot(pluginId, false)
    if (!legacyRoot) return { success: true, data: [] }
    const entries = await fs.readdir(legacyRoot, { withFileTypes: true })
    const data: PreservedPluginDataSnapshot[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeDirectoryName(entry.name)) continue
      const target = path.join(legacyRoot, entry.name)
      const stats = await fs.stat(target)
      try {
        const summary = await summarizeTree(target)
        data.push({
          preservationId: entry.name,
          createdAt: stats.birthtime.toISOString(),
          ...summary,
          state: 'available'
        })
      } catch {
        data.push({
          preservationId: entry.name,
          createdAt: stats.birthtime.toISOString(),
          files: 0,
          directories: 0,
          bytes: 0,
          state: 'invalid'
        })
      }
    }
    data.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    return { success: true, data }
  }

  async restore(
    pluginId: string,
    preservationId: string,
    requestedAssets: readonly string[]
  ): Promise<PluginDataRecoveryResult> {
    validatePluginId(pluginId)
    if (!isSafeDirectoryName(preservationId)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'preservationId 格式无效')
    }
    if (requestedAssets.length === 0 || requestedAssets.length > MAX_ASSETS_PER_RECOVERY) {
      throw new ZToolsError(errorCodes.invalidRequest, '恢复资产列表为空或超过上限')
    }
    const assets = requestedAssets.map(normalizeAssetPath)
    const keys = new Set<string>()
    for (const asset of assets) {
      const key = asset.toLocaleLowerCase('en-US')
      if (keys.has(key)) throw new ZToolsError(errorCodes.invalidRequest, '恢复资产包含重复路径')
      keys.add(key)
    }
    const legacyRoot = await this.#legacyRoot(pluginId, true)
    if (!legacyRoot) throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据目录不存在')
    const sourceRoot = path.join(legacyRoot, preservationId)
    if (!isWithin(legacyRoot, sourceRoot) || !(await ordinaryDirectory(sourceRoot))) {
      throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据快照不存在或不是普通目录')
    }
    const sourceStats = await summarizeTree(sourceRoot)
    if (sourceStats.files > MAX_RECOVERY_FILES || sourceStats.bytes > MAX_RECOVERY_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, '插件历史数据超过恢复预算')
    }
    const restoredRoot = path.join(this.#pluginDataRoot, pluginId, 'restored')
    const restoredStats = await fs.lstat(restoredRoot).catch(() => undefined)
    if (restoredStats && (!restoredStats.isDirectory() || restoredStats.isSymbolicLink())) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件恢复目录不是普通目录')
    }
    await fs.mkdir(restoredRoot, { recursive: true, mode: 0o700 })
    if (!(await ordinaryDirectory(restoredRoot))) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件恢复目录不是普通目录')
    }
    const restorationId = recoveryId(preservationId, assets)
    const destination = path.join(restoredRoot, restorationId)
    if (!isWithin(restoredRoot, destination)) {
      throw new ZToolsError(errorCodes.permissionDenied, '恢复目标路径越界')
    }
    const manifestPath = path.join(destination, '.ztools-recovery.json')
    const existingManifest = await fs.readFile(manifestPath, 'utf8').catch(() => undefined)
    if (existingManifest !== undefined) {
      let value: Record<string, unknown>
      try {
        value = JSON.parse(existingManifest) as Record<string, unknown>
      } catch {
        throw new ZToolsError(errorCodes.dataCorrupt, '恢复记录损坏')
      }
      if (
        value.pluginId === pluginId &&
        value.preservationId === preservationId &&
        Array.isArray(value.assets) &&
        JSON.stringify(value.assets) === JSON.stringify(assets)
      ) {
        return {
          success: true,
          pluginId,
          preservationId,
          restorationId,
          assets: [...assets],
          files: Number(value.files) || 0,
          bytes: Number(value.bytes) || 0,
          relativeRoot: path.relative(this.#dataRoot, destination)
        }
      }
      throw new ZToolsError(errorCodes.storageError, '恢复目标已存在且内容不匹配')
    }
    if (await fs.lstat(destination).then(() => true, () => false)) {
      throw new ZToolsError(errorCodes.storageError, '恢复目标已存在但缺少有效记录')
    }

    const copied: TreeSummary = { files: 0, directories: 0, bytes: 0 }
    try {
      await fs.mkdir(destination, { recursive: false, mode: 0o700 })
      for (const asset of assets) {
        const source = path.resolve(sourceRoot, asset)
        if (!isWithin(sourceRoot, source) || source === path.resolve(sourceRoot)) {
          throw new ZToolsError(errorCodes.invalidRequest, '恢复资产路径越界')
        }
        const target = path.resolve(destination, asset)
        if (!isWithin(destination, target) || path.basename(target) === '.ztools-recovery.json') {
          throw new ZToolsError(errorCodes.invalidRequest, '恢复资产目标路径无效')
        }
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await copyOrdinaryTree(source, target, copied)
      }
      const record = {
        schemaVersion: 1,
        pluginId,
        preservationId,
        assets,
        files: copied.files,
        bytes: copied.bytes,
        createdAt: new Date().toISOString()
      }
      await fs.writeFile(manifestPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return {
      success: true,
      pluginId,
      preservationId,
      restorationId,
      assets: [...assets],
      files: copied.files,
      bytes: copied.bytes,
      relativeRoot: path.relative(this.#dataRoot, destination)
    }
  }

  async #legacyRoot(pluginId: string, required: boolean): Promise<string | undefined> {
    const dataStats = await fs.lstat(this.#pluginDataRoot).catch(() => undefined)
    if (dataStats && (!dataStats.isDirectory() || dataStats.isSymbolicLink())) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件数据根不是普通目录')
    }
    await fs.mkdir(this.#pluginDataRoot, { recursive: true, mode: 0o700 })
    const pluginRoot = path.join(this.#pluginDataRoot, pluginId)
    if (!(await ordinaryDirectory(pluginRoot))) {
      if (required) throw new ZToolsError(errorCodes.dataCorrupt, '插件数据目录不是普通目录')
      return undefined
    }
    const legacyRoot = path.join(pluginRoot, 'legacy')
    if (!(await fs.lstat(legacyRoot).then((stats) => stats.isDirectory() && !stats.isSymbolicLink(), () => false))) {
      if (required) throw new ZToolsError(errorCodes.dataCorrupt, '插件历史数据目录不是普通目录')
      return undefined
    }
    return legacyRoot
  }
}
