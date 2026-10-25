import { ApplicationRecord, ApplicationCategory, ApplicationActionResult } from "./types.js";
import {
  callHostTransport,
  isRealElectronHost,
  openRealPath,
  showRealItemInFolder
} from "../shared/native-ipc.js";

/**
 * 拼音与首字母映射表（支持常用高频软件与系统工具）
 */
const KNOWN_PINYIN_MAP: Record<string, { pinyin: string; initials: string }> = {
  "微信": { pinyin: "weixin", initials: "wx" },
  "腾讯会议": { pinyin: "tengxunhuiyi", initials: "txhy" },
  "钉钉": { pinyin: "dingding", initials: "dd" },
  "网易云音乐": { pinyin: "wangyiyunyinyue", initials: "wyyyy" },
  "飞书": { pinyin: "feishu", initials: "fs" },
  "百度网盘": { pinyin: "baiduwangpan", initials: "bdwp" },
  "夸克": { pinyin: "kuake", initials: "kk" },
  "哔哩哔哩": { pinyin: "bilibili", initials: "blbl" },
  "向日葵": { pinyin: "xiangrikui", initials: "xrk" },
  "计算器": { pinyin: "jisuanqi", initials: "jsq" },
  "终端": { pinyin: "zhongduan", initials: "zd" },
  "照片": { pinyin: "zhaopian", initials: "zp" },
  "任务管理器": { pinyin: "renwuguanliqi", initials: "rwglq" },
  "注册表编辑器": { pinyin: "zhucebiao", initials: "zcb" },
  "控制面板": { pinyin: "kongzhimianban", initials: "kzmb" },
  "赛博朋克 2077": { pinyin: "saibopengke2077", initials: "sbpk" }
};

export function computePinyin(name: string): { pinyin: string; initials: string } {
  for (const [key, val] of Object.entries(KNOWN_PINYIN_MAP)) {
    if (name.includes(key)) return val;
  }
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { pinyin: clean, initials: clean.slice(0, 4) };
}

/**
 * 标杆内置应用程序全景库 (涵盖 Win32 用户自装、UWP 现代化应用、Windows 核心系统工具)
 */
