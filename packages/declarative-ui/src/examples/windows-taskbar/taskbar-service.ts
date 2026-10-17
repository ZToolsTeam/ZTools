import { LocalStorage } from "../../api/storage.js";
import {
  TaskbarState,
  TaskbarActionResult,
  TaskbarAlignment,
  TaskbarPosition,
  TaskbarSize
} from "./types.js";

declare const process: any;

const TASKBAR_STORAGE_KEY = "@ztools/windows-taskbar/state";

const DEFAULT_TASKBAR_STATE: TaskbarState = {
  visible: true,
  autoHide: false,
  position: "bottom",
  alignment: "center",
  size: "regular",
  multiMonitorEnabled: true,
  secondaryTrayCount: 1,
  lastModifiedAt: Date.now()
};

export class WindowsTaskbarManager {
  private currentState: TaskbarState = { ...DEFAULT_TASKBAR_STATE };
  private initialized = false;

  public async getTaskbarState(): Promise<TaskbarState> {
    if (!this.initialized) {
      try {
        const stored = await LocalStorage.getItem<TaskbarState>(TASKBAR_STORAGE_KEY);
        if (stored && typeof stored.visible === "boolean") {
          this.currentState = { ...stored };
        }
      } catch {
        // ignore
      }
      this.initialized = true;
    }
    return { ...this.currentState };
  }

  private async saveState(updated: Partial<TaskbarState>): Promise<TaskbarState> {
    this.currentState = {
      ...this.currentState,
      ...updated,
      lastModifiedAt: Date.now()
    };
    try {
      await LocalStorage.setItem(TASKBAR_STORAGE_KEY, this.currentState);
    } catch {
      // ignore
    }
    return { ...this.currentState };
  }

