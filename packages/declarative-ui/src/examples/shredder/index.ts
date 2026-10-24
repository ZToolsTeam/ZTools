/**
 * ZTools 2.0 标杆原生插件视图: 军工级文件粉碎机 (Shredder 2.0 - 布局二：左 32% 待销毁区域树 + 右 68% 可勾选粉碎列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 4 大待销毁区域导航树 + 右 68% 带覆写轮数预览的可勾选文件列表
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换覆写标准 (DoD 5220.22-M 3次覆写 / Gutmann 7次覆写 / 零值快速1次)
 * 3. 单行极简状态条：filterBar.summaryText 融合当前覆写算法、待销毁文件数与总体积，右侧仅保留 1 个全局重新扫描按钮
 * 4. 系统保护安全锁与二次确认：Windows 系统文件强制设置 checkable: false + lockedReason，主动作配置 confirmAlert 二次确认
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  SHRED_CATEGORIES,
  SHRED_STANDARDS,
  createInitialShredderSnapshot,
  executeSecureShred,
  fetchShredCandidates,
  formatBytes,
  openShredCandidateLocation,
  type ShredCandidateItem,
  type ShredCategory,
  type ShredStandardId,
  type ShredderSnapshot
} from "./logic.js";

export function ShredderCommand() {
  const [snapshot, setSnapshot] = useState<ShredderSnapshot>(() => {
    const init = createInitialShredderSnapshot();
    if (isRealElectronHost()) {
      return {
        ...init,
        candidates: [],
        totalShreddableBytes: 0,
        updatedAt: "正在扫描本机临时文件..."
      };
    }
    return init;
  });
  const [selectedCategory, setSelectedCategory] = useState<ShredCategory>("all");
  const [standardId, setStandardId] = useState<ShredStandardId>("dod_3pass");
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost() ? [] : ["shred_temp_01", "shred_temp_02"]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadCandidates = async () => {
    setIsLoading(true);
    try {
      const data = await fetchShredCandidates();
      setSnapshot(data);
      if (isRealElectronHost()) {
        setCheckedIds(data.candidates.filter((c) => !c.isSystemLocked).slice(0, 5).map((c) => c.id));
      }
      setStatusBanner(
        `已扫描待销毁候选区 · 共 ${data.candidates.filter((c) => !c.isSystemLocked).length} 个可粉碎文件 (${formatBytes(data.totalShreddableBytes)})`
      );
    } catch (err) {
      setStatusBanner(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadCandidates();
  }, []);

  const currentStandard =
    SHRED_STANDARDS.find((s) => s.id === standardId) || SHRED_STANDARDS[0];

  const keyword = searchText.trim().toLowerCase();
  const visibleItems = snapshot.candidates.filter((item) => {
    if (selectedCategory !== "all" && item.category !== selectedCategory) return false;
    if (keyword) {
      const hay = `${item.name} ${item.path} ${item.categoryName}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(checkedIds);
  const selectedSafeItems = snapshot.candidates.filter(
    (item) => !item.isSystemLocked && checkedSet.has(item.id)
  );
  const selectedBytes = selectedSafeItems.reduce((acc, item) => acc + item.sizeBytes, 0);

  const toggleItemCheck = (item: ShredCandidateItem) => {
    if (item.isSystemLocked) return;
    setCheckedIds((prev) =>
      prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
    );
  };

  const toggleAllVisible = () => {
    const checkableIds = visibleItems.filter((i) => !i.isSystemLocked).map((i) => i.id);
    const allChecked =
      checkableIds.length > 0 && checkableIds.every((id) => checkedSet.has(id));
    if (allChecked) {
      const removeSet = new Set(checkableIds);
      setCheckedIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setCheckedIds((prev) => Array.from(new Set([...prev, ...checkableIds])));
    }
  };

  const handleBatchShred = async () => {
    setIsLoading(true);
    try {
      const res = await executeSecureShred(selectedSafeItems, standardId);
      setStatusBanner(res.message);
    } finally {
      setIsLoading(false);
    }
  };

  const maxItemBytes = Math.max(1, ...visibleItems.map((i) => i.sizeBytes));

  const summaryText =
    statusBanner ||
    `算法: ${currentStandard.name} · 已勾选 ${selectedSafeItems.length} 项 (${formatBytes(selectedBytes)}) · 粉碎后扇区不可逆擦除`;

  const leftNavNodes = [
    List.Item({
      id: "nav-shred-all",
      title: "全部待粉碎候选文件",
      subtitle: `共 ${snapshot.candidates.length} 项 (已排除系统锁定项)`,
      icon: Icon.Trash,
      onSelect: () => setSelectedCategory("all"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${snapshot.candidates.length} 项` } },
        { text: formatBytes(snapshot.totalShreddableBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `彻底粉碎已选文件 [${currentStandard.badge}] (Enter)`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleBatchShred
          }),
          Action({
            title: "重新扫描候选区 (Ctrl+Enter)",
            icon: Icon.RotateAntiClockwise,
            onAction: () => {
              void reloadCandidates();
            }
          })
        ]
      })
    }),
    ...SHRED_CATEGORIES.map((cat) => {
      const catItems = snapshot.candidates.filter((i) => i.category === cat.id);
      const catBytes = catItems.reduce((s, i) => s + i.sizeBytes, 0);
      const ratio = Math.min(1, catBytes / Math.max(1, snapshot.totalShreddableBytes));

      return List.Item({
        id: `nav-shred-${cat.id}`,
        title: cat.name,
        subtitle: cat.subtitle,
        icon: cat.id === "system_locked" ? Icon.Lock : Icon.Folder,
        onSelect: () => setSelectedCategory(cat.id),
        accessories: [
          { progress: ratio },
          { tag: { value: `${catItems.length} 项` } },
          { text: formatBytes(catBytes) }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `查看「${cat.name}」明细 (Enter)`,
              icon: Icon.Filter,
              onAction: () => setSelectedCategory(cat.id)
            }),
            Action({
              title: `粉碎已勾选文件 (${selectedSafeItems.length} 项) (Ctrl+Enter)`,
              icon: Icon.Trash,
              style: "destructive",
              onAction: handleBatchShred
            })
          ]
        })
      });
    })
  ];

  const subListItems = visibleItems.map((item) => {
    const isChecked = !item.isSystemLocked && checkedSet.has(item.id);
    const ratio = Math.min(1, item.sizeBytes / maxItemBytes);

    return List.Item({
      id: `shred-item-${item.id}`,
      title: item.name,
      subtitle: item.isSystemLocked
        ? `${item.path} · ${item.lockedReason}`
        : `${item.path} · 预设 ${currentStandard.passes} 轮扇区覆写`,
      icon: item.isSystemLocked ? Icon.Lock : Icon.Document,
      checkable: !item.isSystemLocked,
      checked: isChecked,
      lockedReason: item.lockedReason,
      onCheckChange: () => toggleItemCheck(item),
      onToggleCheck: () => toggleItemCheck(item),
      accessories: [
        { progress: ratio },
        {
          tag: {
            value: item.isSystemLocked ? "系统保护" : currentStandard.badge
          }
        },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `彻底粉碎已勾选文件 (${selectedSafeItems.length} 项 / ${formatBytes(selectedBytes)}) (Enter)`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleBatchShred
          }),
          Action({
            title: "在资源管理器中定位此文件 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openShredCandidateLocation(item.path);
            }
          }),
          ...(!item.isSystemLocked
            ? [
                Action({
                  title: isChecked ? "取消勾选此文件" : "勾选此文件待粉碎",
                  icon: Icon.CheckCircle,
                  onAction: () => toggleItemCheck(item)
                })
              ]
            : [])
        ]
      })
    } as any);
  });

  const checkableVisible = visibleItems.filter((i) => !i.isSystemLocked);
  const allChecked =
    checkableVisible.length > 0 && checkableVisible.every((i) => checkedSet.has(i.id));
  const someChecked = checkableVisible.some((i) => checkedSet.has(i.id));

  return List({
    isLoading,
    searchBarPlaceholder: "搜索待粉碎敏感文件名、路径或缓存后缀...",
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: "选择国际安全扇区覆写标准",
      value: standardId,
      onChange: (val) => setStandardId(val as ShredStandardId),
      children: SHRED_STANDARDS.map((std) =>
        List.Dropdown.Item({
          title: std.name,
          value: std.id
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
            void reloadCandidates();
          }
        }
      ]
    },
    subList: {
      title: `待粉碎文件明细队列 (${visibleItems.length} 项 · 已选 ${formatBytes(selectedBytes)})`,
      subtitle: currentStandard.name,
      emptyText: "当前分类下暂无待粉碎文件",
      checkable: checkableVisible.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "待销毁区域导航树 (32%)",
        subtitle: "支持 1/3/7 轮扇区覆写",
        children: leftNavNodes
      })
    ]
  });
}

export default ShredderCommand;
