/**
 * Windows Taskbar (任务栏治理中枢)
 * 
 * 深度对齐 Raycast Windows 任务栏控制规范：
 * - Win32 原生动作：Toggle Taskbar Visibility (一键显示/隐藏任务栏，基于 FindWindow("Shell_TrayWnd") + ShowWindow)
 * - Toggle Taskbar Auto-Hide (切换任务栏自动隐藏)
 * - 任务栏位置与对齐方式检视 (Windows 11 居中 / 靠左对齐)
 * - 快捷动作反馈与 Toast 提示
 * - 完善的多显示器协同与资源管理器刷新急救
 */

import React from "../../index.js";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  TaskbarState,
  TaskbarAlignment,
  TaskbarPosition
} from "./types.js";
import {
  defaultWindowsTaskbarManager
} from "./taskbar-service.js";

export * from "./types.js";
export * from "./taskbar-service.js";

export default function WindowsTaskbarCommand() {
  const [state, setState] = useState<TaskbarState>({
    visible: true,
    autoHide: false,
    position: "bottom",
    alignment: "center",
    size: "regular",
    multiMonitorEnabled: true,
    secondaryTrayCount: 1,
    lastModifiedAt: Date.now()
  });

  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    defaultWindowsTaskbarManager.getTaskbarState().then((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
    };
  }, [refreshCount]);

  const reloadState = () => {
    setRefreshCount((c) => c + 1);
  };

  const handleToggleVisibility = async () => {
    try {
      const res = await defaultWindowsTaskbarManager.toggleTaskbarVisibility();
      setState(res.state);
      await showToast(
        Toast.Style.Success,
        res.message,
        res.visible ? "所有显示器任务栏均已恢复" : "全屏沉浸模式已激活"
      );
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "切换任务栏显隐失败", err.message || String(err));
    }
  };

  const handleToggleAutoHide = async () => {
    try {
      const res = await defaultWindowsTaskbarManager.toggleTaskbarAutoHide();
      setState(res.state);
      await showToast(
        Toast.Style.Success,
        res.message,
        res.autoHide ? "鼠标移出后自动隐匿" : "任务栏永久固定可见"
      );
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "切换自动隐藏失败", err.message || String(err));
    }
  };

  const handleForceShow = async () => {
    try {
      const res = await defaultWindowsTaskbarManager.showTaskbar();
      setState(res.state);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "显示任务栏失败", err.message || String(err));
    }
  };

  const handleForceHide = async () => {
    try {
      const res = await defaultWindowsTaskbarManager.hideTaskbar();
      setState(res.state);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "隐藏任务栏失败", err.message || String(err));
    }
  };

  const handleToggleAlignment = async () => {
    const nextAlignment: TaskbarAlignment = state.alignment === "center" ? "start" : "center";
    try {
      const res = await defaultWindowsTaskbarManager.setTaskbarAlignment(nextAlignment);
      setState(res.state);
      await showToast(Toast.Style.Success, res.message, `当前对齐: ${nextAlignment === "center" ? "居中" : "靠左"}`);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "设置对齐方式失败", err.message || String(err));
    }
  };

  const handleSetDockPosition = async (position: "bottom" | "left" | "right") => {
    try {
      const res = await defaultWindowsTaskbarManager.setDockPosition(position);
      setState(res.state);
      await showToast(
        Toast.Style.Success,
        `Dock / 任务栏停靠位置已切换为 ${position.toUpperCase()}`,
        res.message
      );
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "切换停靠位置失败", err.message || String(err));
    }
  };

  const handleRestartDock = async () => {
    try {
      await showToast(Toast.Style.Animated, "正在重启 macOS Dock 程序坞...");
      const res = await defaultWindowsTaskbarManager.restartDock();
      setState(res.state);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "重启 Dock 失败", err.message || String(err));
    }
  };

  const handleRestartExplorer = async () => {
    try {
      await showToast(Toast.Style.Animated, "正在重启系统桌面壳层 (Explorer / Dock)...");
      const res = await defaultWindowsTaskbarManager.restartExplorer();
      setState(res.state);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "重启资源管理器失败", err.message || String(err));
    }
  };

  const handleSetAlignment = async (alignment: TaskbarAlignment) => {
    try {
      const res = await defaultWindowsTaskbarManager.setTaskbarAlignment(alignment);
      setState(res.state);
      await showToast(
        Toast.Style.Success,
        res.message,
        `当前对齐: ${alignment === "center" ? "居中 (Center)" : "靠左 (Left)"}`
      );
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "设置对齐方式失败", err.message || String(err));
    }
  };

  return (
    <List
      searchBarPlaceholder="治理系统任务栏与 macOS 程序坞 (Dock) 显隐、自动隐藏、停靠位置..."
      filterBar={{
        summaryText: `任务栏/Dock 状态: ${state.visible ? "显示中 (Visible)" : "已隐藏 (Hidden)"} · 自动隐藏: ${state.autoHide ? "已开启" : "常驻"} · 对齐: ${state.alignment === "center" ? "居中" : "靠左"}`,
        actions: [
          {
            id: "tb-act-visibility",
            label: "👁️ 切换任务栏/Dock显隐",
            title: "👁️ 切换任务栏/Dock显隐",
            style: "primary",
            onAction: () => {
              void handleToggleVisibility();
            }
          },
          {
            id: "tb-act-autohide",
            label: "🔄 切换自动隐藏",
            title: "🔄 切换自动隐藏",
            style: "secondary",
            onAction: () => {
              void handleToggleAutoHide();
            }
          },
          {
            id: "tb-act-align-left",
            label: "⬅️ 靠左对齐",
            title: "⬅️ 靠左对齐",
            style: "secondary",
            onAction: () => {
              void handleSetAlignment("start");
            }
          },
          {
            id: "tb-act-align-center",
            label: "🎯 居中对齐",
            title: "🎯 居中对齐",
            style: "secondary",
            onAction: () => {
              void handleSetAlignment("center");
            }
          },
          {
            id: "tb-act-restart",
            label: "♻️ 重启 Explorer / Dock",
            title: "♻️ 重启 Explorer / Dock",
            style: "danger",
            onAction: () => {
              void handleRestartExplorer();
            }
          }
        ]
      }}
    >
      {/* 1. 跨平台核心显隐与自动隐藏治理 */}
      <List.Section title="Win32 原生治理动作 (Core Actions)">
        <List.Item
          key="item-toggle-visibility"
          title="切换任务栏显隐 / 程序坞显隐 (Toggle Taskbar & Dock)"
          subtitle={`当前状态: ${state.visible ? "显示中 (Visible)" : "已隐藏 (Hidden)"} — Win32 ShowWindow / macOS Dock Autohide`}
          accessories={[
            {
              text: state.visible ? "VISIBLE" : "HIDDEN"
            }
          ]}
          actions={
            <ActionPanel title="任务栏与 Dock 显隐">
              <Action
                title="立即切换任务栏/Dock 显隐"
                icon={Icon.Eye}
                onAction={handleToggleVisibility}
              />
              <Action
                title="强制显示任务栏"
                icon={Icon.Window}
                onAction={handleForceShow}
              />
              <Action
                title="沉浸式隐藏任务栏"
                icon={Icon.XMarkCircle}
                onAction={handleForceHide}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-toggle-autohide"
          title="切换任务栏 / Dock 自动隐藏 (Toggle Auto-Hide)"
          subtitle={`当前状态: ${state.autoHide ? "已启用自动隐藏 (Auto-Hide)" : "常驻显示 (Always Visible)"} — SHAppBarMessage / Dock Preferences`}
          accessories={[
            {
              text: state.autoHide ? "AUTO-HIDE ON" : "ALWAYS ON"
            }
          ]}
          actions={
            <ActionPanel title="自动隐藏控制">
              <Action
                title="切换自动隐藏状态"
                icon={Icon.ArrowDown}
                onAction={handleToggleAutoHide}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-show-taskbar"
          title="强制显示任务栏 (Show Taskbar)"
          subtitle="还原主屏 (Shell_TrayWnd) 与副屏 (Shell_SecondaryTrayWnd) 任务栏窗口"
          accessories={[{ text: "SHOW" }]}
          actions={
            <ActionPanel title="显示任务栏">
              <Action
                title="强制显示任务栏"
                icon={Icon.Window}
                onAction={handleForceShow}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-hide-taskbar"
          title="沉浸式隐藏任务栏 (Hide Taskbar)"
          subtitle="隐藏所有显示器的系统任务栏，享受极致无边框沉浸体验"
          accessories={[{ text: "HIDE" }]}
          actions={
            <ActionPanel title="隐藏任务栏">
              <Action
                title="沉浸式隐藏任务栏"
                icon={Icon.XMarkCircle}
                onAction={handleForceHide}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* 2. macOS Dock 与任务栏位置及对齐治理 */}
      <List.Section title="macOS Dock 与任务栏位置治理 (Dock Position & Alignment)">
        <List.Item
          key="item-dock-bottom"
          title="停靠于屏幕底部 (Set Dock Position: Bottom)"
          subtitle="将 macOS 程序坞 / 任务栏停靠在屏幕底边"
          accessories={[{ text: state.position === "bottom" ? "ACTIVE" : "BOTTOM" }]}
          actions={
            <ActionPanel title="停靠位置">
              <Action
                title="停靠在底部 (Bottom)"
                icon={Icon.ArrowDown}
                onAction={() => handleSetDockPosition("bottom")}
              />
              <Action
                title="停靠在左侧 (Left)"
                icon={Icon.SidebarLeft}
                onAction={() => handleSetDockPosition("left")}
              />
              <Action
                title="停靠在右侧 (Right)"
                icon={Icon.SidebarRight}
                onAction={() => handleSetDockPosition("right")}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-dock-left"
          title="停靠于屏幕左侧 (Set Dock Position: Left)"
          subtitle="将 macOS 程序坞停靠在屏幕左边缘，释放纵向代码阅读视野"
          accessories={[{ text: state.position === "left" ? "ACTIVE" : "LEFT" }]}
          actions={
            <ActionPanel title="停靠位置">
              <Action
                title="停靠在左侧 (Left)"
                icon={Icon.SidebarLeft}
                onAction={() => handleSetDockPosition("left")}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-dock-right"
          title="停靠于屏幕右侧 (Set Dock Position: Right)"
          subtitle="将 macOS 程序坞停靠在屏幕右边缘"
          accessories={[{ text: state.position === "right" ? "ACTIVE" : "RIGHT" }]}
          actions={
            <ActionPanel title="停靠位置">
              <Action
                title="停靠在右侧 (Right)"
                icon={Icon.SidebarRight}
                onAction={() => handleSetDockPosition("right")}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-alignment"
          title={`任务栏图标对齐方式: ${state.alignment === "center" ? "居中 (Center)" : "靠左 (Left)"}`}
          subtitle="Windows 11 开始菜单与应用图标位置治理 (TaskbarAl)"
          accessories={[
            {
              text: state.alignment === "center" ? "CENTER" : "LEFT"
            }
          ]}
          actions={
            <ActionPanel title="对齐治理">
              <Action
                title={`切换为${state.alignment === "center" ? "靠左对齐" : "居中对齐"}`}
                icon={Icon.SidebarLeft}
                onAction={handleToggleAlignment}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* 3. 运维与急救 */}
      <List.Section title="系统级运维与急救 (Diagnostics & Recovery)">
        <List.Item
          key="item-restart-explorer"
          title="重启 Windows 资源管理器 (Restart Explorer)"
          subtitle="当任务栏卡顿、假死、图标空白或显隐异常时一键重启 explorer.exe 进程自愈"
          accessories={[{ text: "RELOAD" }]}
          actions={
            <ActionPanel title="资源管理器治理">
              <Action
                title="重启资源管理器进程"
                icon={Icon.RotateAntiClockwise}
                onAction={handleRestartExplorer}
              />
            </ActionPanel>
          }
        />

        <List.Item
          key="item-restart-dock"
          title="重启 macOS 程序坞 (Restart macOS Dock)"
          subtitle="执行 killall Dock 重置程序坞渲染与图标缓存"
          accessories={[{ text: "DOCK RELOAD" }]}
          actions={
            <ActionPanel title="程序坞急救">
              <Action
                title="重启 macOS Dock"
                icon={Icon.RotateClockwise}
                onAction={handleRestartDock}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
