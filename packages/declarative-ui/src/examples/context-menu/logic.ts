/**
 * 系统右键菜单扩展管理中枢 (ContextMenu 2.0 Logic)
 * 支持一键切换 Windows 11 经典完整右键菜单，以及真实扫描与管理文件/文件夹/桌面背景右键 Shell 扩展项
 */

import { callHostTransport, invokePluginService, isRealElectronHost, invokeDllPluginCapability } from '../shared/native-ipc.js'

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

export type ContextMenuScope = 'system' | 'file' | 'directory' | 'background'
export type ContextMenuFilterMode = 'all' | 'file' | 'directory' | 'background' | 'disabled'

export interface ContextMenuEntry {
  id: string
  title: string
  publisher: string
  scope: ContextMenuScope
  scopeLabel: string
  registryKey: string
  command: string
  enabled: boolean
  isOrphaned?: boolean
  isWin11ClassicToggle?: boolean
}

export interface ContextMenuSnapshot {
  entries: ContextMenuEntry[]
  win11ClassicEnabled: boolean
  enabledCount: number
  disabledCount: number
}

export const DLL_PLUGIN_NAME = 'ContextMenuPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('^(?:HKLM\\\\SAM|HKLM\\\\SECURITY|DELETE_ROOT_CLASSES)$', 'i')
export const FORBIDDEN_REASON = '禁止删除或篡改系统根级 HKCR / SAM 安全注册表分支'

export const WIN11_CLASSIC_CLSID_KEY =
  'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32'

