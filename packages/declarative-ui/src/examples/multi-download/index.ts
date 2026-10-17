/**
 * ZTools 2.0 标杆原生插件视图: 多线程分块高速下载工作台 (Multi-Download 2.0)
 *
 * 严格遵循 ZTools Declarative UI 2.0 复合组件封装规范：
 * - 顶部 `<MetricGrid>` + `<DistributionBar>`（展示本机 Downloads 各类下载文件体积分布）
 * - `<FilterBar>`：4 步向导 + 并发分块线程数切换（16线程 / 8线程 / 4线程 / 单线程） + 下载文件分类胶囊 + 一键新建下载动作
 * - 列表支持三态勾选（`checkable: true`），支持批量清理过期大安装包与在资源管理器中定位
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
import { writeRealClipboardText } from "../shared/native-ipc.js";

type MultiDownloadTab = "files" | "new_task" | "engine_diag";

export function MultiDownloadCommand(): ViewNode {
  const [activeTab, setActiveTab] = useState<MultiDownloadTab>("files");
  const [threadPresetId, setThreadPresetId] = useState<ThreadSplitPresetId>("threads_16");
  const [selectedCategory, setSelectedCategory] = useState<DownloadFileCategory>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [snapshot, setSnapshot] = useState<MultiDownloadSnapshot | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<string>("正在扫描本机 Downloads 目录与嗅探剪贴板链接...");

  const activeThreadPreset =
    THREAD_SPLIT_PRESETS.find((p) => p.id === threadPresetId) || THREAD_SPLIT_PRESETS[0];

  async function refreshWorkspace(): Promise<void> {
    setIsLoading(true);
    try {
      const snap = await fetchMultiDownloadSnapshot();
      setSnapshot(snap);
      setStatusMessage(
        `本机 ${snap.downloadDir} 共 ${snap.files.length} 个已下载文件 (${formatBytes(snap.totalSizeBytes)}) · ${snap.driveLetter} 剩余可用 ${formatBytes(snap.driveFreeBytes)}`
      );
    } catch (err) {
      setStatusMessage(`刷新下载工作台失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshWorkspace();
  }, []);

  const allFiles = snapshot?.files || [];
  const filteredFiles = allFiles.filter((f) => {
    if (selectedCategory !== "all" && f.category !== selectedCategory) return false;
    if (searchText.trim()) {
      const kw = searchText.trim().toLowerCase();
      return (
        f.name.toLowerCase().includes(kw) ||
        f.ext.toLowerCase().includes(kw) ||
        f.categoryName.toLowerCase().includes(kw)
      );
    }
    return true;
  });

  const checkedSet = new Set(checkedPaths);
  const checkedBytes = allFiles
    .filter((f) => checkedSet.has(f.path))
    .reduce((acc, item) => acc + item.sizeBytes, 0);

  function toggleCheckFile(filePath: string, nextChecked: boolean): void {
    setCheckedPaths((prev) => {
      const set = new Set(prev);
      if (nextChecked) set.add(filePath);
      else set.delete(filePath);
      return Array.from(set);
    });
  }

  async function handleStartClipboardDownload(): Promise<void> {
    const snap = await fetchMultiDownloadSnapshot();
    setSnapshot(snap);
    const targetUrl = snap.sniffedClipboardUrl || searchText.trim();
    if (!targetUrl) {
      await showToast({
        style: ToastStyle.Failure,
        title: "未检测到下载链接",
        message: "请先复制 HTTP/HTTPS/FTP/Magnet 链接到剪贴板，或在顶部搜索框粘贴下载 URL"
      });
      return;
    }
    const res = await startMultiThreadDownloadTask(
      targetUrl,
      snap.downloadDir,
      activeThreadPreset
    );
    setStatusMessage(res.message);
  }

  async function handleBatchTrashChecked(): Promise<void> {
    if (checkedPaths.length === 0) {
      await showToast({
        style: ToastStyle.Failure,
        title: "请先勾选要清理的下载文件",
        message: "支持勾选过期安装包与大体积归档文件批量移入回收站"
      });
      return;
    }
    const confirmed = await confirmAlert({
      title: `确认将 ${checkedPaths.length} 个已下载文件移入回收站？`,
      message: `预计可释放 ${formatBytes(checkedBytes)} 磁盘空间（可在 Windows 回收站中还原）。`,
      primaryActionTitle: "移入回收站",
      dismissActionTitle: "取消"
    });
    if (!confirmed) return;

    await deleteDownloadedFiles(checkedPaths);
    setCheckedPaths([]);
    await refreshWorkspace();
  }

  const headerNode = [
    MetricGrid({
      columns: 4,
      items: [
        {
          id: "total-downloaded",
          label: "本机已下文件数 / 总体积",
          value: snapshot ? `${snapshot.files.length} 项 (${formatBytes(snapshot.totalSizeBytes)})` : "扫描中...",
          subtitle: snapshot?.downloadDir || "Downloads",
          icon: "📥",
          color: "#3b82f6"
        },
        {
          id: "drive-free",
          label: `目标盘 (${snapshot?.driveLetter || "C:"}) 剩余空间`,
          value: snapshot ? formatBytes(snapshot.driveFreeBytes) : "--",
          subtitle:
            snapshot && snapshot.driveTotalBytes > 0
              ? `总容量 ${formatBytes(snapshot.driveTotalBytes)}`
              : "实时容量安全监测",
          icon: "💽",
          color: "#10b981"
        },
        {
          id: "thread-split",
          label: "当前并发分块档位",
          value: `${activeThreadPreset.threads} 线程 / ${activeThreadPreset.splitSize}`,
          subtitle: activeThreadPreset.name,
          icon: "⚡",
          color: "#f59e0b"
        },
        {
          id: "clipboard-sniffer",
          label: "剪贴板链接嗅探",
          value: snapshot?.sniffedClipboardUrl ? "已捕获下载链接" : "等待复制 URL",
          subtitle: snapshot?.sniffedProtocol || "支持 HTTP/FTP/Magnet",
          icon: "🔗",
          color: snapshot?.sniffedClipboardUrl ? "#8b5cf6" : "#64748b"
        }
      ]
    }),
    snapshot && snapshot.categoryStats.length > 0
      ? DistributionBar({
          title: `本机 Downloads 目录文件类型空间占比 (总计 ${formatBytes(snapshot.totalSizeBytes)})`,
          totalValue: snapshot.totalSizeBytes,
          segments: snapshot.categoryStats.map((st) => ({
            id: st.category,
            label: `${st.name} (${st.count})`,
            value: st.sizeBytes,
            formattedValue: formatBytes(st.sizeBytes),
            color: st.color
          }))
        })
      : null,
    FilterBar({
      title: "Aria2 多线程分块下载向导与文件分类筛选",
      wizardSteps: [
        {
          step: 1,
          label: "1. 嗅探剪贴板/粘贴 URL",
          status: snapshot?.sniffedClipboardUrl ? "done" : "active"
        },
        {
          step: 2,
          label: `2. 配置 ${activeThreadPreset.threads} 线程分块`,
          status: "active"
        },
        {
          step: 3,
          label: "3. 多路并发断点续传",
          status: "pending"
        },
        {
          step: 4,
          label: "4. 本地归档与空间清理",
          status: checkedPaths.length > 0 ? "active" : "pending"
        }
      ],
      groups: [
        {
          id: "thread-preset",
          label: "并发线程",
          value: threadPresetId,
          onChange: (val) => setThreadPresetId(val as ThreadSplitPresetId),
          options: THREAD_SPLIT_PRESETS.map((p) => ({
            value: p.id,
            label: p.name,
            badge: `${p.threads}x`
          }))
        },
        {
          id: "file-cat",
          label: "文件类型",
          value: selectedCategory,
          onChange: (val) => setSelectedCategory(val as DownloadFileCategory),
          options: [
            { value: "all", label: "全部已下载", badge: allFiles.length },
            ...DOWNLOAD_CATEGORIES.map((c) => ({
              value: c.id,
              label: `${c.icon} ${c.name}`,
              badge: allFiles.filter((f) => f.category === c.id).length
            }))
          ]
        }
      ],
      actions: [
        {
          id: "start-clip-dl",
          title: "🚀 新建多线程下载 (剪贴板/输入框)",
          style: "primary",
          onAction: () => void handleStartClipboardDownload()
        },
        {
          id: "open-dl-dir",
          title: "📂 打开 Downloads 目录",
          style: "secondary",
          onAction: () => {
            if (snapshot?.downloadDir) {
              void openDownloadedFile(snapshot.downloadDir);
            }
          }
        },
        ...(checkedPaths.length > 0
          ? [
              {
                id: "trash-checked",
                title: `🗑️ 清理勾选 (${checkedPaths.length}项 · ${formatBytes(checkedBytes)})`,
                style: "danger" as const,
                onAction: () => void handleBatchTrashChecked()
              }
            ]
          : [])
      ]
    }),
    SegmentedControl({
      value: activeTab,
      onChange: (val) => setActiveTab(val as MultiDownloadTab),
      options: [
        { value: "files", label: `已下载文件管理 (${filteredFiles.length})`, icon: "📥" },
        { value: "new_task", label: "多线程分块参数与剪贴板嗅探", icon: "⚡" },
        { value: "engine_diag", label: "Aria2 引擎与磁盘容量诊断", icon: "🛡️" }
      ]
    })
  ].filter(Boolean) as ViewNode[];

  function renderFileItem(item: DownloadedFileItem): ViewNode {
    const isChecked = checkedSet.has(item.path);
    const mtimeStr = new Date(item.mtimeMs).toLocaleString();
    const aria2Cmd = `aria2c ${activeThreadPreset.aria2Flags} -d "${snapshot?.downloadDir || ""}" -o "${item.name}"`;

    return List.Item({
      id: item.id,
      title: item.name,
      subtitle: `${item.categoryName} · ${mtimeStr}`,
      icon: item.categoryIcon,
      checkable: true,
      checked: isChecked,
      onCheckChange: (next) => toggleCheckFile(item.path, next),
      accessories: [
        { tag: { value: item.ext.toUpperCase(), color: item.categoryColor } },
        { text: formatBytes(item.sizeBytes) }
      ],
      detail: List.Item.Detail({
        markdown: [
          `### ${item.categoryIcon} ${item.name}`,
          "",
          `- **完整物理路径**：\`${item.path}\``,
          `- **文件大小**：**${formatBytes(item.sizeBytes)}** (${item.sizeBytes.toLocaleString()} Bytes)`,
          `- **文件分类**：${item.categoryName} (\`${item.ext}\`)`,
          `- **最后修改时间**：${mtimeStr}`,
          "",
          "#### ⚡ 当前 Aria2 分块重下/续传命令参考",
          "```bash",
          aria2Cmd,
          "```"
        ].join("\n"),
        metadata: Detail.Metadata({
          children: [
            Detail.Metadata.Label({ title: "所属分类", text: item.categoryName }),
            Detail.Metadata.Label({ title: "文件体积", text: formatBytes(item.sizeBytes) }),
            Detail.Metadata.Label({
              title: "分块并发策略",
              text: `${activeThreadPreset.threads} 线程 (${activeThreadPreset.splitSize})`
            }),
            Detail.Metadata.Separator(),
            Detail.Metadata.Label({ title: "状态提示", text: statusMessage })
          ]
        })
      }),
      actions: ActionPanel({
        children: [
          Action({
            title: "打开此下载文件",
            icon: Icon.Document,
            onAction: () => void openDownloadedFile(item.path)
          }),
          Action({
            title: "在资源管理器中定位文件",
            icon: Icon.Folder,
            onAction: () => void openDownloadedFileLocation(item.path)
          }),
          Action({
            title: isChecked ? "取消勾选此文件" : "勾选此文件 (加入批量清理)",
            icon: Icon.Checkmark,
            onAction: () => toggleCheckFile(item.path, !isChecked)
          }),
          Action({
            title: "移入系统回收站",
            icon: Icon.Trash,
            style: "destructive",
            onAction: async () => {
              await deleteDownloadedFiles([item.path]);
              await refreshWorkspace();
            }
          }),
          Action({
            title: "复制完整文件路径",
            icon: Icon.Clipboard,
            onAction: async () => {
              await writeRealClipboardText(item.path);
              await showToast({ style: ToastStyle.Success, title: "已复制文件路径" });
            }
          }),
          Action({
            title: "重新扫描本机下载目录",
            icon: Icon.ArrowClockwise,
            onAction: () => void refreshWorkspace()
          })
        ]
      })
    });
  }

  return List({
    isLoading,
    isShowingDetail: true,
    searchBarPlaceholder: "搜索本机已下载文件名/后缀，或直接粘贴 HTTP/Magnet 链接发起 16 线程下载...",
    onSearchTextChange: (val) => setSearchText(val),
    header: headerNode,
    children: [
      ...(activeTab === "files"
        ? [
            List.Section({
              title: `本机已下载文件库 (${filteredFiles.length} 项 · 已勾选 ${checkedPaths.length} 项 / ${formatBytes(checkedBytes)})`,
              subtitle: statusMessage,
              children: filteredFiles.map((item) => renderFileItem(item))
            })
          ]
        : []),
      ...(activeTab === "new_task"
        ? [
            List.Section({
              title: "多线程分块并发档位与剪贴板自动嗅探",
              subtitle: snapshot?.sniffedClipboardUrl
                ? `已捕获链接: ${snapshot.sniffedClipboardUrl}`
                : "复制任意下载链接后点击即可启动分块加速",
              children: THREAD_SPLIT_PRESETS.map((preset) =>
                List.Item({
                  id: `preset-${preset.id}`,
                  title: preset.name,
                  subtitle: preset.description,
                  icon: preset.id === threadPresetId ? "⚡" : "🔧",
                  accessories: [
                    {
                      tag: {
                        value: `${preset.threads} 线程 / ${preset.splitSize}`,
                        color: preset.id === threadPresetId ? Color.Green : Color.Blue
                      }
                    }
                  ],
                  detail: List.Item.Detail({
                    markdown: [
                      `### ⚡ ${preset.name}`,
                      "",
                      preset.description,
                      "",
                      "#### Aria2 核心分块参数",
                      "```bash",
                      `aria2c ${preset.aria2Flags} -d "${snapshot?.downloadDir || "C:\\Downloads"}" "${snapshot?.sniffedClipboardUrl || searchText.trim() || "https://example.com/large-archive.zip"}"`,
                      "```",
                      "",
                      `- **剪贴板当前嗅探链接**：\`${snapshot?.sniffedClipboardUrl || "未检测到链接（可在上方搜索框直接输入 URL）"}\``,
                      `- **链接协议类型**：${snapshot?.sniffedProtocol || "自动识别 HTTP/HTTPS/FTP/Magnet"}`
                    ].join("\n")
                  }),
                  actions: ActionPanel({
                    children: [
                      Action({
                        title: `选用「${preset.name}」并启动下载`,
                        icon: Icon.Download,
                        onAction: async () => {
                          setThreadPresetId(preset.id);
                          await handleStartClipboardDownload();
                        }
                      }),
                      Action({
                        title: "复制 Aria2 命令行参数",
                        icon: Icon.Clipboard,
                        onAction: async () => {
                          await writeRealClipboardText(
                            `aria2c ${preset.aria2Flags} -d "${snapshot?.downloadDir || ""}" "${snapshot?.sniffedClipboardUrl || searchText.trim()}"`
                          );
                          await showToast({ style: ToastStyle.Success, title: "已复制 Aria2 命令行" });
                        }
                      })
                    ]
                  })
                })
              )
            })
          ]
        : []),
      ...(activeTab === "engine_diag"
        ? [
            List.Section({
              title: "Aria2 JSON-RPC 守护进程与磁盘空间安全诊断",
              children: [
                List.Item({
                  id: "diag-aria2",
                  title: "Aria2 多线程分块引擎状态",
                  subtitle: snapshot?.aria2Endpoint || "http://127.0.0.1:6800/jsonrpc",
                  icon: "🚀",
                  accessories: [
                    {
                      tag: {
                        value: snapshot?.aria2RpcOnline ? "RPC 在线就绪" : "宿主内置通道就绪",
                        color: Color.Green
                      }
                    }
                  ],
                  detail: List.Item.Detail({
                    markdown: [
                      "### 🛡️ Aria2 多线程引擎与磁盘预检报告",
                      "",
                      `- **下载保存目录**：\`${snapshot?.downloadDir || ""}\``,
                      `- **所属分区剩余可用容量**：**${formatBytes(snapshot?.driveFreeBytes || 0)}** / 总计 ${formatBytes(snapshot?.driveTotalBytes || 0)}`,
                      `- **Aria2 JSON-RPC 端点**：\`${snapshot?.aria2Endpoint || "http://127.0.0.1:6800/jsonrpc"}\` (${snapshot?.aria2RpcOnline ? "已连接守护进程" : "按需唤起 / 宿主内置高速下载"})`,
                      `- **支持协议栈**：HTTP/1.1, HTTP/2, HTTPS, FTP, SFTP, BitTorrent, Magnet URI`
                    ].join("\n")
                  }),
                  actions: ActionPanel({
                    children: [
                      Action({
                        title: "重新探测引擎与磁盘余量",
                        icon: Icon.ArrowClockwise,
                        onAction: () => void refreshWorkspace()
                      })
                    ]
                  })
                })
              ]
            })
          ]
        : [])
    ]
  });
}

export default MultiDownloadCommand;
