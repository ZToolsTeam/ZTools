import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileRecord, SearchFilesResult, SubdirStatRecord } from '../../services/sidecar-manager.js'

import { collectSpotlightPaths, macosApplicationName } from './spotlight-search.js'

/** dir: 扫描根目录的展开规则（~ 开头按用户主目录）；路由登记结果授权时用同一规则得到扫描根 */
export function expandHomeDir(inputPath: string): string {
  const trimmed = inputPath.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

function buildFileRecord(filePath: string, name: string, stat: fs.Stats): FileRecord {
  const isDir = stat.isDirectory()
  const isApplication = process.platform === 'darwin' && isDir && filePath.toLowerCase().endsWith('.app')
  const size = isDir ? 0 : Number(stat.size || 0)
  const mtime = Math.round(Number(stat.mtimeMs || Date.now()))
  return {
    ...(isApplication ? { kind: 'application', display_name: name.replace(/\.app$/i, '') } : {}),
    name,
    path: filePath,
    is_dir: isDir,
    size,
    mtime,
    acronym: name.slice(0, 6).toLowerCase(),
    pinyin: name.toLowerCase()
  }
}

/**
 * 扫描本机真实用户目录（Downloads, Desktop, Documents）的一级文件与文件夹，按修改时间降序排列。
 * 不扫描 process.cwd()：开发版是源码目录，打包版从访达启动时是根目录 /。
 */
export async function scanLocalRecentFiles(
  rawQuery = '',
  limit = 50
): Promise<{ files: FileRecord[]; subdirs: SubdirStatRecord[]; totalBytes: number }> {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))
  const qLower = String(rawQuery || '').trim().toLowerCase()
  const home = os.homedir()

  const candidateDirs = [
    ...(home
      ? [
          path.join(home, 'Downloads'),
          path.join(home, 'Desktop'),
          path.join(home, 'Documents')
        ]
      : [])
  ]

  const seenDirs = new Set<string>()
  const recordsMap = new Map<string, FileRecord>()
  const subdirs: SubdirStatRecord[] = []

  for (const dir of candidateDirs) {
    if (!dir) continue
    const normDir = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)
    if (seenDirs.has(normDir)) continue
    seenDirs.add(normDir)

    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const ent of entries) {
      if (!ent.name || ent.name.startsWith('.')) continue
      const lowerName = ent.name.toLowerCase()
      if (
        lowerName === 'node_modules' ||
        lowerName === '.git' ||
        lowerName === '$recycle.bin' ||
        lowerName === 'desktop.ini' ||
        lowerName === 'thumbs.db'
      ) {
        continue
      }

      const fullPath = path.join(dir, ent.name)
      if (qLower && !lowerName.includes(qLower) && !fullPath.toLowerCase().includes(qLower)) {
        continue
      }

      const normPath = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath
      if (recordsMap.has(normPath)) continue

      try {
        const stat = await fs.promises.stat(fullPath)
        const rec = buildFileRecord(fullPath, ent.name, stat)
        recordsMap.set(normPath, rec)
        if (rec.is_dir && subdirs.length < 30) {
          subdirs.push({
            name: ent.name,
            path: fullPath,
            fileCount: 1,
            sizeBytes: 0,
            file_count: 1,
            total_bytes: 0,
            mtime: rec.mtime
          })
        }
      } catch {
        // ignore inaccessible file
      }
    }
  }

  const sortedFiles = Array.from(recordsMap.values())
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, safeLimit)
  const totalBytes = sortedFiles.reduce((acc, item) => acc + (item.size || 0), 0)

  return {
    files: sortedFiles,
    subdirs: subdirs.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)),
    totalBytes
  }
}

/**
 * macOS Spotlight (/usr/bin/mdfind) 极速文件检索 + 主目录浅层回退扫描
 */
