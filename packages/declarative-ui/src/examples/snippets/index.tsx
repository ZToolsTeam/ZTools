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
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  Snippet
} from "./types.js";
import {
  SAMPLE_SNIPPETS,
  getSnippets,
  saveSnippets,
  filterSnippets,
  parseSnippetArguments,
  hasSnippetArguments,
  expandSnippetTemplate,
  createSnippetService,
  updateSnippetService,
  deleteSnippetService,
  toggleSnippetService,
  exportSnippetsJSON,
  importSnippetsJSON
} from "./snippets-storage.js";

export * from "./types.js";
export * from "./snippets-storage.js";

/**
 * 短语动态参数填写表单 (SnippetArgumentFormView)
 * 支持 text / password / dropdown 动态参数表单填写、实时 Preview 预览拼接与粘贴回填
 */
export function SnippetArgumentFormView({
  snippet = SAMPLE_SNIPPETS[5] || SAMPLE_SNIPPETS[0],
  initialArgs = {},
  clipboardContent = "",
  onExpanded
}: {
  snippet?: Snippet;
  initialArgs?: Record<string, string>;
  clipboardContent?: string;
  onExpanded?: (result: { expanded: string; cursorOffset: number; args: Record<string, string> }) => void;
} = {}) {
  const { pop } = useNavigation();
  const descriptors = parseSnippetArguments(snippet.snippet);

  const defaultValues: Record<string, string> = {};
  for (const d of descriptors) {
    defaultValues[d.name] = initialArgs[d.name] ?? d.defaultValue ?? "";
  }

  const [formValues, setFormValues] = useState<Record<string, string>>(defaultValues);

  const liveExpansion = expandSnippetTemplate(snippet.snippet, clipboardContent, {
    args: formValues,
    previewPlaceholders: true
  });

  const handleSubmit = async (submittedValues: Record<string, any> = {}) => {
    const mergedArgs: Record<string, string> = { ...formValues };
    for (const d of descriptors) {
      const val = submittedValues[d.name] ?? formValues[d.name] ?? d.defaultValue ?? "";
      mergedArgs[d.name] = String(val);
    }

    const missing = descriptors.find((d) => d.required && !mergedArgs[d.name]?.trim());
    if (missing) {
      await showToast(Toast.Style.Failure, "参数未填写", `请填写必填参数: "${missing.name}"`);
      return;
    }

    const finalExpansion = expandSnippetTemplate(snippet.snippet, clipboardContent, {
      args: mergedArgs,
      previewPlaceholders: false
    });

    await Clipboard.paste(finalExpansion.expanded);
    onExpanded?.({
      expanded: finalExpansion.expanded,
      cursorOffset: finalExpansion.cursorOffset,
      args: mergedArgs
    });
    await showToast(Toast.Style.Success, "已展开并粘贴短语", snippet.name);
    pop();
  };

  return (
    <Form
      navigationTitle={`填写短语参数: ${snippet.name}`}
      actions={
        <ActionPanel title={snippet.name}>
          <Action.SubmitForm
            title="展开并粘贴到活动窗口 (Paste Snippet)"
            icon={Icon.Checkmark}
            onSubmit={handleSubmit}
          />
          <Action.CopyToClipboard
            title="复制当前预览结果 (Copy Preview)"
            content={liveExpansion.expanded}
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["ctrl"], key: "c" }}
          />
        </ActionPanel>
      }
    >
      {descriptors.map((desc) => {
        if (desc.type === "dropdown" && desc.options.length > 0) {
          return (
            <Form.Dropdown
              key={desc.name}
              id={desc.name}
              title={desc.name}
              defaultValue={formValues[desc.name] || desc.options[0]}
              onChange={(val: string) =>
                setFormValues((prev) => ({ ...prev, [desc.name]: val }))
              }
            >
              {desc.options.map((opt) => (
                <Form.Dropdown.Item key={opt} title={opt} value={opt} />
              ))}
            </Form.Dropdown>
          );
        }

        if (desc.type === "password") {
          return (
            <Form.PasswordField
              key={desc.name}
              id={desc.name}
              title={desc.name}
              placeholder={`请输入 ${desc.name}...`}
              defaultValue={formValues[desc.name] || ""}
              onChange={(val: string) =>
                setFormValues((prev) => ({ ...prev, [desc.name]: val }))
              }
            />
          );
        }

        return (
          <Form.TextField
            key={desc.name}
            id={desc.name}
            title={desc.name}
            placeholder={desc.defaultValue ? `默认: ${desc.defaultValue}` : `请输入 ${desc.name}...`}
            defaultValue={formValues[desc.name] || ""}
            onChange={(val: string) =>
              setFormValues((prev) => ({ ...prev, [desc.name]: val }))
            }
          />
        );
      })}

      <Form.Separator />
      <Form.Description
        title="实时预览 (Preview)"
        text={liveExpansion.expanded}
      />
    </Form>
  );
}

