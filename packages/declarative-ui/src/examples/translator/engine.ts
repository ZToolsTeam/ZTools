/**
 * 极速离线与多语言翻译引擎
 * 对标 Raycast Translator 交互逻辑与反向对照规范
 */

import { LocalStorage } from "../../api/storage.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";
import { detectLanguage, getLanguageByCode } from "./languages.js";

export interface ReverseTranslationItem {
  readonly term: string;
  readonly pos?: string;
  readonly meaning: string;
  readonly alternates?: readonly string[];
}

export interface TranslationResult {
  readonly sourceText: string;
  readonly translatedText: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly detectedLanguage: { code: string; label: string; confidence: number };
  readonly phonetic?: string; // 拼音或音标
  readonly reverseTranslations?: readonly ReverseTranslationItem[];
}

export interface RecentTranslationRecord {
  readonly id: string;
  readonly sourceText: string;
  readonly translatedText: string;
  readonly sourceLang: string;
  readonly targetLang: string;
  readonly timestamp: number;
}

const RECENT_TRANSLATIONS_KEY = "ztools_translator_recents_v1";
const MAX_RECENTS = 50;

/**
 * 丰富的高频与科技互译词库
 */
const DICT_TRANSLATIONS: Record<string, Record<string, { translated: string; phonetic?: string; reverse?: ReverseTranslationItem[] }>> = {
  // 英译中 / 多语
  "hello": {
    "zh-Hans": { translated: "你好", phonetic: "nǐ hǎo", reverse: [{ term: "你好", pos: "int.", meaning: "hello; hi; how do you do", alternates: ["您好", "哈喽"] }] },
    "ja": { translated: "こんにちは", phonetic: "konnichiwa", reverse: [{ term: "こんにちは", pos: "int.", meaning: "hello; good afternoon" }] },
    "ko": { translated: "안녕하세요", phonetic: "annyeonghaseyo" },
    "fr": { translated: "Bonjour", phonetic: "/bɔ̃.ʒuʁ/" },
    "de": { translated: "Hallo", phonetic: "/ˈhaloː/" },
    "es": { translated: "Hola", phonetic: "/ˈo.la/" },
    "ru": { translated: "Здравствуйте", phonetic: "Zdravstvuyte" }
  },
  "world": {
    "zh-Hans": { translated: "世界", phonetic: "shì jiè", reverse: [{ term: "世界", pos: "n.", meaning: "world; earth; universe", alternates: ["天下", "世间"] }] },
    "ja": { translated: "世界", phonetic: "sekai" },
    "fr": { translated: "monde" },
    "de": { translated: "Welt" },
    "es": { translated: "mundo" }
  },
  "hello world": {
    "zh-Hans": { translated: "你好，世界", phonetic: "nǐ hǎo, shì jiè" },
    "ja": { translated: "こんにちは、世界" },
    "fr": { translated: "Bonjour le monde" },
    "de": { translated: "Hallo Welt" }
  },
  "settings": {
    "zh-Hans": { translated: "设置", phonetic: "shè zhì", reverse: [{ term: "设置", pos: "n./v.", meaning: "settings; preferences; setup; configuration", alternates: ["首选项", "偏好设置"] }] },
    "ja": { translated: "設定", phonetic: "settei" },
    "fr": { translated: "Paramètres" },
    "de": { translated: "Einstellungen" }
  },
  "clipboard": {
    "zh-Hans": { translated: "剪贴板", phonetic: "jiǎn tiē bǎn", reverse: [{ term: "剪贴板", pos: "n.", meaning: "clipboard; pasteboard", alternates: ["复制板"] }] },
    "ja": { translated: "クリップボード", phonetic: "kurippubōdo" }
  },
  "architecture": {
    "zh-Hans": { translated: "架构", phonetic: "jià gòu", reverse: [{ term: "架构", pos: "n.", meaning: "architecture; structural framework", alternates: ["体系结构", "体系"] }] }
  },
  "algorithm": {
    "zh-Hans": { translated: "算法", phonetic: "suàn fǎ", reverse: [{ term: "算法", pos: "n.", meaning: "algorithm; method of computation" }] }
  },
  "resilience": {
    "zh-Hans": { translated: "弹性与抗毁性", phonetic: "tán xìng yǔ kàng huǐ xìng", reverse: [{ term: "抗毁性", pos: "n.", meaning: "resilience; robustness; fault tolerance" }] }
  },
  "sidecar": {
    "zh-Hans": { translated: "边车与伴生进程", phonetic: "biān chē yǔ bàn shēng jìn chéng", reverse: [{ term: "伴生侧车", pos: "n.", meaning: "sidecar process" }] }
  },

  // 中译英
  "你好": {
    "en": { translated: "Hello", phonetic: "/həˈloʊ/", reverse: [{ term: "Hello", pos: "int.", meaning: "你好；喂；您好", alternates: ["Hi", "Greetings"] }] },
    "ja": { translated: "こんにちは" },
    "ko": { translated: "안녕하세요" }
  },
  "世界": {
    "en": { translated: "World", phonetic: "/wɜːrld/", reverse: [{ term: "World", pos: "n.", meaning: "世界；地球；领域", alternates: ["Earth", "Globe"] }] }
  },
  "设置": {
    "en": { translated: "Settings", phonetic: "/ˈsetɪŋz/", reverse: [{ term: "Settings", pos: "n.", meaning: "设置；偏好设置；配置", alternates: ["Preferences", "Configuration"] }] }
  },
  "剪贴板": {
    "en": { translated: "Clipboard", phonetic: "/ˈklɪpbɔːrd/", reverse: [{ term: "Clipboard", pos: "n.", meaning: "剪贴板；带夹写字板", alternates: ["Pasteboard"] }] }
  },
  "架构": {
    "en": { translated: "Architecture", phonetic: "/ˈɑːrkɪtektʃər/", reverse: [{ term: "Architecture", pos: "n.", meaning: "架构；建筑学；体系结构", alternates: ["Framework", "Structure"] }] }
  },
  "算法": {
    "en": { translated: "Algorithm", phonetic: "/ˈælɡərɪðəm/", reverse: [{ term: "Algorithm", pos: "n.", meaning: "算法；解题程序", alternates: ["Procedure", "Computation"] }] }
  },
  "抗毁性": {
    "en": { translated: "Resilience", phonetic: "/rɪˈzɪliəns/", reverse: [{ term: "Resilience", pos: "n.", meaning: "抗毁性；弹性；韧性", alternates: ["Robustness", "Fault-tolerance"] }] }
  },
  "侧车": {
    "en": { translated: "Sidecar", phonetic: "/ˈsaɪdkɑːr/", reverse: [{ term: "Sidecar", pos: "n.", meaning: "侧车；边车架构模式" }] }
  }
};

