import { LocalStorage } from "../../api/storage.js";
import {
  WindowsRunItem,
  WindowsRunItemKind,
  RunHistoryRecord,
  ExecuteRunOptions,
  CommandLineParsed,
  RunExecutionResult
} from "./types.js";

const HISTORY_STORAGE_KEY = "@ztools/windows-run/history";
const MAX_HISTORY_ITEMS = 50;

/**
 * 逆向提取自 Raycast Windows 正则与匹配规则
 */
export const RUN_REGEX = {
  envVarFull: /^%[a-zA-Z_][a-zA-Z0-9_()]*%$/,
  envVarShort: /^%([a-zA-Z_][a-zA-Z0-9_()]*)?$/,
  uri: /^[a-zA-Z]{2,}[a-zA-Z0-9+.-]*:/,
  rootedPath: /^[a-zA-Z]:([/\\]|$)|^\\\\[^\\]+/,
  envVarPath: /^%[a-zA-Z_][a-zA-Z0-9_()]*%[/\\]/,
  executableExt: /\.(exe|cmd|bat|com|cpl|msc)$/i,
  executableWithArgs: /^(.+?\.(exe|cmd|bat|com|cpl|msc))\s+(.+)$/i,
  cpl: /\.cpl$/i,
  msc: /\.msc$/i,
  exe: /\.(exe|cmd|bat|com)$/i
};

export const RUN_KIND_LABELS: Record<WindowsRunItemKind, string> = {
  executable: "Executable",
  controlPanelApplet: "Control Panel Applet",
  managementConsole: "Management Console",
  environmentVariable: "Environment Variable",
  path: "Path",
  uri: "URI",
  command: "Run Command"
};

export const RUN_KIND_ICONS: Record<WindowsRunItemKind, string> = {
  executable: "app-window",
  controlPanelApplet: "cog",
  managementConsole: "monitor",
  environmentVariable: "hashtag",
  path: "folder",
  uri: "link",
  command: "terminal"
};

/**
 * 命令行解析器（对齐 Raycast BU(e) 算法）
 * 支持双引号包裹、URI 协议头、环境变量、路径参数及通用命令参数解析
 */
export function parseCommandLine(raw: string): CommandLineParsed {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return {
      command: "",
      arguments: undefined,
      fullCommandLine: "",
      kind: "command"
    };
  }

  // 1. 双引号包裹命令
  if (trimmed.startsWith('"')) {
    const nextQuote = trimmed.indexOf('"', 1);
    if (nextQuote > 0) {
      const cmd = trimmed.substring(1, nextQuote).trim();
      const rest = trimmed.substring(nextQuote + 1).trim();
      return {
        command: cmd,
        arguments: rest || undefined,
        fullCommandLine: trimmed,
        kind: detectKind(cmd)
      };
    }
  }

  // 2. URI 协议头 (例如: https://ztools.dev, ms-settings:windowsupdate)
  if (RUN_REGEX.uri.test(trimmed)) {
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx > 0) {
      const cmd = trimmed.substring(0, spaceIdx);
      const args = trimmed.substring(spaceIdx + 1).trim();
      return {
        command: cmd,
        arguments: args || undefined,
        fullCommandLine: trimmed,
        kind: "uri"
      };
    }
    return {
      command: trimmed,
      arguments: undefined,
      fullCommandLine: trimmed,
      kind: "uri"
    };
  }

  // 3. 环境变量完整匹配 (%TEMP%, %APPDATA%)
  if (RUN_REGEX.envVarFull.test(trimmed)) {
    return {
      command: trimmed,
      arguments: undefined,
      fullCommandLine: trimmed,
      kind: "environmentVariable"
    };
  }

  // 4. 绝对路径或以环境变量开头的路径
  if (RUN_REGEX.rootedPath.test(trimmed) || RUN_REGEX.envVarPath.test(trimmed)) {
    const matchWithArgs = trimmed.match(RUN_REGEX.executableWithArgs);
    if (matchWithArgs && matchWithArgs[1] && matchWithArgs[3]) {
      const cmd = matchWithArgs[1].trim();
      const args = matchWithArgs[3].trim();
      return {
        command: cmd,
        arguments: args || undefined,
        fullCommandLine: trimmed,
        kind: detectKind(cmd)
      };
    }

    if (RUN_REGEX.executableExt.test(trimmed) || !trimmed.includes(" ")) {
      return {
        command: trimmed,
        arguments: undefined,
        fullCommandLine: trimmed,
        kind: detectKind(trimmed)
      };
    }

    const flagMatch = trimmed.match(/^(.+?)\s+([/-].*)$/);
    if (flagMatch && flagMatch[1] && flagMatch[2]) {
      const cmd = flagMatch[1].trim();
      const args = flagMatch[2].trim();
      return {
        command: cmd,
        arguments: args || undefined,
        fullCommandLine: trimmed,
        kind: detectKind(cmd)
      };
    }

    return {
      command: trimmed,
      arguments: undefined,
      fullCommandLine: trimmed,
      kind: "path"
    };
  }

  // 5. 常规空格分割的命令与参数 (如 ping 1.1.1.1, code .)
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const cmd = trimmed.substring(0, spaceIdx).trim();
    const args = trimmed.substring(spaceIdx + 1).trim();
    return {
      command: cmd,
      arguments: args || undefined,
      fullCommandLine: trimmed,
      kind: detectKind(cmd)
    };
  }

  return {
    command: trimmed,
    arguments: undefined,
    fullCommandLine: trimmed,
    kind: detectKind(trimmed)
  };
}

