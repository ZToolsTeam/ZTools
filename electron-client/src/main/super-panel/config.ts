import path from 'node:path'

/**
 * 悬浮条全类型固定配置解析与迁移契约。
 *
 * v2 起将原先分散在 `plugin_state.json`（`pinned`）的固定状态
 * 统一收敛至 `pinnedEntries`（支持 plugin、plugin-feature、builtin、system-tool、file 五类固定项）。
 */
export type PinnedEntry =
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'plugin-feature'; pluginId: string; featureCode: string }
  | { kind: 'builtin'; commandKey: string }
  | { kind: 'system-tool'; toolId: string }
  | { kind: 'file'; path: string; name: string; isDir: boolean; isApplication: boolean }

export interface SuperPanelConfig {
  pinnedSchemaVersion: number
  pinnedEntries: PinnedEntry[]
}

export const CURRENT_PINNED_SCHEMA_VERSION = 2
export const MAX_PINNED_ENTRIES = 10_000
const MAX_ENTRY_SCAN_COUNT = 50_000
const MAX_FEATURE_CODE_LENGTH = 128
const MAX_FILE_PATH_LENGTH = 32_768
const MAX_FILE_NAME_LENGTH = 512

export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const BUILTIN_COMMAND_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const SYSTEM_TOOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isAbsoluteForPlatform(targetPath: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(targetPath)
    : path.posix.isAbsolute(targetPath)
}

function normalizePinnedFilePath(rawPath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const normalized = path.win32.normalize(rawPath)
    const parsed = path.win32.parse(normalized)
    const trimmed = normalized.length > parsed.root.length
      ? normalized.replace(/[\\/]+$/, '')
      : normalized
    return trimmed.toLowerCase()
  }
  const normalized = path.posix.normalize(rawPath)
  const parsed = path.posix.parse(normalized)
  return normalized.length > parsed.root.length
    ? normalized.replace(/\/+$/, '')
    : normalized
}

export function resolvePinKey(entry: PinnedEntry, platform: NodeJS.Platform = process.platform): string {
  switch (entry.kind) {
    case 'plugin':
      return `plugin:${entry.pluginId}`
    case 'plugin-feature':
      return `plugin-feature:${entry.pluginId}:${entry.featureCode}`
    case 'builtin':
      return `builtin:${entry.commandKey}`
    case 'system-tool':
      return `system-tool:${entry.toolId}`
    case 'file':
      return `file:${normalizePinnedFilePath(entry.path, platform)}`
  }
}

export function parsePinnedEntry(value: unknown, platform: NodeJS.Platform = process.platform): PinnedEntry | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  switch (value.kind) {
    case 'plugin':
      return typeof value.pluginId === 'string' && PLUGIN_ID_PATTERN.test(value.pluginId)
        ? { kind: 'plugin', pluginId: value.pluginId }
        : null
    case 'plugin-feature':
      return typeof value.pluginId === 'string' &&
        PLUGIN_ID_PATTERN.test(value.pluginId) &&
        isNonEmptyBoundedText(value.featureCode, MAX_FEATURE_CODE_LENGTH)
        ? { kind: 'plugin-feature', pluginId: value.pluginId, featureCode: value.featureCode }
        : null
    case 'builtin':
      return typeof value.commandKey === 'string' && BUILTIN_COMMAND_KEY_PATTERN.test(value.commandKey)
        ? { kind: 'builtin', commandKey: value.commandKey }
        : null
    case 'system-tool':
      return typeof value.toolId === 'string' && SYSTEM_TOOL_ID_PATTERN.test(value.toolId)
        ? { kind: 'system-tool', toolId: value.toolId }
        : null
    case 'file':
      if (
        isNonEmptyBoundedText(value.path, MAX_FILE_PATH_LENGTH) &&
        isAbsoluteForPlatform(value.path, platform) &&
        isNonEmptyBoundedText(value.name, MAX_FILE_NAME_LENGTH) &&
        typeof value.isDir === 'boolean' &&
        typeof value.isApplication === 'boolean'
      ) {
        return {
          kind: 'file',
          path: value.path,
          name: value.name,
          isDir: value.isDir,
          isApplication: value.isApplication
        }
      }
      return null
    default:
      return null
  }
}

export function parseSuperPanelConfig(value: unknown, platform: NodeJS.Platform = process.platform): SuperPanelConfig {
  const source = isRecord(value) ? value : {}
  const pinnedSchemaVersion =
    Number.isSafeInteger(source.pinnedSchemaVersion) && (source.pinnedSchemaVersion as number) >= 0
      ? (source.pinnedSchemaVersion as number)
      : 0

  const pinnedEntries: PinnedEntry[] = []
  const seenKeys = new Set<string>()
  if (Array.isArray(source.pinnedEntries)) {
    const scanLimit = Math.min(source.pinnedEntries.length, MAX_ENTRY_SCAN_COUNT)
    for (let index = 0; index < scanLimit; index += 1) {
      const entry = parsePinnedEntry(source.pinnedEntries[index], platform)
      if (!entry) continue
      const pinKey = resolvePinKey(entry, platform)
      if (seenKeys.has(pinKey)) continue
      seenKeys.add(pinKey)
      pinnedEntries.push(entry)
      if (pinnedEntries.length >= MAX_PINNED_ENTRIES) break
    }
  }

  return {
    pinnedSchemaVersion,
    pinnedEntries
  }
}

export function decodeSuperPanelConfig(source: string, platform: NodeJS.Platform = process.platform): SuperPanelConfig {
  try {
    return parseSuperPanelConfig(JSON.parse(source), platform)
  } catch {
    return parseSuperPanelConfig(undefined, platform)
  }
}
