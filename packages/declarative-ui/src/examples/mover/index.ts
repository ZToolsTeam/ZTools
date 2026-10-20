/**
 * ZTools 2.0 标杆原生插件视图: C盘大目录无感乾坤大挪移 (Mover 2.0 - 布局二：左 32% 迁移分类树 + 右 68% 可勾选大目录明细列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 4 大目录分类树 + 右 68% C 盘高占用目录可勾选列表
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换目标迁移盘符路径 (D:\ZToolsMoved / E:\ZToolsMoved)
 * 3. 单行极简状态条：filterBar.summaryText 融合 C 盘剩余空间、目标盘可用容量与预计腾出空间，右侧仅保留 1 个重新扫描按钮
 * 4. 系统保护安全锁：C:\Windows\System32 等核心目录强制设置 checkable: false 与 lockedReason，零彩色 Emoji
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  MOVER_CATEGORIES,
  createInitialMoverSnapshot,
  executeDirectoryMove,
  fetchMoverSnapshot,
  formatBytes,
  openMoverFolderLocation,
  type MovableFolderItem,
  type MoverCategory,
  type MoverSnapshot
} from "./logic.js";

export function MoverCommand() {
  const [snapshot, setSnapshot] = useState<MoverSnapshot>(() => {
    const init = createInitialMoverSnapshot();
    if (isRealElectronHost()) {
      return { ...init, folders: [], totalMovableBytes: 0, updatedAt: "正在扫描本机目录..." };
    }
    return init;
  });
  const [selectedCategory, setSelectedCategory] = useState<MoverCategory>("all");
  const [targetRoot, setTargetRoot] = useState<string>("D:\\ZToolsMoved");
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost()
      ? []
      : ["mover_wechat", "mover_qq", "mover_downloads", "mover_npm_cache"]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadMoverSnapshot = async () => {
    setIsLoading(true);
    try {
      const data = await fetchMoverSnapshot();
      setSnapshot(data);
      if (isRealElectronHost()) {
        setCheckedIds(data.folders.filter((f) => !f.isSystemLocked).map((f) => f.id));
      }
      if (data.targetDrives.length > 0 && !data.targetDrives.some((d) => d.targetRoot === targetRoot)) {
        setTargetRoot(data.targetDrives[0].targetRoot);
      }
      setStatusBanner(
        `已扫描 C 盘可迁移大目录 · 发现 ${data.folders.filter((f) => !f.isSystemLocked).length} 个大目录共 ${formatBytes(data.totalMovableBytes)}`
      );
    } catch (err) {
      setStatusBanner(`扫描 C 盘目录失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadMoverSnapshot();
  }, []);

  const keyword = searchText.trim().toLowerCase();
  const visibleFolders = snapshot.folders.filter((folder) => {
    if (selectedCategory !== "all" && folder.category !== selectedCategory) return false;
    if (keyword) {
      const hay = `${folder.name} ${folder.sourcePath} ${folder.categoryName}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(checkedIds);
  const selectedMovableFolders = snapshot.folders.filter(
    (f) => !f.isSystemLocked && checkedSet.has(f.id)
  );
  const selectedMovableBytes = selectedMovableFolders.reduce((acc, item) => acc + item.sizeBytes, 0);

  const toggleFolderCheck = (folder: MovableFolderItem) => {
    if (folder.isSystemLocked) return;
    setCheckedIds((prev) =>
      prev.includes(folder.id) ? prev.filter((id) => id !== folder.id) : [...prev, folder.id]
    );
  };

  const toggleAllVisible = () => {
    const checkableVisible = visibleFolders.filter((f) => !f.isSystemLocked).map((f) => f.id);
    const allChecked =
      checkableVisible.length > 0 && checkableVisible.every((id) => checkedSet.has(id));
    if (allChecked) {
      const removeSet = new Set(checkableVisible);
      setCheckedIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setCheckedIds((prev) => Array.from(new Set([...prev, ...checkableVisible])));
    }
  };

  const handleBatchMove = async () => {
    setIsLoading(true);
    try {
      const res = await executeDirectoryMove(selectedMovableFolders, targetRoot);
      setStatusBanner(res.message);
      await reloadMoverSnapshot();
    } finally {
      setIsLoading(false);
    }
  };

  const maxFolderBytes = Math.max(1, ...visibleFolders.map((f) => f.sizeBytes));
  const cDriveLow =
    snapshot.cDriveTotalBytes > 0 && snapshot.cDriveFreeBytes / snapshot.cDriveTotalBytes < 0.12;

  const summaryText =
    statusBanner ||
    `C 盘剩余 ${formatBytes(snapshot.cDriveFreeBytes)} · 已选 ${selectedMovableFolders.length} 个目录 · 迁移至 ${targetRoot} 预计为 C 盘腾出 ${formatBytes(selectedMovableBytes)}`;

  const leftNavNodes = [
    List.Item({
      id: "nav-mover-all",
      title: "全部 C 盘大目录",
      subtitle: `共 ${snapshot.folders.length} 项 (可安全迁移 ${formatBytes(snapshot.totalMovableBytes)})`,
      icon: Icon.HardDrive,
      onSelect: () => setSelectedCategory("all"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${snapshot.folders.length} 项` } },
        { text: formatBytes(snapshot.totalMovableBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `一键无感迁移已选目录至 ${targetRoot} (Enter)`,
            icon: Icon.ArrowRight,
            onAction: handleBatchMove
          }),
          Action({
            title: "重新扫描 C 盘大目录 (Ctrl+Enter)",
            icon: Icon.RotateAntiClockwise,
            onAction: () => {
              void reloadMoverSnapshot();
            }
          })
        ]
      })
    }),
    ...MOVER_CATEGORIES.map((cat) => {
      const catFolders = snapshot.folders.filter((f) => f.category === cat.id);
      const catBytes = catFolders.reduce((s, f) => s + f.sizeBytes, 0);
      const ratio = Math.min(1, catBytes / Math.max(1, snapshot.totalMovableBytes));

      return List.Item({
        id: `nav-mover-${cat.id}`,
        title: cat.name,
        subtitle: cat.subtitle,
        icon: cat.id === "system_locked" ? Icon.Lock : Icon.Folder,
        onSelect: () => setSelectedCategory(cat.id),
        accessories: [
          { progress: ratio },
          { tag: { value: `${catFolders.length} 项` } },
          { text: formatBytes(catBytes) }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `查看「${cat.name}」目录明细 (Enter)`,
              icon: Icon.Filter,
              onAction: () => setSelectedCategory(cat.id)
            }),
            Action({
              title: `执行无感迁移 (${selectedMovableFolders.length} 项) (Ctrl+Enter)`,
              icon: Icon.ArrowRight,
              onAction: handleBatchMove
            })
          ]
        })
      });
    })
  ];

  const subListItems = visibleFolders.map((folder) => {
    const isChecked = !folder.isSystemLocked && checkedSet.has(folder.id);
    const ratio = Math.min(1, folder.sizeBytes / maxFolderBytes);
    const folderBase = folder.sourcePath.split(/[\\/]/).pop() || folder.id;
    const destPreview = `${targetRoot.replace(/[\\/]+$/, "")}\\${folderBase}`;

    return List.Item({
      id: `mover-item-${folder.id}`,
      title: folder.name,
      subtitle: folder.isSystemLocked
        ? `${folder.sourcePath} · ${folder.lockedReason}`
        : `${folder.sourcePath} -> ${destPreview} (NTFS Junction 符号链接)`,
      icon: folder.isSystemLocked ? Icon.Lock : Icon.Folder,
      checkable: !folder.isSystemLocked,
      checked: isChecked,
      lockedReason: folder.lockedReason,
      onCheckChange: () => toggleFolderCheck(folder),
      onToggleCheck: () => toggleFolderCheck(folder),
      accessories: [
        { progress: ratio },
        {
          tag: {
            value: folder.isSystemLocked ? "系统保护" : folder.categoryName
          }
        },
        { text: formatBytes(folder.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `一键无感迁移并建立符号链接 (${formatBytes(selectedMovableBytes)}) (Enter)`,
            icon: Icon.ArrowRight,
            onAction: handleBatchMove
          }),
          Action({
            title: "在资源管理器中定位源目录 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openMoverFolderLocation(folder.sourcePath);
            }
          }),
          ...(!folder.isSystemLocked
            ? [
                Action({
                  title: isChecked ? "取消勾选此目录" : "勾选此目录参与迁移",
                  icon: Icon.CheckCircle,
                  onAction: () => toggleFolderCheck(folder)
                })
              ]
            : [])
        ]
      })
    } as any);
  });

  const checkableVisible = visibleFolders.filter((f) => !f.isSystemLocked);
  const allChecked =
    checkableVisible.length > 0 && checkableVisible.every((f) => checkedSet.has(f.id));
  const someChecked = checkableVisible.some((f) => checkedSet.has(f.id));

  return List({
    isLoading,
    searchBarPlaceholder: "搜索 C 盘大目录名称、微信/QQ 缓存或开发包路径...",
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: "选择目标迁移盘符与根目录",
      value: targetRoot,
      onChange: (val) => setTargetRoot(val),
      children: snapshot.targetDrives.map((d) =>
        List.Dropdown.Item({
          title: d.label,
          value: d.targetRoot
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
            void reloadMoverSnapshot();
          }
        }
      ]
    },
    subList: {
      title: `C 盘可迁移大目录明细 (${visibleFolders.length} 项 · 预计腾出 ${formatBytes(selectedMovableBytes)})`,
      subtitle: targetRoot,
      emptyText: "当前分类下暂无匹配的目录",
      checkable: checkableVisible.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "C 盘目录分类导航树 (32%)",
        subtitle: "支持 NTFS Junction 无感链接",
        children: leftNavNodes
      })
    ]
  });
}

export default MoverCommand;
