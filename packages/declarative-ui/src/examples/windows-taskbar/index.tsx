/**
 * Windows Taskbar (任务栏治理中枢)
 * 
 * 功能概览：
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
  TaskbarActionResult
} from "./types.js";
import {
  WindowsTaskbarManager,
  defaultWindowsTaskbarManager,
  describeTaskbarFailure
} from "./taskbar-service.js";

export * from "./types.js";
export * from "./taskbar-service.js";

export default function WindowsTaskbarCommand(props?: { manager?: WindowsTaskbarManager } | null) {
  // 宿主渲染命令时可能传入启动参数或 null，只认测试注入的 manager
  const manager = props?.manager instanceof WindowsTaskbarManager ? props.manager : defaultWindowsTaskbarManager;
  // 只展示当前平台宿主真正实现了的动作（Windows：显示 / 隐藏；macOS：Dock 自动隐藏、停靠位置、重启 Dock）
  const caps = manager.getCapabilities();
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
    manager.getTaskbarState().then((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
    };
  }, [refreshCount]);

  const reloadState = () => {
    setRefreshCount((c) => c + 1);
  };

  /**
   * 统一展示操作结果：只有宿主确认成功才弹成功提示，失败时弹失败提示并附上真实原因
   */
  const reportResult = async (res: TaskbarActionResult, successDetail?: string) => {
    setState(res.state);
    if (res.success) {
      await showToast(Toast.Style.Success, res.message, successDetail);
    } else {
      await showToast(Toast.Style.Failure, res.message, describeTaskbarFailure(res));
    }
  };

  const runAction = async (action: () => Promise<TaskbarActionResult>, failureTitle: string, successDetail?: (res: TaskbarActionResult) => string | undefined) => {
    try {
      const res = await action();
      await reportResult(res, successDetail?.(res));
    } catch (err: unknown) {
      await showToast(Toast.Style.Failure, failureTitle, err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleVisibility = () =>
    runAction(
      () => manager.toggleTaskbarVisibility(),
      "切换任务栏显隐失败",
      (res) => (res.visible ? "任务栏 / Dock 已恢复显示" : "任务栏 / Dock 已隐藏")
    );

  const handleToggleAutoHide = () =>
    runAction(
      () => manager.toggleTaskbarAutoHide(),
      "切换自动隐藏失败",
      (res) => (res.autoHide ? "鼠标移出后自动隐藏" : "保持常驻显示")
    );

  const handleForceShow = () => runAction(() => manager.showTaskbar(), "显示任务栏失败");

  const handleForceHide = () => runAction(() => manager.hideTaskbar(), "隐藏任务栏失败");

  const handleSetAlignment = (alignment: TaskbarAlignment) =>
    runAction(() => manager.setTaskbarAlignment(alignment), "设置对齐方式失败");

  const handleSetDockPosition = (position: "bottom" | "left" | "right") =>
    runAction(() => manager.setDockPosition(position), "切换停靠位置失败");

  const handleRestartDock = async () => {
    await showToast(Toast.Style.Animated, "正在重启 macOS Dock 程序坞...");
    await runAction(() => manager.restartDock(), "重启 Dock 失败");
  };

  const handleRestartExplorer = async () => {
    await showToast(Toast.Style.Animated, "正在重启系统桌面壳层 (Explorer / Dock)...");
    await runAction(() => manager.restartExplorer(), "重启资源管理器失败");
  };

  return (
    <List
      searchBarPlaceholder="治理系统任务栏与 macOS 程序坞 (Dock) 显隐、自动隐藏、停靠位置..."
      filterBar={{
        summaryText: `任务栏/Dock 状态: ${state.visible ? "显示中 (Visible)" : "已隐藏 (Hidden)"}${caps.autoHide ? ` · 自动隐藏: ${state.autoHide ? "已开启" : "常驻"}` : ""}`,
        actions: [
          {
            id: "tb-act-visibility",
            label: "切换任务栏/Dock显隐",
            title: "切换任务栏/Dock显隐",
            style: "primary",
            onAction: () => {
              void handleToggleVisibility();
            }
          },
          caps.autoHide && {
            id: "tb-act-autohide",
            label: "切换自动隐藏",
            title: "切换自动隐藏",
            style: "secondary",
            onAction: () => {
              void handleToggleAutoHide();
            }
          },
          caps.alignment && {
            id: "tb-act-align-left",
            label: "靠左对齐",
            title: "靠左对齐",
            style: "secondary",
            onAction: () => {
              void handleSetAlignment("start");
            }
          },
          caps.alignment && {
            id: "tb-act-align-center",
            label: "居中对齐",
            title: "居中对齐",
            style: "secondary",
            onAction: () => {
              void handleSetAlignment("center");
            }
          },
          (caps.restartExplorer || caps.restartDock) && {
            id: "tb-act-restart",
            label: caps.restartExplorer ? "重启 Explorer" : "重启 Dock",
            title: caps.restartExplorer ? "重启 Explorer" : "重启 Dock",
            style: "danger",
            onAction: () => {
              void (caps.restartExplorer ? handleRestartExplorer() : handleRestartDock());
            }
          }
        ].filter(<T,>(action: T | false): action is T => Boolean(action))
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

        {caps.autoHide && (
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
        )}

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

      {/* 2. macOS Dock 停靠位置（仅 macOS；Windows 任务栏对齐宿主未实现，不展示） */}
      {caps.dockPosition && (
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

      </List.Section>
      )}

      {/* 3. 运维与急救（只展示宿主实现了的重启动作） */}
      {(caps.restartExplorer || caps.restartDock) && (
      <List.Section title="系统级运维与急救 (Diagnostics & Recovery)">
        {caps.restartExplorer && (
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
        )}

        {caps.restartDock && (
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
        )}
      </List.Section>
      )}
    </List>
  );
}
