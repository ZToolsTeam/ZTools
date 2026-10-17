import { LocalStorage } from "../../api/storage.js";
import { getDeclarativeBridge } from "../../api/bridge.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";
import {
  Snippet,
  SnippetArgumentDescriptor,
  SnippetFilterOptions,
  SnippetMacroContext,
  MacroExpandResult,
  SnippetImportExportResult
} from "./types.js";

const STORAGE_KEY = "ztools:snippets:list";

export const SAMPLE_SNIPPETS: Snippet[] = [
  {
    id: "snip-1",
    name: "工作邮箱快速输入",
    keyword: ":mail",
    snippet: "developer@ztools.org",
    enabled: true,
    category: "Communication",
    isPinned: true,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 7
  },
  {
    id: "snip-2",
    name: "经典耸肩表情包",
    keyword: ":shrug",
    snippet: "¯\\_(ツ)_/¯",
    enabled: true,
    category: "Fun",
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 5,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 5
  },
  {
    id: "snip-3",
    name: "每日日记时间戳模板",
    keyword: ":journal",
    snippet: "### 📅 日记记录 [{date} {time}]\n\n- 今日重点: {cursor}\n- 剪贴板参考: {clipboard}\n",
    enabled: true,
    category: "Productivity",
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2
  },
  {
    id: "snip-4",
    name: "TypeScript 控制台日志",
    keyword: ":clog",
    snippet: "console.log(\"[DEBUG] {date}\", {cursor});",
    enabled: true,
    category: "Development",
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24
  },
  {
    id: "snip-5",
    name: "停用的历史代码片段",
    keyword: ":legacy",
    snippet: "// Deprecated shim code",
    enabled: false,
    category: "Development",
    isPinned: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 30,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 30
  },
  {
    id: "snip-6",
    name: "版本发布通知模板 (含动态参数)",
    keyword: ":deploy",
    snippet: "🚀 服务 [{argument name=\"服务名\" default=\"ztools-core\"}] 已发布至 {argument name=\"环境\" default=\"production\" options=\"development, staging, production\"} 环境，操作人：{argument name=\"发布人\"}。",
    enabled: true,
    category: "Development",
    isPinned: true,
    createdAt: Date.now() - 1000 * 60 * 60 * 12,
    updatedAt: Date.now() - 1000 * 60 * 60 * 12
  }
];

function formatDateWithFormat(date: Date, fmt: string): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return fmt
    .replace(/YYYY/g, year)
    .replace(/MM/g, month)
    .replace(/DD/g, day)
    .replace(/HH/g, hours)
    .replace(/mm/g, minutes)
    .replace(/ss/g, seconds);
}

/**
 * 解析模板中的 {argument name="..." default="..." options="..." type="..."} 动态参数列表（同名参数自动去重合并）
 */
export function parseSnippetArguments(template: string): SnippetArgumentDescriptor[] {
  if (!template || typeof template !== "string") return [];

  const results: SnippetArgumentDescriptor[] = [];
  const seen = new Map<string, SnippetArgumentDescriptor>();
  const pattern = /\{argument(?:\s+([^}]*))?\}/gi;

  let match: RegExpExecArray | null;
  let fallbackIndex = 1;

  while ((match = pattern.exec(template)) !== null) {
    const attrStr = (match[1] || "").trim();
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrStr)) !== null) {
      const k = (m[1] || "").toLowerCase();
      const v = m[2] ?? m[3] ?? m[4] ?? "";
      attrs[k] = v;
    }

    const name = (attrs.name || `Argument ${fallbackIndex++}`).trim();
    const defaultValue = attrs.default ?? "";
    const options = attrs.options
      ? attrs.options
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    let type: "text" | "password" | "dropdown" = "text";
    if (options.length > 0 || attrs.type === "dropdown") {
      type = "dropdown";
    } else if (attrs.type === "password" || /password|secret|token|key|密码|密钥/i.test(name)) {
      type = "password";
    }

    const required = attrs.optional !== "true" && attrs.required !== "false";

    if (!seen.has(name)) {
      const desc: SnippetArgumentDescriptor = {
        name,
        type,
        defaultValue: defaultValue || (options[0] ?? ""),
        options,
        required
      };
      seen.set(name, desc);
      results.push(desc);
    } else {
      const existing = seen.get(name)!;
      if (!existing.defaultValue && defaultValue) {
        existing.defaultValue = defaultValue;
      }
      if (existing.options.length === 0 && options.length > 0) {
        existing.options = options;
        existing.type = "dropdown";
      }
    }
  }

  return results;
}

export function hasSnippetArguments(template: string): boolean {
  return parseSnippetArguments(template).length > 0;
}

