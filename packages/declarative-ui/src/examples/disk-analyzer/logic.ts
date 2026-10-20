/**
 * 磁盘空间深度分析业务逻辑与真实环境契约层 (DiskAnalyzer Logic - 1:1 完整复刻版)
 * 对接 Electron 真实磁盘分区探针 (system_get_disk_usage)、MFT + 真实目录深度扫描、
 * 10 大官方 FileTypeGroup 分类体系 (file_type_rules.cpp) 与二级扩展名下钻统计
 */

import {
  formatBytes,
  getRealFileSize,
  getRealSystemPath,
  invokeDllPluginCapability,
  isRealElectronHost,
  listRealDirectoryContents,
  probeRealDiskDrives,
  scanRealDirectoryTree,
  searchRealIndexedFiles,
  showRealItemInFolder,
  trashRealItem,
  openRealPath
} from '../shared/native-ipc.js'

export { formatBytes, isRealElectronHost } from '../shared/native-ipc.js'

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export interface DiskDriveItem {
  drive: string
  label: string
  fileSystem: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
  status: 'normal' | 'warning' | 'danger'
}

/**
 * 对应原版 DLLPlugins/disk-analyzer/src/file_type_rules.cpp 的 10 大官方文件类型分组
 */
export type OfficialFileTypeGroupId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 99

export interface OfficialFileTypeGroupMeta {
  groupId: OfficialFileTypeGroupId
  name: string
  shortName: string
  color: string
  legacyCategory: DiskFileEntry['category']
  description: string
  sampleQueries: string[]
}

export const OFFICIAL_FILE_TYPE_GROUPS: OfficialFileTypeGroupMeta[] = [
  {
    groupId: 1,
    name: '视频文件',
    shortName: '视频文件',
    color: '#a855f7',
    legacyCategory: 'video',
    description: '高清影视、录屏素材、直播缓存与流媒体切片 (.mp4, .mkv, .mov, .avi, .webm, .ts)',
    sampleQueries: ['.mp4', '.mkv', '.mov', '.webm']
  },
  {
    groupId: 2,
    name: '音频文件',
    shortName: '音频文件',
    color: '#ec4899',
    legacyCategory: 'video',
    description: '无损音乐、播客录音、语音素材与音效文件 (.mp3, .flac, .wav, .m4a, .aac, .ogg)',
    sampleQueries: ['.mp3', '.wav', '.flac', '.m4a']
  },
  {
    groupId: 3,
    name: '图片文件',
    shortName: '图片文件',
    color: '#10b981',
    legacyCategory: 'other',
    description: '相机照片、设计原图、截图与图标纹理 (.png, .jpg, .webp, .svg, .psd, .gif, .bmp)',
    sampleQueries: ['.png', '.jpg', '.webp', '.svg']
  },
  {
    groupId: 4,
    name: '文档文件',
    shortName: '文档文件',
    color: '#3b82f6',
    legacyCategory: 'document',
    description: '办公文档、PDF 电子书、表格报表与演示文稿 (.pdf, .docx, .xlsx, .pptx, .md, .txt)',
    sampleQueries: ['.pdf', '.docx', '.xlsx', '.pptx']
  },
  {
    groupId: 5,
    name: '压缩包与镜像',
    shortName: '压缩包',
    color: '#f59e0b',
    legacyCategory: 'archive',
    description: '归档压缩包、系统光盘镜像与固件包 (.zip, .7z, .rar, .tar, .gz, .iso, .wim)',
    sampleQueries: ['.zip', '.7z', '.rar', '.gz']
  },
  {
    groupId: 6,
    name: '安装包与程序',
    shortName: '安装包',
    color: '#f97316',
    legacyCategory: 'installer',
    description: 'Windows 可执行安装程序、MSI 部署包与独立启动器 (.exe, .msi, .msix, .appx)',
    sampleQueries: ['.exe', '.msi']
  },
  {
    groupId: 7,
    name: '代码与工程文件',
    shortName: '代码文件',
    color: '#06b6d4',
    legacyCategory: 'other',
    description: '源码文件、前端构建产物、脚本与工程配置 (.ts, .js, .vue, .py, .cpp, .rs, .json)',
    sampleQueries: ['.js', '.ts', '.json', '.wasm']
  },
  {
    groupId: 8,
    name: '系统与运行库',
    shortName: '系统文件',
    color: '#ef4444',
    legacyCategory: 'temp',
    description: '动态链接库、驱动程序、崩溃转储与运行日志 (.dll, .sys, .pdb, .dmp, .log, .tmp)',
    sampleQueries: ['.dll', '.log', '.dmp', '.pdb']
  },
  {
    groupId: 9,
    name: '数据库与资源包',
    shortName: '数据库/资源',
    color: '#6366f1',
    legacyCategory: 'document',
    description: 'SQLite 数据库、Electron 资源封包与索引数据 (.db, .sqlite, .asar, .pak, .bin, .dat)',
    sampleQueries: ['.db', '.asar', '.pak', '.bin']
  },
  {
    groupId: 99,
    name: '其他文件',
    shortName: '其他文件',
    color: '#64748b',
    legacyCategory: 'other',
    description: '未归入以上 9 类的字体、模型权重、专有缓存与无后缀数据文件',
    sampleQueries: ['.ttf', '.woff2']
  }
]

