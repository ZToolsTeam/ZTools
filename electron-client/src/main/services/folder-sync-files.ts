import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AnchoredPathObject, PathAccessAdapter } from '../platform/path-access.js'
import type { SyncDiff, SyncMode } from '../../contracts/folder-sync.js'

export const SYNC_BACKUPS = '.ztools-sync-backups'
const MAX_BYTES = 2 * 1024 ** 3
export interface SyncFile { size: number; modified: number; hash: string }
export interface SyncTree { files: Map<string, SyncFile>; directories: Set<string> }
export interface SyncRoot { object: AnchoredPathObject; path: string }
export const segmentsOf = (relative: string) => relative.split('/')
export function changed(): Error { return new Error('File or directory changed; compare again, operation aborted') }

export async function fingerprint(adapter: PathAccessAdapter, object: AnchoredPathObject, signal: AbortSignal): Promise<SyncFile> {
  const before = await adapter.describe(object, signal)
  if (before.isDirectory || before.size > MAX_BYTES) throw new Error('Folder sync only supports regular files up to 2 GiB')
  const hash = createHash('sha256')
  for (let offset = 0; offset < before.size;) {
    signal.throwIfAborted()
    const bytes = await adapter.readRange(object, [], offset, Math.min(1024 ** 2, before.size - offset), signal)
    if (!bytes.length) throw changed()
    hash.update(bytes); offset += bytes.length
  }
  const after = await adapter.describe(object, signal)
  if (after.size !== before.size || after.lastModifiedMs !== before.lastModifiedMs) throw changed()
  return { size: before.size, modified: before.lastModifiedMs, hash: hash.digest('hex') }
}
export const sameFile = (a: SyncFile, b: SyncFile) => a.size === b.size && a.modified === b.modified && a.hash === b.hash

export async function readFingerprint(adapter: PathAccessAdapter, root: SyncRoot, relative: string, signal: AbortSignal) {
  const object = await adapter.deriveRead(root.object, segmentsOf(relative), signal)
  try { return await fingerprint(adapter, object, signal) } finally { await adapter.release(object) }
}

/** 扫描不允许半份结果：链接、读取失败、数量/深度超限均使整次比对失败。 */
export async function scanTree(adapter: PathAccessAdapter, root: SyncRoot, ignoreJunk: boolean, signal: AbortSignal): Promise<SyncTree> {
  const tree: SyncTree = { files: new Map(), directories: new Set() }
  let count = 0
  const walk = async (segments: string[]) => {
    if (segments.length > 48) throw new Error('Directory nesting exceeds 48 levels; narrow the sync scope')
    const entries = await adapter.list(root.object, segments, signal, true)
    for (const entry of entries) {
      if (++count > 5000) throw new Error('Directory entries exceed 5000 items; narrow the sync scope')
      if (!segments.length && entry.name === SYNC_BACKUPS) {
        if (!entry.isDirectory) throw new Error('Backup directory name is occupied by a file')
        continue
      }
      if (ignoreJunk && ['node_modules', '.git', '.DS_Store', 'Thumbs.db'].includes(entry.name)) continue
      const next = [...segments, entry.name], relative = next.join('/')
      if (entry.isDirectory) { tree.directories.add(relative); await walk(next) }
      else tree.files.set(relative, await readFingerprint(adapter, root, relative, signal))
    }
  }
  await walk([])
  return tree
}

export function assertSameTree(before: SyncTree, after: SyncTree) {
  if (before.files.size !== after.files.size || before.directories.size !== after.directories.size ||
    [...before.directories].some(name => !after.directories.has(name)) ||
    [...before.files].some(([name, file]) => !after.files.has(name) || !sameFile(file, after.files.get(name)!))) throw changed()
}

