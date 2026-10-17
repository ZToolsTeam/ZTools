import React from "../../index.js";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import {
  EmojiItem,
  EmojiCategory,
  CategoryInfo
} from "./types.js";
import {
  CATEGORIES,
  EMOJI_DATABASE,
  getUnicodeHex,
  getHtmlEntity,
  getCategoryLabel
} from "./data.js";
import { searchEmojis } from "./search.js";
import {
  getPinnedEmojis,
  togglePinnedEmoji
} from "./storage.js";

export * from "./types.js";
export * from "./data.js";
export * from "./search.js";
export * from "./storage.js";

/**
 * Emoji 详情卡片组件 (双栏详情模式)
 */
export function EmojiDetailView({
  item,
  isPinned
}: {
  item: EmojiItem;
  isPinned: boolean;
}) {
  const codePoint = item.codePoint || getUnicodeHex(item.char);
  const htmlHex = item.htmlEntity || getHtmlEntity(item.char, true);
  const htmlDec = getHtmlEntity(item.char, false);
  const categoryName = getCategoryLabel(item.category);

  const markdown = `
# ${item.char}

### ${item.nameZh}
*${item.name}*

---

### 字符规范与编码
- **Unicode 码点**: \`${codePoint}\`
- **HTML 16进制实体**: \`${htmlHex}\`
- **HTML 10进制实体**: \`${htmlDec}\`
- **所属分类**: ${categoryName}
- **收藏状态**: ${isPinned ? "⭐ 已收藏" : "未收藏"}

---

> **搜索关键词**: \`${item.keywords.join(", ")}\`
`;

  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="表情字形" text={item.char} icon={Icon.Text} />
          <List.Item.Detail.Metadata.Label title="官方英文名" text={item.name} icon={Icon.Document} />
          <List.Item.Detail.Metadata.Label title="中文标准名" text={item.nameZh} icon={Icon.Pencil} />
          <List.Item.Detail.Metadata.Label title="所属分类" text={categoryName} icon={Icon.List} />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label title="Unicode 码点" text={codePoint} icon={Icon.Key} />
          <List.Item.Detail.Metadata.Label title="HTML 实体" text={htmlHex} icon={Icon.Code} />
          <List.Item.Detail.Metadata.TagList title="检索标签">
            {item.keywords.slice(0, 5).map(k => (
              <List.Item.Detail.Metadata.TagList.Item key={k} text={k} color={Color.Blue} />
            ))}
          </List.Item.Detail.Metadata.TagList>
        </List.Item.Detail.Metadata>
      }
    />
  );
}

/**
 * 全键盘极客 Emoji & 符号选择器主命令
 */