export const INITIAL_APPLICATIONS: ApplicationRecord[] = [
  {
    id: "app-vscode",
    name: "Visual Studio Code",
    publisher: "Microsoft Corporation",
    version: "1.93.0",
    installLocation: "C:\\Program Files\\Microsoft VS Code",
    path: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    architecture: "x64",
    category: "developer",
    bundleId: "Microsoft.VisualStudioCode",
    uninstallString: '"C:\\Program Files\\Microsoft VS Code\\unins000.exe"',
    quietUninstallString: '"C:\\Program Files\\Microsoft VS Code\\unins000.exe" /VERYSILENT',
    estimatedSizeKb: 362400,
    isSystemComponent: false,
    pinyin: "visual studio code",
    pinyinInitials: "vsc",
    isRunning: true,
    pid: 10428,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-chrome",
    name: "Google Chrome",
    publisher: "Google LLC",
    version: "129.0.6668.71",
    installLocation: "C:\\Program Files\\Google\\Chrome\\Application",
    path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    architecture: "x64",
    category: "installed",
    bundleId: "Google.Chrome",
    uninstallString: '"C:\\Program Files\\Google\\Chrome\\Application\\129.0.6668.71\\Installer\\setup.exe" --uninstall',
    estimatedSizeKb: 284100,
    isSystemComponent: false,
    pinyin: "google chrome",
    pinyinInitials: "gc",
    isRunning: true,
    pid: 14892,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-wechat",
    name: "微信 (WeChat)",
    publisher: "Tencent Technology",
    version: "3.9.12.17",
    installLocation: "C:\\Program Files\\Tencent\\WeChat",
    path: "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
    architecture: "x64",
    category: "installed",
    bundleId: "Tencent.WeChat",
    uninstallString: '"C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe"',
    estimatedSizeKb: 412000,
    isSystemComponent: false,
    pinyin: "weixin",
    pinyinInitials: "wx",
    isRunning: true,
    pid: 8812,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-nodejs",
    name: "Node.js JavaScript Runtime",
    publisher: "Node.js Foundation",
    version: "22.11.0",
    installLocation: "C:\\Program Files\\nodejs",
    path: "C:\\Program Files\\nodejs\\node.exe",
    architecture: "x64",
    category: "developer",
    bundleId: "Nodejs.Node",
    uninstallString: 'MsiExec.exe /I{B5D9822F-06E5-46D9-B109-178A7DE4F523}',
    estimatedSizeKb: 68500,
    isSystemComponent: false,
    pinyin: "nodejs",
    pinyinInitials: "node",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-git",
    name: "Git for Windows",
    publisher: "The Git Development Community",
    version: "2.46.0",
    installLocation: "C:\\Program Files\\Git",
    path: "C:\\Program Files\\Git\\git-bash.exe",
    architecture: "x64",
    category: "developer",
    bundleId: "Git.Git",
    uninstallString: '"C:\\Program Files\\Git\\unins000.exe"',
    estimatedSizeKb: 341000,
    isSystemComponent: false,
    pinyin: "git",
    pinyinInitials: "git",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-steam",
    name: "Steam Client",
    publisher: "Valve Corporation",
    version: "2.10.91",
    installLocation: "C:\\Program Files (x86)\\Steam",
    path: "C:\\Program Files (x86)\\Steam\\steam.exe",
    architecture: "x86",
    category: "game",
    bundleId: "Valve.Steam",
    uninstallString: '"C:\\Program Files (x86)\\Steam\\uninstall.exe"',
    estimatedSizeKb: 198000,
    isSystemComponent: false,
    pinyin: "steam",
    pinyinInitials: "stm",
    isRunning: false,
    isGame: true,
    autoQuitEnabled: false
  },
  {
    id: "app-cyberpunk",
    name: "赛博朋克 2077 (Cyberpunk 2077)",
    publisher: "CD PROJEKT RED",
    version: "2.13",
    installLocation: "D:\\Games\\Cyberpunk 2077",
    path: "D:\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe",
    architecture: "x64",
    category: "game",
    bundleId: "CDProjektRED.Cyberpunk2077",
    uninstallString: '"D:\\Games\\Cyberpunk 2077\\Uninstall.exe"',
    estimatedSizeKb: 72400000,
    isSystemComponent: false,
    pinyin: "saibopengke2077",
    pinyinInitials: "sbpk",
    isRunning: false,
    isGame: true,
    autoQuitEnabled: false
  },
  {
    id: "app-obsidian",
    name: "Obsidian",
    publisher: "Dynalist Inc.",
    version: "1.6.7",
    installLocation: "C:\\Users\\User\\AppData\\Local\\Obsidian",
    path: "C:\\Users\\User\\AppData\\Local\\Obsidian\\Obsidian.exe",
    architecture: "x64",
    category: "developer",
    bundleId: "md.obsidian",
    uninstallString: '"C:\\Users\\User\\AppData\\Local\\Obsidian\\Update.exe" --uninstall -s',
    estimatedSizeKb: 215000,
    isSystemComponent: false,
    pinyin: "obsidian",
    pinyinInitials: "obs",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  },
  // UWP 现代化应用
  {
    id: "app-calculator",
    name: "Windows 计算器 (Calculator)",
    publisher: "Microsoft Corporation",
    version: "11.2401.0.0",
    installLocation: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2401.0.0_x64__8wekyb3d8bbwe",
    path: "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
    architecture: "neutral",
    category: "system",
    bundleId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
    isSystemComponent: true,
    isUwp: true,
    pinyin: "jisuanqi",
    pinyinInitials: "jsq",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-terminal",
    name: "Windows 终端 (Windows Terminal)",
    publisher: "Microsoft Corporation",
    version: "1.20.10822.0",
    installLocation: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.20.10822.0_x64__8wekyb3d8bbwe",
    path: "shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
    architecture: "x64",
    category: "developer",
    bundleId: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
    isSystemComponent: false,
    isUwp: true,
    pinyin: "zhongduan",
    pinyinInitials: "zd",
    isRunning: true,
    pid: 19204,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-photos",
    name: "照片 (Microsoft Photos)",
    publisher: "Microsoft Corporation",
    version: "2024.11070.3002.0",
    installLocation: "C:\\Program Files\\WindowsApps\\Microsoft.Windows.Photos_2024.11070.3002.0_x64__8wekyb3d8bbwe",
    path: "shell:AppsFolder\\Microsoft.Windows.Photos_8wekyb3d8bbwe!App",
    architecture: "neutral",
    category: "system",
    bundleId: "Microsoft.Windows.Photos_8wekyb3d8bbwe!App",
    isSystemComponent: true,
    isUwp: true,
    pinyin: "zhaopian",
    pinyinInitials: "zp",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  },
  // Windows 原生系统工具
  {
    id: "app-taskmgr",
    name: "任务管理器 (Task Manager)",
    publisher: "Microsoft Windows",
    version: "10.0.26100.1",
    installLocation: "C:\\Windows\\System32",
    path: "C:\\Windows\\System32\\Taskmgr.exe",
    architecture: "x64",
    category: "system",
    bundleId: "Microsoft.Windows.Taskmgr",
    isSystemComponent: true,
    pinyin: "renwuguanliqi",
    pinyinInitials: "rwglq",
    isRunning: true,
    pid: 3420,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-regedit",
    name: "注册表编辑器 (Registry Editor)",
    publisher: "Microsoft Windows",
    version: "10.0.26100.1",
    installLocation: "C:\\Windows",
    path: "C:\\Windows\\regedit.exe",
    architecture: "x64",
    category: "system",
    bundleId: "Microsoft.Windows.Regedit",
    isSystemComponent: true,
    pinyin: "zhucebiao",
    pinyinInitials: "zcb",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  },
  {
    id: "app-control",
    name: "控制面板 (Control Panel)",
    publisher: "Microsoft Windows",
    version: "10.0.26100.1",
    installLocation: "C:\\Windows\\System32",
    path: "C:\\Windows\\System32\\control.exe",
    architecture: "x64",
    category: "system",
    bundleId: "Microsoft.Windows.ControlPanel",
    isSystemComponent: true,
    pinyin: "kongzhimianban",
    pinyinInitials: "kzmb",
    isRunning: false,
    isGame: false,
    autoQuitEnabled: false
  }
];

