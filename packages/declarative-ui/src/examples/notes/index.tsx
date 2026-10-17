/**
 * Raycast Notes 沉浸式便签笔记管理套件
 * 深度对齐 Raycast 官方 Notes 核心规范：
 * - 多便签本地/SQLite 持久化管理
 * - 双栏沉浸式 Markdown 实时预览与统计元数据
 * - 全键盘极客操作流（新建、编辑、复制、置顶、删除、清空、Markdown 导出）
 */

import React from "../../index.js";
import { confirmAlert } from "../../api/alert.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import {
  NoteItem,
  NoteStats,
  NoteExampleItem,
  NotesFilterTab
} from "./types.js";
import {
  getNotes,
  saveNote,
  updateNote,
  deleteNote,
  clearNotes,
  togglePinNote,
  filterNotes,
  calculateNoteStats,
  deriveNoteTitle,
  exportNoteAsMarkdown,
  formatRelativeTime
} from "./notes-storage.js";

export * from "./types.js";
export * from "./notes-storage.js";

/**
 * 单篇便签详情查看页 (Note Detail View)
 */
export function NoteDetailView({ note }: { note: NoteItem | NoteExampleItem }) {
  const stats = useMemo(() => calculateNoteStats(note.content), [note.content]);
  const formattedTime = typeof note.updatedAt === "number" ? formatRelativeTime(note.updatedAt) : note.updatedAt;

  return (
    <Detail
      markdown={note.content}
      navigationTitle={note.title}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="便签标题" text={note.title} icon={Icon.Document} />
          <Detail.Metadata.TagList title="状态">
            <Detail.Metadata.TagList.Item
              text={note.pinned ? "PINNED (已置顶)" : "NORMAL (便签)"}
              color={note.pinned ? Color.Yellow : Color.Blue}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="统计指标"
            text={`${stats.characters} 字符 • ${stats.words} 词 • ${stats.lines} 行`}
            icon={Icon.Text}
          />
          <Detail.Metadata.Label
            title="预估阅读"
            text={`${stats.readingTimeMinutes} 分钟`}
            icon={Icon.Clock}
          />
          <Detail.Metadata.Label
            title="更新时间"
            text={formattedTime}
            icon={Icon.Calendar}
          />
          {"tags" in note && Array.isArray((note as any).tags) && (note as any).tags.length > 0 && (
            <Detail.Metadata.TagList title="分类标签">
              {(note as any).tags.map((t: string) => (
                <Detail.Metadata.TagList.Item key={t} text={t} />
              ))}
            </Detail.Metadata.TagList>
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action
            title="复制全文"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(note.content);
              await showToast(Toast.Style.Success, "已复制便签全文");
            }}
          />
          <Action
            title="复制 Markdown 源码 (含元数据)"
            icon={Icon.Code}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
            onAction={async () => {
              const fullMd = "tags" in note ? exportNoteAsMarkdown(note as NoteItem) : note.content;
              await Clipboard.copy(fullMd);
              await showToast(Toast.Style.Success, "已复制完整 Markdown 源码");
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 新建便签表单页 (Create Note Form)
 */
export function NoteCreateForm({ onSave }: { onSave?: (note: NoteItem) => void }) {
  const { pop } = useNavigation();

  const handleSubmit = async (values: Record<string, any>) => {
    const rawContent = (values.content ?? "").trim();
    if (!rawContent) {
      await showToast(Toast.Style.Failure, "便签内容不能为空");
      return;
    }

    const tagList = typeof values.tags === "string"
      ? values.tags.split(/[\s,，]+/).filter(Boolean)
      : [];

    const newNote = await saveNote({
      title: values.title?.trim() || undefined,
      content: rawContent,
      pinned: Boolean(values.pinned),
      tags: tagList
    });

    await showToast(Toast.Style.Success, `已创建便签: ${newNote.title}`);
    onSave?.(newNote);
    pop();
  };

  return (
    <Form
      navigationTitle="新建便签笔记"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="创建并保存便签"
            icon={Icon.Checkmark}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="便签标题"
        placeholder="可选，留空则自动提取正文首行作为标题..."
      />
      <Form.TextArea
        id="content"
        title="正文内容 (Markdown)"
        placeholder="编写便签内容，支持 Markdown 标题、任务列表、代码块与链接..."
      />
      <Form.TextField
        id="tags"
        title="分类标签"
        placeholder="标签之间用空格或逗号分隔 (如: work, roadmap)..."
      />
      <Form.Checkbox
        id="pinned"
        label="置顶此便签"
        defaultValue={false}
      />
    </Form>
  );
}

/**
 * 编辑便签表单页 (Edit Note Form)
 */
export function NoteEditForm({
  note,
  onSave
}: {
  note: NoteItem;
  onSave?: (updated: NoteItem) => void;
}) {
  const { pop } = useNavigation();

  const handleSubmit = async (values: Record<string, any>) => {
    const rawContent = (values.content ?? "").trim();
    if (!rawContent) {
      await showToast(Toast.Style.Failure, "便签内容不能为空");
      return;
    }

    const tagList = typeof values.tags === "string"
      ? values.tags.split(/[\s,，]+/).filter(Boolean)
      : note.tags;

    const updated = await updateNote(note.id, {
      title: values.title?.trim() || undefined,
      content: rawContent,
      pinned: Boolean(values.pinned),
      tags: tagList
    });

    if (updated) {
      await showToast(Toast.Style.Success, `便签已更新: ${updated.title}`);
      onSave?.(updated);
    }
    pop();
  };

  return (
    <Form
      navigationTitle={`编辑便签: ${note.title}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存修改"
            icon={Icon.Checkmark}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="便签标题"
        defaultValue={note.title}
        placeholder="留空自动根据正文更新..."
      />
      <Form.TextArea
        id="content"
        title="正文内容 (Markdown)"
        defaultValue={note.content}
        placeholder="支持 Markdown 完整语法..."
      />
      <Form.TextField
        id="tags"
        title="分类标签"
        defaultValue={note.tags.join(" ")}
        placeholder="标签之间用空格分隔..."
      />
      <Form.Checkbox
        id="pinned"
        label="置顶此便签"
        defaultValue={note.pinned}
      />
    </Form>
  );
}

/**
 * 主指令入口：Raycast Notes 便签管理中心
 */
export default function NotesCommand() {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [filterTab, setFilterTab] = useState<NotesFilterTab>("all");
  const [isShowingDetail, setIsShowingDetail] = useState(true);
  const { push } = useNavigation();

  // 加载本地持久化便签
  const refreshNotes = async () => {
    const list = await getNotes();
    setNotes(list);
  };

  useEffect(() => {
    refreshNotes();
  }, []);

  const filtered = useMemo(() => {
    return filterNotes(notes, searchText, filterTab);
  }, [notes, searchText, filterTab]);

  const pinnedNotes = useMemo(() => filtered.filter(n => n.pinned), [filtered]);
  const regularNotes = useMemo(() => filtered.filter(n => !n.pinned), [filtered]);

  const handleTogglePin = async (note: NoteItem) => {
    const updated = await togglePinNote(note.id);
    if (updated) {
      await showToast(
        Toast.Style.Success,
        updated.pinned ? "已置顶便签" : "已取消置顶",
        updated.title
      );
      await refreshNotes();
    }
  };

  const handleDelete = async (note: NoteItem) => {
    const confirmed = await confirmAlert({
      title: `删除便签「${note.title}」？`,
      message: "删除后无法恢复。",
      primaryAction: { title: "删除", style: "destructive" },
      dismissAction: { title: "取消" }
    });
    if (!confirmed) return;
    const success = await deleteNote(note.id);
    if (success) {
      await showToast(Toast.Style.Success, `已删除便签: ${note.title}`);
      await refreshNotes();
    }
  };

  const handleClearAll = async () => {
    const confirmed = await confirmAlert({
      title: "清空全部便签？",
      message: `将删除全部 ${notes.length} 条便签，且无法恢复。`,
      primaryAction: { title: "清空", style: "destructive" },
      dismissAction: { title: "取消" }
    });
    if (!confirmed) return;
    await clearNotes();
    await showToast(Toast.Style.Success, "已清空所有便签笔记");
    await refreshNotes();
  };

  const handleExportMarkdown = async (note: NoteItem) => {
    const markdown = exportNoteAsMarkdown(note);
    await Clipboard.copy(markdown);
    await showToast(
      Toast.Style.Success,
      "已导出 Markdown 并复制到剪贴板",
      `文件结构包含元数据与 ${markdown.length} 字符`
    );
  };

  const renderNoteItem = (note: NoteItem) => {
    const stats = calculateNoteStats(note.content);
    const snippet = note.content
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("#"))[0] || "";

    return (
      <List.Item
        key={note.id}
        id={note.id}
        title={note.title}
        subtitle={isShowingDetail ? undefined : snippet.slice(0, 60)}
        icon={note.pinned ? Icon.Pin : Icon.Document}
        accessories={[
          ...(note.pinned ? [{ icon: Icon.Pin, tooltip: "已置顶便签" }] : []),
          { text: `${stats.characters} 字` },
          { text: formatRelativeTime(note.updatedAt) }
        ]}
        detail={
          <List.Item.Detail
            markdown={note.content}
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="便签标题" text={note.title} icon={Icon.Document} />
                <List.Item.Detail.Metadata.TagList title="置顶状态">
                  <List.Item.Detail.Metadata.TagList.Item
                    text={note.pinned ? "PINNED (已置顶)" : "NORMAL"}
                    color={note.pinned ? Color.Yellow : Color.Blue}
                  />
                </List.Item.Detail.Metadata.TagList>
                <List.Item.Detail.Metadata.Separator />
                <List.Item.Detail.Metadata.Label
                  title="字数统计"
                  text={`${stats.characters} 字符 • ${stats.words} 词 • ${stats.lines} 行`}
                  icon={Icon.Text}
                />
                <List.Item.Detail.Metadata.Label
                  title="预估阅读"
                  text={`${stats.readingTimeMinutes} 分钟`}
                  icon={Icon.Clock}
                />
                <List.Item.Detail.Metadata.Label
                  title="最后更新"
                  text={formatRelativeTime(note.updatedAt)}
                  icon={Icon.Calendar}
                />
                {note.tags.length > 0 && (
                  <List.Item.Detail.Metadata.TagList title="分类标签">
                    {note.tags.map(tag => (
                      <List.Item.Detail.Metadata.TagList.Item key={tag} text={tag} />
                    ))}
                  </List.Item.Detail.Metadata.TagList>
                )}
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          <ActionPanel title={`便签操作: ${note.title}`}>
            <Action
              title="查看独立详情"
              icon={Icon.Eye}
              onAction={() => push(<NoteDetailView note={note} />)}
            />
            <Action
              title="编辑此便签"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["ctrl"], key: "e" }}
              onAction={() =>
                push(
                  <NoteEditForm
                    note={note}
                    onSave={() => refreshNotes()}
                  />
                )
              }
            />
            <Action
              title="新建便签"
              icon={Icon.Plus}
              shortcut={{ modifiers: ["ctrl"], key: "n" }}
              onAction={() =>
                push(
                  <NoteCreateForm
                    onSave={() => refreshNotes()}
                  />
                )
              }
            />
            <Action.CopyToClipboard
              title="复制笔记正文"
              content={note.content}
              shortcut={{ modifiers: ["ctrl"], key: "c" }}
            />
            <Action.CopyToClipboard
              title="复制 Markdown 源码"
              content={exportNoteAsMarkdown(note)}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
            />
            <Action
              title={note.pinned ? "取消置顶" : "置顶便签"}
              icon={Icon.Pin}
              shortcut={{ modifiers: ["ctrl"], key: "p" }}
              onAction={() => handleTogglePin(note)}
            />
            <Action
              title="导出为 .md 本地文件"
              icon={Icon.Download}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "e" }}
              onAction={() => handleExportMarkdown(note)}
            />
            <Action
              title="删除此便签"
              icon={Icon.Trash}
              shortcut={{ modifiers: ["ctrl"], key: "x" }}
              onAction={() => handleDelete(note)}
            />
            <Action
              title="清空全部便签"
              icon={Icon.Trash}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
              onAction={handleClearAll}
            />
            <Action
              title={isShowingDetail ? "关闭双栏详情" : "展开双栏详情"}
              icon={Icon.SidebarRight}
              shortcut={{ modifiers: ["ctrl"], key: "b" }}
              onAction={() => setIsShowingDetail(!isShowingDetail)}
            />
          </ActionPanel>
        }
      />
    );
  };

  return (
    <List
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索便签笔记 (支持 Markdown 全文与标签实时检索)..."
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown tooltip="筛选视图" value={filterTab} onChange={(v) => setFilterTab(v as NotesFilterTab)}>
          <List.Dropdown.Item title="全部便签 (All Notes)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="仅显示已置顶 (Pinned Only)" value="pinned" icon={Icon.Pin} />
        </List.Dropdown>
      }
      actions={
        <ActionPanel>
          <Action
            title="新建便签"
            icon={Icon.Plus}
            shortcut={{ modifiers: ["ctrl"], key: "n" }}
            onAction={() =>
              push(
                <NoteCreateForm
                  onSave={() => refreshNotes()}
                />
              )
            }
          />
        </ActionPanel>
      }
    >
      {notes.length === 0 && (
        <List.Item
          id="notes-empty"
          title="还没有便签"
          subtitle="按回车新建第一条"
          icon={Icon.Plus}
          actions={
            <ActionPanel>
              <Action
                title="新建便签"
                icon={Icon.Plus}
                onAction={() => push(<NoteCreateForm onSave={() => refreshNotes()} />)}
              />
            </ActionPanel>
          }
        />
      )}

      {pinnedNotes.length > 0 && (
        <List.Section title={`📌 已置顶便签 (${pinnedNotes.length})`}>
          {pinnedNotes.map(renderNoteItem)}
        </List.Section>
      )}

      {notes.length > 0 && (
        <List.Section title={`📝 全部便签 (${regularNotes.length})`}>
          {regularNotes.map(renderNoteItem)}
        </List.Section>
      )}
    </List>
  );
}