/**
 * 动态宏展开解析引擎 (Dynamic Macro Engine)
 * 完整对齐 Raycast 官方宏标准：
 * - {clipboard} : 当前剪贴板文本
 * - {date} / {date format="YYYY-MM-DD"} : 格式化日期
 * - {time} / {time format="HH:mm:ss"} : 格式化时间
 * - {datetime} : 完整日期时间 (YYYY-MM-DD HH:mm:ss)
 * - {year} / {month} / {day} : 年月日独立片段
 * - {uuid} : 标准 UUID v4 随机串
 * - {cursor} : 光标重定位落点（自动计算从末尾往左回退字符数）
 * - {argument name="..." default="..." options="..."} / {query} : 动态变量提示插入
 */
export function expandSnippetTemplate(
  template: string,
  clipboardContent = "",
  context: SnippetMacroContext = {}
): MacroExpandResult {
  if (!template || typeof template !== "string") {
    return { expanded: "", cursorOffset: 0, hasCursor: false, arguments: [] };
  }

  const parsedArguments = parseSnippetArguments(template);
  const argDefaults = new Map<string, string>();
  for (const a of parsedArguments) {
    argDefaults.set(a.name, a.defaultValue);
  }

  const effectiveClipboard = context.clipboard !== undefined ? context.clipboard : clipboardContent;
  const now = context.now || new Date();
  const yearStr = String(now.getFullYear());
  const monthStr = String(now.getMonth() + 1).padStart(2, "0");
  const dayStr = String(now.getDate()).padStart(2, "0");
  const hoursStr = String(now.getHours()).padStart(2, "0");
  const minutesStr = String(now.getMinutes()).padStart(2, "0");
  const secondsStr = String(now.getSeconds()).padStart(2, "0");

  const defaultDateStr = `${yearStr}-${monthStr}-${dayStr}`;
  const defaultTimeStr = `${hoursStr}:${minutesStr}:${secondsStr}`;
  const defaultDateTimeStr = `${defaultDateStr} ${defaultTimeStr}`;

  let result = "";
  let cursorIdx = -1;
  let hasCursor = false;
  let fallbackArgIdx = 1;

  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const close = template.indexOf("}", i);
      if (close !== -1) {
        const rawToken = template.slice(i + 1, close).trim();
        const tokenLower = rawToken.toLowerCase();

        // 1. {clipboard}
        if (tokenLower === "clipboard") {
          result += effectiveClipboard;
          i = close + 1;
          continue;
        }

        // 2. {date ...}
        if (tokenLower === "date") {
          result += defaultDateStr;
          i = close + 1;
          continue;
        }
        const dateFormatMatch = rawToken.match(/^date\s+format=["']([^"']+)["']/i);
        if (dateFormatMatch) {
          result += formatDateWithFormat(now, dateFormatMatch[1]);
          i = close + 1;
          continue;
        }

        // 3. {time ...}
        if (tokenLower === "time") {
          result += defaultTimeStr;
          i = close + 1;
          continue;
        }
        const timeFormatMatch = rawToken.match(/^time\s+format=["']([^"']+)["']/i);
        if (timeFormatMatch) {
          result += formatDateWithFormat(now, timeFormatMatch[1]);
          i = close + 1;
          continue;
        }

        // 4. {datetime}
        if (tokenLower === "datetime") {
          result += defaultDateTimeStr;
          i = close + 1;
          continue;
        }

        // 5. {year}, {month}, {day}
        if (tokenLower === "year") {
          result += yearStr;
          i = close + 1;
          continue;
        }
        if (tokenLower === "month") {
          result += monthStr;
          i = close + 1;
          continue;
        }
        if (tokenLower === "day") {
          result += dayStr;
          i = close + 1;
          continue;
        }

        // 6. {uuid}
        if (tokenLower === "uuid") {
          const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
          result += uuid;
          i = close + 1;
          continue;
        }

        // 7. {cursor} (只记录第一个 cursor 所在位置，后续 cursor 剔除)
        if (tokenLower === "cursor") {
          if (!hasCursor) {
            cursorIdx = result.length;
            hasCursor = true;
          }
          i = close + 1;
          continue;
        }

        // 8. {argument ...} or {query}
        if (/^argument(?:\s+|$)/i.test(rawToken)) {
          const attrStr = rawToken.replace(/^argument/i, "").trim();
          const attrs: Record<string, string> = {};
          const attrRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g;
          let m: RegExpExecArray | null;
          while ((m = attrRegex.exec(attrStr)) !== null) {
            const k = (m[1] || "").toLowerCase();
            const v = m[2] ?? m[3] ?? m[4] ?? "";
            attrs[k] = v;
          }
          const argName = (attrs.name || `Argument ${fallbackArgIdx++}`).trim();
          const provided = context.args?.[argName];
          if (provided !== undefined && provided !== "") {
            result += String(provided);
          } else {
            const def = attrs.default ?? argDefaults.get(argName) ?? "";
            if (def !== "") {
              result += def;
            } else if (context.previewPlaceholders) {
              result += `[${argName}]`;
            }
          }
          i = close + 1;
          continue;
        }
        if (tokenLower === "query") {
          const argVal = context.args?.query ?? "";
          result += argVal;
          i = close + 1;
          continue;
        }
      }
    }
    result += template[i];
    i++;
  }

  const cursorOffset = (hasCursor && cursorIdx >= 0) ? Math.max(0, result.length - cursorIdx) : 0;
  return { expanded: result, cursorOffset, hasCursor, arguments: parsedArguments };
}

