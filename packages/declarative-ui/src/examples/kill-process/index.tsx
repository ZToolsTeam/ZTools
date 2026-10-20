import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  ProcessInfo,
  ProcessSortBy,
  KillMode,
  SAMPLE_PROCESSES,
  fetchRealProcesses,
  filterAndSortProcesses,
  isSystemCriticalProcess,
  getKillCommandLine,
  terminateProcess,
  revealProcessInExplorer
} from "./process-manager.js";

export * from "./process-manager.js";

/**
 * 进程详细监控视图 (极客双栏/独立详情视图)
 */
export function ProcessDetailView({
  process,
  onKilled
}: {
  process: ProcessInfo;
  onKilled?: (pid: number) => void;
}) {
  const { pop } = useNavigation();
  const isCritical = process.isSystemCritical || isSystemCriticalProcess(process.name) || isSystemCriticalProcess(process.pid);
  const isPosixPath = process.path?.startsWith("/") ? true : undefined;
  const gracefulCmd = getKillCommandLine(process.pid, "graceful", isPosixPath);
  const forceCmd = getKillCommandLine(process.pid, "force", isPosixPath);
  const treeCmd = getKillCommandLine(process.pid, "tree", isPosixPath);

  const markdown = `
# 进程详情: ${process.name} (PID: ${process.pid})

> **用户**: \`${process.user}\` | **状态**: \`${process.status.toUpperCase()}\` | **活动线程**: \`${process.threads}\` | **架构**: \`${process.arch || "x64"}\`

${
  isCritical
    ? `> [高危警告] **系统关键高危进程**: 该进程属于系统核心守护子系统 (Windows Kernel / macOS launchd & WindowServer)。若强行终结可能导致系统假死、桌面崩溃重启或内核宕机！\n`
    : ""
}

---

### 资源占用规格
- **工作集物理内存**: \`${process.memoryMB.toFixed(1)} MB\` (${(process.memoryMB / 1024).toFixed(2)} GB)
- **CPU 即时占用率**: \`${process.cpuPercent.toFixed(1)}%\`
- **系统核心保护**: ${isCritical ? "已开启防护 (禁止误杀)" : "普通应用进程"}

---

### 可执行文件路径与启动指令
\`\`\`powershell
# 可执行文件完整路径
${process.path}

# 进程完整启动命令行
${process.commandLine}

# 优雅终结指令 (SIGTERM)
${gracefulCmd}

# 强制终结指令 (Kill -9)
${forceCmd}

# 级联终结进程树指令 (/T / pkill -P)
${treeCmd}
\`\`\`
  `;

  const handleExecuteKill = async (mode: KillMode, allowCritical = false) => {
    const res = await terminateProcess(process, mode, allowCritical);
    if (!res.success) {
      await showToast(Toast.Style.Failure, "操作已拦截", res.message);
      return;
    }
    onKilled?.(process.pid);
    await showToast(Toast.Style.Success, "进程已终结", res.message);
    pop();
  };

  const handleReveal = async () => {
    const ok = await revealProcessInExplorer(process.path);
    if (ok) {
      await showToast(Toast.Style.Success, "已在资源管理器中定位", process.path);
    } else {
      await showToast(Toast.Style.Failure, "无法打开资源管理器", process.path);
    }
  };

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`${process.name} [PID: ${process.pid}]`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="进程标识 (PID)" text={String(process.pid)} icon={Icon.Key} />
          <Detail.Metadata.Label title="CPU 占用率" text={`${process.cpuPercent.toFixed(1)}%`} icon={Icon.Clock} />
          <Detail.Metadata.Label title="内存占用" text={`${process.memoryMB.toFixed(1)} MB`} icon={Icon.Document} />
          <Detail.Metadata.Label title="运行用户" text={process.user} icon={Icon.Pencil} />
          <Detail.Metadata.Label title="线程数量" text={String(process.threads)} icon={Icon.Pin} />
          <Detail.Metadata.Label title="体系架构" text={process.arch || "x64"} icon={Icon.Gear} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="进程安全状态">
            {isCritical ? (
              <Detail.Metadata.TagList.Item text="系统核心保护" color={Color.Red} />
            ) : (
              <Detail.Metadata.TagList.Item text="常规应用进程" color={Color.SecondaryText} />
            )}
            <Detail.Metadata.TagList.Item
              text={process.cpuPercent > 15 ? "高 CPU 负载" : "正常负载"}
              color={process.cpuPercent > 15 ? Color.Red : Color.SecondaryText}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title={`进程操作: ${process.name} (PID: ${process.pid})`}>
          <Action
            title="平缓终结进程 (Kill Process)"
            icon={Icon.Trash}
            onAction={() => handleExecuteKill("graceful")}
          />
          <Action
            title="强制终止 (Force Kill -9)"
            icon={Icon.XMarkCircle}
            shortcut={{ modifiers: ["ctrl"], key: "return" }}
            onAction={() => handleExecuteKill("force")}
          />
          <Action
            title="终结完整进程树 (Kill Process Tree)"
            icon={Icon.Trash}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "backspace" }}
            onAction={() => handleExecuteKill("tree")}
          />
          <Action
            title="在资源管理器中定位 (Show in Explorer)"
            icon={Icon.Folder}
            shortcut={{ modifiers: ["ctrl"], key: "o" }}
            onAction={handleReveal}
          />
          <Action.CopyToClipboard
            title="复制 PID"
            content={String(process.pid)}
            icon={Icon.Key}
          />
          <Action.CopyToClipboard
            title="复制可执行文件完整路径"
            content={process.path}
            icon={Icon.Document}
          />
          <Action.CopyToClipboard
            title="复制强制终止命令 (taskkill)"
            content={forceCmd}
            icon={Icon.CopyClipboard}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 系统级进程管理急救箱主命令
 */
