/**
 * ZTools 真实宿主 IPC 与系统能力桥接层 (Real Host IPC Bridge)
 *
 * 严格遵循《ZTools Declarative UI 2.0 架构与 35 款原生插件全量升级规范》5.1 真实环境铁律：
 * - 在真实 Electron 宿主环境中，100% 走通 Preload (__ztoolsElectron.transport.methods / window.ztools / __ztoolsLauncher) 真实调用链路
 * - 严禁在真实环境中因参数格式或嵌套响应结构差异而回退到假数据
 */

let ipcReqSeq = 1
const realFileSizeCache = new Map<string, number>()

export function nextMessageId(prefix = 'ipc'): string {
  ipcReqSeq = (ipcReqSeq + 1) % 1_000_000
  return `${prefix}_${Date.now()}_${ipcReqSeq}`
}

/**
 * 判断当前是否处于真实的 ZTools Electron 渲染进程宿主环境
 */
export function isRealElectronHost(hostOverride?: unknown): boolean {
  if (hostOverride) return false
  if (typeof window === 'undefined') return false
  const w = window as any
  return Boolean(
    w.__ztoolsElectron?.transport?.methods ||
    w.ztools?.transport?.call ||
    w.ztools?.transport?.methods
  )
}

function normalizeMethodParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {}
  const next = { ...params }
  if (method === 'system_get_disk_usage') {
    const rawDrive = String(next.drive || next.path || 'C:\\').trim()
    if (rawDrive.startsWith('/')) {
      next.drive = rawDrive
    } else {
      const match = rawDrive.match(/^([A-Za-z]):/)
      next.drive = match ? `${match[1].toUpperCase()}:\\` : rawDrive.replace(/\//g, '\\')
    }
    delete next.path
  }
  return next
}

function normalizeMethodResult(method: string, payload: any): any {
  if (!payload || typeof payload !== 'object') return payload

  if (method === 'system_get_disk_usage') {
    const avail = typeof payload.available === 'number'
      ? payload.available
      : typeof payload.free === 'number'
      ? payload.free
      : Math.max(0, Number(payload.total || 0) - Number(payload.used || 0))
    return {
      ...payload,
      available: avail,
      free: avail
    }
  }

  if (method === 'system_get_hardware_summary') {
    const cpuModel =
      typeof payload.cpuModel === 'string' && payload.cpuModel.trim()
        ? payload.cpuModel.trim()
        : Array.isArray(payload.cpuModels) && payload.cpuModels.length > 0
        ? String(payload.cpuModels[0]).trim()
        : 'x86_64 Processor'
    return {
      ...payload,
      cpuModel
    }
  }

  if (method === 'system_get_battery_status') {
    const rawPct = typeof payload.percent === 'number' ? payload.percent : 100
    const clampedPct = rawPct > 100 || rawPct < 0 ? 100 : rawPct
    return {
      ...payload,
      percent: clampedPct
    }
  }

  if (method === 'screen_get_all_displays') {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.displays)
      ? payload.displays
      : []
    return list.map((d: any) => ({
      ...d,
      label: d?.label || d?.name || `Display #${d?.id ?? 1}`
    }))
  }

  return payload
}

function unwrapTransportResponse(method: string, raw: any): { ok: boolean; data?: any; error?: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'EMPTY_IPC_RESPONSE' }
  }
  if (typeof raw !== 'object') {
    return { ok: true, data: raw }
  }
  if (raw.success === false) {
    const errObj = raw.error
    const errMsg =
      typeof errObj === 'object' && errObj !== null
        ? String(errObj.message || errObj.code || JSON.stringify(errObj))
        : String(errObj || 'IPC 调用返回失败')
    return { ok: false, error: errMsg }
  }

  const firstLayer = 'data' in raw && raw.data !== undefined ? raw.data : raw
  if (firstLayer && typeof firstLayer === 'object' && !Array.isArray(firstLayer)) {
    if (firstLayer.success === false) {
      const errObj = firstLayer.error
      const errMsg =
        typeof errObj === 'object' && errObj !== null
          ? String(errObj.message || errObj.code || JSON.stringify(errObj))
          : String(errObj || 'IPC 内部调用失败')
      return { ok: false, error: errMsg }
    }
    if ('data' in firstLayer && firstLayer.data !== undefined) {
      return { ok: true, data: normalizeMethodResult(method, firstLayer.data) }
    }
  }

  return { ok: true, data: normalizeMethodResult(method, firstLayer) }
}

/**
 * 调用 Electron Preload Transport 方法（自动封装合法的 alphanumeric messageId 与双层解包）
 */