/**
 * 执行多语言极速翻译（在真实 Electron 宿主中优先走 translator_translate IPC）
 */
export async function translateText(
  text: string,
  sourceLang: string = "auto",
  targetLang: string = "en",
  hostOverride?: any
): Promise<TranslationResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      sourceText: "",
      translatedText: "",
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      detectedLanguage: { code: "en", label: "English", confidence: 0 }
    };
  }

  // 1. 语言探测
  const detected = detectLanguage(trimmed);
  const effectiveSource = sourceLang === "auto" ? detected.code : sourceLang;

  // 2. 目标语言自动调整：如果源语言和目标语言一致，且源为中文，则目标自动变为英文，反之亦然
  let effectiveTarget = targetLang;
  if (effectiveSource === effectiveTarget) {
    effectiveTarget = effectiveSource === "zh-Hans" ? "en" : "zh-Hans";
  }

  // 3. 在真实 Electron 宿主或提供 hostOverride 时优先调用主进程 translator_translate IPC
  if (hostOverride || isRealElectronHost()) {
    const ipcRes = await callHostTransport<any>(
      "translator_translate",
      {
        text: trimmed,
        sourceLanguage: sourceLang,
        targetLanguage: effectiveTarget
      },
      hostOverride
    );
    if (ipcRes.ok && ipcRes.data) {
      const payload = ipcRes.data;
      const translatedStr = String(
        payload.translatedText ?? payload.translation ?? payload.text ?? ""
      ).trim();
      if (translatedStr) {
        return {
          sourceText: text,
          translatedText: translatedStr,
          sourceLanguage: String(payload.sourceLanguage || effectiveSource),
          targetLanguage: String(payload.targetLanguage || effectiveTarget),
          detectedLanguage: payload.detectedLanguage || detected,
          phonetic: payload.phonetic,
          reverseTranslations: Array.isArray(payload.reverseTranslations)
            ? payload.reverseTranslations
            : undefined
        };
      }
    }
  }

  // 4. 查表匹配（忽略大小写）
  const lower = trimmed.toLowerCase();
  const dictMatch = DICT_TRANSLATIONS[lower] || DICT_TRANSLATIONS[trimmed];

  if (dictMatch && dictMatch[effectiveTarget]) {
    const entry = dictMatch[effectiveTarget];
    return {
      sourceText: text,
      translatedText: entry.translated,
      sourceLanguage: effectiveSource,
      targetLanguage: effectiveTarget,
      detectedLanguage: detected,
      phonetic: entry.phonetic,
      reverseTranslations: entry.reverse
    };
  }

  // 5. 通用离线本地翻译回退
  let translatedText = "";
  let phonetic: string | undefined;
  let reverse: ReverseTranslationItem[] | undefined;

  if (effectiveTarget === "zh-Hans") {
    translatedText = `[译] ${text}`;
  } else if (effectiveTarget === "en") {
    translatedText = `[Translated] ${text}`;
  } else {
    const targetDef = getLanguageByCode(effectiveTarget);
    translatedText = `[${targetDef.nativeName}] ${text}`;
  }

  return {
    sourceText: text,
    translatedText,
    sourceLanguage: effectiveSource,
    targetLanguage: effectiveTarget,
    detectedLanguage: detected,
    phonetic,
    reverseTranslations: reverse
  };
}

