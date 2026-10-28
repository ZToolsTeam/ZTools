import { LocalStorage } from "../../api/storage.js";
import { getTranslationEndpoint } from "./translation-config.js";

export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  phonetic?: string;
  synonyms?: string[];
  examples?: { source: string; target: string }[];
  timestamp: string;
}

export interface TranslateHistoryItem extends TranslationResult {
  id: string;
}

const STORAGE_KEY = "google_translate_history";

// 内置精选双语/多语词典映射
const BUILTIN_DICTIONARY: Record<
  string,
  Record<string, { translated: string; phonetic?: string; synonyms?: string[]; examples?: { source: string; target: string }[] }>
> = {
  hello: {
    "zh-CN": {
      translated: "你好",
      phonetic: "/nǐ hǎo/",
      synonyms: ["您好", "喂", "哈喽"],
      examples: [
        { source: "Hello, nice to meet you!", target: "你好，很高兴见到你！" },
        { source: "Hello world!", target: "你好，世界！" }
      ]
    },
    ja: {
      translated: "こんにちは",
      phonetic: "/konnichiwa/",
      synonyms: ["もしもし", "やあ"],
      examples: [{ source: "Hello everyone", target: "皆さん、こんにちは" }]
    },
    ko: {
      translated: "안녕하세요",
      phonetic: "/annyeonghaseyo/",
      synonyms: ["안녕"]
    },
    fr: {
      translated: "Bonjour",
      phonetic: "/bɔ̃.ʒuʁ/",
      synonyms: ["Salut"]
    },
    de: {
      translated: "Hallo",
      phonetic: "/ˈhalo/"
    },
    es: {
      translated: "Hola",
      phonetic: "/ˈo.la/"
    },
    ru: {
      translated: "Привет",
      phonetic: "/prʲɪˈvʲet/"
    }
  },
  ztools: {
    "zh-CN": {
      translated: "ZTools 极速开发者工具箱",
      phonetic: "/z-tools/",
      synonyms: ["ZTools平台", "声明式极速中枢"],
      examples: [
        { source: "ZTools provides declarative UI components.", target: "ZTools 提供声明式 UI 组件。" }
      ]
    },
    en: {
      translated: "ZTools Developer Platform",
      examples: [{ source: "ZTools 提高生产力", target: "ZTools boosts productivity" }]
    }
  },
  world: {
    "zh-CN": {
      translated: "世界",
      phonetic: "/shì jiè/",
      synonyms: ["天下", "人间", "地球"]
    },
    en: {
      translated: "World",
      phonetic: "/wɜːld/"
    },
    ja: {
      translated: "世界 (せかい)",
      phonetic: "/sekai/"
    }
  },
  "thank you": {
    "zh-CN": {
      translated: "谢谢",
      phonetic: "/xiè xie/",
      synonyms: ["感谢", "多谢", "致谢"]
    },
    en: {
      translated: "Thank you",
      phonetic: "/θæŋk juː/"
    },
    ja: {
      translated: "ありがとうございます",
      phonetic: "/arigatou gozaimasu/"
    },
    fr: {
      translated: "Merci",
      phonetic: "/mɛʁ.si/"
    }
  }
};

/** 未配置在线翻译服务时的错误码 */
export const TRANSLATION_NOT_CONFIGURED = "TRANSLATION_NOT_CONFIGURED";

function createNotConfiguredError(): Error {
  const err = new Error("未配置翻译服务，目前只能翻译内置词典收录的词");
  (err as Error & { code?: string }).code = TRANSLATION_NOT_CONFIGURED;
  return err;
}

export function toApiLang(code: string): string {
  const map: Record<string, string> = {
    "zh-CN": "zh",
    "zh": "zh",
    "en": "en",
    "ja": "jp",
    "jp": "jp",
    "ko": "kor",
    "kor": "kor",
    "fr": "fra",
    "fra": "fra",
    "de": "de",
    "es": "spa",
    "spa": "spa",
    "ru": "ru"
  };
  return map[code] || code;
}

/**
 * 联网请求真实在线翻译结果
 */
