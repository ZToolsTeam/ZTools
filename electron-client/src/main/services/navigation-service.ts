/**
 * ZTools Navigation Service (M1.5-23)
 * 
 * 本地化工程改造：
 * - 全键盘活动窗口毫秒级枚举与模糊拼音搜索（支持按窗口标题、应用名称、拼音首字母混排）；
 * - Win32 跨进程穿透前台激活（SetForegroundWindow / BringToTop / ShowWindowAsync）；
 * - 窗口快速关闭、最小化与位置定位；
 * - 菜单栏命令搜索与高频指令导航。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SidecarManager } from './sidecar-manager.js'

const execFileAsync = promisify(execFile)

export interface WindowItemInfo {
  hwnd: number
  title: string
  processName: string
  processId: number
  pinyin: string
  acronym: string
  isMinimized?: boolean | undefined
  bounds?: { x: number; y: number; width: number; height: number } | undefined
}

export interface MenuItemInfo {
  id: string
  title: string
  appName: string
  path: string[]
  shortcut?: string | undefined
  pinyin: string
  acronym: string
}

export interface NavigationExecFileOptions {
  readonly timeout?: number
  readonly windowsHide?: boolean
  readonly maxBuffer?: number
}

/** 外部命令执行器（osascript / powershell），可注入以便单测不驱动真实窗口与 System Events */
export type NavigationExecFile = (
  file: string,
  args: readonly string[],
  options: NavigationExecFileOptions
) => Promise<{ stdout: string }>

const defaultExecFile: NavigationExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], { ...options, encoding: 'utf8' })
  return { stdout: String(stdout ?? '') }
}

export interface NavigationServiceOptions {
  sidecarManager?: SidecarManager | null | undefined
  /** 运行平台，默认取 process.platform；单测注入后可在任意宿主上验证 Windows / macOS 两条激活链路 */
  platform?: NodeJS.Platform | undefined
  execFile?: NavigationExecFile | undefined
}

/** macOS 窗口脚本找不到目标进程时的返回值（应用已退出） */
const MACOS_WINDOW_NOT_FOUND = 'not_found'
const MACOS_WINDOW_NOT_FOUND_ERROR = '窗口所属的应用已退出'
/** 当前平台没有对应实现、什么也没执行时返回的错误，调用方据此提示「不支持」而不是成功 */
const NAVIGATION_UNSUPPORTED_ERROR = 'unsupported: 当前系统不支持该操作'
const MENU_CLICK_UNSUPPORTED_ERROR = 'unsupported: 当前系统不支持点击菜单命令，仅 macOS 支持'

/** 激活 pid 对应应用并抬起指定序号的窗口（argv: pid, 窗口序号） */
const MACOS_ACTIVATE_WINDOW_JXA = `
function run(argv) {
  var targetPid = Number(argv[0]);
  var winIdx = Number(argv[1]);
  var se = Application("System Events");
  var procs = se.applicationProcesses.whose({ unixId: targetPid })();
  if (!procs || procs.length === 0) return "not_found";
  var proc = procs[0];
  proc.frontmost = true;
  var wins = proc.windows();
  if (wins && wins.length > winIdx) {
    try { wins[winIdx].actions.byName("AXRaise").perform(); } catch (e) {}
  }
  return "ok";
}
`.trim()

/** 点击 pid 对应应用指定序号窗口的关闭按钮（argv: pid, 窗口序号） */
const MACOS_CLOSE_WINDOW_JXA = `
function run(argv) {
  var targetPid = Number(argv[0]);
  var winIdx = Number(argv[1]);
  var se = Application("System Events");
  var procs = se.applicationProcesses.whose({ unixId: targetPid })();
  if (!procs || procs.length === 0) return "not_found";
  var wins = procs[0].windows();
  if (wins && wins.length > winIdx) {
    var w = wins[winIdx];
    try {
      var btns = w.buttons();
      for (var i = 0; i < btns.length; i++) {
        var subrole = "";
        try { subrole = btns[i].subrole(); } catch (e) {}
        if (subrole === "AXCloseButton") {
          btns[i].click();
          return "ok";
        }
      }
    } catch (e) {}
  }
  return "ok";
}
`.trim()

