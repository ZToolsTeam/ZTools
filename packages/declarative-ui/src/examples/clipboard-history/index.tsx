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
  isRealElectronHost,
  showRealItemInFolder,
  writeRealClipboardText
} from "../shared/native-ipc.js";
import {
  ClipboardItem,
  ClipboardContentType,
  ClipboardPreferences
} from "./types.js";
import {
  SAMPLE_CLIPBOARD_ITEMS,
  getClipboardHistory,
  saveClipboardHistory,
  syncCurrentSystemClipboard,
  detectClipboardContentType,
  filterClipboardItems,
  formatCopiedTime,
  parseColorDetails,
  maskSensitiveContent,
  toggleClipboardItemPin,
  deleteClipboardItem,
  clearUnpinnedClipboardHistory,
  pasteSequentialClipboard,
  resetPasteSequence,
  getClipboardPreferences,
  saveClipboardPreferences
} from "./clipboard-storage.js";

export * from "./types.js";
export * from "./clipboard-storage.js";

export function getClipboardMarkdown(item: ClipboardItem): string {
  let markdown = `# 剪贴板内容详情\n\n`;

  const sensitivity = maskSensitiveContent(item.content);
  if (sensitivity.isSensitive || item.isSensitive) {
    markdown += `> **安全防护提示**: 检测到敏感凭据 (${sensitivity.reason || "机密凭据"})，已自动对预览内容执行安全脱敏遮罩。\n\n`;
  }

  if (item.type === "color") {
    const details = parseColorDetails(item.content);
    markdown += `### 调色盘与色彩代码\n\n`;
    if (details) {
      markdown += `\`\`\`css\n/* HEX 格式 */\ncolor: ${details.hex};\n\n/* RGB 格式 */\nbackground-color: ${details.rgb};\n\n/* HSL 格式 */\nborder-color: ${details.hsl};\n\`\`\`\n\n`;
      markdown += `> **HEX**: \`${details.hex}\` | **RGB**: \`${details.rgb}\` | **HSL**: \`${details.hsl}\``;
    } else {
      markdown += `> 色彩代码: \`${item.content}\``;
    }
  } else if (item.type === "json") {
    try {
      const parsed = JSON.parse(item.content);
      const formatted = JSON.stringify(parsed, null, 2);
      const keysCount = typeof parsed === "object" && parsed !== null ? Object.keys(parsed).length : 0;
      markdown += `### JSON 结构化数据预览 (${keysCount} 个顶层属性)\n\n\`\`\`json\n${formatted}\n\`\`\``;
    } catch {
      markdown += `\`\`\`json\n${item.content}\n\`\`\``;
    }
  } else if (item.type === "code") {
    markdown += "```typescript\n" + item.content + "\n```";
  } else if (item.type === "link") {
    markdown += `### 网络链接\n\n[${item.content}](${item.content})\n\n> 协议: \`${item.content.startsWith("https") ? "HTTPS (安全加密)" : "HTTP"}\``;
  } else if (item.type === "image") {
    markdown += `![图片预览](${item.content})\n\n> 分辨率: ${item.imageDimensions?.width ?? 0} x ${item.imageDimensions?.height ?? 0}`;
  } else if (item.type === "files") {
    markdown += "### 包含的文件列表\n" + (item.filePaths?.map(f => `- \`${f}\``).join("\n") ?? item.content);
  } else {
    if (sensitivity.isSensitive) {
      markdown += `\`\`\`text\n${sensitivity.masked}\n\`\`\``;
    } else {
      markdown += item.content;
    }
  }
  return markdown;
}

/**
 * 剪贴板条目详情视图
 */
