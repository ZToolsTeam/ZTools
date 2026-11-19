/**
 * ZTools 2.0 标杆原生插件视图: 全平台流媒体音视频解析与下载工坊 (Video Downloader 2.0 - 布局二：左 32% 平台分类树 + 右 68% 视频队列)
 *
 * 严格遵循显式导入规范：
 * 1. 挂载时不扫描本机 Videos/Downloads 目录、不读取剪贴板，初始视频队列为空 `[]`
 * 2. 顶栏 filterBar.actions 最多 2 个：「选择文件」「选择文件夹」，另支持拖入视频/文件夹与粘贴下载链接
 * 3. 本次下载完成的文件或手动导入的视频均汇总展示在右栏，动作面板支持「从列表移除」与「清空列表」
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { getRealFileSize } from "../shared/native-ipc.js";
import {
  buildImportEmptyActionPanel,
  buildListManagementSection,
  useExampleImportQueue
} from "../shared/import-ui.js";
import {
  STREAM_PLATFORMS,
  VIDEO_DOWNLOADER_IMPORT_RULES,
  VIDEO_QUALITY_PRESETS,
  detectVideoPlatform,
  ensureVideoSaveDirectory,
  fetchVideoDownloaderSnapshot,
  formatBytes,
  openLocalVideoFile,
  openLocalVideoFolder,
  parseAndDownloadStreamVideo,
  readClipboardStreamUrl,
  toLocalMediaVideoItem,
  trashLocalVideoFiles,
  type LocalMediaVideoItem,
  type StreamPlatformId,
  type VideoQualityPresetId
} from "./logic.js";

export function VideoDownloaderCommand() {
  const [saveDir, setSaveDir] = useState<string>("");
  const [driveLetter, setDriveLetter] = useState<string>("C:");
  const [driveFreeBytes, setDriveFreeBytes] = useState<number>(0);
  const [selectedPlatform, setSelectedPlatform] = useState<StreamPlatformId>("auto");
  const [selectedQuality, setSelectedQuality] = useState<VideoQualityPresetId>("q_1080p_mp4");
  const [searchText, setSearchText] = useState<string>("");
  const [streamInput, setStreamInput] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const queue = useExampleImportQueue<LocalMediaVideoItem>({
    rules: VIDEO_DOWNLOADER_IMPORT_RULES,
    toItem: (entry) => toLocalMediaVideoItem(entry, entry.parentDir || "手动导入"),
    pathOf: (item) => item.path,
    idOf: (item) => item.id,
    fileTitle: "选择本地视频文件",
    folderTitle: "选择本地视频文件夹",
    filterName: "视频文件",
    supportedText: "仅支持 mp4/mkv/mov/webm/flv/avi 等视频格式",
    defaultChecked: false,
    isBusy: () => isLoading,
    dropTitle: "拖入视频文件或文件夹",
    dropSubtitle: "松开后加入本地视频队列，或按 Ctrl+V 粘贴视频链接",
    onTextPaste: (text) => {
      const detectedPaste = detectVideoPlatform(text);
      if (!detectedPaste.url) return false;
      setStreamInput(detectedPaste.url);
      setStatusBanner(`已从粘贴识别 ${detectedPaste.platform.name} 链接`);
      return true;
    },
    onImported: (added, merged) => {
      if (added[0]?.path && !saveDir) {
        const idx = Math.max(added[0].path.lastIndexOf("/"), added[0].path.lastIndexOf("\\"));
        if (idx > 0) setSaveDir(added[0].path.slice(0, idx));
      }
      setStatusBanner(`已导入 ${added.length} 个视频，当前共 ${merged.length} 项`);
    },
    onCleared: () => setStatusBanner("已清空本地视频列表")
  });

  useEffect(() => {
    let active = true;
    void fetchVideoDownloaderSnapshot(undefined, saveDir)
      .then((snap) => {
        if (!active) return;
        setDriveLetter(snap.driveLetter);
        setDriveFreeBytes(snap.driveFreeBytes);
      })
      .catch(() => {
        // 磁盘空间探测失败时维持默认空状态，不阻塞界面渲染
      });
    return () => {
      active = false;
    };
  }, [saveDir]);

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    if (/(https?:\/\/|\bBV[0-9A-Za-z]{10}\b)/i.test(text.trim())) {
      setStreamInput(text.trim());
    }
  };

  const activeInputText = streamInput.trim();
  const detected = detectVideoPlatform(activeInputText);
  const currentQuality =
    VIDEO_QUALITY_PRESETS.find((q) => q.id === selectedQuality) || VIDEO_QUALITY_PRESETS[1];

  const isUrlSearch = /(https?:\/\/|\bBV[0-9A-Za-z]{10}\b)/i.test(searchText.trim());
  const keyword = isUrlSearch ? "" : searchText.trim().toLowerCase();

  const filteredVideos = queue.items.filter((video) => {
    if (selectedPlatform !== "auto") {
      const nameLower = video.name.toLowerCase();
      if (selectedPlatform === "bilibili" && !nameLower.includes("bili") && !nameLower.includes("bv")) {
        // 保留本地已有视频展示以便统一管理
      }
    }
    if (!keyword) return true;
    return `${video.name} ${video.path} ${video.sourceDirLabel} ${video.resolutionLabel}`
      .toLowerCase()
      .includes(keyword);
  });

  const checkedSet = new Set(queue.checkedIds);
  const selectedVideos = queue.items.filter((v) => checkedSet.has(v.id));
  const selectedTotalBytes = selectedVideos.reduce((acc, item) => acc + item.sizeBytes, 0);
  const totalSizeBytes = queue.items.reduce((acc, item) => acc + item.sizeBytes, 0);

  const handleReadClipboardUrl = async () => {
    const clip = await readClipboardStreamUrl();
    if (!clip.url) {
      setStatusBanner("剪贴板中未检测到 B站/抖音/快手/YouTube/M3U8 视频链接");
      return;
    }
    setStreamInput(clip.url);
    setStatusBanner(`已识别剪贴板链接：${clip.platform.name}`);
  };

  const handleParseAndDownload = async (rawInput?: string) => {
    const target = (rawInput ?? activeInputText).trim();
    if (!target) {
      setStatusBanner("请在搜索框粘贴视频链接，或先点击「读取剪贴板链接」");
      return;
    }
    setIsLoading(true);
    try {
      const resolvedDir = await ensureVideoSaveDirectory(saveDir);
      if (!resolvedDir) {
        setStatusBanner("未能获取视频保存目录，请先通过「选择文件夹」指定目录");
        return;
      }
      if (!saveDir) setSaveDir(resolvedDir);
      const res = await parseAndDownloadStreamVideo(target, resolvedDir, currentQuality);
      setStatusBanner(res.message);
      const destPath =
        res.ok && res.data && typeof res.data === "object"
          ? String((res.data as { destPath?: unknown }).destPath || "")
          : "";
      if (res.ok && destPath) {
        const size = await getRealFileSize(destPath);
        const name = destPath.split(/[\\/]/).pop() || "downloaded_video.mp4";
        const extIdx = name.lastIndexOf(".");
        const item = toLocalMediaVideoItem(
          {
            path: destPath,
            name,
            parentDir: resolvedDir,
            extension: extIdx > 0 ? name.slice(extIdx).toLowerCase() : ".mp4",
            sizeBytes: size,
            lastModifiedMs: Date.now()
          },
          "本次下载"
        );
        queue.setItems((prev) =>
          prev.some((v) => v.path.toLowerCase() === destPath.toLowerCase()) ? prev : [item, ...prev]
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenSaveDirectory = async () => {
    const resolvedDir = await ensureVideoSaveDirectory(saveDir);
    if (!resolvedDir) {
      setStatusBanner("暂无可打开的保存目录，请先导入文件夹");
      return;
    }
    if (!saveDir) setSaveDir(resolvedDir);
    await openLocalVideoFile(resolvedDir);
  };

  const handleTrashSelected = async () => {
    const targets = selectedVideos.length > 0 ? selectedVideos : filteredVideos.slice(0, 1);
    if (targets.length === 0) return;
    setIsLoading(true);
    try {
      const res = await trashLocalVideoFiles(
        targets.map((v) => v.path),
        targets
      );
      if (res.deletedCount > 0) {
        const removedPaths = new Set(targets.map((t) => t.path.toLowerCase()));
        queue.setItems((prev) => prev.filter((item) => !removedPaths.has(item.path.toLowerCase())));
        queue.setCheckedIds((prev) =>
          prev.filter((id) => !targets.some((t) => t.id === id))
        );
      }
      setStatusBanner(
        res.deletedCount > 0
          ? `已将 ${res.deletedCount} 个本地视频移入回收站，释放 ${formatBytes(res.freedBytes)}`
          : "本地视频清理操作未删除任何文件"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const maxVideoBytes = Math.max(1, ...filteredVideos.map((v) => v.sizeBytes));
  const summaryText =
    queue.importStatusText ||
    statusBanner ||
    `解析引擎: ${detected.platform.name} · 档位: ${currentQuality.badge} · 队列 ${filteredVideos.length} 项 (${driveLetter} 可用 ${formatBytes(driveFreeBytes)})`;

  const leftNavNodes = [
    List.Item({
      id: "nav-plat-auto",
      title: "全部平台与本地视频队列",
      subtitle: saveDir || "尚未指定保存目录（点击选择文件夹或粘贴链接开始）",
      icon: Icon.Video,
      onSelect: () => setSelectedPlatform("auto"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${queue.items.length} 部` } },
        { text: formatBytes(totalSizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeInputText ? `一键解析并下载 [${currentQuality.badge}]` : "解析当前输入链接",
            icon: Icon.Download,
            onAction: () => handleParseAndDownload(activeInputText)
          }),
          Action({
            title: "读取剪贴板中的视频链接",
            icon: Icon.Clipboard,
            onAction: handleReadClipboardUrl
          }),
          Action({
            title: "打开视频保存目录",
            icon: Icon.Folder,
            onAction: handleOpenSaveDirectory
          }),
          Action({
            title: `清理已勾选本地视频 (${selectedVideos.length} 部)`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleTrashSelected
          }),
          buildListManagementSection({
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onClear: queue.clearQueue
          })
        ]
      })
    }),
    ...STREAM_PLATFORMS.map((platform, idx) => {
      const isDetected = detected.platform.id === platform.id;
      const ratio = Math.max(0.2, 1 - idx * 0.14);

      return List.Item({
        id: `nav-plat-${platform.id}`,
        title: platform.name,
        subtitle: `${platform.handlerName} · ${platform.features}`,
        icon: Icon.Globe,
        onSelect: () => setSelectedPlatform(platform.id),
        accessories: [
          { progress: ratio },
          { tag: { value: isDetected && activeInputText ? "已命中链接" : platform.handlerName } }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `使用 ${platform.name} 引擎解析下载`,
              icon: Icon.Download,
              onAction: () => {
                setSelectedPlatform(platform.id);
                void handleParseAndDownload(activeInputText);
              }
            }),
            Action({
              title: "读取剪贴板中的视频链接",
              icon: Icon.Clipboard,
              onAction: handleReadClipboardUrl
            }),
            Action({
              title: "打开本地视频保存目录",
              icon: Icon.Folder,
              onAction: handleOpenSaveDirectory
            })
          ]
        })
      });
    })
  ];

  const allChecked = filteredVideos.length > 0 && filteredVideos.every((v) => checkedSet.has(v.id));
  const someChecked = filteredVideos.some((v) => checkedSet.has(v.id));

  const subListItems = filteredVideos.map((video) => {
    const isChecked = checkedSet.has(video.id);
    const ratio = Math.min(1, video.sizeBytes / maxVideoBytes);
    const dateStr = video.mtimeMs > 0 ? new Date(video.mtimeMs).toLocaleDateString() : "本地文件";

    return List.Item({
      id: `vid-item-${video.id}`,
      title: video.name,
      subtitle: `${video.sourceDirLabel} · ${video.path} · ${dateStr}`,
      icon: Icon.Video,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => queue.toggleCheck(video.id),
      onToggleCheck: () => queue.toggleCheck(video.id),
      accessories: [
        { progress: ratio },
        { tag: { value: video.resolutionLabel } },
        { text: formatBytes(video.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeInputText ? `解析下载当前视频 [${currentQuality.badge}]` : "使用系统播放器打开此视频",
            icon: activeInputText ? Icon.Download : Icon.Play,
            onAction: async () => {
              if (activeInputText) {
                await handleParseAndDownload(activeInputText);
              } else {
                await openLocalVideoFile(video.path);
              }
            }
          }),
          Action({
            title: "在资源管理器中定位视频文件",
            icon: Icon.Folder,
            onAction: async () => {
              await openLocalVideoFolder(video.path);
            }
          }),
          Action({
            title: isChecked ? "取消勾选此视频" : "勾选此视频",
            icon: Icon.CheckCircle,
            onAction: () => queue.toggleCheck(video.id)
          }),
          Action({
            title: `批量移入回收站清理 (${selectedVideos.length} 部 / ${formatBytes(selectedTotalBytes)})`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleTrashSelected
          }),
          buildListManagementSection({
            onRemove: () => queue.removeItem(video.id),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(filteredVideos),
            allSelected: allChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    });
  });

  const activePlatformName =
    selectedPlatform === "auto"
      ? "全部平台与本地视频队列"
      : STREAM_PLATFORMS.find((p) => p.id === selectedPlatform)?.name || "流媒体视频";

  return List({
    isLoading: isLoading || queue.isImporting,
    searchBarPlaceholder: "粘贴 Bilibili BV号 / 抖音口令 / 快手 / YouTube / M3U8 链接，或搜索已导入视频...",
    onSearchTextChange: handleSearchChange,
    isShowingDetail: false,
    ...queue.fileInputProps,
    searchBarAccessory: List.Dropdown({
      tooltip: "选择目标画质或音频提取封装格式",
      value: selectedQuality,
      onChange: (val) => setSelectedQuality(val as VideoQualityPresetId),
      children: VIDEO_QUALITY_PRESETS.map((preset) =>
        List.Dropdown.Item({
          title: `${preset.name} [${preset.badge}]`,
          value: preset.id
        })
      )
    }),
    filterBar: {
      summaryText,
      actions: queue.topBarActions
    },
    subList: {
      title: `${activePlatformName} (${filteredVideos.length} 部 · 已选 ${formatBytes(selectedTotalBytes)})`,
      subtitle: saveDir || "支持拖入视频/文件夹、选择文件或粘贴链接下载",
      emptyText: "队列为空，请点击顶部「选择文件 / 选择文件夹」导入视频，或粘贴视频链接下载",
      checkable: filteredVideos.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => queue.toggleAllVisible(filteredVideos),
      items: subListItems
    },
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder, [
      Action({
        title: "读取剪贴板中的视频链接",
        icon: Icon.Clipboard,
        onAction: handleReadClipboardUrl
      })
    ]),
    children: [
      List.Section({
        title: "流媒体平台解析引擎导航 (32%)",
        subtitle: "6 大平台处理器",
        children: leftNavNodes
      })
    ]
  });
}

export default VideoDownloaderCommand;
