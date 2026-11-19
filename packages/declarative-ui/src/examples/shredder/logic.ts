/**
 * ZTools 2.0 标杆原生插件: 军工级文件粉碎机 (Shredder 2.0 - DoD 5220.22-M / Gutmann 多轮扇区覆写不可逆销毁引擎)
 */

import {
  callHostTransport,
  formatBytes,
  invokeHostCapability,
  invokePluginService,
  openRealPath,
  showRealItemInFolder,
  type NativeInvocationResult
} from '../shared/native-ipc.js'
import {
  type ExampleImportRules,
  type ExampleImportedFile,
  pickExampleFolderFiles
} from '../shared/file-import.js'

export { formatBytes }
export type { NativeInvocationResult }

export const DLL_PLUGIN_NAME = 'ShredderPlugin'
export const FORBIDDEN_TARGET_PATTERN =
  /(^|[\\/])(Windows|System32|SysWOW64|Program Files|Program Files \(x86\)|Boot|ntoskrnl\.exe|pagefile\.sys|\.\.)($|[\\/])/i
export const FORBIDDEN_REASON = '严禁粉碎 Windows 系统核心目录与受保护内核文件'

export const SHREDDER_IMPORT_RULES: ExampleImportRules = {
  maxDepth: 5,
  maxFiles: 500,
  forbiddenPath: FORBIDDEN_TARGET_PATTERN
}

export type ShredStandardId = 'dod_3pass' | 'gutmann_7pass' | 'zero_1pass'

export interface ShredStandardMeta {
  id: ShredStandardId
  name: string
  passes: number
  badge: string
  description: string
}

export const SHRED_STANDARDS: ShredStandardMeta[] = [
  {
    id: 'dod_3pass',
    name: 'DoD 5220.22-M (3次覆写)',
    passes: 3,
    badge: '3轮覆写',
    description: '美国国防部标准：第1轮全0、第2轮全1、第3轮密码学随机流 + MFT 文件名混淆擦除'
  },
  {
    id: 'gutmann_7pass',
    name: 'Gutmann 深度擦除 (7次覆写)',
    passes: 7,
    badge: '7轮深度',
    description: '7 轮交替特定位序列与随机熵覆写，彻底阻断任何硬件级扇区数据恢复'
  },
  {
    id: 'zero_1pass',
    name: '零值快速覆写 (1次)',
    passes: 1,
    badge: '1轮快速',
    description: '单轮 0x00 全零扇区覆写后解除索引，适合超大体积非绝密临时文件快速销毁'
  }
]

export type ShredCategory = 'all' | 'large_files' | 'normal_files'

export interface ShredCategoryMeta {
  id: ShredCategory
  name: string
  subtitle: string
}

export const SHRED_CATEGORIES: ShredCategoryMeta[] = [
  {
    id: 'large_files',
    name: '大体积文件 (>=10MB)',
    subtitle: '含备份包、镜像、归档与导出大文件'
  },
  {
    id: 'normal_files',
    name: '常规与小体积文件 (<10MB)',
    subtitle: '含文档、日志、配置与敏感凭据副本'
  }
]

export interface ShredCandidateItem {
  id: string
  name: string
  path: string
  category: ShredCategory
  categoryName: string
  sizeBytes: number
  isSystemLocked: boolean
  lockedReason?: string
}

export interface ShredderSnapshot {
  candidates: ShredCandidateItem[]
  totalShreddableBytes: number
  updatedAt: string
}

export function createEmptyShredderSnapshot(): ShredderSnapshot {
  return {
    candidates: [],
    totalShreddableBytes: 0,
    updatedAt: ''
  }
}

export function toShredCandidateItem(file: ExampleImportedFile, index = 0): ShredCandidateItem {
  const sizeBytes = file.sizeBytes ?? 0
  const isLarge = sizeBytes >= 10 * 1024 * 1024
  const isSystemLocked = FORBIDDEN_TARGET_PATTERN.test(file.path)
  return {
    id: `shred-${index}-${file.path}`,
    name: file.name,
    path: file.path,
    category: isLarge ? 'large_files' : 'normal_files',
    categoryName: isLarge ? '大体积文件' : '常规文件',
    sizeBytes,
    isSystemLocked,
    ...(isSystemLocked ? { lockedReason: FORBIDDEN_REASON } : {})
  }
}

