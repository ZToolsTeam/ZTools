/**
 * ZTools 2.0 标杆原生插件视图: 误删文件与回收站深度恢复工坊 (Data Recovery 2.0 - 布局二：左 32% 恢复分类树 + 右 68% 可勾选待恢复文件列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 5 大文件类型恢复树 + 右 68% 带完整度进度条与原路径对比的可勾选列表
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换扫描深度模式 (快速扫描回收站 / 深度扇区 MFT 扫描 / 办公自动保存扫描)
 * 3. 单行极简状态条：filterBar.summaryText 融合可恢复总数、高完整度占比与已勾选恢复体积，仅保留 1 个全局重新扫描按钮
 * 4. 零彩色 Emoji 与去彩虹化：100% 单色 SVG 图标、单色中性灰完整度进度条
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  RECOVERY_CATEGORIES,
  SCAN_DEPTH_MODES,
  createInitialRecoverySnapshot,
  fetchRecoverableFiles,
  formatBytes,
  openRecoveryLocation,
  restoreSelectedFiles,
  type DataRecoverySnapshot,
  type RecoverableFileItem,
  type RecoveryCategory,
  type ScanDepthMode
} from "./logic.js";

export function DataRecoveryCommand() {
  const [snapshot, setSnapshot] = useState<DataRecoverySnapshot>(() => {
    const init = createInitialRecoverySnapshot();
    if (isRealElectronHost()) {
      return {
        ...init,
        items: [],
        totalSizeBytes: 0,
        highIntegrityCount: 0,
        updatedAt: "正在扫描可恢复文件..."
      };
    }
    return init;
  });
  const [selectedCategory, setSelectedCategory] = useState<RecoveryCategory>("all");
  const [scanMode, setScanMode] = useState<ScanDepthMode>("quick_recycle");
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost() ? [] : ["rec_doc_01", "rec_doc_02", "rec_img_01"]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadRecoveryList = async (mode: ScanDepthMode = scanMode) => {
    setIsLoading(true);
    try {
      const data = await fetchRecoverableFiles(mode);
      setSnapshot(data);
      if (isRealElectronHost()) {
        setCheckedIds(data.items.slice(0, 5).map((i) => i.id));
      }
      setStatusBanner(
        `已完成扫描 · 发现 ${data.items.length} 个可恢复文件 (${formatBytes(data.totalSizeBytes)}) · 高完整度 ${data.highIntegrityCount} 项`
      );
    } catch (err) {
      setStatusBanner(`深度扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadRecoveryList(scanMode);
  }, [scanMode]);

  const keyword = searchText.trim().toLowerCase();
  const visibleItems = snapshot.items.filter((item) => {
    if (selectedCategory !== "all" && item.category !== selectedCategory) return false;
    if (keyword) {
      const hay = `${item.name} ${item.originalPath} ${item.categoryName}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(checkedIds);
  const selectedItems = snapshot.items.filter((item) => checkedSet.has(item.id));
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

  const handleBatchRestore = async () => {
    const targets = selectedItems.length > 0 ? selectedItems : visibleItems.slice(0, 1);
    setIsLoading(true);
    try {
      const res = await restoreSelectedFiles(targets, snapshot.restoreTargetDir);
      setStatusBanner(res.message);
    } finally {
      setIsLoading(false);
    }
  };

  const summaryText =
    statusBanner ||
    `发现可恢复文件 ${snapshot.items.length} 项 (${formatBytes(snapshot.totalSizeBytes)}) · 已勾选 ${selectedItems.length} 项 (${formatBytes(selectedBytes)}) · 恢复目录: ${snapshot.restoreTargetDir}`;

  const leftNavNodes = [
    List.Item({
      id: "nav-rec-all",
      title: "全部可恢复项",
      subtitle: `回收站与临时缓存残留 (${snapshot.items.length} 项)`,
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
            title: `一键恢复已勾选文件 (${selectedItems.length} 项) (Enter)`,
            icon: Icon.CheckCircle,
            onAction: handleBatchRestore
          }),
          Action({
            title: "打开恢复导出文件夹 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openRecoveryLocation(snapshot.restoreTargetDir);
            }
          })
        ]
      })
    }),
    ...RECOVERY_CATEGORIES.map((cat) => {
      const catItems = snapshot.items.filter((i) => i.category === cat.id);
      const catBytes = catItems.reduce((s, i) => s + i.sizeBytes, 0);
      const ratio = Math.min(1, catBytes / Math.max(1, snapshot.totalSizeBytes));

      return List.Item({
        id: `nav-rec-${cat.id}`,
        title: cat.name,
        subtitle: cat.subtitle,
        icon: Icon.Document,
        onSelect: () => setSelectedCategory(cat.id),
        accessories: [
          { progress: ratio },
          { tag: { value: `${catItems.length} 项` } },
          { text: formatBytes(catBytes) }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `筛选「${cat.name}」可恢复文件 (Enter)`,
              icon: Icon.Filter,
              onAction: () => setSelectedCategory(cat.id)
            }),
            Action({
              title: `恢复已勾选文件 (${selectedItems.length} 项) (Ctrl+Enter)`,
              icon: Icon.CheckCircle,
              onAction: handleBatchRestore
            })
          ]
        })
      });
    })
  ];

  const subListItems = visibleItems.map((item) => {
    const isChecked = checkedSet.has(item.id);

    return List.Item({
      id: `rec-item-${item.id}`,
      title: item.name,
      subtitle: `原路径: ${item.originalPath} · ${item.deletedAt}`,
      icon: Icon.Document,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => toggleItemCheck(item.id),
      onToggleCheck: () => toggleItemCheck(item.id),
      accessories: [
        { progress: item.integrityScore },
        { tag: { value: item.integrityLabel } },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `立即恢复已勾选文件至安全目录 (${selectedItems.length} 项) (Enter)`,
            icon: Icon.CheckCircle,
            onAction: handleBatchRestore
          }),
          Action({
            title: "在资源管理器中定位缓存源位置 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openRecoveryLocation(item.cachePath);
            }
          }),
          Action({
            title: isChecked ? "取消勾选此文件" : "勾选此文件",
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
    searchBarPlaceholder: "搜索误删文件名、后缀（如 .docx / .psd / .mp4）或原始路径...",
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: "切换数据恢复扫描深度模式",
      value: scanMode,
      onChange: (val) => setScanMode(val as ScanDepthMode),
      children: SCAN_DEPTH_MODES.map((m) =>
        List.Dropdown.Item({
          title: m.label,
          value: m.id
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
            void reloadRecoveryList(scanMode);
          }
        }
      ]
    },
    subList: {
      title: `可恢复文件明细队列 (${visibleItems.length} 项 · 已选 ${formatBytes(selectedBytes)})`,
      subtitle: snapshot.restoreTargetDir,
      emptyText: "当前分类下未扫描到误删残留文件",
      checkable: visibleItems.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "恢复文件分类导航树 (32%)",
        subtitle: "按类型与完整度检索",
        children: leftNavNodes
      })
    ]
  });
}

export default DataRecoveryCommand;