/**
 * 获取所有 Snippets (优先宿主 IPC / SQLite，次选 Bridge，兜底 LocalStorage)
 */
export async function getSnippets(): Promise<Snippet[]> {
  // 1. window.ztools 原生 IPC
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_list) {
    try {
      const records = await (window as any).ztools.snippets_list();
      if (Array.isArray(records) && records.length > 0) {
        return records.map((r: any) => ({
          id: r.id,
          name: r.name,
          keyword: r.keyword,
          snippet: r.snippet,
          enabled: Boolean(r.enabled),
          category: r.category,
          isPinned: Boolean(r.isPinned ?? r.is_pinned),
          createdAt: r.created_at || r.createdAt || Date.now(),
          updatedAt: r.updated_at || r.updatedAt || Date.now()
        }));
      }
    } catch {
      // 优雅降级
    }
  }

  // 2. Preload Transport
  if (isRealElectronHost()) {
    try {
      const ipcRes = await callHostTransport<any>("snippets_list", {});
      if (ipcRes.ok && ipcRes.data) {
        const list = Array.isArray(ipcRes.data)
          ? ipcRes.data
          : Array.isArray(ipcRes.data?.snippets)
          ? ipcRes.data.snippets
          : [];
        if (list.length > 0) {
          return list.map((r: any) => ({
            id: String(r.id),
            name: String(r.name),
            keyword: String(r.keyword),
            snippet: String(r.snippet),
            enabled: Boolean(r.enabled ?? true),
            category: r.category,
            isPinned: Boolean(r.isPinned ?? r.is_pinned),
            createdAt: Number(r.created_at || r.createdAt) || Date.now(),
            updatedAt: Number(r.updated_at || r.updatedAt) || Date.now()
          }));
        }
      }
    } catch {
      // 优雅降级
    }
  }

  // 3. Bridge
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.list) {
    try {
      const records = await bridge.snippets.list();
      if (Array.isArray(records) && records.length > 0) {
        return records.map((r: any) => ({
          id: r.id,
          name: r.name,
          keyword: r.keyword,
          snippet: r.snippet,
          enabled: Boolean(r.enabled),
          category: r.category,
          isPinned: Boolean(r.isPinned ?? r.is_pinned),
          createdAt: r.created_at || r.createdAt || Date.now(),
          updatedAt: r.updated_at || r.updatedAt || Date.now()
        }));
      }
    } catch {
      // 优雅降级
    }
  }

  // 4. LocalStorage
  try {
    const raw = await LocalStorage.getItem(STORAGE_KEY);
    if (!raw) {
      await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_SNIPPETS));
      return SAMPLE_SNIPPETS;
    }
    return JSON.parse(raw);
  } catch {
    return SAMPLE_SNIPPETS;
  }
}

/**
 * 保存 Snippets 列表
 */
export async function saveSnippets(snippets: Snippet[]): Promise<void> {
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
}

/**
 * 快捷创建 Snippet (带后端直连同步)
 */
