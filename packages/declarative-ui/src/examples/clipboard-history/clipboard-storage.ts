import { LocalStorage } from "../../api/storage.js";
import { getDeclarativeBridge } from "../../api/bridge.js";
import { Clipboard } from "../../api/clipboard.js";
import {
  callHostTransport,
  isRealElectronHost,
  readRealClipboardText,
  writeRealClipboardText
} from "../shared/native-ipc.js";
import {
  ClipboardItem,
  ClipboardFilterOptions,
  ClipboardContentType,
  ClipboardPreferences,
  PasteSequenceState
} from "./types.js";

const STORAGE_KEY = "ztools:clipboard:history";
const PREFS_STORAGE_KEY = "ztools:clipboard:preferences";
const SAMPLE_IDS = new Set(["clip-1", "clip-2", "clip-3", "clip-4", "clip-5"]);

/**
 * 计算字符串的香农信息熵 (Shannon Entropy)
 * 用于高熵密码、API Key、Token 脱敏识别
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * 敏感内容安全脱敏识别与遮罩 (OpenAI Key, GitHub Token, AWS, Private Key, JWT, High-Entropy Passwords)
 */
export function maskSensitiveContent(text: string): { isSensitive: boolean; masked: string; reason?: string } {
  if (!text || typeof text !== "string") {
    return { isSensitive: false, masked: text };
  }

  let masked = text;
  let isSensitive = false;
  let reason: string | undefined;

  // 1. OpenAI / Anthropic / AI API Keys (sk-..., sk-ant-...)
  if (/sk-[a-zA-Z0-9_-]{20,}/.test(masked) || /sk-ant-[a-zA-Z0-9_-]{20,}/.test(masked)) {
    isSensitive = true;
    reason = "API Key";
    masked = masked.replace(/(sk-(?:ant-)?[a-zA-Z0-9]{4})[a-zA-Z0-9_-]{12,}([a-zA-Z0-9]{4})/g, "$1••••••••$2");
  }

  // 2. GitHub Personal Access Token (ghp_..., gho_..., github_pat_...)
  if (/gh[pousr]_[a-zA-Z0-9]{20,}/.test(masked) || /github_pat_[a-zA-Z0-9_]{20,}/.test(masked)) {
    isSensitive = true;
    reason = "GitHub Token";
    masked = masked.replace(/(gh[pousr]_[a-zA-Z0-9]{4})[a-zA-Z0-9]{16,}([a-zA-Z0-9]{4})/g, "$1••••••••$2");
  }

  // 3. AWS Access Key (AKIA...)
  if (/AKIA[0-9A-Z]{16}/.test(masked)) {
    isSensitive = true;
    reason = "AWS Access Key";
    masked = masked.replace(/(AKIA[0-9A-Z]{4})[0-9A-Z]{8}([0-9A-Z]{4})/g, "$1••••••••$2");
  }

  // 4. RSA / EC Private Keys
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(masked)) {
    isSensitive = true;
    reason = "Private Key";
    masked = masked.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[^]+?-----END [A-Z ]+PRIVATE KEY-----/g, "[PROTECTED PRIVATE KEY ••••••••]");
  }

  // 5. JWT Tokens
  if (/ey[A-Za-z0-9_-]{12,}\.ey[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}/.test(masked)) {
    isSensitive = true;
    reason = "JWT Token";
    masked = masked.replace(/(ey[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}(\.ey[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{4,}/g, "$1••••$2••••$3••••");
  }

  // 6. High-entropy single-token secrets
  const trimmed = text.trim();
  if (!isSensitive && trimmed.length >= 16 && trimmed.length <= 128 && !/\s/.test(trimmed)) {
    const entropy = calculateShannonEntropy(trimmed);
    if (entropy >= 3.6) {
      isSensitive = true;
      reason = "High-Entropy Secret";
      const start = trimmed.slice(0, 4);
      const end = trimmed.slice(-4);
      masked = `${start}••••••••${end}`;
    }
  }

  return { isSensitive, masked, reason };
}

/**
 * 智能识别剪贴板内容类型 (Smart Content Detection)
 */
export function detectClipboardContentType(content: string, rawFormat?: string): ClipboardContentType {
  if (rawFormat === "image" || content.startsWith("data:image/")) return "image";
  if (rawFormat === "files") return "files";

  const trimmed = content.trim();

  // 1. 颜色代码检测
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    return "color";
  }
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,]+\)$/i.test(trimmed)) {
    return "color";
  }

  // 2. 链接检测
  if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    return "link";
  }

  // 3. JSON 数据检测
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON
    }
  }

  // 4. 代码结构检测
  const codePatterns = [
    /\b(?:const|let|var|function|class|import|export|interface|type)\s+[a-zA-Z0-9_$]+/,
    /\b(?:def|public|private|protected|void|int|return|async|await)\b/,
    /=>|\{|\};|<!--|<div|<\/|console\.log/,
    /\b(?:fn|pub|impl|struct|enum|match)\b/
  ];
  if (codePatterns.some((p) => p.test(content)) && (content.includes("\n") || content.includes("{"))) {
    return "code";
  }

  // 5. Windows / Unix 文件路径检测
  if (/^[a-zA-Z]:\\[^\0\n]+/.test(trimmed) || (trimmed.startsWith("/") && trimmed.includes("/"))) {
    if (!trimmed.includes(" ") || trimmed.includes("\\")) {
      return "files";
    }
  }

  return "text";
}

