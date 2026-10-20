/**
 * 批量文件重命名工作台业务逻辑与真实文件系统契约层 (BatchRename 2.0 Logic)
 * 1:1 复刻 DLLPlugins/batch-rename/BatchRenamePlugin/产品设计文档.md
 * 完整支持 10 大替换/追加/序号规则、4 种智能排序、重命名同名冲突检测、真实原子改名与一键撤销回滚 (Undo)
 */

import {
  callHostTransport,
  formatBytes,
  getRealSystemPath,
  invokeDllPluginCapability,
  isRealElectronHost,
  readRealDirectory,
  showRealItemInFolder
} from '../shared/native-ipc.js'

export { formatBytes } from '../shared/native-ipc.js'

export type RenameRuleType =
  | 'replace'
  | 'prefix'
  | 'date_prefix'
  | 'suffix'
  | 'case'
  | 'number'
  | 'number_cn'
  | 'number_roman'
  | 'trim_head3'
  | 'clean_brackets'
  | 'snake_case'

export interface RenameRule {
  type: RenameRuleType
  find?: string
  replace?: string
  prefix?: string
  suffix?: string
  caseMode?: 'upper' | 'lower' | 'title'
  startNumber?: number
  padDigits?: number
}

export interface RenameResultItem {
  id: string
  oldName: string
  newName: string
  changed: boolean
  conflict?: boolean
  fullPath?: string
  parentDir?: string
  sizeBytes?: number
}

export interface RenameUndoEntry {
  oldPath: string
  newPath: string
  oldName: string
  newName: string
}

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

export const DLL_PLUGIN_NAME = 'BatchRenamePlugin'
export const FORBIDDEN_TARGET_PATTERN =
  /(?:^|[\\/])(?:Windows|System32|SysWOW64|Program Files|Program Files \(x86\)|\.\.)(?:$|[\\/])/i
export const FORBIDDEN_REASON = '严禁对 Windows 系统核心目录执行批量重命名或包含路径穿越字符'