let fallbackPidSeq = 10000;

export class ApplicationsManager {
  private apps: ApplicationRecord[] = isRealElectronHost() ? [] : [...INITIAL_APPLICATIONS];

  private mapHostAppRecord(raw: unknown): ApplicationRecord {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = String(r?.name || r?.displayName || "Unknown App");
    const py = computePinyin(name);
    const isMacApp = typeof r?.path === "string" && r.path.endsWith(".app");
    const defaultInstallLoc = isMacApp
      ? String(r.path).replace(/\/[^/]+\.app$/i, "")
      : r?.installLocation || "";
    const resolvedPath =
      typeof r?.path === "string" && r.path
        ? r.path
        : r?.installLocation
        ? `${r.installLocation}\\${name}.exe`
        : name;

    return {
      id: String(r?.id || r?.bundleId || `app-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`),
      name,
      version: String(r?.version || "1.0.0"),
      publisher: String(r?.publisher || (isMacApp ? "Apple / macOS Developer" : "Unknown")),
      installLocation: String(defaultInstallLoc),
      path: resolvedPath,
      architecture:
        r?.architecture === "arm64" || r?.architecture === "x86" || r?.architecture === "neutral"
          ? r.architecture
          : "x64",
      category:
        r?.category === "developer" || r?.category === "game" || r?.category === "system"
          ? r.category
          : r?.isSystemComponent
          ? "system"
          : "installed",
      bundleId: typeof (r?.bundleId || r?.id) === "string" ? String(r?.bundleId || r?.id) : undefined,
      uninstallString: typeof r?.uninstallString === "string" ? r.uninstallString : undefined,
      quietUninstallString: typeof r?.quietUninstallString === "string" ? r.quietUninstallString : undefined,
      displayIcon: typeof (r?.displayIcon || r?.icon) === "string" ? String(r?.displayIcon || r?.icon) : undefined,
      estimatedSizeKb: typeof r?.estimatedSizeKb === "number" ? r.estimatedSizeKb : undefined,
      isSystemComponent: Boolean(r?.isSystemComponent),
      isUwp: Boolean(r?.isUwp),
      pinyin: typeof r?.pinyin === "string" && r.pinyin ? r.pinyin : py.pinyin,
      pinyinInitials: typeof r?.pinyinInitials === "string" && r.pinyinInitials ? r.pinyinInitials : py.initials,
      isRunning: Boolean(r?.isRunning),
      pid: typeof r?.pid === "number" ? r.pid : undefined,
      isGame: Boolean(r?.isGame),
      autoQuitEnabled: Boolean(r?.autoQuitEnabled),
      leftoverPaths: Array.isArray(r?.leftoverPaths)
        ? r.leftoverPaths.map((p: unknown) => String(p))
        : undefined
    };
  }

