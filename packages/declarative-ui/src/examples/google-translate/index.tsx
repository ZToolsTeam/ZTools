import React from "../../index.js";
import { confirmAlert } from "../../api/alert.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import { SUPPORTED_LANGUAGES, getLanguageName } from "./languages.js";
import {
  translateText,
  fetchLiveTranslation,
  getTranslateHistory,
  saveTranslateHistory,
  clearTranslateHistory,
  removeTranslateHistoryItem,
  TranslationResult,
  TranslateHistoryItem
} from "./translate.js";

export * from "./languages.js";
export * from "./translate.js";

/**
 * 翻译详情视图 (现代纯正 TSX 模式)
 */
export function TranslateDetailView({ item }: { item: TranslationResult }) {
  const googleTranslateUrl = `https://translate.google.com/?sl=${item.sourceLang}&tl=${item.targetLang}&text=${encodeURIComponent(
    item.sourceText
  )}`;

  const markdown = `
# ${item.translatedText}

> 原文: **${item.sourceText}**  
> 发音/音标: \`${item.phonetic || "无"}\`

---

### 同义词 / 近义表达
${
  item.synonyms && item.synonyms.length > 0
    ? item.synonyms.map((s) => `- ${s}`).join("\n")
    : "- 暂无更多同义词推荐"
}

### 权威双语例句
${
  item.examples && item.examples.length > 0
    ? item.examples
        .map(
          (ex, idx) => `**${idx + 1}.** ${ex.source}  
*➔ ${ex.target}*`
        )
        .join("\n\n")
    : "- 暂无权威例句"
}
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`翻译: ${item.sourceText.slice(0, 12)}...`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="源语言" text={getLanguageName(item.sourceLang)} icon={Icon.Globe} />
          <Detail.Metadata.Label title="目标语言" text={getLanguageName(item.targetLang)} icon={Icon.ArrowRight} />
          <Detail.Metadata.Label title="音标/拼音" text={item.phonetic || "-"} icon={Icon.Text} />
          <Detail.Metadata.Label title="翻译时间" text={item.timestamp} icon={Icon.Clock} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="引擎">
            <Detail.Metadata.TagList.Item text="Google Neural MT" color={Color.Blue} icon={Icon.Check} />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="翻译操作">
          <Action.CopyToClipboard title="复制译文" content={item.translatedText} icon={Icon.CopyClipboard} />
          <Action.CopyToClipboard title="复制原文" content={item.sourceText} icon={Icon.Document} />
          <Action.OpenInBrowser title="在 Google 翻译中打开" url={googleTranslateUrl} icon={Icon.Globe} />
          <Action
            title="朗读发音"
            icon={Icon.Play}
            onAction={async () => {
              await showToast(Toast.Style.Success, "朗读发音", `${item.translatedText} (${item.targetLang})`);
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * Google 翻译主命令 (现代纯正 TSX 模式)
 */
export default function GoogleTranslateCommand() {
  const [inputText, setInputText] = useState("");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [history, setHistory] = useState<TranslateHistoryItem[]>([]);
  const [currentResult, setCurrentResult] = useState<TranslationResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const { push } = useNavigation();

  // 从 LocalStorage 加载历史记录
  useEffect(() => {
    getTranslateHistory().then((stored) => {
      // 没有历史就是空的，不预置示例记录
      setHistory(Array.isArray(stored) ? stored : []);
    });
  }, []);

  // 监听输入与语种变化，触发真实在线翻译
  useEffect(() => {
    const trimmed = inputText.trim();
    setErrorText("");
    if (!trimmed) {
      setCurrentResult(null);
      setIsLoading(false);
      return;
    }

    // 1. 同步初始结果（如果命中了离线词典，立即响应）
    const initialSync = translateText(trimmed, "auto", targetLang);
    setCurrentResult(initialSync);
    setIsLoading(true);

    // 2. 联网防抖异步获取真实翻译
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const live = await fetchLiveTranslation(trimmed, "auto", targetLang, controller.signal);
        if (live) {
          setCurrentResult(live);
        }
      } catch (err: any) {
        if (err?.name !== "AbortError" && !controller.signal.aborted) {
          setErrorText(err?.message || "翻译失败");
        }
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [inputText, targetLang]);

  // 用系统语音合成朗读；不支持时如实提示
  const handlePronounce = async (text: string, lang: string) => {
    const synth = (globalThis as any).speechSynthesis;
    const Utterance = (globalThis as any).SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") {
      await showToast(Toast.Style.Failure, "当前环境不支持朗读");
      return;
    }
    const utterance = new Utterance(text);
    utterance.lang = lang;
    synth.cancel();
    synth.speak(utterance);
  };

  const handleSaveToHistory = async () => {
    if (!currentResult) return;
    const updated = await saveTranslateHistory(currentResult);
    setHistory(updated);
    await showToast(Toast.Style.Success, "已持久化至翻译历史");
  };

  const handleClearHistory = async () => {
    const confirmed = await confirmAlert({
      title: "清空翻译历史？",
      message: `将删除全部 ${history.length} 条记录，且无法恢复。`,
      primaryAction: { title: "清空", style: "destructive" },
      dismissAction: { title: "取消" }
    });
    if (!confirmed) return;
    await clearTranslateHistory();
    setHistory([]);
    await showToast(Toast.Style.Success, "已清空翻译历史");
  };

  const handleRemoveHistory = async (id: string) => {
    const updated = await removeTranslateHistoryItem(id);
    setHistory(updated);
    await showToast(Toast.Style.Success, "已删除该条历史记录");
  };

  const googleUrl = currentResult
    ? `https://translate.google.com/?sl=auto&tl=${targetLang}&text=${encodeURIComponent(
        currentResult.sourceText
      )}`
    : "https://translate.google.com";

  return (
    <List
      isLoading={isLoading}
      navigationTitle="Google 即时翻译"
      searchBarPlaceholder="输入欲翻译的单词、句子或段落..."
      searchText={inputText}
      onSearchTextChange={(txt) => setInputText(txt)}
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择目标语言"
          value={targetLang}
          onChange={(newLang) => setTargetLang(newLang)}
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <List.Dropdown.Item
              key={lang.code}
              title={`${lang.flag} ${lang.name}`}
              value={lang.code}
            />
          ))}
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="全局操作">
          <Action title="保存当前翻译至历史" icon={Icon.Star} onAction={handleSaveToHistory} />
          <Action.OpenInBrowser title="在 Google 翻译中打开" url={googleUrl} icon={Icon.Globe} />
          <Action title="清空所有历史记录" icon={Icon.Trash} onAction={handleClearHistory} />
        </ActionPanel>
      }
    >
      {!currentResult && errorText && (
        <List.Section title="即时翻译结果">
          <List.Item id="translate-error" title={errorText} icon={Icon.ExclamationMark} />
        </List.Section>
      )}

      {currentResult && (
        <List.Section title="即时翻译结果">
          <List.Item
            id="live_result"
            title={currentResult.translatedText}
            subtitle={
              currentResult.phonetic
                ? `${currentResult.phonetic} • ${currentResult.sourceText}`
                : currentResult.sourceText
            }
            icon={Icon.Checkmark}
            accessories={[{ text: getLanguageName(currentResult.targetLang) }]}
            actions={
              <ActionPanel title={currentResult.translatedText}>
                <Action.Push
                  title="查看详细释义与例句"
                  icon={Icon.Eye}
                  target={() => <TranslateDetailView item={currentResult} />}
                />
                <Action.CopyToClipboard
                  title="复制译文"
                  content={currentResult.translatedText}
                  icon={Icon.CopyClipboard}
                />
                <Action.CopyToClipboard
                  title="复制原文"
                  content={currentResult.sourceText}
                  icon={Icon.Document}
                />
                <Action
                  title="朗读译文发音"
                  icon={Icon.Play}
                  onAction={() =>
                    handlePronounce(currentResult.translatedText, currentResult.targetLang)
                  }
                />
                <Action
                  title="保存到本地历史"
                  icon={Icon.Star}
                  onAction={handleSaveToHistory}
                />
                <Action.OpenInBrowser
                  title="在 Google 翻译中打开"
                  url={googleUrl}
                  icon={Icon.Globe}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      <List.Section title={`翻译历史 (${history.length})`}>
        {history.map((hist) => (
          <List.Item
            key={hist.id}
            id={hist.id}
            title={hist.translatedText}
            subtitle={`${hist.sourceText} (${hist.sourceLang} ➔ ${hist.targetLang})`}
            icon={Icon.Clock}
            accessories={[{ text: hist.timestamp }]}
            actions={
              <ActionPanel title={hist.translatedText}>
                <Action.Push
                  title="查看历史详情"
                  icon={Icon.Eye}
                  target={() => <TranslateDetailView item={hist} />}
                />
                <Action.CopyToClipboard
                  title="复制译文"
                  content={hist.translatedText}
                  icon={Icon.CopyClipboard}
                />
                <Action
                  title="重新填入输入框"
                  icon={Icon.Pencil}
                  onAction={() => {
                    setInputText(hist.sourceText);
                    setTargetLang(hist.targetLang);
                  }}
                />
                <Action
                  title="朗读译文发音"
                  icon={Icon.Play}
                  onAction={() => handlePronounce(hist.translatedText, hist.targetLang)}
                />
                <Action
                  title="从历史中删除"
                  icon={Icon.Trash}
                  onAction={() => handleRemoveHistory(hist.id)}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
