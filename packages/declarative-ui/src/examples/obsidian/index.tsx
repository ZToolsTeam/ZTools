import { isRealElectronHost } from '../shared/native-ipc.js';
import React from "../../index.js";
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
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import { ObsidianNote, ObsidianVaultInfo } from "./types.js";
import {
  DEFAULT_VAULTS,
  SAMPLE_OBSIDIAN_NOTES,
  sniffObsidianVaults,
  getVaultNotes,
  saveVaultNote,
  deleteVaultNote,
  appendToDailyNote,
  searchVaultNotes
} from "./vault.js";

export * from "./types.js";
export * from "./vault.js";

/**
 * 查看 Obsidian Markdown 笔记详情视图 (现代纯正 TSX 模式)
 */
export function ObsidianNoteDetailView({
  note,
  onDeleted
}: {
  note: ObsidianNote;
  onDeleted?: () => void;
}) {
  const { pop } = useNavigation();
  const filePath = note.folder ? `${note.folder}/${note.title}` : note.title;
  const obsidianUri = `obsidian://open?vault=${encodeURIComponent(note.vault)}&file=${encodeURIComponent(filePath)}`;

  const markdown = `
# ${note.title}

> **Vault**: \`${note.vault}\` | **目录**: \`${note.folder}\` | **字数**: \`${note.wordCount} 字\`

---

${note.content}
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={note.title}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="所属知识库" text={note.vault} icon={Icon.Folder} />
          <Detail.Metadata.Label title="目录路径" text={note.folder} icon={Icon.Pin} />
          <Detail.Metadata.Label title="字数统计" text={`${note.wordCount} 字`} icon={Icon.Document} />
          <Detail.Metadata.Label title="更新时间" text={note.updatedAt} icon={Icon.Clock} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="关联标签">
            {note.tags.map((t) => (
              <Detail.Metadata.TagList.Item key={t} text={`#${t}`} color={Color.Blue} />
            ))}
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="笔记操作">
          <Action.OpenInBrowser title="在 Obsidian 客户端打开" url={obsidianUri} icon={Icon.Globe} />
          <Action.CopyToClipboard title="复制 Markdown 正文" content={note.content} icon={Icon.CopyClipboard} />
          <Action.CopyToClipboard title="复制双向链引用语法" content={`[[${note.title}]]`} icon={Icon.Link} />
          <Action
            title="删除此笔记"
            icon={Icon.Trash}
            onAction={async () => {
              await deleteVaultNote(note.id);
              await showToast(Toast.Style.Success, "笔记已删除");
              onDeleted?.();
              pop();
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 追加至今日 Daily Note 表单视图
 */
export function ObsidianDailyNoteForm({
  onAppended
}: {
  onAppended?: (note: ObsidianNote) => void;
}) {
  const { pop } = useNavigation();
  const [vaults, setVaults] = useState<ObsidianVaultInfo[]>(DEFAULT_VAULTS);
  const [vault, setVault] = useState("Engineering");
  const [content, setContent] = useState("");

  useEffect(() => {
    sniffObsidianVaults().then((vs) => {
      setVaults(vs);
      if (vs.length > 0) setVault(vs[0].name);
    });
  }, []);

  const handleSubmit = async (values: { vault?: string; content?: string }) => {
    const targetVault = values.vault || vault;
    const text = values.content || content;
    if (!text || !text.trim()) {
      await showToast(Toast.Style.Failure, "日记内容不能为空");
      return;
    }

    const { note } = await appendToDailyNote({
      vault: targetVault,
      content: text,
      timestamp: true
    });

    await showToast(Toast.Style.Success, `已追加到今日 Daily Note [${targetVault}]`);
    onAppended?.(note);
    pop();
  };

  return (
    <Form
      navigationTitle="追加到今日日记 (Daily Note)"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="追加日记条目" onSubmit={handleSubmit} icon={Icon.Check} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="vault"
        title="目标知识库 (Vault)"
        value={vault}
        onChange={(v: string) => setVault(v)}
      >
        {vaults.map((v) => (
          <Form.Dropdown.Item key={v.name} title={`${v.name} (${v.path})`} value={v.name} />
        ))}
      </Form.Dropdown>
      <Form.TextArea
        id="content"
        title="日记内容"
        placeholder="记录灵感、今日待办或站会纪要..."
        value={content}
        onChange={(v: string) => setContent(v)}
      />
    </Form>
  );
}

/**
 * 追加 Obsidian 随手记表单视图 (现代纯正 TSX 模式)
 */
export function ObsidianQuickNoteForm({
  onCreated
}: {
  onCreated: (updatedList: ObsidianNote[]) => void;
}) {
  const { pop } = useNavigation();
  const [vaults, setVaults] = useState<ObsidianVaultInfo[]>(DEFAULT_VAULTS);
  const [title, setTitle] = useState("");
  const [vault, setVault] = useState("Engineering");
  const [folder, setFolder] = useState("Inbox");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  const [isDaily, setIsDaily] = useState(false);

  useEffect(() => {
    sniffObsidianVaults().then((vs) => {
      setVaults(vs);
      if (vs.length > 0) setVault(vs[0].name);
    });
  }, []);

  const handleSubmit = async (values: {
    title?: string;
    vault?: string;
    folder?: string;
    tags?: string;
    content?: string;
    isDaily?: boolean;
  }) => {
    const finalTitle = values.title || title;
    const finalVault = values.vault || vault;
    const finalFolder = values.folder || folder;
    const finalTags = (values.tags || tags)
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);
    const finalContent = values.content || content;

    if (!finalTitle.trim() && !isDaily) {
      await showToast(Toast.Style.Failure, "笔记标题不能为空");
      return;
    }

    if (isDaily) {
      const { allNotes } = await appendToDailyNote({
        vault: finalVault,
        content: finalContent || finalTitle,
        timestamp: true
      });
      await showToast(Toast.Style.Success, `已追加到今日 Daily Note [${finalVault}]`);
      onCreated(allNotes);
      pop();
      return;
    }

    const updated = await saveVaultNote({
      title: finalTitle.trim(),
      vault: finalVault,
      folder: finalFolder.trim() || "Inbox",
      tags: finalTags.length > 0 ? finalTags : ["quick-capture"],
      content: finalContent.trim()
    });

    await showToast(Toast.Style.Success, `随手记已保存至 [${finalVault}/${finalFolder}]`);
    onCreated(updated);
    pop();
  };

  return (
    <Form
      navigationTitle="新建随手记 / 知识沉淀"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存笔记" onSubmit={handleSubmit} icon={Icon.Check} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="vault"
        title="所属知识库 (Vault)"
        value={vault}
        onChange={(v: string) => setVault(v)}
      >
        {vaults.map((v) => (
          <Form.Dropdown.Item key={v.name} title={`${v.name} (${v.path})`} value={v.name} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="title"
        title="笔记标题"
        placeholder="例如: 声明式架构设计草案"
        value={title}
        onChange={(v: string) => setTitle(v)}
      />
      <Form.TextField
        id="folder"
        title="知识库目录 (Folder)"
        placeholder="Inbox"
        value={folder}
        onChange={(v: string) => setFolder(v)}
      />
      <Form.TextField
        id="tags"
        title="标签 (空格分隔)"
        placeholder="architecture design ztools"
        value={tags}
        onChange={(v: string) => setTags(v)}
      />
      <Form.TextArea
        id="content"
        title="Markdown 正文"
        placeholder="输入随想、代码片段或工作纪要..."
        value={content}
        onChange={(v: string) => setContent(v)}
      />
      <Form.Checkbox
        id="isDaily"
        label="直接作为今日 Daily Note (每日笔记) 记录"
        value={isDaily}
        onChange={(v: boolean) => setIsDaily(v)}
      />
    </Form>
  );
}

/**
 * Obsidian 知识库管理主命令 (现代纯正 TSX 模式)
 */
export default function ObsidianCommand() {
  const [notes, setNotes] = useState<ObsidianNote[]>(isRealElectronHost() ? [] : SAMPLE_OBSIDIAN_NOTES);
  const [vaults, setVaults] = useState<ObsidianVaultInfo[]>(DEFAULT_VAULTS);
  const [selectedVault, setSelectedVault] = useState<string>("all");
  const [searchText, setSearchText] = useState<string>("");
  const { push } = useNavigation();

  useEffect(() => {
    sniffObsidianVaults().then((vs) => setVaults(vs));
    getVaultNotes().then((list) => setNotes(list));
  }, []);

  const refreshNotes = async () => {
    const list = await getVaultNotes(selectedVault);
    setNotes(list);
    await showToast(Toast.Style.Success, "知识库笔记已同步刷新");
  };

  const filteredNotes = searchVaultNotes(notes, searchText, selectedVault);

  return (
    <List
      navigationTitle="Obsidian 笔记知识库"
      searchBarPlaceholder="全文搜索笔记标题、正文、标签、目录..."
      searchText={searchText}
      onSearchTextChange={(val) => setSearchText(val)}
      searchBarAccessory={
        <List.Dropdown
          tooltip="筛选知识库"
          value={selectedVault}
          onChange={(newVal) => setSelectedVault(newVal)}
        >
          <List.Dropdown.Item title="全部知识库 (All Vaults)" value="all" />
          {vaults.map((v) => (
            <List.Dropdown.Item key={v.name} title={`Vault: ${v.name}`} value={v.name} />
          ))}
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="全局操作">
          <Action.Push
            title="新建随手记 (Quick Capture)"
            icon={Icon.Plus}
            target={() => (
              <ObsidianQuickNoteForm
                onCreated={(updatedList) => {
                  setNotes(updatedList);
                }}
              />
            )}
          />
          <Action.Push
            title="追加到今日日记 (Daily Note)"
            icon={Icon.Calendar}
            target={() => (
              <ObsidianDailyNoteForm
                onAppended={(note) => {
                  setNotes((prev) => [note, ...prev.filter((n) => n.id !== note.id)]);
                }}
              />
            )}
          />
          <Action title="刷新知识库" icon={Icon.Repeat} onAction={refreshNotes} />
        </ActionPanel>
      }
    >
      <List.Section title={`笔记清单 (${filteredNotes.length})`}>
        {filteredNotes.map((note) => {
          const filePath = note.folder ? `${note.folder}/${note.title}` : note.title;
          const obsidianUri = `obsidian://open?vault=${encodeURIComponent(note.vault)}&file=${encodeURIComponent(filePath)}`;

          return (
            <List.Item
              key={note.id}
              id={note.id}
              title={note.title}
              subtitle={`${note.vault} / ${note.folder}`}
              icon={note.isDaily ? Icon.Calendar : Icon.Document}
              accessories={[
                { text: `${note.wordCount} 字` },
                { text: note.tags.slice(0, 2).map((t) => `#${t}`).join(" ") },
                { text: note.updatedAt }
              ]}
              actions={
                <ActionPanel title={note.title}>
                  <Action.Push
                    title="查看笔记详情"
                    icon={Icon.Eye}
                    target={() => (
                      <ObsidianNoteDetailView
                        note={note}
                        onDeleted={() => {
                          setNotes((prev) => prev.filter((n) => n.id !== note.id));
                        }}
                      />
                    )}
                  />
                  <Action.OpenInBrowser
                    title="在 Obsidian 中打开"
                    url={obsidianUri}
                    icon={Icon.Globe}
                  />
                  <Action.Push
                    title="追加到今日日记"
                    icon={Icon.Calendar}
                    target={() => (
                      <ObsidianDailyNoteForm
                        onAppended={(updatedDaily) => {
                          setNotes((prev) => [
                            updatedDaily,
                            ...prev.filter((n) => n.id !== updatedDaily.id)
                          ]);
                        }}
                      />
                    )}
                  />
                  <Action.CopyToClipboard
                    title="复制 Markdown 正文"
                    content={note.content}
                    icon={Icon.CopyClipboard}
                  />
                  <Action.CopyToClipboard
                    title="复制双链引用语法"
                    content={`[[${note.title}]]`}
                    icon={Icon.Link}
                  />
                  <Action
                    title="删除笔记"
                    icon={Icon.Trash}
                    onAction={async () => {
                      const updated = await deleteVaultNote(note.id);
                      setNotes(updated);
                      await showToast(Toast.Style.Success, "笔记已删除");
                    }}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
