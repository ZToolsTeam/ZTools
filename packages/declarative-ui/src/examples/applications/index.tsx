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
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import { ApplicationRecord, ApplicationCategory, ApplicationActionResult } from "./types.js";
import {
  ApplicationsManager,
  defaultApplicationsManager,
  INITIAL_APPLICATIONS,
  computePinyin
} from "./applications-service.js";

export * from "./types.js";
export * from "./applications-service.js";

/**
 * 格式化文件大小 (KB 转 MB/GB)
 */
function formatSizeKb(kb?: number): string {
  if (!kb || kb <= 0) return "—";
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 根据应用属性与分类获取视觉 Icon
 */
function getAppIcon(app: ApplicationRecord): Icon {
  if (app.isGame) return Icon.Star;
  if (app.category === "developer") return Icon.Code;
  if (app.isUwp) return Icon.AppWindow;
  if (app.category === "system") return Icon.Gear;
  return Icon.AppWindow;
}

/**
 * 应用程序详情视图 (Raycast 1:1 对齐 Markdown 与右侧 Metadata 侧边栏)
 */
export function AppDetailView({
  app,
  manager = defaultApplicationsManager
}: {
  app: ApplicationRecord;
  manager?: ApplicationsManager;
}) {
  const [currentApp, setCurrentApp] = useState<ApplicationRecord>(app);

  const leftoversSection =
    currentApp.leftoverPaths && currentApp.leftoverPaths.length > 0
      ? `\n### 🧹 macOS 关联残留与缓存路径 (App Leftovers)\n${currentApp.leftoverPaths
          .map((p) => `- \`${p}\``)
          .join("\n")}\n`
      : "";

  const markdown = `
# ${currentApp.name}

> **发布者**: ${currentApp.publisher || "未知开发商"} | **版本**: \`v${currentApp.version || "1.0.0"}\` | **架构**: \`${currentApp.architecture.toUpperCase()}\`

---

### 📂 文件系统与执行路径
- **可执行文件路径**: \`${currentApp.path}\`
- **安装根目录**: \`${currentApp.installLocation || "系统默认或内置目录"}\`
- **磁盘占用估计**: \`${formatSizeKb(currentApp.estimatedSizeKb)}\`
- **包标识符 (Package / Bundle ID)**: \`${currentApp.bundleId || currentApp.id}\`

### ⚡ 进程与运行状态
- **当前运行状态**: ${currentApp.isRunning ? `🟢 **正在运行** (PID: \`${currentApp.pid}\`)` : "⚪ **已停止**"}
- **游戏模式标记**: ${currentApp.isGame ? "🎮 已作为游戏管理 (Treat as Game)" : "普通桌面程序"}
- **空闲自动退出**: ${currentApp.autoQuitEnabled ? "⏱️ 已启用" : "未开启"}
- **类型模式**: ${currentApp.isUwp ? "UWP 现代化应用 (AppContainer 沙箱)" : currentApp.path.endsWith(".app") ? "macOS Application Bundle (.app)" : "Win32 经典应用程序"}

