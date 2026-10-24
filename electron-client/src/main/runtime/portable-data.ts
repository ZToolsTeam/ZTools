import type { PortablePlatform } from './portable-platform.js'

export const PORTABLE_DATA_SCHEMA_VERSION = 1 as const

export type PortableJson = null | boolean | number | string | PortableJson[] | { [key: string]: PortableJson }

export interface PortableKeyValue {
  key: string
  value: string
  encoding: 'utf8' | 'base64'
}

export interface PortableDataExport {
  schemaVersion: typeof PORTABLE_DATA_SCHEMA_VERSION
  source: {
    platform: PortablePlatform
    arch: string
  }
  pluginId: string
  config: PortableJson
  pluginState: PortableJson
  triggers: PortableJson
  leveldb: PortableKeyValue[]
  externalPaths: Array<{
    originalPath: string
    relativePath?: string
    state: 'portable-relative' | 'requires-relink' | 'absolute-preserved'
  }>
  credentials: {
    encrypted: boolean
    state: 'portable' | 'requires-reauthentication' | 'unavailable'
  }
  extra?: Record<string, PortableJson>
}

export interface PortableConflict {
  path: string
  existing: PortableJson
  incoming: PortableJson
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toPortableJson(value: unknown, path = '$'): PortableJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') {
    return value.toString(10)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be finite`)
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${path} contains an unsafe integer; encode it as a decimal string`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toPortableJson(item, `${path}[${index}]`))
  }
  if (isRecord(value)) {
    const result: { [key: string]: PortableJson } = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        continue
      }
      result[key] = toPortableJson(value[key], `${path}.${key}`)
    }
    return result
  }
  throw new Error(`${path} contains an unsupported value`)
}

function stableSerialize(value: PortableJson): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key]!)}`).join(',')}}`
}

export function stablePortableStringify(value: unknown): string {
  return stableSerialize(toPortableJson(value))
}

function assertPortablePlatform(value: unknown): asserts value is PortablePlatform {
  if (value !== 'win32' && value !== 'linux' && value !== 'darwin') {
    throw new Error('source.platform must be win32, linux, or darwin')
  }
}

function assertPortableJson(value: unknown, path: string): asserts value is PortableJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`${path} contains an invalid number`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableJson(item, `${path}[${index}]`))
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertPortableJson(item, `${path}.${key}`)
    }
    return
  }
  throw new Error(`${path} is not portable JSON`)
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
}

export function assertPortableDataExport(value: unknown): asserts value is PortableDataExport {
  if (!isRecord(value)) throw new Error('portable export must be an object')
  if (value.schemaVersion !== PORTABLE_DATA_SCHEMA_VERSION) throw new Error('unsupported portable data schema version')
  if (!isRecord(value.source)) throw new Error('portable export source is required')
  assertPortablePlatform(value.source.platform)
  assertString(value.source.arch, 'source.arch')
  assertString(value.pluginId, 'pluginId')
  if (!value.pluginId.trim()) throw new Error('pluginId must not be empty')
  assertPortableJson(value.config, 'config')
  assertPortableJson(value.pluginState, 'pluginState')
  assertPortableJson(value.triggers, 'triggers')
  if (!Array.isArray(value.leveldb)) throw new Error('leveldb must be an array')
  for (const [index, item] of value.leveldb.entries()) {
    if (!isRecord(item)) throw new Error(`leveldb[${index}] must be an object`)
    assertString(item.key, `leveldb[${index}].key`)
    assertString(item.value, `leveldb[${index}].value`)
    if (item.encoding !== 'utf8' && item.encoding !== 'base64') throw new Error(`leveldb[${index}].encoding is invalid`)
  }
  if (!Array.isArray(value.externalPaths)) throw new Error('externalPaths must be an array')
  for (const [index, item] of value.externalPaths.entries()) {
    if (!isRecord(item)) throw new Error(`externalPaths[${index}] must be an object`)
    assertString(item.originalPath, `externalPaths[${index}].originalPath`)
    if (item.relativePath !== undefined) assertString(item.relativePath, `externalPaths[${index}].relativePath`)
    if (item.state !== 'portable-relative' && item.state !== 'requires-relink' && item.state !== 'absolute-preserved') {
      throw new Error(`externalPaths[${index}].state is invalid`)
    }
  }
  if (!isRecord(value.credentials)) throw new Error('credentials is required')
  if (typeof value.credentials.encrypted !== 'boolean') throw new Error('credentials.encrypted must be boolean')
  if (value.credentials.state !== 'portable' && value.credentials.state !== 'requires-reauthentication' && value.credentials.state !== 'unavailable') {
    throw new Error('credentials.state is invalid')
  }
  if (value.extra !== undefined) {
    assertPortableJson(value.extra, 'extra')
  }
}