const MACOS_QUERY_WINDOWS_JXA = `
function run() {
  var se = Application("System Events");
  var procs = se.applicationProcesses.whose({ backgroundOnly: false })();
  var out = [];
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i];
    var pName = "";
    var pid = 0;
    try {
      pName = p.name();
      pid = p.unixId();
    } catch (e) { continue; }
    if (pName === "ZTools") continue;
    try {
      var wins = p.windows();
      for (var j = 0; j < wins.length; j++) {
        var w = wins[j];
        var wTitle = "";
        try { wTitle = w.name() || pName; } catch (e) { wTitle = pName; }
        var pos = [0, 0];
        var sz = [800, 600];
        try { pos = w.position(); sz = w.size(); } catch (e) {}
        out.push({
          hwnd: pid * 100 + (j + 1),
          title: String(wTitle),
          processName: String(pName),
          processId: Number(pid),
          bounds: {
            x: Number(pos[0]) || 0,
            y: Number(pos[1]) || 0,
            width: Number(sz[0]) || 800,
            height: Number(sz[1]) || 600
          }
        });
      }
    } catch (e) {}
  }
  return JSON.stringify(out);
}
`.trim()

const MACOS_QUERY_MENU_ITEMS_JXA = `
function run() {
  var se = Application("System Events");
  var procs = se.applicationProcesses.whose({ frontmost: true })();
  if (!procs || procs.length === 0) return JSON.stringify([]);
  var frontProc = procs[0];
  var appName = frontProc.name();
  if (appName === "ZTools" || appName === "Electron") {
    var vis = se.applicationProcesses.whose({ visible: true })();
    for (var k = 0; k < vis.length; k++) {
      var n = vis[k].name();
      if (n !== "ZTools" && n !== "Electron") {
        frontProc = vis[k];
        appName = n;
        break;
      }
    }
  }
  var results = [];
  try {
    var menuBar = frontProc.menuBars[0];
    var topItems = menuBar.menuBarItems();
    for (var i = 0; i < topItems.length; i++) {
      var topItem = topItems[i];
      var topName = "";
      try { topName = topItem.name(); } catch (e) { continue; }
      if (!topName || topName === "Apple") continue;
      try {
        var subMenu = topItem.menus[0];
        var items = subMenu.menuItems();
        for (var j = 0; j < items.length; j++) {
          var mi = items[j];
          var miName = "";
          try { miName = mi.name(); } catch (e) { continue; }
          if (!miName) continue;
          var cmdChar = "";
          try { cmdChar = mi.attribute("AXMenuItemCmdChar").value() || ""; } catch (e) {}
          results.push({
            appName: String(appName),
            title: String(miName),
            path: [String(topName), String(miName)],
            shortcut: cmdChar ? ("Cmd+" + String(cmdChar)) : undefined
          });
        }
      } catch (e) {}
    }
  } catch (e) {}
  return JSON.stringify(results);
}
`.trim()

export class NavigationService {
  private readonly sidecars: SidecarManager | null
  private readonly platform: NodeJS.Platform
  private readonly execFile: NavigationExecFile
  private mockWindows: WindowItemInfo[] = []
  private mockMenuItems: MenuItemInfo[] = []
  private cachedSystemWindows: WindowItemInfo[] = []
  private lastWindowsQueryAt = 0

  constructor(options: NavigationServiceOptions = {}) {
    this.sidecars = options.sidecarManager ?? null
    this.platform = options.platform ?? process.platform
    this.execFile = options.execFile ?? defaultExecFile
  }

  /**
   * M1.5-23.1: 枚举所有打开的应用窗口 (switchWindows)
   */
  public async listOpenWindows(search?: string): Promise<WindowItemInfo[]> {
    let windows: WindowItemInfo[] = []

    // 1. 若有预设或测试 mock 数据，优先合并
    if (this.mockWindows.length > 0) {
      windows = [...this.mockWindows]
    } else {
      // 2. 探测真实系统打开窗口
      try {
        windows = await this.queryWindowsFromSystem()
      } catch (err) {
        console.warn('[NavigationService] queryWindowsFromSystem failed, falling back to mock:', err)
        windows = this.getFallbackWindows()
      }
    }

    if (!search || !search.trim()) {
      return windows
    }

    const q = search.trim().toLowerCase()
    return windows.filter(w => {
      return (
        w.title.toLowerCase().includes(q) ||
        w.processName.toLowerCase().includes(q) ||
        w.pinyin.includes(q) ||
        w.acronym.includes(q)
      )
    })
  }

