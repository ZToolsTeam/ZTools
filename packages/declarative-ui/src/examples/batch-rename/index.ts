/**
 * 批量文件重命名工作台视图 (BatchRename 2.0 - 布局二：左 32% 10 大重命名规则导航树 + 右 68% 实时原名->新名对比可勾选列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 10 大重命名规则预设导航树 + 右 68% 原文件名 -> 新文件名 Diff 实时预览可勾选列表
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换本机目标目录 (Downloads / Desktop / Documents / Pictures / Videos)
 * 3. 单行极简状态条：filterBar.summaryText 融合目标目录、规则名称、已勾选待改名数与冲突告警，仅保留 1 个全局重新扫描按钮
 * 4. 零彩色 Emoji 与去彩虹化：100% 单色 SVG 图标、中性灰标签（仅在重命名同名冲突时使用 color: "red" 高危告警）
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { formatBytes, isRealElectronHost } from "../shared/native-ipc.js";
import {
  RENAME_RULE_PRESETS,
  applyRenameRule,
  executeRealFileRename,
  fetchRealBatchRenameFiles,
  openRenameFileLocation,
  undoBatchRenameHistory,
  type RealFileEntry,
  type RenameRule,
  type RenameRuleType,
  type RenameUndoEntry
} from "./logic.js";

type SourceDirScope = "downloads" | "desktop" | "documents" | "pictures" | "videos";

const SOURCE_SCOPES: Array<{ id: SourceDirScope; label: string }> = [
  { id: "downloads", label: "下载目录 (Downloads)" },
  { id: "desktop", label: "桌面目录 (Desktop)" },
  { id: "documents", label: "文档目录 (Documents)" },
  { id: "pictures", label: "图片目录 (Pictures)" },
  { id: "videos", label: "视频目录 (Videos)" }
];

const INITIAL_FALLBACK_FILES: RealFileEntry[] = [
  {
    name: "IMG_2026_raw_01 (副本).JPG",
    fullPath: "C:\\Users\\Default\\Downloads\\IMG_2026_raw_01 (副本).JPG",
    parentDir: "C:\\Users\\Default\\Downloads",
    extension: ".jpg",
    sizeBytes: 4250 * 1024,
    lastModifiedMs: Date.now() - 3600_000
  },
  {
    name: "IMG_2026_raw_02 [广告].JPG",
    fullPath: "C:\\Users\\Default\\Downloads\\IMG_2026_raw_02 [广告].JPG",
    parentDir: "C:\\Users\\Default\\Downloads",
    extension: ".jpg",
    sizeBytes: 3980 * 1024,
    lastModifiedMs: Date.now() - 7200_000
  },
  {
    name: "01_季度财务审计报告-v1.xlsx",
    fullPath: "C:\\Users\\Default\\Downloads\\01_季度财务审计报告-v1.xlsx",
    parentDir: "C:\\Users\\Default\\Downloads",
    extension: ".xlsx",
    sizeBytes: 1840 * 1024,
    lastModifiedMs: Date.now() - 10800_000
  },
  {
    name: "02_产品架构评审纪要【内部】.docx",
    fullPath: "C:\\Users\\Default\\Downloads\\02_产品架构评审纪要【内部】.docx",
    parentDir: "C:\\Users\\Default\\Downloads",
    extension: ".docx",
    sizeBytes: 960 * 1024,
    lastModifiedMs: Date.now() - 14400_000
  },
  {
    name: "My-Screen-Recording-Clip.MP4",
    fullPath: "C:\\Users\\Default\\Downloads\\My-Screen-Recording-Clip.MP4",
    parentDir: "C:\\Users\\Default\\Downloads",
    extension: ".mp4",
    sizeBytes: 28400 * 1024,
    lastModifiedMs: Date.now() - 18000_000
  }
];

function stripLeadingEmoji(label: string): string {
  return label.replace(/^[^\u4e00-\u9fa5A-Za-z0-9(\[_-]+/, "").trim();
}

export function BatchRenameCommand() {
  const [sourceScope, setSourceScope] = useState<SourceDirScope>("downloads");
  const [currentDir, setCurrentDir] = useState<string>("C:\\Users\\Default\\Downloads");
  const [realFiles, setRealFiles] = useState<RealFileEntry[]>(() =>
    isRealElectronHost() ? [] : INITIAL_FALLBACK_FILES
  );
  const [ruleType, setRuleType] = useState<RenameRuleType>("number");
  const [checkedPaths, setCheckedPaths] = useState<string[]>(() =>
    isRealElectronHost() ? [] : INITIAL_FALLBACK_FILES.map((f) => f.fullPath)
  );
  const [searchText, setSearchText] = useState<string>("");
  const [undoStack, setUndoStack] = useState<RenameUndoEntry[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const loadDirectoryFiles = async (scope: SourceDirScope) => {
    setIsLoading(true);
    try {
      const res = await fetchRealBatchRenameFiles(scope);
      if (isRealElectronHost() || res.files.length > 0) {
        setCurrentDir(res.directory || scope);
        setRealFiles(res.files);
        setCheckedPaths(res.files.slice(0, 15).map((f) => f.fullPath));
        setStatusMessage(
          res.files.length > 0
            ? `已加载 ${res.directory} 下 ${res.files.length} 个真实文件`
            : `当前目录 (${res.directory || scope}) 暂无可重命名文件`
        );
      } else {
        setStatusMessage(`已就绪 (${scope}) · 共 ${realFiles.length} 个待重命名文件`);
      }
    } catch (err) {
      setStatusMessage(`读取目录失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDirectoryFiles(sourceScope);
  }, [sourceScope]);

  const trimmedQuery = searchText.trim();
  const buildActiveRule = (): RenameRule => {
    if (trimmedQuery.includes("->")) {
      const [findPart, replacePart] = trimmedQuery.split("->");
      return {
        type: "replace",
        find: (findPart || "").trim(),
        replace: (replacePart || "").trim()
      };
    }
    switch (ruleType) {
      case "prefix":
        return { type: "prefix", prefix: trimmedQuery || "ZTools_" };
      case "date_prefix":
        return { type: "date_prefix" };
      case "suffix":
        return { type: "suffix", suffix: trimmedQuery || "_v2" };
      case "case":
        return { type: "case", caseMode: "lower" };
      case "number_cn":
        return { type: "number_cn" };
      case "number_roman":
        return { type: "number_roman" };
      case "trim_head3":
        return { type: "trim_head3" };
      case "clean_brackets":
        return { type: "clean_brackets" };
      case "snake_case":
        return { type: "snake_case" };
      case "number":
      default:
        return { type: "number", startNumber: 1, padDigits: 2 };
    }
  };

  const activeRule = buildActiveRule();

  const filterKeyword =
    trimmedQuery.includes("->") || ruleType === "prefix" || ruleType === "suffix"
      ? ""
      : trimmedQuery.toLowerCase();

  const visibleFiles = realFiles.filter((file) => {
    if (!filterKeyword) return true;
    return file.name.toLowerCase().includes(filterKeyword);
  });

  const checkedSet = new Set(checkedPaths);
  const seenTargetNames = new Set<string>();

  const previewItems = visibleFiles.map((file, idx) => {
    const isChecked = checkedSet.has(file.fullPath);
    const newName = applyRenameRule(file.name, activeRule, idx);
    const lowerTarget = newName.toLowerCase();
    const hasConflict = seenTargetNames.has(lowerTarget);
    seenTargetNames.add(lowerTarget);
    return {
      ...file,
      newName,
      changed: newName !== file.name,
      conflict: hasConflict,
      isChecked
    };
  });

  const selectedItems = previewItems.filter((item) => item.isChecked);
  const changedSelectedCount = selectedItems.filter((item) => item.changed && !item.conflict).length;
  const conflictCount = previewItems.filter((item) => item.conflict).length;

  const toggleFileCheck = (fullPath: string) => {
    setCheckedPaths((prev) =>
      prev.includes(fullPath) ? prev.filter((p) => p !== fullPath) : [...prev, fullPath]
    );
  };

  const toggleAllVisible = () => {
    const visiblePaths = previewItems.map((item) => item.fullPath);
    const allChecked = visiblePaths.length > 0 && visiblePaths.every((p) => checkedSet.has(p));
    if (allChecked) {
      const removeSet = new Set(visiblePaths);
      setCheckedPaths((prev) => prev.filter((p) => !removeSet.has(p)));
    } else {
      setCheckedPaths((prev) => Array.from(new Set([...prev, ...visiblePaths])));
    }
  };

  const executeBatchRename = async () => {
    const targets = selectedItems.filter((item) => item.changed && !item.conflict);
    if (targets.length === 0) {
      setStatusMessage("没有需要改名的已勾选文件，或存在同名冲突需先解除");
      return;
    }
    setIsLoading(true);
    const historyBatch: RenameUndoEntry[] = [];
    let successCount = 0;

    for (const item of targets) {
      const res = await executeRealFileRename(item.fullPath, item.newName);
      if (res.ok && res.destinationPath) {
        successCount += 1;
        historyBatch.push({
          oldPath: item.fullPath,
          newPath: res.destinationPath,
          oldName: item.name,
          newName: item.newName
        });
      }
    }

    if (historyBatch.length > 0) {
      setUndoStack(historyBatch);
    }
    setStatusMessage(`已完成批量重命名：成功改名 ${successCount}/${targets.length} 个文件 (支持一键撤销)`);
    await loadDirectoryFiles(sourceScope);
  };

  const handleUndoLastBatch = async () => {
    if (undoStack.length === 0) {
      setStatusMessage("当前没有可撤销的重命名历史记录");
      return;
    }
    setIsLoading(true);
    try {
      const res = await undoBatchRenameHistory(undoStack);
      setUndoStack([]);
      setStatusMessage(`已撤销回滚 ${res.restoredCount} 个文件至原文件名`);
      await loadDirectoryFiles(sourceScope);
    } finally {
      setIsLoading(false);
    }
  };

  const activePresetMeta =
    RENAME_RULE_PRESETS.find((r) => r.id === ruleType) || RENAME_RULE_PRESETS[0];
  const cleanActiveRuleLabel = stripLeadingEmoji(activePresetMeta.label);

  const summaryText =
    statusMessage ||
    `目录: ${currentDir} · 规则: ${cleanActiveRuleLabel} · 待改名 ${changedSelectedCount} 项` +
      (conflictCount > 0 ? ` · 检测到 ${conflictCount} 项同名冲突` : "") +
      (undoStack.length > 0 ? ` · 可撤销 ${undoStack.length} 项` : "");

  const maxSizeBytes = Math.max(1, ...previewItems.map((f) => f.sizeBytes));

  const leftNavNodes = RENAME_RULE_PRESETS.map((preset) => {
    const cleanLabel = stripLeadingEmoji(preset.label);
    const isActive = ruleType === preset.id;

    return List.Item({
      id: `nav-rule-${preset.id}`,
      title: cleanLabel,
      subtitle: preset.desc,
      icon: Icon.Document,
      onSelect: () => setRuleType(preset.id),
      accessories: [
        { tag: { value: isActive ? "当前生效" : "规则预设" } }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `切换至「${cleanLabel}」规则 (Enter)`,
            icon: Icon.CheckCircle,
            onAction: () => setRuleType(preset.id)
          }),
          Action({
            title: `立即执行批量重命名 (${changedSelectedCount} 项) (Ctrl+Enter)`,
            icon: Icon.ArrowRight,
            onAction: executeBatchRename
          }),
          Action({
            title: `撤销上一次批量重命名 (${undoStack.length} 项)`,
            icon: Icon.RotateAntiClockwise,
            onAction: handleUndoLastBatch
          })
        ]
      })
    });
  });

  const subListItems = previewItems.map((item) => {
    const ratio = Math.min(1, item.sizeBytes / maxSizeBytes);
    const statusLabel = item.conflict
      ? "同名冲突"
      : item.changed
        ? "待改名"
        : "保持不变";

    return List.Item({
      id: `rename-item-${item.fullPath}`,
      title: item.name,
      subtitle: `-> ${item.newName} (实时 Diff 预览)`,
      icon: Icon.Document,
      checkable: true,
      checked: item.isChecked,
      onCheckChange: () => toggleFileCheck(item.fullPath),
      onToggleCheck: () => toggleFileCheck(item.fullPath),
      accessories: [
        { progress: ratio },
        {
          tag: {
            value: statusLabel,
            color: item.conflict ? "red" : undefined
          }
        },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `执行批量重命名 (${changedSelectedCount} 个已选文件) (Enter)`,
            icon: Icon.CheckCircle,
            onAction: executeBatchRename
          }),
          Action({
            title:
              undoStack.length > 0
                ? `撤销上一次重命名回滚 (${undoStack.length} 项) (Ctrl+Enter)`
                : "在资源管理器中定位此文件 (Ctrl+Enter)",
            icon: undoStack.length > 0 ? Icon.RotateAntiClockwise : Icon.Folder,
            onAction: async () => {
              if (undoStack.length > 0) {
                await handleUndoLastBatch();
              } else {
                await openRenameFileLocation(item.fullPath);
              }
            }
          }),
          Action({
            title: "单条立即改名此文件",
            icon: Icon.Document,
            onAction: async () => {
              const res = await executeRealFileRename(item.fullPath, item.newName);
              setStatusMessage(
                res.ok ? `已将 ${item.name} 改名为 ${item.newName}` : `改名失败: ${res.error}`
              );
              await loadDirectoryFiles(sourceScope);
            }
          }),
          Action({
            title: "在资源管理器中定位此文件",
            icon: Icon.Folder,
            onAction: async () => {
              await openRenameFileLocation(item.fullPath);
            }
          })
        ]
      })
    });
  });

  const allChecked = previewItems.length > 0 && previewItems.every((f) => f.isChecked);
  const someChecked = previewItems.some((f) => f.isChecked);

  return List({
    isLoading,
    searchBarPlaceholder: "输入「旧词->新词」实时替换，或输入前缀/后缀参数、搜索文件名...",
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: "切换待重命名的本机目标文件夹",
      value: sourceScope,
      onChange: (val) => setSourceScope(val as SourceDirScope),
      children: SOURCE_SCOPES.map((s) =>
        List.Dropdown.Item({
          title: s.label,
          value: s.id
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
            void loadDirectoryFiles(sourceScope);
          }
        }
      ]
    },
    subList: {
      title: `原名 -> 新名实时对比预览 (${previewItems.length} 项 · 待执行 ${changedSelectedCount} 项)`,
      subtitle: currentDir,
      emptyText: "当前目录下暂无可重命名文件",
      checkable: previewItems.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "10 大重命名规则预设导航 (32%)",
        subtitle: "点击实时预览新文件名",
        children: leftNavNodes
      })
    ]
  });
}

export default BatchRenameCommand;