### 🛠️ 卸载与治理信息
${
  currentApp.isSystemComponent && !currentApp.uninstallString
    ? "> ⚠️ 该应用程序属于操作系统受保护核心组件 (Windows System / macOS /System/Applications)，不可随意卸载。"
    : `- **卸载指令**: \`${currentApp.uninstallString || (currentApp.isUwp ? "Windows Store / Remove-AppxPackage" : currentApp.path.endsWith(".app") ? "Move .app & ~/Library Leftovers to Trash" : "未知")}\``
}
${leftoversSection}`;

  const handleOpen = async (runAsAdmin = false) => {
    const res = await manager.openApplication(currentApp, { runAsAdmin });
    if (res.success) {
      if (res.app) setCurrentApp(res.app);
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleTerminate = async (force = false) => {
    const res = await manager.terminateApplication(currentApp, force);
    if (res.success) {
      if (res.app) setCurrentApp(res.app);
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleRestart = async () => {
    const res = await manager.restartApplication(currentApp);
    if (res.success) {
      if (res.app) setCurrentApp(res.app);
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleUninstall = async () => {
    const res = await manager.uninstallApplication(currentApp);
    if (res.success) {
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleToggleGame = () => {
    const res = manager.toggleGameStatus(currentApp);
    if (res.app) setCurrentApp(res.app);
    void showToast(Toast.Style.Success, res.message);
  };

  const handleToggleAutoQuit = () => {
    const res = manager.toggleAutoQuit(currentApp);
    if (res.app) setCurrentApp(res.app);
    void showToast(Toast.Style.Success, res.message);
  };

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`应用详情: ${currentApp.name}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="应用名称" text={currentApp.name} icon={getAppIcon(currentApp)} />
          <Detail.Metadata.Label title="发布商" text={currentApp.publisher} icon={Icon.Globe} />
          <Detail.Metadata.Label title="版本号" text={currentApp.version} icon={Icon.Document} />
          <Detail.Metadata.Label title="系统架构" text={currentApp.architecture.toUpperCase()} icon={Icon.HardDrive} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="进程状态"
            text={currentApp.isRunning ? `运行中 (PID: ${currentApp.pid})` : "已停止"}
            icon={currentApp.isRunning ? Icon.Checkmark : Icon.XMarkCircle}
          />
          <Detail.Metadata.Label
            title="磁盘占用"
            text={formatSizeKb(currentApp.estimatedSizeKb)}
            icon={Icon.HardDrive}
          />
          <Detail.Metadata.TagList title="分类标签">
            <Detail.Metadata.TagList.Item
              text={currentApp.category.toUpperCase()}
              color={currentApp.category === "developer" ? Color.Purple : Color.Blue}
            />
            {currentApp.isRunning && (
              <Detail.Metadata.TagList.Item text="RUNNING" color={Color.Green} />
            )}
            {currentApp.isGame && (
              <Detail.Metadata.TagList.Item text="GAME" color={Color.Yellow} />
            )}
            {currentApp.isUwp && (
              <Detail.Metadata.TagList.Item text="UWP" color={Color.Orange} />
            )}
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title={currentApp.name}>
          <ActionPanel.Section title="常规动作">
            <Action title="打开应用" icon={Icon.AppWindow} onAction={() => handleOpen(false)} />
            <Action
              title="以管理员身份运行"
              icon={Icon.Shield}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "enter" }}
              onAction={() => handleOpen(true)}
            />
            <Action
              title="在资源管理器中定位"
              icon={Icon.Folder}
              shortcut={{ modifiers: ["ctrl"], key: "enter" }}
              onAction={async () => {
                const res = await manager.revealApplication(currentApp);
                await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
              }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="快捷复制">
            <Action.CopyToClipboard
              title="复制安装路径"
              content={currentApp.path}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
            />
            <Action.CopyToClipboard
              title="复制应用名称"
              content={currentApp.name}
              shortcut={{ modifiers: ["ctrl"], key: "c" }}
            />
            <Action.CopyToClipboard
              title="复制包标识符"
              content={currentApp.bundleId || currentApp.id}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "b" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="进程与生命周期">
            <Action
              title="优雅退出应用"
              icon={Icon.XMarkCircle}
              shortcut={{ modifiers: ["ctrl"], key: "q" }}
              onAction={() => handleTerminate(false)}
            />
            <Action
              title="强制结束进程"
              icon={Icon.Trash}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "q" }}
              onAction={() => handleTerminate(true)}
            />
            <Action
              title="重启应用程序"
              icon={Icon.Repeat}
              shortcut={{ modifiers: ["ctrl"], key: "r" }}
              onAction={handleRestart}
            />
            <Action
              title={currentApp.autoQuitEnabled ? "禁用空闲自动退出" : "启用空闲自动退出"}
              icon={Icon.Clock}
              onAction={handleToggleAutoQuit}
            />
            <Action
              title={currentApp.isGame ? "取消游戏标记" : "标记为游戏 (Treat as Game)"}
              icon={Icon.Star}
              onAction={handleToggleGame}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="系统治理">
            <Action
              title="启动官方卸载程序"
              icon={Icon.Trash}
              style="destructive"
              shortcut={{ modifiers: ["ctrl"], key: "backspace" }}
              onAction={handleUninstall}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

/**
 * 根命令：已安装应用程序管理中枢 (Raycast 1:1 对齐)
 */
