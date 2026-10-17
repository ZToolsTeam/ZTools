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
  open
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import {
  SUPPORTED_LANGUAGES,
  getLanguageByCode,
  detectLanguage,
  LanguageDefinition
} from "./languages.js";
import {
  translateText,
  swapLanguages,
  getRecentTranslations,
  saveRecentTranslation,
  clearRecentTranslations,
  getWebTranslatorUrls,
  TranslationResult,
  RecentTranslationRecord
} from "./engine.js";

export * from "./languages.js";
export * from "./engine.js";

/**
 * Raycast Translator 官方极速多语言翻译套件
 * 深度对齐 Raycast 2.7.3 `TranslateView` 规范与交互体验
 */
export default function TranslatorCommand() {
  const [inputText, setInputText] = useState("");
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("zh-Hans");
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const [recents, setRecents] = useState<RecentTranslationRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // 初始化加载历史记录与选中文本
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const history = await getRecentTranslations();
        if (mounted) setRecents(history);
      } catch (e) {}
    })();
    return () => { mounted = false; };
  }, []);

  // 响应输入变化执行翻译
  useEffect(() => {
    let mounted = true;
    const clean = inputText.trim();
    if (!clean) {
      setTranslation(null);
      return;
    }

    setIsLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await translateText(clean, sourceLang, targetLang);
        if (mounted) {
          setTranslation(res);
          setIsLoading(false);
          // 异步计入历史
          const updated = await saveRecentTranslation(clean, res.translatedText, res.sourceLanguage, res.targetLanguage);
          if (mounted) setRecents(updated);
        }
      } catch (err) {
        if (mounted) setIsLoading(false);
      }
    }, 200);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [inputText, sourceLang, targetLang]);

  // 语言对调 (Swap Languages)
  const handleSwap = () => {
    const detectedCode = translation?.detectedLanguage.code || "zh-Hans";
    const swapped = swapLanguages(sourceLang, targetLang, detectedCode);
    setSourceLang(swapped.newSource);
    setTargetLang(swapped.newTarget);
    showToast(Toast.Style.Success, "已对调语言", `${swapped.newSource} ⇄ ${swapped.newTarget}`);
  };

  const handleCopyTranslated = async (text: string) => {
    if (!text) return;
    await Clipboard.copy(text);
    await showToast(Toast.Style.Success, "已复制译文", text);
  };

  const handlePasteTranslated = async (text: string) => {
    if (!text) return;
    await Clipboard.paste(text);
    await showToast(Toast.Style.Success, "已粘贴译文到活动窗口", text);
  };

  const handleCopySource = async (text: string) => {
    if (!text) return;
    await Clipboard.copy(text);
    await showToast(Toast.Style.Success, "已复制原文", text);
  };

  const handleSpeak = async (text: string, langCode: string) => {
    if (!text) return;
    const { callHostTransport, isRealElectronHost } = await import("../shared/native-ipc.js");
    if (isRealElectronHost()) {
      await callHostTransport("dictionary_speak", { word: text, lang: langCode });
    }
    const langDef = getLanguageByCode(langCode);
    await showToast(Toast.Style.Success, `朗读 (${langDef.nativeName})`, text);
  };

  const handleClearHistory = async () => {
    await clearRecentTranslations();
    setRecents([]);
    await showToast(Toast.Style.Success, "翻译历史已清空");
  };

  const sourceLangDef = getLanguageByCode(sourceLang);
  const targetLangDef = getLanguageByCode(targetLang);
  const webUrls = inputText ? getWebTranslatorUrls(inputText, sourceLang, targetLang) : null;

  // 构建翻译结果卡片的 Markdown
  const detailMarkdown = useMemo(() => {
    if (!translation || !inputText) {
      return `### 🌐 极速多语言翻译中枢\n\n` +
        `- **支持语言**: 中、英、日、韩、法、德、西、俄 等 30+ 常用语言\n` +
        `- **极客特性**: 语言自动探测、双向热键对调 (\`Ctrl+S\`)、拼音/音标高保真注音、反向词条对照\n` +
        `- **快速操作**: 回车粘贴到当前焦点窗口，或按 \`Ctrl+C\` 复制译文\n\n` +
        `> 请在上方搜索框输入待翻译的内容开始体验。`;
    }

    const lines: string[] = [
      `# ${translation.translatedText}`,
      translation.phonetic ? `*注音 / 音标:* \`${translation.phonetic}\`\n` : ``,
      `---`,
      `### 📝 原文对照`,
      `> ${translation.sourceText}`,
      `**源语种**: \`${translation.detectedLanguage.label}\` (置信度: ${Math.round(translation.detectedLanguage.confidence * 100)}%) &nbsp;&nbsp;|&nbsp;&nbsp; **目标语种**: \`${targetLangDef.nativeName}\`\n`
    ];

    if (translation.reverseTranslations && translation.reverseTranslations.length > 0) {
      lines.push(`### 🔄 反向词条对照 (Reverse Translations)`);
      translation.reverseTranslations.forEach(r => {
        lines.push(`- **${r.term}** ${r.pos ? `\`${r.pos}\`` : ""} : ${r.meaning}`);
        if (r.alternates && r.alternates.length > 0) {
          lines.push(`  *近义对照:* ` + r.alternates.map(a => `\`${a}\``).join(" • "));
        }
      });
    }

    return lines.filter(Boolean).join("\n\n");
  }, [translation, inputText, targetLangDef]);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder={`输入待翻译内容... (当前目标: ${targetLangDef.flag} ${targetLangDef.nativeName})`}
      onSearchTextChange={setInputText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择目标语言"
          value={targetLang}
          onChange={(val) => setTargetLang(val)}
        >
          {SUPPORTED_LANGUAGES.filter(l => l.code !== "auto").map(lang => (
            <List.Dropdown.Item
              key={lang.code}
              value={lang.code}
              title={`${lang.flag} ${lang.nativeName} (${lang.label})`}
            />
          ))}
        </List.Dropdown>
      }
    >
      {translation && inputText ? (
        <List.Section title="实时翻译结果 (Live Translation)">
          <List.Item
            key="current-translation"
            id="current-translation"
            title={translation.translatedText}
            subtitle={`原文: ${translation.sourceText}`}
            icon={Icon.Globe}
            accessories={[
              { text: `${translation.detectedLanguage.code} → ${translation.targetLanguage}` },
              { icon: Icon.Checkmark }
            ]}
            detail={
              <List.Item.Detail
                markdown={detailMarkdown}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="源语种" text={translation.detectedLanguage.label} icon={Icon.Globe} />
                    <List.Item.Detail.Metadata.Label title="目标语种" text={targetLangDef.nativeName} icon={Icon.Text} />
                    {translation.phonetic && (
                      <List.Item.Detail.Metadata.Label title="注音/音标" text={translation.phonetic} />
                    )}
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label title="探测状态" text="已自动识别" icon={Icon.Check} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section title="首要操作">
                  <Action
                    title="粘贴译文到活动窗口 (回车默认)"
                    icon={Icon.Clipboard}
                    onAction={() => handlePasteTranslated(translation.translatedText)}
                  />
                  <Action
                    title="复制译文"
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                    onAction={() => handleCopyTranslated(translation.translatedText)}
                  />
                  <Action
                    title="复制原文"
                    icon={Icon.Text}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
                    onAction={() => handleCopySource(translation.sourceText)}
                  />
                </ActionPanel.Section>

                <ActionPanel.Section title="翻译控制">
                  <Action
                    title="对调源与目标语言 (Swap)"
                    icon={Icon.Repeat}
                    shortcut={{ modifiers: ["ctrl"], key: "s" }}
                    onAction={handleSwap}
                  />
                  <Action
                    title="朗读译文"
                    icon={Icon.Play}
                    shortcut={{ modifiers: ["ctrl"], key: "p" }}
                    onAction={() => handleSpeak(translation.translatedText, translation.targetLanguage)}
                  />
                  <Action
                    title="朗读原文"
                    icon={Icon.Play}
                    onAction={() => handleSpeak(translation.sourceText, translation.sourceLanguage)}
                  />
                </ActionPanel.Section>

                {webUrls && (
                  <ActionPanel.Section title="外部翻译平台">
                    <Action.OpenInBrowser title="在 DeepL 中打开" url={webUrls.deepL} />
                    <Action.OpenInBrowser title="在 Google Translate 中打开" url={webUrls.googleTranslate} />
                    <Action.OpenInBrowser title="在 百度翻译 中打开" url={webUrls.baidu} />
                  </ActionPanel.Section>
                )}
              </ActionPanel>
            }
          />
        </List.Section>
      ) : (
        <List.Section title="等待输入待翻译文本">
          <List.Item
            title="等待输入..."
            subtitle="输入英文、中文、日文、韩文或欧洲语言即时呈现译文"
            icon={Icon.Text}
            detail={<List.Item.Detail markdown={detailMarkdown} />}
          />
        </List.Section>
      )}

      {recents.length > 0 && (
        <List.Section title={`近期翻译历史 (${recents.length})`}>
          {recents.map(r => (
            <List.Item
              key={r.id}
              id={r.id}
              title={r.translatedText}
              subtitle={`原文: ${r.sourceText} (${r.sourceLang} → ${r.targetLang})`}
              icon={Icon.Clock}
              actions={
                <ActionPanel>
                  <Action
                    title="复制译文"
                    icon={Icon.Clipboard}
                    onAction={() => handleCopyTranslated(r.translatedText)}
                  />
                  <Action
                    title="重新载入查询"
                    icon={Icon.MagnifyingGlass}
                    onAction={() => {
                      setInputText(r.sourceText);
                      setTargetLang(r.targetLang);
                    }}
                  />
                  <Action
                    title="清空翻译历史"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "delete" }}
                    onAction={handleClearHistory}
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