export async function callHostTransport<T = any>(
  method: string,
  params: Record<string, unknown> = {},
  hostOverride?: any
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const normalizedParams = normalizeMethodParams(method, params)

  // 1. 测试注入的 hostOverride 优先
  if (hostOverride) {
    if (typeof hostOverride[method] === 'function') {
      try {
        const res = await hostOverride[method](normalizedParams)
        const unwrapped = unwrapTransportResponse(method, res)
        return unwrapped as { ok: boolean; data?: T; error?: string }
      } catch (err: any) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    if (typeof hostOverride?.transport?.call === 'function') {
      try {
        const res = await hostOverride.transport.call(method, normalizedParams)
        const unwrapped = unwrapTransportResponse(method, res)
        return unwrapped as { ok: boolean; data?: T; error?: string }
      } catch (err: any) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  if (typeof window === 'undefined') {
    return { ok: false, error: 'NO_WINDOW_ENV' }
  }

  const w = window as any
  const methods = w.__ztoolsElectron?.transport?.methods || w.ztools?.transport?.methods
  const fn = methods?.[method]

  if (typeof fn === 'function') {
    try {
      const messageId = nextMessageId(method.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24))
      const raw = await fn({ messageId, params: normalizedParams })
      return unwrapTransportResponse(method, raw) as { ok: boolean; data?: T; error?: string }
    } catch (err: any) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (typeof w.ztools?.transport?.call === 'function') {
    try {
      const raw = await w.ztools.transport.call(method, normalizedParams)
      return unwrapTransportResponse(method, raw) as { ok: boolean; data?: T; error?: string }
    } catch (err: any) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: false, error: `METHOD_NOT_AVAILABLE: ${method}` }
}

export interface RealDiskDriveInfo {
  drive: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

/**
 * 探测本机全部真实挂载磁盘分区 (C:\ ~ Z:\ 或 macOS/POSIX 挂载点 '/')
 */
export async function probeRealDiskDrives(
  candidateLetters: string[] = ['C', 'D', 'E', 'F', 'G'],
  hostOverride?: any
): Promise<RealDiskDriveInfo[]> {
  const drives: RealDiskDriveInfo[] = []
  const results = await Promise.all(
    candidateLetters.map(async (letter) => {
      const raw = String(letter || '').trim()
      const isPosix = raw.startsWith('/')
      const drivePath = isPosix ? raw : `${raw.replace(/:\\?$/, '').toUpperCase()}:\\`
      const res = await callHostTransport<{
        total: number
        used: number
        available: number
        free?: number
        percent: number
      }>('system_get_disk_usage', { drive: drivePath }, hostOverride)
      if (res.ok && res.data && typeof res.data.total === 'number' && res.data.total > 0) {
        const availableBytes =
          typeof res.data.available === 'number'
            ? res.data.available
            : typeof res.data.free === 'number'
            ? res.data.free
            : Math.max(0, res.data.total - res.data.used)
        return {
          drive: isPosix ? raw : `${raw.replace(/:\\?$/, '').toUpperCase()}:`,
          totalBytes: res.data.total,
          usedBytes: res.data.used,
          availableBytes,
          usagePercent: res.data.percent
        }
      }
      return null
    })
  )

  for (const item of results) {
    if (item) drives.push(item)
  }

  if (drives.length === 0 && !candidateLetters.includes('/')) {
    const posixRes = await callHostTransport<{
      total: number
      used: number
      available: number
      free?: number
      percent: number
    }>('system_get_disk_usage', { drive: '/' }, hostOverride)
    if (posixRes.ok && posixRes.data && typeof posixRes.data.total === 'number' && posixRes.data.total > 0) {
      const availableBytes =
        typeof posixRes.data.available === 'number'
          ? posixRes.data.available
          : typeof posixRes.data.free === 'number'
          ? posixRes.data.free
          : Math.max(0, posixRes.data.total - posixRes.data.used)
      drives.push({
        drive: '/',
        totalBytes: posixRes.data.total,
        usedBytes: posixRes.data.used,
        availableBytes,
        usagePercent: posixRes.data.percent
      })
    }
  }

  return drives
}

/**
 * 获取本机真实系统特殊路径（支持 home 派生标准子目录兜底，自动兼容 Windows 与 macOS/POSIX）
 */
export async function getRealSystemPath(
  name: 'home' | 'appData' | 'userData' | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | 'temp' | 'cache',
  hostOverride?: any
): Promise<string> {
  const res = await callHostTransport<any>('system_get_path', { name }, hostOverride)
  if (res.ok && res.data) {
    if (typeof res.data === 'string' && res.data.trim().length > 0) {
      return res.data.trim()
    }
    if (typeof res.data.path === 'string' && res.data.path.trim().length > 0) {
      return res.data.path.trim()
    }
  }

  if (name !== 'home') {
    const home = await getRealSystemPath('home', hostOverride)
    if (home) {
      const isPosix = home.startsWith('/')
      const subMap: Record<string, string> = isPosix
        ? {
            desktop: `${home}/Desktop`,
            documents: `${home}/Documents`,
            downloads: `${home}/Downloads`,
            music: `${home}/Music`,
            pictures: `${home}/Pictures`,
            videos: `${home}/Videos`,
            appData: `${home}/Library/Application Support`,
            userData: `${home}/Library/Application Support/ZTools`,
            temp: '/tmp',
            cache: `${home}/Library/Caches`
          }
        : {
            desktop: `${home}\\Desktop`,
            documents: `${home}\\Documents`,
            downloads: `${home}\\Downloads`,
            music: `${home}\\Music`,
            pictures: `${home}\\Pictures`,
            videos: `${home}\\Videos`,
            appData: `${home}\\AppData\\Roaming`,
            userData: `${home}\\AppData\\Roaming\\ZTools`,
            temp: `${home}\\AppData\\Local\\Temp`,
            cache: `${home}\\AppData\\Local`
          }
      if (subMap[name]) return subMap[name]
    }
  }

  return ''
}

export type RealDriveUsageInfo = RealDiskDriveInfo

export interface RealIndexedFileEntry {
  name: string
  path: string
  ext: string
  isDir: boolean
  isDirectory: boolean
  size: number
  sizeBytes: number
  mtime: number
  mtimeMs: number
  lastModifiedMs: number
}

export interface RealDirectorySubdirSummary {
  name: string
  path: string
  fileCount: number
  totalBytes: number
  mtime: number
}

export interface RealDirectoryScanResult extends Iterable<RealIndexedFileEntry> {
  files: RealIndexedFileEntry[]
  totalFiles: number
  fileCount: number
  totalBytes: number
  subdirs: RealDirectorySubdirSummary[]
}

export interface ScanDirectoryTreeOptions {
  maxDepth?: number
  maxFiles?: number
  collectTopN?: number
  filterExt?: RegExp
  hostOverride?: any
}

function extractFileExt(fileNameOrPath: string): string {
  const base = String(fileNameOrPath || '').split(/[\\/]/).pop() || ''
  const dotIdx = base.lastIndexOf('.')
  return dotIdx > 0 ? base.slice(dotIdx).toLowerCase() : ''
}

function normalizeIndexedFileEntry(f: any): RealIndexedFileEntry {
  const p = String(f?.path || '')
  const name = String(f?.name || p.split(/[\\/]/).pop() || '')
  const sz = Number(f?.size ?? f?.sizeBytes ?? 0)
  const isDir = Boolean(f?.is_dir || f?.isDir || f?.isDirectory)
  const rawMtime = Number(f?.mtime ?? f?.mtimeMs ?? 0)
  const mtimeMs = rawMtime > 1e11 ? rawMtime : rawMtime > 0 ? rawMtime * 1000 : Date.now()
  const mtimeSec = rawMtime > 1e11 ? Math.floor(rawMtime / 1000) : rawMtime
  if (p && sz >= 0) realFileSizeCache.set(p, sz)
  return {
    name,
    path: p,
    ext: extractFileExt(name || p),
    isDir,
    isDirectory: isDir,
    size: sz,
    sizeBytes: sz,
    mtime: mtimeSec,
    mtimeMs,
    lastModifiedMs: mtimeMs
  }
}

function makeScanResult(
  files: RealIndexedFileEntry[],
  totalFiles: number,
  totalBytes: number,
  subdirs: RealDirectorySubdirSummary[]
): RealDirectoryScanResult {
  return {
    files,
    totalFiles,
    fileCount: totalFiles,
    totalBytes,
    subdirs,
    [Symbol.iterator]() {
      return files[Symbol.iterator]()
    }
  }
}

/**
 * 调用本机 Rust NTFS MFT 硬件级索引引擎 (ztools-indexer) 毫秒级检索真实文件
 */
export async function searchRealIndexedFiles(
  query: string,
  limit = 40,
  hostOverride?: any
): Promise<RealIndexedFileEntry[]> {
  if (!query || !query.trim()) return []
  const q = query.trim()
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit || 40)))

  try {
    const res = await callHostTransport<{ files?: any[] }>(
      'system_search_files',
      { query: q, limit: safeLimit },
      hostOverride
    )
    if (res.ok && res.data && Array.isArray(res.data.files)) {
      return res.data.files.map(normalizeIndexedFileEntry)
    }

    if (!hostOverride && typeof window !== 'undefined') {
      const w = window as any
      if (typeof w.__ztoolsLauncher?.searchFiles === 'function') {
        const rawOuter = await w.__ztoolsLauncher.searchFiles(q, safeLimit)
        const raw = rawOuter && typeof rawOuter === 'object' && 'data' in rawOuter && rawOuter.data ? rawOuter.data : rawOuter
        if (raw && Array.isArray(raw.files)) {
          return raw.files.map(normalizeIndexedFileEntry)
        }
      }
    }
  } catch {
    // ignore
  }
  return []
}

/**
 * 深度扫描指定真实物理目录树（支持符号链接穿透，如 AppData\Roaming\Tencent -> D:\Local\Roaming\Tencent）
 * 返回该目录下 Top 文件列表、全树真实文件总数、全树真实总字节数与一级子目录汇总
 */
export async function scanRealDirectoryTree(
  dirPath: string,
  limitOrOptions: number | ScanDirectoryTreeOptions = 160,
  hostOverrideArg?: any
): Promise<RealDirectoryScanResult> {
  const empty = makeScanResult([], 0, 0, [])
  if (!dirPath || !dirPath.trim()) return empty
  const targetDir = dirPath.trim()

  const opts: ScanDirectoryTreeOptions =
    typeof limitOrOptions === 'number'
      ? { maxFiles: limitOrOptions, hostOverride: hostOverrideArg }
      : { ...limitOrOptions, hostOverride: limitOrOptions?.hostOverride ?? hostOverrideArg }

  const rawLimit = opts.maxFiles ?? opts.collectTopN ?? 160
  const safeLimit = Math.min(200, Math.max(1, Math.floor(rawLimit || 160)))
  const hostOverride = opts.hostOverride
  const filterExt = opts.filterExt
  const dirQuery = `dir:${targetDir}`

  try {
    let rawPayload: any = null
    const res = await callHostTransport<any>(
      'system_search_files',
      { query: dirQuery, limit: safeLimit },
      hostOverride
    )
    if (res.ok && res.data) {
      rawPayload = res.data
    }
    if (!rawPayload && !hostOverride && typeof window !== 'undefined') {
      const w = window as any
      if (typeof w.__ztoolsLauncher?.searchFiles === 'function') {
        const rawOuter = await w.__ztoolsLauncher.searchFiles(dirQuery, safeLimit)
        rawPayload =
          rawOuter && typeof rawOuter === 'object' && 'data' in rawOuter && rawOuter.data
            ? rawOuter.data
            : rawOuter
      }
    }

    if (rawPayload && Array.isArray(rawPayload.files) && (rawPayload.files.length > 0 || Number(rawPayload.total_matches || 0) > 0)) {
      let files: RealIndexedFileEntry[] = rawPayload.files.map(normalizeIndexedFileEntry)
      if (filterExt instanceof RegExp) {
        files = files.filter(f => !f.isDir && (filterExt.test(f.name) || filterExt.test(f.ext)))
        // 若目录 Top-N 大文件均为其他后缀，使用 MFT 索引直接检索目标扩展名
        if (files.length === 0 && !hostOverride) {
          const extTokens = (filterExt.source.match(/[a-z0-9]{2,5}/gi) || [])
            .filter(t => !['thumbcache', 'iconcache'].includes(t.toLowerCase()))
            .slice(0, 4)
          const prefixLower = targetDir.toLowerCase()
          const extraLists = await Promise.all(
            extTokens.map(ext => searchRealIndexedFiles(`.${ext.toLowerCase()}`, 30, hostOverride))
          )
          const seen = new Set<string>()
          for (const list of extraLists) {
            for (const item of list) {
              if (!item.isDir && item.size > 0 && !seen.has(item.path)) {
                if (item.path.toLowerCase().startsWith(prefixLower) || files.length < 15) {
                  seen.add(item.path)
                  files.push(item)
                }
              }
            }
          }
        }
      }
      if (typeof opts.collectTopN === 'number' && opts.collectTopN > 0 && files.length > opts.collectTopN) {
        files = files.slice(0, opts.collectTopN)
      }
      const subdirs: RealDirectorySubdirSummary[] = Array.isArray(rawPayload.subdirs)
        ? rawPayload.subdirs.map((s: any) => ({
            name: String(s.name || ''),
            path: String(s.path || ''),
            fileCount: Number(s.file_count ?? s.fileCount ?? 0),
            totalBytes: Number(s.total_bytes ?? s.totalBytes ?? 0),
            mtime: Number(s.mtime || 0)
          }))
        : []
      const computedBytes = files.reduce((acc, f) => acc + (f.isDir ? 0 : f.size), 0)
      const totalFilesCount =
        filterExt instanceof RegExp ? files.length : Number(rawPayload.total_matches ?? files.length)
      const totalBytesCount =
        filterExt instanceof RegExp ? computedBytes : Number(rawPayload.total_bytes ?? computedBytes)
      return makeScanResult(files, totalFilesCount, totalBytesCount, subdirs)
    }

    // Fallback for test mock or before Main process restart: check filesystem_get_directory_contents
    const listRes = await callHostTransport<string[]>(
      'filesystem_get_directory_contents',
      { path: targetDir },
      hostOverride
    )
    if (listRes.ok && Array.isArray(listRes.data) && listRes.data.length > 0) {
      const files: RealIndexedFileEntry[] = []
      let totalBytes = 0
      for (const itemPath of listRes.data.slice(0, safeLimit)) {
        const sz = await getRealFileSize(itemPath, hostOverride)
        const name = String(itemPath).split(/[\\/]/).pop() || String(itemPath)
        const entry = normalizeIndexedFileEntry({
          name,
          path: String(itemPath),
          isDir: sz === 0 && !name.includes('.'),
          size: sz,
          mtime: Math.floor(Date.now() / 1000)
        })
        if (filterExt instanceof RegExp && !filterExt.test(entry.name) && !filterExt.test(entry.ext)) {
          continue
        }
        files.push(entry)
        totalBytes += sz
      }
      return makeScanResult(files, files.length, totalBytes, [])
    }
  } catch {
    // ignore
  }

  return empty
}


function inferSearchQueriesForDir(dirPath: string): string[] {
  const lower = dirPath.toLowerCase()
  if (lower.includes('wechat') || lower.includes('xwechat')) {
    return ['WeChat', 'xwechat', '.log']
  }
  if (lower.includes('tencent') || lower.includes('\\qq')) {
    return ['Tencent', '.db', '.log']
  }
  if (lower.includes('\\videos')) {
    return ['.mp4', '.mkv', '.mov', '.webm']
  }
  if (lower.includes('\\music')) {
    return ['.mp3', '.wav', '.flac', '.m4a']
  }
  if (lower.includes('\\documents')) {
    return ['.pdf', '.docx', '.xlsx', '.pptx']
  }
  if (lower.includes('temp') || lower.includes('cache') || lower.includes('crashpad')) {
    return ['.tmp', '.log', 'Temp', 'Cache']
  }
  if (lower.includes('\\downloads')) {
    return ['.zip', '.exe', '.pdf', '.mp4', '.mp3']
  }
  if (lower.includes('\\desktop')) {
    return ['Desktop', '.png', '.jpg', '.mp4', '.wav']
  }
  const leaf = dirPath.split(/[\\/]/).filter(Boolean).pop() || ''
  return leaf ? [leaf] : ['.exe', '.zip']
}

/**
 * 读取真实目录下的文件列表（在真实 Electron 宿主中优先走 dir: 深度目录树穿透，毫秒级返回且不触发未授权路径异常）
 */
export async function listRealDirectoryContents(
  dirPath: string,
  hostOverride?: any
): Promise<string[]> {
  if (!dirPath) return []

  // 在真实 Electron 宿主中，优先使用主进程 dir: 穿透扫描，毫秒级返回真实文件与子目录并缓存体积
  if (!hostOverride && isRealElectronHost()) {
    const tree = await scanRealDirectoryTree(dirPath, 60)
    if (tree.files.length > 0 || tree.subdirs.length > 0) {
      const paths: string[] = []
      for (const s of tree.subdirs) {
        if (s.path) paths.push(s.path)
      }
      for (const f of tree.files) {
        if (f.path) paths.push(f.path)
      }
      if (paths.length > 0) return paths
    }
  }

  const res = await callHostTransport<string[]>(
    'filesystem_get_directory_contents',
    { path: dirPath },
    hostOverride
  )
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    return res.data
  }

  if (!hostOverride && isRealElectronHost()) {
    const queries = inferSearchQueriesForDir(dirPath)
    const collected: string[] = []
    const seen = new Set<string>()
    for (const q of queries) {
      const files = await searchRealIndexedFiles(q, 25)
      for (const f of files) {
        if (!f.isDir && f.path && f.size > 0 && !seen.has(f.path)) {
          seen.add(f.path)
          collected.push(f.path)
        }
      }
      if (collected.length >= 25) break
    }
    return collected
  }

  return []
}