export async function fetchLiveTranslation(
  sourceText: string,
  sourceLang: string = "auto",
  targetLang: string = "zh-CN",
  signal?: AbortSignal
): Promise<TranslationResult> {
  const trimmed = (sourceText || "").trim();
  if (!trimmed) {
    return {
      sourceText: "",
      translatedText: "",
      sourceLang,
      targetLang,
      timestamp: new Date().toLocaleTimeString()
    };
  }

  const lower = trimmed.toLowerCase();
  const dictHit = BUILTIN_DICTIONARY[lower]?.[targetLang];

  // 没有配置在线翻译服务（开源构建默认如此）：只用内置词典，词典没有就如实提示
  const endpoint = getTranslationEndpoint();
  if (!endpoint) {
    const offlineOnly = translateText(trimmed, sourceLang, targetLang);
    if (offlineOnly) return offlineOnly;
    throw createNotConfiguredError();
  }

  const apiLang = toApiLang(sourceLang);
  const apiToLang = toApiLang(targetLang);

  const formData = new FormData();
  formData.append("query", trimmed);
  formData.append("lang", apiLang);
  formData.append("tolang", apiToLang);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
      signal
    });

    if (res.ok) {
      const json = await res.json();
      if (json && json.code === 0 && json.data?.trans_result?.length > 0) {
        const translated = json.data.trans_result.map((item: any) => item.dst).join("\n");
        const detectedFrom = json.data.from || sourceLang;
        return {
          sourceText: trimmed,
          translatedText: translated,
          sourceLang: detectedFrom,
          targetLang,
          phonetic: dictHit?.phonetic,
          synonyms: dictHit?.synonyms,
          examples: dictHit?.examples || [
            {
              source: trimmed,
              target: translated
            }
          ],
          timestamp: new Date().toLocaleTimeString()
        };
      }
    }
  } catch (err: any) {
    if (signal?.aborted) throw err;
  }

  // 联网失败时只用内置词典兜底；词典没有就如实报错，不编造译文
  const offline = translateText(trimmed, sourceLang, targetLang);
  if (offline) return offline;
  throw new Error("翻译服务暂时不可用，请检查网络后重试");
}

/**
 * 核心即时翻译逻辑 (支持同步首屏/离线词典)
 */
export function translateText(
  sourceText: string,
  sourceLang: string,
  targetLang: string
): TranslationResult | null {
  const trimmed = sourceText.trim();
  const lower = trimmed.toLowerCase();

  // 1. 查找已知词典
  const dictEntry = BUILTIN_DICTIONARY[lower];
  if (dictEntry && dictEntry[targetLang]) {
    const hit = dictEntry[targetLang];
    return {
      sourceText: trimmed,
      translatedText: hit.translated,
      sourceLang,
      targetLang,
      phonetic: hit.phonetic,
      synonyms: hit.synonyms,
      examples: hit.examples,
      timestamp: new Date().toLocaleTimeString()
    };
  }

  // 2. 内置词典没有收录：返回 null，由调用方联网翻译或提示失败
  return null;
}

/**
 * 历史记录 LocalStorage 持久化操作
 */
export async function getTranslateHistory(): Promise<TranslateHistoryItem[]> {
  try {
    const list = await LocalStorage.getItem<TranslateHistoryItem[]>(STORAGE_KEY);
    return list || [];
  } catch {
    return [];
  }
}

export async function saveTranslateHistory(
  result: TranslationResult
): Promise<TranslateHistoryItem[]> {
  const current = await getTranslateHistory();
  const newItem: TranslateHistoryItem = {
    ...result,
    id: `trans_${Date.now()}_${(globalThis.crypto?.randomUUID?.()?.slice(0, 6) || "0001")}`
  };

  // 去重并限制最多保留 50 条
  const updated = [newItem, ...current.filter((item) => item.sourceText !== result.sourceText)].slice(0, 50);
  await LocalStorage.setItem(STORAGE_KEY, updated);
  return updated;
}

export async function clearTranslateHistory(): Promise<void> {
  await LocalStorage.removeItem(STORAGE_KEY);
}

export async function removeTranslateHistoryItem(id: string): Promise<TranslateHistoryItem[]> {
  const current = await getTranslateHistory();
  const updated = current.filter((i) => i.id !== id);
  await LocalStorage.setItem(STORAGE_KEY, updated);
  return updated;
}