/**
 * 批量导入 Snippets 表单视图
 */
export function ImportSnippetsForm({
  onImportCompleted
}: {
  onImportCompleted?: () => void;
} = {}) {
  const { pop } = useNavigation();

  const handleImportSubmit = async (values: { jsonContent?: string }) => {
    if (!values.jsonContent || !values.jsonContent.trim()) {
      await showToast(Toast.Style.Failure, "导入失败", "请输入合法的 JSON 数据");
      return;
    }

    const current = await getSnippets();
    const result = await importSnippetsJSON(values.jsonContent, current);

    if (result.failed > 0 && result.imported === 0 && result.updated === 0) {
      await showToast(Toast.Style.Failure, "导入失败", result.errors?.[0] || "格式不符合规范");
      return;
    }

    await showToast(
      Toast.Style.Success,
      "Snippets 导入完成",
      `成功新增 ${result.imported} 个，更新 ${result.updated} 个，失败 ${result.failed} 个`
    );
    onImportCompleted?.();
    pop();
  };

  return (
    <Form
      navigationTitle="批量导入 Snippets (JSON)"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="确认导入"
            icon={Icon.Checkmark}
            onSubmit={handleImportSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="jsonContent"
        title="Snippets JSON 数据"
        placeholder='[&#10;  {&#10;    "name": "常用邮箱",&#10;    "keyword": ":mail",&#10;    "snippet": "user@example.com"&#10;  }&#10;]'
      />
    </Form>
  );
}

/**
 * 创建或编辑 Snippet 表单视图
 */
export function CreateSnippetForm({
  initialSnippet,
  onSaved
}: {
  initialSnippet?: Snippet;
  onSaved?: (snippet: Snippet) => void;
} = {}) {
  const { pop } = useNavigation();

  const handleSubmit = async (values: {
    name?: string;
    keyword?: string;
    snippet?: string;
    enabled?: boolean;
  }) => {
    if (!values.name || !values.keyword || !values.snippet) {
      await showToast(Toast.Style.Failure, "表单错误", "名称、触发词和展开文本不能为空");
      return;
    }

    const newSnippet: Snippet = {
      id: initialSnippet ? initialSnippet.id : `snip-${Date.now()}`,
      name: values.name.trim(),
      keyword: values.keyword.trim(),
      snippet: values.snippet,
      enabled: values.enabled !== false,
      category: initialSnippet?.category || "General",
      isPinned: Boolean(initialSnippet?.isPinned),
      createdAt: initialSnippet?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    };

    if (initialSnippet) {
      await updateSnippetService(newSnippet.id, newSnippet);
    } else {
      await createSnippetService(newSnippet);
    }

    onSaved?.(newSnippet);
    await showToast(
      Toast.Style.Success,
      initialSnippet ? "Snippet 已更新" : "Snippet 已创建",
      `触发词: ${newSnippet.keyword}`
    );
    pop();
  };

  return (
    <Form
      navigationTitle={initialSnippet ? `编辑: ${initialSnippet.name}` : "新建 Snippet 快捷指令"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={initialSnippet ? "保存修改" : "创建 Snippet"}
            icon={Icon.Checkmark}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Snippet 名称"
        placeholder="例如: 工作邮箱、常用签名、控制台日志..."
        defaultValue={initialSnippet?.name ?? ""}
      />
      <Form.TextField
        id="keyword"
        title="触发关键词 (Keyword)"
        placeholder="例如: :email, :sign, !date..."
        defaultValue={initialSnippet?.keyword ?? ""}
      />
      <Form.TextArea
        id="snippet"
        title="扩展文本内容 (Snippet)"
        placeholder="支持动态变量: {clipboard} (当前剪贴板), {date} (当前日期), {time} (当前时间), {datetime}, {uuid}, {cursor} (光标落点)..."
        defaultValue={initialSnippet?.snippet ?? ""}
      />
      <Form.Checkbox
        id="enabled"
        label="启用文本自动扩展 (Active Hook)"
        defaultValue={initialSnippet?.enabled ?? true}
      />
    </Form>
  );
}

/**
 * Snippet 详情与展开测试视图
 */
export function SnippetDetailView({
  snippet = SAMPLE_SNIPPETS[0],
  onDeleted,
  onToggled
}: {
  snippet?: Snippet;
  onDeleted?: (id: string) => void;
  onToggled?: (id: string) => void;
} = {}) {
  const { pop } = useNavigation();
  const testExpansion = expandSnippetTemplate(snippet.snippet, "Sample Clipboard Text");

  const markdown = `
# Snippet: ${snippet.name}

> **触发词**: \`${snippet.keyword}\` | **状态**: \`${snippet.enabled ? "ACTIVE (已激活)" : "DISABLED (已停用)"}\` ${snippet.category ? `| **分类**: \`${snippet.category}\`` : ""}

---

### 原始模板内容
\`\`\`text
${snippet.snippet}
\`\`\`

---

### 模拟动态扩展结果
\`\`\`text
${testExpansion.expanded}
\`\`\`
> **光标回退位移**: 距末尾 \`${testExpansion.cursorOffset}\` 个字符 ${testExpansion.hasCursor ? "(已包含光标锚点)" : ""}
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`Snippet: ${snippet.name}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="名称" text={snippet.name} icon={Icon.Pencil} />
          <Detail.Metadata.Label title="触发词" text={snippet.keyword} icon={Icon.Key} />
          {snippet.category ? (
            <Detail.Metadata.Label title="分类" text={snippet.category} icon={Icon.Folder} />
          ) : null}
          <Detail.Metadata.Label title="置顶" text={snippet.isPinned ? "已置顶" : "常规"} icon={Icon.Pin} />
          <Detail.Metadata.Label title="状态" text={snippet.enabled ? "启用中" : "已停用"} icon={Icon.Checkmark} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="生效策略">
            <Detail.Metadata.TagList.Item
              text={snippet.enabled ? "ENABLED" : "PAUSED"}
              color={snippet.enabled ? Color.Green : Color.SecondaryText}
            />
            {snippet.isPinned ? (
              <Detail.Metadata.TagList.Item text="PINNED" color={Color.Yellow} />
            ) : null}
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="Snippet 动作">
          <Action.Paste
            title="回车粘贴展开内容 (Paste to Active)"
            content={testExpansion.expanded}
            icon={Icon.Checkmark}
          />
          <Action.CopyToClipboard
            title="复制展开后文本"
            content={testExpansion.expanded}
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["ctrl"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="复制原始模板"
            content={snippet.snippet}
            icon={Icon.Document}
            shortcut={{ modifiers: ["ctrl", "alt"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="复制触发词"
            content={snippet.keyword}
            icon={Icon.Key}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
          />
          <Action
            title={snippet.enabled ? "停用该 Snippet" : "启用该 Snippet"}
            icon={Icon.Power}
            shortcut={{ modifiers: ["ctrl"], key: "t" }}
            onAction={async () => {
              await toggleSnippetService(snippet.id);
              onToggled?.(snippet.id);
              showToast(Toast.Style.Success, snippet.enabled ? "已停用" : "已启用");
            }}
          />
          <Action
            title="删除该 Snippet"
            icon={Icon.Trash}
            shortcut={{ modifiers: ["ctrl"], key: "x" }}
            onAction={async () => {
              await deleteSnippetService(snippet.id);
              onDeleted?.(snippet.id);
              showToast(Toast.Style.Success, "Snippet 已删除");
              pop();
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 官方内置核心能力: Snippets 文本扩展管理
 * 极客键盘钩子调度、动态宏展开与完整 ActionPanel
 */
export default function SnippetsCommand() {
  const { push } = useNavigation();
  const [snippets, setSnippets] = useState<Snippet[]>(SAMPLE_SNIPPETS);
  const [searchText, setSearchText] = useState<string>("");
  const [filterEnabled, setFilterEnabled] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [expandCount, setExpandCount] = useState<number>(0);
  const [isShowingDetail, setIsShowingDetail] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      const data = await getSnippets();
      setSnippets(data);
      setIsLoading(false);
    })();
  }, []);

  const filteredSnippets = filterSnippets(snippets, {
    query: searchText,
    enabledOnly: filterEnabled === "enabled"
  });

  const activeSnippet =
    filteredSnippets.find((s) => s.id === selectedId) || filteredSnippets[0] || null;
  const enabledCount = snippets.filter((s) => s.enabled).length;

  const handleSaveSnippet = async (item: Snippet) => {
    const exists = snippets.some(s => s.id === item.id);
    const updated = exists
      ? snippets.map(s => (s.id === item.id ? item : s))
      : [item, ...snippets];
    setSnippets(updated);
    await saveSnippets(updated);
  };

  const handleDeleteSnippet = async (id: string) => {
    await deleteSnippetService(id);
    const updated = snippets.filter(s => s.id !== id);
    setSnippets(updated);
    await saveSnippets(updated);
    await showToast(Toast.Style.Success, "Snippet 已删除");
  };

  const handleToggleSnippet = async (id: string) => {
    await toggleSnippetService(id);
    const updated = snippets.map(s =>
      s.id === id ? { ...s, enabled: !s.enabled, updatedAt: Date.now() } : s
    );
    setSnippets(updated);
    await saveSnippets(updated);
  };

  const handleTogglePinSnippet = async (id: string) => {
    const updated = snippets.map(s =>
      s.id === id ? { ...s, isPinned: !s.isPinned, updatedAt: Date.now() } : s
    );
    setSnippets(updated);
    await saveSnippets(updated);
    const target = updated.find(s => s.id === id);
    await showToast(Toast.Style.Success, target?.isPinned ? "已置顶短语" : "已取消置顶");
  };

  const handleExportAll = async () => {
    const jsonStr = await exportSnippetsJSON(snippets);
    await Clipboard.copy(jsonStr);
    await showToast(Toast.Style.Success, "已导出 Snippets 到剪贴板", `共 ${snippets.length} 条短语`);
  };

  const handleExpandAndPasteSelected = async () => {
    if (!activeSnippet) {
      await showToast(Toast.Style.Failure, "请先选择或新建一条快捷短语");
      return;
    }
    if (hasSnippetArguments(activeSnippet.snippet)) {
      push(
        <SnippetArgumentFormView
          snippet={activeSnippet}
          onExpanded={() => setExpandCount((c) => c + 1)}
        />
      );
      return;
    }
    const exp = expandSnippetTemplate(activeSnippet.snippet);
    await Clipboard.paste(exp.expanded);
    setExpandCount((c) => c + 1);
    await showToast(Toast.Style.Success, `已展开并粘贴: ${activeSnippet.name}`, exp.expanded);
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索 Snippets (名称、触发词或内容)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedId(id || "")}
      filterBar={{
        summaryText: `快捷短语共 ${snippets.length} 个 · 已启用 ${enabledCount} 个 · 本次累计展开 ${expandCount} 次`,
        actions: [
          {
            id: "snip-act-create",
            label: "新建快捷短语",
            title: "新建快捷短语",
            style: "primary",
            onAction: () => {
              push(<CreateSnippetForm onSaved={handleSaveSnippet} />);
            }
          },
          {
            id: "snip-act-import",
            label: "批量导入 JSON",
            title: "批量导入 JSON",
            style: "secondary",
            onAction: () => {
              push(
                <ImportSnippetsForm
                  onImportCompleted={async () => {
                    const updated = await getSnippets();
                    setSnippets(updated);
                  }}
                />
              );
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按状态筛选"
          value={filterEnabled}
          onChange={setFilterEnabled}
        >
          <List.Dropdown.Item title="全部 Snippets (All)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="仅启用的 (Enabled Only)" value="enabled" icon={Icon.Checkmark} />
        </List.Dropdown>
      }
    >
      <List.Section title={`文本扩展指令 (${filteredSnippets.length} 个)`}>
        {filteredSnippets.map(item => {
          const expansion = expandSnippetTemplate(item.snippet);
          const detailMarkdown = `
# Snippet: ${item.name}

> **触发词**: \`${item.keyword}\` | **状态**: \`${item.enabled ? "ACTIVE (已激活)" : "DISABLED (已停用)"}\` ${item.category ? `| **分类**: \`${item.category}\`` : ""}

---

### 原始模板内容
\`\`\`text
${item.snippet}
\`\`\`

---

### 模拟动态扩展结果
\`\`\`text
${expansion.expanded}
\`\`\`
> **光标回退位移**: 距末尾 \`${expansion.cursorOffset}\` 个字符 ${expansion.hasCursor ? "(包含光标落点)" : ""}
          `;

          return (
            <List.Item
              key={item.id}
              id={item.id}
              title={item.name}
              subtitle={item.keyword}
              icon={item.enabled ? Icon.Pencil : Icon.Circle}
              accessories={[
                ...(item.isPinned ? [{ icon: Icon.Pin, tooltip: "已置顶" }] : []),
                ...(item.category ? [{ text: item.category }] : []),
                { text: expansion.expanded.slice(0, 24) + (expansion.expanded.length > 24 ? "..." : "") },
                ...(item.enabled
                  ? [{ icon: Icon.Checkmark, tooltip: "已激活" }]
                  : [{ icon: Icon.XmarkCircle, tooltip: "已停用" }])
              ]}
              detail={
                <List.Item.Detail
                  markdown={detailMarkdown}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="名称" text={item.name} icon={Icon.Pencil} />
                      <List.Item.Detail.Metadata.Label title="触发关键词" text={item.keyword} icon={Icon.Key} />
                      {item.category ? (
                        <List.Item.Detail.Metadata.Label title="分类" text={item.category} icon={Icon.Folder} />
                      ) : null}
                      <List.Item.Detail.Metadata.Label title="状态" text={item.enabled ? "已启用" : "已停用"} icon={Icon.Checkmark} />
                      <List.Item.Detail.Metadata.Label title="置顶" text={item.isPinned ? "已置顶" : "普通"} icon={Icon.Pin} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="生效状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={item.enabled ? "ENABLED" : "PAUSED"}
                          color={item.enabled ? Color.Green : Color.SecondaryText}
                        />
                        {item.isPinned ? (
                          <List.Item.Detail.Metadata.TagList.Item text="PINNED" color={Color.Yellow} />
                        ) : null}
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title="Snippet 动作">
                  {/* Action 1: 若含 {argument} 动态参数则进入参数填空表单，否则直接粘贴 */}
                  {hasSnippetArguments(item.snippet) ? (
                    <Action.Push
                      title="填写动态参数并粘贴 (Fill Arguments)"
                      icon={Icon.Pencil}
                      target={<SnippetArgumentFormView snippet={item} />}
                    />
                  ) : (
                    <Action.Paste
                      title="回车粘贴展开内容 (Paste to Active)"
                      content={expansion.expanded}
                      icon={Icon.Checkmark}
                    />
                  )}

                  {/* Action 2: 复制展开文本 */}
                  <Action.CopyToClipboard
                    title="仅复制展开文本"
                    content={expansion.expanded}
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  />

                  {/* Action 3: 复制触发关键词 */}
                  <Action.CopyToClipboard
                    title="复制触发关键词"
                    content={item.keyword}
                    icon={Icon.Key}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
                  />

                  {/* Action 4: 复制原始模板 */}
                  <Action.CopyToClipboard
                    title="复制原始模板内容"
                    content={item.snippet}
                    icon={Icon.Document}
                    shortcut={{ modifiers: ["ctrl", "alt"], key: "c" }}
                  />

                  {/* Action 5: 展开/关闭右侧双栏详情 */}
                  <Action
                    title={isShowingDetail ? "关闭右侧详情分栏" : "展开右侧详情分栏"}
                    icon={Icon.SidebarRight}
                    shortcut={{ modifiers: ["ctrl"], key: "b" }}
                    onAction={() => setIsShowingDetail(!isShowingDetail)}
                  />

                  {/* Action 6: 编辑 Snippet */}
                  <Action.Push
                    title="编辑 Snippet"
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    target={
                      <CreateSnippetForm
                        initialSnippet={item}
                        onSaved={handleSaveSnippet}
                      />
                    }
                    icon={Icon.Pencil}
                  />

                  {/* Action 7: 新建 Snippet */}
                  <Action.Push
                    title="新建 Snippet..."
                    shortcut={{ modifiers: ["ctrl"], key: "n" }}
                    target={<CreateSnippetForm onSaved={handleSaveSnippet} />}
                    icon={Icon.Plus}
                  />

                  {/* Action 8: 置顶/取消置顶 */}
                  <Action
                    title={item.isPinned ? "取消置顶" : "置顶短语"}
                    icon={Icon.Pin}
                    shortcut={{ modifiers: ["ctrl"], key: "p" }}
                    onAction={() => handleTogglePinSnippet(item.id)}
                  />

                  {/* Action 9: 全屏查看详情与测试 */}
                  <Action.Push
                    title="全屏查看详情与测试"
                    target={
                      <SnippetDetailView
                        snippet={item}
                        onDeleted={handleDeleteSnippet}
                        onToggled={handleToggleSnippet}
                      />
                    }
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl"], key: "d" }}
                  />

                  {/* Action 10: 启用/停用 */}
                  <Action
                    title={item.enabled ? "停用该指令" : "启用该指令"}
                    icon={Icon.Power}
                    shortcut={{ modifiers: ["ctrl"], key: "t" }}
                    onAction={() => handleToggleSnippet(item.id)}
                  />

                  {/* Action 11: 导出全部 Snippets 为 JSON */}
                  <Action
                    title="导出全部 Snippets (JSON 到剪贴板)"
                    icon={Icon.Download}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "e" }}
                    onAction={handleExportAll}
                  />

                  {/* Action 12: 导入 Snippets */}
                  <Action.Push
                    title="批量导入 Snippets (JSON)..."
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "i" }}
                    target={<ImportSnippetsForm onImportCompleted={async () => {
                      const updated = await getSnippets();
                      setSnippets(updated);
                    }} />}
                    icon={Icon.Upload}
                  />

                  {/* Action 13: 删除 */}
                  <Action
                    title="删除 Snippet"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => handleDeleteSnippet(item.id)}
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