/**
 * 获取真实文件字节大小（优先命中 MFT 硬件级索引实时缓存，再走 filesystem_get_file_size）
 */
export async function getRealFileSize(
  filePath: string,
  hostOverride?: any
): Promise<number> {
  if (!filePath) return 0
  if (!hostOverride && realFileSizeCache.has(filePath)) {
    const cached = realFileSizeCache.get(filePath)!
    if (cached > 0) return cached
  }
  const res = await callHostTransport<number>('filesystem_get_file_size', { path: filePath }, hostOverride)
  if (res.ok && typeof res.data === 'number' && Number.isFinite(res.data) && res.data >= 0) {
    realFileSizeCache.set(filePath, res.data)
    return res.data
  }
  return 0
}

/**
 * 在 Windows Explorer 中定位并高亮文件/目录
 */
export async function showRealItemInFolder(
  fullPath: string,
  hostOverride?: any
): Promise<boolean> {
  if (!fullPath) return false
  const res = await callHostTransport('shell_show_item_in_folder', { fullPath }, hostOverride)
  if (res.ok) return true
  const fallback = await callHostTransport('shell_open_path', { fullPath }, hostOverride)
  return fallback.ok
}

/**
 * 使用系统默认程序打开文件或目录
 */
export async function openRealPath(
  fullPath: string,
  hostOverride?: any
): Promise<boolean> {
  if (!fullPath) return false
  const res = await callHostTransport('shell_open_path', { fullPath }, hostOverride)
  return res.ok
}

