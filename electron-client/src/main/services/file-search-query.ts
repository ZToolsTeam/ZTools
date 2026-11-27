import type { SystemSearchFilesScope } from '../../contracts/method-params.js'
import type { FileRecord } from './sidecar-manager.js'

export type FileSearchSortBy =
  | 'relevance'
  | 'name-asc'
  | 'name-desc'
  | 'size-desc'
  | 'size-asc'
  | 'mtime-desc'
  | 'mtime-asc'

export type FileSearchKind = 'all' | 'file' | 'directory'

export type FileSearchTypeFilter =
  | 'all'
  | 'folder'
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'media'
  | 'archive'
  | 'code'
  | 'app'
  | 'other'

export interface FileSearchOptions {
  scope?: SystemSearchFilesScope | undefined
  offset?: number | undefined
  contentType?: number | FileSearchTypeFilter | undefined
  kind?: FileSearchKind | undefined
  sortBy?: FileSearchSortBy | undefined
  includeHidden?: boolean | undefined
  pathPrefix?: string | undefined
}

export const CONTENT_TYPE_MASK = Object.freeze({
  all: 0,
  folder: 1 << 0,
  document: 1 << 1,
  image: 1 << 2,
  video: 1 << 3,
  audio: 1 << 4,
  archive: 1 << 5,
  code: 1 << 6,
  app: 1 << 7,
  other: 1 << 8,
  media: (1 << 3) | (1 << 4)
} as const)

const DOC_EXTS = new Set(['doc', 'docx', 'pdf', 'txt', 'md', 'markdown', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt', 'ods', 'pages', 'numbers', 'key'])
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'psd', 'raw', 'heic', 'heif', 'avif'])
const VID_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'rmvb'])
const AUD_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape'])
const ARC_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'dmg', 'tgz'])
const CODE_EXTS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'vue', 'html', 'htm', 'css', 'scss', 'less', 'json',
  'py', 'rs', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'go', 'java', 'kt', 'swift', 'sql',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'yaml', 'yml', 'xml', 'toml', 'ini', 'conf', 'log'
])
const APP_EXTS = new Set(['exe', 'msi', 'appx', 'msix', 'pkg', 'apk', 'lnk', 'app'])

export function resolveContentTypeMask(input?: number | string): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
    return Math.trunc(input) & 0xffff
  }
  if (typeof input === 'string') {
    const key = input.trim().toLowerCase()
    if (key in CONTENT_TYPE_MASK) {
      return CONTENT_TYPE_MASK[key as keyof typeof CONTENT_TYPE_MASK]
    }
    if (key === 'directory') return CONTENT_TYPE_MASK.folder
  }
  return 0
}

export function classifyFileContentType(name: string, isDir: boolean): number {
  if (isDir) return CONTENT_TYPE_MASK.folder
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot + 1 >= name.length) return CONTENT_TYPE_MASK.other
  const ext = name.slice(dot + 1).toLowerCase()
  if (DOC_EXTS.has(ext)) return CONTENT_TYPE_MASK.document
  if (IMG_EXTS.has(ext)) return CONTENT_TYPE_MASK.image
  if (VID_EXTS.has(ext)) return CONTENT_TYPE_MASK.video
  if (AUD_EXTS.has(ext)) return CONTENT_TYPE_MASK.audio
  if (ARC_EXTS.has(ext)) return CONTENT_TYPE_MASK.archive
  if (CODE_EXTS.has(ext)) return CONTENT_TYPE_MASK.code
  if (APP_EXTS.has(ext)) return CONTENT_TYPE_MASK.app
  return CONTENT_TYPE_MASK.other
}

