/**
 * 多语言语言定义与自动检测引擎
 * 对标 Raycast Translator 官方支持语言规范
 */

export interface LanguageDefinition {
  readonly code: string;
  readonly label: string;
  readonly nativeName: string;
  readonly flag: string;
  readonly phoneticsType?: "pinyin" | "ipa" | "romaji" | "hangul";
}

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = Object.freeze([
  { code: "auto", label: "Auto Detect", nativeName: "自动检测", flag: "🌐" },
  { code: "zh-Hans", label: "Chinese (Simplified)", nativeName: "简体中文", flag: "🇨🇳", phoneticsType: "pinyin" },
  { code: "en", label: "English", nativeName: "English", flag: "🇺🇸", phoneticsType: "ipa" },
  { code: "ja", label: "Japanese", nativeName: "日本語", flag: "🇯🇵", phoneticsType: "romaji" },
  { code: "ko", label: "Korean", nativeName: "한국어", flag: "🇰🇷", phoneticsType: "hangul" },
  { code: "fr", label: "French", nativeName: "Français", flag: "🇫🇷", phoneticsType: "ipa" },
  { code: "de", label: "German", nativeName: "Deutsch", flag: "🇩🇪", phoneticsType: "ipa" },
  { code: "es", label: "Spanish", nativeName: "Español", flag: "🇪🇸", phoneticsType: "ipa" },
  { code: "ru", label: "Russian", nativeName: "Русский", flag: "🇷🇺", phoneticsType: "ipa" },
  { code: "it", label: "Italian", nativeName: "Italiano", flag: "🇮🇹", phoneticsType: "ipa" },
  { code: "pt", label: "Portuguese", nativeName: "Português", flag: "🇵🇹", phoneticsType: "ipa" },
  { code: "ar", label: "Arabic", nativeName: "العربية", flag: "🇸🇦" },
  { code: "nl", label: "Dutch", nativeName: "Nederlands", flag: "🇳🇱" },
  { code: "pl", label: "Polish", nativeName: "Polski", flag: "🇵🇱" },
  { code: "tr", label: "Turkish", nativeName: "Türkçe", flag: "🇹🇷" },
  { code: "vi", label: "Vietnamese", nativeName: "Tiếng Việt", flag: "🇻🇳" },
  { code: "th", label: "Thai", nativeName: "ไทย", flag: "🇹🇭" },
  { code: "hi", label: "Hindi", nativeName: "हिन्दी", flag: "🇮🇳" },
  { code: "sv", label: "Swedish", nativeName: "Svenska", flag: "🇸🇪" },
  { code: "id", label: "Indonesian", nativeName: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "uk", label: "Ukrainian", nativeName: "Українська", flag: "🇺🇦" },
  { code: "el", label: "Greek", nativeName: "Ελληνικά", flag: "🇬🇷" },
  { code: "cs", label: "Czech", nativeName: "Čeština", flag: "🇨🇿" },
  { code: "da", label: "Danish", nativeName: "Dansk", flag: "🇩🇰" },
  { code: "fi", label: "Finnish", nativeName: "Suomi", flag: "🇫🇮" },
  { code: "ro", label: "Romanian", nativeName: "Română", flag: "🇷🇴" },
  { code: "hu", label: "Hungarian", nativeName: "Magyar", flag: "🇭🇺" },
  { code: "no", label: "Norwegian", nativeName: "Norsk", flag: "🇳🇴" },
  { code: "he", label: "Hebrew", nativeName: "עברית", flag: "🇮🇱" }
]);

export function getLanguageByCode(code: string): LanguageDefinition {
  const normalized = code.toLowerCase();
  const found = SUPPORTED_LANGUAGES.find(l => l.code.toLowerCase() === normalized);
  if (found) return found;
  if (normalized.startsWith("zh")) return SUPPORTED_LANGUAGES[1]; // default zh-Hans
  return SUPPORTED_LANGUAGES[2]; // default en
}

/**
 * 智能语种探测（基于 Unicode 码点特征与字符集匹配）
 */
export function detectLanguage(text: string): { code: string; label: string; confidence: number } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { code: "en", label: "English", confidence: 0 };
  }

  let cjkCount = 0;
  let hiraganaKatakanaCount = 0;
  let hangulCount = 0;
  let cyrillicCount = 0;
  let arabicCount = 0;
  let latinCount = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    // CJK Unified Ideographs
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjkCount++;
    }
    // Hiragana & Katakana
    else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      hiraganaKatakanaCount++;
    }
    // Hangul Syllables
    else if (code >= 0xac00 && code <= 0xd7af) {
      hangulCount++;
    }
    // Cyrillic
    else if (code >= 0x0400 && code <= 0x04ff) {
      cyrillicCount++;
    }
    // Arabic
    else if (code >= 0x0600 && code <= 0x06ff) {
      arabicCount++;
    }
    // Basic Latin & Latin-1
    else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
      latinCount++;
    }
  }

  // 判定逻辑
  if (hiraganaKatakanaCount > 0) {
    return { code: "ja", label: "Japanese", confidence: 0.95 };
  }
  if (hangulCount > 0) {
    return { code: "ko", label: "Korean", confidence: 0.95 };
  }
  if (cjkCount > 0) {
    return { code: "zh-Hans", label: "Chinese (Simplified)", confidence: 0.95 };
  }
  if (cyrillicCount > 0) {
    return { code: "ru", label: "Russian", confidence: 0.9 };
  }
  if (arabicCount > 0) {
    return { code: "ar", label: "Arabic", confidence: 0.9 };
  }

  // 欧洲语言启发式
  const lower = trimmed.toLowerCase();
  if (/\b(der|die|das|und|ist|nicht|für|mit|ein|eine|guten|tag|danke|bitte)\b/i.test(lower)) {
    return { code: "de", label: "German", confidence: 0.85 };
  }
  if (/\b(le|la|les|un|une|des|et|est|pour|dans|avec|bonjour|merci)\b/i.test(lower)) {
    return { code: "fr", label: "French", confidence: 0.85 };
  }
  if (/\b(el|la|los|las|y|es|por|para|con|un|una|hola|gracias)\b/i.test(lower)) {
    return { code: "es", label: "Spanish", confidence: 0.85 };
  }

  return { code: "en", label: "English", confidence: 0.8 };
}
