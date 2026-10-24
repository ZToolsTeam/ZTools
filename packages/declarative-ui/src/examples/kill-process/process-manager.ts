import { callHostTransport, isRealElectronHost, showRealItemInFolder } from "../shared/native-ipc.js";
import { terminateProcess as hostTerminateProcess } from "../../api/process.js";
import { isZToolsHostError } from "../../api/host-error.js";

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  user: string;
  threads: number;
  path: string;
  commandLine: string;
  status: "running" | "suspended";
  arch?: "x64" | "x86" | "arm64";
  isSystemCritical?: boolean;
  pinyin?: string;
}

export type ProcessSortBy = "memory" | "cpu" | "name" | "pid";
export type KillMode = "graceful" | "force" | "tree";

export const CRITICAL_PROCESSES = new Set([
  // Windows Critical Processes
  "csrss.exe",
  "explorer.exe",
  "svchost.exe",
  "winlogon.exe",
  "smss.exe",
  "services.exe",
  "lsass.exe",
  "dwm.exe",
  "wininit.exe",
  "system",
  "system idle process",
  "registry",
  "fontdrvhost.exe",
  "sihost.exe",
  // macOS Critical Daemons & System Processes
  "kernel_task",
  "launchd",
  "windowserver",
  "loginwindow",
  "dock",
  "finder",
  "systemuiserver",
  "coreaudiod",
  "bluetoothd",
  "mds",
  "opendirectoryd",
  "sysmond"
]);

/**
 * 判断是否为系统高危关键进程 (保护防误杀，含 Windows PID 0/4 与 macOS launchd PID 1)
 */
export function isSystemCriticalProcess(nameOrPid: string | number): boolean {
  if (typeof nameOrPid === "number") {
    return nameOrPid === 0 || nameOrPid === 1 || nameOrPid === 4;
  }
  return CRITICAL_PROCESSES.has(nameOrPid.trim().toLowerCase());
}

export type KillCommandPlatform = "win32" | "posix";

export interface KillCommandOptions {
  /** 目标进程所在的平台：win32 用 taskkill，darwin / linux 等用 kill / pkill；缺省按当前运行平台 */
  platform?: string;
}

function resolveKillCommandPlatform(option?: boolean | KillCommandOptions): KillCommandPlatform {
  if (typeof option === "boolean") return option ? "posix" : "win32";
  const raw = typeof option?.platform === "string" && option.platform.trim()
    ? option.platform.trim().toLowerCase()
    : typeof process !== "undefined" && typeof process.platform === "string"
    ? process.platform
    : "win32";
  return raw === "win32" || raw === "windows" || raw === "win" ? "win32" : "posix";
}

/**
 * 根据可执行文件路径推断进程所属平台：盘符或 UNC 路径为 win32，以 / 开头为 darwin；无法判断时返回 undefined
 */
export function inferProcessPlatform(filePath?: string): string | undefined {
  const value = typeof filePath === "string" ? filePath.trim() : "";
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return "win32";
  if (value.startsWith("/")) return "darwin";
  return undefined;
}

/**
 * 构建进程终止命令行 (Windows taskkill 与 macOS/POSIX kill/pkill)。
 * 第三个参数可传布尔值（true = POSIX，兼容旧调用）或 { platform }，便于测试与按进程路径展示。
 */
export function getKillCommandLine(pid: number, mode: KillMode, option?: boolean | KillCommandOptions): string {
  if (resolveKillCommandPlatform(option) === "posix") {
    switch (mode) {
      case "graceful":
        return `kill -15 ${pid}`;
      case "force":
        return `kill -9 ${pid}`;
      case "tree":
        return `pkill -9 -P ${pid}`;
      default:
        return `kill -9 ${pid}`;
    }
  }

  switch (mode) {
    case "graceful":
      return `taskkill /PID ${pid}`;
    case "force":
      return `taskkill /F /PID ${pid}`;
    case "tree":
      return `taskkill /F /T /PID ${pid}`;
    default:
      return `taskkill /F /PID ${pid}`;
  }
}