export interface DiskFileEntry {
  id: string
  name: string
  path: string
  parentDir: string
  drive: string
  extension: string
  category: 'video' | 'archive' | 'installer' | 'document' | 'temp' | 'other'
  groupId: OfficialFileTypeGroupId
  groupName: string
  groupColor: string
  sizeBytes: number
  mtime: number
  isProtected: boolean
}

export interface DiskExtStat {
  extension: string
  groupId: OfficialFileTypeGroupId
  categoryLabel: string
  fileCount: number
  totalSizeBytes: number
  sharePercent: number
}

export interface DiskGroupStat {
  groupId: OfficialFileTypeGroupId
  name: string
  shortName: string
  color: string
  description: string
  fileCount: number
  totalSizeBytes: number
  sharePercent: number
  topExtensions: DiskExtStat[]
}

export interface DiskAnalysisSnapshot {
  drives: DiskDriveItem[]
  files: DiskFileEntry[]
  extStats: DiskExtStat[]
  groupStats: DiskGroupStat[]
  topDirectories?: Array<{
    name: string
    path: string
    drive: string
    sizeBytes: number
    fileCount: number
  }>
  totalCapacityBytes: number
  totalUsedBytes: number
  totalAvailableBytes: number
}

export const DLL_PLUGIN_NAME = 'AnalyzerPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp(
  '^(?:C:\\\\Windows(?:\\\\.*)?|C:\\\\System Volume Information(?:\\\\.*)?|C:\\\\Program Files(?:\\\\.*)?|C:\\\\Program Files \\(x86\\)(?:\\\\.*)?)$',
  'i'
)
export const FORBIDDEN_REASON = '系统核心目录与卷影副本区受保护，禁止通过分析器直接清理'

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'disk-c-overview',
    title: '系统盘 (C:) 空间占用深度透视',
    subtitle: '定位 AppData、休眠文件、虚拟内存与大体积残留目录',
    tag: '系统盘分析',
    method: 'StartScanAsync',
    params: { drive: 'C:\\' }
  },
  {
    id: 'disk-large-files',
    title: '全盘超大文件排行榜 (> 500MB)',
    subtitle: '快速揪出遗忘的系统镜像 ISO、未清理安装包与冗余视频',
    tag: '大文件排行',
    method: 'GetGroupFiles',
    params: { minSizeMb: 500 }
  },
  {
    id: 'disk-ext-stats',
    title: '按文件扩展名类型统计空间分布',
    subtitle: '统计视频、开发依赖 (node_modules)、文档与归档占比',
    tag: '类型分布',
    method: 'GetExtensionStats',
    params: { topN: 20 }
  },
  {
    id: 'disk-drives-list',
    title: '查看本机全部物理卷与挂载分区健康度',
    subtitle: '汇总各分区总容量、剩余可用空间与文件系统格式',
    tag: '分区概览',
    method: 'GetAvailableDrives',
    params: {}
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return PRESET_ITEMS.map(item => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(item => {
    if (!item || typeof item.title !== 'string') return false
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
    )
  })
}

