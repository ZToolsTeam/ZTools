/**
 * QQ / NTQQ / TIM 专项深度清理业务逻辑与真实环境契约层 (QQCleaner Logic - 1:1 完整复刻版)
 * 完整对齐 DLLPlugins/qq-cleaner/qq_core/include/qq_rules.h 的 12 大官方专项分组 (Group 201~213) + 999 聊天数据库保护区：
 * - 穿透扫描 Documents\Tencent Files、AppData\Roaming\Tencent (Users / QQ / TIM / Logs，含多盘符自定义存储目录与符号链接穿透)、
 *   AppData\Roaming\QQ (NTQQ) 与 AppData\Local\Tencent
 * - 自动识别本机全部真实登录 QQ 号 (UIN)
 * - 严格保护聊天消息加密数据库 (Msg3.0.db / Msg3.0index.db / nt_msg.db / Registry.db / Info.db)
 * - 支持多 QQ 号维度与修改时间范围 (0:全部 / 1:7天前 / 2:30天前 / 3:180天前) 多维过滤及三级复选框联动
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

/**
 * 对应原版 DLLPlugins/qq-cleaner/qq_core/include/qq_rules.h 的官方清理分组 ID (201~213) + 999 聊天核心数据库保护区
 */
export type QQGroupId = 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 209 | 211 | 212 | 213 | 999

export interface QQScannedFileEntry {
  id: string
  name: string
  path: string
  parentDir: string
  groupId: QQGroupId
  groupName: string
  accountId: string
  clientType: 'ClassicQQ' | 'QQNT' | 'TIM' | 'Shared'
  sizeBytes: number
  mtime: number
  isProtected: boolean
}

export interface QQCleanCategoryItem {
  id: string
  groupId: QQGroupId
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
  files: QQScannedFileEntry[]
  description: string
}

export interface QQAccountStat {
  accountId: string
  label: string
  clientType: string
  rootDir: string
  fileCount: number
  totalBytes: number
}

export interface QQScanSnapshot {
  baseDirectories: string[]
  detectedAccounts: string[]
  accountStats: QQAccountStat[]
  categories: QQCleanCategoryItem[]
  allFiles: QQScannedFileEntry[]
  totalScannableBytes: number
  checkedBytes: number
  protectedDbBytes: number
  systemDiskFreeBytes: number
  systemDiskTotalBytes: number
  qqVariantSummary: string
}

export const DLL_PLUGIN_NAME = 'QQCleanerPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp(
  '(?:^|[\\\\/])(?:Msg3\\.0\\.db|Msg3\\.0index\\.db|nt_msg\\.db|Registry\\.db|Registry2\\.0\\.db|Info\\.db|FoldMsg\\.db)(?:-journal|-wal|-shm)?$',
  'i'
)
export const FORBIDDEN_REASON =
  'QQ 核心聊天记录与账户配置加密数据库 (Msg3.0.db / nt_msg.db / Registry.db / Info.db) 受硬件级保护，严禁纳入清理范围'

export interface OfficialQQGroupRule {
  groupId: QQGroupId
  id: string
  name: string
  shortName: string
  color: string
  category: QQCleanCategoryItem['category']
  riskLevel: QQCleanCategoryItem['riskLevel']
  defaultChecked: boolean
  description: string
}

/**
 * 1:1 复刻 qq_rules.h 的 12 大官方清理分组 (201~213) + 999 核心聊天数据库保护区
 */