export const DEFAULT_CONTEXT_MENU_ENTRIES: ContextMenuEntry[] = [
  {
    id: 'ctx-win11-classic',
    title: 'Windows 11 经典完整右键菜单模式 (Classic Full Context Menu)',
    publisher: 'Microsoft Windows Shell',
    scope: 'system',
    scopeLabel: '系统模式',
    registryKey: WIN11_CLASSIC_CLSID_KEY,
    command: 'reg add "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32" /f /ve',
    enabled: true,
    isWin11ClassicToggle: true
  },
  {
    id: 'ctx-vscode-file',
    title: '通过 Visual Studio Code 打开 (Open with Code)',
    publisher: 'Microsoft Corporation',
    scope: 'file',
    scopeLabel: '文件右键',
    registryKey: 'HKCR\\*\\shell\\VSCode',
    command: '"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" "%1"',
    enabled: true
  },
  {
    id: 'ctx-vscode-dir',
    title: '通过 Visual Studio Code 打开目录 (Open Folder with Code)',
    publisher: 'Microsoft Corporation',
    scope: 'directory',
    scopeLabel: '目录右键',
    registryKey: 'HKCR\\Directory\\shell\\VSCode',
    command: '"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" "%V"',
    enabled: true
  },
  {
    id: 'ctx-git-bash',
    title: 'Open Git Bash Here',
    publisher: 'Git for Windows',
    scope: 'directory',
    scopeLabel: '目录右键',
    registryKey: 'HKCR\\Directory\\shell\\git_shell',
    command: '"C:\\Program Files\\Git\\git-bash.exe" "--cd=%v."',
    enabled: true
  },
  {
    id: 'ctx-git-gui',
    title: 'Open Git GUI Here',
    publisher: 'Git for Windows',
    scope: 'directory',
    scopeLabel: '目录右键',
    registryKey: 'HKCR\\Directory\\shell\\git_gui',
    command: '"C:\\Program Files\\Git\\cmd\\git-gui.exe" "--working-dir" "%v."',
    enabled: false
  },
  {
    id: 'ctx-7zip',
    title: '7-Zip 压缩与解压归档扩展 (7-Zip Shell Extension)',
    publisher: 'Igor Pavlov',
    scope: 'file',
    scopeLabel: '文件右键',
    registryKey: 'HKCR\\*\\shellex\\ContextMenuHandlers\\7-Zip',
    command: 'C:\\Program Files\\7-Zip\\7-zip.dll',
    enabled: true
  },
  {
    id: 'ctx-wt-bg',
    title: '在终端中打开 (Open in Windows Terminal)',
    publisher: 'Microsoft Corporation',
    scope: 'background',
    scopeLabel: '桌面背景',
    registryKey: 'HKCR\\Directory\\Background\\shell\\wt',
    command: 'wt.exe -d "%V"',
    enabled: true
  },
  {
    id: 'ctx-baidupan',
    title: '使用百度网盘上传 / 极速分享',
    publisher: 'Baidu Netdisk',
    scope: 'file',
    scopeLabel: '文件右键',
    registryKey: 'HKCR\\*\\shellex\\ContextMenuHandlers\\YunShellExt',
    command: 'C:\\Users\\User\\AppData\\Roaming\\baidu\\BaiduNetdisk\\YunShellExt64.dll',
    enabled: false
  },
  {
    id: 'ctx-wps-office',
    title: 'WPS Office 云文档与 PDF 转换菜单',
    publisher: 'Kingsoft Office',
    scope: 'file',
    scopeLabel: '文件右键',
    registryKey: 'HKCR\\*\\shellex\\ContextMenuHandlers\\qingshell',
    command: 'C:\\Users\\User\\AppData\\Local\\Kingsoft\\WPS Office\\qingshell64.dll',
    enabled: false
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return DEFAULT_CONTEXT_MENU_ENTRIES.map((e) => ({
    id: e.id,
    title: e.title,
    subtitle: e.registryKey,
    tag: e.scopeLabel,
    method: 'ToggleContextMenuEntry',
    params: { id: e.id, registryKey: e.registryKey, enabled: !e.enabled }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q)
  )
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || !method.trim()) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' && FORBIDDEN_TARGET_PATTERN.test(v.trim())) {
      return { valid: false, error: `SECURITY_INTERCEPTED (${k}): ${FORBIDDEN_REASON}` }
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
  return invokeDllPluginCapability(DLL_PLUGIN_NAME, method.trim(), params, hostBridge)
}

function mapRawContextMenuEntry(raw: any, i: number): ContextMenuEntry {
  const rawScope = String(raw.scope || raw.scopeLabel || '').toLowerCase()
  let scope: ContextMenuScope = 'file'
  if (raw.scope === 'system' || rawScope.includes('系统') || rawScope === 'system') {
    scope = 'system'
  } else if (
    rawScope.includes('目录') ||
    rawScope.includes('文件夹') ||
    rawScope.includes('directory') ||
    rawScope.includes('folder')
  ) {
    scope = 'directory'
  } else if (
    rawScope.includes('背景') ||
    rawScope.includes('桌面') ||
    rawScope.includes('background') ||
    rawScope.includes('desktop')
  ) {
    scope = 'background'
  } else {
    scope = 'file'
  }

  const scopeLabel =
    raw.scopeLabel ||
    (scope === 'system'
      ? '系统模式'
      : scope === 'directory'
      ? '目录右键'
      : scope === 'background'
      ? '桌面背景'
      : '文件右键')
  return {
    id: String(raw.id || `ctx-entry-${i}`),
    title: String(raw.title || raw.name || `右键菜单项 #${i + 1}`),
    publisher: String(raw.publisher || 'Windows Shell'),
    scope,
    scopeLabel: String(scopeLabel),
    registryKey: String(raw.registryKey || raw.regPath || ''),
    command: String(raw.command || ''),
    enabled: Boolean(raw.enabled ?? true),
    isOrphaned: Boolean(raw.isOrphaned ?? false),
    isWin11ClassicToggle: Boolean(raw.isWin11ClassicToggle ?? false)
  }
}

export async function fetchContextMenuEntries(hostOverride?: any): Promise<ContextMenuSnapshot> {
  const realHost = isRealElectronHost(hostOverride) || Boolean(hostOverride)

  if (realHost) {
    const pluginRes = await invokePluginService<any>(DLL_PLUGIN_NAME, 'scanEntries', {}, hostOverride)
    const rawData =
      pluginRes.ok && pluginRes.data
        ? pluginRes.data
        : (await callHostTransport<any>('context_menu_list', {}, hostOverride)).data

    if (rawData) {
      const list = Array.isArray(rawData)
        ? rawData
        : Array.isArray(rawData?.entries)
        ? rawData.entries
        : Array.isArray(rawData?.items)
        ? rawData.items
        : null
      if (list) {
        const remoteEntries: ContextMenuEntry[] = list.map(mapRawContextMenuEntry)
        const enabledCount = remoteEntries.filter((e: ContextMenuEntry) => e.enabled).length
        const win11Item = remoteEntries.find((e: ContextMenuEntry) => e.isWin11ClassicToggle)
        return {
          entries: remoteEntries,
          win11ClassicEnabled: Boolean(rawData.win11ClassicEnabled ?? win11Item?.enabled ?? false),
          enabledCount,
          disabledCount: remoteEntries.length - enabledCount
        }
      }
    }

    if (isRealElectronHost(hostOverride)) {
      return {
        entries: [],
        win11ClassicEnabled: false,
        enabledCount: 0,
        disabledCount: 0
      }
    }
  }

  const entries = DEFAULT_CONTEXT_MENU_ENTRIES.map((e) => ({ ...e }))
  const enabledCount = entries.filter((e) => e.enabled).length
  const win11Item = entries.find((e) => e.isWin11ClassicToggle)

  return {
    entries,
    win11ClassicEnabled: Boolean(win11Item?.enabled ?? true),
    enabledCount,
    disabledCount: entries.length - enabledCount
  }
}

export async function switchWin11ClassicMenu(
  useClassic: boolean,
  hostOverride?: any
): Promise<{ ok: boolean; classicMode: boolean; message: string }> {
  const cmd = useClassic
    ? `reg add "${WIN11_CLASSIC_CLSID_KEY}" /f /ve`
    : `reg delete "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}" /f`

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const svcRes = await invokePluginService<any>(
      DLL_PLUGIN_NAME,
      'switchWin11Classic',
      { useClassic, command: cmd },
      hostOverride
    )
    if (svcRes.ok && svcRes.data?.ok !== false) {
      return {
        ok: true,
        classicMode: useClassic,
        message:
          svcRes.data?.message ||
          (useClassic
            ? '已切换为 Windows 11 经典完整右键菜单 (无需点击显示更多选项)'
            : '已恢复为 Windows 11 默认折叠右键菜单')
      }
    }
    if (svcRes.data?.ok === false) {
      return {
        ok: false,
        classicMode: !useClassic,
        message: String(svcRes.data.error || svcRes.data.message || '写入 HKCU CLSID 右键菜单模式注册表失败')
      }
    }

    const shellRes = await callHostTransport('shell_exec', { command: cmd }, hostOverride)
    if (!shellRes.ok) {
      return {
        ok: false,
        classicMode: !useClassic,
        message: svcRes.error || shellRes.error || '写入 HKCU CLSID 右键菜单模式注册表失败'
      }
    }
  }

  return {
    ok: true,
    classicMode: useClassic,
    message: useClassic
      ? '已切换为 Windows 11 经典完整右键菜单 (无需点击显示更多选项)'
      : '已恢复为 Windows 11 默认折叠右键菜单'
  }
}