export async function createSnippetService(snippet: Partial<Snippet>): Promise<Snippet> {
  const newSnippet: Snippet = {
    id: snippet.id || `snip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: snippet.name || "未命名短语",
    keyword: snippet.keyword || "",
    snippet: snippet.snippet || "",
    enabled: snippet.enabled !== false,
    category: snippet.category,
    isPinned: Boolean(snippet.isPinned),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  // 1. window.ztools
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_create) {
    try {
      await (window as any).ztools.snippets_create(newSnippet);
    } catch {}
  }
  if (isRealElectronHost()) {
    try {
      await callHostTransport("snippets_create", newSnippet as any);
    } catch {}
  }
  // 2. Bridge
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.create) {
    try {
      await bridge.snippets.create(newSnippet);
    } catch {}
  }

  return newSnippet;
}

/**
 * 更新 Snippet
 */
export async function updateSnippetService(id: string, updates: Partial<Snippet>): Promise<void> {
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_update) {
    try {
      await (window as any).ztools.snippets_update({ id, ...updates });
    } catch {}
  }
  if (isRealElectronHost()) {
    try {
      await callHostTransport("snippets_update", { id, ...updates });
    } catch {}
  }
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.update) {
    try {
      await bridge.snippets.update(id, updates);
    } catch {}
  }
}

/**
 * 删除 Snippet
 */
export async function deleteSnippetService(id: string): Promise<boolean> {
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_delete) {
    try {
      return await (window as any).ztools.snippets_delete({ id });
    } catch {}
  }
  if (isRealElectronHost()) {
    try {
      const res = await callHostTransport("snippets_delete", { id });
      if (res.ok) return true;
    } catch {}
  }
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.delete) {
    try {
      return await bridge.snippets.delete(id);
    } catch {}
  }
  return false;
}

/**
 * 切换 Snippet 状态
 */
export async function toggleSnippetService(id: string): Promise<boolean> {
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_toggle) {
    try {
      return await (window as any).ztools.snippets_toggle({ id });
    } catch {}
  }
  if (isRealElectronHost()) {
    try {
      const res = await callHostTransport("snippets_toggle", { id });
      if (res.ok) return true;
    } catch {}
  }
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.toggle) {
    try {
      return await bridge.snippets.toggle(id);
    } catch {}
  }
  return false;
}

/**
 * 导出全部短语为 JSON 字符串
 */
export async function exportSnippetsJSON(currentSnippets?: Snippet[]): Promise<string> {
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_export) {
    try {
      const records = await (window as any).ztools.snippets_export();
      if (Array.isArray(records)) {
        return JSON.stringify(records, null, 2);
      }
    } catch {}
  }
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.export) {
    try {
      const records = await bridge.snippets.export();
      if (Array.isArray(records)) {
        return JSON.stringify(records, null, 2);
      }
    } catch {}
  }
  const items = currentSnippets || (await getSnippets());
  return JSON.stringify(items, null, 2);
}

/**
 * 批量导入短语
 */
export async function importSnippetsJSON(
  rawInput: string | Snippet[],
  currentSnippets: Snippet[]
): Promise<SnippetImportExportResult> {
  let list: any[];
  if (typeof rawInput === "string") {
    try {
      list = JSON.parse(rawInput);
    } catch (err: any) {
      return { total: 0, imported: 0, updated: 0, failed: 1, errors: [`JSON 语法无效: ${err.message}`] };
    }
  } else {
    list = rawInput;
  }

  if (!Array.isArray(list)) {
    return { total: 0, imported: 0, updated: 0, failed: 1, errors: ["导入的数据必须是数组格式"] };
  }

  // 1. window.ztools
  if (typeof window !== "undefined" && (window as any).ztools?.snippets_import) {
    try {
      const res = await (window as any).ztools.snippets_import({ data: list });
      if (res) return res;
    } catch {}
  }

  // 2. Bridge
  const bridge = getDeclarativeBridge();
  if (bridge?.snippets?.import) {
    try {
      const res = await bridge.snippets.import(list);
      if (res) return res;
    } catch {}
  }

  // 3. 本地合并导入
  let imported = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  const merged = [...currentSnippets];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object" || !item.name || !item.keyword || !item.snippet) {
      failed++;
      errors.push(`第 ${i + 1} 项数据格式不全 (必须包含 name, keyword, snippet)`);
      continue;
    }

    const existingIdx = merged.findIndex(s => s.keyword === item.keyword || (item.id && s.id === item.id));
    if (existingIdx !== -1) {
      merged[existingIdx] = {
        ...merged[existingIdx],
        name: String(item.name).trim(),
        snippet: String(item.snippet),
        category: item.category || merged[existingIdx].category,
        enabled: item.enabled !== false,
        updatedAt: Date.now()
      };
      updated++;
    } else {
      merged.push({
        id: item.id || `snip-${Date.now()}-${i}`,
        name: String(item.name).trim(),
        keyword: String(item.keyword).trim(),
        snippet: String(item.snippet),
        enabled: item.enabled !== false,
        category: item.category,
        isPinned: Boolean(item.isPinned),
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      imported++;
    }
  }

  await saveSnippets(merged);
  return {
    total: list.length,
    imported,
    updated,
    failed,
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * 筛选与排序 Snippets
 */
export function filterSnippets(snippets: Snippet[], options: SnippetFilterOptions): Snippet[] {
  let result = [...snippets];

  if (options.enabledOnly) {
    result = result.filter(s => s.enabled);
  }

  if (options.category && options.category !== "all") {
    result = result.filter(s => s.category === options.category);
  }

  if (options.query && options.query.trim()) {
    const q = options.query.trim().toLowerCase();
    result = result.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.keyword.toLowerCase().includes(q) ||
      s.snippet.toLowerCase().includes(q) ||
      (s.category && s.category.toLowerCase().includes(q))
    );
  }

  // Sort: isPinned first, then enabled first, then name ascending
  result.sort((a, b) => {
    if (Boolean(a.isPinned) !== Boolean(b.isPinned)) {
      return a.isPinned ? -1 : 1;
    }
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return result;
}