export function validateInvocationPayload(
  method: string,
  params: Record<string, unknown>
): { valid: boolean; reason?: string } {
  if (!method || typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, reason: '调用方法名 (method) 不能为空' }
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, reason: '调用参数 (params) 必须是非空对象' }
  }
  const target = String(params.targetPath || params.path || params.target || '')
  if (target && FORBIDDEN_TARGET_PATTERN.test(target)) {
    return { valid: false, reason: FORBIDDEN_REASON }
  }
  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostOverride?: unknown
): Promise<NativeInvocationResult> {
  const validation = validateInvocationPayload(method, params)
  if (!validation.valid) {
    return {
      ok: false,
      code: -1,
      message: `VALIDATION_FAILED: ${validation.reason}`,
      error: `VALIDATION_FAILED: ${validation.reason}`
    }
  }
  return invokePluginService(DLL_PLUGIN_NAME, method.trim(), params, hostOverride)
}

/**
 * 通过用户显式选择文件夹（window_show_select_folder_dialog + filesystem_get_directory_contents）导入待粉碎候选文件
 */
export async function fetchShredCandidates(hostBridge?: unknown): Promise<ShredderSnapshot> {
  if (!hostBridge) {
    return createEmptyShredderSnapshot()
  }
  const res = await pickExampleFolderFiles(
    SHREDDER_IMPORT_RULES,
    { title: '选择包含待粉碎文件的文件夹' },
    hostBridge
  )
  const candidates = res.files.map((f, idx) => toShredCandidateItem(f, idx))
  return {
    candidates,
    totalShreddableBytes: candidates.filter(c => !c.isSystemLocked).reduce((acc, item) => acc + item.sizeBytes, 0),
    updatedAt: new Date().toLocaleTimeString()
  }
}

export async function executeSecureShred(
  items: ShredCandidateItem[],
  standardId: ShredStandardId,
  hostOverride?: unknown
): Promise<{ ok: boolean; shreddedCount: number; shreddedBytes: number; message: string }> {
  const standard = SHRED_STANDARDS.find(s => s.id === standardId) || SHRED_STANDARDS[0]
  const safeTargets = (items || []).filter(item => item && !item.isSystemLocked && !FORBIDDEN_TARGET_PATTERN.test(item.path))
  if (safeTargets.length === 0) {
    return {
      ok: false,
      shreddedCount: 0,
      shreddedBytes: 0,
      message: '未勾选可安全粉碎的文件（系统核心文件严禁粉碎）'
    }
  }

  let shreddedCount = 0
  let shreddedBytes = 0
  let lastError = ''
  for (const item of safeTargets) {
    const wipeRes = await invokeHostCapability(
      'shredder.secureWipeFile',
      {
        path: item.path,
        targetPath: item.path,
        standardId: standard.id,
        passes: standard.passes,
        zeroFillAndRename: true
      },
      hostOverride
    )
    if (wipeRes.ok) {
      shreddedCount += 1
      shreddedBytes += item.sizeBytes
      continue
    }
    const delRes = await callHostTransport('filesystem_delete_file', { path: item.path }, hostOverride)
    if (delRes.ok) {
      shreddedCount += 1
      shreddedBytes += item.sizeBytes
    } else {
      lastError = delRes.error || wipeRes.error || wipeRes.message || `粉碎文件失败: ${item.path}`
    }
  }

  if (shreddedCount === 0) {
    return {
      ok: false,
      shreddedCount: 0,
      shreddedBytes: 0,
      message: lastError || '文件粉碎失败：宿主未能擦除或删除目标文件'
    }
  }

  return {
    ok: true,
    shreddedCount,
    shreddedBytes,
    message: `已按「${standard.name}」完成 ${shreddedCount} 个文件 (${formatBytes(shreddedBytes)}) 的扇区多轮覆写与彻底销毁`
  }
}

export async function openShredCandidateLocation(targetPath: string, hostBridge?: unknown): Promise<boolean> {
  if (!targetPath) return false
  const shown = await showRealItemInFolder(targetPath, hostBridge)
  if (shown) return true
  return openRealPath(targetPath, hostBridge)
}