export function hasAdvancedFileSearchSyntax(query: string): boolean {
  const q = query.trim()
  if (!q) return false
  return /[\s|*?^$'"]|(?:^|\s)[!-]\S|(?:^|\s)(?:ext|file|folder|dir|type|path|in|size|dm|modified):/i.test(q) ||
    /[\\/]/.test(q)
}

/**
 * Extract the strongest plain search term for Spotlight (mdfind) pre-query when
 * macOS runs in degraded Spotlight fallback without ztools-indexer.
 */
export function extractSpotlightPrimaryTerm(rawQuery: string): string {
  const trimmed = rawQuery.trim()
  if (!trimmed) return ''
  const parts = trimmed.match(/"[^"]+"|\S+/g) ?? []
  let best = ''
  for (const raw of parts) {
    if (raw === '|' || raw.startsWith('!') || raw.startsWith('-')) continue
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    if (/^(?:ext|file|folder|dir|type|path|in|size|dm|modified):/i.test(unquoted)) continue
    const cleaned = unquoted.replace(/^['^]+/, '').replace(/\$+$/, '').replace(/[*?]/g, '')
    if (cleaned.length > best.length) best = cleaned
  }
  return best || trimmed
}

function matchGlob(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let starP = -1
  let starT = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p++
      starT = t
    } else if (starP !== -1) {
      p = starP + 1
      t = ++starT
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

function fuzzySubsequenceScore(textLower: string, patternLower: string): number {
  if (!patternLower || patternLower.length > textLower.length) return 0
  let pidx = 0
  let score = 0
  let consecutive = 0
  for (let i = 0; i < textLower.length && pidx < patternLower.length; i++) {
    if (textLower[i] === patternLower[pidx]) {
      score += 16
      if (i === 0 || /[\s/_.\-\\]/.test(textLower[i - 1]!)) score += 9
      if (consecutive > 0) score += 4 * Math.min(consecutive, 4)
      consecutive++
      pidx++
    } else {
      consecutive = 0
      if (pidx > 0) score -= 1
    }
  }
  return pidx === patternLower.length ? Math.max(1, score) : 0
}

function parseSizeValue(spec: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(spec.trim())
  if (!m) return null
  const num = Number(m[1])
  if (!Number.isFinite(num) || num < 0) return null
  const unit = (m[2] ?? 'b').toLowerCase()
  const mult =
    unit === 'b' ? 1
      : unit === 'k' || unit === 'kb' ? 1024
        : unit === 'm' || unit === 'mb' ? 1024 ** 2
          : unit === 'g' || unit === 'gb' ? 1024 ** 3
            : 1024 ** 4
  return Math.floor(num * mult)
}

function parseSizeRange(spec: string): [number, number] | null {
  if (spec.includes('..')) {
    const [left = '', right = ''] = spec.split('..', 2)
    const min = left ? parseSizeValue(left) : 0
    const max = right ? parseSizeValue(right) : Number.MAX_SAFE_INTEGER
    if (min === null || max === null) return null
    return [min, max]
  }
  if (spec.startsWith('>=')) {
    const v = parseSizeValue(spec.slice(2))
    return v === null ? null : [v, Number.MAX_SAFE_INTEGER]
  }
  if (spec.startsWith('<=')) {
    const v = parseSizeValue(spec.slice(2))
    return v === null ? null : [0, v]
  }
  if (spec.startsWith('>')) {
    const v = parseSizeValue(spec.slice(1))
    return v === null ? null : [v + 1, Number.MAX_SAFE_INTEGER]
  }
  if (spec.startsWith('<')) {
    const v = parseSizeValue(spec.slice(1))
    return v === null ? null : [0, Math.max(0, v - 1)]
  }
  const exact = parseSizeValue(spec)
  return exact === null ? null : [exact, exact]
}

function parseMtimeRange(spec: string, nowMs: number): [number, number] | null {
  const s = spec.toLowerCase()
  const dayMs = 24 * 3600 * 1000
  if (s === 'today') {
    const d = new Date(nowMs)
    d.setHours(0, 0, 0, 0)
    return [d.getTime(), Number.MAX_SAFE_INTEGER]
  }
  if (s === 'yesterday') {
    const d = new Date(nowMs)
    d.setHours(0, 0, 0, 0)
    return [d.getTime() - dayMs, d.getTime()]
  }
  if (s === 'week' || s === '7d') return [nowMs - 7 * dayMs, Number.MAX_SAFE_INTEGER]
  if (s === 'month' || s === '30d') return [nowMs - 30 * dayMs, Number.MAX_SAFE_INTEGER]
  const rel = /^(\d+)([hdw])$/.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    const delta = unit === 'h' ? n * 3600 * 1000 : unit === 'd' ? n * dayMs : n * 7 * dayMs
    return [nowMs - delta, Number.MAX_SAFE_INTEGER]
  }
  return null
}

function normalizePathLower(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function normalizePathPrefix(raw?: string): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  let norm = normalizePathLower(trimmed)
  while (norm.length > 1 && norm.endsWith('/')) {
    if (norm.length === 3 && norm[1] === ':') break
    norm = norm.slice(0, -1)
  }
  return norm
}

function scoreRecordAgainstQuery(record: FileRecord, rawQuery: string, nowMs: number): number | null {
  const trimmed = rawQuery.trim()
  if (!trimmed) return 0

  const nameLower = record.name.toLowerCase()
  const pathLower = normalizePathLower(record.path)
  const dot = nameLower.lastIndexOf('.')
  const extLower = !record.is_dir && dot > 0 && dot + 1 < nameLower.length ? nameLower.slice(dot + 1) : ''
  const acronymLower = (record.acronym || '').toLowerCase()
  const pinyinLower = (record.pinyin || '').toLowerCase()
  const mtimeMs = record.mtime > 0 && record.mtime < 1e11 ? record.mtime * 1000 : record.mtime

  // Split OR branches and AND tokens (respecting quoted phrases)
  const rawTokens = trimmed.match(/[-!]?"[^"]+"|\||\S+/g) ?? []
  const branches: string[][] = [[]]
  for (const tok of rawTokens) {
    if (tok === '|') {
      if (branches[branches.length - 1]!.length > 0) branches.push([])
    } else {
      branches[branches.length - 1]!.push(tok)
    }
  }

  let bestScore: number | null = null
  for (const branch of branches) {
    if (branch.length === 0) continue
    let branchScore = 0
    let ok = true

    for (let raw of branch) {
      let negated = false
      let quoted = false
      if ((raw.startsWith('!') || raw.startsWith('-')) && raw.length > 1) {
        negated = true
        raw = raw.slice(1)
      }
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        quoted = true
        raw = raw.slice(1, -1)
      }
      const lower = raw.toLowerCase()
      if (!lower) continue

      let hit = false
      let cscore = 0

      if (quoted) {
        const hay = lower.includes('/') || lower.includes('\\') ? pathLower : nameLower
        const needle = lower.includes('/') || lower.includes('\\') ? normalizePathLower(lower) : lower
        const idx = hay.indexOf(needle)
        hit = idx !== -1
        cscore = idx === 0 ? 900 : 600
      } else if (lower === 'file:' || lower === 'type:file') {
        hit = !record.is_dir
      } else if (lower === 'folder:' || lower === 'dir:' || lower === 'type:folder' || lower === 'type:dir') {
        hit = record.is_dir
      } else if (lower.startsWith('ext:') && lower.length > 4) {
        const exts = lower.slice(4).split(/[;,]/).map(s => s.replace(/^\.+/, '')).filter(Boolean)
        hit = !record.is_dir && exts.includes(extLower)
        cscore = 450
      } else if ((lower.startsWith('path:') && lower.length > 5) || (lower.startsWith('in:') && lower.length > 3)) {
        const sub = normalizePathLower(lower.startsWith('path:') ? lower.slice(5) : lower.slice(3))
        hit = sub.includes('*') || sub.includes('?') ? matchGlob(sub, pathLower) : pathLower.includes(sub)
        cscore = 650
      } else if (lower.startsWith('size:') && lower.length > 5) {
        const range = parseSizeRange(lower.slice(5))
        if (range) {
          hit = !record.is_dir && record.size >= range[0] && record.size <= range[1]
          cscore = 200
        }
      } else if ((lower.startsWith('dm:') && lower.length > 3) || (lower.startsWith('modified:') && lower.length > 9)) {
        const spec = lower.startsWith('dm:') ? lower.slice(3) : lower.slice(9)
        const range = parseMtimeRange(spec, nowMs)
        if (range) {
          hit = mtimeMs > 0 && mtimeMs >= range[0] && mtimeMs <= range[1]
          cscore = 200
        }
      } else if (lower.startsWith("'") && lower.length > 1) {
        const idx = nameLower.indexOf(lower.slice(1))
        hit = idx !== -1
        cscore = idx === 0 ? 900 : 600
      } else if (lower.startsWith('^') && lower.length > 1) {
        const val = lower.slice(1)
        hit = nameLower.startsWith(val)
        cscore = nameLower === val ? 1200 : 850
      } else if (lower.endsWith('$') && lower.length > 1) {
        hit = nameLower.endsWith(lower.slice(0, -1))
        cscore = 750
      } else if (lower.includes('*') || lower.includes('?')) {
        const usePath = lower.includes('/') || lower.includes('\\')
        hit = matchGlob(usePath ? normalizePathLower(lower) : lower, usePath ? pathLower : nameLower)
        cscore = 700
      } else if (lower.includes('/') || lower.includes('\\') || /^[a-z]:/.test(lower)) {
        hit = pathLower.includes(normalizePathLower(lower))
        cscore = 650
      } else {
        if (nameLower === lower) {
          hit = true
          cscore = 1500
        } else if (nameLower.startsWith(lower)) {
          hit = true
          cscore = 1000
        } else if (nameLower.includes(lower)) {
          hit = true
          cscore = 720
        } else if (acronymLower === lower || pinyinLower === lower) {
          hit = true
          cscore = 920
        } else if (acronymLower.startsWith(lower) || pinyinLower.startsWith(lower)) {
          hit = true
          cscore = 700
        } else if (acronymLower.includes(lower) || pinyinLower.includes(lower)) {
          hit = true
          cscore = 520
        } else if (lower.length >= 2) {
          const fz = fuzzySubsequenceScore(nameLower, lower)
          if (fz > 0) {
            hit = true
            cscore = 320 + Math.min(300, fz)
          } else if (pathLower.includes(lower)) {
            hit = true
            cscore = 260
          }
        } else if (pathLower.includes(lower)) {
          hit = true
          cscore = 260
        }
      }

      if (negated) {
        if (hit) {
          ok = false
          break
        }
      } else {
        if (!hit) {
          ok = false
          break
        }
        branchScore += cscore
      }
    }

    if (ok) {
      const penalty = Math.min(record.name.length, 100) + Math.floor(Math.min(record.path.length, 240) / 8)
      const finalScore = branchScore + (record.is_dir ? 25 : 0) - penalty
      if (bestScore === null || finalScore > bestScore) {
        bestScore = finalScore
      }
    }
  }

  return bestScore
}

/**
 * Unified JS-side query filter/sorter/paginator for fallback & macOS Spotlight paths,
 * mirroring the exact semantics of the native C++20 ztools-indexer query engine.
 */
export function filterSortAndPaginateFileRecords(
  records: readonly FileRecord[],
  query: string,
  limit = 50,
  options: FileSearchOptions = {}
): { files: FileRecord[]; totalMatches: number; offset: number; hasMore: boolean } {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)))
  const safeOffset = Math.max(0, Math.min(4500, Math.trunc(Number(options.offset ?? 0) || 0)))
  const typeMask = resolveContentTypeMask(options.contentType)
  const kind = options.kind ?? 'all'
  const sortBy = options.sortBy ?? 'relevance'
  const includeHidden = options.includeHidden !== false
  const normPrefix = normalizePathPrefix(options.pathPrefix)
  const nowMs = Date.now()

  const scored: Array<{ record: FileRecord; score: number }> = []
  for (const record of records) {
    if (!includeHidden && record.name.startsWith('.')) continue
    if (kind === 'file' && record.is_dir) continue
    if (kind === 'directory' && !record.is_dir) continue
    if (typeMask !== 0 && (classifyFileContentType(record.name, record.is_dir) & typeMask) === 0) continue
    if (normPrefix) {
      const pLower = normalizePathLower(record.path)
      const matchesPrefix = pLower.startsWith(normPrefix) &&
        pLower.length > normPrefix.length &&
        (normPrefix.endsWith('/') || pLower[normPrefix.length] === '/')
      if (!matchesPrefix) continue
    }
    const score = scoreRecordAgainstQuery(record, query, nowMs)
    if (score !== null) {
      scored.push({ record, score })
    }
  }

  scored.sort((a, b) => {
    const ea = a.record
    const eb = b.record
    switch (sortBy) {
      case 'name-asc':
        return ea.name.toLowerCase().localeCompare(eb.name.toLowerCase())
      case 'name-desc':
        return eb.name.toLowerCase().localeCompare(ea.name.toLowerCase())
      case 'size-desc':
        return (eb.size - ea.size) || ea.name.toLowerCase().localeCompare(eb.name.toLowerCase())
      case 'size-asc':
        return (ea.size - eb.size) || ea.name.toLowerCase().localeCompare(eb.name.toLowerCase())
      case 'mtime-desc':
        return (eb.mtime - ea.mtime) || ea.name.toLowerCase().localeCompare(eb.name.toLowerCase())
      case 'mtime-asc':
        return (ea.mtime - eb.mtime) || ea.name.toLowerCase().localeCompare(eb.name.toLowerCase())
      case 'relevance':
      default:
        return (b.score - a.score) ||
          (eb.mtime - ea.mtime) ||
          (ea.path.length - eb.path.length) ||
          ea.name.toLowerCase().localeCompare(eb.name.toLowerCase())
    }
  })

  const totalMatches = scored.length
  const files = scored.slice(safeOffset, safeOffset + safeLimit).map(item => item.record)
  return {
    files,
    totalMatches,
    offset: safeOffset,
    hasMore: safeOffset + files.length < totalMatches
  }
}