export async function searchFilesOnMacos(
  rawQuery: string,
  limit = 50,
  fallbackFiles: readonly FileRecord[] = []
): Promise<SearchFilesResult> {
  const t0 = performance.now()
  const cleanQuery = String(rawQuery || '').trim()
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))

  if (!cleanQuery) {
    if (fallbackFiles.length > 0) {
      const sliced = fallbackFiles.slice(0, safeLimit)
      const totalBytes = sliced.reduce((acc, f) => acc + (f.size || 0), 0)
      const elapsedMs = performance.now() - t0
      return {
        query: cleanQuery,
        limit: safeLimit,
        files: sliced,
        count: sliced.length,
        total_matches: fallbackFiles.length,
        total_bytes: totalBytes,
        elapsed_us: Math.round(elapsedMs * 1000),
        elapsed_ms: elapsedMs,
        total_indexed: fallbackFiles.length,
        source: 'macos-fs'
      }
    }
    const local = await scanLocalRecentFiles('', safeLimit)
    const elapsedMs = performance.now() - t0
    return {
      query: cleanQuery,
      limit: safeLimit,
      files: local.files,
      count: local.files.length,
      total_matches: local.files.length,
      total_bytes: local.totalBytes,
      subdirs: local.subdirs,
      elapsed_us: Math.round(elapsedMs * 1000),
      elapsed_ms: elapsedMs,
      total_indexed: local.files.length,
      source: 'macos-fs'
    }
  }

  const qLower = cleanQuery.toLowerCase()
  const resultsMap = new Map<string, FileRecord>()

  // 1. 先合并内存预设 fallbackFiles 匹配项
  for (const item of fallbackFiles) {
    if (
      item.name.toLowerCase().includes(qLower) ||
      item.acronym.toLowerCase().includes(qLower) ||
      item.path.toLowerCase().includes(qLower)
    ) {
      resultsMap.set(item.path, item)
      if (resultsMap.size >= safeLimit) break
    }
  }

  let degraded = process.platform !== 'darwin'
  let source = 'macos-fs'
  if (process.platform === 'darwin' && resultsMap.size < safeLimit) {
    const spotlight = await collectSpotlightPaths(cleanQuery, Math.max(safeLimit, Math.min(128, safeLimit * 4)))
    degraded = spotlight.degraded
    if (spotlight.paths.length > 0) source = 'macos-spotlight'
    // Small batches bound filesystem and metadata subprocess concurrency.
    for (let offset = 0; offset < spotlight.paths.length; offset += 8) {
      await Promise.all(spotlight.paths.slice(offset, offset + 8).map(async candidatePath => {
        if (resultsMap.has(candidatePath)) return
        try {
          const stat = await fs.promises.stat(candidatePath)
          const record = buildFileRecord(candidatePath, path.basename(candidatePath), stat)
          resultsMap.set(candidatePath, record)
        } catch (error) {
          // Index entries can disappear or become inaccessible while a query is running.
          if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            console.warn('[Spotlight] 搜索结果读取失败:', error)
          }
        }
      }))
    }
    // Preserve partial Spotlight results and fill gaps from accessible local folders.
    if (resultsMap.size < safeLimit) {
      const local = await scanLocalRecentFiles(cleanQuery, safeLimit)
      for (const file of local.files) {
        if (!resultsMap.has(file.path)) resultsMap.set(file.path, file)
      }
    }
  }

  // Include applications found by the local fallback; resolve at most one page concurrently.
  const applications = [...resultsMap.values()].filter(file => file.kind === 'application').slice(0, 12)
  await Promise.all(applications.map(async file => { file.display_name = await macosApplicationName(file.path) }))
  const files = rankSearchFiles([...resultsMap.values()], cleanQuery).slice(0, safeLimit)
  const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0)
  const elapsedMs = performance.now() - t0

  return {
    query: cleanQuery,
    limit: safeLimit,
    files,
    count: files.length,
    total_matches: files.length,
    total_bytes: totalBytes,
    elapsed_us: Math.round(elapsedMs * 1000),
    elapsed_ms: elapsedMs,
    total_indexed: Math.max(fallbackFiles.length, files.length),
    degraded,
    source
  }
}

/** Exact localized names precede prefix and substring matches. */
export function rankSearchFiles(files: readonly FileRecord[], query: string): FileRecord[] {
  const normalized = query.trim().toLocaleLowerCase()
  const score = (file: FileRecord): number => {
    const names = [file.display_name ?? file.name, file.name.replace(/\.app$/i, '')]
      .map(name => name.toLocaleLowerCase())
    if (names.some(name => name === normalized)) return 3
    if (names.some(name => name.startsWith(normalized))) return 2
    if (names.some(name => name.includes(normalized))) return 1
    return 0
  }
  return [...files].sort((a, b) => score(b) - score(a) ||
    (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name))
}

