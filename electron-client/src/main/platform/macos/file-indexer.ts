import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileRecord, SearchFilesResult, SubdirStatRecord } from '../../services/sidecar-manager.js'

import { batchMacosApplicationNames, collectSpotlightPaths, macosApplicationName } from './spotlight-search.js'

/** dir: 扫描根目录的展开规则（~ 开头按用户主目录）；路由登记结果授权时用同一规则得到扫描根 */
export function expandHomeDir(inputPath: string): string {
  const trimmed = inputPath.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

const PINYIN_BOUNDARY_CHARS = '阿八嚓哒妸发旮哈讥咔垃妈拿哦啪期然撒塌挖昔压匝'
const PINYIN_INITIAL_LETTERS = 'abcdefghjklmnopqrstwxyz'
const zhCollator = typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
  ? new Intl.Collator('zh-CN', { sensitivity: 'base' })
  : null

const COMMON_HANZI_PINYIN: Readonly<Record<string, string>> = {
  微: 'wei', 信: 'xin', 企: 'qi', 业: 'ye', 计: 'ji', 算: 'suan', 器: 'qi',
  百: 'bai', 度: 'du', 网: 'wang', 盘: 'pan', 易: 'yi', 云: 'yun', 音: 'yin', 乐: 'yue',
  钉: 'ding', 飞: 'fei', 书: 'shu', 腾: 'teng', 讯: 'xun', 会: 'hui', 议: 'yi',
  哔: 'bi', 哩: 'li', 阿: 'a', 里: 'li', 金: 'jin', 山: 'shan', 文: 'wen', 档: 'dang',
  有: 'you', 道: 'dao', 词: 'ci', 典: 'dian', 迅: 'xun', 雷: 'lei', 下: 'xia', 载: 'zai',
  剪: 'jian', 映: 'ying', 专: 'zhuan', 版: 'ban', 系: 'xi', 统: 'tong', 设: 'she', 置: 'zhi',
  任: 'ren', 务: 'wu', 管: 'guan', 理: 'li', 备: 'bei', 忘: 'wang', 录: 'lu', 语: 'yu',
  终: 'zhong', 端: 'duan', 访: 'fang', 达: 'da', 预: 'yu', 览: 'lan', 照: 'zhao', 片: 'pian',
  日: 'ri', 历: 'li', 邮: 'you', 件: 'jian', 提: 'ti', 醒: 'xing', 事: 'shi', 项: 'xiang',
  地: 'di', 图: 'tu', 气: 'qi', 象: 'xiang', 桌: 'zhuo', 面: 'mian', 活: 'huo', 动: 'dong',
  监: 'jian', 视: 'shi', 磁: 'ci', 工: 'gong', 具: 'ju', 控: 'kong', 制: 'zhi', 台: 'tai',
  钥: 'yao', 匙: 'shi', 串: 'chuan', 问: 'wen', 截: 'jie', 屏: 'ping', 播: 'bo', 客: 'ke',
  股: 'gu', 市: 'shi', 家: 'jia', 庭: 'ting', 无: 'wu', 边: 'bian', 记: 'ji', 密: 'mi',
  码: 'ma', 息: 'xi', 通: 'tong', 电: 'dian', 天: 'tian', 时: 'shi', 钟: 'zhong', 查: 'cha',
  找: 'zhao', 快: 'kuai', 捷: 'jie', 指: 'zhi', 令: 'ling', 字: 'zi', 体: 'ti', 册: 'ce',
  数: 'shu', 测: 'ce', 色: 'se', 浏: 'liu', 放: 'fang', 知: 'zhi', 乎: 'hu', 小: 'xiao',
  红: 'hong', 宝: 'bao', 支: 'zhi', 付: 'fu', 淘: 'tao', 汽: 'qi', 水: 'shui', 夸: 'kua',
  克: 'ke', 豆: 'dou', 包: 'bao', 元: 'yuan', 滴: 'di'
}

const pinyinMetaCache = new Map<string, { acronym: string; pinyin: string }>()

function getCharInitial(ch: string): string {
  const known = COMMON_HANZI_PINYIN[ch]
  if (known) return known[0]!
  if (!zhCollator) return ''
  for (let i = PINYIN_BOUNDARY_CHARS.length - 1; i >= 0; i--) {
    if (zhCollator.compare(ch, PINYIN_BOUNDARY_CHARS[i]!) >= 0) {
      return PINYIN_INITIAL_LETTERS[i]!
    }
  }
  return ''
}

export function computePinyinMeta(rawName: string): { acronym: string; pinyin: string } {
  const cached = pinyinMetaCache.get(rawName)
  if (cached) return cached
  const base = rawName.replace(/\.app$/i, '')
  let acronym = ''
  let pinyin = ''
  let prevWasAsciiAlnum = false
  let prevWasAsciiLower = false
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0
    const isDigit = code >= 48 && code <= 57
    const isUpper = code >= 65 && code <= 90
    const isLower = code >= 97 && code <= 122
    if (isDigit || isUpper || isLower) {
      const lower = ch.toLowerCase()
      pinyin += lower
      if (!prevWasAsciiAlnum || (prevWasAsciiLower && isUpper)) {
        acronym += lower
      }
      prevWasAsciiAlnum = true
      prevWasAsciiLower = isLower
    } else if (code >= 0x4e00 && code <= 0x9fa5) {
      prevWasAsciiAlnum = false
      prevWasAsciiLower = false
      const initial = getCharInitial(ch)
      const full = COMMON_HANZI_PINYIN[ch] ?? initial
      if (initial) acronym += initial
      pinyin += full || ch
    } else {
      prevWasAsciiAlnum = false
      prevWasAsciiLower = false
    }
  }
  const result = {
    acronym: acronym || base.slice(0, 6).toLowerCase(),
    pinyin: pinyin || base.toLowerCase()
  }
  if (pinyinMetaCache.size >= 4096) {
    pinyinMetaCache.delete(pinyinMetaCache.keys().next().value!)
  }
  pinyinMetaCache.set(rawName, result)
  return result
}