export async function toggleContextMenuEntry(
  id: string,
  enabled?: boolean,
  hostOverride?: any,
  regPath?: string
): Promise<{ ok: boolean; enabled: boolean; message: string }> {
  const normalizedId = typeof id === 'string' ? id.trim() : ''
  if (!normalizedId) {
    return { ok: false, enabled: false, message: '右键菜单项 ID 不能为空' }
  }

  const target = DEFAULT_CONTEXT_MENU_ENTRIES.find((e) => e.id === normalizedId)
  const nextState = typeof enabled === 'boolean' ? enabled : !(target?.enabled ?? true)
  const resolvedRegKey = (regPath || target?.registryKey || normalizedId).trim()

  if (FORBIDDEN_TARGET_PATTERN.test(resolvedRegKey)) {
    return { ok: false, enabled: !nextState, message: FORBIDDEN_REASON }
  }

  if (target?.isWin11ClassicToggle || normalizedId === 'ctx-win11-classic') {
    const classicRes = await switchWin11ClassicMenu(nextState, hostOverride)
    return {
      ok: classicRes.ok,
      enabled: classicRes.classicMode,
      message: classicRes.message
    }
  }

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const svcRes = await invokePluginService<any>(
      DLL_PLUGIN_NAME,
      'toggleEntry',
      { id: normalizedId, regPath: resolvedRegKey, registryKey: resolvedRegKey, enabled: nextState },
      hostOverride
    )
    if (svcRes.ok && svcRes.data?.ok !== false) {
      return {
        ok: true,
        enabled: nextState,
        message: String(svcRes.data?.message || `${nextState ? '已启用' : '已禁用'}右键菜单项: ${target?.title || normalizedId}`)
      }
    }
    if (svcRes.data?.ok === false) {
      return {
        ok: false,
        enabled: !nextState,
        message: String(svcRes.data.error || svcRes.data.message || `修改注册表右键菜单项 [${resolvedRegKey}] 失败`)
      }
    }

    const legacyRes = await callHostTransport<any>(
      'context_menu_toggle',
      { id: normalizedId, registryKey: resolvedRegKey, enabled: nextState },
      hostOverride
    )
    if (!legacyRes.ok || legacyRes.data?.ok === false) {
      return {
        ok: false,
        enabled: !nextState,
        message:
          legacyRes.data?.error ||
          svcRes.error ||
          legacyRes.error ||
          `修改注册表右键菜单项 [${resolvedRegKey}] 失败（可能需要管理员权限）`
      }
    }
  }

  return {
    ok: true,
    enabled: nextState,
    message: `${nextState ? '已启用' : '已禁用'}右键菜单项: ${target?.title || normalizedId}`
  }
}

