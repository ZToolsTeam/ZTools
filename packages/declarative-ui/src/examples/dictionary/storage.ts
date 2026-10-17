/**
 * 生词本收藏与查词历史持久化存储管理器
 * 基于 LocalStorage 与容灾校验
 */

import { LocalStorage } from "../../api/storage.js";
import { DictBookmarkItem, DictHistoryItem } from "./types.js";

export const DICTIONARY_STORAGE_KEYS = {
  BOOKMARKS: "ztools_dictionary_bookmarks_v1",
  RECENTS: "ztools_dictionary_recents_v1"
} as const;

const MAX_RECENTS = 30;
const MAX_BOOKMARKS = 200;

/**
 * 获取生词本收藏列表
 */
export async function getBookmarks(): Promise<DictBookmarkItem[]> {
  try {
    const raw = await LocalStorage.getItem(DICTIONARY_STORAGE_KEYS.BOOKMARKS);
    if (!raw || typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.word === "string" && typeof item.addedAt === "number");
  } catch (e) {
    return [];
  }
}

/**
 * 切换收藏状态 (Add / Remove)
 */
export async function toggleBookmark(word: string, note?: string): Promise<{ isBookmarked: boolean; list: DictBookmarkItem[] }> {
  const cleanWord = word.trim().toLowerCase();
  if (!cleanWord) {
    const current = await getBookmarks();
    return { isBookmarked: false, list: current };
  }

  const current = await getBookmarks();
  const index = current.findIndex(b => b.word.toLowerCase() === cleanWord);
  let updated: DictBookmarkItem[];
  let isBookmarked: boolean;

  if (index >= 0) {
    // 移除
    updated = current.filter((_, i) => i !== index);
    isBookmarked = false;
  } else {
    // 添加至头部
    const newItem: DictBookmarkItem = {
      word: cleanWord,
      addedAt: Date.now(),
      note: note ? note.trim() : undefined
    };
    updated = [newItem, ...current].slice(0, MAX_BOOKMARKS);
    isBookmarked = true;
  }

  await LocalStorage.setItem(DICTIONARY_STORAGE_KEYS.BOOKMARKS, JSON.stringify(updated));
  return { isBookmarked, list: updated };
}

/**
 * 判断单词是否已被收藏
 */
export async function isBookmarked(word: string): Promise<boolean> {
  const cleanWord = word.trim().toLowerCase();
  if (!cleanWord) return false;
  const list = await getBookmarks();
  return list.some(b => b.word.toLowerCase() === cleanWord);
}

/**
 * 获取查词历史
 */
export async function getRecentSearches(): Promise<DictHistoryItem[]> {
  try {
    const raw = await LocalStorage.getItem(DICTIONARY_STORAGE_KEYS.RECENTS);
    if (!raw || typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.word === "string" && typeof item.timestamp === "number");
  } catch (e) {
    return [];
  }
}

/**
 * 记录一条查词历史
 */
export async function recordRecentSearch(word: string): Promise<DictHistoryItem[]> {
  const cleanWord = word.trim().toLowerCase();
  if (!cleanWord) return await getRecentSearches();

  const current = await getRecentSearches();
  const filtered = current.filter(r => r.word.toLowerCase() !== cleanWord);
  const updated: DictHistoryItem[] = [
    { word: cleanWord, timestamp: Date.now() },
    ...filtered
  ].slice(0, MAX_RECENTS);

  await LocalStorage.setItem(DICTIONARY_STORAGE_KEYS.RECENTS, JSON.stringify(updated));
  return updated;
}

/**
 * 清空查词历史
 */
export async function clearRecentSearches(): Promise<void> {
  await LocalStorage.removeItem(DICTIONARY_STORAGE_KEYS.RECENTS);
}
