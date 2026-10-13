/**
 * ZTools Windows Taskbar Control Service (M1.5-13)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs` (key: `windows-taskbar`)
 * - 命令结构：`L_({ key: 'windows-taskbar', title: 'Taskbar', commands: { toggleTaskbar: V(...) } })`
 * - 后端处理：`"toggle-taskbar": async () => { ... return { hud: { variant: 'success', title: e ? 'Taskbar Window Shown' : 'Taskbar Window Hidden' } } }`
 * 
 * 本地化工程改造：
 * - 纯 Win32 原生动作 `toggleTaskbar`：通过 FindWindow("Shell_TrayWnd") 与 ShowWindow 实现对系统任务栏的即时显隐切换；
 * - 兼顾主屏幕与副屏幕（Shell_SecondaryTrayWnd）的多显示器协同穿透；
 * - 集成 HUD 浮窗毫秒级即时反馈（"任务栏已显示" / "任务栏已隐藏"）；
 * - 完善的跨平台沙箱兼容与单测 Mock 接口。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HudService } from './hud-service.js'

const execFileAsync = promisify(execFile)

export interface TaskbarActionResult {
  readonly success: boolean
  readonly visible: boolean
  readonly message: string
  readonly error?: string
}

export interface TaskbarWin32Adapter {
  setTaskbarVisible(visible: boolean): Promise<boolean>
  getTaskbarVisible(): Promise<boolean>
}

/**
 * 生产环境 Win32 原生执行器：通过 PowerShell P/Invoke user32.dll ShowWindow/FindWindow
 */
export class DefaultTaskbarWin32Adapter implements TaskbarWin32Adapter {
  private lastKnownVisible = true

  async setTaskbarVisible(visible: boolean): Promise<boolean> {
    if (process.platform !== 'win32') {
      this.lastKnownVisible = visible
      return true
    }

    const nCmdShow = visible ? 5 : 0 // SW_SHOW = 5, SW_HIDE = 0
    const psScript = [
      '$def = @"',
      '[DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int s);',
      '"@',
      '$t = Add-Type -MemberDefinition $def -Name "NativeTray" -Namespace "ZToolsWin32" -PassThru',
      '$mainTray = $t::FindWindow("Shell_TrayWnd", $null)',
      `if ($mainTray -ne [IntPtr]::Zero) { [void]$t::ShowWindow($mainTray, ${nCmdShow}) }`,
      '$secTray = $t::FindWindow("Shell_SecondaryTrayWnd", $null)',
      `if ($secTray -ne [IntPtr]::Zero) { [void]$t::ShowWindow($secTray, ${nCmdShow}) }`
    ].join('\r\n')

    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        timeout: 5000
      })
      this.lastKnownVisible = visible
      return true
    } catch (err) {
      console.warn('[TaskbarService] Failed to set taskbar visibility via Win32:', err)
      this.lastKnownVisible = visible
      return false
    }
  }

  async getTaskbarVisible(): Promise<boolean> {
    return this.lastKnownVisible
  }
}

export class TaskbarService {
  private readonly adapter: TaskbarWin32Adapter
  private readonly hudService: HudService | undefined
  private isVisible = true

  constructor(options: { adapter?: TaskbarWin32Adapter | undefined; hudService?: HudService | undefined } = {}) {
    this.adapter = options.adapter || new DefaultTaskbarWin32Adapter()
    this.hudService = options.hudService
  }

  public getCachedVisible(): boolean {
    return this.isVisible
  }

  public async isTaskbarVisible(): Promise<boolean> {
    return this.adapter.getTaskbarVisible()
  }

  public async showTaskbar(): Promise<TaskbarActionResult> {
    const success = await this.adapter.setTaskbarVisible(true)
    this.isVisible = true
    const message = '任务栏已显示'

    if (this.hudService) {
      try {
        void this.hudService.showHUD(message, { icon: 'window-maximize', durationMs: 1000 })
      } catch {
        // ignore
      }
    }

    return { success, visible: true, message }
  }

  public async hideTaskbar(): Promise<TaskbarActionResult> {
    const success = await this.adapter.setTaskbarVisible(false)
    this.isVisible = false
    const message = '任务栏已隐藏'

    if (this.hudService) {
      try {
        void this.hudService.showHUD(message, { icon: 'window-minus', durationMs: 1000 })
      } catch {
        // ignore
      }
    }

    return { success, visible: false, message }
  }

  /**
   * 纯 Win32 原生动作 toggleTaskbar (对齐 Raycast toggle-taskbar)
   */
  public async toggleTaskbar(): Promise<TaskbarActionResult> {
    const current = await this.adapter.getTaskbarVisible()
    if (current) {
      return this.hideTaskbar()
    } else {
      return this.showTaskbar()
    }
  }
}

/**
 * 模块顶级快捷调用入口
 */
export async function toggleTaskbar(options: { adapter?: TaskbarWin32Adapter | undefined; hudService?: HudService | undefined } = {}): Promise<TaskbarActionResult> {
  const service = new TaskbarService(options)
  return service.toggleTaskbar()
}