export function formatDateTime(mtimeSeconds: number): string {
  if (!mtimeSeconds || !Number.isFinite(mtimeSeconds) || mtimeSeconds <= 0) return '未知时间'
  const ms = mtimeSeconds > 1e12 ? mtimeSeconds : mtimeSeconds * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '未知时间'
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
    return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }

  const record = params as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      if (val.length > 4096) {
        return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` }
      }
      if (FORBIDDEN_TARGET_PATTERN.test(val)) {
        return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` }
      }
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val) || val < -1000 || val > 100_000_000) {
        return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` }
      }
    }
  }

  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: { dllplugin?: { call?: (plugin: string, fn: string, payload: unknown) => Promise<unknown> }; __isRealHost?: boolean }
): Promise<NativeInvocationResult> {
  const check = validateInvocationPayload(method, params)
  if (!check.valid) {
    throw new Error(check.error || '参数校验失败')
  }
  const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, method, params, hostBridge)
  return {
    ok: res.ok,
    pluginName: DLL_PLUGIN_NAME,
    method: method.trim(),
    data: res.data ?? undefined,
    error: res.error,
    fromFallback: res.fromFallback
  }
}

export function getGroupMetaById(groupId: OfficialFileTypeGroupId): OfficialFileTypeGroupMeta {
  return OFFICIAL_FILE_TYPE_GROUPS.find(g => g.groupId === groupId) || OFFICIAL_FILE_TYPE_GROUPS[OFFICIAL_FILE_TYPE_GROUPS.length - 1]
}

/**
 * 1:1 复刻 file_type_rules.cpp 的 10 大官方分类判定规则
 */
export function classifyFileExtension(filePath: string): {
  extension: string
  category: DiskFileEntry['category']
  categoryLabel: string
  groupId: OfficialFileTypeGroupId
  groupName: string
  groupColor: string
} {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const dotIdx = name.lastIndexOf('.')
  const ext = dotIdx > 0 ? name.slice(dotIdx).toLowerCase() : '(无扩展名)'

  let groupId: OfficialFileTypeGroupId = 99
  if (/\.(?:mp4|mkv|mov|avi|flv|webm|wmv|mts|m2ts|m4v|rmvb|mpg|mpeg|3gp)$/i.test(ext)) {
    groupId = 1
  } else if (/\.(?:mp3|flac|wav|aac|ogg|wma|m4a|opus|ape|mid)$/i.test(ext)) {
    groupId = 2
  } else if (/\.(?:jpg|jpeg|png|gif|bmp|webp|svg|psd|raw|ico|tif|tiff|heic|avif)$/i.test(ext)) {
    groupId = 3
  } else if (/\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|md|txt|csv|rtf|epub|mobi|odt|wps)$/i.test(ext)) {
    groupId = 4
  } else if (/\.(?:zip|7z|rar|tar|gz|bz2|xz|iso|wim|cab|dmg|tgz|zst)$/i.test(ext)) {
    groupId = 5
  } else if (/\.(?:exe|msi|msix|appx|apk|bat|cmd|com|scr)$/i.test(ext)) {
    groupId = 6
  } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|cpp|c|h|hpp|rs|go|java|cs|json|yaml|yml|toml|xml|html|css|scss|less|sql|sh|ps1|wasm|map)$/i.test(ext)) {
    groupId = 7
  } else if (/\.(?:dll|sys|drv|ocx|pdb|dmp|log|tmp|bak|old|cat|inf|mui|winmd|etl|evtx|pf)$/i.test(ext)) {
    groupId = 8
  } else if (/\.(?:db|sqlite|sqlite3|wal|shm|mdf|ldf|accdb|mdb|frm|ibd|idx|dat|bin|pak|asar|vmdk|vhdx|vhd)$/i.test(ext)) {
    groupId = 9
  }

  const meta = getGroupMetaById(groupId)
  return {
    extension: ext,
    category: meta.legacyCategory,
    categoryLabel: meta.shortName,
    groupId: meta.groupId,
    groupName: meta.name,
    groupColor: meta.color
  }
}

export function computeExtStats(files: DiskFileEntry[]): DiskExtStat[] {
  const map = new Map<
    string,
    { groupId: OfficialFileTypeGroupId; categoryLabel: string; fileCount: number; totalSizeBytes: number }
  >()
  let grandTotal = 0

  for (const f of files) {
    grandTotal += f.sizeBytes
    const info = classifyFileExtension(f.name)
    const cur = map.get(info.extension) || {
      groupId: info.groupId,
      categoryLabel: info.categoryLabel,
      fileCount: 0,
      totalSizeBytes: 0
    }
    cur.fileCount += 1
    cur.totalSizeBytes += f.sizeBytes
    map.set(info.extension, cur)
  }

  const list: DiskExtStat[] = []
  for (const [extension, val] of map.entries()) {
    list.push({
      extension,
      groupId: val.groupId,
      categoryLabel: val.categoryLabel,
      fileCount: val.fileCount,
      totalSizeBytes: val.totalSizeBytes,
      sharePercent: grandTotal > 0 ? Math.max(1, Math.round((val.totalSizeBytes / grandTotal) * 100)) : 0
    })
  }

  return list.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
}

/**
 * 汇总 10 大官方分类统计及其内部二级扩展名占比
 */
export function computeGroupStats(files: DiskFileEntry[]): DiskGroupStat[] {
  const grandTotal = files.reduce((acc, f) => acc + f.sizeBytes, 0)
  const byGroup = new Map<OfficialFileTypeGroupId, DiskFileEntry[]>()
  for (const g of OFFICIAL_FILE_TYPE_GROUPS) {
    byGroup.set(g.groupId, [])
  }
  for (const f of files) {
    const gid = f.groupId || classifyFileExtension(f.name).groupId
    const arr = byGroup.get(gid) || []
    arr.push(f)
    byGroup.set(gid, arr)
  }

  const result: DiskGroupStat[] = []
  for (const meta of OFFICIAL_FILE_TYPE_GROUPS) {
    const groupFiles = byGroup.get(meta.groupId) || []
    const totalSizeBytes = groupFiles.reduce((acc, f) => acc + f.sizeBytes, 0)
    const sharePercent =
      grandTotal > 0 && totalSizeBytes > 0
        ? Math.max(1, Math.round((totalSizeBytes / grandTotal) * 100))
        : 0
    const topExtensions = computeExtStats(groupFiles).slice(0, 12)
    result.push({
      groupId: meta.groupId,
      name: meta.name,
      shortName: meta.shortName,
      color: meta.color,
      description: meta.description,
      fileCount: groupFiles.length,
      totalSizeBytes,
      sharePercent,
      topExtensions
    })
  }

  return result.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
}

function extractDrivePrefix(filePath: string): string {
  const m = String(filePath || '').match(/^([A-Za-z]:)/)
  return m ? m[1].toUpperCase() : 'C:'
}

/**
 * 采集本机真实磁盘分区、10 大分类分布与热点大文件全景快照
 */
export async function fetchDiskAnalysisSnapshot(hostOverride?: any): Promise<DiskAnalysisSnapshot> {
  // 1. 探测真实磁盘分区 (C:/ ~ G:/)
  const rawDrives = await probeRealDiskDrives(['C', 'D', 'E', 'F', 'G'], hostOverride)
  const drives: DiskDriveItem[] = rawDrives.map(d => ({
    drive: d.drive,
    label: d.drive === 'C:' ? '系统主分区 (C:)' : `本地数据卷 (${d.drive})`,
    fileSystem: 'NTFS',
    totalBytes: d.totalBytes,
    usedBytes: d.usedBytes,
    availableBytes: d.availableBytes,
    usagePercent: d.usagePercent,
    status: d.usagePercent >= 90 ? 'danger' : d.usagePercent >= 75 ? 'warning' : 'normal'
  }))

  // 2. 获取标准用户目录
  const [downloadsDir, documentsDir, desktopDir, videosDir, tempDir] = await Promise.all([
    getRealSystemPath('downloads', hostOverride),
    getRealSystemPath('documents', hostOverride),
    getRealSystemPath('desktop', hostOverride),
    getRealSystemPath('videos', hostOverride),
    getRealSystemPath('temp', hostOverride)
  ])

  const scanDirs = [downloadsDir, documentsDir, desktopDir, videosDir, tempDir].filter(Boolean)
  const files: DiskFileEntry[] = []
  const seenPaths = new Set<string>()

  const addFileEntry = (fullPath: string, sizeBytes: number, mtime = 0) => {
    if (!fullPath || sizeBytes <= 0) return
    const normKey = fullPath.replace(/\//g, '\\').toLowerCase()
    if (seenPaths.has(normKey)) return
    seenPaths.add(normKey)

    const cleanPath = fullPath.replace(/\//g, '\\')
    const lastSep = cleanPath.lastIndexOf('\\')
    const name = lastSep >= 0 ? cleanPath.slice(lastSep + 1) : cleanPath
    const parentDir = lastSep > 0 ? cleanPath.slice(0, lastSep) : cleanPath
    const cls = classifyFileExtension(name)
    files.push({
      id: `file-${files.length}-${name}`,
      name,
      path: cleanPath,
      parentDir,
      drive: extractDrivePrefix(cleanPath),
      extension: cls.extension,
      category: cls.category,
      groupId: cls.groupId,
      groupName: cls.groupName,
      groupColor: cls.groupColor,
      sizeBytes,
      mtime: mtime || Math.floor(Date.now() / 1000),
      isProtected: FORBIDDEN_TARGET_PATTERN.test(cleanPath)
    })
  }

  const supportsDeepScan =
    (!hostOverride && isRealElectronHost()) ||
    typeof hostOverride?.system_search_files === 'function'

  const topDirectories: Array<{
    name: string
    path: string
    drive: string
    sizeBytes: number
    fileCount: number
  }> = []
  const seenDirs = new Set<string>()

  if (supportsDeepScan) {
    // 在真实 Electron 宿主或支持 dir: 深度扫描的环境中，直接并发调用 dir: 深度目录树扫描（基于本机真实挂载盘符与系统用户目录，严禁硬编码路径）
    const driveRoots = !hostOverride
      ? rawDrives.map(d => (d.drive.startsWith('/') ? d.drive : `${d.drive}\\`))
      : []
    const realTargetDirs = Array.from(new Set([...scanDirs, ...driveRoots])).filter(Boolean)

    const dirScans = await Promise.all(
      realTargetDirs.map(d => scanRealDirectoryTree(d, 100, hostOverride))
    )
    for (const res of dirScans) {
      if (Array.isArray(res.subdirs)) {
        for (const sub of res.subdirs) {
          if (!sub.path || sub.totalBytes <= 0) continue
          const normSub = sub.path.replace(/\//g, '\\').toLowerCase()
          if (seenDirs.has(normSub)) continue
          seenDirs.add(normSub)
          const cleanSub = sub.path.replace(/\//g, '\\')
          topDirectories.push({
            name: sub.name || cleanSub.split('\\').pop() || cleanSub,
            path: cleanSub,
            drive: extractDrivePrefix(cleanSub),
            sizeBytes: sub.totalBytes,
            fileCount: sub.fileCount || 0
          })
        }
      }
      for (const f of res.files) {
        if (!f.isDir && f.size > 0) {
          addFileEntry(f.path, f.size, f.mtime)
        }
      }
    }
  } else {
    // 兼容单元测试与自定义 hostOverride 目录扫描链路
    for (const dir of scanDirs) {
      const entries = await listRealDirectoryContents(dir, hostOverride)
      const slice = entries.slice(0, 24)
      const sizes = await Promise.all(slice.map(p => getRealFileSize(p, hostOverride)))

      for (let i = 0; i < slice.length; i++) {
        addFileEntry(slice[i], sizes[i] || 0)
      }
    }
  }

  files.sort((a, b) => b.sizeBytes - a.sizeBytes)
  topDirectories.sort((a, b) => b.sizeBytes - a.sizeBytes)
  const extStats = computeExtStats(files)
  const groupStats = computeGroupStats(files)

  const totalCapacityBytes = drives.reduce((s, d) => s + d.totalBytes, 0)
  const totalUsedBytes = drives.reduce((s, d) => s + d.usedBytes, 0)
  const totalAvailableBytes = drives.reduce((s, d) => s + d.availableBytes, 0)

  return {
    drives,
    files,
    extStats,
    groupStats,
    topDirectories,
    totalCapacityBytes,
    totalUsedBytes,
    totalAvailableBytes
  }
}

/**
 * 安全删除磁盘大文件（移入系统回收站，拦截系统保护目录）
 */
export async function deleteDiskFileItem(
  filePath: string,
  hostOverride?: any
): Promise<{ ok: boolean; error?: string }> {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '文件路径不能为空' }
  }
  if (FORBIDDEN_TARGET_PATTERN.test(filePath.trim())) {
    return { ok: false, error: FORBIDDEN_REASON }
  }
  return trashRealItem(filePath.trim(), hostOverride)
}

/**
 * 批量将选中的磁盘文件安全移入系统回收站
 */
export async function batchDeleteDiskFileItems(
  filePaths: string[],
  hostOverride?: any
): Promise<{
  succeeded: string[]
  failed: Array<{ path: string; error: string }>
}> {
  const succeeded: string[] = []
  const failed: Array<{ path: string; error: string }> = []
  for (const rawPath of filePaths) {
    const res = await deleteDiskFileItem(rawPath, hostOverride)
    if (res.ok) {
      succeeded.push(rawPath)
    } else {
      failed.push({ path: rawPath, error: res.error || '移除失败' })
    }
  }
  return { succeeded, failed }
}

/**
 * 在资源管理器中定位文件或分区
 */
export async function openDiskItemLocation(
  targetPath: string,
  hostOverride?: any
): Promise<boolean> {
  if (!targetPath) return false
  return showRealItemInFolder(targetPath, hostOverride)
}

/**
 * 使用系统默认应用直接打开文件
 */
export async function openDiskFileDefault(
  targetPath: string,
  hostOverride?: any
): Promise<boolean> {
  if (!targetPath) return false
  return openRealPath(targetPath, hostOverride)
}