/**
 * 解析颜色详情并计算换算值
 */
export function parseColorDetails(colorStr: string): { hex: string; rgb: string; hsl: string } | null {
  const trimmed = colorStr.trim();
  if (/^#[0-9a-fA-F]{6}$/i.test(trimmed)) {
    const r = parseInt(trimmed.slice(1, 3), 16);
    const g = parseInt(trimmed.slice(3, 5), 16);
    const b = parseInt(trimmed.slice(5, 7), 16);
    return {
      hex: trimmed.toUpperCase(),
      rgb: `rgb(${r}, ${g}, ${b})`,
      hsl: `hsl(${Math.round((r / 255) * 360)}, 100%, 50%)`
    };
  }
  if (/^#[0-9a-fA-F]{3}$/i.test(trimmed)) {
    const r = parseInt(trimmed[1] + trimmed[1], 16);
    const g = parseInt(trimmed[2] + trimmed[2], 16);
    const b = parseInt(trimmed[3] + trimmed[3], 16);
    const fullHex = `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toUpperCase();
    return {
      hex: fullHex,
      rgb: `rgb(${r}, ${g}, ${b})`,
      hsl: `hsl(${Math.round((r / 255) * 360)}, 100%, 50%)`
    };
  }
  return null;
}

export const SAMPLE_CLIPBOARD_ITEMS: ClipboardItem[] = [
  {
    id: "clip-1",
    type: "code",
    content: "function calculateFrecency(views: number, lastViewed: number): number {\n  const decay = Math.exp(-(Date.now() - lastViewed) / (86400000 * 7));\n  return views * decay;\n}",
    preview: "function calculateFrecency(views: number, lastViewed: number)...",
    copiedAt: Date.now() - 1000 * 10, // 10s ago, most recent pinned item
    pinned: true,
    charCount: 168,
    wordCount: 18,
    lineCount: 4,
    sourceAppName: "VSCode"
  },
  {
    id: "clip-color-1",
    type: "color",
    content: "#3B82F6",
    preview: "颜色代码 #3B82F6 (Tailwind Blue 500)",
    colorHex: "#3B82F6",
    copiedAt: Date.now() - 1000 * 60 * 2, // 2 mins ago
    pinned: true,
    charCount: 7,
    wordCount: 1,
    lineCount: 1,
    sourceAppName: "Figma"
  },
  {
    id: "clip-json-1",
    type: "json",
    content: JSON.stringify({ name: "ZTools", version: "1.1.7", architecture: "Electron 43 + Rust Sidecar", features: ["MFT-Search", "UIAccess", "Declarative-UI"] }, null, 2),
    preview: "JSON 配置: { name: 'ZTools', version: '1.1.7'... }",
    copiedAt: Date.now() - 1000 * 60 * 5, // 5 mins ago
    pinned: false,
    charCount: 152,
    wordCount: 12,
    lineCount: 7,
    sourceAppName: "Terminal"
  },
  {
    id: "clip-2",
    type: "link",
    content: "https://github.com/microsoft/terminal",
    preview: "https://github.com/microsoft/terminal",
    copiedAt: Date.now() - 1000 * 60 * 15, // 15 mins ago
    pinned: false,
    charCount: 38,
    wordCount: 1,
    lineCount: 1,
    sourceAppName: "Edge"
  },
  {
    id: "clip-3",
    type: "text",
    content: "ZTools Windows 剪贴板历史与现代化架构解构：轻量 TypeScript 宿主通过命名管道调度 Rust UIAccess 特权进程与 NTFS MFT 极速索引引擎。",
    preview: "ZTools Windows 剪贴板历史与现代化架构解构：轻量 TypeScript 宿主通过命名管道调度...",
    copiedAt: Date.now() - 1000 * 60 * 45, // 45 mins ago
    pinned: false,
    charCount: 84,
    wordCount: 22,
    lineCount: 1,
    sourceAppName: "Notion"
  },
  {
    id: "clip-4",
    type: "files",
    content: "C:\\Windows\\System32\\drivers\\etc\\hosts\nC:\\Windows\\System32\\cmd.exe",
    preview: "2 个系统文件 (hosts, cmd.exe)",
    copiedAt: Date.now() - 1000 * 60 * 120, // 2 hours ago
    pinned: false,
    filePaths: [
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "C:\\Windows\\System32\\cmd.exe"
    ],
    charCount: 65,
    wordCount: 2,
    lineCount: 2,
    sourceAppName: "Explorer"
  },
  {
    id: "clip-5",
    type: "image",
    content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    preview: "屏幕截图 [1920x1080 PNG]",
    copiedAt: Date.now() - 1000 * 60 * 360, // 6 hours ago
    pinned: false,
    imageDimensions: { width: 1920, height: 1080 },
    sourceAppName: "Snipaste"
  }
];

// 简单轻量拼音首字母映射辅助 (用于支持剪贴板常用中文首字母拼音快速检索)
const PINYIN_INITIALS_MAP: Record<string, string> = {
  剪: "j", 贴: "t", 板: "b", 历: "l", 史: "s",
  快: "k", 捷: "j", 短: "d", 语: "y", 设: "s", 置: "z",
  颜: "y", 色: "s", 代: "d", 码: "m", 文: "w", 件: "j",
  链: "l", 接: "j", 图: "t", 片: "p", 纯: "c", 本: "b",
  深: "s", 度: "d", 逆: "n", 向: "x", 解: "j", 构: "g"
};

function getPinyinInitials(str: string): string {
  let initials = "";
  for (const ch of str) {
    if (PINYIN_INITIALS_MAP[ch]) {
      initials += PINYIN_INITIALS_MAP[ch];
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      initials += ch.toLowerCase();
    }
  }
  return initials;
}

/**
 * 流水粘贴状态机 (Raycast 对齐实现)
 */
export class PasteSequenceManager {
  private offset = 0;
  private lastInvocation: number | null = null;
  private topItemId: string | null = null;
  private timeoutSeconds = 60;

  constructor(timeoutSeconds = 60) {
    this.timeoutSeconds = timeoutSeconds;
  }

  public setTimeoutSeconds(timeout: number): void {
    this.timeoutSeconds = timeout;
  }

  public pasteNext(
    items: ClipboardItem[],
    options: { addNewLine?: boolean } = {}
  ): {
    item: ClipboardItem | null;
    remaining: number;
    offset: number;
  } {
    const now = Date.now();
    if (this.lastInvocation && now - this.lastInvocation > this.timeoutSeconds * 1000) {
      this.offset = 0;
    }

    const topItem = items[0] ?? null;
    if (topItem && topItem.id !== this.topItemId) {
      this.offset = 0;
      this.topItemId = topItem.id;
    }
    this.lastInvocation = now;

    if (this.offset >= items.length) {
      this.offset = 0;
      return { item: null, remaining: 0, offset: 0 };
    }

    const item = items[this.offset];
    this.offset += 1;
    const remaining = items.length - this.offset;
    return { item, remaining, offset: this.offset };
  }

  public reset(): void {
    this.offset = 0;
    this.lastInvocation = null;
    this.topItemId = null;
  }

  public getState(): PasteSequenceState {
    return {
      offset: this.offset,
      lastInvocation: this.lastInvocation,
      topItemId: this.topItemId
    };
  }
}

export const pasteSequenceManager = new PasteSequenceManager();

function mapRawClipboardRecord(r: any, idx = 0): ClipboardItem {
  const content = String(r?.content ?? r?.text ?? "");
  const formatType = String(r?.format_type ?? r?.type ?? "text");
  const detectedType =
    formatType === "image"
      ? "image"
      : formatType === "files"
      ? "files"
      : detectClipboardContentType(content, formatType);
  return {
    id: String(r?.id || `clip-host-${idx}-${Date.now()}`),
    type: detectedType,
    content,
    preview: String(r?.text_preview || r?.preview || content.replace(/\s+/g, " ").slice(0, 100)),
    copiedAt: Number(r?.created_at ?? r?.copiedAt) || Date.now(),
    pinned: Boolean(r?.is_pinned ?? r?.pinned),
    charCount: Number(r?.char_count ?? r?.charCount ?? content.length),
    wordCount: Number(r?.word_count ?? r?.wordCount) || undefined,
    lineCount: Number(r?.line_count ?? r?.lineCount ?? content.split(/\r?\n/).length),
    sourceAppName: r?.source_app_name ?? r?.sourceAppName ?? undefined,
    sourceAppPath: r?.source_app_path ?? r?.sourceAppPath ?? undefined,
    filePaths: Array.isArray(r?.filePaths) ? r.filePaths : undefined
  };
}

/**
 * 获取真实或本地剪贴板历史
 */
export async function getClipboardHistory(hostOverride?: any): Promise<ClipboardItem[]> {
  const realHost = isRealElectronHost(hostOverride);

  // 1. 尝试通过 window.ztools 原生 IPC 接口读取
  if (typeof window !== "undefined" && (window as any).ztools?.clipboard_history_query) {
    try {
      const records = await (window as any).ztools.clipboard_history_query({ limit: 100 });
      if (Array.isArray(records) && records.length > 0) {
        return records.map((r: any, i: number) => mapRawClipboardRecord(r, i));
      }
    } catch {
      // 优雅降级
    }
  }

  // 2. 尝试通过 Preload Transport (clipboard_history_query) 读取
  if (hostOverride || realHost) {
    try {
      const ipcRes = await callHostTransport<any>(
        "clipboard_history_query",
        { limit: 100 },
        hostOverride
      );
      if (ipcRes.ok && ipcRes.data !== undefined) {
        const list = Array.isArray(ipcRes.data)
          ? ipcRes.data
          : Array.isArray(ipcRes.data?.items)
          ? ipcRes.data.items
          : Array.isArray(ipcRes.data?.records)
          ? ipcRes.data.records
          : [];
        if (list.length > 0) {
          return list.map((r: any, i: number) => mapRawClipboardRecord(r, i));
        }
      }
    } catch {
      // 优雅降级
    }
  }

  // 3. 尝试通过 DeclarativeBridge 读取
  const bridge = getDeclarativeBridge();
  if (bridge?.clipboardHistory?.query) {
    try {
      const records = await bridge.clipboardHistory.query({ limit: 100 });
      if (Array.isArray(records) && records.length > 0) {
        return records.map((r: any, i: number) => mapRawClipboardRecord(r, i));
      }
    } catch {
      // 优雅降级
    }
  }

  // 4. 在真实 Electron 宿主或显式传入 hostOverride 时，若历史数据库当前为空，主动读取当前操作系统剪贴板真实内容并拒绝假数据
  if (realHost || hostOverride) {
    let realStored: ClipboardItem[] = [];
    try {
      const raw = await LocalStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
          realStored = parsed.filter(
            (item: any) =>
              item &&
              !SAMPLE_IDS.has(String(item.id)) &&
              !String(item.id).startsWith("clip-color-") &&
              !String(item.id).startsWith("clip-json-")
          );
        }
      }
    } catch {
      // ignore
    }

    try {
      const liveText = await readRealClipboardText(hostOverride);
      const trimmed = (liveText || "").trim();
      if (trimmed) {
        const alreadyExists = realStored.some((item) => item.content === liveText);
        if (!alreadyExists) {
          const liveItem: ClipboardItem = {
            id: `clip-live-${Date.now()}`,
            type: detectClipboardContentType(liveText),
            content: liveText,
            preview: trimmed.replace(/\s+/g, " ").slice(0, 100),
            copiedAt: Date.now(),
            pinned: false,
            charCount: liveText.length,
            lineCount: liveText.split(/\r?\n/).length,
            sourceAppName: "System Clipboard"
          };
          realStored = [liveItem, ...realStored];
          await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(realStored));
          void callHostTransport("clipboard_history_add", { content: liveText }, hostOverride);
        }
      }
    } catch {
      // ignore
    }

    return realStored;
  }

  // 5. 离线/单元测试环境兜底 LocalStorage 读取
  try {
    const raw = await LocalStorage.getItem(STORAGE_KEY);
    if (!raw) {
      await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_CLIPBOARD_ITEMS));
      return SAMPLE_CLIPBOARD_ITEMS;
    }
    return JSON.parse(raw);
  } catch {
    return SAMPLE_CLIPBOARD_ITEMS;
  }
}

/**
 * 主动读取当前系统剪贴板并写入历史记录
 */
export async function syncCurrentSystemClipboard(
  currentItems: ClipboardItem[] = [],
  hostOverride?: any
): Promise<{ added: boolean; item?: ClipboardItem; items: ClipboardItem[] }> {
  const liveText = await readRealClipboardText(hostOverride);
  if (!liveText || !liveText.trim()) {
    return { added: false, items: currentItems };
  }
  const existing = currentItems.find((i) => i.content === liveText);
  if (existing) {
    const updatedItem = { ...existing, copiedAt: Date.now() };
    const next = [updatedItem, ...currentItems.filter((i) => i.id !== existing.id)];
    await saveClipboardHistory(next);
    return { added: false, item: updatedItem, items: next };
  }
  const newItem: ClipboardItem = {
    id: `clip-${Date.now()}`,
    type: detectClipboardContentType(liveText),
    content: liveText,
    preview: liveText.trim().replace(/\s+/g, " ").slice(0, 100),
    copiedAt: Date.now(),
    pinned: false,
    charCount: liveText.length,
    lineCount: liveText.split(/\r?\n/).length,
    sourceAppName: "System Clipboard"
  };
  if (hostOverride || isRealElectronHost(hostOverride)) {
    void callHostTransport("clipboard_history_add", { content: liveText }, hostOverride);
  }
  const next = [newItem, ...currentItems];
  await saveClipboardHistory(next);
  return { added: true, item: newItem, items: next };
}

/**
 * 保存剪贴板历史列表到本地缓存
 */
export async function saveClipboardHistory(items: ClipboardItem[]): Promise<void> {
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

/**
 * 切换条目置顶状态
 */
export async function toggleClipboardItemPin(id: string, hostOverride?: any): Promise<boolean> {
  if (!id || typeof id !== "string" || !id.trim()) return false;
  // 1. window.ztools
  if (typeof window !== "undefined" && (window as any).ztools?.clipboard_history_toggle_pin) {
    try {
      return await (window as any).ztools.clipboard_history_toggle_pin({ id });
    } catch {}
  }
  if (hostOverride || isRealElectronHost(hostOverride)) {
    try {
      const res = await callHostTransport<any>("clipboard_history_toggle_pin", { id }, hostOverride);
      if (res.ok && res.data?.ok !== false) return Boolean(res.data ?? true);
      return false;
    } catch {
      return false;
    }
  }
  // 2. Bridge
  const bridge = getDeclarativeBridge();
  if (bridge?.clipboardHistory?.togglePin) {
    try {
      return await bridge.clipboardHistory.togglePin(id);
    } catch {}
  }
  // 3. LocalStorage fallback
  try {
    const items = await getClipboardHistory();
    let newState = false;
    const updated = items.map(item => {
      if (item.id === id) {
        newState = !item.pinned;
        return { ...item, pinned: newState };
      }
      return item;
    });
    await saveClipboardHistory(updated);
    return newState;
  } catch {
    return false;
  }
}

/**
 * 删除剪贴板单条记录
 */
export async function deleteClipboardItem(id: string, hostOverride?: any): Promise<boolean> {
  if (!id || typeof id !== "string" || !id.trim()) return false;
  // 1. window.ztools
  if (typeof window !== "undefined" && (window as any).ztools?.clipboard_history_delete) {
    try {
      return await (window as any).ztools.clipboard_history_delete({ id });
    } catch {}
  }
  if (hostOverride || isRealElectronHost(hostOverride)) {
    try {
      const res = await callHostTransport<any>("clipboard_history_delete", { id }, hostOverride);
      if (res.ok && res.data?.ok !== false) return true;
      return false;
    } catch {
      return false;
    }
  }
  // 2. Bridge
  const bridge = getDeclarativeBridge();
  if (bridge?.clipboardHistory?.delete) {
    try {
      return await bridge.clipboardHistory.delete(id);
    } catch {}
  }
  // 3. LocalStorage fallback
  try {
    const items = await getClipboardHistory();
    const updated = items.filter(item => item.id !== id);
    await saveClipboardHistory(updated);
    return updated.length < items.length;
  } catch {
    return false;
  }
}

/**
 * 清空所有未置顶历史
 */
export async function clearUnpinnedClipboardHistory(hostOverride?: any): Promise<number> {
  // 1. window.ztools
  if (typeof window !== "undefined" && (window as any).ztools?.clipboard_history_clear_unpinned) {
    try {
      return await (window as any).ztools.clipboard_history_clear_unpinned();
    } catch {}
  }
  if (hostOverride || isRealElectronHost(hostOverride)) {
    try {
      const res = await callHostTransport<any>("clipboard_history_clear_unpinned", {}, hostOverride);
      if (res.ok) return Number(res.data?.clearedCount ?? res.data ?? 0);
      return 0;
    } catch {
      return 0;
    }
  }
  // 2. Bridge
  const bridge = getDeclarativeBridge();
  if (bridge?.clipboardHistory?.clearUnpinned) {
    try {
      return await bridge.clipboardHistory.clearUnpinned();
    } catch {}
  }
  // 3. LocalStorage fallback
  try {
    const items = await getClipboardHistory();
    const pinnedOnly = items.filter(item => item.pinned);
    const removedCount = items.length - pinnedOnly.length;
    await saveClipboardHistory(pinnedOnly);
    return removedCount;
  } catch {
    return 0;
  }
}

/**
 * 连续流水粘贴 (Paste Sequentially)
 */
export async function pasteSequentialClipboard(
  items: ClipboardItem[],
  options: { addNewLine?: boolean; timeoutSeconds?: number } = {}
): Promise<{ success: boolean; item?: ClipboardItem; remaining: number; offset: number; message?: string }> {
  // 1. window.ztools 原生调度
  if (typeof window !== "undefined" && (window as any).ztools?.clipboard_history_paste_sequential) {
    try {
      const res = await (window as any).ztools.clipboard_history_paste_sequential();
      if (res && res.success) {
        return {
          success: true,
          item: res.item,
          remaining: Math.max(0, (res.total || 0) - (res.sequenceIndex || 0)),
          offset: res.sequenceIndex || 0
        };
      }
    } catch {}
  }

  // 2. Bridge 调度
  const bridge = getDeclarativeBridge();
  if (bridge?.clipboardHistory?.pasteSequential) {
    try {
      const res = await bridge.clipboardHistory.pasteSequential();
      if (res && res.success) {
        return {
          success: true,
          item: res.item,
          remaining: Math.max(0, (res.total || 0) - (res.sequenceIndex || 0)),
          offset: res.sequenceIndex || 0
        };
      }
    } catch {}
  }

  // 3. 本地状态机模拟回贴
  if (options.timeoutSeconds) {
    pasteSequenceManager.setTimeoutSeconds(options.timeoutSeconds);
  }
  const result = pasteSequenceManager.pasteNext(items, options);
  if (!result.item) {
    return { success: false, remaining: 0, offset: 0, message: "No clipboard item found to paste." };
  }

  let textToPaste = result.item.content;
  if (options.addNewLine) {
    textToPaste += "\n";
  }

  await Clipboard.paste(textToPaste);
  return {
    success: true,
    item: result.item,
    remaining: result.remaining,
    offset: result.offset
  };
}

/**
 * 重置流水粘贴指针
 */
export async function resetPasteSequence(): Promise<void> {
  if (typeof window !== "undefined" && (window as any).ztools?.clipboard_history_reset_sequence) {
    try {
      await (window as any).ztools.clipboard_history_reset_sequence();
    } catch {}
  }
  const bridge = getDeclarativeBridge();
  if (bridge?.clipboardHistory?.resetSequence) {
    try {
      await bridge.clipboardHistory.resetSequence();
    } catch {}
  }
  pasteSequenceManager.reset();
}

/**
 * 偏好设置获取与持久化
 */
export async function getClipboardPreferences(): Promise<ClipboardPreferences> {
  try {
    const raw = await LocalStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        historyDuration: "P1W",
        primaryAction: "paste",
        preferPastingAsPlainText: false,
        updateHistoryAfterAction: true
      };
    }
    return JSON.parse(raw);
  } catch {
    return {
      historyDuration: "P1W",
      primaryAction: "paste",
      preferPastingAsPlainText: false,
      updateHistoryAfterAction: true
    };
  }
}

export async function saveClipboardPreferences(prefs: ClipboardPreferences): Promise<void> {
  await LocalStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
}

/**
 * 过滤与排序剪贴板条目（支持拼音缩写与模糊检索）
 */
export function filterClipboardItems(items: ClipboardItem[], options: ClipboardFilterOptions): ClipboardItem[] {
  let result = [...items];

  // 1. Filter by category
  if (options.type && options.type !== "all") {
    if (options.type === "pinned") {
      result = result.filter(item => item.pinned);
    } else {
      result = result.filter(item => item.type === options.type);
    }
  }

  // 2. Filter by search query
  if (options.query && options.query.trim()) {
    const q = options.query.trim().toLowerCase();
    result = result.filter(item => {
      if (item.content.toLowerCase().includes(q)) return true;
      if (item.preview.toLowerCase().includes(q)) return true;
      if (item.filePaths?.some(fp => fp.toLowerCase().includes(q))) return true;
      if (item.sourceAppName && item.sourceAppName.toLowerCase().includes(q)) return true;
      // 拼音首字母匹配
      const initials = getPinyinInitials(item.content + " " + item.preview);
      if (initials && initials.includes(q)) return true;
      return false;
    });
  }

  // 3. Sort: Pinned first, then newest copiedAt
  result.sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.copiedAt - a.copiedAt;
  });

  return result;
}

export function formatCopiedTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}