export default function KillProcessCommand() {
  const [processes, setProcesses] = useState<ProcessInfo[]>(() =>
    isRealElectronHost() ? [] : SAMPLE_PROCESSES
  );
  const [isLoading, setIsLoading] = useState<boolean>(() => isRealElectronHost());
  const [sortBy, setSortBy] = useState<ProcessSortBy>("memory");
  const [searchText, setSearchText] = useState("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    let active = true;
    const hasCustomHost = Boolean(
      (globalThis as any).window?.ztools?.dllplugin?.call ||
        (globalThis as any).ztools?.dllplugin?.call
    );
    if (!isRealElectronHost() && !hasCustomHost) {
      return () => {
        active = false;
      };
    }

    let inFlight = false;
    const syncProcesses = async () => {
      if (inFlight || !active) return;
      inFlight = true;
      try {
        const list = await fetchRealProcesses();
        if (active && (list.length > 0 || isRealElectronHost())) {
          setProcesses(list);
          setIsLoading(false);
        }
      } finally {
        if (active) setIsLoading(false);
        inFlight = false;
      }
    };

    void syncProcesses();
    if (!autoRefresh) {
      return () => {
        active = false;
      };
    }

    const timer = setInterval(() => {
      void syncProcesses();
    }, 2000);
    if (typeof (timer as any)?.unref === "function") {
      (timer as any).unref();
    }

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [autoRefresh]);

  const sortedList = filterAndSortProcesses(processes, searchText, sortBy);
  const activeProcess =
    sortedList.find((p) => `proc_${p.pid}` === selectedId || String(p.pid) === selectedId) ||
    sortedList[0];

  const handleKill = async (proc: ProcessInfo, mode: KillMode = "force") => {
    const isCritical = proc.isSystemCritical || isSystemCriticalProcess(proc.name);
    if (isCritical) {
      await showToast(
        Toast.Style.Failure,
        "系统关键进程受安全保护",
        `拒绝终结 ${proc.name} (PID: ${proc.pid})，以防系统崩溃`
      );
      return;
    }

    const res = await terminateProcess(proc, mode, false);
    if (res.success) {
      setProcesses(prev => prev.filter(p => p.pid !== proc.pid));
      await showToast(Toast.Style.Success, res.message, `已释放 ${proc.memoryMB.toFixed(1)} MB 内存`);
    } else {
      await showToast(Toast.Style.Failure, "终止失败", res.message);
    }
  };

  const handleReveal = async (proc: ProcessInfo) => {
    const ok = await revealProcessInExplorer(proc.path);
    if (ok) {
      await showToast(Toast.Style.Success, "已在资源管理器中定位", proc.path);
    }
  };

  const handleRefresh = async () => {
    const hasCustomHost = Boolean(
      (globalThis as any).window?.ztools?.dllplugin?.call ||
        (globalThis as any).ztools?.dllplugin?.call
    );
    if (isRealElectronHost() || hasCustomHost) {
      const list = await fetchRealProcesses();
      setProcesses(list);
      await showToast(Toast.Style.Success, "进程列表已刷新", `当前活跃进程: ${list.length}`);
      return;
    }
    await showToast(Toast.Style.Success, "进程列表已刷新", `当前活跃进程: ${processes.length}`);
  };

  const totalMemory = sortedList.reduce((acc, cur) => acc + cur.memoryMB, 0);

  return (
    <List
      isLoading={isLoading}
      navigationTitle="进程管理急救箱"
      searchBarPlaceholder="搜索进程名、PID、拼音 (如 guge / weiruan / ziyuan) 或可执行路径..."
      searchText={searchText}
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `实时活动进程 ${sortedList.length} 个 · 物理内存合计 ${(totalMemory / 1024).toFixed(2)} GB · ${autoRefresh ? "2s 自动监控中" : "已暂停监控"}`,
        actions: [
          {
            id: "toggle-auto-refresh",
            label: autoRefresh ? "暂停自动刷新" : "开启自动刷新",
            style: "secondary",
            onAction: () => {
              setAutoRefresh(prev => !prev);
            }
          },
          {
            id: "refresh-proc",
            label: "立即刷新",
            style: "secondary",
            onAction: () => {
              void handleRefresh();
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="排序指标"
          value={sortBy}
          onChange={newVal => setSortBy(newVal as ProcessSortBy)}
        >
          <List.Dropdown.Item title="按内存占用降序 (Memory)" value="memory" />
          <List.Dropdown.Item title="按 CPU 占用率降序 (CPU)" value="cpu" />
          <List.Dropdown.Item title="按进程名称排序 (Name)" value="name" />
          <List.Dropdown.Item title="按 PID 升序 (PID)" value="pid" />
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="全局操作">
          <Action
            title="刷新系统进程 (Refresh List)"
            icon={Icon.Repeat}
            onAction={handleRefresh}
          />
          <Action
            title={autoRefresh ? "暂停 2s 自动刷新" : "恢复 2s 自动刷新"}
            icon={autoRefresh ? Icon.Clock : Icon.Bolt}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "r" }}
            onAction={() => setAutoRefresh(prev => !prev)}
          />
        </ActionPanel>
      }
    >
      <List.Section title={`活动进程 (${sortedList.length})`}>
        {sortedList.map(proc => {
          const isHighCpu = proc.cpuPercent >= 15;
          const isHighMem = proc.memoryMB >= 1000;
          const isCritical = proc.isSystemCritical || isSystemCriticalProcess(proc.name);

          return (
            <List.Item
              key={proc.pid}
              id={`proc_${proc.pid}`}
              title={`${proc.name} [PID: ${proc.pid}]`}
              subtitle={`${proc.memoryMB.toFixed(1)} MB • CPU ${proc.cpuPercent.toFixed(1)}% • ${proc.threads} 线程 • ${proc.arch || "x64"}`}
              icon={isCritical ? Icon.Shield : isHighCpu ? Icon.ExclamationMark : Icon.Terminal}
              accessories={[
                ...(isCritical ? [{ tag: { value: "系统关键" } }] : []),
                ...(isHighMem ? [{ tag: { value: "高内存" } }] : []),
                ...(isHighCpu ? [{ tag: { value: "高 CPU", color: Color.Red } }] : []),
                { text: `${proc.memoryMB.toFixed(0)} MB` },
                { text: `CPU ${proc.cpuPercent.toFixed(1)}%` }
              ]}
              actions={
                <ActionPanel title={`${proc.name} (PID: ${proc.pid})`}>
                  <Action
                    title="优雅终结进程 (Kill Process)"
                    icon={Icon.Trash}
                    onAction={() => handleKill(proc, "graceful")}
                  />
                  <Action
                    title="一键强制结束进程"
                    icon={Icon.XMarkCircle}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "return" }}
                    onAction={() => handleKill(proc, "force")}
                  />
                  <Action
                    title="终结进程树 (Kill Process Tree)"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "backspace" }}
                    onAction={() => handleKill(proc, "tree")}
                  />
                  <Action.Push
                    title="查看进程详情与命令行 (Details)"
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl"], key: "d" }}
                    target={
                      <ProcessDetailView
                        process={proc}
                        onKilled={pid => setProcesses(prev => prev.filter(p => p.pid !== pid))}
                      />
                    }
                  />
                  <Action
                    title="在资源管理器中定位 (Show in Explorer)"
                    icon={Icon.Folder}
                    shortcut={{ modifiers: ["ctrl"], key: "o" }}
                    onAction={() => handleReveal(proc)}
                  />
                  <Action.CopyToClipboard
                    title="复制 PID"
                    content={String(proc.pid)}
                    icon={Icon.Key}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="复制可执行文件完整路径"
                    content={proc.path}
                    icon={Icon.Document}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="复制 taskkill 命令"
                    content={`taskkill /F /PID ${proc.pid}`}
                    icon={Icon.CopyClipboard}
                  />
                  <Action
                    title="刷新进程列表 (Refresh)"
                    icon={Icon.Repeat}
                    shortcut={{ modifiers: ["ctrl"], key: "r" }}
                    onAction={handleRefresh}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