export function buildSyncDiffs(source: SyncTree, target: SyncTree, mode: SyncMode, roots: [SyncRoot, SyncRoot]): SyncDiff[] {
  const aliases = new Map<string, string>()
  for (const name of [...source.files.keys(), ...target.files.keys(), ...source.directories, ...target.directories]) {
    const key = name.normalize('NFC').toLowerCase(), previous = aliases.get(key)
    if (previous && previous !== name) throw new Error(`Case or Unicode normalization name conflict detected; resolve first: ${previous} / ${name}`)
    aliases.set(key, name)
  }
  const result: SyncDiff[] = []
  for (const name of [...new Set([...source.files.keys(), ...target.files.keys()])].sort()) {
    if (source.directories.has(name) || target.directories.has(name)) throw new Error(`Path is a file on one side and a directory on the other: ${name}`)
    const src = source.files.get(name), dst = target.files.get(name)
    if (src && dst && src.hash === dst.hash) continue
    let direction: SyncDiff['direction'] = 'src-to-dst', diffType: SyncDiff['diffType'] = dst ? 'modified' : 'added'
    if (!src) {
      if (mode === 'incremental') continue
      direction = mode === 'mirror' ? 'delete-dst' : 'dst-to-src'
      diffType = mode === 'mirror' ? 'orphan' : 'reverse-add'
    } else if (dst && mode === 'two-way') {
      if (Math.abs(src.modified - dst.modified) <= 2000) { direction = 'conflict'; diffType = 'conflict' }
      else if (dst.modified > src.modified) direction = 'dst-to-src'
    }
    const badge = direction === 'delete-dst' ? 'Move to Trash' : direction === 'conflict' ? 'Manual Review' : direction === 'dst-to-src' ? 'Target -> Source' : 'Source -> Target'
    result.push({ relPath: name, direction, diffType, actionBadge: badge,
      reasonText: direction === 'conflict' ? 'Content differs with close modification times; overwrite direction is not chosen automatically' : direction === 'delete-dst' ? 'Missing on source; back up first, then move to Trash' : src && dst ? 'Content differs; preserve and verify original backup before overwriting' : 'New file; will not overwrite an existing file created during execution',
      sizeBytes: (direction === 'dst-to-src' || !src ? dst : src)!.size,
      sourceFullPath: src ? path.join(roots[0].path, name) : '', targetFullPath: dst ? path.join(roots[1].path, name) : '' })
  }
  return result
}

export async function ensureParents(adapter: PathAccessAdapter, root: SyncRoot, parts: string[], signal: AbortSignal) {
  for (let i = 1; i < parts.length; i++) await adapter.createDirectory(root.object, parts.slice(0, i), signal)
}

/** 只提交全量内容哈希匹配的副本；写入目标必须尚不存在。 */
export async function verifiedCopy(adapter: PathAccessAdapter, source: SyncRoot, from: string, destination: SyncRoot, to: string, expected: SyncFile, signal: AbortSignal) {
  const input = await adapter.deriveRead(source.object, segmentsOf(from), signal)
  try {
    if (!sameFile(await fingerprint(adapter, input, signal), expected)) throw changed()
    await ensureParents(adapter, destination, segmentsOf(to), signal)
    const output = await adapter.deriveSave(destination.object, segmentsOf(to), signal)
    try {
      async function* chunks() {
        const hash = createHash('sha256')
        for (let offset = 0; offset < expected.size;) {
          const chunk = await adapter.readRange(input, [], offset, Math.min(64 * 1024, expected.size - offset), signal)
          if (!chunk.length) throw changed()
          hash.update(chunk); offset += chunk.length; yield chunk
        }
        const after = await adapter.describe(input, signal)
        if (hash.digest('hex') !== expected.hash || after.size !== expected.size || after.lastModifiedMs !== expected.modified) throw changed()
      }
      await adapter.streamSave(output, expected.size, chunks(), false, signal)
    } finally { await adapter.release(output) }
    const copied = await readFingerprint(adapter, destination, to, signal)
    if (copied.hash !== expected.hash || copied.size !== expected.size) throw new Error('Copy verification failed; original file was neither overwritten nor removed')
  } finally { await adapter.release(input) }
}

export async function moveWithoutReplace(adapter: PathAccessAdapter, root: SyncRoot, from: string, to: string, signal: AbortSignal) {
  await ensureParents(adapter, root, segmentsOf(to), signal)
  const save = await adapter.deriveSave(root.object, segmentsOf(to), signal)
  try { await adapter.move(root.object, segmentsOf(from), save, false, signal) }
  finally { await adapter.release(save) }
}