export const OFFICIAL_QQ_GROUP_RULES: OfficialQQGroupRule[] = [
  {
    groupId: 203,
    id: 'qq-group-203-logs',
    name: 'QQ / TIM 运行跟踪日志 (Group #203 & #210)',
    shortName: '运行跟踪日志 (.tlg/.log)',
    color: '#06b6d4',
    category: 'logs',
    riskLevel: 'safe',
    defaultChecked: true,
    description:
      'QQ、TIM 与腾讯公共组件每日生成的跟踪诊断日志 (Tencent\\Logs\\QQ.tlg、TIM.tlg、%user%\\Log、nt_data\\Log)，体积常达数百 MB，可 100% 安全清理'
  },
  {
    groupId: 201,
    id: 'qq-group-201-images',
    name: '好友与群聊图片缓存 (Group #201)',
    shortName: '聊天图片 (Image/Pic)',
    color: '#10b981',
    category: 'media',
    riskLevel: 'safe',
    defaultChecked: true,
    description:
      '群聊与好友会话中自动加载的图片文件 (Tencent Files\\%user%\\Image\\Group/C2C、nt_qq\\nt_data\\Pic)，清理后不影响文字聊天记录'
  },
  {
    groupId: 208,
    id: 'qq-group-208-avatars',
    name: '好友与群头像缓存库 (Group #208)',
    shortName: '头像缓存 (Head/MiscHead)',
    color: '#a855f7',
    category: 'media',
    riskLevel: 'safe',
    defaultChecked: true,
    description:
      '本地缓存的好友头像、群头像与历史动态头像包 (MiscHead.db、QQHead、GroupHead、PushHead、SelCreateGroupHead、nt_data\\Head)，打开会话时自动刷新'
  },
  {
    groupId: 202,
    id: 'qq-group-202-cache',
    name: '账号运行与网页临时缓存 (Group #202)',
    shortName: '账号运行缓存 (AppWebCache)',
    color: '#3b82f6',
    category: 'cache',
    riskLevel: 'safe',
    defaultChecked: true,
    description:
      'QQ 账号目录下的网页容器缓存、离线资源包与广告推广缓冲 (AppWebCache、Temp、OfflinePackage、Ads、CloudRes、VasscUpdate、nt_temp)'
  },
  {
    groupId: 209,
    id: 'qq-group-209-app-cache',
    name: 'QQ / TIM 系统级内核与应用缓存 (Group #209)',
    shortName: '系统内核缓存 (Roaming)',
    color: '#ec4899',
    category: 'cache',
    riskLevel: 'safe',
    defaultChecked: true,
    description:
      'Roaming\\Tencent\\QQ 与 TIM 下的 WebKit 渲染缓存、安装包残留与 GPU 着色器缓存 (webkit_cache、STemp、AuTemp、InstallPackageDR、Skins、GPUCache)'
  },
  {
    groupId: 211,
    id: 'qq-group-211-browser-miniapp',
    name: '内置浏览器、小程序与频道缓存 (Group #211)',
    shortName: '内置浏览器/小程序',
    color: '#6366f1',
    category: 'cache',
    riskLevel: 'recommended',
    defaultChecked: true,
    description:
      'QQ 内置 MiniBrowser、小程序引擎、QQ 频道与轻游戏缓存 (Local\\Tencent\\MiniBrowser、QQGuild、QQApp、TIMApp、Partitions、miniapp)'
  },
  {
    groupId: 205,
    id: 'qq-group-205-videos',
    name: '聊天短视频与群视频缓存 (Group #205)',
    shortName: '聊天视频 (Video)',
    color: '#8b5cf6',
    category: 'media',
    riskLevel: 'recommended',
    defaultChecked: true,
    description:
      '聊天过程中播放或自动缓冲的短视频文件 (Tencent Files\\%user%\\Video、nt_qq\\nt_data\\Video)'
  },
  {
    groupId: 206,
    id: 'qq-group-206-voice',
    name: '聊天语音消息分片 (Group #206)',
    shortName: '聊天语音 (Audio/Ptt)',
    color: '#14b8a6',
    category: 'media',
    riskLevel: 'recommended',
    defaultChecked: true,
    description:
      '好友与群聊收发的语音消息音频文件 (Tencent Files\\%user%\\Audio、Voice、nt_qq\\nt_data\\Ptt)'
  },
  {
    groupId: 207,
    id: 'qq-group-207-emoji-cache',
    name: '接收表情与推荐贴纸缓存 (Group #207)',
    shortName: '接收表情缓存',
    color: '#f59e0b',
    category: 'media',
    riskLevel: 'safe',
    defaultChecked: true,
    description:
      '聊天中接收的动态表情缓存与智能推荐表情包 (CustomFaceRecv、ExpressionRecommend、RecommendFace、Emoji\\emoji_cache)，不含用户收藏表情'
  },
  {
    groupId: 212,
    id: 'qq-group-212-fav-emoji',
    name: '用户收藏的自定义表情包 (Group #212)',
    shortName: '收藏表情 (CustomFace)',
    color: '#f97316',
    category: 'files',
    riskLevel: 'caution',
    defaultChecked: false,
    description:
      '用户主动收藏的自定义表情数据库与收藏夹资源 (CustomFace.dbc、CustomFace.db、CustomFace、MyCollection)，清理后无法恢复，默认不勾选'
  },
  {
    groupId: 204,
    id: 'qq-group-204-file-recv',
    name: '聊天接收与云端下载文件 (Group #204)',
    shortName: '接收的文件 (FileRecv)',
    color: '#ef4444',
    category: 'files',
    riskLevel: 'caution',
    defaultChecked: false,
    description:
      '通过 QQ / TIM 接收的办公文档、压缩包与传输文件 (Tencent Files\\%user%\\FileRecv、FileCloud、nt_data\\File)，请仔细核对后再勾选'
  },
  {
    groupId: 213,
    id: 'qq-group-213-session',
    name: '登录会话与快速状态凭证 (Group #213)',
    shortName: '登录会话数据',
    color: '#eab308',
    category: 'files',
    riskLevel: 'caution',
    defaultChecked: false,
    description:
      'QQ / TIM 本地登录态与快速唤醒缓存 (loginrdo.cache、urdo.cache、rdo.cache、Session Storage)，清理后可能需要重新扫码登录，默认不勾选'
  },
  {
    groupId: 999,
    id: 'qq-group-999-protected-db',
    name: '核心聊天记录与注册数据库保护区 (Msg3.0.db / nt_msg.db)',
    shortName: '核心聊天数据库 (受保护)',
    color: '#64748b',
    category: 'protected',
    riskLevel: 'protected',
    defaultChecked: false,
    description:
      '存放所有 QQ / TIM 聊天文字记录、群组关系与本地注册表的加密 SQLite 数据库 (Msg3.0.db、Msg3.0index.db、nt_msg.db、Registry.db、Info.db)，硬件级防误删锁定'
  }
]

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'qq-info-detect',
    title: '自动侦测本机 QQ / NTQQ / TIM 数据存储路径与 QQ 号 (UIN) 列表',
    subtitle: '穿透扫描默认文档 Tencent Files、Roaming\\Tencent\\Users 与符号链接迁移目录',
    tag: '账号侦测',
    method: 'QueryQQInfo',
    params: {}
  },
  {
    id: 'qq-scan-junk',
    title: '深度扫描 12 大官方分组 (日志.tlg/群聊图片/头像库/内核缓存/视频/语音/接收文件)',
    subtitle: '严格对齐 qq_rules.h (Group 201~213)，硬件级锁定保护 Msg3.0.db / nt_msg.db',
    tag: '专项扫描',
    method: 'StartScanAsync',
    params: { scanScope: 'safe_cache' }
  },
  {
    id: 'qq-stats-summary',
    title: '查看各 QQ 号与 12 大清理分组空间占比明细',
    subtitle: '支持按 QQ 号 (qqNumber) 与修改时间 (minModifiedDate: 0/1/2/3) 多维筛选',
    tag: '空间统计',
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
 * 根据 QQ / NTQQ / TIM 文件的真实路径，精准归入 qq_rules.h 的 12 大官方分组 (201~213) 或 999 聊天数据库保护区，
 * 并提取所属 QQ 号 (UIN) 与客户端类型
 */
export function classifyQQFilePath(fullPath: string): {
  groupId: QQGroupId
  accountId: string
  clientType: 'ClassicQQ' | 'QQNT' | 'TIM' | 'Shared'
  isProtected: boolean
} {
  const norm = fullPath.replace(/\//g, '\\')
  const lower = norm.toLowerCase()

  // 1. 提取所属 QQ 号 (UIN: 5~12 位数字)
  let accountId = '公共组件 (Shared)'
  const tfMatch = norm.match(/Tencent Files\\(\d{5,12})(?:\\|$)/i)
  const usersMatch = norm.match(/\\Tencent\\Users\\(\d{5,12})(?:\\|$)/i)
  if (tfMatch && tfMatch[1]) {
    accountId = tfMatch[1]
  } else if (usersMatch && usersMatch[1]) {
    accountId = usersMatch[1]
  }

  // 2. 识别客户端类型
  let clientType: 'ClassicQQ' | 'QQNT' | 'TIM' | 'Shared' = 'ClassicQQ'
  if (lower.includes('\\nt_qq\\') || lower.includes('\\appdata\\roaming\\qq\\')) {
    clientType = 'QQNT'
  } else if (lower.includes('\\tim\\') || lower.includes('tim.tlg') || lower.includes('timlibsdk')) {
    clientType = 'TIM'
  } else if (accountId === '公共组件 (Shared)') {
    clientType = 'Shared'
  }

  // 3. 判定是否属于受保护的核心聊天记录与配置数据库 (Group 999)
  if (
    FORBIDDEN_TARGET_PATTERN.test(norm) ||
    lower.includes('\\nt_db\\') ||
    /\\(?:msg3\.0|msg3\.0index|nt_msg|registry|registry2\.0|info|foldmsg|dingdongstorage|fileshare1\.0|pubacc2\.0|sharedocstroragev1|todostorage)\.db/i.test(
      lower
    )
  ) {
    return { groupId: 999, accountId, clientType, isProtected: true }
  }

  // 4. 判定 12 大官方清理分组 (201~213)
  // Group 203 & 210: 运行跟踪日志 (.tlg / .log / Logs)
  if (
    lower.includes('\\tencent\\logs\\') ||
    lower.includes('\\log\\') ||
    lower.includes('\\logs\\') ||
    lower.endsWith('.tlg') ||
    /\.tlg\.\d+$/i.test(lower) ||
    lower.endsWith('.log')
  ) {
    return { groupId: 203, accountId, clientType, isProtected: false }
  }

  // Group 212: 用户收藏的自定义表情 (CustomFace.db / CustomFace.dbc / CustomFace / MyCollection)
  if (
    /\\customface\.dbc?$/i.test(lower) ||
    lower.includes('\\customface\\') ||
    lower.includes('\\mycollection\\') ||
    lower.includes('\\groupcollection\\')
  ) {
    return { groupId: 212, accountId, clientType, isProtected: false }
  }

  // Group 207: 接收表情缓存 (CustomFaceRecv / ExpressionRecommend / RecommendFace / emoji_cache)
  if (
    lower.includes('\\customfacerecv\\') ||
    lower.includes('\\expressionrecommend') ||
    lower.includes('\\recommendface\\') ||
    lower.includes('\\emoji_cache\\') ||
    lower.includes('\\qqface\\')
  ) {
    return { groupId: 207, accountId, clientType, isProtected: false }
  }

  // Group 208: 头像缓存 (MiscHead.db / QQHead / GroupHead / PushHead / SelCreateGroupHead / nt_data\Head)
  if (
    lower.endsWith('\\mischead.db') ||
    lower.endsWith('\\thumbnails.db') ||
    lower.includes('\\qqhead\\') ||
    lower.includes('\\grouphead\\') ||
    lower.includes('\\pushhead\\') ||
    lower.includes('\\selcreategrouphead\\') ||
    lower.includes('\\nt_data\\head\\') ||
    lower.endsWith('_qh.png')
  ) {
    return { groupId: 208, accountId, clientType, isProtected: false }
  }

  // Group 201: 聊天图片 (Image / nt_data\Pic)
  if (lower.includes('\\image\\') || lower.includes('\\nt_data\\pic\\')) {
    return { groupId: 201, accountId, clientType, isProtected: false }
  }

  // Group 204: 接收的文件 (FileRecv / FileCloud / nt_data\File)
  if (
    lower.includes('\\filerecv\\') ||
    lower.includes('\\filecloud\\') ||
    lower.includes('\\nt_data\\file\\') ||
    lower.endsWith('\\fileinfo.db')
  ) {
    return { groupId: 204, accountId, clientType, isProtected: false }
  }

  // Group 205: 聊天视频 (Video / nt_data\Video)
  if (lower.includes('\\video\\') || lower.includes('\\nt_data\\video\\')) {
    return { groupId: 205, accountId, clientType, isProtected: false }
  }

  // Group 206: 聊天语音 (Audio / Voice / nt_data\Ptt)
  if (
    lower.includes('\\audio\\') ||
    lower.includes('\\voice\\') ||
    lower.includes('\\nt_data\\ptt\\')
  ) {
    return { groupId: 206, accountId, clientType, isProtected: false }
  }

  // Group 213: 登录会话与快速凭证 (Session Storage / Local Storage / loginrdo.cache / urdo.cache / rdo.cache)
  if (
    lower.includes('\\session storage\\') ||
    lower.includes('\\local storage\\') ||
    lower.endsWith('\\loginrdo.cache') ||
    lower.endsWith('\\urdo.cache') ||
    lower.endsWith('\\rdo.cache')
  ) {
    return { groupId: 213, accountId, clientType, isProtected: false }
  }

  // Group 211: 内置浏览器与小程序组件 (MiniBrowser / QQGuild / QQApp / TIMApp / Partitions / miniapp)
  if (
    lower.includes('\\minibrowser\\') ||
    lower.includes('\\qqguild\\') ||
    lower.includes('\\qqapp\\') ||
    lower.includes('\\timapp\\') ||
    lower.includes('\\partitions\\') ||
    lower.includes('\\miniapp\\') ||
    lower.includes('\\qqex\\') ||
    lower.includes('\\qqgame\\') ||
    lower.includes('\\arks\\')
  ) {
    return { groupId: 211, accountId, clientType, isProtected: false }
  }

  // Group 209: QQ/TIM 系统级内核缓存 (Roaming\Tencent\QQ / TIM / Roaming\QQ)
  if (
    lower.includes('\\tencent\\qq\\') ||
    lower.includes('\\tencent\\tim\\') ||
    lower.includes('\\appdata\\roaming\\qq\\') ||
    lower.includes('\\tencent\\users\\') ||
    lower.includes('\\tencent\\txsso\\') ||
    lower.includes('\\tencent\\qqtempsys\\')
  ) {
    return { groupId: 209, accountId, clientType, isProtected: false }
  }

  // 默认归入 Group 202: 账号运行与网页临时缓存 (AppWebCache / Ads / OfflinePackage / CloudRes / Misc.db 等)
  return { groupId: 202, accountId, clientType, isProtected: false }
}

/**
 * 探测并深度扫描本机真实 QQ / NTQQ / TIM 存储路径、登录 QQ 号 (UIN)、12 大官方清理分组与核心聊天数据库保护区
 */
export async function fetchQQCleanSnapshot(hostOverride?: any): Promise<QQScanSnapshot> {
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
  const tencentFilesDir = documentsDir
    ? `${documentsDir}\\Tencent Files`
    : 'C:\\Users\\Default\\Documents\\Tencent Files'

  const driveTencentRoots = mountedDrives.map(d => `${d.drive.replace(/[\\/]+$/, '')}\\Tencent Files`)

  const candidateRoots = [
    tencentFilesDir,
    ...driveTencentRoots,
    appDataDir ? `${appDataDir}\\Tencent\\Users` : '',
    appDataDir ? `${appDataDir}\\Tencent\\Logs` : '',
    appDataDir ? `${appDataDir}\\Tencent\\QQ` : '',
    appDataDir ? `${appDataDir}\\Tencent\\TIM` : '',
    appDataDir ? `${appDataDir}\\QQ` : '',
    localAppData ? `${localAppData}\\Tencent` : ''
  ].filter(Boolean)

  const detectedAccountSet = new Set<string>()
  const allFiles: QQScannedFileEntry[] = []
  const seenPaths = new Set<string>()

  // 归一化 AppData\Roaming\Tencent 与符号链接路径，严防重复计数
  const canonicalizeQQKey = (p: string): string => {
    const lower = p.replace(/\//g, '\\').toLowerCase()
    const idx = lower.indexOf('\\tencent\\')
    if (idx >= 0) return lower.slice(idx)
    return lower
  }

  const registerScannedFile = (fullPath: string, sizeBytes: number, mtime = 0) => {
    if (!fullPath || sizeBytes <= 0) return
    const key = canonicalizeQQKey(fullPath)
    if (seenPaths.has(key)) return
    seenPaths.add(key)

    const cleanPath = fullPath.replace(/\//g, '\\')
    const lastSep = cleanPath.lastIndexOf('\\')
    const name = lastSep >= 0 ? cleanPath.slice(lastSep + 1) : cleanPath
    const parentDir = lastSep > 0 ? cleanPath.slice(0, lastSep) : cleanPath

    const cls = classifyQQFilePath(cleanPath)
    if (cls.accountId !== '公共组件 (Shared)') {
      detectedAccountSet.add(cls.accountId)
    }

    const ruleMeta =
      OFFICIAL_QQ_GROUP_RULES.find(r => r.groupId === cls.groupId) || OFFICIAL_QQ_GROUP_RULES[0]

    allFiles.push({
      id: `qq-file-${allFiles.length}`,
      name,
      path: cleanPath,
      parentDir,
      groupId: cls.groupId,
      groupName: ruleMeta.shortName,
      accountId: cls.accountId,
      clientType: cls.clientType,
      sizeBytes,
      mtime: mtime || Math.floor(Date.now() / 1000),
      isProtected: cls.isProtected
    })
  }

  const extraGroupTotals = new Map<QQGroupId, { extraFiles: number; extraBytes: number; targetDir?: string }>()
  const supportsDeepScan =
    (!hostOverride && isRealElectronHost()) ||
    typeof hostOverride?.system_search_files === 'function'

  if (supportsDeepScan) {
    const deepTargets: Array<{ dir: string; defaultGroup?: QQGroupId }> = [
      { dir: tencentFilesDir },
      ...driveTencentRoots.map(dir => ({ dir })),
      ...(appDataDir
        ? [
            { dir: `${appDataDir}\\Tencent\\Users`, defaultGroup: 209 as QQGroupId },
            { dir: `${appDataDir}\\Tencent\\Logs`, defaultGroup: 203 as QQGroupId },
            { dir: `${appDataDir}\\Tencent\\QQ`, defaultGroup: 209 as QQGroupId },
            { dir: `${appDataDir}\\Tencent\\TIM`, defaultGroup: 209 as QQGroupId },
            { dir: `${appDataDir}\\Tencent\\QQTempSys`, defaultGroup: 209 as QQGroupId },
            { dir: `${appDataDir}\\QQ`, defaultGroup: 209 as QQGroupId }
          ]
        : []),
      ...(localAppData
        ? [
            { dir: `${localAppData}\\Tencent\\MiniBrowser`, defaultGroup: 211 as QQGroupId },
            { dir: `${localAppData}\\Tencent\\QQGuild`, defaultGroup: 211 as QQGroupId },
            { dir: `${localAppData}\\Tencent\\Misc`, defaultGroup: 209 as QQGroupId }
          ]
        : [])
    ]

    const seenSubdirTotals = new Set<string>()
    const scanResults = await Promise.all(deepTargets.map(t => scanRealDirectoryTree(t.dir, 140, hostOverride)))

    // 从 Tencent Files 与 Tencent\Users 一级子目录提取全部本机登录 QQ 号 (UIN)
    for (let i = 0; i < deepTargets.length; i++) {
      const target = deepTargets[i]
      const res = scanResults[i]
      if (!res) continue
      const lowerDir = target.dir.toLowerCase()
      if (lowerDir.endsWith('tencent files') || lowerDir.endsWith('\\tencent\\users')) {
        for (const sub of res.subdirs) {
          if (/^\d{5,12}$/.test(sub.name) || /^nt_qq/i.test(sub.name)) {
            detectedAccountSet.add(sub.name)
          }
        }
      }
    }

    for (let i = 0; i < deepTargets.length; i++) {
      const target = deepTargets[i]
      const res = scanResults[i]
      if (!res || (res.files.length === 0 && res.totalFiles === 0)) continue

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

      if (target.defaultGroup) {
        const canonDirKey = canonicalizeQQKey(target.dir)
        if (!seenSubdirTotals.has(canonDirKey) && res.totalBytes > sampledBytes) {
          seenSubdirTotals.add(canonDirKey)
          const cur = extraGroupTotals.get(target.defaultGroup) || { extraFiles: 0, extraBytes: 0 }
          cur.extraFiles += Math.max(0, res.totalFiles - sampledCount)
          cur.extraBytes += Math.max(0, res.totalBytes - sampledBytes)
          cur.targetDir = target.dir
          extraGroupTotals.set(target.defaultGroup, cur)
        }
      }
    }
  } else {
    // 兼容自定义 hostOverride (filesystem_get_directory_contents) 测试链路
    const subDirs = await listRealDirectoryContents(tencentFilesDir, hostOverride)
    for (const sub of subDirs) {
      const name = sub.split(/[\\/]/).pop() || ''
      if (/^\d{5,12}$/.test(name) || /^nt_qq/i.test(name)) {
        detectedAccountSet.add(name)
      }
    }

    const fallbackDirs = [
      appDataDir ? `${appDataDir}\\Tencent\\QQ` : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\QQ',
      appDataDir ? `${appDataDir}\\Tencent\\Logs` : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\Logs',
      appDataDir ? `${appDataDir}\\Tencent` : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent',
      tencentFilesDir,
      localAppData ? `${localAppData}\\Tencent` : 'C:\\Users\\Default\\AppData\\Local\\Tencent',
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

  // 构建 12 大官方清理分组 + 1 个核心聊天数据库保护区
  const categories: QQCleanCategoryItem[] = OFFICIAL_QQ_GROUP_RULES.map(rule => {
    const catFiles = allFiles.filter(f => f.groupId === rule.groupId)
    const extra = extraGroupTotals.get(rule.groupId)
    const sampledBytes = catFiles.reduce((acc, f) => acc + f.sizeBytes, 0)
    const totalSizeBytes = sampledBytes + (extra?.extraBytes || 0)
    const fileCount = catFiles.length + (extra?.extraFiles || 0)

    const defaultDir =
      catFiles[0]?.parentDir ||
      extra?.targetDir ||
      (rule.groupId === 203
        ? appDataDir
          ? `${appDataDir}\\Tencent\\Logs`
          : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\Logs'
        : rule.groupId === 209 || rule.groupId === 213
        ? appDataDir
          ? `${appDataDir}\\Tencent\\QQ`
          : 'C:\\Users\\Default\\AppData\\Roaming\\Tencent\\QQ'
        : rule.groupId === 211
        ? localAppData
          ? `${localAppData}\\Tencent\\MiniBrowser`
          : 'C:\\Users\\Default\\AppData\\Local\\Tencent'
        : tencentFilesDir)

    return {
      id: rule.id,
      groupId: rule.groupId,
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
      checked: rule.defaultChecked && rule.groupId !== 999 && totalSizeBytes > 0,
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

  categories.sort((a, b) => {
    if (a.groupId === 999) return 1
    if (b.groupId === 999) return -1
    return b.totalSizeBytes - a.totalSizeBytes
  })

  // 汇总各 QQ 账号 (UIN) 统计
  const accountMap = new Map<string, { fileCount: number; totalBytes: number; rootDir: string; clientType: string }>()
  for (const acc of detectedAccountSet) {
    accountMap.set(acc, {
      fileCount: 0,
      totalBytes: 0,
      rootDir: `${tencentFilesDir}\\${acc}`,
      clientType: 'ClassicQQ / TIM'
    })
  }
  for (const f of allFiles) {
    const cur = accountMap.get(f.accountId) || {
      fileCount: 0,
      totalBytes: 0,
      rootDir: f.parentDir,
      clientType: f.clientType
    }
    cur.fileCount += 1
    cur.totalBytes += f.sizeBytes
    accountMap.set(f.accountId, cur)
  }

  const accountStats: QQAccountStat[] = Array.from(accountMap.entries())
    .map(([accountId, stat]) => ({
      accountId,
      label:
        accountId === '公共组件 (Shared)'
          ? '腾讯公共组件与日志缓存 (Logs / QQ / TIM)'
          : `QQ 号 (UIN): ${accountId}`,
      clientType: stat.clientType,
      rootDir: stat.rootDir,
      fileCount: stat.fileCount,
      totalBytes: stat.totalBytes
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes)

  const detectedAccounts = Array.from(detectedAccountSet)
  const scannableCategories = categories.filter(c => c.groupId !== 999)
  const totalScannableBytes = scannableCategories.reduce((s, c) => s + c.totalSizeBytes, 0)
  const checkedBytes = scannableCategories
    .filter(c => c.checked)
    .reduce((s, c) => s + c.totalSizeBytes, 0)
  const protectedDbBytes = categories.find(c => c.groupId === 999)?.totalSizeBytes || 0

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
    qqVariantSummary: 'QQ / TIM / NTQQ 全系支持'
  }
}

/**
 * 执行 QQ / TIM 缓存安全清理（硬件级拦截 Msg3.0.db / nt_msg.db / Registry.db 等聊天数据库，走系统回收站安全移除）
 */
export async function executeQQCleanup(
  categoriesOrPaths: QQCleanCategoryItem[] | string[],
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
      ? (categoriesOrPaths as QQCleanCategoryItem[])
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
      const cls = classifyQQFilePath(targetPath)
      if (FORBIDDEN_TARGET_PATTERN.test(targetPath) || cls.isProtected || cls.groupId === 999) {
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

  const selected = categories.filter(c => c.checked && c.groupId !== 999 && c.sampleFiles.length > 0)
  if (selected.length === 0) {
    return {
      ok: true,
      deletedCount: 0,
      freedBytes: 0,
      skippedProtected: 0,
      deletedPaths: [],
      skippedPaths: []
    }
  }

  for (const cat of selected) {
    for (const sample of cat.sampleFiles) {
      const cls = classifyQQFilePath(sample.path)
      if (FORBIDDEN_TARGET_PATTERN.test(sample.path) || cls.isProtected || cls.groupId === 999) {
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

export async function openQQDirectory(dirPath: string, hostOverride?: any): Promise<boolean> {
  if (!dirPath) return false
  return showRealItemInFolder(dirPath, hostOverride)
}

export async function openQQFileDefault(filePath: string, hostOverride?: any): Promise<boolean> {
  if (!filePath) return false
  return openRealPath(filePath, hostOverride)
}