function mapRawToProcessInfo(raw: any): ProcessInfo {
  const pid = Number(raw?.pid);
  const safePid = Number.isFinite(pid) && pid >= 0 ? Math.floor(pid) : 0;
  const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : `PID-${safePid}`;
  const cpuRaw = Number(raw?.cpuUsage ?? raw?.cpuPercent ?? raw?.cpu ?? 0);
  const cpuPercent = Number.isFinite(cpuRaw) && cpuRaw >= 0 ? Math.round(cpuRaw * 10) / 10 : 0;

  let memoryMB = Number(raw?.memoryMB ?? NaN);
  if (!Number.isFinite(memoryMB)) {
    const bytes = Number(raw?.memoryWorkingSet ?? raw?.workingSetBytes ?? raw?.memoryUsage ?? raw?.memoryBytes ?? 0);
    memoryMB = Number.isFinite(bytes) && bytes >= 0 ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : 0;
  }

  const path = typeof raw?.path === "string" && raw.path.trim() ? raw.path.trim() : name;
  const commandLine = typeof raw?.commandLine === "string" && raw.commandLine.trim() ? raw.commandLine.trim() : path;
  const threads = Number.isFinite(Number(raw?.threadCount ?? raw?.threads)) && Number(raw?.threadCount ?? raw?.threads) > 0
    ? Math.floor(Number(raw?.threadCount ?? raw?.threads))
    : 1;
  const isCritical = Boolean(raw?.isSystemCritical) || isSystemCriticalProcess(name) || isSystemCriticalProcess(safePid);
  const user =
    typeof raw?.user === "string" && raw.user.trim()
      ? raw.user.trim()
      : typeof raw?.userName === "string" && raw.userName.trim()
      ? raw.userName.trim()
      : isCritical || raw?.isSystem
      ? "SYSTEM"
      : "User";

  return {
    pid: safePid,
    name,
    cpuPercent,
    memoryMB,
    user,
    threads,
    path,
    commandLine,
    status: raw?.status === "suspended" ? "suspended" : "running",
    arch: raw?.arch === "x86" || raw?.arch === "arm64" ? raw.arch : "x64",
    isSystemCritical: isCritical,
    pinyin: typeof raw?.pinyin === "string" ? raw.pinyin : undefined
  };
}

/**
 * 从真实宿主拉取系统进程列表 (支持 ProcessMonitorPlugin 与 process_list 兜底)
 */
export async function fetchRealProcesses(hostOverride?: any): Promise<ProcessInfo[]> {
  const realHost = isRealElectronHost(hostOverride);
  const host = hostOverride ?? (globalThis as any).window?.ztools ?? (globalThis as any).ztools;

  // 1. 尝试直接调用 host.dllplugin.call (独立 try/catch 隔离，防止未加载 DLL 抛错中断后续 IPC)
  if (host && typeof host?.dllplugin?.call === "function" && hostOverride) {
    try {
      const raw = await host.dllplugin.call("ProcessMonitorPlugin", "GetProcessList", "{}");
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.processes)
        ? parsed.processes
        : [];
      if (list.length > 0) {
        return list.map(mapRawToProcessInfo);
      }
    } catch {
      // DLL 未加载或调用失败，继续尝试后续通道
    }
  }

  // 2. 尝试通过 Preload Transport 调用 process_list 与 dllplugin_call
  if (!hostOverride || realHost || typeof hostOverride?.transport?.call === "function" || typeof hostOverride?.process_list === "function" || typeof hostOverride?.dllplugin_call === "function") {
    try {
      const fallbackRes = await callHostTransport<any>(
        "process_list",
        {},
        hostOverride
      );
      if (fallbackRes.ok && fallbackRes.data) {
        const d = fallbackRes.data;
        const list = Array.isArray(d)
          ? d
          : Array.isArray(d?.processes)
          ? d.processes
          : Array.isArray(d?.data)
          ? d.data
          : Array.isArray(d?.data?.processes)
          ? d.data.processes
          : [];
        if (list.length > 0) {
          return list.map(mapRawToProcessInfo);
        }
      }
    } catch {
      // 忽略异常继续尝试
    }

    try {
      const res = await callHostTransport<any>(
        "dllplugin_call",
        {
          plugin: "ProcessMonitorPlugin",
          func: "GetProcessList",
          params: { includeCommandLine: true }
        },
        hostOverride
      );
      if (res.ok && res.data !== undefined) {
        const payload = res.data?.result !== undefined ? res.data.result : res.data;
        const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.processes)
          ? parsed.processes
          : [];
        if (list.length > 0) {
          return list.map(mapRawToProcessInfo);
        }
      }
    } catch {
      // 忽略异常
    }
  }

  if (realHost) {
    return [];
  }
  return [...SAMPLE_PROCESSES];
}

type TerminateResult = { success: boolean; command: string; error?: string; message: string };

