/**
 * 便签笔记本地持久化与数据服务 (Notes Storage Service)
 * 支持 LocalStorage / SQLite 统一持久化，包含字数统计与智能检索
 */

import { LocalStorage } from "../../api/storage.js";
import { NoteItem, NoteStats, NotesFilterTab } from "./types.js";

export const NOTES_STORAGE_KEY = "ztools-raycast-notes-v1";

export const SAMPLE_NOTES: readonly NoteItem[] = Object.freeze([
  {
    id: "note-1",
    title: "ZTools 架构设计纲领",
    content: `# ZTools 架构设计纲领

1. **轻量宿主**：基于 TypeScript + Electron 43 打造纯净极客底座，零非标黑盒中间层；
2. **高性能侧车**：Rust NTFS MFT / USN Journal 硬件级秒搜引擎，百万文件检索 SLA < 10ms；
3. **沉浸式声明式 UI**：完全基于统一虚拟视图描述符（Virtual Descriptors），严禁扩展手写原生 CSS/DOM；
4. **全键盘极客闭环**：Enter 激活首要动作、Ctrl+K 呼出动作面板、Esc 极速回退；
5. **去中心化端到端加密**：本地 Argon2id + AES-256-GCM 本地加密，零用户隐私搜集。`,
    pinned: true,
    createdAt: Date.now() - 3600 * 1000 * 24 * 2,
    updatedAt: Date.now() - 3600 * 1000 * 2,
    tags: ["architecture", "ztools", "core"]
  },
  {
    id: "note-2",
    title: "常用高频热键与键盘流备忘",
    content: `# 常用高频热键备忘

- \`Alt + Space\`：全局唤醒 / 隐藏 ZTools 快捷启动主窗口
- \`Enter\`：执行第一顺位首要动作 (Primary Action)
- \`Ctrl + K\`：弹出底部动作面板 (ActionPanel)
- \`Ctrl + B\`：切换双栏沉浸式详情预览 (Toggle Detail)
- \`Ctrl + N\`：新建便签 / 条目
- \`Ctrl + P\`：置顶 / 取消置顶当前便签
- \`Ctrl + E\`：导出当前便签为本地 Markdown 文件
- \`Esc\`：导航栈后退 / 关闭动作弹窗`,
    pinned: false,
    createdAt: Date.now() - 3600 * 1000 * 24,
    updatedAt: Date.now() - 3600 * 1000 * 5,
    tags: ["hotkeys", "keyboard", "shortcuts"]
  },
  {
    id: "note-3",
    title: "声明式 UI 规范速查",
    content: `# 声明式 UI 开发范式

\`\`\`tsx
import { List, ActionPanel, Action, Icon } from "@ztools/api";

export default function MyCommand() {
  return (
    <List searchBarPlaceholder="搜索条目...">
      <List.Item
        title="极客指令"
        icon={Icon.Terminal}
        actions={
          <ActionPanel>
            <Action title="立即执行" onAction={() => console.log("Run")} />
          </ActionPanel>
        }
      />
    </List>
  );
}
\`\`\`

> 核心铁律：所有界面元素仅生成结构化 JSON 视图描述符，由宿主渲染器统一呈现 Fluent 亚克力亚态视觉。`,
    pinned: true,
    createdAt: Date.now() - 3600 * 1000 * 48,
    updatedAt: Date.now() - 3600 * 1000 * 8,
    tags: ["declarative", "ui", "ztools"]
  },
  {
    id: "note-4",
    title: "项目迭代里程碑与待办事项",
    content: `# 项目迭代待办清单

- [x] 完成 Everything 秒级文件搜索侧车集成
- [x] 剪贴板历史与 Snippets 宏展开闭环
- [x] 调色板与多格式色彩互转计算器
- [ ] 完善便签多笔记全键盘管理套件
- [ ] 接入原生 WASAPI 音频混音与特权电源穿透`,
    pinned: false,
    createdAt: Date.now() - 3600 * 1000 * 12,
    updatedAt: Date.now() - 3600 * 1000 * 1,
    tags: ["roadmap", "todo"]
  }
]);

/**
 * 提取便签统计指标
 */
export function calculateNoteStats(content: string): NoteStats {
  if (!content) {
    return { characters: 0, words: 0, lines: 0, readingTimeMinutes: 1 };
  }
  const characters = content.length;
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const lines = content.split("\n").length;
  const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));
  return { characters, words, lines, readingTimeMinutes };
}

/**
 * 智能提取便签标题（对标 Raycast 自动提取第一行）
 */