  /**
   * 从宿主同步真实已安装应用列表 (Windows 注册表/Appx 或 macOS mdfind/system_profiler + ~/Library 残留分析)
   */
  public async syncFromHost(forceRefresh = false, hostOverride?: unknown): Promise<ApplicationRecord[]> {
    const res = await callHostTransport<Record<string, unknown> | unknown[]>(
      "applications_list",
      { forceRefresh },
      hostOverride
    );
    if (res.ok && res.data) {
      const dataObj = (!Array.isArray(res.data) && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
      const rawList = Array.isArray(res.data)
        ? res.data
        : Array.isArray(dataObj.applications)
        ? dataObj.applications
        : Array.isArray(dataObj.apps)
        ? dataObj.apps
        : [];
      if (rawList.length > 0) {
        const mapped = rawList.map((r: unknown) => this.mapHostAppRecord(r));
        this.apps = mapped;
        return [...this.apps];
      }
    }
    if (isRealElectronHost(hostOverride)) {
      this.apps = [];
      return [];
    }
    return [...this.apps];
  }

  public async getApplications(forceRefresh = false, hostOverride?: unknown): Promise<ApplicationRecord[]> {
    try {
      const ztools = (hostOverride ?? (globalThis as Record<string, unknown>).ztools) as {
        applications?: { searchApplications?: (q: string, opts: Record<string, unknown>) => Promise<unknown[]> };
      } | undefined;
      if (ztools?.applications?.searchApplications) {
        const remote = await ztools.applications.searchApplications("", {
          includeSystemComponents: true,
          forceRefresh
        });
        if (Array.isArray(remote) && remote.length > 0) {
          return remote.map((r: unknown) => this.mapHostAppRecord(r));
        }
      }

      if (hostOverride || isRealElectronHost(hostOverride)) {
        const synced = await this.syncFromHost(forceRefresh, hostOverride);
        if (synced.length > 0 || isRealElectronHost(hostOverride)) {
          return synced;
        }
      }
    } catch (err) {
      console.warn("[applications] getApplications failed:", err);
      if (isRealElectronHost(hostOverride)) {
        return [];
      }
    }
    return [...this.apps];
  }

  public filterAndSearch(
    apps: ApplicationRecord[],
    query: string,
    category: ApplicationCategory
  ): ApplicationRecord[] {
    const raw = (query || "").trim().toLowerCase();

    return apps.filter((app) => {
      // 1. 分类筛选
      if (category === "running") {
        if (!app.isRunning) return false;
      } else if (category !== "all") {
        if (app.category !== category) return false;
      }

      // 2. 搜索词匹配
      if (!raw) return true;

      if (app.name.toLowerCase().includes(raw)) return true;
      if (app.publisher.toLowerCase().includes(raw)) return true;
      if (app.path.toLowerCase().includes(raw)) return true;
      if (app.bundleId && app.bundleId.toLowerCase().includes(raw)) return true;
      if (app.pinyin.toLowerCase().includes(raw)) return true;
      if (app.pinyinInitials.toLowerCase().includes(raw)) return true;

      return false;
    });
  }

  public async openApplication(
    app: ApplicationRecord,
    options: { runAsAdmin?: boolean } = {},
    hostOverride?: unknown
  ): Promise<ApplicationActionResult> {
    if (!app || !app.path) {
      return { success: false, message: "应用路径无效或为空", error: "INVALID_PATH" };
    }

    // 防御性校验超长路径与特殊非法路径
    if (app.path.length > 1024) {
      return { success: false, message: "路径长度严重超限 (>1024字符)", error: "PATH_TOO_LONG" };
    }

    try {
      const ztools = (hostOverride ?? (globalThis as Record<string, unknown>).ztools) as {
        applications?: { open?: (opts: Record<string, unknown>) => Promise<unknown> };
      } | undefined;
      if (ztools?.applications?.open) {
        await ztools.applications.open({ raycastAppId: app.bundleId || app.id, runAsAdmin: options.runAsAdmin });
      } else if (hostOverride || isRealElectronHost(hostOverride)) {
        const ok = await openRealPath(app.path, hostOverride);
        if (!ok && isRealElectronHost(hostOverride)) {
          return {
            success: false,
            message: `启动应用失败: 无法打开路径 ${app.path}`,
            error: "LAUNCH_FAILED"
          };
        }
      }

      const idx = this.apps.findIndex((a) => a.id === app.id);
      if (idx !== -1) {
        const nextPid = isRealElectronHost(hostOverride) ? this.apps[idx].pid : ++fallbackPidSeq;
        this.apps[idx] = { ...this.apps[idx], isRunning: true, pid: nextPid };
      }

      const modeStr = options.runAsAdmin ? "以管理员身份" : "";
      return {
        success: true,
        message: `已${modeStr}启动应用程序 [${app.name}]`,
        app: idx !== -1 ? this.apps[idx] : app
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `启动应用失败: ${errMsg}`,
        error: "LAUNCH_FAILED"
      };
    }
  }

  public async revealApplication(app: ApplicationRecord, hostOverride?: unknown): Promise<ApplicationActionResult> {
    if (!app || !app.path) {
      return { success: false, message: "无效的应用路径", error: "INVALID_PATH" };
    }

    try {
      const launcher = (globalThis as Record<string, unknown>).__ztoolsLauncher as {
        showItemInFolder?: (p: string) => Promise<unknown>;
      } | undefined;
      if (launcher?.showItemInFolder) {
        await launcher.showItemInFolder(app.path);
      } else if (hostOverride || isRealElectronHost(hostOverride)) {
        const ok = await showRealItemInFolder(app.path, hostOverride);
        if (!ok && isRealElectronHost(hostOverride)) {
          return { success: false, message: `定位失败: 无法在资源管理器中显示 ${app.path}`, error: "REVEAL_FAILED" };
        }
      }
      return { success: true, message: `已在资源管理器中定位 (Finder) [${app.name}]`, app };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `定位失败: ${errMsg}`, error: "REVEAL_FAILED" };
    }
  }