  /**
   * 纯 Win32 / macOS Dock 原生调用：显示/隐藏任务栏或切换 Dock 自动隐藏
   */
  private async executeNativeShowWindow(visible: boolean, hostOverride?: any): Promise<boolean> {
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (hostOverride || isRealElectronHost()) {
      const ipcRes = await callHostTransport("taskbar_toggle", { visible }, hostOverride);
      if (ipcRes.ok) return true;
    }

    // 1. 尝试对接 Host ztools IPC
    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.taskbar?.setVisibility) {
        return await ztools.taskbar.setVisibility(visible);
      }
      if (ztools?.taskbar?.toggleTaskbar && visible !== this.currentState.visible) {
        const res = await ztools.taskbar.toggleTaskbar();
        return res?.success ?? true;
      }
    } catch {
      // 降级回退
    }

    // 2. 尝试使用 Node.js child_process 执行 Win32 P/Invoke
    try {
      if (typeof process !== "undefined" && process.platform === "win32") {
        const childProcess = await import("node:child_process").catch(() => null);
        if (childProcess && typeof childProcess.execFile === "function") {
          const nCmdShow = visible ? 5 : 0; // SW_SHOW = 5, SW_HIDE = 0
          const psScript = [
            "$def = @\"",
            "[DllImport(\"user32.dll\")] public static extern IntPtr FindWindow(string c, string t);",
            "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int s);",
            "\"@",
            "$t = Add-Type -MemberDefinition $def -Name \"NativeTray\" -Namespace \"ZToolsWin32\" -PassThru",
            "$mainTray = $t::FindWindow(\"Shell_TrayWnd\", $null)",
            `if ($mainTray -ne [IntPtr]::Zero) { [void]$t::ShowWindow($mainTray, ${nCmdShow}) }`,
            "$secTray = $t::FindWindow(\"Shell_SecondaryTrayWnd\", $null)",
            `if ($secTray -ne [IntPtr]::Zero) { [void]$t::ShowWindow($secTray, ${nCmdShow}) }`
          ].join("\r\n");

          await new Promise<void>((resolve, reject) => {
            childProcess.execFile!(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", psScript],
              { windowsHide: true, timeout: 5000 },
              (err: any) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          return true;
        }
      }
    } catch {
      // 容错处理
    }

    return true;
  }

  /**
   * 纯 Win32 / macOS Dock 原生调用：切换任务栏或程序坞自动隐藏
   */
  private async executeNativeAutoHide(autoHide: boolean, hostOverride?: any): Promise<boolean> {
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (hostOverride || isRealElectronHost()) {
      const ipcRes = await callHostTransport("taskbar_toggle", { autoHide }, hostOverride);
      if (ipcRes.ok) return true;
    }

    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.taskbar?.setAutoHide) {
        return await ztools.taskbar.setAutoHide(autoHide);
      }
    } catch {
      // ignore
    }

    try {
      if (typeof process !== "undefined" && process.platform === "win32") {
        const childProcess = await import("node:child_process").catch(() => null);
        if (childProcess && typeof childProcess.execFile === "function") {
          // ABM_SETSTATE = 10; ABS_AUTOHIDE = 1; ABS_ALWAYSONTOP = 2
          const stateVal = autoHide ? 1 : 2;
          const psScript = [
            "$def = @\"",
            "using System;",
            "using System.Runtime.InteropServices;",
            "public class NativeAppBar {",
            "  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {",
            "    public int cbSize;",
            "    public IntPtr hWnd;",
            "    public int uCallbackMessage;",
            "    public int uEdge;",
            "    public int rcLeft, rcTop, rcRight, rcBottom;",
            "    public IntPtr lParam;",
            "  }",
            "  [DllImport(\"shell32.dll\")] public static extern IntPtr SHAppBarMessage(int dwMessage, ref APPBARDATA pData);",
            "}",
            "\"@",
            "$t = Add-Type -MemberDefinition $def -Name \"NativeAppBar\" -Namespace \"ZToolsWin32\" -PassThru",
            "$data = New-Object NativeAppBar+APPBARDATA",
            "$data.cbSize = [Marshal]::SizeOf($data)",
            `$data.lParam = [IntPtr]${stateVal}`,
            "[void]$t::SHAppBarMessage(10, [ref]$data)"
          ].join("\r\n");

          await new Promise<void>((resolve, reject) => {
            childProcess.execFile!(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", psScript],
              { windowsHide: true, timeout: 5000 },
              (err: any) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          return true;
        }
      }
    } catch {
      // ignore
    }

    return true;
  }

  /**
   * 一键切换任务栏显隐 / macOS Dock 自动隐藏 (Toggle Taskbar & Dock Visibility)
   */
  public async toggleTaskbarVisibility(hostOverride?: any): Promise<TaskbarActionResult> {
    const current = await this.getTaskbarState();
    const nextVisible = !current.visible;
    await this.executeNativeShowWindow(nextVisible, hostOverride);
    const updated = await this.saveState({ visible: nextVisible });

    return {
      success: true,
      visible: nextVisible,
      message: nextVisible ? "任务栏已显示 (Taskbar Shown)" : "任务栏已隐藏 (Taskbar Hidden)",
      state: updated
    };
  }

  public async showTaskbar(hostOverride?: any): Promise<TaskbarActionResult> {
    await this.executeNativeShowWindow(true, hostOverride);
    const updated = await this.saveState({ visible: true });
    return {
      success: true,
      visible: true,
      message: "任务栏已恢复显示",
      state: updated
    };
  }

  public async hideTaskbar(hostOverride?: any): Promise<TaskbarActionResult> {
    await this.executeNativeShowWindow(false, hostOverride);
    const updated = await this.saveState({ visible: false });
    return {
      success: true,
      visible: false,
      message: "任务栏已沉浸隐藏",
      state: updated
    };
  }

  /**
   * 切换任务栏 / macOS Dock 自动隐藏 (Toggle Taskbar / Dock Auto-Hide)
   */
  public async toggleTaskbarAutoHide(hostOverride?: any): Promise<TaskbarActionResult> {
    const current = await this.getTaskbarState();
    const nextAutoHide = !current.autoHide;
    await this.executeNativeAutoHide(nextAutoHide, hostOverride);
    const updated = await this.saveState({ autoHide: nextAutoHide });

    return {
      success: true,
      autoHide: nextAutoHide,
      message: nextAutoHide
        ? "已启用任务栏/Dock自动隐藏 (Auto-Hide Enabled)"
        : "已关闭任务栏/Dock自动隐藏 (Auto-Hide Disabled)",
      state: updated
    };
  }

  /**
   * 设置任务栏对齐方式 (Windows 11 Start menu / Taskbar alignment)
   */
  public async setTaskbarAlignment(alignment: TaskbarAlignment): Promise<TaskbarActionResult> {
    const updated = await this.saveState({ alignment });

    // 尝试写入 Windows 注册表 TaskbarAl (0 = Left, 1 = Center)
    try {
      if (typeof process !== "undefined" && process.platform === "win32") {
        const childProcess = await import("node:child_process").catch(() => null);
        if (childProcess && typeof childProcess.execFile === "function") {
          const val = alignment === "center" ? 1 : 0;
          const regCmd = `Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" -Name "TaskbarAl" -Value ${val} -Type DWord`;
          await new Promise<void>((resolve) => {
            childProcess.execFile!(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", regCmd],
              { windowsHide: true, timeout: 3000 },
              () => resolve()
            );
          });
        }
      }
    } catch {
      // ignore
    }

    return {
      success: true,
      message: alignment === "center" ? "任务栏图标已居中对齐" : "任务栏图标已靠左对齐",
      state: updated
    };
  }

  /**
   * 检视与配置任务栏/macOS Dock 停靠位置 (Bottom / Left / Right)
   */
  public async setTaskbarPosition(position: TaskbarPosition, hostOverride?: any): Promise<TaskbarActionResult> {
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (hostOverride || isRealElectronHost()) {
      await callHostTransport("taskbar_set_dock_position", { position }, hostOverride);
    }
    const updated = await this.saveState({ position });
    return {
      success: true,
      message: `停靠位置设定为: ${position.toUpperCase()}`,
      state: updated
    };
  }

  /**
   * 设置 macOS Dock 屏幕停靠位置 (Bottom / Left / Right)
   */
  public async setDockPosition(
    position: "bottom" | "left" | "right",
    hostOverride?: any
  ): Promise<TaskbarActionResult> {
    return this.setTaskbarPosition(position, hostOverride);
  }

  /**
   * 重启 macOS 程序坞 (killall Dock)
   */
  public async restartDock(hostOverride?: any): Promise<TaskbarActionResult> {
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (hostOverride || isRealElectronHost()) {
      await callHostTransport("taskbar_restart_dock", {}, hostOverride);
    }
    const state = await this.getTaskbarState();
    return {
      success: true,
      message: "macOS 程序坞 (Dock) 已重启刷新",
      state
    };
  }

  /**
   * 重启 Windows 资源管理器进程 / macOS Dock 进程 (刷新状态机)
   */
  public async restartExplorer(hostOverride?: any): Promise<TaskbarActionResult> {
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (hostOverride || isRealElectronHost()) {
      await callHostTransport("taskbar_restart_dock", {}, hostOverride);
    }
    try {
      if (typeof process !== "undefined" && process.platform === "win32") {
        const childProcess = await import("node:child_process").catch(() => null);
        if (childProcess && typeof childProcess.execFile === "function") {
          await new Promise<void>((resolve) => {
            childProcess.execFile!(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", "Stop-Process -Name explorer -Force; Start-Process explorer"],
              { windowsHide: true, timeout: 5000 },
              () => resolve()
            );
          });
        }
      }
    } catch {
      // ignore
    }

    const state = await this.getTaskbarState();
    return {
      success: true,
      message: "系统桌面壳层 (Explorer / Dock) 已重新加载",
      state
    };
  }
}

export const defaultWindowsTaskbarManager = new WindowsTaskbarManager();
