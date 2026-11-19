/**
 * ZTools 2.0 标杆原生插件视图: 多线程分块高速下载工作台 (Multi-Download 2.0 - 布局二：左 32% 导航分类树 + 右 68% 明细队列)
 *
 * 严格遵循显式导入规范：
 * 1. 挂载时不扫描本机 Downloads 目录、不偷读剪贴板，初始文件列表为空 `[]`
 * 2. 顶栏 filterBar.actions 最多 2 个：「选择文件」「选择文件夹」，另支持拖入文件/文件夹与粘贴下载链接
 * 3. 本次下载完成的文件或手动导入的文件均展示在右栏，动作面板支持「从列表移除」与「清空列表」
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { getRealFileSize } from "../shared/native-ipc.js";
import {
  buildImportEmptyActionPanel,
  buildListManagementSection,
  useExampleImportQueue
} from "../shared/import-ui.js";
import {
  DOWNLOAD_CATEGORIES,
  MULTI_DOWNLOAD_IMPORT_RULES,
  THREAD_SPLIT_PRESETS,
  computeDownloadCategoryStats,
  deleteDownloadedFiles,
  detectDownloadUrlFromText,
  ensureMultiDownloadDirectory,
  fetchMultiDownloadSnapshot,
  formatBytes,
  openDownloadedFile,
  openDownloadedFileLocation,
  readClipboardDownloadUrl,
  startMultiThreadDownloadTask,
  toDownloadedFileItem,
  type DownloadFileCategory,
  type DownloadedFileItem,
  type ThreadSplitPresetId
} from "./logic.js";

export function MultiDownloadCommand() {
  const [downloadDir, setDownloadDir] = useState<string>("");
  const [driveLetter, setDriveLetter] = useState<string>("C:");
  const [driveFreeBytes, setDriveFreeBytes] = useState<number>(0);
  const [driveTotalBytes, setDriveTotalBytes] = useState<number>(0);
  const [selectedCategory, setSelectedCategory] = useState<DownloadFileCategory>("all");
  const [selectedPresetId, setSelectedPresetId] = useState<ThreadSplitPresetId>("threads_16");
  const [searchText, setSearchText] = useState<string>("");
  const [customUrlInput, setCustomUrlInput] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const queue = useExampleImportQueue<DownloadedFileItem>({
    rules: MULTI_DOWNLOAD_IMPORT_RULES,
    toItem: toDownloadedFileItem,
    pathOf: (item) => item.path,
    idOf: (item) => item.id,
    fileTitle: "选择已下载文件",
    folderTitle: "选择下载文件夹",
    defaultChecked: false,
    isBusy: () => isLoading,
    dropTitle: "拖入文件或下载目录",
    dropSubtitle: "松开后加入下载队列，或按 Ctrl+V 粘贴下载链接",
    onTextPaste: (text) => {
      const parsed = detectDownloadUrlFromText(text);
      if (!parsed.url) return false;
      setCustomUrlInput(parsed.url);
      setStatusBanner(`已从粘贴识别 ${parsed.protocol} 链接`);
      return true;
    },
    onImported: (added, merged) => {
      if (added[0]?.path && !downloadDir) {
        const idx = Math.max(added[0].path.lastIndexOf("/"), added[0].path.lastIndexOf("\\"));
        if (idx > 0) setDownloadDir(added[0].path.slice(0, idx));
      }
      setStatusBanner(`已导入 ${added.length} 个文件，当前共 ${merged.length} 项`);
    },
    onCleared: () => setStatusBanner("已清空下载文件列表")
  });

  useEffect(() => {
    let active = true;
    void fetchMultiDownloadSnapshot(undefined, downloadDir)
      .then((snap) => {
        if (!active) return;
        setDriveLetter(snap.driveLetter);
        setDriveFreeBytes(snap.driveFreeBytes);
        setDriveTotalBytes(snap.driveTotalBytes);
      })
      .catch(() => {
        // 磁盘空间探查失败时维持空状态，不阻塞界面渲染
      });
    return () => {
      active = false;
    };
  }, [downloadDir]);

  const currentPreset =
    THREAD_SPLIT_PRESETS.find((p) => p.id === selectedPresetId) || THREAD_SPLIT_PRESETS[0];

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    if (/^(https?|ftp|magnet):/i.test(text.trim())) {
      setCustomUrlInput(text.trim());
    }
  };

  const keyword =
    /^(https?|ftp|magnet):/i.test(searchText.trim()) ? "" : searchText.trim().toLowerCase();

  const filteredFiles = queue.items.filter((file) => {
    if (selectedCategory !== "all" && file.category !== selectedCategory) return false;
    if (keyword) {
      const hay = `${file.name} ${file.path} ${file.categoryName}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(queue.checkedIds);
  const selectedFiles = queue.items.filter((file) => checkedSet.has(file.id));
  const selectedTotalBytes = selectedFiles.reduce((acc, item) => acc + item.sizeBytes, 0);
  const totalSizeBytes = queue.items.reduce((acc, item) => acc + item.sizeBytes, 0);
  const categoryStats = computeDownloadCategoryStats(queue.items);
  const activeDownloadUrl = customUrlInput.trim();

  const handleReadClipboardUrl = async () => {
    const clip = await readClipboardDownloadUrl();
    if (!clip.url) {
      setStatusBanner("剪贴板中未检测到 HTTP/HTTPS/FTP/Magnet 下载链接");
      return;
    }
    setCustomUrlInput(clip.url);
    setStatusBanner(`已识别剪贴板链接：${clip.protocol}`);
  };

  const handleStartDownload = async (urlToDownload?: string) => {
    const targetUrl = (urlToDownload ?? activeDownloadUrl).trim();
    if (!targetUrl) {
      setStatusBanner("请在顶部搜索框粘贴下载链接，或先点击「读取剪贴板下载链接」");
      return;
    }
    setIsLoading(true);
    try {
      const resolvedDir = await ensureMultiDownloadDirectory(downloadDir);
      if (!resolvedDir) {
        setStatusBanner("未能获取下载保存目录，请先通过「选择文件夹」指定目录");
        return;
      }
      if (!downloadDir) setDownloadDir(resolvedDir);
      const res = await startMultiThreadDownloadTask(targetUrl, resolvedDir, currentPreset);
      setStatusBanner(res.message);
      const destPath =
        res.ok && res.data && typeof res.data === "object"
          ? String((res.data as { destPath?: unknown }).destPath || "")
          : "";
      if (res.ok && destPath) {
        const size = await getRealFileSize(destPath);
        const name = destPath.split(/[\\/]/).pop() || "downloaded_file.bin";
        const extIdx = name.lastIndexOf(".");
        const item = toDownloadedFileItem({
          path: destPath,
          name,
          parentDir: resolvedDir,
          extension: extIdx > 0 ? name.slice(extIdx).toLowerCase() : ".bin",
          sizeBytes: size,
          lastModifiedMs: Date.now()
        });
        queue.setItems((prev) =>
          prev.some((f) => f.path.toLowerCase() === destPath.toLowerCase()) ? prev : [item, ...prev]
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenDownloadDir = async () => {
    const resolvedDir = await ensureMultiDownloadDirectory(downloadDir);
    if (!resolvedDir) {
      setStatusBanner("暂无可打开的下载目录，请先导入文件夹");
      return;
    }
    if (!downloadDir) setDownloadDir(resolvedDir);
    await openDownloadedFile(resolvedDir);
  };

  const handleBatchTrashSelected = async () => {
    const targetList = selectedFiles.length > 0 ? selectedFiles : filteredFiles.slice(0, 1);
    if (targetList.length === 0) return;
    setIsLoading(true);
    try {
      const res = await deleteDownloadedFiles(targetList.map((f) => f.path), targetList);
      if (res.deletedCount > 0) {
        const removed = new Set(targetList.map((t) => t.path.toLowerCase()));
        queue.setItems((prev) => prev.filter((item) => !removed.has(item.path.toLowerCase())));
        queue.setCheckedIds((prev) => prev.filter((id) => !targetList.some((t) => t.id === id)));
      }
      setStatusBanner(
        res.deletedCount > 0
          ? `已将 ${res.deletedCount} 个下载文件移入回收站，释放 ${formatBytes(res.freedBytes)}`
          : "已完成所选下载文件清理操作"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const maxCategoryBytes = Math.max(1, ...categoryStats.map((c) => c.sizeBytes));
  const maxFileBytes = Math.max(1, ...filteredFiles.map((f) => f.sizeBytes));
  const driveLowSpace = driveTotalBytes > 0 && driveFreeBytes / driveTotalBytes < 0.1;

  const summaryText =
    queue.importStatusText ||
    statusBanner ||
    `${driveLetter} 剩余 ${formatBytes(driveFreeBytes)} · 已选 ${selectedFiles.length}/${filteredFiles.length} 项 (${formatBytes(selectedTotalBytes)}) · 引擎: ${currentPreset.name}`;

  const leftNavNodes = [
    List.Item({
      id: "nav-dl-all",
      title: "全部已下载文件",
      subtitle: `${downloadDir || "尚未指定下载目录"} (${queue.items.length} 个文件)`,
      icon: Icon.Folder,
      onSelect: () => setSelectedCategory("all"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${queue.items.length} 项` } },
        { text: formatBytes(totalSizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeDownloadUrl
              ? `发起 ${currentPreset.threads} 线程高速下载`
              : "启动当前链接下载",
            icon: Icon.Download,
            onAction: () => handleStartDownload(activeDownloadUrl)
          }),
          Action({
            title: "读取剪贴板中的下载链接",
            icon: Icon.Clipboard,
            onAction: handleReadClipboardUrl
          }),
          Action({
            title: "打开本机下载目录",
            icon: Icon.Folder,
            onAction: handleOpenDownloadDir
          }),
          Action({
            title: `清理已勾选文件 (${selectedFiles.length} 项)`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleBatchTrashSelected
          }),
          buildListManagementSection({
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onClear: queue.clearQueue
          })
        ]
      })
    }),
    ...DOWNLOAD_CATEGORIES.map((cat) => {
      const stat = categoryStats.find((s) => s.category === cat.id);
      const catSize = stat?.sizeBytes || 0;
      const catCount = stat?.count || 0;
      const ratio = Math.min(1, catSize / maxCategoryBytes);

      return List.Item({
        id: `nav-dl-${cat.id}`,
        title: cat.name,
        subtitle: cat.exts.length > 0 ? `支持后缀: ${cat.exts.slice(0, 5).join(" ")}` : "其他未分类下载文件",
        icon: Icon.Document,
        onSelect: () => setSelectedCategory(cat.id),
        accessories: [
          { progress: ratio },
          { tag: { value: `${catCount} 项` } },
          { text: formatBytes(catSize) }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `筛选 ${cat.name}`,
              icon: Icon.Filter,
              onAction: () => setSelectedCategory(cat.id)
            }),
            Action({
              title: "读取剪贴板中的下载链接",
              icon: Icon.Clipboard,
              onAction: handleReadClipboardUrl
            }),
            Action({
              title: "打开本机下载目录",
              icon: Icon.Folder,
              onAction: handleOpenDownloadDir
            })
          ]
        })
      });
    })
  ];

  const allChecked = filteredFiles.length > 0 && filteredFiles.every((f) => checkedSet.has(f.id));
  const someChecked = filteredFiles.some((f) => checkedSet.has(f.id));

  const subListItems = filteredFiles.map((file) => {
    const isChecked = checkedSet.has(file.id);
    const ratio = Math.min(1, file.sizeBytes / maxFileBytes);
    const dateStr = file.mtimeMs > 0 ? new Date(file.mtimeMs).toLocaleDateString() : "本地文件";

    return List.Item({
      id: `dl-file-${file.id}`,
      title: file.name,
      subtitle: `${file.path} · ${dateStr}`,
      icon: Icon.Document,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => queue.toggleCheck(file.id),
      onToggleCheck: () => queue.toggleCheck(file.id),
      accessories: [
        { progress: ratio },
        { tag: { value: file.categoryName } },
        { text: formatBytes(file.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeDownloadUrl
              ? `发起 ${currentPreset.threads} 线程分块下载`
              : "直接打开此下载文件",
            icon: activeDownloadUrl ? Icon.Download : Icon.ArrowRight,
            onAction: async () => {
              if (activeDownloadUrl) {
                await handleStartDownload(activeDownloadUrl);
              } else {
                await openDownloadedFile(file.path);
              }
            }
          }),
          Action({
            title: "在资源管理器中定位文件",
            icon: Icon.Folder,
            onAction: async () => {
              await openDownloadedFileLocation(file.path);
            }
          }),
          Action({
            title: isChecked ? "取消勾选此文件" : "勾选此文件",
            icon: Icon.CheckCircle,
            onAction: () => queue.toggleCheck(file.id)
          }),
          Action({
            title: `批量移入回收站清理 (${selectedFiles.length} 项 / ${formatBytes(selectedTotalBytes)})`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleBatchTrashSelected
          }),
          buildListManagementSection({
            onRemove: () => queue.removeItem(file.id),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(filteredFiles),
            allSelected: allChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    });
  });

  const activeCategoryName =
    selectedCategory === "all"
      ? "全部已下载文件"
      : DOWNLOAD_CATEGORIES.find((c) => c.id === selectedCategory)?.name || "下载文件";

  return List({
    isLoading: isLoading || queue.isImporting,
    searchBarPlaceholder: "粘贴 HTTP/HTTPS/FTP/Magnet 下载链接，或搜索已导入文件...",
    onSearchTextChange: handleSearchChange,
    isShowingDetail: false,
    ...queue.fileInputProps,
    searchBarAccessory: List.Dropdown({
      tooltip: "切换多线程分块加速档位",
      value: selectedPresetId,
      onChange: (val) => setSelectedPresetId(val as ThreadSplitPresetId),
      children: THREAD_SPLIT_PRESETS.map((preset) =>
        List.Dropdown.Item({
          title: `${preset.name} (分块 ${preset.splitSize})`,
          value: preset.id
        })
      )
    }),
    filterBar: {
      summaryText: driveLowSpace ? `磁盘空间偏低 · ${summaryText}` : summaryText,
      actions: queue.topBarActions
    },
    subList: {
      title: `${activeCategoryName} (${filteredFiles.length} 项 · 已选 ${formatBytes(selectedTotalBytes)})`,
      subtitle: downloadDir || "支持拖入文件/文件夹、选择文件或粘贴链接下载",
      emptyText: "列表为空，请点击顶部「选择文件 / 选择文件夹」导入文件，或粘贴下载链接",
      checkable: filteredFiles.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => queue.toggleAllVisible(filteredFiles),
      items: subListItems
    },
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder, [
      Action({
        title: "读取剪贴板中的下载链接",
        icon: Icon.Clipboard,
        onAction: handleReadClipboardUrl
      })
    ]),
    children: [
      List.Section({
        title: "下载文件分类导航树 (32%)",
        subtitle: `${queue.items.length} 个文件`,
        children: leftNavNodes
      })
    ]
  });
}

export default MultiDownloadCommand;
