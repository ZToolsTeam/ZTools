import fs from "node:fs";
import path from "node:path";
import { LocalStorage } from "../../api/storage.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import { ObsidianNote, ObsidianVaultInfo, DailyNoteAppendOptions } from "./types.js";

const STORAGE_KEY = "obsidian_vault_notes";
const STORAGE_KEY_CONFIGURED_VAULTS = "obsidian_configured_vaults";

export const DEFAULT_VAULTS: ObsidianVaultInfo[] = [
  { name: "Engineering", path: "C:/Obsidian/Engineering", open: true },
  { name: "Personal", path: "C:/Obsidian/Personal", open: false },
  { name: "Work", path: "C:/Obsidian/Work", open: false }
];

export const SAMPLE_OBSIDIAN_NOTES: ObsidianNote[] = [
  {
    id: "note-1",
    title: "ZTools 声明式架构设计决策",
    vault: "Engineering",
    folder: "Architecture",
    tags: ["architecture", "ztools", "declarative"],
    content: `---
title: ZTools 声明式架构设计决策
date: 2026-10-10
status: approved
tags: [architecture, ztools, declarative]
---

# ZTools 声明式架构设计决策 (ADR-004)

## 背景
传统桌面与插件生态面临原生 Web DOM 的性能瓶颈与跨平台样式一致性问题。为实现极速启动与高度统一的 Fluent 极客视觉规范，我们需要一套纯净的声明式虚拟视图描述符体系。

## 决策核心
1. **纯净声明式 Virtual View Descriptors**：组件只返回轻量 JSON 描述符，禁止注入原生 HTML/CSS。
2. **渐进式响应式微内核**：内置轻量 \`useState\` / \`useEffect\` / \`useMemo\`，与底层 Host 渲染完全解耦。
3. **平台安全与沙箱隔离**：NativeHost32 与认证 Service 双向验签，保障生产环境安全。

## 后续规划
- 支持全部经典生态应用无缝适配
- 完善 CI/CD 自动化门禁测试
`,
    wordCount: 380,
    createdAt: "2026-10-10 14:20",
    updatedAt: "2026-10-11 09:15"
  },
  {
    id: "note-2",
    title: "团队每周敏捷站会备忘",
    vault: "Personal",
    folder: "Meetings",
    tags: ["meeting", "agile", "weekly"],
    content: `---
title: 团队每周敏捷站会备忘
date: 2026-10-11
attendees: [@alice, @bob, @carol]
---

# 团队每周敏捷站会备忘

### 本周交付成果
- [x] 完成声明式兼容运行时单元与契约测试
- [x] 优化 LocalStorage 与 Clipboard 双向同步机制
- [ ] 补全首批 10 款经典开源应用生态

### 风险与阻碍
- 无重大风险，各子模块测试覆盖率达标。
`,
    wordCount: 165,
    createdAt: "2026-10-11 10:00",
    updatedAt: "2026-10-11 11:30"
  },
  {
    id: "note-3",
    title: "TypeScript 高性能类型体操与技巧",
    vault: "Engineering",
    folder: "Knowledge",
    tags: ["typescript", "tips", "dev"],
    content: `---
title: TypeScript 高性能类型体操与技巧
tags: [typescript, dev]
---

# TypeScript 技巧集合

### 1. 递归类型深度限制规避
使用尾递归模式或元组计数器，避免触发 TS2589: Type instantiation is excessively deep.

### 2. 模式匹配推断
\`\`\`typescript
type UnwrapPromise<T> = T extends Promise<infer U> ? UnwrapPromise<U> : T;
\`\`\`

持续更新中...
`,
    wordCount: 210,
    createdAt: "2026-10-09 18:00",
    updatedAt: "2026-10-10 20:10"
  },
  {
    id: "note-daily-today",
    title: "2026-10-13",
    vault: "Personal",
    folder: "Daily Notes",
    tags: ["daily-note", "journal"],
    content: `# 2026-10-13

- 09:30 团队晨会，同步 ZTools 官方插件重构排期
- 14:15 完成 GitHub 与 Obsidian 声明式扩展对齐`,
    wordCount: 88,
    createdAt: "2026-10-13 09:30",
    updatedAt: "2026-10-13 14:15",
    isDaily: true
  }
];

/**
 * 自动嗅探 Obsidian 配置文件 (%APPDATA%/obsidian/obsidian.json) 与自定义 Vaults
 */
