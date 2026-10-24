/**
 * ZTools Windows Taskbar Control Service (M1.5-13)
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

/** 执行器设置结果：失败时 error 带上真实原因（如 osascript 的权限错误、超时） */
export interface TaskbarSetVisibleResult {
  readonly success: boolean
  readonly error?: string | undefined
}

export interface TaskbarWin32Adapter {
  /** 返回 boolean 或带失败原因的结果对象（自定义执行器可只返回 boolean） */
  setTaskbarVisible(visible: boolean): Promise<boolean | TaskbarSetVisibleResult>
  getTaskbarVisible(): Promise<boolean>
}

/**
 * macOS 自动化权限被拒的典型报错：osascript 返回 -1743（errAEEventNotPermitted）
 * 或 "Not authorized to send Apple events"。只有这类错误才提示去系统设置授权，其它失败（超时等）给通用提示
 */
export function isMacAutomationPermissionError(error: string | undefined): boolean {
  if (!error) return false
  return /not authori[sz]ed to send apple events|-1743\b|errAEEventNotPermitted/i.test(error)
}

const MAC_AUTOMATION_PERMISSION_HINT = '请在「系统设置 > 隐私与安全性 > 自动化」中允许 ZTools 控制 System Events'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface TaskbarExecFileOptions {
  readonly timeout?: number
  readonly windowsHide?: boolean
}

/** 外部命令执行器（osascript / powershell / killall），可注入以便单测不触碰真实 Dock 与任务栏 */
export type TaskbarExecFile = (
  file: string,
  args: readonly string[],
  options: TaskbarExecFileOptions
) => Promise<{ stdout: string }>

const defaultExecFile: TaskbarExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], { ...options, encoding: 'utf8' })
  return { stdout: String(stdout ?? '') }
}

export interface TaskbarServiceOptions {
  readonly adapter?: TaskbarWin32Adapter | undefined
  readonly hudService?: HudService | undefined
  /** 运行平台，默认取 process.platform；单测注入后可在任意宿主上验证 Windows / macOS 两套行为 */
  readonly platform?: NodeJS.Platform | undefined
  readonly execFile?: TaskbarExecFile | undefined
}

/**
 * 生产环境原生执行器：Windows 通过 PowerShell P/Invoke user32.dll ShowWindow/FindWindow，
 * macOS 通过 System Events 切换 Dock 自动隐藏
 */
export class DefaultTaskbarWin32Adapter implements TaskbarWin32Adapter {
  private lastKnownVisible = true
  private readonly platform: NodeJS.Platform
  private readonly execFile: TaskbarExecFile

  constructor(options: { platform?: NodeJS.Platform | undefined; execFile?: TaskbarExecFile | undefined } = {}) {
    this.platform = options.platform ?? process.platform
    this.execFile = options.execFile ?? defaultExecFile
  }

