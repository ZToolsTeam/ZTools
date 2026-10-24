/**
 * ZTools 2.0 标杆原生插件视图: 全平台流媒体音视频解析与下载工坊 (Video Downloader 2.0 - 布局二：左 32% 平台分类树 + 右 68% 可勾选视频库列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 6 大流媒体平台解析导航树 + 右 68% 本机已下载视频媒体勾选明细队列
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换视频画质与音轨提取档位 (4K 60fps / 1080P / 720P / MP3 / FLAC / 含字幕)
 * 3. 单行极简状态条：filterBar.summaryText 融合剪贴板平台自动识别、存储空间与已选视频统计，仅保留 1 个全局重新扫描按钮
 * 4. 零彩色 Emoji 与去彩虹化：100% 单色 SVG 图标、中性灰体积进度条与无边框胶囊标签
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  STREAM_PLATFORMS,
  VIDEO_QUALITY_PRESETS,
  detectVideoPlatform,
  fetchVideoDownloaderSnapshot,
  formatBytes,
  openLocalVideoFile,
  openLocalVideoFolder,
  parseAndDownloadStreamVideo,
  trashLocalVideoFiles,
  type LocalMediaVideoItem,
  type StreamPlatformId,
  type VideoDownloaderSnapshot,
  type VideoQualityPresetId
} from "./logic.js";

function createInitialVideoSnapshot(): VideoDownloaderSnapshot {
  if (isRealElectronHost()) {
    return {
      saveDir: "",
      driveLetter: "C:",
      driveFreeBytes: 0,
      clipboardUrl: "",
      detectedPlatform: STREAM_PLATFORMS[0],
      videos: [],
      totalSizeBytes: 0,
      tierStats: [],
      updatedAt: "正在扫描本机视频库..."
    };
  }
  const defaultVideos: LocalMediaVideoItem[] = [
    {
      id: "vid_init_0",
      name: "Bilibili_4K60_TechReview_BV1xx411c7mD.mp4",
      path: "C:\\Users\\Default\\Videos\\Bilibili_4K60_TechReview_BV1xx411c7mD.mp4",
      ext: ".mp4",
      sizeBytes: 680 * 1024 * 1024,
      mtimeMs: Date.now() - 3600_000,
      sourceDirLabel: "Videos 视频库",
      resolutionTier: "large_hd",
      resolutionLabel: "4K / 超清原画",
      color: "var(--rc-text-muted)"
    },
    {
      id: "vid_init_1",
      name: "Douyin_NoWatermark_1080P_Clip.mp4",
      path: "C:\\Users\\Default\\Videos\\Douyin_NoWatermark_1080P_Clip.mp4",
      ext: ".mp4",
      sizeBytes: 42 * 1024 * 1024,
      mtimeMs: Date.now() - 7200_000,
      sourceDirLabel: "Videos 视频库",
      resolutionTier: "standard",
      resolutionLabel: "1080P 高清",
      color: "var(--rc-text-muted)"
    },
    {
      id: "vid_init_2",
      name: "YouTube_Keynote_2026_1080P_WithSubs.mkv",
      path: "C:\\Users\\Default\\Downloads\\YouTube_Keynote_2026_1080P_WithSubs.mkv",
      ext: ".mkv",
      sizeBytes: 410 * 1024 * 1024,
      mtimeMs: Date.now() - 10800_000,
      sourceDirLabel: "Downloads 下载库",
      resolutionTier: "large_hd",
      resolutionLabel: "4K / 超清原画",
      color: "var(--rc-text-muted)"
    },
    {
      id: "vid_init_3",
      name: "Kuaishou_LiveReplay_Highlight.mp4",
      path: "C:\\Users\\Default\\Videos\\Kuaishou_LiveReplay_Highlight.mp4",
      ext: ".mp4",
      sizeBytes: 85 * 1024 * 1024,
      mtimeMs: Date.now() - 14400_000,
      sourceDirLabel: "Videos 视频库",
      resolutionTier: "standard",
      resolutionLabel: "1080P 高清",
      color: "var(--rc-text-muted)"
    },
    {
      id: "vid_init_4",
      name: "HLS_Stream_Merged_Lecture_01.mp4",
      path: "C:\\Users\\Default\\Downloads\\HLS_Stream_Merged_Lecture_01.mp4",
      ext: ".mp4",
      sizeBytes: 156 * 1024 * 1024,
      mtimeMs: Date.now() - 18000_000,
      sourceDirLabel: "Downloads 下载库",
      resolutionTier: "standard",
      resolutionLabel: "1080P 高清",
      color: "var(--rc-text-muted)"
    }
  ];

  const totalSizeBytes = defaultVideos.reduce((acc, item) => acc + item.sizeBytes, 0);

  return {
    saveDir: "C:\\Users\\Default\\Videos",
    driveLetter: "C:",
    driveFreeBytes: 128 * 1024 * 1024 * 1024,
    clipboardUrl: "",
    detectedPlatform: STREAM_PLATFORMS[0],
    videos: defaultVideos,
    totalSizeBytes,
    tierStats: [
      {
        tier: "large_hd",
        label: "4K / 超清原画 (>200MB)",
        color: "var(--rc-text-muted)",
        sizeBytes: 1090 * 1024 * 1024,
        count: 2
      },
      {
        tier: "standard",
        label: "1080P 标准高清 (20~200MB)",
        color: "var(--rc-text-muted)",
        sizeBytes: 283 * 1024 * 1024,
        count: 3
      }
    ],
    updatedAt: "初始化就绪"
  };
}

export function VideoDownloaderCommand() {
  const [snapshot, setSnapshot] = useState<VideoDownloaderSnapshot>(() => createInitialVideoSnapshot());
  const [selectedPlatform, setSelectedPlatform] = useState<StreamPlatformId>("auto");
  const [selectedQuality, setSelectedQuality] = useState<VideoQualityPresetId>("q_1080p_mp4");
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost() ? [] : ["vid_init_0", "vid_init_1"]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [streamInput, setStreamInput] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadVideoSnapshot = async () => {
    setIsLoading(true);
    try {
      const data = await fetchVideoDownloaderSnapshot();
      if (isRealElectronHost() || data.videos.length > 0) {
        setSnapshot(data);
        setCheckedIds(data.videos.slice(0, 5).map((v) => v.id));
        if (data.clipboardUrl && !streamInput) {
          setStreamInput(data.clipboardUrl);
        }
        setStatusBanner(
          data.videos.length > 0
            ? `已扫描本地媒体库 · 共 ${data.videos.length} 个视频 (${formatBytes(data.totalSizeBytes)})`
            : `媒体保存目录 ${data.saveDir} · 暂无本地视频 · 盘符剩余可用 ${formatBytes(data.driveFreeBytes)}`
        );
      } else {
        setStatusBanner(
          `媒体保存目录 ${data.saveDir} · 盘符剩余可用 ${formatBytes(data.driveFreeBytes)}`
        );
      }
    } catch (err) {
      setStatusBanner(`扫描本地视频库失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadVideoSnapshot();
  }, []);

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    if (/(https?:\/\/|\bBV[0-9A-Za-z]{10}\b)/i.test(text.trim())) {
      setStreamInput(text.trim());
    }
  };

  const activeInputText = streamInput.trim() || snapshot.clipboardUrl;
  const detected = detectVideoPlatform(activeInputText);
  const currentQuality =
    VIDEO_QUALITY_PRESETS.find((q) => q.id === selectedQuality) || VIDEO_QUALITY_PRESETS[1];

  const isUrlSearch = /(https?:\/\/|\bBV[0-9A-Za-z]{10}\b)/i.test(searchText.trim());
  const keyword = isUrlSearch ? "" : searchText.trim().toLowerCase();

  const filteredVideos = snapshot.videos.filter((video) => {
    if (selectedPlatform !== "auto") {
      const nameLower = video.name.toLowerCase();
      if (selectedPlatform === "bilibili" && !nameLower.includes("bili") && !nameLower.includes("bv")) {
        // 若用户选择了特定平台但本地文件名无特定前缀，按文件名搜索或保留展示以支持本地管理
      }
    }
    if (!keyword) return true;
    return `${video.name} ${video.path} ${video.sourceDirLabel} ${video.resolutionLabel}`
      .toLowerCase()
      .includes(keyword);
  });

  const checkedSet = new Set(checkedIds);
  const selectedVideos = snapshot.videos.filter((v) => checkedSet.has(v.id));
  const selectedTotalBytes = selectedVideos.reduce((acc, item) => acc + item.sizeBytes, 0);

  const toggleVideoCheck = (id: string) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleAllVisible = () => {
    const visibleIds = filteredVideos.map((v) => v.id);
    const allChecked = visibleIds.length > 0 && visibleIds.every((id) => checkedSet.has(id));
    if (allChecked) {
      const removeSet = new Set(visibleIds);
      setCheckedIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setCheckedIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const handleParseAndDownload = async (rawInput?: string) => {
    const target = (rawInput ?? activeInputText).trim();
    if (!target) {
      setStatusBanner("请先复制视频分享口令/链接到剪贴板，或在顶部搜索框粘贴 B站/抖音/YouTube/M3U8 链接");
      return;
    }
    setIsLoading(true);
    try {
      const res = await parseAndDownloadStreamVideo(target, snapshot.saveDir, currentQuality);
      setStatusBanner(res.message);
      await reloadVideoSnapshot();
    } finally {
      setIsLoading(false);
    }
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
      setStatusBanner(
        res.deletedCount > 0
          ? `已将 ${res.deletedCount} 个本地视频移入回收站，释放 ${formatBytes(res.freedBytes)}`
          : "本地视频清理操作未删除任何文件"
      );
      await reloadVideoSnapshot();
    } finally {
      setIsLoading(false);
    }
  };

  const maxVideoBytes = Math.max(1, ...filteredVideos.map((v) => v.sizeBytes));

  const summaryText =
    statusBanner ||
    `解析引擎: ${detected.platform.name} · 档位: ${currentQuality.badge} · 本地视频库 ${filteredVideos.length} 项 (已选 ${selectedVideos.length} 项 / ${formatBytes(selectedTotalBytes)})`;

  const leftNavNodes = [
    List.Item({
      id: "nav-plat-auto",
      title: "全部平台与本地视频库",
      subtitle: `${snapshot.saveDir} (智能探测剪贴板分享链接)`,
      icon: Icon.Video,
      onSelect: () => setSelectedPlatform("auto"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${snapshot.videos.length} 部` } },
        { text: formatBytes(snapshot.totalSizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeInputText
              ? `一键解析并下载 [${currentQuality.badge}] (Enter)`
              : "读取剪贴板口令并解析下载 (Enter)",
            icon: Icon.Download,
            onAction: () => handleParseAndDownload(activeInputText)
          }),
          Action({
            title: "打开视频保存目录 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openLocalVideoFile(snapshot.saveDir);
            }
          }),
          Action({
            title: `清理已勾选本地视频 (${selectedVideos.length} 部)`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleTrashSelected
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
              title: `使用 ${platform.name} 引擎解析下载 (Enter)`,
              icon: Icon.Download,
              onAction: () => {
                setSelectedPlatform(platform.id);
                void handleParseAndDownload(activeInputText);
              }
            }),
            Action({
              title: "打开本地视频保存目录 (Ctrl+Enter)",
              icon: Icon.Folder,
              onAction: async () => {
                await openLocalVideoFile(snapshot.saveDir);
              }
            })
          ]
        })
      });
    })
  ];

  const subListItems = filteredVideos.map((video) => {
    const isChecked = checkedSet.has(video.id);
    const ratio = Math.min(1, video.sizeBytes / maxVideoBytes);
    const dateStr = video.mtimeMs > 0 ? new Date(video.mtimeMs).toLocaleDateString() : "近期下载";

    return List.Item({
      id: `vid-item-${video.id}`,
      title: video.name,
      subtitle: `${video.sourceDirLabel} · ${video.path} · ${dateStr}`,
      icon: Icon.Video,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => toggleVideoCheck(video.id),
      onToggleCheck: () => toggleVideoCheck(video.id),
      accessories: [
        { progress: ratio },
        { tag: { value: video.resolutionLabel } },
        { text: formatBytes(video.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: activeInputText
              ? `解析下载剪贴板视频 [${currentQuality.badge}] (Enter)`
              : "使用系统播放器打开此视频 (Enter)",
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
            title: "在资源管理器中定位视频文件 (Ctrl+Enter)",
            icon: Icon.Folder,
            onAction: async () => {
              await openLocalVideoFolder(video.path);
            }
          }),
          Action({
            title: isChecked ? "取消勾选此视频" : "勾选此视频",
            icon: Icon.CheckCircle,
            onAction: () => toggleVideoCheck(video.id)
          }),
          Action({
            title: `批量移入回收站清理 (${selectedVideos.length} 部 / ${formatBytes(selectedTotalBytes)})`,
            icon: Icon.Trash,
            style: "destructive",
            onAction: handleTrashSelected
          })
        ]
      })
    });
  });

  const activePlatformName =
    selectedPlatform === "auto"
      ? "全部平台与本地媒体库"
      : STREAM_PLATFORMS.find((p) => p.id === selectedPlatform)?.name || "流媒体视频";

  const allChecked = filteredVideos.length > 0 && filteredVideos.every((v) => checkedSet.has(v.id));
  const someChecked = filteredVideos.some((v) => checkedSet.has(v.id));

  return List({
    isLoading,
    searchBarPlaceholder: "粘贴 Bilibili BV号 / 抖音口令 / 快手 / YouTube / M3U8 链接，或搜索本地视频...",
    onSearchTextChange: handleSearchChange,
    isShowingDetail: false,
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
      actions: [
        {
          id: "rescan",
          title: "重新扫描",
          style: "secondary",
          onAction: () => {
            void reloadVideoSnapshot();
          }
        }
      ]
    },
    subList: {
      title: `${activePlatformName} · 本地已保存视频明细 (${filteredVideos.length} 部 · 已选 ${formatBytes(selectedTotalBytes)})`,
      subtitle: snapshot.saveDir,
      emptyText: "当前筛选条件下暂无本地视频文件",
      checkable: filteredVideos.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
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
