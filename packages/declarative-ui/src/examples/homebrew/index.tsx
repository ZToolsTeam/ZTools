/**
 * Homebrew (macOS Formulae & Casks 极客包管理工作台)
 *
 * 深度对齐 Raycast 官方 `brew` 套件（对标 Windows 端 `winget`）：
 * - 支持检索、安装、升级、卸载 Homebrew Formulae (CLI) 与 Casks (GUI 应用)
 * - 顶部 <List.Dropdown> 筛选：all / installed / outdated / formula / cask
 * - 对接主进程 `brew_exec` 安全受控通道（action: list | search | info | outdated | install | upgrade | uninstall | cleanup）
 */

import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export type HomebrewFilterCategory =
  | "all"
  | "installed"
  | "outdated"
  | "formula"
  | "cask";

export interface HomebrewPackage {
  readonly name: string;
  readonly fullName: string;
  readonly type: "formula" | "cask";
  readonly installedVersion?: string;
  readonly latestVersion: string;
  readonly outdated: boolean;
  readonly pinned?: boolean;
  readonly description: string;
  readonly homepage: string;
  readonly license: string;
  readonly tap: string;
  readonly dependencies: readonly string[];
}

export const SAMPLE_HOMEBREW_PACKAGES: readonly HomebrewPackage[] = Object.freeze([
  {
    name: "ripgrep",
    fullName: "ripgrep",
    type: "formula",
    installedVersion: "14.1.0",
    latestVersion: "14.1.1",
    outdated: true,
    description: "Line-oriented search tool that recursively searches the current directory for a regex pattern",
    homepage: "https://github.com/BurntSushi/ripgrep",
    license: "MIT / Unlicense",
    tap: "homebrew/core",
    dependencies: ["pcre2"]
  },
  {
    name: "node",
    fullName: "node",
    type: "formula",
    installedVersion: "22.9.0",
    latestVersion: "22.9.0",
    outdated: false,
    description: "Platform built on V8 to build network applications",
    homepage: "https://nodejs.org/",
    license: "MIT",
    tap: "homebrew/core",
    dependencies: ["brotli", "c-ares", "icu4c", "libnghttp2", "libuv", "openssl@3"]
  },
  {
    name: "jq",
    fullName: "jq",
    type: "formula",
    installedVersion: "1.7.1",
    latestVersion: "1.7.1",
    outdated: false,
    description: "Lightweight and flexible command-line JSON processor",
    homepage: "https://jqlang.github.io/jq/",
    license: "MIT",
    tap: "homebrew/core",
    dependencies: ["oniguruma"]
  },
  {
    name: "visual-studio-code",
    fullName: "visual-studio-code",
    type: "cask",
    installedVersion: "1.94.0",
    latestVersion: "1.95.1",
    outdated: true,
    description: "Open-source code editor by Microsoft",
    homepage: "https://code.visualstudio.com/",
    license: "MIT",
    tap: "homebrew/cask",
    dependencies: []
  },
  {
    name: "iterm2",
    fullName: "iterm2",
    type: "cask",
    installedVersion: "3.5.5",
    latestVersion: "3.5.5",
    outdated: false,
    description: "Terminal emulator as alternative to Apple's Terminal app",
    homepage: "https://iterm2.com/",
    license: "GPL-2.0-or-later",
    tap: "homebrew/cask",
    dependencies: []
  },
  {
    name: "orbstack",
    fullName: "orbstack",
    type: "cask",
    latestVersion: "1.7.5",
    outdated: false,
    description: "Drop-in replacement for Docker Desktop on macOS (fast, light, native)",
    homepage: "https://orbstack.dev/",
    license: "Proprietary",
    tap: "homebrew/cask",
    dependencies: []
  },
  {
    name: "ffmpeg",
    fullName: "ffmpeg",
    type: "formula",
    latestVersion: "7.1",
    outdated: false,
    description: "Play, record, convert, and stream audio and video",
    homepage: "https://ffmpeg.org/",
    license: "GPL-2.0-or-later",
    tap: "homebrew/core",
    dependencies: ["dav1d", "flac", "lame", "libass", "libvorbis", "libvpx", "opus", "x264", "x265"]
  },
  {
    name: "SwitchAudioSource",
    fullName: "switchaudio-osx",
    type: "formula",
    installedVersion: "1.2.2",
    latestVersion: "1.2.2",
    outdated: false,
    description: "Change macOS audio source from the command-line",
    homepage: "https://github.com/deweller/switchaudio-osx",
    license: "MIT",
    tap: "homebrew/core",
    dependencies: []
  }
]);