/** 宿主 process_terminate_pid 的错误码转成用户可读的说明 */
function describeHostTerminateError(code: string, fallback: string): string {
  switch (code) {
    case "PROCESS_PROTECTED":
      return "宿主拒绝结束该进程（系统或 ZTools 自身进程受保护）";
    case "PROCESS_ACCESS_DENIED":
      return "没有权限结束该进程（可能需要管理员权限）";
    case "PROCESS_IDENTITY_MISMATCH":
      return "该 PID 已不是列表里的进程（可能已退出并被复用），为避免误杀未执行，请刷新后重试";
    case "PROCESS_TERMINATE_TIMEOUT":
      return "进程没有在限定时间内退出，可改用强制结束";
    case "PLUGIN_PERMISSION_REQUIRED":
    case "PLUGIN_IDENTITY_REQUIRED":
      return "当前入口没有结束进程的权限";
    default:
      return fallback || "终止进程失败";
  }
}

/** 测试注入的假宿主（方法名 → 实现），或带 dllplugin.call 的旧宿主对象；透传给 callHostTransport */
type KillProcessHost = Record<string, unknown>;

interface LegacyDllHost {
  dllplugin?: { call?: (plugin: string, func: string, params: Record<string, unknown>) => unknown };
}

/** DLL 返回值（可能是 JSON 字符串）中是否带有失败标记；返回失败原因，成功返回 null */
function legacyDllFailure(raw: unknown): string | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "DLL 返回了无法解析的结果";
    }
  }
  if (parsed === null || parsed === undefined) return "DLL 返回为空";
  if (typeof parsed !== "object") return null;
  const record = parsed as { success?: unknown; error?: unknown };
  if (record.success === false || record.error) return String(record.error || "DLL 返回失败");
  return null;
}

