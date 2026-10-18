import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  FileRecord,
  SortOption,
  TypeFilter,
  FileQuickLookResult,
  FileActionResult
} from "./types.js";
import {
  formatBytes,
  truncatePath,
  getFileCategory,
  SAMPLE_FILES,
  sortAndFilterFiles,
  searchLocalFiles,
  getFileQuickLook,
  calculateFileSha256,
  calculateFileMd5,
  openFile,
  openWith,
  revealFile,
  moveToTrash,
  copyFileToClipboard,
  quickLookFile
} from "./search-service.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export * from "./types.js";
export * from "./search-service.js";

/**
 * 空格即时预览视图 (Space Quick Look Detail View)
 * 100% 对齐 Raycast quickLookSelection 原生手感
 */
export function FileQuickLookDetailView({
  file,
  initialQuickLook
}: {
  file: FileRecord;
  initialQuickLook?: FileQuickLookResult;
}) {
  const [quickLook, setQuickLook] = useState<FileQuickLookResult | null>(initialQuickLook || null);
  const [sha256, setSha256] = useState<string>("");

  React.useEffect(() => {
    if (!initialQuickLook) {
      void getFileQuickLook(file).then(setQuickLook);
    }
    void calculateFileSha256(file.path).then(setSha256).catch(() => setSha256(""));
  }, [file.path]);

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const ql = quickLook;

  let markdown = `# 🔍 即时预览: ${file.name}\n\n> **路径**: \`${file.path}\`\n\n`;

  if (!ql) {
    markdown += `⏳ 正在抽取文件头部数据与语法分析...`;
  } else if (ql.previewType === "error") {
    markdown += `> ⚠️ **读取异常**: ${ql.error || "无法访问该文件"}\n\n可能原因：文件被独占占用、权限不足或路径不存在。`;
  } else if (ql.previewType === "empty") {
    markdown += `> ℹ️ **空文件**: 该文件长度为 0 字节。`;
  } else if (ql.previewType === "directory") {
    markdown += `### 📁 文件夹内容 (${ql.totalLines ?? 0} 项)\n\n`;
    if (ql.dirEntries && ql.dirEntries.length > 0) {
      markdown += ql.dirEntries
        .map((e) => `- ${e.isDir ? "📁" : "📄"} \`${e.name}\``)
        .join("\n");
      if (ql.truncated) {
        markdown += `\n\n*(仅显示前 25 项，已安全截断)*`;
      }
    } else {
      markdown += `*(空目录或暂无子项)*`;
    }
  } else if (ql.previewType === "image") {
    markdown += `![图片预览](${ql.content})\n\n> 分辨率/原图链接: \`${ql.content}\``;
  } else if (ql.previewType === "markdown") {
    markdown += `${ql.content}\n\n`;
    if (ql.truncated) {
      markdown += `\n\n*(内容超限，已截取前 200 行 / 64KB 防内存爆破)*`;
    }
  } else if (ql.previewType === "code") {
    markdown += `\`\`\`${ql.codeLanguage || ext}\n${ql.content}\n\`\`\`\n\n`;
    if (ql.truncated) {
      markdown += `*(代码超限，已截取前 200 行 / 64KB 防内存爆破)*`;
    }
  } else {
    markdown += `> ℹ️ ${ql.content || "该格式为二进制文件，请使用关联应用直接打开。"}`;
  }

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`Quick Look: ${file.name}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="文件名" text={file.name} icon={Icon.Document} />
          <Detail.Metadata.Label title="所在位置" text={file.path} icon={Icon.Folder} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="大小"
            text={file.isDir ? "文件夹" : formatBytes(file.size)}
            icon={Icon.HardDrive}
          />
          <Detail.Metadata.Label
            title="修改时间"
            text={new Date(file.mtime).toLocaleString("zh-CN")}
            icon={Icon.Calendar}
          />
          {ql?.totalLines !== undefined && ql.previewType === "code" && (
            <Detail.Metadata.Label
              title="行数统计"
              text={`${ql.totalLines} 行${ql.truncated ? " (已截取前200行)" : ""}`}
              icon={Icon.List}
            />
          )}
          {sha256 ? (
            <Detail.Metadata.Label
              title="SHA-256"
              text={`${sha256.slice(0, 16)}...`}
              icon={Icon.Lock}
            />
          ) : null}
          <Detail.Metadata.TagList title="分类">
            <Detail.Metadata.TagList.Item
              text={file.isDir ? "目录" : `.${ext.toUpperCase() || "FILE"}`}
              color={file.isDir ? Color.Orange : Color.Blue}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="文件操作">
          <Action
            title={file.isDir ? "打开文件夹" : "打开文件"}
            icon={file.isDir ? Icon.Folder : Icon.Document}
            onAction={async () => {
              const res = await openFile(file.path);
              await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
            }}
          />
          <Action
            title="在 Finder / 资源管理器中定位 (Show in Finder)"
            icon={Icon.Folder}
            shortcut={{ modifiers: ["ctrl"], key: "enter" }}
            onAction={async () => {
              const res = await revealFile(file.path);
              await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
            }}
          />
          <Action
            title="Quick Look 快速预览"
            icon={Icon.Eye}
            shortcut={{ modifiers: ["ctrl"], key: "y" }}
            onAction={async () => {
              const res = await callHostTransport("filesearch_quick_look", { path: file.path });
              await showToast(
                Toast.Style.Success,
                res.ok ? `已调起 Quick Look 原生预览: ${file.name}` : `快速预览: ${file.name}`
              );
            }}
          />
          <Action.CopyToClipboard
            title="复制文件绝对路径"
            content={file.path}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="复制文件名"
            content={file.name}
            shortcut={{ modifiers: ["ctrl"], key: "c" }}
          />
          {sha256 ? (
            <Action.CopyToClipboard
              title="复制 SHA-256 哈希值"
              content={sha256}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "h" }}
            />
          ) : null}
        </ActionPanel>
      }
    />
  );
}

/**
 * 文件的详细信息视图 (独立卡片模式)
 */
export function FileDetailView({ file }: { file: FileRecord }) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isCode = ["js", "ts", "vue", "html", "css", "json", "py", "cpp", "c", "h", "rs", "go", "java", "sql", "md"].includes(ext);

  const markdown = file.isDir
    ? `
# 📁 文件夹: ${file.name}

> **完整绝对路径**: \`${file.path}\`

### 目录概览
- **类型**: 本地文件系统目录
- **最后修改**: ${new Date(file.mtime).toLocaleString("zh-CN")}
- **快速操作**: 支持按 \`Enter\` 在 Finder / 资源管理器中打开该文件夹，或使用 \`Ctrl+Shift+C\` / \`Cmd+Shift+C\` 快速复制绝对路径。
`
    : `
# 📄 ${file.name}

> **文件路径**: \`${file.path}\`  
> **文件大小**: \`${formatBytes(file.size)}\` | **修改时间**: \`${new Date(file.mtime).toLocaleString("zh-CN")}\`

${
  isCode
    ? `### 源代码 / 文本预览
\`\`\`${ext === "ts" || ext === "js" ? "typescript" : ext}
// 文件路径: ${file.path}
// 状态: 已建立索引 (macOS Spotlight mdfind / Windows NTFS MFT)，就绪可用
\`\`\``
    : `### 文件信息
- **扩展名**: \`.${ext || "未知"}\`
- **归属分类**: \`${getFileCategory(file.name, file.isDir)}\`
- **系统关联**: 默认调用 macOS / Windows 关联应用秒级启动，支持 \`Cmd+Y\` / \`Ctrl+Y\` 原生 Quick Look 预览。`
}
`;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`${file.name} (${formatBytes(file.size)})`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="文件名" text={file.name} icon={Icon.Document} />
          <Detail.Metadata.Label title="所在位置" text={file.path} icon={Icon.Folder} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="大小"
            text={file.isDir ? "文件夹" : formatBytes(file.size)}
            icon={Icon.HardDrive}
          />
          <Detail.Metadata.Label
            title="修改时间"
            text={new Date(file.mtime).toLocaleString("zh-CN")}
            icon={Icon.Calendar}
          />
          <Detail.Metadata.TagList title="类型">
            <Detail.Metadata.TagList.Item
              text={file.isDir ? "目录" : `.${ext.toUpperCase() || "FILE"}`}
              color={file.isDir ? Color.Orange : Color.Blue}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="文件操作">
          <Action
            title="在 Finder / 资源管理器中定位 (Show in Finder)"
            icon={Icon.Folder}
            onAction={async () => {
              const res = await revealFile(file.path);
              await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
            }}
          />
          <Action
            title="Quick Look 快速预览"
            icon={Icon.Eye}
            shortcut={{ modifiers: ["ctrl"], key: "y" }}
            onAction={async () => {
              const res = await callHostTransport("filesearch_quick_look", { path: file.path });
              await showToast(
                Toast.Style.Success,
                res.ok ? `已调起 Quick Look 原生预览: ${file.name}` : `快速预览: ${file.name}`
              );
            }}
          />
          <Action.Push
            title="即时预览 (Quick Look)"
            icon={Icon.Eye}
            shortcut={{ modifiers: ["ctrl"], key: "y" }}
            target={() => <FileQuickLookDetailView file={file} />}
          />
          <Action.CopyToClipboard
            title="复制文件绝对路径"
            content={file.path}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="复制文件名"
            content={file.name}
            shortcut={{ modifiers: ["ctrl"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 根命令：Everything 文件搜索 (Raycast 1:1 双栏详情分栏 + 原版 Action 集合)
 */
export default function EverythingFileSearchCommand() {
  const [query, setQuery] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("name-asc");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [allFiles, setAllFiles] = useState<FileRecord[]>(() =>
    isRealElectronHost() ? [] : SAMPLE_FILES
  );
  const [isLoading, setIsLoading] = useState<boolean>(() => isRealElectronHost());
  const [isShowingDetail, setIsShowingDetail] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { push } = useNavigation();

  // 触发搜索
  const handleSearchTextChange = async (text: string) => {
    setQuery(text);
    setIsLoading(true);
    try {
      const results = await searchLocalFiles(text, 50);
      setAllFiles(results);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isRealElectronHost()) {
      void handleSearchTextChange("");
    }
  }, []);

  // 排序与筛选后的展示列表
  const displayedFiles = sortAndFilterFiles(allFiles, sortOption, typeFilter);
  const activeFile = displayedFiles.find((f) => f.path === selectedId) || displayedFiles[0];
  const totalSizeBytes = displayedFiles.reduce((acc, f) => acc + (f.isDir ? 0 : f.size || 0), 0);

  const handleOpenFile = async (file: FileRecord) => {
    const res = await openFile(file.path);
    await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
  };

  const handleOpenWith = async (file: FileRecord) => {
    const res = await openWith(file.path);
    await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
  };

  const handleShowInFolder = async (file: FileRecord) => {
    const res = await revealFile(file.path);
    await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
  };

  const handleMoveToTrash = async (file: FileRecord) => {
    const res = await moveToTrash(file.path);
    if (res.success) {
      setAllFiles((prev) => prev.filter((f) => f.path !== file.path));
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleCopyFile = async (file: FileRecord) => {
    const res = await copyFileToClipboard(file.path);
    await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
  };

  const handleCalculateSha256 = async (file: FileRecord) => {
    try {
      const hash = await calculateFileSha256(file.path);
      await Clipboard.copy(hash);
      await showToast(Toast.Style.Success, `已复制 SHA-256: ${hash.slice(0, 16)}...`);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, `计算 SHA-256 失败: ${err.message || String(err)}`);
    }
  };

  const handleCalculateMd5 = async (file: FileRecord) => {
    try {
      const hash = await calculateFileMd5(file.path);
      await Clipboard.copy(hash);
      await showToast(Toast.Style.Success, `已复制 MD5: ${hash}`);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, `计算 MD5 失败: ${err.message || String(err)}`);
    }
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="Everything文件搜索 (支持拼音、扩展名与双栏预览)..."
      onSearchTextChange={handleSearchTextChange}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `当前匹配 ${displayedFiles.length} 个文件/目录 • 总大小 ${formatBytes(totalSizeBytes)}${query ? ` • 检索词 "${query}"` : ""}`,
        groups: [
          {
            id: "type",
            label: "文件类型",
            value: typeFilter,
            onChange: (val: string) => setTypeFilter(val as TypeFilter),
            options: [
              { value: "all", label: "全部" },
              { value: "document", label: "文档" },
              { value: "image", label: "图片" },
              { value: "video", label: "音视频" },
              { value: "code", label: "代码" },
              { value: "archive", label: "压缩包" }
            ]
          }
        ],
        actions: [
          {
            id: "open",
            label: "🚀 打开选中项",
            title: "🚀 打开选中项",
            style: "primary",
            onAction: () => {
              if (activeFile) void handleOpenFile(activeFile);
            }
          },
          {
            id: "reveal",
            label: "📂 定位所在目录",
            title: "📂 定位所在目录",
            style: "secondary",
            onAction: () => {
              if (activeFile) void handleShowInFolder(activeFile);
            }
          },
          {
            id: "quicklook",
            label: "👁️ Quick Look 预览",
            title: "👁️ Quick Look 预览",
            style: "secondary",
            onAction: () => {
              if (activeFile) push(<FileQuickLookDetailView file={activeFile} />);
            }
          },
          {
            id: "sha256",
            label: "🔐 复制 SHA-256",
            title: "🔐 复制 SHA-256",
            style: "secondary",
            onAction: () => {
              if (activeFile) void handleCalculateSha256(activeFile);
            }
          },
          {
            id: "trash",
            label: "🗑️ 移入回收站",
            title: "🗑️ 移入回收站",
            style: "danger",
            onAction: () => {
              if (activeFile) void handleMoveToTrash(activeFile);
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="类型筛选与排序"
          onChange={(val: string) => {
            if (val.startsWith("sort:")) {
              setSortOption(val.replace("sort:", "") as SortOption);
            } else if (val.startsWith("type:")) {
              setTypeFilter(val.replace("type:", "") as TypeFilter);
            }
          }}
        >
          <List.Dropdown.Section title="类型筛选">
            <List.Dropdown.Item title="全部文件与文件夹 (All)" value="type:all" />
            <List.Dropdown.Item title="📄 文档与表格 (Documents)" value="type:document" />
            <List.Dropdown.Item title="🖼️ 图片与照片 (Images)" value="type:image" />
            <List.Dropdown.Item title="🎬 视频与影片 (Videos)" value="type:video" />
            <List.Dropdown.Item title="🎵 音频与音乐 (Audio)" value="type:audio" />
            <List.Dropdown.Item title="📦 压缩文件 (Archives)" value="type:archive" />
            <List.Dropdown.Item title="💻 源代码与配置 (Code)" value="type:code" />
            <List.Dropdown.Item title="📁 文件夹目录 (Folders)" value="type:folder" />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="排序方式">
            <List.Dropdown.Item title="按名称升序 (A-Z)" value="sort:name-asc" />
            <List.Dropdown.Item title="按名称降序 (Z-A)" value="sort:name-desc" />
            <List.Dropdown.Item title="按文件大小 (从大到小)" value="sort:size-desc" />
            <List.Dropdown.Item title="按文件大小 (从小到大)" value="sort:size-asc" />
            <List.Dropdown.Item title="按修改时间 (最新优先)" value="sort:mtime-desc" />
            <List.Dropdown.Item title="按修改时间 (最早优先)" value="sort:mtime-asc" />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {displayedFiles.map((file) => {
        const isDir = file.isDir;
        const category = getFileCategory(file.name, isDir);
        const ext = (file.name.split(".").pop() || "").toLowerCase();

        let fileIcon = Icon.Document;
        if (isDir) fileIcon = Icon.Folder;
        else if (category === "image") fileIcon = Icon.Image;
        else if (category === "video") fileIcon = Icon.Video;
        else if (category === "audio") fileIcon = Icon.Play;
        else if (category === "code") fileIcon = Icon.Code;
        else if (category === "archive") fileIcon = Icon.HardDrive;
        else if (category === "app") fileIcon = Icon.Terminal;

        const detailMarkdown = `
