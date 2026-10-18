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
  open,
  useNavigation
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import { DictWordEntry, DictFilterTab } from "./types.js";
import {
  BUILTIN_DICTIONARY,
  lookupWord,
  lookupWordFromHost,
  speakWordOnHost,
  getOnlineDictionaryUrls
} from "./data.js";
import {
  getBookmarks,
  toggleBookmark,
  isBookmarked,
  getRecentSearches,
  recordRecentSearch,
  clearRecentSearches
} from "./storage.js";
import { isRealElectronHost } from "../shared/native-ipc.js";

export * from "./types.js";
export * from "./data.js";
export * from "./storage.js";

/**
 * 单词全屏详情视图 (对标 Raycast `/extension/dictionary/detail`)
 */
export function WordDetailView({ entry }: { entry: DictWordEntry }) {
  const [bookmarked, setBookmarked] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const b = await isBookmarked(entry.word);
      if (mounted) setBookmarked(b);
    })();
    return () => { mounted = false; };
  }, [entry.word]);

  const handleToggleBookmark = async () => {
    const res = await toggleBookmark(entry.word);
    setBookmarked(res.isBookmarked);
    await showToast(
      Toast.Style.Success,
      res.isBookmarked ? "已加入生词本" : "已从生词本移除",
      entry.word
    );
  };

  const urls = getOnlineDictionaryUrls(entry.word);

  const markdown = [
    `# ${entry.word}`,
    `**US:** \`${entry.phoneticUs}\` &nbsp;&nbsp;&nbsp;&nbsp; **UK:** \`${entry.phoneticUk}\`\n`,
    `---`,
    `### 📖 中文精准释义`,
    `> **${entry.pos.join(", ")}** ${entry.definitionZh}\n`,
    `### 🌐 英英释义 (English Definition)`,
    `> ${entry.definitionEn}\n`,
    (entry.examples && entry.examples.length > 0) ? `### 💡 权威例句 (Examples)\n` + (entry.examples ?? []).map(ex => `- ${ex.en}\n  *${ex.zh}*`).join("\n\n") : "",
    entry.synonyms.length > 0 ? `\n### 🔗 同义词 (Synonyms)\n` + entry.synonyms.map(s => `\`${s}\``).join(" • ") : "",
    entry.antonyms.length > 0 ? `\n### ⚡ 反义词 (Antonyms)\n` + entry.antonyms.map(a => `\`${a}\``).join(" • ") : ""
  ].filter(Boolean).join("\n\n");

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`${entry.word} - 详细释义`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="查询单词" text={entry.word} icon={Icon.Text} />
          <Detail.Metadata.Label title="音标" text={`${entry.phoneticUs} (US)`} />
          <Detail.Metadata.Label title="词性" text={entry.pos.join(", ")} />
          <Detail.Metadata.Separator />
          {entry.tags && entry.tags.length > 0 && (
            <Detail.Metadata.TagList title="词库标签">
              {entry.tags.map(t => (
                <Detail.Metadata.TagList.Item key={t} text={t} color={Color.Blue} />
              ))}
            </Detail.Metadata.TagList>
          )}
          <Detail.Metadata.Label
            title="生词本状态"
            text={bookmarked ? "已收藏 ⭐" : "未收藏"}
            icon={bookmarked ? Icon.Star : Icon.Circle}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="释义操作">
            <Action
              title="复制中文释义"
              icon={Icon.Clipboard}
              onAction={async () => {
                await Clipboard.copy(entry.definitionZh);
                await showToast(Toast.Style.Success, "已复制中文释义");
              }}
            />
            <Action
              title="复制单词"
              icon={Icon.Text}
              shortcut={{ modifiers: ["ctrl"], key: "c" }}
              onAction={async () => {
                await Clipboard.copy(entry.word);
                await showToast(Toast.Style.Success, "已复制单词");
              }}
            />
            <Action
              title={bookmarked ? "移出生词本" : "加入生词本"}
              icon={bookmarked ? Icon.Trash : Icon.Star}
              shortcut={{ modifiers: ["ctrl"], key: "b" }}
              onAction={handleToggleBookmark}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="外部权威词典">
            <Action.OpenInBrowser title="在 剑桥词典 (Cambridge) 中打开" url={urls.cambridge} />
            <Action.OpenInBrowser title="在 有道词典 (Youdao) 中打开" url={urls.youdao} />
            <Action.OpenInBrowser title="在 必应词典 (Bing) 中打开" url={urls.bing} />
            <Action.OpenInBrowser title="在 WordReference 中打开" url={urls.wordReference} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