export async function sniffObsidianVaults(): Promise<ObsidianVaultInfo[]> {
  try {
    // 1. 检查环境变量 APPDATA 或 macOS Application Support
    const appData =
      process.env.APPDATA ||
      (process.env.HOME ? path.join(process.env.HOME, "Library", "Application Support") : "");
    if (appData) {
      const configPath = path.join(appData, "obsidian", "obsidian.json");
      if (fs.existsSync(configPath)) {
        const text = fs.readFileSync(configPath, "utf8");
        const json = JSON.parse(text);
        if (json.vaults && typeof json.vaults === "object") {
          const detected: ObsidianVaultInfo[] = Object.values(json.vaults).map((rawVault: unknown) => {
            const v = (rawVault && typeof rawVault === "object" ? rawVault : {}) as { path?: string; open?: boolean; ts?: number };
            return {
              name: path.basename(v.path || "Vault"),
              path: v.path || "",
              open: Boolean(v.open),
              ts: v.ts
            };
          });
          if (detected.length > 0) {
            return detected;
          }
        }
      }
    }
  } catch (err) {
    console.warn("[obsidian] Failed to sniff obsidian.json:", err);
  }

  // 2. 检查本地 LocalStorage 用户自定义库
  try {
    const custom = await LocalStorage.getItem<ObsidianVaultInfo[]>(STORAGE_KEY_CONFIGURED_VAULTS);
    if (custom && custom.length > 0) {
      return custom;
    }
  } catch (err) {
    console.warn("[obsidian] Failed to read configured vaults:", err);
  }

  return isRealElectronHost() ? [] : DEFAULT_VAULTS;
}

export async function getVaultNotes(vaultName?: string): Promise<ObsidianNote[]> {
  let notes: ObsidianNote[] = isRealElectronHost() ? [] : SAMPLE_OBSIDIAN_NOTES;
  try {
    const list = await LocalStorage.getItem<ObsidianNote[]>(STORAGE_KEY);
    if (list && list.length > 0) {
      notes = list;
    }
  } catch (err) {
    console.warn("[obsidian] Failed to read vault notes:", err);
  }

  if (vaultName && vaultName !== "all") {
    return notes.filter((n) => n.vault.toLowerCase() === vaultName.toLowerCase());
  }
  return notes;
}

export async function saveVaultNote(
  note: Omit<ObsidianNote, "id" | "createdAt" | "updatedAt" | "wordCount">
): Promise<ObsidianNote[]> {
  const current = await getVaultNotes();
  const wordCount = note.content.trim().length;
  const now = new Date().toLocaleString();

  const newNote: ObsidianNote = {
    ...note,
    id: `obsidian_${Date.now()}`,
    wordCount,
    createdAt: now,
    updatedAt: now
  };

  const updated = [newNote, ...current];
  await LocalStorage.setItem(STORAGE_KEY, updated);
  return updated;
}

export async function deleteVaultNote(id: string): Promise<ObsidianNote[]> {
  const current = await getVaultNotes();
  const updated = current.filter((n) => n.id !== id);
  await LocalStorage.setItem(STORAGE_KEY, updated);
  return updated;
}

/**
 * 追加内容至今日 Daily Note (每日笔记)
 */
export async function appendToDailyNote(
  options: DailyNoteAppendOptions
): Promise<{ note: ObsidianNote; allNotes: ObsidianNote[] }> {
  const current = await getVaultNotes();
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const entryText = options.timestamp !== false ? `- ${timeStr} ${options.content.trim()}` : `- ${options.content.trim()}`;

  const existingIndex = current.findIndex(
    (n) => n.vault === options.vault && (n.title === todayStr || n.isDaily)
  );

  let targetNote: ObsidianNote;
  let updatedList: ObsidianNote[];

  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    const newContent = `${existing.content}\n${entryText}`;
    targetNote = {
      ...existing,
      content: newContent,
      wordCount: newContent.trim().length,
      updatedAt: now.toLocaleString()
    };
    updatedList = [...current];
    updatedList[existingIndex] = targetNote;
  } else {
    const initialContent = `# ${todayStr}\n\n${entryText}`;
    targetNote = {
      id: `daily_${Date.now()}`,
      title: todayStr,
      vault: options.vault,
      folder: "Daily Notes",
      tags: ["daily-note", "journal"],
      content: initialContent,
      wordCount: initialContent.trim().length,
      createdAt: now.toLocaleString(),
      updatedAt: now.toLocaleString(),
      isDaily: true
    };
    updatedList = [targetNote, ...current];
  }

  await LocalStorage.setItem(STORAGE_KEY, updatedList);
  return { note: targetNote, allNotes: updatedList };
}

export function searchVaultNotes(notes: ObsidianNote[], query: string, vault?: string): ObsidianNote[] {
  let list = notes;
  if (vault && vault !== "all") {
    list = list.filter((n) => n.vault.toLowerCase() === vault.toLowerCase());
  }

  if (!query || !query.trim()) return list;
  const q = query.toLowerCase().trim();
  return list.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.folder.toLowerCase().includes(q) ||
      n.vault.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
  );
}