const statRecordCache = new Map<string, { expires: number; record: FileRecord }>()
let macosAppCache: { expires: number; apps: FileRecord[] } | null = null
let macosAppCachePending: Promise<FileRecord[]> | null = null

async function getStatFileRecordCached(fullPath: string, name?: string): Promise<FileRecord> {
  const now = Date.now()
  const cached = statRecordCache.get(fullPath)
  if (cached && cached.expires > now) {
    return cached.record
  }
  const stat = await fs.promises.stat(fullPath)
  const record = buildFileRecord(fullPath, name ?? path.basename(fullPath), stat)
  if (statRecordCache.size >= 4096) {
    statRecordCache.delete(statRecordCache.keys().next().value!)
  }
  statRecordCache.set(fullPath, { expires: now + 15_000, record })
  return record
}

async function buildMacosApplicationsCache(): Promise<FileRecord[]> {
  const appDirs = [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/System/Cryptexes/App/System/Applications',
    path.join(os.homedir(), 'Applications')
  ]
  const apps: FileRecord[] = []
  const seen = new Set<string>()
  for (const dir of appDirs) {
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.name.toLowerCase().endsWith('.app')) continue
      const fullPath = path.join(dir, ent.name)
      if (seen.has(fullPath)) continue
      seen.add(fullPath)
      try {
        const rec = await getStatFileRecordCached(fullPath, ent.name)
        apps.push({ ...rec })
      } catch {
        // ignore inaccessible app
      }
    }
  }

  // 在构建应用缓存时一次性批量解析中文显示名称（如 WeChat.app -> 微信）并合并双语拼音与首字母
  const localizedNames = await batchMacosApplicationNames(apps.map(a => a.path))
  for (const app of apps) {
    const displayName = localizedNames.get(app.path) || app.display_name || app.name.replace(/\.app$/i, '')
    app.display_name = displayName
    const nameMeta = computePinyinMeta(app.name)
    const displayMeta = computePinyinMeta(displayName)
    const acronyms = new Set([displayMeta.acronym, nameMeta.acronym].filter(Boolean))
    const pinyins = new Set([displayMeta.pinyin, nameMeta.pinyin].filter(Boolean))
    app.acronym = [...acronyms].join(' ')
    app.pinyin = [...pinyins].join(' ')
  }

  macosAppCache = { expires: Date.now() + 60_000, apps }
  return apps
}