export function deriveNoteTitle(title?: string, content?: string): string {
  if (title && title.trim()) {
    return title.trim();
  }
  if (!content || !content.trim()) {
    return "未命名便签 (Untitled Note)";
  }
  const lines = content.split("\n");
  for (const line of lines) {
    const clean = line.replace(/^[#\s*`>-]+/, "").trim();
    if (clean.length > 0) {
      return clean.slice(0, 50);
    }
  }
  return "未命名便签 (Untitled Note)";
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 3600 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / (3600 * 1000))} 小时前`;
  if (diff < 86400 * 1000 * 2) return "昨天";
  if (diff < 86400 * 1000 * 7) return `${Math.floor(diff / (86400 * 1000))} 天前`;
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 导出便签为标准 Markdown 文本（含 Frontmatter）
 */
export function exportNoteAsMarkdown(note: NoteItem): string {
  const frontmatter = [
    "---",
    `title: "${note.title.replace(/"/g, '\\"')}"`,
    `pinned: ${note.pinned}`,
    `tags: [${note.tags.map(t => `"${t}"`).join(", ")}]`,
    `createdAt: "${new Date(note.createdAt).toISOString()}"`,
    `updatedAt: "${new Date(note.updatedAt).toISOString()}"`,
    "---",
    "",
    note.content
  ].join("\n");
  return frontmatter;
}

/**
 * 获取全部便签笔记（按置顶排序，再按更新时间降序）
 */
export async function getNotes(): Promise<NoteItem[]> {
  const raw = await LocalStorage.getItem<string>(NOTES_STORAGE_KEY);
  let list: NoteItem[] = [];

  // 没有便签就是空列表：不预置示例，删光后也不会冒出示例；数据损坏时返回空列表且不覆盖原数据
  if (raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        list = parsed;
      }
    } catch {
      list = [];
    }
  }

  // 旧版本首次打开时会把示例便签写进存储；清掉其中从未被改动过的示例，用户新建或改过的一律保留
  const untouchedSample = (note: NoteItem) =>
    SAMPLE_NOTES.some((sample) => sample.id === note.id && sample.title === note.title && sample.content === note.content);
  const cleaned = list.filter((note) => !untouchedSample(note));
  if (cleaned.length !== list.length) {
    list = cleaned;
    await LocalStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(list));
  }

  return sortNotes(list);
}

/**
 * 保存或新建便签
 */
export async function saveNote(data: {
  id?: string;
  title?: string;
  content: string;
  pinned?: boolean;
  tags?: string[];
}): Promise<NoteItem> {
  const allNotes = await getNotes();
  const now = Date.now();
  const title = deriveNoteTitle(data.title, data.content);

  if (data.id) {
    const existingIndex = allNotes.findIndex(n => n.id === data.id);
    if (existingIndex >= 0) {
      const updated: NoteItem = {
        ...allNotes[existingIndex],
        title,
        content: data.content,
        pinned: data.pinned ?? allNotes[existingIndex].pinned,
        tags: data.tags ?? allNotes[existingIndex].tags,
        updatedAt: now
      };
      allNotes[existingIndex] = updated;
      await LocalStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(allNotes));
      return updated;
    }
  }

  const newNote: NoteItem = {
    id: data.id ?? `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    content: data.content,
    pinned: data.pinned ?? false,
    createdAt: now,
    updatedAt: now,
    tags: data.tags ?? []
  };

  const updatedList = [newNote, ...allNotes];
  await LocalStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(updatedList));
  return newNote;
}

/**
 * 更新指定便签
 */
export async function updateNote(id: string, updates: Partial<NoteItem>): Promise<NoteItem | null> {
  const allNotes = await getNotes();
  const idx = allNotes.findIndex(n => n.id === id);
  if (idx < 0) return null;

  const current = allNotes[idx];
  const updated: NoteItem = {
    ...current,
    ...updates,
    title: updates.content ? deriveNoteTitle(updates.title ?? current.title, updates.content) : (updates.title ?? current.title),
    updatedAt: Date.now()
  };

  allNotes[idx] = updated;
  await LocalStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(allNotes));
  return updated;
}

/**
 * 切换便签置顶状态
 */
export async function togglePinNote(id: string): Promise<NoteItem | null> {
  const allNotes = await getNotes();
  const note = allNotes.find(n => n.id === id);
  if (!note) return null;
  return updateNote(id, { pinned: !note.pinned });
}

/**
 * 删除便签
 */
export async function deleteNote(id: string): Promise<boolean> {
  const allNotes = await getNotes();
  const filtered = allNotes.filter(n => n.id !== id);
  if (filtered.length === allNotes.length) return false;
  await LocalStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(filtered));
  return true;
}

/**
 * 清空全部便签
 */
export async function clearNotes(): Promise<void> {
  await LocalStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify([]));
}

/**
 * 智能过滤与搜索便签
 */
export function filterNotes(
  notes: NoteItem[],
  query: string,
  filterTab: NotesFilterTab = "all"
): NoteItem[] {
  let list = [...notes];

  if (filterTab === "pinned") {
    list = list.filter(n => n.pinned);
  }

  if (!query || !query.trim()) {
    return sortNotes(list);
  }

  const q = query.trim().toLowerCase();
  return sortNotes(
    list.filter(n => {
      if (n.title.toLowerCase().includes(q)) return true;
      if (n.content.toLowerCase().includes(q)) return true;
      if (n.tags.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    })
  );
}

function sortNotes(notes: NoteItem[]): NoteItem[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.updatedAt - a.updatedAt;
  });
}