  async setTaskbarVisible(visible: boolean): Promise<TaskbarSetVisibleResult> {
    if (this.platform === 'darwin') {
      const autohide = !visible
      try {
        await this.execFile('/usr/bin/osascript', [
          '-e',
          `tell application "System Events" to tell dock preferences to set autohide to ${autohide ? 'true' : 'false'}`
        ], { timeout: 4000 })
        this.lastKnownVisible = visible
        return { success: true }
      } catch (err) {
        // 常见原因：用户未在「自动化」中允许 ZTools 控制 System Events；失败时保留原缓存状态，避免下次切换方向反转
        console.warn('[TaskbarService] Failed to set macOS Dock autohide:', err)
        return { success: false, error: errorText(err) }
      }
    }

    if (this.platform !== 'win32') {
      // 仅支持 Windows 与 macOS，其它平台没有执行任何操作，如实返回失败
      return { success: false, error: 'unsupported: 当前系统不支持任务栏显隐切换' }
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
      await this.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        timeout: 5000
      })
      this.lastKnownVisible = visible
      return { success: true }
    } catch (err) {
      // Windows 下 getTaskbarVisible 只读缓存，失败时不能改写缓存，否则下次切换方向会反
      console.warn('[TaskbarService] Failed to set taskbar visibility via Win32:', err)
      return { success: false, error: errorText(err) }
    }
  }

  async getTaskbarVisible(): Promise<boolean> {
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.execFile('/usr/bin/osascript', [
          '-e',
          'tell application "System Events" to tell dock preferences to get autohide'
        ], { timeout: 3000 })
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
  private readonly platform: NodeJS.Platform
  private readonly execFile: TaskbarExecFile
  private isVisible = true

  constructor(options: TaskbarServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.execFile = options.execFile ?? defaultExecFile
    this.adapter = options.adapter || new DefaultTaskbarWin32Adapter({ platform: this.platform, execFile: this.execFile })
    this.hudService = options.hudService
  }

  public getCachedVisible(): boolean {
    return this.isVisible
  }

  public async isTaskbarVisible(): Promise<boolean> {
    return this.adapter.getTaskbarVisible()
  }

  public async showTaskbar(): Promise<TaskbarActionResult> {
    return this.setVisible(true)
  }

  public async hideTaskbar(): Promise<TaskbarActionResult> {
    return this.setVisible(false)
  }

  /**
   * 显隐切换的统一入口：只有执行器确认成功才更新缓存状态并提示成功，
   * 失败（返回 false 或抛错）时保留原状态，返回 success:false 并提示失败原因
   */
  private async setVisible(visible: boolean): Promise<TaskbarActionResult> {
    let ok = false
    let error: string | undefined
    try {
      const res = await this.adapter.setTaskbarVisible(visible)
      if (typeof res === 'boolean') {
        ok = res
      } else {
        ok = res?.success === true
        error = res?.error
      }
    } catch (err) {
      error = errorText(err)
    }

    if (!ok) {
      const message = this.failureMessage(error)
      // 失败提示文字可能较长（含权限设置路径），停留时间加长
      this.notify(message, 'error', 3000)
      return { success: false, visible: await this.readActualVisible(), message, error: error ?? message }
    }

    this.isVisible = visible
    const message = this.platform === 'darwin'
      ? (visible ? 'Dock 常驻显示已开启' : 'Dock 自动隐藏已开启')
      : (visible ? '任务栏已显示' : '任务栏已隐藏')
    this.notify(message, visible ? 'window-maximize' : 'window-minus')
    return { success: true, visible, message }
  }

  /** 失败时以执行器读到的真实状态为准；读取也失败时退回本服务缓存 */
  private async readActualVisible(): Promise<boolean> {
    try {
      const actual = await this.adapter.getTaskbarVisible()
      if (typeof actual === 'boolean') return actual
    } catch {
      // 读取失败时使用缓存
    }
    return this.isVisible
  }

  private failureMessage(error: string | undefined): string {
    if (this.platform === 'darwin') {
      return isMacAutomationPermissionError(error) ? `Dock 设置失败，${MAC_AUTOMATION_PERMISSION_HINT}` : 'Dock 设置失败'
    }
    if (this.platform === 'win32') {
      return '任务栏切换失败'
    }
    return '当前系统不支持任务栏显隐切换'
  }

  private notify(message: string, icon: string, durationMs = 1000): void {
    if (!this.hudService) return
    try {
      void this.hudService.showHUD(message, { icon, durationMs })
    } catch {
      // HUD 只是辅助提示，展示失败不影响操作结果
    }
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
  ): Promise<{ success: boolean; edge: 'bottom' | 'left' | 'right'; message: string; error?: string }> {
    const normalized = String(edge ?? '').trim().toLowerCase()
    if (normalized !== 'bottom' && normalized !== 'left' && normalized !== 'right') {
      throw new Error(`无效的 Dock 停靠位置: ${String(edge)}`)
    }

    if (this.platform !== 'darwin') {
      // Dock 只存在于 macOS，其它平台没有执行任何操作，不能报成功
      const message = '当前系统没有 Dock，仅 macOS 支持设置停靠位置'
      return { success: false, edge: normalized, message, error: message }
    }

    try {
      await this.execFile('/usr/bin/osascript', [
        '-e',
        `tell application "System Events" to tell dock preferences to set screen edge to ${normalized}`
      ], { timeout: 4000 })
    } catch (err) {
      const error = errorText(err)
      return { success: false, edge: normalized, message: this.dockCommandFailureMessage(error), error }
    }

    const labelMap: Record<'bottom' | 'left' | 'right', string> = {
      bottom: '底部',
      left: '左侧',
      right: '右侧'
    }
    const message = `Dock 停靠位置已切换至${labelMap[normalized]}`
    this.notify(message, '✓')
    return { success: true, edge: normalized, message }
  }

  /** Dock 命令失败的提示：权限错误给授权路径，其它错误直接给出原因 */
  private dockCommandFailureMessage(error: string): string {
    return isMacAutomationPermissionError(error) ? `Dock 设置失败，${MAC_AUTOMATION_PERMISSION_HINT}` : error
  }

  /**
   * 重启 macOS Dock 进程
   */
  public async restartDock(): Promise<{ success: boolean; message: string; error?: string }> {
    if (this.platform !== 'darwin') {
      // Dock 只存在于 macOS，其它平台没有执行任何操作，不能报成功
      const message = '当前系统没有 Dock，仅 macOS 支持重启 Dock'
      return { success: false, message, error: message }
    }
    try {
      await this.execFile('/usr/bin/killall', ['Dock'], { timeout: 4000 })
    } catch (err) {
      const error = errorText(err)
      return { success: false, message: error, error }
    }
    const message = 'Dock 已重启'
    this.notify(message, '✓')
    return { success: true, message }
  }
}

/**
 * 模块顶级快捷调用入口
 */
export async function toggleTaskbar(options: TaskbarServiceOptions = {}): Promise<TaskbarActionResult> {
  const service = new TaskbarService(options)
  return service.toggleTaskbar()
}