/** dir: 扫描默认 / 最大条目上限 */
export const DIR_SCAN_DEFAULT_MAX_ENTRIES = 2000
export const DIR_SCAN_MAX_ENTRIES_CAP = 20000

/**
 * macOS 伪文件系统、系统卷挂载点与 autofs 挂载点：遍历它们既不反映真实占用，又可能很慢或挂起。
 * 仅在作为子目录出现时跳过；用户显式把它们作为扫描根目录时照常扫描。
 */
const MAC_SKIPPED_SCAN_DIRS = new Set([
  '/dev',
  '/System/Volumes',
  '/private/var/vm',
  '/var/vm',
  '/net',
  '/home'
])

export interface DirectorySizeMeasurement {
  bytes: number
  /** false：统计过程中遇到无权限等错误，结果偏小 */
  complete: boolean
}

/** 统计单个目录占用字节数；超时 / 失败返回 null */
export type DirectorySizeMeasurer = (dirPath: string, timeoutMs: number) => Promise<DirectorySizeMeasurement | null>

/** du -skx：只统计同一文件系统，跳过挂载点；超时直接 SIGKILL */
export const measureDirectoryWithDu: DirectorySizeMeasurer = (dirPath, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        '/usr/bin/du',
        ['-skx', dirPath],
        { timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          const failure = error as (Error & { killed?: boolean; signal?: string | null; code?: unknown }) | null
          if (failure && (failure.killed || failure.signal || typeof failure.code === 'string')) {
            resolve(null)
            return
          }
          const lines = String(stdout || '').trim().split(/\r?\n/)
          const match = /^(\d+)\s/.exec(lines[lines.length - 1] ?? '')
          if (!match) {
            resolve(null)
            return
          }
          resolve({ bytes: Number(match[1]) * 1024, complete: !failure })
        }
      )
    } catch {
      resolve(null)
    }
  })

export interface DirectoryScanOptions {
  /** 截断后对未遍历完的一级子目录单独统计体积；测试可注入替身，传 null 关闭 */
  measureDirectory?: DirectorySizeMeasurer | null
  /** 独立体积统计的总时间预算（墙钟） */
  sizeBudgetMs?: number
  sizeConcurrency?: number
}

async function measureIncompleteSubdirs(
  targets: Array<SubdirStatRecord & { approximate?: boolean }>,
  measure: DirectorySizeMeasurer,
  budgetMs: number,
  concurrency: number
): Promise<void> {
  const deadline = Date.now() + Math.max(1, budgetMs)
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++]!
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      let measured: DirectorySizeMeasurement | null = null
      try {
        measured = await measure(target.path, remaining)
      } catch {
        measured = null
      }
      if (measured && Number.isFinite(measured.bytes) && measured.bytes >= 0) {
        target.sizeBytes = measured.bytes
        target.total_bytes = measured.bytes
        target.approximate = !measured.complete
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker))
}

/**
 * 扫描指定目录 (dir:<path>) 的一级子目录与文件，并聚合深层体积统计与 fallbackFiles。
 * 广度优先遍历到 maxEntries 即停止，此时返回 truncated=true：files / total_matches 只是抽样；
 * 未遍历完的一级子目录体积改用 du 独立统计（有总时间预算），统计不到的标记 approximate。
 */