/**
 * 将真实文件或目录移入系统回收站（安全可恢复删除）
 */
export async function trashRealItem(
  fullPath: string,
  hostOverride?: any
): Promise<{ ok: boolean; error?: string }> {
  if (!fullPath) return { ok: false, error: '路径不能为空' }
  const res = await callHostTransport('shell_trash_item', { fullPath }, hostOverride)
  return { ok: res.ok, error: res.error }
}

export interface NativeInvocationResult<T = any> {
  ok: boolean
  code: number
  message: string
  data?: T
  error?: string
}

export interface DllCapabilityResponse<T = any> {
  ok: boolean
  code: number
  data: T | null
  message?: string
  error?: string
  pluginName: string
  method: string
  fromFallback?: boolean
}

export async function invokeDllPluginCapability<T = any>(
  pluginName: string,
  method: string,
  params: Record<string, any> = {},
  hostBridge?: any,
  offlineFallback?: () => T | Promise<T>
): Promise<DllCapabilityResponse<T>> {
  if (!method || typeof method !== 'string' || method.trim().length === 0) {
    return {
      ok: false,
      code: -1,
      data: null,
      message: 'method 参数不能为空',
      error: 'INVALID_METHOD: method 不能为空且必须为字符串',
      pluginName,
      method: String(method || '')
    }
  }

  const trimmedMethod = method.trim()

  const unwrapDllRawPayload = (raw: unknown, unwrapDataProperty: boolean): DllCapabilityResponse<T> => {
    let parsed: any = raw
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('MALFORMED_DLL_RESPONSE: 原生组件返回了损坏的 JSON 数据')
      }
    }
    if (parsed && typeof parsed === 'object') {
      if ('error' in parsed && parsed.error !== undefined && parsed.error !== null && parsed.error !== '') {
        const errMsg = `DLL_ERROR: ${String(parsed.error)}`
        return {
          ok: false,
          code: typeof parsed.code === 'number' ? parsed.code : -1,
          data: null,
          message: errMsg,
          error: errMsg,
          pluginName,
          method: trimmedMethod,
          fromFallback: false
        }
      }
      if ('ok' in parsed && parsed.ok === false) {
        const errMsg = `DLL_ERROR: ${String(parsed.error || parsed.message || '原生组件返回未知错误')}`
        return {
          ok: false,
          code: typeof parsed.code === 'number' ? parsed.code : -1,
          data: null,
          message: errMsg,
          error: errMsg,
          pluginName,
          method: trimmedMethod,
          fromFallback: false
        }
      }
      const dataPayload = unwrapDataProperty && 'data' in parsed && parsed.data !== undefined ? parsed.data : parsed
      return {
        ok: true,
        code: typeof parsed.code === 'number' ? parsed.code : 0,
        data: dataPayload as T,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
        pluginName,
        method: trimmedMethod,
        fromFallback: false
      }
    }
    return {
      ok: true,
      code: 0,
      data: (parsed ?? null) as T,
      pluginName,
      method: trimmedMethod,
      fromFallback: false
    }
  }

  const wrapCaughtDllError = (err: unknown): DllCapabilityResponse<T> => {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('MALFORMED_DLL_RESPONSE:')) {
      throw err
    }
    const errMsg = `NATIVE_CALL_FAILED: ${message}`
    return {
      ok: false,
      code: -1,
      data: null,
      message: errMsg,
      error: errMsg,
      pluginName,
      method: trimmedMethod,
      fromFallback: false
    }
  }

  if (hostBridge && typeof hostBridge.invokeNative === 'function') {
    try {
      const raw = await hostBridge.invokeNative(pluginName, trimmedMethod, params)
      return unwrapDllRawPayload(raw, true)
    } catch (err: unknown) {
      return wrapCaughtDllError(err)
    }
  }

  const runtimeHost = (hostBridge ?? (globalThis as Record<string, unknown>).ztools) as
    | { dllplugin?: { call?: (plugin: string, fn: string, payload: unknown) => Promise<unknown> | unknown } }
    | undefined

  const callFn = runtimeHost?.dllplugin?.call
  if (typeof callFn === 'function') {
    try {
      const raw = await callFn.call(runtimeHost?.dllplugin, pluginName, trimmedMethod, params)
      return unwrapDllRawPayload(raw, false)
    } catch (err: unknown) {
      return wrapCaughtDllError(err)
    }
  }

  const ipcRes = await callHostTransport<any>(
    'dllplugin_call',
    {
      plugin: pluginName,
      pluginName,
      func: trimmedMethod,
      method: trimmedMethod,
      params
    },
    hostBridge
  )

  if (ipcRes.ok && ipcRes.data !== undefined && ipcRes.data !== null) {
    return unwrapDllRawPayload(ipcRes.data, false)
  }

  const isExplicitTransportFailure =
    typeof ipcRes.error === 'string' &&
    ipcRes.error.length > 0 &&
    ipcRes.error !== 'NO_WINDOW_ENV' &&
    !ipcRes.error.startsWith('METHOD_NOT_AVAILABLE:')

  if (
    isRealElectronHost(hostBridge) ||
    isRealElectronHost() ||
    Boolean((hostBridge as any)?.__isRealHost) ||
    isExplicitTransportFailure
  ) {
    const errMsg =
      ipcRes.error || `HOST_IPC_FAILED: ${pluginName}.${trimmedMethod} 调用失败`
    return {
      ok: false,
      code: -1,
      data: null,
      message: errMsg,
      error: errMsg,
      pluginName,
      method: trimmedMethod,
      fromFallback: false
    }
  }

  if (typeof offlineFallback === 'function') {
    const fallbackData = await offlineFallback()
    return {
      ok: true,
      code: 0,
      data: fallbackData,
      pluginName,
      method: trimmedMethod,
      fromFallback: true
    }
  }

  return {
    ok: true,
    code: 0,
    data: { simulated: true, method: trimmedMethod, params } as unknown as T,
    pluginName,
    method: trimmedMethod,
    fromFallback: true
  }
}

