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
  "system idle process"
]);

/**
 * 判断是否为系统高危关键进程 (保护防误杀)
 */
export function isSystemCriticalProcess(nameOrPid: string | number): boolean {
  if (typeof nameOrPid === "number") {
    return nameOrPid === 0 || nameOrPid === 4;
  }
  return CRITICAL_PROCESSES.has(nameOrPid.trim().toLowerCase());
}

/**
 * 构建进程终止命令行
 */
export function getKillCommandLine(pid: number, mode: KillMode): string {
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

/**
 * 终结进程服务 (含高危防误杀拦截与状态返回)
 */
export async function terminateProcess(
  proc: ProcessInfo | { pid: number; name: string },
  mode: KillMode = "force",
  allowCriticalKill = false
): Promise<{ success: boolean; command: string; error?: string; message: string }> {
  const isCritical = proc.name ? isSystemCriticalProcess(proc.name) : isSystemCriticalProcess(proc.pid);

  if (isCritical && !allowCriticalKill) {
    return {
      success: false,
      command: "",
      error: "PROTECTED_CRITICAL_PROCESS",
      message: `系统关键进程受安全保护: 拒绝终结 ${proc.name || proc.pid}，以防系统假死或崩溃蓝屏`
    };
  }

  const cmd = getKillCommandLine(proc.pid, mode);

  // 检查宿主原生执行器或执行环境
  if (typeof (globalThis as any).window?.ztools?.executeCommand === "function") {
    try {
      await (globalThis as any).window.ztools.executeCommand(cmd);
    } catch (err: any) {
      return {
        success: false,
        command: cmd,
        error: "EXECUTION_FAILED",
        message: err?.message || `执行 ${cmd} 失败`
      };
    }
  }

  const modeText = mode === "tree" ? "进程树" : mode === "graceful" ? "平缓终结" : "强制终结";
  return {
    success: true,
    command: cmd,
    message: `已成功${modeText} ${proc.name || proc.pid} (PID: ${proc.pid})`
  };
}

/**
 * 在资源管理器中定位可执行文件
 */
export async function revealProcessInExplorer(filePath: string): Promise<boolean> {
  if (!filePath) return false;
  if (typeof (globalThis as any).window?.ztools?.revealInExplorer === "function") {
    try {
      await (globalThis as any).window.ztools.revealInExplorer(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return true;
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
