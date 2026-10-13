import React from "../../index.js";
import {
  List,
  Form,
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
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import { Quicklink, QuicklinkInput } from "./types.js";
import {
  DEFAULT_QUICKLINKS,
  getQuicklinks,
  saveQuicklinks,
  resolveQuicklinkUrl,
  filterQuicklinks,
  exportQuicklinksJson,
  importQuicklinksJson
} from "./quicklinks-storage.js";

export * from "./types.js";
export * from "./quicklinks-storage.js";

/**
 * 新建快捷直达链接表单
 */
export function CreateQuicklinkForm({
  onCreated
}: {
  onCreated?: (item: Quicklink) => void;
}) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [keyword, setKeyword] = useState("");
  const [defaultArgument, setDefaultArgument] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = async () => {
    if (!title.trim()) {
      await showToast(Toast.Style.Failure, "请输入链接标题");
      return;
    }
    const trimmedLink = link.trim();
    if (!trimmedLink || !/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/|[a-zA-Z]:\\)/i.test(trimmedLink)) {
      await showToast(Toast.Style.Failure, "请输入合法的 URL 协议或系统路径");
      return;
    }

    const current = await getQuicklinks();
    const newId = `ql-${Date.now()}`;
    const newItem: Quicklink = {
      id: newId,
      title: title.trim(),
      link: trimmedLink,
      keyword: keyword.trim() || undefined,
      defaultArgument: defaultArgument.trim() || undefined,
      description: description.trim() || undefined,
      icon: "globe",
      openCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const updated = [newItem, ...current];
    await saveQuicklinks(updated);
    await showToast(Toast.Style.Success, "快捷链接创建成功", newItem.title);
    onCreated?.(newItem);
    pop();
  };

  return (
    <Form
      navigationTitle="新建快捷直达链接"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存快捷链接" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="链接名称"
        placeholder="例如: Google 搜索, GitHub 仓库"
        value={title}
        onChange={setTitle}
      />
      <Form.TextField
        id="link"
        title="目标 URL 地址"
        placeholder="支持 {argument} 或 {query} 变量，如: https://google.com/search?q={argument}"
        value={link}
        onChange={setLink}
      />
      <Form.TextField
        id="keyword"
        title="触发关键词 / 别名 (可选)"
        placeholder="例如: g (在主界面键入 'g 关键词' 即可秒开)"
        value={keyword}
        onChange={setKeyword}
      />
      <Form.TextField
        id="defaultArgument"
        title="默认参数值 (可选)"
        placeholder="当未输入查询词时使用的预设参数"
        value={defaultArgument}
        onChange={setDefaultArgument}
      />
      <Form.TextArea
        id="description"
        title="简要说明"
        placeholder="说明该链接的使用场景或备注"
        value={description}
        onChange={setDescription}
      />
    </Form>
  );
}

/**
 * 编辑快捷直达链接表单
 */