export async function getCachedMacosApplications(): Promise<FileRecord[]> {
  if (process.platform !== 'darwin') return []
  const now = Date.now()
  if (macosAppCache && macosAppCache.expires > now) {
    return macosAppCache.apps
  }
  if (!macosAppCachePending) {
    macosAppCachePending = buildMacosApplicationsCache().finally(() => {
      macosAppCachePending = null
    })
  }
  return macosAppCachePending
}

/** 后台预热 macOS 应用列表与本地化名称缓存，让首次打开悬浮条搜索即达亚毫秒级命中 */
export function prewarmMacosApplicationCache(): void {
  if (process.platform !== 'darwin') return
  void getCachedMacosApplications().catch(() => undefined)
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
    acronym: computePinyinMeta(name).acronym,
    pinyin: computePinyinMeta(name).pinyin
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
      const pinyinMeta = qLower ? computePinyinMeta(ent.name) : null
      if (qLower && !lowerName.includes(qLower) && !fullPath.toLowerCase().includes(qLower) && !(pinyinMeta && (pinyinMeta.acronym.includes(qLower) || pinyinMeta.pinyin.includes(qLower)))) {
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
      (item.pinyin || '').toLowerCase().includes(qLower) ||
      item.path.toLowerCase().includes(qLower)
    ) {
      resultsMap.set(item.path, item)
      if (resultsMap.size >= safeLimit) break
    }
  }

  let degraded = process.platform !== 'darwin'
  let source = 'macos-fs'
  if (process.platform === 'darwin' && resultsMap.size < safeLimit) {
    const cachedApps = await getCachedMacosApplications()
    for (const appItem of cachedApps) {
      if (
        appItem.name.toLowerCase().includes(qLower) ||
        (appItem.display_name || '').toLowerCase().includes(qLower) ||
        appItem.acronym.toLowerCase().includes(qLower) ||
        appItem.pinyin.toLowerCase().includes(qLower)
      ) {
        resultsMap.set(appItem.path, appItem)
      }
    }
    const spotlight = await collectSpotlightPaths(cleanQuery, Math.max(safeLimit, Math.min(128, safeLimit * 4)))
    degraded = spotlight.degraded
    if (spotlight.paths.length > 0) source = 'macos-spotlight'
    // Small batches bound filesystem and metadata subprocess concurrency.
    for (let offset = 0; offset < spotlight.paths.length; offset += 32) {
      await Promise.all(spotlight.paths.slice(offset, offset + 32).map(async candidatePath => {
        if (resultsMap.has(candidatePath)) return
        try {
          resultsMap.set(candidatePath, await getStatFileRecordCached(candidatePath))


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
    const appBonus = file.kind === 'application' ? 0.05 : 0
    const names = [file.display_name ?? file.name, file.name.replace(/\.app$/i, '')]
      .map(name => name.toLocaleLowerCase())
    if (names.some(name => name === normalized)) return 3 + appBonus
    if (names.some(name => name.startsWith(normalized))) return 2 + appBonus
    if (names.some(name => name.includes(normalized))) return 1 + appBonus
    const acronyms = (file.acronym || '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const pinyins = (file.pinyin || '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (acronyms.some(a => a.startsWith(normalized)) || pinyins.some(p => p.startsWith(normalized))) return 0.8 + appBonus
    if (acronyms.some(a => a.includes(normalized)) || pinyins.some(p => p.includes(normalized))) return 0.5 + appBonus
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
    if (filesMap.size === 0 && subdirMap.size === 0) {
      throw new Error(`目录不存在或无法访问: ${resolvedRoot}`)
    }
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
    } catch (err) {
      if (!current.topSubdir && filesMap.size === 0 && subdirMap.size === 0) {
        throw new Error(`无法读取目录 ${resolvedRoot}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }
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
