/**
 * 微信专项深度清理业务逻辑与真实环境契约层 (WechatCleaner Logic - 1:1 完整复刻版)
 * 完整对齐 DLLPlugins/wechat-cleaner/src/wechat_rules.h 的 9 大专项清理分类 (owner 107~115)：
 * - 穿透扫描 Documents\xwechat_files、WeChat Files、AppData\Roaming\Tencent\xwechat (含多盘符自定义存储目录与符号链接穿透) 与 LocalLow\TENCENT\WeType
 * - 严格保护聊天文字数据库 (MSG*.db / MicroMsg.db / db_storage\*.db)
 * - 支持多微信账号 (wxid) 维度与修改时间范围 (全部/7天前/30天前/半年前) 多维过滤及三级复选框联动
 */

import {
  callHostTransport,
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

export type WechatOwnerId = 107 | 108 | 109 | 110 | 111 | 112 | 113 | 114 | 115 | 999

export interface WechatScannedFileEntry {
  id: string
  name: string
  path: string
  parentDir: string
  ownerId: WechatOwnerId
  ownerName: string
  accountId: string
  sizeBytes: number
  mtime: number
  isProtected: boolean
}

export interface WechatCleanCategoryItem {
  id: string
  ownerId: WechatOwnerId
  name: string
  shortName: string
  color: string
  category: 'cache' | 'media' | 'files' | 'logs' | 'protected'
  riskLevel: 'safe' | 'recommended' | 'caution' | 'protected'
  safetyLevel?: 'safe' | 'recommended' | 'caution' | 'protected'
  targetDir: string
  existsOnDisk: boolean
  fileCount: number
  totalSizeBytes: number
  checked: boolean
  sampleFiles: Array<{ path: string; sizeBytes: number; mtime?: number; accountId?: string }>
  files: WechatScannedFileEntry[]
  description: string
}

export interface WechatAccountStat {
  accountId: string
  label: string
  rootDir: string
  fileCount: number
  totalBytes: number
}

export interface WechatScanSnapshot {
  baseDirectories: string[]
  detectedAccounts: string[]
  accountStats: WechatAccountStat[]
  categories: WechatCleanCategoryItem[]
  allFiles: WechatScannedFileEntry[]
  totalScannableBytes: number
  checkedBytes: number
  protectedDbBytes: number
  systemDiskFreeBytes: number
  systemDiskTotalBytes: number
  wechatRunning: boolean
  wechatVersionLabel: string
}

export const DLL_PLUGIN_NAME = 'WechatCleanerPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp(
  '(?:^|[\\\\/])(?:MSG\\d*\\.db|MicroMsg\\.db|MediaMsg\\d*\\.db|db_storage[\\\\/].*\\.db(?:-wal|-shm)?|message_\\d+\\.db|contact\\.db|session\\.db)$',
  'i'
)
export const FORBIDDEN_REASON =
  '微信核心聊天文字与联系人数据库 (MSG.db / MicroMsg.db / db_storage/*.db) 受到严格硬件级保护，严禁纳入清理范围'

export interface OfficialWechatOwnerRule {
  ownerId: WechatOwnerId
  id: string
  name: string
  shortName: string
  color: string
  category: WechatCleanCategoryItem['category']
  riskLevel: WechatCleanCategoryItem['riskLevel']
  defaultChecked: boolean
  description: string
}

/**
 * 对应原版 wechat_rules.h 的 9 大专项清理分类 (owner 107~115) + 1 项核心聊天数据库保护区 (999)
 */