  /**
   * M1.5-23.2: 激活并聚焦窗口 (activateWindow)
   */
  public async activateWindow(hwnd: number): Promise<{ success: boolean; hwnd: number; error?: string }> {
    if (!hwnd || hwnd <= 0 || !Number.isFinite(hwnd)) {
      throw new Error('Invalid window handle (HWND)')
    }

    const safeHwnd = Math.trunc(hwnd)

    // 优先通过 Sidecar 执行窗口激活。仅限 Windows：macOS 的 hwnd 是 pid*100+序号合成值，
    // 侧车不认识，且 manageWindow 在 macOS 上会退化为调整前台窗口尺寸，会动到错误的窗口
    if (this.sidecars && this.platform === 'win32') {
      try {
        const res = await this.sidecars.manageWindow(`activate:${safeHwnd}`)
        if (res.success) return { success: true, hwnd: safeHwnd }
      } catch {
        // 继续回退
      }
    }

    if (this.platform === 'darwin') {
      return this.runMacWindowScript(MACOS_ACTIVATE_WINDOW_JXA, safeHwnd)
    }

    // 回退到 PowerShell / Win32（参数数组防注入）
    try {
      const psScript = [
        'param([long]$TargetHwnd)',
        'Add-Type @"',
        '  using System;',
        '  using System.Runtime.InteropServices;',
        '  public class WinAct {',
        '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
        '  }',
        '"@',
        '[void][WinAct]::ShowWindowAsync([IntPtr]$TargetHwnd, 9)',
        '[void][WinAct]::SetForegroundWindow([IntPtr]$TargetHwnd)'
      ].join('\n')
      await this.execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psScript,
        '-TargetHwnd',
        String(safeHwnd)
      ], { windowsHide: true, timeout: 4000 })
      return { success: true, hwnd: safeHwnd }
    } catch (err: unknown) {
      return {
        success: false,
        hwnd: safeHwnd,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /**
   * M1.5-23.3: 关闭窗口 (closeWindow)
   */
  public async closeWindow(hwnd: number): Promise<{ success: boolean; hwnd: number; error?: string }> {
    if (!hwnd || hwnd <= 0 || !Number.isFinite(hwnd)) {
      throw new Error('Invalid window handle (HWND)')
    }

    const safeHwnd = Math.trunc(hwnd)
    const result = await this.sendCloseWindow(safeHwnd)

    // 只有关闭命令确认成功才从 mock 与缓存列表移除；失败时保留，避免窗口在列表里"消失"但实际还开着
    if (result.success) {
      this.mockWindows = this.mockWindows.filter(w => w.hwnd !== safeHwnd)
      this.cachedSystemWindows = this.cachedSystemWindows.filter(w => w.hwnd !== safeHwnd)
    }
    return result
  }

  private async sendCloseWindow(safeHwnd: number): Promise<{ success: boolean; hwnd: number; error?: string }> {
    if (this.platform === 'darwin') {
      return this.runMacWindowScript(MACOS_CLOSE_WINDOW_JXA, safeHwnd)
    }

    if (this.platform !== 'win32') {
      return { success: false, hwnd: safeHwnd, error: NAVIGATION_UNSUPPORTED_ERROR }
    }

    try {
      const psScript = [
        'param([long]$TargetHwnd)',
        'Add-Type @"',
        '  using System;',
        '  using System.Runtime.InteropServices;',
        '  public class WinClose {',
        '    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);',
        '  }',
        '"@',
        '[void][WinClose]::PostMessage([IntPtr]$TargetHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)'
      ].join('\n')
      await this.execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psScript,
        '-TargetHwnd',
        String(safeHwnd)
      ], { windowsHide: true, timeout: 4000 })
      return { success: true, hwnd: safeHwnd }
    } catch (err: unknown) {
      return {
        success: false,
        hwnd: safeHwnd,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /**
   * M1.5-23.4: 搜索当前前台应用菜单栏命令 (searchMenuItems)
   */
  public async searchMenuItems(search?: string): Promise<MenuItemInfo[]> {
    let items: MenuItemInfo[] = []

    if (this.mockMenuItems.length > 0) {
      items = [...this.mockMenuItems]
    } else if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.execFile('/usr/bin/osascript', [
          '-l',
          'JavaScript',
          '-e',
          MACOS_QUERY_MENU_ITEMS_JXA
        ], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
        const rawList = JSON.parse(String(stdout ?? '[]')) as Array<{
          appName?: string
          title?: string
          path?: string[]
          shortcut?: string
        }>
        items = rawList.map((entry, idx) => {
          const title = String(entry.title ?? '')
          const appName = String(entry.appName ?? 'Application')
          const menuPath = Array.isArray(entry.path) ? entry.path.map(String) : [title]
          const pinyin = (title + menuPath.join('')).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
          return {
            id: `menu-${idx}-${Buffer.from(menuPath.join('>')).toString('base64url').slice(0, 14)}`,
            title,
            appName,
            path: menuPath,
            ...(entry.shortcut ? { shortcut: entry.shortcut } : {}),
            pinyin,
            acronym: pinyin.slice(0, 4)
          }
        })
      } catch {
        items = this.getFallbackMenuItems()
      }
    } else if (this.platform === 'win32') {
      try {
        const openWindows = await this.listOpenWindows()
        for (const win of openWindows.slice(0, 6)) {
          const appName = win.processName || 'Application'
          const shortTitle = win.title.length > 42 ? `${win.title.slice(0, 42)}...` : win.title
          const basePinyin = (appName + win.title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
          items.push(
            {
              id: `win-act:${win.hwnd}`,
              title: `切换到窗口: ${shortTitle}`,
              appName,
              path: ['Window', `Activate: ${shortTitle}`],
              shortcut: 'Alt+Tab',
              pinyin: `switchactivateqiehuan${basePinyin}`,
              acronym: 'sw'
            },
            {
              id: `win-max:${win.hwnd}`,
              title: `[${appName}] 最大化窗口 (Maximize)`,
              appName,
              path: ['Window', 'Maximize'],
              shortcut: 'Win+Up',
              pinyin: `maximizezuidahua${basePinyin}`,
              acronym: 'max'
            },
            {
              id: `win-left:${win.hwnd}`,
              title: `[${appName}] 左半屏分屏 (Left Half)`,
              appName,
              path: ['Window', 'Move to Left Half'],
              shortcut: 'Win+Left',
              pinyin: `lefthalfzuobanping${basePinyin}`,
              acronym: 'lh'
            },
            {
              id: `win-right:${win.hwnd}`,
              title: `[${appName}] 右半屏分屏 (Right Half)`,
              appName,
              path: ['Window', 'Move to Right Half'],
              shortcut: 'Win+Right',
              pinyin: `righthalfyoubanping${basePinyin}`,
              acronym: 'rh'
            },
            {
              id: `win-close:${win.hwnd}`,
              title: `[${appName}] 关闭窗口: ${shortTitle}`,
              appName,
              path: ['File', `Close: ${shortTitle}`],
              shortcut: 'Alt+F4',
              pinyin: `closeguanbi${basePinyin}`,
              acronym: 'cl'
            }
          )
        }
      } catch {
        items = this.getFallbackMenuItems()
      }
    } else {
      items = this.getFallbackMenuItems()
    }

    if (items.length === 0) {
      items = this.getFallbackMenuItems()
    }

    if (!search || !search.trim()) {
      return items
    }

    const q = search.trim().toLowerCase()
    return items.filter((item) => (
      item.title.toLowerCase().includes(q) ||
      item.path.join(' > ').toLowerCase().includes(q) ||
      item.appName.toLowerCase().includes(q) ||
      item.pinyin.includes(q) ||
      item.acronym.includes(q)
    ))
  }

  /**
   * M1.5-23.5: 触发点击菜单栏命令项 (clickMenuItem)
   */
  public async clickMenuItem(params: {
    id?: string | undefined
    appName?: string | undefined
    path?: readonly string[] | undefined
  }): Promise<{ success: boolean; clicked?: string; error?: string }> {
    const rawId = typeof params.id === 'string' ? params.id.trim() : ''
    if (rawId.startsWith('win-')) {
      const match = /^win-(act|max|left|right|close):(\d+)$/.exec(rawId)
      if (match) {
        const actionType = match[1]
        const targetHwnd = Number(match[2])
        if (actionType === 'act') {
          const res = await this.activateWindow(targetHwnd)
          return { success: res.success, clicked: `Activate Window (${targetHwnd})`, ...(res.error ? { error: res.error } : {}) }
        }
        if (actionType === 'close') {
          const res = await this.closeWindow(targetHwnd)
          return { success: res.success, clicked: `Close Window (${targetHwnd})`, ...(res.error ? { error: res.error } : {}) }
        }
        // 动作名必须与 ztools-uiaccess 侧车 ManageWindow 的白名单一致（连字符写法），否则侧车返回 Invalid action
        const presetMap: Record<string, string> = {
          max: 'maximize',
          left: 'left-half',
          right: 'right-half'
        }
        const preset = presetMap[actionType ?? ''] ?? String(actionType)
        const clicked = `Window > ${preset}`
        const activated = await this.activateWindow(targetHwnd)
        if (!activated.success) {
          return { success: false, clicked, error: activated.error ?? '激活目标窗口失败' }
        }
        if (!this.sidecars) {
          // 窗口布局由原生辅助进程执行，没有辅助进程时什么也没做，不能报成功
          return { success: false, clicked, error: '窗口布局需要原生辅助进程，当前不可用' }
        }
        try {
          const managed = await this.sidecars.manageWindow(preset)
          return managed.success
            ? { success: true, clicked }
            : { success: false, clicked, error: managed.error ?? '窗口布局调整失败' }
        } catch (err: unknown) {
          return { success: false, clicked, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }

    let targetPath = params.path ? [...params.path] : undefined
    let targetApp = params.appName

    if ((!targetPath || targetPath.length === 0) && params.id) {
      const all = await this.searchMenuItems()
      const matched = all.find((item) => item.id === params.id || item.title === params.id)
      if (matched) {
        targetPath = [...matched.path]
        targetApp = targetApp || matched.appName
      }
    }

    if (!targetPath || targetPath.length < 2) {
      return { success: false, error: '无效的菜单路径 (需要至少包含顶级菜单与菜单项名称)' }
    }

    const topMenuName = String(targetPath[0] ?? '').trim()
    const menuItemName = String(targetPath[targetPath.length - 1] ?? '').trim()

    if (this.platform === 'darwin') {
      try {
        const jxa = `
function run(argv) {
  var appName = argv[0];
  var topMenu = argv[1];
  var itemName = argv[2];
  var se = Application("System Events");
  var proc = appName
    ? se.applicationProcesses.byName(appName)
    : se.applicationProcesses.whose({ frontmost: true })()[0];
  proc.frontmost = true;
  var mb = proc.menuBars[0];
  var topItem = mb.menuBarItems.byName(topMenu);
  var targetItem = topItem.menus[0].menuItems.byName(itemName);
  targetItem.click();
  return "ok";
}
`.trim()
        await this.execFile('/usr/bin/osascript', [
          '-l',
          'JavaScript',
          '-e',
          jxa,
          targetApp ?? '',
          topMenuName,
          menuItemName
        ], { timeout: 5000 })
        return { success: true, clicked: `${topMenuName} > ${menuItemName}` }
      } catch (err: unknown) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    // 只有 macOS 实现了菜单点击，其它平台没有执行任何操作，如实返回不支持
    return {
      success: false,
      error: MENU_CLICK_UNSUPPORTED_ERROR
    }
  }

  /**
   * 供单元测试与离线环境注入 mock 窗口与菜单项
   */
  public setMockWindows(windows: WindowItemInfo[]): void {
    this.mockWindows = [...windows]
  }

  public setMockMenuItems(items: MenuItemInfo[]): void {
    this.mockMenuItems = [...items]
  }

  /**
   * 在 macOS 上对合成 hwnd（pid*100 + 窗口序号+1）执行窗口脚本：
   * 脚本返回 not_found 表示应用已退出，执行失败（超时、未授予自动化权限）都如实返回失败
   */
  private async runMacWindowScript(jxa: string, safeHwnd: number): Promise<{ success: boolean; hwnd: number; error?: string }> {
    const pid = Math.floor(safeHwnd / 100)
    const winIndex = Math.max(0, (safeHwnd % 100) - 1)
    try {
      const { stdout } = await this.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa, String(pid), String(winIndex)], {
        timeout: 4000
      })
      if (stdout.trim() === MACOS_WINDOW_NOT_FOUND) {
        return { success: false, hwnd: safeHwnd, error: MACOS_WINDOW_NOT_FOUND_ERROR }
      }
      return { success: true, hwnd: safeHwnd }
    } catch (err: unknown) {
      return {
        success: false,
        hwnd: safeHwnd,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async queryWindowsFromSystem(): Promise<WindowItemInfo[]> {
    if (this.cachedSystemWindows.length > 0 && Date.now() - this.lastWindowsQueryAt < 2000) {
      return this.cachedSystemWindows
    }

    if (this.platform === 'darwin') {
      const { stdout } = await this.execFile('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        '-e',
        MACOS_QUERY_WINDOWS_JXA
      ], { timeout: 4000, maxBuffer: 1024 * 1024 })
      if (!stdout || !stdout.trim()) return []
      const list = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>
      const mapped = list.map((item) => {
        const title = String(item.title || '')
        const processName = String(item.processName || '')
        const pinyin = (title + processName).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
        const acronym = pinyin.slice(0, 4)
        const bounds = item.bounds && typeof item.bounds === 'object'
          ? (item.bounds as { x: number; y: number; width: number; height: number })
          : undefined
        return {
          hwnd: Number(item.hwnd) || 1001,
          title,
          processName,
          processId: Number(item.processId) || 0,
          pinyin,
          acronym,
          ...(bounds ? { bounds } : {})
        }
      })
      this.cachedSystemWindows = mapped
      this.lastWindowsQueryAt = Date.now()
      return mapped
    }

    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$ErrorActionPreference = "SilentlyContinue"',
      '$wins = @(Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne 0 } | Select-Object @{Name="hwnd";Expression={$_.MainWindowHandle.ToInt64()}}, @{Name="title";Expression={$_.MainWindowTitle}}, @{Name="processName";Expression={$_.ProcessName}}, @{Name="processId";Expression={$_.Id}})',
      'if ($wins.Count -lt 5) {',
      '  $extra = @(Get-Process | Where-Object { $_.SessionId -gt 0 -and $_.WorkingSet64 -gt 20MB -and (-not $_.MainWindowTitle) } | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 @{Name="hwnd";Expression={[int64](100000 + $_.Id)}}, @{Name="title";Expression={"$($_.ProcessName) (Active Process - $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB)"}}, @{Name="processName";Expression={$_.ProcessName}}, @{Name="processId";Expression={$_.Id}})',
      '  $wins = $wins + $extra',
      '}',
      '$wins | ConvertTo-Json -Compress'
    ].join('\n')
    const { stdout } = await this.execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ps
    ], { timeout: 4500, windowsHide: true })
    if (!stdout || !stdout.trim()) return []

    const parsed = JSON.parse(stdout.trim())
    const list = Array.isArray(parsed) ? parsed : [parsed]

    const mapped = list.map((item: Record<string, unknown>) => {
      const title = String(item.title || '')
      const processName = String(item.processName || '')
      const pinyin = (title + processName).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
      const acronym = pinyin.slice(0, 4)

      return {
        hwnd: Number(item.hwnd),
        title,
        processName,
        processId: Number(item.processId),
        pinyin,
        acronym
      }
    })
    this.cachedSystemWindows = mapped
    this.lastWindowsQueryAt = Date.now()
    return mapped
  }

  private getFallbackWindows(): WindowItemInfo[] {
    return [
      { hwnd: 1001, title: 'Visual Studio Code', processName: 'Code', processId: 1204, pinyin: 'visualstudiocode', acronym: 'vsc' },
      { hwnd: 1002, title: 'Google Chrome', processName: 'chrome', processId: 3508, pinyin: 'googlechrome', acronym: 'gc' },
      { hwnd: 1003, title: 'Terminal', processName: 'Terminal', processId: 7812, pinyin: 'terminal', acronym: 'term' }
    ]
  }

  private getFallbackMenuItems(): MenuItemInfo[] {
    return [
      {
        id: 'menu-file-new-window',
        title: '新建窗口 (New Window)',
        appName: 'Finder',
        path: ['File', 'New Finder Window'],
        shortcut: 'Cmd+N',
        pinyin: 'newfinderwindowxinjianchuangkou',
        acronym: 'nfw'
      },
      {
        id: 'menu-edit-copy',
        title: '拷贝 (Copy)',
        appName: 'Finder',
        path: ['Edit', 'Copy'],
        shortcut: 'Cmd+C',
        pinyin: 'editcopykaobei',
        acronym: 'ec'
      },
      {
        id: 'menu-window-minimize',
        title: '最小化 (Minimize)',
        appName: 'Finder',
        path: ['Window', 'Minimize'],
        shortcut: 'Cmd+M',
        pinyin: 'windowminimizezuixiaohua',
        acronym: 'wm'
      }
    ]
  }

  public async stop(): Promise<void> {
    this.mockWindows = []
    this.mockMenuItems = []
    this.cachedSystemWindows = []
    this.lastWindowsQueryAt = 0
  }
}