export function getBrewCliCommand(
  action: "install" | "upgrade" | "uninstall" | "cleanup",
  pkg?: HomebrewPackage | { name: string; type?: "formula" | "cask" }
): string {
  if (action === "cleanup") {
    return "brew cleanup --prune=all";
  }
  const pkgName = pkg?.name || "";
  const caskFlag = pkg?.type === "cask" ? " --cask" : "";
  return `brew ${action}${caskFlag} ${pkgName}`.trim();
}

export function filterHomebrewPackages(
  packages: readonly HomebrewPackage[],
  query = "",
  category: HomebrewFilterCategory = "all"
): HomebrewPackage[] {
  const q = (query || "").trim().toLowerCase();
  return packages.filter((p) => {
    if (category === "installed" && !p.installedVersion) return false;
    if (category === "outdated" && !p.outdated) return false;
    if (category === "formula" && p.type !== "formula") return false;
    if (category === "cask" && p.type !== "cask") return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.fullName.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tap.toLowerCase().includes(q)
    );
  });
}

function parseBrewStdoutToPackages(stdout: string, action: string): HomebrewPackage[] {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-=]+$/.test(l) && !/^Name\s+Id\s+Version/i.test(l) && !/^==>/.test(l));

  const results: HomebrewPackage[] = [];
  for (const line of lines) {
    const parts = line.split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const idOrVer = parts[1].trim();
      const ver = parts[2] ? parts[2].trim() : idOrVer;
      const availVer = parts[3] ? parts[3].trim() : ver;
      if (!name || name.length > 80) continue;
      results.push({
        name,
        fullName: parts.length >= 3 ? idOrVer : name,
        type: "formula",
        installedVersion: action === "search" ? undefined : ver,
        latestVersion: availVer || ver || "latest",
        outdated: Boolean(parts[3] && parts[3] !== ver && parts[3] !== "winget"),
        description: parts.length >= 3 ? `${name} (${idOrVer})` : `${name} — System Package`,
        homepage: "https://brew.sh",
        license: "System / Open Source",
        tap: parts[parts.length - 1] === "winget" ? "winget" : "system/packages",
        dependencies: []
      });
    } else {
      const tokens = line.split(/\s+/).filter(Boolean);
      const pkgName = tokens[0] || "";
      const version = tokens[1] || "latest";
      if (!pkgName || pkgName.length > 80) continue;
      results.push({
        name: pkgName,
        fullName: pkgName,
        type: "formula",
        installedVersion: action === "search" ? undefined : version,
        latestVersion: tokens[2] || version,
        outdated: Boolean(tokens[2] && tokens[2] !== version),
        description: `Installed package: ${pkgName}`,
        homepage: "https://brew.sh",
        license: "Open Source",
        tap: "homebrew/core",
        dependencies: []
      });
    }
  }
  return results;
}

/**
 * 调用主进程 `brew_exec` 安全受控通道执行 Homebrew / 本机包管理器操作
 */
