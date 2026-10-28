import { isRealElectronHost } from '../shared/native-ipc.js';
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
  useNavigation
} from "../../index.js";
import { useState } from "../../runtime/hooks.js";
import {
  WingetPackage,
  SAMPLE_WINGET_PACKAGES,
  filterWingetPackages,
  installWingetPackage,
  upgradeWingetPackage,
  uninstallWingetPackage
} from "./packages.js";

export * from "./packages.js";

/**
 * 查看软件包详情视图 (现代纯正 TSX 模式)
 */
export function WingetDetailView({
  pkg,
  onPackageUpdated
}: {
  pkg: WingetPackage;
  onPackageUpdated?: (updated: WingetPackage) => void;
}) {
  const installCmd = `winget install --id ${pkg.id} -e --accept-package-agreements --accept-source-agreements`;
  const upgradeCmd = `winget upgrade --id ${pkg.id}`;
  const uninstallCmd = `winget uninstall --id ${pkg.id}`;

  const markdown = `
# ${pkg.name}

> **包标识 ID**: \`${pkg.id}\` | **开发商**: \`${pkg.publisher}\`

### 软件简介
${pkg.description}

---

### 终端安装与管理命令
\`\`\`powershell
# 一键安装
${installCmd}

# 升级最新版本
${upgradeCmd}

# 卸载清理
${uninstallCmd}
\`\`\`

---

### 分类与标签
${pkg.tags.map((t) => `\`#${t}\``).join(" ")}
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`${pkg.name} (${pkg.id})`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="包 ID" text={pkg.id} icon={Icon.Key} />
          <Detail.Metadata.Label title="开发商" text={pkg.publisher} icon={Icon.Document} />
          <Detail.Metadata.Label
            title="已安装版本"
            text={pkg.installedVersion || "未安装"}
            icon={Icon.Pin}
          />
          <Detail.Metadata.Label title="最新可用版本" text={pkg.latestVersion} icon={Icon.Upload} />
          <Detail.Metadata.Label title="开源协议" text={pkg.license} icon={Icon.Document} />
          <Detail.Metadata.Label title="分发源" text={pkg.source || "winget"} icon={Icon.Globe} />
          <Detail.Metadata.Label title="架构支持" text={pkg.architecture} icon={Icon.Terminal} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="状态">
            <Detail.Metadata.TagList.Item
              text={
                pkg.status === "installed"
                  ? "已是最新版本"
                  : pkg.status === "upgradable"
                  ? `可升级至 v${pkg.latestVersion}`
                  : "未安装"
              }
              color={
                pkg.status === "installed"
                  ? Color.Green
                  : pkg.status === "upgradable"
                  ? Color.Yellow
                  : Color.SecondaryText
              }
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="软件包操作">
          {pkg.status === "upgradable" && (
            <Action
              title="一键升级到最新版"
              icon={Icon.Upload}
              onAction={async () => {
                const updated: WingetPackage = {
                  ...pkg,
                  installedVersion: pkg.latestVersion,
                  status: "installed"
                };
                onPackageUpdated?.(updated);
                await showToast(Toast.Style.Success, `已升级 ${pkg.name}`, `版本升级至 ${pkg.latestVersion}`);
              }}
            />
          )}
          {pkg.status === "available" && (
            <Action
              title="一键安装此软件"
              icon={Icon.Download}
              onAction={async () => {
                const updated: WingetPackage = {
                  ...pkg,
                  installedVersion: pkg.latestVersion,
                  status: "installed"
                };
                onPackageUpdated?.(updated);
                await showToast(Toast.Style.Success, `已安装 ${pkg.name}`, `成功安装版本 ${pkg.latestVersion}`);
              }}
            />
          )}
          {pkg.status !== "available" && (
            <Action
              title="卸载此软件"
              icon={Icon.Trash}
              onAction={async () => {
                const updated: WingetPackage = {
                  ...pkg,
                  installedVersion: null,
                  status: "available"
                };
                onPackageUpdated?.(updated);
                await showToast(Toast.Style.Success, `已卸载 ${pkg.name}`);
              }}
            />
          )}
          <Action.CopyToClipboard
            title="复制 Winget 安装命令"
            content={installCmd}
            icon={Icon.CopyClipboard}
          />
          <Action.CopyToClipboard
            title="复制 Winget 升级命令"
            content={upgradeCmd}
            icon={Icon.Upload}
          />
          <Action.CopyToClipboard
            title="复制软件包 ID"
            content={pkg.id}
            icon={Icon.Key}
          />
          <Action.OpenInBrowser
            title="访问软件官方网站"
            url={pkg.homepage}
            icon={Icon.Globe}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * Winget 包管理器前端主命令 (现代纯正 TSX 模式)
 */