export async function scanDirectoryForSearch(
  rawTargetDir: string,
  limit = 50,
  fallbackFiles: readonly FileRecord[] = [],
  maxEntries = DIR_SCAN_DEFAULT_MAX_ENTRIES,
  options: DirectoryScanOptions = {}
): Promise<SearchFilesResult> {
  const t0 = performance.now()
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))
  const entryCap = Math.max(1, Math.min(DIR_SCAN_MAX_ENTRIES_CAP, Math.floor(Number(maxEntries) || DIR_SCAN_DEFAULT_MAX_ENTRIES)))
  const resolvedRoot = expandHomeDir(rawTargetDir)
  const queryLabel = `dir:${rawTargetDir}`

  const filesMap = new Map<string, FileRecord>()
  const subdirMap = new Map<string, SubdirStatRecord & { topFiles: FileRecord[] }>()
  let totalFiles = 0
  let totalBytes = 0

  // 合并预设的 fallbackFiles（支持离线单测注入）
  const normalizedRootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`
  for (const item of fallbackFiles) {
    const resolvedItemPath = path.resolve(item.path)
    if (resolvedItemPath === resolvedRoot || resolvedItemPath.startsWith(normalizedRootPrefix)) {
      if (item.is_dir && resolvedItemPath !== resolvedRoot) {
        const rel = path.relative(resolvedRoot, resolvedItemPath)
        const firstSeg = rel.split(/[\\/]/)[0]
        if (firstSeg && !subdirMap.has(firstSeg)) {
          const subPath = path.join(resolvedRoot, firstSeg)
          subdirMap.set(firstSeg, {
            name: firstSeg,
            path: subPath,
            fileCount: 0,
            sizeBytes: 0,
            file_count: 0,
            total_bytes: 0,
            mtime: item.mtime || Date.now(),
            topFiles: []
          })
        }
      } else if (!item.is_dir) {
        totalFiles++
        totalBytes += item.size || 0
        filesMap.set(item.path, item)
      }
    }
  }

  if (!fs.existsSync(resolvedRoot)) {
    const fallbackMatched = Array.from(filesMap.values()).slice(0, safeLimit)
    const fallbackSubdirs = Array.from(subdirMap.values()).map(({ topFiles: _tf, ...rest }) => rest)
    const elapsedMs = performance.now() - t0
    return {
      query: queryLabel,
      limit: safeLimit,
      files: fallbackMatched,
      count: fallbackMatched.length,
      total_matches: totalFiles,
      total_bytes: totalBytes,
      subdirs: fallbackSubdirs,
      elapsed_us: Math.round(elapsedMs * 1000),
      elapsed_ms: elapsedMs,
      total_indexed: totalBytes,
      source: 'macos-fs'
    }
  }

  const visitedReal = new Set<string>()
  const allTopFiles: FileRecord[] = []
  let visitedCount = 0
  let truncated = false
  let rootFileBytes = 0
  /** 未遍历完的一级子目录名；'' 表示根目录自身的条目都没读完 */
  const incompleteTop = new Set<string>()

  const queue: Array<{ dirPath: string; topSubdir: string; isSymlink?: boolean }> = [
    { dirPath: resolvedRoot, topSubdir: '', isSymlink: true }
  ]

  while (queue.length > 0) {
    if (visitedCount >= entryCap) {
      truncated = true
      break
    }
    const current = queue.shift()!
    let realCurrent = current.dirPath
    if (current.isSymlink) {
      try {
        realCurrent = await fs.promises.realpath(current.dirPath)
      } catch {
        // keep original path
      }
    }
    const realKey = process.platform === 'win32' ? realCurrent.toLowerCase() : realCurrent
    if (visitedReal.has(realKey)) continue
    visitedReal.add(realKey)

    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(current.dirPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const ent of entries) {
      visitedCount++
      if (visitedCount > entryCap) {
        visitedCount = entryCap
        truncated = true
        incompleteTop.add(current.topSubdir)
        break
      }
      const fullPath = path.join(current.dirPath, ent.name)
      const topSub = current.topSubdir || ent.name

      const isSym = ent.isSymbolicLink()
      let isDir = ent.isDirectory()
      let isFile = ent.isFile()
      let statObj: fs.Stats | null = null

      try {
        statObj = await fs.promises.stat(fullPath)
        isDir = statObj.isDirectory()
        isFile = statObj.isFile()
      } catch {
        continue
      }

      if (isDir) {
        const lowerName = ent.name.toLowerCase()
        if (process.platform === 'darwin' && MAC_SKIPPED_SCAN_DIRS.has(fullPath)) continue
        if (
          lowerName === '$recycle.bin' ||
          lowerName === 'system volume information' ||
          lowerName === 'node_modules' ||
          lowerName === '.git' ||
          lowerName === '.trash'
        ) {
          continue
        }
        const mtimeMs = Math.round(Number(statObj?.mtimeMs || Date.now()))
        if (!current.topSubdir && !subdirMap.has(topSub)) {
          subdirMap.set(topSub, {
            name: topSub,
            path: fullPath,
            fileCount: 0,
            sizeBytes: 0,
            file_count: 0,
            total_bytes: 0,
            mtime: mtimeMs,
            topFiles: []
          })
        }
        queue.push({ dirPath: fullPath, topSubdir: topSub, isSymlink: isSym })
      } else if (isFile && statObj) {
        const sz = Number(statObj.size || 0)
        const mtimeMs = Math.round(Number(statObj.mtimeMs || Date.now()))
        totalFiles++
        totalBytes += sz

        const rec = buildFileRecord(fullPath, ent.name, statObj)

        if (current.topSubdir) {
          let subEntry = subdirMap.get(topSub)
          if (!subEntry) {
            subEntry = {
              name: topSub,
              path: path.join(resolvedRoot, topSub),
              fileCount: 0,
              sizeBytes: 0,
              file_count: 0,
              total_bytes: 0,
              mtime: mtimeMs,
              topFiles: []
            }
            subdirMap.set(topSub, subEntry)
          }
          subEntry.fileCount++
          subEntry.sizeBytes += sz
          subEntry.file_count = subEntry.fileCount
          subEntry.total_bytes = subEntry.sizeBytes
          if (mtimeMs > (subEntry.mtime ?? 0)) {
            subEntry.mtime = mtimeMs
          }
          if (subEntry.topFiles.length < 40) {
            subEntry.topFiles.push(rec)
          } else {
            let minIdx = 0
            for (let i = 1; i < subEntry.topFiles.length; i++) {
              if (subEntry.topFiles[i]!.size < subEntry.topFiles[minIdx]!.size) {
                minIdx = i
              }
            }
            if (sz > subEntry.topFiles[minIdx]!.size) {
              subEntry.topFiles[minIdx] = rec
            }
          }
        } else {
          rootFileBytes += sz
          filesMap.set(rec.path, rec)
        }

        if (allTopFiles.length < safeLimit * 2) {
          allTopFiles.push(rec)
        } else if (sz > allTopFiles[allTopFiles.length - 1]!.size) {
          allTopFiles[allTopFiles.length - 1] = rec
          allTopFiles.sort((a, b) => b.size - a.size)
        }
      }
    }
  }

  let approximate = false
  if (truncated) {
    for (const pendingItem of queue) incompleteTop.add(pendingItem.topSubdir)
    const incomplete = Array.from(subdirMap.values())
      .filter((sub) => incompleteTop.has(sub.name)) as Array<SubdirStatRecord & { topFiles: FileRecord[]; approximate?: boolean }>
    for (const sub of incomplete) sub.approximate = true
    const measure = options.measureDirectory === undefined
      ? (process.platform === 'win32' ? null : measureDirectoryWithDu)
      : options.measureDirectory
    if (measure && incomplete.length > 0) {
      await measureIncompleteSubdirs(incomplete, measure, options.sizeBudgetMs ?? 2500, options.sizeConcurrency ?? 6)
    }
    totalBytes = rootFileBytes + Array.from(subdirMap.values()).reduce((acc, sub) => acc + sub.sizeBytes, 0)
    approximate = incompleteTop.has('') || incomplete.some((sub) => sub.approximate)
  }

  const sortedSubdirs = Array.from(subdirMap.values()).sort((a, b) => b.sizeBytes - a.sizeBytes)
  for (const sub of sortedSubdirs) {
    sub.topFiles.sort((a, b) => b.size - a.size)
    for (const f of sub.topFiles.slice(0, 18)) {
      if (filesMap.size < safeLimit) {
        filesMap.set(f.path, f)
      }
    }
  }
  allTopFiles.sort((a, b) => b.size - a.size)
  for (const f of allTopFiles) {
    if (filesMap.size >= safeLimit) break
    filesMap.set(f.path, f)
  }

  const finalFiles = Array.from(filesMap.values())
    .sort((a, b) => b.size - a.size)
    .slice(0, safeLimit)
  const elapsedMs = performance.now() - t0

  return {
    query: queryLabel,
    limit: safeLimit,
    files: finalFiles,
    count: finalFiles.length,
    total_matches: totalFiles,
    total_bytes: totalBytes,
    subdirs: sortedSubdirs.map(({ name, path: p, fileCount, sizeBytes, mtime, ...rest }) => ({
      name,
      path: p,
      fileCount,
      sizeBytes,
      file_count: fileCount,
      total_bytes: sizeBytes,
      ...(mtime !== undefined ? { mtime } : {}),
      ...((rest as { approximate?: boolean }).approximate ? { approximate: true } : {})
    })),
    elapsed_us: Math.round(elapsedMs * 1000),
    elapsed_ms: elapsedMs,
    total_indexed: totalBytes,
    truncated,
    approximate,
    visited_entries: visitedCount,
    max_entries: entryCap,
    source: 'macos-fs'
  }
}