export function EditQuicklinkForm({
  quicklink,
  onUpdated
}: {
  quicklink: Quicklink;
  onUpdated?: (item: Quicklink) => void;
}) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState(quicklink.title);
  const [link, setLink] = useState(quicklink.link);
  const [keyword, setKeyword] = useState(quicklink.keyword || "");
  const [defaultArgument, setDefaultArgument] = useState(quicklink.defaultArgument || "");
  const [description, setDescription] = useState(quicklink.description || "");

  const handleSubmit = async () => {
    if (!title.trim()) {
      await showToast(Toast.Style.Failure, "请输入链接标题");
      return;
    }
    const trimmedLink = link.trim();
    if (!trimmedLink || !/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/|[a-zA-Z]:\\)/i.test(trimmedLink)) {
      await showToast(Toast.Style.Failure, "请输入合法的 URL 协议或系统路径");
      return;
    }

    const current = await getQuicklinks();
    const updatedItem: Quicklink = {
      ...quicklink,
      title: title.trim(),
      link: trimmedLink,
      keyword: keyword.trim() || undefined,
      defaultArgument: defaultArgument.trim() || undefined,
      description: description.trim() || undefined,
      updatedAt: Date.now()
    };

    const updated = current.map(item => (item.id === quicklink.id ? updatedItem : item));
    await saveQuicklinks(updated);
    await showToast(Toast.Style.Success, "快捷链接已更新", updatedItem.title);
    onUpdated?.(updatedItem);
    pop();
  };

  return (
    <Form
      navigationTitle={`编辑: ${quicklink.title}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存修改" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="链接名称"
        value={title}
        onChange={setTitle}
      />
      <Form.TextField
        id="link"
        title="目标 URL 地址"
        value={link}
        onChange={setLink}
      />
      <Form.TextField
        id="keyword"
        title="触发关键词 / 别名"
        value={keyword}
        onChange={setKeyword}
      />
      <Form.TextField
        id="defaultArgument"
        title="默认参数值"
        value={defaultArgument}
        onChange={setDefaultArgument}
      />
      <Form.TextArea
        id="description"
        title="简要说明"
        value={description}
        onChange={setDescription}
      />
    </Form>
  );
}

/**
 * 导入 Quicklinks 表单
 */
export function ImportQuicklinksForm({
  onImported
}: {
  onImported?: (count: number) => void;
}) {
  const { pop } = useNavigation();
  const [jsonText, setJsonText] = useState("");

  const handleImport = async () => {
    if (!jsonText.trim()) {
      await showToast(Toast.Style.Failure, "请粘贴包含 Quicklinks 的 JSON 数据");
      return;
    }

    const current = await getQuicklinks();
    const result = importQuicklinksJson(jsonText, current);
    if (!result.success) {
      await showToast(Toast.Style.Failure, "导入失败", result.error);
      return;
    }

    await saveQuicklinks(result.result);
    await showToast(Toast.Style.Success, `成功导入 ${result.importedCount} 个快捷链接`);
    onImported?.(result.importedCount);
    pop();
  };

  return (
    <Form
      navigationTitle="导入 Quicklinks JSON"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="确认导入" onSubmit={handleImport} />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="json"
        title="JSON 数据"
        placeholder="在此粘贴导出的 Quicklinks JSON 文本..."
        value={jsonText}
        onChange={setJsonText}
      />
    </Form>
  );
}

/**
 * 快捷直达链接主命令
 */
export default function QuicklinksCommand() {
  const [quicklinks, setQuicklinks] = useState<Quicklink[]>(DEFAULT_QUICKLINKS);
  const [searchText, setSearchText] = useState("");
  const [isShowingDetail, setIsShowingDetail] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getQuicklinks().then(data => {
      setQuicklinks(data);
      setIsLoading(false);
    });
  }, []);

  const { matches, directMatch } = useMemo(() => {
    return filterQuicklinks(quicklinks, searchText);
  }, [quicklinks, searchText]);

  const handleOpenLink = async (ql: Quicklink, queryArg?: string) => {
    const { url } = resolveQuicklinkUrl(ql.link, queryArg, ql.defaultArgument);
    if (!url) return;

    // 检查宿主 openExternal IPC
    if (typeof (globalThis as any).window?.ztools?.openExternal === "function") {
      try {
        await (globalThis as any).window.ztools.openExternal(url);
      } catch (err: any) {
        console.warn("openExternal failed:", err);
      }
    } else if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank");
    }

    // 更新打开计数
    const updated = quicklinks.map(item =>
      item.id === ql.id ? { ...item, openCount: (item.openCount || 0) + 1, updatedAt: Date.now() } : item
    );
    setQuicklinks(updated);
    await saveQuicklinks(updated);

    await showToast(Toast.Style.Success, `已在浏览器打开: ${ql.title}`, url);
  };

  const handleDelete = async (id: string) => {
    const updated = quicklinks.filter(ql => ql.id !== id);
    setQuicklinks(updated);
    await saveQuicklinks(updated);
    await showToast(Toast.Style.Success, "快捷链接已删除");
  };

  const handleDuplicate = async (ql: Quicklink) => {
    const dup: Quicklink = {
      ...ql,
      id: `ql-${Date.now()}`,
      title: `${ql.title} (副本)`,
      openCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const updated = [dup, ...quicklinks];
    setQuicklinks(updated);
    await saveQuicklinks(updated);
    await showToast(Toast.Style.Success, "已复制快捷链接", dup.title);
  };

  const handleExport = async () => {
    const json = exportQuicklinksJson(quicklinks);
    await Clipboard.copy(json);
    await showToast(Toast.Style.Success, `已导出 ${quicklinks.length} 个快捷链接到剪贴板`);
  };

  const handleCopy = async (text: string, label: string) => {
    await Clipboard.copy(text);
    await showToast(Toast.Style.Success, `已复制 ${label}`);
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索快捷链接，或用别名检索 (如: g deepseek, gh react, bili)..."
      searchText={searchText}
      onSearchTextChange={setSearchText}
    >
      {/* 1. 别名关键词精准匹配直达区 */}
      {directMatch && (
        <List.Section title="快捷别名即时直达">
          <List.Item
            id="direct-match"
            title={`直达: ${directMatch.quicklink.title}`}
            subtitle={`检索词: "${directMatch.queryArg}" | 目标: ${resolveQuicklinkUrl(directMatch.quicklink.link, directMatch.queryArg).url}`}
            icon={Icon.Globe}
            accessories={[{ text: "ENTER 立即直达", icon: Icon.ArrowRight }]}
            actions={
              <ActionPanel title="直达动作">
                <Action
                  title="立即在浏览器打开直达链接"
                  icon={Icon.Globe}
                  onAction={() => handleOpenLink(directMatch.quicklink, directMatch.queryArg)}
                />
                <Action
                  title="复制直达完整 URL"
                  icon={Icon.CopyClipboard}
                  onAction={() =>
                    handleCopy(
                      resolveQuicklinkUrl(directMatch.quicklink.link, directMatch.queryArg).url,
                      "完整 URL"
                    )
                  }
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {/* 2. 快捷链接完整列表 */}
      <List.Section title={`快捷直达清单 (${matches.length})`}>
        {matches.map(item => {
          const hasMacro = /\{(query|argument|arg)/i.test(item.link);
          return (
            <List.Item
              key={item.id}
              id={item.id}
              title={item.title}
              subtitle={item.link}
              icon={Icon.Globe}
              accessories={[
                ...(item.keyword ? [{ text: `别名: ${item.keyword}`, icon: Icon.Key }] : []),
                { text: `打开 ${item.openCount || 0} 次` }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### ${item.title}\n\n**目标链接**: \`${item.link}\`\n\n${item.description ? item.description + '\n\n' : ''}> **参数宏解析**: ${hasMacro ? '✅ 支持动态参数占位符 (`{argument}` / `{query}`)' : '❌ 固定静态链接'}${item.defaultArgument ? `\n> **预设默认参数**: \`${item.defaultArgument}\`` : ''}`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="名称" text={item.title} icon={Icon.Document} />
                      {item.keyword && (
                        <List.Item.Detail.Metadata.Label title="别名 / 触发词" text={item.keyword} icon={Icon.Key} />
                      )}
                      {item.defaultArgument && (
                        <List.Item.Detail.Metadata.Label title="默认参数" text={item.defaultArgument} icon={Icon.Pencil} />
                      )}
                      <List.Item.Detail.Metadata.Label title="累计打开" text={`${item.openCount || 0} 次`} icon={Icon.Eye} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="完整链接" text={item.link} icon={Icon.Link} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={`${item.title}`}>
                  <Action
                    title="在浏览器中打开 (Open)"
                    icon={Icon.Globe}
                    onAction={() => handleOpenLink(item)}
                  />
                  <Action
                    title="复制目标链接"
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                    onAction={() => handleCopy(item.link, "目标链接")}
                  />
                  {item.keyword && (
                    <Action
                      title="复制别名触发词"
                      icon={Icon.Key}
                      shortcut={{ modifiers: ["ctrl"], key: "k" }}
                      onAction={() => handleCopy(item.keyword!, "别名触发词")}
                    />
                  )}
                  <Action.Push
                    title="编辑快捷链接"
                    icon={Icon.Pencil}
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    target={
                      <EditQuicklinkForm
                        quicklink={item}
                        onUpdated={updatedItem => {
                          setQuicklinks(quicklinks.map(q => (q.id === updatedItem.id ? updatedItem : q)));
                        }}
                      />
                    }
                  />
                  <Action
                    title="复制生成副本 (Duplicate)"
                    icon={Icon.Document}
                    shortcut={{ modifiers: ["ctrl"], key: "d" }}
                    onAction={() => handleDuplicate(item)}
                  />
                  <Action.Push
                    title="新建快捷链接"
                    icon={Icon.Plus}
                    shortcut={{ modifiers: ["ctrl"], key: "n" }}
                    target={
                      <CreateQuicklinkForm
                        onCreated={newItem => setQuicklinks([newItem, ...quicklinks])}
                      />
                    }
                  />
                  <Action
                    title="导出全部链接到剪贴板 (Export)"
                    icon={Icon.Upload}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "e" }}
                    onAction={handleExport}
                  />
                  <Action.Push
                    title="导入 Quicklinks JSON (Import)"
                    icon={Icon.Download}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "i" }}
                    target={
                      <ImportQuicklinksForm
                        onImported={async () => {
                          const refreshed = await getQuicklinks();
                          setQuicklinks(refreshed);
                        }}
                      />
                    }
                  />
                  <Action
                    title={isShowingDetail ? "关闭详情侧栏" : "展开详情侧栏"}
                    icon={Icon.SidebarRight}
                    shortcut={{ modifiers: ["ctrl"], key: "b" }}
                    onAction={() => setIsShowingDetail(!isShowingDetail)}
                  />
                  <Action
                    title="删除该快捷链接"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => handleDelete(item.id)}
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
