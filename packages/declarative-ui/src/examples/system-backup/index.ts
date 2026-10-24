/**
 * ZTools 2.0 标杆原生插件视图: 系统与开发环境关键配置备份工坊 (System Backup 2.0 - 布局二：左 32% 配置分类树 + 右 68% 可勾选配置与快照列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 4 大系统与极客配置分类导航树 + 右 68% 可勾选配置文件与快照列表
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换备份策略模式 (全量快照 / 极客 Dotfiles / 增量归档)
 * 3. 单行极简状态条：filterBar.summaryText 融合备份归档仓库路径、已选配置项数量与总大小，仅保留 1 个全局重新扫描按钮
 * 4. 零彩色 Emoji 与去彩虹化：100% 单色 SVG 图标、单色中性灰进度条与标签
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  BACKUP_CATEGORIES,
  BACKUP_PROFILES,
  createBackupArchive,
  createInitialSystemBackupSnapshot,
  fetchSystemBackupSnapshot,
  formatBytes,
  openBackupConfigLocation,
  restoreBackupSnapshot,
  type BackupCategory,
  type BackupConfigItem,
  type BackupProfileMode,
  type SystemBackupSnapshot
} from "./logic.js";

export function SystemBackupCommand() {
  const [snapshot, setSnapshot] = useState<SystemBackupSnapshot>(() => {
    const init = createInitialSystemBackupSnapshot();
    if (isRealElectronHost()) {
      return {
        ...init,
        items: [],
        totalSizeBytes: 0,
        updatedAt: "正在扫描本机配置项..."
      };
    }
    return init;
  });
  const [selectedCategory, setSelectedCategory] = useState<BackupCategory>("all");
  const [profileMode, setProfileMode] = useState<BackupProfileMode>("full_bundle");
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost()
      ? []
      : [
          "bak_hosts",
          "bak_env_path",
          "bak_ssh_config",
          "bak_gitconfig",
          "bak_ps_profile",
          "bak_vscode_settings"
        ]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadBackupSnapshot = async () => {
    setIsLoading(true);
    try {
      const data = await fetchSystemBackupSnapshot();
      setSnapshot(data);
      if (isRealElectronHost()) {
        setCheckedIds(
          data.items.filter((i) => i.category !== "snapshot_archives").map((i) => i.id)
        );
      }
      setStatusBanner(
        `已扫描本机关键配置项 · 共 ${data.items.length} 项 (${formatBytes(data.totalSizeBytes)}) · 仓库: ${data.backupVaultDir}`
      );
    } catch (err) {
      setStatusBanner(`读取配置列表失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadBackupSnapshot();
  }, []);

  const currentProfile =
    BACKUP_PROFILES.find((p) => p.id === profileMode) || BACKUP_PROFILES[0];

  const keyword = searchText.trim().toLowerCase();
  const visibleItems = snapshot.items.filter((item) => {
    if (selectedCategory !== "all" && item.category !== selectedCategory) return false;
    if (keyword) {
      const hay = `${item.name} ${item.path} ${item.categoryName} ${item.statusTag}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(checkedIds);
  const selectedItems = snapshot.items.filter((i) => checkedSet.has(i.id));
  const selectedBytes = selectedItems.reduce((acc, item) => acc + item.sizeBytes, 0);

  const toggleItemCheck = (id: string) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const toggleAllVisible = () => {
    const visibleIds = visibleItems.map((i) => i.id);
    const allChecked = visibleIds.length > 0 && visibleIds.every((id) => checkedSet.has(id));
    if (allChecked) {
      const removeSet = new Set(visibleIds);
      setCheckedIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setCheckedIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const handleCreateBackup = async () => {
    const targets = selectedItems.length > 0 ? selectedItems : visibleItems;
    setIsLoading(true);
    try {
      const res = await createBackupArchive(targets, profileMode, snapshot.backupVaultDir);
      setStatusBanner(res.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestoreLatest = async (item?: BackupConfigItem) => {
    const archivePath =
      item && item.category === "snapshot_archives"
        ? item.path
        : `${snapshot.backupVaultDir}\\ZTools_SystemBackup_20261018_Full.zip`;
    setIsLoading(true);
    try {
      const res = await restoreBackupSnapshot(archivePath);
      setStatusBanner(res.message);
    } finally {
      setIsLoading(false);
    }
  };

  const maxItemBytes = Math.max(1, ...visibleItems.map((i) => i.sizeBytes));

  const summaryText =
    statusBanner ||
    `策略: ${currentProfile.label} · 已选 ${selectedItems.length}/${visibleItems.length} 项配置 (${formatBytes(selectedBytes)}) · 归档目录: ${snapshot.backupVaultDir}`;

  const leftNavNodes = [
    List.Item({
      id: "nav-bak-all",
      title: "全部系统与开发配置",
      subtitle: `共 ${snapshot.items.length} 项配置与历史归档`,
      icon: Icon.HardDrive,
      onSelect: () => setSelectedCategory("all"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${snapshot.items.length} 项` } },
        { text: formatBytes(snapshot.totalSizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `立即打包创建快照备份 (${selectedItems.length} 项) (Enter)`,
            icon: Icon.Download,
            onAction: handleCreateBackup
          }),
          Action({
            title: "从最近一次快照还原配置 (Ctrl+Enter)",
            icon: Icon.RotateAntiClockwise,
            onAction: () => handleRestoreLatest()
          })
        ]
      })
    }),
    ...BACKUP_CATEGORIES.map((cat) => {
      const catItems = snapshot.items.filter((i) => i.category === cat.id);
      const catBytes = catItems.reduce((s, i) => s + i.sizeBytes, 0);
      const ratio = Math.min(1, catBytes / Math.max(1, snapshot.totalSizeBytes));

      return List.Item({
        id: `nav-bak-${cat.id}`,
        title: cat.name,
        subtitle: cat.subtitle,
        icon: Icon.Folder,
        onSelect: () => setSelectedCategory(cat.id),
        accessories: [
          { progress: ratio },
          { tag: { value: `${catItems.length} 项` } },
          { text: formatBytes(catBytes) }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `查看「${cat.name}」配置项 (Enter)`,
              icon: Icon.Filter,
              onAction: () => setSelectedCategory(cat.id)
            }),
            Action({
              title: `立即打包备份已选配置 (${selectedItems.length} 项) (Ctrl+Enter)`,
              icon: Icon.Download,
              onAction: handleCreateBackup
            })
          ]
        })
      });
    })
  ];

  const subListItems = visibleItems.map((item) => {
    const isChecked = checkedSet.has(item.id);
    const ratio = Math.min(1, item.sizeBytes / maxItemBytes);

    return List.Item({
      id: `bak-item-${item.id}`,
      title: item.name,
      subtitle: `${item.path} · ${item.lastModified}`,
      icon: Icon.Document,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => toggleItemCheck(item.id),
      onToggleCheck: () => toggleItemCheck(item.id),
      accessories: [
        { progress: ratio },
        { tag: { value: item.statusTag } },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title:
              item.category === "snapshot_archives"
                ? "从此历史快照归档还原配置 (Enter)"
                : `打包备份已勾选配置 (${selectedItems.length} 项) (Enter)`,
            icon: item.category === "snapshot_archives" ? Icon.RotateAntiClockwise : Icon.Download,
            onAction: () => {
              if (item.category === "snapshot_archives") {
                void handleRestoreLatest(item);
              } else {
                void handleCreateBackup();
              }
            }
          }),
          Action({
            title: "在资源管理器中定位配置文件 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openBackupConfigLocation(item.path);
            }
          }),
          Action({
            title: isChecked ? "取消勾选此配置项" : "勾选此配置项",
            icon: Icon.CheckCircle,
            onAction: () => toggleItemCheck(item.id)
          })
        ]
      })
    });
  });

  const allChecked = visibleItems.length > 0 && visibleItems.every((i) => checkedSet.has(i.id));
  const someChecked = visibleItems.some((i) => checkedSet.has(i.id));

  return List({
    isLoading,
    searchBarPlaceholder: "搜索 Hosts、PATH、.ssh/config、.gitconfig、VSCode 配置或备份快照...",
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: "切换配置备份归档模式",
      value: profileMode,
      onChange: (val) => setProfileMode(val as BackupProfileMode),
      children: BACKUP_PROFILES.map((p) =>
        List.Dropdown.Item({
          title: p.label,
          value: p.id
        })
      )
    }),
    filterBar: {
      summaryText,
      actions: [
        {
          id: "rescan",
          title: "重新扫描",
          style: "secondary",
          onAction: () => {
            void reloadBackupSnapshot();
          }
        }
      ]
    },
    subList: {
      title: `系统与开发配置明细 (${visibleItems.length} 项 · 已选 ${formatBytes(selectedBytes)})`,
      subtitle: snapshot.backupVaultDir,
      emptyText: "当前分类下暂无匹配的配置文件",
      checkable: visibleItems.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "关键配置与快照分类树 (32%)",
        subtitle: "系统 / 终端 / IDE / 归档",
        children: leftNavNodes
      })
    ]
  });
}

export default SystemBackupCommand;
