import { Quicklink, QuicklinkInput, QuicklinkResolved } from "./types.js";

export const DEFAULT_QUICKLINKS: Quicklink[] = [
  {
    id: "ql-1",
    title: "Google 搜索",
    link: "https://www.google.com/search?q={argument}",
    keyword: "g",
    description: "Google 全球搜索，输入关键词快速检索",
    icon: "globe",
    defaultArgument: "ZTools",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-2",
    title: "GitHub 代码与仓库搜索",
    link: "https://github.com/search?q={argument}",
    keyword: "gh",
    description: "检索 GitHub 全球开源仓库、代码与 Issue",
    icon: "code",
    defaultArgument: "ztools",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-3",
    title: "DeepSeek 智能对话",
    link: "https://chat.deepseek.com",
    keyword: "ds",
    description: "DeepSeek 官方大模型深度思考与对话平台",
    icon: "message",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-4",
    title: "哔哩哔哩 (Bilibili)",
    link: "https://search.bilibili.com/all?keyword={argument}",
    keyword: "bili",
    description: "B 站弹幕视频搜索与精彩内容直达",
    icon: "play",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-5",
    title: "YouTube 视频搜索",
    link: "https://www.youtube.com/results?search_query={argument}",
    keyword: "yt",
    description: "全球海量原创视频与音频检索",
    icon: "play",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-6",
    title: "维基百科 (Wikipedia)",
    link: "https://zh.wikipedia.org/w/index.php?search={argument}",
    keyword: "wiki",
    description: "自由的百科全书条目检索",
    icon: "document",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-7",
    title: "Stack Overflow 问答",
    link: "https://stackoverflow.com/search?q={argument}",
    keyword: "so",
    description: "开发者编程问答与技术疑难解决",
    icon: "code",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: "ql-8",
    title: "Bing 必应搜索",
    link: "https://www.bing.com/search?q={argument}",
    keyword: "bing",
    description: "微软必应智能搜索直达",
    icon: "globe",
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }
];

const STORAGE_KEY = "ztools_quicklinks_list_v1";

export async function getQuicklinks(): Promise<Quicklink[]> {
  if (typeof localStorage !== "undefined") {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Fallback to defaults
    }
  }
  return [...DEFAULT_QUICKLINKS];
}

export async function saveQuicklinks(quicklinks: Quicklink[]): Promise<void> {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(quicklinks));
    } catch {
      // LocalStorage full or blocked
    }
  }
}

/**
 * 解析 Quicklink 宏模板 URL
 * 支持替换 {query}、{argument} 与 {argument name="..." default="..."}
 */
export function resolveQuicklinkUrl(
  linkTemplate: string,
  queryParam?: string,
  defaultParam?: string
): QuicklinkResolved {
  if (!linkTemplate || typeof linkTemplate !== "string") {
    return { url: "", hasQuery: false, needsArgument: false };
  }

  // 匹配 {query}, {argument}, {arg}, 支持 name="..." 与 default="..." 属性
  const placeholderRegex = /\{(query|argument|arg)(?:\s+name="([^"]*)")?(?:\s+default="([^"]*)")?\}/gi;
  const hasQuery = placeholderRegex.test(linkTemplate);

  if (!hasQuery) {
    return { url: linkTemplate.trim(), hasQuery: false, needsArgument: false };
  }

  // 重置正则游标
  placeholderRegex.lastIndex = 0;

  const rawArg = queryParam !== undefined && queryParam !== null ? String(queryParam).trim() : "";
  let missingArgument = false;

  const resolved = linkTemplate.replace(
    placeholderRegex,
    (_match, _type, _name, defaultAttr) => {
      if (rawArg) {
        return encodeURIComponent(rawArg);
      }
      if (defaultAttr !== undefined && defaultAttr !== null) {
        return encodeURIComponent(defaultAttr);
      }
      if (defaultParam) {
        return encodeURIComponent(defaultParam);
      }
      missingArgument = true;
      return "";
    }
  );

  return {
    url: resolved,
    hasQuery: true,
    queryParam: rawArg,
    needsArgument: missingArgument && !rawArg
  };
}

/**
 * 过滤与匹配 Quicklinks (支持关键词精确直达与模糊搜索)
 */
export function filterQuicklinks(
  quicklinks: Quicklink[],
  searchQuery: string
): { matches: Quicklink[]; directMatch?: { quicklink: Quicklink; queryArg: string } } {
  if (!searchQuery || !searchQuery.trim()) {
    return { matches: [...quicklinks] };
  }

  const query = searchQuery.trim();
  const parts = query.split(/\s+/);
  const firstWord = parts[0].toLowerCase();
  const restArg = parts.slice(1).join(" ");

  // 1. 检查关键词直达 (如 "g react" 或 "gh ztools")
  const directQuicklink = quicklinks.find(
    ql => ql.keyword && ql.keyword.toLowerCase() === firstWord
  );

  let directMatch: { quicklink: Quicklink; queryArg: string } | undefined;
  if (directQuicklink && restArg) {
    directMatch = {
      quicklink: directQuicklink,
      queryArg: restArg
    };
  }

  // 2. 常规模糊匹配
  const qLower = query.toLowerCase();
  const matches = quicklinks.filter(
    ql =>
      ql.title.toLowerCase().includes(qLower) ||
      ql.link.toLowerCase().includes(qLower) ||
      (ql.keyword && ql.keyword.toLowerCase().includes(qLower)) ||
      (ql.description && ql.description.toLowerCase().includes(qLower))
  );

  return { matches, directMatch };
}

/**
 * 导出 Quicklinks 数据为格式化 JSON 字符串
 */
export function exportQuicklinksJson(quicklinks: Quicklink[]): string {
  return JSON.stringify(quicklinks, null, 2);
}

/**
 * 导入 Quicklinks 数据，合并并去重
 */
export function importQuicklinksJson(
  jsonStr: string,
  existing: Quicklink[]
): { success: boolean; importedCount: number; result: Quicklink[]; error?: string } {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return { success: false, importedCount: 0, result: existing, error: "导入内容必须为 Quicklink 数组 JSON" };
    }

    const existingMap = new Map<string, Quicklink>();
    existing.forEach(item => existingMap.set(item.id, item));

    let importedCount = 0;
    const merged = [...existing];

    for (const item of parsed) {
      if (item && typeof item === "object" && item.title && item.link) {
        const id = item.id || `ql-import-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!existingMap.has(id)) {
          const newItem: Quicklink = {
            id,
            title: String(item.title).trim(),
            link: String(item.link).trim(),
            keyword: item.keyword ? String(item.keyword).trim() : undefined,
            description: item.description ? String(item.description).trim() : undefined,
            defaultArgument: item.defaultArgument ? String(item.defaultArgument).trim() : undefined,
            icon: item.icon ? String(item.icon) : "globe",
            openCount: Number(item.openCount) || 0,
            createdAt: Number(item.createdAt) || Date.now(),
            updatedAt: Date.now()
          };
          merged.push(newItem);
          existingMap.set(id, newItem);
          importedCount++;
        }
      }
    }

    return {
      success: true,
      importedCount,
      result: merged
    };
  } catch (err: any) {
    return {
      success: false,
      importedCount: 0,
      result: existing,
      error: err?.message || "无法解析输入的 JSON 格式"
    };
  }
}