export function ClipboardDetailView({
  item = SAMPLE_CLIPBOARD_ITEMS[0],
  onDeleted,
  onPinToggled
}: {
  item?: ClipboardItem;
  onDeleted?: (id: string) => void;
  onPinToggled?: (id: string) => void;
} = {}) {
  const { pop } = useNavigation();
  const markdown = getClipboardMarkdown(item);
  const colorDetails = item.type === "color" ? parseColorDetails(item.content) : null;
  const sensitivity = maskSensitiveContent(item.content);

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`详情: ${item.type.toUpperCase()}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="内容类型" text={item.type.toUpperCase()} icon={Icon.Document} />
          <Detail.Metadata.Label title="复制时间" text={formatCopiedTime(item.copiedAt)} icon={Icon.Clock} />
          <Detail.Metadata.Label title="置顶状态" text={item.pinned ? "已置顶" : "未置顶"} icon={Icon.Pin} />
          {item.sourceAppName ? (
            <Detail.Metadata.Label title="来源应用" text={item.sourceAppName} icon={Icon.AppWindow} />
          ) : null}
          {colorDetails ? (
            <>
              <Detail.Metadata.Label title="HEX" text={colorDetails.hex} icon={Icon.Eye} />
              <Detail.Metadata.Label title="RGB" text={colorDetails.rgb} icon={Icon.Eye} />
              <Detail.Metadata.Label title="HSL" text={colorDetails.hsl} icon={Icon.Eye} />
            </>
          ) : null}
          {item.charCount !== undefined && (
            <Detail.Metadata.Label title="字符总数" text={`${item.charCount} 字符`} icon={Icon.Pencil} />
          )}
          {item.lineCount !== undefined && (
            <Detail.Metadata.Label title="文本行数" text={`${item.lineCount} 行`} icon={Icon.List} />
          )}
          {(sensitivity.isSensitive || item.isSensitive) ? (
            <Detail.Metadata.Label title="敏感脱敏" text={sensitivity.reason || "已脱敏"} icon={Icon.Lock} />
          ) : null}
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="分类标签">
            <Detail.Metadata.TagList.Item
              text={item.pinned ? "PINNED" : "STANDARD"}
              color={Color.SecondaryText}
            />
            {(sensitivity.isSensitive || item.isSensitive) ? (
              <Detail.Metadata.TagList.Item text="SENSITIVE" color={Color.Red} />
            ) : null}
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="条目操作">
          <Action.Paste
            title="回车粘贴到前台应用 (Paste to Active)"
            content={item.content}
            icon={Icon.Checkmark}
          />
          <Action.CopyToClipboard
            title="仅复制到剪贴板"
            content={item.content}
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["ctrl"], key: "c" }}
          />
          {item.type === "link" ? (
            <Action.OpenInBrowser
              title="在浏览器中打开链接"
              url={item.content}
              icon={Icon.Globe}
              shortcut={{ modifiers: ["ctrl"], key: "o" }}
            />
          ) : null}
          {item.type === "files" && item.filePaths && item.filePaths.length > 0 ? (
            <Action
              title="在资源管理器中打开目标"
              icon={Icon.Folder}
              shortcut={{ modifiers: ["ctrl"], key: "o" }}
              onAction={async () => {
                await showToast(Toast.Style.Success, "定位文件", item.filePaths![0]);
              }}
            />
          ) : null}
          {colorDetails ? (
            <>
              <Action.CopyToClipboard
                title="复制 RGB 颜色值"
                content={colorDetails.rgb}
                icon={Icon.Eye}
                shortcut={{ modifiers: ["ctrl", "shift"], key: "r" }}
              />
              <Action.CopyToClipboard
                title="复制 HSL 颜色值"
                content={colorDetails.hsl}
                icon={Icon.Eye}
                shortcut={{ modifiers: ["ctrl", "shift"], key: "s" }}
              />
            </>
          ) : null}
          <Action
            title={item.pinned ? "取消置顶" : "置顶条目"}
            icon={Icon.Pin}
            shortcut={{ modifiers: ["ctrl"], key: "p" }}
            onAction={async () => {
              await toggleClipboardItemPin(item.id);
              onPinToggled?.(item.id);
              showToast(Toast.Style.Success, item.pinned ? "已取消置顶" : "已置顶");
            }}
          />
          <Action
            title="删除该记录"
            icon={Icon.Trash}
            shortcut={{ modifiers: ["ctrl"], key: "x" }}
            onAction={async () => {
              await deleteClipboardItem(item.id);
              onDeleted?.(item.id);
              showToast(Toast.Style.Success, "条目已删除");
              pop();
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 新建或编辑剪贴板条目表单
 */
export function ClipboardItemForm({
  initialItem,
  onSaved
}: {
  initialItem?: ClipboardItem;
  onSaved?: (item: ClipboardItem) => void;
}) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle={initialItem ? "编辑剪贴板内容" : "新建剪贴板内容"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={initialItem ? "保存并写入剪贴板" : "创建并写入剪贴板"}
            icon={Icon.Checkmark}
            onSubmit={async (values: Record<string, any>) => {
              const content = String(values.content || "");
              if (!content.trim()) {
                await showToast(Toast.Style.Failure, "内容不能为空");
                return;
              }
              const nextItem: ClipboardItem = {
                id: initialItem?.id || `clip-${Date.now()}`,
                type: detectClipboardContentType(content),
                content,
                preview: content.trim().replace(/\s+/g, " ").slice(0, 100),
                copiedAt: Date.now(),
                pinned: Boolean(values.pinned ?? initialItem?.pinned),
                charCount: content.length,
                lineCount: content.split(/\r?\n/).length,
                sourceAppName: initialItem?.sourceAppName || "ZTools Editor"
              };
              await Clipboard.copy(content);
              if (isRealElectronHost()) {
                await writeRealClipboardText(content);
              }
              onSaved?.(nextItem);
              await showToast(Toast.Style.Success, "已保存并同步至系统剪贴板");
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="content"
        title="剪贴板文本内容"
        placeholder="输入或编辑要写入剪贴板的文本、代码、JSON 或链接..."
        defaultValue={initialItem?.content || ""}
      />
      <Form.Checkbox
        id="pinned"
        label="置顶保护该条目 (Pin Item)"
        defaultValue={Boolean(initialItem?.pinned)}
      />
    </Form>
  );
}

/**
 * 官方内置核心能力: 剪贴板历史管理器
 * 布局一标杆：左 48% 历史列表 + 右 52% 真实内容本体预览，零彩色 Emoji 污染
 */
export default function ClipboardHistoryCommand() {
  const { push } = useNavigation();
  const [items, setItems] = useState<ClipboardItem[]>(() =>
    isRealElectronHost() ? [] : SAMPLE_CLIPBOARD_ITEMS
  );
  const [filterType, setFilterType] = useState<string>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [isShowingDetail, setIsShowingDetail] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(() => isRealElectronHost());
  const [preferences, setPreferences] = useState<ClipboardPreferences>({
    historyDuration: "P1W",
    primaryAction: "paste",
    preferPastingAsPlainText: false,
    updateHistoryAfterAction: true
  });

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      const [data, prefs] = await Promise.all([
        getClipboardHistory(),
        getClipboardPreferences()
      ]);
      setItems(data);
      setPreferences(prefs);
      setIsLoading(false);
    })();
  }, []);

  const filteredItems = filterClipboardItems(items, {
    type: filterType as any,
    query: searchText
  });

  const pinnedCount = items.filter((item) => item.pinned).length;

  const handleTogglePin = async (id: string) => {
    await toggleClipboardItemPin(id);
    const updated = items.map(item =>
      item.id === id ? { ...item, pinned: !item.pinned } : item
    );
    setItems(updated);
    await saveClipboardHistory(updated);
  };

  const handleDelete = async (id: string) => {
    await deleteClipboardItem(id);
    const updated = items.filter(item => item.id !== id);
    setItems(updated);
    await saveClipboardHistory(updated);
  };

  const handleClearUnpinned = async () => {
    await clearUnpinnedClipboardHistory();
    const updated = items.filter(item => item.pinned);
    setItems(updated);
    await saveClipboardHistory(updated);
    await showToast(Toast.Style.Success, "已清空未置顶历史", `保留了 ${updated.length} 条置顶条目`);
  };

  const handleSyncSystemClipboard = async () => {
    const res = await syncCurrentSystemClipboard(items);
    setItems(res.items);
    await showToast(
      Toast.Style.Success,
      res.added ? "已同步当前系统剪贴板" : "系统剪贴板已是最新记录",
      res.item?.preview || "当前系统剪贴板为空"
    );
  };

  const handleSaveEditedItem = async (saved: ClipboardItem) => {
    const exists = items.some((i) => i.id === saved.id);
    const next = exists
      ? items.map((i) => (i.id === saved.id ? saved : i))
      : [saved, ...items];
    setItems(next);
    await saveClipboardHistory(next);
  };

  const handlePasteSequential = async () => {
    const res = await pasteSequentialClipboard(filteredItems, {
      addNewLine: true,
      timeoutSeconds: 60
    });
    if (res.success && res.item) {
      await showToast(
        Toast.Style.Success,
        `流水粘贴 [第 ${res.offset} 项]`,
        `剩余 ${res.remaining} 条记录`
      );
    } else {
      await showToast(Toast.Style.Failure, "连续流水粘贴已结束", res.message || "无可用条目");
    }
  };

  const handleResetSequence = async () => {
    await resetPasteSequence();
    await showToast(Toast.Style.Success, "流水粘贴指针已重置", "下一次粘贴将重新从首条开始");
  };

  const getItemIcon = (item: ClipboardItem) => {
    switch (item.type) {
      case "color": return Icon.Eye;
      case "json": return Icon.Code;
      case "code": return Icon.Terminal;
      case "image": return Icon.Image;
      case "link": return Icon.Globe;
      case "files": return Icon.Folder;
      default: return Icon.Document;
    }
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索剪贴板历史 (支持拼音缩写、内容、代码、色彩、文件名)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedId(id || "")}
      filterBar={{
        summaryText: `本地 SQLite 历史共 ${items.length} 条 · 置顶 ${pinnedCount} 条 · 支持流水粘贴`,
        actions: [
          {
            id: "clear",
            label: "清空非置顶",
            title: "清空非置顶",
            style: "secondary",
            onAction: () => {
              void handleClearUnpinned();
            }
          },
          {
            id: "sync",
            label: "同步剪贴板",
            title: "同步剪贴板",
            style: "secondary",
            onAction: () => {
              void handleSyncSystemClipboard();
            }
          }
        ]
      }}
      actions={
        <ActionPanel title="剪贴板全局操作">
          <Action
            title="读取并同步当前系统剪贴板"
            icon={Icon.Repeat}
            onAction={handleSyncSystemClipboard}
          />
          <Action.Push
            title="新建剪贴板记录..."
            icon={Icon.Plus}
            shortcut={{ modifiers: ["ctrl"], key: "n" }}
            target={<ClipboardItemForm onSaved={handleSaveEditedItem} />}
          />
        </ActionPanel>
      }
      searchBarAccessory={
        <List.Dropdown
          tooltip="按类型筛选"
          value={filterType}
          onChange={setFilterType}
        >
          <List.Dropdown.Item title="全部格式 (All)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="已置顶 (Pinned)" value="pinned" icon={Icon.Pin} />
          <List.Dropdown.Item title="色彩代码 (Color)" value="color" icon={Icon.Eye} />
          <List.Dropdown.Item title="JSON 数据 (JSON)" value="json" icon={Icon.Code} />
          <List.Dropdown.Item title="代码片段 (Code)" value="code" icon={Icon.Terminal} />
          <List.Dropdown.Item title="链接网址 (Links)" value="link" icon={Icon.Globe} />
          <List.Dropdown.Item title="文件列表 (Files)" value="files" icon={Icon.Folder} />
          <List.Dropdown.Item title="图片 (Images)" value="image" icon={Icon.Image} />
          <List.Dropdown.Item title="纯文本 (Text)" value="text" icon={Icon.Document} />
        </List.Dropdown>
      }
    >
      <List.Section title={`历史记录 (${filteredItems.length} 条)`}>
        {filteredItems.map(item => {
          const colorDetails = item.type === "color" ? parseColorDetails(item.content) : null;
          const sensitivity = maskSensitiveContent(item.content);
          const isItemSensitive = Boolean(item.isSensitive || sensitivity.isSensitive);

          return (
            <List.Item
              key={item.id}
              id={item.id}
              title={isItemSensitive ? sensitivity.masked : item.preview}
              subtitle={formatCopiedTime(item.copiedAt)}
              icon={getItemIcon(item)}
              accessories={[
                ...(item.pinned ? [{ tag: { value: "置顶" }, tooltip: "已置顶" }] : []),
                ...(isItemSensitive ? [{ tag: { value: "敏感", color: Color.Red } }] : []),
                { text: item.type.toUpperCase() }
              ]}
              detail={
                <List.Item.Detail
                  markdown={getClipboardMarkdown(item)}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="类型" text={item.type.toUpperCase()} icon={Icon.Document} />
                      <List.Item.Detail.Metadata.Label title="复制时间" text={formatCopiedTime(item.copiedAt)} icon={Icon.Clock} />
                      <List.Item.Detail.Metadata.Label title="置顶" text={item.pinned ? "已置顶" : "普通"} icon={Icon.Pin} />
                      {item.sourceAppName ? (
                        <List.Item.Detail.Metadata.Label title="来源应用" text={item.sourceAppName} icon={Icon.AppWindow} />
                      ) : null}
                      {colorDetails ? (
                        <>
                          <List.Item.Detail.Metadata.Label title="HEX" text={colorDetails.hex} icon={Icon.Eye} />
                          <List.Item.Detail.Metadata.Label title="RGB" text={colorDetails.rgb} icon={Icon.Eye} />
                        </>
                      ) : null}
                      {item.charCount !== undefined && (
                        <List.Item.Detail.Metadata.Label title="字符数" text={`${item.charCount}`} icon={Icon.Pencil} />
                      )}
                      {item.lineCount !== undefined && (
                        <List.Item.Detail.Metadata.Label title="行数" text={`${item.lineCount}`} icon={Icon.List} />
                      )}
                      {isItemSensitive ? (
                        <List.Item.Detail.Metadata.Label title="安全状态" text="已脱敏遮罩" icon={Icon.Lock} />
                      ) : null}
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={item.pinned ? "PINNED" : "STANDARD"}
                          color={Color.SecondaryText}
                        />
                        {isItemSensitive ? (
                          <List.Item.Detail.Metadata.TagList.Item text="PROTECTED" color={Color.Red} />
                        ) : null}
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title="剪贴板动作">
                  <Action.Paste
                    title="回车粘贴到前台应用 (Paste to Active)"
                    content={item.content}
                    icon={Icon.Checkmark}
                  />

                  <Action.CopyToClipboard
                    title="仅复制到剪贴板"
                    content={item.content}
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  />

                  <Action.Push
                    title="全屏查看详情"
                    target={
                      <ClipboardDetailView
                        item={item}
                        onDeleted={handleDelete}
                        onPinToggled={handleTogglePin}
                      />
                    }
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ["ctrl"], key: "d" }}
                  />

                  <Action
                    title="连续流水粘贴下一个 (Paste Sequentially)"
                    icon={Icon.ArrowRight}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "v" }}
                    onAction={handlePasteSequential}
                  />

                  <Action
                    title="重置流水粘贴指针"
                    icon={Icon.RotateClockwise}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "z" }}
                    onAction={handleResetSequence}
                  />

                  <Action
                    title={isShowingDetail ? "关闭右侧详情分栏" : "展开右侧详情分栏"}
                    icon={Icon.SidebarRight}
                    shortcut={{ modifiers: ["ctrl"], key: "b" }}
                    onAction={() => setIsShowingDetail(!isShowingDetail)}
                  />

                  {item.type === "files" && item.filePaths && item.filePaths.length > 0 ? (
                    <Action
                      title="在资源管理器中定位文件"
                      icon={Icon.Folder}
                      shortcut={{ modifiers: ["ctrl"], key: "o" }}
                      onAction={async () => {
                        if (isRealElectronHost()) {
                          await showRealItemInFolder(item.filePaths![0]);
                        }
                        await showToast(Toast.Style.Success, "定位文件", item.filePaths![0]);
                      }}
                    />
                  ) : null}

                  {item.type === "link" ? (
                    <Action.OpenInBrowser
                      title="在浏览器中打开网址"
                      url={item.content}
                      icon={Icon.Globe}
                      shortcut={{ modifiers: ["ctrl"], key: "o" }}
                    />
                  ) : null}

                  {colorDetails ? (
                    <>
                      <Action.CopyToClipboard
                        title="复制 RGB 颜色值"
                        content={colorDetails.rgb}
                        icon={Icon.Eye}
                        shortcut={{ modifiers: ["ctrl", "shift"], key: "r" }}
                      />
                      <Action.CopyToClipboard
                        title="复制 HSL 颜色值"
                        content={colorDetails.hsl}
                        icon={Icon.Eye}
                        shortcut={{ modifiers: ["ctrl", "shift"], key: "s" }}
                      />
                    </>
                  ) : null}

                  <Action.Push
                    title="编辑该剪贴板内容..."
                    icon={Icon.Pencil}
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    target={<ClipboardItemForm initialItem={item} onSaved={handleSaveEditedItem} />}
                  />
                  <Action.Push
                    title="新建剪贴板记录..."
                    icon={Icon.Plus}
                    shortcut={{ modifiers: ["ctrl"], key: "n" }}
                    target={<ClipboardItemForm onSaved={handleSaveEditedItem} />}
                  />
                  <Action
                    title="读取并同步当前系统剪贴板"
                    icon={Icon.Repeat}
                    shortcut={{ modifiers: ["ctrl"], key: "r" }}
                    onAction={handleSyncSystemClipboard}
                  />

                  <Action
                    title={item.pinned ? "取消置顶" : "置顶条目"}
                    icon={Icon.Pin}
                    shortcut={{ modifiers: ["ctrl"], key: "p" }}
                    onAction={() => handleTogglePin(item.id)}
                  />

                  <Action
                    title="删除该记录"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => handleDelete(item.id)}
                  />

                  <Action
                    title="清空所有未置顶记录"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                    onAction={handleClearUnpinned}
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
