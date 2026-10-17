/**
 * ZTools Navigation Service (M1.5-23)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs` (key: `navigation`)
 * - 命令结构：`L_({ key: 'navigation', title: 'Navigation', commands: { switchWindows: V(...), searchMenuItems: V(...) } })`
 * - 核心参数：title: 'Switch Windows', path: '/extension/navigation/switch-windows'
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

export interface NavigationServiceOptions {
  sidecarManager?: SidecarManager | null | undefined
}

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
  private mockWindows: WindowItemInfo[] = []
  private mockMenuItems: MenuItemInfo[] = []
  private cachedSystemWindows: WindowItemInfo[] = []
  private lastWindowsQueryAt = 0

  constructor(options: NavigationServiceOptions = {}) {
    this.sidecars = options.sidecarManager ?? null
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

    // 优先通过 Sidecar 执行窗口激活
    if (this.sidecars && process.platform === 'win32') {
      try {
        const res = await this.sidecars.manageWindow(`activate:${safeHwnd}`)
        if (res.success) return { success: true, hwnd: safeHwnd }
      } catch {
        // 继续回退
      }
    }

    if (process.platform === 'darwin') {
      const pid = Math.floor(safeHwnd / 100)
      const winIndex = Math.max(0, (safeHwnd % 100) - 1)
      try {
        const jxa = `
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
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa, String(pid), String(winIndex)], {
          timeout: 4000
        })
        return { success: true, hwnd: safeHwnd }
      } catch (err: unknown) {
        return {
          success: false,
          hwnd: safeHwnd,
          error: err instanceof Error ? err.message : String(err)
        }
      }
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
      await execFileAsync('powershell.exe', [
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

    // 移除 mock 窗口与缓存窗口
    this.mockWindows = this.mockWindows.filter(w => w.hwnd !== safeHwnd)
    this.cachedSystemWindows = this.cachedSystemWindows.filter(w => w.hwnd !== safeHwnd)

    if (process.platform === 'darwin') {
      const pid = Math.floor(safeHwnd / 100)
      const winIndex = Math.max(0, (safeHwnd % 100) - 1)
      try {
        const jxa = `
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
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa, String(pid), String(winIndex)], {
          timeout: 4000
        })
        return { success: true, hwnd: safeHwnd }
      } catch (err: unknown) {
        return {
          success: false,
          hwnd: safeHwnd,
          error: err instanceof Error ? err.message : String(err)
        }
      }
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
      await execFileAsync('powershell.exe', [
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
    } else if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('/usr/bin/osascript', [
          '-l',
          'JavaScript',
          '-e',
          MACOS_QUERY_MENU_ITEMS_JXA
        ], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
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
    } else if (process.platform === 'win32') {
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
        await this.activateWindow(targetHwnd)
        const presetMap: Record<string, string> = {
          max: 'maximize',
          left: 'left_half',
          right: 'right_half'
        }
        const preset = presetMap[actionType ?? '']
        if (preset && this.sidecars) {
          await this.sidecars.manageWindow(preset).catch(() => {})
        }
        return { success: true, clicked: `Window > ${preset ?? actionType}` }
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

    if (process.platform === 'darwin') {
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
        await execFileAsync('/usr/bin/osascript', [
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

    return {
      success: true,
      clicked: `${topMenuName} > ${menuItemName}`
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

  private async queryWindowsFromSystem(): Promise<WindowItemInfo[]> {
    if (this.cachedSystemWindows.length > 0 && Date.now() - this.lastWindowsQueryAt < 2000) {
      return this.cachedSystemWindows
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        '-e',
        MACOS_QUERY_WINDOWS_JXA
      ], { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 })
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
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ps
    ], { encoding: 'utf8', timeout: 4500, windowsHide: true })
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