/**
 * 格式化 List.Item.Detail 的 Markdown 视图
 */
function buildItemDetailMarkdown(entry: DictWordEntry, isBookmarkedWord: boolean): string {
  const parts: string[] = [
    `# ${entry.word}  \`${entry.phoneticUs}\``,
    `**词性**: ${entry.pos.map(p => `\`${p}\``).join(" ")} &nbsp;&nbsp;|&nbsp;&nbsp; **英式**: \`${entry.phoneticUk}\`\n`,
    `### 📖 中文精准释义`,
    `> ${entry.definitionZh}\n`,
    `### 🌐 英英释义`,
    `> ${entry.definitionEn}\n`
  ];

  const exList = entry.examples;
  if (exList && exList.length > 0) {
    parts.push(`### 💡 权威例句`);
    exList.slice(0, 2).forEach(ex => {
      parts.push(`- **${ex.en}**\n  *${ex.zh}*`);
    });
  }

  if (entry.synonyms.length > 0) {
    parts.push(`\n**同义词**: ` + entry.synonyms.slice(0, 5).map(s => `\`${s}\``).join(" • "));
  }

  if (entry.antonyms.length > 0) {
    parts.push(`\n**反义词**: ` + entry.antonyms.slice(0, 4).map(a => `\`${a}\``).join(" • "));
  }

  return parts.join("\n\n");
}

/**
 * Raycast Dictionary 官方生词释义主入口
 * 深度对齐 Raycast 2.7.3 `defineWord` 规范与交互体验
 */