export function createPortableDataExport(input: {
  source: { platform: PortablePlatform; arch: string }
  pluginId: string
  config: unknown
  pluginState: unknown
  triggers: unknown
  leveldb?: readonly { key: string; value: string; encoding?: 'utf8' | 'base64' }[]
  externalPaths?: readonly { originalPath: string; relativePath?: string; state: 'portable-relative' | 'requires-relink' | 'absolute-preserved' }[]
  credentials?: { encrypted: boolean; state: 'portable' | 'requires-reauthentication' | 'unavailable' }
  extra?: Record<string, unknown>
}): PortableDataExport {
  const result: PortableDataExport = {
    schemaVersion: PORTABLE_DATA_SCHEMA_VERSION,
    source: { platform: input.source.platform, arch: input.source.arch },
    pluginId: input.pluginId,
    config: toPortableJson(input.config),
    pluginState: toPortableJson(input.pluginState),
    triggers: toPortableJson(input.triggers),
    leveldb: (input.leveldb ?? []).map((item) => ({ key: item.key, value: item.value, encoding: item.encoding ?? 'utf8' })),
    externalPaths: (input.externalPaths ?? []).map((item) => ({ ...item })),
    credentials: input.credentials ?? { encrypted: false, state: 'portable' },
  }
  if (input.extra !== undefined) result.extra = toPortableJson(input.extra) as Record<string, PortableJson>
  assertPortableDataExport(result)
  return result
}

export function parsePortableDataExport(serialized: string): PortableDataExport {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new Error(`portable export is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertPortableDataExport(parsed)
  return parsed
}

function mergeJson(existing: PortableJson, incoming: PortableJson, path: string, conflicts: PortableConflict[]): PortableJson {
  if (isRecord(existing) && isRecord(incoming)) {
    const result: { [key: string]: PortableJson } = { ...(existing as { [key: string]: PortableJson }) }
    for (const [key, value] of Object.entries(incoming)) {
      if (result[key] === undefined) result[key] = value as PortableJson
      else result[key] = mergeJson(result[key], value as PortableJson, `${path}.${key}`, conflicts)
    }
    return result
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    if (stableSerialize(existing) !== stableSerialize(incoming)) conflicts.push({ path, existing, incoming })
    return existing
  }
  if (stableSerialize(existing) !== stableSerialize(incoming)) conflicts.push({ path, existing, incoming })
  return existing
}

function mergeKeyValues(existing: PortableKeyValue[], incoming: PortableKeyValue[], conflicts: PortableConflict[]): PortableKeyValue[] {
  const result = existing.map((item) => ({ ...item }))
  const byKey = new Map(result.map((item) => [item.key, item]))
  for (const item of incoming) {
    const current = byKey.get(item.key)
    if (!current) {
      const copy = { ...item }
      result.push(copy)
      byKey.set(item.key, copy)
    } else if (current.value !== item.value || current.encoding !== item.encoding) {
      conflicts.push({ path: `leveldb.${item.key}`, existing: { ...current }, incoming: { ...item } })
    }
  }
  return result.sort((left, right) => left.key.localeCompare(right.key))
}

export function mergePortableDataExports(
  existing: PortableDataExport,
  incoming: PortableDataExport,
): { data: PortableDataExport; conflicts: PortableConflict[] } {
  assertPortableDataExport(existing)
  assertPortableDataExport(incoming)
  if (existing.pluginId !== incoming.pluginId) throw new Error('portable exports must target the same plugin')
  const conflicts: PortableConflict[] = []
  const data: PortableDataExport = {
    ...incoming,
    ...existing,
    source: { ...incoming.source, ...existing.source },
    config: mergeJson(existing.config, incoming.config, 'config', conflicts),
    pluginState: mergeJson(existing.pluginState, incoming.pluginState, 'pluginState', conflicts),
    triggers: mergeJson(existing.triggers, incoming.triggers, 'triggers', conflicts),
    leveldb: mergeKeyValues(existing.leveldb, incoming.leveldb, conflicts),
    externalPaths: [...existing.externalPaths],
    credentials: { ...existing.credentials },
  }
  const knownPaths = new Set(data.externalPaths.map((item) => `${item.originalPath}\u0000${item.relativePath ?? ''}`))
  for (const item of incoming.externalPaths) {
    const key = `${item.originalPath}\u0000${item.relativePath ?? ''}`
    if (!knownPaths.has(key)) data.externalPaths.push({ ...item })
  }
  if (existing.extra || incoming.extra) {
    data.extra = mergeJson(existing.extra ?? {}, incoming.extra ?? {}, 'extra', conflicts) as Record<string, PortableJson>
  }
  assertPortableDataExport(data)
  return { data, conflicts }
}
