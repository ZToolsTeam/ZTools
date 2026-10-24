/**
 * 下载文件夹管家 (downloads-manager) 声明式主视图
 *
 * 借鉴 Raycast 官方 `extensions/downloads-manager/src/manage-downloads.tsx` 改造：
 * - 支持一键打开/复制最新下载的文件（方便直接粘贴到微信/飞书发送）
 * - 支持按 6 大文件类型过滤、大文件筛选、一键按分类自动归档整理与过期垃圾清理
 */

import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  Toast
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import { DownloadFileItem, DownloadFilterCategory } from "./types.js";
import {
  defaultDownloadsManager,
  formatFileSize
} from "./downloads-service.js";

export * from "./types.js";
export * from "./downloads-service.js";

/**
 * 单个下载文件详情视图
 */
export function DownloadFileDetailView({
  file,
  onUpdated
}: {
  file: DownloadFileItem;
  onUpdated?: () => void;
}) {
  const markdown = `
# 📂 ${file.filename}

${file.pinned ? "> 📌 **已置顶保护文件（不会被自动清理删除）**\n" : ""}
${file.archivedTo ? `> 🗂️ **已自动归档至子目录**: \`${file.archivedTo}\`\n` : ""}

---

### 文件属性
- **所属分类**: \`${file.categoryLabel} (${file.extension})\`
- **文件大小**: \`${file.formattedSize}\` (\`${file.sizeBytes.toLocaleString()} Bytes\`)
- **下载时间**: \`${file.formattedDate}\`
- **完整路径**: \`${file.path}\`

${file.summary ? `### 摘要说明\n> ${file.summary}\n` : ""}
`;

  return (
    <Detail
      navigationTitle={`文件详情: ${file.filename}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="文件名" text={file.filename} icon={Icon.Document} />
          <Detail.Metadata.TagList title="智能分类">
            <Detail.Metadata.TagList.Item text={file.categoryLabel} color={Color.Blue} />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="文件大小" text={file.formattedSize} icon={Icon.HardDrive} />
          <Detail.Metadata.Label title="修改时间" text={file.formattedDate} icon={Icon.Clock} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action
            title="打开文件 (Open File)"
            icon={Icon.Document}
            onAction={async () => {
              const res = await defaultDownloadsManager.openDownload(file.id);
              await showToast(
                res.success ? Toast.Style.Success : Toast.Style.Failure,
                res.message
              );
            }}
          />
          <Action
            title="在 Finder / 资源管理器中显示 (Show in Finder)"
            icon={Icon.Folder}
            onAction={async () => {
              const res = await defaultDownloadsManager.showInFinder(file.id);
              await showToast(
                res.success ? Toast.Style.Success : Toast.Style.Failure,
                res.message
              );
            }}
          />
          <Action
            title="复制文件路径到剪贴板"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(file.path);
              await showToast(Toast.Style.Success, "已复制文件完整路径");
            }}
          />
          <Action
            title={file.pinned ? "取消置顶保护" : "置顶保护此文件"}
            icon={file.pinned ? Icon.StarDisabled : Icon.Star}
            onAction={async () => {
              defaultDownloadsManager.togglePin(file.id);
              onUpdated?.();
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 下载文件夹管家主命令组件 (对应 Raycast `manage-downloads.tsx`)
 */
export default function DownloadsManagerCommand() {
  const [searchText, setSearchText] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<DownloadFilterCategory>("all");
  const [isShowingDetail, setIsShowingDetail] = useState(true);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    let active = true;
    void defaultDownloadsManager.syncRealDownloads().then(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
    };
  }, []);

  const files = useMemo(
    () =>
      defaultDownloadsManager.getDownloads({
        query: searchText,
        category: categoryFilter
      }),
    [searchText, categoryFilter, version]
  );

  const activeFile = useMemo(
    () => files.find((f) => f.id === selectedId) || files[0],
    [files, selectedId]
  );

  const totalBytes = useMemo(
    () => files.reduce((sum, item) => sum + item.sizeBytes, 0),
    [files]
  );

  return (
    <List
      navigationTitle="下载文件夹管家 (Downloads Manager)"
      searchBarPlaceholder="搜索下载文件名、后缀或按类型筛选..."
      isShowingDetail={isShowingDetail}
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `~/Downloads 共 ${files.length} 个文件 · 总占用空间 ${formatFileSize(totalBytes)}`,
        actions: [
          {
            id: "organize-all",
            label: "一键分类自动归档",
            title: "一键分类自动归档",
            style: "primary",
            onAction: async () => {
              const res = await defaultDownloadsManager.organizeByCategory(false);
              await showToast(Toast.Style.Success, res.message);
              refresh();
            }
          },
          {
            id: "clean-expired",
            label: "清理 30 天过期文件",
            title: "清理 30 天过期文件",
            style: "danger",
            onAction: async () => {
              const res = await defaultDownloadsManager.cleanExpiredDownloads(30, false);
              await showToast(Toast.Style.Success, res.message);
              refresh();
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按文件类型或状态筛选"
          value={categoryFilter}
          onChange={(val) => setCategoryFilter(val as DownloadFilterCategory)}
        >
          <List.Dropdown.Item title="全部下载文件 (All)" value="all" />
          <List.Dropdown.Item title="📄 办公文档与 PDF (Documents)" value="document" />
          <List.Dropdown.Item title="📦 安装包与程序 (Installers)" value="installer" />
          <List.Dropdown.Item title="🗜️ 压缩归档包 (Archives)" value="archive" />
          <List.Dropdown.Item title="🖼️ 图片与设计稿 (Images)" value="image" />
          <List.Dropdown.Item title="🎬 音视频媒体 (Media)" value="media" />
          <List.Dropdown.Item title="🐘 超过 100MB 的大文件 (Large)" value="large" />
          <List.Dropdown.Item title="🧹 超过 30 天的过期文件 (Expired)" value="expired" />
        </List.Dropdown>
      }
    >
      <List.Section
        title="下载目录文件列表 (Downloads)"
        subtitle={`共 ${files.length} 个文件 • 总计 ${formatFileSize(totalBytes)}`}
      >
        {files.map((item, idx) => (
          <List.Item
            key={item.id}
            id={item.id}
            icon={{
              source: Icon.Document,
              tintColor: idx === 0 ? Color.Green : Color.Blue
            }}
            title={item.filename}
            subtitle={isShowingDetail ? undefined : `${item.categoryLabel} • ${item.formattedDate}`}
            accessories={
              isShowingDetail
                ? [
                    idx === 0 ? { tag: { value: "最新", color: Color.Green } } : {},
                    item.pinned ? { icon: { source: Icon.Star, tintColor: Color.Yellow } } : {},
                    { text: item.formattedSize }
                  ]
                : [
                    idx === 0 ? { tag: { value: "最新下载", color: Color.Green } } : {},
                    item.pinned ? { icon: { source: Icon.Star, tintColor: Color.Yellow } } : {},
                    item.archivedTo ? { tag: { value: item.archivedTo, color: Color.Purple } } : {},
                    { text: item.formattedSize }
                  ]
            }
            detail={
              <List.Item.Detail
                markdown={`# 📂 ${item.filename}\n\n${item.pinned ? "> 📌 **已置顶保护文件（不会被自动清理删除）**\n\n" : ""}${item.archivedTo ? `> 🗂️ **已自动归档至子目录**: \`${item.archivedTo}\`\n\n` : ""}---\n\n### 文件属性\n- **所属分类**: \`${item.categoryLabel} (${item.extension})\`\n- **文件大小**: \`${item.formattedSize}\` (\`${item.sizeBytes.toLocaleString()} Bytes\`)\n- **下载时间**: \`${item.formattedDate}\`\n- **完整路径**: \`${item.path}\`\n\n${item.summary ? `### 摘要说明\n> ${item.summary}\n` : ""}`}
                metadata={
                  <Detail.Metadata>
                    <Detail.Metadata.Label title="文件名" text={item.filename} icon={Icon.Document} />
                    <Detail.Metadata.TagList title="智能分类">
                      <Detail.Metadata.TagList.Item text={item.categoryLabel} color={Color.Blue} />
                    </Detail.Metadata.TagList>
                    <Detail.Metadata.Label title="文件大小" text={item.formattedSize} icon={Icon.HardDrive} />
                    <Detail.Metadata.Label title="下载时间" text={item.formattedDate} icon={Icon.Clock} />
                    <Detail.Metadata.Separator />
                    <Detail.Metadata.Label title="保护状态" text={item.pinned ? "已置顶保护" : "普通文件"} icon={item.pinned ? Icon.Star : Icon.StarDisabled} />
                    <Detail.Metadata.Label title="归档状态" text={item.archivedTo ? `已归档至 ${item.archivedTo}` : "未归档"} icon={Icon.Folder} />
                  </Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="打开此文件 (Open Download)"
                  icon={Icon.Document}
                  onAction={async () => {
                    const res = await defaultDownloadsManager.openDownload(item.id);
                    await showToast(Toast.Style.Success, res.message);
                  }}
                />
                <Action
                  title="在 Finder / 资源管理器中显示 (Show in Finder)"
                  icon={Icon.Folder}
                  shortcut={{ modifiers: ["ctrl", "shift"], key: "o" }}
                  onAction={async () => {
                    const res = await defaultDownloadsManager.showInFinder(item.id);
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    );
                  }}
                />
                <Action
                  title={isShowingDetail ? "隐藏详情预览分栏 (Hide Details)" : "开启详情预览分栏 (Show Details)"}
                  icon={Icon.Sidebar}
                  shortcut={{ modifiers: ["ctrl"], key: "d" }}
                  onAction={() => setIsShowingDetail(!isShowingDetail)}
                />
                <Action
                  title="复制最新下载文件 (Copy Latest Download)"
                  icon={Icon.CopyClipboard}
                  shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  onAction={async () => {
                    const res = await defaultDownloadsManager.copyLatestDownload();
                    if (res.file) {
                      await Clipboard.copy(res.file.path);
                    }
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    );
                  }}
                />
                <Action.Push
                  title="全屏查看文件大详情"
                  icon={Icon.Eye}
                  target={<DownloadFileDetailView file={item} onUpdated={refresh} />}
                />
                <Action
                  title="🗂️ 一键按分类自动归档整理全部文件"
                  icon={Icon.Folder}
                  shortcut={{ modifiers: ["ctrl"], key: "o" }}
                  onAction={async () => {
                    const res = await defaultDownloadsManager.organizeByCategory(false);
                    await showToast(Toast.Style.Success, res.message);
                    refresh();
                  }}
                />
                <Action
                  title="🧹 一键清理超过 30 天的过期文件"
                  icon={Icon.Trash}
                  shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                  onAction={async () => {
                    const res = await defaultDownloadsManager.cleanExpiredDownloads(30, false);
                    await showToast(Toast.Style.Success, res.message);
                    refresh();
                  }}
                />
                <Action
                  title={item.pinned ? "取消置顶保护" : "置顶保护此文件"}
                  icon={item.pinned ? Icon.StarDisabled : Icon.Star}
                  shortcut={{ modifiers: ["ctrl"], key: "p" }}
                  onAction={() => {
                    defaultDownloadsManager.togglePin(item.id);
                    refresh();
                  }}
                />
                <Action
                  title="删除此文件 (Delete Download)"
                  icon={Icon.Trash}
                  onAction={async () => {
                    const res = await defaultDownloadsManager.deleteDownload(item.id);
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    );
                    refresh();
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
