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
export function changed(): Error { return new Error('文件或目录已变化，请重新比对；本次操作已停止') }

export async function fingerprint(adapter: PathAccessAdapter, object: AnchoredPathObject, signal: AbortSignal): Promise<SyncFile> {
  const before = await adapter.describe(object, signal)
  if (before.isDirectory || before.size > MAX_BYTES) throw new Error('当前同步仅支持不超过 2 GiB 的普通文件')
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
    if (segments.length > 48) throw new Error('目录层级超过 48 层，请缩小同步范围')
    const entries = await adapter.list(root.object, segments, signal, true)
    for (const entry of entries) {
      if (++count > 5000) throw new Error('目录条目超过 5000 项，请缩小同步范围')
      if (!segments.length && entry.name === SYNC_BACKUPS) {
        if (!entry.isDirectory) throw new Error('备份目录名称被文件占用')
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
    if (previous && previous !== name) throw new Error(`存在大小写或 Unicode 名称冲突，请先处理：${previous} / ${name}`)
    aliases.set(key, name)
  }
  const result: SyncDiff[] = []
  for (const name of [...new Set([...source.files.keys(), ...target.files.keys()])].sort()) {
    if (source.directories.has(name) || target.directories.has(name)) throw new Error(`同一路径一边是文件、一边是目录：${name}`)
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
    const badge = direction === 'delete-dst' ? '移入回收站' : direction === 'conflict' ? '需手动处理' : direction === 'dst-to-src' ? '目标 → 源' : '源 → 目标'
    result.push({ relPath: name, direction, diffType, actionBadge: badge,
      reasonText: direction === 'conflict' ? '内容不同但修改时间接近；不会自动选择覆盖方向' : direction === 'delete-dst' ? '源端没有此文件；先备份，再移入系统回收站' : src && dst ? '内容不同；覆盖前保留并校验原文件备份' : '新增文件；不会覆盖执行期间出现的同名文件',
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
    if (copied.hash !== expected.hash || copied.size !== expected.size) throw new Error('副本校验失败；未开始覆盖或移除原文件')
  } finally { await adapter.release(input) }
}

export async function moveWithoutReplace(adapter: PathAccessAdapter, root: SyncRoot, from: string, to: string, signal: AbortSignal) {
  await ensureParents(adapter, root, segmentsOf(to), signal)
  const save = await adapter.deriveSave(root.object, segmentsOf(to), signal)
  try { await adapter.move(root.object, segmentsOf(from), save, false, signal) }
  finally { await adapter.release(save) }
}