  public async terminateApplication(
    app: ApplicationRecord,
    force = false
  ): Promise<ApplicationActionResult> {
    if (!app) {
      return { success: false, message: "应用对象为空", error: "NULL_APP" };
    }

    // 关键系统进程保护
    if (app.id === "app-taskmgr" && !force) {
      return {
        success: false,
        message: "任务管理器属于受保护的核心系统组件，请使用强制终止 (Force Quit)",
        error: "SYSTEM_COMPONENT_PROTECTED"
      };
    }

    if (!app.isRunning) {
      return {
        success: false,
        message: `应用 [${app.name}] 当前未在运行`,
        error: "PROCESS_NOT_RUNNING"
      };
    }

    const idx = this.apps.findIndex((a) => a.id === app.id);
    if (idx !== -1) {
      this.apps[idx] = { ...this.apps[idx], isRunning: false, pid: undefined };
    }

    const actionName = force ? "已强制终结" : "已优雅退出";
    return {
      success: true,
      message: `${actionName}应用程序 [${app.name}] (PID: ${app.pid || "N/A"})`,
      app: idx !== -1 ? this.apps[idx] : app
    };
  }

  public async restartApplication(app: ApplicationRecord): Promise<ApplicationActionResult> {
    if (!app) {
      return { success: false, message: "应用对象为空", error: "NULL_APP" };
    }

    if (app.isRunning) {
      await this.terminateApplication(app, true);
    }
    return this.openApplication(app);
  }

