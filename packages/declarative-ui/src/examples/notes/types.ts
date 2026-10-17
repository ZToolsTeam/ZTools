/**
 * ZTools Raycast-Compat Notes 数据模型与类型定义
 * 深度对齐 Raycast Notes 官方规范与数据结构
 */

export interface NoteItem {
  id: string;
  title: string;
  content: string; // Markdown 源码
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

export interface NoteStats {
  characters: number;
  words: number;
  lines: number;
  readingTimeMinutes: number;
}

/**
 * 兼容历史示例旧版接口契约
 */
export interface NoteExampleItem {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly pinned: boolean;
  readonly updatedAt: string;
}

export type NotesFilterTab = "all" | "pinned";
