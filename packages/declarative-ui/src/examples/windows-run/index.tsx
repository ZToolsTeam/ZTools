/**
 * Windows Run Dialog (极客运行中枢)
 * 
 * 深度对齐 Raycast Windows 运行中枢规范：
 * - 系统命令与可执行文件检索 (PATH / System32 / MSC / CPL)
 * - 命令参数化执行 (如 ping 1.1.1.1 或 code .)
 * - 运行历史记录入库与排序
 * - ActionPanel 动作集：
 *   - Run (普通启动)
 *   - Run as Administrator (提权以管理员身份运行)
 *   - Run in PowerShell (在 PowerShell 中执行并保持窗口)
 *   - Run in Command Prompt (CMD) (在 CMD 中执行)
 *   - Copy Command (复制完整命令行)
 *   - Clear Run History (清空运行历史)
 */

import React from "../../index.js";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import {
  WindowsRunItem,
  RunHistoryRecord,
  ExecuteRunOptions
} from "./types.js";
import {
  defaultWindowsRunManager,
  parseCommandLine
} from "./run-service.js";

export * from "./types.js";
export * from "./run-service.js";

export default function WindowsRunCommand() {
  const [searchText, setSearchText] = useState("");
  const [history, setHistory] = useState<RunHistoryRecord[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    let active = true;
    defaultWindowsRunManager.getHistory().then((h) => {
      if (active) setHistory(h);
    });
    return () => {
      active = false;
    };
  }, [refreshTrigger]);

  const reloadHistory = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleExecute = async (
    cmdLine: string,
    options: ExecuteRunOptions = {}
  ) => {
    const raw = cmdLine.trim();
    if (!raw) {
      await showToast(Toast.Style.Failure, "请输入需要执行的命令");
      return;
    }

    try {
      const res = await defaultWindowsRunManager.execute(raw, options);
      if (res.success) {
        await showToast(
          Toast.Style.Success,
          res.message,
          options.asAdministrator ? "管理员特权启动" : options.shell ? `终端: ${options.shell.toUpperCase()}` : ""
        );
        reloadHistory();
      } else {
        await showToast(Toast.Style.Failure, "执行失败", res.error || res.message);
      }
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "执行命令异常", err.message || String(err));
    }
  };

  const handleCopy = async (cmdLine: string) => {
    await Clipboard.copy(cmdLine);
    await showToast(Toast.Style.Success, "已复制命令到剪贴板", cmdLine);
  };

  const handleClearHistory = async () => {
    await defaultWindowsRunManager.clearHistory();
    setHistory([]);
    await showToast(Toast.Style.Success, "运行历史已清空");
  };

  const handleDeleteHistoryItem = async (id: string) => {
    await defaultWindowsRunManager.deleteHistoryItem(id);
    reloadHistory();
    await showToast(Toast.Style.Success, "已从历史记录中移除");
  };

  // 搜索与过滤逻辑
  const query = searchText.trim();
  const parsed = useMemo(() => parseCommandLine(query), [query]);

  const searchData = useMemo(() => {
    const lower = query.toLowerCase();

    // 1. 匹配历史
    const matchedHistory = history.filter(
      (h) =>
        h.fullCommandLine.toLowerCase().includes(lower) ||
        h.command.toLowerCase().includes(lower)
    );

    return {
      matchedHistory
    };
  }, [query, history]);

  // 构建动作面板
  const renderActionPanel = (cmdLine: string, historyId?: string) => (
    <ActionPanel title={`运行: ${cmdLine}`}>
      <Action
        title="运行 (Run)"
        icon={Icon.Play}
        onAction={() => handleExecute(cmdLine, { shell: "none" })}
      />
      <Action
        title="以管理员身份运行 (Run as Administrator)"
        icon={Icon.Shield}
        shortcut={{ modifiers: ["ctrl", "shift"], key: "enter" }}
        onAction={() => handleExecute(cmdLine, { asAdministrator: true })}
      />
      <Action
        title="在 PowerShell 中运行 (Run in PowerShell)"
        icon={Icon.Terminal}
        shortcut={{ modifiers: ["ctrl"], key: "p" }}
        onAction={() => handleExecute(cmdLine, { shell: "powershell" })}
      />
      <Action
        title="在 CMD 中运行 (Run in CMD)"
        icon={Icon.Terminal}
        shortcut={{ modifiers: ["ctrl"], key: "c" }}
        onAction={() => handleExecute(cmdLine, { shell: "cmd" })}
      />
      <Action
        title="复制完整命令 (Copy Command)"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["ctrl"], key: "y" }}
        onAction={() => handleCopy(cmdLine)}
      />
      {historyId && (
        <Action
          title="从历史记录删除"
          icon={Icon.Trash}
          onAction={() => handleDeleteHistoryItem(historyId)}
        />
      )}
      {history.length > 0 && (
        <Action
          title="清空运行历史 (Clear Run History)"
          icon={Icon.Trash}
          shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
          onAction={handleClearHistory}
        />
      )}
    </ActionPanel>
  );

  return (
    <List
      searchBarPlaceholder="输入命令或路径 (如 ping 1.1.1.1, code ., regedit, ncpa.cpl)..."
      onSearchTextChange={setSearchText}
    >
      {/* 1. 自定义/即时参数化执行项 (当输入非空时) */}
      {query.length > 0 && (
        <List.Section title="执行输入指令">
          <List.Item
            key={`direct-${query}`}
            title={query}
            subtitle={
              parsed.arguments
                ? `命令: ${parsed.command} | 参数: ${parsed.arguments}`
                : `直接运行命令: ${parsed.command}`
            }
            accessories={[{ text: parsed.kind.toUpperCase() }]}
            actions={renderActionPanel(query)}
          />
        </List.Section>
      )}

      {/* 2. 运行历史记录 (若有) */}
      {searchData.matchedHistory.length > 0 && (
        <List.Section title="最近运行历史 (Recent History)">
          {searchData.matchedHistory.map((item) => (
            <List.Item
              key={item.id}
              title={item.fullCommandLine}
              subtitle={
                item.runCount > 1
                  ? `运行 ${item.runCount} 次 • ${new Date(item.executedAt).toLocaleTimeString()}`
                  : `最近执行 • ${new Date(item.executedAt).toLocaleTimeString()}`
              }
              accessories={[
                ...(item.asAdmin ? [{ text: "ADMIN" }] : []),
                ...(item.shell ? [{ text: item.shell.toUpperCase() }] : []),
                { text: "历史" }
              ]}
              actions={renderActionPanel(item.fullCommandLine, item.id)}
            />
          ))}
        </List.Section>
      )}

      {/* 3. 系统核心配置与治理 MSC */}
      <List.Section title="系统管理与控制台 (System & Management)">
        <List.Item
          key="item-regedit"
          title="regedit"
          subtitle="注册表编辑器 (Registry Editor)"
          accessories={[{ text: "系统管理" }]}
          actions={renderActionPanel("regedit.exe")}
        />
        <List.Item
          key="item-taskmgr"
          title="taskmgr"
          subtitle="任务管理器 (Task Manager)"
          accessories={[{ text: "系统管理" }]}
          actions={renderActionPanel("taskmgr.exe")}
        />
        <List.Item
          key="item-services"
          title="services.msc"
          subtitle="系统后台服务管理 (Windows Services)"
          accessories={[{ text: "MMC 控制台" }]}
          actions={renderActionPanel("services.msc")}
        />
        <List.Item
          key="item-gpedit"
          title="gpedit.msc"
          subtitle="本地组策略编辑器 (Group Policy)"
          accessories={[{ text: "MMC 控制台" }]}
          actions={renderActionPanel("gpedit.msc")}
        />
        <List.Item
          key="item-compmgmt"
          title="compmgmt.msc"
          subtitle="计算机管理中枢 (Computer Management)"
          accessories={[{ text: "MMC 控制台" }]}
          actions={renderActionPanel("compmgmt.msc")}
        />
        <List.Item
          key="item-devmgmt"
          title="devmgmt.msc"
          subtitle="设备管理器驱动治理 (Device Manager)"
          accessories={[{ text: "MMC 控制台" }]}
          actions={renderActionPanel("devmgmt.msc")}
        />
        <List.Item
          key="item-dxdiag"
          title="dxdiag"
          subtitle="DirectX 诊断硬件工具"
          accessories={[{ text: "硬件诊断" }]}
          actions={renderActionPanel("dxdiag.exe")}
        />
        <List.Item
          key="item-cleanmgr"
          title="cleanmgr"
          subtitle="磁盘垃圾清理工具 (Disk Cleanup)"
          accessories={[{ text: "磁盘清理" }]}
          actions={renderActionPanel("cleanmgr.exe")}
        />
        <List.Item
          key="item-perfmon"
          title="perfmon"
          subtitle="性能监视器 (Performance Monitor)"
          accessories={[{ text: "性能诊断" }]}
          actions={renderActionPanel("perfmon.exe")}
        />
        <List.Item
          key="item-msconfig"
          title="msconfig"
          subtitle="系统引导配置与启动项 (System Configuration)"
          accessories={[{ text: "引导配置" }]}
          actions={renderActionPanel("msconfig.exe")}
        />
      </List.Section>

      {/* 4. 控制面板 CPL 专向直达 */}
      <List.Section title="控制面板专项 (Control Panel Applets)">
        <List.Item
          key="item-ncpa"
          title="ncpa.cpl"
          subtitle="网络连接与网卡适配器管理"
          accessories={[{ text: "CPL 插件" }]}
          actions={renderActionPanel("ncpa.cpl")}
        />
        <List.Item
          key="item-sysdm"
          title="sysdm.cpl"
          subtitle="系统属性与环境变量设置"
          accessories={[{ text: "CPL 插件" }]}
          actions={renderActionPanel("sysdm.cpl")}
        />
        <List.Item
          key="item-appwiz"
          title="appwiz.cpl"
          subtitle="程序和功能 (软件卸载管理)"
          accessories={[{ text: "CPL 插件" }]}
          actions={renderActionPanel("appwiz.cpl")}
        />
        <List.Item
          key="item-firewall"
          title="firewall.cpl"
          subtitle="Windows 防火墙安全设置"
          accessories={[{ text: "CPL 插件" }]}
          actions={renderActionPanel("firewall.cpl")}
        />
      </List.Section>

      {/* 5. 终端与开发 */}
      <List.Section title="终端与开发环境 (Terminals & Developer)">
        <List.Item
          key="item-cmd"
          title="cmd"
          subtitle="命令提示符 (Command Prompt)"
          accessories={[{ text: "CLI 终端" }]}
          actions={renderActionPanel("cmd.exe")}
        />
        <List.Item
          key="item-powershell"
          title="powershell"
          subtitle="PowerShell 现代终端"
          accessories={[{ text: "CLI 终端" }]}
          actions={renderActionPanel("powershell.exe")}
        />
        <List.Item
          key="item-wt"
          title="wt"
          subtitle="Windows 官方现代终端 (Windows Terminal)"
          accessories={[{ text: "CLI 终端" }]}
          actions={renderActionPanel("wt.exe")}
        />
        <List.Item
          key="item-code"
          title="code ."
          subtitle="在当前目录打开 VS Code"
          accessories={[{ text: "代码开发" }]}
          actions={renderActionPanel("code .")}
        />
      </List.Section>
    </List>
  );
}
