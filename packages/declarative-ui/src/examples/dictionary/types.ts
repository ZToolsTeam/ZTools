/**
 * ZTools Raycast-Compat Dictionary 类型定义
 * 对标 Raycast Dictionary & macOS Dictionary 官方规范
 */

export interface DictExampleItem {
  readonly en: string;
  readonly zh: string;
}

export interface DictDefinitionItem {
  readonly partOfSpeech: string; // n., v., adj., adv., prep., conj.
  readonly definitionZh: string;
  readonly definitionEn?: string;
  readonly synonyms?: readonly string[];
  readonly antonyms?: readonly string[];
  readonly examples?: readonly DictExampleItem[];
}

export interface DictWordEntry {
  readonly word: string;
  readonly phoneticUs: string;
  readonly phoneticUk: string;
  readonly pos: readonly string[]; // 词性标签列表
  readonly definitionZh: string;   // 摘要释义
  readonly definitionEn: string;   // 摘要英英释义
  readonly definitions: readonly DictDefinitionItem[]; // 完整分项释义
  readonly synonyms: readonly string[];
  readonly antonyms: readonly string[];
  readonly examples?: readonly DictExampleItem[];
  readonly tags?: readonly string[]; // "CS" | "CET4" | "CET6" | "IELTS" | "TOEFL" | "TECH"
  readonly frequencyRank?: number;   // 词频等级 1-5
}

export interface DictHistoryItem {
  readonly word: string;
  readonly timestamp: number;
}

export interface DictBookmarkItem {
  readonly word: string;
  readonly addedAt: number;
  readonly note?: string;
}

export type DictFilterTab = "all" | "bookmarks" | "history";
