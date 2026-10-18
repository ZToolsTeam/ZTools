/**
 * 系统右键菜单扩展管理中枢 (ContextMenu 2.0 Logic)
 * 支持一键切换 Windows 11 经典完整右键菜单，以及管理文件/文件夹/桌面背景右键 Shell 扩展项
 */

import { callHostTransport, isRealElectronHost } from '../shared/native-ipc.js'

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
  const ipcRes = await callHostTransport(
    'dllplugin_call',
    { plugin: DLL_PLUGIN_NAME, func: method.trim(), params },
    hostBridge
  )
  if (ipcRes.ok && ipcRes.data) {
    return { ok: true, pluginName: DLL_PLUGIN_NAME, method: method.trim(), data: ipcRes.data, fromFallback: false }
  }
  return {
    ok: true,
    pluginName: DLL_PLUGIN_NAME,
    method: method.trim(),
    data: { simulated: true, method: method.trim(), params },
    fromFallback: true
  }
}

export async function fetchContextMenuEntries(hostOverride?: any): Promise<ContextMenuSnapshot> {
  const entries = DEFAULT_CONTEXT_MENU_ENTRIES.map((e) => ({ ...e }))

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const res = await callHostTransport<any>('context_menu_list', {}, hostOverride)
    if (res.ok && Array.isArray(res.data?.entries) && res.data.entries.length > 0) {
      const remoteEntries: ContextMenuEntry[] = res.data.entries
      const enabledCount = remoteEntries.filter((e) => e.enabled).length
      return {
        entries: remoteEntries,
        win11ClassicEnabled: Boolean(res.data.win11ClassicEnabled ?? true),
        enabledCount,
        disabledCount: remoteEntries.length - enabledCount
      }
    }
  }

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
    await callHostTransport('shell_exec', { command: cmd }, hostOverride)
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
  hostOverride?: any
): Promise<{ ok: boolean; enabled: boolean; message: string }> {
  const target = DEFAULT_CONTEXT_MENU_ENTRIES.find((e) => e.id === id)
  const nextState = typeof enabled === 'boolean' ? enabled : !(target?.enabled ?? true)

  if (target?.isWin11ClassicToggle) {
    const classicRes = await switchWin11ClassicMenu(nextState, hostOverride)
    return {
      ok: classicRes.ok,
      enabled: classicRes.classicMode,
      message: classicRes.message
    }
  }

  if (hostOverride || isRealElectronHost(hostOverride)) {
    await callHostTransport(
      'context_menu_toggle',
      { id, registryKey: target?.registryKey, enabled: nextState },
      hostOverride
    )
  }

  return {
    ok: true,
    enabled: nextState,
    message: `${nextState ? '已启用' : '已禁用'}右键菜单项: ${target?.title || id}`
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
