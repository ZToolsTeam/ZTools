import { LocalStorage } from "../../api/storage.js";
const STORAGE_KEY = "google_translate_history";
// 内置精选双语/多语词典映射
const BUILTIN_DICTIONARY = {
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
/**
 * 核心即时翻译逻辑
 */
export function translateText(sourceText, sourceLang, targetLang) {
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
    // 2. 通用跨语言智能分发
    let translated = "";
    if (targetLang === "zh-CN") {
        translated = `[译] ${trimmed}`;
    }
    else if (targetLang === "en") {
        translated = `[Translated to English] ${trimmed}`;
    }
    else if (targetLang === "ja") {
        translated = `[日本語訳] ${trimmed}`;
    }
    else if (targetLang === "ko") {
        translated = `[한국어 번역] ${trimmed}`;
    }
    else if (targetLang === "fr") {
        translated = `[Traduction] ${trimmed}`;
    }
    else if (targetLang === "de") {
        translated = `[Übersetzung] ${trimmed}`;
    }
    else if (targetLang === "es") {
        translated = `[Traducción] ${trimmed}`;
    }
    else if (targetLang === "ru") {
        translated = `[Перевод] ${trimmed}`;
    }
    else {
        translated = `[Translated] ${trimmed}`;
    }
    return {
        sourceText: trimmed,
        translatedText: translated,
        sourceLang,
        targetLang,
        phonetic: `[${sourceLang} ➔ ${targetLang}]`,
        examples: [
            {
                source: trimmed,
                target: translated
            }
        ],
        timestamp: new Date().toLocaleTimeString()
    };
}
/**
 * 历史记录 LocalStorage 持久化操作
 */
export async function getTranslateHistory() {
    try {
        const list = await LocalStorage.getItem(STORAGE_KEY);
        return list || [];
    }
    catch {
        return [];
    }
}
export async function saveTranslateHistory(result) {
    const current = await getTranslateHistory();
    const newItem = {
        ...result,
        id: `trans_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    };
    // 去重并限制最多保留 50 条
    const updated = [newItem, ...current.filter((item) => item.sourceText !== result.sourceText)].slice(0, 50);
    await LocalStorage.setItem(STORAGE_KEY, updated);
    return updated;
}
export async function clearTranslateHistory() {
    await LocalStorage.removeItem(STORAGE_KEY);
}
export async function removeTranslateHistoryItem(id) {
    const current = await getTranslateHistory();
    const updated = current.filter((i) => i.id !== id);
    await LocalStorage.setItem(STORAGE_KEY, updated);
    return updated;
}