export default function EmojiPickerCommand() {
  const [searchText, setSearchText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [pinnedList, setPinnedList] = useState<string[]>([]);
  const [isShowingDetail, setIsShowingDetail] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // 初始化加载置顶表情
  useEffect(() => {
    getPinnedEmojis().then(pins => {
      setPinnedList(pins);
      setIsLoading(false);
    });
  }, []);

  const pinnedSet = useMemo(() => new Set(pinnedList), [pinnedList]);

  // 执行拼音、中文、英文与十六进制全能搜索
  const { allFiltered, pinnedItems, categoryGroups } = useMemo(() => {
    return searchEmojis(searchText, selectedCategory, pinnedSet);
  }, [searchText, selectedCategory, pinnedSet]);

  // 1. 粘贴到前台应用 (Paste to Active App - Enter 默认主动作)
  const handlePaste = async (item: EmojiItem) => {
    await Clipboard.paste(item.char);
    await showToast(Toast.Style.Success, `已插入表情 ${item.char}`, item.nameZh);
  };

  // 2. 复制到剪贴板 (Copy Character)
  const handleCopyChar = async (item: EmojiItem) => {
    await Clipboard.copy(item.char);
    await showToast(Toast.Style.Success, `已复制表情 ${item.char}`, item.nameZh);
  };

  // 3. 复制 Unicode 码点 (Copy Unicode Hex)
  const handleCopyUnicode = async (item: EmojiItem) => {
    const hex = getUnicodeHex(item.char);
    await Clipboard.copy(hex);
    await showToast(Toast.Style.Success, `已复制 Unicode 码点: ${hex}`, item.nameZh);
  };

  // 4. 复制 HTML 实体 (Copy HTML Entity)
  const handleCopyHtml = async (item: EmojiItem) => {
    const entity = getHtmlEntity(item.char, true);
    await Clipboard.copy(entity);
    await showToast(Toast.Style.Success, `已复制 HTML 实体: ${entity}`, item.nameZh);
  };

  // 5. 切换常用收藏 (Toggle Pin / Favorite)
  const handleTogglePin = async (item: EmojiItem) => {
    const isNowPinned = await togglePinnedEmoji(item.char);
    const updated = await getPinnedEmojis();
    setPinnedList(updated);
    await showToast(
      Toast.Style.Success,
      isNowPinned ? `已添加收藏 ${item.char}` : `已移出收藏 ${item.char}`,
      item.nameZh
    );
  };

  const renderEmojiItem = (item: EmojiItem) => {
    const isPinned = pinnedSet.has(item.char);
    const codePoint = getUnicodeHex(item.char);

    return (
      <List.Item
        key={`${item.category}-${item.char}`}
        id={`${item.category}-${item.char}`}
        title={`${item.char}  ${item.nameZh}`}
        subtitle={item.name}
        accessories={[
          ...(isPinned ? [{ icon: Icon.Star, tooltip: "已收藏" }] : []),
          { text: codePoint }
        ]}
        detail={<EmojiDetailView item={item} isPinned={isPinned} />}
        actions={
          <ActionPanel title={`${item.char} ${item.nameZh}`}>
            <Action
              title="插入前台活动应用 (Paste)"
              icon={Icon.Terminal}
              onAction={() => handlePaste(item)}
            />
            <Action
              title="复制表情符号 (Copy Char)"
              icon={Icon.CopyClipboard}
              shortcut={{ modifiers: ["ctrl"], key: "c" }}
              onAction={() => handleCopyChar(item)}
            />
            <Action
              title="复制 Unicode 码点 (Hex)"
              icon={Icon.Key}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "u" }}
              onAction={() => handleCopyUnicode(item)}
            />
            <Action
              title="复制 HTML 实体编码"
              icon={Icon.Code}
              shortcut={{ modifiers: ["ctrl", "shift"], key: "h" }}
              onAction={() => handleCopyHtml(item)}
            />
            <Action
              title={isPinned ? "取消常用收藏" : "加入常用收藏"}
              icon={Icon.Star}
              shortcut={{ modifiers: ["ctrl"], key: "f" }}
              onAction={() => handleTogglePin(item)}
            />
            <Action
              title={isShowingDetail ? "关闭详情侧栏" : "展开详情侧栏"}
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
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索表情与符号 (支持中文、拼音如 xiao / diannao、英文或 U+码点)..."
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择表情类别"
          value={selectedCategory}
          onChange={setSelectedCategory}
        >
          <List.Dropdown.Item title="全部类别 (All Categories)" value="all" />
          <List.Dropdown.Item title="⭐ 常用收藏 (Pinned)" value="pinned" />
          {CATEGORIES.map(cat => (
            <List.Dropdown.Item
              key={cat.id}
              title={`${cat.labelZh} (${cat.labelEn})`}
              value={cat.id}
            />
          ))}
        </List.Dropdown>
      }
    >
      {/* 1. 若存在置顶收藏且在全景视图或有匹配 */}
      {selectedCategory === "all" && !searchText && pinnedItems.length > 0 && (
        <List.Section title={`⭐ 常用收藏 (${pinnedItems.length})`}>
          {pinnedItems.map(renderEmojiItem)}
        </List.Section>
      )}

      {/* 2. 搜索中或有分类过滤时按分组呈现 */}
      {selectedCategory === "pinned" ? (
        <List.Section title={`⭐ 常用收藏 (${pinnedItems.length})`}>
          {pinnedItems.map(renderEmojiItem)}
        </List.Section>
      ) : searchText.trim() ? (
        <List.Section title={`搜索结果 (${allFiltered.length})`}>
          {allFiltered.map(renderEmojiItem)}
        </List.Section>
      ) : (
        categoryGroups.map(group => (
          <List.Section
            key={group.category}
            title={`${getCategoryLabel(group.category)} (${group.items.length})`}
          >
            {group.items.map(renderEmojiItem)}
          </List.Section>
        ))
      )}
    </List>
  );
}