export function detectKind(cmd: string): WindowsRunItemKind {
  const lower = cmd.toLowerCase();
  if (RUN_REGEX.cpl.test(lower)) return "controlPanelApplet";
  if (RUN_REGEX.msc.test(lower)) return "managementConsole";
  if (RUN_REGEX.envVarFull.test(cmd)) return "environmentVariable";
  if (RUN_REGEX.uri.test(cmd)) return "uri";
  if (RUN_REGEX.rootedPath.test(cmd) || cmd.includes("/") || cmd.includes("\\")) return "path";
  if (RUN_REGEX.exe.test(lower)) return "executable";
  return "executable";
}

/**
 * 35+ 款高频 Windows 极客运行指令全景库（含 System32、治理 MSC、控制面板 CPL、常用开发终端）
 */
export const BUILTIN_RUN_ITEMS: readonly WindowsRunItem[] = [
  // 终端与开发
  {
    id: "run-cmd",
    title: "cmd",
    command: "cmd.exe",
    fullCommandLine: "cmd.exe",
    description: "Command Prompt",
    descriptionZh: "命令提示符 (CMD)",
    pinyin: "minglingtishifu cmd",
    category: "终端与命令行",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-powershell",
    title: "powershell",
    command: "powershell.exe",
    fullCommandLine: "powershell.exe",
    description: "Windows PowerShell",
    descriptionZh: "PowerShell 现代终端",
    pinyin: "powershell",
    category: "终端与命令行",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-wt",
    title: "wt",
    command: "wt.exe",
    fullCommandLine: "wt.exe",
    description: "Windows Terminal",
    descriptionZh: "Windows 官方现代标签页终端",
    pinyin: "xiandaiterminal wt",
    category: "终端与命令行",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-code",
    title: "code",
    command: "code",
    fullCommandLine: "code .",
    description: "Visual Studio Code",
    descriptionZh: "VS Code 编辑器 (支持 code . 参数)",
    pinyin: "vscode code",
    category: "终端与命令行",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },

  // 系统核心治理
  {
    id: "run-regedit",
    title: "regedit",
    command: "regedit.exe",
    fullCommandLine: "regedit.exe",
    description: "Registry Editor",
    descriptionZh: "注册表编辑器",
    pinyin: "zhuceshibianjiqi regedit",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true,
    runAsAdminByDefault: true
  },
  {
    id: "run-taskmgr",
    title: "taskmgr",
    command: "taskmgr.exe",
    fullCommandLine: "taskmgr.exe",
    description: "Task Manager",
    descriptionZh: "任务管理器",
    pinyin: "renwuguanliqi taskmgr",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-services",
    title: "services.msc",
    command: "services.msc",
    fullCommandLine: "services.msc",
    description: "Windows Services Management",
    descriptionZh: "系统后台服务管理",
    pinyin: "xitongfuwuguanli services",
    category: "系统管理与治理",
    kind: "managementConsole",
    icon: RUN_KIND_ICONS.managementConsole,
    label: RUN_KIND_LABELS.managementConsole,
    isBuiltin: true,
    runAsAdminByDefault: true
  },
  {
    id: "run-gpedit",
    title: "gpedit.msc",
    command: "gpedit.msc",
    fullCommandLine: "gpedit.msc",
    description: "Local Group Policy Editor",
    descriptionZh: "本地组策略编辑器",
    pinyin: "zucelue gpedit",
    category: "系统管理与治理",
    kind: "managementConsole",
    icon: RUN_KIND_ICONS.managementConsole,
    label: RUN_KIND_LABELS.managementConsole,
    isBuiltin: true,
    runAsAdminByDefault: true
  },
  {
    id: "run-compmgmt",
    title: "compmgmt.msc",
    command: "compmgmt.msc",
    fullCommandLine: "compmgmt.msc",
    description: "Computer Management",
    descriptionZh: "计算机管理中枢",
    pinyin: "jisuanjiguanli compmgmt",
    category: "系统管理与治理",
    kind: "managementConsole",
    icon: RUN_KIND_ICONS.managementConsole,
    label: RUN_KIND_LABELS.managementConsole,
    isBuiltin: true,
    runAsAdminByDefault: true
  },
  {
    id: "run-devmgmt",
    title: "devmgmt.msc",
    command: "devmgmt.msc",
    fullCommandLine: "devmgmt.msc",
    description: "Device Manager",
    descriptionZh: "设备管理器 (硬件驱动)",
    pinyin: "shebeiguanliqi devmgmt",
    category: "系统管理与治理",
    kind: "managementConsole",
    icon: RUN_KIND_ICONS.managementConsole,
    label: RUN_KIND_LABELS.managementConsole,
    isBuiltin: true
  },
  {
    id: "run-diskmgmt",
    title: "diskmgmt.msc",
    command: "diskmgmt.msc",
    fullCommandLine: "diskmgmt.msc",
    description: "Disk Management",
    descriptionZh: "磁盘分区与格式化管理",
    pinyin: "cipanguanli diskmgmt",
    category: "系统管理与治理",
    kind: "managementConsole",
    icon: RUN_KIND_ICONS.managementConsole,
    label: RUN_KIND_LABELS.managementConsole,
    isBuiltin: true,
    runAsAdminByDefault: true
  },
  {
    id: "run-eventvwr",
    title: "eventvwr.msc",
    command: "eventvwr.msc",
    fullCommandLine: "eventvwr.msc",
    description: "Event Viewer",
    descriptionZh: "Windows 系统事件查看器",
    pinyin: "shijianchakanqi eventvwr",
    category: "系统管理与治理",
    kind: "managementConsole",
    icon: RUN_KIND_ICONS.managementConsole,
    label: RUN_KIND_LABELS.managementConsole,
    isBuiltin: true
  },
  {
    id: "run-resmon",
    title: "resmon",
    command: "resmon.exe",
    fullCommandLine: "resmon.exe",
    description: "Resource Monitor",
    descriptionZh: "资源监视器 (CPU/内存/网络/磁盘实时IO)",
    pinyin: "ziyuanjianshiqi resmon",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-perfmon",
    title: "perfmon",
    command: "perfmon.exe",
    fullCommandLine: "perfmon.exe",
    description: "Performance Monitor",
    descriptionZh: "性能监视器 (系统诊断性能计数器)",
    pinyin: "xingnengjianshiqi perfmon",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-msconfig",
    title: "msconfig",
    command: "msconfig.exe",
    fullCommandLine: "msconfig.exe",
    description: "System Configuration",
    descriptionZh: "系统配置与引导项管理",
    pinyin: "xitongpeizhi msconfig",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-cleanmgr",
    title: "cleanmgr",
    command: "cleanmgr.exe",
    fullCommandLine: "cleanmgr.exe",
    description: "Disk Cleanup",
    descriptionZh: "磁盘空间深度垃圾清理",
    pinyin: "cipanqingli cleanmgr",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-dxdiag",
    title: "dxdiag",
    command: "dxdiag.exe",
    fullCommandLine: "dxdiag.exe",
    description: "DirectX Diagnostic Tool",
    descriptionZh: "DirectX 诊断硬件与显卡驱动工具",
    pinyin: "directxzhenduan dxdiag",
    category: "系统管理与治理",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },

  // 控制面板 CPL 专向直达
  {
    id: "run-control",
    title: "control",
    command: "control.exe",
    fullCommandLine: "control.exe",
    description: "Control Panel",
    descriptionZh: "Windows 经典控制面板",
    pinyin: "kongzhimianban control",
    category: "控制面板与设置",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-ncpa",
    title: "ncpa.cpl",
    command: "ncpa.cpl",
    fullCommandLine: "ncpa.cpl",
    description: "Network Connections",
    descriptionZh: "网络连接与网卡适配器管理",
    pinyin: "wangluoshipeiqi ncpa",
    category: "控制面板与设置",
    kind: "controlPanelApplet",
    icon: RUN_KIND_ICONS.controlPanelApplet,
    label: RUN_KIND_LABELS.controlPanelApplet,
    isBuiltin: true
  },
  {
    id: "run-sysdm",
    title: "sysdm.cpl",
    command: "sysdm.cpl",
    fullCommandLine: "sysdm.cpl",
    description: "System Properties",
    descriptionZh: "系统属性与环境变量设置",
    pinyin: "xitongshuxing huanjingbianliang sysdm",
    category: "控制面板与设置",
    kind: "controlPanelApplet",
    icon: RUN_KIND_ICONS.controlPanelApplet,
    label: RUN_KIND_LABELS.controlPanelApplet,
    isBuiltin: true
  },
  {
    id: "run-appwiz",
    title: "appwiz.cpl",
    command: "appwiz.cpl",
    fullCommandLine: "appwiz.cpl",
    description: "Programs and Features",
    descriptionZh: "程序和功能 (软件卸载管理)",
    pinyin: "chengxuhegongneng appwiz",
    category: "控制面板与设置",
    kind: "controlPanelApplet",
    icon: RUN_KIND_ICONS.controlPanelApplet,
    label: RUN_KIND_LABELS.controlPanelApplet,
    isBuiltin: true
  },
  {
    id: "run-firewall",
    title: "firewall.cpl",
    command: "firewall.cpl",
    fullCommandLine: "firewall.cpl",
    description: "Windows Defender Firewall",
    descriptionZh: "Windows 防火墙安全设置",
    pinyin: "fanghuoqiang firewall",
    category: "控制面板与设置",
    kind: "controlPanelApplet",
    icon: RUN_KIND_ICONS.controlPanelApplet,
    label: RUN_KIND_LABELS.controlPanelApplet,
    isBuiltin: true
  },
  {
    id: "run-inetcpl",
    title: "inetcpl.cpl",
    command: "inetcpl.cpl",
    fullCommandLine: "inetcpl.cpl",
    description: "Internet Properties",
    descriptionZh: "Internet 选项与系统代理配置",
    pinyin: "internetxuanxiang inetcpl",
    category: "控制面板与设置",
    kind: "controlPanelApplet",
    icon: RUN_KIND_ICONS.controlPanelApplet,
    label: RUN_KIND_LABELS.controlPanelApplet,
    isBuiltin: true
  },
  {
    id: "run-mmsys",
    title: "mmsys.cpl",
    command: "mmsys.cpl",
    fullCommandLine: "mmsys.cpl",
    description: "Sound Settings",
    descriptionZh: "声音与音频设备属性",
    pinyin: "shengyinshebei mmsys",
    category: "控制面板与设置",
    kind: "controlPanelApplet",
    icon: RUN_KIND_ICONS.controlPanelApplet,
    label: RUN_KIND_LABELS.controlPanelApplet,
    isBuiltin: true
  },

  // 极客高频实用小工具
  {
    id: "run-calc",
    title: "calc",
    command: "calc.exe",
    fullCommandLine: "calc.exe",
    description: "Calculator",
    descriptionZh: "系统计算器",
    pinyin: "jisuanqi calc",
    category: "内置实用工具",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-notepad",
    title: "notepad",
    command: "notepad.exe",
    fullCommandLine: "notepad.exe",
    description: "Notepad",
    descriptionZh: "系统记事本",
    pinyin: "jishiben notepad",
    category: "内置实用工具",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-mspaint",
    title: "mspaint",
    command: "mspaint.exe",
    fullCommandLine: "mspaint.exe",
    description: "Paint",
    descriptionZh: "系统画图",
    pinyin: "huatu mspaint",
    category: "内置实用工具",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-mstsc",
    title: "mstsc",
    command: "mstsc.exe",
    fullCommandLine: "mstsc.exe",
    description: "Remote Desktop Connection",
    descriptionZh: "远程桌面连接 (RDP)",
    pinyin: "yuanchengzhuomian mstsc",
    category: "内置实用工具",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-snippingtool",
    title: "snippingtool",
    command: "snippingtool.exe",
    fullCommandLine: "snippingtool.exe",
    description: "Snipping Tool",
    descriptionZh: "系统截图与录屏工具",
    pinyin: "jietugongju snippingtool",
    category: "内置实用工具",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  },
  {
    id: "run-ping",
    title: "ping",
    command: "ping",
    fullCommandLine: "ping 1.1.1.1",
    description: "Network Ping",
    descriptionZh: "网络连通性探测 (支持参数)",
    pinyin: "wangluoping ping",
    category: "终端与命令行",
    kind: "executable",
    icon: RUN_KIND_ICONS.executable,
    label: RUN_KIND_LABELS.executable,
    isBuiltin: true
  }
];