export async function executeHomebrewAction(
  action: "list" | "search" | "info" | "outdated" | "install" | "upgrade" | "uninstall" | "cleanup" | "doctor",
  options: { pkg?: string; cask?: boolean; query?: string } = {},
  hostOverride?: any
): Promise<{
  ok: boolean;
  message: string;
  packages?: HomebrewPackage[];
  output?: string;
}> {
  const pkgName = (options.pkg || options.query || "").trim();
  const isCask = Boolean(options.cask);

  if (
    ["install", "upgrade", "uninstall", "info"].includes(action) &&
    (!pkgName || /[;&|`$<>]/.test(pkgName))
  ) {
    return {
      ok: false,
      message: "INVALID_PACKAGE_NAME: 非法或空的软件包名称"
    };
  }

  const realHost = isRealElectronHost(hostOverride);
  if (hostOverride || realHost) {
    const brewParams: Record<string, unknown> = {
      action,
      cask: isCask
    };
    if (pkgName) {
      brewParams.pkg = pkgName;
    }
    if (options.query) {
      brewParams.query = options.query;
    }
    const res = await callHostTransport<any>(
      "brew_exec",
      brewParams,
      hostOverride
    );

    if (res.ok && res.data !== undefined) {
      const d = res.data;
      const rawList = Array.isArray(d)
        ? d
        : Array.isArray(d?.items)
          ? d.items
          : Array.isArray(d?.packages)
            ? d.packages
            : Array.isArray(d?.formulae)
              ? d.formulae
              : null;

      const stdoutStr =
        typeof d === "string"
          ? d
          : typeof d?.stdout === "string"
            ? d.stdout
            : typeof d?.output === "string"
              ? d.output
              : undefined;

      let mappedPackages: HomebrewPackage[] | undefined = rawList
        ? rawList.map((item: any): HomebrewPackage => {
            const nameStr = String(item.name || item.id || item.token || "package");
            const installedVer =
              item.installedVersion ||
              item.installed_version ||
              (action !== "search" ? item.version : undefined) ||
              undefined;
            const latestVer = String(
              item.latestVersion ||
                item.availableVersion ||
                item.version ||
                installedVer ||
                "latest"
            );
            return {
              name: nameStr,
              fullName: String(item.fullName || item.full_name || item.id || nameStr),
              type: item.type === "cask" || item.cask ? "cask" : "formula",
              installedVersion: installedVer ? String(installedVer) : undefined,
              latestVersion: latestVer,
              outdated: Boolean(
                item.outdated ||
                  (installedVer &&
                    item.availableVersion &&
                    String(item.availableVersion) !== String(installedVer))
              ),
              description: String(
                item.description ||
                  item.desc ||
                  item.publisher ||
                  `${nameStr} (${item.id || item.source || "System Package"})`
              ),
              homepage: String(item.homepage || "https://brew.sh"),
              license: String(item.license || "OSI Approved"),
              tap: String(
                item.tap ||
                  item.source ||
                  (item.type === "cask" ? "homebrew/cask" : "homebrew/core")
              ),
              dependencies: Array.isArray(item.dependencies)
                ? item.dependencies.map(String)
                : []
            };
          })
        : undefined;

      if ((!mappedPackages || mappedPackages.length === 0) && stdoutStr) {
        const parsedFromStdout = parseBrewStdoutToPackages(stdoutStr, action);
        if (parsedFromStdout.length > 0) {
          mappedPackages = parsedFromStdout;
        }
      }

      return {
        ok: true,
        message: String(d?.message || `brew ${action} 执行成功`),
        packages: mappedPackages ?? (realHost ? [] : undefined),
        output: stdoutStr
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        message: res.error || `brew ${action} 执行失败`,
        packages: realHost ? [] : undefined
      };
    }
  }

  if (action === "list" || action === "search" || action === "outdated") {
    return {
      ok: true,
      message: `已获取 Homebrew 列表 (${action})`,
      packages: filterHomebrewPackages(
        SAMPLE_HOMEBREW_PACKAGES,
        pkgName,
        action === "outdated" ? "outdated" : "all"
      )
    };
  }

  if (action === "cleanup") {
    return {
      ok: true,
      message: "已清理 Homebrew 旧版本缓存与残留包 (brew cleanup)"
    };
  }

  return {
    ok: true,
    message: `已完成 brew ${action}${isCask ? " --cask" : ""} ${pkgName}`
  };
}

export async function searchBrewPackages(
  query = "",
  category: HomebrewFilterCategory = "all",
  hostOverride?: any
): Promise<HomebrewPackage[]> {
  const action = category === "outdated" ? "outdated" : query.trim() ? "search" : "list";
  const res = await executeHomebrewAction(
    action,
    { query: query.trim(), pkg: query.trim() },
    hostOverride
  );
  if (res.packages) {
    return filterHomebrewPackages(res.packages, query, category);
  }
  if (isRealElectronHost(hostOverride)) {
    return [];
  }
  return filterHomebrewPackages(SAMPLE_HOMEBREW_PACKAGES, query, category);
}

export const installBrewPackage = (pkg: string, cask = false, hostOverride?: any) =>
  executeHomebrewAction("install", { pkg, cask }, hostOverride);
export const upgradeBrewPackage = (pkg: string, cask = false, hostOverride?: any) =>
  executeHomebrewAction("upgrade", { pkg, cask }, hostOverride);
export const uninstallBrewPackage = (pkg: string, cask = false, hostOverride?: any) =>
  executeHomebrewAction("uninstall", { pkg, cask }, hostOverride);
export const runBrewCleanup = (hostOverride?: any) =>
  executeHomebrewAction("cleanup", {}, hostOverride);
export const runBrewDoctor = (hostOverride?: any) =>
  executeHomebrewAction("doctor", {}, hostOverride);

export function HomebrewDetailView({
  pkg,
  onPackageMutated
}: {
  pkg: HomebrewPackage;
  onPackageMutated?: (updated: HomebrewPackage) => void;
}) {
  const installCmd = getBrewCliCommand("install", pkg);
  const upgradeCmd = getBrewCliCommand("upgrade", pkg);
  const uninstallCmd = getBrewCliCommand("uninstall", pkg);

  const markdown = [
    `# 🍺 ${pkg.name} ${pkg.type === "cask" ? "`Cask (GUI)`" : "`Formula (CLI)`"}`,
    `> **Tap 源**: \`${pkg.tap}\` &nbsp;|&nbsp; **开源协议**: \`${pkg.license}\``,
    `---`,
    `### 软件包简介`,
    pkg.description,
    `### 终端命令 (Terminal CLI)`,
    `\`\`\`zsh\n# 安装\n${installCmd}\n\n# 升级\n${upgradeCmd}\n\n# 卸载\n${uninstallCmd}\n\`\`\``,
    pkg.dependencies.length > 0
      ? `### 依赖树 (Dependencies)\n` + pkg.dependencies.map((d) => `\`${d}\``).join(" • ")
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Detail
      navigationTitle={`${pkg.name} — Homebrew`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="名称" text={pkg.fullName} icon={Icon.Terminal} />
          <Detail.Metadata.Label
            title="包类型"
            text={pkg.type === "cask" ? "Cask (macOS App)" : "Formula (CLI)"}
            icon={pkg.type === "cask" ? Icon.AppWindow : Icon.Code}
          />
          <Detail.Metadata.Label
            title="已装版本"
            text={pkg.installedVersion || "未安装"}
            icon={Icon.Pin}
          />
          <Detail.Metadata.Label title="最新版本" text={pkg.latestVersion} icon={Icon.Upload} />
          <Detail.Metadata.Label title="Tap 仓库" text={pkg.tap} icon={Icon.Folder} />
          <Detail.Metadata.Label title="许可证" text={pkg.license} icon={Icon.Document} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="状态">
            <Detail.Metadata.TagList.Item
              text={
                pkg.outdated
                  ? `可升级 -> ${pkg.latestVersion}`
                  : pkg.installedVersion
                    ? "已安装最新"
                    : "未安装"
              }
              color={
                pkg.outdated
                  ? Color.Yellow
                  : pkg.installedVersion
                    ? Color.Green
                    : Color.SecondaryText
              }
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title={`Homebrew: ${pkg.name}`}>
          {!pkg.installedVersion && (
            <Action
              title={`安装 ${pkg.name} (${installCmd})`}
              icon={Icon.Download}
              onAction={async () => {
                const res = await executeHomebrewAction("install", {
                  pkg: pkg.name,
                  cask: pkg.type === "cask"
                });
                if (res.ok) {
                  onPackageMutated?.({
                    ...pkg,
                    installedVersion: pkg.latestVersion,
                    outdated: false
                  });
                }
                await showToast(
                  res.ok ? Toast.Style.Success : Toast.Style.Failure,
                  res.message
                );
              }}
            />
          )}
          {pkg.outdated && (
            <Action
              title={`升级至 v${pkg.latestVersion} (${upgradeCmd})`}
              icon={Icon.Upload}
              onAction={async () => {
                const res = await executeHomebrewAction("upgrade", {
                  pkg: pkg.name,
                  cask: pkg.type === "cask"
                });
                if (res.ok) {
                  onPackageMutated?.({
                    ...pkg,
                    installedVersion: pkg.latestVersion,
                    outdated: false
                  });
                }
                await showToast(
                  res.ok ? Toast.Style.Success : Toast.Style.Failure,
                  res.message
                );
              }}
            />
          )}
          <Action
            title="复制安装命令"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(installCmd);
              await showToast(Toast.Style.Success, "已复制命令", installCmd);
            }}
          />
          <Action.OpenInBrowser title="打开官方主页" url={pkg.homepage} />
        </ActionPanel>
      }
    />
  );
}