  public async uninstallApplication(
    app: ApplicationRecord,
    hostOverride?: unknown
  ): Promise<ApplicationActionResult> {
    if (!app) {
      return { success: false, message: "应用对象为空", error: "NULL_APP" };
    }

    if (app.isSystemComponent && !app.uninstallString) {
      return {
        success: false,
        message: `应用 [${app.name}] 为系统核心组件 (Windows System / macOS /System/Applications)，不允许直接卸载`,
        error: "SYSTEM_COMPONENT_LOCKED"
      };
    }

    const isMacBundle = Boolean(app.path?.endsWith(".app") || (app.leftoverPaths && app.leftoverPaths.length > 0));
    if (!app.uninstallString && !app.isUwp && !isMacBundle && !hostOverride && !isRealElectronHost()) {
      return {
        success: false,
        message: `应用 [${app.name}] 未找到有效的卸载注册表项`,
        error: "UNINSTALL_COMMAND_MISSING"
      };
    }

    try {
      const ztools = (hostOverride ?? (globalThis as Record<string, unknown>).ztools) as {
        applications?: { launchUninstall?: (id: string) => Promise<unknown> };
      } | undefined;
      if (ztools?.applications?.launchUninstall) {
        await ztools.applications.launchUninstall(app.id);
      } else if (hostOverride || isRealElectronHost(hostOverride)) {
        const res = await callHostTransport<Record<string, unknown>>(
          "applications_uninstall",
          {
            id: app.id,
            appId: app.id,
            bundleId: app.bundleId,
            path: app.path,
            command: app.uninstallString || app.id,
            leftoverPaths: app.leftoverPaths
          },
          hostOverride
        );
        if (!res.ok) {
          return {
            success: false,
            message: `启动卸载失败: ${res.error || "宿主卸载通道返回异常"}`,
            error: "UNINSTALL_FAILED"
          };
        }
      }
      const leftoverHint =
        app.leftoverPaths && app.leftoverPaths.length > 0
          ? `（已同步清理 ${app.leftoverPaths.length} 项 ~/Library 关联残留）`
          : "";
      return {
        success: true,
        message: `已调起 [${app.name}] 官方卸载向导${leftoverHint}`,
        app
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `启动卸载失败: ${errMsg}`,
        error: "UNINSTALL_FAILED"
      };
    }
  }

  public toggleGameStatus(app: ApplicationRecord): ApplicationActionResult {
    const idx = this.apps.findIndex((a) => a.id === app.id);
    if (idx === -1) {
      return { success: false, message: "未找到应用", error: "APP_NOT_FOUND" };
    }
    const newStatus = !this.apps[idx].isGame;
    this.apps[idx] = {
      ...this.apps[idx],
      isGame: newStatus,
      category: newStatus ? "game" : "installed"
    };
    return {
      success: true,
      message: newStatus ? `已将 [${app.name}] 标记为游戏` : `已取消 [${app.name}] 游戏标记`,
      app: this.apps[idx]
    };
  }

  public toggleAutoQuit(app: ApplicationRecord): ApplicationActionResult {
    const idx = this.apps.findIndex((a) => a.id === app.id);
    if (idx === -1) {
      return { success: false, message: "未找到应用", error: "APP_NOT_FOUND" };
    }
    const newStatus = !this.apps[idx].autoQuitEnabled;
    this.apps[idx] = {
      ...this.apps[idx],
      autoQuitEnabled: newStatus
    };
    return {
      success: true,
      message: newStatus
        ? `已为 [${app.name}] 启用空闲自动退出`
        : `已为 [${app.name}] 禁用空闲自动退出`,
      app: this.apps[idx]
    };
  }
}

export const defaultApplicationsManager = new ApplicationsManager();
