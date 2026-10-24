/**
 * ZTools 2.0 标杆原生插件视图: 多线程分块高速下载工作台 (Multi-Download 2.0 - 布局二：左 32% 导航分类树 + 右 68% 可勾选明细列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 6 大下载文件分类导航树 + 右 68% 可勾选已下载文件与任务明细队列
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换 Aria2 分块并发线程档位 (16/8/4/1 线程)
 * 3. 单行极简状态条：filterBar.summaryText 融合下载目录可用空间、Aria2 RPC 状态、剪贴板链接嗅探与右侧勾选汇总，仅保留 1 个全局刷新按钮
 * 4. 零彩色 Emoji 与去彩虹化：100% 单色 SVG 图标、中性灰进度条与标签，仅在磁盘空间告警时点缀红色
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  DOWNLOAD_CATEGORIES,
  THREAD_SPLIT_PRESETS,
  deleteDownloadedFiles,
  fetchMultiDownloadSnapshot,
  formatBytes,
  openDownloadedFile,
  openDownloadedFileLocation,
  startMultiThreadDownloadTask,
  type DownloadFileCategory,
  type DownloadedFileItem,
  type MultiDownloadSnapshot,
  type ThreadSplitPresetId
} from "./logic.js";

function createInitialMultiDownloadSnapshot(): MultiDownloadSnapshot {
  const inRealHost = isRealElectronHost();
  const defaultFiles: DownloadedFileItem[] = inRealHost
    ? []
    : [
        {
          id: "dl_init_0",
          name: "ZTools-Setup-2.0.0-x64.exe",
          path: "C:\\Users\\Default\\Downloads\\ZTools-Setup-2.0.0-x64.exe",
          ext: ".exe",
          sizeBytes: 148 * 1024 * 1024,
          mtimeMs: Date.now() - 3600_000,
          category: "installer",
          categoryName: "应用安装包",
          categoryColor: "var(--rc-text-muted)",
          categoryIcon: "box"
        },
        {
          id: "dl_init_1",
          name: "Windows11_24H2_Chinese_x64.iso",
          path: "C:\\Users\\Default\\Downloads\\Windows11_24H2_Chinese_x64.iso",
          ext: ".iso",
          sizeBytes: 5420 * 1024 * 1024,
          mtimeMs: Date.now() - 7200_000,
          category: "iso_image",
          categoryName: "系统镜像与模型",
          categoryColor: "var(--rc-text-muted)",
          categoryIcon: "disc"
        },
        {
          id: "dl_init_2",
          name: "project-release-bundle-v2.zip",
          path: "C:\\Users\\Default\\Downloads\\project-release-bundle-v2.zip",
          ext: ".zip",
          sizeBytes: 320 * 1024 * 1024,
          mtimeMs: Date.now() - 10800_000,
          category: "archive",
          categoryName: "压缩归档包",
          categoryColor: "var(--rc-text-muted)",
          categoryIcon: "archive"
        },
        {
          id: "dl_init_3",
          name: "keynote-recording-4k60.mp4",
          path: "C:\\Users\\Default\\Downloads\\keynote-recording-4k60.mp4",
          ext: ".mp4",
          sizeBytes: 860 * 1024 * 1024,
          mtimeMs: Date.now() - 14400_000,
          category: "media",
          categoryName: "音视频与图像",
          categoryColor: "var(--rc-text-muted)",
          categoryIcon: "video"
        },
        {
          id: "dl_init_4",
          name: "architecture-specification-2026.pdf",
          path: "C:\\Users\\Default\\Downloads\\architecture-specification-2026.pdf",
          ext: ".pdf",
          sizeBytes: 24 * 1024 * 1024,
          mtimeMs: Date.now() - 18000_000,
          category: "document",
          categoryName: "办公文档与脚本",
          categoryColor: "var(--rc-text-muted)",
          categoryIcon: "file-text"
        }
      ];

  const totalSizeBytes = defaultFiles.reduce((acc, item) => acc + item.sizeBytes, 0);

  return {
    downloadDir: "C:\\Users\\Default\\Downloads",
    driveLetter: "C:",
    driveFreeBytes: inRealHost ? 0 : 128 * 1024 * 1024 * 1024,
    driveTotalBytes: inRealHost ? 0 : 512 * 1024 * 1024 * 1024,
    aria2RpcOnline: false,
    aria2Endpoint: "http://127.0.0.1:6800/jsonrpc",
    sniffedClipboardUrl: "",
    sniffedProtocol: "HTTPS 多线程直链",
    files: defaultFiles,
    totalSizeBytes,
    categoryStats: DOWNLOAD_CATEGORIES.map((cat) => {
      const matched = defaultFiles.filter((f) => f.category === cat.id);
      return {
        category: cat.id,
        name: cat.name,
        color: "var(--rc-text-muted)",
        sizeBytes: matched.reduce((s, f) => s + f.sizeBytes, 0),
        count: matched.length
      };
    }),
    updatedAt: "初始化就绪"
  };
}

export function MultiDownloadCommand() {
  const [snapshot, setSnapshot] = useState<MultiDownloadSnapshot>(() => createInitialMultiDownloadSnapshot());
  const [selectedCategory, setSelectedCategory] = useState<DownloadFileCategory>("all");
  const [selectedPresetId, setSelectedPresetId] = useState<ThreadSplitPresetId>("threads_16");
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost() ? [] : ["dl_init_0", "dl_init_1", "dl_init_2"]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [customUrlInput, setCustomUrlInput] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadDownloadSnapshot = async () => {
    setIsLoading(true);
    try {
      const data = await fetchMultiDownloadSnapshot();
      if (isRealElectronHost() || data.files.length > 0) {
        setSnapshot(data);
        setCheckedIds(data.files.slice(0, 6).map((item) => item.id));
        if (data.sniffedClipboardUrl && !customUrlInput) {
          setCustomUrlInput(data.sniffedClipboardUrl);
        }
        setStatusBanner(
          `已扫描 ${data.downloadDir} · 共 ${data.files.length} 个已下载文件 (${formatBytes(data.totalSizeBytes)})`
        );
      } else {
        setStatusBanner(
          `已探测下载目录 ${data.downloadDir} · 盘符剩余可用 ${formatBytes(data.driveFreeBytes)}`
        );
      }
    } catch (err) {
      setStatusBanner(`扫描下载目录失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadDownloadSnapshot();
  }, []);

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

  const filteredFiles = snapshot.files.filter((file) => {
    if (selectedCategory !== "all" && file.category !== selectedCategory) return false;
    if (keyword) {
      const hay = `${file.name} ${file.path} ${file.categoryName}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(checkedIds);
  const selectedFiles = snapshot.files.filter((file) => checkedSet.has(file.id));
  const selectedTotalBytes = selectedFiles.reduce((acc, item) => acc + item.sizeBytes, 0);

  const activeDownloadUrl = customUrlInput.trim() || snapshot.sniffedClipboardUrl;

  const toggleFileCheck = (id: string) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleAllVisible = () => {
    const visibleIds = filteredFiles.map((f) => f.id);
    const allChecked = visibleIds.length > 0 && visibleIds.every((id) => checkedSet.has(id));
    if (allChecked) {
      const removeSet = new Set(visibleIds);
      setCheckedIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setCheckedIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const handleStartDownload = async (urlToDownload?: string) => {
    const targetUrl = (urlToDownload ?? activeDownloadUrl).trim();
    if (!targetUrl) {
      setStatusBanner("请先复制下载链接到剪贴板，或在顶部搜索框粘贴 HTTP/HTTPS/Magnet 链接");
      return;
    }
    setIsLoading(true);
    try {
      const res = await startMultiThreadDownloadTask(targetUrl, snapshot.downloadDir, currentPreset);
      setStatusBanner(res.message);
      await reloadDownloadSnapshot();
    } finally {
      setIsLoading(false);
    }
  };

  const handleBatchTrashSelected = async () => {
    const targetList = selectedFiles.length > 0 ? selectedFiles : filteredFiles.slice(0, 1);
    if (targetList.length === 0) return;
    setIsLoading(true);
    try {
      const res = await deleteDownloadedFiles(targetList.map((f) => f.path), targetList);
      setStatusBanner(
        res.deletedCount > 0
          ? `已将 ${res.deletedCount} 个下载文件移入回收站，释放 ${formatBytes(res.freedBytes)}`
          : "已完成所选下载文件清理操作"
      );
      await reloadDownloadSnapshot();
    } finally {
      setIsLoading(false);
    }
  };

  const maxCategoryBytes = Math.max(1, ...snapshot.categoryStats.map((c) => c.sizeBytes));
  const maxFileBytes = Math.max(1, ...filteredFiles.map((f) => f.sizeBytes));
  const driveLowSpace =
    snapshot.driveTotalBytes > 0 && snapshot.driveFreeBytes / snapshot.driveTotalBytes < 0.1;

  const summaryText =
    statusBanner ||
    `${snapshot.driveLetter} 剩余 ${formatBytes(snapshot.driveFreeBytes)} · 已选 ${selectedFiles.length}/${filteredFiles.length} 项 (${formatBytes(selectedTotalBytes)}) · 引擎: ${currentPreset.name}`;

  const leftNavNodes = [
    List.Item({
      id: "nav-dl-all",
      title: "全部已下载文件",
      subtitle: `${snapshot.downloadDir} (${snapshot.files.length} 个文件)`,
      icon: Icon.Folder,
      onSelect: () => setSelectedCategory("all"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${snapshot.files.length} 项` } },
        { text: formatBytes(snapshot.totalSizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeDownloadUrl
              ? `发起 ${currentPreset.threads} 线程高速下载 (Enter)`
              : "读取剪贴板链接并下载 (Enter)",
            icon: Icon.Download,
            onAction: () => handleStartDownload(activeDownloadUrl)
          }),
          Action({
            title: "打开本机下载目录 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openDownloadedFile(snapshot.downloadDir);
            }
          }),
          Action({
            title: `清理已勾选文件 (${selectedFiles.length} 项)`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleBatchTrashSelected
          })
        ]
      })
    }),
    ...DOWNLOAD_CATEGORIES.map((cat) => {
      const stat = snapshot.categoryStats.find((s) => s.category === cat.id);
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
              title: `筛选 ${cat.name} (Enter)`,
              icon: Icon.Filter,
              onAction: () => setSelectedCategory(cat.id)
            }),
            Action({
              title: "打开本机下载目录 (Ctrl+Enter)",
              icon: Icon.Folder,
              onAction: async () => {
                await openDownloadedFile(snapshot.downloadDir);
              }
            })
          ]
        })
      });
    })
  ];

  const subListItems = filteredFiles.map((file) => {
    const isChecked = checkedSet.has(file.id);
    const ratio = Math.min(1, file.sizeBytes / maxFileBytes);
    const dateStr = file.mtimeMs > 0 ? new Date(file.mtimeMs).toLocaleDateString() : "近期下载";

    return List.Item({
      id: `dl-file-${file.id}`,
      title: file.name,
      subtitle: `${file.path} · ${dateStr}`,
      icon: Icon.Document,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => toggleFileCheck(file.id),
      onToggleCheck: () => toggleFileCheck(file.id),
      accessories: [
        { progress: ratio },
        { tag: { value: file.categoryName } },
        { text: formatBytes(file.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeDownloadUrl
              ? `发起 ${currentPreset.threads} 线程分块下载 (Enter)`
              : "直接打开此下载文件 (Enter)",
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
            title: "在资源管理器中定位文件 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openDownloadedFileLocation(file.path);
            }
          }),
          Action({
            title: isChecked ? "取消勾选此文件" : "勾选此文件",
            icon: Icon.CheckCircle,
            onAction: () => toggleFileCheck(file.id)
          }),
          Action({
            title: `批量移入回收站清理 (${selectedFiles.length} 项 / ${formatBytes(selectedTotalBytes)})`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleBatchTrashSelected
          })
        ]
      })
    });
  });

  const activeCategoryName =
    selectedCategory === "all"
      ? "全部已下载文件"
      : DOWNLOAD_CATEGORIES.find((c) => c.id === selectedCategory)?.name || "下载文件";

  const allChecked = filteredFiles.length > 0 && filteredFiles.every((f) => checkedSet.has(f.id));
  const someChecked = filteredFiles.some((f) => checkedSet.has(f.id));

  return List({
    isLoading,
    searchBarPlaceholder: "粘贴 HTTP/HTTPS/FTP/Magnet 下载链接，或搜索本地已下载文件名...",
    onSearchTextChange: handleSearchChange,
    isShowingDetail: false,
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
      summaryText,
      actions: [
        {
          id: "rescan",
          title: "重新扫描",
          style: "secondary",
          onAction: () => {
            void reloadDownloadSnapshot();
          }
        }
      ]
    },
    subList: {
      title: `${activeCategoryName} (${filteredFiles.length} 项 · 已选 ${formatBytes(selectedTotalBytes)})`,
      subtitle: snapshot.downloadDir,
      emptyText: "当前分类下暂无匹配的下载文件",
      checkable: filteredFiles.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "下载文件分类导航树 (32%)",
        subtitle: `${snapshot.files.length} 个文件`,
        children: leftNavNodes
      })
    ]
  });
}

export default MultiDownloadCommand;