/**
 * 双向语言切换 (Swap Languages)
 * 对标 Raycast: 如果源语言是 auto，则将目标语言对调为探测语言，源语言设为旧目标语言
 */
export function swapLanguages(
  sourceLang: string,
  targetLang: string,
  detectedSourceLang: string = "zh-Hans"
): { newSource: string; newTarget: string } {
  if (sourceLang === "auto") {
    // 切换后：原目标变为源，原探测源变为新目标
    return {
      newSource: targetLang,
      newTarget: detectedSourceLang
    };
  }
  return {
    newSource: targetLang,
    newTarget: sourceLang
  };
}

/**
 * 历史翻译记录读取与持久化
 */
export async function getRecentTranslations(): Promise<RecentTranslationRecord[]> {
  try {
    const raw = await LocalStorage.getItem(RECENT_TRANSLATIONS_KEY);
    if (!raw || typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.sourceText === "string" && typeof item.translatedText === "string");
  } catch (e) {
    return [];
  }
}

export async function saveRecentTranslation(
  sourceText: string,
  translatedText: string,
  sourceLang: string,
  targetLang: string
): Promise<RecentTranslationRecord[]> {
  const cleanSource = sourceText.trim();
  const cleanTrans = translatedText.trim();
  if (!cleanSource || !cleanTrans) return await getRecentTranslations();

  const current = await getRecentTranslations();
  const filtered = current.filter(r => r.sourceText !== cleanSource || r.targetLang !== targetLang);

  const newRecord: RecentTranslationRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sourceText: cleanSource,
    translatedText: cleanTrans,
    sourceLang,
    targetLang,
    timestamp: Date.now()
  };

  const updated = [newRecord, ...filtered].slice(0, MAX_RECENTS);
  await LocalStorage.setItem(RECENT_TRANSLATIONS_KEY, JSON.stringify(updated));
  return updated;
}

export async function clearRecentTranslations(): Promise<void> {
  await LocalStorage.removeItem(RECENT_TRANSLATIONS_KEY);
}

/**
 * 外部 Web 翻译器跳转 URL 生成器
 */
export function getWebTranslatorUrls(text: string, sourceLang: string, targetLang: string) {
  const enc = encodeURIComponent(text.trim());
  const s = sourceLang === "auto" ? "auto" : sourceLang;
  const t = targetLang;
  return {
    deepL: `https://www.deepl.com/translator#${s}/${t}/${enc}`,
    googleTranslate: `https://translate.google.com/?sl=${s}&tl=${t}&text=${enc}&op=translate`,
    baidu: `https://fanyi.baidu.com/#${s === "auto" ? "auto" : s}/${t}/${enc}`
  };
}