export default function ApplicationsCommand({
  manager = defaultApplicationsManager
}: {
  manager?: ApplicationsManager;
} = {}) {
  const [searchText, setSearchText] = useState("");
  const [category, setCategory] = useState<ApplicationCategory>("all");
  const [apps, setApps] = useState<ApplicationRecord[]>(() =>
    isRealElectronHost() ? [] : INITIAL_APPLICATIONS
  );
  const [isLoading, setIsLoading] = useState(() => isRealElectronHost());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    void manager.getApplications().then((loaded) => {
      if (mounted) {
        setApps(loaded);
        setIsLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [manager]);

  const filteredApps = useMemo(() => {
    return manager.filterAndSearch(apps, searchText, category);
  }, [apps, searchText, category, manager]);

  const activeApp = useMemo(() => {
    return filteredApps.find((a) => a.id === selectedId) || filteredApps[0];
  }, [filteredApps, selectedId]);

  const handleRescan = async () => {
    setIsLoading(true);
    try {
      const loaded = await manager.getApplications(true);
      setApps(loaded);
      await showToast(Toast.Style.Success, `已重新扫描应用程序 (${loaded.length} 款)`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenApp = async (app: ApplicationRecord, runAsAdmin = false) => {
    const res = await manager.openApplication(app, { runAsAdmin });
    if (res.success) {
      if (res.app) {
        setApps((prev) => prev.map((a) => (a.id === app.id ? res.app! : a)));
      }
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleTerminateApp = async (app: ApplicationRecord, force = false) => {
    const res = await manager.terminateApplication(app, force);
    if (res.success) {
      if (res.app) {
        setApps((prev) => prev.map((a) => (a.id === app.id ? res.app! : a)));
      }
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleRestartApp = async (app: ApplicationRecord) => {
    const res = await manager.restartApplication(app);
    if (res.success) {
      if (res.app) {
        setApps((prev) => prev.map((a) => (a.id === app.id ? res.app! : a)));
      }
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleUninstallApp = async (app: ApplicationRecord) => {
    const res = await manager.uninstallApplication(app);
    if (res.success) {
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleToggleGame = (app: ApplicationRecord) => {
    const res = manager.toggleGameStatus(app);
    if (res.app) {
      setApps((prev) => prev.map((a) => (a.id === app.id ? res.app! : a)));
    }
    void showToast(Toast.Style.Success, res.message);
  };

  const handleToggleAutoQuit = (app: ApplicationRecord) => {
    const res = manager.toggleAutoQuit(app);
    if (res.app) {
      setApps((prev) => prev.map((a) => (a.id === app.id ? res.app! : a)));
    }
    void showToast(Toast.Style.Success, res.message);
  };

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="搜索已安装应用 (支持名称、拼音与分类筛选)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `已安装应用 ${filteredApps.length} 款 • 当前筛选状态: ${category.toUpperCase()}`,
        groups: [
          {
            id: "category",
            label: "应用分类",
            value: category,
            onChange: (val: string) => setCategory(val as ApplicationCategory),
            options: [
              { value: "all", label: "全部" },
              { value: "installed", label: "自装应用" },
              { value: "developer", label: "开发者工具" },
              { value: "system", label: "系统工具" },
              { value: "running", label: "正在运行" }
            ]
          }
        ],
        actions: [
          {
            id: "launch-app",
            label: "🚀 启动选中应用",
            title: "🚀 启动选中应用",
            style: "primary",
            onAction: () => {
              if (activeApp) void handleOpenApp(activeApp, false);
            }
          },
          {
            id: "run-admin",
            label: "🛡️ 管理员运行",
            title: "🛡️ 管理员运行",
            style: "secondary",
            onAction: () => {
              if (activeApp) void handleOpenApp(activeApp, true);
            }
          },
          {
            id: "open-dir",
            label: "📂 打开安装目录",
            title: "📂 打开安装目录",
            style: "secondary",
            onAction: async () => {
              if (activeApp) {
                const res = await manager.revealApplication(activeApp);
                await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
              }
            }
          },
          {
            id: "uninstall-app",
            label: "🗑️ 卸载应用",
            title: "🗑️ 卸载应用",
            style: "danger",
            onAction: () => {
              if (activeApp) void handleUninstallApp(activeApp);
            }
          },
          {
            id: "rescan-apps",
            label: "🔄 重新扫描",
            title: "🔄 重新扫描",
            style: "secondary",
            onAction: () => {
              void handleRescan();
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="应用分类与筛选"
          value={category}
          onChange={(val: string) => setCategory(val as ApplicationCategory)}
        >
          <List.Dropdown.Section title="分类筛选">
            <List.Dropdown.Item title="全部应用 (All)" value="all" />
            <List.Dropdown.Item title="用户自装应用 (Installed)" value="installed" />
            <List.Dropdown.Item title="系统组件与工具 (System Tools)" value="system" />
            <List.Dropdown.Item title="开发者工具 (Developer)" value="developer" />
            <List.Dropdown.Item title="游戏与娱乐 (Games)" value="game" />
            <List.Dropdown.Item title="正在运行应用 (Running)" value="running" />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {filteredApps.map((app) => {
        const appIcon = getAppIcon(app);
        const subtitleText = app.publisher ? `${app.publisher} • v${app.version}` : `v${app.version}`;

        const accessories: any[] = [
          { text: app.architecture.toUpperCase() }
        ];

        if (app.isRunning) {
          accessories.push({
            text: "运行中",
            icon: Icon.Checkmark
          });
        }
        if (app.isGame) {
          accessories.push({
            text: "游戏",
            icon: Icon.Star
          });
        }
        if (app.isUwp) {
          accessories.push({
            text: "UWP"
          });
        }

        return (
          <List.Item
            key={app.id}
            id={app.id}
            title={app.name}
            subtitle={subtitleText}
            icon={appIcon}
            accessories={accessories}
            actions={
              <ActionPanel title={app.name}>
                <ActionPanel.Section title="常规动作">
                  <Action
                    title="打开应用"
                    icon={Icon.AppWindow}
                    onAction={() => handleOpenApp(app, false)}
                  />
                  <Action
                    title="以管理员身份运行"
                    icon={Icon.Shield}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "enter" }}
                    onAction={() => handleOpenApp(app, true)}
                  />
                  <Action
                    title="在资源管理器中定位"
                    icon={Icon.Folder}
                    shortcut={{ modifiers: ["ctrl"], key: "enter" }}
                    onAction={async () => {
                      const res = await manager.revealApplication(app);
                      await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
                    }}
                  />
                  <Action.Push
                    title="查看应用详细属性"
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "i" }}
                    target={<AppDetailView app={app} manager={manager} />}
                  />
                </ActionPanel.Section>

                <ActionPanel.Section title="快捷复制">
                  <Action.CopyToClipboard
                    title="复制安装路径"
                    content={app.path}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="复制应用名称"
                    content={app.name}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="复制包标识符"
                    content={app.bundleId || app.id}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "b" }}
                  />
                </ActionPanel.Section>

                <ActionPanel.Section title="进程与生命周期">
                  <Action
                    title="优雅退出应用"
                    icon={Icon.XMarkCircle}
                    shortcut={{ modifiers: ["ctrl"], key: "q" }}
                    onAction={() => handleTerminateApp(app, false)}
                  />
                  <Action
                    title="强制结束进程"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "q" }}
                    onAction={() => handleTerminateApp(app, true)}
                  />
                  <Action
                    title="重启应用程序"
                    icon={Icon.Repeat}
                    shortcut={{ modifiers: ["ctrl"], key: "r" }}
                    onAction={() => handleRestartApp(app)}
                  />
                  <Action
                    title={app.autoQuitEnabled ? "禁用空闲自动退出" : "启用空闲自动退出"}
                    icon={Icon.Clock}
                    onAction={() => handleToggleAutoQuit(app)}
                  />
                  <Action
                    title={app.isGame ? "取消游戏标记" : "标记为游戏 (Treat as Game)"}
                    icon={Icon.Star}
                    onAction={() => handleToggleGame(app)}
                  />
                </ActionPanel.Section>

                <ActionPanel.Section title="系统治理">
                  <Action
                    title="启动官方卸载程序"
                    icon={Icon.Trash}
                    style="destructive"
                    shortcut={{ modifiers: ["ctrl"], key: "backspace" }}
                    onAction={() => handleUninstallApp(app)}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