export const RENAME_RULE_PRESETS: Array<{ id: RenameRuleType; label: string; desc: string }> = [
  { id: 'number', label: '阿拉伯序号 (_01, _02)', desc: '按补零数字序列自动追加后缀 (PRD 2.3.4)' },
  { id: 'number_cn', label: '中文序号 (_一, _二)', desc: '按中文数字序列追加后缀 (PRD 2.3.4)' },
  { id: 'number_roman', label: '罗马序号 (_I, _II)', desc: '按罗马数字序列追加后缀 (PRD 2.3.4)' },
  { id: 'prefix', label: '前缀注入 (Prefix_)', desc: '在文件名首部插入自定义前缀或工程标识 (PRD 2.3.1)' },
  { id: 'date_prefix', label: '日期归档前缀 (YYYYMMDD_)', desc: '自动注入当前日期归档头' },
  { id: 'suffix', label: '后缀追加 (_Suffix)', desc: '在扩展名前追加版本或状态后缀 (PRD 2.3.2)' },
  { id: 'trim_head3', label: '裁剪前3字符 (前N位删除)', desc: '移除文件名前 3 位冗余编号字符 (PRD 2.2.2)' },
  { id: 'clean_brackets', label: '清洗括号与冗余符号', desc: '清除 () [] 【】 及其内部广告/副本标记 (PRD 2.2.5)' },
  { id: 'snake_case', label: '下划线规范化 (snake_case)', desc: '将空格与连字符统一替换为下划线' },
  { id: 'case', label: '全小写规范 (lowercase)', desc: '文件名与扩展名统一转为全小写 (PRD 2.2.6)' }
]

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'rename-seq-number',
    title: '按两位序号递增批量重命名 (_01, _02...)',
    subtitle: '为目录内文件统一追加规范化数字序列后缀',
    tag: '序号重命名',
    method: 'BatchRenameByRule',
    params: { type: 'number', startNumber: 1, padDigits: 2 }
  },
  {
    id: 'rename-prefix-date',
    title: '批量注入归档前缀 ([ZTools]_)',
    subtitle: '为项目交付物或摄影素材统一添加工程前缀标识',
    tag: '前缀注入',
    method: 'BatchRenameByRule',
    params: { type: 'prefix', prefix: 'ZTools_' }
  },
  {
    id: 'rename-case-lower',
    title: '文件名与扩展名统一规范为全小写',
    subtitle: '消除跨平台大小写敏感引发的资源引用隐患',
    tag: '大小写规范',
    method: 'BatchRenameByRule',
    params: { type: 'case', caseMode: 'lower' }
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

export function splitFileName(fullName: string): { baseName: string; extension: string } {
  const lastDot = fullName.lastIndexOf('.')
  if (lastDot > 0) {
    return {
      baseName: fullName.slice(0, lastDot),
      extension: fullName.slice(lastDot)
    }
  }
  return {
    baseName: fullName,
    extension: ''
  }
}

function toTitleCase(str: string): string {
  return str.replace(/[A-Za-z]+/g, word => {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  })
}

const CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
const ROMAN_NUMS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']

/**
 * 单个文件名应用重命名规则 (1:1 对齐 PRD 2.2 & 2.3)
 */
export function applyRenameRule(fileName: string, rule: RenameRule, index: number): string {
  const { baseName, extension } = splitFileName(fileName)
  let newBaseName = baseName
  let newExtension = extension

  switch (rule.type) {
    case 'replace': {
      if (rule.find) {
        newBaseName = newBaseName.split(rule.find).join(rule.replace || '')
      }
      break
    }
    case 'prefix': {
      if (rule.prefix) {
        newBaseName = `${rule.prefix}${newBaseName}`
      }
      break
    }
    case 'date_prefix': {
      const d = new Date()
      const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_`
      if (!newBaseName.startsWith(ds)) {
        newBaseName = `${ds}${newBaseName}`
      }
      break
    }
    case 'suffix': {
      if (rule.suffix) {
        newBaseName = `${newBaseName}${rule.suffix}`
      }
      break
    }
    case 'case': {
      if (rule.caseMode === 'upper') {
        newBaseName = newBaseName.toUpperCase()
        newExtension = newExtension.toUpperCase()
      } else if (rule.caseMode === 'lower' || !rule.caseMode) {
        newBaseName = newBaseName.toLowerCase()
        newExtension = newExtension.toLowerCase()
      } else if (rule.caseMode === 'title') {
        newBaseName = toTitleCase(newBaseName)
      }
      break
    }
    case 'number': {
      const start = rule.startNumber ?? 1
      const pad = rule.padDigits ?? 2
      const numStr = String(start + index).padStart(pad, '0')
      newBaseName = `${newBaseName}_${numStr}`
      break
    }
    case 'number_cn': {
      const cn = CN_NUMS[index] || String(index + 1)
      newBaseName = `${newBaseName}_${cn}`
      break
    }
    case 'number_roman': {
      const rom = ROMAN_NUMS[index] || String(index + 1)
      newBaseName = `${newBaseName}_${rom}`
      break
    }
    case 'trim_head3': {
      newBaseName = newBaseName.length > 3 ? newBaseName.slice(3) : newBaseName
      break
    }
    case 'clean_brackets': {
      const cleaned = newBaseName
        .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, '')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '')
      if (cleaned.length > 0) newBaseName = cleaned
      break
    }
    case 'snake_case': {
      newBaseName = newBaseName.replace(/[\s\-]+/g, '_').toLowerCase()
      newExtension = newExtension.toLowerCase()
      break
    }
  }

  return `${newBaseName}${newExtension}`
}

export function batchApplyRename(files: string[], rule: RenameRule): RenameResultItem[] {
  const seen = new Set<string>()
  return files.map((file, index) => {
    const newName = applyRenameRule(file, rule, index)
    const lower = newName.toLowerCase()
    const conflict = seen.has(lower)
    seen.add(lower)
    return {
      id: `file-${index}`,
      oldName: file,
      newName,
      changed: file !== newName,
      conflict
    }
  })
}

export function getSampleFiles(): string[] {
  return [
    'IMG_2026_01.JPG',
    'IMG_2026_02.JPG',
    'IMG_2026_03.JPG',
    'document_draft_v1.docx',
    'my-awesome-video-clip.mp4'
  ]
}

export interface RealFileEntry {
  name: string
  fullPath: string
  parentDir: string
  extension: string
  sizeBytes: number
  lastModifiedMs: number
}

/**
 * 从本机真实目录 (downloads / desktop / documents / pictures / videos) 加载待重命名文件列表
 */
export async function fetchRealBatchRenameFiles(
  sourceScope: 'downloads' | 'desktop' | 'documents' | 'pictures' | 'videos' = 'downloads',
  hostOverride?: any
): Promise<{ directory: string; files: RealFileEntry[] }> {
  const dirPath = await getRealSystemPath(sourceScope, hostOverride)
  if (!dirPath) {
    return { directory: '', files: [] }
  }

  const entries = await readRealDirectory(dirPath, hostOverride)
  const files: RealFileEntry[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!entry.name || entry.name.toLowerCase() === 'desktop.ini') continue
    const dot = entry.name.lastIndexOf('.')
    const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : '.file'
    files.push({
      name: entry.name,
      fullPath: entry.path || `${dirPath}\\${entry.name}`,
      parentDir: dirPath,
      extension: ext,
      sizeBytes: entry.sizeBytes || 0,
      lastModifiedMs: entry.lastModifiedMs || 0
    })
  }

  return { directory: dirPath, files: files.slice(0, 60) }
}

export async function executeRealFileRename(
  sourcePath: string,
  newFileName: string,
  hostOverride?: any
): Promise<{ ok: boolean; destinationPath?: string; error?: string }> {
  if (!sourcePath || !newFileName) {
    return { ok: false, error: '源路径或新文件名不能为空' }
  }
  if (FORBIDDEN_TARGET_PATTERN.test(sourcePath) || FORBIDDEN_TARGET_PATTERN.test(newFileName)) {
    return { ok: false, error: FORBIDDEN_REASON }
  }
  const sep = sourcePath.includes('\\') ? '\\' : '/'
  const parts = sourcePath.split(/[\\/]/)
  parts.pop()
  const parentDir = parts.join(sep)
  const destinationPath = `${parentDir}${sep}${newFileName}`
  if (destinationPath === sourcePath) {
    return { ok: true, destinationPath }
  }

  const res = await callHostTransport('filesystem_move_file', { sourcePath, destinationPath }, hostOverride)
  return { ok: res.ok, destinationPath, error: res.error }
}

/**
 * 批量撤销上一次重命名操作 (PRD 2.6 撤销回滚)
 */
export async function undoBatchRenameHistory(
  history: RenameUndoEntry[],
  hostOverride?: any
): Promise<{ ok: boolean; restoredCount: number }> {
  let restoredCount = 0
  for (const item of history) {
    const res = await callHostTransport(
      'filesystem_move_file',
      { sourcePath: item.newPath, destinationPath: item.oldPath },
      hostOverride
    )
    if (res.ok) restoredCount += 1
  }
  return { ok: restoredCount > 0, restoredCount }
}

export async function openRenameFileLocation(fullPath: string, hostOverride?: any): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