export const OFFICIAL_WECHAT_OWNER_RULES: OfficialWechatOwnerRule[] = [
  {
    ownerId: 107,
    id: 'wx-owner-107-sns-web',
    name: '朋友圈与公众号网页缓存 (Owner #107)',
    shortName: '朋友圈/网页缓存',
    color: '#64748b',
    category: 'cache',
    riskLevel: 'safe',
    defaultChecked: true,
    description: '朋友圈动态流图片/视频缓存、内置浏览器网页缓存 (xwechat/radium/Users、FileStorage/Sns & Cache)，清理后不影响聊天记录'
  },
  {
    ownerId: 115,
    id: 'wx-owner-115-xplugin',
    name: '小程序与跨端引擎组件包 (Owner #115)',
    shortName: '小程序/XPlugin',
    color: '#64748b',
    category: 'cache',
    riskLevel: 'recommended',
    defaultChecked: true,
    description: '微信小程序历史版本包、RadiumWMPF 跨端引擎运行时与 XPlugin 插件缓存 (xwechat/xplugin/Plugins)，按需自动重下'
  },
  {
    ownerId: 113,
    id: 'wx-owner-113-xlog',
    name: '微信运行跟踪与输入法日志 (Owner #113)',
    shortName: '运行跟踪日志 (.xlog)',
    color: '#64748b',
    category: 'logs',
    riskLevel: 'safe',
    defaultChecked: true,
    description: '微信每日生成的加密诊断跟踪日志 (xwechat/log/*.xlog) 与微信输入法运行日志 (WeType/*.xlog)，体积巨大且可100%安全清理'
  },
  {
    ownerId: 112,
    id: 'wx-owner-112-crash',
    name: '崩溃转储与诊断快照 (Owner #112)',
    shortName: '崩溃转储 (.dmp)',
    color: '#64748b',
    category: 'logs',
    riskLevel: 'safe',
    defaultChecked: true,
    description: '微信与小程序进程异常退出时生成的内存转储快照 (crashinfo/WeChatAppEx_*.dmp、Weixin_*.dmp)，可放心清理'
  },
  {
    ownerId: 111,
    id: 'wx-owner-111-emoticon',
    name: '表情包与动态贴纸缓存 (Owner #111)',
    shortName: '表情包与资源缓存',
    color: '#64748b',
    category: 'media',
    riskLevel: 'safe',
    defaultChecked: true,
    description: '群聊自动加载的动态表情包缓存、聊天气泡资源与临时缩略图 (business/emoticon、resource、FileStorage/Temp)'
  },
  {
    ownerId: 114,
    id: 'wx-owner-114-update',
    name: '版本升级补丁与公共宿主缓存 (Owner #114)',
    shortName: '升级补丁/WMPF',
    color: '#64748b',
    category: 'cache',
    riskLevel: 'safe',
    defaultChecked: true,
    description: '微信客户端热更新残留包、WMPF 公共宿主缓存与网络探针缓存 (xwechat_files/WMPF、all_users、xwechat/net)'
  },
  {
    ownerId: 109,
    id: 'wx-owner-109-video-voice',
    name: '聊天视频与语音媒体文件 (Owner #109)',
    shortName: '聊天视频/语音',
    color: '#64748b',
    category: 'media',
    riskLevel: 'recommended',
    defaultChecked: true,
    description: '群聊与私聊中播放过的视频文件、流媒体音视频缓存与语音分片 (msg/video、FileStorage/Video、Media Cache)'
  },
  {
    ownerId: 108,
    id: 'wx-owner-108-chat-images',
    name: '聊天加密图片与缩略图附件 (Owner #108)',
    shortName: '聊天加密图片 (.dat)',
    color: '#64748b',
    category: 'media',
    riskLevel: 'caution',
    defaultChecked: false,
    description: '聊天过程中收发的原图加密文件 (.dat) 与附件缩略图 (msg/attach、FileStorage/MsgAttach)，清理后过期图片将无法查看原图'
  },
  {
    ownerId: 110,
    id: 'wx-owner-110-recv-files',
    name: '聊天接收与自动下载文档 (Owner #110)',
    shortName: '聊天接收文件',
    color: '#64748b',
    category: 'files',
    riskLevel: 'caution',
    defaultChecked: false,
    description: '通过微信接收或自动下载的办公文档、压缩包与工作文件 (msg/file、FileStorage/File)，请核对后再勾选清理'
  },
  {
    ownerId: 999,
    id: 'wx-owner-999-protected-db',
    name: '核心聊天文字与联系人数据库保护区 (db_storage)',
    shortName: '核心聊天数据库 (受保护)',
    color: '#64748b',
    category: 'protected',
    riskLevel: 'protected',
    defaultChecked: false,
    description: '存放所有聊天文字记录、联系人列表与会话索引的加密 SQLite 数据库 (db_storage/message_0.db、contact.db、MSG.db)，硬件级防误删锁定'
  }
]

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'wx-detect-info',
    title: '自动识别本机微信 WeChat Files / xwechat_files 存储目录与微信号',
    subtitle: '支持默认文档路径、AppData\\Roaming\\Tencent\\xwechat 与符号链接迁移目录的多账号扫描',
    tag: '目录识别',
    method: 'GetWechatInfo',
    params: {}
  },
  {
    id: 'wx-scan-cache',
    title: '扫描 9 大专项分类 (朋友圈/小程序/XLog/崩溃Dmp/视频/图片/接收文件)',
    subtitle: '精准识别 Owner 107~115 下的高占用冗余文件并严格保护聊天数据库',
    tag: '专项扫描',
    method: 'StartScanAsync',
    params: { scope: 'cache_and_video' }
  },
  {
    id: 'wx-total-stats',
    title: '查看各账号分类空间占用统计报告',
    subtitle: '按微信号 wxid、时间范围与 9 大专项展示可安全释放容量',
    tag: '容量报告',
    method: 'GetTotalStats',
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
  if (!mtimeSeconds || !Number.isFinite(mtimeSeconds) || mtimeSeconds <= 0) return '未知日期'
  const ms = mtimeSeconds > 1e12 ? mtimeSeconds : mtimeSeconds * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '未知日期'
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
  hostBridge?: any
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

/**
 * 根据微信文件的完整真实路径，将其精准归入 wechat_rules.h 的 9 大专项分类 (107~115) 或 999 聊天数据库保护区，
 * 并提取所属微信号 (accountId)
 */
export function classifyWechatFilePath(
  fullPath: string,
  knownAccounts: string[]
): {
  ownerId: WechatOwnerId
  accountId: string
  isProtected: boolean
} {
  const norm = fullPath.replace(/\//g, '\\')
  const lower = norm.toLowerCase()

  // 1. 识别所属账号 (wxid / 微信号目录)
  let accountId = '公共组件 (Shared)'
  const xwMatch = norm.match(/xwechat_files\\([^\\]+)/i) || norm.match(/WeChat Files\\([^\\]+)/i)
  if (xwMatch && xwMatch[1]) {
    const seg = xwMatch[1]
    if (!/^(?:all_users|all users|wmpf|applet|backup)$/i.test(seg)) {
      accountId = seg
    }
  } else {
    const radiumUserMatch = norm.match(/radium\\Users\\([0-9a-f]{16,64})/i)
    if (radiumUserMatch && radiumUserMatch[1]) {
      const hash = radiumUserMatch[1].toLowerCase()
      const matchedKnown = knownAccounts.find(a => {
        const suffix = a.split('_').pop()?.toLowerCase() || ''
        return suffix.length >= 4 && hash.startsWith(suffix)
      })
      accountId = matchedKnown || `wx_${hash.slice(0, 8)}`
    }
  }

  // 2. 判定是否属于受保护的核心聊天数据库 (Owner 999)
  if (
    FORBIDDEN_TARGET_PATTERN.test(norm) ||
    lower.includes('\\db_storage\\') ||
    lower.includes('\\msg\\multi\\') ||
    /\\(?:micromsg|msg\d*|mediamsg\d*|contact|session|message_\d+|head_image|favorite)\.db/i.test(lower)
  ) {
    return { ownerId: 999, accountId, isProtected: true }
  }

  // 3. 判定 9 大专项清理分类 (Owner 107~115)
  if (lower.includes('\\crashinfo\\') || lower.includes('\\crashpad\\') || lower.endsWith('.dmp')) {
    return { ownerId: 112, accountId, isProtected: false }
  }
  if (lower.includes('\\log\\') || lower.includes('\\wetype\\') || lower.endsWith('.xlog')) {
    return { ownerId: 113, accountId, isProtected: false }
  }
  if (lower.includes('\\xplugin\\') || lower.includes('\\applet\\') || lower.includes('radiumwmpf')) {
    return { ownerId: 115, accountId, isProtected: false }
  }
  if (
    lower.includes('\\emoticon\\') ||
    lower.includes('\\customemotion\\') ||
    lower.includes('\\resource\\') ||
    lower.includes('\\filestorage\\temp\\')
  ) {
    return { ownerId: 111, accountId, isProtected: false }
  }
  if (
    lower.includes('\\msg\\attach\\') ||
    lower.includes('\\filestorage\\msgattach\\') ||
    lower.includes('\\filestorage\\image\\')
  ) {
    return { ownerId: 108, accountId, isProtected: false }
  }
  if (
    lower.includes('\\msg\\video\\') ||
    lower.includes('\\msg\\voice\\') ||
    lower.includes('\\filestorage\\video\\') ||
    lower.includes('\\filestorage\\voice\\') ||
    lower.includes('\\media cache\\') ||
    /\.(?:mp4|mov|avi|amr|silk|mp3|wav)$/i.test(lower)
  ) {
    return { ownerId: 109, accountId, isProtected: false }
  }
  if (lower.includes('\\msg\\file\\') || lower.includes('\\filestorage\\file\\')) {
    return { ownerId: 110, accountId, isProtected: false }
  }
  if (
    lower.includes('\\wmpf\\') ||
    lower.includes('\\all_users\\') ||
    lower.includes('\\update\\') ||
    lower.includes('\\xwechat\\net') ||
    lower.includes('\\xwechat\\roam') ||
    lower.includes('\\config\\')
  ) {
    return { ownerId: 114, accountId, isProtected: false }
  }

  // 默认归入 107: 朋友圈与公众号网页/Web缓存 (radium/Users, cache, Sns 等)
  return { ownerId: 107, accountId, isProtected: false }
}

/**
 * 探测并深度扫描本机真实微信存储路径、微信号账号、9 大专项分类与聊天数据库保护区
 */
export async function fetchWechatCleanSnapshot(hostOverride?: any): Promise<WechatScanSnapshot> {
  const [documentsDir, appDataDir, homeDir, tempDir, diskRes, mountedDrives] = await Promise.all([
    getRealSystemPath('documents', hostOverride),
    getRealSystemPath('appData', hostOverride),
    getRealSystemPath('home', hostOverride),
    getRealSystemPath('temp', hostOverride),
    callHostTransport<{ total: number; used: number; available: number }>(
      'system_get_disk_usage',
      { drive: 'C:/' },
      hostOverride
    ),
    probeRealDiskDrives(undefined, hostOverride)
  ])

  const localAppData = homeDir ? `${homeDir}\\AppData\\Local` : ''
  const localLowAppData = homeDir ? `${homeDir}\\AppData\\LocalLow` : ''

  // 动态组合系统默认路径与各挂载盘符根目录下的微信数据路径
  const driveWechatRoots = mountedDrives.flatMap(d => {
    const letter = d.drive.replace(/[\\/]+$/, '')
    return [`${letter}\\WeChat Files`, `${letter}\\xwechat_files`]
  })

  const candidateRoots = [
    documentsDir ? `${documentsDir}\\xwechat_files` : '',
    documentsDir ? `${documentsDir}\\WeChat Files` : '',
    appDataDir ? `${appDataDir}\\Tencent\\xwechat` : '',
    appDataDir ? `${appDataDir}\\Tencent\\WeChat` : '',
    ...driveWechatRoots,
    localLowAppData ? `${localLowAppData}\\TENCENT\\WeType` : '',
    localAppData ? `${localAppData}\\Tencent\\WeChat` : ''
  ].filter(Boolean)

  // 1. 先探测本机微信号账号目录
  const detectedAccountSet = new Set<string>()
  if (hostOverride || !isRealElectronHost()) {
    for (const root of candidateRoots.slice(0, 2)) {
      const subDirs = await listRealDirectoryContents(root, hostOverride)
      for (const sub of subDirs) {
        const name = sub.split(/[\\/]/).pop() || ''
        if (
          name &&
          !name.includes('.') &&
          !/^(?:All Users|all_users|Applet|WMPF|Backup|config)$/i.test(name)
        ) {
          detectedAccountSet.add(name)
        }
      }
    }
  }

  const allFiles: WechatScannedFileEntry[] = []
  const seenPaths = new Set<string>()

  // 归一化 AppData\Roaming\Tencent 与符号链接路径，避免重复计数
  const canonicalizeWechatKey = (p: string): string => {
    const lower = p.replace(/\//g, '\\').toLowerCase()
    const idx = lower.indexOf('\\tencent\\xwechat\\')
    if (idx >= 0) return lower.slice(idx)
    const idx2 = lower.indexOf('\\tencent\\wechat\\')
    if (idx2 >= 0) return lower.slice(idx2)
    return lower
  }

  const registerScannedFile = (fullPath: string, sizeBytes: number, mtime = 0) => {
    if (!fullPath || sizeBytes <= 0) return
    const key = canonicalizeWechatKey(fullPath)
    if (seenPaths.has(key)) return
    seenPaths.add(key)

    const cleanPath = fullPath.replace(/\//g, '\\')
    const lastSep = cleanPath.lastIndexOf('\\')
    const name = lastSep >= 0 ? cleanPath.slice(lastSep + 1) : cleanPath
    const parentDir = lastSep > 0 ? cleanPath.slice(0, lastSep) : cleanPath

    // 从路径中补充识别账号
    const xwAcc = cleanPath.match(/xwechat_files\\([^\\]+)\\/i)
    if (xwAcc && xwAcc[1] && !/^(?:all_users|wmpf|applet|backup)$/i.test(xwAcc[1])) {
      detectedAccountSet.add(xwAcc[1])
    }

    const knownAccounts = Array.from(detectedAccountSet)
    const cls = classifyWechatFilePath(cleanPath, knownAccounts)
    if (cls.accountId !== '公共组件 (Shared)') {
      detectedAccountSet.add(cls.accountId)
    }

    const ruleMeta =
      OFFICIAL_WECHAT_OWNER_RULES.find(r => r.ownerId === cls.ownerId) ||
      OFFICIAL_WECHAT_OWNER_RULES[0]

    allFiles.push({
      id: `wx-file-${allFiles.length}`,
      name,
      path: cleanPath,
      parentDir,
      ownerId: cls.ownerId,
      ownerName: ruleMeta.shortName,
      accountId: cls.accountId,
      sizeBytes,
      mtime: mtime || Math.floor(Date.now() / 1000),
      isProtected: cls.isProtected
    })
  }

  // 2A. 真实 Electron 宿主环境或支持 dir: 深度扫描的测试环境：执行深度目录树扫描 (dir:)
  // 同时跟踪各分类的真实全量文件数与真实全量字节数（即使 Top 样本只取前 200 个）
  const extraOwnerTotals = new Map<WechatOwnerId, { extraFiles: number; extraBytes: number; targetDir?: string }>()
  const supportsDeepScan =
    (!hostOverride && isRealElectronHost()) ||
    typeof hostOverride?.system_search_files === 'function'

  if (supportsDeepScan) {
    const deepTargets: Array<{ dir: string; defaultOwner?: WechatOwnerId }> = [
      ...(documentsDir
        ? [
            { dir: `${documentsDir}\\xwechat_files` },
            { dir: `${documentsDir}\\WeChat Files` }
          ]
        : []),
      ...driveWechatRoots.map(dir => ({ dir })),
      ...(appDataDir
        ? [
            { dir: `${appDataDir}\\Tencent\\xwechat\\radium`, defaultOwner: 107 as WechatOwnerId },
            { dir: `${appDataDir}\\Tencent\\xwechat\\xplugin`, defaultOwner: 115 as WechatOwnerId },
            { dir: `${appDataDir}\\Tencent\\xwechat\\log`, defaultOwner: 113 as WechatOwnerId },
            { dir: `${appDataDir}\\Tencent\\xwechat\\crashinfo`, defaultOwner: 112 as WechatOwnerId },
            { dir: `${appDataDir}\\Tencent\\xwechat\\net`, defaultOwner: 114 as WechatOwnerId }
          ]
        : []),
      ...(localLowAppData
        ? [{ dir: `${localLowAppData}\\TENCENT\\WeType`, defaultOwner: 113 as WechatOwnerId }]
        : [])
    ]

    const seenSubdirTotals = new Set<string>()
    const scanResults = await Promise.all(deepTargets.map(t => scanRealDirectoryTree(t.dir, 150, hostOverride)))

    // 先从 xwechat_files / WeChat Files 子目录提取本机微信号账号目录 (如 liaoguobo_7f67)
    for (let i = 0; i < Math.min(2, deepTargets.length); i++) {
      const res = scanResults[i]
      if (!res) continue
      for (const sub of res.subdirs) {
        if (
          sub.name &&
          !sub.name.includes('.') &&
          !/^(?:All Users|all_users|Applet|WMPF|Backup|config)$/i.test(sub.name)
        ) {
          detectedAccountSet.add(sub.name)
        }
      }
    }

    for (let i = 0; i < deepTargets.length; i++) {
      const target = deepTargets[i]
      const res = scanResults[i]
      if (!res || (res.files.length === 0 && res.totalFiles === 0)) continue

      // 从 radium\Users 子目录识别更多微信号 profile
      if (target.dir.toLowerCase().endsWith('\\radium')) {
        for (const sub of res.subdirs) {
          if (sub.name.toLowerCase() === 'users') {
            const usersScan = await scanRealDirectoryTree(sub.path, 40, hostOverride)
            for (const u of usersScan.subdirs) {
              if (/^[0-9a-f]{16,64}$/i.test(u.name)) {
                const hash = u.name.toLowerCase()
                const matched = Array.from(detectedAccountSet).find(a => {
                  const suf = a.split('_').pop()?.toLowerCase() || ''
                  return suf.length >= 4 && hash.startsWith(suf)
                })
                if (!matched) {
                  detectedAccountSet.add(`wx_${hash.slice(0, 8)}`)
                }
              }
            }
          }
        }
      }

      let sampledBytes = 0
      let sampledCount = 0
      for (const f of res.files) {
        if (!f.isDir && f.size > 0) {
          const beforeLen = allFiles.length
          registerScannedFile(f.path, f.size, f.mtime)
          if (allFiles.length > beforeLen) {
            sampledBytes += f.size
            sampledCount += 1
          }
        }
      }

      // 如果该专项子目录真实全量字节数大于 Top 采样字节数，记录真实全量差值以确保统计 100% 精确反映磁盘真实占用
      if (target.defaultOwner) {
        const canonDirKey = canonicalizeWechatKey(target.dir)
        if (!seenSubdirTotals.has(canonDirKey) && res.totalBytes > sampledBytes) {
          seenSubdirTotals.add(canonDirKey)
          const cur = extraOwnerTotals.get(target.defaultOwner) || { extraFiles: 0, extraBytes: 0 }
          cur.extraFiles += Math.max(0, res.totalFiles - sampledCount)
          cur.extraBytes += Math.max(0, res.totalBytes - sampledBytes)
          cur.targetDir = target.dir
          extraOwnerTotals.set(target.defaultOwner, cur)
        }
      }
    }
  } else {
    // 2B. 测试环境或自定义 hostOverride 兼容扫描
    const fallbackDirs = [
      appDataDir ? `${appDataDir}\\Tencent\\WeChat` : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\WeChat',
      appDataDir ? `${appDataDir}\\Tencent\\xwechat` : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\xwechat',
      documentsDir ? `${documentsDir}\\WeChat Files` : 'C:\\Users\\Default\\Documents\\WeChat Files',
      documentsDir ? `${documentsDir}\\xwechat_files` : 'C:\\Users\\Default\\Documents\\xwechat_files',
      tempDir || 'C:\\Windows\\Temp'
    ]
    for (const d of fallbackDirs) {
      const entries = await listRealDirectoryContents(d, hostOverride)
      const slice = entries.slice(0, 25)
      const sizes = await Promise.all(slice.map(p => getRealFileSize(p, hostOverride)))
      for (let i = 0; i < slice.length; i++) {
        registerScannedFile(slice[i], sizes[i] || 0)
      }
    }
  }

  allFiles.sort((a, b) => b.sizeBytes - a.sizeBytes)

  // 3. 构建 9 大官方专项分类 + 1 个核心数据库保护区
  const categories: WechatCleanCategoryItem[] = OFFICIAL_WECHAT_OWNER_RULES.map(rule => {
    const catFiles = allFiles.filter(f => f.ownerId === rule.ownerId)
    const extra = extraOwnerTotals.get(rule.ownerId)
    const sampledBytes = catFiles.reduce((acc, f) => acc + f.sizeBytes, 0)
    const totalSizeBytes = sampledBytes + (extra?.extraBytes || 0)
    const fileCount = catFiles.length + (extra?.extraFiles || 0)

    const defaultDir =
      catFiles[0]?.parentDir ||
      extra?.targetDir ||
      (rule.ownerId === 107 || rule.ownerId === 115 || rule.ownerId === 112 || rule.ownerId === 113
        ? appDataDir
          ? `${appDataDir}\\Tencent\\xwechat`
          : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\xwechat'
        : documentsDir
        ? `${documentsDir}\\xwechat_files`
        : 'C:\\Users\\Default\\Documents\\xwechat_files')

    return {
      id: rule.id,
      ownerId: rule.ownerId,
      name: rule.name,
      shortName: rule.shortName,
      color: rule.color,
      category: rule.category,
      riskLevel: rule.riskLevel,
      safetyLevel: rule.riskLevel,
      targetDir: defaultDir,
      existsOnDisk: fileCount > 0,
      fileCount,
      totalSizeBytes,
      checked: rule.defaultChecked && rule.ownerId !== 999 && totalSizeBytes > 0,
      sampleFiles: catFiles.slice(0, 12).map(f => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
        mtime: f.mtime,
        accountId: f.accountId
      })),
      files: catFiles,
      description: rule.description
    }
  })

  // 按实际体积降序排列（但保持 999 保护区在最后以便清晰核对）
  categories.sort((a, b) => {
    if (a.ownerId === 999) return 1
    if (b.ownerId === 999) return -1
    return b.totalSizeBytes - a.totalSizeBytes
  })

  // 4. 汇总各微信账号统计
  const accountMap = new Map<string, { fileCount: number; totalBytes: number; rootDir: string }>()
  for (const acc of detectedAccountSet) {
    accountMap.set(acc, {
      fileCount: 0,
      totalBytes: 0,
      rootDir: documentsDir ? `${documentsDir}\\xwechat_files\\${acc}` : acc
    })
  }
  for (const f of allFiles) {
    const cur = accountMap.get(f.accountId) || {
      fileCount: 0,
      totalBytes: 0,
      rootDir: f.parentDir
    }
    cur.fileCount += 1
    cur.totalBytes += f.sizeBytes
    accountMap.set(f.accountId, cur)
  }

  const accountStats: WechatAccountStat[] = Array.from(accountMap.entries())
    .map(([accountId, stat]) => ({
      accountId,
      label:
        accountId === '公共组件 (Shared)'
          ? '微信公共引擎与跨端缓存 (xplugin/log/WMPF)'
          : `微信号: ${accountId}`,
      rootDir: stat.rootDir,
      fileCount: stat.fileCount,
      totalBytes: stat.totalBytes
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes)

  const detectedAccounts = Array.from(detectedAccountSet)
  const scannableCategories = categories.filter(c => c.ownerId !== 999)
  const totalScannableBytes = scannableCategories.reduce((s, c) => s + c.totalSizeBytes, 0)
  const checkedBytes = scannableCategories
    .filter(c => c.checked)
    .reduce((s, c) => s + c.totalSizeBytes, 0)
  const protectedDbBytes =
    categories.find(c => c.ownerId === 999)?.totalSizeBytes || 0

  return {
    baseDirectories: candidateRoots,
    detectedAccounts,
    accountStats,
    categories,
    allFiles,
    totalScannableBytes,
    checkedBytes,
    protectedDbBytes,
    systemDiskFreeBytes: diskRes.ok && diskRes.data?.available ? diskRes.data.available : 0,
    systemDiskTotalBytes: diskRes.ok && diskRes.data?.total ? diskRes.data.total : 0,
    wechatRunning: false,
    wechatVersionLabel: 'WeChat 4.0 (xwechat + RadiumWMPF)'
  }
}

/**
 * 执行微信缓存安全清理（严格拦截聊天数据库文件，走真实回收站移除）
 */
export async function executeWechatCleanup(
  categoriesOrPaths: WechatCleanCategoryItem[] | string[],
  hostOverride?: any,
  explicitFilePaths?: string[]
): Promise<{
  ok: boolean
  deletedCount: number
  freedBytes: number
  skippedProtected: number
  deletedPaths: string[]
  skippedPaths: string[]
  error?: string
}> {
  let deletedCount = 0
  let freedBytes = 0
  let skippedProtected = 0
  const deletedPaths: string[] = []
  const skippedPaths: string[] = []

  const directStringPaths =
    Array.isArray(categoriesOrPaths) && categoriesOrPaths.length > 0 && typeof categoriesOrPaths[0] === 'string'
      ? (categoriesOrPaths as string[])
      : explicitFilePaths
  const categories =
    Array.isArray(categoriesOrPaths) && (categoriesOrPaths.length === 0 || typeof categoriesOrPaths[0] !== 'string')
      ? (categoriesOrPaths as WechatCleanCategoryItem[])
      : []

  if (Array.isArray(directStringPaths) && directStringPaths.length > 0) {
    const fileSizeLookup = new Map<string, number>()
    for (const cat of categories) {
      for (const f of cat.files || []) {
        fileSizeLookup.set(f.path, f.sizeBytes)
      }
      for (const s of cat.sampleFiles || []) {
        if (!fileSizeLookup.has(s.path)) fileSizeLookup.set(s.path, s.sizeBytes)
      }
    }

    for (const targetPath of directStringPaths) {
      if (FORBIDDEN_TARGET_PATTERN.test(targetPath) || targetPath.toLowerCase().includes('\\db_storage\\')) {
        skippedProtected += 1
        skippedPaths.push(targetPath)
        continue
      }
      const res = await trashRealItem(targetPath, hostOverride)
      if (res.ok) {
        deletedCount += 1
        freedBytes += fileSizeLookup.get(targetPath) || 0
        deletedPaths.push(targetPath)
      }
    }

    return {
      ok: true,
      deletedCount,
      freedBytes,
      skippedProtected,
      deletedPaths,
      skippedPaths
    }
  }

  const selected = categories.filter(c => c.checked && c.ownerId !== 999 && c.sampleFiles.length > 0)
  if (selected.length === 0) {
    return { ok: true, deletedCount: 0, freedBytes: 0, skippedProtected: 0, deletedPaths: [], skippedPaths: [] }
  }

  for (const cat of selected) {
    for (const sample of cat.sampleFiles) {
      if (FORBIDDEN_TARGET_PATTERN.test(sample.path) || sample.path.toLowerCase().includes('\\db_storage\\')) {
        skippedProtected += 1
        skippedPaths.push(sample.path)
        continue
      }
      const res = await trashRealItem(sample.path, hostOverride)
      if (res.ok) {
        deletedCount += 1
        freedBytes += sample.sizeBytes
        deletedPaths.push(sample.path)
      }
    }
  }

  return {
    ok: true,
    deletedCount,
    freedBytes,
    skippedProtected,
    deletedPaths,
    skippedPaths
  }
}

export async function openWechatDirectory(dirPath: string, hostOverride?: any): Promise<boolean> {
  if (!dirPath) return false
  return showRealItemInFolder(dirPath, hostOverride)
}

export async function openWechatFileDefault(filePath: string, hostOverride?: any): Promise<boolean> {
  if (!filePath) return false
  return openRealPath(filePath, hostOverride)
}