# ${isDir ? "📁" : "📄"} ${file.name}

> **绝对路径**: \`${file.path}\`  
> **文件大小**: \`${isDir ? "文件夹" : formatBytes(file.size)}\` | **修改时间**: \`${new Date(file.mtime).toLocaleString("zh-CN")}\`

---

${
  isDir
    ? `### 文件夹属性\n- 本地目录，包含子项目与文件\n- 支持按 \`Enter\` 在 Finder / 资源管理器中打开`
    : `### 文件属性\n- **扩展名**: \`.${ext.toUpperCase() || "未知"}\`\n- **分类**: \`${category.toUpperCase()}\`\n- **系统关联**: 默认调用 macOS Spotlight / Windows NTFS MFT 关联应用秒级启动`
}
`;

        return (
          <List.Item
            key={file.path}
            id={file.path}
            title={file.name}
            subtitle={isShowingDetail ? undefined : truncatePath(file.path)}
            icon={fileIcon}
            accessories={
              isShowingDetail
                ? undefined
                : [
                    {
                      text: isDir ? "文件夹" : formatBytes(file.size),
                      icon: isDir ? Icon.Folder : Icon.HardDrive
                    }
                  ]
            }
            detail={
              <List.Item.Detail
                markdown={detailMarkdown}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="完整路径"
                      text={file.path}
                      icon={Icon.Folder}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="文件名"
                      text={file.name}
                      icon={Icon.Document}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="文件大小"
                      text={isDir ? "文件夹" : formatBytes(file.size)}
                      icon={Icon.HardDrive}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="修改时间"
                      text={new Date(file.mtime).toLocaleString("zh-CN")}
                      icon={Icon.Calendar}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="扩展名属性"
                      text={isDir ? "文件夹 (Directory)" : `.${ext.toUpperCase()} 文件`}
                      icon={Icon.Document}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.TagList title="分类归属">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={category.toUpperCase()}
                        color={isDir ? Color.Orange : Color.Blue}
                      />
                    </List.Item.Detail.Metadata.TagList>
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel title={file.name}>
                <ActionPanel.Section title="核心动作">
                  <Action
                    title={isDir ? "打开文件夹" : "打开文件"}
                    icon={isDir ? Icon.Folder : Icon.Document}
                    onAction={() => handleOpenFile(file)}
                  />
                  <Action
                    title="选择关联打开程序 (Open With...)"
                    icon={Icon.Upload}
                    shortcut={{ modifiers: ["ctrl"], key: "o" }}
                    onAction={() => handleOpenWith(file)}
                  />
                  <Action
                    title="在 Finder / 资源管理器中定位 (Show in Finder)"
                    icon={Icon.Folder}
                    shortcut={{ modifiers: ["ctrl"], key: "enter" }}
                    onAction={() => handleShowInFolder(file)}
                  />
                  <Action
                    title="Quick Look 快速预览"
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl"], key: "y" }}
                    onAction={async () => {
                      const res = await callHostTransport("filesearch_quick_look", { path: file.path });
                      await showToast(
                        Toast.Style.Success,
                        res.ok ? `已调起 Quick Look 原生预览: ${file.name}` : `快速预览: ${file.name}`
                      );
                    }}
                  />
                  <Action
                    title={isShowingDetail ? "隐藏详情分栏" : "展开详情分栏"}
                    icon={Icon.SidebarRight}
                    shortcut={{ modifiers: ["ctrl"], key: "d" }}
                    onAction={() => setIsShowingDetail((prev) => !prev)}
                  />
                  <Action.Push
                    title="即时预览 (Quick Look)"
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl"], key: "y" }}
                    target={() => <FileQuickLookDetailView file={file} />}
                  />
                  <Action.Push
                    title="查看完整详情卡片"
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "i" }}
                    target={() => <FileDetailView file={file} />}
                  />
                </ActionPanel.Section>

                <ActionPanel.Section title="快捷复制 (Clipboard)">
                  <Action.CopyToClipboard
                    title="复制文件绝对路径"
                    content={file.path}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="复制文件名"
                    content={file.name}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  />
                  <Action
                    title="复制文件本身到剪贴板"
                    icon={Icon.Clipboard}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "v" }}
                    onAction={() => handleCopyFile(file)}
                  />
                  <Action
                    title="计算并复制 SHA-256"
                    icon={Icon.Lock}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "h" }}
                    onAction={() => handleCalculateSha256(file)}
                  />
                  <Action
                    title="计算并复制 MD5"
                    icon={Icon.Lock}
                    onAction={() => handleCalculateMd5(file)}
                  />
                </ActionPanel.Section>

                <ActionPanel.Section title="文件治理 (Operations)">
                  <Action
                    title="移入回收站 (Move to Trash)"
                    icon={Icon.Trash}
                    style="destructive"
                    shortcut={{ modifiers: ["ctrl"], key: "backspace" }}
                    onAction={() => handleMoveToTrash(file)}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