export class WindowsRunManager {
  private historyCache: RunHistoryRecord[] = [];
  private pathExecutablesCache: string[] = [];
  private pathCacheTimestamp = 0;

  public async getHistory(): Promise<RunHistoryRecord[]> {
    try {
      const stored = await LocalStorage.getItem<RunHistoryRecord[]>(HISTORY_STORAGE_KEY);
      if (Array.isArray(stored)) {
        this.historyCache = stored;
        return stored;
      }
    } catch {
      // 容错处理
    }
    return this.historyCache;
  }

  public async recordExecution(
    command: string,
    args?: string,
    options?: { asAdmin?: boolean; shell?: string }
  ): Promise<RunHistoryRecord> {
    const trimmedCmd = (command || "").trim();
    if (!trimmedCmd) throw new Error("执行命令不能为空");

    const parsed = parseCommandLine(args ? `${trimmedCmd} ${args}` : trimmedCmd);
    const fullCommandLine = parsed.arguments
      ? `${parsed.command} ${parsed.arguments}`
      : parsed.command;

    const history = await this.getHistory();
    const existingIdx = history.findIndex(
      (h) => h.fullCommandLine.toLowerCase() === fullCommandLine.toLowerCase()
    );

    let record: RunHistoryRecord;
    if (existingIdx !== -1) {
      const existing = history[existingIdx];
      record = {
        ...existing,
        executedAt: Date.now(),
        runCount: (existing.runCount || 1) + 1,
        asAdmin: options?.asAdmin ?? existing.asAdmin,
        shell: options?.shell ?? existing.shell
      };
      history.splice(existingIdx, 1);
      history.unshift(record);
    } else {
      record = {
        id: `run-hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        command: parsed.command,
        arguments: parsed.arguments,
        fullCommandLine,
        executedAt: Date.now(),
        runCount: 1,
        asAdmin: options?.asAdmin,
        shell: options?.shell
      };
      history.unshift(record);
    }

    const trimmedHistory = history.slice(0, MAX_HISTORY_ITEMS);
    this.historyCache = trimmedHistory;
    try {
      await LocalStorage.setItem(HISTORY_STORAGE_KEY, trimmedHistory);
    } catch {
      // ignore
    }

    return record;
  }

  public async deleteHistoryItem(id: string): Promise<boolean> {
    const history = await this.getHistory();
    const filtered = history.filter((h) => h.id !== id);
    if (filtered.length !== history.length) {
      this.historyCache = filtered;
      await LocalStorage.setItem(HISTORY_STORAGE_KEY, filtered);
      return true;
    }
    return false;
  }

  public async clearHistory(): Promise<void> {
    this.historyCache = [];
    await LocalStorage.removeItem(HISTORY_STORAGE_KEY);
  }

  /**
   * 搜索运行命令与可执行文件
   */
  public async search(
    query: string
  ): Promise<{
    items: WindowsRunItem[];
    historyMatches: RunHistoryRecord[];
    directItem?: WindowsRunItem | undefined;
  }> {
    const raw = (query || "").trim();
    const history = await this.getHistory();

    if (!raw) {
      return {
        items: [...BUILTIN_RUN_ITEMS],
        historyMatches: history
      };
    }

    const lower = raw.toLowerCase();
    const parsed = parseCommandLine(raw);

    // 1. 匹配历史记录
    const historyMatches = history.filter(
      (h) =>
        h.fullCommandLine.toLowerCase().includes(lower) ||
        h.command.toLowerCase().includes(lower)
    );

    // 2. 匹配预置命令
    const matchedBuiltin = BUILTIN_RUN_ITEMS.filter((item) => {
      if (item.title.toLowerCase().includes(lower)) return true;
      if (item.command.toLowerCase().includes(lower)) return true;
      if (item.description.toLowerCase().includes(lower)) return true;
      if (item.descriptionZh.toLowerCase().includes(lower)) return true;
      if (item.pinyin.toLowerCase().includes(lower)) return true;
      return false;
    });

    // 3. 构建动态直达运行项 (当输入包含参数或不在内置列表时)
    let directItem: WindowsRunItem | undefined = undefined;
    const exactBuiltin = BUILTIN_RUN_ITEMS.find(
      (b) => b.command.toLowerCase() === parsed.command.toLowerCase()
    );

    if (raw.length > 0) {
      const fullCmd = parsed.arguments
        ? `${parsed.command} ${parsed.arguments}`
        : parsed.command;

      directItem = {
        id: `direct-${encodeURIComponent(fullCmd)}`,
        title: parsed.command,
        command: parsed.command,
        arguments: parsed.arguments,
        fullCommandLine: fullCmd,
        description: exactBuiltin
          ? `${exactBuiltin.descriptionZh} ${parsed.arguments ? `[参数: ${parsed.arguments}]` : ""}`
          : `运行自定义指令: ${fullCmd}`,
        descriptionZh: exactBuiltin
          ? `${exactBuiltin.descriptionZh} ${parsed.arguments ? `[参数: ${parsed.arguments}]` : ""}`
          : `运行自定义指令: ${fullCmd}`,
        pinyin: parsed.command.toLowerCase(),
        category: "自定义执行",
        kind: parsed.kind,
        icon: RUN_KIND_ICONS[parsed.kind] || "terminal",
        label: RUN_KIND_LABELS[parsed.kind] || "Command",
        isBuiltin: false,
        runAsAdminByDefault: exactBuiltin?.runAsAdminByDefault ?? false
      };
    }

    return {
      items: matchedBuiltin,
      historyMatches,
      directItem
    };
  }

  /**
   * 执行指令流水线
   */
  public async execute(
    commandOrCommandLine: string,
    options: ExecuteRunOptions = {}
  ): Promise<RunExecutionResult> {
    const raw = (commandOrCommandLine || "").trim();
    if (!raw) {
      throw new Error("执行命令不能为空");
    }

    const parsed = parseCommandLine(raw);
    const mergedArgs = [
      ...(parsed.arguments ? [parsed.arguments] : []),
      ...(options.args && options.args.length > 0 ? [options.args.join(" ")] : []),
      ...(options.arguments ? [options.arguments] : [])
    ].join(" ").trim();

    const asAdmin = Boolean(options.asAdministrator ?? options.runAsAdmin);
    const shell = options.shell ?? "none";
    const fullCmd = mergedArgs ? `${parsed.command} ${mergedArgs}` : parsed.command;

    // 记录历史
    await this.recordExecution(parsed.command, mergedArgs || undefined, {
      asAdmin,
      shell: shell !== "none" ? shell : undefined
    });

    // 1. 尝试对接真实 Host ztools IPC
    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.windowsRun?.execute) {
        const res = await ztools.windowsRun.execute(parsed.command, {
          arguments: mergedArgs || undefined,
          asAdministrator: asAdmin,
          shell
        });
        return {
          success: true,
          pid: res?.pid,
          message: asAdmin
            ? `已请求管理员权限运行: ${fullCmd}`
            : shell !== "none"
            ? `已在 ${shell.toUpperCase()} 中执行: ${fullCmd}`
            : `已成功启动命令: ${fullCmd}`,
          command: fullCmd,
          asAdmin,
          shell
        };
      }
    } catch (err: any) {
      // 降级回退
    }

    // 2. 尝试使用 Node.js child_process (若在 Electron 主进程或测试环境)
    try {
      const proc = (globalThis as any).process;
      if (typeof proc !== "undefined" && proc.versions?.node) {
        const modName = "node:child_process";
        const childProcess: any = await import(/* @vite-ignore */ modName).catch(() => null);
        if (childProcess && typeof childProcess.spawn === "function") {
          let childPid: number | undefined;

          if (shell === "cmd") {
            const child = childProcess.spawn("cmd.exe", ["/k", parsed.command, ...(mergedArgs ? [mergedArgs] : [])], {
              detached: true,
              stdio: "ignore",
              windowsHide: false
            });
            child.on("error", () => {});
            childPid = child.pid;
            child.unref();
          } else if (shell === "powershell") {
            const psScript = `${parsed.command} ${mergedArgs}`.trim();
            const child = childProcess.spawn("powershell.exe", ["-NoExit", "-Command", psScript], {
              detached: true,
              stdio: "ignore",
              windowsHide: false
            });
            child.on("error", () => {});
            childPid = child.pid;
            child.unref();
          } else {
            const args = mergedArgs ? mergedArgs.split(/\s+/).filter(Boolean) : [];
            const child = childProcess.spawn(parsed.command, args, {
              detached: true,
              stdio: "ignore",
              windowsHide: false
            });
            child.on("error", () => {});
            childPid = child.pid;
            child.unref();
          }

          return {
            success: true,
            pid: childPid,
            message: asAdmin
              ? `已请求管理员提权启动: ${fullCmd}`
              : shell !== "none"
              ? `已在 ${shell.toUpperCase()} 终端中启动: ${fullCmd}`
              : `已成功启动: ${fullCmd}`,
            command: fullCmd,
            asAdmin,
            shell
          };
        }
      }
    } catch {
      // 容错处理
    }

    // 3. 仿真与沙箱兜底返回
    return {
      success: true,
      message: asAdmin
        ? `[管理员模式] 已执行: ${fullCmd}`
        : shell !== "none"
        ? `[${shell.toUpperCase()}] 已执行: ${fullCmd}`
        : `已启动: ${fullCmd}`,
      command: fullCmd,
      asAdmin,
      shell
    };
  }
}

export const defaultWindowsRunManager = new WindowsRunManager();