export default function DictionaryCommand() {
  const [searchText, setSearchText] = useState("");
  const [currentTab, setCurrentTab] = useState<DictFilterTab>("all");
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [selectedWord, setSelectedWord] = useState<string>("");
  const [hostEntry, setHostEntry] = useState<DictWordEntry | null>(null);
  const { push } = useNavigation();

  // 加载生词本与查词历史
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [bmList, rcList] = await Promise.all([
        getBookmarks(),
        getRecentSearches()
      ]);
      if (mounted) {
        setBookmarks(bmList.map(b => b.word.toLowerCase()));
        setRecents(rcList.map(r => r.word.toLowerCase()));
      }
    })();
    return () => { mounted = false; };
  }, []);

  // 真实宿主下异步调用 dictionary_lookup IPC
  useEffect(() => {
    let mounted = true;
    const q = searchText.trim();
    if (!q || !isRealElectronHost()) {
      setHostEntry(null);
      return;
    }
    (async () => {
      try {
        const entry = await lookupWordFromHost(q);
        if (mounted) setHostEntry(entry);
      } catch {
        if (mounted) setHostEntry(null);
      }
    })();
    return () => { mounted = false; };
  }, [searchText]);

  // 记录搜索历史并执行查词
  const { results, guesses, isSearching } = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) {
      return { results: BUILTIN_DICTIONARY, guesses: [], isSearching: false };
    }
    const searchRes = lookupWord(q, BUILTIN_DICTIONARY);
    const combined = [...searchRes.exactMatches, ...searchRes.suggestions];
    if (hostEntry && !combined.some(e => e.word.toLowerCase() === hostEntry.word.toLowerCase())) {
      combined.unshift(hostEntry);
    }
    return {
      results: combined,
      guesses: searchRes.guesses,
      isSearching: true
    };
  }, [searchText, hostEntry]);

  // 根据 Tab 进行视图过滤
  const displayedEntries = useMemo(() => {
    if (currentTab === "bookmarks") {
      return BUILTIN_DICTIONARY.filter(e => bookmarks.includes(e.word.toLowerCase()));
    }
    if (currentTab === "history") {
      return recents
        .map(w => BUILTIN_DICTIONARY.find(e => e.word.toLowerCase() === w))
        .filter((e): e is DictWordEntry => Boolean(e));
    }
    return results;
  }, [currentTab, bookmarks, recents, results]);

  const handleToggleBookmark = async (entry: DictWordEntry) => {
    const res = await toggleBookmark(entry.word);
    setBookmarks(res.list.map(b => b.word.toLowerCase()));
    await showToast(
      Toast.Style.Success,
      res.isBookmarked ? "已加入生词本" : "已从生词本移除",
      entry.word
    );
  };

  const handleSelectWord = async (entry: DictWordEntry) => {
    setSelectedWord(entry.word);
    const updated = await recordRecentSearch(entry.word);
    setRecents(updated.map(u => u.word.toLowerCase()));
  };

  const handlePronounce = async (entry: DictWordEntry, dialect: "US" | "UK" = "US") => {
    const phonetic = dialect === "US" ? entry.phoneticUs : entry.phoneticUk;
    await speakWordOnHost(entry.word, dialect);
    await showToast(
      Toast.Style.Success,
      `发音朗读 (${dialect})`,
      `${entry.word} ${phonetic}`
    );
  };

  const handleClearHistory = async () => {
    await clearRecentSearches();
    setRecents([]);
    await showToast(Toast.Style.Success, "查词历史已清空");
  };

  const activeEntry =
    displayedEntries.find((e) => e.word === selectedWord) || displayedEntries[0] || null;

  return (
    <List
      isShowingDetail={true}
      searchBarPlaceholder="搜索词典 (如 architecture, resilience, sidecar, latency)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedWord(id || "")}
      filterBar={{
        summaryText: `当前词条结果 ${displayedEntries.length} 条 · 生词本已收藏 ${bookmarks.length} 个单词 · 历史查询 ${recents.length} 条`,
        groups: [
          {
            id: "dict-tab-filter",
            label: "词库视图",
            value: currentTab,
            onChange: (val) => setCurrentTab(val as DictFilterTab),
            options: [
              { value: "all", label: "全部词条", badge: results.length },
              { value: "bookmarks", label: "生词本收藏", badge: bookmarks.length },
              { value: "history", label: "最近查询", badge: recents.length }
            ]
          }
        ],
        actions: [
          {
            id: "dict-act-us",
            label: "🔊 美式发音 (US)",
            title: "🔊 美式发音 (US)",
            style: "primary",
            onAction: () => {
              if (!activeEntry) {
                void showToast(Toast.Style.Failure, "请先选择或搜索一个词条");
                return;
              }
              void handlePronounce(activeEntry, "US");
            }
          },
          {
            id: "dict-act-uk",
            label: "🔊 英式发音 (UK)",
            title: "🔊 英式发音 (UK)",
            style: "secondary",
            onAction: () => {
              if (!activeEntry) {
                void showToast(Toast.Style.Failure, "请先选择或搜索一个词条");
                return;
              }
              void handlePronounce(activeEntry, "UK");
            }
          },
          {
            id: "dict-act-copy-zh",
            label: "📋 复制中文释义",
            title: "📋 复制中文释义",
            style: "secondary",
            onAction: async () => {
              if (!activeEntry) {
                await showToast(Toast.Style.Failure, "请先选择或搜索一个词条");
                return;
              }
              await handleSelectWord(activeEntry);
              await Clipboard.copy(activeEntry.definitionZh);
              await showToast(Toast.Style.Success, "已复制中文释义", activeEntry.definitionZh);
            }
          },
          {
            id: "dict-act-bookmark",
            label: "⭐ 加入/移出生词本",
            title: "⭐ 加入/移出生词本",
            style: "secondary",
            onAction: () => {
              if (!activeEntry) {
                void showToast(Toast.Style.Failure, "请先选择或搜索一个词条");
                return;
              }
              void handleToggleBookmark(activeEntry);
            }
          },
          {
            id: "dict-act-cambridge",
            label: "🌐 剑桥词典打开",
            title: "🌐 剑桥词典打开",
            style: "secondary",
            onAction: async () => {
              const targetWord = activeEntry?.word || searchText.trim() || "architecture";
              const urls = getOnlineDictionaryUrls(targetWord);
              await open(urls.cambridge);
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="切换词典视图"
          value={currentTab}
          onChange={(val) => setCurrentTab(val as DictFilterTab)}
        >
          <List.Dropdown.Item title="全部词条 (All Words)" value="all" icon={Icon.List} />
          <List.Dropdown.Item
            title={`生词本 (${bookmarks.length})`}
            value="bookmarks"
            icon={Icon.Star}
          />
          <List.Dropdown.Item
            title={`查词历史 (${recents.length})`}
            value="history"
            icon={Icon.Clock}
          />
        </List.Dropdown>
      }
    >
      <List.Section title={currentTab === "bookmarks" ? `生词本收藏 (${displayedEntries.length})` : currentTab === "history" ? `最近查询 (${displayedEntries.length})` : `词条结果 (${displayedEntries.length})`}>
        {displayedEntries.map((entry) => {
          const isFav = bookmarks.includes(entry.word.toLowerCase());
          const urls = getOnlineDictionaryUrls(entry.word);
          return (
            <List.Item
              key={entry.word}
              id={entry.word}
              title={entry.word}
              subtitle={`${entry.phoneticUs} — ${entry.pos.join(", ")}`}
              icon={isFav ? Icon.Star : Icon.Text}
              accessories={[
                { text: entry.pos[0] || "n." },
                ...(isFav ? [{ icon: Icon.Star, tooltip: "已收藏在生词本" }] : [])
              ]}
              detail={
                <List.Item.Detail
                  markdown={buildItemDetailMarkdown(entry, isFav)}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="单词" text={entry.word} icon={Icon.Text} />
                      <List.Item.Detail.Metadata.Label title="美式音标 (US)" text={entry.phoneticUs} />
                      <List.Item.Detail.Metadata.Label title="英式音标 (UK)" text={entry.phoneticUk} />
                      <List.Item.Detail.Metadata.Label title="词性" text={entry.pos.join(", ")} />
                      <List.Item.Detail.Metadata.Separator />
                      {entry.tags && entry.tags.length > 0 && (
                        <List.Item.Detail.Metadata.TagList title="词库分级">
                          {entry.tags.map(t => (
                            <List.Item.Detail.Metadata.TagList.Item key={t} text={t} color={Color.Blue} />
                          ))}
                        </List.Item.Detail.Metadata.TagList>
                      )}
                      <List.Item.Detail.Metadata.Label
                        title="生词本"
                        text={isFav ? "已在生词本" : "未收藏"}
                        icon={isFav ? Icon.Star : Icon.Circle}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="查词操作">
                    <Action
                      title="复制中文释义 (回车默认)"
                      icon={Icon.Clipboard}
                      onAction={async () => {
                        await handleSelectWord(entry);
                        await Clipboard.copy(entry.definitionZh);
                        await showToast(Toast.Style.Success, "已复制释义", entry.definitionZh);
                      }}
                    />
                    <Action
                      title="复制英文单词"
                      icon={Icon.Text}
                      shortcut={{ modifiers: ["ctrl"], key: "c" }}
                      onAction={async () => {
                        await handleSelectWord(entry);
                        await Clipboard.copy(entry.word);
                        await showToast(Toast.Style.Success, "已复制单词", entry.word);
                      }}
                    />
                    <Action
                      title="查看全屏详情"
                      icon={Icon.Document}
                      onAction={async () => {
                        await handleSelectWord(entry);
                        push(<WordDetailView entry={entry} />);
                      }}
                    />
                    <Action
                      title={isFav ? "移出生词本" : "加入生词本 (Favorites)"}
                      icon={isFav ? Icon.Trash : Icon.Star}
                      shortcut={{ modifiers: ["ctrl"], key: "b" }}
                      onAction={() => handleToggleBookmark(entry)}
                    />
                  </ActionPanel.Section>

                  <ActionPanel.Section title="发音与外部检索">
                    <Action
                      title="朗读发音 (美式 US)"
                      icon={Icon.Play}
                      shortcut={{ modifiers: ["ctrl"], key: "p" }}
                      onAction={() => handlePronounce(entry, "US")}
                    />
                    <Action
                      title="朗读发音 (英式 UK)"
                      icon={Icon.Play}
                      onAction={() => handlePronounce(entry, "UK")}
                    />
                    <Action.OpenInBrowser title="在 剑桥词典 (Cambridge) 中打开" url={urls.cambridge} />
                    <Action.OpenInBrowser title="在 有道词典 (Youdao) 中打开" url={urls.youdao} />
                    <Action.OpenInBrowser title="在 必应词典 (Bing) 中打开" url={urls.bing} />
                  </ActionPanel.Section>

                  {currentTab === "history" && (
                    <ActionPanel.Section title="历史管理">
                      <Action
                        title="清空查词历史"
                        icon={Icon.Trash}
                        shortcut={{ modifiers: ["ctrl", "shift"], key: "delete" }}
                        onAction={handleClearHistory}
                      />
                    </ActionPanel.Section>
                  )}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>

      {isSearching && guesses.length > 0 && (
        <List.Section title={`您是否要找 (Did you mean? ${guesses.length})`}>
          {guesses.map(guess => (
            <List.Item
              key={`guess-${guess.word}`}
              id={`guess-${guess.word}`}
              title={guess.word}
              subtitle={`智能拼写推荐: ${guess.phoneticUs} — ${guess.definitionZh}`}
              icon={Icon.MagnifyingGlass}
              actions={
                <ActionPanel>
                  <Action
                    title={`查询 ${guess.word}`}
                    icon={Icon.MagnifyingGlass}
                    onAction={() => {
                      setSearchText(guess.word);
                    }}
                  />
                  <Action
                    title="复制释义"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      await Clipboard.copy(guess.definitionZh);
                      await showToast(Toast.Style.Success, "已复制释义", guess.definitionZh);
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