export function HomebrewCommand() {
  const realHost = isRealElectronHost();
  const [packages, setPackages] = useState<HomebrewPackage[]>(() =>
    realHost ? [] : [...SAMPLE_HOMEBREW_PACKAGES]
  );
  const [remoteSearchResults, setRemoteSearchResults] = useState<HomebrewPackage[]>([]);
  const [searchText, setSearchText] = useState("");
  const [category, setCategory] = useState<HomebrewFilterCategory>("all");
  const [isLoading, setIsLoading] = useState<boolean>(realHost);
  const [refreshTick, setRefreshTick] = useState(0);
  const { push } = useNavigation();

  useEffect(() => {
    let active = true;
    if (!realHost) return;
    setIsLoading(true);
    executeHomebrewAction("list")
      .then((res) => {
        if (!active) return;
        if (res.ok && res.packages) {
          setPackages(res.packages);
        }
        setIsLoading(false);
      })
      .catch(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [realHost, refreshTick]);

  // 当用户在搜索框输入关键词时，触发真实远程搜索 (brew_exec action: 'search')
  useEffect(() => {
    let active = true;
    const q = searchText.trim();
    if (!realHost || q.length < 2) {
      setRemoteSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      setIsLoading(true);
      executeHomebrewAction("search", { query: q, pkg: q })
        .then((res) => {
          if (!active) return;
          if (res.ok && res.packages) {
            setRemoteSearchResults(res.packages);
          }
          setIsLoading(false);
        })
        .catch(() => {
          if (active) setIsLoading(false);
        });
    }, 260);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [searchText, realHost]);

  const displayedPackages = useMemo(() => {
    const localFiltered = filterHomebrewPackages(packages, searchText, category);
    if (remoteSearchResults.length === 0) return localFiltered;
    const seen = new Set(localFiltered.map((p) => p.name.toLowerCase()));
    const merged = [...localFiltered];
    for (const remotePkg of filterHomebrewPackages(remoteSearchResults, searchText, category)) {
      if (!seen.has(remotePkg.name.toLowerCase())) {
        seen.add(remotePkg.name.toLowerCase());
        merged.push(remotePkg);
      }
    }
    return merged;
  }, [packages, remoteSearchResults, searchText, category]);

  const updatePackageState = (updated: HomebrewPackage) => {
    setPackages((prev) => {
      const exists = prev.some((p) => p.name === updated.name);
      return exists ? prev.map((p) => (p.name === updated.name ? updated : p)) : [updated, ...prev];
    });
    setRemoteSearchResults((prev) =>
      prev.map((p) => (p.name === updated.name ? updated : p))
    );
  };

  const handleInstall = async (pkg: HomebrewPackage) => {
    await showToast(Toast.Style.Animated, `正在安装 ${pkg.name}...`);
    const res = await executeHomebrewAction("install", {
      pkg: pkg.name,
      cask: pkg.type === "cask"
    });
    if (res.ok) {
      updatePackageState({
        ...pkg,
        installedVersion: pkg.latestVersion,
        outdated: false
      });
    }
    await showToast(
      res.ok ? Toast.Style.Success : Toast.Style.Failure,
      res.ok ? `已安装 ${pkg.name}` : "安装失败",
      res.message
    );
  };

  const handleUpgrade = async (pkg: HomebrewPackage) => {
    await showToast(Toast.Style.Animated, `正在升级 ${pkg.name} 至 v${pkg.latestVersion}...`);
    const res = await executeHomebrewAction("upgrade", {
      pkg: pkg.name,
      cask: pkg.type === "cask"
    });
    if (res.ok) {
      updatePackageState({
        ...pkg,
        installedVersion: pkg.latestVersion,
        outdated: false
      });
    }
    await showToast(
      res.ok ? Toast.Style.Success : Toast.Style.Failure,
      res.ok ? `已升级 ${pkg.name}` : "升级失败",
      res.message
    );
  };

  const handleUninstall = async (pkg: HomebrewPackage) => {
    await showToast(Toast.Style.Animated, `正在卸载 ${pkg.name}...`);
    const res = await executeHomebrewAction("uninstall", {
      pkg: pkg.name,
      cask: pkg.type === "cask"
    });
    if (res.ok) {
      updatePackageState({
        ...pkg,
        installedVersion: undefined,
        outdated: false
      });
    }
    await showToast(
      res.ok ? Toast.Style.Success : Toast.Style.Failure,
      res.ok ? `已卸载 ${pkg.name}` : "卸载失败",
      res.message
    );
  };

  const handleCleanup = async () => {
    await showToast(Toast.Style.Animated, "正在执行 brew cleanup 清理旧版本缓存...");
    const res = await executeHomebrewAction("cleanup");
    await showToast(
      res.ok ? Toast.Style.Success : Toast.Style.Failure,
      res.message
    );
  };

  const [selectedPkgName, setSelectedPkgName] = useState<string>("");
  const installedCount = packages.filter((p) => Boolean(p.installedVersion)).length;
  const outdatedCount = packages.filter((p) => p.outdated).length;
  const activePkg =
    displayedPackages.find((p) => p.name === selectedPkgName) || displayedPackages[0] || null;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索本机已安装软件包或远程检索 (Homebrew / Winget)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedPkgName(id || "")}
      filterBar={{
        summaryText: `本机已安装软件包 ${installedCount} 个 · 可升级 ${outdatedCount} 个 · 当前匹配 ${displayedPackages.length} 个`,
        groups: [
          {
            id: "brew-category-filter",
            label: "包分类",
            value: category,
            onChange: (val) => setCategory(val as HomebrewFilterCategory),
            options: [
              { value: "all", label: "全部", badge: displayedPackages.length },
              { value: "installed", label: "已安装 Installed", badge: installedCount },
              { value: "outdated", label: "可升级 Outdated", badge: outdatedCount },
              {
                value: "formula",
                label: "命令行 Formulae",
                badge: packages.filter((p) => p.type === "formula").length
              },
              {
                value: "cask",
                label: "桌面应用 Casks",
                badge: packages.filter((p) => p.type === "cask").length
              }
            ]
          }
        ],
        actions: [
          {
            id: "brew-act-install-upgrade",
            label: "⬆️ 安装 / 升级选中包",
            title: "⬆️ 安装 / 升级选中包",
            style: "primary",
            onAction: () => {
              if (!activePkg) {
                void showToast(Toast.Style.Failure, "请先选择或搜索一个软件包");
                return;
              }
              if (activePkg.installedVersion) {
                void handleUpgrade(activePkg);
              } else {
                void handleInstall(activePkg);
              }
            }
          },
          {
            id: "brew-act-uninstall",
            label: "🗑️ 卸载选中包",
            title: "🗑️ 卸载选中包",
            style: "danger",
            onAction: () => {
              if (!activePkg) {
                void showToast(Toast.Style.Failure, "请先选择要卸载的软件包");
                return;
              }
              void handleUninstall(activePkg);
            }
          },
          {
            id: "brew-act-copy-cmd",
            label: "📋 复制安装命令",
            title: "📋 复制安装命令",
            style: "secondary",
            onAction: async () => {
              if (!activePkg) {
                await showToast(Toast.Style.Failure, "请先选择一个软件包");
                return;
              }
              const cmd = getBrewCliCommand("install", activePkg);
              await Clipboard.copy(cmd);
              await showToast(Toast.Style.Success, "已复制安装命令", cmd);
            }
          },
          {
            id: "brew-act-cleanup",
            label: "🧹 清理缓存 (cleanup)",
            title: "🧹 清理缓存 (cleanup)",
            style: "secondary",
            onAction: () => {
              void handleCleanup();
            }
          },
          {
            id: "brew-act-refresh",
            label: "🔄 刷新列表",
            title: "🔄 刷新列表",
            style: "secondary",
            onAction: () => {
              setRefreshTick((t) => t + 1);
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按状态或类型筛选软件包"
          value={category}
          onChange={(val) => setCategory(val as HomebrewFilterCategory)}
        >
          <List.Dropdown.Item
            title={`全部软件包 (All · ${displayedPackages.length})`}
            value="all"
            icon={Icon.List}
          />
          <List.Dropdown.Item
            title={`已安装 (Installed · ${installedCount})`}
            value="installed"
            icon={Icon.CheckCircle}
          />
          <List.Dropdown.Item
            title={`可升级 (Outdated · ${outdatedCount})`}
            value="outdated"
            icon={Icon.Upload}
          />
          <List.Dropdown.Item
            title="命令行工具 (Formulae)"
            value="formula"
            icon={Icon.Terminal}
          />
          <List.Dropdown.Item
            title="图形界面应用 (Casks)"
            value="cask"
            icon={Icon.AppWindow}
          />
        </List.Dropdown>
      }
    >
      <List.Section title={`软件包列表 (Packages · ${displayedPackages.length})`}>
        {displayedPackages.map((pkg) => {
          const installCmd = getBrewCliCommand("install", pkg);
          const upgradeCmd = getBrewCliCommand("upgrade", pkg);
          const uninstallCmd = getBrewCliCommand("uninstall", pkg);
          const statusLabel = pkg.outdated
            ? `${pkg.installedVersion} → ${pkg.latestVersion}`
            : pkg.installedVersion
              ? `v${pkg.installedVersion}`
              : `最新 v${pkg.latestVersion}`;

          return (
            <List.Item
              key={`${pkg.tap}-${pkg.fullName}-${pkg.name}`}
              id={pkg.name}
              title={pkg.name}
              subtitle={pkg.description}
              icon={pkg.type === "cask" ? Icon.AppWindow : Icon.Terminal}
              accessories={[
                { text: pkg.type === "cask" ? "Cask" : "Formula" },
                {
                  text: statusLabel,
                  icon: pkg.outdated
                    ? Icon.Upload
                    : pkg.installedVersion
                      ? Icon.Checkmark
                      : Icon.Download
                }
              ]}
              detail={
                <List.Item.Detail
                  markdown={[
                    `# 🍺 ${pkg.name}`,
                    `> \`${pkg.tap}\` • **${pkg.type === "cask" ? "Cask (GUI App)" : "Formula (CLI Tool)"}**`,
                    `---`,
                    `${pkg.description}`,
                    `### 终端命令`,
                    `\`\`\`zsh\n# 安装\n${installCmd}\n\n# 升级\n${upgradeCmd}\n\n# 卸载\n${uninstallCmd}\n\`\`\``,
                    pkg.dependencies.length > 0
                      ? `**依赖项**: ${pkg.dependencies.map((d) => `\`${d}\``).join(", ")}`
                      : ""
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label
                        title="软件包名"
                        text={pkg.fullName}
                        icon={Icon.Terminal}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="类型"
                        text={pkg.type === "cask" ? "Cask (GUI)" : "Formula (CLI)"}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="已安装版本"
                        text={pkg.installedVersion || "未安装"}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="最新可用版本"
                        text={pkg.latestVersion}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="来源仓库"
                        text={pkg.tap}
                      />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={
                            pkg.outdated
                              ? "可升级 (Outdated)"
                              : pkg.installedVersion
                                ? "已安装 (Installed)"
                                : "可安装 (Available)"
                          }
                          color={
                            pkg.outdated
                              ? Color.Yellow
                              : pkg.installedVersion
                                ? Color.Green
                                : Color.Blue
                          }
                        />
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={`Homebrew: ${pkg.name}`}>
                  {pkg.outdated ? (
                    <Action
                      title={`升级 ${pkg.name} 至 v${pkg.latestVersion}`}
                      icon={Icon.Upload}
                      onAction={() => handleUpgrade(pkg)}
                    />
                  ) : !pkg.installedVersion ? (
                    <Action
                      title={`安装 ${pkg.name} (${installCmd})`}
                      icon={Icon.Download}
                      onAction={() => handleInstall(pkg)}
                    />
                  ) : (
                    <Action
                      title="查看软件包详情"
                      icon={Icon.Eye}
                      onAction={() =>
                        push(
                          <HomebrewDetailView
                            pkg={pkg}
                            onPackageMutated={updatePackageState}
                          />
                        )
                      }
                    />
                  )}

                  {!pkg.installedVersion ? null : (
                    <Action
                      title={`升级 ${pkg.name} (${upgradeCmd})`}
                      icon={Icon.Upload}
                      onAction={() => handleUpgrade(pkg)}
                    />
                  )}

                  <Action
                    title={`复制命令 (${installCmd})`}
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                    onAction={async () => {
                      await Clipboard.copy(installCmd);
                      await showToast(Toast.Style.Success, "已复制安装命令", installCmd);
                    }}
                  />

                  {pkg.installedVersion && (
                    <Action
                      title={`卸载 ${pkg.name}`}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl"], key: "x" }}
                      onAction={() => handleUninstall(pkg)}
                    />
                  )}

                  <Action
                    title="刷新软件包列表"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ["ctrl"], key: "r" }}
                    onAction={() => setRefreshTick((t) => t + 1)}
                  />

                  <Action
                    title="清理 Homebrew 缓存 (brew cleanup)"
                    icon={Icon.Broom}
                    onAction={handleCleanup}
                  />

                  <Action.OpenInBrowser title="访问软件主页" url={pkg.homepage} />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}

export default HomebrewCommand;
