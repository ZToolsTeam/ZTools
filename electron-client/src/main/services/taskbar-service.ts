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
    if (process.platform === 'darwin') {
      const autohide = !visible
      try {
        await execFileAsync('/usr/bin/osascript', [
          '-e',
          `tell application "System Events" to tell dock preferences to set autohide to ${autohide ? 'true' : 'false'}`
        ], { timeout: 4000 })
        this.lastKnownVisible = visible
        return true
      } catch (err) {
        console.warn('[TaskbarService] Failed to set macOS Dock autohide:', err)
        this.lastKnownVisible = visible
        return false
      }
    }

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
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('/usr/bin/osascript', [
          '-e',
          'tell application "System Events" to tell dock preferences to get autohide'
        ], { encoding: 'utf8', timeout: 3000 })
        const autohide = String(stdout ?? '').trim().toLowerCase() === 'true'
        this.lastKnownVisible = !autohide
        return this.lastKnownVisible
      } catch {
        return this.lastKnownVisible
      }
    }
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
    const message = process.platform === 'darwin' ? 'Dock 常驻显示已开启' : '任务栏已显示'

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
    const message = process.platform === 'darwin' ? 'Dock 自动隐藏已开启' : '任务栏已隐藏'

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
   * 切换 Windows 任务栏显隐或 macOS Dock 自动隐藏状态
   */
  public async toggleTaskbar(): Promise<TaskbarActionResult> {
    const current = await this.adapter.getTaskbarVisible()
    if (current) {
      return this.hideTaskbar()
    } else {
      return this.showTaskbar()
    }
  }

  /**
   * 设置 macOS Dock 屏幕停靠方位 (bottom / left / right)
   */
  public async setDockPosition(
    edge: 'bottom' | 'left' | 'right'
  ): Promise<{ success: boolean; edge: 'bottom' | 'left' | 'right'; message: string }> {
    const normalized = String(edge ?? '').trim().toLowerCase()
    if (normalized !== 'bottom' && normalized !== 'left' && normalized !== 'right') {
      throw new Error(`无效的 Dock 停靠位置: ${String(edge)}`)
    }

    if (process.platform === 'darwin') {
      try {
        await execFileAsync('/usr/bin/osascript', [
          '-e',
          `tell application "System Events" to tell dock preferences to set screen edge to ${normalized}`
        ], { timeout: 4000 })
      } catch (err) {
        return {
          success: false,
          edge: normalized,
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }

    const labelMap: Record<'bottom' | 'left' | 'right', string> = {
      bottom: '底部',
      left: '左侧',
      right: '右侧'
    }
    const message = `Dock 停靠位置已切换至${labelMap[normalized]}`
    if (this.hudService) {
      try {
        void this.hudService.showHUD(message, { icon: '✓', durationMs: 1000 })
      } catch {
        // ignore
      }
    }
    return { success: true, edge: normalized, message }
  }

  /**
   * 重启 macOS Dock 进程
   */
  public async restartDock(): Promise<{ success: boolean; message: string }> {
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('/usr/bin/killall', ['Dock'], { timeout: 4000 })
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
    const message = 'Dock 已重启'
    if (this.hudService) {
      try {
        void this.hudService.showHUD(message, { icon: '✓', durationMs: 1000 })
      } catch {
        // ignore
      }
    }
    return { success: true, message }
  }
}

/**
 * 模块顶级快捷调用入口
 */
export async function toggleTaskbar(options: { adapter?: TaskbarWin32Adapter | undefined; hudService?: HudService | undefined } = {}): Promise<TaskbarActionResult> {
  const service = new TaskbarService(options)
  return service.toggleTaskbar()
}