/** 旧 DLL 通道：只有 Windows 宿主提供；内层返回 success:false 时如实上报 */
async function terminateByLegacyDll(
  proc: { pid: number; name: string },
  mode: KillMode,
  hostOverride?: KillProcessHost
): Promise<{ ok: boolean; error?: string }> {
  const g = globalThis as { window?: { ztools?: LegacyDllHost }; ztools?: LegacyDllHost };
  const host = (hostOverride as LegacyDllHost | undefined) ?? g.window?.ztools ?? g.ztools;
  const legacyCall = host?.dllplugin?.call;
  if (typeof legacyCall === "function") {
    try {
      const raw = await legacyCall.call(host?.dllplugin, "ProcessMonitorPlugin", "TerminateProcessByPID", {
        pid: proc.pid,
        name: proc.name,
        mode
      });
      const failure = legacyDllFailure(raw);
      return failure ? { ok: false, error: failure } : { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const res = await callHostTransport<{ result?: unknown } | string>(
    "dllplugin_call",
    { plugin: "ProcessMonitorPlugin", func: "TerminateProcessByPID", params: { pid: proc.pid, name: proc.name, mode } },
    hostOverride
  );
  if (!res.ok) return { ok: false, error: res.error };
  const data = res.data;
  const inner = data && typeof data === "object" && data.result !== undefined ? data.result : data;
  const failure = inner === undefined ? null : legacyDllFailure(inner);
  return failure ? { ok: false, error: failure } : { ok: true };
}

/**
 * 终结进程服务 (含高危防误杀拦截、宿主真实进程终结与状态返回)。
 *
 * 通道顺序：
 * 1. 宿主注入的 terminateProcess（process_terminate_pid，带插件身份，宿主内做保护名单与 pid 复用校验）；
 * 2. 直接调用 process_terminate_pid（宿主会校验调用方是否有 process 权限）；
 * 3. Windows 旧 DLL（ProcessMonitorPlugin.TerminateProcessByPID），内层失败如实返回。
 * 没有任何宿主时返回 success:false，不会假装成功。
 */
export async function terminateProcess(
  proc: ProcessInfo | { pid: number; name: string; path?: string },
  mode: KillMode = "force",
  allowCriticalKill = false,
  hostOverride?: KillProcessHost,
  options: KillCommandOptions = {}
): Promise<TerminateResult> {
  const isCritical =
    (proc.name ? isSystemCriticalProcess(proc.name) : false) || isSystemCriticalProcess(proc.pid);

  if (isCritical && !allowCriticalKill) {
    return {
      success: false,
      command: "",
      error: "PROTECTED_CRITICAL_PROCESS",
      message: `系统关键进程受安全保护: 拒绝终结 ${proc.name || proc.pid}，以防系统假死或崩溃蓝屏`
    };
  }

  const platform = options.platform ?? inferProcessPlatform("path" in proc ? proc.path : undefined);
  const cmd = getKillCommandLine(proc.pid, mode, { platform });

  if (!Number.isInteger(proc.pid) || proc.pid < 2) {
    return { success: false, command: cmd, error: "INVALID_PID", message: `进程 PID 无效: ${proc.pid}` };
  }

  const modeText = mode === "tree" ? "进程树" : mode === "graceful" ? "平缓终结" : "强制终结";
  const okResult: TerminateResult = {
    success: true,
    command: cmd,
    message: `已成功${modeText} ${proc.name || proc.pid} (PID: ${proc.pid})`
  };
  const expectedName = proc.name && proc.name !== `PID-${proc.pid}` ? proc.name : undefined;
  const hostMode: "graceful" | "force" = mode === "graceful" ? "graceful" : "force";
  let lastError = "";

  // 1. 宿主注入的结束进程能力（测试注入 hostOverride 时跳过，避免误用全局桥接）
  if (!hostOverride) {
    try {
      await hostTerminateProcess(proc.pid, { mode: hostMode, tree: mode === "tree", ...(expectedName ? { expectedName } : {}) });
      return okResult;
    } catch (err) {
      if (isZToolsHostError(err)) {
        if (err.code === "PROCESS_NOT_FOUND") return { ...okResult, message: `${proc.name || proc.pid} 已经退出` };
        if (err.code !== "HOST_FEATURE_UNAVAILABLE") {
          return { success: false, command: cmd, error: err.code, message: describeHostTerminateError(err.code, err.message) };
        }
      } else {
        return { success: false, command: cmd, error: "EXECUTION_FAILED", message: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const realHost = isRealElectronHost(hostOverride);
  if (!hostOverride && !realHost) {
    return { success: false, command: cmd, error: "HOST_UNAVAILABLE", message: "未连接 ZTools 宿主，无法结束进程" };
  }

  // 2. 直接走 process_terminate_pid（契约只接受 pid / mode / tree / timeoutMs / expectedName）
  const termRes = await callHostTransport<unknown>(
    "process_terminate_pid",
    { pid: proc.pid, mode: hostMode, tree: mode === "tree", ...(expectedName ? { expectedName } : {}) },
    hostOverride
  );
  if (termRes.ok) return okResult;
  lastError = termRes.error || "";

  // 3. Windows 旧 DLL 通道
  const dllRes = await terminateByLegacyDll(proc, mode, hostOverride);
  if (dllRes.ok) return okResult;

  return {
    success: false,
    command: cmd,
    error: "EXECUTION_FAILED",
    message: dllRes.error || lastError || `执行 ${cmd} 失败`
  };
}

/**
 * 在资源管理器 / 访达中定位可执行文件（shell_show_item_in_folder），按宿主返回判断成败
 */
export async function revealProcessInExplorer(filePath: string, hostOverride?: KillProcessHost): Promise<boolean> {
  if (!filePath) return false;
  if (hostOverride || isRealElectronHost()) {
    return showRealItemInFolder(filePath, hostOverride);
  }
  return false;
}

export const SAMPLE_PROCESSES: ProcessInfo[] = [
  {
    pid: 14220,
    name: "chrome.exe",
    cpuPercent: 14.5,
    memoryMB: 1845.2,
    user: "User",
    threads: 48,
    path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --enable-features=WebAssembly',
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "guge liulanqi chrome"
  },
  {
    pid: 8940,
    name: "Code.exe",
    cpuPercent: 8.2,
    memoryMB: 1220.8,
    user: "User",
    threads: 36,
    path: "C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" --crash-reporter-id 4a8e2',
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "weiruan vscode daima bianjiqi"
  },
  {
    pid: 21088,
    name: "Docker Desktop.exe",
    cpuPercent: 6.8,
    memoryMB: 2450.0,
    user: "SYSTEM",
    threads: 64,
    path: "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    commandLine: '"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" --virtualization=wsl2',
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "duoke rongqi docker desktop wsl2"
  },
  {
    pid: 15432,
    name: "node.exe",
    cpuPercent: 12.0,
    memoryMB: 890.4,
    user: "User",
    threads: 18,
    path: "C:\\Program Files\\nodejs\\node.exe",
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" ./dist/server.js --port=3000',
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "jiedian houduan nodejs javascript"
  },
  {
    pid: 7320,
    name: "Teams.exe",
    cpuPercent: 3.1,
    memoryMB: 780.5,
    user: "User",
    threads: 28,
    path: "C:\\Program Files\\WindowsApps\\MicrosoftTeams_24231.512.3106.6573_x64\\msteams.exe",
    commandLine: "msteams.exe --background",
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "weiruan huiyi teams"
  },
  {
    pid: 4120,
    name: "slack.exe",
    cpuPercent: 2.5,
    memoryMB: 650.0,
    user: "User",
    threads: 24,
    path: "C:\\Users\\User\\AppData\\Local\\slack\\slack.exe",
    commandLine: '"C:\\Users\\User\\AppData\\Local\\slack\\slack.exe" --startup',
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "bangong liaotian slack"
  },
  {
    pid: 18904,
    name: "python.exe",
    cpuPercent: 22.4,
    memoryMB: 512.3,
    user: "User",
    threads: 8,
    path: "C:\\Python312\\python.exe",
    commandLine: "python.exe train_model.py --epochs 100",
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "mangshe suanfatraining python ai"
  },
  {
    pid: 9812,
    name: "WeChat.exe",
    cpuPercent: 1.8,
    memoryMB: 480.0,
    user: "User",
    threads: 32,
    path: "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
    commandLine: '"C:\\Program Files\\Tencent\\WeChat\\WeChat.exe"',
    status: "running",
    arch: "x64",
    isSystemCritical: false,
    pinyin: "weixin shejiao tengxun wechat"
  },
  {
    pid: 3108,
    name: "explorer.exe",
    cpuPercent: 1.2,
    memoryMB: 320.0,
    user: "User",
    threads: 72,
    path: "C:\\Windows\\explorer.exe",
    commandLine: "C:\\Windows\\explorer.exe",
    status: "running",
    arch: "x64",
    isSystemCritical: true,
    pinyin: "ziyuan guanliqi zhuomian explorer"
  },
  {
    pid: 1120,
    name: "svchost.exe",
    cpuPercent: 0.9,
    memoryMB: 210.0,
    user: "SYSTEM",
    threads: 54,
    path: "C:\\Windows\\System32\\svchost.exe",
    commandLine: "C:\\Windows\\System32\\svchost.exe -k DcomLaunch",
    status: "running",
    arch: "x64",
    isSystemCritical: true,
    pinyin: "xitong fuwu xitongsvchost"
  },
  {
    pid: 840,
    name: "dwm.exe",
    cpuPercent: 3.4,
    memoryMB: 195.0,
    user: "SYSTEM",
    threads: 16,
    path: "C:\\Windows\\System32\\dwm.exe",
    commandLine: "dwm.exe",
    status: "running",
    arch: "x64",
    isSystemCritical: true,
    pinyin: "chuangkou guanliqi dwm desktop window manager"
  },
  {
    pid: 580,
    name: "csrss.exe",
    cpuPercent: 0.2,
    memoryMB: 45.0,
    user: "SYSTEM",
    threads: 12,
    path: "C:\\Windows\\System32\\csrss.exe",
    commandLine: "csrss.exe",
    status: "running",
    arch: "x64",
    isSystemCritical: true,
    pinyin: "xitong hexin csrss runtime subsystem"
  },
  {
    pid: 620,
    name: "winlogon.exe",
    cpuPercent: 0.1,
    memoryMB: 38.0,
    user: "SYSTEM",
    threads: 6,
    path: "C:\\Windows\\System32\\winlogon.exe",
    commandLine: "winlogon.exe",
    status: "running",
    arch: "x64",
    isSystemCritical: true,
    pinyin: "denglu jincheng winlogon"
  }
];

export function filterAndSortProcesses(
  processes: ProcessInfo[],
  query: string,
  sortBy: ProcessSortBy = "memory"
): ProcessInfo[] {
  let list = [...processes];

  if (query && query.trim()) {
    const q = query.toLowerCase().trim();
    list = list.filter(
      p =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        p.user.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.pinyin && p.pinyin.toLowerCase().includes(q))
    );
  }

  list.sort((a, b) => {
    switch (sortBy) {
      case "memory":
        return b.memoryMB - a.memoryMB;
      case "cpu":
        return b.cpuPercent - a.cpuPercent;
      case "name":
        return a.name.localeCompare(b.name);
      case "pid":
        return a.pid - b.pid;
      default:
        return 0;
    }
  });

  return list;
}
