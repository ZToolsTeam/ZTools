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
  Clipboard
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  ReleaseNoteItem,
  AnnouncementItem,
  UpdateCheckResult
} from "./types.js";
import {
  CURRENT_APP_VERSION,
  getReleaseNotes,
  checkForUpdates,
  getActiveAnnouncements,
  dismissAnnouncement
} from "./core-service.js";

export * from "./types.js";
export * from "./core-service.js";

/**
 * M1.5-27: Raycast Core 核心系统状态与更新中心
 */
export default function RaycastCoreCommand() {
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNoteItem[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const notes = getReleaseNotes();
        const anns = await getActiveAnnouncements();
        if (isMounted) {
          setReleaseNotes(notes);
          setAnnouncements(anns);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    await showToast(Toast.Style.Animated, "正在检查 ZTools 最新版本...");
    try {
      const res = await checkForUpdates();
      setUpdateInfo(res);
      if (res.hasUpdate) {
        await showToast(Toast.Style.Success, `发现新版本 v${res.latestVersion}!`, "可立即下载或安装更新");
      } else {
        await showToast(Toast.Style.Success, `已是最新版本 (v${res.currentVersion})`);
      }
    } catch (err: any) {
      await showToast(Toast.Style.Failure, `更新检查失败: ${err.message}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleDismissAnnouncement = async (id: string) => {
    await dismissAnnouncement(id);
    setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    await showToast(Toast.Style.Success, "公告已标记已读并隐藏");
  };

  return (
    <List
      isLoading={isLoading || isCheckingUpdate}
      isShowingDetail={true}
      searchBarPlaceholder="搜索版本特性与系统公告 (Release Notes, Announcements)..."
    >
      {/* 1. 软件更新状态 */}
      <List.Section title="系统更新 (Software Updates)">
        <List.Item
          id="item_check_update"
          title="检查 ZTools 客户端更新"
          subtitle={`当前版本: v${CURRENT_APP_VERSION} (最新稳定版)`}
          icon={Icon.Repeat}
          accessories={[{ text: "检查更新" }]}
          detail={
            <List.Item.Detail
              markdown={`### 🔄 ZTools 客户端更新中心\n\n- **当前已安装版本**: \`v${CURRENT_APP_VERSION}\`\n- **更新服务状态**: 正常运行 (GitHub Releases + 阿里云 CDN)\n- **SHA-256 完整性校验**: 开启强制校验\n\n> 按 **Enter** 立即检查是否有新版本发布。`}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="当前版本" text={`v${CURRENT_APP_VERSION}`} icon={Icon.Document} />
                  <List.Item.Detail.Metadata.Label title="更新通道" text="Stable 稳定通道" icon={Icon.Check} />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.TagList title="状态">
                    <List.Item.Detail.Metadata.TagList.Item text="就绪" color={Color.Green} />
                  </List.Item.Detail.Metadata.TagList>
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action
                title="立即检查更新"
                icon={Icon.Repeat}
                onAction={handleCheckUpdate}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* 2. 系统公告 */}
      {announcements.length > 0 && (
        <List.Section title={`官方公告与广播 (${announcements.length})`}>
          {announcements.map((ann) => (
            <List.Item
              key={ann.id}
              id={ann.id}
              title={ann.title}
              subtitle={ann.date}
              icon={Icon.ExclamationMark}
              accessories={[{ text: ann.severity.toUpperCase() }]}
              detail={
                <List.Item.Detail
                  markdown={`### 📢 ${ann.title}\n\n*发布日期: ${ann.date}*\n\n${ann.content}\n\n${ann.linkUrl ? `[访问官方链接](${ann.linkUrl})` : ""}`}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="忽略此公告"
                    icon={Icon.XMarkCircle}
                    onAction={() => handleDismissAnnouncement(ann.id)}
                  />
                  {ann.linkUrl && (
                    <Action.OpenInBrowser url={ann.linkUrl} />
                  )}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 3. 新特性速览 (Release Notes) */}
      <List.Section title={`版本更新日志 (${releaseNotes.length})`}>
        {releaseNotes.map((note) => (
          <List.Item
            key={note.version}
            id={`note_${note.version}`}
            title={`v${note.version} - ${note.title}`}
            subtitle={note.releaseDate}
            icon={Icon.Document}
            accessories={note.isCurrentVersion ? [{ text: "当前版本" }] : []}
            detail={
              <List.Item.Detail
                markdown={note.markdownNotes}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="版本号" text={`v${note.version}`} icon={Icon.Key} />
                    <List.Item.Detail.Metadata.Label title="发布日期" text={note.releaseDate} icon={Icon.Calendar} />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.TagList title="核心升级">
                      {note.highlights.slice(0, 3).map((h, i) => (
                        <List.Item.Detail.Metadata.TagList.Item
                          key={i}
                          text={h.slice(0, 16)}
                          color={Color.Blue}
                        />
                      ))}
                    </List.Item.Detail.Metadata.TagList>
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="复制版本日志"
                  icon={Icon.Clipboard}
                  onAction={async () => {
                    await Clipboard.copy(note.markdownNotes);
                    await showToast(Toast.Style.Success, `v${note.version} 日志已复制`);
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