export async function cleanOrphanedContextMenuEntries(
  regPaths?: string[],
  hostOverride?: any
): Promise<{ ok: boolean; cleanedCount: number; message: string }> {
  const paths = Array.isArray(regPaths)
    ? regPaths.map((p) => String(p || '').trim()).filter(Boolean)
    : []

  for (const p of paths) {
    if (FORBIDDEN_TARGET_PATTERN.test(p)) {
      return { ok: false, cleanedCount: 0, message: FORBIDDEN_REASON }
    }
  }

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const svcRes = await invokePluginService<any>(
      DLL_PLUGIN_NAME,
      'cleanOrphans',
      { regPaths: paths },
      hostOverride
    )
    if (svcRes.ok && svcRes.data?.ok !== false) {
      const cleanedCount = Number(svcRes.data?.cleanedCount ?? paths.length)
      return {
        ok: true,
        cleanedCount,
        message: String(svcRes.data?.message || `已清理 ${cleanedCount} 项失效残留右键菜单扩展`)
      }
    }
    return {
      ok: false,
      cleanedCount: 0,
      message: svcRes.data?.error || svcRes.error || '清理孤立右键菜单注册表项失败（需要管理员权限）'
    }
  }

  return {
    ok: true,
    cleanedCount: paths.length,
    message: `已清理 ${paths.length} 项失效右键菜单项`
  }
}

export function filterContextMenuEntries(
  entries: ContextMenuEntry[],
  query: string,
  filterMode: ContextMenuFilterMode | string = 'all'
): ContextMenuEntry[] {
  if (!Array.isArray(entries)) return []
  let list = entries
  if (filterMode === 'file') {
    list = list.filter((e) => e.scope === 'file' || e.isWin11ClassicToggle)
  } else if (filterMode === 'directory') {
    list = list.filter((e) => e.scope === 'directory' || e.isWin11ClassicToggle)
  } else if (filterMode === 'background') {
    list = list.filter((e) => e.scope === 'background' || e.isWin11ClassicToggle)
  } else if (filterMode === 'disabled') {
    list = list.filter((e) => !e.enabled)
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return list
  return list.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.publisher.toLowerCase().includes(q) ||
      e.registryKey.toLowerCase().includes(q) ||
      e.command.toLowerCase().includes(q) ||
      e.scopeLabel.toLowerCase().includes(q)
  )
}
