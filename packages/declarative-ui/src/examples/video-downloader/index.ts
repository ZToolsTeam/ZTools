/**
 * ZTools 2.0 标杆原生插件视图: 全平台流媒体音视频解析与下载工坊 (Video Downloader 2.0)
 *
 * 严格遵循 ZTools Declarative UI 2.0 复合组件封装规范：
 * - 顶部 `<MetricGrid>` + `<DistributionBar>`（展示本机已保存视频库按体量与清晰度分布）
 * - `<FilterBar>`：4 步流媒体解析向导 + 6 大平台解析器筛选 + 6 大画质/音轨封装档位 + 一键解析剪贴板链接
 * - 列表支持三态勾选（`checkable: true`），支持一键调用本地播放器播放、定位文件夹与批量清理
 */

import {
  Action,
  ActionPanel,
  Color,
  Detail,
  DistributionBar,
  FilterBar,
  Icon,
  List,
  MetricGrid,
  SegmentedControl,
  confirmAlert,
  showToast,
  ToastStyle,
  useEffect,
  useState,
  type ViewNode
} from "../../index.js";
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
import { writeRealClipboardText } from "../shared/native-ipc.js";

type VideoWorkspaceTab = "library" | "platforms" | "quality_presets";

export function VideoDownloaderCommand(): ViewNode {
  const [activeTab, setActiveTab] = useState<VideoWorkspaceTab>("library");
  const [platformFilter, setPlatformFilter] = useState<StreamPlatformId>("auto");
  const [qualityId, setQualityId] = useState<VideoQualityPresetId>("q_4k_mp4");
  const [searchText, setSearchText] = useState<string>("");
  const [snapshot, setSnapshot] = useState<VideoDownloaderSnapshot | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<string>("正在扫描本机视频库并检测剪贴板分享口令...");

  const activeQuality =
    VIDEO_QUALITY_PRESETS.find((q) => q.id === qualityId) || VIDEO_QUALITY_PRESETS[0];

  async function refreshWorkspace(): Promise<void> {
    setIsLoading(true);
    try {
      const snap = await fetchVideoDownloaderSnapshot();
      setSnapshot(snap);
      setStatusMessage(
        `本机视频库共 ${snap.videos.length} 个视频 (${formatBytes(snap.totalSizeBytes)}) · 剪贴板识别: ${snap.clipboardUrl ? snap.detectedPlatform.name : "等待复制视频分享链接"}`
      );
    } catch (err) {
      setStatusMessage(`刷新视频下载工坊失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshWorkspace();
  }, []);

  const allVideos = snapshot?.videos || [];
  const filteredVideos = allVideos.filter((v) => {
    if (searchText.trim()) {
      const kw = searchText.trim().toLowerCase();
      return (
        v.name.toLowerCase().includes(kw) ||
        v.ext.toLowerCase().includes(kw) ||
        v.sourceDirLabel.toLowerCase().includes(kw)
      );
    }
    return true;
  });

  const checkedSet = new Set(checkedPaths);
  const checkedBytes = allVideos
    .filter((v) => checkedSet.has(v.path))
    .reduce((acc, v) => acc + v.sizeBytes, 0);

  function toggleCheckVideo(filePath: string, nextChecked: boolean): void {
    setCheckedPaths((prev) => {
      const set = new Set(prev);
      if (nextChecked) set.add(filePath);
      else set.delete(filePath);
      return Array.from(set);
    });
  }

  async function handleParseAndDownload(): Promise<void> {
    const snap = await fetchVideoDownloaderSnapshot();
    setSnapshot(snap);
    const inputCandidate = searchText.trim() || snap.clipboardUrl;
    if (!inputCandidate) {
      await showToast({
        style: ToastStyle.Failure,
        title: "请先复制视频分享链接或 BV 号",
        message: "支持 B站 BV号/链接、抖音分享口令、快手、微博、YouTube 及 M3U8 直链"
      });
      return;
    }
    const res = await parseAndDownloadStreamVideo(inputCandidate, snap.saveDir, activeQuality);
    setStatusMessage(res.message);
  }

  async function handleTrashCheckedVideos(): Promise<void> {
    if (checkedPaths.length === 0) return;
    const confirmed = await confirmAlert({
      title: `确认将选中的 ${checkedPaths.length} 个本地视频移入回收站？`,
      message: `预计释放 ${formatBytes(checkedBytes)} 存储空间。`,
      primaryActionTitle: "移入回收站",
      dismissActionTitle: "取消"
    });
    if (!confirmed) return;
    await trashLocalVideoFiles(checkedPaths);
    setCheckedPaths([]);
    await refreshWorkspace();
  }

  const liveInputDetection = searchText.trim()
    ? detectVideoPlatform(searchText.trim())
    : snapshot
      ? { url: snapshot.clipboardUrl, platform: snapshot.detectedPlatform }
      : { url: "", platform: STREAM_PLATFORMS[0] };

  const headerNode = [
    MetricGrid({
      columns: 4,
      items: [
        {
          id: "local-videos",
          label: "本机视频媒体库",
          value: snapshot ? `${snapshot.videos.length} 部 (${formatBytes(snapshot.totalSizeBytes)})` : "扫描中...",
          subtitle: snapshot?.saveDir || "Videos & Downloads",
          icon: "🎬",
          color: "#ec4899"
        },
        {
          id: "platform-detect",
          label: "智能平台探测器",
          value: liveInputDetection.url ? liveInputDetection.platform.name : "自动识别 6 大平台",
          subtitle: liveInputDetection.url || "支持 B站/抖音/快手/YouTube/M3U8",
          icon: liveInputDetection.platform.icon,
          color: liveInputDetection.platform.color
        },
        {
          id: "quality-tier",
          label: "输出画质与音轨封装",
          value: activeQuality.badge,
          subtitle: activeQuality.name,
          icon: "✨",
          color: "#8b5cf6"
        },
        {
          id: "drive-free",
          label: `存储盘 (${snapshot?.driveLetter || "C:"}) 可用容量`,
          value: snapshot ? formatBytes(snapshot.driveFreeBytes) : "--",
          subtitle: "FFmpeg 音画无损合并就绪",
          icon: "💽",
          color: "#10b981"
        }
      ]
    }),
    snapshot && snapshot.tierStats.length > 0
      ? DistributionBar({
          title: `本机已保存视频媒体库体积分布 (共 ${snapshot.videos.length} 部 · ${formatBytes(snapshot.totalSizeBytes)})`,
          totalValue: snapshot.totalSizeBytes,
          segments: snapshot.tierStats.map((st) => ({
            id: st.tier,
            label: `${st.label} (${st.count})`,
            value: st.sizeBytes,
            formattedValue: formatBytes(st.sizeBytes),
            color: st.color
          }))
        })
      : null,
    FilterBar({
      title: "全平台流媒体解析向导与画质封装配置",
      wizardSteps: [
        {
          step: 1,
          label: "1. 粘贴分享口令/BV号",
          status: liveInputDetection.url ? "done" : "active"
        },
        {
          step: 2,
          label: `2. 平台识别 (${liveInputDetection.platform.handlerName})`,
          status: "active"
        },
        {
          step: 3,
          label: `3. 选定画质 (${activeQuality.badge})`,
          status: "active"
        },
        {
          step: 4,
          label: "4. FFmpeg 音画合并入库",
          status: "pending"
        }
      ],
      groups: [
        {
          id: "platform-group",
          label: "平台解析器",
          value: platformFilter,
          onChange: (val) => setPlatformFilter(val as StreamPlatformId),
          options: [
            { value: "auto", label: "🤖 自动识别平台", badge: "推荐" },
            ...STREAM_PLATFORMS.map((p) => ({
              value: p.id,
              label: `${p.icon} ${p.name}`
            }))
          ]
        },
        {
          id: "quality-group",
          label: "画质与音轨",
          value: qualityId,
          onChange: (val) => setQualityId(val as VideoQualityPresetId),
          options: VIDEO_QUALITY_PRESETS.map((q) => ({
            value: q.id,
            label: q.name,
            badge: q.badge
          }))
        }
      ],
      actions: [
        {
          id: "parse-dl",
          title: `🚀 解析并下载 (${activeQuality.badge})`,
          style: "primary",
          onAction: () => void handleParseAndDownload()
        },
        {
          id: "open-video-dir",
          title: "📂 打开 Videos 保存目录",
          style: "secondary",
          onAction: () => {
            if (snapshot?.saveDir) {
              void openLocalVideoFile(snapshot.saveDir);
            }
          }
        },
        ...(checkedPaths.length > 0
          ? [
              {
                id: "trash-checked-videos",
                title: `🗑️ 清理勾选视频 (${checkedPaths.length}部 · ${formatBytes(checkedBytes)})`,
                style: "danger" as const,
                onAction: () => void handleTrashCheckedVideos()
              }
            ]
          : [])
      ]
    }),
    SegmentedControl({
      value: activeTab,
      onChange: (val) => setActiveTab(val as VideoWorkspaceTab),
      options: [
        { value: "library", label: `本机视频媒体库 (${filteredVideos.length})`, icon: "🎬" },
        { value: "platforms", label: `6 大流媒体平台解析器 (${STREAM_PLATFORMS.length})`, icon: "📺" },
        { value: "quality_presets", label: `画质与音频提取档位 (${VIDEO_QUALITY_PRESETS.length})`, icon: "✨" }
      ]
    })
  ].filter(Boolean) as ViewNode[];

  function renderLocalVideoItem(video: LocalMediaVideoItem): ViewNode {
    const isChecked = checkedSet.has(video.path);
    const mtimeStr = new Date(video.mtimeMs).toLocaleString();

    return List.Item({
      id: video.id,
      title: video.name,
      subtitle: `${video.sourceDirLabel} · ${mtimeStr}`,
      icon: "🎬",
      checkable: true,
      checked: isChecked,
      onCheckChange: (next) => toggleCheckVideo(video.path, next),
      accessories: [
        { tag: { value: video.ext.toUpperCase(), color: video.color } },
        { text: formatBytes(video.sizeBytes) }
      ],
      detail: List.Item.Detail({
        markdown: [
          `### 🎬 ${video.name}`,
          "",
          `- **物理文件路径**：\`${video.path}\``,
          `- **视频文件大小**：**${formatBytes(video.sizeBytes)}** (${video.sizeBytes.toLocaleString()} Bytes)`,
          `- **所属目录来源**：${video.sourceDirLabel}`,
          `- **规格分级**：${video.resolutionLabel}`,
          `- **最后修改时间**：${mtimeStr}`,
          "",
          "#### 🛠️ 本地视频二次无损转封装 / 提取 MP3 音频命令",
          "```bash",
          `ffmpeg -i "${video.path}" -vn -c:a libmp3lame -b:a 320k "${video.path}.mp3"`,
          "```"
        ].join("\n"),
        metadata: Detail.Metadata({
          children: [
            Detail.Metadata.Label({ title: "封装格式", text: video.ext.toUpperCase() }),
            Detail.Metadata.Label({ title: "文件体积", text: formatBytes(video.sizeBytes) }),
            Detail.Metadata.Label({ title: "来源目录", text: video.sourceDirLabel }),
            Detail.Metadata.Separator(),
            Detail.Metadata.Label({ title: "工作台状态", text: statusMessage })
          ]
        })
      }),
      actions: ActionPanel({
        children: [
          Action({
            title: "调用系统播放器播放视频",
            icon: Icon.Play,
            onAction: () => void openLocalVideoFile(video.path)
          }),
          Action({
            title: "在资源管理器中定位文件",
            icon: Icon.Folder,
            onAction: () => void openLocalVideoFolder(video.path)
          }),
          Action({
            title: isChecked ? "取消勾选此视频" : "勾选此视频",
            icon: Icon.Checkmark,
            onAction: () => toggleCheckVideo(video.path, !isChecked)
          }),
          Action({
            title: "移入系统回收站",
            icon: Icon.Trash,
            style: "destructive",
            onAction: async () => {
              await trashLocalVideoFiles([video.path]);
              await refreshWorkspace();
            }
          }),
          Action({
            title: "复制视频完整路径",
            icon: Icon.Clipboard,
            onAction: async () => {
              await writeRealClipboardText(video.path);
              await showToast({ style: ToastStyle.Success, title: "已复制视频路径" });
            }
          })
        ]
      })
    });
  }

  return List({
    isLoading,
    isShowingDetail: true,
    searchBarPlaceholder: "粘贴 B站 BV号/链接、抖音分享口令、YouTube 链接直接解析，或筛选本地视频...",
    onSearchTextChange: (val) => setSearchText(val),
    header: headerNode,
    children: [
      ...(activeTab === "library"
        ? [
            List.Section({
              title: `本机已保存视频媒体库 (${filteredVideos.length} 部 · 已勾选 ${checkedPaths.length} 部 / ${formatBytes(checkedBytes)})`,
              subtitle: statusMessage,
              children: filteredVideos.map((v) => renderLocalVideoItem(v))
            })
          ]
        : []),
      ...(activeTab === "platforms"
        ? [
            List.Section({
              title: "6 大流媒体平台专用解析引擎 (复刻 VideoDownloaderPlugin Handlers)",
              children: STREAM_PLATFORMS.map((plat) =>
                List.Item({
                  id: `plat-${plat.id}`,
                  title: `${plat.icon} ${plat.name}`,
                  subtitle: plat.features,
                  icon: plat.icon,
                  accessories: [{ tag: { value: plat.handlerName, color: plat.color } }],
                  detail: List.Item.Detail({
                    markdown: [
                      `### ${plat.icon} ${plat.name} (\`${plat.handlerName}\`)`,
                      "",
                      plat.features,
                      "",
                      "#### 当前选定画质下载管线",
                      "```bash",
                      `yt-dlp ${activeQuality.ytDlpArgs} -P "${snapshot?.saveDir || "C:\\Videos"}" "${liveInputDetection.url || "https://www.bilibili.com/video/BV1xx411c7mD"}"`,
                      "```"
                    ].join("\n")
                  }),
                  actions: ActionPanel({
                    children: [
                      Action({
                        title: `使用 ${plat.name} 解析器下载剪贴板链接`,
                        icon: Icon.Download,
                        onAction: () => void handleParseAndDownload()
                      })
                    ]
                  })
                })
              )
            })
          ]
        : []),
      ...(activeTab === "quality_presets"
        ? [
            List.Section({
              title: "6 大画质、音轨抽离与字幕封面封装预设",
              children: VIDEO_QUALITY_PRESETS.map((q) =>
                List.Item({
                  id: `qual-${q.id}`,
                  title: q.name,
                  subtitle: q.description,
                  icon: q.id === qualityId ? "✨" : "🎞️",
                  accessories: [
                    {
                      tag: {
                        value: q.badge,
                        color: q.id === qualityId ? Color.Green : Color.Blue
                      }
                    }
                  ],
                  detail: List.Item.Detail({
                    markdown: [
                      `### ✨ ${q.name}`,
                      "",
                      q.description,
                      "",
                      "#### 底层 yt-dlp + FFmpeg 参数链",
                      "```bash",
                      `yt-dlp ${q.ytDlpArgs} -P "${snapshot?.saveDir || ""}"`,
                      "```"
                    ].join("\n")
                  }),
                  actions: ActionPanel({
                    children: [
                      Action({
                        title: `切换为「${q.badge}」并解析下载`,
                        icon: Icon.Checkmark,
                        onAction: async () => {
                          setQualityId(q.id);
                          await handleParseAndDownload();
                        }
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [])
    ]
  });
}

export default VideoDownloaderCommand;