export default function WingetCommand() {
  const [packages, setPackages] = useState<WingetPackage[]>(isRealElectronHost() ? [] : SAMPLE_WINGET_PACKAGES);
  const [filterType, setFilterType] = useState<string>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [isShowingDetail, setIsShowingDetail] = useState<boolean>(true);
  const { push } = useNavigation();

  const filtered = filterWingetPackages(packages, searchText, filterType);

  const handleInstall = async (pkg: WingetPackage) => {
    setPackages((prev) => installWingetPackage(prev, pkg.id));
    await showToast(Toast.Style.Success, `正在安装 ${pkg.name}`, `已执行 winget install --id ${pkg.id} -e`);
  };

  const handleUpgrade = async (pkg: WingetPackage) => {
    setPackages((prev) => upgradeWingetPackage(prev, pkg.id));
    await showToast(Toast.Style.Success, `正在升级 ${pkg.name}`, `已升级到最新版 ${pkg.latestVersion}`);
  };

  const handleUninstall = async (pkg: WingetPackage) => {
    setPackages((prev) => uninstallWingetPackage(prev, pkg.id));
    await showToast(Toast.Style.Success, `正在卸载 ${pkg.name}`, `已从系统移除该应用`);
  };

  return (
    <List
      navigationTitle="Windows 包管理器 (Winget)"
      searchBarPlaceholder="搜索全网软件包 (例如: VS Code, Git, Chrome, Node, Bun)..."
      searchText={searchText}
      isShowingDetail={isShowingDetail}
      onSearchTextChange={(val) => setSearchText(val)}
      searchBarAccessory={
        <List.Dropdown
          tooltip="筛选软件包状态"
          value={filterType}
          onChange={(newVal) => setFilterType(newVal)}
        >
          <List.Dropdown.Item title="全部软件包 (All Packages)" value="all" />
          <List.Dropdown.Item title="可更新 (Upgradable)" value="upgradable" />
          <List.Dropdown.Item title="已安装 (Installed)" value="installed" />
          <List.Dropdown.Item title="未安装 (Available)" value="available" />
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="全局操作">
          <Action
            title="刷新软件包清单"
            icon={Icon.Repeat}
            onAction={async () => {
              await showToast(Toast.Style.Success, "已刷新 Winget 本地源清单");
            }}
          />
          <Action
            title={isShowingDetail ? "隐藏详情侧边栏" : "显示详情侧边栏"}
            icon={Icon.Sidebar}
            onAction={() => setIsShowingDetail((prev) => !prev)}
          />
        </ActionPanel>
      }
    >
      <List.Section title={`软件包列表 (${filtered.length})`}>
        {filtered.map((pkg) => {
          const isUpgradable = pkg.status === "upgradable";
          const isInstalled = pkg.status === "installed";

          return (
            <List.Item
              key={pkg.id}
              id={pkg.id}
              title={pkg.name}
              subtitle={`${pkg.id} (${pkg.publisher})`}
              icon={isInstalled ? Icon.Checkmark : isUpgradable ? Icon.Upload : Icon.Download}
              accessories={[
                ...(isUpgradable
                  ? [
                      { text: `v${pkg.installedVersion} ➔ v${pkg.latestVersion}` },
                      { text: "可升级", tag: "upgradable" }
                    ]
                  : isInstalled
                  ? [{ text: `v${pkg.installedVersion}` }, { text: "已安装", tag: "installed" }]
                  : [{ text: `v${pkg.latestVersion}` }, { text: "未安装" }])
              ]}
              detail={
                <List.Item.Detail
                  markdown={`# ${pkg.name}\n\n> ${pkg.description}\n\n---\n\n### 终端命令参考\n\`\`\`powershell\n# 一键安装\nwinget install --id ${pkg.id} -e\n\n# 升级最新版\nwinget upgrade --id ${pkg.id} -e\n\n# 卸载清理\nwinget uninstall --id ${pkg.id} -e\n\`\`\`\n\n### 官方网站\n[${pkg.homepage}](${pkg.homepage})`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="软件包 ID" text={pkg.id} icon={Icon.Key} />
                      <List.Item.Detail.Metadata.Label title="发布者" text={pkg.publisher} icon={Icon.Pencil} />
                      <List.Item.Detail.Metadata.Label title="最新版本" text={pkg.latestVersion} icon={Icon.Check} />
                      <List.Item.Detail.Metadata.Label
                        title="已安装版本"
                        text={pkg.installedVersion || "未安装"}
                        icon={Icon.Clock}
                      />
                      <List.Item.Detail.Metadata.Label title="开源许可证" text={pkg.license} icon={Icon.Document} />
                      <List.Item.Detail.Metadata.Label title="分发源" text={pkg.source || "winget"} icon={Icon.Globe} />
                      <List.Item.Detail.Metadata.Label title="系统架构" text={pkg.architecture} icon={Icon.Terminal} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={
                            pkg.status === "installed"
                              ? "已安装 (Installed)"
                              : pkg.status === "upgradable"
                              ? `可升级至 v${pkg.latestVersion}`
                              : "可安装 (Available)"
                          }
                          color={
                            pkg.status === "installed"
                              ? Color.Green
                              : pkg.status === "upgradable"
                              ? Color.Yellow
                              : Color.SecondaryText
                          }
                        />
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={pkg.name}>
                  {isUpgradable && (
                    <Action
                      title="一键升级到最新版"
                      icon={Icon.Upload}
                      onAction={() => handleUpgrade(pkg)}
                    />
                  )}
                  {!isInstalled && !isUpgradable && (
                    <Action
                      title="一键安装此软件"
                      icon={Icon.Download}
                      onAction={() => handleInstall(pkg)}
                    />
                  )}
                  {(isInstalled || isUpgradable) && (
                    <Action
                      title="卸载此软件"
                      icon={Icon.Trash}
                      onAction={() => handleUninstall(pkg)}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="复制 Winget 安装命令"
                    content={`winget install --id ${pkg.id} -e`}
                    icon={Icon.CopyClipboard}
                  />
                  <Action.CopyToClipboard
                    title="复制 Winget 升级命令"
                    content={`winget upgrade --id ${pkg.id} -e`}
                    icon={Icon.Upload}
                  />
                  <Action.CopyToClipboard
                    title="复制软件包 ID"
                    content={pkg.id}
                    icon={Icon.Key}
                  />
                  <Action.OpenInBrowser
                    title="访问软件官方网站"
                    url={pkg.homepage}
                    icon={Icon.Globe}
                  />
                  <Action.Push
                    title="查看包详细版本描述"
                    icon={Icon.Eye}
                    target={() => (
                      <WingetDetailView
                        pkg={pkg}
                        onPackageUpdated={(u) =>
                          setPackages((prev) => prev.map((p) => (p.id === u.id ? u : p)))
                        }
                      />
                    )}
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
