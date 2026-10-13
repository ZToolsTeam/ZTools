import { EmojiItem, EmojiCategory } from "./types.js";
import { EMOJI_DATABASE, getUnicodeHex } from "./data.js";

export interface EmojiSearchResult {
  readonly allFiltered: EmojiItem[];
  readonly pinnedItems: EmojiItem[];
  readonly categoryGroups: { category: EmojiCategory; items: EmojiItem[] }[];
}

export function searchEmojis(
  query: string,
  categoryFilter: string = "all",
  pinnedSet: Set<string> = new Set()
): EmojiSearchResult {
  const q = query.trim().toLowerCase();
  const hexQuery = q.replace(/^u\+/i, "");

  const allFiltered = EMOJI_DATABASE.filter(item => {
    // 1. 分类过滤
    if (categoryFilter !== "all" && categoryFilter !== "pinned") {
      if (item.category !== categoryFilter) {
        return false;
      }
    }

    if (categoryFilter === "pinned") {
      if (!pinnedSet.has(item.char)) {
        return false;
      }
    }

    // 2. 搜索词为空时直接通过分类过滤
    if (!q) {
      return true;
    }

    // 3. 字符精确匹配
    if (item.char === q) {
      return true;
    }

    // 4. 英文名模糊匹配
    if (item.name.toLowerCase().includes(q)) {
      return true;
    }

    // 5. 中文译名模糊匹配
    if (item.nameZh.includes(q)) {
      return true;
    }

    // 6. 拼音及附加关键字匹配 (例如 "xiao" 匹配 😄, "diannao" 匹配 💻)
    if (item.keywords && item.keywords.some(k => k.toLowerCase().includes(q))) {
      return true;
    }

    // 7. Unicode 码点十六进制匹配 (例如 "1F600" 匹配 😀)
    if (hexQuery.length >= 3) {
      const codePointHex = getUnicodeHex(item.char).replace(/U\+/gi, "").toLowerCase();
      if (codePointHex.includes(hexQuery)) {
        return true;
      }
    }

    return false;
  });

  // 整理置顶 / 常用收藏项
  const pinnedItems = allFiltered.filter(item => pinnedSet.has(item.char));

  // 整理按分类聚合的数据
  const categoryMap = new Map<EmojiCategory, EmojiItem[]>();
  for (const item of allFiltered) {
    const list = categoryMap.get(item.category) || [];
    list.push(item);
    categoryMap.set(item.category, list);
  }

  const categoryGroups: { category: EmojiCategory; items: EmojiItem[] }[] = [];
  categoryMap.forEach((items, cat) => {
    if (items.length > 0) {
      categoryGroups.push({ category: cat, items });
    }
  });

  return {
    allFiltered,
    pinnedItems,
    categoryGroups
  };
}
