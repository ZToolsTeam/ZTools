import { LocalStorage } from "../../api/storage.js";
import {
  TaskbarState,
  TaskbarActionResult,
  TaskbarAlignment,
  TaskbarPosition
} from "./types.js";

declare const process: { platform?: unknown } | undefined;

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

/** 测试或调用方注入的宿主对象（方法名 → 实现），透传给 callHostTransport */
export type TaskbarHostOverride = Record<string, unknown>;

/** 插件关心的三类平台；识别不出时为 undefined */
export type TaskbarPlatform = "win32" | "darwin" | "linux";

export interface WindowsTaskbarManagerOptions {
  /** 运行平台，默认自动识别；单测注入后可在任意宿主上验证 Windows / macOS 两套行为 */
  readonly platform?: TaskbarPlatform | undefined;
}

type DockEdge = "bottom" | "left" | "right";
const DOCK_EDGES: readonly DockEdge[] = ["bottom", "left", "right"];
const DOCK_EDGE_LABELS: Record<DockEdge, string> = { bottom: "底部", left: "左侧", right: "右侧" };

/**
 * 识别当前平台：Node 环境读 process.platform，渲染进程（无 process）读 userAgent
 */
export function detectTaskbarPlatform(): TaskbarPlatform | undefined {
  try {
    if (typeof process !== "undefined" && typeof process?.platform === "string") {
      const p = process.platform;
      if (p === "win32" || p === "darwin" || p === "linux") return p;
    }
  } catch {
    // 渲染进程沙箱里访问 process 可能抛错，改用 userAgent 判断
  }
  const ua = String((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "");
  if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
  if (/Windows/i.test(ua)) return "win32";
  if (/Linux/i.test(ua)) return "linux";
  return undefined;
}

/**
 * 当前平台上宿主真正实现了的任务栏能力。界面只展示这里为 true 的动作，避免提供每次都失败的按钮。
 * - Windows：只有显示 / 隐藏（taskbar_show / taskbar_hide / taskbar_status）；
 *   自动隐藏、图标对齐、重启资源管理器宿主均未实现；
 * - macOS：Dock 自动隐藏（即显示 / 隐藏）、停靠位置、重启 Dock；
 * - 其他或识别不出：只保留显示 / 隐藏，由宿主如实返回结果。
 */
export interface TaskbarCapabilities {
  readonly visibility: boolean;
  readonly autoHide: boolean;
  readonly dockPosition: boolean;
  readonly restartDock: boolean;
  readonly restartExplorer: boolean;
  readonly alignment: boolean;
}

export function getTaskbarCapabilities(platform: TaskbarPlatform | undefined): TaskbarCapabilities {
  const isMac = platform === "darwin";
  return {
    visibility: true,
    autoHide: isMac,
    dockPosition: isMac,
    restartDock: isMac,
    restartExplorer: false,
    alignment: false
  };
}

/** 宿主调用的统一结果：ok 只代表宿主确认执行成功，error 是宿主给出的失败原因 */
interface HostCallOutcome<T = unknown> {
  readonly ok: boolean;
  readonly reachable: boolean;
  readonly data?: T;
  readonly error?: string;
}

/** 这些错误码表示根本没连上宿主（非 ZTools 环境 / 宿主未暴露该方法），与"宿主执行失败"区分开 */
function isHostUnreachable(error: string | undefined): boolean {
  return /^(NO_WINDOW_ENV|METHOD_NOT_AVAILABLE)/.test(String(error ?? ""));
}

export class WindowsTaskbarManager {
  private currentState: TaskbarState = { ...DEFAULT_TASKBAR_STATE };
  private initialized = false;
  private readonly platformOverride: TaskbarPlatform | undefined;

  constructor(options: WindowsTaskbarManagerOptions = {}) {
    this.platformOverride = options.platform;
  }

  private get platform(): TaskbarPlatform | undefined {
    return this.platformOverride ?? detectTaskbarPlatform();
  }

  /** 当前平台可用的动作（界面据此隐藏宿主未实现的动作） */
  public getCapabilities(): TaskbarCapabilities {
    return getTaskbarCapabilities(this.platform);
  }

  public async getTaskbarState(): Promise<TaskbarState> {
    if (!this.initialized) {
      try {
        const stored = await LocalStorage.getItem<TaskbarState>(TASKBAR_STORAGE_KEY);
        if (stored && typeof stored.visible === "boolean") {
          this.currentState = { ...stored };
        }
      } catch {
        // 读不到本地缓存时沿用默认状态
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
      // 本地缓存写入失败不影响系统设置本身已生效
    }
    return { ...this.currentState };
  }

  /**
   * 调用宿主方法。只有宿主确认成功才算成功；没有宿主时如实返回不可达，绝不假装成功
   */
  private async callHost<T = unknown>(method: string, params: Record<string, unknown>, hostOverride?: TaskbarHostOverride): Promise<HostCallOutcome<T>> {
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (!hostOverride && !isRealElectronHost()) {
      return { ok: false, reachable: false, error: "NO_HOST" };
    }
    const res = await callHostTransport<T>(method, params, hostOverride);
    if (res.ok) return { ok: true, reachable: true, data: res.data as T };
    return { ok: false, reachable: !isHostUnreachable(res.error), error: res.error };
  }

  /** 失败结果：不改动已保存的状态，visible / autoHide 取当前保存的值，message 给用户看，error 保留宿主原始原因 */
  private async failure(message: string, error?: string): Promise<TaskbarActionResult> {
    const state = await this.getTaskbarState();
    return { success: false, visible: state.visible, autoHide: state.autoHide, message, error: error ?? message, state };
  }

  private unreachableMessage(): string {
    return "未连接 ZTools 宿主，无法控制系统任务栏 / Dock";
  }

  /**
   * 显式显示或隐藏：Windows 隐藏任务栏窗口，macOS 对应 Dock 常驻 / 自动隐藏。
   * 调用 taskbar_show / taskbar_hide 而不是 toggle，避免宿主真实状态与本地缓存不一致时方向反转
   */
  private async applyVisible(visible: boolean, hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    const res = await this.callHost<{ message?: unknown }>(visible ? "taskbar_show" : "taskbar_hide", {}, hostOverride);
    if (!res.ok) {
      const fallback = visible ? "显示任务栏失败" : "隐藏任务栏失败";
      return this.failure(res.reachable ? fallback : this.unreachableMessage(), res.reachable ? res.error : undefined);
    }
    const isMac = this.platform === "darwin";
    // macOS 的"隐藏"就是开启 Dock 自动隐藏，两个字段同步更新
    const updated = await this.saveState(isMac ? { visible, autoHide: !visible } : { visible });
    const hostMessage = typeof res.data?.message === "string" && res.data.message ? res.data.message : "";
    return {
      success: true,
      visible,
      message: hostMessage || (visible ? "任务栏已显示" : "任务栏已隐藏"),
      state: updated
    };
  }

  /** 读取宿主的真实显隐状态；读不到时回退到本地缓存 */
  private async readHostVisible(hostOverride?: TaskbarHostOverride): Promise<boolean> {
    const res = await this.callHost<{ visible?: boolean }>("taskbar_status", {}, hostOverride);
    if (res.ok && typeof res.data?.visible === "boolean") return res.data.visible;
    return (await this.getTaskbarState()).visible;
  }

  /**
   * 一键切换任务栏显隐 / macOS Dock 自动隐藏 (Toggle Taskbar & Dock Visibility)
   */
  public async toggleTaskbarVisibility(hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    const current = await this.readHostVisible(hostOverride);
    return this.applyVisible(!current, hostOverride);
  }

  public async showTaskbar(hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    return this.applyVisible(true, hostOverride);
  }

  public async hideTaskbar(hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    return this.applyVisible(false, hostOverride);
  }

  /**
   * 设置自动隐藏：宿主目前只在 macOS 上提供（Dock 自动隐藏 = taskbar_hide），
   * Windows 任务栏自动隐藏宿主尚未实现，如实返回不支持
   */
  public async setTaskbarAutoHide(autoHide: boolean, hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    if (this.platform !== "darwin") {
      return this.failure("当前版本暂不支持切换 Windows 任务栏自动隐藏，仅 macOS Dock 支持");
    }
    const res = await this.callHost(autoHide ? "taskbar_hide" : "taskbar_show", {}, hostOverride);
    if (!res.ok) {
      return this.failure(res.reachable ? "切换 Dock 自动隐藏失败" : this.unreachableMessage(), res.reachable ? res.error : undefined);
    }
    const updated = await this.saveState({ autoHide, visible: !autoHide });
    return {
      success: true,
      autoHide,
      message: autoHide ? "已开启 Dock 自动隐藏" : "已关闭 Dock 自动隐藏",
      state: updated
    };
  }

  /**
   * 切换任务栏 / macOS Dock 自动隐藏 (Toggle Taskbar / Dock Auto-Hide)
   */
  public async toggleTaskbarAutoHide(hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    if (this.platform === "darwin") {
      // macOS 上以 Dock 真实状态为准决定方向
      const visible = await this.readHostVisible(hostOverride);
      return this.setTaskbarAutoHide(visible, hostOverride);
    }
    const current = await this.getTaskbarState();
    return this.setTaskbarAutoHide(!current.autoHide, hostOverride);
  }

  /**
   * 设置任务栏对齐方式 (Windows 11 TaskbarAl)：宿主尚未提供写注册表的能力，如实返回不支持，不改动保存的状态
   */
  public async setTaskbarAlignment(alignment: TaskbarAlignment): Promise<TaskbarActionResult> {
    if (alignment !== "start" && alignment !== "center") {
      return this.failure(`无效的对齐方式: ${String(alignment)}`);
    }
    return this.failure("当前版本暂不支持修改任务栏对齐方式");
  }

  /**
   * 设置任务栏 / macOS Dock 停靠位置：宿主只支持 macOS Dock 的底部 / 左侧 / 右侧，结果以宿主返回为准
   */
  public async setTaskbarPosition(position: TaskbarPosition, hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    const platform = this.platform;
    if (platform && platform !== "darwin") {
      return this.failure("当前系统没有 Dock，仅 macOS 支持设置停靠位置");
    }
    if (!DOCK_EDGES.includes(position as DockEdge)) {
      return this.failure(`Dock 不支持停靠到 ${String(position)}，可选：底部 / 左侧 / 右侧`);
    }
    const res = await this.callHost<{ message?: string }>("taskbar_set_dock_position", { position }, hostOverride);
    if (!res.ok) {
      return this.failure(res.reachable ? "设置 Dock 停靠位置失败" : this.unreachableMessage(), res.reachable ? res.error : undefined);
    }
    const updated = await this.saveState({ position });
    return {
      success: true,
      message: `Dock 停靠位置已切换至${DOCK_EDGE_LABELS[position as DockEdge]}`,
      state: updated
    };
  }

  /**
   * 设置 macOS Dock 屏幕停靠位置 (Bottom / Left / Right)
   */
  public async setDockPosition(
    position: "bottom" | "left" | "right",
    hostOverride?: TaskbarHostOverride
  ): Promise<TaskbarActionResult> {
    return this.setTaskbarPosition(position, hostOverride);
  }

  /**
   * 重启 macOS 程序坞 (killall Dock)，结果以宿主返回为准
   */
  public async restartDock(hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    const platform = this.platform;
    if (platform && platform !== "darwin") {
      return this.failure("当前系统没有 Dock，仅 macOS 支持重启 Dock");
    }
    const res = await this.callHost("taskbar_restart_dock", {}, hostOverride);
    if (!res.ok) {
      return this.failure(res.reachable ? "重启 Dock 失败" : this.unreachableMessage(), res.reachable ? res.error : undefined);
    }
    return { success: true, message: "Dock 已重启", state: await this.getTaskbarState() };
  }

  /**
   * 重启桌面壳层：macOS 重启 Dock；Windows 重启资源管理器宿主尚未实现，如实返回不支持
   */
  public async restartExplorer(hostOverride?: TaskbarHostOverride): Promise<TaskbarActionResult> {
    const platform = this.platform;
    if (platform === "darwin") {
      return this.restartDock(hostOverride);
    }
    if (platform === "win32") {
      return this.failure("当前版本暂不支持重启 Windows 资源管理器");
    }
    return this.failure("当前系统不支持重启桌面壳层");
  }
}

export const defaultWindowsTaskbarManager = new WindowsTaskbarManager();

/** 供界面层统一展示的 Toast 文案：失败时标题为 message，详情为宿主原始原因（与 message 相同则省略） */
export function describeTaskbarFailure(res: TaskbarActionResult): string | undefined {
  if (res.success) return undefined;
  return res.error && res.error !== res.message ? res.error : undefined;
}