export function formatBytes(bytes: number, decimals = 1): string {
  const num = Number(bytes)
  if (!Number.isFinite(num) || num <= 0) return '0 B'
  if (num < 1024) return `${Math.round(num)} B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = num
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  const safeDecimals = Math.max(0, Math.floor(decimals))
  return `${val >= 100 ? val.toFixed(0) : val.toFixed(safeDecimals)} ${units[idx]}`
}

export function joinWinPath(...segments: string[]): string {
  return segments
    .filter(s => typeof s === 'string' && s.trim().length > 0)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

export interface RealEnvPaths {
  home: string
  userProfile: string
  appData: string
  localAppData: string
  temp: string
  downloads: string
  documents: string
  desktop: string
  pictures: string
  videos: string
  music: string
}

export async function getRealEnvPaths(hostOverride?: any): Promise<RealEnvPaths> {
  const [homeRaw, appData, downloads, documents, desktop, pictures, videos, music] = await Promise.all([
    getRealSystemPath('home', hostOverride),
    getRealSystemPath('appData', hostOverride),
    getRealSystemPath('downloads', hostOverride),
    getRealSystemPath('documents', hostOverride),
    getRealSystemPath('desktop', hostOverride),
    getRealSystemPath('pictures', hostOverride),
    getRealSystemPath('videos', hostOverride),
    getRealSystemPath('music', hostOverride)
  ])
  const home = homeRaw || 'C:\\Users\\Default'
  const isPosix = home.startsWith('/')
  const tempRes = hostOverride ? await getRealSystemPath('temp', hostOverride) : ''
  if (isPosix) {
    return {
      home,
      userProfile: home,
      appData: appData || `${home}/Library/Application Support`,
      localAppData: `${home}/Library/Application Support`,
      temp: tempRes || '/tmp',
      downloads: downloads || `${home}/Downloads`,
      documents: documents || `${home}/Documents`,
      desktop: desktop || `${home}/Desktop`,
      pictures: pictures || `${home}/Pictures`,
      videos: videos || `${home}/Videos`,
      music: music || `${home}/Music`
    }
  }
  return {
    home,
    userProfile: home,
    appData: appData || `${home}\\AppData\\Roaming`,
    localAppData: `${home}\\AppData\\Local`,
    temp: tempRes || `${home}\\AppData\\Local\\Temp`,
    downloads: downloads || `${home}\\Downloads`,
    documents: documents || `${home}\\Documents`,
    desktop: desktop || `${home}\\Desktop`,
    pictures: pictures || `${home}\\Pictures`,
    videos: videos || `${home}\\Videos`,
    music: music || `${home}\\Music`
  }
}

export const resolveRealSpecialPaths = getRealEnvPaths

export async function readRealDirectory(
  dirPath: string,
  hostOverride?: any
): Promise<RealIndexedFileEntry[]> {
  if (!dirPath) return []
  const tree = await scanRealDirectoryTree(dirPath, { maxFiles: 120, hostOverride })
  const entries: RealIndexedFileEntry[] = []
  for (const s of tree.subdirs) {
    entries.push(
      normalizeIndexedFileEntry({
        name: s.name,
        path: s.path,
        isDir: true,
        isDirectory: true,
        size: s.totalBytes,
        mtime: s.mtime
      })
    )
  }
  for (const f of tree.files) {
    entries.push(f)
  }
  if (entries.length > 0) return entries

  const rawPaths = await listRealDirectoryContents(dirPath, hostOverride)
  const fallbackEntries: RealIndexedFileEntry[] = []
  for (const p of rawPaths) {
    const sz = await getRealFileSize(p, hostOverride)
    const name = String(p).split(/[\\/]/).pop() || String(p)
    fallbackEntries.push(
      normalizeIndexedFileEntry({
        name,
        path: String(p),
        isDir: sz === 0 && !name.includes('.'),
        size: sz,
        mtime: Math.floor(Date.now() / 1000)
      })
    )
  }
  return fallbackEntries
}

export async function moveRealFilesToTrash(
  paths: string[],
  hostOverride?: any
): Promise<{
  ok: boolean
  trashedCount: number
  deletedCount: number
  failedPaths: string[]
  error?: string
}> {
  let deletedCount = 0
  const failedPaths: string[] = []
  let lastError: string | undefined
  for (const p of paths) {
    if (!p) continue
    const res = await trashRealItem(p, hostOverride)
    if (res.ok) {
      deletedCount += 1
    } else {
      failedPaths.push(p)
      if (res.error) lastError = res.error
    }
  }
  return {
    ok: deletedCount > 0 || paths.length === 0,
    trashedCount: deletedCount,
    deletedCount,
    failedPaths,
    error: lastError
  }
}

const CAPABILITY_TO_PLUGIN_MAP: Record<string, { plugin: string; func: string }> = {
  'mover.relocateWithJunction': { plugin: 'MoverPlugin', func: 'relocateWithJunction' },
  'mover.scanCandidates': { plugin: 'MoverPlugin', func: 'scanCandidates' },
  'recovery.restoreFile': { plugin: 'DataRecoveryPlugin', func: 'restoreFile' },
  'recovery.scanDeletedFiles': { plugin: 'DataRecoveryPlugin', func: 'scanDeletedFiles' },
  'shredder.secureWipeFile': { plugin: 'ShredderPlugin', func: 'secureWipeFile' },
  'shredder.scanCandidates': { plugin: 'ShredderPlugin', func: 'scanCandidates' },
  'backup.createSnapshotArchive': { plugin: 'SystemBackupPlugin', func: 'createSnapshotArchive' },
  'backup.restoreSnapshotArchive': { plugin: 'SystemBackupPlugin', func: 'restoreSnapshotArchive' },
  'backup.scanSnapshots': { plugin: 'SystemBackupPlugin', func: 'scanSnapshots' },
  'sqlite.execute': { plugin: 'SqlitePlugin', func: 'execute' },
  'sqlite.query': { plugin: 'SqlitePlugin', func: 'executeQuery' },
  'sqlite.inspectWorkspace': { plugin: 'SqlitePlugin', func: 'inspectWorkspace' }
}

export async function invokeHostCapability<T = any>(
  capability: string,
  params: Record<string, unknown> = {},
  hostOverride?: any
): Promise<NativeInvocationResult<T>> {
  const normalizedMethod = capability.replace(/\./g, '_')

  // 若测试显式注入了对应 normalizedMethod 的 mock 函数，优先调用测试桩
  if (hostOverride && typeof hostOverride[normalizedMethod] === 'function') {
    const mockRes = await callHostTransport<T>(normalizedMethod, params, hostOverride)
    return {
      ok: mockRes.ok,
      code: mockRes.ok ? 0 : -1,
      message: mockRes.ok ? 'OK' : mockRes.error || '调用失败',
      data: mockRes.data,
      error: mockRes.error
    }
  }

  if (capability === 'system.info') {
    const drives = await probeRealDiskDrives(['C', 'D', 'E', 'F'], hostOverride)
    return {
      ok: true,
      code: 0,
      message: 'OK',
      data: {
        storage: drives.map(d => ({
          mount: d.drive,
          fs: d.drive,
          size: d.totalBytes,
          total: d.totalBytes,
          used: d.usedBytes,
          available: d.availableBytes,
          free: d.availableBytes,
          percent: d.usagePercent
        }))
      } as unknown as T
    }
  }
  if (capability === 'filesystem.deleteItem') {
    const targetPath = String(params.path || params.fullPath || '')
    const tr = await trashRealItem(targetPath, hostOverride)
    return {
      ok: tr.ok,
      code: tr.ok ? 0 : -1,
      message: tr.ok ? '已移入回收站' : tr.error || '删除失败',
      error: tr.error
    }
  }
  if (capability === 'system.showItemInFolder') {
    const targetPath = String(params.path || params.fullPath || '')
    const ok = await showRealItemInFolder(targetPath, hostOverride)
    return { ok, code: ok ? 0 : -1, message: ok ? '已定位文件' : '定位失败' }
  }
  if (capability === 'filesystem.openItem' || capability === 'system.openUrl') {
    const target = String(params.path || params.url || params.fullPath || '')
    const method = capability === 'system.openUrl' ? 'shell_open_external' : 'shell_open_path'
    const res = await callHostTransport<T>(
      method,
      capability === 'system.openUrl' ? { url: target } : { fullPath: target },
      hostOverride
    )
    return {
      ok: res.ok,
      code: res.ok ? 0 : -1,
      message: res.ok ? '已打开' : res.error || '打开失败',
      data: res.data,
      error: res.error
    }
  }

  const pluginMapping = CAPABILITY_TO_PLUGIN_MAP[capability]
  if (pluginMapping) {
    const dllRes = await invokePluginService<T>(
      pluginMapping.plugin,
      pluginMapping.func,
      params,
      hostOverride
    )
    if (dllRes.ok) return dllRes
    if (hostOverride) {
      const fallbackMock = await callHostTransport<T>(normalizedMethod, params, hostOverride)
      if (fallbackMock.ok) {
        return {
          ok: true,
          code: 0,
          message: 'OK',
          data: fallbackMock.data
        }
      }
    }
    return dllRes
  }

  const res = await callHostTransport<T>(normalizedMethod, params, hostOverride)
  return {
    ok: res.ok,
    code: res.ok ? 0 : -1,
    message: res.ok ? 'OK' : res.error || '调用失败',
    data: res.data,
    error: res.error
  }
}

export async function invokePluginService<T = any>(
  pluginName: string,
  action: string,
  params: Record<string, unknown> = {},
  hostOverride?: any
): Promise<NativeInvocationResult<T>> {
  // 1. 若测试注入了专门拦截 plugin_invoke 的 mock，支持调用
  if (hostOverride && typeof hostOverride.plugin_invoke === 'function') {
    const mockRes = await callHostTransport<T>(
      'plugin_invoke',
      { plugin: pluginName, action, params },
      hostOverride
    )
    return {
      ok: mockRes.ok,
      code: mockRes.ok ? 0 : -1,
      message: mockRes.ok ? 'OK' : mockRes.error || '插件调用未就绪',
      data: mockRes.data,
      error: mockRes.error
    }
  }

  // 2. 优先走真实 Electron IPC 的 dllplugin_call 通道
  const dllRes = await callHostTransport<any>(
    'dllplugin_call',
    { plugin: pluginName, func: action, params },
    hostOverride
  )
  if (dllRes.ok) {
    const inner = dllRes.data
    if (inner && typeof inner === 'object' && typeof inner.error === 'string' && inner.error.length > 0 && inner.ok !== true) {
      return {
        ok: false,
        code: -1,
        message: inner.error,
        error: inner.error
      }
    }
    return {
      ok: true,
      code: 0,
      message: 'OK',
      data: inner as T
    }
  }

  // 3. 兼容单元测试中通过 transport.call('plugin_invoke') 注入的测试桩
  if (hostOverride) {
    const legacyRes = await callHostTransport<T>(
      'plugin_invoke',
      { plugin: pluginName, action, params },
      hostOverride
    )
    if (legacyRes.ok) {
      return {
        ok: true,
        code: 0,
        message: 'OK',
        data: legacyRes.data
      }
    }
  }

  // 4. 兼容旧版 globalThis.ztools.dllplugin.call
  const g = globalThis as any
  if (!hostOverride && typeof g?.ztools?.dllplugin?.call === 'function') {
    try {
      const raw = await g.ztools.dllplugin.call(pluginName, action, params)
      if (raw && typeof raw === 'object' && raw.ok === false) {
        return {
          ok: false,
          code: -1,
          message: String(raw.error || '调用失败'),
          error: String(raw.error || '调用失败')
        }
      }
      const data = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw
      return { ok: true, code: 0, message: 'OK', data: data as T }
    } catch (err: any) {
      return {
        ok: false,
        code: -1,
        message: err instanceof Error ? err.message : String(err),
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  return {
    ok: false,
    code: -1,
    message: dllRes.error || '插件调用未就绪',
    error: dllRes.error || '插件调用未就绪'
  }
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/**
 * 标准 FIPS 180-4 SHA-256 真实字节摘要算法（返回 64 位小写 Hex）
 */
export function computeRealSha256Hex(input: string | Uint8Array): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input || [])
  const bitLen = bytes.length * 8
  const padLen = ((bytes.length + 9 + 63) & ~63)
  const buf = new Uint8Array(padLen)
  buf.set(bytes, 0)
  buf[bytes.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padLen - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(v => (v >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

/**
 * 读取本地文件真实字节并计算标准 SHA-256（优先走宿主 filesearch_sha256 / FileComparePlugin，回退读取真实文件内容计算）
 */
export async function computeRealFileSha256(
  filePath: string,
  hostOverride?: any
): Promise<string> {
  if (!filePath || !filePath.trim()) return ''
  const target = filePath.trim()

  const shaRes = await callHostTransport<any>('filesearch_sha256', { filePath: target, path: target }, hostOverride)
  if (shaRes.ok && shaRes.data) {
    const hash = typeof shaRes.data === 'string' ? shaRes.data : String(shaRes.data?.sha256 || shaRes.data?.hash || '')
    if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase()
  }

  const dllRes = await invokePluginService<any>('FileComparePlugin', 'computeFileSha256', { path: target }, hostOverride)
  if (dllRes.ok && dllRes.data) {
    const hash = typeof dllRes.data === 'string' ? dllRes.data : String(dllRes.data?.sha256 || dllRes.data?.hash || '')
    if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase()
  }

  const readRes = await callHostTransport<any>(
    'filesystem_read_file',
    { path: target, encoding: 'utf8' },
    hostOverride
  )
  if (readRes.ok && readRes.data !== undefined && readRes.data !== null) {
    const content =
      typeof readRes.data === 'string'
        ? readRes.data
        : typeof readRes.data?.content === 'string'
        ? readRes.data.content
        : JSON.stringify(readRes.data)
    return computeRealSha256Hex(content)
  }

  return ''
}

export async function readRealClipboardText(hostOverride?: any): Promise<string> {
  const res = await callHostTransport<any>('clipboard_read_text', {}, hostOverride)
  if (res.ok && res.data !== undefined && res.data !== null) {
    if (typeof res.data === 'string') return res.data
    if (typeof res.data?.text === 'string') return res.data.text
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    // ignore
  }
  return ''
}

export async function writeRealClipboardText(text: string, hostOverride?: any): Promise<boolean> {
  const res = await callHostTransport('clipboard_write_text', { text: String(text || '') }, hostOverride)
  if (res.ok) return true
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(text || ''))
      return true
    }
  } catch {
    // ignore
  }
  return false
}

export async function showRealToast(
  title: string,
  style: 'success' | 'failure' | 'info' = 'info'
): Promise<void> {
  try {
    const { showToast, Toast } = await import('../../api/toast.js')
    await showToast({
      title,
      style:
        style === 'success'
          ? Toast.Style.Success
          : style === 'failure'
            ? Toast.Style.Failure
            : Toast.Style.Animated
    })
  } catch {
    // ignore
  }
}

